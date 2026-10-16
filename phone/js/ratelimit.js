// Sliding-window rate limiter (Hardcover: 60 requests/minute).
export class RateLimiter {
  constructor(maxCalls = 60, periodMs = 60000, { now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    Object.assign(this, { maxCalls, periodMs, _now: now, _sleep: sleep, _stamps: [] });
  }
  async acquire() {
    for (;;) {
      const now = this._now();
      while (this._stamps.length && now - this._stamps[0] >= this.periodMs) this._stamps.shift();
      if (this._stamps.length < this.maxCalls) { this._stamps.push(now); return; }
      await this._sleep(this._stamps[0] + this.periodMs - now);
    }
  }
}
