// The lobby rules have one set of names, used wherever a rule is chosen (the Meet lens, the Control
// room, the meeting dialog, the invitation block, a Room's settings). Guests from a browser always
// wait, so the rule that lets everyone else in must say so, not "Nobody waits".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { LOBBY_RULES, lobbyLabel } from '../src/renderer/meet/lobby.ts';

const RENDERER = path.join(import.meta.dirname, '../src/renderer');
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = path.join(dir, n);
  return statSync(p).isDirectory() ? (n === 'i18n' ? [] : files(p)) : /\.tsx?$/.test(n) ? [p] : [];
});

test('three rules, three names', () => {
  assert.deepEqual(LOBBY_RULES.map((r) => r.value), ['outside', 'everyone', 'off']);
  assert.equal(lobbyLabel('off'), 'Only guests from a browser wait');
  assert.equal(lobbyLabel('outside'), 'Guests and people from outside wait');
  assert.equal(lobbyLabel('everyone'), 'Everyone waits to be let in');
});

test('every place that lists the rules takes them from meet/lobby.ts', () => {
  const users: string[] = [];
  for (const f of files(RENDERER)) {
    if (f.endsWith(path.join('meet', 'lobby.ts'))) continue;
    const src = readFileSync(f, 'utf8');
    const rel = path.relative(RENDERER, f);
    assert.doesNotMatch(src, /value: 'off', label:|<option value="off">|\['off', '/, `${rel} names the lobby rules itself`);
    assert.doesNotMatch(src, /'Nobody waits'|>Nobody waits</, `${rel} still says Nobody waits`);
    if (/\bLOBBY_RULES\b/.test(src)) users.push(rel.split(path.sep).join('/'));
  }
  assert.deepEqual(users.sort(), ['calendar/CalendarView.tsx', 'meet/GuestLink.tsx', 'meet/MeetAdmin.tsx', 'meet/MeetLens.tsx', 'rooms/Stage.tsx']);
});
