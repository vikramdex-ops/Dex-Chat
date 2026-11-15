// The notice board's shared rules: numbers, revision letters, changed paragraphs and audiences.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVERYONE, changedParagraphs, inAudience, nextRev, noticeNumber, paragraphs, revOrder } from '../src/notices.ts';

test('numbers and revision letters', () => {
  assert.equal(noticeNumber('HR', 'policy', 12), 'HR-POL-0012');
  assert.equal(noticeNumber('IT', 'it', 3), 'IT-ITA-0003');
  assert.deepEqual([null, 'A', 'B', 'Z', 'AZ', 'ZZ'].map(nextRev), ['A', 'B', 'C', 'AA', 'BA', 'AAA']);
  assert.deepEqual(['B', 'AA', 'A', 'Z'].sort(revOrder), ['A', 'B', 'Z', 'AA']);
});

test('changed paragraphs: new and edited ones, and how many went', () => {
  assert.deepEqual(paragraphs('One.\n\n\nTwo.\r\n\r\nThree.'), ['One.', 'Two.', 'Three.']);
  assert.deepEqual(changedParagraphs('A.\n\nB.\n\nC.', 'A.\n\nB, changed.\n\nC.\n\nD.'), { changed: [1, 3], removed: 0 });
  assert.deepEqual(changedParagraphs('A.\n\nB.\n\nC.', 'A.'), { changed: [], removed: 2 });
  assert.deepEqual(changedParagraphs('A.\n\nB.', 'b.\n\n  a. '), { changed: [], removed: 0 }, 'moved, not changed; spacing and case do not count');
});

test('who a notice is for', () => {
  const p = (role: string, departmentId: string | null = null, location: string | null = null) => ({ id: 'u1', role, profile: { departmentId, location } });
  assert.equal(inAudience(p('member'), EVERYONE), true);
  assert.equal(inAudience(p('guest'), EVERYONE), false, 'never guests');
  assert.equal(inAudience(p('bot'), EVERYONE), false);
  const a = { everyone: false, departments: ['d1'], roles: [] as Array<'admin' | 'member'>, locations: ['Site — Dahej'], people: ['u9'] };
  assert.equal(inAudience(p('member', 'd1'), a), true);
  assert.equal(inAudience(p('member', 'd2'), a), false);
  assert.equal(inAudience(p('member', 'd2'), a, new Set(['d1', 'd2'])), true, 'a department under a chosen one');
  assert.equal(inAudience(p('member', null, ' site — dahej'), a), true);
  assert.equal(inAudience({ id: 'u9', role: 'member', profile: null }, a), true);
  assert.equal(inAudience(p('owner'), { ...a, roles: ['admin'] }), true, 'the owner is an admin');
  assert.equal(inAudience(p('guest', 'd1'), a), false);
});
