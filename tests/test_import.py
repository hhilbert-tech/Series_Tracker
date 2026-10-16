import csv
import io

from tests.fakes import book, series_hit
from tracker import db
from tracker.importer import import_goodreads, import_hardcover


def csv_text(rows):
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["Title", "Author", "ISBN", "ISBN13", "Exclusive Shelf", "Date Read", "My Rating"])
    w.writerows(rows)
    return out.getvalue()


def stormlight_match(client):
    client.isbns["9780765326355"] = {"hardcover_book_id": 1, "title": "The Way of Kings", "series": [
        {"hardcover_series_id": 10, "name": "The Stormlight Archive", "author": "Brandon Sanderson",
         "position": 1.0, "complete": False}]}
    client.series[10] = [book(1, date="2010-08-31"), book(2, date="2014-03-04"), book(3, date="2027-01-01")]


def progress(conn, sid):
    row = conn.execute("SELECT max_position_read FROM user_progress WHERE series_id=?", (sid,)).fetchone()
    return row[0] if row else None


def test_isbn_match_resolves_whole_series_group(conn, client):
    stormlight_match(client)
    text = csv_text([
        ["The Way of Kings (The Stormlight Archive, #1)", "Brandon Sanderson", '="0765326353"', '="9780765326355"', "read", "", "5"],
        ["Words of Radiance (The Stormlight Archive, #2)", "Brandon Sanderson", '=""', '=""', "read", "", "5"],
    ])
    res = import_goodreads(conn, text, client)
    assert res.series_followed == 1 and res.needs_review == 0
    sid = conn.execute("SELECT id FROM series WHERE hardcover_series_id=10").fetchone()[0]
    assert progress(conn, sid) == 2.0
    assert conn.execute("SELECT COUNT(*) FROM book WHERE series_id=? AND source='goodreads'", (sid,)).fetchone()[0] == 2
    assert conn.execute("SELECT COUNT(*) FROM series_book WHERE series_id=?", (sid,)).fetchone()[0] == 3


def test_fuzzy_name_match_when_no_isbn(conn, client):
    client.series_by_name = [series_hit(21, "Mistborn: Wax and Wayne", "Brandon Sanderson"),
                             series_hit(20, "The Mistborn Saga", "Brandon Sanderson")]
    client.series[20] = [book(1, date="2006-07-17")]
    text = csv_text([["The Final Empire (Mistborn, #1)", "Brandon Sanderson", "", "", "read", "", "5"]])
    res = import_goodreads(conn, text, client)
    assert res.series_followed == 1
    assert conn.execute("SELECT hardcover_series_id FROM series").fetchall()[0][0] == 20


def test_unmatched_goes_to_review(conn, client):
    client.series_by_name = [series_hit(99, "Totally Different", "Someone Else")]
    text = csv_text([["Lost Tale (Obscure Saga, #1)", "Nobody Known", "", "", "read", "", "3"]])
    res = import_goodreads(conn, text, client)
    assert res.series_followed == 0 and res.needs_review == 1
    row = conn.execute("SELECT review_status, series_id FROM book").fetchone()
    assert tuple(row) == ("needs_review", None)


def test_shelves_decimals_and_non_series_rows(conn, client):
    stormlight_match(client)
    text = csv_text([
        ["The Way of Kings (The Stormlight Archive, #1)", "Brandon Sanderson", "", '="9780765326355"', "read", "", "5"],
        ["Edgedancer (The Stormlight Archive, #2.5)", "Brandon Sanderson", "", "", "read", "", "5"],
        ["Oathbringer (The Stormlight Archive, #3)", "Brandon Sanderson", "", "", "to-read", "", "0"],
        ["Piranesi", "Susanna Clarke", "", "", "read", "", "5"],
    ])
    import_goodreads(conn, text, client)
    sid = conn.execute("SELECT id FROM series").fetchone()[0]
    assert progress(conn, sid) == 1.0                                  # 2.5 ignored, to-read ignored
    assert conn.execute("SELECT COUNT(*) FROM book").fetchone()[0] == 2  # to-read + no-series not stored


def test_currently_reading_counts_as_read(conn, client):
    stormlight_match(client)
    text = csv_text([
        ["The Way of Kings (The Stormlight Archive, #1)", "Brandon Sanderson", "", '="9780765326355"', "read", "", "5"],
        ["Words of Radiance (The Stormlight Archive, #2)", "Brandon Sanderson", "", "", "currently-reading", "", "0"],
    ])
    import_goodreads(conn, text, client)
    sid = conn.execute("SELECT id FROM series").fetchone()[0]
    assert progress(conn, sid) == 2.0


def test_reimport_is_idempotent(conn, client):
    stormlight_match(client)
    text = csv_text([["The Way of Kings (The Stormlight Archive, #1)", "Brandon Sanderson", "", '="9780765326355"', "read", "", "5"]])
    import_goodreads(conn, text, client)
    import_goodreads(conn, text, client)
    assert conn.execute("SELECT COUNT(*) FROM book").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM series").fetchone()[0] == 1


def test_import_without_client_leaves_everything_for_review(conn):
    text = csv_text([["A (S, #1)", "Au", "", "", "read", "", "5"]])
    res = import_goodreads(conn, text, None)
    assert res.series_followed == 0 and res.needs_review == 1


def test_hardcover_library_import(conn, client):
    client.library = [
        {"hardcover_book_id": 5, "title": "Book Two", "author": "A", "isbn13": None, "read": True,
         "series": [{"hardcover_series_id": 30, "name": "S", "author": "A", "position": 2.0, "complete": False}]},
        {"hardcover_book_id": 6, "title": "Standalone", "author": "A", "isbn13": None, "read": True, "series": []},
    ]
    client.series[30] = [book(1, date="2001-01-01"), book(2, date="2002-01-01"), book(3, date="2030-01-01")]
    res = import_hardcover(conn, client)
    assert res.series_followed == 1
    sid = conn.execute("SELECT id FROM series WHERE hardcover_series_id=30").fetchone()[0]
    assert progress(conn, sid) == 2.0
    assert conn.execute("SELECT source FROM book WHERE hardcover_book_id=5").fetchone()[0] == "hardcover"
