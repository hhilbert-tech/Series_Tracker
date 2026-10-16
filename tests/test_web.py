import sqlite3

import pytest
from fastapi.testclient import TestClient

from tests.fakes import FakeClient, book, series_hit
from tracker.web import create_app

GR_CSV = (
    "Title,Author,ISBN,ISBN13,Exclusive Shelf,Date Read,My Rating\n"
    '"The Way of Kings (The Stormlight Archive, #1)",Brandon Sanderson,"=""""","=""9780765326355""",read,,5\n'
    '"Lost Tale (Obscure Saga, #1)",Nobody Known,"=""""","=""""",read,,3\n'
)


@pytest.fixture
def env(tmp_path):
    fake = FakeClient()
    app = create_app(db_path=tmp_path / "t.db", covers_dir=tmp_path / "c",
                     client_factory=lambda: fake, fetcher=lambda u: None)
    db = lambda: sqlite3.connect(tmp_path / "t.db")  # noqa: E731
    return TestClient(app), fake, db


# Acceptance test 8
def test_search_returns_series_and_books_and_follow_creates_series(env):
    tc, fake, db = env
    fake.series_by_name = [series_hit(7, "Harbor Lights Saga", "Ann Author", books_count=4)]
    fake.books_hits = [{"hardcover_book_id": 55, "title": "Harbor Lights", "author": "Ann Author",
                        "cover_url": None, "release_date": "2021-01-01", "isbn13": None}]
    fake.series[7] = [book(1, date="2019-01-01"), book(2, date="2020-01-01"),
                      book(3, date="2021-01-01"), book(4, date="2030-01-01")]
    html = tc.get("/search", params={"q": "harbor lights"}).text
    assert "Harbor Lights Saga" in html and "Harbor Lights" in html and "Follow" in html

    r = tc.post("/follow", data={"hardcover_series_id": 7, "name": "Harbor Lights Saga",
                                 "author": "Ann Author", "read_up_to": 2}, follow_redirects=False)
    assert r.status_code == 303
    con = db()
    row = con.execute("SELECT id, muted FROM series WHERE hardcover_series_id=7").fetchone()
    assert row[1] == 0
    assert con.execute("SELECT max_position_read FROM user_progress WHERE series_id=?", (row[0],)).fetchone()[0] == 2
    assert con.execute("SELECT COUNT(*) FROM series_book WHERE series_id=?", (row[0],)).fetchone()[0] == 4
    assert "Harbor Lights Saga" in tc.get("/").text


def test_follow_twice_does_not_duplicate_or_lower_progress(env):
    tc, fake, db = env
    fake.series[7] = [book(1, date="2019-01-01")]
    for n in (3, 1):
        tc.post("/follow", data={"hardcover_series_id": 7, "name": "S", "author": "A", "read_up_to": n})
    con = db()
    assert con.execute("SELECT COUNT(*) FROM series").fetchone()[0] == 1
    assert con.execute("SELECT max_position_read FROM user_progress").fetchone()[0] == 3


def test_add_single_book_with_series_bumps_progress(env):
    tc, fake, db = env
    fake.book_series_map[55] = [{"hardcover_series_id": 7, "name": "Harbor Lights Saga", "author": "Ann",
                                 "position": 2.0, "complete": False}]
    fake.series[7] = [book(1, date="2019-01-01"), book(2, date="2020-01-01")]
    r = tc.post("/add-book", data={"hardcover_book_id": 55, "title": "Harbor Lights", "author": "Ann"},
                follow_redirects=False)
    assert r.status_code == 303
    con = db()
    assert con.execute("SELECT source, read FROM book").fetchone() == ("search", 1)
    assert con.execute("SELECT max_position_read FROM user_progress").fetchone()[0] == 2


# Acceptance test 9
def test_manual_book_without_match_is_saved_and_listed_for_review(env):
    tc, fake, db = env
    r = tc.post("/manual", data={"title": "Handmade Tale", "author": "Me", "series_name": "Home Saga",
                                 "position": "1", "isbn": ""}, follow_redirects=False)
    assert r.status_code == 303
    con = db()
    assert con.execute("SELECT source, review_status FROM book").fetchone() == ("manual", "needs_review")
    assert "Handmade Tale" in tc.get("/review").text


def test_import_flow_mute_and_review_assign(env):
    tc, fake, db = env
    fake.isbns["9780765326355"] = {"hardcover_book_id": 1, "title": "The Way of Kings", "series": [
        {"hardcover_series_id": 10, "name": "The Stormlight Archive", "author": "Brandon Sanderson",
         "position": 1.0, "complete": False}]}
    fake.series[10] = [book(1, date="2010-01-01"), book(2, date="2030-01-01")]
    r = tc.post("/import/goodreads", files={"file": ("lib.csv", GR_CSV.encode(), "text/csv")}, follow_redirects=True)
    assert r.status_code == 200 and "following 1 series" in r.text
    con = db()
    sid = con.execute("SELECT id FROM series").fetchone()[0]

    assert "Lost Tale" in tc.get("/review").text

    tc.post(f"/series/{sid}/mute", follow_redirects=False)
    assert con.execute("SELECT muted FROM series WHERE id=?", (sid,)).fetchone()[0] == 1
    assert "muted" in tc.get("/").text.lower()
    tc.post(f"/series/{sid}/mute", follow_redirects=False)
    assert con.execute("SELECT muted FROM series WHERE id=?", (sid,)).fetchone()[0] == 0

    bid = con.execute("SELECT id FROM book WHERE review_status='needs_review'").fetchone()[0]
    fake.series[50] = [book(1, date="2000-01-01")]
    tc.post(f"/review/{bid}/assign", data={"hardcover_series_id": 50, "name": "Obscure Saga", "author": "Nobody Known"})
    assert con.execute("SELECT review_status FROM book WHERE id=?", (bid,)).fetchone()[0] == "ok"
    assert con.execute("SELECT COUNT(*) FROM series").fetchone()[0] == 2

    tc.post("/manual", data={"title": "Skip Me", "author": "X"})
    bid2 = con.execute("SELECT id FROM book WHERE title='Skip Me'").fetchone()[0]
    tc.post(f"/review/{bid2}/ignore")
    assert con.execute("SELECT review_status FROM book WHERE id=?", (bid2,)).fetchone()[0] == "ignored"
    assert "Skip Me" not in tc.get("/review").text


def test_series_without_cover_renders_placeholder(env):
    tc, fake, db = env
    fake.series[7] = [book(1, date="2019-01-01")]
    tc.post("/follow", data={"hardcover_series_id": 7, "name": "Plain Saga", "author": "A", "read_up_to": 0})
    html = tc.get("/").text
    assert "/placeholder.svg" in html
    svg = tc.get("/placeholder.svg", params={"title": "Plain Saga", "seed": "x"})
    assert svg.headers["content-type"].startswith("image/svg+xml") and "Plain Saga" in svg.text


def test_cover_route_rejects_path_traversal(env):
    tc, _, _ = env
    assert tc.get("/covers/..%2F..%2Fetc%2Fpasswd").status_code == 404
    assert tc.get("/covers/notahash.jpg").status_code == 404


def test_search_survives_missing_token(env):
    from tracker.hardcover import HardcoverAuthError
    tc, fake, _ = env
    fake.fail = HardcoverAuthError("Hardcover rejected the token (HTTP 401). Check HARDCOVER_TOKEN.")
    r = tc.get("/search", params={"q": "anything"})
    assert r.status_code == 200 and "HARDCOVER_TOKEN" in r.text
