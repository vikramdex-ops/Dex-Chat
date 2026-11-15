// Offboarding: one step signs someone out everywhere and hands what they looked after to a
// colleague; their messages stay for compliance; the Directory shows them as having left; it is
// all audited; and giving access back restores sign-in but not what was handed over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import type { Departure, FileInfo, Message } from '@dex/core';
import type { HubClient } from '@dex/core/client';
import type { Hub } from '../src/hub.ts';
import { office, me, nextEvent, send, until } from './office.ts';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function upload(hub: Hub, c: HubClient, name: string, data: Buffer): Promise<FileInfo> {
  return new Promise((resolve, reject) => {
    const r = https.request({ host: '127.0.0.1', port: hub.port, path: `/files?name=${encodeURIComponent(name)}`, method: 'POST', rejectUnauthorized: false,
      headers: { authorization: `Bearer ${c.session!.fileToken}`, 'content-length': String(data.length) } }, (res) => {
      let raw = '';
      res.on('data', (x) => { raw += x; });
      res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(raw) as FileInfo) : reject(new Error(raw))));
    });
    r.on('error', reject);
    r.end(data);
  });
}
const status = (hub: Hub, p: string, token?: string) => new Promise<number>((resolve, reject) => {
  const r = https.request({ host: '127.0.0.1', port: hub.port, path: p, rejectUnauthorized: false, headers: token ? { authorization: `Bearer ${token}` } : {} }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
  r.on('error', reject);
  r.end();
});
const tool = (id: string) => Buffer.from(`<!doctype html><html><head><script type="application/dex-manifest+json">${JSON.stringify({ id, name: 'Line list', version: '1.0.0', permissions: ['state'] })}</script></head><body><main>Lines</main></body></html>`);
const graph = (postIn: string) => ({ trigger: { id: 't1', kind: 'message.matched', mode: 'keywords', pattern: 'urgent' }, conditions: [], actions: [{ id: 'a1', kind: 'post', convId: postIn, text: 'Seen' }] });

/** Priya looks after a lot; Ravi takes over when she leaves. */
async function busyOffice() {
  const o = await office();
  const { hub, owner, priya, ravi } = o;
  await owner.request('admin.setRole', { userId: me(priya), role: 'admin' });
  const pump = await priya.request('conv.create', { kind: 'space', name: 'Pump skid P-12', private: true, members: [me(owner)] });
  const site = await owner.request('conv.create', { kind: 'space', name: 'Site office', members: [me(priya)] });
  await owner.request('conv.settings', { convId: site.id, moderators: [me(priya)] });
  const dm = await priya.request('conv.create', { kind: 'direct', members: [me(owner)] });
  const msgs = [await send(priya, pump.id, 'Nozzle loads are in'), await send(priya, site.id, 'Crane on Tuesday')];
  const flows = {
    space: await priya.request('flow.save', { convId: pump.id, name: 'Urgent in pump skid', graph: graph(pump.id) } as never),
    office: await priya.request('flow.save', { convId: null, name: 'Urgent anywhere', graph: graph(pump.id) } as never),
    direct: await priya.request('flow.save', { convId: dm.id, name: 'Personal', graph: graph(pump.id) } as never),
  };
  const bot = await priya.request('admin.bots.create', { name: 'Hopper' });
  const file = await upload(hub, priya, 'line-list.html', tool('line-list'));
  const app = await priya.request('admin.miniapps.upload', { fileId: file.id });
  await priya.request('sched.create', { convId: pump.id, body: 'Reminder: datasheets due', sendAt: Date.now() + DAY });
  await priya.request('remind.create', { text: 'Send the GA to the client', dueAt: Date.now() + DAY, forUserId: me(owner) });
  await owner.request('remind.create', { text: 'Check the stress report', dueAt: Date.now() + DAY, forUserId: me(priya) });
  const t0 = Date.now() + 2 * DAY;
  const review = await priya.request('cal.create', { title: 'Design review', startAt: t0, endAt: t0 + HOUR, attendees: [me(owner)], online: true });
  const weekly = await priya.request('cal.create', { title: 'Piping weekly', startAt: Date.now() - 14 * DAY, endAt: Date.now() - 14 * DAY + HOUR, recurrence: 'weekly', attendees: [me(owner), me(ravi)] });
  const past = await priya.request('cal.create', { title: 'Kick-off', startAt: Date.now() - 3 * DAY, endAt: Date.now() - 3 * DAY + HOUR, attendees: [me(owner)] });
  await priya.request('meet.event', { eventId: review.id });
  await owner.request('admin.help.staff', { userId: me(priya), on: true });
  await owner.request('admin.help.staff', { userId: me(ravi), on: true });
  const asked = await owner.request('help.create', { summary: 'Plotter will not print', category: 'hardware' } as never);
  await priya.request('help.take', { id: asked.id });
  const own = await priya.request('help.create', { summary: 'New mouse please', category: 'hardware' } as never);
  const webinar = await priya.request('web.create', { title: 'Skid sizing talk', startsAt: Date.now() + 3 * DAY, durationMin: 60, panelists: [me(owner)] } as never) as { meetingId: string };
  await priya.request('pair.create', { kind: 'phone' });
  const feed = await priya.request('cal.feed.set', { enabled: true });
  await owner.request('admin.compliance.hold', { kind: 'user', targetId: me(priya), note: 'Contract dispute' });
  return { ...o, pump, site, dm, msgs, flows, bot, app, review, weekly, past, asked, own, webinar, feed };
}

test('offboarding signs someone out everywhere and hands their Spaces, automations, tools, reminders, meetings, tickets and webinars to a colleague', async () => {
  const o = await busyOffice();
  const { hub, owner, priya, ravi } = o;
  const db = hub.store.db;
  const leaverId = me(priya);
  const fileToken = priya.session!.fileToken;

  // checks first: only administrators, never the owner or yourself, and a colleague who can take over
  await assert.rejects(ravi.request('admin.offboard.preview', { userId: leaverId }), /administrators/);
  await assert.rejects(priya.request('admin.offboard.run', { userId: me(owner), toUserId: me(ravi), meetings: 'reassign' }), /owner cannot be offboarded/);
  await assert.rejects(owner.request('admin.offboard.run', { userId: me(owner), toUserId: me(ravi), meetings: 'reassign' }), /yourself/);
  await assert.rejects(owner.request('admin.offboard.run', { userId: leaverId, toUserId: leaverId, meetings: 'reassign' }), /colleague who takes over/);

  const p = await owner.request('admin.offboard.preview', { userId: leaverId });
  assert.equal(p.devices.length, 1);
  assert.equal(p.pairingCodes, 1);
  // the threads of the Calendar meetings she organised are hers too (each meeting has one)
  assert.deepEqual(p.spacesOwned.map((s) => s.name), ['Design review · meeting', 'Kick-off · meeting', 'Piping weekly · meeting', 'Pump skid P-12', 'Skid sizing talk · backstage'], "the webinar's backstage is hers too");
  assert.deepEqual(p.spacesModerated.map((s) => s.name), ['Site office']);
  assert.deepEqual(p.automations.map((f) => f.where).sort(), ['direct', 'office', 'space']);
  assert.deepEqual(p.bots.map((b) => b.name), ['Hopper']);
  assert.deepEqual(p.tools.map((t) => t.id), ['line-list']);
  assert.equal(p.scheduled, 1);
  assert.equal(p.remindersForOthers, 1);
  assert.equal(p.remindersFromOthers, 1);
  assert.deepEqual(p.meetings.map((m) => m.title).sort(), ['Design review', 'Piping weekly'], 'meetings from now on, not ones that are over');
  assert.deepEqual(p.tickets.map((t) => t.role).sort(), ['requester', 'technician']);
  assert.deepEqual(p.webinars.map((w) => w.role), ['organiser']);
  assert.ok(p.messages >= 2);
  assert.equal(p.onHold, true);

  await priya.request('notify.token'); // her phone's background service could still wait for messages
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM notify_tokens WHERE user_id = ?').get(leaverId) as { n: number }).n, 1);
  const rejected = until(priya, (s) => s.kind === 'rejected');
  const told = nextEvent<Message>(owner, 'msg.new', (m) => /Design review/.test(m.body) && /now organised by/.test(m.body));
  const leftEvent = nextEvent<{ userId: string; contactId: string }>(ravi, 'user.left');
  const handed = nextEvent<Message>(ravi, 'msg.new', (m) => /asked you to take over/.test(m.body));
  const dep: Departure = await owner.request('admin.offboard.run', { userId: leaverId, toUserId: me(ravi), meetings: 'reassign', note: 'Moved to the Pune office' });
  assert.equal(dep.user.leftAt, dep.leftAt);
  assert.equal(dep.toId, me(ravi));
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM notify_tokens WHERE user_id = ?').get(leaverId) as { n: number }).n, 0, 'background-notification tokens are forgotten');

  // signed out everywhere, and nothing lets them back in
  await rejected;
  assert.match((priya.state as { reason: string }).reason, /left the office/);
  assert.deepEqual(db.prepare(`SELECT status FROM devices WHERE user_id = ?`).all(leaverId).map((r) => (r as { status: string }).status), ['revoked']);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM pair_tokens WHERE user_id = ? AND used_at IS NULL').get(leaverId) as { n: number }).n, 0);
  assert.equal(await status(hub, o.feed.urls!.path), 404, 'the calendar feed stops');
  assert.equal(await status(hub, `/files/${o.msgs[0].id}`, fileToken), 401, 'the file link of their session stops');

  // Spaces
  assert.equal((db.prepare('SELECT created_by FROM conversations WHERE id = ?').get(o.pump.id) as { created_by: string }).created_by, me(ravi));
  const site = (await ravi.request('conv.list')).find((c) => c.id === o.site.id)!;
  assert.ok(site.moderators.includes(me(ravi)) && !site.moderators.includes(leaverId));
  assert.ok((await ravi.request('conv.list')).some((c) => c.id === o.pump.id), 'the colleague is in the private Space they now own');
  // automations: the Space's to the colleague, the office-wide one to an administrator, the personal one off
  const flow = (id: string) => db.prepare('SELECT owner_id, enabled FROM flows WHERE id = ?').get(id) as { owner_id: string; enabled: number };
  assert.equal(flow(o.flows.space.id).owner_id, me(ravi));
  assert.equal(flow(o.flows.office.id).owner_id, me(owner), 'office-wide rules act for an administrator');
  assert.equal(flow(o.flows.direct.id).enabled, 0);
  // integrations and tools
  assert.deepEqual(db.prepare('SELECT DISTINCT created_by FROM bot_tokens WHERE user_id = ?').all(o.bot.bot.id).map((r) => (r as { created_by: string }).created_by), [me(ravi)]);
  assert.equal((db.prepare('SELECT uploaded_by FROM miniapps WHERE id = ?').get('line-list') as { uploaded_by: string }).uploaded_by, me(ravi));
  // scheduled messages cancelled; reminders moved
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM scheduled WHERE user_id = ?').get(leaverId) as { n: number }).n, 0);
  const reminders = (await ravi.request('remind.list', {})).map((r) => r.text).sort();
  assert.deepEqual(reminders, ['Check the stress report', 'Send the GA to the client']);
  // meetings: the colleague organises them, everyone invited is told; the one that is over stays as it was
  const review = await ravi.request('cal.get', { eventId: o.review.id });
  assert.equal(review.organizerId, me(ravi));
  assert.ok(!review.attendees.some((a) => a.userId === leaverId));
  assert.equal((db.prepare('SELECT host_id FROM meetings WHERE event_id = ?').get(o.review.id) as { host_id: string }).host_id, me(ravi));
  assert.match((await told).body, /Priya has left the office/);
  assert.equal((await ravi.request('cal.get', { eventId: o.weekly.id })).organizerId, me(ravi));
  assert.equal((db.prepare('SELECT organizer_id FROM events WHERE id = ?').get(o.past.id) as { organizer_id: string }).organizer_id, leaverId);
  assert.ok(((db.prepare('SELECT seq FROM events WHERE id = ?').get(o.review.id)) as { seq: number }).seq > 0, 'calendar feeds pick up the change');
  // help tickets: the one being worked on goes to the colleague on the IT desk; their own request is closed
  const asked = await ravi.request('help.get', { id: o.asked.id });
  assert.equal(asked.ticket.techId, me(ravi));
  assert.equal(asked.ticket.status, 'taken');
  assert.equal((await ravi.request('help.get', { id: o.own.id })).ticket.status, 'closed');
  assert.ok(!(await ravi.request('help.staff')).includes(leaverId));
  // webinars they organise
  assert.equal((db.prepare('SELECT host_id FROM meetings WHERE id = ?').get(o.webinar.meetingId) as { host_id: string }).host_id, me(ravi));

  // their messages stay for compliance: the hold still applies and an export still finds them
  assert.ok((await owner.request('msg.list', { convId: o.site.id })).messages.some((m) => m.id === o.msgs[1].id));
  assert.ok((await owner.request('admin.compliance.get')).holds.some((h) => h.targetId === leaverId));
  const exp = await owner.request('admin.compliance.export', { userIds: [leaverId], from: 0, to: Date.now() + 1000, format: 'json' });
  assert.ok(exp.messages >= 2);
  hub.compliance.purge();
  assert.ok((db.prepare('SELECT COUNT(*) AS n FROM messages WHERE author_id = ? AND deleted = 0').get(leaverId) as { n: number }).n >= 2);

  // the Directory: no longer among colleagues, listed under "Left the office" with who to ask
  assert.equal((await leftEvent).contactId, me(ravi));
  assert.ok(!(await ravi.request('directory.list')).users.some((u) => u.id === leaverId));
  assert.ok(!ravi.session!.users.some((u) => u.id === leaverId), 'colleagues signed in now drop them too');
  const left = await ravi.request('directory.left');
  assert.equal(left.length, 1);
  assert.equal(left[0].user.id, leaverId);
  assert.equal(left[0].contactId, me(ravi));
  assert.ok(left[0].user.leftAt);
  // the colleague hears what they now look after
  const note = (await handed).body;
  assert.match(note, /Space/);
  assert.match(note, /meeting/);
  assert.match(note, /Moved to the Pune office/);

  // all of it audited
  const actions = new Set(hub.store.auditTrail(200).map((a) => a.action));
  for (const a of ['person.offboarded', 'device.revoked', 'handover.spaces', 'handover.automations', 'handover.integrations', 'handover.scheduled', 'handover.reminders', 'handover.meetings', 'handover.tickets', 'handover.webinars']) assert.ok(actions.has(a), a);
  const list = await owner.request('admin.offboard.list');
  assert.equal(list[0].summary.spaces, 5, "her Spaces and her meetings' threads");
  assert.equal(list[0].summary.moderated, 1);
  assert.equal(list[0].summary.meetingsReassigned, 2);
  assert.equal(list[0].summary.automationsTurnedOff, 1);
  assert.equal(list[0].summary.calendarFeed, true);
  await assert.rejects(owner.request('admin.offboard.run', { userId: leaverId, toUserId: me(ravi), meetings: 'reassign' }), /already left/);
  await assert.rejects(owner.request('admin.offboard.run', { userId: me(ravi), toUserId: leaverId, meetings: 'reassign' }), /cannot use Dexterity Connect now/);

  // a new PC of theirs waits, and cannot be approved until they are given access again
  const fresh = await o.join('priya');
  await assert.rejects(owner.request('admin.decide', { deviceId: fresh.identity.deviceId, approve: true }), /has left the office/);
  fresh.c.disconnect();

  // coming back: access again, but what was handed over stays with the colleague
  const back = await owner.request('admin.offboard.reactivate', { userId: leaverId });
  assert.equal(back.devices, 1);
  assert.equal(back.user.leftAt, undefined);
  // the same PC signs in again with its own key
  priya.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
  await until(priya, (s) => s.kind === 'ready');
  const welcome = (await priya.request('conv.list')).find((c) => c.kind === 'direct' && c.lastMessage && /Welcome back/.test(c.lastMessage.body ?? ''));
  assert.ok(welcome, 'the system bot says what stayed with the colleague');
  assert.equal((db.prepare('SELECT created_by FROM conversations WHERE id = ?').get(o.pump.id) as { created_by: string }).created_by, me(ravi));
  assert.equal(flow(o.flows.space.id).owner_id, me(ravi));
  assert.equal((await owner.request('cal.get', { eventId: o.review.id })).organizerId, me(ravi));
  assert.equal(await status(hub, o.feed.urls!.path), 404, 'the old calendar feed address does not come back');
  assert.deepEqual(await ravi.request('directory.left'), []);
  assert.ok((await ravi.request('directory.list')).users.some((u) => u.id === leaverId));
  assert.ok(hub.store.auditTrail(20).some((a) => a.action === 'person.reactivated'));
  await assert.rejects(owner.request('admin.offboard.reactivate', { userId: leaverId }), /has not left/);
});

test('offboarding with meetings cancelled: everyone invited is told, a series that began keeps its past; a colleague not on the IT desk returns tickets to the queue', async () => {
  const { hub, owner, priya, ravi } = await office();
  const t0 = Date.now() + DAY;
  const one = await priya.request('cal.create', { title: 'Vendor visit', startAt: t0, endAt: t0 + HOUR, attendees: [me(owner)] });
  const series = await priya.request('cal.create', { title: 'Daily stand-up', startAt: Date.now() - 5 * DAY, endAt: Date.now() - 5 * DAY + HOUR / 4, recurrence: 'daily', attendees: [me(ravi)] });
  await owner.request('admin.help.staff', { userId: me(priya), on: true });
  const t = await owner.request('help.create', { summary: 'Laptop will not start', category: 'hardware' } as never);
  await priya.request('help.take', { id: t.id });
  const toldOwner = nextEvent<Message>(owner, 'msg.new', (m) => /Vendor visit/.test(m.body) && /cancelled/.test(m.body));
  const toldRavi = nextEvent<Message>(ravi, 'msg.new', (m) => /Daily stand-up/.test(m.body) && /cancelled/.test(m.body));
  await owner.request('admin.offboard.run', { userId: me(priya), toUserId: me(ravi), meetings: 'cancel' });
  assert.equal((await owner.request('cal.get', { eventId: one.id })).cancelled, true);
  const s = await ravi.request('cal.get', { eventId: series.id });
  assert.equal(s.cancelled, false, 'past stand-ups stay in the calendar');
  assert.ok(s.until! <= Date.now() && s.until! > Date.now() - HOUR, 'and no more are held');
  assert.match((await toldOwner).body, /Ask \*\*Ravi\*\*/);
  await toldRavi;
  const ticket = await owner.request('help.get', { id: t.id });
  assert.equal(ticket.ticket.status, 'open');
  assert.equal(ticket.ticket.techId, null);
  assert.ok(hub.store.auditTrail(50).some((a) => a.action === 'handover.meetings' && (a.detail as { mode: string }).mode === 'cancel'));
});

test('who may offboard whom: administrators, not the owner, another administrator only by the owner; a guest cannot take over', async () => {
  const { owner, priya, ravi, join } = await office();
  const raviId = me(ravi);
  const { c: anita, identity } = await join('anita');
  await owner.request('admin.decide', { deviceId: identity.deviceId, approve: true });
  await until(anita, (s) => s.kind === 'ready');
  await assert.rejects(priya.request('admin.offboard.run', { userId: me(ravi), toUserId: me(anita), meetings: 'reassign' }), /administrators/);
  await owner.request('admin.setRole', { userId: me(priya), role: 'admin' });
  await owner.request('admin.setRole', { userId: me(ravi), role: 'admin' });
  await assert.rejects(priya.request('admin.offboard.preview', { userId: me(ravi) }), /Only the owner can offboard an administrator/);
  await owner.request('admin.setRole', { userId: me(anita), role: 'guest' });
  await assert.rejects(owner.request('admin.offboard.run', { userId: me(ravi), toUserId: me(anita), meetings: 'reassign' }), /guest cannot take over/);
  const dep = await owner.request('admin.offboard.run', { userId: me(ravi), toUserId: me(priya), meetings: 'reassign' });
  assert.equal(dep.summary.devicesSignedOut, 1);
  // a guest sees no one under "Left the office"; an administrator gives access back only to people who left
  assert.deepEqual(await anita.request('directory.left'), []);
  await assert.rejects(priya.request('admin.offboard.reactivate', { userId: raviId }), /Only the owner/);
});
