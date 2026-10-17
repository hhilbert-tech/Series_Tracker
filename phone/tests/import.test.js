import test from 'node:test';
import assert from 'node:assert/strict';
import { MemStore } from '../js/store-mem.js';
import { maxRead, isRead } from '../js/db.js';
import { importGoodreads, importHardcover, addManualBook, addSearchBook, followSeries } from '../js/importer.js';
import { FakeClient, book, seriesHit, PAST, FUTURE } from './helpers.js';

const HEAD = 'Title,Author,ISBN,ISBN13,Exclusive Shelf,Date Read,My Rating';
const csv = (rows) => [HEAD, ...rows.map((r) => r.map((c) => `"${String(c).replaceAll('"', '""')}"`).join(','))].join('\n');
const gr = (title, author, isbn13, shelf) => [title, author, '', isbn13 ? `="${isbn13}"` : '', shelf, '', 5];

function stormlight(client) {
  client.isbns['9780765326355'] = { hardcover_book_id: 1, title: 'The Way of Kings', series: [
    { hardcover_series_id: 10, name: 'The Stormlight Archive', author: 'Brandon Sanderson', position: 1, complete: false }] };
  client.series[10] = [book(1, null, PAST), book(2, null, PAST), book(3, null, FUTURE)];
}
const only = async (store, t) => { const a = await store.all(t); assert.equal(a.length, 1); return a[0]; };

test('isbn match resolves the whole series group', async () => {
  const store = new MemStore(), client = new FakeClient(); stormlight(client);
  const res = await importGoodreads(store, csv([
    gr('The Way of Kings (The Stormlight Archive, #1)', 'Brandon Sanderson', '9780765326355', 'read'),
    gr('Words of Radiance (The Stormlight Archive, #2)', 'Brandon Sanderson', '', 'read')]), client);
  assert.equal(res.series_followed, 1); assert.equal(res.needs_review, 0);
  const s = await only(store, 'series');
  assert.equal(await maxRead(store, s.id), 2);
  assert.equal((await store.all('book')).filter((b) => b.series_id === s.id).length, 2);
  assert.equal((await store.all('series_book')).length, 3);
});

test('fuzzy name match when no isbn', async () => {
  const store = new MemStore(), client = new FakeClient();
  client.seriesByName = [seriesHit(21, 'Mistborn: Wax and Wayne', 'Brandon Sanderson'), seriesHit(20, 'The Mistborn Saga', 'Brandon Sanderson')];
  client.series[20] = [book(1, null, PAST)];
  const res = await importGoodreads(store, csv([gr('The Final Empire (Mistborn, #1)', 'Brandon Sanderson', '', 'read')]), client);
  assert.equal(res.series_followed, 1);
  assert.equal((await only(store, 'series')).hardcover_series_id, 20);
});

test('unmatched goes to review', async () => {
  const store = new MemStore(), client = new FakeClient();
  client.seriesByName = [seriesHit(99, 'Totally Different', 'Someone Else')];
  const res = await importGoodreads(store, csv([gr('Lost Tale (Obscure Saga, #1)', 'Nobody Known', '', 'read')]), client);
  assert.equal(res.series_followed, 0); assert.equal(res.needs_review, 1);
  const b = await only(store, 'book');
  assert.equal(b.review_status, 'needs_review'); assert.equal(b.series_id, null);
});

test('shelves, decimals and non-series rows', async () => {
  const store = new MemStore(), client = new FakeClient(); stormlight(client);
  await importGoodreads(store, csv([
    gr('The Way of Kings (The Stormlight Archive, #1)', 'Brandon Sanderson', '9780765326355', 'read'),
    gr('Edgedancer (The Stormlight Archive, #2.5)', 'Brandon Sanderson', '', 'read'),
    gr('Oathbringer (The Stormlight Archive, #3)', 'Brandon Sanderson', '', 'to-read'),
    gr('Piranesi', 'Susanna Clarke', '', 'read')]), client);
  const s = await only(store, 'series');
  assert.equal(await maxRead(store, s.id), 1);
  assert.equal((await store.all('book')).length, 2);
});

test('currently-reading counts as read', async () => {
  const store = new MemStore(), client = new FakeClient(); stormlight(client);
  await importGoodreads(store, csv([
    gr('The Way of Kings (The Stormlight Archive, #1)', 'Brandon Sanderson', '9780765326355', 'read'),
    gr('Words of Radiance (The Stormlight Archive, #2)', 'Brandon Sanderson', '', 'currently-reading')]), client);
  assert.equal(await maxRead(store, (await only(store, 'series')).id), 2);
});

test('re-import is idempotent', async () => {
  const store = new MemStore(), client = new FakeClient(); stormlight(client);
  const text = csv([gr('The Way of Kings (The Stormlight Archive, #1)', 'Brandon Sanderson', '9780765326355', 'read')]);
  await importGoodreads(store, text, client); await importGoodreads(store, text, client);
  assert.equal((await store.all('book')).length, 1); assert.equal((await store.all('series')).length, 1);
});

test('import without a client leaves everything for review', async () => {
  const store = new MemStore();
  const res = await importGoodreads(store, csv([gr('A (S, #1)', 'Au', '', 'read')]), null);
  assert.equal(res.series_followed, 0); assert.equal(res.needs_review, 1);
});

test('hardcover library import', async () => {
  const store = new MemStore(), client = new FakeClient();
  client.library = [
    { hardcover_book_id: 5, title: 'Book Two', author: 'A', isbn13: null, read: true,
      series: [{ hardcover_series_id: 30, name: 'S', author: 'A', position: 2, complete: false }] },
    { hardcover_book_id: 6, title: 'Standalone', author: 'A', isbn13: null, read: true, series: [] }];
  client.series[30] = [book(1, null, PAST), book(2, null, PAST), book(3, null, FUTURE)];
  const res = await importHardcover(store, client);
  assert.equal(res.series_followed, 1);
  const s = await only(store, 'series');
  assert.equal(await maxRead(store, s.id), 2);
  assert.equal((await only(store, 'book')).source, 'hardcover');
});

// Acceptance test 8 (logic half; the UI half runs in the browser test)
test('follow creates a tracked series with the chosen read-up-to, and never lowers it', async () => {
  const store = new MemStore(), client = new FakeClient();
  client.series[7] = [1, 2, 3, 4].map((i) => book(i, null, i < 4 ? PAST : FUTURE));
  const info = { hardcover_series_id: 7, name: 'Harbor Lights Saga', author: 'Ann Author' };
  const sid = await followSeries(store, client, info, 2);
  const s = await store.get('series', sid);
  assert.equal(s.muted, 0); assert.equal(await maxRead(store, sid), 2);
  assert.equal((await store.all('series_book')).length, 4);
  await followSeries(store, client, info, 1);
  assert.equal((await store.all('series')).length, 1); assert.equal(await maxRead(store, sid), 2);
});

test("I've read it: stores the book, follows nothing, and is picked up when its series is followed later", async () => {
  const store = new MemStore(), client = new FakeClient();
  client.series[7] = [book(1, null, PAST, 54), book(2, null, PAST, 55)];
  const r = await addSearchBook(store, { hardcover_book_id: 55, title: 'Harbor Lights', author: 'Ann' });
  const b = await only(store, 'book');
  assert.equal(b.source, 'search'); assert.equal(b.read, 1); assert.equal(r.series, null);
  assert.equal((await store.all('series')).length, 0);
  const sid = await followSeries(store, client, { hardcover_series_id: 7, name: 'Harbor Lights Saga' });
  assert.equal(await maxRead(store, sid), 2);
});

test("I've read it: a book in a series you already follow is ticked off there", async () => {
  const store = new MemStore(), client = new FakeClient();
  client.series[7] = [book(1, null, PAST, 54), book(2, null, PAST, 55), book(3, null, PAST, 56)];
  const sid = await followSeries(store, client, { hardcover_series_id: 7, name: 'Harbor Lights Saga' });
  const r = await addSearchBook(store, { hardcover_book_id: 55, title: 'Two', author: 'Ann' });
  assert.equal(r.series, 'Harbor Lights Saga');
  const rows = (await store.all('series_book')).filter((x) => x.series_id === sid).sort((a, c) => a.position - c.position);
  assert.deepEqual(rows.map((x) => isRead(x, 0)), [false, true, false]);                       // just that book, not "up to"
});

// Acceptance test 9
test('hand-entered book with no match is saved as manual and needs review', async () => {
  const store = new MemStore(), client = new FakeClient();
  const matched = await addManualBook(store, client, { title: 'Handmade Tale', author: 'Me', series_name: 'Home Saga', position: '1', isbn: '' });
  assert.equal(matched, false);
  const b = await only(store, 'book');
  assert.equal(b.source, 'manual'); assert.equal(b.review_status, 'needs_review');
});

test('hand-entered book matches via isbn', async () => {
  const store = new MemStore(), client = new FakeClient(); stormlight(client);
  const ok = await addManualBook(store, client, { title: 'The Way of Kings', author: 'BS', series_name: '', position: '', isbn: '978-0-7653-2635-5' });
  assert.equal(ok, true);
  assert.equal(await maxRead(store, (await only(store, 'series')).id), 1);
  assert.equal((await only(store, 'book')).review_status, 'ok');
});

import { reviewGroups, assignGroup, ignoreGroup } from '../js/importer.js';

test('review: assign links the whole group; ignore hides it', async () => {
  const store = new MemStore(), client = new FakeClient();
  await importGoodreads(store, csv([
    gr('Lost Tale (Obscure Saga, #1)', 'Nobody Known', '', 'read'),
    gr('Lost Tale 2 (Obscure Saga, #2)', 'Nobody Known', '', 'read')]), client);
  await addManualBook(store, client, { title: 'Skip Me', author: 'X' }, null);
  let groups = await reviewGroups(store);
  assert.equal(groups.length, 2);
  const saga = groups.find((g) => g.lead.series_name_raw === 'Obscure Saga');
  assert.equal(saga.books.length, 2);

  client.series[50] = [book(1, null, PAST)];
  const sid = await assignGroup(store, client, saga.lead.id, { hardcover_series_id: 50, name: 'Obscure Saga', author: 'Nobody Known' });
  assert.equal(await maxRead(store, sid), 2);
  assert.ok((await store.all('book')).filter((b) => b.series_name_raw === 'Obscure Saga').every((b) => b.series_id === sid && b.review_status === 'ok'));

  const skip = (await reviewGroups(store))[0];
  await ignoreGroup(store, skip.lead.id);
  assert.equal((await reviewGroups(store)).length, 0);
});

test('a removed series is not re-followed by a Hardcover sync, until followed again on purpose', async () => {
  const { removeSeries, unremoveSeries, maxRead: mr } = await import('../js/db.js');
  const store = new MemStore(), client = new FakeClient();
  client.library = [{ hardcover_book_id: 5, title: 'B2', author: 'A', isbn13: null, read: true,
    series: [{ hardcover_series_id: 30, name: 'S', author: 'A', position: 2, complete: false }] }];
  client.series[30] = [book(1, null, PAST), book(2, null, PAST), book(3, null, FUTURE)];
  await importHardcover(store, client);
  const s = await only(store, 'series');
  await removeSeries(store, s.id);
  const res = await importHardcover(store, client);
  assert.equal(res.series_followed, 0);
  assert.equal((await store.all('series')).length, 0);
  await unremoveSeries(store, 30);                       // user follows it again
  await importHardcover(store, client);
  assert.equal(await mr(store, (await only(store, 'series')).id), 2);
});
