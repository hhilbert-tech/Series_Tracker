import json

import httpx
import pytest

from tracker.hardcover import HardcoverAuthError, HardcoverClient, HardcoverError

SERIES_RESPONSE = {"data": {"book_series": [
    {"position": 1, "book": {"id": 11, "title": "One", "release_date": "2020-05-01", "image": {"url": "https://img/1.jpg"}}},
    {"position": 2.5, "book": {"id": 12, "title": "Two and a half", "release_date": None, "image": None}},
    {"position": None, "book": {"id": 13, "title": "Unpositioned", "release_date": None, "image": None}},
]}}


class CountingLimiter:
    def __init__(self):
        self.n = 0

    def acquire(self):
        self.n += 1


def make(handler, **kw):
    return HardcoverClient("secret-token", transport=httpx.MockTransport(handler),
                           limiter=kw.pop("limiter", CountingLimiter()), **kw)


def test_series_books_normalised_and_query_follows_spec():
    seen = {}

    def handler(req):
        seen["auth"] = req.headers["authorization"]
        seen["body"] = json.loads(req.content)
        return httpx.Response(200, json=SERIES_RESPONSE)

    c = make(handler)
    books = c.series_books(42)
    assert [b["position"] for b in books] == [1.0, 2.5]  # null position dropped
    assert books[0] == {"position": 1.0, "hardcover_book_id": 11, "title": "One",
                        "release_date": "2020-05-01", "cover_url": "https://img/1.jpg"}
    assert seen["auth"] == "Bearer secret-token"
    q = seen["body"]["query"]
    for needle in ("canonical_id", "is_partial_book", "compilation", "distinct_on", "users_count"):
        assert needle in q
    assert seen["body"]["variables"]["id"] == 42


def test_each_request_goes_through_limiter():
    lim = CountingLimiter()
    c = make(lambda r: httpx.Response(200, json=SERIES_RESPONSE), limiter=lim)
    c.series_books(1)
    c.series_books(2)
    assert lim.n == 2


# Acceptance test 7 (client half)
def test_401_raises_clear_auth_error_without_leaking_token():
    c = make(lambda r: httpx.Response(401, json={"error": "Unauthorized"}))
    with pytest.raises(HardcoverAuthError) as e:
        c.series_books(1)
    assert "HARDCOVER_TOKEN" in str(e.value) and "secret-token" not in str(e.value)
    assert "secret-token" not in repr(c)


def test_graphql_errors_raise():
    c = make(lambda r: httpx.Response(200, json={"errors": [{"message": "field 'x' not found"}]}))
    with pytest.raises(HardcoverError) as e:
        c.series_books(1)
    assert "not found" in str(e.value)


def test_search_is_cached():
    calls = []

    def handler(req):
        calls.append(1)
        return httpx.Response(200, json={"data": {"search": {"results": {"hits": [
            {"document": {"id": "9", "title": "Harbor Lights", "author_names": ["Ann Author"],
                          "image": {"url": "https://img/h.jpg"}, "release_date": "2021-01-01"}}]}}}})

    c = make(handler)
    first = c.search_books("Harbor Lights")
    second = c.search_books("harbor lights ")
    assert first == second and len(calls) == 1
    assert first[0]["title"] == "Harbor Lights" and first[0]["author"] == "Ann Author"
    assert first[0]["hardcover_book_id"] == 9


def test_find_by_isbn_shape():
    payload = {"data": {"editions": [{"book": {"id": 1, "title": "T", "book_series": [
        {"position": 3, "series": {"id": 7, "name": "S", "author": {"name": "Au"}, "is_completed": True}}]}}]}}
    c = make(lambda r: httpx.Response(200, json=payload))
    r = c.find_by_isbn("9780765326355")
    assert r["hardcover_book_id"] == 1
    assert r["series"][0] == {"hardcover_series_id": 7, "name": "S", "author": "Au",
                              "position": 3.0, "complete": True}
    c2 = make(lambda r: httpx.Response(200, json={"data": {"editions": []}}))
    assert c2.find_by_isbn("9780000000000") is None
