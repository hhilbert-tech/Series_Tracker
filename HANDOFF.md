# Handoff — Series Tracker (phone PWA)

**Repo:** `hhilbert-tech/Series_Tracker`, branch `main`. App lives in `phone/`; every push touching it runs `npm test` and deploys to GitHub Pages (`.github/workflows/pages.yml`). Python version was retired (in git history ≤ `f796a60`).

**Stack:** vanilla ES modules, no build. IndexedDB store (`store-idb.js`, `MemStore` twin for tests), hash router in `js/app.js`, service worker `sw.js` (stale-while-revalidate; bump `CACHE` name and add any new js file to `SHELL` on every release). Visible version string lives in `viewMore()` (currently "v12"). Tests: `cd phone && npm test` (node:test, 80 passing).

**Key files:** `app.js` (all views + actions), `hardcover.js` (all GraphQL), `check.js` (release detection), `db.js` (progress model), `authors.js`, `recs.js` (suggestions), `format.js` (dates, store links), `ics.js` (calendar export), `covers.js`.

**Progress model:** `user_progress.max_position_read` + per-book overrides `series_book.read` (true/false) via `isRead(row, max)`; `read_at` stamped when marked read; `series.last_read_at` for sorting.

**Suggestions:** Hardcover `cached_similar_book_ids` (top source) → author series → tag/genre popularity. Cached 7 days in setting `recs`; rebuilds merge with the old list so it never empties.

**Unverified (most likely source of real-world bugs):** Hardcover field names were written from docs, never run against the live API — esp. `cached_similar_book_ids`, `cached_tags`, `rating`, `pages`, `book_series` inside author queries. First thing to do with the user's real data: **More → Checking & advanced → Verify Hardcover fields**, then fix any MISSING field in `hardcover.js`.

**Not built / open options:** nightly GitHub Actions + ntfy push (user declined for now: needs token as repo secret); Cloudflare Worker proxy so others can use the app without a token; Hardcover Vibes as a suggestion source (needs `read:vibes`, likely Supporter); language filter for translated standalone books on author pages; "#1 of 5 in series" label on suggestion cards.

**Testing notes:** Playwright smoke scripts against a mocked Hardcover exist only in the old session's scratchpad — recreate if needed (Chromium at `/opt/pw-browsers`). CSS upper-cases section labels, so text assertions must be case-insensitive.

**User:** Tsek, Android phone. Prefers results first, short replies, one task per session.
