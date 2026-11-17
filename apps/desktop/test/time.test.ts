// One time of day across the app: no leading zero in 12-hour mode, the person's 12/24-hour choice,
// and am/pm as the language writes it (Hindi "pm", Tamil and English "PM").
import { test } from 'node:test';
import assert from 'node:assert/strict';

// the app's language is Hindi for this file (read once, when the i18n module loads)
(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => (k === 'dex.language' ? 'hi' : null), setItem() {} };
await import('../src/renderer/i18n/index.ts');
const { formatDateTime, formatTime, setTimeFormat } = await import('../src/renderer/time.ts');

const at = new Date(2026, 10, 15, 14, 5);
const morning = new Date(2026, 10, 15, 9, 5);

test('12-hour times have no leading zero, and am/pm follows the language', () => {
  setTimeFormat('12');
  assert.equal(formatTime(at), at.toLocaleTimeString('hi-IN', { hour: 'numeric', minute: '2-digit', hour12: true }));
  assert.match(formatTime(at), /^2:05\s?pm$/);
  assert.match(formatTime(morning), /^9:05\s?am$/);
  assert.match(formatTime(at.getTime()), /^2:05\s?pm$/);
  // a weekday or a zone can be added; the time keeps its form
  assert.match(formatTime(at, { timeZone: 'UTC', weekday: 'short' }), /\d:\d\d\s?[ap]m$/);
  assert.match(formatDateTime(at, { day: 'numeric', month: 'short' }), /15.*2:05\s?pm$/);
});

test('24-hour times follow the preference', () => {
  setTimeFormat('24');
  assert.equal(formatTime(at), '14:05');
  assert.doesNotMatch(formatTime(morning), /[ap]m/i);
  assert.match(formatDateTime(at, { weekday: 'short' }), /14:05$/);
  setTimeFormat('system');
  assert.equal(formatTime(at), at.toLocaleTimeString('hi-IN', { hour: 'numeric', minute: '2-digit' }));
});

test('Nib’s times of day ("18:00" from the hub) read the same way', async () => {
  const { clockOf, wrapTimeText } = await import('../src/renderer/nib/words.ts');
  setTimeFormat('12');
  assert.match(clockOf('2026-11-15', '18:00'), /^6:00\s?pm$/);
  assert.match(wrapTimeText({ date: '2026-11-15', wrapAt: '18:30' } as never), /^6:30\s?pm$/);
  setTimeFormat('24');
  assert.equal(clockOf('2026-11-15', '18:00'), '18:00');
  assert.equal(clockOf('2026-11-15', '09:05'), '09:05');
  setTimeFormat('system');
});
