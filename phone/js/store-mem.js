// In-memory store (tests, and the reference semantics for the IndexedDB store).
import { KEYS, Store } from './store-base.js';

export class MemStore extends Store {
  constructor() { super(); this.t = Object.fromEntries(Object.keys(KEYS).map((k) => [k, new Map()])); }
  async get(table, key) { const v = this.t[table].get(key); return v && { ...v }; }
  async put(table, obj) { this.t[table].set(obj[KEYS[table]], { ...obj }); }
  async add(table, obj) {            // false if the key already exists
    const k = obj[KEYS[table]];
    if (this.t[table].has(k)) return false;
    this.t[table].set(k, { ...obj });
    return true;
  }
  async all(table) { return [...this.t[table].values()].map((v) => ({ ...v })); }
  async delete(table, key) { this.t[table].delete(key); }
  async clear(table) { this.t[table].clear(); }
}
