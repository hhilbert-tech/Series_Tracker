import test from 'node:test';
import assert from 'node:assert/strict';
import { isEstimated, fmtDate, when } from '../js/format.js';

const T = '2026-10-16';
test('future 1 January is an estimate; past ones and other dates are not', () => {
  assert.equal(isEstimated('2028-01-01', T), true);
  assert.equal(isEstimated('2020-01-01', T), false);
  assert.equal(isEstimated('2028-03-05', T), false);
  assert.equal(isEstimated(null, T), false);
});
test('fmtDate and when mark estimates', () => {
  assert.equal(fmtDate('2028-01-01', T), '2028 (est.)');
  assert.equal(fmtDate(null, T), 'Date TBA');
  assert.match(fmtDate('2028-03-05', T), /2028/);
  assert.deepEqual(when('2028-01-01', T), { text: 'in ~15 months', tone: 'far' });
  assert.deepEqual(when('2026-10-20', T), { text: 'in 4 days', tone: 'soon' });
  assert.deepEqual(when('2026-09-29', T), { text: 'Out now', tone: 'ok' });
  assert.deepEqual(when(null, T), { text: 'Date TBA', tone: 'tba' });
});
