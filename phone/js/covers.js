// Cover cache: Hardcover image -> Open Library by ISBN -> generated placeholder. Blobs live in IndexedDB.
// Each source is asked at most once (definitive misses are remembered). If the browser blocks a
// cross-origin download (CORS), nothing is stored and the UI falls back to the browser's own HTTP cache.
const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);

export const openlibraryUrl = (isbn) => `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg?default=false`;

// -> {data: Blob, type} | null (definitive "no image") ; throws on transient errors
export async function defaultFetch(url) {
  if (!url.startsWith('https://')) return null;
  const r = await fetch(url);   // plain request: the Hardcover token is never sent to image hosts
  if ([403, 404, 410].includes(r.status)) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.blob();
  return { data, type: r.headers.get('content-type') || data.type };
}

export class CoverCache {
  constructor(store, fetcher = defaultFetch) { this.store = store; this.fetcher = fetcher; }

  // Returns the cache key if a cover is stored, else null.
  async getOrFetch(key, urls) {
    const rec = await this.store.get('covers', key);
    if (rec) return rec.none ? null : key;
    urls = urls.filter(Boolean);
    if (!urls.length) return null;
    let transient = false;
    for (const u of urls) {
      let res;
      try { res = await this.fetcher(u); } catch { transient = true; continue; }
      if (!res) continue;
      const type = (res.type || '').split(';')[0].trim().toLowerCase();
      if (!TYPES.has(type) || !res.data.size || res.data.size > MAX_BYTES) continue;
      await this.store.put('covers', { key, blob: res.data, type });
      return key;
    }
    if (!transient) await this.store.put('covers', { key, none: true });
    return null;
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; }
function wrap(text, width) {
  const lines = []; let cur = '';
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (cur && (cur + ' ' + w).length > width) { lines.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) lines.push(cur);
  return lines;
}
export function placeholderSvg(title, seed) {
  const hue = hash(seed || title || '') % 360;
  const lines = wrap(title || '', 16).slice(0, 4);
  const y0 = 150 - Math.max(0, lines.length - 1) * 14;
  const text = lines.map((l, i) => `<text x="100" y="${y0 + i * 28}" text-anchor="middle">${esc(l)}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title>`
    + `<rect width="200" height="300" fill="hsl(${hue},45%,28%)"/><g fill="#fff" font-family="Georgia,serif" font-size="22">${text}</g></svg>`;
}
export const placeholderUri = (title, seed) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(placeholderSvg(title, seed));

// Download covers for a series' books (once each) and pick a series cover.
export async function fetchSeriesCovers(store, cache, sid) {
  for (const sb of (await store.all('series_book')).filter((r) => r.series_id === sid && !r.cover_key && r.cover_url)) {
    const key = await cache.getOrFetch(`sb-${sid}-${sb.position}`, [sb.cover_url]);
    if (key) await store.put('series_book', { ...sb, cover_key: key });
  }
  const s = await store.get('series', sid);
  if (!s || s.cover_key) return;
  let key = (await store.all('series_book')).filter((r) => r.series_id === sid && r.cover_key).sort((a, b) => a.position - b.position)[0]?.cover_key ?? null;
  if (!key && s.cover_url) key = await cache.getOrFetch(`series-${sid}`, [s.cover_url]);
  if (!key) {
    const isbns = (await store.all('book')).filter((b) => b.series_id === sid && b.isbn13).slice(0, 3).map((b) => openlibraryUrl(b.isbn13));
    key = await cache.getOrFetch(`series-${sid}`, isbns);
  }
  if (key) await store.put('series', { ...(await store.get('series', sid)), cover_key: key });
}
