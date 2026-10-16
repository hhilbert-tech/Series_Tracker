export const TODAY = '2026-10-16';
export const PAST = '2020-01-01';
export const FUTURE = '2099-03-01';

export function book(pos, title, date = null, bid = null, cover = null) {
  return {
    position: Number(pos),
    hardcover_book_id: bid ?? 1000 + Math.round(pos * 10),
    title: title ?? `Book ${pos}`,
    release_date: date,
    cover_url: cover,
  };
}

export function seriesHit(id, name, author = 'A. Writer', extra = {}) {
  return { hardcover_series_id: id, name, author, complete: false, cover_url: null, books_count: 3, ...extra };
}

export class FakeClient {
  constructor() {
    this.series = {}; this.isbns = {}; this.seriesByName = []; this.booksHits = [];
    this.bookSeriesMap = {}; this.authors = {}; this.authorSeriesMap = {}; this.tags = {}; this.subtags = {}; this.similar = {}; this.info = {}; this.genreSeries = {}; this.library = []; this.calls = []; this.fail = null;
  }
  _hit(name, ...args) { this.calls.push([name, ...args]); if (this.fail) throw this.fail; }
  async seriesBooks(id) { this._hit('seriesBooks', id); return (this.series[id] ?? []).map((b) => ({ ...b })); }
  async authorBooks(id) { this._hit('authorBooks', id); return (this.authors[id] ?? []).map((b) => ({ ...b })); }
  async authorSeries(names) { this._hit('authorSeries', names); return new Map(names.map((n) => [n, (this.authorSeriesMap[n] ?? []).map((s) => ({ ...s }))])); }
  async bookTags(ids) { this._hit('bookTags', ids); return ids.filter((i) => this.tags[i]).map((i) => ({ id: i, genres: this.tags[i], tags: this.subtags[i] ?? [], categories: [] })); }
  async similarBookIds(ids) { this._hit('similarBookIds', ids); return new Map(ids.filter((i) => this.similar[i]).map((i) => [i, this.similar[i]])); }
  async booksInfo(ids) { this._hit('booksInfo', ids); return ids.filter((i) => this.info[i]).map((i) => ({ hardcover_book_id: i, ...this.info[i] })); }
  async popularInGenre(slug, cat = 'Genre') { this._hit('popularInGenre', slug, cat); return (this.genreSeries[slug] ?? []).map((s) => ({ ...s })); }
  async findByIsbn(isbn) { this._hit('findByIsbn', isbn); return this.isbns[isbn] ?? null; }
  async searchSeries(q) { this._hit('searchSeries', q); return [...this.seriesByName]; }
  async searchBooks(q) { this._hit('searchBooks', q); return [...this.booksHits]; }
  async search(q) { this._hit('search', q); return { series: [...this.seriesByName], books: [...this.booksHits] }; }
  async bookSeries(id) { this._hit('bookSeries', id); return this.bookSeriesMap[id] ?? []; }
  async myLibrary() { this._hit('myLibrary'); return [...this.library]; }
}
