import test from 'node:test';
import assert from 'node:assert/strict';
import { MemStore } from '../js/store-mem.js';
import { CoverCache, placeholderSvg } from '../js/covers.js';

const IMG = { data: new Blob([new Uint8Array(64)]), type: 'image/png' };
function fetcher(result) {
  const f = async (url) => { f.urls.push(url); const r = typeof result === 'function' ? result(url) : result; if (r instanceof Error) throw r; return r; };
  f.urls = []; return f;
}

// Acceptance test 10
test('no cover anywhere: placeholder, and the network is hit once per source', async () => {
  const f = fetcher(null), cache = new CoverCache(new MemStore(), f);
  assert.equal(await cache.getOrFetch('k1', ['https://a/1.jpg', 'https://b/2.jpg']), null);
  assert.equal(f.urls.length, 2);
  assert.equal(await cache.getOrFetch('k1', ['https://a/1.jpg', 'https://b/2.jpg']), null);
  assert.equal(f.urls.length, 2);
  const svg = placeholderSvg('Harbor Lights', 'Harbor Lights');
  assert.ok(svg.startsWith('<svg') && svg.includes('Harbor Lights'));
});

test('found cover is stored and fetched once', async () => {
  const store = new MemStore(), f = fetcher(IMG), cache = new CoverCache(store, f);
  assert.equal(await cache.getOrFetch('k2', ['https://a/1.png']), 'k2');
  assert.equal(await cache.getOrFetch('k2', ['https://a/1.png']), 'k2');
  assert.equal(f.urls.length, 1);
  assert.ok((await store.get('covers', 'k2')).blob.size > 0);
});

test('falls through to the second source', async () => {
  const cache = new CoverCache(new MemStore(), fetcher((u) => (u === 'https://a/1' ? null : IMG)));
  assert.equal(await cache.getOrFetch('k3', ['https://a/1', 'https://b/2']), 'k3');
});

test('transient failure is not remembered as missing', async () => {
  const f = fetcher(new Error('network down')), cache = new CoverCache(new MemStore(), f);
  assert.equal(await cache.getOrFetch('k4', ['https://a/1']), null);
  const f2 = fetcher(IMG); cache.fetcher = f2;
  assert.equal(await cache.getOrFetch('k4', ['https://a/1']), 'k4');
});

test('rejects non-images and oversize', async () => {
  const html = fetcher({ data: new Blob(['<html>']), type: 'text/html' });
  assert.equal(await new CoverCache(new MemStore(), html).getOrFetch('a', ['u']), null);
  const big = fetcher({ data: new Blob([new Uint8Array(6 * 1024 * 1024)]), type: 'image/jpeg' });
  assert.equal(await new CoverCache(new MemStore(), big).getOrFetch('b', ['u']), null);
});

test('placeholder escapes and is deterministic', () => {
  const a = placeholderSvg('<script>', 'seed');
  assert.ok(!a.includes('<script>') && a.includes('&lt;script&gt;'));
  assert.equal(a, placeholderSvg('<script>', 'seed'));
});

test('title lookup: found once, stored; a miss is remembered', async () => {
  const store = new MemStore(), f = fetcher(IMG);
  const searches = [];
  const cache = new CoverCache(store, f, async (t, a) => { searches.push([t, a]); return t === 'Known' ? 'https://covers/x.jpg' : null; });
  assert.equal(await cache.lookupByTitle('k', 'Known', 'Ann'), 'k');
  assert.equal(await cache.lookupByTitle('k', 'Known', 'Ann'), 'k');
  assert.equal(searches.length, 1);
  assert.equal(await cache.lookupByTitle('m', 'Unknown'), null);
  assert.equal(await cache.lookupByTitle('m', 'Unknown'), null);
  assert.equal(searches.length, 2);
  const boom = new CoverCache(new MemStore(), f, async () => { throw new Error('net'); });
  assert.equal(await boom.lookupByTitle('z', 'T'), null);
  assert.equal(await boom.store.get('covers', 'z'), undefined);               // transient: nothing remembered
});
