import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../js/ratelimit.js';

function clock() {
  const c = { t: 0, now: () => c.t, sleep: async (ms) => { c.t += ms; } };
  return c;
}

// Acceptance test 6
test('never exceeds 60 requests per minute', async () => {
  const c = clock();
  const rl = new RateLimiter(60, 60000, { now: c.now, sleep: c.sleep });
  const stamps = [];
  for (let i = 0; i < 250; i++) { await rl.acquire(); stamps.push(c.t); }
  for (const s of stamps) {
    assert.ok(stamps.filter((x) => x >= s && x < s + 60000).length <= 60);
  }
  assert.equal(stamps[59], 0);
  assert.ok(stamps[60] >= 60000);
});
