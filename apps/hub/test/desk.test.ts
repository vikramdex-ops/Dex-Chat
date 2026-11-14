import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message, Reminder, ScheduledMessage } from '@dex/core';
import { nextOccurrence } from '../src/desk.ts';
import { office, nextEvent, me, send, nextClientId } from './office.ts';

test('saved messages are private to each person and follow edits and deletes', async () => {
  const { owner, priya, ravi } = await office();
  const space = await owner.request('conv.create', { kind: 'space', name: 'Saves', members: [me(priya)] });
  const a = await send(owner, space.id, 'Revised MTO for area 3');
  const b = await send(owner, space.id, 'Site visit on Friday');
  const starred = nextEvent<{ messageId: string; on: boolean }>(priya, 'star.updated');
  await priya.request('msg.star', { messageId: a.id, on: true });
  assert.deepEqual(await starred, { messageId: a.id, on: true });
  await priya.request('msg.star', { messageId: b.id, on: true });
  assert.deepEqual((await priya.request('desk.saved')).map((s) => s.message.id), [b.id, a.id]);
  assert.equal((await owner.request('desk.saved')).length, 0);
  await owner.request('msg.delete', { messageId: b.id });
  assert.deepEqual((await priya.request('desk.saved')).map((s) => s.message.id), [a.id]);
  await priya.request('msg.star', { messageId: a.id, on: false });
  assert.equal((await priya.request('desk.saved')).length, 0);
  // you cannot save what you cannot see
  const dm = await owner.request('conv.create', { kind: 'direct', members: [me(priya)] });
  const secret = await send(owner, dm.id, 'between us');
  await assert.rejects(ravi.request('msg.star', { messageId: secret.id, on: true }), /not found/);
  await assert.rejects(owner.request('msg.star', { messageId: 'nope', on: true }), /not found/);
});

test('reminders fire on time, repeat, snooze and can be set for a colleague', async () => {
  const { hub, owner, priya, ravi } = await office();
  const space = await owner.request('conv.create', { kind: 'space', name: 'Reminders', members: [me(priya)] });
  const m = await send(owner, space.id, 'Send the GA drawings to the client');
  const soon = Date.now() + 60_000;
  const r = await priya.request('remind.create', { messageId: m.id, dueAt: soon });
  assert.equal(r.text, 'About this message');
  assert.equal(r.message?.id, m.id);
  assert.equal(r.convId, space.id);
  // not due yet
  hub.desk.tick(soon - 1);
  // due: Priya hears about it once
  const due = nextEvent<Reminder>(priya, 'reminder.due');
  hub.desk.tick(soon + 1);
  assert.equal((await due).id, r.id);
  let quiet = true;
  const listen = (n: string) => { if (n === 'reminder.due') quiet = false; };
  priya.on('event', listen);
  hub.desk.tick(soon + 5000);
  await new Promise((res) => setTimeout(res, 150));
  priya.off('event', listen);
  assert.ok(quiet, 'a reminder fires once');
  // snooze re-arms it
  const later = soon + 3600_000;
  const snoozed = await priya.request('remind.update', { id: r.id, dueAt: later });
  assert.equal(snoozed.firedAt, null);
  const again = nextEvent<Reminder>(priya, 'reminder.due');
  hub.desk.tick(later + 1);
  await again;
  await priya.request('remind.update', { id: r.id, done: true });
  assert.equal((await priya.request('remind.list')).length, 0);
  assert.equal((await priya.request('remind.list', { includeDone: true })).length, 1);

  // for a colleague: Ravi cannot see the Space, so it is refused; a plain one works
  await assert.rejects(priya.request('remind.create', { messageId: m.id, dueAt: soon, forUserId: me(ravi) }), /cannot see/);
  const forRavi = await priya.request('remind.create', { text: 'Timesheet', dueAt: soon, forUserId: me(ravi), repeat: 'weekly' });
  assert.equal(forRavi.userId, me(ravi));
  assert.equal(forRavi.createdBy, me(priya));
  assert.ok((await ravi.request('remind.list')).some((x) => x.id === forRavi.id));
  assert.ok((await priya.request('remind.list')).some((x) => x.id === forRavi.id));
  const raviDue = nextEvent<Reminder>(ravi, 'reminder.due');
  const moved = nextEvent<Reminder>(ravi, 'reminder.updated', (x) => x.dueAt > soon + 1000);
  hub.desk.tick(soon + 10);
  await raviDue;
  // weekly: moves on seven days and stays open
  assert.equal(new Date((await moved).dueAt).getDate(), new Date(soon + 7 * 86400_000).getDate());
  assert.equal((await ravi.request('remind.list')).find((x) => x.id === forRavi.id)?.done, false);
  // strangers cannot touch it
  await assert.rejects(owner.request('remind.delete', { id: forRavi.id }), /not found/);
  await ravi.request('remind.delete', { id: forRavi.id });
  await assert.rejects(priya.request('remind.create', { text: '', dueAt: soon }), /say/);
  await assert.rejects(priya.request('remind.create', { text: 'x', dueAt: Number.NaN }), /time/);
});

test('repeat rules step to the next time in the future', () => {
  const mon = new Date(2026, 10, 9, 9, 0).getTime(); // Monday 9 Nov 2026, 09:00
  const fri = new Date(2026, 10, 13, 9, 0).getTime();
  assert.equal(nextOccurrence(mon, 'none', mon), null);
  assert.equal(new Date(nextOccurrence(mon, 'daily', mon)!).getDate(), 10);
  assert.equal(new Date(nextOccurrence(fri, 'weekdays', fri)!).getDate(), 16); // skips the weekend
  assert.equal(new Date(nextOccurrence(mon, 'weekly', mon)!).getDate(), 16);
  const jan31 = new Date(2027, 0, 31, 9).getTime();
  const feb = new Date(nextOccurrence(jan31, 'monthly', jan31)!);
  assert.deepEqual([feb.getMonth(), feb.getDate()], [1, 28]); // clamps to the end of February
  // missed for a long time: still one step into the future, not a burst
  const past = new Date(2026, 0, 1, 9).getTime();
  assert.ok(nextOccurrence(past, 'daily', mon)! > mon);
  assert.ok(nextOccurrence(past, 'daily', mon)! - mon <= 86400_000);
});

test('scheduled messages send on time, can be edited, sent now or cancelled', async () => {
  const { hub, owner, priya } = await office();
  const space = await owner.request('conv.create', { kind: 'space', name: 'Schedules', members: [me(priya)] });
  const at = Date.now() + 120_000;
  await assert.rejects(owner.request('sched.create', { convId: space.id, body: 'too soon', sendAt: Date.now() + 1000 }), /at least a minute/);
  const s = await owner.request('sched.create', { convId: space.id, body: 'Good morning team', sendAt: at });
  assert.equal(s.status, 'pending');
  const edited = await owner.request('sched.update', { id: s.id, body: 'Good morning, team' });
  assert.equal(edited.body, 'Good morning, team');
  assert.equal((await priya.request('sched.list')).length, 0, 'only the author sees it');
  const arrived = nextEvent<Message>(priya, 'msg.new', (m) => m.convId === space.id);
  const removed = nextEvent<{ id: string; sentMessageId: string | null }>(owner, 'sched.removed');
  hub.desk.tick(at + 1);
  const msg = await arrived;
  assert.equal(msg.body, 'Good morning, team');
  assert.equal(msg.authorId, me(owner));
  assert.equal((await removed).sentMessageId, msg.id);
  assert.equal((await owner.request('sched.list')).length, 0);

  const s2 = await owner.request('sched.create', { convId: space.id, body: 'now please', sendAt: at });
  const now = await owner.request('sched.sendNow', { id: s2.id });
  assert.equal(now.body, 'now please');
  await assert.rejects(owner.request('sched.sendNow', { id: s2.id }), /already sent/);
  const s3 = await owner.request('sched.create', { convId: space.id, body: 'never mind', sendAt: at });
  await owner.request('sched.cancel', { id: s3.id });
  assert.equal((await owner.request('sched.list')).length, 0);

  // the author left before it was due: it fails visibly instead of vanishing
  const s4 = await priya.request('sched.create', { convId: space.id, body: 'after I leave', sendAt: at });
  await priya.request('conv.leave', { convId: space.id });
  const failed = nextEvent<ScheduledMessage>(priya, 'sched.updated', (x) => x.id === s4.id);
  hub.desk.tick(at + 10);
  assert.equal((await failed).status, 'failed');
  assert.match((await priya.request('sched.list'))[0].error ?? '', /not found/);
});

test('polls: one or many choices, anonymous, closing', async () => {
  const { owner, priya, ravi } = await office();
  const space = await owner.request('conv.create', { kind: 'space', name: 'Polls', members: [me(priya), me(ravi)] });
  await assert.rejects(owner.request('poll.create', { convId: space.id, question: 'Lunch?', options: ['Dosa'], clientId: nextClientId() }), /two choices/);
  await assert.rejects(owner.request('poll.create', { convId: space.id, question: 'Lunch?', options: ['Dosa', 'dosa'], clientId: nextClientId() }), /different/);
  const poll = await owner.request('poll.create', { convId: space.id, question: 'Team lunch on Friday?', options: ['Dosa', 'Biryani', 'Thali'], clientId: nextClientId() });
  assert.equal(poll.poll?.options.length, 3);
  const update = nextEvent<Message>(owner, 'msg.updated', (m) => m.id === poll.id);
  const v1 = await priya.request('poll.vote', { messageId: poll.id, options: [1] });
  assert.deepEqual(v1.poll?.mine, [1]);
  const seen = await update;
  assert.deepEqual(seen.poll?.mine, [], 'each person gets their own view');
  assert.deepEqual(seen.poll?.options[1].voters, [me(priya)]);
  await assert.rejects(ravi.request('poll.vote', { messageId: poll.id, options: [0, 1] }), /one option/);
  await ravi.request('poll.vote', { messageId: poll.id, options: [1] });
  const changed = await priya.request('poll.vote', { messageId: poll.id, options: [2] });
  assert.deepEqual(changed.poll?.options.map((o) => o.votes), [0, 1, 1]);
  assert.equal(changed.poll?.voterCount, 2);
  await assert.rejects(priya.request('poll.close', { messageId: poll.id }), /Only the person/);
  const closed = await owner.request('poll.close', { messageId: poll.id });
  assert.equal(closed.poll?.closed, true);
  await assert.rejects(ravi.request('poll.vote', { messageId: poll.id, options: [0] }), /closed/);

  const anon = await owner.request('poll.create', { convId: space.id, question: 'Rate the new office', options: ['Great', 'OK', 'Meh'], multi: true, anonymous: true, clientId: nextClientId() });
  const a = await priya.request('poll.vote', { messageId: anon.id, options: [0, 1] });
  assert.deepEqual(a.poll?.mine, [0, 1]);
  assert.deepEqual(a.poll?.options.map((o) => o.voters), [[], [], []], 'anonymous polls never reveal voters');
  const list = await ravi.request('msg.list', { convId: space.id });
  assert.equal(list.messages.find((m) => m.id === anon.id)?.poll?.voterCount, 1);
  const conv = (await ravi.request('conv.list')).find((c) => c.id === space.id)!;
  assert.match(conv.lastMessage?.body ?? '', /^📊 Rate the new office/);
  assert.ok((await ravi.request('search', { q: 'meh' })).messages.some((x) => x.message.id === anon.id), 'choices are searchable');
});

test('forwarding copies text and files with credit, only where you belong; mark unread', async () => {
  const { owner, priya, ravi } = await office();
  const a = await owner.request('conv.create', { kind: 'space', name: 'Source', members: [me(priya)] });
  const b = await owner.request('conv.create', { kind: 'direct', members: [me(ravi)] });
  const orig = await send(priya, a.id, 'Client approved revision C');
  const out = await owner.request('msg.forward', { messageId: orig.id, convIds: [b.id], note: 'FYI' });
  assert.equal(out.length, 1);
  assert.equal(out[0].body, 'Client approved revision C');
  assert.deepEqual(out[0].forwardedFrom, { authorId: me(priya), convId: a.id, messageId: orig.id, createdAt: orig.createdAt });
  const inB = (await ravi.request('msg.list', { convId: b.id })).messages;
  assert.deepEqual(inB.map((m) => m.body), ['FYI', 'Client approved revision C']);
  // forwarding a forward keeps the original author
  const again = await ravi.request('msg.forward', { messageId: out[0].id, convIds: [(await ravi.request('conv.create', { kind: 'direct', members: [me(priya)] })).id] });
  assert.equal(again[0].forwardedFrom?.authorId, me(priya));
  await assert.rejects(ravi.request('msg.forward', { messageId: orig.id, convIds: [b.id] }), /not found/);
  await assert.rejects(owner.request('msg.forward', { messageId: orig.id, convIds: [] }), /Choose/);

  // mark unread from a message: it and everything after it count again
  await send(priya, a.id, 'second');
  await send(priya, a.id, 'third');
  const list = (await owner.request('msg.list', { convId: a.id })).messages;
  await owner.request('conv.read', { convId: a.id, messageId: list.at(-1)!.id });
  const unread = await owner.request('conv.markUnread', { convId: a.id, messageId: list.at(-2)!.id });
  assert.equal(unread.unread, 2);
  assert.equal(unread.lastReadId, list.at(-3)!.id);
});
