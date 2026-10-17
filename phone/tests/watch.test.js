import test from 'node:test';
import assert from 'node:assert/strict';
import { MemStore } from '../js/store-mem.js';
import { maxRead } from '../js/db.js';
import { watchBook, unwatchBook, watchList, runWatchCheck } from '../js/watch.js';
import { updates, pendingEvents, runCheck } from '../js/check.js';
import { followSeries } from '../js/importer.js';
import { HardcoverAuthError } from '../js/hardcover.js';
import { FakeClient, book } from './helpers.js';

const TODAY = '2026-10-17';
const info = (client, id, release_date, extra = {}) => { client.info[id] = { title: `T${id}`, author: 'Au', series: null, release_date, ...extra }; };

test('watch: a book already out is refused; upcoming and undated ones are kept', async () => {
  const store = new MemStore();
  assert.equal(await watchBook(store, { hardcover_book_id: 1, title: 'Old', release_date: '2020-01-01' }, TODAY), false);
  assert.equal(await watchBook(store, { hardcover_book_id: 2, title: 'Soon', release_date: '2027-03-01' }, TODAY), true);
  assert.equal(await watchBook(store, { hardcover_book_id: 3, title: 'Someday', release_date: null }, TODAY), true);
  assert.deepEqual((await watchList(store)).map((w) => w.hardcover_book_id), [2, 3]);
  await unwatchBook(store, 2);
  assert.deepEqual((await watchList(store)).map((w) => w.hardcover_book_id), [3]);
});

test('watch check: date set, date moved, then released; each once, shown in Updates', async () => {
  const store = new MemStore(), client = new FakeClient();
  await watchBook(store, { hardcover_book_id: 3, title: 'Someday', author: 'Au', release_date: null }, TODAY);
  info(client, 3, '2027-01-10');
  let r = await runWatchCheck(store, client, { today: TODAY });
  assert.deepEqual(r.events.map((e) => e.kind), ['dated']);
  assert.deepEqual((await runWatchCheck(store, client, { today: TODAY })).events, []);           // nothing new
  info(client, 3, '2027-02-01');
  r = await runWatchCheck(store, client, { today: TODAY });
  assert.deepEqual(r.events.map((e) => [e.kind, e.old_date]), [['date_changed', '2027-01-10']]);
  r = await runWatchCheck(store, client, { today: '2027-02-02' });
  assert.deepEqual(r.events.map((e) => e.kind), ['released']);
  assert.deepEqual((await runWatchCheck(store, client, { today: '2027-02-03' })).events, []);
  const u = await updates(store);
  assert.equal(u.length, 3); assert.ok(u.every((n) => n.watch && n.series_name === 'Au'));
  assert.equal((await pendingEvents(store)).length, 3);
});

test('watch check: an undated book that turns out to be old is recorded silently; errors stay local; auth errors propagate', async () => {
  const store = new MemStore(), client = new FakeClient();
  await watchBook(store, { hardcover_book_id: 4, title: 'Old?', release_date: null }, TODAY);
  info(client, 4, '1999-05-05');
  assert.deepEqual((await runWatchCheck(store, client, { today: TODAY })).events, []);
  assert.equal((await watchList(store))[0].release_date, '1999-05-05');
  client.booksInfo = async () => { throw new Error('down'); };
  assert.match((await runWatchCheck(store, client, { today: TODAY })).errors[0], /watched books/);
  client.booksInfo = async () => { throw new HardcoverAuthError('bad token'); };
  await assert.rejects(() => runWatchCheck(store, client, { today: TODAY }), /bad token/);
});

test('runCheck includes watched books', async () => {
  const store = new MemStore(), client = new FakeClient();
  await watchBook(store, { hardcover_book_id: 5, title: 'W', release_date: '2027-01-01' }, TODAY);
  info(client, 5, '2027-06-01');
  const r = await runCheck(store, client, { today: TODAY });
  assert.deepEqual(r.events.map((e) => e.kind), ['date_changed']);
});

test('follow "only new books": everything already out counts as read; new books are still announced', async () => {
  const store = new MemStore(), client = new FakeClient();
  client.series[50] = [book(1, 'A', '2020-01-01'), book(2, 'B', '2021-01-01'), book(3, 'C', '2099-01-01')];
  const sid = await followSeries(store, client, { hardcover_series_id: 50, name: 'S', mode: 'new' }, 0, null, TODAY);
  assert.equal(await maxRead(store, sid), 2);
  assert.deepEqual((await pendingEvents(store)).map((e) => e.title), ['C']);                     // the upcoming one
});

test('follow: your place comes from books already in your history', async () => {
  const store = new MemStore(), client = new FakeClient();
  client.series[60] = [book(1, 'A', '2020-01-01', 601), book(2, 'B', '2021-01-01', 602), book(3, 'C', '2022-01-01', 603)];
  await store.put('book', { id: 1, title: 'B', author: 'X', hardcover_book_id: 602, read: 1, review_status: 'ok', source: 'hardcover' });
  const sid = await followSeries(store, client, { hardcover_series_id: 60, name: 'S2' }, 0, null, TODAY);
  assert.equal(await maxRead(store, sid), 2);
});
