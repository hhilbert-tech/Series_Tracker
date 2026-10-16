# Series Release Tracker (MVP)

> **On a phone?** Use the no-server version in [`phone/`](phone/README.md). This Python version needs a computer running.

Imports your reading history, works out which series you're partway through, and emails you
when the next book is announced, its date changes, or it's released.

## Run

    python -m venv .venv && .venv/bin/pip install -r requirements.txt     # Windows: .venv\Scripts\pip
    export HARDCOVER_TOKEN=...            # your own Hardcover API token (env only, never stored)
    uvicorn tracker.web:create_app --factory --port 8000                  # http://localhost:8000

Nightly job (cron / Task Scheduler): `python -m tracker.check` (`--dry-run` prints the digest instead of emailing).
Exit codes: 0 ok, 2 Hardcover errors (e.g. rejected token), 3 email not configured (changes stay queued).

Email: `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `NOTIFY_TO` (optional `SMTP_PORT` default 587, `SMTP_FROM`).
`PUBLIC_BASE_URL` (default `http://localhost:8000`) is used for cover links in the digest; set it to an
address your mail client can reach or covers won't load. Data lives in `data/` (`TRACKER_DB`, `TRACKER_COVERS`).

## Before first real use
Hardcover field names were written from its public docs and are **not verified**. Run
`HARDCOVER_TOKEN=... python -m tracker.introspect` and fix any MISSING field in `tracker/hardcover.py`
(all GraphQL lives in that one file).

## Tests
`pytest` — the 11 acceptance tests from the spec plus coverage for import, matching, digest and web routes.
Theme behaviour is tested structurally (CSS tokens, WCAG AA contrast, persisted `data-theme`), not in a real browser.

## Decisions beyond the spec
- First check of a series is a *baseline*: already-released books are stored silently; only unreleased or
  undated books past your progress are announced. (Otherwise a first run would announce your whole backlog.)
- `date_changed` can repeat per book; `announced`/`released` are deduped per series+book.
- Unsent notifications stay queued (`sent_at` NULL) and go out in the next digest.
- Added columns: `book.series_id/hardcover_book_id/review_status`, `series.complete/cover_url`,
  `series_book.cover_url`, `notification_log.suppressed/position/title/release_date/detail`.
- Not built: Open Library/Google Books date fallbacks (Open Library is used for covers only), auth, Kindle.
- No login: bind to localhost only.
