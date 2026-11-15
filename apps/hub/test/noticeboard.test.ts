// The notice board (docs/ANNOUNCEMENTS.md): desks and who may issue, audiences resolved from the
// organisation, drafts, scheduled issue, numbering, acknowledgement with check questions,
// revisions and re-acknowledgement, grouped reminders and the desk's digest, PDF text in search,
// urgent banners, expiry, withdrawal, the email copy, moving pinned Office messages, the register
// export and retention. The board's clock is moved with hub.notices.setClock and tick.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Conversation, NoticeDraftInput, NoticeView } from '@dex/core';
import { EVERYONE } from '@dex/core';
import { office, me, send } from './office.ts';
import { buildPdf } from './pdfs.ts';

const DAY = 86400_000;
const base = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
/** Day n after today (0 = today) at a time, in the hub's local time. */
const at = (day: number, h: number, m = 0) => base + day * DAY + (h * 60 + m) * 60_000;

async function setup() {
  const o = await office();
  const { hub, owner, priya, ravi, join } = o;
  const approve = async (name: string) => {
    const { c, identity } = await join(name);
    await owner.request('admin.decide', { deviceId: identity.deviceId, approve: true });
    for (let i = 0; i < 50 && c.state.kind !== 'ready'; i++) await new Promise((r) => setTimeout(r, 40));
    return c;
  };
  const meera = await approve('meera');
  const piping = await owner.request('admin.org.saveDepartment', { name: 'Piping' });
  const stress = await owner.request('admin.org.saveDepartment', { name: 'Stress', parentId: piping.id });
  const structural = await owner.request('admin.org.saveDepartment', { name: 'Structural' });
  await owner.request('admin.org.setProfile', { userId: me(priya), departmentId: piping.id });
  await owner.request('admin.org.setProfile', { userId: me(ravi), departmentId: stress.id });
  await owner.request('admin.org.setProfile', { userId: me(meera), departmentId: structural.id, location: 'Site — Dahej' });
  const desks = (await owner.request('admin.notices.get')).desks;
  const hr = desks.find((d) => d.code === 'HR')!;
  const it = desks.find((d) => d.code === 'IT')!;
  await owner.request('admin.notices.setDesk', { id: hr.id, code: 'HR', name: 'HR', issuers: [me(priya)] });
  const clock = (t: number) => { hub.notices.setClock(t); hub.notices.tick(t); return t; };
  const draft = (patch: Partial<NoticeDraftInput> = {}): NoticeDraftInput => ({
    deskId: hr.id, category: 'policy', title: 'Leave policy', body: 'Everyone gets 18 days of earned leave.\n\nCarry forward is up to 30 days.',
    audience: { ...EVERYONE, everyone: false, departments: [piping.id] }, ackRequired: true, ...patch,
  });
  const nibLines = async (c: typeof priya) => {
    const m = await c.request('nib.me');
    return m.convId ? (await c.request('msg.list', { convId: m.convId })).messages.filter((x) => !x.nib && !x.system).map((x) => x.body) : [];
  };
  return { ...o, meera, piping, stress, structural, hr, it, clock, draft, nibLines };
}

test('desks decide who issues; drafts stay with the desk; the audience follows the organisation', async () => {
  const { owner, priya, ravi, meera, hr, draft, structural } = await setup();
  await assert.rejects(ravi.request('notices.save', draft()), /issuers/);
  await assert.rejects(priya.request('notices.save', draft({ urgent: true })), /administrators/);
  await assert.rejects(priya.request('notices.save', draft({ audience: { everyone: false, departments: [], roles: [], locations: [], people: [] } })), /who the notice is for/);
  await assert.rejects(priya.request('admin.notices.setDesk', { code: 'XX', name: 'X', issuers: [] }), /administrators/);

  const v = await priya.request('notices.save', draft());
  assert.equal(v.status, 'draft');
  assert.equal(v.number, null, 'numbered only when issued');
  assert.equal(v.nextNumber, 'HR-POL-0001');
  assert.equal(v.standing, true, 'policies stand on the shelf by default');
  assert.equal((await ravi.request('notices.list')).notices.length, 0, 'a draft is not on the readers’ board');
  await assert.rejects(ravi.request('notices.get', { id: v.id }), /not found/);

  const issued = await priya.request('notices.issue', { id: v.id });
  assert.equal(issued.number, 'HR-POL-0001');
  assert.equal(issued.rev, 'A');
  // Ravi is in Stress, under Piping: in the audience. Meera (Structural) is not.
  assert.equal((await ravi.request('notices.list')).notices[0].needsAck, true);
  assert.equal((await meera.request('notices.list')).notices.length, 0);
  // the audience is read again each time: Meera moves to Piping and sees it at once
  await owner.request('admin.org.setProfile', { userId: me(meera), departmentId: (await owner.request('org.get')).departments.find((d) => d.name === 'Piping')!.id });
  assert.equal((await meera.request('notices.list')).notices.length, 1);
  await owner.request('admin.org.setProfile', { userId: me(meera), departmentId: structural.id });

  // by location, by role and by name
  const loc = await priya.request('notices.save', draft({ title: 'Site safety walk', category: 'safety', ackRequired: false, audience: { everyone: false, departments: [], roles: [], locations: ['site — dahej'], people: [] } }));
  await priya.request('notices.issue', { id: loc.id });
  assert.deepEqual((await meera.request('notices.list')).notices.map((n) => n.title), ['Site safety walk']);
  const admins = await priya.request('notices.save', draft({ title: 'For administrators', category: 'notice', ackRequired: false, audience: { everyone: false, departments: [], roles: ['admin'], locations: [], people: [] } }));
  await priya.request('notices.issue', { id: admins.id });
  assert.ok((await owner.request('notices.list')).notices.some((n) => n.title === 'For administrators'), 'the owner counts as an admin');
  assert.ok(!(await ravi.request('notices.list')).notices.some((n) => n.title === 'For administrators'));
  // the desk's issuer sees all of its notices, numbered in their own series
  const mine = (await priya.request('notices.list')).notices;
  assert.deepEqual(mine.map((n) => n.number).sort(), ['HR-NTC-0001', 'HR-POL-0001', 'HR-SAF-0001']);
  assert.deepEqual((await priya.request('notices.list')).canIssue, [hr.id]);
  // a desk with notices keeps its code and cannot be removed
  await assert.rejects(owner.request('admin.notices.setDesk', { id: hr.id, code: 'HRD', name: 'HR', issuers: [me(priya)] }), /code stays/);
  await assert.rejects(owner.request('admin.notices.removeDesk', { id: hr.id }), /stays/);
  const audit = await owner.request('admin.audit', { limit: 100 });
  assert.ok(audit.some((a) => a.action === 'notice.issued') && audit.some((a) => a.action === 'notice.desk'), 'audited');
});

test('a scheduled notice issues on time; readers are reminded once a day, grouped; the desk gets one digest', async () => {
  const { priya, ravi, clock, draft, nibLines } = await setup();
  clock(at(0, 9));
  const a = await priya.request('notices.save', draft());
  const s = await priya.request('notices.issue', { id: a.id, at: at(0, 11) });
  assert.equal(s.status, 'scheduled');
  assert.equal(s.issueAt, at(0, 11));
  clock(at(0, 10, 59));
  assert.equal((await priya.request('notices.get', { id: a.id })).status, 'scheduled');
  clock(at(0, 11));
  const issued = await priya.request('notices.get', { id: a.id });
  assert.equal(issued.status, 'issued');
  assert.equal(issued.issuedAt, at(0, 11));
  const b = await priya.request('notices.save', draft({ title: 'Travel claims', category: 'circular' }));
  await priya.request('notices.issue', { id: b.id });

  // not chased on the day it comes out
  clock(at(0, 12));
  clock(at(0, 17));
  assert.equal((await nibLines(ravi)).length, 0);
  // the next morning: one line with both
  clock(at(1, 10, 5));
  clock(at(1, 10, 30));
  let lines = (await nibLines(ravi)).filter((l) => /waiting for you/.test(l));
  assert.equal(lines.length, 1, 'one reminder a day');
  assert.match(lines[0], /2 notices are waiting for you to read and acknowledge: .*HR-POL-0001 Rev A, Leave policy.*HR-CIR-0001 Rev A, Travel claims/);
  // the desk's digest, once
  clock(at(1, 16, 10));
  clock(at(1, 16, 40));
  const digest = (await nibLines(priya)).filter((l) => /outstanding/.test(l));
  assert.equal(digest.length, 1);
  assert.match(digest[0], /HR-POL-0001 Rev A Leave policy: 0 of 2 \(waiting: (Piping 1, Stress 1|Stress 1, Piping 1)\)/);
  // a reminder from the desk the same day reaches no one twice
  assert.equal((await priya.request('notices.remind', { id: a.id })).sent, 0);
  await assert.rejects(priya.request('notices.remind', { id: a.id }), /already went today/);
  await assert.rejects(ravi.request('notices.remind', { id: a.id }), /issuers/);
  // the next day before the morning round, the desk's reminder goes
  clock(at(2, 9));
  assert.equal((await priya.request('notices.remind', { id: a.id })).sent, 2);
  lines = (await nibLines(ravi)).filter((l) => /waiting for you/.test(l));
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^A notice is waiting for you/);
  // at most three reminders about one revision
  clock(at(3, 10, 5));
  clock(at(4, 10, 5));
  clock(at(5, 10, 5));
  const chased = (await nibLines(ravi)).filter((l) => /HR-POL-0001/.test(l)).length;
  assert.equal(chased, 3);
  const chart = await priya.request('notices.acks', { id: a.id });
  assert.equal(chart.total, 2);
  assert.ok(chart.lastReminderAt);
});

test('acknowledgement with check questions; Rev B carries it; Rev C asks again', async () => {
  const { priya, ravi, draft, owner } = await setup();
  const v = await priya.request('notices.save', draft({ checks: [{ prompt: 'How many days of earned leave?', options: ['12', '18'], answer: 1 }] }));
  await priya.request('notices.issue', { id: v.id });
  const rv = await ravi.request('notices.get', { id: v.id });
  assert.deepEqual(rv.current.checks, [{ id: 'q1', prompt: 'How many days of earned leave?', options: ['12', '18'] }], 'the right answer stays on the hub');
  assert.equal(rv.draft, null);
  await assert.rejects(ravi.request('notices.ack', { id: v.id, answers: [0] }), /does not match/);
  await assert.rejects(ravi.request('notices.ack', { id: v.id }), /does not match/);
  const acked = await ravi.request('notices.ack', { id: v.id, answers: [1] });
  assert.equal(acked.acked, true);
  assert.equal(acked.ackedRev, 'A');
  await assert.rejects(owner.request('notices.ack', { id: v.id, answers: [1] }), /not addressed to you/);
  let chart = await priya.request('notices.acks', { id: v.id });
  assert.equal(chart.done, 1);
  assert.deepEqual(chart.departments.map((d) => [d.name, d.people.map((p) => p.acked)]), [['Piping', [false]], ['Stress', [true]]]);
  await assert.rejects(ravi.request('notices.acks', { id: v.id }), /issuers/);

  // Rev B: a change note, no new acknowledgement
  const b = await priya.request('notices.save', { ...draft({ checks: [{ prompt: 'How many days of earned leave?', options: ['12', '18'], answer: 1 }] }), id: v.id, body: 'Everyone gets 18 days of earned leave.\n\nCarry forward is up to 45 days.\n\nLeave is applied for in the HR portal.', changeNote: 'Carry forward raised to 45 days.' });
  assert.equal(b.draft?.rev, 'B');
  assert.equal(b.draft?.checkDefs[0].answer, 1, 'the desk sees its own answers');
  assert.equal((await ravi.request('notices.get', { id: v.id })).current.rev, 'A', 'readers see Rev A until B issues');
  const issuedB = await priya.request('notices.issue', { id: v.id });
  assert.equal(issuedB.rev, 'B');
  assert.deepEqual(issuedB.current.changed, [1, 2], 'the changed and the new paragraph get a revision cloud');
  assert.equal(issuedB.current.removed, 0);
  assert.deepEqual(issuedB.revisions.map((r) => [r.rev, r.status]), [['B', 'issued'], ['A', 'superseded']]);
  const rb = await ravi.request('notices.get', { id: v.id });
  assert.equal(rb.acked, true, 'Rev B does not ask again');
  assert.equal(rb.needsAck, false);
  assert.equal(rb.seen, false, 'but it is new to him');
  await ravi.request('notices.seen', { id: v.id });
  assert.equal((await ravi.request('notices.get', { id: v.id })).seen, true);

  // Rev C asks everyone again
  await priya.request('notices.save', { ...draft(), id: v.id, body: 'Everyone gets 20 days of earned leave.', changeNote: 'Earned leave is 20 days.', reack: true });
  const c = await priya.request('notices.issue', { id: v.id });
  assert.equal(c.rev, 'C');
  const rc = await ravi.request('notices.get', { id: v.id });
  assert.equal(rc.needsAck, true);
  assert.equal(rc.acked, false);
  assert.equal(rc.current.removed, 2, 'three paragraphs became one');
  await ravi.request('notices.ack', { id: v.id });
  chart = await priya.request('notices.acks', { id: v.id });
  assert.equal(chart.rev, 'C');
  assert.equal(chart.done, 1);

  // questions to the desk, privately; one answer published to everyone
  await ravi.request('notices.ask', { id: v.id, text: 'Does it apply to site staff?' });
  const inbox = (await priya.request('notices.get', { id: v.id })).inbox!;
  assert.equal(inbox.length, 1);
  assert.equal((await owner.request('notices.list')).notices[0].needsAck, false, 'administrators see every notice, but this one is not addressed to the owner');
  await priya.request('notices.answer', { id: v.id, askId: inbox[0].id, answer: 'Yes, from the same date.', publish: true });
  const after = await ravi.request('notices.get', { id: v.id });
  assert.deepEqual(after.faq.map((f) => [f.question, f.answer]), [['Does it apply to site staff?', 'Yes, from the same date.']]);
  assert.equal(after.asked[0].answer, 'Yes, from the same date.');
  assert.equal(after.inbox, null, 'readers do not see the desk’s inbox');
});

test('the text of an attached PDF is searchable; the PDF opens for the audience only and is kept', async () => {
  const { hub, priya, ravi, meera, draft } = await setup();
  const pdf = buildPdf({ pages: [{ content: 'BT /F1 12 Tf 72 720 Td (Leave encashment applies after 240 days of service.) Tj ET' }] });
  const file = hub.files.storeBuffer(me(priya), 'HR leave policy.pdf', 'application/pdf', pdf);
  const v = await priya.request('notices.save', draft({ fileId: file.id, body: 'The policy is attached.' }));
  await priya.request('notices.issue', { id: v.id });
  const hits = (await ravi.request('notices.search', { q: 'encashment' })).hits;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].where, 'pdf');
  assert.match(hits[0].snippet, /\[\[encashment\]\]/i);
  assert.equal((await ravi.request('notices.search', { q: 'HR-POL-0001' })).hits.length, 1, 'by number');
  const all = await ravi.request('search', { q: 'encashment' });
  assert.equal(all.notices?.[0].notice.id, v.id, 'the app’s search reads the board too');
  assert.equal((await meera.request('notices.search', { q: 'encashment' })).hits.length, 0);
  assert.equal(hub.files.canRead(me(ravi), file.id), true);
  assert.equal(hub.files.canRead(me(meera), file.id), false);
  hub.files.gc(Date.now() + DAY);
  assert.ok(hub.files.info(file.id), 'kept while its notice is');
  // a PDF in a revision still being written is the desk's alone
  const next = hub.files.storeBuffer(me(priya), 'HR leave policy rev B.pdf', 'application/pdf', pdf);
  await priya.request('notices.save', { ...draft({ fileId: next.id, body: 'Rev B is attached.' }), id: v.id });
  assert.equal(hub.files.canRead(me(ravi), next.id), false);
  await priya.request('notices.issue', { id: v.id });
  assert.equal(hub.files.canRead(me(ravi), next.id), true);
});

test('urgent notices: admins only, a banner each person dismisses once, a few a day; expiry archives; withdrawal stamps', async () => {
  const { owner, priya, ravi, it, hr, draft, clock } = await setup();
  clock(at(0, 9));
  const urgent = await owner.request('notices.save', { deskId: it.id, category: 'it', title: 'Mail server down until 3 pm', body: 'Use the chat for now.', audience: EVERYONE, ackRequired: false, urgent: true });
  await assert.rejects(owner.request('notices.issue', { id: urgent.id, at: at(0, 12) }), /at once/);
  const u = await owner.request('notices.issue', { id: urgent.id });
  assert.ok(Math.abs((u.expiresAt ?? 0) - (at(0, 9) + 24 * 3600_000)) < 5000, 'an urgent notice lasts a day unless told otherwise');
  assert.equal((await priya.request('notices.list')).banner?.id, urgent.id);
  await priya.request('notices.dismiss', { id: urgent.id });
  assert.equal((await priya.request('notices.list')).banner, null, 'once dismissed, it does not come back');
  assert.equal((await ravi.request('notices.list')).banner?.id, urgent.id);
  for (let i = 0; i < 2; i++) await owner.request('notices.issue', { id: (await owner.request('notices.save', { deskId: it.id, category: 'it', title: `Outage ${i}`, body: 'x', audience: EVERYONE, ackRequired: false, urgent: true })).id });
  const fourth = await owner.request('notices.save', { deskId: it.id, category: 'it', title: 'One more', body: 'x', audience: EVERYONE, ackRequired: false, urgent: true });
  await assert.rejects(owner.request('notices.issue', { id: fourth.id }), /3 urgent notices a day/);
  clock(at(1, 9, 1));
  assert.equal((await ravi.request('notices.list')).banner, null, 'gone when it expires');
  assert.equal((await ravi.request('notices.get', { id: urgent.id })).status, 'expired');

  // a holiday notice expires into the archive
  const hol = await priya.request('notices.save', draft({ category: 'holiday', title: 'Office closed for Diwali', ackRequired: false, effectiveAt: at(2, 0), expiresAt: at(3, 0) }));
  await priya.request('notices.issue', { id: hol.id });
  clock(at(3, 0, 1));
  const gone = await ravi.request('notices.get', { id: hol.id });
  assert.equal(gone.status, 'expired');
  await assert.rejects(priya.request('notices.save', { ...draft(), id: hol.id }), /no longer in force/);

  // withdrawal keeps a stamped record
  const w = await priya.request('notices.save', draft({ title: 'Canteen timings' }));
  await priya.request('notices.issue', { id: w.id });
  await assert.rejects(priya.request('notices.withdraw', { id: w.id, reason: '' }), /Say why/);
  const wd = await priya.request('notices.withdraw', { id: w.id, reason: 'Issued by mistake.' });
  assert.equal(wd.status, 'withdrawn');
  assert.equal(wd.withdrawn?.reason, 'Issued by mistake.');
  assert.equal(wd.current.status, 'withdrawn');
  const rw = await ravi.request('notices.get', { id: w.id });
  assert.equal(rw.needsAck, false);
  await assert.rejects(ravi.request('notices.ack', { id: w.id }), /in force/);

  // the email copy for people without the app
  const p = await priya.request('notices.save', draft({ title: 'Diwali bonus' }));
  await priya.request('notices.issue', { id: p.id });
  const mail = await priya.request('notices.emailCopy', { id: p.id });
  assert.equal(mail.subject, 'HR-POL-0002 Rev A: Diwali bonus');
  assert.match(mail.text, /Issued by: HR/);
  assert.deepEqual(mail.to, [], 'everyone here uses the app');
  void hr;
});

test('pinned Office messages move onto the board; the register exports; retention spares what is on hold', async () => {
  const { hub, owner, priya, ravi, draft, clock } = await setup();
  const officeSpace = (await owner.request('conv.list')).find((c: Conversation) => c.everyone)!;
  const m = await send(owner, officeSpace.id, 'Office timings from 1 November\nThe office opens at 9:00 and closes at 18:00.');
  await owner.request('msg.pin', { messageId: m.id, pinned: true });
  const pins = await owner.request('admin.notices.pinned');
  assert.deepEqual(pins.map((x) => x.messageId), [m.id]);
  await assert.rejects(priya.request('admin.notices.pinned'), /administrators/);
  const adm = (await owner.request('admin.notices.get')).desks.find((d) => d.code === 'ADM')!;
  assert.equal((await owner.request('admin.notices.import', { messageIds: [m.id], deskId: adm.id, category: 'notice' })).created, 1);
  assert.equal((await owner.request('admin.notices.import', { messageIds: [m.id], deskId: adm.id, category: 'notice' })).created, 0, 'once');
  const moved = (await ravi.request('notices.list')).notices.find((n) => n.deskCode === 'ADM')!;
  assert.equal(moved.number, 'ADM-NTC-0001');
  assert.equal(moved.title, 'Office timings from 1 November');
  assert.equal(moved.issuedAt, m.createdAt, 'issued when it was posted');
  assert.equal((await owner.request('msg.pins', { convId: officeSpace.id })).length, 0, 'the pin comes off');

  const v = await priya.request('notices.save', draft());
  await priya.request('notices.issue', { id: v.id });
  await ravi.request('notices.ack', { id: v.id });
  const csv = await owner.request('admin.notices.export', { format: 'csv' });
  assert.equal(csv.notices, 2);
  const text = hub.files.read(csv.file.id, 1 << 20)!.toString('utf8');
  assert.match(text, /HR-POL-0001,A,issued,HR,policy,Leave policy/);
  const json = JSON.parse(hub.files.read((await owner.request('admin.notices.export', { format: 'json' })).file.id, 1 << 20)!.toString('utf8')) as { notices: Array<{ number: string; revisions: Array<{ acknowledgements: unknown[] }> }> };
  assert.equal(json.notices.find((n) => n.number === 'HR-POL-0001')!.revisions[0].acknowledgements.length, 1);

  await assert.rejects(owner.request('admin.notices.setRetention', { days: 30 }), /at least a year/);
  await owner.request('admin.notices.setRetention', { days: 365 });
  await owner.request('notices.withdraw', { id: moved.id, reason: 'Moved to the handbook.' });
  await priya.request('notices.withdraw', { id: v.id, reason: 'Replaced.' });
  await owner.request('admin.compliance.hold', { kind: 'user', targetId: me(priya) });
  clock(Date.now() + 400 * DAY);
  const left = (await owner.request('admin.notices.export', { format: 'json' })).notices;
  assert.equal(left, 1, 'the withdrawn notice past retention went; the held author’s stayed');
  assert.ok((await owner.request('admin.audit', { limit: 100 })).some((a) => a.action === 'notice.purged'));
  void hub;
});

test('a revision draft is the desk’s alone; discarding it leaves the issued notice; withdrawing drops it', async () => {
  const { priya, ravi, draft } = await setup();
  const v = await priya.request('notices.save', draft());
  await assert.rejects(priya.request('notices.issue', { id: v.id, at: Date.now() + 400 * DAY }), /within a year/);
  await priya.request('notices.issue', { id: v.id });
  await priya.request('notices.save', { ...draft(), id: v.id, title: 'Leave policy (draft B)' });
  assert.equal((await ravi.request('notices.get', { id: v.id })).title, 'Leave policy');
  const list = (await priya.request('notices.list')).notices[0];
  assert.deepEqual(list.pendingRev, { rev: 'B', status: 'draft', issueAt: null });
  assert.equal((await priya.request('notices.discard', { id: v.id })).deleted, false);
  const after: NoticeView = await priya.request('notices.get', { id: v.id });
  assert.equal(after.draft, null);
  assert.equal(after.status, 'issued');
  const d2 = await priya.request('notices.save', draft({ title: 'Never issued' }));
  assert.equal((await priya.request('notices.discard', { id: d2.id })).deleted, true);
  await assert.rejects(priya.request('notices.get', { id: d2.id }), /not found/);
});
