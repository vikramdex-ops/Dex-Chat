// Guests from a browser (M2): the guest link and its passcode, the guest's limited session (the
// meeting and nothing else), the lobby they always wait in, signalling, the meeting chat, host
// controls on a guest, and the relay meetings browsers cannot reach. The gateway is replaced by
// a recorder of the frames the hub would send it; the gateway itself is tested in apps/gateway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GuestDown, GuestLinkView, MeetingInfo, RoomChatLine, RoomInfo } from '@dex/core';
import type { HubClient } from '@dex/core/client';
import type { Hub } from '../src/hub.ts';
import { office, me, nextEvent } from './office.ts';

const dev = (c: HubClient) => c.session!.deviceId;

/** A fake gateway: what the hub sends each guest, and how their connection was closed. */
function fakeGateway(hub: Hub) {
  const frames = new Map<number, GuestDown[]>();
  const closed = new Map<number, { code: number; reason: string }>();
  const waiters: Array<() => void> = [];
  hub.gateway.sendGuest = (gid: number, f: unknown) => { (frames.get(gid) ?? frames.set(gid, []).get(gid)!).push(f as GuestDown); for (const w of waiters.splice(0)) w(); };
  hub.gateway.closeGuest = (gid: number, code: number, reason: string) => { closed.set(gid, { code, reason }); for (const w of waiters.splice(0)) w(); };
  // the hub keeps trying to reach the example gateway, and drops every guest each time it fails:
  // for these tests the guests stay connected (on a busy machine the attempt can fail mid-test)
  hub.meetGuests.dropAll = () => {};
  let next = 100;
  const open = (meetingId: string, ip = '203.0.113.7') => {
    const gid = next++;
    hub.meetGuests.open(gid, ip, meetingId);
    const send = (f: unknown) => hub.meetGuests.frame(gid, JSON.stringify(f));
    const wait = async <T extends GuestDown['t']>(t: T, ms = 4000): Promise<Extract<GuestDown, { t: T }>> => {
      const end = Date.now() + ms;
      for (;;) {
        const hit = (frames.get(gid) ?? []).find((f) => f.t === t);
        if (hit) { frames.set(gid, (frames.get(gid) ?? []).filter((f) => f !== hit)); return hit as Extract<GuestDown, { t: T }>; }
        if (Date.now() > end) throw new Error(`no ${t} frame (have ${(frames.get(gid) ?? []).map((f) => f.t).join(', ')})`);
        await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 50); });
      }
    };
    const isClosed = async (ms = 4000) => {
      const end = Date.now() + ms;
      while (!closed.has(gid)) { if (Date.now() > end) throw new Error('not closed'); await new Promise((r) => setTimeout(r, 20)); }
      return closed.get(gid)!;
    };
    return { gid, send, wait, isClosed, frames: () => frames.get(gid) ?? [] };
  };
  return { open };
}

async function withGateway(owner: HubClient) {
  // the gateway address makes the link; the hub keeps trying to reach it in the background
  await owner.request('admin.remote.set', { url: 'https://dexconnect-gateway.example.workers.dev', enabled: true });
}

test('the guest link: hosts turn it on, see the passcode, renew it; the office can turn guest links off', async () => {
  const { owner, priya, ravi } = await office();
  const m = await priya.request('meet.create', { title: 'Client review', invite: [me(ravi)] }) as MeetingInfo;
  let g = await priya.request('meet.guestLink', { id: m.id }) as GuestLinkView;
  assert.equal(g.enabled, false);
  assert.equal(g.url, null);
  await assert.rejects(ravi.request('meet.guestLink', { id: m.id }), /host/);
  g = await priya.request('meet.guestLink', { id: m.id, enabled: true });
  assert.equal(g.enabled, true);
  assert.match(g.passcode!, /^[A-Za-z0-9]{8}$/);
  assert.equal(g.url, null, 'no gateway yet');
  assert.match(g.problem!, /gateway/);
  await withGateway(owner);
  g = await priya.request('meet.guestLink', { id: m.id });
  // with no meeting site set, the page is on the gateway's own address: /482-913-207#passcode
  assert.equal(g.url, `https://dexconnect-gateway.example.workers.dev/${m.id.slice(0, 3)}-${m.id.slice(3, 6)}-${m.id.slice(6)}#${g.passcode}`);
  assert.equal(g.problem, null);
  const renewed = await priya.request('meet.guestLink', { id: m.id, regenerate: true });
  assert.notEqual(renewed.passcode, g.passcode);
  assert.ok(renewed.url!.endsWith(`#${renewed.passcode}`));
  // the office turns guest links off: the link stops, and hosts are told why
  await owner.request('admin.policy.set', { guestLinks: false });
  g = await priya.request('meet.guestLink', { id: m.id });
  assert.equal(g.enabled, false);
  assert.equal(g.url, null);
  assert.match(g.problem!, /turned guest links off/);
  await assert.rejects(priya.request('meet.guestLink', { id: m.id, enabled: true }), /turned guest links off/);
  const audit = await owner.request('admin.audit', { limit: 50 }) as Array<{ action: string }>;
  for (const a of ['meeting.guestLinkOn', 'meeting.guestLinkRenewed']) assert.ok(audit.some((x) => x.action === a), a);
});

test('a guest from a browser: passcode, lobby (always), admitted into the meeting and nothing else', async () => {
  const { hub, owner, priya, ravi } = await office();
  await withGateway(owner);
  const gw = fakeGateway(hub);
  // no lobby for anyone in this meeting: guests still wait
  const m = await priya.request('meet.create', { title: 'Site handover', invite: [me(ravi)], settings: { lobby: 'off' } }) as MeetingInfo;
  const link = await priya.request('meet.guestLink', { id: m.id, enabled: true }) as GuestLinkView;

  // a wrong passcode closes the connection with the code the gateway counts
  const bad = gw.open(m.id);
  bad.send({ t: 'join', name: 'Mallory', passcode: 'WRONG123' });
  assert.equal((await bad.isClosed()).code, 4403);
  assert.match((await bad.wait('denied')).reason, /passcode is wrong/);
  // a meeting that does not exist answers the same (no probing for IDs)
  const none = gw.open('123456789');
  none.send({ t: 'join', name: 'Mallory', passcode: link.passcode });
  assert.equal((await none.isClosed()).code, 4403);

  // the right passcode, before the meeting starts: the lobby
  const dana = gw.open(m.id, '198.51.100.20');
  dana.send({ t: 'join', name: '', passcode: link.passcode });
  assert.match((await dana.wait('error')).message, /name/);
  dana.send({ t: 'join', name: 'Dana <b>Wright</b>', passcode: link.passcode });
  const lobby = await dana.wait('lobby');
  assert.equal(lobby.title, 'Site handover');
  assert.equal(lobby.host, 'Priya');
  // anything but the meeting is refused while waiting
  dana.send({ t: 'chat', text: 'hello?' });
  assert.match((await dana.wait('error')).message, /Wait until the host/);

  // the host starts the meeting: Dana is in its lobby, named, as a guest
  const knock = nextEvent<RoomInfo>(priya, 'room.updated', (r) => (r.lobby ?? []).length === 1);
  const room = (await priya.request('meet.join', { id: m.id })).room!;
  const seen = await knock;
  const guestEntry = seen.lobby![0];
  assert.match(guestEntry.userId, /^guest:/);
  assert.deepEqual(seen.visitors?.map((v) => v.name), ['Dana b Wright /b']);
  // ravi (no lobby for him) walks straight in
  assert.ok((await ravi.request('meet.join', { id: m.id })).room);

  // admitted: the Room as a guest sees it (names and media), ICE servers and the chat so far
  await priya.request('room.chat', { roomId: room.id, text: 'Welcome, we start in a minute' });
  await priya.request('room.admit', { roomId: room.id, deviceIds: [guestEntry.deviceId], allow: true });
  const inside = await dana.wait('admitted');
  assert.equal(inside.self.deviceId, guestEntry.deviceId);
  assert.deepEqual(inside.room.seats.map((s) => s.name).sort(), ['Dana b Wright /b', 'Priya', 'Ravi']);
  assert.ok(inside.room.seats.find((s) => s.name === 'Priya')!.host);
  assert.ok(Array.isArray(inside.iceServers) && inside.iceServers.length >= 1);
  assert.deepEqual(inside.chat.map((l) => l.text), ['Welcome, we start in a minute']);
  // nothing about the office beyond the meeting: no conversation, no accounts
  const json = JSON.stringify(inside);
  assert.ok(!json.includes(m.convId!), 'no conversation id');
  assert.ok(!json.includes(me(priya)) && !json.includes(me(ravi)), 'no office user ids');
  assert.ok(!json.includes('DEX'), 'no Windows accounts');
  dana.send({ t: 'op', op: 'directory.list' });
  assert.match((await dana.wait('error')).message, /Not available to guests/);

  // the apps see her as a visitor in the Room
  const list = (await priya.request('room.list')).find((r) => r.id === room.id)!;
  assert.equal(list.participants.length, 3);
  assert.equal(list.visitors?.[0].name, 'Dana b Wright /b');

  // signalling both ways, with the same perfect-negotiation messages as between PCs
  const toPriya = nextEvent<{ fromDevice: string; fromUser: string; data: { description: { type: string } } }>(priya, 'room.signal');
  dana.send({ t: 'signal', to: dev(priya), data: { description: { type: 'offer', sdp: 'v=0' } } });
  const sig = await toPriya;
  assert.equal(sig.fromDevice, guestEntry.deviceId);
  assert.equal(sig.data.description.type, 'offer');
  await priya.request('room.signal', { roomId: room.id, toDevice: guestEntry.deviceId, data: { description: { type: 'answer', sdp: 'v=0' } } });
  const back = await dana.wait('signal');
  assert.equal(back.from, dev(priya));
  // she cannot signal someone outside the Room
  dana.send({ t: 'signal', to: dev(owner), data: {} });
  assert.match((await dana.wait('error')).message, /Not in this call/);

  // the meeting chat, both ways; media state; hands and reactions
  const line = nextEvent<RoomChatLine>(ravi, 'room.chat', (l) => l.guest);
  dana.send({ t: 'chat', text: 'Thanks, I can hear you' });
  const got = await line;
  assert.equal(got.name, 'Dana b Wright /b');
  assert.equal(got.text, 'Thanks, I can hear you');
  await ravi.request('room.chat', { roomId: room.id, text: 'Good morning Dana' });
  assert.ok((await dana.wait('chat')).line.text === 'Thanks, I can hear you');
  assert.equal((await dana.wait('chat')).line.text, 'Good morning Dana');
  const media = nextEvent<RoomInfo>(priya, 'room.updated', (r) => !!r.participants.find((p) => p.deviceId === guestEntry.deviceId)?.camera);
  dana.send({ t: 'media', muted: false, camera: true, screen: true });
  assert.ok((await media).participants.find((p) => p.deviceId === guestEntry.deviceId)!.screen);
  const hand = nextEvent<RoomInfo>(priya, 'room.updated', (r) => (r.hands ?? []).length === 1);
  dana.send({ t: 'hand', up: true });
  assert.equal((await hand).hands![0].deviceId, guestEntry.deviceId);
  const reaction = nextEvent<{ deviceId: string; emoji: string }>(ravi, 'room.reaction');
  dana.send({ t: 'react', emoji: '👏' });
  assert.equal((await reaction).deviceId, guestEntry.deviceId);
  // her own reaction floats up her tile on her page too
  assert.equal((await dana.wait('reaction')).emoji, '👏');
  await ravi.request('room.react', { roomId: room.id, emoji: '👍' });
  assert.equal((await dana.wait('reaction')).emoji, '👍');

  // host controls reach the guest: mute, then remove
  await priya.request('room.mute', { roomId: room.id, deviceId: guestEntry.deviceId });
  assert.equal((await dana.wait('muted')).by, 'Priya');
  // a guest never inherits the host's controls
  await priya.request('room.leave', { roomId: room.id });
  const after = (await ravi.request('room.list')).find((r) => r.id === room.id)!;
  assert.ok(!(after.coHosts ?? []).some((u) => u.startsWith('guest:')));
  assert.ok((after.coHosts ?? []).includes(me(ravi)));
  const gone = nextEvent<RoomInfo>(ravi, 'room.updated', (r) => r.participants.length === 1);
  await ravi.request('room.remove', { roomId: room.id, deviceId: guestEntry.deviceId });
  assert.match((await dana.wait('denied')).reason, /took you out/);
  assert.equal((await dana.isClosed()).code, 4000);
  await gone;
  const audit = await owner.request('admin.audit', { limit: 80 }) as Array<{ action: string }>;
  for (const a of ['meeting.started', 'meeting.guestKnocked', 'meeting.admitted', 'meeting.guestJoined', 'meeting.removed']) assert.ok(audit.some((x) => x.action === a), a);
});

test('wrong passcodes are limited per address; a guest leaving the page leaves the Room', async () => {
  const { hub, owner, priya } = await office();
  await withGateway(owner);
  const gw = fakeGateway(hub);
  const m = await priya.request('meet.create', { title: 'Vendor call' }) as MeetingInfo;
  const link = await priya.request('meet.guestLink', { id: m.id, enabled: true }) as GuestLinkView;
  for (let i = 0; i < 9; i++) {
    const t = gw.open(m.id, '192.0.2.50');
    t.send({ t: 'join', name: 'Guesser', passcode: `Try${String(i).padStart(5, '0')}` });
    assert.equal((await t.isClosed()).code, 4403);
  }
  const tenth = gw.open(m.id, '192.0.2.50');
  tenth.send({ t: 'join', name: 'Guesser', passcode: 'Try99999' });
  assert.equal((await tenth.isClosed()).code, 4429);
  // even the right passcode now waits ten minutes from that address; other addresses are fine
  const blocked = gw.open(m.id, '192.0.2.50');
  blocked.send({ t: 'join', name: 'Guesser', passcode: link.passcode });
  assert.equal((await blocked.isClosed()).code, 4429);

  const room = (await priya.request('meet.join', { id: m.id })).room!;
  const ok = gw.open(m.id, '198.51.100.9');
  const knock = nextEvent<RoomInfo>(priya, 'room.updated', (r) => (r.lobby ?? []).length === 1);
  ok.send({ t: 'join', name: 'Sam Lee', passcode: link.passcode });
  await ok.wait('lobby');
  const entry = (await knock).lobby![0];
  await priya.request('room.admit', { roomId: room.id, deviceIds: [entry.deviceId], allow: true });
  await ok.wait('admitted');
  const left = nextEvent<RoomInfo>(priya, 'room.updated', (r) => r.participants.length === 1);
  hub.meetGuests.closed(ok.gid);
  await left;
  assert.deepEqual(hub.meetGuests.summary(), { connected: 0, waiting: 0, inMeetings: 0 });

  // denied at the lobby: told, and closed
  const no = gw.open(m.id, '198.51.100.10');
  const knock2 = nextEvent<RoomInfo>(priya, 'room.updated', (r) => (r.lobby ?? []).length === 1);
  no.send({ t: 'join', name: 'Uninvited', passcode: link.passcode });
  await no.wait('lobby');
  await priya.request('room.admit', { roomId: room.id, deviceIds: [(await knock2).lobby![0].deviceId], allow: false });
  assert.match((await no.wait('denied')).reason, /did not let you in/);
  // a locked meeting refuses guests before the lobby
  await priya.request('room.lock', { roomId: room.id, locked: true });
  const late = gw.open(m.id, '198.51.100.11');
  late.send({ t: 'join', name: 'Late', passcode: link.passcode });
  assert.match((await late.wait('denied')).reason, /locked/);
});

test('relay meetings stay on the office network: a browser guest is refused and the hosts are told', async () => {
  const { hub, owner, priya } = await office();
  await withGateway(owner);
  const gw = fakeGateway(hub);
  const m = await priya.request('meet.create', { title: 'All hands' }) as MeetingInfo;
  const link = await priya.request('meet.guestLink', { id: m.id, enabled: true }) as GuestLinkView;
  const room = (await priya.request('meet.join', { id: m.id })).room!;
  // the Room runs on the hub's relay (more than 8 people on the office network)
  hub.rooms.rooms.get(room.id)!.mode = 'relay';
  const told = nextEvent<{ name: string; reason: string }>(priya, 'meet.guestRefused');
  const g = gw.open(m.id);
  g.send({ t: 'join', name: 'Kim Outside', passcode: link.passcode });
  assert.match((await g.wait('denied')).reason, /office network only/);
  assert.equal((await g.isClosed()).code, 4409);
  const t = await told;
  assert.equal(t.name, 'Kim Outside');
  assert.match(t.reason, /relay/);
  const view = await priya.request('meet.guestLink', { id: m.id }) as GuestLinkView;
  assert.equal(view.relayOnly, true);
  assert.match(view.problem!, /relay/);
});
