// "Give control" to a guest in a browser: the guest may ask; the presenter must pick that guest
// on purpose (the grant says guest: true); the guest's input comes through the gateway and goes
// only to the presenter, checked here first; the guest's page learns who has control, a refusal
// and why it ended; a screen shared from a browser is never offered; it is all audited.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_VIEW_ONLY, askerRefusal, controllerRefusal, presenterRefusal } from '@dex/core';
import type { GuestDown, GuestLinkView, MeetingInfo, RoomControl, RoomInfo, RoomParticipant } from '@dex/core';
import type { HubClient } from '@dex/core/client';
import type { Hub } from '../src/hub.ts';
import { office, me, nextEvent } from './office.ts';

const dev = (c: HubClient) => c.session!.deviceId;
const nothing = (c: HubClient, name: string, ms = 400) => nextEvent(c, name, () => true, ms).then(() => { throw new Error(`unexpected ${name}`); }, () => undefined);

/** A fake gateway: the frames the hub sends a guest, and a way to send theirs. */
function gateway(hub: Hub) {
  const frames = new Map<number, GuestDown[]>();
  hub.gateway.sendGuest = (gid: number, f: unknown) => { (frames.get(gid) ?? frames.set(gid, []).get(gid)!).push(f as GuestDown); };
  hub.gateway.closeGuest = () => {};
  hub.meetGuests.dropAll = () => {};
  return (meetingId: string, gid: number) => {
    hub.meetGuests.open(gid, '203.0.113.9', meetingId);
    const send = (f: unknown) => hub.meetGuests.frame(gid, JSON.stringify(f));
    const wait = async <T extends GuestDown['t']>(t: T, ok: (f: Extract<GuestDown, { t: T }>) => boolean = () => true, ms = 4000): Promise<Extract<GuestDown, { t: T }>> => {
      const end = Date.now() + ms;
      for (;;) {
        const hit = (frames.get(gid) ?? []).find((f) => f.t === t && ok(f as Extract<GuestDown, { t: T }>));
        if (hit) { frames.set(gid, (frames.get(gid) ?? []).filter((f) => f !== hit)); return hit as Extract<GuestDown, { t: T }>; }
        if (Date.now() > end) throw new Error(`no ${t} frame (have ${(frames.get(gid) ?? []).map((f) => f.t).join(', ')})`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    return { send, wait };
  };
}

/** Priya shares a whole, controllable screen; Ravi is in the app; Dana is a guest in a browser. */
async function meeting() {
  const o = await office();
  const { hub, owner, priya, ravi } = o;
  await owner.request('admin.remote.set', { url: 'https://dexconnect-gateway.example.workers.dev', enabled: true });
  const open = gateway(hub);
  const m = await priya.request('meet.create', { title: 'Design review', invite: [me(ravi)] }) as MeetingInfo;
  const link = await priya.request('meet.guestLink', { id: m.id, enabled: true }) as GuestLinkView;
  const room = (await priya.request('meet.join', { id: m.id })).room!;
  await ravi.request('meet.join', { id: m.id });
  const dana = open(m.id, 501);
  const knock = nextEvent<RoomInfo>(priya, 'room.updated', (r) => (r.lobby ?? []).length === 1);
  dana.send({ t: 'join', name: 'Dana Wright', passcode: link.passcode });
  const guestDevice = (await knock).lobby![0].deviceId;
  await priya.request('room.admit', { roomId: room.id, deviceIds: [guestDevice], allow: true });
  const admitted = await dana.wait('admitted');
  await ravi.request('room.media', { roomId: room.id, muted: false, camera: false, screen: false, desktop: true });
  await priya.request('room.media', { roomId: room.id, muted: false, camera: false, screen: true, controllable: true, desktop: true });
  return { ...o, m, room, dana, guestDevice, admitted, open, link };
}

test('a guest asks; the presenter refuses, then picks the guest on purpose; input passes only from them, only to the presenter', async () => {
  const { owner, priya, ravi, room, dana, guestDevice } = await meeting();
  // the guest's page knows Priya's screen can be controlled
  const v = await dana.wait('room', (f) => !!f.room.seats.find((s) => s.screen)?.controllable);
  assert.equal(v.room.control, null);
  // the guest asks: Priya is asked, and refuses; the guest's page is told
  const asked = nextEvent<{ fromDevice: string; fromUser: string }>(priya, 'room.controlAsk');
  dana.send({ t: 'control', a: 'ask' });
  assert.equal((await asked).fromDevice, guestDevice);
  await priya.request('room.control.refuse', { roomId: room.id, deviceId: guestDevice });
  assert.equal((await dana.wait('control', (f) => f.state === 'refused')).text, 'Priya said no to control for now');
  // a grant to a guest without picking them on purpose is refused
  await assert.rejects(priya.request('room.control.grant', { roomId: room.id, deviceId: guestDevice }), /only when the person sharing picks them/);
  // picked on purpose: granted, and everyone sees a guest has it
  const c = await priya.request('room.control.grant', { roomId: room.id, deviceId: guestDevice, guest: true }) as RoomControl;
  assert.equal(c.controllerDevice, guestDevice);
  assert.equal(c.guest, true);
  const gv = await dana.wait('room', (f) => !!f.room.control);
  assert.deepEqual(gv.room.control, { presenterDevice: dev(priya), controllerDevice: guestDevice, controllerName: 'Dana Wright' });
  // the guest's input reaches Priya (cleaned: unknown keys and junk dropped), and nobody else
  const ravisSees = nothing(ravi, 'room.data');
  const got = nextEvent<{ fromDevice: string; fromUser: string; data: { k: string; e: unknown[] } }>(priya, 'room.data');
  dana.send({ t: 'input', e: [{ t: 'move', x: 0.25, y: 2 }, { t: 'key', code: 'NotAKey', down: true }, 'junk', { t: 'button', b: 'left', down: true, x: 0.25, y: 0.5 }] });
  const g = await got;
  assert.equal(g.fromDevice, guestDevice);
  assert.match(g.fromUser, /^guest:/);
  assert.deepEqual(g.data, { k: 'in', e: [{ t: 'move', x: 0.25, y: 1 }, { t: 'button', b: 'left', down: true, x: 0.25, y: 0.5 }] });
  await ravisSees;
  // anything else from the guest goes nowhere
  const quiet = nothing(priya, 'room.data');
  dana.send({ t: 'input', e: 'nope' });
  dana.send({ t: 'input' });
  await quiet;
  // the audit says a guest was given control, by name
  const audit = await owner.request('admin.audit', { limit: 50 }) as Array<{ action: string; detail: Record<string, unknown> }>;
  const granted = audit.find((x) => x.action === 'meeting.control.granted')!;
  assert.equal(granted.detail.guest, true);
  assert.equal(granted.detail.controllerName, 'Dana Wright');
  // Priya takes it back: the guest is told, and their input stops going anywhere
  await priya.request('room.control.stop', { roomId: room.id });
  assert.equal((await dana.wait('control', (f) => f.state === 'ended')).text, 'Priya took back control');
  const after = nothing(priya, 'room.data');
  dana.send({ t: 'input', e: [{ t: 'move', x: 0.5, y: 0.5 }] });
  await after;
  const revoked = (await owner.request('admin.audit', { limit: 50 }) as Array<{ action: string; detail: Record<string, unknown> }>).find((x) => x.action === 'meeting.control.revoked')!;
  assert.equal(revoked.detail.guest, true);
  assert.equal(revoked.detail.why, 'stopped');
});

test('a guest gives control back, or leaves: it ends, and both sides are told', async () => {
  const { priya, room, dana, guestDevice, m, open, link } = await meeting();
  await priya.request('room.control.grant', { roomId: room.id, deviceId: guestDevice, guest: true });
  const ended = nextEvent<{ why: string }>(priya, 'room.controlEnded');
  dana.send({ t: 'control', a: 'stop' });
  assert.equal((await ended).why, 'released');
  assert.equal((await dana.wait('control', (f) => f.state === 'ended')).text, 'You gave control back to Priya');
  // again, and the guest closes the page
  await priya.request('room.control.grant', { roomId: room.id, deviceId: guestDevice, guest: true });
  const left = nextEvent<{ why: string }>(priya, 'room.controlEnded');
  dana.send({ t: 'leave' });
  assert.equal((await left).why, 'controller left');
  // a second guest cannot take over a grant, or send input for someone else
  const eve = open(m.id, 502);
  const knock = nextEvent<RoomInfo>(priya, 'room.updated', (r) => (r.lobby ?? []).length === 1);
  eve.send({ t: 'join', name: 'Eve', passcode: link.passcode });
  const eveDevice = (await knock).lobby![0].deviceId;
  await priya.request('room.admit', { roomId: room.id, deviceIds: [eveDevice], allow: true });
  await eve.wait('admitted');
  const quiet = nothing(priya, 'room.data');
  eve.send({ t: 'input', e: [{ t: 'move', x: 0.5, y: 0.5 }] });
  await quiet;
});

test('a screen shared from a browser is view only; the rules for who may ask and be given control', async () => {
  const { priya, ravi, room, dana, guestDevice } = await meeting();
  // Priya stops; the guest shares from the browser: nobody can ask for or be given control of it
  await priya.request('room.media', { roomId: room.id, muted: false, camera: false, screen: false, desktop: true });
  const shared = nextEvent<RoomInfo>(ravi, 'room.updated', (r) => !!r.participants.find((p) => p.deviceId === guestDevice)?.screen);
  dana.send({ t: 'media', muted: false, camera: false, screen: true, controllable: true });
  const r = await shared;
  const gp = r.participants.find((p) => p.deviceId === guestDevice)!;
  assert.equal(gp.controllable, false, 'a browser cannot claim it can be controlled');
  assert.equal(presenterRefusal(gp), BROWSER_VIEW_ONLY);
  await assert.rejects(ravi.request('room.control.ask', { roomId: room.id }), /view only/);
  const v = await dana.wait('room', (f) => !!f.room.seats.find((s) => s.deviceId === guestDevice)?.screen);
  assert.equal(v.room.seats.find((s) => s.deviceId === guestDevice)!.controllable, undefined);
  // the pure rules
  const p = (x: Partial<RoomParticipant>): RoomParticipant => ({ userId: 'U1', deviceId: 'D1', joinedAt: 0, muted: false, camera: false, screen: false, ...x });
  assert.match(controllerRefusal(p({ userId: 'guest:abc' }), null)!, /picks them/);
  assert.equal(controllerRefusal(p({ userId: 'guest:abc' }), null, { guestPicked: true }), null);
  assert.match(controllerRefusal(p({ userId: 'guest:abc' }), false, { guestPicked: true })!, /webinar/);
  assert.equal(askerRefusal(p({ userId: 'guest:abc' }), null), null, 'a guest may ask');
  assert.match(askerRefusal(p({ userId: 'guest:abc' }), false)!, /webinar/);
  assert.match(askerRefusal(p({ desktop: false }), null)!, /desktop app/, 'a phone may not ask');
  assert.equal(askerRefusal(p({ desktop: true }), null), null);
  assert.match(askerRefusal(undefined, null)!, /left/);
});
