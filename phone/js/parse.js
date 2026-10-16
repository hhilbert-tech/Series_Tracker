// Goodreads CSV parsing: series-in-title regex and ISBN cleaning.
export const SERIES_RE = /^(.*?)\s*\(([^()]+?),?\s*#(\d+(?:\.\d+)?)\)\s*$/;
const READ_SHELVES = new Set(['read', 'currently-reading']);

export function parseTitle(raw) {
  const m = SERIES_RE.exec(raw ?? '');
  if (!m) return { title: raw, series: null, position: null };
  return { title: m[1].trim(), series: m[2].trim(), position: parseFloat(m[3]) };
}

// `="9780765326355"` -> `9780765326355`; empty/null -> ''
export function cleanIsbn(raw) {
  return (raw ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();
}

// Minimal RFC 4180 parser: quoted fields, "" escapes, embedded newlines, CRLF, BOM.
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

export function parseGoodreadsCsv(text) {
  const [head = [], ...body] = parseCsv(text);
  const col = Object.fromEntries(head.map((h, i) => [h.trim(), i]));
  const get = (r, name) => (col[name] === undefined ? '' : (r[col[name]] ?? '')).trim();
  const out = [];
  for (const r of body) {
    const rawTitle = get(r, 'Title');
    if (!rawTitle) continue;
    const p = parseTitle(rawTitle);
    const shelf = get(r, 'Exclusive Shelf');
    out.push({
      title: p.title, series: p.series, position: p.position, author: get(r, 'Author'),
      isbn: cleanIsbn(get(r, 'ISBN')), isbn13: cleanIsbn(get(r, 'ISBN13')),
      shelf, read: READ_SHELVES.has(shelf),
    });
  }
  return out;
}
