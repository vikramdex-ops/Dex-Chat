// Remote support policies (docs/HELP-DESK.md, "Remote support"): unattended access for IT staff,
// sessions that wait for a dropped connection, and the audit trail of both. Each is off unless an
// administrator turns it on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import type { SupportSession } from '@dex/core';
import { createIdentity } from '@dex/core';
import { HubClient } from '@dex/core/client';
import { parsePairCode } from '@dex/core/remote';
import { office, nextEvent, me, until, cleanups } from './office.ts';

function upload(hub: { port: number }, c: HubClient, name: string, body: string): Promise<{ id: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: hub.port, method: 'POST', path: `/files?name=${encodeURIComponent(name)}&type=text/plain`, rejectUnauthorized: false,
      headers: { authorization: `Bearer ${c.session!.fileToken}`, 'content-length': Buffer.byteLength(body) } }, (res) => {
      let raw = ''; res.on('data', (x) => { raw += x; }); res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function status(hub: { port: number }, c: HubClient, fileId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', port: hub.port, path: `/files/${fileId}`, rejectUnauthorized: false, headers: { authorization: `Bearer ${c.session!.fileToken}` } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on('error', reject);
  });
}

test('remote support policies are off until an administrator turns them on', async () => {
  const { owner, priya } = await office();
  const p = await priya.request('policy.get');
  assert.equal(p.assistUnattended, false);
  assert.equal(p.assistClipboard, false);
  assert.equal(p.assistFiles, false);
  assert.equal(p.assistReconnect, false);
  await assert.rejects(priya.request('admin.policy.set', { assistUnattended: true }));
  const changed = nextEvent<{ assistUnattended?: boolean }>(priya, 'policy.updated', (x) => x.assistUnattended === true);
  const after = await owner.request('admin.policy.set', { assistUnattended: true, assistClipboard: true, assistFiles: true, assistReconnect: true });
  assert.equal(after.assistUnattended, true);
  assert.equal(after.assistFiles, true);
  await changed;
  const audit = await owner.request('admin.audit', { limit: 5 });
  assert.ok(audit.some((a) => a.action === 'policy.set'));
});

test('unattended access: only IT staff, only with the policy on, recorded on the ticket and in the audit log', async () => {
  const { owner, priya, ravi } = await office();
  // off: refused even for IT
  await owner.request('admin.help.staff', { userId: me(ravi), on: true });
  await assert.rejects(ravi.request('help.connect', { userId: me(priya) }), /Unattended access is off/);
  await owner.request('admin.policy.set', { assistUnattended: true });
  // not on the IT desk: refused
  await assert.rejects(priya.request('help.connect', { userId: me(ravi) }), /IT desk/);
  await assert.rejects(ravi.request('help.connect', { userId: me(ravi) }), /your own PC/);

  await priya.request('help.device', { control: true });
  const invited = nextEvent<SupportSession>(priya, 'help.session', (s) => s.unattended);
  const r = await ravi.request('help.connect', { userId: me(priya) });
  assert.equal(r.session.unattended, true);
  assert.equal(r.session.requesterId, me(priya));
  assert.equal((await invited).techId, me(ravi));
  // a ticket opened for the person, held by the technician
  const { ticket, timeline } = await priya.request('help.get', { id: r.session.ticketId });
  assert.equal(ticket.status, 'taken');
  assert.equal(ticket.techId, me(ravi));
  assert.ok(timeline.some((e) => e.kind === 'session.started' && e.detail?.unattended === true));

  // the person's app joins and grants by itself; they can still stop it
  await priya.request('help.session.join', { id: ticket.id, controlAvailable: true });
  await priya.request('help.consent', { id: ticket.id, kind: 'screen', on: true, scope: 'screen' });
  await priya.request('help.consent', { id: ticket.id, kind: 'control', on: true });
  const stopped = await priya.request('help.consent', { id: ticket.id, kind: 'control', on: false });
  assert.equal(stopped.consent.control, false);
  assert.deepEqual((await priya.request('help.live')).map((s) => s.id), [r.session.id]);
  await ravi.request('help.session.end', { id: ticket.id });
  assert.deepEqual(await priya.request('help.live'), []);

  const audit = await owner.request('admin.audit', { limit: 40 });
  const actions = audit.map((a) => a.action);
  for (const a of ['help.unattended.started', 'help.unattended.ended', 'help.session.started', 'help.session.ended']) assert.ok(actions.includes(a), a);
  const granted = audit.filter((a) => a.action === 'help.consent.granted');
  assert.ok(granted.length >= 2 && granted.every((a) => (a.detail as { unattended?: boolean }).unattended === true));
});

test('unattended access on an existing ticket takes it and turns a running session unattended', async () => {
  const { owner, priya, ravi } = await office();
  await owner.request('admin.help.staff', { userId: me(ravi), on: true });
  await owner.request('admin.policy.set', { assistUnattended: true });
  const t = await priya.request('help.create', { summary: 'Plotter offline', category: 'printing' });
  await priya.request('help.device', { control: true });
  const r = await ravi.request('help.connect', { id: t.id });
  assert.equal(r.session.ticketId, t.id);
  assert.equal(r.session.unattended, true);
  const { ticket } = await priya.request('help.get', { id: t.id });
  assert.equal(ticket.techId, me(ravi));
  await ravi.request('help.close', { id: t.id });
  await assert.rejects(ravi.request('help.connect', { id: t.id }), /closed/);
});

test('reconnect: with the policy on, a dropped session waits, then resumes; without it, it ends', async () => {
  const { owner, priya, ravi, hub } = await office();
  await owner.request('admin.help.staff', { userId: me(ravi), on: true });
  const start = async (summary: string) => {
    const t = await priya.request('help.create', { summary, category: 'network' });
    await ravi.request('help.take', { id: t.id });
    const s = await ravi.request('help.session.start', { id: t.id });
    const j = await priya.request('help.session.join', { id: t.id, controlAvailable: true });
    await priya.request('help.consent', { id: t.id, kind: 'screen', on: true, scope: 'screen' });
    return { t, room: j.room.id ?? s.room.id };
  };

  // off: both leaving ends the session, as before
  const a = await start('Wi-Fi drops');
  const ended = nextEvent<SupportSession>(ravi, 'help.session', (s) => s.ticketId === a.t.id && !!s.endedAt);
  await priya.request('room.leave', { roomId: a.room });
  await ravi.request('room.leave', { roomId: a.room });
  await ended;

  // on: the session pauses, sharing stops, and joining again resumes it
  await owner.request('admin.policy.set', { assistReconnect: true });
  const b = await start('VPN drops');
  const paused = nextEvent<SupportSession>(priya, 'help.session', (s) => s.ticketId === b.t.id && s.pausedAt !== null);
  await priya.request('room.leave', { roomId: b.room });
  await ravi.request('room.leave', { roomId: b.room });
  const p = await paused;
  assert.equal(p.endedAt, null);
  assert.equal(p.consent.screen, false, 'sharing stops while the connection is down');
  assert.equal((await priya.request('help.live')).length, 1);
  const back = await priya.request('help.session.join', { id: b.t.id, controlAvailable: true });
  // one side back is not enough: the session waits for both, and nothing can be shared meanwhile
  assert.notEqual(back.session.pausedAt, null);
  await assert.rejects(priya.request('help.consent', { id: b.t.id, kind: 'screen', on: true, scope: 'screen' }), /not connected right now/);
  const resumedEv = nextEvent<SupportSession>(priya, 'help.session', (x) => x.id === back.session.id && x.pausedAt === null);
  await ravi.request('help.session.join', { id: b.t.id });
  await resumedEv;
  const { timeline } = await priya.request('help.get', { id: b.t.id });
  assert.ok(timeline.some((e) => e.kind === 'session.paused'));
  assert.ok(timeline.some((e) => e.kind === 'session.resumed'));

  // a connection that does not come back in time ends the session
  hub.helpdesk.reconnectGraceMs = 50;
  const room2 = back.room.id;
  const gone = nextEvent<SupportSession>(ravi, 'help.session', (s) => s.ticketId === b.t.id && !!s.endedAt);
  await priya.request('room.leave', { roomId: room2 });
  await ravi.request('room.leave', { roomId: room2 });
  const g = await gone;
  assert.ok(g.endedAt);
  const after = await priya.request('help.get', { id: b.t.id });
  assert.equal(after.timeline.at(-1)!.text, 'The connection did not come back in time.');
});

test('dropped files: only in a running session with the policy on; the other side can read them; one timeline line per drop', async () => {
  const { owner, priya, ravi, hub } = await office();
  await owner.request('admin.help.staff', { userId: me(ravi), on: true });
  const t = await priya.request('help.create', { summary: 'Need the template folder', category: 'drawings' });
  await ravi.request('help.take', { id: t.id });
  const files = await Promise.all(Array.from({ length: 45 }, (_, i) => upload(hub, ravi, `sheet-${i}.txt`, `sheet ${i}`)));
  const ids = files.map((f) => f.id);
  const one = (id: string, path = 'a.txt') => [{ fileId: id, path }];
  await assert.rejects(ravi.request('help.drop', { id: t.id, files: one(ids[0]) }), /inside the session/);
  await ravi.request('help.session.start', { id: t.id });
  await priya.request('help.session.join', { id: t.id });
  await assert.rejects(ravi.request('help.drop', { id: t.id, files: one(ids[0]) }), /off for this office/);
  await owner.request('admin.policy.set', { assistFiles: true });
  // someone else's file in the batch: nothing is attached, not even the good ones (all or none, always audited)
  const other = await upload(hub, owner, 'secret.txt', 'x');
  await assert.rejects(ravi.request('help.drop', { id: t.id, files: [...one(ids[0]), ...one(other.id, 'b.txt')] }), /not found/);
  assert.equal(await status(hub, priya, ids[0]), 404, 'nothing from a refused drop is readable by the other side');
  // the other side is told through the hub, with the cleaned paths
  const told = nextEvent<{ files: Array<{ fileId: string; path: string }> }>(priya, 'help.dropped');
  // more than a ticket's 40 files: drops do not count toward that limit
  const r = await ravi.request('help.drop', { id: t.id, files: ids.map((id, i) => ({ fileId: id, path: `Templates/../sheet-${i}.txt` })), folder: 'Templates' });
  const heard = await told;
  assert.equal(heard.files.length, 45);
  assert.equal(heard.files[0].path, 'Templates/sheet-0.txt');
  assert.equal(r.count, 45);
  assert.equal(await status(hub, priya, ids[44]), 200);
  const { ticket, timeline } = await priya.request('help.get', { id: t.id });
  assert.equal(ticket.files.length, 0, 'dropped files are not listed as ticket attachments');
  const line = timeline.filter((e) => e.kind === 'file').at(-1)!;
  assert.equal(line.text, '45 files from the folder Templates');
  // a client cannot attach hidden "dropped" files through help.attach: they are ordinary files, counted and listed
  const extra = await upload(hub, priya, 'note.txt', 'n');
  const after = await priya.request('help.attach', { id: t.id, fileId: extra.id, kind: 'dropped' as never });
  assert.equal(after.files.length, 1);
  assert.equal(after.files[0].kind, 'file');
  const audit = await owner.request('admin.audit', { limit: 10 });
  assert.ok(audit.some((a) => a.action === 'help.files.dropped' && (a.detail as { count: number }).count === 45));
});

test('one device per person: the requester\'s other devices and the technician\'s other devices are kept out', async () => {
  const { owner, priya, ravi, hub } = await office();
  await owner.request('admin.help.staff', { userId: me(ravi), on: true });
  const t = await priya.request('help.create', { summary: 'Outlook keeps asking for a password', category: 'account' });
  await ravi.request('help.take', { id: t.id });
  const started = await ravi.request('help.session.start', { id: t.id });
  const j = await priya.request('help.session.join', { id: t.id });
  assert.equal(j.session.requesterDevice, priya.session!.deviceId);
  assert.equal(started.session.techDevice, ravi.session!.deviceId);
  // a second device of Priya's (paired as her) cannot join the same session
  const made = await priya.request('pair.create', { kind: 'laptop' });
  const laptop = new HubClient({ identity: createIdentity(), account: { username: 'priya-laptop', domain: 'DEX', displayName: 'Laptop', hostname: 'priya-laptop' } });
  laptop.setPair(parsePairCode(made.code)!.token);
  cleanups.push(() => laptop.disconnect());
  laptop.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
  await until(laptop, (x) => x.kind === 'ready');
  assert.equal(me(laptop), me(priya));
  await assert.rejects(laptop.request('help.session.join', { id: t.id }), /another of your devices/);
  // and Ravi's second device cannot take over his place either
  await assert.rejects(laptop.request('help.drop', { id: t.id, files: [] }), /.+/);
});

test('unattended: the hub picks one PC of the person; their stop is remembered; turning the policy off takes control back', async () => {
  const { owner, priya, ravi } = await office();
  await owner.request('admin.help.staff', { userId: me(ravi), on: true });
  await owner.request('admin.policy.set', { assistUnattended: true });
  await priya.request('help.device', { control: true });
  const r = await ravi.request('help.connect', { userId: me(priya) });
  assert.equal(r.session.requesterDevice, priya.session!.deviceId, 'the PC IT reaches is chosen by the hub, not the first to join');
  const id = r.session.ticketId;
  await priya.request('help.session.join', { id, controlAvailable: true });
  await priya.request('help.consent', { id, kind: 'screen', on: true, scope: 'screen' });
  await priya.request('help.consent', { id, kind: 'control', on: true });
  const stopped = await priya.request('help.consent', { id, kind: 'control', on: false });
  assert.equal(stopped.stopped, true, 'her stop is remembered for this session');
  // IT connecting again is a new request
  const again = await ravi.request('help.connect', { id });
  assert.equal(again.session.stopped, false);
  await priya.request('help.consent', { id, kind: 'control', on: true });
  // the administrator turns unattended access off: control is taken back at once
  const back = nextEvent<SupportSession>(priya, 'help.session', (s) => !s.consent.control && !s.consent.screen && !s.unattended);
  await owner.request('admin.policy.set', { assistUnattended: false });
  const s = await back;
  assert.equal(s.unattended, false);
  assert.equal(s.consent.screen, false, 'the screen the app shared by itself stops too');
  const audit = (await owner.request('admin.audit', { limit: 20 })).filter((a) => a.action === 'help.unattended.ended');
  assert.ok(audit.some((a) => (a.detail as { why?: string }).why === 'policy turned off'));
});

test('unattended needs the person online', async () => {
  const { owner, priya, ravi } = await office();
  await owner.request('admin.help.staff', { userId: me(ravi), on: true });
  await owner.request('admin.policy.set', { assistUnattended: true });
  const priyaId = me(priya);
  // a device that cannot be controlled (a phone, the web app) is never chosen
  await assert.rejects(ravi.request('help.connect', { userId: priyaId }), /not online/);
  priya.disconnect();
  await new Promise((r) => setTimeout(r, 300));
  await assert.rejects(ravi.request('help.connect', { userId: priyaId }), /not online/);
  // a failed Connect now leaves nothing behind: no ticket opened for her
  const queue = await ravi.request('help.queue', { status: 'all' });
  assert.equal(queue.filter((t) => t.requesterId === priyaId).length, 0);
});

test('reconnect: one side back alone does not end the wait; the wait still runs out', async () => {
  const { owner, priya, ravi, hub } = await office();
  await owner.request('admin.help.staff', { userId: me(ravi), on: true });
  await owner.request('admin.policy.set', { assistReconnect: true });
  hub.helpdesk.reconnectGraceMs = 300;
  const t = await priya.request('help.create', { summary: 'Laptop dock', category: 'hardware' });
  await ravi.request('help.take', { id: t.id });
  await ravi.request('help.session.start', { id: t.id });
  const j = await priya.request('help.session.join', { id: t.id });
  // Ravi's app goes away: the session pauses although Priya is still in the Room
  const paused = nextEvent<SupportSession>(priya, 'help.session', (x) => x.pausedAt !== null);
  await ravi.request('room.leave', { roomId: j.room.id });
  await paused;
  // and it ends when he is not back in time, with Priya still there
  const ended = nextEvent<SupportSession>(priya, 'help.session', (x) => !!x.endedAt);
  assert.ok((await ended).endedAt);
});

test('a dropped file attached afterwards shows on the ticket', async () => {
  const { owner, priya, ravi, hub } = await office();
  await owner.request('admin.help.staff', { userId: me(ravi), on: true });
  await owner.request('admin.policy.set', { assistFiles: true });
  const t = await priya.request('help.create', { summary: 'Log file', category: 'software' });
  await ravi.request('help.take', { id: t.id });
  await ravi.request('help.session.start', { id: t.id });
  await priya.request('help.session.join', { id: t.id });
  const f = await upload(hub, priya, 'app.log', 'log');
  await priya.request('help.drop', { id: t.id, files: [{ fileId: f.id, path: 'app.log' }] });
  assert.equal((await priya.request('help.get', { id: t.id })).ticket.files.length, 0);
  const after = await priya.request('help.attach', { id: t.id, fileId: f.id, kind: 'file' });
  assert.equal(after.files.length, 1);
});

test('third review: leaving the IT desk ends the session; a Room ended before both met ends it; drops wait for both; Connect now never switches PCs', async () => {
  const { owner, priya, ravi } = await office();
  await owner.request('admin.help.staff', { userId: me(ravi), on: true });
  await owner.request('admin.policy.set', { assistReconnect: true, assistUnattended: true, assistFiles: true });

  // the technician alone in the Room, whose app goes away: nothing to wait for, the session ends
  const t1 = await priya.request('help.create', { summary: 'Mouse lag', category: 'hardware' });
  await ravi.request('help.take', { id: t1.id });
  const s1 = await ravi.request('help.session.start', { id: t1.id });
  const ended1 = nextEvent<SupportSession>(priya, 'help.session', (x) => x.ticketId === t1.id && !!x.endedAt);
  await ravi.request('room.leave', { roomId: s1.room.id });
  assert.ok((await ended1).endedAt, 'no pause before both had met');

  // a drop while the other person is not in the Room is refused
  const t2 = await priya.request('help.create', { summary: 'Fonts', category: 'software' });
  await ravi.request('help.take', { id: t2.id });
  await ravi.request('help.session.start', { id: t2.id });
  await assert.rejects(ravi.request('help.drop', { id: t2.id, files: [{ fileId: '01JABCDEFGHJKMNPQRSTVWXYZ0', path: 'a.txt' }] }), /not in the session right now/);

  // Priya joins from a device that cannot be controlled (it never said it can): Connect now refuses, never switches PCs
  await priya.request('help.session.join', { id: t2.id });
  await assert.rejects(ravi.request('help.connect', { id: t2.id }), /cannot be controlled from here/);

  // Ravi leaves the IT desk: his session ends at once, and he cannot come back to it
  const ended2 = nextEvent<SupportSession>(priya, 'help.session', (x) => x.ticketId === t2.id && !!x.endedAt);
  await owner.request('admin.help.staff', { userId: me(ravi), on: false });
  assert.ok((await ended2).endedAt);
  const { timeline } = await priya.request('help.get', { id: t2.id });
  assert.equal(timeline.filter((e) => e.kind === 'session.ended').at(-1)!.text, 'The technician is no longer on the IT desk.');
});

test('fourth review: one support session per person from Connect now; a refused connect closes the ticket it opened', async () => {
  const { owner, priya, ravi } = await office();
  await owner.request('admin.help.staff', { userId: me(ravi), on: true });
  await owner.request('admin.policy.set', { assistUnattended: true });
  await priya.request('help.device', { control: true });
  const first = await ravi.request('help.connect', { userId: me(priya) });
  // a second Connect now for the same person is refused while the first runs
  await assert.rejects(ravi.request('help.connect', { userId: me(priya) }), /already in a support session/);
  const queue = await ravi.request('help.queue', { status: 'all' });
  assert.equal(queue.filter((t) => t.requesterId === me(priya) && t.status !== 'closed').length, 1, 'no second ticket was opened');
  await ravi.request('help.session.end', { id: first.session.ticketId });
});

test('privacy screen: only with its policy, only IT turns it on, the person\'s app turns it off when it cannot show it, all audited', async () => {
  const { owner, priya, ravi } = await office();
  await owner.request('admin.help.staff', { userId: me(ravi), on: true });
  await owner.request('admin.policy.set', { assistUnattended: true });
  await priya.request('help.device', { control: true });
  await assert.rejects(ravi.request('help.connect', { userId: me(priya), privacy: true }), /privacy screen is off/);
  await owner.request('admin.policy.set', { assistPrivacy: true });
  const r = await ravi.request('help.connect', { userId: me(priya), privacy: true });
  assert.equal(r.session.privacy, true);
  const id = r.session.ticketId;
  await assert.rejects(priya.request('help.privacy', { id, on: true }), /Only IT/);
  await assert.rejects(priya.request('help.privacy', { id, on: false }), /Only IT/);
  const off = await priya.request('help.privacy', { id, on: false, unavailable: true });
  assert.equal(off.privacy, false);
  const on = await ravi.request('help.privacy', { id, on: true });
  assert.equal(on.privacy, true);
  // the administrator turns the policy off: the privacy screen goes at once
  const gone = nextEvent<SupportSession>(priya, 'help.session', (x) => !x.privacy);
  await owner.request('admin.policy.set', { assistPrivacy: false });
  await gone;
  const audit = (await owner.request('admin.audit', { limit: 30 })).filter((a) => a.action === 'help.privacy');
  assert.ok(audit.length >= 4);
  const { timeline } = await priya.request('help.get', { id });
  assert.ok(timeline.some((e) => /privacy screen on/.test(e.text ?? '')));
});
