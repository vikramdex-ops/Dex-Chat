// Growing writing boxes (meeting chat in the app and the browser): the height for the text, the
// six-line limit, and Enter that sends except during an input method's composition.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GROW_MAX_LINES, enterAction, growHeight } from '../src/compose.ts';

const base = { lineHeight: 20, padY: 16, borderY: 2, borderBox: true, maxLines: GROW_MAX_LINES, minHeight: 38 };

test('one line keeps the box at its minimum height', () => {
  const r = growHeight({ ...base, scrollHeight: 20 + 16 });
  assert.deepEqual(r, { height: 38, scroll: false, multi: false });
});

test('the box grows a line at a time, then stops at six lines and scrolls', () => {
  assert.deepEqual(growHeight({ ...base, scrollHeight: 3 * 20 + 16 }), { height: 3 * 20 + 18, scroll: false, multi: true });
  assert.deepEqual(growHeight({ ...base, scrollHeight: 6 * 20 + 16 }), { height: 6 * 20 + 18, scroll: false, multi: true });
  const long = growHeight({ ...base, scrollHeight: 14 * 20 + 16 });
  assert.equal(long.height, 6 * 20 + 18, 'six lines at most');
  assert.equal(long.scroll, true);
});

test('content-box sizing leaves padding and border out of the height', () => {
  assert.equal(growHeight({ ...base, borderBox: false, minHeight: 0, scrollHeight: 2 * 20 + 16 }).height, 40);
});

test('odd measurements never give a negative or endless box', () => {
  assert.equal(growHeight({ ...base, scrollHeight: Number.NaN }).height, 38);
  assert.equal(growHeight({ ...base, lineHeight: 0, scrollHeight: 400 }).height, 6 * 20 + 18);
  assert.equal(growHeight({ ...base, maxLines: 0, scrollHeight: 400 }).height, 38);
});

test('Enter sends; Shift+Enter, Alt+Enter and an input method composing do not', () => {
  assert.equal(enterAction({ key: 'Enter' }), 'send');
  assert.equal(enterAction({ key: 'Enter', ctrlKey: true }), 'send');
  assert.equal(enterAction({ key: 'Enter', shiftKey: true }), null);
  assert.equal(enterAction({ key: 'Enter', altKey: true }), null);
  assert.equal(enterAction({ key: 'Enter', isComposing: true }), null, 'Hindi or Tamil input choosing a word');
  assert.equal(enterAction({ key: 'Process', keyCode: 229 }), null);
  assert.equal(enterAction({ key: 'Enter', keyCode: 229 }), null, 'Chromium marks composition keys 229');
  assert.equal(enterAction({ key: 'a' }), null);
});
