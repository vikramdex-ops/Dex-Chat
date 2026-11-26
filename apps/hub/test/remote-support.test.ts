// Remote support policies (docs/HELP-DESK.md, "Remote support"): unattended access for IT staff,
// sessions that wait for a dropped connection, and the audit trail of both. Each is off unless an
// administrator turns it on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import type { SupportSession } from '@dex/core';
import type { HubClient } from '@dex/core/client';
import { office, nextEvent, me } from './office.ts';

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
  assert.equal(back.session.pausedAt, null);
  await ravi.request('help.session.join', { id: b.t.id });
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
  await assert.rejects(ravi.request('help.drop', { id: t.id, fileIds: ids.slice(0, 1) }), /inside the session/);
  await ravi.request('help.session.start', { id: t.id });
  await priya.request('help.session.join', { id: t.id });
  await assert.rejects(ravi.request('help.drop', { id: t.id, fileIds: ids.slice(0, 1) }), /off for this office/);
  await owner.request('admin.policy.set', { assistFiles: true });
  // more than a ticket's 40 files: drops do not count toward that limit
  const r = await ravi.request('help.drop', { id: t.id, fileIds: ids, folder: 'Templates' });
  assert.equal(r.count, 45);
  assert.equal(await status(hub, priya, ids[44]), 200);
  const { ticket, timeline } = await priya.request('help.get', { id: t.id });
  assert.equal(ticket.files.length, 0, 'dropped files are not listed as ticket attachments');
  const line = timeline.filter((e) => e.kind === 'file').at(-1)!;
  assert.equal(line.text, '45 files from the folder Templates');
  // someone else's file cannot be dropped
  const other = await upload(hub, owner, 'secret.txt', 'x');
  await assert.rejects(ravi.request('help.drop', { id: t.id, fileIds: [other.id] }), /not found/);
  const audit = await owner.request('admin.audit', { limit: 10 });
  assert.ok(audit.some((a) => a.action === 'help.files.dropped' && (a.detail as { count: number }).count === 45));
});
