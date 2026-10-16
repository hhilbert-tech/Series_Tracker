// Followed authors: any new book by them is announced (books already listed when you follow are
// recorded silently, except ones with a known future date). Books that belong to a series you
// follow are left to the series check so you don't get two alerts for one book.
import { HardcoverAuthError, HardcoverError } from './hardcover.js';
import { nowIso, todayIso } from './db.js';

export const abKey = (aid, bid) => `${aid}:${bid}`;
const isPast = (d, today) => /^\d{4}-\d{2}-\d{2}/.test(d ?? '') && d.slice(0, 10) <= today;

async function log(store, e, suppressed = false) {
  const once = e.kind !== 'date_changed';
  const key = once ? `a${e.author_id}:${e.hardcover_book_id}:${e.kind}`
    : `a${e.author_id}:${e.hardcover_book_id}:date:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  return store.add('notification_log', { key, ...e, suppressed: suppressed ? 1 : 0, seen_at: suppressed ? nowIso() : null, created_at: nowIso() });
}

export async function syncAuthor(store, author, books, today, baseline) {
  const aid = author.hardcover_author_id;
  const inSeries = new Set((await store.all('series_book')).map((r) => r.hardcover_book_id));
  const existing = new Map((await store.all('author_book')).filter((r) => r.author_id === aid).map((r) => [r.hardcover_book_id, r]));
  const events = [];
  for (const b of books) {
    const hid = b.hardcover_book_id, d = b.release_date ?? null, past = isPast(d, today), dup = inSeries.has(hid);
    const base = { series_id: null, author_id: aid, hardcover_book_id: hid, position: null, title: b.title, release_date: d, detail: null };
    const ev = (kind, old = null) => events.push({ ...base, kind, series_name: author.name, old_date: old, cover_key: null, cover_url: b.cover_url ?? null });
    const row = existing.get(hid);
    if (!row) {
      await store.put('author_book', { key: abKey(aid, hid), author_id: aid, hardcover_book_id: hid, title: b.title, release_date: d,
        cover_url: b.cover_url ?? null, first_seen_at: nowIso() });
      if (dup) continue;
      if (baseline) { if (d && !past && await log(store, { ...base, kind: 'announced' })) ev('announced'); continue; }
      if (past) { if (await log(store, { ...base, kind: 'released' })) ev('released'); }
      else if (await log(store, { ...base, kind: 'announced' })) ev('announced');
      continue;
    }
    const old = row.release_date ?? null;
    await store.put('author_book', { ...row, title: b.title, release_date: d, cover_url: b.cover_url ?? row.cover_url });
    if (dup || d === old) continue;
    if (past) { if (!isPast(old, today) && await log(store, { ...base, kind: 'released' })) ev('released'); }
    else { await log(store, { ...base, kind: 'date_changed', detail: old }); ev('date_changed', old); }
  }
  return events;
}

export async function followAuthor(store, client, info, today = todayIso()) {
  const aid = Number(info.hardcover_author_id);
  const have = await store.get('author', aid);
  if (have) return aid;
  const books = await client.authorBooks(aid);
  const author = { hardcover_author_id: aid, name: info.name, muted: 0, last_checked_at: null, cover_url: info.cover_url ?? null, added_at: nowIso() };
  await store.put('author', author);
  await syncAuthor(store, author, books, today, true);
  await store.put('author', { ...author, last_checked_at: nowIso() });
  return aid;
}

export async function removeAuthor(store, aid) {
  for (const r of await store.all('author_book')) if (r.author_id === aid) await store.delete('author_book', r.key);
  for (const r of await store.all('notification_log')) if (r.author_id === aid) await store.delete('notification_log', r.key);
  await store.delete('author', aid);
}

export async function runAuthorCheck(store, client, { today = todayIso() } = {}) {
  const res = { events: [], errors: [] };
  for (const a of (await store.all('author')).filter((x) => !x.muted).sort((x, y) => x.name.localeCompare(y.name))) {
    let books;
    try { books = await client.authorBooks(a.hardcover_author_id); }
    catch (e) {
      if (e instanceof HardcoverAuthError) { res.errors.push(e.message); break; }
      res.errors.push(e instanceof HardcoverError ? `${a.name}: ${e.message}` : `${a.name}: unexpected error (${e?.name ?? 'Error'})`);
      continue;
    }
    res.events.push(...await syncAuthor(store, a, books, today, a.last_checked_at == null));
    await store.put('author', { ...(await store.get('author', a.hardcover_author_id)), last_checked_at: nowIso() });
  }
  return res;
}
