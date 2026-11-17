// Live pointers: coordinate mapping on a turned picture, the 30 Hz throttle, the stroke cap,
// and the shared board (fading highlights and ink, numbered markers, presenter-only clear).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HIGHLIGHT_MS, INK_MS, MAX_INK, PointerBoard, PointerThrottle, fade, fromSurface, readPointerBatch, readPointerMsg, toSurface } from '../src/pointers.ts';
import type { PointerMsg } from '../src/pointers.ts';

test('a point on screen maps to the surface and back, at every quarter turn', () => {
  const box = { x: 100, y: 50, width: 400, height: 200 };
  assert.deepEqual(toSurface(100, 50, box), { x: 0, y: 0 });
  assert.deepEqual(toSurface(300, 150, box), { x: 0.5, y: 0.5 });
  assert.equal(toSurface(99, 50, box), null, 'outside the surface');
  assert.equal(toSurface(0, 0, { x: 0, y: 0, width: 0, height: 10 }), null);
  // a quarter turn clockwise: the picture's top-left corner is drawn at the top-right
  assert.deepEqual(toSurface(500, 50, box, 90), { x: 0, y: 0 });
  assert.deepEqual(toSurface(100, 50, box, 180), { x: 1, y: 1 });
  assert.deepEqual(toSurface(100, 250, box, 270), { x: 0, y: 0 });
  for (const rot of [0, 90, 180, 270, -90, 450]) {
    for (const [x, y] of [[0.1, 0.2], [0.75, 0.4], [0.5, 0.5], [1, 0]]) {
      const p = fromSurface(x, y, box, rot);
      const back = toSurface(p.x, p.y, box, rot)!;
      assert.ok(Math.abs(back.x - x) < 1e-4 && Math.abs(back.y - y) < 1e-4, `${rot}° ${x},${y} -> ${back.x},${back.y}`);
    }
  }
});

test('messages are checked on the way in', () => {
  assert.deepEqual(readPointerMsg({ k: 'cur', x: 2, y: 0.5 }), { k: 'cur', x: 1, y: 0.5 });
  assert.deepEqual(readPointerMsg({ k: 'cur', x: -1, y: 0 }), { k: 'cur', x: -1, y: -1 });
  assert.deepEqual(readPointerMsg({ k: 'hl', id: 'a1', shape: 'ellipse', x: 0.9, y: 0.9, w: 0.5, h: 0.5, pinned: 1 }), { k: 'hl', id: 'a1', shape: 'ellipse', x: 0.9, y: 0.9, w: 0.1, h: 0.1, pinned: false });
  assert.equal(readPointerMsg({ k: 'hl', id: 'a1', shape: 'star', x: 0, y: 0, w: 1, h: 1 }), null);
  assert.equal(readPointerMsg({ k: 'pin', id: '../../x', n: 1, x: 0, y: 0 }), null, 'ids are short and plain');
  assert.equal(readPointerMsg({ k: 'pin', id: 'p', n: 3, x: 0, y: 0, note: 'x'.repeat(200) })!.k, 'pin');
  assert.equal((readPointerMsg({ k: 'pin', id: 'p', n: 3, x: 0, y: 0, note: 'x'.repeat(200) }) as { note: string }).note.length, 80);
  assert.equal(readPointerMsg({ k: 'ink', id: 's', pts: [0, 0, 'a', 1] }), null);
  assert.equal((readPointerMsg({ k: 'ink', id: 's', pts: Array.from({ length: 5000 }, () => 0.5) }) as { pts: number[] }).pts.length, MAX_INK);
  assert.equal(readPointerMsg({ k: 'mode', on: 'yes' }), null);
  assert.deepEqual(readPointerBatch({ k: 'pt', m: [{ k: 'clear' }, { k: 'bogus' }] }), [{ k: 'clear' }]);
  assert.deepEqual(readPointerBatch({ k: 'in', m: [] }), []);
});

test('the throttle sends at most 30 batches a second, coalescing moves and joining ink', () => {
  let now = 0;
  const timers: Array<{ at: number; f: () => void }> = [];
  const sent: PointerMsg[][] = [];
  const t = new PointerThrottle((b) => sent.push(b.m), { now: () => now, later: (f, ms) => { timers.push({ at: now + ms, f }); return 0 as unknown as ReturnType<typeof setTimeout>; } });
  const run = (until: number) => {
    for (; now <= until; now++) {
      for (const tm of timers.splice(0)) { if (tm.at <= now) tm.f(); else timers.push(tm); }
    }
  };
  // a second of pointer moves, one every 2 ms
  for (let i = 0; i < 500; i++) { t.push({ k: 'cur', x: i / 500, y: 0.5 }); run(now + 1); }
  run(now + 50);
  assert.ok(sent.length <= 31 && sent.length >= 25, `batches in a second: ${sent.length}`);
  assert.ok(sent.every((b) => b.filter((m) => m.k === 'cur').length === 1), 'one cursor per batch');
  assert.deepEqual(sent.at(-1)!.at(-1), { k: 'cur', x: 499 / 500, y: 0.5 }, 'the latest position is the one sent last');
  // ink for one stroke joins into one message per batch, and stops growing at the cap
  sent.length = 0;
  for (let i = 0; i < 1000; i++) { t.push({ k: 'ink', id: 's1', pts: [i / 1000, 0.5], end: false }); if (i % 10 === 0) run(now + 1); }
  t.push({ k: 'ink', id: 's1', pts: [], end: true });
  run(now + 100);
  const inkMsgs = sent.flat().filter((m): m is Extract<PointerMsg, { k: 'ink' }> => m.k === 'ink');
  const total = inkMsgs.reduce((n, m) => n + m.pts.length, 0);
  assert.equal(total, MAX_INK, 'the stroke is capped');
  assert.equal(inkMsgs.at(-1)!.end, true);
  assert.ok(sent.every((b) => b.filter((m) => m.k === 'ink').length <= 1));
});

test('the board: highlights and ink fade, markers stay, only the presenter clears or turns pointers off', () => {
  const b = new PointerBoard();
  let now = 1000;
  assert.ok(b.apply('dev-a', { k: 'cur', x: 0.2, y: 0.3 }, now, false));
  b.apply('dev-a', { k: 'hl', id: 'h1', shape: 'rect', x: 0.1, y: 0.1, w: 0.2, h: 0.2, pinned: false }, now, false);
  b.apply('dev-b', { k: 'hl', id: 'h1', shape: 'ellipse', x: 0.5, y: 0.5, w: 0.2, h: 0.2, pinned: true }, now, false);
  b.apply('dev-a', { k: 'pin', id: 'p1', n: b.nextMarker(), x: 0.4, y: 0.4, note: 'this flange' }, now, false);
  b.apply('dev-b', { k: 'pin', id: 'p1', n: b.nextMarker(), x: 0.6, y: 0.4, note: '' }, now, false);
  assert.deepEqual([...b.markers.values()].map((m) => m.n), [1, 2]);
  b.apply('dev-a', { k: 'ink', id: 's', pts: [0, 0, 0.1, 0.1], end: false }, now, false);
  b.apply('dev-a', { k: 'ink', id: 's', pts: [0.2, 0.2], end: true }, now, false);
  assert.deepEqual(b.inks.get('dev-a:s')!.pts, [0, 0, 0.1, 0.1, 0.2, 0.2]);
  assert.equal(b.highlights.size, 2, 'the same mark id from two people are two marks');
  now += HIGHLIGHT_MS + 1;
  assert.ok(b.prune(now));
  assert.deepEqual([...b.highlights.values()].map((h) => h.from), ['dev-b'], 'the pinned highlight stays');
  assert.equal(b.inks.size, 0);
  assert.equal(b.markers.size, 2);
  assert.equal(fade(0, 0, INK_MS), 1);
  assert.equal(fade(0, INK_MS - 500, INK_MS), 0.5);
  assert.equal(fade(0, INK_MS + 1, INK_MS), 0);
  // someone else cannot clear; the presenter can
  assert.equal(b.apply('dev-b', { k: 'clear' }, now, false), false);
  assert.equal(b.markers.size, 2);
  assert.ok(b.apply('dev-a', { k: 'clear' }, now, true));
  assert.equal(b.markers.size + b.highlights.size + b.inks.size, 0);
  // pointers off: cursors go and new marks are ignored until the presenter turns them back on
  assert.equal(b.apply('dev-b', { k: 'mode', on: false }, now, false), false);
  assert.ok(b.apply('dev-a', { k: 'mode', on: false }, now, true));
  assert.equal(b.cursors.size, 0);
  assert.equal(b.apply('dev-b', { k: 'cur', x: 0.5, y: 0.5 }, now, false), false);
  b.apply('dev-a', { k: 'mode', on: true }, now, true);
  assert.ok(b.apply('dev-b', { k: 'cur', x: 0.5, y: 0.5 }, now, false));
  b.apply('dev-b', { k: 'pin', id: 'p9', n: 1, x: 0.5, y: 0.5, note: '' }, now, false);
  assert.ok(b.apply('dev-b', { k: 'drop', id: 'p9' }, now, false));
  assert.equal(b.markers.size, 0);
});
