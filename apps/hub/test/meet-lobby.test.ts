// Knocks (meet-lobby.ts): someone waiting in a lobby is news to every person who may let them in,
// wherever they are. A browser guest at a standing personal room while its host is not in it; the
// host's event, indicator board and Nib card; Admit from the card opening the Room for the guest;
// Decline; a colleague waiting for the host; an instant meeting's lobby answered from the Room's
// own list (the card follows); a guest who gives up; and the "joined" notice to an absent organiser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GuestDown, GuestLinkView, JoinedNotice, KnockView, LobbyBoard, MeetingInfo, Message, NibCard, RoomInfo } from '@dex/core';
import type { HubClient } from '@dex/core/client';
import type { Hub } from '../src/hub.ts';
import { office, me, nextEvent } from './office.ts';

/** A fake gateway: what the hub sends each guest, and how their connection was closed (as in meet-guests.test.ts). */
function fakeGateway(hub: Hub) {
  const frames = new Map<number, GuestDown[]>();
  const closed = new Map<number, { code: number; reason: string }>();
  hub.gateway.sendGuest = (gid: number, f: unknown) => { (frames.get(gid) ?? frames.set(gid, []).get(gid)!).push(f as GuestDown); };
  hub.gateway.closeGuest = (gid: number, code: number, reason: string) => { closed.set(gid, { code, reason }); };
  hub.meetGuests.dropAll = () => {};
  let next = 500;
  const open = (meetingId: string, ip = '203.0.113.9') => {
    const gid = next++;
    hub.meetGuests.open(gid, ip, meetingId);
    const send = (f: unknown) => hub.meetGuests.frame(gid, JSON.stringify(f));
    const wait = async <T extends GuestDown['t']>(t: T, pred: (f: Extract<GuestDown, { t: T }>) => boolean = () => true, ms = 4000): Promise<Extract<GuestDown, { t: T }>> => {
      const end = Date.now() + ms;
      for (;;) {
        const hit = (frames.get(gid) ?? []).find((f) => f.t === t && pred(f as Extract<GuestDown, { t: T }>));
        if (hit) { frames.set(gid, (frames.get(gid) ?? []).filter((f) => f !== hit)); return hit as Extract<GuestDown, { t: T }>; }
        if (Date.now() > end) throw new Error(`no ${t} frame (have ${(frames.get(gid) ?? []).map((f) => f.t).join(', ')})`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    const isClosed = async (ms = 4000) => {
      const end = Date.now() + ms;
      while (!closed.has(gid)) { if (Date.now() > end) throw new Error('not closed'); await new Promise((r) => setTimeout(r, 20)); }
      return closed.get(gid)!;
    };
    return { gid, send, wait, isClosed };
  };
  return { open };
}

async function guestOffice() {
  const o = await office();
  await o.owner.request('admin.remote.set', { url: 'https://dexconnect-gateway.example.workers.dev', enabled: true });
  return { ...o, gw: fakeGateway(o.hub) };
}

const knockCard = (c: HubClient, kind: 'knock' = 'knock') => nextEvent<Message>(c, 'msg.new', (m) => m.nib?.kind === kind, 6000);
const card = async (c: HubClient, ref: string) => ((await c.request('nib.card', { kind: 'knock', ref })) as Extract<NibCard, { kind: 'knock' }>).knock;

test('a browser guest at a personal room while its host is elsewhere: the host is told everywhere, and Admit from Nib lets the guest in', async () => {
  const { hub, priya, gw } = await guestOffice();
  const room = await priya.request('meet.personal') as MeetingInfo;
  const link = await priya.request('meet.guestLink', { id: room.id, enabled: true }) as GuestLinkView;

  // the guest knocks; Priya is not in her room (the app is open on something else)
  const knocked = nextEvent<KnockView>(priya, 'meet.knocked');
  const boardEvt = nextEvent<LobbyBoard>(priya, 'meet.knocks', (b) => b.knocks.length === 1);
  const nibMsg = knockCard(priya);
  const dana = gw.open(room.id);
  dana.send({ t: 'join', name: 'Dana Wright', passcode: link.passcode });
  const lobby = await dana.wait('lobby');
  // honest: no host is in the room; the page says she has been told
  assert.equal(lobby.hostIn, false);

  const k = await knocked;
  assert.equal(k.name, 'Dana Wright');
  assert.equal(k.guest, true, 'a browser guest: the name is not verified');
  assert.equal(k.userId, '', 'a guest has no account id to show');
  assert.equal(k.kind, 'personal');
  assert.equal(k.state, 'waiting');
  assert.equal(k.live, false);
  assert.equal(k.hostIn, false);
  const b = await boardEvt;
  assert.deepEqual(b.knocks.map((x) => x.id), [k.id]);
  assert.deepEqual(await priya.request('meet.knocks'), b, 'the board on request is the one pushed');

  // Nib's card: in Priya's conversation with Nib, naming the guest as unverified
  const m = await nibMsg;
  assert.equal(m.nib!.ref, k.id);
  assert.match(m.body, /Dana Wright \(guest, name not verified\) is waiting in the lobby of your personal room/);
  const c1 = await card(priya, k.id);
  assert.equal(c1!.state, 'waiting');

  // Admit from the card: the guest is let in, opens the room and waits there for Priya
  const cardChanged = nextEvent<{ kinds: string[] }>(priya, 'nib.changed', (e) => e.kinds.includes('knock'));
  const joined = nextEvent<JoinedNotice>(priya, 'meet.joined');
  await priya.request('meet.knock.answer', { id: k.id, allow: true });
  const admitted = await dana.wait('admitted');
  assert.equal(admitted.room.seats.length, 1, 'the guest is alone in the room until the host comes');
  assert.equal(admitted.room.hostAway, 'Priya', 'the guest sees the host has not come in yet');
  await cardChanged;
  const c2 = await card(priya, k.id);
  assert.equal(c2!.state, 'admitted');
  assert.equal(c2!.by, me(priya));
  assert.ok(c2!.joinedAt, 'the card shows she came in');
  const j = await joined;
  assert.equal(j.name, 'Dana Wright');
  assert.equal(j.admitted, true);
  // the indicator: no one waiting, and her room running without her
  const b2 = await priya.request('meet.knocks') as LobbyBoard;
  assert.equal(b2.knocks.length, 0);
  assert.equal(b2.rooms.length, 1);
  assert.equal(b2.rooms[0].meetingId, room.id);
  assert.deepEqual(b2.rooms[0].people.map((p) => [p.name, p.guest]), [['Dana Wright', true]]);
  // answering again says who already did
  await assert.rejects(priya.request('meet.knock.answer', { id: k.id, allow: false }), /already let Dana Wright in/);

  // Priya opens her room: she joins the guest, and the guest's page stops saying she is away
  const roomFrame = dana.wait('room', (f) => f.room.seats.length === 2);
  const res = await priya.request('meet.join', { id: room.id });
  assert.ok(res.room, 'the host goes straight in');
  assert.equal((await roomFrame).room.hostAway, undefined);
  assert.equal(((await priya.request('meet.knocks')) as LobbyBoard).rooms.length, 0, 'her room is no longer running without her');
  assert.equal(hub.meetLobby.waiting, 0);
});

test('Decline from the card tells the guest; a colleague waiting for the host is let in and opens the room', async () => {
  const { priya, ravi, gw } = await guestOffice();
  const room = await priya.request('meet.personal') as MeetingInfo;
  const link = await priya.request('meet.guestLink', { id: room.id, enabled: true }) as GuestLinkView;

  const knocked = nextEvent<KnockView>(priya, 'meet.knocked');
  const sam = gw.open(room.id);
  sam.send({ t: 'join', name: 'Sam', passcode: link.passcode });
  await sam.wait('lobby');
  const k = await knocked;
  // Ravi is not a host: he cannot answer, see the card, or see it on his board
  await assert.rejects(ravi.request('meet.knock.answer', { id: k.id, allow: true }), /host/);
  await assert.rejects(ravi.request('nib.card', { kind: 'knock', ref: k.id }), /not for you/);
  assert.equal(((await ravi.request('meet.knocks')) as LobbyBoard).knocks.length, 0);

  await priya.request('meet.knock.answer', { id: k.id, allow: false });
  assert.match((await sam.wait('denied')).reason, /did not let you in/);
  assert.equal((await sam.isClosed()).code, 4000);
  const c = await card(priya, k.id);
  assert.equal(c!.state, 'declined');

  // Ravi, a colleague, comes by the room's ID: personal rooms wait for their host, so he knocks too
  const knocked2 = nextEvent<KnockView>(priya, 'meet.knocked');
  const told = nextEvent<{ state: string }>(ravi, 'meet.lobby', (e) => e.state === 'admitted');
  const w = await ravi.request('meet.join', { id: room.id });
  assert.equal(w.waiting, 'host');
  const k2 = await knocked2;
  assert.equal(k2.guest, false);
  assert.equal(k2.userId, me(ravi));
  await priya.request('meet.knock.answer', { id: k2.id, allow: true });
  await told;
  // his app joins again (as it does on "admitted"): the room opens with him in it, without ringing anyone
  const r = await ravi.request('meet.join', { id: room.id });
  assert.ok(r.room);
  assert.deepEqual(r.room!.participants.map((p) => p.userId), [me(ravi)]);
  assert.deepEqual(r.room!.ringing, []);
});

test('an instant meeting: a knock answered in the Room reaches the card; a guest who gives up closes it; co-hosts are told', async () => {
  const { priya, ravi, gw } = await guestOffice();
  const m = await priya.request('meet.create', { title: 'Client review', invite: [me(ravi)] }) as MeetingInfo;
  const link = await priya.request('meet.guestLink', { id: m.id, enabled: true }) as GuestLinkView;
  const started = (await priya.request('meet.join', { id: m.id })).room!;
  // Ravi comes in and is made co-host: he can let people in too, so he is told as well
  await ravi.request('meet.join', { id: m.id });
  await priya.request('room.cohost', { roomId: started.id, userId: me(ravi), on: true });

  const forPriya = nextEvent<KnockView>(priya, 'meet.knocked');
  const forRavi = nextEvent<KnockView>(ravi, 'meet.knocked');
  const ravisCard = knockCard(ravi);
  const lee = gw.open(m.id);
  lee.send({ t: 'join', name: 'Lee', passcode: link.passcode });
  const lobby = await lee.wait('lobby');
  assert.equal(lobby.hostIn, true, 'a host is in the meeting: they see her waiting');
  const k = await forPriya;
  assert.equal((await forRavi).id, k.id, 'the same knock');
  assert.equal(k.live, true);
  assert.equal(k.hostIn, true);
  await ravisCard;

  // Priya admits from the Room's own lobby list: both cards follow
  const room = await priya.request('room.list') as RoomInfo[];
  const entry = room.find((r) => r.id === started.id)!.lobby![0];
  const ravisChange = nextEvent<{ kinds: string[] }>(ravi, 'nib.changed', (e) => e.kinds.includes('knock'));
  await priya.request('room.admit', { roomId: started.id, deviceIds: [entry.deviceId], allow: true });
  await lee.wait('admitted');
  await ravisChange;
  const c = await card(ravi, k.id);
  assert.equal(c!.state, 'admitted');
  assert.equal(c!.by, me(priya));
  await assert.rejects(ravi.request('meet.knock.answer', { id: k.id, allow: true }), /Priya already let Lee in/);

  // another guest gives up while waiting: the knock closes as "left"
  const knocked = nextEvent<KnockView>(priya, 'meet.knocked');
  const kim = gw.open(m.id);
  kim.send({ t: 'join', name: 'Kim', passcode: link.passcode });
  await kim.wait('lobby');
  const k2 = await knocked;
  const gone = nextEvent<LobbyBoard>(priya, 'meet.knocks', (b) => !b.knocks.some((x) => x.id === k2.id));
  kim.send({ t: 'leave' });
  await gone;
  assert.equal((await card(priya, k2.id))!.state, 'left');
  await assert.rejects(priya.request('meet.knock.answer', { id: k2.id, allow: true }), /left the lobby/);

  // Admit all, from anywhere, by the meeting's ID
  const two = [gw.open(m.id), gw.open(m.id)];
  const both = nextEvent<LobbyBoard>(priya, 'meet.knocks', (b) => b.knocks.length === 2);
  two[0].send({ t: 'join', name: 'Ann', passcode: link.passcode });
  two[1].send({ t: 'join', name: 'Ben', passcode: link.passcode });
  await both;
  const res = await priya.request('meet.knock.answer', { meetingId: m.id, all: true, allow: true });
  assert.equal(res.knocks.length, 2);
  await two[0].wait('admitted');
  await two[1].wait('admitted');
});

test('the organiser is told when someone comes into their meeting while they are not in it', async () => {
  const { priya, ravi, owner } = await guestOffice();
  const m = await priya.request('meet.create', { title: 'Weekly piping', invite: [me(ravi), me(owner)], settings: { lobby: 'off', joinBeforeHost: true } }) as MeetingInfo;
  const joined = nextEvent<JoinedNotice>(priya, 'meet.joined');
  const board = nextEvent<LobbyBoard>(priya, 'meet.knocks', (b) => b.rooms.length === 1);
  await ravi.request('meet.join', { id: m.id });
  const j = await joined;
  assert.equal(j.name, 'Ravi');
  assert.equal(j.admitted, false);
  assert.equal(j.title, 'Weekly piping');
  assert.equal((await board).rooms[0].people[0].name, 'Ravi');
  // once she is in, people coming in are no news to her
  await priya.request('meet.join', { id: m.id });
  let told = false;
  const off = (n: string) => { if (n === 'meet.joined') told = true; };
  priya.on('event', off);
  await owner.request('meet.join', { id: m.id });
  await new Promise((r) => setTimeout(r, 300));
  priya.off('event', off);
  assert.equal(told, false);
});
