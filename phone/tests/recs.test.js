import test from 'node:test';
import assert from 'node:assert/strict';
import { MemStore } from '../js/store-mem.js';
import { upsertSeries, bumpProgress, removeSeries, setSetting } from '../js/db.js';
import { buildRecs, loadRecs, dismissRec, recsStale, RECS_TTL_MS } from '../js/recs.js';
import { HardcoverAuthError, HardcoverClient } from '../js/hardcover.js';
import { FakeClient, book, PAST } from './helpers.js';

const ser = (id, name, author, extra = {}) => ({ hardcover_series_id: id, name, author, cover_url: null, books_count: 3, complete: false, ...extra });
async function setup() {
  const store = new MemStore(), client = new FakeClient();
  const sid = await upsertSeries(store, 1, 'Harbor Lights', 'Ann Author');
  await bumpProgress(store, sid, 2);
  await store.put('series_book', { key: `${sid}:1`, series_id: sid, position: 1, hardcover_book_id: 11, title: 'One', release_date: PAST });
  await store.put('series_book', { key: `${sid}:2`, series_id: sid, position: 2, hardcover_book_id: 12, title: 'Two', release_date: PAST });
  await store.put('series_book', { key: `${sid}:3`, series_id: sid, position: 3, hardcover_book_id: 13, title: 'Three (unread)', release_date: PAST });
  client.authorSeriesMap['Ann Author'] = [ser(1, 'Harbor Lights', 'Ann Author'), ser(2, 'Tide Pool', 'Ann Author')];
  client.tags = { 11: [{ slug: 'fantasy', name: 'Fantasy', count: 5 }, { slug: 'romance', name: 'Romance', count: 1 }], 12: [{ slug: 'fantasy', name: 'Fantasy', count: 3 }], 13: [{ slug: 'horror', name: 'Horror', count: 99 }] };
  client.genreSeries.fantasy = [ser(3, 'Dragon Saga', 'B. Writer', { users_count: 500 }), ser(2, 'Tide Pool', 'Ann Author', { users_count: 900 }), ser(1, 'Harbor Lights', 'Ann Author', { users_count: 50 })];
  client.genreSeries.romance = [ser(4, 'Hearts', 'C. Penn', { users_count: 100 })];
  return { store, client };
}

test('author matches come first, genre matches follow; followed series excluded; tags only from READ books', async () => {
  const { store, client } = await setup();
  await buildRecs(store, client);
  const r = await loadRecs(store);
  assert.deepEqual(r.items.map((i) => [i.name, i.why]), [['Tide Pool', 'More by Ann Author'], ['Dragon Saga', 'Popular in Fantasy'], ['Hearts', 'Popular in Romance']]);
  const tagCall = client.calls.find((c) => c[0] === 'bookTags');
  assert.deepEqual(tagCall[1].sort(), [11, 12]);                         // book 13 is unread
  assert.ok(!client.calls.some((c) => c[0] === 'popularInGenre' && c[1] === 'horror'));
});

test('follow, remove and dismiss change what is shown without a new request', async () => {
  const { store, client } = await setup();
  await buildRecs(store, client);
  await upsertSeries(store, 3, 'Dragon Saga', 'B. Writer');                // you followed it
  await dismissRec(store, 4);                                              // not interested
  assert.deepEqual((await loadRecs(store)).items.map((i) => i.name), ['Tide Pool']);
  const sid = await upsertSeries(store, 2, 'Tide Pool', 'Ann Author');
  await removeSeries(store, sid);                                          // removed series never come back
  assert.equal((await loadRecs(store)).items.length, 0);
});

test('a failed lookup only removes that source; an auth failure propagates; all-failed is retried soon', async () => {
  const { store, client } = await setup();
  client.authorSeries = async () => { throw new Error('boom'); };
  const r = await buildRecs(store, client);
  assert.ok(r.items.length > 0 && r.errors.length === 1);                  // genres still worked
  const s2 = await setup();
  s2.client.authorSeries = async () => { throw new HardcoverAuthError('rejected'); };
  await assert.rejects(() => buildRecs(s2.store, s2.client), /rejected/);
  const s3 = await setup();
  s3.client.authorSeries = async () => { throw new Error('x'); }; s3.client.bookTags = async () => { throw new Error('y'); };
  const bad = await buildRecs(s3.store, s3.client);
  assert.equal(bad.items.length, 0);
  assert.equal(recsStale(bad, Date.now() + 7 * 36e5), true);               // stale again in ~6 h, not a week
  assert.equal(recsStale(bad), false);
});

test('recsStale: none, fresh, week-old', () => {
  assert.equal(recsStale(null), true);
  assert.equal(recsStale({ at: new Date().toISOString() }), false);
  assert.equal(recsStale({ at: new Date(Date.now() - RECS_TTL_MS - 1000).toISOString() }), true);
});

test('Hardcover client: authorSeries is one aliased request and filters other authors; bookTags/popularInGenre normalise', async () => {
  const json = (b) => new Response(JSON.stringify(b), { status: 200 });
  const bodies = [];
  const hits = (ds) => ({ results: { hits: ds.map((document) => ({ document })) } });
  const c = new HardcoverClient({ getToken: () => 't', limiter: { async acquire() {} }, fetch: async (u, init) => {
    const b = JSON.parse(init.body); bodies.push(b);
    if (b.query.includes('AuthorSeries')) return json({ data: { a0: hits([{ id: '2', name: 'Tide Pool', author_names: ['Ann Author'] }, { id: '9', name: 'Imposter', author_names: ['Someone Else'] }]), a1: hits([]) } });
    if (b.query.includes('BookTags')) return json({ data: { books: [{ id: 11, cached_tags: { Genre: [{ tag: 'Fantasy', tagSlug: 'fantasy', count: 4 }], Tag: [{ tag: 'Dark Fantasy', tagSlug: 'dark-fantasy', count: 2 }] } }, { id: 12, cached_tags: '{"Genre":[{"tag":"Horror","tagSlug":"horror"}]}' }, { id: 13, cached_tags: null }] } });
    return json({ data: { books: [{ id: 1, users_count: 7, image: { url: 'u' }, book_series: [{ series: { id: 5, name: 'S', author: { name: 'A' }, is_completed: true } }] }, { id: 2, book_series: [] }] } });
  } });
  const m = await c.authorSeries(['Ann Author', 'Zed']);
  assert.equal(bodies.length, 1);
  assert.deepEqual(m.get('Ann Author').map((s) => s.name), ['Tide Pool']);
  assert.deepEqual(await c.bookTags([11, 12, 13]), [
    { id: 11, genres: [{ slug: 'fantasy', name: 'Fantasy', count: 4 }], tags: [{ slug: 'dark-fantasy', name: 'Dark Fantasy', count: 2 }], categories: ['Genre', 'Tag'] },
    { id: 12, genres: [{ slug: 'horror', name: 'Horror', count: 1 }], tags: [], categories: ['Genre'] }, { id: 13, genres: [], tags: [], categories: [] }]);
  const g = await c.popularInGenre('fantasy');
  assert.deepEqual(g, [{ hardcover_series_id: 5, name: 'S', author: 'A', cover_url: 'u', complete: true, users_count: 7, rating: null }]);
  assert.deepEqual(bodies[2].variables, { tag: { Genre: [{ tagSlug: 'fantasy' }] } });
});

test('subgenre tags rank above plain genre matches and use the Tag category', async () => {
  const store = new MemStore(), client = new FakeClient();
  const sid = await upsertSeries(store, 1, 'Read Saga', 'Ann Author');
  await store.put('series_book', { key: `${sid}:1`, series_id: sid, position: 1, hardcover_book_id: 11, title: 'One', release_date: '2010-01-01' });
  await bumpProgress(store, sid, 1);
  client.tags[11] = [{ slug: 'fantasy', name: 'Fantasy', count: 3 }]; client.subtags[11] = [{ slug: 'dark-fantasy', name: 'Dark Fantasy', count: 2 }];
  client.genreSeries['dark-fantasy'] = [{ hardcover_series_id: 50, name: 'Grim', author: 'G', cover_url: null, complete: false, users_count: 10 }];
  client.genreSeries.fantasy = [{ hardcover_series_id: 51, name: 'Plain', author: 'P', cover_url: null, complete: false, users_count: 9000 }, { hardcover_series_id: 50, name: 'Grim', author: 'G', cover_url: null, complete: false, users_count: 10 }];
  const rec = await buildRecs(store, client);
  assert.deepEqual(rec.items.map((i) => i.name), ['Grim', 'Plain']);
  assert.equal(rec.items[0].why, 'Popular in Dark Fantasy');
  assert.ok(client.calls.some((c) => c[0] === 'popularInGenre' && c[1] === 'dark-fantasy' && c[2] === 'Tag'));
});
