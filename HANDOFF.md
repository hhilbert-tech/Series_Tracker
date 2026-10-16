# Handoff — Book Finder (phone PWA, formerly Series Tracker)

**Repo:** `hhilbert-tech/Series_Tracker`, branch `main`. App lives in `phone/`; every push touching it runs `npm test` and deploys to GitHub Pages (`.github/workflows/pages.yml`). Python version was retired (in git history ≤ `f796a60`).

**Stack:** vanilla ES modules, no build. IndexedDB store (`store-idb.js`, `MemStore` twin for tests), hash router in `js/app.js`, service worker `sw.js` (stale-while-revalidate; bump `CACHE` name and add any new js file to `SHELL` on every release). Visible version string lives in `viewMore()` (currently "v14"). Tests: `cd phone && npm test` (node:test, 86 passing).

**Key files:** `app.js` (all views + actions), `hardcover.js` (all GraphQL), `check.js` (release detection), `db.js` (progress model), `authors.js`, `recs.js` (suggestions), `format.js` (dates, store links), `ics.js` (calendar export), `covers.js`.

**Progress model:** `user_progress.max_position_read` + per-book overrides `series_book.read` (true/false) via `isRead(row, max)`; `read_at` stamped when marked read; `series.last_read_at` for sorting.

**Layout (v13):** tabs Discover · Releases · Following · Search · More. Discover (`#/`, `viewDiscover`) = book finder shelves; pick page `#/pick/<key>` (query string carries the book so links survive cache changes); series-only picks use `#/rec/<id>`. Releases (`#/releases`, `viewReleases`) = next release / just out / coming up / continue reading, with a sub-nav to the Updates feed (`#/updates`); the badge sits on Releases. IndexedDB name, backup `app` id and `st-theme` key unchanged on purpose.

**Finder (`recs.js`, v2 cache):** book-level picks keyed `s:<seriesId>` (one per series) or `b:<bookId>` (standalones). Tiers: similar books (seeds = everything read: series_book, imported `book` rows, author_book.read) → followed-author books (local, computed at display time in `authorPicks`) → subgenre tags → other series by authors of followed series → genres. Cached 7 days in setting `recs` (`v: 2`; v1 caches are ignored, old numeric dismissals map to `s:<id>`). Builds run via `startRecsBuild()` in app.js (one at a time; never-built caches retry on every Discover visit, stale ones at most every 6 h); `buildRecs` saves a `partial` list after the similar/author steps and Discover redraws as it arrives. Hardcover requests time out after 25 s. `shelves()` groups picks for Discover; single-book "Because you read X" groups fold into "Similar to books you read".

**Unverified (most likely source of real-world bugs):** Hardcover field names were written from docs, never run against the live API — esp. `cached_similar_book_ids`, `cached_tags`, `rating`, `pages`, `book_series` inside author queries, and (new in v13) `contributions { author { id name } }` + `book_series.position` inside `booksInfo`. First thing to do with the user's real data: **More → Checking & advanced → Verify Hardcover fields**, then fix any MISSING field in `hardcover.js`.

**Not built / open options:** nightly GitHub Actions + ntfy push (user declined for now: needs token as repo secret); Cloudflare Worker proxy so others can use the app without a token; Hardcover Vibes as a suggestion source (needs `read:vibes`, likely Supporter); language filter for translated standalone books on author pages; series length ("#1 of 5") on picks — only the position is known today.

**Testing notes:** Playwright smoke scripts against a mocked Hardcover exist only in the old session's scratchpad — recreate if needed (Chromium at `/opt/pw-browsers`). CSS upper-cases section labels, so text assertions must be case-insensitive.

**User:** Tsek, Android phone. Prefers results first, short replies, one task per session.
