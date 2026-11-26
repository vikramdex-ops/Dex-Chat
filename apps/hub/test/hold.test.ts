// Hold: a seat kept while its device is in another call, never dialled meanwhile, and one live
// Room per device. And a screen shown in a conversation without voice or camera.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RoomInfo } from '@dex/core';
import { office, nextEvent, me } from './office.ts';

const seat = (r: RoomInfo, userId: string) => r.participants.find((p) => p.userId === userId);

test('the hub tells every app it can hold calls and show screens (an older hub says nothing, and apps hide both)', async () => {
  const { hub, owner } = await office();
  assert.deepEqual(hub.info.features, ['room.hold', 'room.share']);
  assert.deepEqual(owner.session!.hub.features, ['room.hold', 'room.share']);
});

test('hold: the seat stays, no one connects to it, the others are told; back again it is live', async () => {
  const { owner, priya, ravi } = await office();
  const group = await owner.request('conv.create', { kind: 'space', name: 'Piping desk', members: [me(priya), me(ravi)] });
  const room = await owner.request('room.start', { convId: group.id, video: false });
  await priya.request('room.join', { roomId: room.id });
  await ravi.request('room.join', { roomId: room.id });
  await priya.request('room.media', { roomId: room.id, muted: false, camera: false, screen: true });

  const told = nextEvent<RoomInfo>(owner, 'room.updated', (r) => !!seat(r, me(priya))?.held);
  const held = await priya.request('room.hold', { roomId: room.id, on: true });
  assert.equal(seat(held, me(priya))?.held, true);
  assert.equal(seat(held, me(priya))?.screen, false, 'a shared screen stops on hold');
  assert.equal(seat(await told, me(priya))?.held, true, 'the others see who is on hold');
  assert.equal(held.participants.length, 3, 'the seat is kept');

  // nothing is passed to or from a seat on hold
  let reached = false;
  priya.on('event', (n: string) => { if (n === 'room.signal') reached = true; });
  await ravi.request('room.signal', { roomId: room.id, toDevice: priya.session!.deviceId, data: { sdp: 'offer' } });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(reached, false);
  // and while on hold it does not share a screen
  await priya.request('room.media', { roomId: room.id, muted: true, camera: false, screen: true });
  assert.equal(seat((await owner.request('room.list'))[0], me(priya))?.screen, false);

  const back = await priya.request('room.hold', { roomId: room.id, on: false });
  assert.equal(seat(back, me(priya))?.held, undefined);
  const signal = nextEvent<{ fromDevice: string }>(owner, 'room.signal');
  await priya.request('room.signal', { roomId: room.id, toDevice: owner.session!.deviceId, data: { sdp: 'offer' } });
  assert.equal((await signal).fromDevice, priya.session!.deviceId, 'back from hold, it reaches out again');
});

test('hold and answer: a second call keeps the first seat on hold; coming back holds the second', async () => {
  const { owner, priya, ravi } = await office();
  const a = await owner.request('conv.create', { kind: 'direct', members: [me(priya)] });
  const b = await ravi.request('conv.create', { kind: 'direct', members: [me(priya)] });
  const first = await owner.request('room.start', { convId: a.id, video: false });
  await priya.request('room.join', { roomId: first.id });

  // Ravi rings while Priya is on Vikram's call: she holds it and answers
  const ring = nextEvent<{ room: RoomInfo }>(priya, 'room.ring');
  const second = await ravi.request('room.start', { convId: b.id, video: false });
  await ring;
  await priya.request('room.hold', { roomId: first.id, on: true });
  await priya.request('room.join', { roomId: second.id });
  const rooms = await priya.request('room.list');
  assert.equal(seat(rooms.find((r) => r.id === first.id)!, me(priya))?.held, true, 'the first call keeps her seat, on hold');
  assert.ok(seat(rooms.find((r) => r.id === second.id)!, me(priya)) && !seat(rooms.find((r) => r.id === second.id)!, me(priya))!.held);

  // back to Vikram: Ravi's call goes on hold in turn (one live call per device)
  await priya.request('room.hold', { roomId: first.id, on: false });
  const now = await priya.request('room.list');
  assert.equal(seat(now.find((r) => r.id === first.id)!, me(priya))?.held, undefined);
  assert.equal(seat(now.find((r) => r.id === second.id)!, me(priya))?.held, true);

  // joining a third Room leaves a live seat but keeps a held one
  await priya.request('room.hold', { roomId: second.id, on: false });
  const three = await owner.request('conv.create', { kind: 'space', name: 'Site', members: [me(priya)] });
  const third = await owner.request('room.start', { convId: three.id, video: false });
  await priya.request('room.hold', { roomId: second.id, on: true });
  await priya.request('room.join', { roomId: third.id });
  const after = await priya.request('room.list');
  assert.equal(seat(after.find((r) => r.id === second.id)!, me(priya))?.held, true, 'the held seat is kept');
  assert.equal(after.find((r) => r.id === first.id), undefined, 'the live one-to-one was left, so it ended');

  // a one-to-one ends when the other person hangs up, held or not: the held device is told
  const ended = nextEvent<{ roomId: string }>(priya, 'room.ended', (e) => e.roomId === second.id);
  await ravi.request('room.leave', { roomId: second.id });
  assert.equal((await ended).roomId, second.id);
});

test('only someone in the Room can put their own seat on hold', async () => {
  const { owner, priya } = await office();
  const dm = await owner.request('conv.create', { kind: 'direct', members: [me(priya)] });
  const room = await owner.request('room.start', { convId: dm.id, video: false });
  await assert.rejects(priya.request('room.hold', { roomId: room.id, on: true }), /Not in this call/);
});

test('show a screen: no voice asked for, members are told, it waits for watchers past the ring', async () => {
  const { owner, priya } = await office({});
  const dm = await owner.request('conv.create', { kind: 'direct', members: [me(priya)] });
  const ring = nextEvent<{ room: RoomInfo }>(priya, 'room.ring');
  const room = await owner.request('room.start', { convId: dm.id, video: true, share: true });
  assert.equal(room.share, true);
  assert.equal(room.video, false, 'a shared screen never asks for a camera');
  assert.equal((await ring).room.share, true, 'the other side is told it is a screen');
  const watching = await priya.request('room.join', { roomId: room.id });
  assert.equal(watching.share, true);
  assert.equal(watching.participants.length, 2);
});
