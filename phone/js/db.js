// Helpers over the store (settings, series, progress).
export const pad = (n) => String(n).padStart(2, '0');
export const nowIso = () => new Date().toISOString().slice(0, 19) + 'Z';
export function todayIso() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
export const sbKey = (sid, pos) => `${sid}:${pos}`;

export async function getSetting(store, key, def = null) { const r = await store.get('settings', key); return r ? r.value : def; }
export function setSetting(store, key, value) { return store.put('settings', { key, value }); }

export async function upsertSeries(store, hcId, name, author = null, complete = false, coverUrl = null) {
  const s = (await store.all('series')).find((x) => x.hardcover_series_id === hcId);
  if (s) {
    Object.assign(s, { name, author: author ?? s.author, complete: Math.max(s.complete, complete ? 1 : 0), cover_url: s.cover_url ?? coverUrl });
    await store.put('series', s);
    return s.id;
  }
  const id = await store.nextId('series');
  await store.put('series', { id, hardcover_series_id: hcId, name, author, muted: 0, complete: complete ? 1 : 0,
    last_checked_at: null, cover_key: null, cover_url: coverUrl });
  return id;
}

// Raise max_position_read (never lowers; non-integer positions don't count).
export async function bumpProgress(store, sid, position) {
  let p = Number(position || 0);
  if (!Number.isInteger(p)) p = 0;
  const cur = await store.get('user_progress', sid);
  await store.put('user_progress', { series_id: sid, max_position_read: Math.max(cur?.max_position_read ?? 0, p) });
}
// Set progress exactly (unlike bumpProgress this can lower it, to undo a mistap).
export async function setProgress(store, sid, position) {
  const p = Math.max(0, Math.floor(Number(position) || 0));
  await store.put('user_progress', { series_id: sid, max_position_read: p });
}
// Highest whole-number position already released as of `today` (0 if none).
export async function lastReleased(store, sid, today) {
  const ps = (await store.all('series_book'))
    .filter((r) => r.series_id === sid && Number.isInteger(r.position) && r.release_date && r.release_date.slice(0, 10) <= today)
    .map((r) => r.position);
  return ps.length ? Math.max(...ps) : 0;
}
// Stop following: drops the series, its book list, progress and updates. Books imported from
// Goodreads are marked ignored so a later re-import doesn't quietly re-follow it.
export async function removeSeries(store, sid) {
  for (const r of await store.all('series_book')) if (r.series_id === sid) await store.delete('series_book', r.key);
  for (const r of await store.all('notification_log')) if (r.series_id === sid) await store.delete('notification_log', r.key);
  for (const b of await store.all('book')) if (b.series_id === sid) await store.put('book', { ...b, review_status: 'ignored' });
  await store.delete('user_progress', sid);
  await store.delete('series', sid);
}
// Will this book raise alerts? Default: whole-number books past your progress. "Notify me" overrides it either way.
export const notifying = (row, read) => row.notify ?? (Number.isInteger(row.position) && row.position > read);
export async function maxRead(store, sid) { return (await store.get('user_progress', sid))?.max_position_read ?? 0; }
