// Date display helpers (pure; unit-tested).
import { todayIso } from './db.js';

// Publishers often list a year-only release as 1 January. A future Jan 1 is shown as an estimate.
export const isEstimated = (d, today = todayIso()) => /^\d{4}-01-01/.test(d ?? '') && d.slice(0, 10) > today;

export function fmtDate(d, today = todayIso()) {
  if (!d) return 'Date TBA';
  if (isEstimated(d, today)) return `${d.slice(0, 4)} (est.)`;
  const t = new Date(d.slice(0, 10) + 'T00:00:00');
  return Number.isNaN(t.getTime()) ? d : t.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// "in 3 weeks" / "Out now" plus a tone for the chip colour; estimated dates read "in ~15 months".
export function when(d, today = todayIso()) {
  if (!d) return { text: 'Date TBA', tone: 'tba' };
  const n = Math.round((new Date(d.slice(0, 10) + 'T00:00:00') - new Date(today + 'T00:00:00')) / 864e5);
  if (Number.isNaN(n)) return { text: 'Date TBA', tone: 'tba' };
  const est = isEstimated(d, today) ? '~' : '';
  if (n < 0) return { text: 'Out now', tone: 'ok' };
  if (n === 0) return { text: 'Today', tone: 'soon' };
  if (n <= 30) return { text: `in ${est}${n} day${n > 1 ? 's' : ''}`, tone: 'soon' };
  if (n < 90) return { text: `in ${est}${Math.round(n / 7)} weeks`, tone: 'near' };
  if (n < 730) return { text: `in ${est}${Math.round(n / 30.4)} months`, tone: 'far' };
  return { text: `in ${est}${Math.round(n / 365)} years`, tone: 'far' };
}

// "Get it" links for the store chosen in More (default: the Hardcover search page).
export const STORES = { hardcover: 'Hardcover', amazon: 'Amazon', kobo: 'Kobo', google: 'Google Books' };
export function storeLink(store, title, author = '') {
  const q = encodeURIComponent([title, author].filter(Boolean).join(' '));
  return ({ amazon: `https://www.amazon.es/s?k=${q}&i=stripbooks`, kobo: `https://www.kobo.com/es/en/search?query=${q}`,
    google: `https://www.google.com/search?tbm=bks&q=${q}` }[store]) ?? `https://hardcover.app/search?q=${q}`;
}

// A stored timestamp (ISO, UTC) for people: "just now", "5 min ago", "today 20:31", "yesterday 08:10", "12 Oct 2026".
export function ago(iso, now = Date.now()) {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso);
  const d = new Date(t), mins = Math.round((now - t) / 6e4);
  if (mins >= 0 && mins < 1) return 'just now';
  if (mins >= 0 && mins < 60) return `${mins} min ago`;
  const hm = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const day = (x) => new Date(x).toDateString(), n = new Date(now);
  if (day(t) === day(now)) return `today ${hm}`;
  if (day(t) === day(new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1))) return `yesterday ${hm}`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
