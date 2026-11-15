// The PDF viewer's tiling and layout: big drawing sheets are drawn at screen resolution in tiles
// covering only what is in view, within a fixed pixel budget; zooming keeps the point under the
// pointer still; search highlights land on the words they match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_MAX_PX, PDF_TO_CSS, PIXEL_BUDGET, SINGLE_MAX_PX, SINGLE_MAX_SIDE, TILE_PX, ZOOM_MAX, ZOOM_MIN,
  anchorAt, clampZoom, currentPage, evict, fitPageZoom, fitWidthZoom, layoutPages, minZoomFor, pagesInView, paperName, planPage,
  rotatedSize, scrollForAnchor, stepZoom, tilesFor, visibleInPage,
} from '../src/renderer/pdf/tiles.ts';
import { copyText, findMatches, matchBoxes, matchSegments, pageText, queryPattern } from '../src/renderer/pdf/textsearch.ts';

const A0 = { w: 2384, h: 3370 }; // points: 841 x 1189 mm
const A1 = { w: 1684, h: 2384 };
const A4 = { w: 595, h: 842 };

test('an A4 page on screen is one canvas; an A0 sheet at 1:1 is tiled, never one giant canvas', () => {
  const a4 = planPage(A4.w * PDF_TO_CSS, A4.h * PDF_TO_CSS, 2);
  assert.equal(a4.mode, 'single');
  for (const dpr of [1, 1.25, 2, 3]) {
    const p = planPage(A0.w * PDF_TO_CSS, A0.h * PDF_TO_CSS, dpr); // 100% = real paper size
    assert.equal(p.mode, 'tiled', `A0 at 100% and ${dpr}x`);
    if (p.mode !== 'tiled') continue;
    assert.ok(p.baseW * p.baseH <= BASE_MAX_PX, 'the stand-in under the tiles is small');
    assert.ok(Math.max(p.baseW, p.baseH) <= SINGLE_MAX_SIDE);
    assert.equal(p.devW, Math.round(A0.w * PDF_TO_CSS * dpr));
  }
  // nothing drawn as a single canvas is ever bigger than the limits
  for (const z of [0.25, 0.5, 1, 2, 4, 8]) for (const s of [A0, A1, A4]) for (const dpr of [1, 2]) {
    const p = planPage(s.w * PDF_TO_CSS * z, s.h * PDF_TO_CSS * z, dpr);
    if (p.mode === 'single') { assert.ok(p.devW * p.devH <= SINGLE_MAX_PX); assert.ok(Math.max(p.devW, p.devH) <= SINGLE_MAX_SIDE); }
  }
  // a hostile pixel ratio is tamed
  assert.equal(planPage(100, 100, Number.NaN).devW, 100);
  assert.equal(planPage(100, 100, 50).devW, 400);
});

test('tiles cover exactly what is in view, at most TILE_PX square, clipped to the sheet', () => {
  const dpr = 2;
  const z = 8; // 800% on A0
  const devW = Math.round(A0.w * PDF_TO_CSS * z * dpr);
  const devH = Math.round(A0.h * PDF_TO_CSS * z * dpr);
  const view = { x: 41_000, y: 60_000, w: 1280 * dpr, h: 800 * dpr };
  const tiles = tilesFor(devW, devH, view);
  assert.ok(tiles.length > 0 && tiles.length <= (Math.ceil(view.w / TILE_PX) + 1) * (Math.ceil(view.h / TILE_PX) + 1));
  let area = 0;
  for (const t of tiles) {
    assert.ok(t.w > 0 && t.w <= TILE_PX && t.h > 0 && t.h <= TILE_PX);
    assert.ok(t.x + t.w <= devW && t.y + t.h <= devH);
    area += t.w * t.h;
  }
  assert.ok(area <= PIXEL_BUDGET, 'a screenful of tiles fits the budget');
  // every pixel of the view is in a tile
  for (const [px, py] of [[view.x, view.y], [view.x + view.w - 1, view.y + view.h - 1], [view.x + 700, view.y + 333]]) {
    assert.equal(tiles.filter((t) => px >= t.x && px < t.x + t.w && py >= t.y && py < t.y + t.h).length, 1);
  }
  // the sheet's edge: tiles are cut to the paper
  const edge = tilesFor(2500, 1500, { x: 0, y: 0, w: 2500, h: 1500 });
  assert.equal(edge.length, 6);
  assert.deepEqual(edge.at(-1), { col: 2, row: 1, x: 2048, y: 1024, w: 452, h: 476 });
  // nothing in view, nothing drawn; a view off the sheet draws nothing
  assert.equal(tilesFor(2500, 1500, { x: 3000, y: 0, w: 100, h: 100 }).length, 0);
});

test('the pixel budget drops what is out of view first, then the least recently used', () => {
  const items = [
    { key: 'a', pixels: 20e6, needed: true, lastUsed: 5 },
    { key: 'b', pixels: 10e6, needed: false, lastUsed: 9 },
    { key: 'c', pixels: 10e6, needed: false, lastUsed: 1 },
    { key: 'd', pixels: 15e6, needed: true, lastUsed: 2 },
  ];
  assert.deepEqual(evict(items, 40e6), ['c', 'b']);
  assert.deepEqual(evict(items, 20e6), ['c', 'b', 'd']);
  assert.deepEqual(evict(items, 100e6), []);
});

test('pages stack under one another, centred, and only those near the view are drawn', () => {
  const sizes = [A4, A4, A1, A4];
  const l = layoutPages(sizes, 1, 0, 1000);
  assert.equal(l.boxes.length, 4);
  assert.equal(l.width, Math.round(A1.w * PDF_TO_CSS) + 32, 'the widest page sets the width');
  assert.equal(l.boxes[0].x, Math.round((l.width - Math.round(A4.w * PDF_TO_CSS)) / 2));
  assert.equal(l.boxes[1].y, l.boxes[0].y + l.boxes[0].h + 16);
  assert.deepEqual(pagesInView(l, { x: 0, y: 0, w: 1000, h: 600 }), [0]);
  assert.deepEqual(pagesInView(l, { x: 0, y: l.boxes[1].y + 10, w: 1000, h: 600 }, 0), [1]);
  assert.deepEqual(pagesInView(l, { x: 0, y: l.boxes[1].y + 10, w: 1000, h: 600 }, 2000), [0, 1, 2]);
  assert.equal(currentPage(l, { x: 0, y: l.boxes[2].y + 100, w: 1000, h: 600 }), 2);
  // rotated a quarter turn, width and height swap
  assert.deepEqual(rotatedSize(A4, 90), { w: A4.h, h: A4.w });
  assert.deepEqual(rotatedSize(A4, -270), { w: A4.h, h: A4.w });
  const r = layoutPages([A4], 1, 90, 400);
  assert.equal(r.boxes[0].w, Math.round(A4.h * PDF_TO_CSS));
  // the part of a page in view
  assert.deepEqual(visibleInPage({ x: 100, y: 100, w: 500, h: 500 }, { x: 0, y: 300, w: 400, h: 1000 }), { x: 0, y: 200, w: 300, h: 300 });
  assert.equal(visibleInPage({ x: 100, y: 100, w: 500, h: 500 }, { x: 0, y: 700, w: 400, h: 100 }), null);
});

test('fit width, fit page and zoom steps stay within 25-800%', () => {
  const w = fitWidthZoom(A4, 0, 1280);
  assert.ok(Math.abs(A4.w * PDF_TO_CSS * w - (1280 - 32)) < 0.01);
  const p = fitPageZoom(A0, 0, 1280, 700);
  assert.ok(A0.h * PDF_TO_CSS * p <= 700 - 32 + 0.01 && A0.w * PDF_TO_CSS * p <= 1280 - 32 + 0.01);
  assert.ok(p < ZOOM_MIN, 'fit page goes below 25% when the sheet needs it');
  const phone = fitPageZoom(A0, 0, 390, 640);
  assert.ok(A0.w * PDF_TO_CSS * phone <= 390 - 32 + 0.01, 'an A0 sheet fits a phone');
  assert.equal(minZoomFor(p), p);
  assert.equal(minZoomFor(0.6), ZOOM_MIN);
  assert.equal(stepZoom(p, -1, p), p, 'zooming out stops at the whole sheet');
  assert.equal(stepZoom(p, 1, p), ZOOM_MIN);
  assert.equal(fitWidthZoom({ w: 20, h: 20 }, 0, 4000), ZOOM_MAX);
  assert.equal(clampZoom(Number.NaN), 1);
  assert.equal(stepZoom(1, 1), 1.1);
  assert.equal(stepZoom(1, -1), 0.9);
  assert.equal(stepZoom(1.18, 1), 1.25);
  assert.equal(stepZoom(8, 1), ZOOM_MAX);
  assert.equal(stepZoom(0.25, -1), ZOOM_MIN);
  assert.equal(paperName(A0), 'A0');
  assert.equal(paperName({ w: A1.h, h: A1.w }), 'A1');
  assert.equal(paperName({ w: 612, h: 792 }), 'ANSI A');
  assert.equal(paperName({ w: 500, h: 500 }), null);
});

test('zooming keeps the point under the pointer where it was', () => {
  const sizes = [A1, A1, A1];
  const view = { w: 1280, h: 800 };
  const before = layoutPages(sizes, 0.5, 0, view.w);
  const scroll = { left: 0, top: before.boxes[1].y + 120 };
  const a = anchorAt(before, scroll, 640, 400)!;
  assert.equal(a.page, 1);
  const after = layoutPages(sizes, 2, 0, view.w);
  const s = scrollForAnchor(after, a, view);
  const b = after.boxes[1];
  const back = before.boxes[1];
  // the same spot of the same page is under the pointer
  assert.ok(Math.abs((s.left + 640 - b.x) / b.w - (scroll.left + 640 - back.x) / back.w) < 1e-6);
  assert.ok(Math.abs((s.top + 400 - b.y) / b.h - (scroll.top + 400 - back.y) / back.h) < 1e-6);
  // never scrolled past the sheet
  const far = scrollForAnchor(after, { page: 2, fx: 1, fy: 1, vx: 0, vy: 0 }, view);
  assert.ok(far.top <= after.height - view.h && far.left <= after.width - view.w);
});

test('PDF text search: case, spaces and line breaks, Hindi, and boxes on the right words', () => {
  // two runs on one line, one on the next; 10 pt Helvetica-like widths
  const runs = [
    { str: 'PIPE RACK ', transform: [10, 0, 0, 10, 100, 700], width: 60, height: 10 },
    { str: 'PR-03', transform: [10, 0, 0, 10, 160, 700], width: 30, height: 10, hasEOL: true },
    { str: 'पाइप रैक', transform: [12, 0, 0, 12, 100, 680], width: 48, height: 12 },
  ];
  const p = pageText(runs);
  assert.equal(p.text, 'PIPE RACK PR-03\nपाइप रैक');
  assert.equal(findMatches(p, 'rack pr-03', 0).length, 1);
  assert.equal(findMatches(p, 'pr-03 पाइप', 0).length, 1, 'a space in the query matches a line break');
  assert.equal(findMatches(p, 'रैक', 4)[0].page, 4);
  assert.equal(findMatches(p, '(', 0).length, 0, 'the query is text, not a pattern');
  assert.equal(queryPattern('   '), null);
  const m = findMatches(p, 'k pr', 0)[0];
  assert.deepEqual(matchSegments(p, m.start, m.end), [{ run: 0, from: 8, to: 10 }, { run: 1, from: 0, to: 2 }]);
  // the box of "RACK" on a US Letter page: x from 100 + 5/10 * 60, baseline at y = 700
  const view = [0, 0, 612, 792];
  const rack = findMatches(p, 'RACK', 0)[0];
  const [box] = matchBoxes(p, rack, view);
  assert.ok(Math.abs(box.left * 612 - 130) < 0.01);
  assert.ok(Math.abs(box.width * 612 - 24) < 0.01);
  assert.ok(Math.abs((box.top + box.height) * 792 - (792 - 700 + 2)) < 0.01, 'the box reaches just below the baseline');
  // text turned a quarter turn (a vertical label on a drawing) gets an upright box around it
  const up = pageText([{ str: 'GRID A', transform: [0, 10, -10, 0, 50, 100], width: 36, height: 10 }]);
  const [ub] = matchBoxes(up, findMatches(up, 'GRID', 0)[0], view);
  assert.ok(ub.height * 792 > ub.width * 612, 'a vertical label has a tall box');
  assert.equal(copyText(p), 'PIPE RACK PR-03\nपाइप रैक');
  // with a measure, a box follows the letters' own widths (a narrow "I" and a wide "W")
  const ruler = (s: string) => [...s].reduce((n, c) => n + (c === 'I' ? 1 : 3), 0);
  const w = pageText([{ str: 'IIWW', transform: [10, 0, 0, 10, 0, 100], width: 80, height: 10 }]);
  const [ww] = matchBoxes(w, findMatches(w, 'WW', 0)[0], view, ruler);
  assert.ok(Math.abs(ww.left * 612 - 20) < 0.01 && Math.abs(ww.width * 612 - 60) < 0.01);
});
