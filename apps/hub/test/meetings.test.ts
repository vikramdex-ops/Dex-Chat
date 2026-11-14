// Meetings: IDs and links, instant meetings and personal rooms, the lobby and lock, co-hosts,
// host controls (mute, ask to unmute, remove, spotlight, end), hands and reactions, the record of
// past meetings, Calendar meetings held as calls, and the camera consent policy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMeetingId, parseMeetingId } from '@dex/core';
import type { MeetingInfo, RoomInfo } from '@dex/core';
import type { HubClient } from '@dex/core/client';
import { office, me, nextEvent } from './office.ts';

const dev = (c: HubClient) => c.session!.deviceId;
const join = (c: HubClient, id: string) => c.request('meet.join', { id }) as Promise<{ room?: RoomInfo; waiting?: 'admit' | 'host' }>;

test('meeting IDs read as 482-913-207 and links parse back', () => {
  assert.equal(formatMeetingId('482913207'), '482-913-207');
  assert.equal(parseMeetingId('482-913-207'), '482913207');
  assert.equal(parseMeetingId(' 482 913 207 '), '482913207');
  assert.equal(parseMeetingId('dexconnect://meet/482-913-207'), '482913207');
  assert.equal(parseMeetingId('48291320'), null);
  assert.equal(parseMeetingId('dexconnect://meet/482-913-2077'), null);
  assert.equal(parseMeetingId('drop table'), null);
});

test('an instant meeting: its own Space, insiders walk in, outsiders wait in the lobby until admitted', async () => {
  const { owner, priya, ravi } = await office();
  const m = await priya.request('meet.create', { title: 'Pump skid review', invite: [me(ravi)] }) as MeetingInfo;
  assert.match(m.id, /^[1-9]\d{8}$/);
  assert.equal(m.link, `dexconnect://meet/${formatMeetingId(m.id)}`);
  assert.equal(m.kind, 'instant');
  assert.equal(m.hostId, me(priya));
  assert.deepEqual(m.settings, { lobby: 'outside', joinBeforeHost: true });
  const space = (await priya.request('conv.list')).find((c) => c.id === m.convId)!;
  assert.equal(space.kind, 'space');
  assert.deepEqual([...space.members].sort(), [me(priya), me(ravi)].sort());

  // the host starts it; ravi (invited) is rung and walks in by the ID
  const ring = nextEvent<{ room: RoomInfo }>(ravi, 'room.ring');
  const started = await join(priya, m.id);
  assert.ok(started.room);
  assert.equal(started.room.meetingId, m.id);
  assert.equal(started.room.title, 'Pump skid review');
  assert.equal(started.room.hostId, me(priya));
  assert.equal((await ring).room.meetingId, m.id);
  const r2 = await join(ravi, m.id);
  assert.equal(r2.room?.participants.length, 2);
  assert.equal((await priya.request('meet.get', { id: m.id })).live?.participants, 2);

  // vikram is not in the meeting's Space: he waits; the host sees him, ravi does not
  const knock = nextEvent<RoomInfo>(priya, 'room.updated', (r) => (r.lobby ?? []).length === 1);
  const raviSees = nextEvent<RoomInfo>(ravi, 'room.updated');
  const w = await join(owner, m.id);
  assert.equal(w.waiting, 'admit');
  const lobby = (await knock).lobby!;
  assert.equal(lobby[0].userId, me(owner));
  assert.equal((await raviSees).lobby, undefined, 'only hosts see the lobby');
  // the room's own join refuses to skip the lobby
  await assert.rejects(owner.request('room.join', { roomId: started.room.id }), /lobby|ended/);
  // ravi is not a host
  await assert.rejects(ravi.request('room.admit', { roomId: started.room.id, all: true, allow: true }), /host/);
  const admitted = nextEvent<{ state: string }>(owner, 'meet.lobby');
  await priya.request('room.admit', { roomId: started.room.id, deviceIds: [dev(owner)], allow: true });
  assert.equal((await admitted).state, 'admitted');
  const inside = await join(owner, m.id);
  assert.equal(inside.room?.participants.length, 3);
  // let in to an instant meeting means a member of its Space (chat, polls, board, files)
  assert.ok((await owner.request('conv.list')).some((c) => c.id === m.convId));
});

test('lock, deny, co-hosts, mute and ask to unmute, hands, reactions, spotlight, remove, end for everyone', async () => {
  const { owner, priya, ravi } = await office();
  const m = await priya.request('meet.create', { title: 'Weekly coordination', invite: [me(ravi)], settings: { lobby: 'everyone' } }) as MeetingInfo;
  assert.equal(m.settings.lobby, 'everyone');
  const room = (await join(priya, m.id)).room!;
  // lobby for everyone: even invited people wait
  assert.equal((await join(ravi, m.id)).waiting, 'admit');
  const denied = nextEvent<{ state: string }>(ravi, 'meet.lobby');
  await priya.request('room.admit', { roomId: room.id, all: true, allow: false });
  assert.equal((await denied).state, 'denied');
  assert.equal((await join(ravi, m.id)).waiting, 'admit');
  await priya.request('room.admit', { roomId: room.id, all: true, allow: true });
  assert.ok((await join(ravi, m.id)).room);

  // locked: nobody new gets in, not even to the lobby
  await priya.request('room.lock', { roomId: room.id, locked: true });
  await assert.rejects(join(owner, m.id), /locked/);
  await priya.request('room.lock', { roomId: room.id, locked: false });
  await priya.request('meet.settings', { id: m.id, lobby: 'off' });
  assert.ok((await join(owner, m.id)).room);
  await assert.rejects(ravi.request('meet.settings', { id: m.id, lobby: 'everyone' }), /host/);
  await assert.rejects(priya.request('meet.settings', { id: m.id, lobby: 'sometimes' as 'off' }), /lobby/);

  // co-host: only the host grants it; a co-host has the host controls
  await assert.rejects(ravi.request('room.mute', { roomId: room.id, deviceId: dev(owner) }), /host/);
  await assert.rejects(ravi.request('room.cohost', { roomId: room.id, userId: me(owner), on: true }), /host/);
  await priya.request('room.cohost', { roomId: room.id, userId: me(ravi), on: true });
  const muted = nextEvent<{ by: string }>(owner, 'room.muted');
  await ravi.request('room.mute', { roomId: room.id, deviceId: dev(owner) });
  assert.equal((await muted).by, me(ravi));
  let list = (await owner.request('room.list'))[0];
  assert.equal(list.participants.find((p) => p.userId === me(owner))!.muted, true);
  assert.deepEqual(list.coHosts, [me(ravi)]);
  // ask to unmute: a request, never forced; once is enough for a few seconds
  const ask = nextEvent<{ by: string }>(owner, 'room.unmuteAsk');
  await priya.request('room.askUnmute', { roomId: room.id, deviceId: dev(owner) });
  assert.equal((await ask).by, me(priya));
  assert.equal((await owner.request('room.list'))[0].participants.find((p) => p.userId === me(owner))!.muted, true);
  await assert.rejects(priya.request('room.askUnmute', { roomId: room.id, deviceId: dev(owner) }), /moment/);
  // mute all: everyone but the person asking
  const m1 = nextEvent(ravi, 'room.muted');
  await priya.request('room.mute', { roomId: room.id, all: true });
  await m1;
  list = (await priya.request('room.list'))[0];
  assert.deepEqual(list.participants.map((p) => p.muted), [false, true, true]);

  // hands, oldest first; a host lowers them
  await owner.request('room.hand', { roomId: room.id, up: true });
  await ravi.request('room.hand', { roomId: room.id, up: true });
  await owner.request('room.hand', { roomId: room.id, up: true });
  list = (await priya.request('room.list'))[0];
  assert.deepEqual(list.hands!.map((h) => h.userId), [me(owner), me(ravi)]);
  await assert.rejects(owner.request('room.hand', { roomId: room.id, up: false, all: true }), /host/);
  await priya.request('room.hand', { roomId: room.id, up: false, deviceId: dev(owner) });
  assert.deepEqual((await priya.request('room.list'))[0].hands!.map((h) => h.userId), [me(ravi)]);
  await priya.request('room.hand', { roomId: room.id, up: false, all: true });
  assert.deepEqual((await priya.request('room.list'))[0].hands, []);

  // reactions go to everyone in the Room; only the set ones; a flood is cut short
  const seen = nextEvent<{ emoji: string; userId: string }>(owner, 'room.reaction');
  await ravi.request('room.react', { roomId: room.id, emoji: '👏' });
  assert.deepEqual(await seen.then((e) => [e.emoji, e.userId]), ['👏', me(ravi)]);
  await assert.rejects(ravi.request('room.react', { roomId: room.id, emoji: '<img>' }), /reactions/);
  let delivered = 0;
  const count = (n: string) => { if (n === 'room.reaction') delivered++; };
  owner.on('event', count);
  for (let i = 0; i < 30; i++) await ravi.request('room.react', { roomId: room.id, emoji: '🎉' });
  await new Promise((r) => setTimeout(r, 200));
  owner.off('event', count);
  assert.ok(delivered < 12, `flood limited (${delivered})`);

  // spotlight: hosts only; cleared when that person leaves
  await assert.rejects(owner.request('room.spotlight', { roomId: room.id, deviceId: dev(ravi) }), /host/);
  await priya.request('room.spotlight', { roomId: room.id, deviceId: dev(owner) });
  assert.equal((await ravi.request('room.list'))[0].spotlight, dev(owner));
  await assert.rejects(priya.request('room.spotlight', { roomId: room.id, deviceId: 'nobody' }), /left/);

  // remove: they are told, and must wait to come back
  await assert.rejects(ravi.request('room.remove', { roomId: room.id, deviceId: dev(priya) }), /host cannot/);
  const removed = nextEvent<{ by: string }>(owner, 'room.removed');
  await priya.request('room.remove', { roomId: room.id, deviceId: dev(owner) });
  assert.equal((await removed).by, me(priya));
  assert.equal((await priya.request('room.list'))[0].spotlight, null);
  assert.equal((await join(owner, m.id)).waiting, 'admit');

  // a co-host can end it for everyone too
  const ended = nextEvent<{ endedBy?: string }>(priya, 'room.ended');
  await ravi.request('room.end', { roomId: room.id });
  assert.equal((await ended).endedBy, me(ravi));
});

test('ending for everyone tells the Room and the lobby; recent meetings list who was there', async () => {
  const { owner, priya, ravi } = await office();
  const m = await priya.request('meet.create', { title: 'Site visit debrief', invite: [me(ravi)] }) as MeetingInfo;
  const room = (await join(priya, m.id)).room!;
  await join(ravi, m.id);
  assert.equal((await join(owner, m.id)).waiting, 'admit');
  await assert.rejects(ravi.request('room.end', { roomId: room.id }), /host/);
  const ended = nextEvent<{ endedBy?: string; roomId: string }>(ravi, 'room.ended');
  const turnedAway = nextEvent<{ state: string }>(owner, 'meet.lobby');
  await priya.request('room.end', { roomId: room.id });
  assert.equal((await ended).endedBy, me(priya));
  assert.equal((await turnedAway).state, 'denied');
  assert.deepEqual(await priya.request('room.list'), []);
  const recent = await ravi.request('meet.recent', {});
  assert.equal(recent.length, 1);
  assert.equal(recent[0].meetingId, m.id);
  assert.equal(recent[0].title, 'Site visit debrief');
  assert.deepEqual([...recent[0].people].sort(), [me(priya), me(ravi)].sort());
  assert.deepEqual(await owner.request('meet.recent', {}), [], 'only meetings you were in');
});

test('a personal room: a standing ID; people wait for its host; the host leaving hands the controls on', async () => {
  const { owner, priya, ravi } = await office();
  const p1 = await priya.request('meet.personal') as MeetingInfo;
  const p2 = await priya.request('meet.personal') as MeetingInfo;
  assert.equal(p1.id, p2.id, 'the same ID every time');
  assert.equal(p1.kind, 'personal');
  assert.equal(p1.convId, null, 'its Space is made when it is first used');
  assert.deepEqual(p1.settings, { lobby: 'outside', joinBeforeHost: false });
  await priya.request('meet.settings', { id: p1.id, lobby: 'off' });
  // the host is not there: ravi waits for her
  assert.equal((await join(ravi, p1.id)).waiting, 'host');
  await assert.rejects(ravi.request('meet.settings', { id: p1.id, joinBeforeHost: true }), /host/);
  const letIn = nextEvent<{ state: string }>(ravi, 'meet.lobby');
  const started = await join(priya, p1.id);
  assert.ok(started.room);
  assert.equal((await letIn).state, 'admitted');
  const r = await join(ravi, p1.id);
  assert.equal(r.room?.participants.length, 2);
  // came in by the ID: now in the room's Space
  assert.ok((await ravi.request('conv.list')).some((c) => c.id === r.room!.convId));
  // a personal room does not ring the Space when it opens
  assert.deepEqual(started.room.ringing, []);
  // the host leaves: ravi runs the room now (a meeting does not end when two become one)
  await priya.request('room.leave', { roomId: started.room.id });
  const after = (await ravi.request('room.list'))[0];
  assert.ok(after, 'still running');
  assert.deepEqual(after.coHosts, [me(ravi)]);
  await ravi.request('room.lock', { roomId: started.room.id, locked: true });
  await assert.rejects(join(owner, p1.id), /locked/);
  // someone else's personal room ID cannot be changed by you
  await assert.rejects(owner.request('meet.settings', { id: p1.id, title: 'Mine' }), /host/);
  await assert.rejects(owner.request('meet.get', { id: '123' }), /No meeting/);
});

test('a Calendar meeting held as a call is a meeting with its own ID; invitees walk in', async () => {
  const { owner, priya, ravi } = await office();
  const now = Date.now();
  const ev = await priya.request('cal.create', { title: 'Isometrics review', startAt: now + 60_000, endAt: now + 3_600_000, attendees: [me(ravi)], online: true });
  const m = await ravi.request('meet.event', { eventId: ev.id }) as MeetingInfo;
  assert.equal(m.kind, 'event');
  assert.equal(m.hostId, me(priya), 'the organiser hosts it');
  assert.equal(m.title, 'Isometrics review');
  assert.equal((await priya.request('meet.event', { eventId: ev.id })).id, m.id, 'one meeting per event');
  await assert.rejects(owner.request('meet.event', { eventId: ev.id }), /not found/);
  // join before the host (on by default for Calendar meetings): ravi opens it, priya joins
  const r = await join(ravi, m.id);
  assert.ok(r.room);
  assert.equal(r.room.hostId, me(priya));
  assert.deepEqual(r.room.coHosts, [me(ravi)], 'until the host comes, the first person in runs it');
  // its conversation was made for it, with the people invited
  const conv = (await priya.request('conv.list')).find((c) => c.id === r.room!.convId)!;
  assert.deepEqual([...conv.members].sort(), [me(priya), me(ravi)].sort());
  assert.equal((await join(priya, m.id)).room?.participants.length, 2);
  // vikram was not invited: he waits
  assert.equal((await join(owner, m.id)).waiting, 'admit');
  const off = await priya.request('cal.create', { title: 'In person', startAt: now, endAt: now + 60_000, attendees: [], online: false });
  await assert.rejects(priya.request('meet.event', { eventId: off.id }), /not held as a call/);
});

test('a conversation Room is a meeting too; the camera consent policy is an office setting', async () => {
  const { owner, priya } = await office();
  const dm = await owner.request('conv.create', { kind: 'direct', members: [me(priya)] });
  const room = await owner.request('room.start', { convId: dm.id, video: false });
  assert.match(room.meetingId ?? '', /^\d{9}$/);
  assert.equal(room.meetingKind, 'conversation');
  assert.equal(room.hostId, me(owner));
  const m = await priya.request('meet.create', { convId: dm.id }) as MeetingInfo;
  assert.equal(m.id, room.meetingId);
  assert.equal(m.live?.roomId, room.id);
  // the classic way in still works for members
  assert.equal((await priya.request('room.join', { roomId: room.id })).participants.length, 2);
  await owner.request('room.leave', { roomId: room.id });
  // the policy
  assert.equal((await priya.request('policy.get')).cameraConsent, false);
  await assert.rejects(priya.request('admin.policy.set', { cameraConsent: true }), /administrators/);
  const p = await owner.request('admin.policy.set', { cameraConsent: true });
  assert.equal(p.cameraConsent, true);
  assert.equal((await priya.request('policy.get')).cameraConsent, true);
});
