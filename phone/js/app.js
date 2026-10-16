// UI: hash-routed, mobile-first. All data lives in this browser (IndexedDB); nothing is sent anywhere
// except requests to Hardcover (and cover images) made directly from the phone.
import { openIdbStore } from './store-idb.js';
import { HardcoverClient, HardcoverError } from './hardcover.js';
import { CoverCache, placeholderUri } from './covers.js';
import { getSetting, setSetting, sbKey, maxRead, setProgress, removeSeries, lastReleased, nowIso } from './db.js';
import { followAuthor, removeAuthor } from './authors.js';
import { runCheck, updates, pendingEvents, markAllSeen } from './check.js';
import { importGoodreads, importHardcover, followSeries, addManualBook, addSearchBook, reviewGroups, assignGroup, ignoreGroup } from './importer.js';
import { KEYS } from './store-base.js';

const THEMES = ['system', 'light', 'dark'];
const LABEL = { announced: 'New book announced', date_changed: 'Release date changed', released: 'Now released' };
const CHECK_EVERY_MS = 12 * 3600 * 1000;
const $app = document.getElementById('app');
let store, covers, client, theme = 'system', checking = false, searchSeq = 0, installPrompt = null, afterRender = null;
const failedCovers = new Set();
const objectUrls = new Map();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pos = (p) => (p == null ? '' : String(Number(p)));
const msg = (e) => (e instanceof HardcoverError ? e.message : 'Something went wrong: ' + (e?.message ?? e));

// ---- feedback ---------------------------------------------------------------------------
let toastTimer;
function toast(text, { error = false, ms = 7000 } = {}) {
  const el = document.getElementById('toast');
  clearTimeout(toastTimer);
  el.textContent = text; el.className = error ? 'error' : '';
  if (text && ms) toastTimer = setTimeout(() => { el.textContent = ''; }, ms);
}

// ---- theme --------------------------------------------------------------------------------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('st-theme', t); } catch { /* private mode etc. */ }
}
async function setTheme(t) {
  if (!THEMES.includes(t)) return;
  theme = t; applyTheme(t); await setSetting(store, 'theme', t);
}

// ---- covers -------------------------------------------------------------------------------
// key: cache key (or null); fb: remote URL used to fill the cache once, or shown directly if the browser blocks the download.
function img(key, fb, title, seed, cls = 'cover') {
  return `<img class="${cls}" src="${esc(placeholderUri(title, seed))}" alt="Cover of ${esc(title)}" loading="lazy" `
    + `data-ck="${esc(key ?? '')}" data-fb="${esc(fb ?? '')}" data-title="${esc(title)}" data-seed="${esc(seed)}">`;
}
async function hydrateCovers(root = $app) {
  await Promise.all([...root.querySelectorAll('img[data-ck]')].map(async (el) => {
    const { ck, fb } = el.dataset;
    if (!ck && !fb) return;
    const key = ck || `remote-${fb}`;
    try {
      let rec = await store.get('covers', key);
      if (!rec && fb && !failedCovers.has(key)) {
        if (await covers.getOrFetch(key, [fb])) rec = await store.get('covers', key);
        else if (!(await store.get('covers', key))) failedCovers.add(key);   // blocked or transient: don't retry this session
      }
      if (rec?.blob) {
        if (!objectUrls.has(key)) objectUrls.set(key, URL.createObjectURL(rec.blob));
        el.src = objectUrls.get(key);
      } else if (fb && !rec) {
        el.onerror = () => { el.onerror = null; el.src = placeholderUri(el.dataset.title, el.dataset.seed); };
        el.src = fb;                                    // fallback: browser HTTP cache
      }
    } catch { /* keep placeholder */ }
  }));
}

// ---- views ----------------------------------------------------------------------------------
function seriesCard(s, read, next) {
  return `<li class="card ${s.muted ? 'is-muted' : ''}">
    ${img(s.cover_key ?? `series-${s.id}`, s.cover_key ? '' : s.cover_url, s.name, s.name)}
    <div>
      <h2><a href="#/series/${s.id}">${esc(s.name)}</a>${s.muted ? ' <span class="badge">Muted</span>' : ''}</h2>
      <p class="meta">${esc(s.author ?? 'Unknown author')} · read up to #${pos(read)}</p>
      <p>${next ? `Next: <a href="#/book/${s.id}/${next.position}">#${pos(next.position)} ${esc(next.title)}</a> — ${esc(next.release_date ?? 'date TBA')}`
        : s.last_checked_at ? 'No unread book announced yet' : 'Not checked yet'}</p>
      <button data-click="mute" data-id="${s.id}">${s.muted ? 'Unmute' : 'Mute'}</button>
      <button data-click="remove" data-id="${s.id}" data-name="${esc(s.name)}">Remove</button>
    </div></li>`;
}

async function viewHome() {
  const series = (await store.all('series')).sort((a, b) => a.muted - b.muted || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const sbs = await store.all('series_book');
  const cards = [];
  for (const s of series) {
    const read = await maxRead(store, s.id);
    const next = sbs.filter((r) => r.series_id === s.id && Number.isInteger(r.position) && r.position > read).sort((a, b) => a.position - b.position)[0];
    cards.push(seriesCard(s, read, next));
  }
  const authors = (await store.all('author')).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const muted = series.filter((s) => s.muted).length;
  const unseen = (await pendingEvents(store)).length;
  return `<h1>You're following ${series.length - muted} series${muted ? ` <small>(${muted} muted)</small>` : ''}</h1>
    ${unseen ? `<p class="flash"><a href="#/updates">${unseen} new update${unseen > 1 ? 's' : ''} — see what's new</a></p>` : ''}
    ${series.length ? `<ul class="cards">${cards.join('')}</ul>`
      : `<p>Nothing followed yet.</p><p><a class="btn" href="#/more">Import your reading history</a> or <a href="#/search">search for a series</a>.</p>`}
    ${authors.length ? `<h2>Authors you follow</h2><ul class="cards">${authors.map((a) => `<li class="card ${a.muted ? 'is-muted' : ''}">
      ${img(null, a.cover_url, a.name, a.name)}<div><h2><a href="#/author/${a.hardcover_author_id}">${esc(a.name)}</a>${a.muted ? ' <span class="badge">Muted</span>' : ''}</h2>
      <p class="meta">New books by this author show up in Updates.</p></div></li>`).join('')}</ul>` : ''}`;
}

async function viewSeries(id) {
  const s = await store.get('series', Number(id));
  if (!s) return '<p>No such series. <a href="#/">Back</a></p>';
  const read = await maxRead(store, s.id);
  const books = (await store.all('series_book')).filter((r) => r.series_id === s.id).sort((a, b) => a.position - b.position);
  return `<p><a href="#/">← Following</a></p>
    <div class="card" style="margin-bottom:1rem">
      ${img(s.cover_key ?? `series-${s.id}`, s.cover_key ? '' : s.cover_url, s.name, s.name, 'cover big')}
      <div><h1>${esc(s.name)}${s.muted ? ' <span class="badge">Muted</span>' : ''}</h1>
        <p class="meta">${esc(s.author ?? 'Unknown author')}${s.author ? ` (<a href="#/search?q=${encodeURIComponent(s.author)}">follow author</a>)` : ''} · read up to #${pos(read)}${s.complete ? ' · complete' : ''}</p>
        <p class="meta">${s.last_checked_at ? 'Last checked ' + esc(s.last_checked_at) : 'Not checked yet'}</p>
        <button data-click="mute" data-id="${s.id}">${s.muted ? 'Unmute' : 'Mute'}</button>
        <button data-click="read-all" data-id="${s.id}">Mark all released as read</button>
        <button data-click="remove" data-id="${s.id}" data-name="${esc(s.name)}" data-home="1">Remove</button>
        ${read ? `<button data-click="read-none" data-id="${s.id}">Reset progress</button>` : ''}</div></div>
    ${books.length ? `<ul class="rows">${books.map((b) => {
      const whole = Number.isInteger(b.position), isRead = b.position <= read;
      const btn = !whole ? '' : isRead
        ? (b.position === read ? ` <button data-click="read-to" data-id="${s.id}" data-pos="${b.position - 1}">Undo</button>` : '')
        : ` <button data-click="read-to" data-id="${s.id}" data-pos="${b.position}">Read up to here</button>`;
      return `<li class="${isRead ? 'read' : ''}">
        ${img(b.cover_key ?? `sb-${s.id}-${b.position}`, b.cover_key ? '' : b.cover_url, b.title, s.name, 'cover small')}
        <div><strong><a href="#/book/${s.id}/${b.position}">#${pos(b.position)} ${esc(b.title)}</a></strong><br><span class="meta">${esc(b.release_date ?? 'TBA')} · ${isRead ? 'Read' : 'Unread'}</span>${btn}</div></li>`;
    }).join('')}</ul>`
      : '<p>No books fetched yet. Use “Check now” in More.</p>'}`;
}

async function viewBook(sid, position) {
  sid = Number(sid); position = Number(position);
  const s = await store.get('series', sid), b = await store.get('series_book', sbKey(sid, position));
  if (!s || !b) return '<p>No such book. <a href="#/">Back</a></p>';
  const read = await maxRead(store, sid), isRead = b.position <= read, today = nowIso().slice(0, 10);
  const status = !b.release_date ? 'Release date not announced'
    : b.release_date.slice(0, 10) <= today ? `Released ${esc(b.release_date)}` : `Coming ${esc(b.release_date)}`;
  const whole = Number.isInteger(b.position);
  const btn = !whole ? '' : isRead
    ? (b.position === read ? `<button data-click="read-to" data-id="${sid}" data-pos="${b.position - 1}" data-back="1">Undo read</button>` : '')
    : `<button data-click="read-to" data-id="${sid}" data-pos="${b.position}" data-back="1">Read up to here</button>`;
  afterRender = async () => {
    const box = document.getElementById('book-more');
    if (!box) return;
    if (!b.hardcover_book_id) { box.textContent = ''; return; }
    try {
      const d = await client.bookDetails(b.hardcover_book_id);
      const bits = [d.pages ? `<p class="meta">${d.pages} pages</p>` : '',
        d.description ? `<p class="desc">${esc(d.description).replace(/\n+/g, '</p><p class="desc">')}</p>` : '<p class="meta">No description on Hardcover.</p>'];
      box.innerHTML = bits.join('');
    } catch (e) { box.innerHTML = `<p class="meta">Details unavailable: ${esc(msg(e))}</p>`; }
  };
  return `<p><a href="#/series/${sid}">← ${esc(s.name)}</a></p>
    <div class="card" style="margin-bottom:1rem">
      ${img(b.cover_key ?? `sb-${sid}-${b.position}`, b.cover_key ? '' : b.cover_url, b.title, s.name, 'cover big')}
      <div><h1>${esc(b.title)}</h1>
        <p class="meta">${esc(s.author ?? 'Unknown author')}${s.author ? ` (<a href="#/search?q=${encodeURIComponent(s.author)}">follow author</a>)` : ''} · ${esc(s.name)} #${pos(b.position)}</p>
        <p>${status}</p><p class="meta">${isRead ? 'Read' : 'Unread'}</p>${btn}</div></div>
    <div id="book-more"><p class="meta">Loading details…</p></div>`;
}

async function viewAuthor(id) {
  const a = await store.get('author', Number(id));
  if (!a) return '<p>No such author. <a href="#/">Back</a></p>';
  const today = nowIso().slice(0, 10);
  const books = (await store.all('author_book')).filter((r) => r.author_id === a.hardcover_author_id)
    .sort((x, y) => (y.release_date ?? '9999').localeCompare(x.release_date ?? '9999'));
  const up = books.filter((b) => !b.release_date || b.release_date.slice(0, 10) > today), out = books.filter((b) => !up.includes(b));
  const row = (b) => `<li>${img(null, b.cover_url, b.title, a.name, 'cover small')}<div><strong>${esc(b.title)}</strong><br>
    <span class="meta">${esc(b.release_date ?? 'TBA')}</span></div></li>`;
  return `<p><a href="#/">← Following</a></p>
    <div class="card" style="margin-bottom:1rem">${img(null, a.cover_url, a.name, a.name, 'cover big')}
      <div><h1>${esc(a.name)}${a.muted ? ' <span class="badge">Muted</span>' : ''}</h1>
        <p class="meta">${a.last_checked_at ? 'Last checked ' + esc(a.last_checked_at) : 'Not checked yet'} · ${books.length} books</p>
        <button data-click="mute-author" data-id="${a.hardcover_author_id}">${a.muted ? 'Unmute' : 'Mute'}</button>
        <button data-click="remove-author" data-id="${a.hardcover_author_id}" data-name="${esc(a.name)}">Remove</button></div></div>
    ${up.length ? `<h2>Upcoming / undated</h2><ul class="rows">${up.map(row).join('')}</ul>` : ''}
    <h2>Released</h2>${out.length ? `<ul class="rows">${out.map(row).join('')}</ul>` : '<p>No books listed.</p>'}`;
}

function resultsHtml(r, followed, followedAuthors = new Set()) {
  if (r.error) return `<p class="error" role="alert">${esc(r.error)}</p>`;
  if (!r.q) return '';
  const sCards = r.series.map((s) => `<li class="card">${img(null, s.cover_url, s.name, s.name)}<div><h3>${esc(s.name)}</h3>
      <p class="meta">${esc(s.author ?? 'Unknown author')}${s.books_count ? ` · ${s.books_count} books` : ''}</p>
      ${followed.has(s.hardcover_series_id) ? '<p><span class="badge">Following</span></p>' : `
      <form class="inline" data-form="follow">
        <input type="hidden" name="hardcover_series_id" value="${s.hardcover_series_id}"><input type="hidden" name="name" value="${esc(s.name)}">
        <input type="hidden" name="author" value="${esc(s.author ?? '')}"><input type="hidden" name="cover_url" value="${esc(s.cover_url ?? '')}">
        <input type="hidden" name="complete" value="${s.complete ? 1 : ''}">
        <label>I've read up to book <input type="number" name="read_up_to" min="0" value="0" inputmode="numeric"></label>
        <button class="primary">Follow</button></form>`}</div></li>`).join('');
  const bCards = r.books.map((b) => `<li class="card">${img(null, b.cover_url, b.title, b.title)}<div><h3>${esc(b.title)}</h3>
      <p class="meta">${esc(b.author ?? 'Unknown author')}${b.release_date ? ' · ' + esc(b.release_date) : ''}</p>
      <form class="inline" data-form="add-book">
        <input type="hidden" name="hardcover_book_id" value="${b.hardcover_book_id}"><input type="hidden" name="title" value="${esc(b.title)}">
        <input type="hidden" name="author" value="${esc(b.author ?? '')}"><input type="hidden" name="cover_url" value="${esc(b.cover_url ?? '')}">
        <input type="hidden" name="isbn13" value="${esc(b.isbn13 ?? '')}"><button>Add as read</button></form></div></li>`).join('');
  const aCards = (r.authors ?? []).map((a) => `<li class="card">${img(null, a.cover_url, a.name, a.name)}<div><h3>${esc(a.name)}</h3>
      <p class="meta">${a.books_count ? `${a.books_count} books` : 'Author'}</p>
      ${followedAuthors.has(a.hardcover_author_id) ? `<p><a class="badge" href="#/author/${a.hardcover_author_id}">Following</a></p>` : `
      <form class="inline" data-form="follow-author">
        <input type="hidden" name="hardcover_author_id" value="${a.hardcover_author_id}"><input type="hidden" name="name" value="${esc(a.name)}">
        <input type="hidden" name="cover_url" value="${esc(a.cover_url ?? '')}"><button class="primary">Follow author</button></form>`}</div></li>`).join('');
  return `${aCards ? `<h2>Authors</h2><ul class="cards">${aCards}</ul>` : ''}<h2>Series</h2>${r.series.length ? `<ul class="cards">${sCards}</ul>` : '<p>No series found.</p>'}
    <h2>Books</h2>${r.books.length ? `<ul class="cards">${bCards}</ul>` : '<p>No books found.</p>'}
    <p>Can't find it? <a href="#/manual">Add it by hand</a>.</p>`;
}

async function runSearch(q) {
  const mine = ++searchSeq;
  q = q.trim();
  const out = document.getElementById('results');
  if (!q) { out.innerHTML = ''; return; }
  out.setAttribute('aria-busy', 'true');
  let r;
  try { r = { q, ...(await client.search(q)), error: null }; } catch (e) { r = { q, series: [], books: [], authors: [], error: msg(e) }; }
  if (mine !== searchSeq) return;                          // a newer search superseded this one
  const followed = new Set((await store.all('series')).map((s) => s.hardcover_series_id));
  const followedAuthors = new Set((await store.all('author')).map((a) => a.hardcover_author_id));
  out.innerHTML = resultsHtml(r, followed, followedAuthors); out.removeAttribute('aria-busy');
  history.replaceState(null, '', '#/search?q=' + encodeURIComponent(q));
  hydrateCovers(out);
}

async function viewSearch(params) {
  const q = params.get('q') ?? '';
  afterRender = () => {
    const input = document.getElementById('q'); let t;
    input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => runSearch(input.value), 300); });   // debounce
    if (q) runSearch(q);
  };
  return `<h1>Search</h1>
    <form role="search" class="inline" data-form="search"><label class="sr" for="q">Title, author, series or ISBN</label>
      <input id="q" type="search" name="q" value="${esc(q)}" placeholder="Title, author, series or ISBN" enterkeyhint="search" autocomplete="off">
      <button class="primary">Search</button></form>
    <div id="results" aria-live="polite"></div>`;
}

async function viewUpdates() {
  const list = (await updates(store)).sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '')).slice(0, 100);
  const unseen = list.filter((n) => !n.seen_at).length;
  return `<h1>Updates</h1>
    ${unseen ? '<p><button data-click="mark-seen">Mark all seen</button></p>' : ''}
    ${list.length ? `<ul class="cards">${list.map((n) => `<li class="card ${n.seen_at ? '' : 'unseen'}">
        ${img(n.author_id != null ? null : (n.cover_key ?? `sb-${n.series_id}-${n.position}`), n.author_id != null ? n.cover_url : null, n.title ?? '', n.series_name)}
        <div><h3><a href="#/${n.author_id != null ? 'author/' + n.author_id : 'series/' + n.series_id}">${esc(n.series_name)}</a>${n.author_id != null ? ' <span class="badge">Author</span>' : ''}</h3>
        <p><strong>${n.position != null ? '#' + pos(n.position) + ' ' : ''}${esc(n.title)}</strong></p>
        <p class="meta">${LABEL[n.kind]} · ${n.kind === 'date_changed' ? `${esc(n.detail ?? 'TBA')} → ${esc(n.release_date ?? 'TBA')}` : esc(n.release_date ?? 'date TBA')}</p></div></li>`).join('')}</ul>`
      : '<p>Nothing yet. New announcements, date changes and releases for series you follow show up here after a check.</p>'}`;
}

async function viewManual() {
  return `<h1>Add a book by hand</h1>
    <p class="meta">Use this when search finds nothing. The app tries one Hardcover match; otherwise the book waits under Needs review.</p>
    <form class="stack" data-form="manual">
      <label>Title <input type="text" name="title" required></label>
      <label>Author <input type="text" name="author"></label>
      <label>Series name <input type="text" name="series_name"></label>
      <label>Position in series <input type="text" name="position" inputmode="decimal" placeholder="e.g. 3 or 2.5"></label>
      <label>ISBN <input type="text" name="isbn" inputmode="numeric"></label>
      <label><span><input type="checkbox" name="read" checked> I've read it</span></label>
      <button class="primary">Save</button></form>`;
}

async function viewReview(params) {
  const active = Number(params.get('book') ?? 0), q = params.get('q') ?? '';
  let cands = [], error = null;
  if (active && q.trim()) { try { cands = await client.searchSeries(q.trim()); } catch (e) { error = msg(e); } }
  const groups = await reviewGroups(store);
  return `<h1>Needs review</h1>${groups.length ? '' : '<p>Everything is matched. Nothing to review.</p>'}
    ${groups.map((g) => `<section class="panel"><h2>${esc(g.lead.series_name_raw ?? g.lead.title)} <small>${esc(g.lead.author ?? '')} · ${esc(g.lead.source)}</small></h2>
      <ul>${g.books.map((b) => `<li>${b.series_position != null ? '#' + pos(b.series_position) + ' ' : ''}${esc(b.title)}</li>`).join('')}</ul>
      <form class="inline" data-form="review-search"><input type="hidden" name="book" value="${g.lead.id}">
        <label class="sr" for="rq${g.lead.id}">Search Hardcover series</label>
        <input id="rq${g.lead.id}" type="search" name="q" value="${esc(active === g.lead.id ? q : (g.lead.series_name_raw ?? g.lead.title))}">
        <button>Find series</button></form>
      ${active === g.lead.id ? `${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}${!cands.length && !error ? '<p>No series found for that search.</p>' : ''}
        ${cands.map((c) => `<p class="inline"><span>${esc(c.name)} <small>${esc(c.author ?? '')}</small></span>
          <button class="primary" data-click="assign" data-id="${g.lead.id}" data-hc="${c.hardcover_series_id}" data-name="${esc(c.name)}" data-author="${esc(c.author ?? '')}">Use this series</button></p>`).join('')}` : ''}
      <p><button data-click="ignore" data-id="${g.lead.id}">Ignore</button></p></section>`).join('')}`;
}

async function viewMore() {
  const hasToken = Boolean(await getSetting(store, 'hc_token', ''));
  const last = await getSetting(store, 'last_check', null);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const canNotify = 'Notification' in window && 'serviceWorker' in navigator;
  return `<h1>More</h1>
    <section class="panel"><h2>Theme</h2><div class="seg" role="group" aria-label="Theme">
      ${THEMES.map((t) => `<button data-click="theme" data-value="${t}" aria-pressed="${theme === t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div></section>

    <section class="panel"><h2>Hardcover token</h2>
      <p class="meta">${hasToken ? 'A token is saved on this phone.' : 'Needed for matching, search and checks.'} It is stored only on this device and sent only to Hardcover. Tokens expire; paste a new one if you see “rejected”.</p>
      <form class="stack" data-form="token"><label>API token <input type="password" name="token" autocomplete="off" placeholder="${hasToken ? '•••••••• (saved)' : 'paste token'}"></label>
        <div class="inline"><button class="primary">Save token</button>${hasToken ? '<button type="button" class="danger" data-click="remove-token">Remove</button>' : ''}</div></form></section>

    <section class="panel"><h2>Import</h2>
      <form class="stack" data-form="import-gr"><label>Goodreads export (goodreads_library_export.csv)<input type="file" name="file" accept=".csv,text/csv"></label>
        <button class="primary">Import Goodreads CSV</button></form>
      <p><button data-click="import-hc">Import from Hardcover</button></p>
      <p class="meta">Imports can take a few minutes: Hardcover allows 60 requests a minute.</p></section>

    <section class="panel"><h2>Checking</h2>
      <p class="meta">${last ? 'Last checked ' + esc(last) : 'Not checked yet'}. The app checks when you open it (at most every 12 hours).</p>
      <p><button class="primary" data-click="check-now">Check now</button></p>
      ${canNotify ? `<p><button data-click="enable-alerts">Enable background alerts</button></p>
        <p class="meta">Android Chrome only, and only for the installed app; the browser decides when it runs. iPhone can't do this — open the app to check.</p>` : ''}</section>

    <section class="panel"><h2>Needs review &amp; manual</h2><p><a href="#/review">Needs review</a> · <a href="#/manual">Add a book by hand</a></p></section>

    <section class="panel"><h2>Backup</h2>
      <p class="meta">Your data lives only on this phone. Export a backup now and then (it does not include your token).</p>
      <p><button data-click="export">Export backup</button></p>
      <form class="stack" data-form="restore"><label>Restore from backup<input type="file" name="file" accept=".json,application/json"></label><button>Restore</button></form></section>

    <section class="panel"><h2>Hardcover fields</h2>
      <p class="meta">The app's Hardcover queries were written from the public docs. This compares them with the live schema.</p>
      <p><button data-click="verify">Verify Hardcover fields</button></p><pre class="out" id="verify-out"></pre></section>

    ${standalone ? '' : `<section class="panel"><h2>Install</h2><p class="meta">Android: browser menu → Install app / Add to Home screen. iPhone: Share → Add to Home Screen (needed so iOS keeps your data).</p>
      ${installPrompt ? '<p><button data-click="install">Install app</button></p>' : ''}</section>`}`;
}

// ---- router -----------------------------------------------------------------------------------
async function route() {
  const [path, qs = ''] = location.hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(qs);
  const [, seg, arg] = path.split('/');
  const tab = { '': 'home', series: 'home', search: 'search', updates: 'updates', book: 'home', author: 'home' }[seg ?? ''] ?? 'more';
  let html;
  try {
    html = await ({ '': viewHome, series: () => viewSeries(arg), book: () => viewBook(arg, path.split('/')[3]), author: () => viewAuthor(arg), search: () => viewSearch(params), updates: viewUpdates,
      manual: viewManual, review: () => viewReview(params), more: viewMore }[seg ?? ''] ?? viewHome)();
  } catch (e) { html = `<p class="error">${esc(msg(e))}</p>`; }
  $app.innerHTML = html;
  const bind = afterRender; afterRender = null;
  bind?.();
  document.querySelectorAll('.tabs a').forEach((a) => (a.dataset.tab === tab ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  hydrateCovers();
  refreshBadge();
}
async function refreshBadge() {
  const n = (await pendingEvents(store)).length, b = document.getElementById('updates-badge');
  b.hidden = !n; b.textContent = n;
}

// ---- actions ----------------------------------------------------------------------------------
const report = (r, what) => `${what}: ${r.books_imported} new books, ${r.series_followed} series matched, ${r.needs_review} to review.` + (r.errors.length ? ' Problem: ' + r.errors[0] : '');
const needToken = async () => { if (await getSetting(store, 'hc_token', '')) return false; toast('Add your Hardcover token first (More → Hardcover token).', { error: true }); return true; };

async function checkNow({ silent = false } = {}) {
  if (checking) return;
  if (!(await getSetting(store, 'hc_token', ''))) { if (!silent) await needToken(); return; }
  checking = true; toast('Checking for new books…', { ms: 0 });
  try {
    const res = await runCheck(store, client, { covers });
    await setSetting(store, 'last_check', nowIso());
    if (res.errors.length) toast(res.errors[0], { error: true });
    else toast(res.events.length ? `${res.events.length} new update${res.events.length > 1 ? 's' : ''}.` : 'Nothing new.');
  } catch (e) { toast(msg(e), { error: true }); }
  checking = false; await route();
}

const clickActions = {
  async mute(el) { const s = await store.get('series', Number(el.dataset.id)); await store.put('series', { ...s, muted: s.muted ? 0 : 1 }); await route(); },
  async theme(el) { await setTheme(el.dataset.value); await route(); },
  async 'mark-seen'() { await markAllSeen(store); toast('All caught up.'); await route(); },
  async 'check-now'() { await checkNow(); },
  async 'remove-token'() { await store.delete('settings', 'hc_token'); toast('Token removed.'); await route(); },
  async 'import-hc'() {
    if (await needToken()) return;
    toast('Importing from Hardcover…', { ms: 0 });
    toast(report(await importHardcover(store, client, covers), 'Hardcover import')); location.hash = '#/';
  },
  async assign(el) {
    await assignGroup(store, client, Number(el.dataset.id), { hardcover_series_id: Number(el.dataset.hc), name: el.dataset.name, author: el.dataset.author || null }, covers);
    location.hash = '#/review'; await route();
  },
  async 'read-to'(el) { await setProgress(store, Number(el.dataset.id), Number(el.dataset.pos)); await route(); },
  async remove(el) {
    if (!confirm(`Stop following “${el.dataset.name}”? Its progress and updates are deleted.`)) return;
    await removeSeries(store, Number(el.dataset.id));
    if (el.dataset.home) location.hash = '#/';
    toast('Removed.'); await route();
  },
  async 'mute-author'(el) { const a = await store.get('author', Number(el.dataset.id)); await store.put('author', { ...a, muted: a.muted ? 0 : 1 }); await route(); },
  async 'remove-author'(el) {
    if (!confirm(`Stop following ${el.dataset.name}? Their updates are deleted.`)) return;
    await removeAuthor(store, Number(el.dataset.id)); toast('Removed.'); location.hash = '#/'; await route();
  },
  async 'read-none'(el) { await setProgress(store, Number(el.dataset.id), 0); await route(); },
  async 'read-all'(el) {
    const sid = Number(el.dataset.id), p = await lastReleased(store, sid, nowIso().slice(0, 10));
    if (!p) return toast('No released books to mark.');
    await setProgress(store, sid, Math.max(p, await maxRead(store, sid))); await route();
  },
  async ignore(el) { await ignoreGroup(store, Number(el.dataset.id)); await route(); },
  async export() {
    const dump = { app: 'series-tracker', version: 1, exported_at: nowIso(), tables: {} };
    for (const t of Object.keys(KEYS)) if (t !== 'covers') dump.tables[t] = (await store.all(t)).filter((r) => !(t === 'settings' && r.key === 'hc_token'));
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify(dump)], { type: 'application/json' })), download: `series-tracker-${nowIso().slice(0, 10)}.json` });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  async verify() {
    if (await needToken()) return;
    const out = document.getElementById('verify-out'); out.textContent = 'Checking…';
    const r = await client.verifyFields();
    const bad = Object.entries(r).filter(([, m]) => m.length);
    out.textContent = bad.length ? 'Missing fields:\n' + bad.map(([t, m]) => `${t}: ${m.join(', ')}`).join('\n') : 'All expected fields exist.';
  },
  async 'enable-alerts'() {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return toast('Notifications were not allowed.', { error: true });
    const reg = await navigator.serviceWorker.ready;
    if (!reg.periodicSync) return toast('This browser has no background sync; open the app to check.', { error: true });
    try { await reg.periodicSync.register('check-series', { minInterval: CHECK_EVERY_MS }); toast('Background alerts requested. The browser decides when to run them.'); }
    catch { toast('Background sync was not allowed. Install the app to the home screen first.', { error: true }); }
  },
  async install() { installPrompt?.prompt(); installPrompt = null; await route(); },
};

const formActions = {
  async search(fd) { await runSearch(fd.get('q') ?? ''); },
  async follow(fd) {
    const sid = await followSeries(store, client, { hardcover_series_id: Number(fd.get('hardcover_series_id')), name: fd.get('name'),
      author: fd.get('author') || null, cover_url: fd.get('cover_url') || null, complete: Boolean(fd.get('complete')) },
      Math.max(0, parseInt(fd.get('read_up_to'), 10) || 0), covers);
    location.hash = `#/series/${sid}`;
  },
  async 'follow-author'(fd) {
    const aid = await followAuthor(store, client, { hardcover_author_id: Number(fd.get('hardcover_author_id')), name: fd.get('name'), cover_url: fd.get('cover_url') || null });
    toast(`Following ${fd.get('name')}. New books by them will show in Updates.`); location.hash = `#/author/${aid}`;
  },
  async 'add-book'(fd) {
    const r = await addSearchBook(store, client, { hardcover_book_id: Number(fd.get('hardcover_book_id')), title: fd.get('title'),
      author: fd.get('author'), cover_url: fd.get('cover_url'), isbn13: fd.get('isbn13') }, covers);
    toast(r.duplicate ? `“${fd.get('title')}” is already in your history.` : `Added “${fd.get('title')}”${r.series ? ` and following ${r.series}` : ''}.`);
    location.hash = '#/';
  },
  async manual(fd) {
    const title = (fd.get('title') ?? '').trim();
    if (!title) return toast('A title is required.', { error: true });
    const p = String(fd.get('position') ?? '').trim();
    if (p && !Number.isFinite(parseFloat(p))) return toast('Position must be a number, e.g. 3 or 2.5.', { error: true });
    const ok = await addManualBook(store, client, { title, author: fd.get('author'), series_name: fd.get('series_name'), position: p, isbn: fd.get('isbn'), read: Boolean(fd.get('read')) }, covers);
    toast(`Saved “${title}”.` + (ok ? '' : ' No Hardcover match yet — see Needs review.')); location.hash = '#/';
  },
  async 'review-search'(fd) { location.hash = `#/review?book=${fd.get('book')}&q=${encodeURIComponent(fd.get('q') ?? '')}`; },
  async token(fd) {
    const t = (fd.get('token') ?? '').trim();
    if (!t) return toast('Paste your token first.', { error: true });
    await setSetting(store, 'hc_token', t); toast('Token saved on this phone.'); await route();
  },
  async 'import-gr'(fd) {
    const file = fd.get('file');
    if (!file?.size) return toast('Choose your Goodreads CSV first.', { error: true });
    const text = await file.text();
    if (!(text.split(/\r?\n/, 1)[0] ?? '').includes('Title')) return toast("That doesn't look like a Goodreads library export (no Title column).", { error: true });
    if (await needToken()) return;
    toast('Importing… this can take a few minutes.', { ms: 0 });
    toast(report(await importGoodreads(store, text, client, covers), 'Goodreads import')); location.hash = '#/';
  },
  async restore(fd) {
    const file = fd.get('file');
    if (!file?.size) return toast('Choose a backup file first.', { error: true });
    let dump;
    try { dump = JSON.parse(await file.text()); } catch { return toast('That is not a valid backup file.', { error: true }); }
    if (dump.app !== 'series-tracker' || !dump.tables) return toast('That is not a Series Tracker backup.', { error: true });
    if (!confirm('Replace everything on this phone with the backup?')) return;
    const token = await store.get('settings', 'hc_token');
    for (const t of Object.keys(KEYS)) if (t !== 'covers') { await store.clear(t); for (const r of dump.tables[t] ?? []) await store.put(t, r); }
    if (token) await store.put('settings', token);
    theme = await getSetting(store, 'theme', 'system'); applyTheme(theme);
    toast('Backup restored.'); location.hash = '#/'; await route();
  },
};

// Run an action with its button disabled and any error shown as a message.
async function guarded(btn, fn) {
  btn?.setAttribute('disabled', ''); 
  try { await fn(); } catch (e) { toast(msg(e), { error: true }); } finally { btn?.removeAttribute('disabled'); }
}
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-click]');
  if (el) { e.preventDefault(); guarded(el, () => clickActions[el.dataset.click](el)); }
});
document.addEventListener('submit', (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  guarded(f.querySelector('button:not([type=button])'), () => formActions[f.dataset.form](new FormData(f), f));
});
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });
window.addEventListener('hashchange', route);

// ---- boot -----------------------------------------------------------------------------------------
async function main() {
  store = await openIdbStore();
  covers = new CoverCache(store);
  client = new HardcoverClient({ getToken: () => getSetting(store, 'hc_token', '') });
  theme = await getSetting(store, 'theme', 'system'); applyTheme(theme);
  try { await navigator.storage?.persist?.(); } catch { /* optional */ }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { type: 'module' }).catch(() => {});
  await route();
  const last = await getSetting(store, 'last_check', null);
  if (!last || Date.now() - Date.parse(last) > CHECK_EVERY_MS) checkNow({ silent: true });
}
main().catch((e) => { $app.innerHTML = `<p class="error">Could not open local storage: ${esc(e?.message ?? e)}. Private browsing can block it.</p>`; });
