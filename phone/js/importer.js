// Import (Goodreads CSV / Hardcover library), series matching, and the shared "follow a series" step.
import { HardcoverAuthError, HardcoverError } from './hardcover.js';
import { bumpProgress, nowIso, todayIso, upsertSeries } from './db.js';
import { syncSeries } from './check.js';
import { parseGoodreadsCsv, cleanIsbn } from './parse.js';

const NOISE = new Set(['the', 'a', 'an', 'series', 'saga', 'trilogy', 'cycle']);
const MIN_NAME_SIM = 0.85;
const tokens = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t && !NOISE.has(t));

// Port of Python difflib.SequenceMatcher.ratio() (no junk heuristics; inputs are short).
function matched(a, b) {
  if (!a.length || !b.length) return 0;
  let best = 0, bi = 0, bj = 0, prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) { best = cur[j]; bi = i - best; bj = j - best; } }
    }
    prev = cur;
  }
  if (!best) return 0;
  return best + matched(a.slice(0, bi), b.slice(0, bj)) + matched(a.slice(bi + best), b.slice(bj + best));
}
export function nameSim(a, b) {
  const x = tokens(a).join(' '), y = tokens(b).join(' ');
  return x.length + y.length ? (2 * matched(x, y)) / (x.length + y.length) : 1;
}
function authorOk(want, cand) {
  const w = new Set(tokens(want)), c = new Set(tokens(cand));
  if (!w.size || !c.size) return null;             // unknown
  return [...w].some((t) => c.has(t));
}

// Spec matching: 1) ISBN13 -> edition -> book -> series, 2) series name + author fuzzy search.
export async function resolveSeries(client, name, author, isbns) {
  for (const isbn of (isbns ?? []).slice(0, 3)) {
    const hit = await client.findByIsbn(isbn);
    if (hit?.series?.length) {
      const best = hit.series.reduce((m, s) => (nameSim(name, s.name) > nameSim(name, m.name) ? s : m));
      if (!name || nameSim(name, best.name) >= 0.5 || hit.series.length === 1) return best;
    }
  }
  if (!name) return null;
  let best = null, bestScore = 0;
  for (const c of await client.searchSeries(name)) {
    const sim = nameSim(name, c.name), ok = authorOk(author, c.author);
    if (sim < MIN_NAME_SIM || ok === false || (ok === null && sim < 0.95)) continue;
    if (sim > bestScore) { best = c; bestScore = sim; }
  }
  return best;
}

// Create/refresh a tracked series, raise progress, and baseline-sync its books on first sight.
export async function followSeries(store, client, info, readUpTo = 0, covers = null, today = null) {
  const sid = await upsertSeries(store, info.hardcover_series_id, info.name, info.author ?? null, info.complete ?? false, info.cover_url ?? null);
  await bumpProgress(store, sid, readUpTo || 0);
  if (client && (await store.get('series', sid)).last_checked_at == null) {
    let books;
    try { books = await client.seriesBooks(info.hardcover_series_id); }
    catch (e) { if (e instanceof HardcoverError) return sid; throw e; }   // nightly-style check will baseline it
    await syncSeries(store, sid, books, today ?? todayIso(), true, covers);
    await store.put('series', { ...(await store.get('series', sid)), last_checked_at: nowIso() });
  }
  return sid;
}

export async function linkBook(store, bookId, seriesId, position = null) {
  const b = await store.get('book', bookId);
  await store.put('book', { ...b, series_id: seriesId, review_status: 'ok', series_position: position ?? b.series_position });
}

const maxIntRead = (positions) => Math.max(0, ...positions.filter((p) => p != null && Number.isInteger(p)));
const newBook = async (store, fields) => {
  const id = await store.nextId('book');
  const b = { id, title: '', author: null, isbn13: '', series_name_raw: null, series_position: null, read: 1, source: 'manual',
    cover_key: null, series_id: null, hardcover_book_id: null, review_status: 'ok', ...fields };
  await store.put('book', b);
  return b;
};

export async function importGoodreads(store, text, client, covers = null) {
  const res = { books_imported: 0, series_followed: 0, needs_review: 0, errors: [] };
  const groups = new Map();
  for (const r of parseGoodreadsCsv(text)) {
    if (!(r.series && r.read)) continue;
    const k = `${r.series.toLowerCase()}|${r.author.toLowerCase()}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const followed = new Set();
  let authFailed = false;
  for (const rows of groups.values()) {
    const ids = [];
    for (const r of rows) {
      const ex = (await store.all('book')).find((b) => b.source === 'goodreads' && b.title === r.title && b.author === r.author);
      if (ex) {
        await store.put('book', { ...ex, isbn13: r.isbn13, series_name_raw: r.series, series_position: r.position, read: 1 });
        ids.push(ex.id);
      } else {
        const b = await newBook(store, { title: r.title, author: r.author, isbn13: r.isbn13, series_name_raw: r.series,
          series_position: r.position, source: 'goodreads', review_status: 'needs_review' });
        ids.push(b.id); res.books_imported++;
      }
    }
    const states = await Promise.all(ids.map((i) => store.get('book', i)));
    if (states.some((b) => b.review_status === 'ignored')) continue;
    const known = states.find((b) => b.series_id)?.series_id;
    let info = null;
    if (known) {
      const s = await store.get('series', known);
      info = { hardcover_series_id: s.hardcover_series_id, name: s.name, author: s.author };
    } else if (client && !authFailed) {
      try { info = await resolveSeries(client, rows[0].series, rows[0].author, rows.filter((r) => r.isbn13).map((r) => r.isbn13)); }
      catch (e) {
        if (e instanceof HardcoverAuthError) { res.errors.push(e.message); authFailed = true; }
        else if (e instanceof HardcoverError) res.errors.push(`${rows[0].series}: ${e.message}`);
        else throw e;
      }
    }
    if (!info) { res.needs_review++; continue; }
    const sid = await followSeries(store, client, info, maxIntRead(rows.map((r) => r.position)), covers);
    for (const id of ids) await linkBook(store, id, sid);
    followed.add(sid);
  }
  res.series_followed = followed.size;
  return res;
}

export async function importHardcover(store, client, covers = null) {
  const res = { books_imported: 0, series_followed: 0, needs_review: 0, errors: [] };
  const followed = new Set();
  for (const item of await client.myLibrary()) {
    if (!item.series.length) continue;
    const first = item.series[0];
    let b = (await store.all('book')).find((x) => x.source === 'hardcover' && x.hardcover_book_id === item.hardcover_book_id);
    if (!b) {
      b = await newBook(store, { title: item.title, author: item.author, series_name_raw: first.name, series_position: first.position,
        source: 'hardcover', hardcover_book_id: item.hardcover_book_id });
      res.books_imported++;
    }
    for (const [i, s] of item.series.entries()) {
      const sid = await followSeries(store, client, s, item.read ? s.position : 0, covers);
      followed.add(sid);
      if (i === 0) await linkBook(store, b.id, sid, s.position);
    }
  }
  res.series_followed = followed.size;
  return res;
}

// Try spec matching steps 1-2 once for one stored book; link it or mark needs_review.
export async function matchAndLinkBook(store, client, bookId, covers = null) {
  const b = await store.get('book', bookId);
  let info = null;
  if (client) {
    try { info = await resolveSeries(client, b.series_name_raw, b.author, b.isbn13 ? [b.isbn13] : []); }
    catch (e) { if (!(e instanceof HardcoverError)) throw e; }
  }
  if (!info) { await store.put('book', { ...b, review_status: 'needs_review' }); return false; }
  const pos = b.series_position ?? info.position ?? null;
  const sid = await followSeries(store, client, info, b.read ? pos : 0, covers);
  await linkBook(store, bookId, sid, pos);
  return true;
}

// Hand entry: saved as source=manual; one match attempt, otherwise it waits under "Needs review".
export async function addManualBook(store, client, f, covers = null) {
  const pos = String(f.position ?? '').trim() === '' ? null : parseFloat(f.position);
  const b = await newBook(store, { title: f.title.trim(), author: (f.author ?? '').trim() || null, isbn13: cleanIsbn(f.isbn),
    series_name_raw: (f.series_name ?? '').trim() || null, series_position: Number.isFinite(pos) ? pos : null,
    read: f.read === false ? 0 : 1, source: 'manual', review_status: 'needs_review' });
  return matchAndLinkBook(store, client, b.id, covers);
}

// "Add as read" from search: stores the book and follows its series (if any) up to its position.
export async function addSearchBook(store, client, f, covers = null) {
  const dup = (await store.all('book')).find((x) => x.source === 'search' && x.hardcover_book_id === f.hardcover_book_id);
  if (dup) return { duplicate: true, series: null };
  const coverKey = f.cover_url && covers ? await covers.getOrFetch(`book-${f.hardcover_book_id}`, [f.cover_url]) : null;
  const b = await newBook(store, { title: f.title, author: f.author || null, isbn13: cleanIsbn(f.isbn13), source: 'search',
    hardcover_book_id: f.hardcover_book_id, cover_key: coverKey });
  let list = [];
  try { list = await client.bookSeries(f.hardcover_book_id); } catch (e) { if (!(e instanceof HardcoverError)) throw e; }
  for (const [i, s] of list.entries()) {
    const sid = await followSeries(store, client, s, s.position, covers);
    if (i === 0) await linkBook(store, b.id, sid, s.position);
  }
  return { duplicate: false, series: list[0]?.name ?? null };
}

// ---- Needs review -------------------------------------------------------------------
const sameGroup = (a, b) => (a.series_name_raw
  ? a.source === b.source && a.series_name_raw === b.series_name_raw && (a.author ?? '') === (b.author ?? '')
  : a.id === b.id);

export async function reviewGroups(store) {
  const rows = (await store.all('book')).filter((b) => b.review_status === 'needs_review')
    .sort((a, b) => (a.series_name_raw ?? '').localeCompare(b.series_name_raw ?? '') || (a.series_position ?? 0) - (b.series_position ?? 0) || a.title.localeCompare(b.title));
  const groups = [];
  for (const r of rows) {
    const g = groups.find((x) => sameGroup(x.lead, r));
    if (g) g.books.push(r); else groups.push({ lead: r, books: [r] });
  }
  return groups;
}
async function members(store, bookId) {
  const b = await store.get('book', bookId);
  return (await store.all('book')).filter((x) => x.review_status === 'needs_review' && sameGroup(b, x));
}
export async function assignGroup(store, client, bookId, info, covers = null) {
  const ms = await members(store, bookId);
  const sid = await followSeries(store, client, info, maxIntRead(ms.filter((m) => m.read).map((m) => m.series_position)), covers);
  for (const m of ms) await linkBook(store, m.id, sid);
  return sid;
}
export async function ignoreGroup(store, bookId) {
  for (const m of await members(store, bookId)) await store.put('book', { ...m, review_status: 'ignored' });
}
