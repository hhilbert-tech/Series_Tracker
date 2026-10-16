// Tiny async table store. Tables and their key fields:
export const KEYS = {
  series: 'id', book: 'id', series_book: 'key', settings: 'key',
  user_progress: 'series_id', notification_log: 'key', covers: 'key',
  author: 'hardcover_author_id', author_book: 'key',
};

export class Store {
  async nextId(table) {
    const k = `seq_${table}`;
    const n = ((await this.get('settings', k))?.value ?? 0) + 1;
    await this.put('settings', { key: k, value: n });
    return n;
  }
}
