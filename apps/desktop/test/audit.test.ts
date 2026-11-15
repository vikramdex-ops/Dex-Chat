// Control room ▸ Audit log: meetings read as sentences, and what the hub did by itself says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditLine } from '../src/renderer/views/audit.ts';

const words = (a: string) => ({ 'device.approved': 'approved a device' } as Record<string, string>)[a] ?? a;

test('a meeting the host ended reads with their name', () => {
  assert.deepEqual(auditLine('meeting.ended', 'Priya Raman', { endedForEveryone: true, people: 4 }, words), { who: 'Priya Raman', what: 'ended a meeting for everyone' });
  assert.deepEqual(auditLine('meeting.ended', 'Priya Raman', null, words), { who: 'Priya Raman', what: 'ended a meeting' });
});

test('a meeting the hub closed says it was the hub, and why', () => {
  // what the hub records when the last person leaves (rooms.ts: actor null)
  assert.deepEqual(auditLine('meeting.ended', null, { roomId: 'r1', durationMs: 60_000, people: 3, endedForEveryone: false }, words), { who: 'The hub', what: 'ended a meeting (everyone had left)' });
  // a call that stopped ringing with nobody else in it
  assert.deepEqual(auditLine('meeting.ended', null, { people: 1, endedForEveryone: false }, words), { who: 'The hub', what: 'ended a meeting (nobody else joined)' });
  assert.deepEqual(auditLine('meeting.ended', null, 'not an object', words), { who: 'The hub', what: 'ended a meeting (everyone had left)' });
});

test('other actions keep their words', () => {
  assert.deepEqual(auditLine('device.approved', 'Vikram Shah', null, words), { who: 'Vikram Shah', what: 'approved a device' });
  assert.deepEqual(auditLine('device.approved', null, null, words), { who: 'Someone', what: 'approved a device' });
});
