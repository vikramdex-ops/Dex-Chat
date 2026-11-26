// Clipboard sync and dropped files in a support session (policies assistClipboard, assistFiles):
// what the other side may send, and where a dropped file may land on this PC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIP_MAX, decodeClip, safeRelativePath } from '../src/assist.ts';

test('clipboard messages: text only, bounded', () => {
  assert.equal(decodeClip({ k: 'clip', text: 'hello' }), 'hello');
  assert.equal(decodeClip({ k: 'clip', text: '' }), '');
  assert.equal(decodeClip({ k: 'clip', text: 'x'.repeat(CLIP_MAX + 1) }), null);
  assert.equal(decodeClip({ k: 'clip', text: 5 }), null);
  assert.equal(decodeClip({ k: 'in', text: 'x' }), null);
  assert.equal(decodeClip(null), null);
});

test('a dropped file keeps its place in the folder, never outside the ticket folder', () => {
  assert.deepEqual(safeRelativePath('Drawings/Rev A/P-101.pdf'), ['Drawings', 'Rev A', 'P-101.pdf']);
  assert.deepEqual(safeRelativePath('Drawings\\sub\\a.txt'), ['Drawings', 'sub', 'a.txt']);
  assert.deepEqual(safeRelativePath('../../Windows/System32/evil.dll'), ['Windows', 'System32', 'evil.dll']);
  assert.deepEqual(safeRelativePath('C:/Users/x/a.txt'), ['C_', 'Users', 'x', 'a.txt']);
  assert.deepEqual(safeRelativePath('/etc/passwd'), ['etc', 'passwd']);
  assert.deepEqual(safeRelativePath('a<b>|?.txt'), ['a_b___.txt']);
  assert.deepEqual(safeRelativePath('CON/aux.txt'), ['_CON', '_aux.txt']);
  assert.deepEqual(safeRelativePath('name. . '), ['name']);
  assert.equal(safeRelativePath('../..'), null);
  assert.equal(safeRelativePath(''), null);
  assert.equal(safeRelativePath(Array(13).fill('d').join('/')), null);
});
