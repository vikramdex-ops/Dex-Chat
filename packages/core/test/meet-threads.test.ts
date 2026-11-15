// Action points from words, working hours, and the recap as text and email.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECAP_PARTS_ALL, RECAP_PARTS_GUESTS, actionTrigger, apRef, inWorkingHours, isOverdue, occurrenceNo, ownerLabel, parseAction, recapEmail, recapText } from '../src/meet-threads.ts';
import type { MeetRecap } from '../src/meet-threads.ts';
import { buildEml } from '../src/eml.ts';

const people = [{ id: 'u-ravi', name: 'Ravi Kumar' }, { id: 'u-meera', name: 'Meera Iyer' }, { id: 'guest:01', name: 'Mr Rao' }];
const ctx = { people, today: '2026-11-15' };

test('the words that start an action point', () => {
  for (const t of ['/action Ravi to send', '/ap send', 'AP: send', 'ap - send', 'Action: send', 'Action point: send', '→ send', '-> send', '=> send']) assert.equal(actionTrigger(t), t.endsWith('Ravi to send') ? 'Ravi to send' : 'send', t);
  for (const t of ['apple pie', 'Actions speak', 'send the GA', '/actions', '']) assert.equal(actionTrigger(t), null, t);
});

test('owner, task and due date from plain words', () => {
  const a = parseAction('Ravi to send the revised GA by Fri', ctx);
  assert.deepEqual([a.owner, a.task, a.due], [{ id: 'u-ravi', name: 'Ravi Kumar' }, 'Send the revised GA', '2026-11-20']);
  assert.deepEqual(a.spans.map((s) => s.kind), ['owner', 'due']);
  const b = parseAction('Meera Iyer will check the MTO kal tak', ctx);
  assert.deepEqual([b.owner?.id, b.task, b.due], ['u-meera', 'Check the MTO', '2026-11-16']);
  // a guest by name: no account
  const c = parseAction('Mr Rao to confirm the nozzle loads by 20 Nov', ctx);
  assert.deepEqual([c.owner, c.task, c.due], [{ id: null, name: 'Mr Rao' }, 'Confirm the nozzle loads', '2026-11-20']);
  // someone outside the list, with a title, is still an owner by name
  assert.deepEqual(parseAction('Dr Shah: approve the layout', ctx).owner, { id: null, name: 'Dr Shah' });
  // the owner at the end
  const d = parseAction('send the GA – Ravi', ctx);
  assert.deepEqual([d.owner?.id, d.task], ['u-ravi', 'Send the GA']);
  // a mention
  assert.equal(parseAction('<@u-meera> update the line list', ctx).owner?.id, 'u-meera');
  // no owner: the words stay the task
  const e = parseAction('need to check pump curves', ctx);
  assert.deepEqual([e.owner, e.task, e.due], [null, 'Need to check pump curves', null]);
  assert.equal(parseAction('', ctx).task, '');
});

test('numbers, labels, overdue and working hours', () => {
  assert.equal(apRef(7), 'AP-07');
  assert.equal(apRef(123), 'AP-123');
  assert.equal(occurrenceNo({ meetingId: '482913207', seq: 3, id: 'x' }), 'MTG-482913207-03');
  assert.equal(ownerLabel({ ownerId: null, ownerName: 'Mr Rao' }, () => ''), 'Mr Rao (guest)');
  assert.equal(ownerLabel({ ownerId: 'u', ownerName: null }, () => 'Ravi Kumar'), 'Ravi Kumar');
  assert.ok(isOverdue({ status: 'open', due: '2026-11-14' }, '2026-11-15'));
  assert.ok(!isOverdue({ status: 'done', due: '2026-11-14' }, '2026-11-15'));
  assert.ok(!isOverdue({ status: 'open', due: null }, '2026-11-15'));
  const mon11 = new Date(2026, 10, 16, 11, 0).getTime();
  const mon8 = new Date(2026, 10, 16, 8, 0).getTime();
  const sun11 = new Date(2026, 10, 15, 11, 0).getTime();
  assert.ok(inWorkingHours(mon11, [1, 2, 3, 4, 5, 6], '09:45', '18:00'));
  assert.ok(!inWorkingHours(mon8, [1, 2, 3, 4, 5, 6], '09:45', '18:00'));
  assert.ok(!inWorkingHours(sun11, [1, 2, 3, 4, 5, 6], '09:45', '18:00'));
});

test('the recap as text and as an email draft, with only the parts chosen', () => {
  const t0 = new Date(2026, 10, 16, 10, 2).getTime();
  const r: MeetRecap = {
    occurrence: { id: 'o1', meetingId: '482913207', convId: 'c', eventId: null, title: 'प्रगति समीक्षा · Weekly piping sync', kind: 'event', hostId: 'u-priya', slotStart: null, slotEnd: null, startedAt: t0, endedAt: t0 + 47 * 60_000, state: 'ended', seq: 2, noteTakerId: 'u-meera', sealed: false },
    viewer: { member: true, organiser: true },
    attendance: [{ userId: 'u-ravi', name: 'Ravi Kumar', guest: false, firstJoin: t0, lastLeave: t0 + 47 * 60_000, totalMs: 47 * 60_000, joins: 1 }, { userId: 'guest:1', name: 'Mr Rao', guest: true, firstJoin: t0, lastLeave: t0, totalMs: 30 * 60_000, joins: 2 }],
    absent: ['u-anil'], recordings: [],
    actions: [{ id: 'a', convId: 'c', occurrenceId: 'o1', n: 1, text: 'Send the revised GA', sealed: false, ownerId: 'u-ravi', ownerName: null, due: '2026-11-20', status: 'open', createdBy: 'u-priya', createdAt: t0, updatedAt: t0, doneAt: null, doneBy: null, messageId: 'm', source: 'chat' }],
    decisions: [{ messageId: 'd', question: 'Go with option B?', authorId: 'u-priya', at: t0, reached: 3, outcomes: [{ label: 'Approved', count: 3 }] }],
    files: [], filesMore: 0, polls: [], notes: [], agenda: [],
    chat: { lines: [{ messageId: 'l', authorId: 'guest:1', name: 'Mr Rao', guest: true, text: 'Thanks', at: t0, everyone: true, breakout: null, files: [] }], total: 1, next: null, from: t0, to: t0, sealed: false },
  };
  const names: Record<string, string> = { 'u-priya': 'Priya Raman', 'u-meera': 'Meera Iyer', 'u-anil': 'Anil Rao', 'u-ravi': 'Ravi Kumar' };
  const nameOf = (id: string) => names[id] ?? 'Someone';
  const full = recapText(r, RECAP_PARTS_ALL, nameOf);
  assert.match(full, /MTG-482913207-02/);
  assert.match(full, /47 min/);
  assert.match(full, /Mr Rao \(guest\) · 30 min/);
  assert.match(full, /Invited, not there: Anil Rao/);
  assert.match(full, /AP-01 Send the revised GA · Ravi Kumar · due 2026-11-20 · Open/);
  assert.match(full, /Go with option B\?: Approved \(3\)/);
  assert.doesNotMatch(full, /CHAT/, 'the chat is not sent unless chosen');
  const guests = recapText(r, RECAP_PARTS_GUESTS, nameOf);
  assert.doesNotMatch(guests, /ATTENDANCE|DECISIONS/);
  assert.match(guests, /ACTION POINTS/);
  const mail = recapEmail(r, RECAP_PARTS_GUESTS, nameOf, 'DDSP');
  assert.match(mail.subject, /^Recap: /);
  assert.match(mail.html, /AP-01/);
  assert.doesNotMatch(mail.html, /<script/);
  const eml = buildEml({ to: [{ name: 'Mr Rao', email: 'rao@example.com' }], subject: mail.subject, text: mail.text, html: mail.html, seed: 's', date: new Date(t0) });
  assert.match(eml, /^Subject: =\?UTF-8\?B\?/m, 'the Hindi title is encoded');
  assert.match(eml, /X-Unsent: 1/);
});
