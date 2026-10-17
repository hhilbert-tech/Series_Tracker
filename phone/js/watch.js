// Single books you asked to be told about (🔔 Notify me), without following a series or author.
// Stored in setting "watch". The regular check looks them up in one request and logs: a date set for an
// undated book ("dated"), a changed date ("date_changed"), and the release of a book whose future date we knew.
import { HardcoverAuthError, HardcoverError } from './hardcover.js';
import { getSetting, setSetting, nowIso, todayIso } from './db.js';

const isPast = (d, today) => /^\d{4}-\d{2}-\d{2}/.test(d ?? '') && d.slice(0, 10) <= today;
export const isOut = (d, today = todayIso()) => isPast(d, today);

export const watchList = (store) => getSetting(store, 'watch', []);
export const isWatched = async (store, id) => (await watchList(store)).some((w) => w.hardcover_book_id === Number(id));

// b: {hardcover_book_id, title, author, cover_url, release_date}. Returns false (and stores nothing) for a book already out.
export async function watchBook(store, b, today = todayIso(), extra = {}) {
  if (isPast(b.release_date, today)) return false;
  const id = Number(b.hardcover_book_id), list = (await watchList(store)).filter((w) => w.hardcover_book_id !== id);
  await setSetting(store, 'watch', [...list, { hardcover_book_id: id, title: b.title ?? '', author: b.author ?? null, cover_url: b.cover_url ?? null,
    release_date: b.release_date ?? null, future: Boolean(b.release_date), out: false, added_at: nowIso(), ...extra }]);
  return true;
}
export async function unwatchBook(store, id) {
  await setSetting(store, 'watch', (await watchList(store)).filter((w) => w.hardcover_book_id !== Number(id)));
}

async function log(store, e) {
  const key = e.kind === 'date_changed' ? `w:${e.hardcover_book_id}:date:${Date.now()}:${Math.random().toString(36).slice(2, 8)}` : `w:${e.hardcover_book_id}:${e.kind}`;
  return store.add('notification_log', { key, ...e, suppressed: 0, seen_at: null, created_at: nowIso() });
}

export async function runWatchCheck(store, client, { today = todayIso() } = {}) {
  const res = { events: [], errors: [] }, list = await watchList(store);
  if (!list.length) return res;
  let info;
  try { info = new Map((await client.booksInfo(list.map((w) => w.hardcover_book_id))).map((b) => [b.hardcover_book_id, b])); }
  catch (e) {
    if (e instanceof HardcoverAuthError) throw e;
    res.errors.push(`watched books: ${e instanceof HardcoverError ? e.message : 'unexpected error'}`);
    return res;
  }
  const next = [];
  for (const w of list) {
    const b = info.get(w.hardcover_book_id);
    if (!b) { next.push(w); continue; }                                     // not returned this time: keep as is
    const old = w.release_date ?? null, d = b.release_date ?? null;
    const e = { watch: 1, series_id: null, author_id: null, hardcover_book_id: w.hardcover_book_id, position: null, title: b.title || w.title,
      series_name: w.author ?? b.author ?? '', release_date: d, detail: null, cover_url: w.cover_url ?? b.cover_url ?? null };
    // `future`: we've seen a date still to come, so its arrival is news. An undated book that turns out to be old stays silent.
    const past = isPast(d, today), future = Boolean(w.future) || (Boolean(d) && !past);
    let kind = null;
    if (past && !w.out) kind = w.future ? 'released' : null;
    else if (d && !past && d !== old) kind = old ? 'date_changed' : 'dated';
    if (kind && await log(store, { ...e, kind, detail: kind === 'date_changed' ? old : null })) res.events.push({ ...e, kind, old_date: old });
    next.push({ ...w, title: e.title, release_date: d, cover_url: e.cover_url, future, out: past, last_checked_at: nowIso() });
  }
  // Merge with the list as it is now: books added or removed while the lookup ran win.
  const cur = await watchList(store), curIds = new Set(cur.map((w) => w.hardcover_book_id)), ids = new Set(next.map((w) => w.hardcover_book_id));
  await setSetting(store, 'watch', [...next.filter((w) => curIds.has(w.hardcover_book_id)), ...cur.filter((w) => !ids.has(w.hardcover_book_id))]);
  return res;
}
