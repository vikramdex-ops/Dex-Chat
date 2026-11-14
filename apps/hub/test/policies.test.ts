import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OfficePolicy } from '@dex/core';
import { office, nextEvent, me, send } from './office.ts';

test('office policies: edit window, upload limit, peer fallback, recording; admins only', async () => {
  const { hub, owner, priya } = await office();
  const p0 = await priya.request('policy.get');
  assert.equal(p0.editWindowMinutes, null);
  assert.equal(p0.peerFallback, true);
  assert.equal(p0.allowRecording, true);
  await assert.rejects(priya.request('admin.policy.set', { editWindowMinutes: 5 }), /administrators/);

  const space = await owner.request('conv.create', { kind: 'space', name: 'Policy', members: [me(priya)] });
  const old = await send(priya, space.id, 'first draft');
  const changed = nextEvent<OfficePolicy>(priya, 'policy.updated');
  const p = await owner.request('admin.policy.set', { editWindowMinutes: 15, maxUploadMb: 50, peerFallback: false, allowRecording: false });
  assert.deepEqual(await changed, p);
  assert.equal(hub.files.maxBytes, 50 * 1024 * 1024);
  // a message older than the window can no longer be edited or deleted by its author
  hub.store.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(Date.now() - 16 * 60_000, old.id);
  await assert.rejects(priya.request('msg.edit', { messageId: old.id, body: 'second draft' }), /15 minutes after sending/);
  await assert.rejects(priya.request('msg.delete', { messageId: old.id }), /15 minutes/);
  const fresh = await send(priya, space.id, 'new note');
  await priya.request('msg.edit', { messageId: fresh.id, body: 'new note, edited' });
  // moderators can still remove old messages in their Spaces
  await owner.request('msg.delete', { messageId: old.id });
  await assert.rejects(owner.request('admin.policy.set', { editWindowMinutes: 0 }), /between 1 minute/);
  await assert.rejects(owner.request('admin.policy.set', { maxUploadMb: 0 }), /upload limit/);
  assert.equal((await owner.request('admin.policy.set', { editWindowMinutes: null })).editWindowMinutes, null);
  await priya.request('msg.edit', { messageId: fresh.id, body: 'any time again' });
});

test('usage report counts messages, people, Spaces and calls per day', async () => {
  const { hub, owner, priya, ravi } = await office();
  const space = await owner.request('conv.create', { kind: 'space', name: 'Busy', members: [me(priya), me(ravi)] });
  const dm = await owner.request('conv.create', { kind: 'direct', members: [me(priya)] });
  await send(owner, space.id, 'one');
  await send(priya, space.id, 'two');
  await send(priya, dm.id, 'three');
  hub.policies.logCall('r1', dm.id, me(owner), false, false, 5 * 60_000);
  hub.policies.logCall('r2', dm.id, me(owner), true, true, 0);
  await assert.rejects(priya.request('admin.usage', { days: 7 }), /administrators/);
  const r = await owner.request('admin.usage', { days: 7 });
  assert.equal(r.daily.length, 7);
  const today = r.daily[r.daily.length - 1];
  assert.equal(today.messages >= 3, true);
  assert.equal(today.direct, 1);
  assert.equal(today.activePeople >= 2, true);
  assert.equal(today.calls, 2);
  assert.equal(today.callMinutes, 5);
  assert.equal(r.totals.callMinutes, 5);
  assert.equal(r.totals.people, 3);
  assert.equal(r.topSpaces[0].name, 'Busy');
  assert.equal(r.topPeople[0].userId, me(priya));
});

test('recording a call shows to everyone in it and follows the office policy', async () => {
  const { owner, priya } = await office();
  const dm = await owner.request('conv.create', { kind: 'direct', members: [me(priya)] });
  const room = await owner.request('room.start', { convId: dm.id, video: false });
  await priya.request('room.join', { roomId: room.id });
  const seen = new Promise<boolean>((resolve) => owner.on('event', (n: string, r: { id: string; participants: Array<{ userId: string; recording?: boolean }> }) => {
    if (n === 'room.updated' && r.id === room.id && r.participants.some((p) => p.userId === me(priya) && p.recording)) resolve(true);
  }));
  await priya.request('room.record', { roomId: room.id, on: true });
  assert.equal(await seen, true);
  await owner.request('admin.policy.set', { allowRecording: false });
  await assert.rejects(owner.request('room.record', { roomId: room.id, on: true }), /turned off/);
  await priya.request('room.record', { roomId: room.id, on: false });
  await priya.request('room.leave', { roomId: room.id });
});
