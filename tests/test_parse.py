import csv
import io

from tracker.parse import clean_isbn, parse_goodreads_csv, parse_title


# Acceptance test 1
def test_series_and_position():
    p = parse_title("The Way of Kings (The Stormlight Archive, #1)")
    assert (p.title, p.series, p.position) == ("The Way of Kings", "The Stormlight Archive", 1.0)


def test_decimal_position():
    p = parse_title("Edgedancer (The Stormlight Archive, #2.5)")
    assert (p.title, p.series, p.position) == ("Edgedancer", "The Stormlight Archive", 2.5)


def test_no_series():
    for raw in ("Piranesi", "Foo (Bar)", "Dune (Deluxe Edition)"):
        p = parse_title(raw)
        assert p.series is None and p.position is None and p.title == raw


# Acceptance test 2
def test_isbn_cleaner():
    assert clean_isbn('="9780765326355"') == "9780765326355"
    assert clean_isbn("") == ""
    assert clean_isbn('=""') == ""
    assert clean_isbn(None) == ""


def _csv(rows):
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["Title", "Author", "ISBN", "ISBN13", "Exclusive Shelf", "Date Read", "My Rating"])
    w.writerows(rows)
    return out.getvalue()


def test_csv_rows_and_read_flag():
    text = _csv([
        ["A (S, #1)", "Au", '="0765326353"', '="9780765326355"', "read", "2020/01/02", "5"],
        ["B (S, #2)", "Au", '=""', '=""', "currently-reading", "", "0"],
        ["C (S, #3)", "Au", "", "", "to-read", "", "0"],
    ])
    rows = parse_goodreads_csv(text)
    assert [r.read for r in rows] == [True, True, False]
    assert rows[0].isbn13 == "9780765326355" and rows[1].isbn13 == ""
    assert rows[0].series == "S" and rows[0].position == 1.0
