// Calendar export: upcoming releases as an iCalendar (.ics) file of all-day events. Pure; unit-tested.
const escText = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// RFC 5545: lines longer than 75 octets are folded (continuation lines start with a space).
function fold(line) {
  const out = []; let cur = '';
  for (const ch of line) { if (new TextEncoder().encode(cur + ch).length > 75) { out.push(cur); cur = ' ' + ch; } else cur += ch; }
  return [...out, cur].join('\r\n');
}
const ymd = (d) => d.slice(0, 10).replace(/-/g, '');
function nextDay(d) { const t = new Date(d.slice(0, 10) + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); }

// items: [{uid, date: 'YYYY-MM-DD', title, description?, estimated?}]
export function buildIcs(items, stamp = new Date().toISOString()) {
  const dtstamp = stamp.replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Series Tracker//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Book releases'];
  for (const it of items) {
    lines.push('BEGIN:VEVENT', `UID:${it.uid}@series-tracker`, `DTSTAMP:${dtstamp}`, `DTSTART;VALUE=DATE:${ymd(it.date)}`, `DTEND;VALUE=DATE:${ymd(nextDay(it.date))}`,
      fold(`SUMMARY:${escText((it.estimated ? '(est.) ' : '') + it.title)}`), ...(it.description ? [fold(`DESCRIPTION:${escText(it.description)}`)] : []), 'TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
