// A phone whose background connection was stopped catches up on what it missed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { office, me, send } from './office.ts';

function wait(port: number, token: string, after: string | null): Promise<{ status: number; body: { items: Array<{ id: string; title: string; text: string }>; cursor: string | null }; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', port, path: `/notify/wait${after ? `?after=${after}` : ''}`, rejectUnauthorized: false, headers: { authorization: `Bearer ${token}` } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text || '{}'), ms: Date.now() - t0 }));
    }).on('error', reject);
  });
}

test('a reconnecting phone is told what it missed: Direct messages, mentions and replies, not its own or what it read', async () => {
  const { owner, priya, ravi } = await office();
  const start = await priya.request('notify.missed', {});
  assert.deepEqual(start.items, [], 'nothing from before the phone started counting');
  const dm = await ravi.request('conv.create', { kind: 'direct', members: [me(priya)] });
  const space = await owner.request('conv.create', { kind: 'space', name: 'P-12 Piping', members: [me(priya), me(ravi)] });
  await send(ravi, dm.id, 'Can you check ISO-1001?');
  await send(owner, space.id, `<@${me(priya)}> the nozzle loads are in`);
  await send(owner, space.id, 'General note for everyone');
  const other = await priya.request('conv.create', { kind: 'direct', members: [me(owner)] });
  await send(priya, other.id, 'my own message');
  // a fresh start cursor skips history
  const missed = await priya.request('notify.missed', { after: start.cursor });
  assert.deepEqual(missed.items.map((i) => [i.title, i.text, i.personal]), [
    ['Ravi', 'Can you check ISO-1001?', true],
    ['@ you in P-12 Piping · Vikram', '@Priya the nozzle loads are in', true],
    ['P-12 Piping · Vikram', 'General note for everyone', false],
  ]);
  assert.equal(missed.items[0].link, `dexconnect://conversation/${dm.id}`);
  // the cursor moves on: asking again gives nothing
  assert.deepEqual((await priya.request('notify.missed', { after: missed.cursor })).items, []);
  // what was read on another device is not shown again
  await priya.request('conv.read', { convId: space.id, messageId: missed.items[2].id });
  assert.deepEqual((await priya.request('notify.missed', { after: start.cursor })).items.map((i) => i.text), ['Can you check ISO-1001?']);
  // a hushed conversation is marked so the phone can leave it quiet
  await priya.request('conv.mute', { convId: dm.id, muted: true });
  assert.equal((await priya.request('notify.missed', { after: start.cursor })).items[0].muted, true);
});

test("a phone's background service waits for the next message on its own, with a token that removal revokes", async () => {
  const { hub, owner, priya, ravi } = await office();
  const { token } = await priya.request('notify.token');
  const dm = await ravi.request('conv.create', { kind: 'direct', members: [me(priya)] });
  const start = await wait(hub.port, token, null);
  assert.equal(start.status, 200);
  const waiting = wait(hub.port, token, start.body.cursor);
  await new Promise((r) => setTimeout(r, 300));
  await send(ravi, dm.id, 'Site visit moved to 3 pm');
  const got = await waiting;
  assert.equal(got.status, 200);
  assert.deepEqual(got.body.items.map((i) => i.text), ['Site visit moved to 3 pm']);
  assert.ok(got.ms < 5000, 'answered as soon as the message arrived');
  // a new token replaces the old one
  const { token: next } = await priya.request('notify.token');
  assert.equal((await wait(hub.port, token, null)).status, 401);
  assert.equal((await wait(hub.port, 'forged', null)).status, 401);
  assert.equal((await wait(hub.port, next, null)).status, 200);
  // an administrator removes the phone: its background service is signed out too
  await owner.request('admin.revoke', { deviceId: priya.session!.deviceId });
  assert.equal((await wait(hub.port, next, null)).status, 401);
});
