import test from 'node:test';
import assert from 'node:assert/strict';
import { MemStore } from '../js/store-mem.js';
import { upsertSeries, bumpProgress } from '../js/db.js';
import { runCheck, pendingEvents, markAllSeen } from '../js/check.js';
import { HardcoverAuthError, HardcoverError } from '../js/hardcover.js';
import { FakeClient, book, TODAY, PAST, FUTURE } from './helpers.js';

async function addSeries(store, { hc = 1, name = 'Harbor Lights', maxRead = 3, muted = 0 } = {}) {
  const sid = await upsertSeries(store, hc, name, 'A. Writer');
  if (muted) { const s = await store.get('series', sid); s.muted = 1; await store.put('series', s); }
  await bumpProgress(store, sid, maxRead);
  return sid;
}
const four = (d4) => [book(1, null, PAST), book(2, null, PAST), book(3, null, PAST), book(4, null, d4)];
const logCount = async (store) => (await store.all('notification_log')).length;
const kinds = (res) => res.events.map((e) => [e.kind, e.position]);

// Acceptance test 3
for (const d4 of [FUTURE, null]) {
  test(`announces the next book (date ${d4})`, async () => {
    const store = new MemStore(), client = new FakeClient();
    await addSeries(store); client.series[1] = four(d4);
    const res = await runCheck(store, client, { today: TODAY });
    assert.deepEqual(kinds(res), [['announced', 4]]);
    assert.equal(res.errors.length, 0);
  });
}

// Acceptance test 4
test('second run emits nothing', async () => {
  const store = new MemStore(), client = new FakeClient();
  await addSeries(store); client.series[1] = four(FUTURE);
  await runCheck(store, client, { today: TODAY });
  const n = await logCount(store);
  const again = await runCheck(store, client, { today: TODAY });
  assert.deepEqual(again.events, []); assert.equal(await logCount(store), n);
});

// Acceptance test 5
test('muted series is skipped', async () => {
  const store = new MemStore(), client = new FakeClient();
  await addSeries(store, { muted: 1 }); client.series[1] = four(FUTURE);
  const res = await runCheck(store, client, { today: TODAY });
  assert.deepEqual(res.events, []); assert.deepEqual(client.calls, []); assert.equal(await logCount(store), 0);
});

// Acceptance test 7 (job half)
test('auth failure is reported, not thrown, and stops further calls', async () => {
  const store = new MemStore(), client = new FakeClient();
  await addSeries(store, { hc: 1, name: 'One' }); await addSeries(store, { hc: 2, name: 'Two' });
  client.fail = new HardcoverAuthError('Hardcover rejected the API token (HTTP 401).');
  const res = await runCheck(store, client, { today: TODAY });
  assert.deepEqual(res.events, []); assert.equal(res.errors.length, 1); assert.ok(res.errors[0].includes('401'));
  assert.equal((await store.all('series')).filter((s) => s.last_checked_at).length, 0);
  assert.equal(client.calls.length, 1);
});

test('other errors do not stop remaining series', async () => {
  const store = new MemStore(), client = new FakeClient();
  await addSeries(store, { hc: 1, name: 'One' }); await addSeries(store, { hc: 2, name: 'Two' });
  client.series[2] = four(FUTURE);
  const orig = client.seriesBooks.bind(client);
  client.seriesBooks = async (id) => { if (id === 1) throw new HardcoverError('boom'); return orig(id); };
  const res = await runCheck(store, client, { today: TODAY });
  assert.equal(res.errors.length, 1); assert.ok(res.errors[0].includes('One'));
  assert.deepEqual(res.events.map((e) => e.kind), ['announced']);
});

test('first sight of already-released books is silent, and stays silent', async () => {
  const store = new MemStore(), client = new FakeClient();
  await addSeries(store, { maxRead: 1 });
  client.series[1] = [1, 2, 3, 4].map((i) => book(i, null, PAST));
  assert.deepEqual((await runCheck(store, client, { today: TODAY })).events, []);
  assert.deepEqual((await runCheck(store, client, { today: TODAY })).events, []);
});

test('date change then release', async () => {
  const store = new MemStore(), client = new FakeClient();
  await addSeries(store); client.series[1] = four('2026-12-01');
  await runCheck(store, client, { today: TODAY });
  client.series[1] = four('2027-02-01');
  let res = await runCheck(store, client, { today: TODAY });
  assert.deepEqual(res.events.map((e) => [e.kind, e.old_date, e.release_date]), [['date_changed', '2026-12-01', '2027-02-01']]);
  res = await runCheck(store, client, { today: '2027-02-02' });
  assert.deepEqual(res.events.map((e) => e.kind), ['released']);
  assert.deepEqual((await runCheck(store, client, { today: '2027-02-03' })).events, []);
});

test('new book after baseline is announced', async () => {
  const store = new MemStore(), client = new FakeClient();
  await addSeries(store); client.series[1] = [1, 2, 3].map((i) => book(i, null, PAST));
  await runCheck(store, client, { today: TODAY });
  client.series[1].push(book(4, null, FUTURE));
  assert.deepEqual(kinds(await runCheck(store, client, { today: TODAY })), [['announced', 4]]);
});

test('decimal positions never announce', async () => {
  const store = new MemStore(), client = new FakeClient();
  await addSeries(store, { maxRead: 3 });
  client.series[1] = [book(1, null, PAST), book(2, null, PAST), book(3, null, PAST), book(3.5, null, FUTURE)];
  assert.deepEqual((await runCheck(store, client, { today: TODAY })).events, []);
});

test('completed, fully-read series is skipped', async () => {
  const store = new MemStore(), client = new FakeClient();
  const sid = await addSeries(store, { maxRead: 3 });
  client.series[1] = [1, 2, 3].map((i) => book(i, null, PAST));
  await runCheck(store, client, { today: TODAY });
  const s = await store.get('series', sid); s.complete = 1; await store.put('series', s);
  client.calls.length = 0;
  await runCheck(store, client, { today: TODAY });
  assert.deepEqual(client.calls, []);
});

test('updates are unseen until marked seen', async () => {
  const store = new MemStore(), client = new FakeClient();
  await addSeries(store); client.series[1] = four(FUTURE);
  await runCheck(store, client, { today: TODAY });
  assert.equal((await pendingEvents(store)).length, 1);
  await markAllSeen(store);
  assert.equal((await pendingEvents(store)).length, 0);
  assert.equal(await logCount(store), 1);
});

test('mark all released as read, then undo; unreleased never counts', async () => {
  const { setProgress, lastReleased, maxRead } = await import('../js/db.js');
  const store = new MemStore();
  const sid = await upsertSeries(store, 7, 'Quick Read', 'A. Writer');
  for (const b of [book(1, null, PAST), book(2, null, PAST), book(2.5, null, PAST), book(3, null, FUTURE), book(4, null, null)]) {
    await store.put('series_book', { ...b, key: `${sid}:${b.position}`, series_id: sid });
  }
  assert.equal(await lastReleased(store, sid, TODAY), 2);
  await setProgress(store, sid, 2);
  assert.equal(await maxRead(store, sid), 2);
  await setProgress(store, sid, 1);          // undo lowers it
  assert.equal(await maxRead(store, sid), 1);
  await setProgress(store, sid, 0);
  assert.equal(await maxRead(store, sid), 0);
});

test('removeSeries clears the series and its data, keeps others', async () => {
  const { removeSeries } = await import('../js/db.js');
  const store = new MemStore();
  const a = await addSeries(store, { hc: 1 }), b = await addSeries(store, { hc: 2, name: 'Other' });
  const client = new FakeClient(); client.series[1] = four(FUTURE); client.series[2] = four(FUTURE);
  await runCheck(store, client, { today: TODAY });
  await removeSeries(store, a);
  assert.equal(await store.get('series', a), undefined);
  assert.equal(await store.get('user_progress', a), undefined);
  assert.ok((await store.all('series_book')).every((r) => r.series_id === b));
  assert.ok((await store.all('notification_log')).every((r) => r.series_id === b));
  assert.ok(await store.get('series', b));
});
