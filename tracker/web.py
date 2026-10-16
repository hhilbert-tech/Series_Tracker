"""FastAPI UI: tracked series, mute, search/follow/add, hand entry, needs-review, theme.

Single-user and unauthenticated by design (MVP): bind to localhost only.
"""
import re
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Annotated
from urllib.parse import urlencode, urlparse

from fastapi import Depends, FastAPI, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from . import config, db
from .covers import NAME_RE, CoverCache, default_fetch, placeholder_svg
from .hardcover import HardcoverClient, HardcoverError
from .importer import (follow_series, import_goodreads, import_hardcover, link_book,
                       match_and_link_book, _max_int_read)
from .parse import clean_isbn

PKG = Path(__file__).parent
THEMES = ("system", "light", "dark")
MAX_UPLOAD = 20 * 1024 * 1024


def cover_src(path, title, seed):
    if path:
        return f"/covers/{path}"
    return "/placeholder.svg?" + urlencode({"title": (title or "")[:200], "seed": (seed or title or "")[:200]})


def create_app(db_path=None, covers_dir=None, client_factory=None, fetcher=None) -> FastAPI:
    db_path = Path(db_path or config.DB_PATH)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    boot = db.connect(db_path)
    db.init_db(boot)
    boot.close()

    app = FastAPI(title="Series Tracker")
    app.state.covers = CoverCache(covers_dir or config.COVERS_DIR, fetcher or default_fetch)
    app.state.client_factory = client_factory or HardcoverClient.from_env
    app.state.client = None
    app.mount("/static", StaticFiles(directory=PKG / "static"), name="static")

    templates = Jinja2Templates(directory=PKG / "templates")
    templates.env.globals["cover"] = cover_src
    templates.env.filters["pos"] = lambda p: "" if p is None else f"{float(p):g}"

    def get_conn():
        c = db.connect(db_path)
        try:
            yield c
        finally:
            c.close()

    Conn = Annotated[sqlite3.Connection, Depends(get_conn)]

    def client():
        if app.state.client is None:
            app.state.client = app.state.client_factory()
        return app.state.client

    def render(request, name, conn, **ctx):
        ctx.update(theme=db.get_setting(conn, "theme", "system"), msg=request.query_params.get("msg"),
                   review_count=conn.execute("SELECT COUNT(*) FROM book WHERE review_status='needs_review'").fetchone()[0])
        return templates.TemplateResponse(request, name, ctx)

    def go(url):
        return RedirectResponse(url, status_code=303)

    def back(request, default="/"):
        ref = urlparse(request.headers.get("referer", ""))
        return (ref.path + ("?" + ref.query if ref.query else "")) if ref.path.startswith("/") else default

    def say(path, text):
        return go(f"{path}?{urlencode({'msg': text})}")

    # ---- home -----------------------------------------------------------
    @app.get("/")
    def home(request: Request, conn: Conn):
        rows = conn.execute(
            "SELECT s.*, COALESCE(p.max_position_read,0) AS max_read FROM series s "
            "LEFT JOIN user_progress p ON p.series_id=s.id ORDER BY s.muted, s.name COLLATE NOCASE").fetchall()
        series = []
        for r in rows:
            nxt = conn.execute(
                "SELECT position, title, release_date FROM series_book WHERE series_id=? AND position>? "
                "AND position=CAST(position AS INTEGER) ORDER BY position LIMIT 1", (r["id"], r["max_read"])).fetchone()
            series.append({**dict(r), "next": nxt})
        n_muted = sum(1 for s in series if s["muted"])
        return render(request, "home.html", conn, series=series, n_following=len(series) - n_muted, n_muted=n_muted)

    @app.post("/theme")
    def set_theme(conn: Conn, theme: Annotated[str, Form()], next: Annotated[str, Form()] = "/"):
        if theme not in THEMES:
            raise HTTPException(400, "theme must be system, light or dark")
        db.set_setting(conn, "theme", theme)
        return go(next if next.startswith("/") and not next.startswith("//") else "/")

    # ---- import ---------------------------------------------------------
    def report(res, what):
        text = f"{what}: {res.books_imported} new books, {res.series_followed} series matched, {res.needs_review} to review."
        if res.errors:
            text += " Problem: " + res.errors[0]
        return say("/", text)

    @app.post("/import/goodreads")
    def import_gr(conn: Conn, file: UploadFile):
        raw = file.file.read(MAX_UPLOAD + 1)
        if len(raw) > MAX_UPLOAD:
            return say("/", "That file is too large for a Goodreads export.")
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            return say("/", "Could not read that file as UTF-8 CSV.")
        if "Title" not in text.split("\n", 1)[0]:
            return say("/", "That doesn't look like a Goodreads library export (no Title column).")
        return report(import_goodreads(conn, text, client(), app.state.covers), "Goodreads import")

    @app.post("/import/hardcover")
    def import_hc(conn: Conn, token: Annotated[str, Form()] = ""):
        c = HardcoverClient(token) if token.strip() else client()    # pasted token is used once, never stored
        try:
            return report(import_hardcover(conn, c, app.state.covers), "Hardcover import")
        except HardcoverError as e:
            return say("/", f"Hardcover import failed: {e}")

    # ---- series ---------------------------------------------------------
    @app.get("/series/{sid}")
    def series_page(request: Request, sid: int, conn: Conn):
        s = conn.execute("SELECT * FROM series WHERE id=?", (sid,)).fetchone()
        if not s:
            raise HTTPException(404, "No such series")
        books = conn.execute("SELECT * FROM series_book WHERE series_id=? ORDER BY position", (sid,)).fetchall()
        return render(request, "series.html", conn, s=s, books=books, max_read=db.max_read(conn, sid))

    @app.post("/series/{sid}/mute")
    def toggle_mute(request: Request, sid: int, conn: Conn):
        conn.execute("UPDATE series SET muted = 1 - muted WHERE id=?", (sid,))
        conn.commit()
        return go(back(request))

    # ---- search / follow / add -------------------------------------------
    def run_search(conn, q):
        q = (q or "").strip()
        if not q:
            return {"q": q, "series": [], "books": [], "error": None}
        try:
            res = client().search(q)
        except HardcoverError as e:
            return {"q": q, "series": [], "books": [], "error": str(e)}
        urls = {h.get("cover_url") for h in res["series"] + res["books"] if h.get("cover_url")}
        with ThreadPoolExecutor(5) as ex:
            files = dict(zip(urls, ex.map(lambda u: app.state.covers.get_or_fetch(f"remote-{u}", [u]), urls)))
        for h in res["series"] + res["books"]:
            h["cover_file"] = files.get(h.get("cover_url"))
        followed = {r[0] for r in conn.execute("SELECT hardcover_series_id FROM series")}
        return {"q": q, "series": res["series"], "books": res["books"], "error": None, "followed": followed}

    @app.get("/search")
    def search(request: Request, conn: Conn, q: str = ""):
        return render(request, "search.html", conn, **run_search(conn, q))

    @app.get("/search/results")
    def search_fragment(request: Request, conn: Conn, q: str = ""):
        return render(request, "_results.html", conn, **run_search(conn, q))

    @app.post("/follow")
    def follow(conn: Conn, hardcover_series_id: Annotated[int, Form()], name: Annotated[str, Form()],
               author: Annotated[str, Form()] = "", cover_url: Annotated[str, Form()] = "",
               complete: Annotated[bool, Form()] = False, read_up_to: Annotated[int, Form()] = 0):
        info = {"hardcover_series_id": hardcover_series_id, "name": name, "author": author or None,
                "cover_url": cover_url or None, "complete": complete}
        sid = follow_series(conn, client(), info, max(0, read_up_to), app.state.covers)
        return go(f"/series/{sid}")

    @app.post("/add-book")
    def add_book(conn: Conn, hardcover_book_id: Annotated[int, Form()], title: Annotated[str, Form()],
                 author: Annotated[str, Form()] = "", cover_url: Annotated[str, Form()] = "",
                 isbn13: Annotated[str, Form()] = ""):
        ex = conn.execute("SELECT id FROM book WHERE source='search' AND hardcover_book_id=?",
                          (hardcover_book_id,)).fetchone()
        if ex:
            return say("/", f"“{title}” is already in your history.")
        cover = app.state.covers.get_or_fetch(f"book-{hardcover_book_id}", [cover_url]) if cover_url else None
        bid = conn.execute("INSERT INTO book(title,author,isbn13,read,source,hardcover_book_id,cover_path) "
                           "VALUES(?,?,?,1,'search',?,?)",
                           (title, author or None, clean_isbn(isbn13), hardcover_book_id, cover)).lastrowid
        conn.commit()
        try:
            seriess = client().book_series(hardcover_book_id)
        except HardcoverError:
            seriess = []
        for i, s in enumerate(seriess):
            sid = follow_series(conn, client(), s, s["position"], app.state.covers)
            if i == 0:
                link_book(conn, bid, sid, s["position"])
        conn.commit()
        extra = f" and following {seriess[0]['name']}" if seriess else ""
        return say("/", f"Added “{title}”{extra}.")

    # ---- hand entry -----------------------------------------------------
    @app.get("/manual")
    def manual_form(request: Request, conn: Conn):
        return render(request, "manual.html", conn)

    @app.post("/manual")
    def manual_save(conn: Conn, title: Annotated[str, Form()], author: Annotated[str, Form()] = "",
                    series_name: Annotated[str, Form()] = "", position: Annotated[str, Form()] = "",
                    isbn: Annotated[str, Form()] = "", read: Annotated[bool, Form()] = True):
        title = title.strip()
        if not title:
            return say("/manual", "A title is required.")
        try:
            pos = float(position) if position.strip() else None
        except ValueError:
            return say("/manual", "Position must be a number, e.g. 3 or 2.5.")
        bid = conn.execute(
            "INSERT INTO book(title,author,isbn13,series_name_raw,series_position,read,source,review_status) "
            "VALUES(?,?,?,?,?,?,'manual','needs_review')",
            (title, author.strip() or None, clean_isbn(isbn), series_name.strip() or None, pos, int(read))).lastrowid
        conn.commit()
        ok = match_and_link_book(conn, client(), bid, app.state.covers)
        return say("/", f"Saved “{title}”." + ("" if ok else " No Hardcover match yet — see Needs review."))

    # ---- needs review ---------------------------------------------------
    def group_ids(conn, bid):
        b = conn.execute("SELECT * FROM book WHERE id=?", (bid,)).fetchone()
        if not b:
            raise HTTPException(404, "No such book")
        if b["series_name_raw"]:
            ids = [r[0] for r in conn.execute(
                "SELECT id FROM book WHERE review_status='needs_review' AND source=? AND series_name_raw=? "
                "AND COALESCE(author,'')=COALESCE(?, '')", (b["source"], b["series_name_raw"], b["author"]))]
        else:
            ids = [bid]
        return b, ids

    @app.get("/review")
    def review(request: Request, conn: Conn, book: int = 0, q: str = ""):
        rows = conn.execute("SELECT * FROM book WHERE review_status='needs_review' "
                            "ORDER BY series_name_raw, author, series_position, title").fetchall()
        groups, seen = [], {}
        for r in rows:
            key = (r["source"], r["series_name_raw"], r["author"]) if r["series_name_raw"] else ("one", r["id"])
            if key not in seen:
                seen[key] = {"lead": r, "books": []}
                groups.append(seen[key])
            seen[key]["books"].append(r)
        cands, error = [], None
        if book and q.strip():
            try:
                cands = client().search_series(q.strip())
            except HardcoverError as e:
                error = str(e)
        return render(request, "review.html", conn, groups=groups, active=book, q=q, cands=cands, error=error)

    @app.post("/review/{bid}/assign")
    def assign(conn: Conn, bid: int, hardcover_series_id: Annotated[int, Form()], name: Annotated[str, Form()],
               author: Annotated[str, Form()] = ""):
        _, ids = group_ids(conn, bid)
        rows = [conn.execute("SELECT series_position, read FROM book WHERE id=?", (i,)).fetchone() for i in ids]
        upto = _max_int_read(r["series_position"] for r in rows if r["read"])
        sid = follow_series(conn, client(), {"hardcover_series_id": hardcover_series_id, "name": name,
                                             "author": author or None}, upto, app.state.covers)
        for i in ids:
            link_book(conn, i, sid)
        conn.commit()
        return go("/review")

    @app.post("/review/{bid}/ignore")
    def ignore(conn: Conn, bid: int):
        _, ids = group_ids(conn, bid)
        conn.executemany("UPDATE book SET review_status='ignored' WHERE id=?", [(i,) for i in ids])
        conn.commit()
        return go("/review")

    # ---- covers ---------------------------------------------------------
    @app.get("/covers/{name}")
    def cover_file(name: str):
        if not re.fullmatch(NAME_RE, name):
            raise HTTPException(404)
        p = app.state.covers.dir / name
        if not p.is_file():
            raise HTTPException(404)
        return FileResponse(p, headers={"Cache-Control": "public, max-age=31536000, immutable",
                                        "X-Content-Type-Options": "nosniff"})

    @app.get("/placeholder.svg")
    def placeholder(title: str = "", seed: str = ""):
        return Response(placeholder_svg(title[:200], seed[:200]), media_type="image/svg+xml",
                        headers={"Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff"})

    return app
