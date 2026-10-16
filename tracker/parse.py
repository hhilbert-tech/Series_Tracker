"""Goodreads CSV parsing: series-in-title regex and ISBN cleaning."""
import csv
import io
import re
from dataclasses import dataclass
from typing import Optional

SERIES_RE = re.compile(r"^(.*?)\s*\(([^()]+?),?\s*#(\d+(?:\.\d+)?)\)\s*$")
READ_SHELVES = {"read", "currently-reading"}


@dataclass
class ParsedTitle:
    title: str
    series: Optional[str]
    position: Optional[float]


@dataclass
class GoodreadsRow:
    title: str
    series: Optional[str]
    position: Optional[float]
    author: str
    isbn: str
    isbn13: str
    shelf: str
    read: bool


def parse_title(raw: str) -> ParsedTitle:
    m = SERIES_RE.match(raw or "")
    if not m:
        return ParsedTitle(raw, None, None)
    return ParsedTitle(m.group(1).strip(), m.group(2).strip(), float(m.group(3)))


def clean_isbn(raw) -> str:
    """`="9780765326355"` -> `9780765326355`; empty/None -> ''."""
    if not raw:
        return ""
    return re.sub(r"[^0-9Xx]", "", raw).upper()


def parse_goodreads_csv(text: str) -> list:
    rows = []
    for rec in csv.DictReader(io.StringIO(text)):
        raw_title = (rec.get("Title") or "").strip()
        if not raw_title:
            continue
        p = parse_title(raw_title)
        shelf = (rec.get("Exclusive Shelf") or "").strip()
        rows.append(GoodreadsRow(
            title=p.title, series=p.series, position=p.position,
            author=(rec.get("Author") or "").strip(),
            isbn=clean_isbn(rec.get("ISBN")), isbn13=clean_isbn(rec.get("ISBN13")),
            shelf=shelf, read=shelf in READ_SHELVES,
        ))
    return rows
