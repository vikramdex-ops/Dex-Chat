// Remote control: the input event encoder and decoder, the rate limiter, the chord blocklist and
// the coordinate mapping from the shared picture to the requester's screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INPUT_BATCH, INPUT_RATE, InputBatcher, InputGate, KEYS, blockedChord, containBox, decodeInput, decodeInputBatch,
  domButton, fromPicture, toScreen, toVirtualDesk, wheelNotches,
} from '../src/assist.ts';
import type { InputEvent } from '../src/assist.ts';

test('decoding: valid events pass, positions are clamped, anything else is dropped', () => {
  assert.deepEqual(decodeInput({ t: 'move', x: 0.5, y: 0.25 }), { t: 'move', x: 0.5, y: 0.25 });
  assert.deepEqual(decodeInput({ t: 'move', x: 1.7, y: -3 }), { t: 'move', x: 1, y: 0 });
  assert.deepEqual(decodeInput({ t: 'move', x: 0.123456789, y: 0.5 }), { t: 'move', x: 0.1235, y: 0.5 });
  assert.deepEqual(decodeInput({ t: 'button', b: 'right', down: true, x: 0.1, y: 0.2 }), { t: 'button', b: 'right', down: true, x: 0.1, y: 0.2 });
  assert.deepEqual(decodeInput({ t: 'wheel', dx: 0, dy: 37, x: 0, y: 0 }), { t: 'wheel', dx: 0, dy: 10, x: 0, y: 0 });
  assert.deepEqual(decodeInput({ t: 'key', code: 'KeyA', down: true }), { t: 'key', code: 'KeyA', down: true });
  for (const bad of [null, 'move', {}, { t: 'move', x: '1', y: 0 }, { t: 'move', x: NaN, y: 0 }, { t: 'move', x: Infinity, y: 0 },
    { t: 'button', b: 'back', down: true, x: 0, y: 0 }, { t: 'button', b: 'left', x: 0, y: 0 }, { t: 'key', code: 'Fn', down: true },
    { t: 'key', code: 'KeyA', down: 'yes' }, { t: 'wheel', dx: 0, dy: 0, x: 0, y: 0 }, { t: 'exec', cmd: 'calc' }]) {
    assert.equal(decodeInput(bad), null, JSON.stringify(bad));
  }
  const batch = decodeInputBatch({ k: 'in', e: [{ t: 'move', x: 0.1, y: 0.1 }, { t: 'nope' }, ...Array.from({ length: 50 }, () => ({ t: 'move', x: 0.2, y: 0.2 }))] });
  assert.equal(batch.length, INPUT_BATCH - 1, 'one bad event dropped, the batch capped');
  assert.deepEqual(decodeInputBatch({ k: 'pt', e: [] }), []);
  assert.deepEqual(decodeInputBatch({ k: 'in', e: 'x' }), []);
});

test('key table: letters, digits and the extended keys Windows needs', () => {
  assert.deepEqual(KEYS.KeyA, { vk: 0x41, x: 'a' });
  assert.deepEqual(KEYS.Digit7, { vk: 0x37, x: '7' });
  assert.deepEqual(KEYS.F5, { vk: 0x74, x: 'F5' });
  assert.equal(KEYS.ArrowLeft.ext, true);
  assert.equal(KEYS.ControlRight.ext, true);
  assert.equal(KEYS.ControlLeft.ext, undefined);
  assert.equal(KEYS.Enter.vk, KEYS.NumpadEnter.vk);
  assert.equal(KEYS.NumpadEnter.ext, true);
  assert.equal(KEYS.Enter.x, 'Return');
});

test('the gate passes nothing without consent, and taking consent back releases held keys and buttons', () => {
  const g = new InputGate();
  assert.deepEqual(g.accept({ t: 'move', x: 0.5, y: 0.5 }), { ok: false, reason: 'off' });
  g.set(true);
  assert.equal(g.accept({ t: 'key', code: 'ShiftLeft', down: true }).ok, true);
  assert.equal(g.accept({ t: 'button', b: 'left', down: true, x: 0.5, y: 0.5 }).ok, true);
  const released = g.set(false);
  assert.deepEqual(released, [{ t: 'key', code: 'ShiftLeft', down: false }, { t: 'button', b: 'left', down: false, x: -1, y: -1 }]);
  assert.equal(g.enabled, false);
  assert.equal(g.accept({ t: 'key', code: 'KeyA', down: true }).ok, false);
});

test('the gate blocks system chords, and the chord key-up is not passed on either', () => {
  const g = new InputGate();
  g.set(true);
  const press = (code: string) => g.accept({ t: 'key', code, down: true });
  const lift = (code: string) => g.accept({ t: 'key', code, down: false });
  press('ControlLeft'); press('AltLeft');
  assert.deepEqual(press('Delete'), { ok: false, reason: 'chord', detail: 'Ctrl+Alt+Del' });
  assert.deepEqual(lift('Delete'), { ok: false, reason: 'stray' });
  assert.equal(press('End').ok, false);
  assert.equal(press('Backspace').ok, false);
  assert.equal(press('F2').ok, false);
  assert.equal(press('KeyC').ok, true, 'Ctrl+Alt+C is an ordinary chord');
  lift('KeyC'); lift('AltLeft'); lift('ControlLeft');
  press('MetaLeft');
  assert.deepEqual(press('KeyL'), { ok: false, reason: 'chord', detail: 'Win+L' });
  assert.equal(press('KeyE').ok, true, 'Win+E opens Explorer: allowed');
  lift('KeyE'); lift('MetaLeft');
  press('ControlRight'); press('AltRight'); press('ShiftLeft');
  assert.equal(press('KeyS').ok, false, 'the stop chord is never sent');
  lift('ShiftLeft'); lift('AltRight'); lift('ControlRight');
  assert.equal(press('Delete').ok, true, 'Delete on its own is fine');
  assert.equal(blockedChord('Delete', new Set(['ctrl'])), null);
  assert.equal(blockedChord('NumpadDecimal', new Set(['ctrl', 'alt'])), 'Ctrl+Alt+Del');
});

test('the gate allows 120 events a second; releases of held keys always go through', () => {
  const g = new InputGate();
  g.set(true);
  let t = 1_000_000;
  let ok = 0;
  for (let i = 0; i < 300; i++) if (g.accept({ t: 'move', x: i / 300, y: 0.5 }, t + i).ok) ok++;
  assert.equal(ok, INPUT_RATE);
  t += 300;
  // a key pressed just before the limit is reached is still released when the limit is full
  const g2 = new InputGate(3);
  g2.set(true);
  assert.equal(g2.accept({ t: 'key', code: 'KeyA', down: true }, t).ok, true);
  assert.equal(g2.accept({ t: 'move', x: 0, y: 0 }, t).ok, true);
  assert.equal(g2.accept({ t: 'move', x: 0, y: 0 }, t).ok, true);
  assert.deepEqual(g2.accept({ t: 'move', x: 0, y: 0 }, t), { ok: false, reason: 'rate' });
  assert.equal(g2.accept({ t: 'key', code: 'KeyA', down: false }, t).ok, true);
  assert.deepEqual(g2.accept({ t: 'button', b: 'left', down: false, x: 0, y: 0 }, t), { ok: false, reason: 'stray' }, 'nothing held: a stray release');
  // a second later the window has moved on
  assert.equal(g2.accept({ t: 'move', x: 0, y: 0 }, t + 1000).ok, true);
});

test('coordinates: the picture maps onto the shared display, also one left of the primary', () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1080 };
  assert.deepEqual(toScreen(0, 0, primary), { x: 0, y: 0 });
  assert.deepEqual(toScreen(1, 1, primary), { x: 1919, y: 1079 });
  assert.deepEqual(toScreen(0.5, 0.5, primary), { x: 960, y: 540 });
  assert.deepEqual(toScreen(2, -1, primary), { x: 1919, y: 0 }, 'clamped inside the display');
  const left = { x: -2560, y: -200, width: 2560, height: 1440 };
  assert.deepEqual(toScreen(0, 0, left), { x: -2560, y: -200 });
  assert.deepEqual(toScreen(1, 1, left), { x: -1, y: 1239 });
  // Windows' virtual desk (both monitors) in SendInput's 0..65535 range
  const vs = { x: -2560, y: -200, width: 2560 + 1920, height: 1440 };
  assert.deepEqual(toVirtualDesk(-2560, -200, vs), { x: 0, y: 0 });
  assert.deepEqual(toVirtualDesk(1919, 1239, vs), { x: 65535, y: 65535 });
  const mid = toVirtualDesk(0, 0, vs);
  assert.equal(mid.x, Math.round((2560 * 65535) / (4480 - 1)));
  assert.deepEqual(toVirtualDesk(99999, -99999, vs), { x: 65535, y: 0 });
});

test('coordinates: a click on the letterboxed video lands on the right spot of the picture', () => {
  // a 1600x900 picture in a 1000x1000 element: drawn 1000x562.5, 218.75 px from the top
  const el = { x: 100, y: 50, width: 1000, height: 1000 };
  assert.deepEqual(containBox(el, 1600, 900), { x: 100, y: 268.75, width: 1000, height: 562.5 });
  assert.deepEqual(fromPicture(600, 550, el, 1600, 900), { x: 0.5, y: 0.5 });
  assert.deepEqual(fromPicture(100, 268.75, el, 1600, 900), { x: 0, y: 0 });
  assert.equal(fromPicture(600, 100, el, 1600, 900), null, 'the letterbox is not the picture');
  assert.deepEqual(fromPicture(600, 500, el, 0, 0), { x: 0.5, y: 0.45 }, 'size not known yet: the element is the picture');
  assert.equal(domButton(0), 'left');
  assert.equal(domButton(2), 'right');
  assert.equal(domButton(3), null);
  assert.equal(wheelNotches(100, 0), 1);
  assert.equal(wheelNotches(-300, 0), -3);
  assert.equal(wheelNotches(3, 1), 1);
  assert.equal(wheelNotches(4, 0), 1, 'a touchpad nudge is still one notch');
  assert.equal(wheelNotches(99999, 0), 10);
});

test('the technician batches events and keeps only the latest pointer move between batches', () => {
  const b = new InputBatcher();
  b.push({ t: 'move', x: 0.1, y: 0.1 });
  b.push({ t: 'move', x: 0.2, y: 0.2 });
  b.push({ t: 'button', b: 'left', down: true, x: 0.2, y: 0.2 });
  b.push({ t: 'move', x: 0.3, y: 0.3 });
  b.push({ t: 'move', x: 0.4, y: 0.4 });
  const m = b.take()!;
  assert.deepEqual(m.e.map((e: InputEvent) => e.t), ['move', 'button', 'move']);
  assert.deepEqual(m.e[2], { t: 'move', x: 0.4, y: 0.4 });
  assert.equal(b.take(), null);
  for (let i = 0; i < 40; i++) b.push({ t: 'key', code: 'KeyA', down: i % 2 === 0 });
  assert.equal(b.take()!.e.length, INPUT_BATCH);
  assert.equal(b.pending, 8);
});
