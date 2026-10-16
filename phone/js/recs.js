// The book finder: books you might like next. Sources, best first:
//   1. Hardcover's "similar books" for the books you've read (standalones included),
//   2. books by authors you follow (from local data, so always current),
//   3. popular books in your subgenres/tags, 4. other series by authors you read, 5. popular in your genres.
// The network part is cached for a week; everything is filtered at display time so reading, following or
// dismissing takes effect at once. A series is suggested once (via one of its books); failures only mean fewer picks.
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
  cover_url: b.cover_url ?? null, rating: b.rating ?? null, users_count: b.users_count ?? 0, series: b.series ?? null });
// A series found without a specific book (author/genre lookups): shown by its name.
const fromSeries = (s) => ({ hardcover_book_id: s.hardcover_book_id ?? null, title: s.title || s.name, author: s.author ?? null, author_id: null,
  cover_url: s.cover_url ?? null, rating: s.rating ?? null, users_count: s.users_count ?? 0,
  series: { hardcover_series_id: s.hardcover_series_id, name: s.name, author: s.author ?? null, complete: Boolean(s.complete), position: s.hardcover_book_id ? 1 : null } });

export async function buildRecs(store, client, { genres: maxGenres = MAX_GENRES } = {}) {
  const series = await store.all('series'), authors = await store.all('author');
  const { ids: read } = await readBooks(store);
  const errors = [], items = [];
  const fail = (src, e) => { if (e instanceof HardcoverAuthError) throw e; errors.push(`${src}: ${e.message ?? e}`); };
  const seedIds = [...read.keys()];

  // 1. "Similar books", like the Hardcover book page: books similar to many of the ones you've read score highest.
  try {
    const sim = await client.similarBookIds(seedIds.slice(-25));
    const score = new Map();
    for (const [seed, list] of sim) list.forEach((id, i) => {
      if (read.has(id)) return;
      const cur = score.get(id) ?? { w: 0, best: 0, seed };
      const w = 1 - i / 60; cur.w += w; if (w > cur.best) { cur.best = w; cur.seed = seed; } score.set(id, cur);
    });
    const top = [...score.entries()].sort((x, y) => y[1].w - x[1].w).slice(0, 60);
    if (top.length) for (const b of await client.booksInfo(top.map(([id]) => id))) {
      const sc = score.get(b.hardcover_book_id);
      if (!sc) continue;
      const seed = read.get(sc.seed) ?? 'books you read';
      items.push({ ...fromInfo(b), kind: 'similar', why: `Similar to ${seed}`, group: `Because you read ${seed}`, rank: T_SIMILAR + Math.round(sc.w * 1000) });
    }
  } catch (e) { fail('similar', e); }

  // 2. Other series by the authors of series you follow (authors you follow are covered from local data).
  const followedNames = new Set(authors.map((a) => a.name.toLowerCase()));
  const weight = new Map();
  for (const s of series) if (s.author && !followedNames.has(s.author.toLowerCase())) {
    const k = s.author.toLowerCase(); weight.set(k, { name: s.author, w: (weight.get(k)?.w ?? 0) + 1 });
  }
  const top = [...weight.values()].sort((a, b) => b.w - a.w || a.name.localeCompare(b.name)).slice(0, MAX_AUTHORS);
  if (top.length) try {
    const bySeries = await client.authorSeries(top.map((x) => x.name));
    for (const { name, w } of top) for (const s of bySeries.get(name) ?? []) items.push({ ...fromSeries(s), kind: 'author', why: `More by ${name}`, group: 'More by authors you read', rank: T_AUTHOR + w * 10 });
  } catch (e) { fail('authors', e); }

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

  const seen = new Set(), out = [];
  for (const it of items.sort((a, b) => b.rank - a.rank)) {
    const k = recKey(it);
    if (!seen.has(k) && !read.has(it.hardcover_book_id)) { seen.add(k); out.push({ ...it, key: k }); }
  }
  // Keep earlier picks this run didn't find again (after the new ones), so a refill or a failed lookup never empties the list.
  const old = await getSetting(store, 'recs', null);
  if (old?.v === RECS_VERSION) for (const it of old.items) if (!seen.has(it.key)) { seen.add(it.key); out.push(it); }
  // If everything failed, back-date the cache so it is retried in ~6 h instead of sitting empty for a week.
  const at = !out.length && errors.length ? new Date(Date.now() - RECS_TTL_MS + 6 * 36e5).toISOString().slice(0, 19) + 'Z' : nowIso();
  const rec = { v: RECS_VERSION, at, items: out.slice(0, MAX_ITEMS), errors };
  await setSetting(store, 'recs', rec);
  return rec;
}

// Released (or undated), unread books by authors you follow, outside the series you already follow; one per series (its earliest).
export async function authorPicks(store, today = todayIso()) {
  const authors = new Map((await store.all('author')).filter((a) => !a.muted).map((a) => [a.hardcover_author_id, a]));
  const followed = new Set((await store.all('series')).map((s) => s.hardcover_series_id));
  const best = new Map();
  for (const r of await store.all('author_book')) {
    const a = authors.get(r.author_id);
    if (!a || r.read || (r.release_date && r.release_date.slice(0, 10) > today) || (r.series_id != null && followed.has(r.series_id))) continue;
    const it = { hardcover_book_id: r.hardcover_book_id, title: r.title, author: a.name, author_id: a.hardcover_author_id, cover_url: r.cover_url ?? null,
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
  const seen = new Set(), items = [];
  for (const it of [...local, ...(cached?.items ?? [])].sort((a, b) => b.rank - a.rank)) {
    const k = it.key ?? recKey(it);
    if (seen.has(k) || dismissed.has(k) || read.has(it.hardcover_book_id) || skipSeries.has(it.series?.hardcover_series_id)
      || (it.hardcover_book_id && names.has(norm(it.title, it.author)))) continue;
    seen.add(k); items.push({ ...it, key: k });
  }
  return { at: cached?.at ?? null, errors: cached?.errors ?? [], items };
}
export async function dismissRec(store, key) {
  await setSetting(store, 'recs_dismissed', [...new Set([...(await getSetting(store, 'recs_dismissed', [])), key])]);
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
