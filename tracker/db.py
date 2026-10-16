"""SQLite schema and small helpers."""
import sqlite3

SCHEMA = """
CREATE TABLE IF NOT EXISTS series(
  id INTEGER PRIMARY KEY,
  hardcover_series_id INTEGER UNIQUE,
  name TEXT NOT NULL,
  author TEXT,
  muted INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT,
  cover_path TEXT,
  cover_url TEXT
);
CREATE TABLE IF NOT EXISTS book(
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT,
  isbn13 TEXT,
  series_name_raw TEXT,
  series_position REAL,
  read INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL CHECK(source IN ('goodreads','hardcover','search','manual')),
  cover_path TEXT,
  series_id INTEGER REFERENCES series(id),
  hardcover_book_id INTEGER,
  review_status TEXT NOT NULL DEFAULT 'ok' CHECK(review_status IN ('ok','needs_review','ignored'))
);
CREATE TABLE IF NOT EXISTS series_book(
  series_id INTEGER NOT NULL REFERENCES series(id),
  position REAL NOT NULL,
  hardcover_book_id INTEGER,
  title TEXT,
  release_date TEXT,
  first_seen_at TEXT,
  cover_path TEXT,
  cover_url TEXT,
  PRIMARY KEY(series_id, position)
);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS user_progress(
  series_id INTEGER PRIMARY KEY REFERENCES series(id),
  max_position_read REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS notification_log(
  id INTEGER PRIMARY KEY,
  series_id INTEGER NOT NULL REFERENCES series(id),
  hardcover_book_id INTEGER,
  kind TEXT NOT NULL CHECK(kind IN ('announced','date_changed','released')),
  sent_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0,
  position REAL,
  title TEXT,
  release_date TEXT,
  detail TEXT,
  created_at TEXT
);
-- dedupe on series+book+kind; date_changed may legitimately repeat for one book
CREATE UNIQUE INDEX IF NOT EXISTS ux_notif_once ON notification_log(series_id, hardcover_book_id, kind)
  WHERE kind IN ('announced','released');
CREATE INDEX IF NOT EXISTS ix_book_series ON book(series_id);
"""


def connect(path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db(conn):
    conn.executescript(SCHEMA)
    conn.commit()


def get_setting(conn, key, default=None):
    row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row[0] if row else default


def set_setting(conn, key, value):
    conn.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                 (key, value))
    conn.commit()


def upsert_series(conn, hc_id, name, author=None, complete=False, cover_url=None) -> int:
    conn.execute(
        """INSERT INTO series(hardcover_series_id,name,author,complete,cover_url) VALUES(?,?,?,?,?)
           ON CONFLICT(hardcover_series_id) DO UPDATE SET
             name=excluded.name,
             author=COALESCE(excluded.author, series.author),
             complete=MAX(series.complete, excluded.complete),
             cover_url=COALESCE(series.cover_url, excluded.cover_url)""",
        (hc_id, name, author, int(bool(complete)), cover_url))
    return conn.execute("SELECT id FROM series WHERE hardcover_series_id=?", (hc_id,)).fetchone()[0]


def bump_progress(conn, series_id, position):
    """Raise max_position_read to `position` (never lowers; non-integer positions don't count)."""
    p = float(position or 0)
    if not p.is_integer():
        p = 0.0
    conn.execute(
        """INSERT INTO user_progress(series_id,max_position_read) VALUES(?,?)
           ON CONFLICT(series_id) DO UPDATE SET
             max_position_read=MAX(user_progress.max_position_read, excluded.max_position_read)""",
        (series_id, p))


def max_read(conn, series_id) -> float:
    row = conn.execute("SELECT max_position_read FROM user_progress WHERE series_id=?", (series_id,)).fetchone()
    return float(row[0]) if row else 0.0
