"""Hardcover GraphQL client.

ALL Hardcover field names live in the query strings below. They were written from
Hardcover's public docs/examples and are NOT yet verified against the live schema:
run `python -m tracker.introspect` (needs HARDCOVER_TOKEN) before relying on them.
"""
import json
import os
import re
import time

import httpx

from .ratelimit import RateLimiter

URL = "https://api.hardcover.app/v1/graphql"
CACHE_TTL = 3600


class HardcoverError(Exception):
    pass


class HardcoverAuthError(HardcoverError):
    pass


SERIES_BOOKS_Q = """
query SeriesBooks($id: Int!) {
  book_series(
    where: {series_id: {_eq: $id},
            book: {canonical_id: {_is_null: true}, is_partial_book: {_eq: false}, compilation: {_eq: false}}}
    distinct_on: position
    order_by: [{position: asc}, {book: {users_count: desc}}]
  ) { position book { id title release_date image { url } } }
}"""

_SERIES_FIELDS = "id name is_completed author { name }"

ISBN_Q = """
query ByIsbn($isbn: String!) {
  editions(where: {%s: {_eq: $isbn}}, limit: 1) {
    book { id title book_series { position series { %s } } }
  }
}"""

BOOK_SERIES_Q = """
query BookSeries($id: Int!) {
  book_series(where: {book_id: {_eq: $id}}) { position series { %s } }
}""" % _SERIES_FIELDS

SEARCH_Q = """
query Search($q: String!, $type: String!, $page: Int!) {
  search(query: $q, query_type: $type, per_page: 10, page: $page) { results }
}"""

LIBRARY_Q = """
query MyLibrary {
  me { user_books(where: {status_id: {_in: [2, 3]}}) {
    status_id
    book { id title contributions { author { name } }
           book_series { position series { %s } } }
  } }
}""" % _SERIES_FIELDS


def _pos(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _date(v):
    return str(v)[:10] if v else None


def _series_info(s, position=None):
    return {
        "hardcover_series_id": int(s["id"]), "name": s.get("name") or "",
        "author": ((s.get("author") or {}).get("name")), "position": _pos(position),
        "complete": bool(s.get("is_completed")),
    }


def _book_series_list(book_series):
    out = []
    for bs in book_series or []:
        if bs.get("series"):
            out.append(_series_info(bs["series"], bs.get("position")))
    return out


class HardcoverClient:
    def __init__(self, token, *, transport=None, limiter=None):
        self._token = (token or "").strip()
        self._limiter = limiter or RateLimiter(60, 60.0)
        self._http = httpx.Client(transport=transport, timeout=20)
        self._cache = {}

    @classmethod
    def from_env(cls):
        return cls(os.environ.get("HARDCOVER_TOKEN", ""))

    def __repr__(self):
        return "HardcoverClient()"

    # -- transport ---------------------------------------------------------
    def _gql(self, query, variables=None):
        if not self._token:
            raise HardcoverAuthError("No Hardcover API token. Set HARDCOVER_TOKEN.")
        auth = self._token if self._token.lower().startswith("bearer ") else f"Bearer {self._token}"
        self._limiter.acquire()
        try:
            r = self._http.post(URL, json={"query": query, "variables": variables or {}},
                                headers={"Authorization": auth})
        except httpx.HTTPError as e:
            raise HardcoverError(f"Hardcover request failed ({type(e).__name__}).") from None
        if r.status_code in (401, 403):
            raise HardcoverAuthError(f"Hardcover rejected the API token (HTTP {r.status_code}). Check HARDCOVER_TOKEN.")
        if r.status_code == 429:
            raise HardcoverError("Hardcover rate limit hit (HTTP 429); try again later.")
        if r.status_code >= 400:
            raise HardcoverError(f"Hardcover returned HTTP {r.status_code}.")
        try:
            body = r.json()
        except ValueError:
            raise HardcoverError("Hardcover returned a non-JSON response.") from None
        if body.get("errors"):
            msgs = "; ".join(str(e.get("message", e)) for e in body["errors"])[:300]
            raise HardcoverError(f"Hardcover GraphQL error: {msgs}")
        return body.get("data") or {}

    def _cached(self, key, fn):
        hit = self._cache.get(key)
        if hit and time.monotonic() - hit[0] < CACHE_TTL:
            return hit[1]
        val = fn()
        self._cache[key] = (time.monotonic(), val)
        return val

    # -- queries -----------------------------------------------------------
    def series_books(self, series_id):
        data = self._gql(SERIES_BOOKS_Q, {"id": int(series_id)})
        out = []
        for row in data.get("book_series", []):
            pos, b = _pos(row.get("position")), row.get("book") or {}
            if pos is None or "id" not in b:
                continue
            out.append({"position": pos, "hardcover_book_id": int(b["id"]), "title": b.get("title") or "",
                        "release_date": _date(b.get("release_date")),
                        "cover_url": (b.get("image") or {}).get("url")})
        return sorted(out, key=lambda x: x["position"])

    def find_by_isbn(self, isbn):
        isbn = re.sub(r"[^0-9Xx]", "", isbn or "").upper()
        if len(isbn) not in (10, 13):
            return None
        field = "isbn_13" if len(isbn) == 13 else "isbn_10"
        data = self._gql(ISBN_Q % (field, _SERIES_FIELDS), {"isbn": isbn})
        eds = data.get("editions") or []
        if not eds or not eds[0].get("book"):
            return None
        b = eds[0]["book"]
        return {"hardcover_book_id": int(b["id"]), "title": b.get("title") or "",
                "series": _book_series_list(b.get("book_series"))}

    def book_series(self, book_id):
        data = self._gql(BOOK_SERIES_Q, {"id": int(book_id)})
        return _book_series_list(data.get("book_series"))

    def _search_docs(self, q, qtype):
        q = " ".join((q or "").split())
        if not q:
            return []

        def go():
            data = self._gql(SEARCH_Q, {"q": q, "type": qtype, "page": 1})
            res = (data.get("search") or {}).get("results") or {}
            if isinstance(res, str):
                res = json.loads(res)
            return [h.get("document", h) for h in res.get("hits", [])]
        return self._cached((qtype, q.lower()), go)

    def search_books(self, q):
        out = []
        for d in self._search_docs(q, "Book"):
            names = d.get("author_names") or []
            isbns = [i for i in (d.get("isbns") or []) if len(str(i)) == 13]
            out.append({"hardcover_book_id": int(d["id"]), "title": d.get("title") or "",
                        "author": names[0] if names else None,
                        "cover_url": (d.get("image") or {}).get("url"),
                        "release_date": _date(d.get("release_date")),
                        "isbn13": str(isbns[0]) if isbns else None})
        return out

    def search_series(self, q):
        out = []
        for d in self._search_docs(q, "Series"):
            names = d.get("author_names") or ([d["author_name"]] if d.get("author_name") else [])
            out.append({"hardcover_series_id": int(d["id"]), "name": d.get("name") or "",
                        "author": names[0] if names else None,
                        "cover_url": (d.get("image") or {}).get("url"),
                        "books_count": d.get("books_count"), "complete": bool(d.get("is_completed"))})
        return out

    def search(self, q):
        digits = re.sub(r"[\s-]", "", q or "")
        if re.fullmatch(r"\d{9}[\dXx]|\d{13}", digits):
            hit = self.find_by_isbn(digits)
            if not hit:
                return {"series": [], "books": []}
            book = {"hardcover_book_id": hit["hardcover_book_id"], "title": hit["title"], "author": None,
                    "cover_url": None, "release_date": None, "isbn13": digits if len(digits) == 13 else None}
            series = [{**s, "cover_url": None, "books_count": None} for s in hit["series"]]
            return {"series": series, "books": [book]}
        return {"series": self.search_series(q), "books": self.search_books(q)}

    def my_library(self):
        data = self._gql(LIBRARY_Q)
        me = data.get("me")
        me = me[0] if isinstance(me, list) and me else me
        out = []
        for ub in ((me or {}).get("user_books") or []):
            b = ub.get("book") or {}
            if "id" not in b:
                continue
            contribs = b.get("contributions") or []
            author = ((contribs[0].get("author") or {}).get("name")) if contribs else None
            out.append({"hardcover_book_id": int(b["id"]), "title": b.get("title") or "", "author": author,
                        "isbn13": None, "read": True, "series": _book_series_list(b.get("book_series"))})
        return out
