// The Dock's slash list: the app's own commands are the ones the hub keeps from integrations, and the
// list shows each name once (a command typed can only ever run one thing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { APP_COMMANDS, uniqueCommands } from '../../../packages/core/src/bots.ts';

const src = readFileSync(path.join(import.meta.dirname, '../src/renderer/chat/commands.ts'), 'utf8');
const block = src.slice(src.indexOf('export const BUILT_INS'), src.indexOf('];', src.indexOf('export const BUILT_INS')));
const builtIns = [...block.matchAll(/command: '([a-z-]+)'/g)].map((m) => m[1]);

test('every command the app answers is kept from integrations, and listed once', () => {
  assert.ok(builtIns.length >= 20, `${builtIns.length} built-in commands read`);
  assert.equal(new Set(builtIns).size, builtIns.length, 'no built-in command twice');
  for (const c of builtIns) assert.ok(APP_COMMANDS.includes(c), `/${c} is answered by the app, so the hub must keep it from integrations`);
  for (const c of ['leave', 'got', 'done', 'wrap', 'sheet', 'nib']) assert.ok(builtIns.includes(c), `/${c} is the app's (Nib's)`);
});

test('the slash list has each name once, the app’s own first', () => {
  const app = [{ command: 'leave', description: 'Going on leave: tell everyone at once' }, { command: 'poll', description: 'Ask a question' }];
  const bots = [
    { command: 'leave', description: 'Leave request (an older flow)', bot: true },
    { command: 'plot', description: 'Request a plot', bot: true },
    { command: 'Plot', description: 'Another integration’s plot', bot: true },
    { command: 'leave-request', description: 'Leave request', bot: true },
  ];
  const list = uniqueCommands<{ command: string; description: string; bot?: boolean }>(app, bots);
  assert.deepEqual(list.map((c) => c.command), ['leave', 'poll', 'plot', 'leave-request']);
  assert.equal(list[0].description, 'Going on leave: tell everyone at once', 'the app’s /leave wins');
  assert.equal(new Set(list.map((c) => c.command.toLowerCase())).size, list.length);
});
