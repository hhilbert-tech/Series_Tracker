# Book Finder — phone app (no server)

Finds your next book. **Discover** (the home screen) shows books similar to what you've read (Hardcover's
"similar books", standalones included; a series is suggested from its book 1), unread books by authors you follow,
and popular books in your genres. Also on Discover:
- *Find books like…*: search any title and see books similar to it.
- Filters: standalones / series, minimum rating, maximum length.
- *♥ Favourite* a book you've read (book pages, or *♥ Loved it* on a pick): favourites steer the picks at double weight.
- *Not interested* twice for the same author (or genre row) sends the rest of them to the end; *Never suggest* hides an author.

**Want to read** (tab): books you saved with *＋ Want to read* on a pick, also marked Want to Read on Hardcover when your token allows it.

**More → Following & releases** holds the series and authors you follow plus the reminder side: *Releases* (next release, just out, coming up, continue reading) and the *Updates* feed; the unread count shows on the More tab.

An installable web app. Everything runs in your phone's browser and your data stays on the phone
(IndexedDB). The only network traffic is to Hardcover (and cover images), straight from the phone.

## What differs from the spec
- **No nightly email.** There is no always-on machine. The app checks when you open it (at most every 12 hours,
  or tap *More → Check now*) and lists changes under **More → Following & releases → Updates** with a badge on the More tab.
- **Authors:** search an author and tap *Follow author* (or use the *follow author* link on a series or book page). Their unread books show in Discover; any new book by them lands in Updates; books of a series you already follow are left to the series check.
- **Background alerts: best effort.** On Android Chrome, with the app installed, *More → Enable background alerts*
  asks the browser to check periodically and show a notification. The browser decides if and when it runs.
  iPhone can't do this.
- Hardcover token: pasted once on the phone and stored only there (never in backups, never logged).

## Put it on your phone
The phone needs an **https** address to install it and use it offline. Any free static host works; the host only
serves the code, never your data.
1. Upload the contents of this `phone` folder to a static host. Two common ones: **Netlify Drop**
   (app.netlify.com/drop — drag the folder in; sign in so the site doesn't expire) or **GitHub Pages**
   (new repo → upload these files → Settings → Pages → deploy from the main branch). Check each host's current steps.
2. Open the https address on your phone.
3. Install it: Android Chrome menu → *Install app*; iPhone Safari → Share → *Add to Home Screen* (do this on iPhone,
   or iOS may delete the data after a week without use).

Quick try on your home Wi-Fi without hosting (can't be installed or used offline): in this folder run
`py -m http.server 8000`, find your PC's address with `ipconfig`, and open `http://<that-address>:8000` on the phone.

## First use
*More → Hardcover token* → paste your token → *Import Goodreads CSV* (get the export from Goodreads on the phone,
or move the file there) → check **Needs review** for anything that didn't match.
Then *More → Verify Hardcover fields*: the Hardcover queries were written from its public docs and haven't been
confirmed against the live schema. If anything is listed as missing, the queries are at the top of `js/hardcover.js`.

## Notes
- Hardcover's docs currently say API queries should run server-side and list browser use as planned for 2026, while
  noting CORS is open. It works today; if Hardcover blocks it later, a small proxy would be the fix.
- Tokens expire (you choose the period when creating one). A "rejected" message means paste a new one.
- Export a backup from *More* now and then; restoring replaces everything on the phone.
- Updates: re-upload the files. The new version appears the second time you open the app.
- Tests: `npm test` (Node 20+): 49 tests covering the acceptance criteria, import/matching and WCAG AA contrast.

## Added later
- Per-book read ticks (a skipped book stays unread), "Next to read" shelf on Home, "Get it / Pre-order" links to a store you pick in More,
  ratings and sorting on suggestions, cover lookup by title on Open Library when no cover is found.
- Following: sort and filters; series rows with read ticks (swipe a row to tick it); book pages with previous/next and Hardcover's similar books;
  grouped Updates (swipe to dismiss); search tabs; More split into sections; reading stats; calendar (.ics) export of upcoming releases.
