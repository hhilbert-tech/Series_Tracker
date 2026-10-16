"""Cover cache: Hardcover image -> Open Library by ISBN -> generated placeholder.

Each cover is downloaded at most once (misses are remembered with a `.none` marker).
Covers are never hotlinked from pages or emails.
"""
import hashlib
import html
import textwrap
from pathlib import Path

import httpx

MAX_BYTES = 5 * 1024 * 1024
EXT = {"image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif"}
NAME_RE = r"[0-9a-f]{16}\.(?:jpg|png|webp|gif)"


def openlibrary_url(isbn):
    return f"https://covers.openlibrary.org/b/isbn/{isbn}-M.jpg?default=false"


def default_fetch(url):
    """Return (bytes, content_type), None for a definitive 'no image', raise on transient errors.
    Plain unauthenticated GET: the Hardcover token is never sent to image hosts."""
    if not url.startswith("https://"):
        return None
    r = httpx.get(url, follow_redirects=True, timeout=10, headers={"User-Agent": "series-tracker/0.1"})
    if r.status_code in (403, 404, 410):
        return None
    r.raise_for_status()
    return r.content, r.headers.get("content-type", "")


class CoverCache:
    def __init__(self, directory, fetcher=default_fetch):
        self.dir = Path(directory)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.fetcher = fetcher

    def _stem(self, key):
        return hashlib.sha1(key.encode()).hexdigest()[:16]

    def get_or_fetch(self, key, urls):
        """Cached filename for `key`, fetching from the first working URL; None if there is no cover."""
        stem = self._stem(key)
        for ext in set(EXT.values()):
            if (self.dir / f"{stem}.{ext}").exists():
                return f"{stem}.{ext}"
        if (self.dir / f"{stem}.none").exists():
            return None
        urls = [u for u in urls if u]
        if not urls:
            return None
        transient = False
        for u in urls:
            try:
                res = self.fetcher(u)
            except Exception:
                transient = True
                continue
            if res is None:
                continue
            data, ctype = res
            ext = EXT.get((ctype or "").split(";")[0].strip().lower())
            if not ext or not data or len(data) > MAX_BYTES:
                continue
            (self.dir / f"{stem}.{ext}").write_bytes(data)
            return f"{stem}.{ext}"
        if not transient:
            (self.dir / f"{stem}.none").write_bytes(b"")
        return None


def placeholder_svg(title, seed):
    hue = int(hashlib.sha1((seed or title or "").encode()).hexdigest()[:6], 16) % 360
    lines = textwrap.wrap(title or "", 16)[:4] or [""]
    y0 = 150 - (len(lines) - 1) * 14
    text = "".join(f'<text x="100" y="{y0 + i * 28}" text-anchor="middle">{html.escape(l)}</text>'
                   for i, l in enumerate(lines))
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300" role="img" '
            f'aria-label="{html.escape(title or "", quote=True)}"><title>{html.escape(title or "")}</title>'
            f'<rect width="200" height="300" fill="hsl({hue},45%,28%)"/>'
            f'<g fill="#fff" font-family="Georgia,serif" font-size="22">{text}</g></svg>')


def fetch_series_covers(conn, cache, series_id):
    """Download covers for a series' books (once each) and pick a series cover."""
    for r in conn.execute("SELECT position, cover_url FROM series_book WHERE series_id=? AND cover_path IS NULL "
                          "AND cover_url IS NOT NULL", (series_id,)).fetchall():
        name = cache.get_or_fetch(f"sb-{series_id}-{r['position']}", [r["cover_url"]])
        if name:
            conn.execute("UPDATE series_book SET cover_path=? WHERE series_id=? AND position=?",
                         (name, series_id, r["position"]))
    s = conn.execute("SELECT cover_path, cover_url FROM series WHERE id=?", (series_id,)).fetchone()
    if s and not s["cover_path"]:
        name = None
        first = conn.execute("SELECT cover_path FROM series_book WHERE series_id=? AND cover_path IS NOT NULL "
                             "ORDER BY position LIMIT 1", (series_id,)).fetchone()
        if first:
            name = first[0]
        if not name and s["cover_url"]:
            name = cache.get_or_fetch(f"series-{series_id}", [s["cover_url"]])
        if not name:  # fallback: Open Library by ISBN of a book the user has read
            isbns = [r[0] for r in conn.execute("SELECT isbn13 FROM book WHERE series_id=? AND isbn13<>'' "
                                                "ORDER BY series_position LIMIT 3", (series_id,))]
            name = cache.get_or_fetch(f"series-{series_id}", [openlibrary_url(i) for i in isbns])
        if name:
            conn.execute("UPDATE series SET cover_path=? WHERE id=?", (name, series_id))
    conn.commit()
