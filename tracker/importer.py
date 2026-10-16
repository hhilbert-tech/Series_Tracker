"""Import (Goodreads CSV / Hardcover library), series matching, and the shared 'follow a series' step."""
import re
from dataclasses import dataclass, field
from datetime import date
from difflib import SequenceMatcher

from . import db
from .check import _now, sync_series
from .hardcover import HardcoverAuthError, HardcoverError
from .parse import parse_goodreads_csv

NOISE = {"the", "a", "an", "series", "saga", "trilogy", "cycle"}
MIN_NAME_SIM = 0.85


@dataclass
class ImportResult:
    books_imported: int = 0
    series_followed: int = 0
    needs_review: int = 0
    errors: list = field(default_factory=list)


def _tokens(s):
    return [t for t in re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).split() if t not in NOISE]


def name_sim(a, b):
    return SequenceMatcher(None, " ".join(_tokens(a)), " ".join(_tokens(b))).ratio()


def _author_ok(want, cand):
    w, c = set(_tokens(want)), set(_tokens(cand))
    return bool(w & c) if (w and c) else None   # None = unknown


def resolve_series(client, name, author, isbns):
    """Spec matching: 1) ISBN13 -> edition -> book -> series, 2) series name + author fuzzy search."""
    for isbn in (isbns or [])[:3]:
        hit = client.find_by_isbn(isbn)
        if hit and hit["series"]:
            best = max(hit["series"], key=lambda s: name_sim(name, s["name"]))
            if not name or name_sim(name, best["name"]) >= 0.5 or len(hit["series"]) == 1:
                return best
    if not name:
        return None
    best, best_score = None, 0.0
    for c in client.search_series(name):
        sim = name_sim(name, c["name"])
        ok = _author_ok(author, c.get("author"))
        if sim < MIN_NAME_SIM or ok is False or (ok is None and sim < 0.95):
            continue
        if sim > best_score:
            best, best_score = c, sim
    return best


def follow_series(conn, client, info, read_up_to=0, covers=None, today=None):
    """Create/refresh a tracked series, raise progress, and baseline-sync its books on first sight."""
    sid = db.upsert_series(conn, info["hardcover_series_id"], info["name"], info.get("author"),
                           info.get("complete", False), info.get("cover_url"))
    db.bump_progress(conn, sid, read_up_to or 0)
    conn.commit()
    row = conn.execute("SELECT last_checked_at FROM series WHERE id=?", (sid,)).fetchone()
    if client is not None and row["last_checked_at"] is None:
        try:
            books = client.series_books(info["hardcover_series_id"])
        except HardcoverError:
            return sid                  # nightly job will baseline it
        sync_series(conn, sid, books, today or date.today(), True, covers)
        conn.execute("UPDATE series SET last_checked_at=? WHERE id=?", (_now(), sid))
        conn.commit()
    return sid


def link_book(conn, book_id, series_id, position=None):
    conn.execute("UPDATE book SET series_id=?, review_status='ok', series_position=COALESCE(?, series_position) "
                 "WHERE id=?", (series_id, position, book_id))


def _max_int_read(positions):
    ints = [p for p in positions if p is not None and float(p).is_integer()]
    return max(ints) if ints else 0


def import_goodreads(conn, text, client, covers=None) -> ImportResult:
    res = ImportResult()
    groups = {}
    for r in parse_goodreads_csv(text):
        if r.series and r.read:
            groups.setdefault((r.series.lower(), r.author.lower()), []).append(r)
    followed, auth_failed = set(), False
    for rows in groups.values():
        ids = []
        for r in rows:
            ex = conn.execute("SELECT id FROM book WHERE source='goodreads' AND title=? AND author=?",
                              (r.title, r.author)).fetchone()
            if ex:
                bid = ex["id"]
                conn.execute("UPDATE book SET isbn13=?, series_name_raw=?, series_position=?, read=1 WHERE id=?",
                             (r.isbn13, r.series, r.position, bid))
            else:
                bid = conn.execute(
                    "INSERT INTO book(title,author,isbn13,series_name_raw,series_position,read,source,review_status) "
                    "VALUES(?,?,?,?,?,1,'goodreads','needs_review')",
                    (r.title, r.author, r.isbn13, r.series, r.position)).lastrowid
                res.books_imported += 1
            ids.append(bid)
        conn.commit()
        states = conn.execute(f"SELECT series_id, review_status FROM book WHERE id IN ({','.join('?' * len(ids))})",
                              ids).fetchall()
        if any(s["review_status"] == "ignored" for s in states):
            continue
        known = next((s["series_id"] for s in states if s["series_id"]), None)
        info = None
        if known:
            info = dict(conn.execute("SELECT hardcover_series_id, name, author FROM series WHERE id=?", (known,)).fetchone())
        elif client is not None and not auth_failed:
            try:
                info = resolve_series(client, rows[0].series, rows[0].author, [r.isbn13 for r in rows if r.isbn13])
            except HardcoverAuthError as e:
                res.errors.append(str(e))
                auth_failed = True
            except HardcoverError as e:
                res.errors.append(f"{rows[0].series}: {e}")
        if not info:
            res.needs_review += 1
            continue
        sid = follow_series(conn, client, info, _max_int_read(r.position for r in rows), covers)
        for bid in ids:
            link_book(conn, bid, sid)
        conn.commit()
        followed.add(sid)
    res.series_followed = len(followed)
    return res


def import_hardcover(conn, client, covers=None) -> ImportResult:
    res = ImportResult()
    followed = set()
    for item in client.my_library():
        if not item["series"]:
            continue
        ex = conn.execute("SELECT id FROM book WHERE source='hardcover' AND hardcover_book_id=?",
                          (item["hardcover_book_id"],)).fetchone()
        first = item["series"][0]
        if ex:
            bid = ex["id"]
        else:
            bid = conn.execute(
                "INSERT INTO book(title,author,series_name_raw,series_position,read,source,hardcover_book_id) "
                "VALUES(?,?,?,?,1,'hardcover',?)",
                (item["title"], item["author"], first["name"], first["position"], item["hardcover_book_id"])).lastrowid
            res.books_imported += 1
        for i, s in enumerate(item["series"]):
            sid = follow_series(conn, client, s, s["position"] if item["read"] else 0, covers)
            followed.add(sid)
            if i == 0:
                link_book(conn, bid, sid, s["position"])
        conn.commit()
    res.series_followed = len(followed)
    return res


def match_and_link_book(conn, client, book_id, covers=None) -> bool:
    """Try spec matching steps 1-2 once for one stored book; link it or mark needs_review."""
    b = conn.execute("SELECT * FROM book WHERE id=?", (book_id,)).fetchone()
    info = None
    if client is not None:
        try:
            info = resolve_series(client, b["series_name_raw"], b["author"], [b["isbn13"]] if b["isbn13"] else [])
        except HardcoverError:
            info = None
    if not info:
        conn.execute("UPDATE book SET review_status='needs_review' WHERE id=?", (book_id,))
        conn.commit()
        return False
    pos = b["series_position"] if b["series_position"] is not None else info.get("position")
    sid = follow_series(conn, client, info, pos if b["read"] else 0, covers)
    link_book(conn, book_id, sid, pos)
    conn.commit()
    return True
