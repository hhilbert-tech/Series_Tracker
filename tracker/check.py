"""Nightly job: diff Hardcover against stored series_book, log notifications, send one digest.

    python -m tracker.check [--dry-run]

First sight of a series ("baseline") seeds series_book silently for books that are already
released; only unreleased/undated books beyond your progress are announced.
"""
import argparse
import sys
from dataclasses import dataclass, field
from datetime import date, datetime, timezone

from . import config, db
from .hardcover import HardcoverAuthError, HardcoverClient, HardcoverError


@dataclass
class CheckResult:
    events: list = field(default_factory=list)
    errors: list = field(default_factory=list)


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _is_past(d, today):
    try:
        return bool(d) and date.fromisoformat(d[:10]) <= today
    except ValueError:
        return False


def _log(conn, sid, hid, kind, *, position, title, release_date, detail=None, suppressed=False):
    now = _now()
    cur = conn.execute(
        """INSERT OR IGNORE INTO notification_log
           (series_id,hardcover_book_id,kind,sent_at,suppressed,position,title,release_date,detail,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?)""",
        (sid, hid, kind, now if suppressed else None, int(suppressed), position, title, release_date, detail, now))
    return cur.rowcount == 1


def sync_series(conn, series_id, books, today, baseline, covers=None):
    """Diff `books` against series_book, update it, log + return new events."""
    s = conn.execute("SELECT name FROM series WHERE id=?", (series_id,)).fetchone()
    mx = db.max_read(conn, series_id)
    existing = {r["position"]: r for r in conn.execute("SELECT * FROM series_book WHERE series_id=?", (series_id,))}
    events = []

    def event(kind, pos, hid, title, d, old=None):
        events.append({"series_id": series_id, "series_name": s["name"], "hardcover_book_id": hid,
                       "position": pos, "title": title, "kind": kind, "release_date": d, "old_date": old,
                       "cover_path": None})

    for b in sorted(books, key=lambda x: x["position"]):
        pos, hid, title, d = b["position"], b["hardcover_book_id"], b["title"], b.get("release_date")
        counted = float(pos).is_integer() and pos > mx          # decimals never count as "next"
        past = _is_past(d, today)
        row = existing.get(pos)
        common = dict(position=pos, title=title, release_date=d)
        if row is None:
            conn.execute("INSERT INTO series_book(series_id,position,hardcover_book_id,title,release_date,"
                         "first_seen_at,cover_url) VALUES(?,?,?,?,?,?,?)",
                         (series_id, pos, hid, title, d, _now(), b.get("cover_url")))
            if counted:
                if baseline and past:
                    _log(conn, series_id, hid, "released", suppressed=True, **common)
                elif past:
                    if _log(conn, series_id, hid, "released", **common):
                        event("released", pos, hid, title, d)
                elif _log(conn, series_id, hid, "announced", **common):
                    event("announced", pos, hid, title, d)
            continue
        old = row["release_date"]
        conn.execute("UPDATE series_book SET hardcover_book_id=?, title=?, release_date=?, "
                     "cover_url=COALESCE(?, cover_url) WHERE series_id=? AND position=?",
                     (hid, title, d, b.get("cover_url"), series_id, pos))
        if counted and d != old:
            _log(conn, series_id, hid, "date_changed", detail=old, **common)
            event("date_changed", pos, hid, title, d, old)
        if counted and past and _log(conn, series_id, hid, "released", **common):
            event("released", pos, hid, title, d)

    for e in events:
        r = conn.execute("SELECT cover_path FROM series_book WHERE series_id=? AND position=?",
                         (series_id, e["position"])).fetchone()
        e["cover_path"] = r[0] if r else None
    conn.commit()
    if covers is not None:
        try:
            from .covers import fetch_series_covers
            fetch_series_covers(conn, covers, series_id)
            for e in events:
                r = conn.execute("SELECT cover_path FROM series_book WHERE series_id=? AND position=?",
                                 (series_id, e["position"])).fetchone()
                e["cover_path"] = r[0] if r else None
        except Exception:
            pass  # covers are cosmetic; never fail the job on them
    return events


def _caught_up_and_complete(conn, s):
    if not s["complete"]:
        return False
    top = conn.execute("SELECT MAX(position) FROM series_book WHERE series_id=?", (s["id"],)).fetchone()[0]
    return top is not None and db.max_read(conn, s["id"]) >= top


def run_check(conn, client, *, today=None, covers=None) -> CheckResult:
    today = today or date.today()
    res = CheckResult()
    rows = conn.execute("SELECT * FROM series WHERE muted=0 AND hardcover_series_id IS NOT NULL ORDER BY id").fetchall()
    for s in rows:
        if _caught_up_and_complete(conn, s):
            continue
        try:
            books = client.series_books(s["hardcover_series_id"])
        except HardcoverAuthError as e:
            res.errors.append(str(e))
            break                       # same token for every series: stop instead of hammering
        except HardcoverError as e:
            res.errors.append(f"{s['name']}: {e}")
            continue
        except Exception as e:           # noqa: BLE001 - one bad series must not kill the run
            res.errors.append(f"{s['name']}: unexpected error ({type(e).__name__})")
            continue
        res.events += sync_series(conn, s["id"], books, today, s["last_checked_at"] is None, covers)
        conn.execute("UPDATE series SET last_checked_at=? WHERE id=?", (_now(), s["id"]))
        conn.commit()
    return res


def main(argv=None, *, client=None, conn=None) -> int:
    from .covers import CoverCache
    from .notify import ConfigError, build_digest, deliver_pending, pending_events, smtp_sender_from_env

    ap = argparse.ArgumentParser(prog="python -m tracker.check")
    ap.add_argument("--dry-run", action="store_true", help="check and log, but print the digest instead of emailing")
    args = ap.parse_args(argv)

    covers = None
    if conn is None:
        config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        conn = db.connect(config.DB_PATH)
        db.init_db(conn)
        covers = CoverCache(config.COVERS_DIR)
    client = client or HardcoverClient.from_env()

    res = run_check(conn, client, covers=covers)
    for e in res.errors:
        print(f"ERROR: {e}", file=sys.stderr)

    if args.dry_run:
        ev = pending_events(conn)
        print(build_digest(ev, config.base_url()).text if ev else "No changes.")
    else:
        try:
            deliver_pending(conn, smtp_sender_from_env(), config.base_url())
        except ConfigError as e:
            print(f"ERROR: {e} (changes stay queued for the next run)", file=sys.stderr)
            return 3
    return 2 if res.errors else 0


if __name__ == "__main__":
    sys.exit(main())
