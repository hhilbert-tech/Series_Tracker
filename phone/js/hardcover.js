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
export const AUTHOR_BOOKS_Q = `
query AuthorBooks($id: Int!) {
  contributions(
    where: {author_id: {_eq: $id},
            book: {canonical_id: {_is_null: true}, is_partial_book: {_eq: false}, compilation: {_eq: false}}}
    order_by: {book: {release_date: desc_nulls_first}}
    limit: 300
  ) { contribution book { id title release_date users_count image { url } book_series { position series { id name } } } }
}`;
const SERIES_FIELDS = 'id name is_completed author { name }';
const isbnQ = (field) => `
query ByIsbn($isbn: String!) {
  editions(where: {${field}: {_eq: $isbn}}, limit: 1) {
    book { id title book_series { position series { ${SERIES_FIELDS} } } }
  }
}`;
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
  books: ['id', 'title', 'release_date', 'image', 'canonical_id', 'is_partial_book', 'compilation', 'users_count', 'contributions', 'book_series', 'description', 'pages', 'rating', 'cached_tags', 'cached_similar_book_ids'],
  editions: ['isbn_13', 'isbn_10', 'book'],
  series: ['id', 'name', 'is_completed', 'author', 'books_count'],
  book_series: ['position', 'series', 'book', 'book_id', 'series_id'],
  user_books: ['status_id', 'book'],
  contributions: ['author_id', 'book', 'contribution'],
  authors: ['id', 'name'],
  mutation_root: ['insert_user_book', 'delete_user_book'],
};

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const dateOf = (v) => (v ? String(v).slice(0, 10) : null);
const seriesInfo = (s, position = null) => ({
  hardcover_series_id: Number(s.id), name: s.name ?? '', author: s.author?.name ?? null,
  position: num(position), complete: Boolean(s.is_completed),
});
const bookSeriesList = (bs) => (bs ?? []).filter((x) => x.series).map((x) => seriesInfo(x.series, x.position));

export class HardcoverClient {
  constructor({ getToken, fetch: f = (...a) => globalThis.fetch(...a), limiter = new RateLimiter(50, 60000), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = 25000 }) {
    this._sleep = sleep; this._blockedUntil = 0; this._timeoutMs = timeoutMs;
    this._getToken = getToken; this._fetch = f; this._limiter = limiter; this._cache = new Map();
  }
  toString() { return 'HardcoverClient()'; }

  async gql(query, variables = {}) {
    const token = ((await this._getToken()) ?? '').trim();
    if (!token) throw new HardcoverAuthError('No Hardcover API token. Add it in Settings.');
    const auth = /^bearer /i.test(token) ? token : `Bearer ${token}`;
    const wait = this._blockedUntil - Date.now();                 // Hardcover told us to slow down: respect it for everyone
    if (wait > 0) {
      if (wait > 15000) throw new HardcoverError(`Hardcover asked us to slow down; try again in ${Math.ceil(wait / 1000)} seconds.`);
      await this._sleep(wait);
    }
    await this._limiter.acquire();
    // A request that hangs would stall everything waiting on it (e.g. the Discover picks): give up after a while.
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), this._timeoutMs);
    const timedOut = () => new HardcoverError('Hardcover took too long to answer. Try again later.');
    try { return await this._send(auth, query, variables, ctl.signal); }
    catch (e) { throw ctl.signal.aborted ? timedOut() : e; }
    finally { clearTimeout(timer); }
  }

  async _send(auth, query, variables, signal) {
    let r;
    try {
      r = await this._fetch(URL_, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }), signal });
    } catch {
      throw new HardcoverError('Could not reach Hardcover (offline, or the browser blocked the request).');
    }
    if (r.status === 401 || r.status === 403) throw new HardcoverAuthError(`Hardcover rejected the API token (HTTP ${r.status}). Check the token in Settings; tokens expire.`);
    if (r.status === 429) {
      const secs = Math.min(120, Math.max(5, Number(r.headers?.get?.('retry-after')) || 30));
      this._blockedUntil = Date.now() + secs * 1000;
      throw new HardcoverError(`Hardcover rate limit hit (HTTP 429). Wait about ${secs} seconds, then try again.`);
    }
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

  // Description and page count for one book (shown on the book page; fetched on demand).
  async bookDetails(bookId) {
    const data = await this._cached('bd' + bookId, () => this.gql(
      'query BookDetails($id: Int!) { books(where: {id: {_eq: $id}}, limit: 1) { description pages rating release_date } }', { id: Number(bookId) }));
    const b = data.books?.[0] ?? {};
    return { description: b.description ? String(b.description) : null, pages: Number(b.pages) > 0 ? Number(b.pages) : null, rating: Number(b.rating) > 0 ? Number(b.rating) : null,
      release_date: dateOf(b.release_date) };
  }

  async findByIsbn(isbn) {
    isbn = (isbn ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();
    if (![10, 13].includes(isbn.length)) return null;
    const data = await this.gql(isbnQ(isbn.length === 13 ? 'isbn_13' : 'isbn_10'), { isbn });
    const b = data.editions?.[0]?.book;
    if (!b) return null;
    return { hardcover_book_id: Number(b.id), title: b.title ?? '', series: bookSeriesList(b.book_series) };
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

  _mapBooks(docs) {
    return docs.map((d) => {
      const isbns = (d.isbns ?? []).filter((i) => String(i).length === 13);
      return { hardcover_book_id: Number(d.id), title: d.title ?? '', author: (d.author_names ?? [])[0] ?? null,
        cover_url: d.image?.url ?? null, release_date: dateOf(d.release_date), isbn13: isbns.length ? String(isbns[0]) : null };
    });
  }
  _mapSeries(docs) {
    return docs.map((d) => {
      const names = d.author_names ?? (d.author_name ? [d.author_name] : []);
      return { hardcover_series_id: Number(d.id), name: d.name ?? '', author: names[0] ?? null, cover_url: d.image?.url ?? null,
        books_count: d.books_count ?? null, complete: Boolean(d.is_completed) };
    });
  }
  _mapAuthors(docs) {
    return docs.map((d) => ({ hardcover_author_id: Number(d.id), name: d.name ?? '',
      books_count: d.books_count ?? null, cover_url: d.image?.url ?? null })).filter((a) => a.hardcover_author_id && a.name);
  }
  async searchBooks(q) { return this._mapBooks(await this._searchDocs(q, 'Book')); }
  async searchSeries(q) { return this._mapSeries(await this._searchDocs(q, 'Series')); }
  async searchAuthors(q) { return this._mapAuthors(await this._searchDocs(q, 'Author')); }

  // --- recommendations (field names unverified, like the rest; callers treat failures as "no suggestions") ---
  // Series by each named author, in ONE request (aliased searches). Returns Map(name -> series[]).
  async authorSeries(names) {
    names = [...new Set(names)].slice(0, 8);
    if (!names.length) return new Map();
    const vars = Object.fromEntries(names.map((n, i) => [`q${i}`, n]));
    const decl = names.map((_, i) => `$q${i}: String!`).join(', ');
    const body = names.map((_, i) => `a${i}: search(query: $q${i}, query_type: "Series", per_page: 6, page: 1) { results }`).join(' ');
    const data = await this.gql(`query AuthorSeries(${decl}) { ${body} }`, vars);
    const out = new Map();
    names.forEach((n, i) => {
      let res = data[`a${i}`]?.results ?? {}; if (typeof res === 'string') res = JSON.parse(res);
      const docs = (res.hits ?? []).map((h) => h.document ?? h)
        .filter((d) => (d.author_names ?? (d.author_name ? [d.author_name] : [])).some((x) => String(x).toLowerCase() === n.toLowerCase()));
      out.set(n, this._mapSeries(docs));
    });
    return out;
  }

  // Tags of some books: [{id, genres: [{slug, name, count}], tags: [...same shape, "Tag" category = finer subgenres/themes]}].
  async bookTags(ids) {
    ids = [...new Set(ids)].slice(0, 40).map(Number);
    if (!ids.length) return [];
    const data = await this.gql('query BookTags($ids: [Int!]) { books(where: {id: {_in: $ids}}) { id cached_tags } }', { ids });
    return (data.books ?? []).map((b) => {
      let ct = b.cached_tags; if (typeof ct === 'string') { try { ct = JSON.parse(ct); } catch { ct = null; } }
      const pick = (...keys) => keys.flatMap((k) => ct?.[k] ?? []).map((g) => ({ slug: g.tagSlug ?? g.tag_slug ?? g.slug ?? null, name: g.tag ?? g.name ?? null, count: Number(g.count) || 1 }))
        .filter((g) => g.slug);
      return { id: Number(b.id), genres: pick('Genre', 'genre'), tags: pick('Tag', 'tag'), categories: ct && typeof ct === 'object' ? Object.keys(ct) : [] };
    });
  }

  // "Similar books" (what the Hardcover site shows on a book page): Map(bookId -> similar book ids, most similar first).
  async similarBookIds(ids) {
    ids = [...new Set(ids)].slice(0, 25).map(Number);
    if (!ids.length) return new Map();
    const data = await this.gql('query Similar($ids: [Int!]) { books(where: {id: {_in: $ids}}) { id cached_similar_book_ids } }', { ids });
    const out = new Map();
    for (const b of data.books ?? []) {
      let v = b.cached_similar_book_ids; if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = []; } }
      out.set(Number(b.id), (Array.isArray(v) ? v : []).map(Number).filter(Number.isFinite).slice(0, 40));
    }
    return out;
  }

  // Basic info, first author and first series of some books, one request:
  // [{hardcover_book_id, title, author, author_id, users_count, rating, pages, cover_url, release_date, series: {hardcover_series_id, name, author, complete, position}|null}].
  async booksInfo(ids) {
    ids = [...new Set(ids)].slice(0, 60).map(Number);
    if (!ids.length) return [];
    const data = await this.gql(`query BooksInfo($ids: [Int!]) { books(where: {id: {_in: $ids}, canonical_id: {_is_null: true}}) {
      id title release_date users_count rating pages image { url } contributions { author { id name } } book_series(limit: 1) { position series { ${SERIES_FIELDS} } } } }`, { ids });
    return (data.books ?? []).map((b) => {
      const bs = b.book_series?.[0], s = bs?.series, a = b.contributions?.[0]?.author;
      return { hardcover_book_id: Number(b.id), title: b.title ?? '', author: a?.name ?? s?.author?.name ?? null, author_id: Number(a?.id) || null,
        users_count: Number(b.users_count) || 0, rating: Number(b.rating) > 0 ? Number(b.rating) : null, pages: Number(b.pages) > 0 ? Number(b.pages) : null,
        cover_url: b.image?.url ?? null, release_date: dateOf(b.release_date),
        series: s?.id ? { hardcover_series_id: Number(s.id), name: s.name ?? '', author: s.author?.name ?? null, complete: Boolean(s.is_completed), position: num(bs.position) } : null };
    });
  }

  // Book #1 of some series, one request: Map(seriesId -> {hardcover_book_id, title, author, author_id, users_count, rating, pages, cover_url}).
  // The most-read edition-free entry wins when several books share position 1 (translations etc.).
  async firstBooks(seriesIds) {
    seriesIds = [...new Set(seriesIds)].slice(0, 40).map(Number);
    if (!seriesIds.length) return new Map();
    const data = await this.gql(`query FirstBooks($ids: [Int!]) { book_series(
      where: {series_id: {_in: $ids}, position: {_eq: 1}, book: {canonical_id: {_is_null: true}, is_partial_book: {_eq: false}, compilation: {_eq: false}}}
      distinct_on: series_id order_by: [{series_id: asc}, {book: {users_count: desc}}]
    ) { series_id book { id title release_date users_count rating pages image { url } contributions { author { id name } } } } }`, { ids: seriesIds });
    const out = new Map();
    for (const row of data.book_series ?? []) {
      const b = row.book, a = b?.contributions?.[0]?.author;
      if (!b?.id || row.series_id == null) continue;
      out.set(Number(row.series_id), { hardcover_book_id: Number(b.id), title: b.title ?? '', author: a?.name ?? null, author_id: Number(a?.id) || null,
        users_count: Number(b.users_count) || 0, rating: Number(b.rating) > 0 ? Number(b.rating) : null, pages: Number(b.pages) > 0 ? Number(b.pages) : null, cover_url: b.image?.url ?? null,
        release_date: dateOf(b.release_date) });
    }
    return out;
  }

  // Your Hardcover shelf: mark a book "Want to Read" (status 1); returns the user_book id (needed to undo), or throws.
  async wantToRead(bookId) {
    const data = await this.gql('mutation WantToRead($id: Int!) { insert_user_book(object: {book_id: $id, status_id: 1}) { id error } }', { id: Number(bookId) });
    const r = data.insert_user_book;
    if (r?.error) throw new HardcoverError(`Hardcover: ${r.error}`);
    return Number(r?.id) || null;
  }
  async removeUserBook(userBookId) {
    await this.gql('mutation RemoveUserBook($id: Int!) { delete_user_book(id: $id) { id } }', { id: Number(userBookId) });
  }

  // Popular series in a genre, via their first book (whose id and title come along).
  async popularInGenre(slug, category = 'Genre') {
    const data = await this.gql(`query PopularInGenre($tag: jsonb!) { books(
      where: {cached_tags: {_contains: $tag}, canonical_id: {_is_null: true}, book_series: {position: {_eq: 1}}}
      order_by: {users_count: desc}, limit: 20
    ) { id title release_date users_count rating pages image { url } book_series(where: {position: {_eq: 1}}, limit: 1) { series { ${SERIES_FIELDS} } } } }`, { tag: { [category]: [{ tagSlug: slug }] } });
    const out = [];
    for (const b of data.books ?? []) {
      const s = b.book_series?.[0]?.series;
      if (!s?.id) continue;
      out.push({ hardcover_series_id: Number(s.id), name: s.name ?? '', author: s.author?.name ?? null, cover_url: b.image?.url ?? null,
        complete: Boolean(s.is_completed), users_count: Number(b.users_count) || 0, rating: Number(b.rating) > 0 ? Number(b.rating) : null,
        hardcover_book_id: Number(b.id) || null, title: b.title ?? null, pages: Number(b.pages) > 0 ? Number(b.pages) : null, release_date: dateOf(b.release_date) });
    }
    return out;
  }

  // Every main (non-edition, non-compilation) book credited to the author, newest first, with its series
  // when it has one. Translations/duplicates of the same series slot collapse to the most-read entry.
  async authorBooks(authorId) {
    const data = await this.gql(AUTHOR_BOOKS_Q, { id: Number(authorId) });
    const seen = new Set(), all = [];
    for (const row of data.contributions ?? []) {
      const b = row.book ?? {}, c = row.contribution;
      if (b.id === undefined || !b.title || seen.has(b.id)) continue;
      if (c && String(c).toLowerCase() !== 'author') continue;           // skip illustrators, translators, etc.
      seen.add(b.id);
      const bs = (b.book_series ?? []).find((x) => x?.series?.id && num(x.position) !== null) ?? (b.book_series ?? []).find((x) => x?.series?.id);
      all.push({ hardcover_book_id: Number(b.id), title: b.title, release_date: dateOf(b.release_date), cover_url: b.image?.url ?? null,
        series_id: bs ? Number(bs.series.id) : null, series_name: bs?.series?.name ?? null, series_position: bs ? num(bs.position) : null,
        users_count: Number(b.users_count) || 0 });
    }
    const best = new Map();
    for (const b of all) if (b.series_id != null && b.series_position != null) {
      const k = `${b.series_id}:${b.series_position}`;
      if (!best.has(k) || b.users_count > best.get(k).users_count) best.set(k, b);
    }
    return all.filter((b) => b.series_id == null || b.series_position == null || best.get(`${b.series_id}:${b.series_position}`) === b);
  }

  // Series, books and authors in ONE request (three aliased searches): searching used to cost three.
  async _searchAll(q) {
    q = (q ?? '').split(/\s+/).filter(Boolean).join(' ');
    return this._cached(`all|${q.toLowerCase()}`, async () => {
      const f = (alias, type) => `${alias}: search(query: $q, query_type: "${type}", per_page: 10, page: 1) { results }`;
      const data = await this.gql(`query SearchAll($q: String!) { ${f('s', 'Series')} ${f('b', 'Book')} ${f('a', 'Author')} }`, { q });
      const docs = (x) => { let res = x?.results ?? {}; if (typeof res === 'string') res = JSON.parse(res); return (res.hits ?? []).map((h) => h.document ?? h); };
      return { series: docs(data.s), books: docs(data.b), authors: docs(data.a) };
    });
  }

  async search(q) {
    const digits = (q ?? '').replace(/[\s-]/g, '');
    if (/^(\d{9}[\dXx]|\d{13})$/.test(digits)) {
      const hit = await this.findByIsbn(digits);
      if (!hit) return { series: [], books: [], authors: [] };
      return { series: hit.series.map((s) => ({ ...s, cover_url: null, books_count: null })),
        books: [{ hardcover_book_id: hit.hardcover_book_id, title: hit.title, author: null, cover_url: null, release_date: null, isbn13: digits.length === 13 ? digits : null }], authors: [] };
    }
    if (!(q ?? '').trim()) return { series: [], books: [], authors: [] };
    const all = await this._searchAll(q);
    return { series: this._mapSeries(all.series), books: this._mapBooks(all.books), authors: this._mapAuthors(all.authors) };
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
