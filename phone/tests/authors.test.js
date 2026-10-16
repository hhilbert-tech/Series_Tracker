import test from 'node:test';
import assert from 'node:assert/strict';
import { MemStore } from '../js/store-mem.js';
import { upsertSeries } from '../js/db.js';
import { followAuthor, removeAuthor } from '../js/authors.js';
import { runCheck, updates, pendingEvents } from '../js/check.js';
import { HardcoverClient } from '../js/hardcover.js';
import { FakeClient, book, TODAY, PAST, FUTURE } from './helpers.js';

const A = { hardcover_author_id: 9, name: 'Ann Author' };
const ab = (id, title, date) => ({ hardcover_book_id: id, title, release_date: date, cover_url: null });

test('follow records existing books silently; only known-future books are announced', async () => {
  const store = new MemStore(), client = new FakeClient();
  client.authors[9] = [ab(1, 'Old One', PAST), ab(2, 'Undated Old', null), ab(3, 'Coming Soon', FUTURE)];
  await followAuthor(store, client, A, TODAY);
  assert.equal((await store.all('author_book')).length, 3);
  assert.deepEqual((await pendingEvents(store)).map((e) => [e.kind, e.title, e.series_name]), [['announced', 'Coming Soon', 'Ann Author']]);
});

test('later checks: new book announced once, date change, then released', async () => {
  const store = new MemStore(), client = new FakeClient();
  client.authors[9] = [ab(1, 'Old One', PAST)];
  await followAuthor(store, client, A, TODAY);
  client.authors[9] = [ab(1, 'Old One', PAST), ab(2, 'New Book', FUTURE)];
  let res = await runCheck(store, client, { today: TODAY });
  assert.deepEqual(res.events.map((e) => [e.kind, e.title]), [['announced', 'New Book']]);
  res = await runCheck(store, client, { today: TODAY });
  assert.equal(res.events.length, 0);                                   // no repeat
  client.authors[9][1].release_date = '2099-06-01';
  res = await runCheck(store, client, { today: TODAY });
  assert.deepEqual(res.events.map((e) => e.kind), ['date_changed']);
  client.authors[9][1].release_date = PAST;
  res = await runCheck(store, client, { today: TODAY });
  assert.deepEqual(res.events.map((e) => e.kind), ['released']);
  res = await runCheck(store, client, { today: TODAY });
  assert.equal(res.events.length, 0);                                   // old books never "released" again
});

test('books from a followed series are left to the series check; muted authors skipped', async () => {
  const store = new MemStore(), client = new FakeClient();
  client.authors[9] = [ab(1, 'Old One', PAST)];
  await followAuthor(store, client, A, TODAY);
  const sid = await upsertSeries(store, 1, 'Saga', 'Ann Author');
  await store.put('series_book', { key: `${sid}:4`, series_id: sid, position: 4, hardcover_book_id: 44, title: 'Saga 4', release_date: FUTURE });
  client.authors[9] = [ab(1, 'Old One', PAST), ab(44, 'Saga 4', FUTURE), ab(5, 'Standalone', FUTURE)];
  let res = await runCheck(store, client, { today: TODAY });
  assert.deepEqual(res.events.map((e) => e.title), ['Standalone']);
  await store.put('author', { ...(await store.get('author', 9)), muted: 1 });
  client.authors[9].push(ab(6, 'Muted Book', FUTURE));
  res = await runCheck(store, client, { today: TODAY });
  assert.equal(res.events.length, 0);
});

test('removeAuthor clears author, books and updates', async () => {
  const store = new MemStore(), client = new FakeClient();
  client.authors[9] = [ab(3, 'Coming Soon', FUTURE)];
  await followAuthor(store, client, A, TODAY);
  await removeAuthor(store, 9);
  assert.equal((await store.all('author')).length + (await store.all('author_book')).length, 0);
  assert.equal((await updates(store)).length, 0);
});

test('authorBooks normalises, skips non-author credits and duplicates', async () => {
  const json = (body) => new Response(JSON.stringify(body), { status: 200 });
  const c = new HardcoverClient({ getToken: () => 't', limiter: { async acquire() {} }, fetch: async (u, init) => {
    assert.match(JSON.parse(init.body).query, /contributions/);
    return json({ data: { contributions: [
      { contribution: null, book: { id: 1, title: 'One', release_date: '2020-01-01T00:00:00', image: { url: 'u' } } },
      { contribution: 'Illustrator', book: { id: 2, title: 'Pics', release_date: null, image: null } },
      { contribution: 'Author', book: { id: 1, title: 'One', release_date: null, image: null } },
      { contribution: null, book: { id: 3, title: 'Three', release_date: null, image: null } },
    ] } });
  } });
  assert.deepEqual((await c.authorBooks(9)).map((b) => [b.hardcover_book_id, b.release_date]), [[1, '2020-01-01'], [3, null]]);
});
