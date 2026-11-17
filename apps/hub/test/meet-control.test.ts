// "Give control" in meetings: the presenter (the device sharing its screen) grants one other
// person in the Room their mouse and keyboard; the hub keeps the grant, passes input on the relay
// only from that person and only to the presenter, ends it when sharing stops, either leaves or
// the meeting ends, and audits the start, the end and how long it lasted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlEndText, controllerRefusal, presenterOf, presenterRefusal } from '@dex/core';
import type { MeetingInfo, RoomControl, RoomInfo, RoomParticipant } from '@dex/core';
import type { HubClient } from '@dex/core/client';
import { MeetControl } from '../src/meet-control.ts';
import type { Room } from '../src/rooms.ts';
import { office, me, nextEvent } from './office.ts';

const dev = (c: HubClient) => c.session!.deviceId;
type Media = { screen?: boolean; controllable?: boolean; controlOff?: 'mac' | 'unavailable' | null; desktop?: boolean };
const media = (c: HubClient, roomId: string, m: Media) => c.request('room.media', { roomId, muted: false, camera: false, screen: !!m.screen, controllable: m.controllable, controlOff: m.controlOff ?? null, desktop: m.desktop ?? true });
const nothing = (c: HubClient, name: string, ms = 400) => nextEvent(c, name, () => true, ms).then(() => { throw new Error(`unexpected ${name}`); }, () => undefined);
const input = { k: 'in', e: [{ t: 'move', x: 0.5, y: 0.5 }] };

/** A meeting with Priya sharing her whole screen from a PC that can be controlled, Ravi and Vikram in it. */
async function meeting() {
  const o = await office();
  const { owner, priya, ravi } = o;
  const m = await priya.request('meet.create', { title: 'Model review', invite: [me(ravi), me(owner)] }) as MeetingInfo;
  const room = ((await priya.request('meet.join', { id: m.id })) as { room: RoomInfo }).room;
  await ravi.request('meet.join', { id: m.id });
  await owner.request('meet.join', { id: m.id });
  await media(ravi, room.id, {});
  await media(owner, room.id, {});
  const shared = nextEvent<RoomInfo>(ravi, 'room.updated', (r) => !!presenterOf(r));
  await media(priya, room.id, { screen: true, controllable: true });
  const seen = await shared;
  return { ...o, m, room, seen };
}

test('grant: only the presenter gives control, to one person at a time, and everyone in the Room sees who has it', async () => {
  const { owner, priya, ravi, room, seen } = await meeting();
  const p = presenterOf(seen)!;
  assert.equal(p.deviceId, dev(priya));
  assert.equal(p.controllable, true);
  assert.equal(seen.participants.find((x) => x.deviceId === dev(ravi))?.desktop, true);
  // someone who is not sharing cannot give control
  await assert.rejects(ravi.request('room.control.grant', { roomId: room.id, deviceId: dev(owner) }), /sharing their screen/);
  // not to yourself
  await assert.rejects(priya.request('room.control.grant', { roomId: room.id, deviceId: dev(priya) }), /someone else/);
  const told = nextEvent<RoomInfo>(owner, 'room.updated', (r) => !!r.control);
  const c = await priya.request('room.control.grant', { roomId: room.id, deviceId: dev(ravi) }) as RoomControl;
  assert.equal(c.presenterId, me(priya));
  assert.equal(c.controllerId, me(ravi));
  assert.equal(c.controllerDevice, dev(ravi));
  assert.equal((await told).control?.controllerId, me(ravi), 'the Room shows who has control');
  // granting again to the same person is the same grant; to another is refused
  assert.equal((await priya.request('room.control.grant', { roomId: room.id, deviceId: dev(ravi) }) as RoomControl).since, c.since);
  await assert.rejects(priya.request('room.control.grant', { roomId: room.id, deviceId: dev(owner) }), /one person at a time/);
  // asking while someone has control is refused
  await assert.rejects(owner.request('room.control.ask', { roomId: room.id }), /Someone else has control/);
  // only the presenter or the controller stops it
  await assert.rejects(owner.request('room.control.stop', { roomId: room.id }), /Only the presenter or the person in control/);
});

test('who may send: on the relay, input passes only from the person granted and only to the presenter', async () => {
  const { owner, priya, ravi, room } = await meeting();
  // before any grant nobody's input goes anywhere
  const early = nothing(priya, 'room.data');
  assert.deepEqual(await ravi.request('room.data', { roomId: room.id, data: input }), { ok: true, dropped: true });
  await early;
  await priya.request('room.control.grant', { roomId: room.id, deviceId: dev(ravi) });
  const ownerSees = nothing(owner, 'room.data');
  const got = nextEvent<{ fromDevice: string; fromUser: string; data: unknown }>(priya, 'room.data');
  assert.deepEqual(await ravi.request('room.data', { roomId: room.id, data: input }), { ok: true });
  const g = await got;
  assert.equal(g.fromDevice, dev(ravi));
  assert.deepEqual(g.data, input);
  await ownerSees;
  // anyone else's input is dropped, even addressed to the presenter
  const none = nothing(priya, 'room.data');
  assert.deepEqual(await owner.request('room.data', { roomId: room.id, data: input }), { ok: true, dropped: true });
  assert.deepEqual(await priya.request('room.data', { roomId: room.id, data: input }), { ok: true, dropped: true });
  await none;
  // other small messages (live pointers) still reach everyone
  const pt = nextEvent<{ data: { k: string } }>(owner, 'room.data');
  await ravi.request('room.data', { roomId: room.id, data: { k: 'pt', m: [] } });
  assert.equal((await pt).data.k, 'pt');
  // after Stop, the controller's input goes nowhere
  const ended = nextEvent<{ why: string; durationMs: number }>(ravi, 'room.controlEnded');
  await priya.request('room.control.stop', { roomId: room.id });
  assert.equal((await ended).why, 'stopped');
  const after = nothing(priya, 'room.data');
  assert.deepEqual(await ravi.request('room.data', { roomId: room.id, data: input }), { ok: true, dropped: true });
  await after;
});

test('asking for control: the presenter is asked and refuses or grants; asks are limited', async () => {
  const { owner, priya, ravi, room } = await meeting();
  // the presenter cannot ask for their own screen
  await assert.rejects(priya.request('room.control.ask', { roomId: room.id }), /Nobody is sharing|own screen/);
  const ask = nextEvent<{ fromDevice: string; fromUser: string }>(priya, 'room.controlAsk');
  await owner.request('room.control.ask', { roomId: room.id });
  const a = await ask;
  assert.equal(a.fromUser, me(owner));
  assert.equal(a.fromDevice, dev(owner));
  // only the presenter answers
  await assert.rejects(ravi.request('room.control.refuse', { roomId: room.id, deviceId: dev(owner) }), /sharing their screen/);
  const refused = nextEvent<{ by: string }>(owner, 'room.controlRefused');
  await priya.request('room.control.refuse', { roomId: room.id, deviceId: dev(owner) });
  assert.equal((await refused).by, me(priya));
  // a few more asks, then a pause
  for (let i = 0; i < 3; i++) await owner.request('room.control.ask', { roomId: room.id });
  await assert.rejects(owner.request('room.control.ask', { roomId: room.id }), /Wait for an answer/);
  // ravi asks and the presenter accepts by granting
  await ravi.request('room.control.ask', { roomId: room.id });
  const c = await priya.request('room.control.grant', { roomId: room.id, deviceId: dev(ravi) }) as RoomControl;
  assert.equal(c.controllerId, me(ravi));
  // the controller gives it back
  const ended = nextEvent<{ why: string; by: string }>(priya, 'room.controlEnded');
  await ravi.request('room.control.stop', { roomId: room.id });
  const e = await ended;
  assert.equal(e.why, 'released');
  assert.equal(e.by, me(ravi));
  assert.equal((await priya.request('room.list')).find((r) => r.id === room.id)?.control, undefined);
});

test('control ends on its own: sharing stops, the controller leaves, the presenter leaves, the meeting ends', async () => {
  const { owner, priya, ravi, room, m } = await meeting();
  const grant = (to: HubClient) => priya.request('room.control.grant', { roomId: room.id, deviceId: dev(to) });
  const endedFor = (c: HubClient) => nextEvent<{ why: string; durationMs: number }>(c, 'room.controlEnded');

  await grant(ravi);
  let e = endedFor(ravi);
  await media(priya, room.id, { screen: false, controllable: true });
  assert.equal((await e).why, 'sharing stopped');
  // sharing again, she can give control again
  await media(priya, room.id, { screen: true, controllable: true });
  await grant(ravi);
  e = endedFor(priya);
  await ravi.request('room.leave', { roomId: room.id });
  assert.equal((await e).why, 'controller left');

  await grant(owner);
  e = endedFor(owner);
  await priya.request('room.leave', { roomId: room.id });
  assert.equal((await e).why, 'presenter left');

  // priya comes back and shares again; the meeting ends for everyone
  await priya.request('meet.join', { id: m.id });
  await media(priya, room.id, { screen: true, controllable: true });
  await grant(owner);
  e = endedFor(owner);
  await priya.request('room.end', { roomId: room.id });
  assert.equal((await e).why, 'meeting ended');
});

test('not offered: phones and browsers as controllers, a Mac presenter (view only)', async () => {
  const { owner, priya, ravi, room } = await meeting();
  // a phone (no desktop app) is never given control and cannot ask
  await media(owner, room.id, { desktop: false });
  await assert.rejects(priya.request('room.control.grant', { roomId: room.id, deviceId: dev(owner) }), /desktop app/);
  await assert.rejects(owner.request('room.control.ask', { roomId: room.id }), /desktop app/);
  // a Mac presenter's screen is view only
  await media(priya, room.id, { screen: true, controllable: false, controlOff: 'mac' });
  await assert.rejects(priya.request('room.control.grant', { roomId: room.id, deviceId: dev(ravi) }), /Mac/);
  await assert.rejects(ravi.request('room.control.ask', { roomId: room.id }), /view only/);
  // the pure rules behind it: browser guests, phones, webinar attendees; presenters
  const p = (x: Partial<RoomParticipant>): RoomParticipant => ({ userId: 'U1', deviceId: 'D1', joinedAt: 0, muted: false, camera: false, screen: false, ...x });
  assert.match(controllerRefusal(p({ userId: 'guest:abc', desktop: true }), null)!, /browser/);
  assert.match(controllerRefusal(p({ desktop: false }), null)!, /desktop app/);
  assert.match(controllerRefusal(p({ desktop: true }), false)!, /webinar/);
  assert.equal(controllerRefusal(p({ desktop: true }), true), null);
  assert.equal(controllerRefusal(p({ desktop: true }), null), null);
  assert.match(presenterRefusal(p({ screen: false, controllable: true }))!, /Share your screen/);
  assert.match(presenterRefusal(p({ screen: true, controlOff: 'mac' }))!, /view only/);
  assert.match(presenterRefusal(p({ screen: true }))!, /cannot be controlled/);
  assert.match(presenterRefusal(p({ screen: true, controlOff: 'window' }))!, /whole screen/);
  assert.equal(presenterRefusal(p({ screen: true, controllable: true })), null);
  assert.equal(controlEndText('released', 'Priya', 'Ravi', true), 'Ravi gave control back');
  assert.equal(controlEndText('sharing stopped', 'Priya', 'Ravi', false), 'Control ended: Priya stopped sharing');
});

test('a webinar stage: an attendee invited to speak is not given control; panelists are', () => {
  const sent: Array<[string, string]> = [];
  const audits: string[] = [];
  const ctl = new MeetControl({
    host: { members: () => [], deliverToUsers: () => {}, deliverToDevice: (d, n) => { sent.push([d, n]); }, broadcast: () => {}, audit: (_a, action) => { audits.push(action); } },
    stageStaff: (_r, userId) => userId !== 'SPEAKER',
  });
  const part = (userId: string, deviceId: string, x: Partial<RoomParticipant> = {}): RoomParticipant => ({ userId, deviceId, joinedAt: 0, muted: false, camera: false, screen: false, desktop: true, ...x });
  const r = { id: 'R1', participants: [part('ORG', 'D-ORG', { screen: true, controllable: true }), part('PAN', 'D-PAN'), part('SPEAKER', 'D-SPK')], meeting: { id: '123456789', kind: 'webinar' } } as unknown as Room;
  const org = { id: 'ORG' } as never;
  assert.throws(() => ctl.handle('room.control.grant', org, 'D-ORG', r, { deviceId: 'D-SPK' }), /only the organiser and panelists/);
  assert.throws(() => ctl.handle('room.control.ask', { id: 'SPEAKER' } as never, 'D-SPK', r, {}), /only the organiser and panelists/);
  const c = ctl.handle('room.control.grant', org, 'D-ORG', r, { deviceId: 'D-PAN' }) as RoomControl;
  assert.equal(c.controllerId, 'PAN');
  // the panelist moves away: the grant ends, both are told, and it is audited
  r.participants = r.participants.filter((p) => p.deviceId !== 'D-PAN');
  ctl.check(r);
  assert.equal(ctl.view('R1'), null);
  assert.deepEqual(sent.filter(([, n]) => n === 'room.controlEnded').map(([d]) => d).sort(), ['D-ORG', 'D-PAN']);
  assert.deepEqual(audits, ['meeting.control.granted', 'meeting.control.revoked']);
});

test('audit: every grant and its end, with who, why and how long', async () => {
  const { owner, priya, ravi, room, m } = await meeting();
  await priya.request('room.control.grant', { roomId: room.id, deviceId: dev(ravi) });
  await new Promise((r) => setTimeout(r, 60));
  await priya.request('room.control.stop', { roomId: room.id });
  const audit = await owner.request('admin.audit', { limit: 50 });
  const granted = audit.find((a) => a.action === 'meeting.control.granted')!;
  const revoked = audit.find((a) => a.action === 'meeting.control.revoked')!;
  assert.ok(granted && revoked);
  assert.equal(granted.actor, me(priya));
  assert.equal(granted.target, m.id);
  assert.equal((granted.detail as { controller: string }).controller, me(ravi));
  const d = revoked.detail as { presenter: string; controller: string; durationMs: number; why: string; from: number; to: number };
  assert.equal(d.presenter, me(priya));
  assert.equal(d.controller, me(ravi));
  assert.equal(d.why, 'stopped');
  assert.ok(d.durationMs >= 50 && d.to - d.from === d.durationMs, 'how long control lasted');
});
