// The document scanner's maths: find the sheet, straighten it, write a valid PDF.
import { test } from 'node:test';
import assert from 'node:assert/strict';

class ImageDataPolyfill { width: number; height: number; data: Uint8ClampedArray; constructor(w: number, h: number) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } }
(globalThis as unknown as { ImageData: unknown }).ImageData ??= ImageDataPolyfill;
const { findSheet, warp, cleanUp, pagesToPdf } = await import('../src/renderer/scan/geometry.ts');

/** A dark desk with a white sheet whose corners are given (a convex quad). */
function photo(w: number, h: number, quad: Array<[number, number]>): ImageData {
  const img = new ImageData(w, h);
  const inside = (x: number, y: number) => quad.every(([ax, ay], i) => { const [bx, by] = quad[(i + 1) % 4]; return (bx - ax) * (y - ay) - (by - ay) * (x - ax) >= 0; });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    const v = inside(x, y) ? 235 : 50 + ((x * 7 + y * 3) % 20);
    img.data[o] = img.data[o + 1] = img.data[o + 2] = v; img.data[o + 3] = 255;
  }
  return img;
}

test('finds a tilted sheet on a desk', () => {
  const corners: Array<[number, number]> = [[60, 40], [250, 60], [230, 300], [40, 280]];
  const q = findSheet(photo(300, 340, corners));
  q.forEach((p, i) => {
    assert.ok(Math.hypot(p.x - corners[i][0], p.y - corners[i][1]) < 6, `corner ${i}: ${JSON.stringify(p)} vs ${corners[i]}`);
  });
});

test('nothing light enough: an inset frame to drag', () => {
  const q = findSheet(photo(200, 200, [[0, 0], [1, 0], [1, 1], [0, 1]]));
  assert.ok(q[0].x > 10 && q[2].x < 190);
});

test('straightening maps the corners to the page corners; clean-up whitens paper', () => {
  const corners: Array<[number, number]> = [[60, 40], [250, 60], [230, 300], [40, 280]];
  const img = photo(300, 340, corners);
  const page = warp(img, corners.map(([x, y]) => ({ x, y })) as never, 120, 170);
  assert.equal(page.width, 120);
  const at = (x: number, y: number) => page.data[(y * 120 + x) * 4];
  for (const [x, y] of [[5, 5], [114, 5], [114, 164], [5, 164], [60, 85]]) assert.ok(at(x, y) > 200, `paper at ${x},${y}: ${at(x, y)}`);
  const clean = cleanUp(page);
  assert.ok(clean.data[(85 * 120 + 60) * 4] > 240);
});

test('PDF: one A4 page per scan, offsets that match', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  const pdf = pagesToPdf([{ jpeg, width: 1240, height: 1754 }, { jpeg, width: 1754, height: 1240 }]);
  const text = new TextDecoder('latin1').decode(pdf);
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.match(text, /\/Count 2/);
  assert.match(text, /\/MediaBox \[0 0 595 842\]/);
  assert.match(text, /\/MediaBox \[0 0 842 595\]/);
  const xref = Number(text.match(/startxref\n(\d+)/)![1]);
  assert.ok(text.slice(xref).startsWith('xref'));
  const rows = text.slice(xref).split('\n').slice(3, 9);
  rows.forEach((r, i) => assert.ok(text.slice(Number(r.slice(0, 10))).startsWith(`${i + 1} 0 obj`), `object ${i + 1}`));
});
