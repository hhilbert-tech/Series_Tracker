// Hardcover GraphQL client. ALL field names live in the query strings below. They were written from
// Hardcover's public docs and are NOT yet verified against the live schema: use Settings -> "Verify
// Hardcover fields" in the app (needs a token) before relying on them.
import { RateLimiter } from './ratelimit.js';

export const URL_ = 'https://api.hardcover.app/v1/graphql';
const CACHE_TTL = 3600 * 1000;

export class HardcoverError extends Error {}
export class HardcoverAuthError extends HardcoverError {}

export const SERIES_BOOKS_Q = `
query SeriesBooks($id: Int!) {
  book_series(
    where: {series_id: {_eq: $id},
            book: {canonical_id: {_is_null: true}, is_partial_book: {_eq: false}, compilation: {_eq: false}}}
    distinct_on: position
    order_by: [{position: asc}, {book: {users_count: desc}}]
  ) { position book { id title release_date image { url } } }
}`;
const SERIES_FIELDS = 'id name is_completed author { name }';
const isbnQ = (field) => `
query ByIsbn($isbn: String!) {
  editions(where: {${field}: {_eq: $isbn}}, limit: 1) {
    book { id title book_series { position series { ${SERIES_FIELDS} } } }
  }
}`;
const BOOK_SERIES_Q = `query BookSeries($id: Int!) { book_series(where: {book_id: {_eq: $id}}) { position series { ${SERIES_FIELDS} } } }`;
const SEARCH_Q = `query Search($q: String!, $type: String!, $page: Int!) { search(query: $q, query_type: $type, per_page: 10, page: $page) { results } }`;
const LIBRARY_Q = `
query MyLibrary {
  me { user_books(where: {status_id: {_in: [2, 3]}}) {
    status_id
    book { id title contributions { author { name } } book_series { position series { ${SERIES_FIELDS} } } }
  } }
}`;
export const SCHEMA_Q = 'query($n: String!) { __type(name: $n) { fields { name } } }';
export const EXPECTED_FIELDS = {
  books: ['id', 'title', 'release_date', 'image', 'canonical_id', 'is_partial_book', 'compilation', 'users_count', 'contributions', 'book_series'],
  editions: ['isbn_13', 'isbn_10', 'book'],
  series: ['id', 'name', 'is_completed', 'author', 'books_count'],
  book_series: ['position', 'series', 'book', 'book_id', 'series_id'],
  user_books: ['status_id', 'book'],
};

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const dateOf = (v) => (v ? String(v).slice(0, 10) : null);
const seriesInfo = (s, position = null) => ({
  hardcover_series_id: Number(s.id), name: s.name ?? '', author: s.author?.name ?? null,
  position: num(position), complete: Boolean(s.is_completed),
});
const bookSeriesList = (bs) => (bs ?? []).filter((x) => x.series).map((x) => seriesInfo(x.series, x.position));

export class HardcoverClient {
  constructor({ getToken, fetch: f = (...a) => globalThis.fetch(...a), limiter = new RateLimiter(60, 60000) }) {
    this._getToken = getToken; this._fetch = f; this._limiter = limiter; this._cache = new Map();
  }
  toString() { return 'HardcoverClient()'; }

  async gql(query, variables = {}) {
    const token = ((await this._getToken()) ?? '').trim();
    if (!token) throw new HardcoverAuthError('No Hardcover API token. Add it in Settings.');
    const auth = /^bearer /i.test(token) ? token : `Bearer ${token}`;
    await this._limiter.acquire();
    let r;
    try {
      r = await this._fetch(URL_, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }) });
    } catch {
      throw new HardcoverError('Could not reach Hardcover (offline, or the browser blocked the request).');
    }
    if (r.status === 401 || r.status === 403) throw new HardcoverAuthError(`Hardcover rejected the API token (HTTP ${r.status}). Check the token in Settings; tokens expire.`);
    if (r.status === 429) throw new HardcoverError('Hardcover rate limit hit (HTTP 429); try again later.');
    if (r.status >= 400) throw new HardcoverError(`Hardcover returned HTTP ${r.status}.`);
    let body;
    try { body = await r.json(); } catch { throw new HardcoverError('Hardcover returned a non-JSON response.'); }
    if (body.errors?.length) throw new HardcoverError('Hardcover GraphQL error: ' + body.errors.map((e) => e.message ?? JSON.stringify(e)).join('; ').slice(0, 300));
    return body.data ?? {};
  }

  async _cached(key, fn) {
    const hit = this._cache.get(key);
    if (hit && Date.now() - hit[0] < CACHE_TTL) return hit[1];
    const val = await fn();
    this._cache.set(key, [Date.now(), val]);
    return val;
  }

  async seriesBooks(seriesId) {
    const data = await this.gql(SERIES_BOOKS_Q, { id: Number(seriesId) });
    const out = [];
    for (const row of data.book_series ?? []) {
      const pos = num(row.position), b = row.book ?? {};
      if (pos === null || b.id === undefined) continue;
      out.push({ position: pos, hardcover_book_id: Number(b.id), title: b.title ?? '', release_date: dateOf(b.release_date), cover_url: b.image?.url ?? null });
    }
    return out.sort((a, b) => a.position - b.position);
  }

  async findByIsbn(isbn) {
    isbn = (isbn ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();
    if (![10, 13].includes(isbn.length)) return null;
    const data = await this.gql(isbnQ(isbn.length === 13 ? 'isbn_13' : 'isbn_10'), { isbn });
    const b = data.editions?.[0]?.book;
    if (!b) return null;
    return { hardcover_book_id: Number(b.id), title: b.title ?? '', series: bookSeriesList(b.book_series) };
  }

  async bookSeries(bookId) {
    return bookSeriesList((await this.gql(BOOK_SERIES_Q, { id: Number(bookId) })).book_series);
  }

  async _searchDocs(q, type) {
    q = (q ?? '').split(/\s+/).filter(Boolean).join(' ');
    if (!q) return [];
    return this._cached(`${type}|${q.toLowerCase()}`, async () => {
      const data = await this.gql(SEARCH_Q, { q, type, page: 1 });
      let res = data.search?.results ?? {};
      if (typeof res === 'string') res = JSON.parse(res);
      return (res.hits ?? []).map((h) => h.document ?? h);
    });
  }

  async searchBooks(q) {
    return (await this._searchDocs(q, 'Book')).map((d) => {
      const isbns = (d.isbns ?? []).filter((i) => String(i).length === 13);
      return { hardcover_book_id: Number(d.id), title: d.title ?? '', author: (d.author_names ?? [])[0] ?? null,
        cover_url: d.image?.url ?? null, release_date: dateOf(d.release_date), isbn13: isbns.length ? String(isbns[0]) : null };
    });
  }

  async searchSeries(q) {
    return (await this._searchDocs(q, 'Series')).map((d) => {
      const names = d.author_names ?? (d.author_name ? [d.author_name] : []);
      return { hardcover_series_id: Number(d.id), name: d.name ?? '', author: names[0] ?? null, cover_url: d.image?.url ?? null,
        books_count: d.books_count ?? null, complete: Boolean(d.is_completed) };
    });
  }

  async search(q) {
    const digits = (q ?? '').replace(/[\s-]/g, '');
    if (/^(\d{9}[\dXx]|\d{13})$/.test(digits)) {
      const hit = await this.findByIsbn(digits);
      if (!hit) return { series: [], books: [] };
      return { series: hit.series.map((s) => ({ ...s, cover_url: null, books_count: null })),
        books: [{ hardcover_book_id: hit.hardcover_book_id, title: hit.title, author: null, cover_url: null, release_date: null, isbn13: digits.length === 13 ? digits : null }] };
    }
    return { series: await this.searchSeries(q), books: await this.searchBooks(q) };
  }

  async myLibrary() {
    const data = await this.gql(LIBRARY_Q);
    const me = Array.isArray(data.me) ? data.me[0] : data.me;
    const out = [];
    for (const ub of me?.user_books ?? []) {
      const b = ub.book ?? {};
      if (b.id === undefined) continue;
      out.push({ hardcover_book_id: Number(b.id), title: b.title ?? '', author: b.contributions?.[0]?.author?.name ?? null,
        isbn13: null, read: true, series: bookSeriesList(b.book_series) });
    }
    return out;
  }

  // Compare the fields this app uses with the live schema; returns {type: [missing...]}.
  async verifyFields() {
    const out = {};
    for (const [type, fields] of Object.entries(EXPECTED_FIELDS)) {
      const t = (await this.gql(SCHEMA_Q, { n: type })).__type;
      const have = new Set((t?.fields ?? []).map((f) => f.name));
      out[type] = t ? fields.filter((f) => !have.has(f)) : ['(type not found)'];
    }
    return out;
  }
}
