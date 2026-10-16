import test from 'node:test';
import assert from 'node:assert/strict';
import { MemStore } from '../js/store-mem.js';
import { upsertSeries, bumpProgress, removeSeries, setSetting } from '../js/db.js';
import { buildRecs, loadRecs, dismissRec, recsStale, authorPicks, shelves, RECS_TTL_MS } from '../js/recs.js';
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

test('series authors and genres give picks; followed series excluded; tags only from READ books', async () => {
  const { store, client } = await setup();
  await buildRecs(store, client);
  const r = await loadRecs(store);
  assert.deepEqual(r.items.map((i) => [i.title, i.why, i.key]), [['Tide Pool', 'More by Ann Author', 's:2'], ['Dragon Saga', 'Popular in Fantasy', 's:3'], ['Hearts', 'Popular in Romance', 's:4']]);
  const tagCall = client.calls.find((c) => c[0] === 'bookTags');
  assert.deepEqual(tagCall[1].sort(), [11, 12]);                         // book 13 is unread
  assert.ok(!client.calls.some((c) => c[0] === 'popularInGenre' && c[1] === 'horror'));
});

test('follow, remove and dismiss change what is shown without a new request; old numeric dismissals still apply', async () => {
  const { store, client } = await setup();
  await buildRecs(store, client);
  await upsertSeries(store, 3, 'Dragon Saga', 'B. Writer');                // you followed it
  await setSetting(store, 'recs_dismissed', [4]);                          // dismissed before v2 (series id)
  assert.deepEqual((await loadRecs(store)).items.map((i) => i.title), ['Tide Pool']);
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
  assert.equal(recsStale({ at: null, items: [] }), true);                  // only local picks so far
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
  assert.deepEqual(g, [{ hardcover_series_id: 5, name: 'S', author: 'A', cover_url: 'u', complete: true, users_count: 7, rating: null, hardcover_book_id: 1, title: null }]);
  assert.deepEqual(bodies[2].variables, { tag: { Genre: [{ tagSlug: 'fantasy' }] } });
});

test('Hardcover client: booksInfo returns author, author id and series position; standalones keep series null', async () => {
  const c = new HardcoverClient({ getToken: () => 't', limiter: { async acquire() {} }, fetch: async () => new Response(JSON.stringify({ data: { books: [
    { id: 1, title: 'In', users_count: 3, rating: 4.2, image: { url: 'u' }, contributions: [{ author: { id: 9, name: 'Nia' } }], book_series: [{ position: '2', series: { id: 5, name: 'S', author: { name: 'Nia' }, is_completed: false } }] },
    { id: 2, title: 'Solo', contributions: [], book_series: [] }] } }), { status: 200 }) });
  const [a, b] = await c.booksInfo([1, 2]);
  assert.deepEqual([a.author, a.author_id, a.series.position, a.series.hardcover_series_id], ['Nia', 9, 2, 5]);
  assert.deepEqual([b.author, b.author_id, b.series], [null, null, null]);
});

test('subgenre tags rank above plain genre matches and use the Tag category', async () => {
  const store = new MemStore(), client = new FakeClient();
  const sid = await upsertSeries(store, 1, 'Read Saga', 'Ann Author');
  await store.put('series_book', { key: `${sid}:1`, series_id: sid, position: 1, hardcover_book_id: 11, title: 'One', release_date: '2010-01-01' });
  await bumpProgress(store, sid, 1);
  client.tags[11] = [{ slug: 'fantasy', name: 'Fantasy', count: 3 }]; client.subtags[11] = [{ slug: 'dark-fantasy', name: 'Dark Fantasy', count: 2 }];
  client.genreSeries['dark-fantasy'] = [{ hardcover_series_id: 50, name: 'Grim', author: 'G', cover_url: null, complete: false, users_count: 10, hardcover_book_id: 500, title: 'Grim One' }];
  client.genreSeries.fantasy = [{ hardcover_series_id: 51, name: 'Plain', author: 'P', cover_url: null, complete: false, users_count: 9000 }, { hardcover_series_id: 50, name: 'Grim', author: 'G', cover_url: null, complete: false, users_count: 10 }];
  const rec = await buildRecs(store, client);
  assert.deepEqual(rec.items.map((i) => i.series.name), ['Grim', 'Plain']);
  assert.equal(rec.items[0].why, 'Popular in Dark Fantasy');
  assert.deepEqual([rec.items[0].hardcover_book_id, rec.items[0].title, rec.items[0].series.position], [500, 'Grim One', 1]);   // book 1 of the series
  assert.equal(rec.items[1].title, 'Plain');                                                     // no book known: shown by series name
  assert.ok(client.calls.some((c) => c[0] === 'popularInGenre' && c[1] === 'dark-fantasy' && c[2] === 'Tag'));
});

test('similar books: ranked by overlap, standalones included, one per series, read books excluded', async () => {
  const store = new MemStore(), client = new FakeClient();
  const sid = await upsertSeries(store, 1, 'Read Saga', 'Ann Author');
  for (const [p, id] of [[1, 11], [2, 12]]) await store.put('series_book', { key: `${sid}:${p}`, series_id: sid, position: p, hardcover_book_id: id, title: `Book ${p}`, release_date: '2010-01-01' });
  await bumpProgress(store, sid, 2);
  client.similar[11] = [12, 21, 22, 23, 24]; client.similar[12] = [22, 21, 23];
  const inSer = (n, s = n, p = 1) => ({ series: { hardcover_series_id: s, name: `S${s}`, author: 'X', complete: false, position: p }, title: `T${n}`, author: 'X', author_id: 7, users_count: 1, rating: 4, cover_url: null });
  client.info[21] = inSer(21); client.info[22] = inSer(22); client.info[23] = { ...inSer(23), series: null }; client.info[24] = inSer(24, 22, 2);   // 23 standalone; 24 is #2 of S22
  const rec = await buildRecs(store, client);
  const sims = rec.items.filter((i) => i.kind === 'similar');
  assert.deepEqual(sims.map((i) => [i.title, i.key]), [['T22', 's:22'], ['T21', 's:21'], ['T23', 'b:23']]);
  assert.equal(sims[0].why, 'Similar to Book 2');
  assert.equal(sims[0].group, 'Because you read Book 2');
  assert.equal(sims[2].author_id, 7);
});

test('books from your reading history (not only series) seed "similar" and are never suggested', async () => {
  const store = new MemStore(), client = new FakeClient();
  await store.put('book', { id: 1, title: 'Lonely Mountain', author: 'Solo', hardcover_book_id: 31, read: 1, review_status: 'ok', source: 'hardcover' });
  await store.put('book', { id: 2, title: 'Also Read', author: 'Z', hardcover_book_id: null, read: 1, review_status: 'ok', source: 'goodreads' });
  client.similar[31] = [41, 42];
  client.info[41] = { title: 'Also Read', author: 'Z', series: null }; client.info[42] = { title: 'Fresh', author: 'Q', series: null };
  await buildRecs(store, client);
  assert.deepEqual(client.calls.find((c) => c[0] === 'similarBookIds')[1], [31]);
  assert.deepEqual((await loadRecs(store)).items.map((i) => i.title), ['Fresh']);                 // matched by title + author
  await dismissRec(store, 'b:42');
  assert.equal((await loadRecs(store)).items.length, 0);
});

test('followed authors: released unread books outside followed series, one per series (earliest), always current', async () => {
  const store = new MemStore(), today = '2026-10-16';
  await store.put('author', { hardcover_author_id: 9, name: 'Nia Pen', muted: 0 });
  await store.put('author', { hardcover_author_id: 8, name: 'Muted Max', muted: 1 });
  const ab = (bid, extra) => store.put('author_book', { key: `9:${bid}`, author_id: 9, hardcover_book_id: bid, title: `B${bid}`, release_date: '2020-01-01', series_id: null, users_count: bid, ...extra });
  await ab(1); await ab(2, { read: true }); await ab(3, { release_date: '2099-01-01' });
  await ab(4, { series_id: 70, series_name: 'Saga', series_position: 2 }); await ab(5, { series_id: 70, series_name: 'Saga', series_position: 1 });
  await ab(6, { series_id: 71, series_name: 'Mine', series_position: 1 }); await ab(7, { release_date: null });
  await store.put('author_book', { key: '8:99', author_id: 8, hardcover_book_id: 99, title: 'Muted', release_date: '2020-01-01', series_id: null });
  await upsertSeries(store, 71, 'Mine', 'Nia Pen');
  const picks = await authorPicks(store, today);
  assert.deepEqual(picks.map((p) => [p.title, p.key]).sort(), [['B1', 'b:1'], ['B5', 's:70'], ['B7', 'b:7']]);
  assert.equal(picks[0].why, 'By Nia Pen');
  const r = await loadRecs(store, today);                                                       // works before any network build
  assert.equal(r.items.length, 3); assert.equal(recsStale(r), true);
});

test('shelves: groups in rank order; single-book "Because you read" groups fold together', () => {
  const it = (key, group, kind = 'similar') => ({ key, group, kind });
  const s = shelves([it('b:1', 'Because you read A'), it('b:2', 'Because you read A'), it('b:3', 'Because you read B'), it('b:4', 'Because you read C'),
    it('b:5', 'From authors you follow', 'followed')]);
  assert.deepEqual(s.map((g) => [g.label, g.items.map((x) => x.key)]), [['Because you read A', ['b:1', 'b:2']], ['Similar to books you read', ['b:3', 'b:4']], ['From authors you follow', ['b:5']]]);
});
