// "Recommended for you": (1) other series by authors you follow or read, (2) popular series in the genres
// of the books you've read. Built from a few Hardcover requests, cached for a week, filtered at display
// time so a follow or dismissal takes effect at once. Failures only mean fewer suggestions.
import { HardcoverAuthError } from './hardcover.js';
import { getSetting, setSetting, nowIso, maxRead, removedSeriesIds } from './db.js';

export const RECS_TTL_MS = 7 * 864e5;
const MAX_AUTHORS = 8, MAX_GENRES = 2, MAX_ITEMS = 40;

export async function buildRecs(store, client) {
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

  // 2. Same genres, from the books you've read.
  try {
    const ids = [];
    for (const s of series) {
      const read = await maxRead(store, s.id);
      for (const r of await store.all('series_book')) if (r.series_id === s.id && r.position <= read && r.hardcover_book_id) ids.push(r.hardcover_book_id);
    }
    const tally = new Map();
    for (const b of await client.bookTags(ids)) for (const g of b.genres) tally.set(g.slug, { slug: g.slug, name: g.name ?? g.slug, n: (tally.get(g.slug)?.n ?? 0) + g.count });
    for (const g of [...tally.values()].sort((a, b) => b.n - a.n).slice(0, MAX_GENRES)) {
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
