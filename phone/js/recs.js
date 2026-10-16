// "Recommended for you": (1) other series by authors you follow or read, (2) popular series in the genres
// of the books you've read. Built from a few Hardcover requests, cached for a week, filtered at display
// time so a follow or dismissal takes effect at once. Failures only mean fewer suggestions.
import { HardcoverAuthError } from './hardcover.js';
import { getSetting, setSetting, nowIso, maxRead, removedSeriesIds, isRead } from './db.js';

export const RECS_TTL_MS = 7 * 864e5;
const MAX_AUTHORS = 8, MAX_GENRES = 2, MAX_TAGS = 2, MAX_ITEMS = 60;

export async function buildRecs(store, client, { genres: maxGenres = MAX_GENRES } = {}) {
  const series = await store.all('series'), authors = await store.all('author');
  const errors = [], items = [];

  // 1. Same authors. Weight = how many of their series you follow.
  const weight = new Map();
  const add = (name, w) => { if (name) { const k = name.toLowerCase(); weight.set(k, { name, w: (weight.get(k)?.w ?? 0) + w }); } };
  for (const s of series) add(s.author, 1);
  for (const a of authors) add(a.name, 1);
  const top = [...weight.values()].sort((a, b) => b.w - a.w || a.name.localeCompare(b.name)).slice(0, MAX_AUTHORS);
  try {
    const bySeries = await client.authorSeries(top.map((x) => x.name));
    for (const { name, w } of top) for (const s of bySeries.get(name) ?? []) items.push({ ...s, why: `More by ${name}`, kind: 'author', rank: 1000 + w * 10 });
  } catch (e) { if (e instanceof HardcoverAuthError) throw e; errors.push(`authors: ${e.message ?? e}`); }

  // The books you've read (id -> title), shared by the "similar" and genre lookups below.
  const readBooks = new Map();
  for (const s of series) {
    const read = await maxRead(store, s.id);
    for (const r of await store.all('series_book')) if (r.series_id === s.id && isRead(r, read) && r.hardcover_book_id) readBooks.set(r.hardcover_book_id, r.title);
  }
  const ids = [...readBooks.keys()];

  // 2. "Similar books", like the Hardcover book page: books similar to many of the ones you've read score highest.
  try {
    const seeds = ids.slice(-25), sim = await client.similarBookIds(seeds);
    const score = new Map();
    for (const [seed, list] of sim) list.forEach((id, i) => {
      if (readBooks.has(id)) return;
      const cur = score.get(id) ?? { w: 0, best: 0, seed };
      const w = 1 - i / 60; cur.w += w; if (w > cur.best) { cur.best = w; cur.seed = seed; } score.set(id, cur);
    });
    const top = [...score.entries()].sort((x, y) => y[1].w - x[1].w).slice(0, 60);
    if (top.length) for (const b of await client.booksInfo(top.map(([id]) => id))) {
      const sc = score.get(b.hardcover_book_id);
      if (!b.series || !sc) continue;                                   // standalone books can't be followed as a series
      items.push({ ...b.series, cover_url: b.cover_url, users_count: b.users_count, rating: b.rating, kind: 'similar',
        why: `Similar to ${readBooks.get(sc.seed) ?? 'books you read'}`, rank: 2e6 + Math.round(sc.w * 1000) });
    }
  } catch (e) { if (e instanceof HardcoverAuthError) throw e; errors.push(`similar: ${e.message ?? e}`); }

  // 3. Same genres/tags, from the books you've read.
  try {
    const tally = new Map(), tagTally = new Map(), books = await client.bookTags(ids);
    const count = (m, g) => m.set(g.slug, { slug: g.slug, name: g.name ?? g.slug, n: (m.get(g.slug)?.n ?? 0) + g.count });
    for (const b of books) { for (const g of b.genres) count(tally, g); for (const g of b.tags ?? []) count(tagTally, g); }
    for (const g of [...tagTally.values()].sort((a, b) => b.n - a.n).slice(0, MAX_TAGS)) {
      for (const s of await client.popularInGenre(g.slug, 'Tag')) items.push({ ...s, why: `Popular in ${g.name}`, kind: 'genre', rank: 1e6 + (s.users_count ?? 0) });
    }
    for (const g of [...tally.values()].sort((a, b) => b.n - a.n).slice(0, maxGenres)) {
      for (const s of await client.popularInGenre(g.slug)) items.push({ ...s, why: `Popular in ${g.name}`, kind: 'genre', rank: s.users_count ?? 0 });
    }
  } catch (e) { if (e instanceof HardcoverAuthError) throw e; errors.push(`genres: ${e.message ?? e}`); }

  const seen = new Set(), out = [];
  for (const it of items.sort((a, b) => b.rank - a.rank)) {
    if (seen.has(it.hardcover_series_id)) continue;
    seen.add(it.hardcover_series_id); out.push(it);
  }
  // If everything failed, back-date the cache so it is retried in ~6 h instead of sitting empty for a week.
  const at = !out.length && errors.length ? new Date(Date.now() - RECS_TTL_MS + 6 * 36e5).toISOString().slice(0, 19) + 'Z' : nowIso();
  const rec = { at, items: out.slice(0, MAX_ITEMS), errors };
  await setSetting(store, 'recs', rec);
  return rec;
}

// Saved suggestions minus anything followed, removed or dismissed since.
export async function loadRecs(store) {
  const rec = await getSetting(store, 'recs', null);
  if (!rec) return null;
  const skip = new Set([...(await store.all('series')).map((s) => s.hardcover_series_id), ...(await removedSeriesIds(store)), ...(await getSetting(store, 'recs_dismissed', []))]);
  return { ...rec, items: rec.items.filter((i) => !skip.has(i.hardcover_series_id)) };
}
export async function dismissRec(store, hcId) {
  await setSetting(store, 'recs_dismissed', [...new Set([...(await getSetting(store, 'recs_dismissed', [])), hcId])]);
}
export const recsStale = (rec, now = Date.now()) => !rec || now - Date.parse(rec.at) > RECS_TTL_MS;
