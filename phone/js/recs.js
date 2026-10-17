// The book finder: books you might like next. Sources, best first:
//   1. Hardcover's "similar books" for the books you've read (standalones included),
//   2. books by authors you follow (from local data, so always current),
//   3. popular books in your subgenres/tags, 4. other series by authors you read, 5. popular in your genres.
// The network part is cached for a week; everything is filtered at display time so reading, following or
// dismissing takes effect at once. A series is suggested once, via its first book unless you've read that;
// favourite books weigh double as seeds; authors/genres you keep dismissing sink. Failures only mean fewer picks.
import { HardcoverAuthError } from './hardcover.js';
import { getSetting, setSetting, nowIso, todayIso, maxRead, removedSeriesIds, isRead } from './db.js';

export const RECS_TTL_MS = 7 * 864e5;
export const RECS_VERSION = 2;
const MAX_AUTHORS = 8, MAX_GENRES = 2, MAX_TAGS = 2, MAX_ITEMS = 120;
const T_SIMILAR = 4e6, T_FOLLOWED = 3e6, T_TAG = 2e6, T_AUTHOR = 1e6;           // rank tiers; within a tier, higher = better
const cap = (n) => Math.min(Number(n) || 0, 999999);

// One suggestion per series, otherwise one per book.
export const recKey = (it) => (it.series?.hardcover_series_id ? `s:${it.series.hardcover_series_id}` : `b:${it.hardcover_book_id}`);
const norm = (t, a) => `${String(t ?? '').trim().toLowerCase()}|${String(a ?? '').trim().toLowerCase()}`;

// Everything you've read: ids (Map id -> title, most recently read last) and title|author keys for books without an id.
export async function readBooks(store) {
  const ids = new Map(), names = new Set();
  for (const b of await store.all('book')) {
    if (!b.read || b.review_status === 'ignored') continue;
    if (b.hardcover_book_id) ids.set(b.hardcover_book_id, b.title);
    if (b.title) names.add(norm(b.title, b.author));
  }
  const max = new Map();
  for (const s of await store.all('series')) max.set(s.id, await maxRead(store, s.id));
  const rows = (await store.all('series_book')).filter((r) => max.has(r.series_id) && r.hardcover_book_id && isRead(r, max.get(r.series_id)))
    .sort((x, y) => (x.read_at ?? '').localeCompare(y.read_at ?? ''));
  for (const r of rows) { ids.delete(r.hardcover_book_id); ids.set(r.hardcover_book_id, r.title); }
  for (const r of await store.all('author_book')) if (r.read && r.hardcover_book_id) { ids.delete(r.hardcover_book_id); ids.set(r.hardcover_book_id, r.title); }
  return { ids, names };
}

const fromInfo = (b) => ({ hardcover_book_id: b.hardcover_book_id, title: b.title, author: b.author ?? b.series?.author ?? null, author_id: b.author_id ?? null,
  cover_url: b.cover_url ?? null, rating: b.rating ?? null, pages: b.pages ?? null, users_count: b.users_count ?? 0, release_date: b.release_date ?? null, series: b.series ?? null });
// A series found without a specific book (author/genre lookups): shown by its name.
const fromSeries = (s) => ({ hardcover_book_id: s.hardcover_book_id ?? null, title: s.title || s.name, author: s.author ?? null, author_id: null,
  cover_url: s.cover_url ?? null, rating: s.rating ?? null, pages: s.pages ?? null, users_count: s.users_count ?? 0,
  series: { hardcover_series_id: s.hardcover_series_id, name: s.name, author: s.author ?? null, complete: Boolean(s.complete), position: s.hardcover_book_id ? 1 : null } });

// Series picks that aren't book #1 (or have no book yet) switch to book #1, in one request, unless you've read #1.
// `via` remembers the book that matched. Failure leaves the picks as found.
async function toFirstBooks(client, list, read, fail) {
  const need = list.filter((it) => it.series && it.series.position !== 1);
  if (!need.length) return;
  let firsts;
  try { firsts = await client.firstBooks(need.map((it) => it.series.hardcover_series_id)); } catch (e) { fail('first books', e); return; }
  for (const it of need) {
    const f = firsts.get(it.series.hardcover_series_id);
    if (!f || read.has(f.hardcover_book_id)) continue;
    const via = it.hardcover_book_id && f.hardcover_book_id !== it.hardcover_book_id ? `${it.series.position != null ? `#${it.series.position} ` : ''}${it.title}` : null;
    Object.assign(it, { hardcover_book_id: f.hardcover_book_id, title: f.title || it.title, author: f.author ?? it.author, author_id: f.author_id ?? it.author_id,
      cover_url: f.cover_url ?? it.cover_url, rating: f.rating ?? it.rating, pages: f.pages ?? it.pages ?? null, users_count: f.users_count || it.users_count, release_date: f.release_date ?? null,
      series: { ...it.series, position: 1 }, ...(via ? { via } : {}) });
  }
}

// Favourite books (♥ on a read book): always used as "similar" seeds, at double weight. [{id, title}]
export const getFavourites = async (store) => getSetting(store, 'favourites', []);
export async function toggleFavourite(store, id, title) {
  const favs = await getFavourites(store), on = !favs.some((f) => f.id === Number(id));
  await setSetting(store, 'favourites', on ? [...favs, { id: Number(id), title }] : favs.filter((f) => f.id !== Number(id)));
  await invalidateRecs(store);
  return on;
}
// Keep the current picks on screen but rebuild them on the next Discover visit.
export async function invalidateRecs(store) {
  const rec = await getSetting(store, 'recs', null);
  if (rec?.v === RECS_VERSION) await setSetting(store, 'recs', { ...rec, at: null });
}

// onProgress(rec) is called after the early sources with a partial list (saved, marked partial) so it can be shown at once.
export async function buildRecs(store, client, { genres: maxGenres = MAX_GENRES, onProgress = null } = {}) {
  const series = await store.all('series'), authors = await store.all('author');
  const { ids: read } = await readBooks(store);
  const errors = [], items = [], old = await getSetting(store, 'recs', null);
  const save = async (final) => {
    const seen = new Set(), out = [];
    for (const it of [...items].sort((a, b) => b.rank - a.rank)) {
      const k = recKey(it);
      if (!seen.has(k) && !read.has(it.hardcover_book_id)) { seen.add(k); out.push({ ...it, key: k }); }
    }
    // Keep earlier picks this run didn't find again (after the new ones), so a refill or a failed lookup never empties the list.
    if (old?.v === RECS_VERSION) for (const it of old.items) if (!seen.has(it.key)) { seen.add(it.key); out.push(it); }
    // If everything failed, back-date the cache so it is retried in ~6 h instead of sitting empty for a week.
    // A partial save keeps the previous date, so an interrupted build still counts as stale.
    const at = !final ? (old?.v === RECS_VERSION && !old.partial ? old.at : null)
      : !out.length && errors.length ? new Date(Date.now() - RECS_TTL_MS + 6 * 36e5).toISOString().slice(0, 19) + 'Z' : nowIso();
    const rec = { v: RECS_VERSION, at, items: out.slice(0, MAX_ITEMS), errors: [...errors], ...(final ? {} : { partial: true }) };
    await setSetting(store, 'recs', rec);
    if (!final && onProgress) try { await onProgress(rec); } catch { /* display only */ }
    return rec;
  };
  const fail = (src, e) => { if (e instanceof HardcoverAuthError) throw e; errors.push(`${src}: ${e.message ?? e}`); };
  const seedIds = [...read.keys()];
  const favs = (await getFavourites(store)).slice(-15), loved = new Map(favs.map((f) => [f.id, f.title]));
  const seeds = [...loved.keys(), ...seedIds.filter((id) => !loved.has(id)).slice(-(25 - loved.size))];
  const titleOf = (id) => loved.get(id) ?? read.get(id);

  // 1. "Similar books", like the Hardcover book page: books similar to many of the ones you've read score highest.
  try {
    const sim = await client.similarBookIds(seeds);
    const score = new Map();
    for (const [seed, list] of sim) list.forEach((id, i) => {
      if (read.has(id) || loved.has(id)) return;
      const cur = score.get(id) ?? { w: 0, best: 0, seed };
      const w = (1 - i / 60) * (loved.has(seed) ? 2 : 1); cur.w += w; if (w > cur.best) { cur.best = w; cur.seed = seed; } score.set(id, cur);
    });
    const top = [...score.entries()].sort((x, y) => y[1].w - x[1].w).slice(0, 60);
    if (top.length) for (const b of await client.booksInfo(top.map(([id]) => id))) {
      const sc = score.get(b.hardcover_book_id);
      if (!sc) continue;
      const seed = titleOf(sc.seed) ?? 'books you read', fav = loved.has(sc.seed);
      items.push({ ...fromInfo(b), kind: 'similar', why: `Similar to ${seed}`, group: `Because you ${fav ? 'loved' : 'read'} ${seed}`, rank: T_SIMILAR + Math.round(sc.w * 1000) });
    }
    await toFirstBooks(client, items, read, fail);
  } catch (e) { fail('similar', e); }
  if (items.length) await save(false);

  // 2. Other series by the authors of series you follow (authors you follow are covered from local data).
  const followedNames = new Set(authors.map((a) => a.name.toLowerCase()));
  const weight = new Map();
  for (const s of series) if (s.author && !followedNames.has(s.author.toLowerCase())) {
    const k = s.author.toLowerCase(); weight.set(k, { name: s.author, w: (weight.get(k)?.w ?? 0) + 1 });
  }
  const top = [...weight.values()].sort((a, b) => b.w - a.w || a.name.localeCompare(b.name)).slice(0, MAX_AUTHORS);
  const before = items.length;
  if (top.length) try {
    const bySeries = await client.authorSeries(top.map((x) => x.name));
    for (const { name, w } of top) for (const s of bySeries.get(name) ?? []) items.push({ ...fromSeries(s), kind: 'author', why: `More by ${name}`, group: 'More by authors you read', rank: T_AUTHOR + w * 10 });
    await toFirstBooks(client, items.slice(before), read, fail);
  } catch (e) { fail('authors', e); }
  if (items.length > before) await save(false);

  // 3. Same subgenres/tags and genres, from the books you've read.
  try {
    const tally = new Map(), tagTally = new Map(), books = await client.bookTags(seedIds);
    const count = (m, g) => m.set(g.slug, { slug: g.slug, name: g.name ?? g.slug, n: (m.get(g.slug)?.n ?? 0) + g.count });
    for (const b of books) { for (const g of b.genres) count(tally, g); for (const g of b.tags ?? []) count(tagTally, g); }
    for (const g of [...tagTally.values()].sort((a, b) => b.n - a.n).slice(0, MAX_TAGS)) {
      for (const s of await client.popularInGenre(g.slug, 'Tag')) items.push({ ...fromSeries(s), kind: 'genre', why: `Popular in ${g.name}`, group: `Popular in ${g.name}`, rank: T_TAG + cap(s.users_count) });
    }
    for (const g of [...tally.values()].sort((a, b) => b.n - a.n).slice(0, maxGenres)) {
      for (const s of await client.popularInGenre(g.slug)) items.push({ ...fromSeries(s), kind: 'genre', why: `Popular in ${g.name}`, group: `Popular in ${g.name}`, rank: cap(s.users_count) });
    }
  } catch (e) { fail('genres', e); }
  return save(true);
}

// Released (or undated), unread books by authors you follow, outside the series you already follow; one per series (its earliest).
export async function authorPicks(store, today = todayIso()) {
  const authors = new Map((await store.all('author')).filter((a) => !a.muted).map((a) => [a.hardcover_author_id, a]));
  const followed = new Set((await store.all('series')).map((s) => s.hardcover_series_id));
  const best = new Map();
  for (const r of await store.all('author_book')) {
    const a = authors.get(r.author_id);
    if (!a || r.read || (r.release_date && r.release_date.slice(0, 10) > today) || (r.series_id != null && followed.has(r.series_id))) continue;
    const it = { hardcover_book_id: r.hardcover_book_id, title: r.title, author: a.name, author_id: a.hardcover_author_id, cover_url: r.cover_url ?? null, release_date: r.release_date ?? null,
      rating: null, users_count: r.users_count ?? 0, kind: 'followed', why: `By ${a.name}`, group: 'From authors you follow', rank: T_FOLLOWED + cap(r.users_count),
      series: r.series_id != null ? { hardcover_series_id: r.series_id, name: r.series_name ?? '', author: a.name, complete: false, position: r.series_position ?? null } : null };
    const k = recKey(it), cur = best.get(k);
    if (!cur || (it.series && (it.series.position ?? 1e9) < (cur.series.position ?? 1e9))) best.set(k, { ...it, key: k });
  }
  return [...best.values()].sort((x, y) => y.rank - x.rank);
}

// Saved picks plus followed-author picks, minus anything read, followed, removed or dismissed since. null = nothing built yet.
export async function loadRecs(store, today = todayIso()) {
  const rec = await getSetting(store, 'recs', null), cached = rec?.v === RECS_VERSION ? rec : null;
  const local = await authorPicks(store, today);
  if (!cached && !local.length) return null;
  const { ids: read, names } = await readBooks(store);
  const skipSeries = new Set([...(await store.all('series')).map((s) => s.hardcover_series_id), ...(await removedSeriesIds(store))]);
  const dismissed = new Set((await getSetting(store, 'recs_dismissed', [])).map((k) => (typeof k === 'number' ? `s:${k}` : k)));
  const want = new Set((await getSetting(store, 'want', [])).map((w) => w.key));
  const { authors: dAuth, groups: dGroup } = await getSetting(store, 'recs_dislikes', { authors: {}, groups: {} });
  const hidden = new Set((await getSetting(store, 'recs_hidden_authors', [])).map((a) => a.toLowerCase()));
  const lc = (s) => String(s ?? '').toLowerCase();
  // Two or more "Not interested" for an author (or a genre shelf) sends the rest of them to the end.
  const sunk = (it) => (dAuth[lc(it.author)] ?? 0) >= 2 || (it.kind === 'genre' && (dGroup[lc(it.group)] ?? 0) >= 2);
  const adj = (it) => it.rank - (sunk(it) ? 1e8 : 0);
  const seen = new Set(), items = [];
  for (const it of [...local, ...(cached?.items ?? [])].sort((a, b) => adj(b) - adj(a))) {
    const k = it.key ?? recKey(it);
    if (seen.has(k) || dismissed.has(k) || want.has(k) || hidden.has(lc(it.author)) || read.has(it.hardcover_book_id) || skipSeries.has(it.series?.hardcover_series_id)
      || (it.hardcover_book_id && names.has(norm(it.title, it.author)))) continue;
    seen.add(k); items.push({ ...it, key: k });
  }
  return { at: cached?.at ?? null, partial: Boolean(cached?.partial), errors: cached?.errors ?? [], items };
}
// "Not interested": hides the pick, and counts against its author (and genre shelf) for "less like this".
export async function dismissRec(store, key, { author = null, group = null } = {}) {
  await setSetting(store, 'recs_dismissed', [...new Set([...(await getSetting(store, 'recs_dismissed', [])), key])]);
  if (!author && !group) return;
  const d = await getSetting(store, 'recs_dislikes', { authors: {}, groups: {} });
  const bump = (m, k) => { if (k) m[k.toLowerCase()] = (m[k.toLowerCase()] ?? 0) + 1; };
  bump(d.authors, author); bump(d.groups, group);
  await setSetting(store, 'recs_dislikes', d);
}
export async function hideAuthor(store, name) {
  await setSetting(store, 'recs_hidden_authors', [...new Set([...(await getSetting(store, 'recs_hidden_authors', [])), name])]);
}
export async function unhideAuthor(store, name) {
  await setSetting(store, 'recs_hidden_authors', (await getSetting(store, 'recs_hidden_authors', [])).filter((a) => a.toLowerCase() !== name.toLowerCase()));
}

// "Want to read": saved picks (whole item, so they show without a lookup), newest first; read ones drop off.
export async function wantList(store) {
  const { ids: read, names } = await readBooks(store);
  return (await getSetting(store, 'want', [])).filter((w) => !read.has(w.hardcover_book_id) && !names.has(norm(w.title, w.author)))
    .sort((a, b) => (b.saved_at ?? '').localeCompare(a.saved_at ?? ''));
}
export async function addWant(store, it, extra = {}) {
  const list = (await getSetting(store, 'want', [])).filter((w) => w.key !== it.key);
  const { key, hardcover_book_id, title, author, author_id, cover_url, rating, pages, series, why, release_date } = it;
  await setSetting(store, 'want', [...list, { key, hardcover_book_id, title, author, author_id, cover_url, rating, pages, series, why, release_date: release_date ?? null, kind: 'want', saved_at: nowIso(), ...extra }]);
}
export async function removeWant(store, key) {
  const list = await getSetting(store, 'want', []), gone = list.find((w) => w.key === key);
  await setSetting(store, 'want', list.filter((w) => w.key !== key));
  return gone ?? null;
}

// Display filters (setting "pick_filter"). Unknown rating/pages pass, so sparse data never hides a pick.
export const DEFAULT_FILTER = { kind: 'all', minRating: 0, maxPages: 0 };
export function filterPicks(items, f = DEFAULT_FILTER) {
  return items.filter((it) => (f.kind === 'standalone' ? !it.series : f.kind === 'series' ? Boolean(it.series) : true)
    && (!f.minRating || it.rating == null || it.rating >= f.minRating)
    && (!f.maxPages || it.pages == null || it.pages <= f.maxPages));
}

// Books similar to one book (the "Books like…" search and the shelf on book pages): read books left out, one per series (book #1).
export async function similarTo(store, client, bookId, title = 'this book') {
  const ids = (await client.similarBookIds([bookId])).get(Number(bookId)) ?? [];
  if (!ids.length) return [];
  const { ids: read } = await readBooks(store);
  const info = new Map((await client.booksInfo(ids.slice(0, 30))).map((x) => [x.hardcover_book_id, x]));
  const items = ids.slice(0, 30).filter((id) => info.has(id) && !read.has(id) && id !== Number(bookId))
    .map((id, i) => ({ ...fromInfo(info.get(id)), kind: 'similar', why: `Similar to ${title}`, rank: T_SIMILAR - i }));
  await toFirstBooks(client, items, read, () => {});
  const seen = new Set(), out = [];
  for (const it of items) { const k = recKey(it); if (!seen.has(k) && !read.has(it.hardcover_book_id)) { seen.add(k); out.push({ ...it, key: k }); } }
  return out;
}
export const recsStale = (rec, now = Date.now()) => !rec?.at || !(now - Date.parse(rec.at) <= RECS_TTL_MS);

// Picks grouped into shelves for Discover: "Because you read X" groups with a single book fold into one shelf.
export function shelves(items, { maxShelves = 8 } = {}) {
  const groups = new Map();
  for (const it of items) {
    let g = it.group ?? it.why ?? 'For you';
    if (it.kind === 'similar' && items.filter((x) => x.group === g).length < 2) g = 'Similar to books you read';
    (groups.get(g) ?? groups.set(g, { label: g, items: [] }).get(g)).items.push(it);
  }
  return [...groups.values()].slice(0, maxShelves);
}
