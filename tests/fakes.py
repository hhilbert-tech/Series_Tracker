"""Test doubles shared across the suite."""


def book(pos, title=None, date=None, bid=None, cover=None):
    return {
        "position": float(pos),
        "hardcover_book_id": bid or 1000 + int(pos * 10),
        "title": title or f"Book {pos:g}",
        "release_date": date,
        "cover_url": cover,
    }


def series_hit(hc_id, name, author="A. Writer", complete=False, cover_url=None, books_count=3):
    return {
        "hardcover_series_id": hc_id, "name": name, "author": author,
        "complete": complete, "cover_url": cover_url, "books_count": books_count,
    }


class FakeClient:
    """In-memory stand-in for HardcoverClient (same public methods)."""

    def __init__(self):
        self.series = {}            # hc series id -> [book dicts]
        self.isbns = {}             # isbn13 -> find_by_isbn result
        self.series_by_name = []    # series dicts returned by search_series / search
        self.books_hits = []        # book dicts returned by search_books / search
        self.book_series_map = {}   # hc book id -> [series dicts with position]
        self.library = []
        self.calls = []
        self.fail = None            # exception instance to raise on every call

    def _hit(self, name, *args):
        self.calls.append((name,) + args)
        if self.fail:
            raise self.fail

    def series_books(self, sid):
        self._hit("series_books", sid)
        return [dict(b) for b in self.series.get(sid, [])]

    def find_by_isbn(self, isbn13):
        self._hit("find_by_isbn", isbn13)
        return self.isbns.get(isbn13)

    def search_series(self, q):
        self._hit("search_series", q)
        return list(self.series_by_name)

    def search_books(self, q):
        self._hit("search_books", q)
        return list(self.books_hits)

    def search(self, q):
        self._hit("search", q)
        return {"series": list(self.series_by_name), "books": list(self.books_hits)}

    def book_series(self, book_id):
        self._hit("book_series", book_id)
        return self.book_series_map.get(book_id, [])

    def my_library(self):
        self._hit("my_library")
        return list(self.library)
