import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTitle, cleanIsbn, parseCsv, parseGoodreadsCsv } from '../js/parse.js';

// Acceptance test 1
test('series and position', () => {
  assert.deepEqual(parseTitle('The Way of Kings (The Stormlight Archive, #1)'),
    { title: 'The Way of Kings', series: 'The Stormlight Archive', position: 1 });
});
test('decimal position', () => {
  assert.deepEqual(parseTitle('Edgedancer (The Stormlight Archive, #2.5)'),
    { title: 'Edgedancer', series: 'The Stormlight Archive', position: 2.5 });
});
test('no series', () => {
  for (const raw of ['Piranesi', 'Foo (Bar)', 'Dune (Deluxe Edition)']) {
    assert.deepEqual(parseTitle(raw), { title: raw, series: null, position: null });
  }
});

// Acceptance test 2
test('isbn cleaner', () => {
  assert.equal(cleanIsbn('="9780765326355"'), '9780765326355');
  assert.equal(cleanIsbn(''), '');
  assert.equal(cleanIsbn('=""'), '');
  assert.equal(cleanIsbn(null), '');
});

test('csv parser handles quotes, commas, newlines, BOM and CRLF', () => {
  const text = '﻿a,b,c\r\n1,"x, ""y""",3\r\n"multi\nline",,\r\n';
  assert.deepEqual(parseCsv(text), [['a', 'b', 'c'], ['1', 'x, "y"', '3'], ['multi\nline', '', '']]);
});

test('goodreads rows and read flag', () => {
  const text = [
    'Title,Author,ISBN,ISBN13,Exclusive Shelf,Date Read,My Rating',
    '"A (S, #1)",Au,"=""0765326353""","=""9780765326355""",read,2020/01/02,5',
    '"B (S, #2)",Au,"=""""","=""""",currently-reading,,0',
    '"C (S, #3)",Au,,,to-read,,0',
  ].join('\n');
  const rows = parseGoodreadsCsv(text);
  assert.deepEqual(rows.map((r) => r.read), [true, true, false]);
  assert.equal(rows[0].isbn13, '9780765326355');
  assert.equal(rows[1].isbn13, '');
  assert.equal(rows[0].series, 'S');
  assert.equal(rows[0].position, 1);
});
