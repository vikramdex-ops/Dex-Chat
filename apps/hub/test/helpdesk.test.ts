// The help desk: tickets and the IT queue, the `it` capability, who may join a support session,
// consent as the protocol carries it, and the audit trail of every grant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import type { HelpEntry, HelpTicket, SupportSession } from '@dex/core';
import { office, nextEvent, me, until } from './office.ts';
import type { HubClient } from '@dex/core/client';

async function upload(hub: { port: number }, c: HubClient, name: string, body: string): Promise<{ id: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: hub.port, method: 'POST', path: `/files?name=${encodeURIComponent(name)}&type=application/json`, rejectUnauthorized: false,
      headers: { authorization: `Bearer ${c.session!.fileToken}`, 'content-length': Buffer.byteLength(body) } }, (res) => {
      let raw = ''; res.on('data', (x) => { raw += x; }); res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function fetchStatus(hub: { port: number }, c: HubClient, fileId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', port: hub.port, path: `/files/${fileId}`, rejectUnauthorized: false, headers: { authorization: `Bearer ${c.session!.fileToken}` } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on('error', reject);
  });
}

test('the it capability: only administrators grant it, everyone can see who has it', async () => {
  const { owner, priya, ravi } = await office();
  assert.deepEqual(await priya.request('help.staff'), []);
  await assert.rejects(priya.request('admin.help.staff', { userId: me(ravi), on: true }), /administrators/);
  const told = nextEvent<string[]>(priya, 'help.staff');
  assert.deepEqual(await owner.request('admin.help.staff', { userId: me(ravi), on: true }), [me(ravi)]);
  assert.deepEqual(await told, [me(ravi)]);
  // the queue is for the IT desk
  await assert.rejects(priya.request('help.queue'), /IT desk/);
  assert.deepEqual(await ravi.request('help.queue'), []);
  await owner.request('admin.help.staff', { userId: me(ravi), on: false });
  await assert.rejects(ravi.request('help.queue'), /IT desk/);
  const audit = await owner.request('admin.audit', { limit: 20 });
  assert.ok(audit.some((a) => a.action === 'help.staff.granted' && a.target === me(ravi)));
  assert.ok(audit.some((a) => a.action === 'help.staff.removed' && a.target === me(ravi)));
});

test('a request goes to the IT queue; IT takes it, notes, closes; the requester rates and reopens', async () => {
  const { hub, owner, priya, ravi } = await office();
  await owner.request('admin.help.staff', { userId: me(ravi), on: true });
  await assert.rejects(priya.request('help.create', { summary: 'x', category: 'software' }), /few words/);
  await assert.rejects(priya.request('help.create', { summary: 'Plotter will not print', category: 'cooking' as never }), /Choose/);
  const shot = await upload(hub, priya, 'screen.png', 'not really a png');
  const queued = nextEvent<HelpTicket>(ravi, 'help.updated');
  const t = await priya.request('help.create', { summary: 'Plotter   will not\nprint A1 sheets', detail: 'The HP plotter on the 2nd floor shows a paper error.', category: 'printing', screenshot: shot.id, platform: 'win32' });
  assert.equal(t.summary, 'Plotter will not print A1 sheets', 'one line');
  assert.equal(t.status, 'open');
  assert.equal(t.number, 1);
  assert.equal(t.platform, 'win32');
  assert.deepEqual(t.files.map((f) => f.kind), ['screenshot']);
  assert.equal((await queued).id, t.id, 'IT hears about it at once');
  assert.deepEqual((await ravi.request('help.queue')).map((x) => x.id), [t.id]);
  assert.deepEqual((await priya.request('help.mine')).map((x) => x.id), [t.id]);
  // other people cannot see it, nor its screenshot
  await assert.rejects(owner.request('help.get', { id: t.id }), /not found/);
  assert.equal(await fetchStatus(hub, owner, shot.id), 404);
  assert.equal(await fetchStatus(hub, ravi, shot.id), 200, 'IT can open files on tickets');
  // nobody takes their own request; only IT takes
  await assert.rejects(priya.request('help.take', { id: t.id }), /IT desk/);
  const taken = await ravi.request('help.take', { id: t.id });
  assert.equal(taken.status, 'taken');
  assert.equal(taken.techId, me(ravi));
  await ravi.request('help.note', { id: t.id, text: 'Loaded A1 roll; testing.' });
  const two = await priya.request('help.create', { summary: 'Second screen flickers', category: 'hardware' });
  assert.equal(two.number, 2);
  assert.deepEqual((await ravi.request('help.queue')).map((x) => x.id), [two.id, t.id], 'open tickets first');
  // the requester closes it and rates it, then reopens: it goes back to the same technician
  await assert.rejects(owner.request('help.close', { id: t.id }), /not found/);
  const closed = await priya.request('help.close', { id: t.id, note: 'Printing again' });
  assert.equal(closed.status, 'closed');
  const rated = await priya.request('help.rate', { id: t.id, rating: 5, note: 'Quick, thanks' });
  assert.equal(rated.rating, 5);
  await assert.rejects(ravi.request('help.rate', { id: t.id, rating: 1 }), /person who asked/);
  await assert.rejects(priya.request('help.rate', { id: t.id, rating: 9 }), /one to five/);
  const again = await priya.request('help.reopen', { id: t.id, note: 'It jammed again' });
  assert.equal(again.status, 'taken');
  assert.equal(again.techId, me(ravi));
  const { timeline } = await priya.request('help.get', { id: t.id });
  assert.deepEqual(timeline.map((e) => e.kind), ['opened', 'taken', 'note', 'closed', 'rated', 'reopened']);
  // handing it back puts it in the queue again
  const back = await ravi.request('help.release', { id: t.id });
  assert.equal(back.status, 'open');
  assert.equal(back.techId, null);
});

test('a support session: only the assigned technician joins, consent is the requester\'s, every grant is audited', async () => {
  const { owner, priya, ravi, join } = await office();
  const asha = (await join('asha')).c;
  await owner.request('admin.decide', { deviceId: (await owner.request('admin.devices')).find((x) => x.status === 'pending')!.id, approve: true });
  await until(asha, (s) => s.kind === 'ready');
  await owner.request('admin.help.staff', { userId: me(ravi), on: true });
  await owner.request('admin.help.staff', { userId: me(asha), on: true });
  const t = await priya.request('help.create', { summary: 'Outlook keeps asking for my password', category: 'account' });
  await assert.rejects(ravi.request('help.session.start', { id: t.id }), /Take the ticket/);
  await ravi.request('help.take', { id: t.id });
  await assert.rejects(asha.request('help.session.start', { id: t.id }), /only its technician/);
  const invited = nextEvent<SupportSession>(priya, 'help.session');
  const started = await ravi.request('help.session.start', { id: t.id });
  assert.equal(started.room.purpose?.kind, 'support');
  assert.deepEqual(started.room.participants.map((p) => p.userId), [me(ravi)]);
  assert.equal((await invited).techId, me(ravi));
  // another IT colleague can see the ticket but not come into the session or its Room
  await assert.rejects(asha.request('help.session.join', { id: t.id }), /Only the person who asked/);
  await assert.rejects(asha.request('room.join', { roomId: started.room.id }), /ended/);
  assert.equal((await asha.request('room.list')).length, 0, 'the session Room is invisible to others');
  await assert.rejects(owner.request('help.session.join', { id: t.id }), /not found/);
  await assert.rejects(priya.request('room.join', { roomId: started.room.id }), /support session/);
  // the requester joins; their PC says it can take control
  const joined = await priya.request('help.session.join', { id: t.id, controlAvailable: true });
  assert.equal(joined.room.participants.length, 2);
  assert.equal(joined.session.controlAvailable, true);
  // the technician cannot grant consent, and cannot ask for control before a whole screen is shared
  await assert.rejects(ravi.request('help.consent', { id: t.id, kind: 'screen', on: true }), /person being helped/);
  await assert.rejects(ravi.request('help.ask', { id: t.id, kind: 'control' }), /whole screen/);
  const asked = nextEvent<{ ticketId: string; kind: string }>(priya, 'help.ask');
  await ravi.request('help.ask', { id: t.id, kind: 'screen' });
  assert.equal((await asked).kind, 'screen');
  // control needs a whole screen, not a window
  await priya.request('help.consent', { id: t.id, kind: 'screen', on: true, scope: 'window' });
  await assert.rejects(priya.request('help.consent', { id: t.id, kind: 'control', on: true }), /whole screen/);
  const techSees = nextEvent<SupportSession>(ravi, 'help.session', (s) => s.consent.scope === 'screen');
  await priya.request('help.consent', { id: t.id, kind: 'screen', on: true, scope: 'screen' });
  assert.equal((await techSees).consent.screen, true);
  const ctl = nextEvent<SupportSession>(ravi, 'help.session', (s) => s.consent.control);
  const s1 = await priya.request('help.consent', { id: t.id, kind: 'control', on: true });
  assert.equal(s1.consent.control, true);
  assert.ok(s1.consent.controlSince);
  await ctl;
  // stopping the screen share stops control too
  const s2 = await priya.request('help.consent', { id: t.id, kind: 'screen', on: false });
  assert.deepEqual([s2.consent.screen, s2.consent.control], [false, false]);
  // the requester leaves the Room: the session's Room keeps the technician; ending closes it for both
  const ended = nextEvent<{ roomId: string }>(priya, 'room.ended');
  await ravi.request('help.session.end', { id: t.id });
  assert.equal((await ended).roomId, started.room.id);
  const after = await priya.request('help.get', { id: t.id });
  assert.equal(after.ticket.session, null);
  const kinds = after.timeline.map((e: HelpEntry) => `${e.kind}${e.detail?.kind ? `:${e.detail.kind}` : ''}`);
  assert.deepEqual(kinds, ['opened', 'taken', 'session.started', 'session.joined', 'asked:screen', 'consent.granted:screen', 'consent.revoked:screen',
    'consent.granted:screen', 'consent.granted:control', 'consent.revoked:control', 'consent.revoked:screen', 'session.ended']);
  const revoked = after.timeline.find((e) => e.kind === 'consent.revoked' && e.detail?.kind === 'control')!;
  assert.equal(typeof revoked.detail!.durationMs, 'number');
  const audit = await owner.request('admin.audit', { limit: 50 });
  const grants = audit.filter((a) => a.action.startsWith('help.consent'));
  assert.equal(grants.length, 6);
  const ctlRevoked = grants.find((a) => a.action === 'help.consent.revoked' && (a.detail as { kind: string }).kind === 'control')!;
  assert.equal(ctlRevoked.actor, me(priya), 'who');
  const d = ctlRevoked.detail as { from: number; to: number; durationMs: number; technician: string };
  assert.ok(d.to >= d.from, 'when');
  assert.equal(d.durationMs, d.to - d.from, 'how long');
  assert.equal(d.technician, me(ravi), 'granted to whom');
  assert.ok(audit.some((a) => a.action === 'help.session.ended'));
});

test('a requester who leaves the session stops sharing at once', async () => {
  const { owner, priya, ravi } = await office();
  await owner.request('admin.help.staff', { userId: me(ravi), on: true });
  const t = await priya.request('help.create', { summary: 'Shared drive is empty', category: 'network' });
  await ravi.request('help.take', { id: t.id });
  await ravi.request('help.session.start', { id: t.id });
  const j = await priya.request('help.session.join', { id: t.id, controlAvailable: false });
  await priya.request('help.consent', { id: t.id, kind: 'screen', on: true, scope: 'screen' });
  await assert.rejects(priya.request('help.consent', { id: t.id, kind: 'control', on: true }), /cannot be controlled/);
  await assert.rejects(ravi.request('help.ask', { id: t.id, kind: 'control' }), /cannot be controlled/);
  const off = nextEvent<SupportSession>(ravi, 'help.session', (s) => !s.consent.screen);
  await priya.request('room.leave', { roomId: j.room.id });
  assert.equal((await off).consent.screen, false);
  // the requester can come back into the same session
  const back = await priya.request('help.session.join', { id: t.id });
  assert.equal(back.room.id, j.room.id);
  // closing the ticket ends the session
  await ravi.request('help.close', { id: t.id });
  const view = await priya.request('help.get', { id: t.id });
  assert.equal(view.ticket.status, 'closed');
  assert.equal(view.ticket.session, null);
});

test('diagnostics and files attach to the ticket for the requester and the technician', async () => {
  const { hub, owner, priya, ravi } = await office();
  await owner.request('admin.help.staff', { userId: me(ravi), on: true });
  const t = await priya.request('help.create', { summary: 'AutoCAD crashes on start', category: 'software' });
  await ravi.request('help.take', { id: t.id });
  const diag = await upload(hub, priya, 'diagnostics-T-0001.json', JSON.stringify({ app: { version: '0.1.0' } }));
  const withDiag = await priya.request('help.attach', { id: t.id, fileId: diag.id, kind: 'diagnostics' });
  assert.deepEqual(withDiag.files.map((f) => [f.kind, f.name]), [['diagnostics', 'diagnostics-T-0001.json']]);
  const fix = await upload(hub, ravi, 'acad-reset.reg', 'Windows Registry Editor Version 5.00');
  const withFix = await ravi.request('help.attach', { id: t.id, fileId: fix.id, kind: 'file' });
  assert.equal(withFix.files.length, 2);
  assert.equal(await fetchStatus(hub, priya, fix.id), 200, 'the requester opens the technician\'s file');
  assert.equal(await fetchStatus(hub, owner, fix.id), 404);
  // a file someone else uploaded and you cannot read cannot be attached
  const secret = await upload(hub, owner, 'salaries.json', '{}');
  await assert.rejects(priya.request('help.attach', { id: t.id, fileId: secret.id, kind: 'file' }), /not found/);
  const audit = await owner.request('admin.audit', { limit: 20 });
  assert.ok(audit.some((a) => a.action === 'help.diagnostics' && a.target === t.id));
});

test('a session cut short by a hub restart is closed on the timeline', async () => {
  const { hub, owner, priya, ravi } = await office();
  await owner.request('admin.help.staff', { userId: me(ravi), on: true });
  const t = await priya.request('help.create', { summary: 'VPN drops every hour', category: 'network' });
  await ravi.request('help.take', { id: t.id });
  await ravi.request('help.session.start', { id: t.id });
  const { HelpDesk } = await import('../src/helpdesk.ts');
  // a second desk on the same database, as after a restart
  new HelpDesk({ store: hub.store, messaging: hub.messaging, files: hub.files, rooms: hub.rooms, deliver: () => {}, broadcast: () => {} });
  const row = hub.store.db.prepare('SELECT ended_at FROM help_sessions WHERE ticket_id = ?').get(t.id) as { ended_at: number | null };
  assert.ok(row.ended_at, 'the session has an end');
  const { timeline } = await priya.request('help.get', { id: t.id });
  assert.equal(timeline.at(-1)!.kind, 'session.ended');
});
