import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CSS = readFileSync(new URL('../css/style.css', import.meta.url), 'utf8');
const tokens = (block) => Object.fromEntries([...block.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
const light = tokens(/:root\s*\{([^}]*)\}/.exec(CSS)[1]);
const media = tokens(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([^}]*)\}/.exec(CSS)[1]);
const forced = tokens(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/.exec(CSS)[1]);

const lum = (h) => {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const PAIRS = [['--text', '--bg'], ['--text', '--surface'], ['--muted', '--bg'], ['--muted', '--surface'],
  ['--accent', '--bg'], ['--accent', '--surface'], ['--on-accent', '--accent'], ['--danger', '--surface']];

test('dark values are identical for the media query and the manual override', () => {
  assert.ok(Object.keys(media).length > 0); assert.deepEqual(media, forced);
});
for (const [name, t] of [['light', light], ['dark', media]]) {
  test(`${name} theme meets WCAG AA (4.5:1)`, () => {
    for (const [fg, bg] of PAIRS) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${fg}/${bg} ${ratio(t[fg], t[bg]).toFixed(2)}`);
  });
}
test('light and dark differ', () => assert.notEqual(light['--bg'], media['--bg']));
