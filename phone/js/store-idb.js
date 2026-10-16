// IndexedDB-backed store; same API as MemStore. Runs in pages and in the service worker.
import { KEYS, Store } from './store-base.js';

class IdbStore extends Store {
  constructor(db) { super(); this.db = db; }
  _req(table, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(table, mode);
      const req = fn(tx.objectStore(table));
      req.onsuccess = () => resolve(req.result);
      req.onerror = (ev) => {
        if (req.error?.name === 'ConstraintError') { ev.preventDefault(); resolve(CONSTRAINT); } else reject(req.error);
      };
    });
  }
  get(table, key) { return this._req(table, 'readonly', (s) => s.get(key)); }
  async put(table, obj) { await this._req(table, 'readwrite', (s) => s.put(obj)); }
  async add(table, obj) { return (await this._req(table, 'readwrite', (s) => s.add(obj))) !== CONSTRAINT; }
  all(table) { return this._req(table, 'readonly', (s) => s.getAll()); }
  async delete(table, key) { await this._req(table, 'readwrite', (s) => s.delete(key)); }
  async clear(table) { await this._req(table, 'readwrite', (s) => s.clear()); }
}
const CONSTRAINT = Symbol('constraint');

export function openIdbStore(name = 'series-tracker') {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name, 1);
    open.onupgradeneeded = () => {
      for (const [table, keyPath] of Object.entries(KEYS)) open.result.createObjectStore(table, { keyPath });
    };
    open.onsuccess = () => resolve(new IdbStore(open.result));
    open.onerror = () => reject(open.error);
  });
}
