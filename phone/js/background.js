// Background check, run by the service worker on a periodic-sync event (Android Chrome, installed app).
import { openIdbStore } from './store-idb.js';
import { HardcoverClient } from './hardcover.js';
import { runCheck } from './check.js';
import { getSetting, setSetting, nowIso } from './db.js';

export async function runBackgroundCheck(registration) {
  const store = await openIdbStore();
  const token = await getSetting(store, 'hc_token', '');
  if (!token) return;
  const client = new HardcoverClient({ getToken: () => token });
  const res = await runCheck(store, client);
  await setSetting(store, 'last_check', nowIso());
  if (!res.events.length) return;
  const first = res.events[0];
  const more = res.events.length > 1 ? ` (+${res.events.length - 1} more)` : '';
  await registration.showNotification('Book Finder', {
    body: `${{ released: 'Out now', announced: 'Announced', date_changed: 'New date', dated: 'Date announced' }[first.kind] ?? 'Update'} · ${first.series_name}: ${first.position != null ? '#' + first.position + ' ' : ''}${first.title}${more}`,
    icon: 'icons/icon-192.png', tag: 'series-update', data: { url: './#/updates' },
  });
}
