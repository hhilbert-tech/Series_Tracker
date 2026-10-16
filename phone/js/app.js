// UI: hash-routed, mobile-first. All data lives in this browser (IndexedDB); nothing is sent anywhere
// except requests to Hardcover (and cover images) made directly from the phone.
import { openIdbStore } from './store-idb.js';
import { HardcoverClient, HardcoverError } from './hardcover.js';
import { CoverCache, placeholderUri } from './covers.js';
import { getSetting, setSetting, todayIso, sbKey, notifying, maxRead, setProgress, removeSeries, unremoveSeries, lastReleased, nowIso } from './db.js';
import { followAuthor, removeAuthor, refreshAuthorMeta } from './authors.js';
import { fmtDate, when } from './format.js';
import { buildRecs, loadRecs, dismissRec, recsStale } from './recs.js';
import { runCheck, updates, pendingEvents, markAllSeen, dismissUpdate, dismissAllUpdates } from './check.js';
import { importGoodreads, importHardcover, followSeries, addManualBook, addSearchBook, reviewGroups, assignGroup, ignoreGroup } from './importer.js';
import { KEYS } from './store-base.js';

const THEMES = ['system', 'light', 'dark'];
const LABEL = { announced: 'New book', date_changed: 'Date changed', released: 'Now out' };
const CHECK_EVERY_MS = 12 * 3600 * 1000;
const $app = document.getElementById('app');
let store, covers, client, theme = 'system', checking = false, searchSeq = 0, installPrompt = null, afterRender = null;
const failedCovers = new Set();
const objectUrls = new Map();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pos = (p) => (p == null ? '' : String(Number(p)));
// Position of the book before `p` (0 if none): what "Undo" falls back to.
const prevPos = (books, p) => Math.max(0, ...books.map((r) => r.position).filter((x) => x < p));
const notifyBtn = (sid, b, read) => { const on = notifying(b, read);
  return `<button class="small notify" aria-pressed="${on}" data-click="notify" data-id="${sid}" data-pos="${b.position}">${on ? '🔔 Notifying' : 'Notify me'}</button>`; };
const chip = (w, extra = '') => `<span class="chip ${w.tone} ${extra}">${esc(w.text)}</span>`;
const menu = (label, items) => `<details class="menu"><summary aria-label="Actions for ${esc(label)}">⋯</summary><div class="menu-items">${items}</div></details>`;
function progress(series_books, read) {
  const whole = series_books.filter((r) => Number.isInteger(r.position));
  return { total: whole.length, read: whole.filter((r) => r.position <= read).length };
}
const progressHtml = (p) => (p.total ? `<div class="progress"><div class="bar" role="img" aria-label="${p.read} of ${p.total} read"><i style="width:${Math.round(100 * p.read / p.total)}%"></i></div><span class="meta">${p.read} of ${p.total} read</span></div>` : '');
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
function seriesCard(s, read, next, prog) {
  const w = next ? when(next.release_date) : null;
  return `<li class="card ${s.muted ? 'is-muted' : ''}">
    <a class="cardlink" href="#/series/${s.id}">
      ${img(s.cover_key ?? `series-${s.id}`, s.cover_key ? '' : s.cover_url, s.name, s.name)}
      <div class="body">
        <h2>${esc(s.name)}${s.muted ? ' <span class="badge">Muted</span>' : ''}</h2>
        <p class="meta">${esc(s.author ?? 'Unknown author')}</p>
        ${progressHtml(prog)}
        ${next ? `<p class="next">Next: <strong>#${pos(next.position)} ${esc(next.title)}</strong></p><p>${chip(w)} <span class="meta">${w.tone === 'tba' ? '' : esc(fmtDate(next.release_date))}</span></p>`
          : `<p class="meta">${s.last_checked_at ? 'No unread book announced yet' : 'Not checked yet'}</p>`}
      </div></a>
    ${menu(s.name, `<button data-click="mute" data-id="${s.id}">${s.muted ? 'Unmute' : 'Mute'}</button>
      <button class="danger" data-click="remove" data-id="${s.id}" data-name="${esc(s.name)}">Remove</button>`)}</li>`;
}

async function viewFollowing() {
  const series = (await store.all('series')).sort((a, b) => a.muted - b.muted || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const sbs = await store.all('series_book');
  const authors = (await store.all('author')).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const cards = [];
  for (const s of series) {
    const read = await maxRead(store, s.id), mine = sbs.filter((r) => r.series_id === s.id);
    const next = mine.filter((r) => Number.isInteger(r.position) && r.position > read).sort((a, b) => a.position - b.position)[0];
    cards.push(seriesCard(s, read, next, progress(mine, read)));
  }
  const muted = series.filter((s) => s.muted).length;
  const unseen = (await pendingEvents(store)).length;
  const hasToken = Boolean(await getSetting(store, 'hc_token', ''));
  return `<div class="pagehead"><h1>Following</h1><span class="meta">${series.length - muted} series${muted ? ` · ${muted} muted` : ''}${authors.length ? ` · ${authors.length} author${authors.length > 1 ? 's' : ''}` : ''}</span></div>
    ${hasToken && series.length ? '<p><button class="small" data-click="sync-hc">Sync reading progress from Hardcover</button></p>' : ''}
    ${unseen ? `<a class="flash" href="#/updates"><span class="badge fill">${unseen}</span> new update${unseen > 1 ? 's' : ''} — see what's new</a>` : ''}
    ${series.length ? `<ul class="cards">${cards.join('')}</ul>`
      : `<p>Nothing followed yet.</p><p><a class="btn" href="#/more">Import your reading history</a> or <a href="#/search">search for a series</a>.</p>`}
    ${authors.length ? `<h2 class="label">Authors</h2><ul class="cards">${authors.map((a) => `<li class="card ${a.muted ? 'is-muted' : ''}">
      <a class="cardlink" href="#/author/${a.hardcover_author_id}">${img(null, a.cover_url, a.name, a.name)}
        <div class="body"><h2>${esc(a.name)}${a.muted ? ' <span class="badge">Muted</span>' : ''}</h2>
        <p class="meta">New books show up in Updates</p></div></a>
      ${menu(a.name, `<button data-click="mute-author" data-id="${a.hardcover_author_id}">${a.muted ? 'Unmute' : 'Mute'}</button>
        <button class="danger" data-click="remove-author" data-id="${a.hardcover_author_id}" data-name="${esc(a.name)}">Remove</button>`)}</li>`).join('')}</ul>` : ''}`;
}

async function viewSeries(id) {
  const s = await store.get('series', Number(id));
  if (!s) return '<p>No such series. <a href="#/following">Back</a></p>';
  const read = await maxRead(store, s.id), today = todayIso();
  const books = (await store.all('series_book')).filter((r) => r.series_id === s.id).sort((a, b) => a.position - b.position);
  return `<p><a class="back" href="#/following">← Following</a></p>
    <div class="hero">
      ${img(s.cover_key ?? `series-${s.id}`, s.cover_key ? '' : s.cover_url, s.name, s.name, 'cover big')}
      <div class="body"><h1>${esc(s.name)}${s.muted ? ' <span class="badge">Muted</span>' : ''}</h1>
        <p class="meta">${esc(s.author ?? 'Unknown author')}${s.author ? ` · <a href="#/search?q=${encodeURIComponent(s.author)}">follow author</a>` : ''}${s.complete ? ' · complete' : ''}</p>
        ${progressHtml(progress(books, read))}
        <p class="meta">${s.last_checked_at ? 'Checked ' + esc(s.last_checked_at.slice(0, 10)) : 'Not checked yet'}</p></div></div>
    <div class="actions"><button class="primary" data-click="read-all" data-id="${s.id}">Mark all released as read</button>
      ${menu(s.name, `<button data-click="mute" data-id="${s.id}">${s.muted ? 'Unmute' : 'Mute'}</button>
        ${read ? `<button data-click="read-none" data-id="${s.id}">Reset progress</button>` : ''}
        <button class="danger" data-click="remove" data-id="${s.id}" data-name="${esc(s.name)}" data-home="1">Remove</button>`)}</div>
    ${books.length ? `<ul class="rows">${books.map((b) => {
      const isRead = b.position <= read, w = when(b.release_date, today);
      const unreleased = w.tone !== 'ok';
      const btn = isRead
        ? (b.position === read ? `<button class="small" data-click="read-to" data-id="${s.id}" data-pos="${prevPos(books, b.position)}">Undo</button>` : '')
        : unreleased ? notifyBtn(s.id, b, read)
        : `<button class="small" data-click="read-to" data-id="${s.id}" data-pos="${b.position}">Read to here</button>`;
      return `<li class="${isRead ? 'read' : ''}">
        ${img(b.cover_key ?? `sb-${s.id}-${b.position}`, b.cover_key ? '' : b.cover_url, b.title, s.name, 'cover small')}
        <div class="grow"><a class="booklink" href="#/book/${s.id}/${b.position}"><span class="num">#${pos(b.position)}</span> ${esc(b.title)}</a><br>
          ${isRead ? '<span class="chip read">✓ Read</span>' : chip(w)} <span class="meta">${w.tone === 'tba' ? '' : esc(fmtDate(b.release_date))}</span></div>${btn}</li>`;
    }).join('')}</ul>` : '<p>No books fetched yet. Use “Check now” in More.</p>'}`;
}

async function viewBook(sid, position) {
  sid = Number(sid); position = Number(position);
  const s = await store.get('series', sid), b = await store.get('series_book', sbKey(sid, position));
  if (!s || !b) return '<p>No such book. <a href="#/following">Back</a></p>';
  const read = await maxRead(store, sid), isRead = b.position <= read, w = when(b.release_date);
  const all = (await store.all('series_book')).filter((r) => r.series_id === sid);
  const btn = isRead
    ? (b.position === read ? `<button data-click="read-to" data-id="${sid}" data-pos="${prevPos(all, b.position)}">Undo read</button>` : '')
    : w.tone !== 'ok' ? notifyBtn(sid, b, read)
    : `<button class="primary" data-click="read-to" data-id="${sid}" data-pos="${b.position}">Read up to here</button>`;
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
  return `<p><a class="back" href="#/series/${sid}">← ${esc(s.name)}</a></p>
    <div class="hero">
      ${img(b.cover_key ?? `sb-${sid}-${b.position}`, b.cover_key ? '' : b.cover_url, b.title, s.name, 'cover big')}
      <div class="body"><h1>${esc(b.title)}</h1>
        <p class="meta">${esc(s.author ?? 'Unknown author')}${s.author ? ` · <a href="#/search?q=${encodeURIComponent(s.author)}">follow author</a>` : ''}</p>
        <p class="meta">${esc(s.name)} · #${pos(b.position)}</p>
        <p>${isRead ? '<span class="chip read">✓ Read</span> ' : ''}${chip(w)} <span class="meta">${w.tone === 'tba' ? '' : esc(fmtDate(b.release_date))}</span></p></div></div>
    ${btn ? `<div class="actions">${btn}</div>` : ''}
    <div id="book-more"><p class="meta">Loading details…</p></div>`;
}

async function viewAuthor(id) {
  const a = await store.get('author', Number(id));
  if (!a) return '<p>No such author. <a href="#/following">Back</a></p>';
  const today = todayIso();
  const books = (await store.all('author_book')).filter((r) => r.author_id === a.hardcover_author_id);
  if (books.some((r) => r.series_id === undefined)) {            // stored before series info existed: fill it in quietly, then redraw
    afterRender = async () => { try { if (await refreshAuthorMeta(store, client, a.hardcover_author_id) && location.hash === `#/author/${a.hardcover_author_id}`) await route(); } catch { /* shown as-is */ } };
  }
  const followed = new Map((await store.all('series')).map((s) => [s.hardcover_series_id, s]));
  const isUp = (b) => !b.release_date || b.release_date.slice(0, 10) > today;
  // one group per series (a slot held by several rows, e.g. translations, shows once), then standalone books
  const slots = new Map(), groups = new Map(), stand = [];
  for (const b of books) {
    if (b.series_id == null || b.series_position == null) { (b.series_id == null ? stand : (groups.get(b.series_id) ?? groups.set(b.series_id, { id: b.series_id, name: b.series_name, books: [] }).get(b.series_id)).books).push(b); continue; }
    const k = `${b.series_id}:${b.series_position}`;
    if (!slots.has(k) || (b.users_count ?? 0) > (slots.get(k).users_count ?? 0)) slots.set(k, b);
  }
  for (const b of slots.values()) (groups.get(b.series_id) ?? groups.set(b.series_id, { id: b.series_id, name: b.series_name, books: [] }).get(b.series_id)).books.push(b);
  const newest = (g) => g.books.map((b) => b.release_date ?? '9999').sort().pop();
  const list = [...groups.values()].sort((x, y) => (+y.books.some(isUp) - +x.books.some(isUp)) || newest(y).localeCompare(newest(x)) || (x.name ?? '').localeCompare(y.name ?? ''));
  const row = (b, withPos) => { const w = when(b.release_date, today); return `<li>${img(null, b.cover_url, b.title, a.name, 'cover small')}
    <div class="grow"><strong>${withPos && b.series_position != null ? `<span class="num">#${pos(b.series_position)}</span> ` : ''}${esc(b.title)}</strong><br>${chip(w)} <span class="meta">${w.tone === 'tba' ? '' : esc(fmtDate(b.release_date, today))}</span></div></li>`; };
  const section = (g) => {
    const mine = followed.get(g.id), cover = g.books.find((b) => b.cover_url)?.cover_url ?? '';
    g.books.sort((x, y) => (x.series_position ?? 1e9) - (y.series_position ?? 1e9));
    return `<div class="grouphead"><h2 class="label">${mine ? `<a href="#/series/${mine.id}">${esc(g.name)}</a>` : esc(g.name)} <span class="meta">· ${g.books.length} book${g.books.length > 1 ? 's' : ''}</span></h2>
      ${mine ? '<span class="badge">Following</span>' : `<button class="small" data-click="rec-follow" data-hc="${g.id}" data-name="${esc(g.name)}" data-author="${esc(a.name)}" data-cover="${esc(cover)}">Follow series</button>`}</div>
      <ul class="rows">${g.books.map((b) => row(b, true)).join('')}</ul>`;
  };
  stand.sort((x, y) => (y.release_date ?? '9999').localeCompare(x.release_date ?? '9999'));
  return `<p><a class="back" href="#/following">← Following</a></p>
    <div class="hero">${img(null, a.cover_url, a.name, a.name, 'cover big')}
      <div class="body"><h1>${esc(a.name)}${a.muted ? ' <span class="badge">Muted</span>' : ''}</h1>
        <p class="meta">${books.length ? `${list.length} series · ${stand.length} standalone` : 'No books listed'} · ${a.last_checked_at ? 'checked ' + esc(a.last_checked_at.slice(0, 10)) : 'not checked yet'}</p></div></div>
    <div class="actions">${menu(a.name, `<button data-click="mute-author" data-id="${a.hardcover_author_id}">${a.muted ? 'Unmute' : 'Mute'}</button>
      <button class="danger" data-click="remove-author" data-id="${a.hardcover_author_id}" data-name="${esc(a.name)}">Remove</button>`)}</div>
    ${list.map(section).join('')}
    ${stand.length ? `<div class="grouphead"><h2 class="label">Standalone &amp; other</h2></div><ul class="rows">${stand.map((b) => row(b, false)).join('')}</ul>` : ''}`;
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
    // Wait for a pause in typing (and 3+ characters): Hardcover allows ~60 requests a minute. Enter/Search runs it at once.
    input.addEventListener('input', () => { clearTimeout(t); if (input.value.trim().length < 3) return; t = setTimeout(() => runSearch(input.value), 1000); });
    if (q) runSearch(q);
  };
  return `<h1>Search</h1>
    <form role="search" class="inline" data-form="search"><label class="sr" for="q">Title, author, series or ISBN</label>
      <input id="q" type="search" name="q" value="${esc(q)}" placeholder="Title, author, series or ISBN" enterkeyhint="search" autocomplete="off">
      <button class="primary">Search</button></form>
    <div id="results" aria-live="polite"></div>`;
}

// Dated releases from followed series (not muted) and authors, from 30 days ago onward, minus read/dismissed ones.
async function collectUpcoming(today) {
  const ago = new Date(Date.now() - 30 * 864e5), cutoff = `${ago.getFullYear()}-${String(ago.getMonth() + 1).padStart(2, '0')}-${String(ago.getDate()).padStart(2, '0')}`;
  const series = new Map((await store.all('series')).map((s) => [s.id, s]));
  const authors = new Map((await store.all('author')).map((a) => [a.hardcover_author_id, a]));
  const sbs = (await store.all('series_book')).filter((r) => series.get(r.series_id) && !series.get(r.series_id).muted);
  const inSeries = new Set(sbs.map((r) => r.hardcover_book_id));
  const items = [], readOf = new Map();
  for (const id of series.keys()) readOf.set(id, await maxRead(store, id));
  for (const r of sbs) {
    if (!r.release_date || r.release_date.slice(0, 10) < cutoff || r.dismissed) continue;
    const s = series.get(r.series_id), out = r.release_date.slice(0, 10) <= today;
    if (out && r.position <= readOf.get(r.series_id)) continue;                 // released and already read: nothing to do
    items.push({ date: r.release_date.slice(0, 10), title: `#${pos(r.position)} ${r.title}`, sub: s.name, href: `#/book/${r.series_id}/${r.position}`,
      ck: r.cover_key ?? `sb-${r.series_id}-${r.position}`, fb: r.cover_key ? '' : r.cover_url, seed: s.name,
      actions: out ? `<button class="small" data-click="read-to" data-id="${r.series_id}" data-pos="${r.position}">Mark read</button>
        <button class="small" data-click="dismiss" data-kind="series" data-id="${r.series_id}" data-pos="${r.position}">Dismiss</button>` : '' });
  }
  for (const r of await store.all('author_book')) {
    const a = authors.get(r.author_id);
    if (!a || a.muted || inSeries.has(r.hardcover_book_id) || !r.release_date || r.release_date.slice(0, 10) < cutoff || r.dismissed) continue;
    items.push({ date: r.release_date.slice(0, 10), title: r.title, sub: `${a.name} · author`, href: `#/author/${a.hardcover_author_id}`, ck: null, fb: r.cover_url, seed: a.name,
      actions: r.release_date.slice(0, 10) <= today ? `<button class="small" data-click="dismiss" data-kind="author" data-id="${r.author_id}" data-bid="${r.hardcover_book_id}">Dismiss</button>` : '' });
  }
  items.sort((x, y) => x.date.localeCompare(y.date) || x.title.localeCompare(y.title));
  return { items, undated: sbs.filter((r) => !r.release_date).length };
}
function upcomingRow(it, today) {
  const w = when(it.date, today);
  return `<li>${img(it.ck, it.fb, it.title, it.seed, 'cover small')}<div class="grow"><a class="booklink" href="${it.href}">${esc(it.title)}</a><br>
    <span class="meta">${esc(it.sub)}</span><br>${chip(w)} <span class="meta">${esc(fmtDate(it.date, today))}</span>
    ${it.actions ? `<div class="row-actions">${it.actions}</div>` : ''}</div></li>`;
}

async function viewUpcoming() {
  const today = todayIso();
  const { items, undated } = await collectUpcoming(today);
  const monthOf = (d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const groups = [];
  for (const it of items) {
    const label = it.date <= today ? 'Out in the last 30 days' : monthOf(it.date);
    const g = groups.find((x) => x.label === label) ?? groups[groups.push({ label, items: [] }) - 1];
    g.items.push(it);
  }
  groups.sort((a, b) => (a.label.startsWith('Out') ? -1 : b.label.startsWith('Out') ? 1 : 0));   // stable otherwise: already date-ordered
  return `<p><a class="back" href="#/">← Home</a></p>
    <div class="pagehead"><h1>All upcoming</h1><span class="meta">${items.filter((i) => i.date > today).length} to come</span></div>
    ${groups.some((g) => g.label.startsWith('Out')) ? '<p class="meta">Books that just came out stay here until you mark them read or dismiss them.</p>' : ''}
    ${groups.length ? groups.map((g) => `<h2 class="label">${esc(g.label)}</h2><ul class="rows">${g.items.map((it) => upcomingRow(it, today)).join('')}</ul>`).join('')
      : '<p>No dated releases yet. Follow a series or author, then run a check.</p>'}
    ${undated ? `<p class="meta">${undated} more book${undated > 1 ? 's' : ''} in your series ${undated > 1 ? 'have' : 'has'} no date yet.</p>` : ''}`;
}

const recCard = (r) => `<li class="card has-actions">
  <div class="cardlink">${img(null, r.cover_url, r.name, r.name)}
    <div class="body"><h2>${esc(r.name)}</h2><p class="meta">${esc(r.author ?? 'Unknown author')}</p>
      <p><span class="chip ${r.kind === 'author' ? 'near' : ''}">${esc(r.why)}</span></p></div></div>
  <div class="card-actions"><button class="small primary" data-click="rec-follow" data-hc="${r.hardcover_series_id}" data-name="${esc(r.name)}" data-author="${esc(r.author ?? '')}" data-cover="${esc(r.cover_url ?? '')}" data-complete="${r.complete ? 1 : ''}">Follow</button>
    <button class="small" data-click="rec-dismiss" data-hc="${r.hardcover_series_id}">Not interested</button></div></li>`;

async function viewHome() {
  const today = todayIso();
  const { items } = await collectUpcoming(today);
  const out = items.filter((i) => i.date <= today), soon = items.filter((i) => i.date > today);
  const unseen = (await pendingEvents(store)).length;
  const nSeries = (await store.all('series')).length, nAuthors = (await store.all('author')).length;
  const hasToken = Boolean(await getSetting(store, 'hc_token', ''));
  const backupDue = (nSeries || nAuthors) && (Date.now() - Date.parse((await getSetting(store, 'last_backup', null)) ?? (await getSetting(store, 'first_seen', nowIso())))) > 30 * 864e5;
  const recs = await loadRecs(store);
  const recsNote = !hasToken ? '<p class="meta">Add your Hardcover token (More) to get recommendations.</p>'
    : !nSeries && !nAuthors ? '<p class="meta">Follow a series or author and suggestions will appear here.</p>'
    : !recs ? '<p class="meta" id="recs-status">Finding suggestions…</p>'
    : !recs.items.length ? `<p class="meta">No new suggestions right now.${recs.errors?.length ? ' Some lookups failed: ' + esc(recs.errors[0]) : ''}</p>` : '';
  if (hasToken && (nSeries || nAuthors) && recsStale(recs) && Date.now() - Date.parse(await getSetting(store, 'recs_attempt', '1970-01-01')) > 6 * 36e5) {
    afterRender = async () => {                                      // build in the background, then redraw if still on Home
      await setSetting(store, 'recs_attempt', nowIso());
      try { await buildRecs(store, client); } catch (e) { const el = document.getElementById('recs-status'); if (el) el.textContent = 'Suggestions unavailable: ' + msg(e); return; }
      if (!location.hash || location.hash === '#/') await route();
    };
  }
  return `<div class="pagehead"><h1>Home</h1></div>
    ${backupDue ? '<div class="flash"><span>It has been a while since your last backup.</span> <button class="small" data-click="export">Back up now</button></div>' : ''}
    ${unseen ? `<a class="flash" href="#/updates"><span class="badge fill">${unseen}</span> new update${unseen > 1 ? 's' : ''} — see what's new</a>` : ''}
    ${!nSeries && !nAuthors ? '<section class="panel"><h2>Welcome</h2><p>Follow the series and authors you read and this page shows what is coming out.</p><p><a class="btn" href="#/search">Search</a> <a class="btn" href="#/more">Import your reading history</a></p></section>' : ''}
    ${out.length ? `<h2 class="label">Just out</h2><ul class="rows">${out.slice(0, 4).map((it) => upcomingRow(it, today)).join('')}</ul>` : ''}
    ${soon.length ? `<h2 class="label">Coming up</h2><ul class="rows">${soon.slice(0, 5).map((it) => upcomingRow(it, today)).join('')}</ul>` : ''}
    ${items.length ? '<p><a href="#/upcoming">See all upcoming →</a></p>' : ''}
    ${nSeries || nAuthors ? `<h2 class="label">Recommended for you</h2>${recs?.items.length ? `<ul class="cards">${recs.items.slice(0, 8).map(recCard).join('')}</ul>` : ''}${recsNote}
      ${hasToken && recs ? '<p><button class="small" data-click="recs-refresh">Refresh suggestions</button></p>' : ''}` : ''}`;
}

async function viewUpdates() {
  const list = (await updates(store)).sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '')).slice(0, 100);
  const unseen = list.filter((n) => !n.seen_at).length;
  const tone = { announced: 'near', date_changed: 'warn', released: 'ok' };
  const readOf = new Map();
  for (const n of list) if (n.series_id != null && !readOf.has(n.series_id)) readOf.set(n.series_id, await maxRead(store, n.series_id));
  return `<div class="pagehead"><h1>Updates</h1><span class="head-actions">
      ${unseen ? '<button class="small" data-click="mark-seen">Mark all seen</button>' : ''}
      ${list.length ? '<button class="small" data-click="dismiss-all">Clear all</button>' : ''}</span></div>
    ${list.length ? `<ul class="cards">${list.map((n) => { const w = when(n.release_date);
      const canRead = n.kind === 'released' && n.series_id != null && n.position != null && n.position > readOf.get(n.series_id);
      return `<li class="card has-actions ${n.seen_at ? '' : 'unseen'}">
        <a class="cardlink" href="#/${n.author_id != null ? 'author/' + n.author_id : 'series/' + n.series_id}">
        ${img(n.author_id != null ? null : (n.cover_key ?? `sb-${n.series_id}-${n.position}`), n.author_id != null ? n.cover_url : null, n.title ?? '', n.series_name)}
        <div class="body"><p><span class="chip ${tone[n.kind]}">${LABEL[n.kind]}</span></p>
        <h2>${n.position != null ? '#' + pos(n.position) + ' ' : ''}${esc(n.title)}</h2>
        <p class="meta">${esc(n.series_name)}${n.author_id != null ? ' · author' : ''}</p>
        <p class="meta">${n.kind === 'date_changed' ? `${esc(fmtDate(n.detail))} → ${esc(fmtDate(n.release_date))}` : `${esc(fmtDate(n.release_date))}${w.tone === 'tba' ? '' : ' · ' + esc(w.text)}`}</p></div></a>
        <div class="card-actions">${canRead ? `<button class="small" data-click="read-to" data-id="${n.series_id}" data-pos="${n.position}" data-dismiss="${esc(n.key)}">Mark read</button>` : ''}
          <button class="small" data-click="dismiss-update" data-key="${esc(n.key)}">Dismiss</button></div></li>`; }).join('')}</ul>`
      : '<p>Nothing yet. New announcements, date changes and releases for series and authors you follow show up here after a check.</p>'}`;
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
      <p class="meta">Last backup: ${esc((await getSetting(store, 'last_backup', null))?.slice(0, 10) ?? 'never')} · Storage: ${(await navigator.storage?.persisted?.()) ? 'protected from automatic clearing' : 'not guaranteed (the browser may clear it if space runs low)'}</p>
      <p><button data-click="export">Export backup</button></p>
      <form class="stack" data-form="restore"><label>Restore from backup<input type="file" name="file" accept=".json,application/json"></label><button>Restore</button></form></section>

    <section class="panel"><h2>Hardcover fields</h2>
      <p class="meta">The app's Hardcover queries were written from the public docs. This compares them with the live schema.</p>
      <p><button data-click="verify">Verify Hardcover fields</button></p><pre class="out" id="verify-out"></pre>
      <p class="meta">App version: author grouping (v5)</p></section>

    ${standalone ? '' : `<section class="panel"><h2>Install</h2><p class="meta">Android: browser menu → Install app / Add to Home screen. iPhone: Share → Add to Home Screen (needed so iOS keeps your data).</p>
      ${installPrompt ? '<p><button data-click="install">Install app</button></p>' : ''}</section>`}`;
}

// ---- router -----------------------------------------------------------------------------------
async function route() {
  const [path, qs = ''] = location.hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(qs);
  const [, seg, arg] = path.split('/');
  const tab = { '': 'home', upcoming: 'home', following: 'following', series: 'following', book: 'following', author: 'following', search: 'search', updates: 'updates' }[seg ?? ''] ?? 'more';
  let html;
  try {
    html = await ({ '': viewHome, series: () => viewSeries(arg), book: () => viewBook(arg, path.split('/')[3]), author: () => viewAuthor(arg), upcoming: viewUpcoming, following: viewFollowing, search: () => viewSearch(params), updates: viewUpdates,
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
  async 'dismiss-update'(el) { await dismissUpdate(store, el.dataset.key); await route(); },
  async 'dismiss-all'() { if (!confirm('Clear all updates?')) return; await dismissAllUpdates(store); await route(); },
  async dismiss(el) {
    const { kind, id, pos: p, bid } = el.dataset;
    const [table, key] = kind === 'author' ? ['author_book', `${id}:${bid}`] : ['series_book', sbKey(Number(id), Number(p))];
    const row = await store.get(table, key);
    if (row) await store.put(table, { ...row, dismissed: 1 });
    await route();
  },
  async 'rec-follow'(el) {
    const d = el.dataset;
    await unremoveSeries(store, Number(d.hc));
    const sid = await followSeries(store, client, { hardcover_series_id: Number(d.hc), name: d.name, author: d.author || null, cover_url: d.cover || null, complete: Boolean(d.complete) }, 0, covers);
    toast(`Following “${d.name}”. Use “Mark all released as read” on its page if you've read it.`); location.hash = `#/series/${sid}`;
  },
  async 'rec-dismiss'(el) { await dismissRec(store, Number(el.dataset.hc)); await route(); },
  async 'recs-refresh'() {
    toast('Looking for suggestions…', { ms: 0 });
    const r = await buildRecs(store, client);
    toast(r.items.length ? `Found ${r.items.length} suggestion${r.items.length > 1 ? "s" : ""}.` : 'No suggestions found.' + (r.errors.length ? ' ' + r.errors[0] : ''), { error: !r.items.length && r.errors.length > 0 }); await route();
  },
  async 'sync-hc'() {
    toast('Syncing from Hardcover…', { ms: 0 });
    const r = await importHardcover(store, client, covers);
    toast(`Synced: ${r.series_followed} series checked against your Hardcover library.` + (r.errors.length ? ' Problem: ' + r.errors[0] : '')); await route();
  },
  async 'import-hc'() {
    if (await needToken()) return;
    toast('Importing from Hardcover…', { ms: 0 });
    toast(report(await importHardcover(store, client, covers), 'Hardcover import')); location.hash = '#/following';
  },
  async assign(el) {
    await assignGroup(store, client, Number(el.dataset.id), { hardcover_series_id: Number(el.dataset.hc), name: el.dataset.name, author: el.dataset.author || null }, covers);
    location.hash = '#/review'; await route();
  },
  async 'read-to'(el) {
    await setProgress(store, Number(el.dataset.id), Number(el.dataset.pos));
    if (el.dataset.dismiss) await dismissUpdate(store, el.dataset.dismiss);
    await route();
  },
  async remove(el) {
    if (!confirm(`Stop following “${el.dataset.name}”? Its progress and updates are deleted.`)) return;
    await removeSeries(store, Number(el.dataset.id));
    if (el.dataset.home) location.hash = '#/following';
    toast('Removed.'); await route();
  },
  async 'mute-author'(el) { const a = await store.get('author', Number(el.dataset.id)); await store.put('author', { ...a, muted: a.muted ? 0 : 1 }); await route(); },
  async 'remove-author'(el) {
    if (!confirm(`Stop following ${el.dataset.name}? Their updates are deleted.`)) return;
    await removeAuthor(store, Number(el.dataset.id)); toast('Removed.'); location.hash = '#/following'; await route();
  },
  async notify(el) {
    const sid = Number(el.dataset.id), pos_ = Number(el.dataset.pos), row = await store.get('series_book', sbKey(sid, pos_));
    if (!row) return;
    const on = !notifying(row, await maxRead(store, sid));
    await store.put('series_book', { ...row, notify: on });
    toast(on ? `You'll be notified about “${row.title}”.` : `Notifications off for “${row.title}”.`, { ms: 3000 }); await route();
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
    await setSetting(store, 'last_backup', nowIso()); toast('Backup downloaded.', { ms: 3000 }); await route();
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
    await unremoveSeries(store, Number(fd.get('hardcover_series_id')));
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
    toast(report(await importGoodreads(store, text, client, covers), 'Goodreads import')); location.hash = '#/following';
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
  if (!(await getSetting(store, 'first_seen', null))) await setSetting(store, 'first_seen', nowIso());
  try { await navigator.storage?.persist?.(); } catch { /* optional */ }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { type: 'module' }).catch(() => {});
  await route();
  const last = await getSetting(store, 'last_check', null);
  if (!last || Date.now() - Date.parse(last) > CHECK_EVERY_MS) checkNow({ silent: true });
}
main().catch((e) => { $app.innerHTML = `<p class="error">Could not open local storage: ${esc(e?.message ?? e)}. Private browsing can block it.</p>`; });
