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

// ------------------------------------------------------------------ a marker on a shared screen, end to end
import { overlayBox, pictureBox } from '../src/pointers.ts';
import { fromPicture, toScreen } from '../src/assist.ts';

/** WebRTC sends a smaller picture when it must, with even sides. */
const sent = (w: number, h: number, k: number) => ({ w: Math.max(2, Math.round((w * k) / 2) * 2), h: Math.max(2, Math.round((h * k) / 2) * 2) });

test('a marker placed on the shared video lands on the same pixel for the viewer, on the presenter\'s screen, and for remote control', () => {
  // the presenter's monitors: physical pixels, Windows scaling, and where each sits (a second monitor left of or above the main one)
  const monitors = [
    { W: 1920, H: 1080, s: 1, px: 0, py: 0 },
    { W: 1920, H: 1080, s: 1.25, px: 0, py: 0 },
    { W: 2560, H: 1440, s: 1.5, px: 1920, py: 0 },
    { W: 1920, H: 1200, s: 1.75, px: -1920, py: -120 },
    { W: 3840, H: 2160, s: 2, px: 0, py: -2160 },
    { W: 1366, H: 768, s: 1, px: 2560, py: 300 },
    { W: 1080, H: 1920, s: 1.5, px: -1080, py: 0 },
  ];
  // the viewer's shared-screen element: wide, tall, phone-sized, odd sizes
  const views = [
    { x: 300, y: 80, width: 1100, height: 620 },
    { x: 12, y: 140, width: 366, height: 520 },
    { x: 0, y: 0, width: 2400, height: 900 },
    { x: 41.5, y: 63.25, width: 777.5, height: 777.5 },
  ];
  let checked = 0;
  for (const mon of monitors) {
    const dip = { x: mon.px / mon.s, y: mon.py / mon.s, width: mon.W / mon.s, height: mon.H / mon.s };
    const phys = { x: mon.px, y: mon.py, width: mon.W, height: mon.H };
    for (const k of [1, 0.5, 0.37]) {
      const f = sent(mon.W, mon.H, k);
      for (const el of views) {
        const box = pictureBox(el, f.w, f.h);
        for (const [u, v] of [[0.03, 0.04], [0.5, 0.5], [0.97, 0.12], [0.21, 0.88], [0.999, 0.999]]) {
          const cx = box.x + u * box.width;
          const cy = box.y + v * box.height;
          const p = toSurface(cx, cy, box);
          assert.ok(p, 'a click on the picture is on the surface');
          // the viewer draws it where they clicked
          const back = fromSurface(p.x, p.y, box);
          assert.ok(Math.abs(back.x - cx) <= 1 && Math.abs(back.y - cy) <= 1, `viewer: ${back.x},${back.y} vs ${cx},${cy}`);
          // the physical pixel the viewer clicked on, through the (scaled) picture
          const truth = { x: phys.x + ((cx - box.x) / box.width) * mon.W, y: phys.y + ((cy - box.y) / box.height) * mon.H };
          // remote control injects there (same mapping as live pointers)
          const c = fromPicture(cx, cy, el, f.w, f.h)!;
          assert.deepEqual(c, p, 'control and pointers read the same point');
          const inj = toScreen(c.x, c.y, phys);
          assert.ok(Math.abs(inj.x - truth.x) <= 1 && Math.abs(inj.y - truth.y) <= 1, `injected ${inj.x},${inj.y} vs ${truth.x},${truth.y} (${mon.W}x${mon.H}@${mon.s})`);
          // the presenter's pointer window: exactly over the display, or put elsewhere by Windows
          for (const win of [dip, { ...dip, width: dip.width * 1.2, height: dip.height * 1.2 }, { x: dip.x + 40, y: dip.y + 30, width: dip.width - 40, height: dip.height - 78 }]) {
            for (const zoom of [1, 1.25]) {
              const inner = { width: win.width / zoom, height: win.height / zoom };
              const q = fromSurface(p.x, p.y, overlayBox(dip, win, inner));
              // the window's CSS pixel on the screen, in physical pixels
              const sx = (win.x + (q.x * win.width) / inner.width) * mon.s;
              const sy = (win.y + (q.y * win.height) / inner.height) * mon.s;
              assert.ok(Math.abs(sx - truth.x) <= 1 && Math.abs(sy - truth.y) <= 1, `overlay ${sx},${sy} vs ${truth.x},${truth.y}`);
              checked++;
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 1000);
});

test('the pointer window used to assume it covered the display: off by the difference when it did not', () => {
  const dip = { x: 0, y: 0, width: 1536, height: 864 };
  const win = { x: 0, y: 0, width: 1920, height: 1080 }; // made at the main monitor's scaling
  const inner = { width: win.width, height: win.height };
  const old = fromSurface(0.5, 0.5, { x: 0, y: 0, ...inner });
  const now = fromSurface(0.5, 0.5, overlayBox(dip, win, inner));
  assert.deepEqual(now, { x: 768, y: 432 });
  assert.ok(Math.abs(old.x - now.x) > 100, 'the old placement was far off');
});

test('letterboxing: clicks on the bars are not on the picture', () => {
  const el = { x: 0, y: 0, width: 1000, height: 1000 };
  const box = pictureBox(el, 1920, 1080);
  assert.equal(box.y, (1000 - 562.5) / 2);
  assert.equal(toSurface(500, 100, box), null);
  assert.deepEqual(toSurface(500, 500, box), { x: 0.5, y: 0.5 });
  assert.deepEqual(pictureBox(el, 0, 0), el, 'no picture yet: the element');
  assert.deepEqual(overlayBox(el, { x: 0, y: 0, width: 0, height: 0 }, { width: 10, height: 20 }), { x: 0, y: 0, width: 10, height: 20 });
});
