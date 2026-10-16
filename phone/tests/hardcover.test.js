import test from 'node:test';
import assert from 'node:assert/strict';
import { HardcoverClient, HardcoverAuthError, HardcoverError } from '../js/hardcover.js';

const SERIES_RESPONSE = { data: { book_series: [
  { position: 1, book: { id: 11, title: 'One', release_date: '2020-05-01', image: { url: 'https://img/1.jpg' } } },
  { position: 2.5, book: { id: 12, title: 'Two and a half', release_date: null, image: null } },
  { position: null, book: { id: 13, title: 'Unpositioned', release_date: null, image: null } },
] } };

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const limiter = () => ({ n: 0, async acquire() { this.n++; } });
function make(handler, extra = {}) {
  return new HardcoverClient({ getToken: () => 'secret-token', fetch: handler, limiter: extra.limiter ?? limiter() });
}

test('seriesBooks is normalised and the query follows the spec', async () => {
  let seen;
  const c = make(async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return json(SERIES_RESPONSE); });
  const books = await c.seriesBooks(42);
  assert.deepEqual(books.map((b) => b.position), [1, 2.5]);
  assert.deepEqual(books[0], { position: 1, hardcover_book_id: 11, title: 'One', release_date: '2020-05-01', cover_url: 'https://img/1.jpg' });
  assert.equal(seen.init.headers.authorization, 'Bearer secret-token');
  for (const needle of ['canonical_id', 'is_partial_book', 'compilation', 'distinct_on', 'users_count']) {
    assert.ok(seen.body.query.includes(needle), needle);
  }
  assert.equal(seen.body.variables.id, 42);
});

test('every request goes through the limiter', async () => {
  const lim = limiter();
  const c = make(async () => json(SERIES_RESPONSE), { limiter: lim });
  await c.seriesBooks(1); await c.seriesBooks(2);
  assert.equal(lim.n, 2);
});

// Acceptance test 7 (client half)
test('401 raises a clear auth error without leaking the token', async () => {
  const c = make(async () => json({ error: 'Unauthorized' }, 401));
  await assert.rejects(c.seriesBooks(1), (e) => {
    assert.ok(e instanceof HardcoverAuthError);
    assert.ok(e.message.includes('token') && !e.message.includes('secret-token'));
    return true;
  });
});

test('missing token is an auth error and makes no request', async () => {
  let called = false;
  const c = new HardcoverClient({ getToken: () => '', fetch: async () => { called = true; }, limiter: limiter() });
  await assert.rejects(c.seriesBooks(1), HardcoverAuthError);
  assert.equal(called, false);
});

test('graphql errors and network failures raise HardcoverError', async () => {
  await assert.rejects(make(async () => json({ errors: [{ message: "field 'x' not found" }] })).seriesBooks(1), /not found/);
  const offline = make(async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(offline.seriesBooks(1), (e) => e instanceof HardcoverError && !(e instanceof HardcoverAuthError));
});

test('search is cached and normalised', async () => {
  let calls = 0;
  const c = make(async () => { calls++; return json({ data: { search: { results: { hits: [
    { document: { id: '9', title: 'Harbor Lights', author_names: ['Ann Author'], image: { url: 'https://img/h.jpg' }, release_date: '2021-01-01' } }] } } } }); });
  const a = await c.searchBooks('Harbor Lights');
  const b = await c.searchBooks('harbor lights ');
  assert.deepEqual(a, b); assert.equal(calls, 1);
  assert.equal(a[0].title, 'Harbor Lights'); assert.equal(a[0].author, 'Ann Author'); assert.equal(a[0].hardcover_book_id, 9);
});

test('findByIsbn shape', async () => {
  const c = make(async () => json({ data: { editions: [{ book: { id: 1, title: 'T', book_series: [
    { position: 3, series: { id: 7, name: 'S', author: { name: 'Au' }, is_completed: true } }] } }] } }));
  const r = await c.findByIsbn('9780765326355');
  assert.equal(r.hardcover_book_id, 1);
  assert.deepEqual(r.series[0], { hardcover_series_id: 7, name: 'S', author: 'Au', position: 3, complete: true });
  const none = make(async () => json({ data: { editions: [] } }));
  assert.equal(await none.findByIsbn('9780000000000'), null);
});

test('bookDetails returns description and pages, tolerating gaps', async () => {
  const c = make(async () => json({ data: { books: [{ description: 'A tale.', pages: 320, rating: 4.25 }] } }));
  assert.deepEqual(await c.bookDetails(5), { description: 'A tale.', pages: 320, rating: 4.25 });
  const e = make(async () => json({ data: { books: [] } }));
  assert.deepEqual(await e.bookDetails(6), { description: null, pages: null, rating: null });
});

test('search costs ONE request for series, books and authors', async () => {
  let calls = 0, body;
  const hits = (d) => ({ results: { hits: d.map((document) => ({ document })) } });
  const c = make(async (u, init) => { calls++; body = JSON.parse(init.body).query;
    return json({ data: { s: hits([{ id: '7', name: 'Saga' }]), b: hits([{ id: '5', title: 'Book' }]), a: hits([{ id: '9', name: 'Ann' }]) } }); });
  const r = await c.search('ann');
  assert.equal(calls, 1);
  for (const t of ['Series', 'Book', 'Author']) assert.match(body, new RegExp(`query_type: "${t}"`));
  assert.deepEqual([r.series[0].name, r.books[0].title, r.authors[0].name], ['Saga', 'Book', 'Ann']);
  await c.search('ANN');                                          // cached
  assert.equal(calls, 1);
});

test('a 429 pauses every later request (Retry-After honoured) instead of hammering', async () => {
  let calls = 0;
  const slept = [];
  const c = new HardcoverClient({ getToken: () => 't', limiter: limiter(), sleep: async (ms) => { slept.push(ms); },
    fetch: async () => { calls++; return calls === 1 ? new Response('{}', { status: 429, headers: { 'retry-after': '8' } }) : json({ data: { book_series: [] } }); } });
  await assert.rejects(() => c.seriesBooks(1), /429.*8 seconds/);
  assert.equal(calls, 1);
  await c.seriesBooks(1);                                         // short wait: sleeps, then goes through
  assert.equal(slept.length, 1);
  assert.ok(slept[0] > 0 && slept[0] <= 8000);
  assert.equal(calls, 2);
  const c2 = new HardcoverClient({ getToken: () => 't', limiter: limiter(), sleep: async () => {},
    fetch: async () => { calls++; return new Response('{}', { status: 429, headers: { 'retry-after': '90' } }); } });
  await assert.rejects(() => c2.seriesBooks(1), /429/);
  const before = calls;
  await assert.rejects(() => c2.seriesBooks(1), /slow down; try again in \d+ seconds/);   // long wait: refuse without calling
  assert.equal(calls, before);
});
