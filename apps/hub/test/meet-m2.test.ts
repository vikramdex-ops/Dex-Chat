// Meetings M2 on the hub: per-meeting reports (attendance with rejoins summed, hands, reactions,
// polls), the office's meeting totals, recordings uploaded in chunks (resumable, capped, shared,
// audited, kept by retention) and breakout rooms (assignments, notes, visits, the timer and the
// call back with its countdown).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { BREAKOUT_RETURN_MS, RECORDING_CHUNK } from '@dex/core';
import type { BreakoutView, MeetingInfo, MeetingReport, RecordingInfo, RoomInfo } from '@dex/core';
import type { HubClient } from '@dex/core/client';
import type { Hub } from '../src/hub.ts';
import { office, me, nextEvent } from './office.ts';

const dev = (c: HubClient) => c.session!.deviceId;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function get(hub: Hub, path: string, token: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const r = https.request({ host: '127.0.0.1', port: hub.port, path, method: 'GET', rejectUnauthorized: false, headers: { authorization: `Bearer ${token}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end();
  });
}

test('a meeting report: who came and for how long (rejoins summed), hands, reactions and polls; office totals', async () => {
  const { owner, priya, ravi, join } = await office();
  const asha = (await join('asha')).c; // pending: not approved, cannot see anything
  void asha;
  const m = await priya.request('meet.create', { title: 'Design review', invite: [me(ravi)] }) as MeetingInfo;
  const room = (await priya.request('meet.join', { id: m.id })).room!;
  await ravi.request('meet.join', { id: m.id });
  await ravi.request('room.hand', { roomId: room.id, up: true });
  await ravi.request('room.react', { roomId: room.id, emoji: '👏' });
  await sleep(300);
  await priya.request('room.react', { roomId: room.id, emoji: '🎉' });
  await priya.request('poll.create', { convId: m.convId!, question: 'Ship rev C?', options: ['Yes', 'No'], clientId: 'p1' });
  const poll = (await priya.request('msg.list', { convId: m.convId! })).messages.find((x) => x.poll)!;
  await ravi.request('poll.vote', { messageId: poll.id, options: [0] });
  await priya.request('poll.vote', { messageId: poll.id, options: [0] });
  // ravi leaves and comes back: one person, two visits
  await ravi.request('room.leave', { roomId: room.id });
  await sleep(150);
  await ravi.request('meet.join', { id: m.id });
  await sleep(150);
  // the report is there while the meeting runs, and after
  const live = await priya.request('meet.report', { roomId: room.id }) as MeetingReport;
  assert.equal(live.endedAt, null);
  await priya.request('room.end', { roomId: room.id });
  const r = await ravi.request('meet.report', { roomId: room.id }) as MeetingReport;
  assert.equal(r.title, 'Design review');
  assert.equal(r.meetingId, m.id);
  assert.ok(r.endedAt);
  assert.equal(r.people.length, 2);
  const rv = r.people.find((p) => p.userId === me(ravi))!;
  const pr = r.people.find((p) => p.userId === me(priya))!;
  assert.equal(rv.joins, 2);
  assert.equal(pr.joins, 1);
  assert.ok(rv.totalMs < pr.totalMs, 'the time away is not counted');
  assert.ok(rv.totalMs > 200);
  assert.equal(rv.hands, 1);
  assert.equal(rv.reactions, 1);
  assert.equal(r.hands, 1);
  assert.deepEqual(r.reactions, { '👏': 1, '🎉': 1 });
  assert.equal(r.peak, 2);
  assert.deepEqual(r.polls, [{ question: 'Ship rev C?', options: [{ text: 'Yes', votes: 2 }, { text: 'No', votes: 0 }], voters: 2 }]);
  // people who were not there do not see it (administrators do)
  const other = await priya.request('conv.create', { kind: 'space', name: 'Elsewhere', members: [] });
  void other;
  assert.ok(await owner.request('meet.report', { roomId: room.id }));
  await assert.rejects(ravi.request('meet.report', { roomId: 'nope' }), /No report/);

  // the office's totals by week
  await assert.rejects(priya.request('admin.meetings.usage', { days: 28 }), /administrators/);
  const u = await owner.request('admin.meetings.usage', { days: 28 });
  assert.equal(u.totals.meetings, 1);
  assert.equal(u.totals.averageSize, 2);
  assert.ok(u.weeks.length >= 4);
  assert.equal(u.weeks.reduce((n, w) => n + w.meetings, 0), 1);
});

test('recordings: uploaded in chunks (resumable, capped), kept on the hub, shared, audited, deleted', async () => {
  const { hub, owner, priya, ravi } = await office();
  const m = await priya.request('meet.create', { title: 'Model review', invite: [me(ravi)] }) as MeetingInfo;
  const room = (await priya.request('meet.join', { id: m.id })).room!;
  await ravi.request('meet.join', { id: m.id });
  await priya.request('room.end', { roomId: room.id });

  // the office caps a recording's size
  await owner.request('admin.policy.set', { recordingMaxMb: 50 });
  await assert.rejects(priya.request('rec.begin', { roomId: room.id, title: '', startedAt: Date.now() - 60_000, size: 60 * 1024 * 1024, mime: 'video/webm;codecs=vp8,opus' }), /up to 50 MB/);

  const video = Buffer.alloc(RECORDING_CHUNK * 2 + 1234);
  for (let i = 0; i < video.length; i++) video[i] = (i * 7) % 251;
  video.set([0x1a, 0x45, 0xdf, 0xa3], 0); // a WebM file starts like this
  const startedAt = Date.now() - 90_000;
  const b = await priya.request('rec.begin', { roomId: room.id, title: '', startedAt, size: video.length, mime: 'video/webm;codecs=vp8,opus' });
  assert.equal(b.received, 0);
  assert.equal(b.chunk, RECORDING_CHUNK);
  const send = (offset: number) => priya.request('rec.chunk', { id: b.id, offset, data: video.subarray(offset, offset + RECORDING_CHUNK).toString('base64') });
  assert.equal((await send(0)).received, RECORDING_CHUNK);
  // the answer was lost and the chunk comes again: no harm done
  assert.equal((await send(0)).received, RECORDING_CHUNK);
  // the connection dropped: starting again finds the same upload and where it got to
  const again = await priya.request('rec.begin', { roomId: room.id, title: '', startedAt, size: video.length, mime: 'video/webm' });
  assert.equal(again.id, b.id);
  assert.equal(again.received, RECORDING_CHUNK);
  await assert.rejects(priya.request('rec.finish', { id: b.id, durationMs: 60_000, chapters: [] }), /not complete/);
  await assert.rejects(ravi.request('rec.chunk', { id: b.id, offset: RECORDING_CHUNK, data: 'AAAA' }), /not yours/);
  assert.equal((await send(RECORDING_CHUNK)).received, RECORDING_CHUNK * 2);
  assert.equal((await send(RECORDING_CHUNK * 2)).received, video.length);
  const chapters = [{ at: 0, userId: me(priya), name: 'Priya' }, { at: 21_000, userId: me(ravi), name: 'Ravi' }, { at: 48_000, userId: me(priya), name: 'Priya' }];
  const rec = await priya.request('rec.finish', { id: b.id, durationMs: 60_000, chapters }) as RecordingInfo;
  assert.equal(rec.status, 'ready');
  assert.equal(rec.title, 'Model review');
  assert.equal(rec.meetingId, m.id);
  assert.equal(rec.convId, m.convId);
  assert.equal(rec.durationMs, 60_000);
  assert.deepEqual(rec.chapters.map((c) => c.name), ['Priya', 'Ravi', 'Priya']);
  assert.ok(rec.fileId);
  assert.equal(rec.canManage, true);

  // only the recorder sees it, until it is shared
  assert.equal((await priya.request('rec.list')).length, 1);
  assert.equal((await ravi.request('rec.list')).length, 0);
  assert.equal((await get(hub, `/files/${rec.fileId}`, ravi.session!.fileToken)).status, 404);
  const mine = await get(hub, `/files/${rec.fileId}`, priya.session!.fileToken);
  assert.equal(mine.status, 200);
  assert.ok(mine.body.equals(video), 'the stored video is byte for byte the upload');
  await assert.rejects(ravi.request('rec.share', { id: rec.id, conv: true }), /not found/);

  // shared with the meeting's conversation: its members watch it
  const shared = await priya.request('rec.share', { id: rec.id, conv: true });
  assert.equal(shared.sharedWithConv, true);
  const rl = await ravi.request('rec.list');
  assert.equal(rl.length, 1);
  assert.equal(rl[0].canManage, false);
  assert.equal(rl[0].link, null);
  assert.equal((await get(hub, `/files/${rec.fileId}`, ravi.session!.fileToken)).status, 200);
  // and by a link, for anyone in the office (who opens it)
  assert.equal((await owner.request('rec.list')).length, 1, 'administrators see every recording');
  const linked = await priya.request('rec.share', { id: rec.id, link: true });
  assert.match(linked.link!, /^dexconnect:\/\/recording\/[A-Za-z0-9_-]{16,}$/);
  const token = linked.link!.split('/').pop()!;
  await priya.request('rec.share', { id: rec.id, conv: false });
  assert.equal((await ravi.request('rec.list')).length, 0);
  const viaLink = await ravi.request('rec.get', { token });
  assert.equal(viaLink.id, rec.id);
  assert.equal((await ravi.request('rec.list')).length, 1, 'opened by its link');
  // the link turned off: it stops working
  await priya.request('rec.share', { id: rec.id, link: false });
  await assert.rejects(owner.request('rec.get', { token }), /does not work/);
  assert.equal((await get(hub, `/files/${rec.fileId}`, ravi.session!.fileToken)).status, 404);

  // downloads are audited (once, not for each byte range)
  await get(hub, `/files/${rec.fileId}?download=1`, priya.session!.fileToken);
  await get(hub, `/files/${rec.fileId}`, priya.session!.fileToken, { range: 'bytes=100-200' });
  const audit = await owner.request('admin.audit', { limit: 100 }) as Array<{ action: string }>;
  assert.ok(audit.filter((a) => a.action === 'recording.downloaded').length >= 2);
  for (const a of ['recording.uploadStarted', 'recording.stored', 'recording.shared']) assert.ok(audit.some((x) => x.action === a), a);

  // the recording is never garbage-collected as an unused file
  hub.files.gc(Date.now() + 86400_000);
  assert.equal((await get(hub, `/files/${rec.fileId}`, priya.session!.fileToken)).status, 200);

  // administrators can delete; the file goes with it
  await assert.rejects(ravi.request('rec.delete', { id: rec.id }), /not found|Only/);
  await owner.request('rec.delete', { id: rec.id });
  assert.equal((await priya.request('rec.list')).length, 0);
  assert.equal((await get(hub, `/files/${rec.fileId}`, priya.session!.fileToken)).status, 404);
});

test('recordings follow the office retention; legal holds keep them', async () => {
  const { hub, owner, priya, ravi } = await office();
  const m = await priya.request('meet.create', { title: 'Retention', invite: [me(ravi)] }) as MeetingInfo;
  const room = (await priya.request('meet.join', { id: m.id })).room!;
  await priya.request('room.end', { roomId: room.id });
  const upload = async (title: string) => {
    const data = Buffer.from(`webm-${title}`);
    const b = await priya.request('rec.begin', { roomId: room.id, title, startedAt: Date.now() - 1000, size: data.length, mime: 'video/webm' });
    await priya.request('rec.chunk', { id: b.id, offset: 0, data: data.toString('base64') });
    return priya.request('rec.finish', { id: b.id, durationMs: 1000, chapters: [] });
  };
  const old = await upload('Old');
  const kept = await upload('Kept');
  assert.equal(old.expiresAt, null, 'kept forever by default');
  await owner.request('admin.compliance.setPolicy', { spaceRetentionDays: 30, directRetentionDays: null });
  const now = Date.now();
  hub.store.db.prepare('UPDATE meeting_recordings SET created_at = ? WHERE id IN (?, ?)').run(now - 40 * 86400_000, old.id, kept.id);
  const withExpiry = (await priya.request('rec.get', { id: old.id })) as RecordingInfo;
  assert.ok(withExpiry.expiresAt! < now);
  // a hold on the recorder keeps both
  const hold = await owner.request('admin.compliance.hold', { kind: 'user', targetId: me(priya), note: 'Matter 7' });
  assert.equal(hub.recordings.purge(), 0);
  await owner.request('admin.compliance.release', { id: hold.id });
  // a hold on the conversation keeps them too
  await owner.request('admin.compliance.hold', { kind: 'conv', targetId: m.convId!, note: 'Matter 8' });
  assert.equal(hub.recordings.purge(), 0);
  assert.equal((await priya.request('rec.list')).length, 2);
  const holds = (await owner.request('admin.compliance.get')).holds;
  for (const h of holds) await owner.request('admin.compliance.release', { id: h.id });
  assert.equal(hub.recordings.purge(), 2);
  assert.equal((await priya.request('rec.list')).length, 0);
});

test('breakout rooms: split, a note to every room, visit, move, the countdown and everyone back', async () => {
  const { hub, owner, priya, ravi, join } = await office();
  const asha = (await join('asha')).c;
  await owner.request('admin.decide', { deviceId: asha.session?.deviceId ?? (await owner.request('admin.devices')).find((d) => d.status === 'pending')!.id, approve: true });
  await new Promise((r) => setTimeout(r, 200));
  const m = await priya.request('meet.create', { title: 'Workshop', invite: [me(ravi), me(owner), me(asha)] }) as MeetingInfo;
  const main = (await priya.request('meet.join', { id: m.id })).room!;
  for (const c of [ravi, owner, asha]) await c.request('meet.join', { id: m.id });
  await assert.rejects(ravi.request('room.breakout.open', { roomId: main.id, rooms: [{ name: 'A', devices: [dev(ravi)] }], minutes: 10 }), /host/);
  await assert.rejects(priya.request('room.breakout.open', { roomId: main.id, rooms: [{ name: 'A', devices: [] }], minutes: 10 }), /Put someone/);
  await assert.rejects(priya.request('room.breakout.open', { roomId: main.id, rooms: [{ name: 'A', devices: [dev(ravi)] }], minutes: 999 }), /timer/);

  const movedRavi = nextEvent<{ from: string; room: RoomInfo }>(ravi, 'room.moved');
  const movedAsha = nextEvent<{ from: string; room: RoomInfo }>(asha, 'room.moved');
  const b = await priya.request('room.breakout.open', {
    roomId: main.id, minutes: 15,
    rooms: [{ name: 'Piping', devices: [dev(ravi), dev(owner)] }, { name: 'Civil', devices: [dev(asha), 'not-in-the-room'] }],
  }) as BreakoutView;
  assert.equal(b.rooms.length, 2);
  assert.ok(b.endsAt! > Date.now() + 14 * 60_000);
  const rr = await movedRavi;
  assert.equal(rr.from, main.id);
  assert.equal(rr.room.parentId, main.id);
  assert.equal(rr.room.breakoutName, 'B1 · Piping');
  const piping = (await ravi.request('room.list')).find((r) => r.id === rr.room.id)!;
  assert.deepEqual(piping.participants.map((p) => p.userId).sort(), [me(ravi), me(owner)].sort());
  const ra = await movedAsha;
  assert.equal(ra.room.breakoutName, 'B2 · Civil');
  // the main Room keeps running with the host, and lists the breakouts
  const mainNow = (await priya.request('room.list')).find((r) => r.id === main.id)!;
  assert.deepEqual(mainNow.participants.map((p) => p.userId), [me(priya)]);
  assert.deepEqual(mainNow.breakouts!.rooms.map((x) => x.devices.length), [2, 1]);
  // a breakout is not joined by its id, and is not "the" Room of the conversation
  await assert.rejects(priya.request('room.join', { roomId: rr.room.id }), /breakout/);
  // signalling stays inside each breakout
  await assert.rejects(ravi.request('room.signal', { roomId: rr.room.id, toDevice: dev(asha), data: {} }), /Not in this call/);
  await ravi.request('room.signal', { roomId: rr.room.id, toDevice: dev(owner), data: { candidate: null } });

  // a note to every room
  const noteA = nextEvent<{ text: string }>(asha, 'room.breakoutNote');
  const noteR = nextEvent<{ text: string }>(ravi, 'room.breakoutNote');
  await priya.request('room.breakout.note', { roomId: main.id, text: 'Five minutes left: pick one option' });
  assert.equal((await noteA).text, 'Five minutes left: pick one option');
  assert.equal((await noteR).text, 'Five minutes left: pick one option');
  // the meeting chat is shared by every room
  const chat = nextEvent<{ text: string }>(priya, 'room.chat');
  await asha.request('room.chat', { roomId: ra.room.id, text: 'Civil has a question' });
  assert.equal((await chat).text, 'Civil has a question');

  // the host visits B2, then moves Ravi there
  const visit = await priya.request('room.breakout.visit', { roomId: main.id, to: 1 }) as RoomInfo;
  assert.equal(visit.breakoutName, 'B2 · Civil');
  assert.equal(visit.participants.length, 2);
  const moved = nextEvent<{ room: RoomInfo }>(ravi, 'room.moved');
  const after = await priya.request('room.breakout.move', { roomId: visit.id, deviceId: dev(ravi), to: 1 }) as BreakoutView;
  assert.equal((await moved).room.breakoutName, 'B2 · Civil');
  assert.deepEqual(after.rooms.map((x) => x.devices.length), [1, 3]);
  // someone leaving a breakout does not end it or the meeting
  await owner.request('room.leave', { roomId: rr.room.id });
  assert.ok((await priya.request('room.list')).some((r) => r.id === main.id));
  await priya.request('room.breakout.visit', { roomId: visit.id, to: 'main' });

  // call everyone back: a 60-second countdown for everyone first
  const countdown = nextEvent<RoomInfo>(asha, 'room.updated', (r) => !!r.breakouts?.returningAt);
  const closing = await priya.request('room.breakout.close', { roomId: main.id }) as BreakoutView;
  assert.ok(Math.abs(closing.returningAt! - (Date.now() + BREAKOUT_RETURN_MS)) < 2000);
  assert.ok((await countdown).breakouts!.returningAt);
  // (the 60 seconds pass): everyone is back in the main Room, the breakouts gone
  const home = nextEvent<{ from: string; room: RoomInfo }>(asha, 'room.moved');
  hub.rooms.breakouts.returnAll(hub.rooms.rooms.get(main.id)!);
  assert.equal((await home).room.id, main.id);
  const back = (await priya.request('room.list')).find((r) => r.id === main.id)!;
  assert.deepEqual(back.participants.map((p) => p.userId).sort(), [me(priya), me(ravi), me(asha)].sort());
  assert.equal(back.breakouts, undefined);
  assert.equal((await priya.request('room.list')).length, 1);
  const rep = await priya.request('meet.report', { roomId: main.id }) as MeetingReport;
  assert.equal(rep.breakouts, 2);
  assert.equal(rep.people.find((p) => p.userId === me(asha))!.joins, 1, 'moving between rooms is not leaving');

  // breakouts again, ended by the host from inside one: the whole meeting ends
  await priya.request('room.breakout.open', { roomId: main.id, rooms: [{ name: 'Solo', devices: [dev(asha)] }], minutes: null });
  const sub = (await asha.request('room.list')).find((r) => r.parentId === main.id)!;
  const endedAsha = nextEvent<{ roomId: string }>(asha, 'room.ended', (e) => e.roomId === sub.id);
  await priya.request('room.breakout.visit', { roomId: main.id, to: 0 });
  await priya.request('room.end', { roomId: sub.id });
  await endedAsha;
  assert.equal((await priya.request('room.list')).length, 0);
  const audit = await owner.request('admin.audit', { limit: 100 }) as Array<{ action: string }>;
  for (const a of ['meeting.breakouts.opened', 'meeting.breakouts.closed', 'meeting.ended']) assert.ok(audit.some((x) => x.action === a), a);
});
