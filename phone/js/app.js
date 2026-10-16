// UI: hash-routed, mobile-first. All data lives in this browser (IndexedDB); nothing is sent anywhere
// except requests to Hardcover (and cover images) made directly from the phone.
import { openIdbStore } from './store-idb.js';
import { HardcoverClient, HardcoverError } from './hardcover.js';
import { CoverCache, placeholderUri } from './covers.js';
import { getSetting, setSetting, todayIso, sbKey, notifying, maxRead, setProgress, removeSeries, unremoveSeries, lastReleased, nowIso, isRead, toggleRead } from './db.js';
import { followAuthor, removeAuthor, refreshAuthorMeta } from './authors.js';
import { fmtDate, when, ago, isEstimated, STORES, storeLink } from './format.js';
import { buildIcs } from './ics.js';
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
  return { total: whole.length, read: whole.filter((r) => isRead(r, read)).length };
}
const progressHtml = (p) => (p.total ? `<div class="progress"><div class="bar" role="img" aria-label="${p.read} of ${p.total} read"><i style="width:${Math.round(100 * p.read / p.total)}%"></i></div><span class="meta">${p.read} of ${p.total} read</span></div>` : '');
const msg = (e) => (e instanceof HardcoverError ? e.message : 'Something went wrong: ' + (e?.message ?? e));

// ---- feedback ---------------------------------------------------------------------------
let toastTimer;
function toast(text, { error = false, ms = error ? 6000 : 3000 } = {}) {
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
function img(key, fb, title, seed, cls = 'cover', author = '') {
  return `<img class="${cls}" src="${esc(placeholderUri(title, seed))}" alt="Cover of ${esc(title)}" loading="lazy" `
    + `data-ck="${esc(key ?? '')}" data-fb="${esc(fb ?? '')}" data-title="${esc(title)}" data-seed="${esc(seed)}" data-author="${esc(author ?? '')}">`;
}
async function hydrateCovers(root = $app) {
  await Promise.all([...root.querySelectorAll('img[data-ck]')].map(async (el) => {
    const { ck, fb } = el.dataset;
    if (!ck && !fb) return;
    const key = ck || `remote-${fb}`;
    const byTitle = async () => {                       // no image from any source: try Open Library by title
      const k = await covers.lookupByTitle(key, el.dataset.title, el.dataset.author || null);
      const r2 = k && await store.get('covers', k);
      if (r2?.blob) { if (!objectUrls.has(key)) objectUrls.set(key, URL.createObjectURL(r2.blob)); el.onerror = null; el.src = objectUrls.get(key); }
    };
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
        el.onerror = () => { el.src = placeholderUri(el.dataset.title, el.dataset.seed); el.onerror = null; byTitle().catch(() => {}); };
        el.src = fb;                                    // fallback: browser HTTP cache
      } else if (!rec?.blob) await byTitle();
    } catch { /* keep placeholder */ }
  }));
}

// ---- views ----------------------------------------------------------------------------------
function seriesCard(s, read, next, prog) {
  const w = next ? when(next.release_date) : null;
  return `<li class="card ${s.muted ? 'is-muted' : ''}">
    <a class="cardlink" href="#/series/${s.id}">
      ${img(s.cover_key ?? `series-${s.id}`, s.cover_key ? '' : s.cover_url, s.name, s.name, 'cover', s.author)}
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

// What state a followed series is in (for the Following filters).
function seriesState(s, mine, read, today) {
  const released = mine.filter((r) => r.release_date && r.release_date.slice(0, 10) <= today && Number.isInteger(r.position));
  const started = mine.some((r) => isRead(r, read)), caughtUp = released.every((r) => isRead(r, read));
  if (s.muted) return 'muted';
  if (caughtUp && started && s.complete) return 'finished';
  if (caughtUp && started) return 'waiting';
  return started ? 'reading' : 'unstarted';
}
const FOLLOW_SORTS = [['next', 'Next release'], ['recent', 'Recently read'], ['az', 'A–Z'], ['progress', 'Progress']];
const FILTERS = [['all', 'All'], ['reading', 'Reading'], ['waiting', 'Waiting'], ['finished', 'Finished'], ['muted', 'Muted']];
async function viewFollowing() {
  const today = todayIso(), sort = await getSetting(store, 'follow_sort', 'next'), filter = await getSetting(store, 'follow_filter', 'all');
  const sbs = await store.all('series_book');
  const authors = (await store.all('author')).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const rows = [];
  for (const s of await store.all('series')) {
    const read = await maxRead(store, s.id), mine = sbs.filter((r) => r.series_id === s.id);
    const next = mine.filter((r) => Number.isInteger(r.position) && r.position > read && r.read !== true).sort((a, b) => a.position - b.position)[0];
    const prog = progress(mine, read);
    rows.push({ s, read, next, prog, state: seriesState(s, mine, read, today) });
  }
  const counts = Object.fromEntries(FILTERS.map(([k]) => [k, k === 'all' ? rows.filter((r) => r.state !== 'muted').length : rows.filter((r) => r.state === k).length]));
  const shown = rows.filter((r) => (filter === 'all' ? r.state !== 'muted' : r.state === filter));
  const name = (r) => r.s.name.toLowerCase();
  shown.sort(sort === 'az' ? (x, y) => name(x).localeCompare(name(y))
    : sort === 'recent' ? (x, y) => (y.s.last_read_at ?? '').localeCompare(x.s.last_read_at ?? '') || name(x).localeCompare(name(y))
    : sort === 'progress' ? (x, y) => (y.prog.total ? y.prog.read / y.prog.total : 0) - (x.prog.total ? x.prog.read / x.prog.total : 0) || name(x).localeCompare(name(y))
    : (x, y) => (x.next?.release_date ?? '9999').localeCompare(y.next?.release_date ?? '9999') || name(x).localeCompare(name(y)));
  const hasToken = Boolean(await getSetting(store, 'hc_token', ''));
  const sortSel = `<details class="menu inline"><summary aria-label="Sort series">${esc(FOLLOW_SORTS.find(([k]) => k === sort)?.[1] ?? 'Sort')} ▾</summary><div class="menu-items">
    ${FOLLOW_SORTS.map(([k, v]) => `<button data-click="follow-sort" data-value="${k}" aria-pressed="${sort === k}">${sort === k ? '✓ ' : ''}${v}</button>`).join('')}
    ${hasToken && rows.length ? '<button data-click="sync-hc">Sync progress from Hardcover</button>' : ''}</div></details>`;
  return `<div class="pagehead"><h1>Following</h1>${rows.length ? sortSel : ''}</div>
    ${authors.length ? `${secHead(`Authors · ${authors.length}`, '')}<ul class="shelf authors">${authors.map((a) => shelfItem({ href: `#/author/${a.hardcover_author_id}`, ck: null, fb: a.cover_url,
      title: a.name, seed: a.name, author: a.name, line2: a.muted ? 'Muted' : '' })).join('')}</ul>` : ''}
    ${rows.length ? `${authors.length ? secHead(`Series · ${rows.length}`, '') : ''}<div class="filters" role="group" aria-label="Filter series">${FILTERS.filter(([k]) => k === 'all' || counts[k])
      .map(([k, v]) => `<button class="filter" data-click="follow-filter" data-value="${k}" aria-pressed="${filter === k}">${v} <span>${counts[k]}</span></button>`).join('')}</div>
      ${shown.length ? `<ul class="cards">${shown.map((r) => seriesCard(r.s, r.read, r.next, r.prog)).join('')}</ul>` : '<p class="meta">Nothing here.</p>'}`
      : `<p>Nothing followed yet.</p><p><a class="btn" href="#/more/data">Import your reading history</a> or <a href="#/search">search for a series</a>.</p>`}`;
}

async function viewSeries(id) {
  const s = await store.get('series', Number(id));
  if (!s) return '<p>No such series. <a href="#/following">Back</a></p>';
  const read = await maxRead(store, s.id), today = todayIso();
  const books = (await store.all('series_book')).filter((r) => r.series_id === s.id).sort((a, b) => a.position - b.position);
  const authorFollowed = s.author && (await store.all('author')).some((x) => x.name.toLowerCase() === s.author.toLowerCase());
  return `<p><a class="back" href="#/following">← Following</a></p>
    <div class="hero">
      ${img(s.cover_key ?? `series-${s.id}`, s.cover_key ? '' : s.cover_url, s.name, s.name, 'cover big', s.author)}
      <div class="body"><h1>${esc(s.name)}${s.muted ? ' <span class="badge">Muted</span>' : ''}</h1>
        <p class="meta">${esc(s.author ?? 'Unknown author')}</p>
        <p class="meta">${books.filter((b) => Number.isInteger(b.position)).length} books · ${s.complete ? 'complete' : 'ongoing'} · ${s.last_checked_at ? 'checked ' + esc(ago(s.last_checked_at)) : 'not checked yet'}</p>
        ${progressHtml(progress(books, read))}
        ${s.author && !authorFollowed ? `<p><a class="btn small" href="#/search?q=${encodeURIComponent(s.author)}">+ Follow ${esc(s.author)}</a></p>` : ''}</div></div>
    <div class="actions"><button class="primary" data-click="read-all" data-id="${s.id}">Mark all released as read</button>
      ${menu(s.name, `<button data-click="mute" data-id="${s.id}">${s.muted ? 'Unmute' : 'Mute'}</button>
        ${read ? `<button data-click="read-none" data-id="${s.id}">Reset progress</button>` : ''}
        <button class="danger" data-click="remove" data-id="${s.id}" data-name="${esc(s.name)}" data-home="1">Remove</button>`)}</div>
    ${books.length ? `<ul class="rows">${books.map((b) => {
      const done = isRead(b, read), w = when(b.release_date, today);
      const unreleased = w.tone !== 'ok';
      const earlierUnread = books.some((x) => x.position < b.position && !isRead(x, read));
      const on = notifying(b, read);
      const btn = unreleased && !done
        ? `<button class="tick bell" aria-pressed="${on}" data-click="notify" data-id="${s.id}" data-pos="${b.position}" aria-label="${on ? 'Notifying' : 'Notify me'} about ${esc(b.title)}" title="${on ? 'Notifying' : 'Notify me'}">🔔</button>`
        : `<button class="tick" aria-pressed="${done}" data-click="toggle-read" data-id="${s.id}" data-pos="${b.position}" aria-label="${done ? 'Mark unread' : 'Mark read'}: ${esc(b.title)}">✓</button>`;
      const rowMenu = !done && !unreleased && earlierUnread ? `<details class="menu row"><summary aria-label="More for ${esc(b.title)}">⋯</summary><div class="menu-items">
        <button data-click="read-to" data-id="${s.id}" data-pos="${b.position}">Read everything up to here</button></div></details>` : '';
      return `<li class="${done ? 'read' : ''}" data-swipe="toggle-read" data-id="${s.id}" data-pos="${b.position}">
        ${img(b.cover_key ?? `sb-${s.id}-${b.position}`, b.cover_key ? '' : b.cover_url, b.title, s.name, 'cover small', s.author)}
        <div class="grow"><a class="booklink" href="#/book/${s.id}/${b.position}"><span class="num">#${pos(b.position)}</span> ${esc(b.title)}</a><br>
          ${done ? '<span class="chip read">✓ Read</span>' : chip(w)} <span class="meta">${w.tone === 'tba' ? '' : esc(fmtDate(b.release_date))}</span></div>${rowMenu}${btn}</li>`;
    }).join('')}</ul>` : '<p>No books fetched yet. Use “Check now” in More.</p>'}`;
}

async function viewBook(sid, position) {
  sid = Number(sid); position = Number(position);
  const s = await store.get('series', sid), b = await store.get('series_book', sbKey(sid, position));
  if (!s || !b) return '<p>No such book. <a href="#/following">Back</a></p>';
  const read = await maxRead(store, sid), done = isRead(b, read), w = when(b.release_date);
  const all = (await store.all('series_book')).filter((r) => r.series_id === sid);
  const earlierUnread = all.some((x) => x.position < b.position && !isRead(x, read));
  const shop = await getSetting(store, 'store', 'hardcover');
  const btn = done ? `<button data-click="toggle-read" data-id="${sid}" data-pos="${b.position}">Mark unread</button>`
    : w.tone !== 'ok' ? notifyBtn(sid, b, read)
    : `<button class="primary" data-click="toggle-read" data-id="${sid}" data-pos="${b.position}">Mark read</button>${earlierUnread ? `<button data-click="read-to" data-id="${sid}" data-pos="${b.position}">Read up to here</button>` : ''}`;
  const sorted = all.sort((x, y) => x.position - y.position), i = sorted.findIndex((x) => x.position === b.position);
  const prev = sorted[i - 1], next = sorted[i + 1];
  const authorFollowed = s.author && (await store.all('author')).some((x) => x.name.toLowerCase() === s.author.toLowerCase());
  const getIt = done ? '' : `<a class="btn" target="_blank" rel="noopener" href="${esc(storeLink(shop, b.title, s.author ?? ''))}">${w.tone === 'ok' ? 'Get it' : 'Pre-order'} · ${STORES[shop] ?? 'Hardcover'} ↗</a>`;
  afterRender = async () => {
    const box = document.getElementById('book-more');
    if (!box) return;
    if (!b.hardcover_book_id) { box.textContent = ''; return; }
    try {
      const d = await client.bookDetails(b.hardcover_book_id);
      const bits = [d.pages || d.rating ? `<p class="meta">${[d.rating ? `★ ${d.rating.toFixed(1)}` : '', d.pages ? `${d.pages} pages` : ''].filter(Boolean).join(' · ')}</p>` : '',
        d.description ? `<p class="desc">${esc(d.description).replace(/\n+/g, '</p><p class="desc">')}</p>` : '<p class="meta">No description on Hardcover.</p>'];
      box.innerHTML = bits.join('');
    } catch (e) { box.innerHTML = `<p class="meta">Details unavailable: ${esc(msg(e))}</p>`; }
    await similarShelf(b.hardcover_book_id);
  };
  return `<div class="bookbar"><a class="back" href="#/series/${sid}">← ${esc(s.name)}</a><span class="pn">
      ${prev ? `<a class="btn small" href="#/book/${sid}/${prev.position}" aria-label="Previous: ${esc(prev.title)}">‹ #${pos(prev.position)}</a>` : ''}
      ${next ? `<a class="btn small" href="#/book/${sid}/${next.position}" aria-label="Next: ${esc(next.title)}">#${pos(next.position)} ›</a>` : ''}</span></div>
    <div class="hero">
      ${img(b.cover_key ?? `sb-${sid}-${b.position}`, b.cover_key ? '' : b.cover_url, b.title, s.name, 'cover big', s.author)}
      <div class="body"><h1>${esc(b.title)}</h1>
        <p class="meta">${esc(s.author ?? 'Unknown author')}</p>
        <p class="meta">${esc(s.name)} · #${pos(b.position)} of ${sorted.filter((x) => Number.isInteger(x.position)).length}</p>
        <p>${done ? '<span class="chip read">✓ Read</span> ' : ''}${chip(w)} <span class="meta">${w.tone === 'tba' ? '' : esc(fmtDate(b.release_date))}</span></p></div></div>
    ${btn || getIt ? `<div class="actions">${btn}${getIt}</div>` : ''}
    ${s.author && !authorFollowed ? `<p><a class="btn small" href="#/search?q=${encodeURIComponent(s.author)}">+ Follow ${esc(s.author)}</a></p>` : ''}
    <div id="book-more"><p class="meta">Loading details…</p></div>
    <div id="similar"></div>`;
}

// "Similar books" shelf (Hardcover's own similar-books list), filled in after the page shows.
async function similarShelf(bookId) {
  const box = document.getElementById('similar');
  if (!box || !bookId || !(await getSetting(store, 'hc_token', ''))) return;
  try {
    const ids = (await client.similarBookIds([bookId])).get(Number(bookId)) ?? [];
    if (!ids.length) return;
    const mine = new Map((await store.all('series')).map((s) => [s.hardcover_series_id, s]));
    const seen = new Set(), items = [];
    const info = new Map((await client.booksInfo(ids.slice(0, 20))).map((x) => [x.hardcover_book_id, x]));
    for (const id of ids.slice(0, 20)) {
      const x = info.get(id);
      if (!x?.series || seen.has(x.series.hardcover_series_id)) continue;
      seen.add(x.series.hardcover_series_id);
      const own = mine.get(x.series.hardcover_series_id);
      const q = new URLSearchParams({ n: x.series.name, a: x.series.author ?? '', c: x.cover_url ?? '', w: `Similar to ${document.querySelector('h1')?.textContent ?? 'this book'}` });
      items.push(shelfItem({ href: own ? `#/series/${own.id}` : `#/rec/${x.series.hardcover_series_id}?${q}`, ck: null, fb: x.cover_url, title: x.title, seed: x.series.name,
        author: x.series.author, line2: own ? 'Following' : esc(x.series.author ?? x.series.name) }));
      if (items.length >= 12) break;
    }
    if (!items.length || !document.body.contains(box)) return;
    box.innerHTML = `${secHead('Similar books', '')}<ul class="shelf">${items.join('')}</ul>`;
    hydrateCovers(box);
  } catch { /* the shelf is optional */ }
}

async function viewAuthorBook(aid, bid) {
  aid = Number(aid); bid = Number(bid);
  const a = await store.get('author', aid), b = await store.get('author_book', `${aid}:${bid}`);
  if (!a || !b) return '<p>No such book. <a href="#/following">Back</a></p>';
  const w = when(b.release_date);
  afterRender = async () => {
    const box = document.getElementById('book-more');
    if (!box) return;
    try {
      const d = await client.bookDetails(bid);
      box.innerHTML = [d.pages ? `<p class="meta">${d.pages} pages</p>` : '',
        d.description ? `<p class="desc">${esc(d.description).replace(/\n+/g, '</p><p class="desc">')}</p>` : '<p class="meta">No description on Hardcover.</p>'].join('');
    } catch (e) { box.innerHTML = `<p class="meta">Details unavailable: ${esc(msg(e))}</p>`; }
    await similarShelf(bid);
  };
  return `<p><a class="back" href="#/author/${aid}">← ${esc(a.name)}</a></p>
    <div class="hero">${img(null, b.cover_url, b.title, a.name, 'cover big', a.name)}
      <div class="body"><h1>${esc(b.title)}</h1>
        <p class="meta">${esc(a.name)}</p>
        ${b.series_name ? `<p class="meta">${esc(b.series_name)}${b.series_position != null ? ` · #${pos(b.series_position)}` : ''}</p>` : ''}
        <p>${chip(w)} <span class="meta">${w.tone === 'tba' ? '' : esc(fmtDate(b.release_date))}</span></p></div></div>
    <div id="book-more"><p class="meta">Loading details…</p></div><div id="similar"></div>`;
}

async function viewRec(id, params = new URLSearchParams()) {
  id = Number(id);
  const own = (await store.all('series')).find((s) => s.hardcover_series_id === id);
  if (own) { location.replace(`#/series/${own.id}`); return ''; }
  const rec = await getSetting(store, 'recs', null);
  const r = rec?.items.find((i) => i.hardcover_series_id === id)
    ?? (params.get('n') ? { hardcover_series_id: id, name: params.get('n'), author: params.get('a') || null, cover_url: params.get('c') || null, why: params.get('w') || 'Similar book', kind: 'similar' } : null);
  if (!r) return '<p>Suggestion no longer available. <a href="#/">Back</a></p>';
  const today = todayIso();
  afterRender = async () => {
    const box = document.getElementById('book-more');
    if (!box) return;
    try {
      const books = await client.seriesBooks(id), first = books[0];
      let d = null;
      if (first) { try { d = await client.bookDetails(first.hardcover_book_id); } catch { /* list still useful */ } }
      box.innerHTML = `${d?.rating ? `<p class="meta">★ ${d.rating.toFixed(1)} on Hardcover${d.pages ? ` · book 1 is ${d.pages} pages` : ''}</p>` : ''}${d?.description ? `<p class="desc">${esc(d.description).replace(/\n+/g, '</p><p class="desc">')}</p>` : ''}
        ${books.length ? `<h2 class="label">${books.length} book${books.length > 1 ? 's' : ''}</h2><ul class="rows">${books.map((b) => { const w = when(b.release_date, today);
          return `<li>${img(null, b.cover_url, b.title, r.name, 'cover small')}<div class="grow"><strong><span class="num">#${pos(b.position)}</span> ${esc(b.title)}</strong><br>${chip(w)} <span class="meta">${w.tone === 'tba' ? '' : esc(fmtDate(b.release_date, today))}</span></div></li>`; }).join('')}</ul>` : '<p class="meta">No books listed on Hardcover.</p>'}`;
    } catch (e) { box.innerHTML = `<p class="meta">Details unavailable: ${esc(msg(e))}</p>`; }
  };
  return `<p><a class="back" href="#/" data-click="back">← Back</a></p>
    <div class="hero">${img(null, r.cover_url, r.name, r.name, 'cover big')}
      <div class="body"><h1>${esc(r.name)}</h1><p class="meta">${esc(r.author ?? 'Unknown author')}</p>
        <p><span class="chip ${r.kind === 'author' ? 'near' : ''}">${esc(r.why)}</span></p></div></div>
    <div class="actions"><button class="primary" data-click="rec-follow" data-hc="${id}" data-name="${esc(r.name)}" data-author="${esc(r.author ?? '')}" data-cover="${esc(r.cover_url ?? '')}" data-complete="${r.complete ? 1 : ''}">Follow</button>
      <button data-click="rec-dismiss" data-hc="${id}" data-home="1">Not interested</button></div>
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
  const row = (b, withPos) => { const w = when(b.release_date, today); return `<li>${img(null, b.cover_url, b.title, a.name, 'cover small', a.name)}
    <div class="grow"><a class="booklink" href="#/abook/${a.hardcover_author_id}/${b.hardcover_book_id}">${withPos && b.series_position != null ? `<span class="num">#${pos(b.series_position)}</span> ` : ''}${esc(b.title)}</a><br>${b.read ? '<span class="chip read">✓ Read</span>' : chip(w)} <span class="meta">${w.tone === 'tba' ? '' : esc(fmtDate(b.release_date, today))}</span></div>
    ${b.read || w.tone === 'ok' ? `<div class="row-btns"><button class="small ${b.read ? '' : 'primary'}" data-click="toggle-aread" data-aid="${a.hardcover_author_id}" data-bid="${b.hardcover_book_id}">${b.read ? 'Unread' : 'Mark read'}</button></div>` : ''}</li>`; };
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
        <p class="meta">${books.length ? `${list.length} series · ${stand.length} standalone` : 'No books listed'} · ${a.last_checked_at ? 'checked ' + esc(ago(a.last_checked_at)) : 'not checked yet'}</p></div></div>
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
        <button class="primary">Follow</button></form>`}</div></li>`).join('');
  const bCards = r.books.map((b) => `<li class="card">${img(null, b.cover_url, b.title, b.title)}<div><h3>${esc(b.title)}</h3>
      <p class="meta">${esc(b.author ?? 'Unknown author')}${b.release_date ? ' · ' + esc(fmtDate(b.release_date)) : ''}</p>
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
  const tabs = [['series', 'Series', r.series.length, sCards, 'No series found.'], ['authors', 'Authors', (r.authors ?? []).length, aCards, 'No authors found.'],
    ['books', 'Books', r.books.length, bCards, 'No books found.']];
  const first = (tabs.find((t) => t[2]) ?? tabs[0])[0];
  return `<div class="filters" role="tablist" aria-label="Result type">${tabs.map(([k, label, n]) =>
      `<button class="filter" role="tab" data-click="search-tab" data-value="${k}" aria-selected="${k === first}" aria-pressed="${k === first}">${label} <span>${n}</span></button>`).join('')}</div>
    ${tabs.map(([k, , n, html, none]) => `<div class="tabpanel" data-panel="${k}" role="tabpanel" ${k === first ? '' : 'hidden'}>${n ? `<ul class="cards">${html}</ul>` : `<p class="meta">${none}</p>`}</div>`).join('')}
    <p class="meta">Can't find it? <a href="#/manual">Add it by hand</a>.</p>`;
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
  return `<div class="pagehead"><h1>Search</h1></div>
    <form role="search" class="inline" data-form="search"><label class="sr" for="q">Title, author, series or ISBN</label>
      <input id="q" type="search" name="q" value="${esc(q)}" placeholder="Title, author, series or ISBN" enterkeyhint="search" autocomplete="off">
      <button class="sr">Search</button></form>
    <div id="results" aria-live="polite"></div>`;
}

// Dated releases from followed series (not muted) and authors, from 30 days ago onward, minus read/dismissed ones.
async function collectUpcoming(today) {
  const ago = new Date(Date.now() - 30 * 864e5), cutoff = `${ago.getFullYear()}-${String(ago.getMonth() + 1).padStart(2, '0')}-${String(ago.getDate()).padStart(2, '0')}`;
  const series = new Map((await store.all('series')).map((s) => [s.id, s]));
  const authors = new Map((await store.all('author')).map((a) => [a.hardcover_author_id, a]));
  const sbs = (await store.all('series_book')).filter((r) => series.get(r.series_id) && !series.get(r.series_id).muted);
  const inSeries = new Set(sbs.map((r) => r.hardcover_book_id));
  const items = [], readOf = new Map(), shop = await getSetting(store, 'store', 'hardcover');
  for (const id of series.keys()) readOf.set(id, await maxRead(store, id));
  for (const r of sbs) {
    if (!r.release_date || r.release_date.slice(0, 10) < cutoff || r.dismissed) continue;
    const s = series.get(r.series_id), out = r.release_date.slice(0, 10) <= today;
    if (out && isRead(r, readOf.get(r.series_id))) continue;                 // released and already read: nothing to do
    items.push({ date: r.release_date.slice(0, 10), title: `#${pos(r.position)} ${r.title}`, sub: s.name, href: `#/book/${r.series_id}/${r.position}`,
      ck: r.cover_key ?? `sb-${r.series_id}-${r.position}`, fb: r.cover_key ? '' : r.cover_url, seed: s.name,
      actions: out ? `<button class="small" data-click="toggle-read" data-id="${r.series_id}" data-pos="${r.position}">Mark read</button>
        <a class="btn small" target="_blank" rel="noopener" href="${esc(storeLink(shop, r.title, s.author ?? ''))}">Get it ↗</a>
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
  return `<li>${img(it.ck, it.fb, it.title, it.seed, 'cover small', it.author)}<div class="grow"><a class="booklink" href="${it.href}">${esc(it.title)}</a><br>
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
  <a class="cardlink" href="#/rec/${r.hardcover_series_id}">${img(null, r.cover_url, r.name, r.name, 'cover', r.author)}
    <div class="body"><h2>${esc(r.name)}</h2><p class="meta">${esc(r.author ?? 'Unknown author')}</p>
      <p><span class="chip ${r.kind === 'author' ? 'near' : ''}">${esc(r.why)}</span>${r.rating ? ` <span class="chip">★ ${r.rating.toFixed(1)}</span>` : ''}</p></div></a>
  <div class="card-actions"><button class="small primary" data-click="rec-follow" data-hc="${r.hardcover_series_id}" data-name="${esc(r.name)}" data-author="${esc(r.author ?? '')}" data-cover="${esc(r.cover_url ?? '')}" data-complete="${r.complete ? 1 : ''}">Follow</button>
    <button class="small" data-click="rec-dismiss" data-hc="${r.hardcover_series_id}">Not interested</button></div></li>`;

// Released, unread next book of each started series (the "Continue reading" shelf).
async function collectNext(today, skip = new Set()) {
  const shop = await getSetting(store, 'store', 'hardcover'), allSb = await store.all('series_book'), out = [];
  for (const s of (await store.all('series')).filter((x) => !x.muted).sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }))) {
    const read = await maxRead(store, s.id), rows = allSb.filter((r) => r.series_id === s.id).sort((x, y) => x.position - y.position);
    if (!rows.some((r) => isRead(r, read))) continue;                      // only series you have started
    const n = rows.find((r) => Number.isInteger(r.position) && !isRead(r, read) && r.release_date && r.release_date.slice(0, 10) <= today);
    if (!n || skip.has(`#/book/${s.id}/${n.position}`)) continue;
    out.push({ date: n.release_date.slice(0, 10), title: `#${pos(n.position)} ${n.title}`, name: n.title, num: n.position, sub: s.name, href: `#/book/${s.id}/${n.position}`,
      ck: n.cover_key ?? `sb-${s.id}-${n.position}`, fb: n.cover_key ? '' : n.cover_url, seed: s.name, author: s.author,
      actions: `<button class="small primary" data-click="toggle-read" data-id="${s.id}" data-pos="${n.position}">Mark read</button>
        <a class="btn small" target="_blank" rel="noopener" href="${esc(storeLink(shop, n.title, s.author ?? ''))}">Get it ↗</a>` });
  }
  return out;
}
async function sortedRecs() {
  const recs = await loadRecs(store), sort = await getSetting(store, 'recs_sort', 'popular');
  if (recs) recs.items = [...recs.items].sort(sort === 'rating' ? (x, y) => (y.rating ?? 0) - (x.rating ?? 0) || y.rank - x.rank
    : sort === 'authors' ? (x, y) => (+(y.kind === 'author') - +(x.kind === 'author')) || y.rank - x.rank : (x, y) => y.rank - x.rank);
  return { recs, sort };
}
const SORTS = [['popular', 'Most similar'], ['rating', 'Top rated'], ['authors', 'My authors']];
const sortMenu = (sort, hasToken) => `<details class="menu inline"><summary aria-label="Sort and refresh suggestions">${esc(SORTS.find(([k]) => k === sort)?.[1] ?? 'Sort')} ▾</summary><div class="menu-items">
  ${SORTS.map(([k, v]) => `<button data-click="recs-sort" data-value="${k}" aria-pressed="${sort === k}">${sort === k ? '✓ ' : ''}${v}</button>`).join('')}
  ${hasToken ? '<button data-click="recs-refresh">Refresh suggestions</button>' : ''}</div></details>`;
const secHead = (label, href, extra = '') => `<div class="sechead"><h2 class="label">${label}</h2><span class="sechead-r">${extra}${href ? `<a href="${href}">See all →</a>` : ''}</span></div>`;
// One cover in a horizontal shelf: cover, two-line title, one-line subtitle; optional ✕ (dismiss) in the corner.
const shelfItem = ({ href, ck, fb, title, seed, author, line2, x }) => `<li class="shelf-item"><a href="${href}">${img(ck, fb, title, seed, 'cover shelfcover', author)}
  <span class="t">${esc(title)}</span>${line2 ? `<span class="s">${line2}</span>` : ''}</a>${x ?? ''}</li>`;

async function viewHome() {
  const today = todayIso();
  const { items } = await collectUpcoming(today);
  const out = items.filter((i) => i.date <= today), soon = items.filter((i) => i.date > today);
  const nextUp = await collectNext(today, new Set(out.map((i) => i.href)));
  const nSeries = (await store.all('series')).length, nAuthors = (await store.all('author')).length;
  const hasToken = Boolean(await getSetting(store, 'hc_token', ''));
  const { recs, sort } = await sortedRecs();
  const recsNote = !hasToken ? '<p class="meta">Add your Hardcover token (More) to get suggestions.</p>'
    : !recs ? '<p class="meta" id="recs-status">Finding suggestions…</p>'
    : !recs.items.length ? `<p class="meta">No new suggestions right now.${recs.errors?.length ? ' Some lookups failed: ' + esc(recs.errors[0]) : ''}</p>` : '';
  if (hasToken && (nSeries || nAuthors) && recsStale(recs) && Date.now() - Date.parse(await getSetting(store, 'recs_attempt', '1970-01-01')) > 6 * 36e5) {
    afterRender = async () => {                                      // build in the background, then redraw if still on Home
      await setSetting(store, 'recs_attempt', nowIso());
      try { await buildRecs(store, client); } catch (e) { const el = document.getElementById('recs-status'); if (el) el.textContent = 'Suggestions unavailable: ' + msg(e); return; }
      if (!location.hash || location.hash === '#/') await route();
    };
  }
  if (!nSeries && !nAuthors) return `<div class="pagehead"><h1>Home</h1></div>
    <section class="panel"><h2>Welcome</h2><p>Follow the series and authors you read and this page shows what is coming out.</p><p><a class="btn" href="#/search">Search</a> <a class="btn" href="#/more/data">Import your reading history</a></p></section>`;
  const hero = soon[0], hw = hero && when(hero.date, today);
  const later = soon.slice(hero ? 1 : 0);
  return `<div class="pagehead"><h1>Home</h1></div>
    ${hero ? `<a class="hero-card" href="${hero.href}">${img(hero.ck, hero.fb, hero.title, hero.seed, 'cover big', hero.author)}
      <div class="body"><span class="label">Next release</span><strong class="ht">${esc(hero.title)}</strong><span class="meta">${esc(hero.sub)}</span>
        <span class="countdown ${hw.tone}">${esc(hw.text)}</span><span class="meta">${esc(fmtDate(hero.date, today))}</span></div></a>` : ''}
    ${out.length ? `${secHead('Just out', out.length > 3 ? '#/upcoming' : '')}<ul class="rows">${out.slice(0, 3).map((it) => upcomingRow(it, today)).join('')}</ul>` : ''}
    ${later.length ? `${secHead('Coming up', '#/upcoming')}<ul class="shelf">${later.slice(0, 12).map((it) => { const w = when(it.date, today);
      return shelfItem({ ...it, line2: `<span class="chip ${w.tone}">${esc(w.text)}</span>` }); }).join('')}</ul>` : ''}
    ${!items.length ? '<p class="meta">No dated releases yet. They show up here once Hardcover lists a date.</p>' : ''}
    ${nextUp.length ? `${secHead('Continue reading', nextUp.length > 1 ? '#/continue' : '')}<ul class="shelf">${nextUp.slice(0, 12).map((it) =>
      shelfItem({ ...it, title: it.name, line2: `#${pos(it.num)} · ${esc(it.sub)}` })).join('')}</ul>` : ''}
    ${secHead('For you', recs?.items.length ? '#/recs' : '', recs?.items.length > 1 ? sortMenu(sort, hasToken) : '')}
    ${recs?.items.length ? `<ul class="shelf">${recs.items.slice(0, 12).map((r) => shelfItem({ href: `#/rec/${r.hardcover_series_id}`, ck: null, fb: r.cover_url, title: r.name, seed: r.name, author: r.author,
      line2: r.rating ? `★ ${r.rating.toFixed(1)} · ${esc(r.author ?? '')}` : esc(r.author ?? ''),
      x: `<button class="shelf-x" data-click="rec-dismiss" data-hc="${r.hardcover_series_id}" aria-label="Not interested in ${esc(r.name)}">✕</button>` })).join('')}</ul>` : ''}${recsNote}`;
}

async function viewContinue() {
  const today = todayIso(), list = await collectNext(today);
  return `<p><a class="back" href="#/">← Home</a></p><div class="pagehead"><h1>Continue reading</h1><span class="meta">${list.length} series</span></div>
    ${list.length ? `<ul class="rows">${list.map((it) => upcomingRow(it, today)).join('')}</ul>` : '<p>Nothing waiting: every released book in your started series is read.</p>'}`;
}
async function viewRecs() {
  const hasToken = Boolean(await getSetting(store, 'hc_token', ''));
  const { recs, sort } = await sortedRecs();
  return `<p><a class="back" href="#/">← Home</a></p><div class="pagehead"><h1>For you</h1>${recs?.items.length ? sortMenu(sort, hasToken) : ''}</div>
    ${recs?.items.length ? `<ul class="cards">${recs.items.map(recCard).join('')}</ul>` : '<p class="meta">No suggestions right now.</p>'}`;
}

async function viewUpdates() {
  const list = (await updates(store)).sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '')).slice(0, 100);
  const unseen = list.filter((n) => !n.seen_at).length;
  const tone = { announced: 'near', date_changed: 'warn', released: 'ok' };
  const readOf = new Map(), rows = new Map((await store.all('series_book')).map((r) => [r.key, r]));
  const abooks = new Set((await store.all('author_book')).map((r) => r.key));
  for (const n of list) if (n.series_id != null && !readOf.has(n.series_id)) readOf.set(n.series_id, await maxRead(store, n.series_id));
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const groupOf = (n) => { const t = Date.parse(n.created_at ?? ''); return Number.isNaN(t) ? 'Earlier' : t >= start ? 'Today' : t >= start - 6 * 864e5 ? 'This week' : 'Earlier'; };
  const groups = [];
  for (const n of list) { const g = groupOf(n); (groups.find((x) => x.label === g) ?? groups[groups.push({ label: g, items: [] }) - 1]).items.push(n); }
  const card = (n) => {
    const w = when(n.release_date), row = n.series_id != null && n.position != null ? rows.get(sbKey(n.series_id, n.position)) : null;
    const canRead = n.kind === 'released' && row && !isRead(row, readOf.get(n.series_id));
    const href = row ? `#/book/${n.series_id}/${n.position}` : n.author_id != null
      ? (abooks.has(`${n.author_id}:${n.hardcover_book_id}`) ? `#/abook/${n.author_id}/${n.hardcover_book_id}` : `#/author/${n.author_id}`) : `#/series/${n.series_id}`;
    return `<li class="card ${canRead ? 'has-actions' : ''} ${n.seen_at ? '' : 'unseen'}" data-swipe="dismiss-update" data-key="${esc(n.key)}">
      <a class="cardlink" href="${href}">
      ${img(n.author_id != null ? null : (n.cover_key ?? `sb-${n.series_id}-${n.position}`), n.author_id != null ? n.cover_url : null, n.title ?? '', n.series_name)}
      <div class="body"><p><span class="chip ${tone[n.kind]}">${LABEL[n.kind]}</span>${n.seen_at ? '' : ' <span class="dot" aria-label="new"></span>'}</p>
      <h2>${n.position != null ? '#' + pos(n.position) + ' ' : ''}${esc(n.title)}</h2>
      <p class="meta">${esc(n.series_name)}${n.author_id != null ? ' · author' : ''}</p>
      <p class="meta">${n.kind === 'date_changed' ? `${esc(fmtDate(n.detail))} → ${esc(fmtDate(n.release_date))}` : `${esc(fmtDate(n.release_date))}${w.tone === 'tba' ? '' : ' · ' + esc(w.text)}`}</p>
</div></a>
      ${canRead ? `<div class="card-actions"><button class="small primary" data-click="toggle-read" data-id="${n.series_id}" data-pos="${n.position}" data-dismiss="${esc(n.key)}">Mark read</button></div>` : ''}
      <button class="card-x" data-click="dismiss-update" data-key="${esc(n.key)}" aria-label="Dismiss">✕</button></li>`;
  };
  return `<div class="pagehead"><h1>Updates</h1>${list.length ? `<details class="menu inline"><summary aria-label="Update actions">⋯</summary><div class="menu-items">
      ${unseen ? '<button data-click="mark-seen">Mark all seen</button>' : ''}<button data-click="dismiss-all">Clear all</button></div></details>` : ''}</div>
    ${list.length ? `<p class="meta swipe-hint">Swipe an update sideways to dismiss it.</p>${groups.map((g) => `${secHead(g.label, '')}<ul class="cards">${g.items.map(card).join('')}</ul>`).join('')}`
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

const MORE = [['appearance', 'Appearance', 'Theme and where “Get it” links go'], ['account', 'Hardcover account', 'Your API token'],
  ['data', 'Your data', 'Import, backup and restore, books to review'], ['stats', 'Reading stats', 'Books and pages read, series finished'],
  ['calendar', 'Release calendar', 'Add upcoming releases to your calendar'], ['advanced', 'Checking & advanced', 'Check now, background alerts, verify Hardcover']];
async function viewMore(sub) {
  const backupDue = (await store.all('series')).length + (await store.all('author')).length > 0
    && (Date.now() - Date.parse((await getSetting(store, 'last_backup', null)) ?? (await getSetting(store, 'first_seen', nowIso())))) > 30 * 864e5;
  const hasToken = Boolean(await getSetting(store, 'hc_token', ''));
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (sub === 'stats') return viewStats();
  if (sub === 'calendar') return viewCalendar();
  const page = MORE.find(([k]) => k === sub);
  if (!page) return `<div class="pagehead"><h1>More</h1></div>
    <ul class="menu-list">${MORE.map(([k, t, d]) => `<li><a href="#/more/${k}"><span><strong>${t}</strong><span class="meta">${d}</span></span>
      ${(k === 'data' && backupDue) || (k === 'account' && !hasToken) ? '<span class="dot" aria-label="needs attention"></span>' : ''}<span class="chev" aria-hidden="true">›</span></a></li>`).join('')}</ul>
    ${standalone ? '' : `<section class="panel"><h2>Install</h2><p class="meta">Android: browser menu → Install app / Add to Home screen. iPhone: Share → Add to Home Screen (needed so iOS keeps your data).</p>
      ${installPrompt ? '<p><button data-click="install">Install app</button></p>' : ''}</section>`}
    <p class="meta center">Series Tracker · v12</p>`;
  const head = `<p><a class="back" href="#/more">← More</a></p><div class="pagehead"><h1>${page[1]}</h1></div>`;
  if (sub === 'appearance') {
    const shopPref = await getSetting(store, 'store', 'hardcover');
    return `${head}<section class="panel"><h2>Theme</h2><div class="seg" role="group" aria-label="Theme">
      ${THEMES.map((t) => `<button data-click="theme" data-value="${t}" aria-pressed="${theme === t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div></section>
    <section class="panel"><h2>Where to get books</h2><div class="seg" role="group" aria-label="Store">
      ${Object.entries(STORES).map(([k, v]) => `<button data-click="set-store" data-value="${k}" aria-pressed="${shopPref === k}">${v}</button>`).join('')}</div>
      <p class="meta">“Get it” and “Pre-order” links on book pages and Home open a search here.</p></section>`;
  }
  if (sub === 'account') return `${head}<section class="panel">
      <p class="meta">${hasToken ? 'A token is saved on this phone.' : 'Needed for matching, search and checks.'} It is stored only on this device and sent only to Hardcover. Tokens expire; paste a new one if you see “rejected”.</p>
      <form class="stack" data-form="token"><label>API token <input type="password" name="token" autocomplete="off" placeholder="${hasToken ? '•••••••• (saved)' : 'paste token'}"></label>
        <div class="inline"><button class="primary">Save token</button>${hasToken ? '<button type="button" class="danger" data-click="remove-token">Remove</button>' : ''}</div></form></section>`;
  if (sub === 'data') {
    const lastBackup = await getSetting(store, 'last_backup', null);
    return `${head}<section class="panel"><h2>Import</h2>
      <form class="stack" data-form="import-gr"><label>Goodreads export (goodreads_library_export.csv)<input type="file" name="file" accept=".csv,text/csv"></label>
        <button class="primary">Import Goodreads CSV</button></form>
      <p><button data-click="import-hc">Import from Hardcover</button></p>
      <p class="meta">Imports can take a few minutes: Hardcover allows 60 requests a minute.</p></section>
    <section class="panel"><h2>Backup</h2>
      <p class="meta">Your data lives only on this phone. Export a backup now and then (it does not include your token).</p>
      ${backupDue ? '<p class="flash">It has been over a month since your last backup.</p>' : ''}
      <p class="meta">Last backup: ${esc(ago(lastBackup))} · Storage: ${(await navigator.storage?.persisted?.()) ? 'protected from automatic clearing' : 'not guaranteed (the browser may clear it if space runs low)'}</p>
      <p><button class="${backupDue ? 'primary' : ''}" data-click="export">Export backup</button></p>
      <form class="stack" data-form="restore"><label>Restore from backup<input type="file" name="file" accept=".json,application/json"></label><button>Restore</button></form></section>
    <section class="panel"><h2>Books to sort out</h2><p><a href="#/review">Needs review</a> · <a href="#/manual">Add a book by hand</a></p></section>`;
  }
  const last = await getSetting(store, 'last_check', null);
  const canNotify = 'Notification' in window && 'serviceWorker' in navigator;
  return `${head}<section class="panel"><h2>Checking</h2>
      <p class="meta">${last ? 'Last checked ' + esc(ago(last)) : 'Not checked yet'}. The app checks when you open it (at most every 12 hours).</p>
      <p><button class="primary" data-click="check-now">Check now</button></p>
      ${canNotify ? `<p><button data-click="enable-alerts">Enable background alerts</button></p>
        <p class="meta">Android Chrome only, and only for the installed app; the browser decides when it runs. iPhone can't do this — open the app to check.</p>` : ''}</section>
    <section class="panel"><h2>Hardcover fields</h2>
      <p class="meta">The app's Hardcover queries were written from the public docs. This compares them with the live schema.</p>
      <p><button data-click="verify">Verify Hardcover fields</button></p><pre class="out" id="verify-out"></pre></section>`;
}

// ---- stats & calendar ------------------------------------------------------------------------
async function viewStats() {
  const today = todayIso(), sbs = await store.all('series_book'), series = await store.all('series');
  const readRows = [];
  const states = { reading: 0, waiting: 0, finished: 0, unstarted: 0, muted: 0 };
  for (const s of series) {
    const read = await maxRead(store, s.id), mine = sbs.filter((r) => r.series_id === s.id);
    for (const r of mine) if (isRead(r, read)) readRows.push({ ...r, author: s.author });
    states[seriesState(s, mine, read, today)]++;
  }
  const extra = (await store.all('author_book')).filter((r) => r.read);
  const byAuthor = new Map();
  for (const r of readRows) if (r.author) byAuthor.set(r.author, (byAuthor.get(r.author) ?? 0) + 1);
  const topAuthors = [...byAuthor.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6), maxA = topAuthors[0]?.[1] ?? 1;
  const byYear = new Map();
  for (const r of [...readRows, ...extra]) if (r.read_at) byYear.set(r.read_at.slice(0, 4), (byYear.get(r.read_at.slice(0, 4)) ?? 0) + 1);
  const pagesCache = await getSetting(store, 'pages_cache', {});
  const ids = [...new Set(readRows.map((r) => r.hardcover_book_id).filter(Boolean))];
  const missing = ids.filter((i) => !(i in pagesCache));
  const pages = ids.reduce((n, i) => n + (pagesCache[i] || 0), 0), known = ids.filter((i) => pagesCache[i]).length;
  if (missing.length && await getSetting(store, 'hc_token', '')) afterRender = async () => {     // look up page counts once, 60 books per request
    const cache = { ...pagesCache };
    try { for (let i = 0; i < missing.length; i += 60) { const got = await client.booksInfo(missing.slice(i, i + 60));
      for (const id of missing.slice(i, i + 60)) cache[id] = got.find((g) => g.hardcover_book_id === id)?.pages ?? 0; } } catch { /* partial is fine */ }
    await setSetting(store, 'pages_cache', cache);
    if (location.hash === '#/more/stats') await route();
  };
  const next12 = sbs.filter((r) => r.release_date && r.release_date.slice(0, 10) > today && r.release_date.slice(0, 10) <= `${+today.slice(0, 4) + 1}${today.slice(4)}`).length;
  const tile = (n, label) => `<div class="tile"><strong>${n.toLocaleString()}</strong><span>${label}</span></div>`;
  return `<p><a class="back" href="#/more">← More</a></p><div class="pagehead"><h1>Reading stats</h1></div>
    <div class="tiles">${tile(readRows.length + extra.length, 'books read')}${tile(pages, missing.length ? 'pages read (counting…)' : `pages read${known < ids.length ? '*' : ''}`)}
      ${tile(states.finished, 'series finished')}${tile(states.reading, 'series in progress')}${tile(states.waiting, 'waiting for the next book')}${tile(next12, 'releases in the next 12 months')}</div>
    ${known < ids.length && !missing.length ? `<p class="meta">* ${ids.length - known} books have no page count on Hardcover.</p>` : ''}
    ${topAuthors.length ? `${secHead('Most-read authors', '')}<ul class="bars">${topAuthors.map(([n, c]) => `<li><span class="bl">${esc(n)}</span><span class="bb"><i style="width:${Math.round(100 * c / maxA)}%"></i></span><span class="bn">${c}</span></li>`).join('')}</ul>` : ''}
    ${byYear.size ? `${secHead('Marked read, by year', '')}<ul class="bars">${[...byYear.entries()].sort().reverse().map(([y, c]) => `<li><span class="bl">${y}</span><span class="bb"><i style="width:${Math.round(100 * c / Math.max(...byYear.values()))}%"></i></span><span class="bn">${c}</span></li>`).join('')}</ul>
      <p class="meta">Counts books from when you mark them read in this app; books imported from Goodreads or Hardcover have no date.</p>` : ''}`;
}

async function calendarItems(includeEstimated) {
  const today = todayIso(), out = [];
  const series = new Map((await store.all('series')).map((s) => [s.id, s]));
  for (const r of await store.all('series_book')) {
    const s = series.get(r.series_id);
    if (!s || s.muted || !r.release_date || r.release_date.slice(0, 10) <= today) continue;
    const est = isEstimated(r.release_date, today);
    if (est && !includeEstimated) continue;
    out.push({ uid: `s${s.hardcover_series_id}-${r.hardcover_book_id ?? r.position}`, date: r.release_date.slice(0, 10), estimated: est,
      title: `${r.title} (${s.name} #${pos(r.position)})`, description: `${s.author ?? ''}${est ? '\nYear only: the exact date is not known yet.' : ''}` });
  }
  const authors = new Map((await store.all('author')).map((a) => [a.hardcover_author_id, a]));
  const inSeries = new Set([...out.map((o) => o.uid)]);
  for (const r of await store.all('author_book')) {
    const a = authors.get(r.author_id);
    if (!a || a.muted || r.dismissed || !r.release_date || r.release_date.slice(0, 10) <= today || (r.series_id && [...series.values()].some((s) => s.hardcover_series_id === r.series_id))) continue;
    const est = isEstimated(r.release_date, today);
    if (est && !includeEstimated) continue;
    const uid = `a${r.author_id}-${r.hardcover_book_id}`;
    if (!inSeries.has(uid)) out.push({ uid, date: r.release_date.slice(0, 10), estimated: est, title: `${r.title} (${a.name})`, description: a.name });
  }
  return out.sort((x, y) => x.date.localeCompare(y.date));
}
async function viewCalendar() {
  const exact = await calendarItems(false), all = await calendarItems(true);
  return `<p><a class="back" href="#/more">← More</a></p><div class="pagehead"><h1>Release calendar</h1></div>
    <section class="panel"><p>${exact.length} upcoming release${exact.length === 1 ? '' : 's'} with an exact date${all.length > exact.length ? `, plus ${all.length - exact.length} with only a year` : ''}.</p>
      <p><button class="primary" data-click="ics" data-est="">Download calendar file</button></p>
      ${all.length > exact.length ? '<p><button data-click="ics" data-est="1">Include year-only estimates</button></p>' : ''}
      <p class="meta">Open the downloaded <strong>.ics</strong> file and your calendar app adds all-day events. Download again after new announcements:
        each book keeps the same ID, so most calendar apps update the event instead of adding a duplicate.</p></section>
    ${exact.length ? `${secHead('Next up', '')}<ul class="rows">${exact.slice(0, 8).map((it) => `<li><div class="grow"><strong>${esc(it.title)}</strong><br><span class="meta">${esc(fmtDate(it.date))}</span></div></li>`).join('')}</ul>` : ''}`;
}

// ---- router -----------------------------------------------------------------------------------
async function route() {
  const [path, qs = ''] = location.hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(qs);
  const [, seg, arg] = path.split('/');
  const tab = { '': 'home', upcoming: 'home', following: 'following', series: 'following', book: 'following', author: 'following', abook: 'following', rec: 'home', recs: 'home', continue: 'home', search: 'search', updates: 'updates' }[seg ?? ''] ?? 'more';
  let html;
  try {
    html = await ({ '': viewHome, series: () => viewSeries(arg), book: () => viewBook(arg, path.split('/')[3]), author: () => viewAuthor(arg), abook: () => viewAuthorBook(arg, path.split('/')[3]), rec: () => viewRec(arg, params), recs: viewRecs, continue: viewContinue, upcoming: viewUpcoming, following: viewFollowing, search: () => viewSearch(params), updates: viewUpdates,
      manual: viewManual, review: () => viewReview(params), more: () => viewMore(arg) }[seg ?? ''] ?? viewHome)();
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
const needToken = async () => { if (await getSetting(store, 'hc_token', '')) return false; toast('Add your Hardcover token first (More → Hardcover account).', { error: true }); return true; };

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
  async 'search-tab'(el) {
    for (const b of document.querySelectorAll('[data-click="search-tab"]')) { const on = b === el; b.setAttribute('aria-selected', on); b.setAttribute('aria-pressed', on); }
    for (const p of document.querySelectorAll('.tabpanel')) p.hidden = p.dataset.panel !== el.dataset.value;
  },
  async ics(el) {
    const items = await calendarItems(Boolean(el.dataset.est));
    if (!items.length) return toast('No upcoming releases to export.', { error: true });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([buildIcs(items)], { type: 'text/calendar' })), download: 'book-releases.ics' });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`Calendar file with ${items.length} release${items.length > 1 ? 's' : ''} downloaded.`);
  },
  async back() { if (history.length > 1) history.back(); else location.hash = '#/'; },
  async 'follow-sort'(el) { await setSetting(store, 'follow_sort', el.dataset.value); await route(); },
  async 'follow-filter'(el) { await setSetting(store, 'follow_filter', el.dataset.value); await route(); },
  async 'recs-sort'(el) { await setSetting(store, 'recs_sort', el.dataset.value); await route(); },
  async 'rec-dismiss'(el) {
    await dismissRec(store, Number(el.dataset.hc));
    if (el.dataset.home) location.hash = '#/'; else await route();
    const left = (await loadRecs(store))?.items.length ?? 0;
    if (left < 10 && (await getSetting(store, 'hc_token', ''))) {        // running low: widen the search for more, then redraw Home
      try { await buildRecs(store, client, { genres: 5 }); if (!location.hash || location.hash === '#/') await route(); } catch { /* keep what is left */ }
    }
  },
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
  async 'toggle-read'(el) {
    const on = await toggleRead(store, Number(el.dataset.id), Number(el.dataset.pos));
    if (on && el.dataset.dismiss) await dismissUpdate(store, el.dataset.dismiss);
    await route();
  },
  async 'toggle-aread'(el) {
    const row = await store.get('author_book', `${el.dataset.aid}:${el.dataset.bid}`);
    if (row) await store.put('author_book', { ...row, read: !row.read });
    await route();
  },
  async 'set-store'(el) { await setSetting(store, 'store', el.dataset.value); toast(`Links go to ${STORES[el.dataset.value]}.`, { ms: 2500 }); await route(); },
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
    let txt = bad.length ? 'Missing fields:\n' + bad.map(([t, m]) => `${t}: ${m.join(', ')}`).join('\n') : 'All expected fields exist.';
    try {                                                           // show what Hardcover's tag data looks like for one of your read books
      const ids = (await store.all('series_book')).filter((r) => r.hardcover_book_id && r.read !== false).slice(0, 3).map((r) => r.hardcover_book_id);
      const [b] = await client.bookTags(ids);
      txt += b ? `\n\nTag data for book ${b.id}:\ncategories: ${b.categories.join(', ') || '(none)'}\ngenres: ${b.genres.slice(0, 5).map((g) => `${g.name ?? g.slug} (${g.count})`).join(', ') || '(none)'}\ntags: ${b.tags.slice(0, 8).map((g) => `${g.name ?? g.slug} (${g.count})`).join(', ') || '(none)'}` : '\n\nNo book to sample tags from yet.';
    } catch (e) { txt += `\n\nTag sample failed: ${msg(e)}`; }
    out.textContent = txt;
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
// Swipe a [data-swipe] row/card sideways (> 90 px, mostly horizontal) to run its action: mark read / dismiss.
let swipe = null;
document.addEventListener('touchstart', (e) => {
  const el = e.target.closest('[data-swipe]');
  if (!el || e.touches.length !== 1 || e.target.closest('button, details, input')) { swipe = null; return; }
  swipe = { el, x: e.touches[0].clientX, y: e.touches[0].clientY, dx: 0, locked: null };
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  if (!swipe) return;
  const dx = e.touches[0].clientX - swipe.x, dy = e.touches[0].clientY - swipe.y;
  if (swipe.locked === null && Math.hypot(dx, dy) > 10) swipe.locked = Math.abs(dx) > Math.abs(dy) * 1.5;
  if (!swipe.locked) return;
  swipe.dx = dx; swipe.el.classList.add('swiping');
  swipe.el.style.transform = `translateX(${dx}px)`; swipe.el.style.opacity = String(Math.max(.35, 1 - Math.abs(dx) / 300));
}, { passive: true });
document.addEventListener('touchend', () => {
  if (!swipe) return;
  const { el, dx, locked } = swipe; swipe = null;
  el.classList.remove('swiping');
  if (locked && Math.abs(dx) > 90) {
    el.style.transform = `translateX(${dx > 0 ? 110 : -110}%)`; el.style.opacity = '0';
    setTimeout(() => guarded(null, () => clickActions[el.dataset.swipe](el)), 160);
  } else { el.style.transform = ''; el.style.opacity = ''; }
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
