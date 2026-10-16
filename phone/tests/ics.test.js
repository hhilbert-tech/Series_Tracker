import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIcs } from '../js/ics.js';
import { ago } from '../js/format.js';

test('buildIcs: all-day events, escaped text, stable UIDs, CRLF, folded long lines', () => {
  const ics = buildIcs([{ uid: 's1-9', date: '2026-11-03', title: 'War, of the Gods; #4', description: 'line1\nline2' },
    { uid: 's2-1', date: '2027-01-01', title: 'X'.repeat(120), estimated: true }], '2026-10-16T18:00:00.000Z');
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(ics.includes('UID:s1-9@series-tracker'));
  assert.ok(ics.includes('DTSTART;VALUE=DATE:20261103') && ics.includes('DTEND;VALUE=DATE:20261104'));
  assert.ok(ics.includes('SUMMARY:War\\, of the Gods\; #4'));
  assert.ok(ics.includes('DESCRIPTION:line1\\nline2'));
  assert.ok(ics.includes('SUMMARY:(est.) XXX'));
  for (const line of ics.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, line);
  assert.equal((ics.match(/BEGIN:VEVENT/g) ?? []).length, 2);
});

test('ago: relative wording for recent stamps, a date for old ones', () => {
  const now = Date.parse('2026-10-16T18:00:00Z');
  assert.equal(ago(null, now), 'never');
  assert.equal(ago('2026-10-16T17:59:40Z', now), 'just now');
  assert.equal(ago('2026-10-16T17:30:00Z', now), '30 min ago');
  assert.ok(/^today /.test(ago('2026-10-16T10:00:00Z', now)) || /^yesterday /.test(ago('2026-10-16T10:00:00Z', now)));
  assert.ok(/2026/.test(ago('2026-09-01T10:00:00Z', now)));
});
