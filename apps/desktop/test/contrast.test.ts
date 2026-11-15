// Colour contrast: every text colour the interface uses reads at WCAG AA (4.5:1) on every surface
// it sits on, in the light and the dark theme. The colours come straight from styles.css.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const css = fs.readFileSync(path.join(import.meta.dirname, '../src/renderer/styles.css'), 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `${selector} block in styles.css`);
  const body = css.slice(start, css.indexOf('\n}', start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
const light = block(':root');
const dark = { ...light, ...block(":root[data-theme='dark']") };

type RGBA = [number, number, number, number];
function colour(v: string): RGBA {
  const hex = v.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1) as RGBA;
  const rgba = v.match(/^rgba?\(([^)]+)\)$/);
  assert.ok(rgba, `a colour: ${v}`);
  const [r, g, b, a = '1'] = rgba[1].split(',').map((x) => x.trim());
  return [Number(r), Number(g), Number(b), Number(a)];
}
const over = (top: RGBA, base: RGBA): RGBA => [0, 1, 2].map((i) => top[i] * top[3] + base[i] * (1 - top[3])).concat(1) as RGBA;
const lum = (c: RGBA) => {
  const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const ratio = (a: RGBA, b: RGBA) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

for (const [name, t] of [['light', light], ['dark', dark]] as const) {
  test(`${name} theme: text colours pass AA on the window, layers, cards and tinted rows`, () => {
    const win = colour(t.window);
    const solid = colour(t['layer-solid']);
    const layer = over(colour(t.layer), win);
    const surfaces: Record<string, RGBA> = {
      window: win, 'layer-solid': solid, layer, card: over(colour(t.card), layer),
      subtle: over(colour(t.subtle), solid), 'accent-soft': over(colour(t['accent-soft']), solid), 'amber-soft': over(colour(t['amber-soft']), solid),
    };
    const fails: string[] = [];
    for (const ink of ['text', 'text-2', 'text-3', 'accent-ink', 'amber-ink', 'danger']) {
      for (const [s, bg] of Object.entries(surfaces)) {
        const r = ratio(colour(t[ink]), bg);
        if (r < 4.5) fails.push(`--${ink} on ${s}: ${r.toFixed(2)}`);
      }
    }
    // status colours on their own tint (chips: "Connected", "Not sent")
    for (const [ink, soft] of [['ok', 'ok-soft'], ['danger', 'danger-soft'], ['accent-ink', 'accent-soft']]) {
      const r = ratio(colour(t[ink]), over(colour(t[soft]), solid));
      if (r < 4.5) fails.push(`--${ink} on --${soft}: ${r.toFixed(2)}`);
    }
    // buttons: their label on the accent
    const r = ratio(colour(t['accent-text']), colour(t.accent));
    if (r < 4.5) fails.push(`--accent-text on --accent: ${r.toFixed(2)}`);
    assert.deepEqual(fails, []);
  });
}
