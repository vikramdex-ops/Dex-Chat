// Meeting threads, action points and recaps: a Calendar meeting's own thread, chat before it, the
// meeting chat saved as it is said (guests by name, their files under the office's rules), the
// cards in the thread, the recap and who may read it, recurring meetings with points brought
// forward, the action point lifecycle (Desk, Nib, done, overdue reminders in working hours), a hub
// restart mid-meeting, and retention. The gateway is replaced by a recorder (as in meet-guests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIdentity } from '@dex/core';
import type { ActionPoint, CalEvent, Conversation, GuestDown, MeetRecap, Message, MeetingInfo, RoomChatLine, RoomInfo } from '@dex/core';
import { HubClient } from '@dex/core/client';
import { Hub } from '../src/hub.ts';
import { cleanups, me, nextEvent, office, send, until } from './office.ts';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const ymd = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** A fake gateway: the frames the hub sends each guest. */
function fakeGateway(hub: Hub) {
  const frames = new Map<number, GuestDown[]>();
  hub.gateway.sendGuest = (gid: number, f: unknown) => { (frames.get(gid) ?? frames.set(gid, []).get(gid)!).push(f as GuestDown); };
  hub.gateway.closeGuest = () => {};
  hub.meetGuests.dropAll = () => {};
  let next = 500;
  return (meetingId: string) => {
    const gid = next++;
    hub.meetGuests.open(gid, '203.0.113.9', meetingId);
    const sendF = (f: unknown) => hub.meetGuests.frame(gid, JSON.stringify(f));
    const wait = async <T extends GuestDown['t']>(t: T, pred: (f: Extract<GuestDown, { t: T }>) => boolean = () => true, ms = 4000): Promise<Extract<GuestDown, { t: T }>> => {
      const end = Date.now() + ms;
      for (;;) {
        const hit = (frames.get(gid) ?? []).find((f) => f.t === t && pred(f as Extract<GuestDown, { t: T }>));
        if (hit) { frames.set(gid, (frames.get(gid) ?? []).filter((f) => f !== hit)); return hit as Extract<GuestDown, { t: T }>; }
        if (Date.now() > end) throw new Error(`no ${t} frame (have ${(frames.get(gid) ?? []).map((f) => f.t).join(', ')})`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    return { gid, send: sendF, wait };
  };
}

/** A browser guest knocks with the passcode, the host admits them. */
async function guestIn(hub: Hub, gw: ReturnType<typeof fakeGateway>, host: HubClient, m: MeetingInfo, roomId: string, name: string) {
  const link = await host.request('meet.guestLink', { id: m.id, enabled: true });
  const g = gw(m.id);
  g.send({ t: 'join', name, passcode: link.passcode });
  await g.wait('lobby');
  const room = await host.request('room.list').then((l) => (l as RoomInfo[]).find((r) => r.id === roomId)!);
  const waiting = await (async () => { for (let i = 0; i < 100; i++) { const r = (await host.request('room.list') as RoomInfo[]).find((x) => x.id === roomId)!; if (r.lobby?.length) return r.lobby; await new Promise((x) => setTimeout(x, 20)); } return []; })();
  void room;
  await host.request('room.admit', { roomId, deviceIds: waiting.filter((l) => l.userId.startsWith('guest:')).map((l) => l.deviceId), allow: true });
  const admitted = await g.wait('admitted');
  return { ...g, admitted };
}

async function remoteOn(owner: HubClient) {
  await owner.request('admin.remote.set', { url: 'https://dexconnect-gateway.example.workers.dev', enabled: true });
}

const thread = (c: HubClient, convId: string) => c.request('msg.list', { convId, limit: 100 }) as Promise<{ messages: Message[] }>;

test('a Calendar meeting with no conversation gets its own thread: chat and files before, the meeting chat saved as said, guests by name, the cards and the recap', async () => {
  const { hub, owner, priya, ravi } = await office();
  await remoteOn(owner);
  const gw = fakeGateway(hub);
  const start = Date.now() + 30 * 60_000;
  let ev = await priya.request('cal.create', { title: 'Pump skid review', startAt: start, endAt: start + HOUR, attendees: [me(ravi)], online: true }) as CalEvent;
  assert.ok(ev.convId, 'the meeting has a thread from the start');
  const conv = (await priya.request('conv.list') as Conversation[]).find((c) => c.id === ev.convId)!;
  assert.equal(conv.kind, 'space');
  assert.deepEqual([...conv.members].sort(), [me(priya), me(ravi)].sort());
  // before the meeting: the agenda and a drawing
  await send(ravi, ev.convId!, 'Agenda: 1. GA comments 2. Nozzle loads');
  const info = await priya.request('meet.thread', { eventId: ev.id });
  assert.equal(info.convId, ev.convId);
  assert.equal(info.occurrences.length, 0);
  assert.ok(info.next);
  // the meeting starts (early is fine: within an hour of its slot)
  const m = await priya.request('meet.event', { eventId: ev.id }) as MeetingInfo;
  assert.equal(m.convId, ev.convId, 'the Room is held in the thread');
  const room = (await priya.request('meet.join', { id: m.id }) as { room: RoomInfo }).room;
  assert.ok(room.occurrenceId);
  await ravi.request('meet.join', { id: m.id });
  let msgs = (await thread(priya, ev.convId!)).messages;
  const divider = msgs.find((x) => x.meetCard?.kind === 'started');
  assert.ok(divider, 'a divider card is posted when it starts');
  assert.equal(divider.meetCard!.occurrenceId, room.occurrenceId);
  assert.match(divider.meetCard!.no, /^MTG-\d{9}-01$/);

  // a guest, and a second guest of the same name
  const rao = await guestIn(hub, gw, priya, m, room.id, 'Mr Rao');
  const rao2 = await guestIn(hub, gw, priya, m, room.id, 'Mr Rao');
  rao.send({ t: 'chat', text: 'Good morning, the pump curves are attached' });
  const seen = await nextEvent<RoomChatLine>(priya, 'room.chat', (l) => l.guest && /pump curves/.test(l.text));
  assert.equal(seen.name, 'Mr Rao');
  assert.ok(seen.messageId, 'saved in the thread as it was said');
  rao2.send({ t: 'chat', text: 'Hello from the site office' });
  const other = await nextEvent<RoomChatLine>(priya, 'room.chat', (l) => /site office/.test(l.text));
  assert.equal(other.name, 'Mr Rao (2)', 'two guests of one name are told apart');
  const line = await priya.request('room.chat', { roomId: room.id, text: 'Welcome both, sheet 3 first' });
  assert.ok(line.messageId);
  // the guest's file: the office's blocked types apply, then it is saved in the thread
  await owner.request('admin.policy.set', { blockedFileTypes: ['exe'] });
  rao.send({ t: 'file', id: 'f1', name: 'setup.exe', mime: 'application/octet-stream', size: 10 });
  assert.match((await rao.wait('fileDone')).reason ?? '', /\.exe/);
  const data = Buffer.from('pump curve data '.repeat(4000));
  rao.send({ t: 'file', id: 'f2', name: 'curves.csv', mime: 'text/csv', size: data.length });
  for (let i = 0, k = 0; i < data.length; i += 36 * 1024, k++) rao.send({ t: 'fileChunk', id: 'f2', i: k, data: data.subarray(i, i + 36 * 1024).toString('base64') });
  assert.equal((await rao.wait('fileDone')).ok, true);
  const fileLine = await nextEvent<RoomChatLine>(priya, 'room.chat', (l) => !!l.file);
  assert.equal(fileLine.file!.name, 'curves.csv');

  msgs = (await thread(ravi, ev.convId!)).messages;
  const guestMsg = msgs.find((x) => /pump curves/.test(x.body))!;
  assert.equal(guestMsg.meetLine?.name, 'Mr Rao');
  assert.equal(guestMsg.meetLine?.guest, true);
  assert.ok(msgs.find((x) => x.files.some((f) => f.name === 'curves.csv')), 'the guest file is in the thread');
  assert.ok(msgs.find((x) => x.body === 'Welcome both, sheet 3 first')?.meetLine, 'a colleague\'s line to everyone is marked too');
  // the meeting chat is searchable like any message
  const found = await ravi.request('search', { q: 'pump curves' });
  assert.ok(JSON.stringify(found).includes('pump curves'));

  // the guest's chat after a page reload comes from the thread
  const log = await priya.request('room.chatLog', { roomId: room.id });
  assert.deepEqual(log.map((l) => l.name), ['Mr Rao', 'Mr Rao (2)', 'Priya', 'Mr Rao']);

  // end: the recap card, and the recap
  await priya.request('room.end', { roomId: room.id });
  for (let i = 0; i < 50 && !(await thread(priya, ev.convId!)).messages.some((x) => x.meetCard?.kind === 'recap'); i++) await new Promise((r) => setTimeout(r, 20));
  msgs = (await thread(priya, ev.convId!)).messages;
  const card = msgs.find((x) => x.meetCard?.kind === 'recap')!;
  assert.ok(card, 'a recap card when it ends');
  assert.equal(card.meetCard!.people, 4);
  assert.equal(card.meetCard!.files, 1);
  const recap = await ravi.request('meet.recap', { occurrenceId: room.occurrenceId! }) as MeetRecap;
  assert.equal(recap.occurrence.state, 'ended');
  assert.deepEqual(recap.attendance.map((p) => p.name).sort(), ['Mr Rao', 'Mr Rao (2)', 'Priya', 'Ravi'].sort());
  assert.ok(recap.attendance.find((p) => p.name === 'Mr Rao')!.guest);
  assert.equal(recap.files.length, 1);
  assert.ok(recap.chat.lines.some((l) => l.guest && l.name === 'Mr Rao (2)'));
  assert.ok(!recap.chat.lines.some((l) => /Agenda/.test(l.text)), 'what was said before it started is not its chat');
  // the Calendar finds it
  ev = await priya.request('cal.get', { eventId: ev.id }) as CalEvent;
  assert.equal((await priya.request('meet.recapFor', { eventId: ev.id, slotStart: ev.startAt })).occurrenceId, room.occurrenceId);
  // and the Meet lens
  const recent = await ravi.request('meet.recent', {});
  assert.equal(recent[0].occurrenceId, room.occurrenceId);
});

test('who may come back: a removed invitee leaves the thread unless they attended; an outsider let in reads only the meeting\'s part; cancelling keeps the thread', async () => {
  const { owner, priya, ravi, join } = await office();
  const anil = (await (async () => { const { c, identity } = await join('anil'); await owner.request('admin.decide', { deviceId: identity.deviceId, approve: true }); await until(c, (s) => s.kind === 'ready'); return c; })());
  const start = Date.now() + 10 * 60_000;
  const ev = await priya.request('cal.create', { title: 'Design check', startAt: start, endAt: start + HOUR, attendees: [me(ravi), me(anil)], online: true }) as CalEvent;
  // anil is taken off before the meeting: he leaves the thread
  await priya.request('cal.update', { eventId: ev.id, attendees: [me(ravi)] });
  assert.ok(!(await anil.request('conv.list') as Conversation[]).some((c) => c.id === ev.convId));
  // ravi attends; taken off the invitation afterwards, he keeps the thread (he was there)
  const em = await priya.request('meet.event', { eventId: ev.id }) as MeetingInfo;
  const er = (await priya.request('meet.join', { id: em.id }) as { room: RoomInfo }).room;
  await ravi.request('meet.join', { id: em.id });
  await priya.request('room.end', { roomId: er.id });
  await priya.request('cal.update', { eventId: ev.id, attendees: [] });
  assert.ok((await ravi.request('conv.list') as Conversation[]).some((c) => c.id === ev.convId), 'an attendee keeps the thread');
  // a Space meeting: vikram is let in from outside and attends; he is not a member of the Space
  const space = await priya.request('conv.create', { kind: 'space', name: 'Piping desk', private: true, members: [me(ravi)] }) as Conversation;
  await send(priya, space.id, 'Members only: the bid price is 12 lakh');
  const sm = await priya.request('meet.create', { convId: space.id }) as MeetingInfo;
  const room = (await priya.request('meet.join', { id: sm.id }) as { room: RoomInfo }).room;
  const w = await owner.request('meet.join', { id: sm.id }) as { waiting?: string };
  if (w.waiting) { await priya.request('room.admit', { roomId: room.id, all: true, allow: true }); await owner.request('meet.join', { id: sm.id }); }
  await priya.request('room.chat', { roomId: room.id, text: 'Everyone here: start with the GA' });
  await send(priya, space.id, 'Members only, during the meeting');
  await priya.request('room.end', { roomId: room.id });
  const recap = await owner.request('meet.recap', { occurrenceId: room.occurrenceId! }) as MeetRecap;
  assert.equal(recap.viewer.member, false);
  assert.deepEqual(recap.chat.lines.map((l) => l.text), ['Everyone here: start with the GA'], 'only what he could see in the meeting');
  assert.equal(recap.polls.length, 0);
  await assert.rejects(anil.request('meet.recap', { occurrenceId: room.occurrenceId! }), /No recap/);
  // cancelled: the thread stays, with a card
  await priya.request('cal.cancel', { eventId: ev.id });
  const msgs = (await thread(ravi, ev.convId!)).messages;
  assert.ok(msgs.some((x) => x.meetCard?.kind === 'cancelled'));
});

test('action points: logged three ways, numbered for the thread, the owner hears once and finds it on their Desk and day sheet; done, overdue reminders grouped in working hours', async () => {
  const { hub, priya, ravi } = await office();
  const m = await priya.request('meet.create', { title: 'Weekly piping sync', invite: [me(ravi)] }) as MeetingInfo;
  const room = (await priya.request('meet.join', { id: m.id }) as { room: RoomInfo }).room;
  await ravi.request('meet.join', { id: m.id });
  // 1. from chat (the app parsed "/action Ravi to send the revised GA by Fri"); 2. the capture strip; 3. promote a line
  const due = ymd(Date.now() + 3 * DAY);
  const heard = nextEvent<{ action: ActionPoint; title: string }>(ravi, 'ap.assigned');
  const m1 = await send(priya, m.convId!, 'Send the revised GA');
  const a1 = await priya.request('ap.create', { messageId: m1.id, ownerId: me(ravi), due, source: 'chat' });
  assert.equal(a1.n, 1);
  assert.equal(a1.text, 'Send the revised GA');
  const told = await heard;
  assert.equal(told.action.id, a1.id);
  assert.equal(told.title, 'Weekly piping sync');
  const m2 = await send(priya, m.convId!, 'Check nozzle loads with the vendor');
  const a2 = await priya.request('ap.create', { messageId: m2.id, ownerName: 'Mr Rao', source: 'strip' });
  assert.equal(a2.ownerName, 'Mr Rao');
  const said = await ravi.request('room.chat', { roomId: room.id, text: 'I can update the MTO after lunch' });
  const a3 = await priya.request('ap.create', { messageId: said.messageId!, ownerId: me(ravi), source: 'promote' });
  assert.deepEqual([a1.n, a2.n, a3.n], [1, 2, 3]);
  // the same message twice is one action point (two devices, a retry)
  assert.equal((await priya.request('ap.create', { messageId: m1.id, ownerId: me(ravi) })).id, a1.id);
  // on ravi's Desk (filed as To-do, with a reminder on the due date) and his day sheet, given by priya
  const saved = await ravi.request('desk.saved') as Array<{ message: Message; kind: string }>;
  assert.ok(saved.some((s) => s.message.id === m1.id && s.kind === 'todo'));
  const reminders = await ravi.request('remind.list', {}) as Array<{ messageId?: string; message: Message | null; dueAt: number }>;
  assert.ok(reminders.some((r) => r.message?.id === m1.id));
  const sheet = await ravi.request('nib.me') as { items: Array<{ id: string; activity: string; giverId: string | null; source: string; status: string }> };
  const item = sheet.items.find((i) => /AP-01/.test(i.activity))!;
  assert.ok(item, 'on his day sheet');
  assert.equal(item.giverId, me(priya));
  assert.equal(item.source, 'meeting');
  // the card shows on the message
  const card = (await thread(ravi, m.convId!)).messages.find((x) => x.id === m1.id)!;
  assert.equal(card.actionPoint?.id, a1.id);
  // someone else cannot change it; the owner ticks it on his day sheet and the register follows
  await ravi.request('nib.item.save', { id: item.id, status: 'done' });
  const list = await priya.request('ap.list', { convId: m.convId! });
  assert.equal(list.actions.find((a) => a.id === a1.id)!.status, 'done');
  const r1 = (await ravi.request('remind.list', { includeDone: true }) as Array<{ message: Message | null; done: boolean }>).find((r) => r.message?.id === m1.id)!;
  assert.equal(r1.done, true, 'the Desk reminder closes with it');
  // reopened in the register: the day sheet follows
  await ravi.request('ap.update', { id: a1.id, status: 'open' });
  assert.equal((await ravi.request('nib.me')).items.find((i: { id: string }) => i.id === item.id)?.status, 'going');

  // overdue: a3 given a date in the past; reminders only in working hours, one message for all, once a day
  await priya.request('ap.update', { id: a3.id, due: ymd(Date.now() - 2 * DAY) });
  await priya.request('ap.update', { id: a1.id, due: ymd(Date.now() - DAY) });
  const day = new Date(); day.setHours(0, 0, 0, 0);
  // a working day (Mon–Sat) at 07:00, then at 11:00
  while (day.getDay() === 0) day.setDate(day.getDate() + 1);
  const at = (h: number) => day.getTime() + h * HOUR;
  const count = async () => (await ravi.request('conv.list') as Conversation[]).filter((c) => c.kind === 'direct' && c.lastMessage && /past their date|past its date/.test(c.lastMessage.body ?? '')).length;
  hub.meetThreads.tick(at(7));
  assert.equal(await count(), 0, 'not before the working day starts');
  hub.meetThreads.tick(at(11));
  for (let i = 0; i < 50 && !(await count()); i++) await new Promise((r) => setTimeout(r, 20));
  const dm = (await ravi.request('conv.list') as Conversation[]).find((c) => c.kind === 'direct' && /past their date/.test(c.lastMessage?.body ?? ''))!;
  assert.ok(dm, 'one grouped message');
  assert.match(dm.lastMessage!.body, /AP-01/);
  assert.match(dm.lastMessage!.body, /AP-03/);
  const before = (await thread(ravi, dm.id)).messages.length;
  hub.meetThreads.tick(at(15));
  assert.equal((await thread(ravi, dm.id)).messages.length, before, 'once a working day');
  // deleting the card's message drops it from the register
  await priya.request('msg.delete', { messageId: m2.id });
  assert.ok(!(await priya.request('ap.list', { convId: m.convId! })).actions.some((a) => a.id === a2.id));
});

test('a recurring meeting has one thread: an occurrence per date, open action points brought forward, each its own recap', async () => {
  const { hub, priya, ravi } = await office();
  // weekly, the first one now
  const t0 = Date.now() - 10 * 60_000;
  const ev = await priya.request('cal.create', { title: 'Weekly coordination', startAt: t0, endAt: t0 + HOUR, attendees: [me(ravi)], online: true, recurrence: 'weekly' }) as CalEvent;
  const m = await priya.request('meet.event', { eventId: ev.id }) as MeetingInfo;
  const r1 = (await priya.request('meet.join', { id: m.id }) as { room: RoomInfo }).room;
  await ravi.request('meet.join', { id: m.id });
  const x = await send(priya, ev.convId!, 'Issue the line list');
  const ap = await priya.request('ap.create', { messageId: x.id, ownerId: me(ravi) });
  const y = await send(priya, ev.convId!, 'Book the site visit');
  const apDone = await priya.request('ap.create', { messageId: y.id, ownerId: me(priya) });
  await priya.request('ap.update', { id: apDone.id, status: 'done' });
  await priya.request('room.end', { roomId: r1.id });
  // a week later (the hub's thread clock moved on)
  hub.meetThreads.setClock(t0 + 7 * DAY + 5 * 60_000);
  try {
    const r2 = (await priya.request('meet.join', { id: m.id }) as { room: RoomInfo }).room;
    assert.notEqual(r2.occurrenceId, r1.occurrenceId, 'a new occurrence');
    const info = await priya.request('meet.thread', { convId: ev.convId! });
    assert.equal(info.occurrences.length, 2);
    assert.deepEqual(info.occurrences.map((o) => o.seq), [2, 1]);
    assert.equal(info.occurrences[0].slotStart, t0 + 7 * DAY);
    const reg = await priya.request('ap.list', { occurrenceId: r2.occurrenceId! });
    const carried = reg.actions.filter((a) => a.carried);
    assert.deepEqual(carried.map((a) => a.id), [ap.id], 'only the open one is brought forward');
    const z = await send(priya, ev.convId!, 'Send the minutes');
    const ap3 = await priya.request('ap.create', { messageId: z.id, ownerId: me(ravi) });
    assert.equal(ap3.n, 3, 'numbered for the series');
    await priya.request('room.end', { roomId: r2.id });
    const rc2 = await priya.request('meet.recap', { occurrenceId: r2.occurrenceId! });
    assert.deepEqual(rc2.actions.map((a) => [a.n, !!a.carried]), [[1, true], [3, false]]);
    const rc1 = await priya.request('meet.recap', { occurrenceId: r1.occurrenceId! });
    assert.deepEqual(rc1.actions.map((a) => a.n), [1, 2]);
  } finally { hub.meetThreads.setClock(null); }
});

test('the hub restarts mid-meeting: the chat is kept, the Room resumes the same occurrence, one nobody returns to closes with its recap', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexrecap-'));
  let hub = new Hub({ dataDir: dir, port: 0, host: '127.0.0.1', discoveryPort: false, updates: false });
  await hub.start();
  const port = hub.port;
  const clients: HubClient[] = [];
  cleanups.push(async () => { for (const c of clients) c.disconnect(); await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const ids = new Map<string, ReturnType<typeof createIdentity>>();
  const connect = async (username: string) => {
    const identity = ids.get(username) ?? createIdentity();
    ids.set(username, identity);
    const c = new HubClient({ identity, account: { username, domain: 'DEX', displayName: username[0].toUpperCase() + username.slice(1), hostname: `${username}-pc` } });
    clients.push(c);
    c.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
    await until(c, (s) => s.kind === 'ready' || s.kind === 'pending');
    return { c, identity };
  };
  const owner = (await connect('vikram')).c;
  const p = await connect('priya');
  await owner.request('admin.decide', { deviceId: p.identity.deviceId, approve: true });
  await until(p.c, (s) => s.kind === 'ready');
  const m = await p.c.request('meet.create', { title: 'Restart drill', invite: [me(owner)] }) as MeetingInfo;
  const room = (await p.c.request('meet.join', { id: m.id }) as { room: RoomInfo }).room;
  await owner.request('meet.join', { id: m.id });
  await p.c.request('room.chat', { roomId: room.id, text: 'Line one before the restart' });
  await owner.request('room.chat', { roomId: room.id, text: 'Line two before the restart' });

  // the hub stops without the meeting ending
  for (const c of clients.splice(0)) c.disconnect();
  await hub.stop();
  hub = new Hub({ dataDir: dir, port, host: '127.0.0.1', discoveryPort: false, updates: false });
  await hub.start();
  const priya = (await connect('priya')).c;
  const vikram = (await connect('vikram')).c;
  await until(priya, (s) => s.kind === 'ready');
  const back = (await priya.request('meet.join', { id: m.id }) as { room: RoomInfo }).room;
  assert.equal(back.occurrenceId, room.occurrenceId, 'the same occurrence resumes');
  const log = await priya.request('room.chatLog', { roomId: back.id });
  assert.deepEqual(log.map((l) => l.text), ['Line one before the restart', 'Line two before the restart']);
  await vikram.request('meet.join', { id: m.id });
  await vikram.request('room.chat', { roomId: back.id, text: 'Line three after' });
  await priya.request('room.end', { roomId: back.id });
  const recap = await priya.request('meet.recap', { occurrenceId: room.occurrenceId! }) as MeetRecap;
  assert.deepEqual(recap.chat.lines.filter((l) => l.everyone).map((l) => l.text), ['Line one before the restart', 'Line two before the restart', 'Line three after']);
  const cards = (await thread(priya, m.convId!)).messages.filter((x) => x.meetCard);
  assert.deepEqual(cards.map((c) => c.meetCard!.kind), ['started', 'recap'], 'one divider and one recap');

  // another meeting is left running when the hub stops, and nobody comes back
  const m2 = await priya.request('meet.create', { title: 'Abandoned', invite: [me(vikram)] }) as MeetingInfo;
  const r2 = (await priya.request('meet.join', { id: m2.id }) as { room: RoomInfo }).room;
  await vikram.request('meet.join', { id: m2.id });
  await priya.request('room.chat', { roomId: r2.id, text: 'Anyone there?' });
  for (const c of clients.splice(0)) c.disconnect();
  await hub.stop();
  hub = new Hub({ dataDir: dir, port, host: '127.0.0.1', discoveryPort: false, updates: false });
  await hub.start();
  const again = (await connect('priya')).c;
  hub.meetThreads.tick(Date.now() + 16 * 60_000);
  const rc = await again.request('meet.recap', { occurrenceId: r2.occurrenceId! }) as MeetRecap;
  assert.equal(rc.occurrence.state, 'ended');
  assert.ok((await thread(again, m2.convId!)).messages.some((x) => x.meetCard?.kind === 'recap'));
});

test('retention: purged messages take their action points and saved chat with them, and the recap does not bring them back', async () => {
  const { hub, owner, priya, ravi } = await office();
  const m = await priya.request('meet.create', { title: 'Old meeting', invite: [me(ravi)] }) as MeetingInfo;
  const room = (await priya.request('meet.join', { id: m.id }) as { room: RoomInfo }).room;
  await ravi.request('meet.join', { id: m.id });
  const said = await ravi.request('room.chat', { roomId: room.id, text: 'An old line' });
  await priya.request('ap.create', { messageId: said.messageId!, ownerId: me(ravi) });
  await priya.request('room.end', { roomId: room.id });
  assert.equal((await priya.request('meet.recap', { occurrenceId: room.occurrenceId! })).actions.length, 1);
  await owner.request('admin.compliance.setPolicy', { spaceRetentionDays: 30, directRetentionDays: null });
  hub.compliance.purge(Date.now() + 31 * DAY);
  const recap = await priya.request('meet.recap', { occurrenceId: room.occurrenceId! }) as MeetRecap;
  assert.equal(recap.actions.length, 0);
  assert.equal(recap.chat.lines.length, 0);
  assert.equal((await priya.request('ap.list', { mine: true })).actions.length, 0);
  assert.equal((await ravi.request('ap.list', { mine: true })).actions.length, 0);
});
