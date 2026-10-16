// The check: diff Hardcover against stored series_book, log updates (unseen until the user views them).
// First sight of a series ("baseline") seeds series_book silently for books that are already released;
// only unreleased/undated books beyond your progress are announced.
import { HardcoverAuthError, HardcoverError } from './hardcover.js';
import { maxRead, nowIso, sbKey, todayIso } from './db.js';
import { fetchSeriesCovers } from './covers.js';

const isPast = (d, today) => /^\d{4}-\d{2}-\d{2}/.test(d ?? '') && d.slice(0, 10) <= today;

async function log(store, e, suppressed = false) {
  const once = e.kind !== 'date_changed';           // announced/released dedupe on series+book+kind
  const key = once ? `${e.series_id}:${e.hardcover_book_id}:${e.kind}`
    : `${e.series_id}:${e.hardcover_book_id}:date:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  return store.add('notification_log', { key, ...e, suppressed: suppressed ? 1 : 0, seen_at: suppressed ? nowIso() : null, created_at: nowIso() });
}

// Diff `books` against series_book, update it, log + return new events.
export async function syncSeries(store, seriesId, books, today, baseline, covers = null) {
  const s = await store.get('series', seriesId);
  const mx = await maxRead(store, seriesId);
  const existing = new Map((await store.all('series_book')).filter((r) => r.series_id === seriesId).map((r) => [r.position, r]));
  const events = [];
  const ev = (kind, b, old = null) => events.push({ series_id: seriesId, series_name: s.name, hardcover_book_id: b.hardcover_book_id,
    position: b.position, title: b.title, kind, release_date: b.release_date ?? null, old_date: old, cover_key: null });

  for (const b of [...books].sort((x, y) => x.position - y.position)) {
    const { position: pos, hardcover_book_id: hid, title } = b, d = b.release_date ?? null;
    const counted = Number.isInteger(pos) && pos > mx;              // decimals never count as "next"
    const past = isPast(d, today);
    const base = { series_id: seriesId, hardcover_book_id: hid, position: pos, title, release_date: d, detail: null };
    const row = existing.get(pos);
    if (!row) {
      await store.put('series_book', { key: sbKey(seriesId, pos), series_id: seriesId, position: pos, hardcover_book_id: hid, title,
        release_date: d, first_seen_at: nowIso(), cover_key: null, cover_url: b.cover_url ?? null });
      if (!counted) continue;
      if (baseline && past) await log(store, { ...base, kind: 'released' }, true);
      else if (past) { if (await log(store, { ...base, kind: 'released' })) ev('released', b); }
      else if (await log(store, { ...base, kind: 'announced' })) ev('announced', b);
      continue;
    }
    const old = row.release_date ?? null;
    await store.put('series_book', { ...row, hardcover_book_id: hid, title, release_date: d, cover_url: b.cover_url ?? row.cover_url });
    if (counted && d !== old) {
      await log(store, { ...base, kind: 'date_changed', detail: old });
      ev('date_changed', b, old);
    }
    if (counted && past && await log(store, { ...base, kind: 'released' })) ev('released', b);
  }

  if (covers) {
    try { await fetchSeriesCovers(store, covers, seriesId); } catch { /* covers are cosmetic */ }
  }
  for (const e of events) e.cover_key = (await store.get('series_book', sbKey(seriesId, e.position)))?.cover_key ?? null;
  return events;
}

async function caughtUpAndComplete(store, s) {
  if (!s.complete) return false;
  const pos = (await store.all('series_book')).filter((r) => r.series_id === s.id).map((r) => r.position);
  return pos.length > 0 && (await maxRead(store, s.id)) >= Math.max(...pos);
}

export async function runCheck(store, client, { today = todayIso(), covers = null } = {}) {
  const res = { events: [], errors: [] };
  const rows = (await store.all('series')).filter((s) => !s.muted && s.hardcover_series_id != null).sort((a, b) => a.id - b.id);
  for (const s of rows) {
    if (await caughtUpAndComplete(store, s)) continue;
    let books;
    try { books = await client.seriesBooks(s.hardcover_series_id); }
    catch (e) {
      if (e instanceof HardcoverAuthError) { res.errors.push(e.message); break; }   // same token for all: stop
      res.errors.push(e instanceof HardcoverError ? `${s.name}: ${e.message}` : `${s.name}: unexpected error (${e?.name ?? 'Error'})`);
      continue;
    }
    res.events.push(...await syncSeries(store, s.id, books, today, s.last_checked_at == null, covers));
    await store.put('series', { ...(await store.get('series', s.id)), last_checked_at: nowIso() });
  }
  return res;
}

const byUpdate = (a, b) => (a.series_name.localeCompare(b.series_name) || (a.position ?? 0) - (b.position ?? 0));
export async function updates(store, { onlyUnseen = false } = {}) {
  const names = new Map((await store.all('series')).map((s) => [s.id, s]));
  const sbs = new Map((await store.all('series_book')).map((r) => [r.key, r]));
  return (await store.all('notification_log'))
    .filter((n) => !n.suppressed && (!onlyUnseen || !n.seen_at) && names.has(n.series_id))
    .map((n) => ({ ...n, series_name: names.get(n.series_id).name, old_date: n.detail,
      cover_key: sbs.get(sbKey(n.series_id, n.position))?.cover_key ?? null }));
}
export async function pendingEvents(store) { return (await updates(store, { onlyUnseen: true })).sort(byUpdate); }
export async function markAllSeen(store) {
  for (const n of await store.all('notification_log')) if (!n.seen_at) await store.put('notification_log', { ...n, seen_at: nowIso() });
}
