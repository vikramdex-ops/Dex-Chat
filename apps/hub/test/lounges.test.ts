// Lounges: they persist across a hub restart, only the Space's members see and join them, only
// administrators and Space managers rename or archive them, and colleagues see who is in one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIdentity } from '@dex/core';
import type { Lounge, PointSession, RoomInfo } from '@dex/core';
import { HubClient } from '@dex/core/client';
import { Hub } from '../src/hub.ts';
import { cleanups, office, nextEvent, me, until } from './office.ts';

test('lounges: create, join and leave freely, no ringing, presence for colleagues', async () => {
  const { owner, priya, ravi, join } = await office();
  const asha = (await join('asha')).c;
  await owner.request('admin.decide', { deviceId: (await owner.request('admin.devices')).find((x) => x.status === 'pending')!.id, approve: true });
  await until(asha, (s) => s.kind === 'ready');
  const space = await priya.request('conv.create', { kind: 'space', name: 'Piping', members: [me(ravi), me(owner)] });
  await assert.rejects(priya.request('lounge.create', { convId: space.id, name: 'x' }), /name/);
  const seen = nextEvent<Lounge>(ravi, 'lounge.updated');
  const lounge = await priya.request('lounge.create', { convId: space.id, name: '  Piping   desk ' });
  assert.equal(lounge.name, 'Piping desk');
  assert.deepEqual(lounge.people, []);
  assert.equal((await seen).id, lounge.id, 'the Space hears about it');
  await assert.rejects(ravi.request('lounge.create', { convId: space.id, name: 'piping DESK' }), /already has/);
  // someone outside the Space neither sees nor joins it
  await assert.rejects(asha.request('lounge.create', { convId: space.id, name: 'Mine' }), /not found/);
  await assert.rejects(asha.request('lounge.join', { id: lounge.id }), /not found/);
  assert.deepEqual(await asha.request('lounge.list'), []);
  // a Direct conversation has no lounges
  const dm = await priya.request('conv.create', { kind: 'direct', members: [me(ravi)] });
  await assert.rejects(priya.request('lounge.create', { convId: dm.id, name: 'Chat' }), /Spaces/);

  let rang = false;
  for (const c of [ravi, owner, asha]) c.on('event', (n: string) => { if (n === 'room.ring') rang = true; });
  const where = nextEvent<{ userId: string; name: string | null }>(ravi, 'lounge.where', (w) => w.userId === me(priya));
  const whereOutside = nextEvent<{ userId: string; name: string | null }>(asha, 'lounge.where', (w) => w.userId === me(priya));
  const room = await priya.request('lounge.join', { id: lounge.id });
  assert.equal(room.purpose?.kind, 'lounge');
  assert.equal(room.ringing.length, 0);
  assert.equal(room.mode, 'mesh');
  assert.equal((await where).name, 'Piping desk', 'Space members see where');
  assert.equal((await whereOutside).name, null, 'others only that she is in a lounge');
  const busy = nextEvent<Lounge>(priya, 'lounge.updated', (l) => l.people.length === 2);
  const r2 = await ravi.request('lounge.join', { id: lounge.id });
  assert.equal(r2.id, room.id, 'the same Room');
  assert.deepEqual((await busy).people.map((p) => p.userId).sort(), [me(priya), me(ravi)].sort());
  assert.equal(rang, false, 'nobody is rung');
  // the Space sees who is speaking in the lounge; muting stops it
  const speaking = nextEvent<Lounge>(owner, 'lounge.updated', (l) => l.people.some((p) => p.speaking));
  await priya.request('room.speaking', { roomId: room.id, speaking: true });
  assert.equal((await speaking).people.find((p) => p.speaking)!.userId, me(priya));
  const quiet = nextEvent<Lounge>(owner, 'lounge.updated', (l) => l.people.every((p) => !p.speaking));
  await priya.request('room.media', { roomId: room.id, muted: true, camera: false, screen: false });
  await quiet;
  assert.deepEqual((await asha.request('lounge.presence')).map((p) => [p.userId, p.name]).sort(), [[me(priya), null], [me(ravi), null]].sort());
  assert.deepEqual((await owner.request('lounge.presence')).map((p) => p.name), ['Piping desk', 'Piping desk']);
  // a lounge Room is not the Space's call: opening a Room in the Space starts a separate one
  const call = await owner.request('room.start', { convId: space.id, video: false });
  assert.notEqual(call.id, room.id);
  assert.equal(call.purpose, undefined);
  await owner.request('room.leave', { roomId: call.id });
  // lounges never ring anyone in
  await assert.rejects(priya.request('room.invite', { roomId: room.id, userIds: [me(owner)] }), /never ring/);
  // a lounge with two people does not end when one leaves (unlike a one-to-one call)
  await priya.request('room.leave', { roomId: room.id });
  const listed = (await ravi.request('lounge.list', { convId: space.id }))[0];
  assert.deepEqual(listed.people.map((p) => p.userId), [me(ravi)]);
  const empty = nextEvent<Lounge>(priya, 'lounge.updated', (l) => l.people.length === 0);
  await ravi.request('room.leave', { roomId: room.id });
  assert.equal((await empty).roomId, null);
  // still there, empty
  assert.equal((await priya.request('lounge.list', { convId: space.id })).length, 1);
});

test('lounges: only administrators and Space managers rename or archive them; archiving empties them', async () => {
  const { owner, priya, ravi } = await office();
  const space = await priya.request('conv.create', { kind: 'space', name: 'Site coordination', members: [me(ravi), me(owner)] });
  const lounge = await ravi.request('lounge.create', { convId: space.id, name: 'Site desk' });
  await assert.rejects(ravi.request('lounge.rename', { id: lounge.id, name: 'Site room' }), /managers/);
  const renamed = await priya.request('lounge.rename', { id: lounge.id, name: 'Site room' });
  assert.equal(renamed.name, 'Site room');
  // the administrator manages every Space's lounges; people in the lounge leave when it is archived
  const room = await ravi.request('lounge.join', { id: lounge.id });
  const gone = nextEvent<{ roomId: string }>(ravi, 'room.ended', (e) => e.roomId === room.id);
  await assert.rejects(ravi.request('lounge.archive', { id: lounge.id, archived: true }), /managers/);
  const archived = await owner.request('lounge.archive', { id: lounge.id, archived: true });
  assert.equal(archived.archived, true);
  await gone;
  await assert.rejects(ravi.request('lounge.join', { id: lounge.id }), /archived/);
  assert.deepEqual(await ravi.request('lounge.list', { convId: space.id }), [], 'members no longer see it');
  assert.equal((await priya.request('lounge.list', { convId: space.id }))[0].archived, true, 'its managers can bring it back');
  const back = await priya.request('lounge.archive', { id: lounge.id, archived: false });
  assert.equal(back.archived, false);
  // a moderator is a manager too
  await priya.request('conv.settings', { convId: space.id, moderators: [me(ravi)] });
  assert.equal((await ravi.request('lounge.rename', { id: lounge.id, name: 'Site desk' })).name, 'Site desk');
});

test('lounges persist across a hub restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexlounge-'));
  const start = async () => { const h = new Hub({ dataDir: dir, port: 0, host: '127.0.0.1', discoveryPort: false, updates: false, relay: false }); await h.start(); return h; };
  const identity = createIdentity();
  const connect = async (h: Hub) => {
    const c = new HubClient({ identity, account: { username: 'vikram', domain: 'DEX', displayName: 'Vikram', hostname: 'vikram-pc' } });
    c.connect({ host: '127.0.0.1', port: h.port, fp: h.fingerprint });
    await until(c, (s) => s.kind === 'ready');
    return c;
  };
  let hub = await start();
  let c = await connect(hub);
  const space = await c.request('conv.create', { kind: 'space', name: 'Drawing office', members: [] });
  const made = await c.request('lounge.create', { convId: space.id, name: 'Checking desk' });
  await c.request('lounge.create', { convId: space.id, name: 'Quiet corner' });
  await c.request('lounge.archive', { id: made.id, archived: true });
  c.disconnect();
  await hub.stop();
  hub = await start();
  cleanups.push(async () => { c.disconnect(); await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  c = await connect(hub);
  const list = await c.request('lounge.list', { convId: space.id });
  assert.deepEqual(list.map((l) => [l.name, l.archived]), [['Checking desk', true], ['Quiet corner', false]]);
  const room: RoomInfo = await c.request('lounge.join', { id: list[1].id });
  assert.equal(room.purpose?.kind, 'lounge');
});

test('pointers: people looking at the same file see each other\'s messages; only viewers who can open it', async () => {
  const { owner, priya, ravi, join } = await office();
  const asha = (await join('asha')).c;
  await owner.request('admin.decide', { deviceId: (await owner.request('admin.devices')).find((x) => x.status === 'pending')!.id, approve: true });
  await until(asha, (s) => s.kind === 'ready');
  const space = await priya.request('conv.create', { kind: 'space', name: 'Checking', members: [me(ravi)] });
  const board = await priya.request('board.create', { convId: space.id, title: 'Rack layout' });
  const surface = `board:${board.id}`;
  await assert.rejects(asha.request('point.join', { surface }), /not found/);
  await assert.rejects(priya.request('point.join', { surface: 'file:../../etc' }), /Unknown/);
  const invite = nextEvent<{ surface: string; by: string; name: string }>(ravi, 'point.invite');
  const s1 = await priya.request('point.join', { surface, convId: space.id, invite: true, name: 'Rack layout' });
  assert.equal(s1.presenter, me(priya));
  assert.equal((await invite).by, me(priya));
  const joined = nextEvent<PointSession>(priya, 'point.session', (s) => s.viewers.length === 2);
  await ravi.request('point.join', { surface });
  await joined;
  const got = nextEvent<{ fromUser: string; data: unknown }>(ravi, 'point.data');
  await priya.request('point.send', { surface, data: { k: 'pt', m: [{ k: 'cur', x: 0.5, y: 0.5 }] } });
  assert.deepEqual((await got).data, { k: 'pt', m: [{ k: 'cur', x: 0.5, y: 0.5 }] });
  await assert.rejects(asha.request('point.send', { surface, data: {} }), /Open it first/);
  await assert.rejects(ravi.request('point.set', { surface, enabled: false }), /presenting/);
  const off = await priya.request('point.set', { surface, enabled: false });
  assert.equal(off.enabled, false);
  // the presenter leaves: the next viewer presents
  const handed = nextEvent<PointSession>(ravi, 'point.session', (s) => s.presenter === me(ravi));
  await priya.request('point.leave', { surface });
  await handed;
});

test('room.data: small messages reach everyone else in the Room, not people outside it', async () => {
  const { owner, priya, ravi } = await office();
  const space = await priya.request('conv.create', { kind: 'space', name: 'Review', members: [me(ravi), me(owner)] });
  const lounge = await priya.request('lounge.create', { convId: space.id, name: 'Review desk' });
  const room = await priya.request('lounge.join', { id: lounge.id });
  await ravi.request('lounge.join', { id: lounge.id });
  let ownerGot = false;
  owner.on('event', (n: string) => { if (n === 'room.data') ownerGot = true; });
  const got = nextEvent<{ fromUser: string; data: unknown }>(ravi, 'room.data');
  await priya.request('room.data', { roomId: room.id, data: { k: 'pt', m: [{ k: 'cur', x: 0.1, y: 0.2 }] } });
  const e = await got;
  assert.equal(e.fromUser, me(priya));
  assert.deepEqual(e.data, { k: 'pt', m: [{ k: 'cur', x: 0.1, y: 0.2 }] });
  await assert.rejects(owner.request('room.data', { roomId: room.id, data: {} }), /Not in this call/);
  await assert.rejects(priya.request('room.data', { roomId: room.id, data: 'x'.repeat(9000) }), /too large/);
  // a flood is cut to 60 a second
  const results = await Promise.all(Array.from({ length: 80 }, () => priya.request('room.data', { roomId: room.id, data: { k: 'pt', m: [] } })));
  assert.ok(results.filter((r) => (r as { limited?: boolean }).limited).length >= 19);
  assert.equal(ownerGot, false);
});
