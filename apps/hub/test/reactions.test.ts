// Reaction insights: the history of reactions, and what members of a conversation can learn
// about one message's reactions (descriptive only: reactions are not approvals).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReactionInsights } from '../src/reactions.ts';
import type { HubClient } from '@dex/core/client';
import { office as base, me, send, until } from './office.ts';

/** The usual three people, and `n` more approved colleagues. */
async function office(n = 0) {
  const o = await base();
  const extra: HubClient[] = [];
  for (const name of ['anu', 'dev', 'meera'].slice(0, n)) {
    const { c, identity } = await o.join(name);
    await o.owner.request('admin.decide', { deviceId: identity.deviceId, approve: true });
    await until(c, (st) => st.kind === 'ready');
    extra.push(c);
  }
  return { ...o, extra };
}

const react = (c: HubClient, messageId: string, emoji: string, on = true) => c.request('msg.react', { messageId, emoji, on });

test('every reaction change is recorded once, with its time', async () => {
  const { hub, owner, priya, ravi } = await office();
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Piping', members: [me(priya), me(ravi)] });
  const m = await send(owner, sp.id, 'ISO-0042 Rev B issued');
  await react(priya, m.id, '👍');
  await react(priya, m.id, '👍'); // already there: not a change
  await react(ravi, m.id, '🎉', false); // nothing to remove
  await react(ravi, m.id, '👍');
  await react(ravi, m.id, '👍', false);
  const rows = hub.store.db.prepare('SELECT user_id, emoji, action, conv_id FROM reaction_events WHERE message_id = ? ORDER BY id').all(m.id) as Array<{ user_id: string; emoji: string; action: string; conv_id: string }>;
  assert.deepEqual(rows.map((r) => [r.user_id, r.emoji, r.action]), [[me(priya), '👍', 'add'], [me(ravi), '👍', 'add'], [me(ravi), '👍', 'remove']]);
  assert.ok(rows.every((r) => r.conv_id === sp.id));
});

test('the spread per emoji, with counts and percentages, and the note', async () => {
  const { owner, priya, ravi, extra } = await office(2);
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Site', members: [me(priya), me(ravi), ...extra.map(me)] });
  const m = await send(owner, sp.id, 'Site visit to the refinery on Friday 9:30 am');
  await react(priya, m.id, '👍');
  await react(ravi, m.id, '👍');
  await react(extra[0], m.id, '👍');
  await react(extra[0], m.id, '🙏');
  const r = await priya.request('reactions.insights', { messageId: m.id });
  assert.equal(r.note, 'Reactions are not approvals');
  assert.equal(r.total, 4);
  assert.equal(r.people, 3);
  assert.deepEqual(r.distribution, [{ emoji: '👍', count: 3, percent: 75 }, { emoji: '🙏', count: 1, percent: 25 }]);
  assert.equal(r.audience.members, 4); // everyone but the author
  assert.equal(r.audience.reacted, 3);
  assert.equal(r.audience.reactedPercent, 75);
  assert.equal(r.anonymous, false);
});

test('reacted against read-but-no-reaction, by read receipts as people share them', async () => {
  const { owner, priya, ravi, extra } = await office(2);
  const [anu, dev] = extra;
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Structural', members: [me(priya), me(ravi), me(anu), me(dev)] });
  const m = await send(owner, sp.id, 'Please review the GA by EOD');
  await react(priya, m.id, '👀');
  await ravi.request('conv.read', { convId: sp.id, messageId: m.id }); // read, no reaction
  await anu.request('me.update', { readReceipts: false });
  await anu.request('conv.read', { convId: sp.id, messageId: m.id }); // read, but does not share it
  // dev has not read it
  const r = await owner.request('reactions.insights', { messageId: m.id });
  assert.deepEqual({ ...r.audience }, { members: 4, reacted: 1, seenNoReaction: 1, notSeen: 1, unknown: 1, reactedPercent: 25, seenNoReactionPercent: 25, receipts: true });
  // someone who keeps their own receipts private sees none of others'
  const forAnu = await anu.request('reactions.insights', { messageId: m.id });
  assert.equal(forAnu.audience.receipts, false);
  assert.equal(forAnu.audience.seenNoReaction, 0);
  assert.equal(forAnu.audience.unknown, 3);
  // side-track replies have no read receipts
  const reply = await priya.request('msg.send', { convId: sp.id, body: 'On it', parentId: m.id, clientId: 'rx1' });
  const rr = await owner.request('reactions.insights', { messageId: reply.id });
  assert.equal(rr.audience.receipts, false);
});

test('a timeline of cumulative reactions, and the first and last reaction', async () => {
  const { hub, owner, priya } = await office();
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Timeline', members: [me(priya)] });
  const m = await send(owner, sp.id, 'MTO for unit 300 is out');
  const t0 = m.createdAt;
  const db = hub.store.db;
  const add = (user: string, emoji: string, action: 'add' | 'remove', at: number) =>
    db.prepare('INSERT INTO reaction_events (message_id, conv_id, user_id, emoji, action, at) VALUES (?, ?, ?, ?, ?, ?)').run(m.id, sp.id, user, emoji, action, at);
  add('U1', '👍', 'add', t0 + 2 * 60_000);
  add('U2', '👍', 'add', t0 + 7 * 60_000);
  add('U3', '🎉', 'add', t0 + 40 * 60_000);
  add('U2', '👍', 'remove', t0 + 41 * 60_000);
  add('U4', '👍', 'add', t0 + 100 * 60_000);
  const r = await priya.request('reactions.insights', { messageId: m.id });
  assert.equal(r.timeline.bucketMs, 5 * 60_000);
  assert.equal(r.firstAt, t0 + 2 * 60_000);
  assert.equal(r.lastAt, t0 + 100 * 60_000);
  const b = r.timeline.buckets;
  assert.equal(b[0].start, t0);
  assert.deepEqual(b.map((x) => x.cumulative).filter((_, i) => [0, 1, 8, 20].includes(i)), [1, 2, 2, 3]);
  assert.equal(b.reduce((n, x) => n + x.added, 0), 4);
  assert.equal(b.reduce((n, x) => n + x.removed, 0), 1);
  assert.ok(b.length <= 25);
  // no reactions yet: one empty bucket and no times
  const quiet = await send(owner, sp.id, 'Nothing to see');
  const q = await priya.request('reactions.insights', { messageId: quiet.id });
  assert.equal(q.firstAt, null);
  assert.equal(q.total, 0);
  assert.equal(q.timeline.buckets.length, 1);
  assert.equal(q.audience.reactedPercent, 0);
});

test('reactors per department', async () => {
  const { owner, priya, ravi, extra } = await office(1);
  const piping = await owner.request('admin.org.saveDepartment', { name: 'Piping' });
  const civil = await owner.request('admin.org.saveDepartment', { name: 'Civil' });
  await owner.request('admin.org.setProfile', { userId: me(priya), departmentId: piping.id });
  await owner.request('admin.org.setProfile', { userId: me(ravi), departmentId: piping.id });
  await owner.request('admin.org.setProfile', { userId: me(extra[0]), departmentId: civil.id });
  const sp = await owner.request('conv.create', { kind: 'space', name: 'All design', members: [me(priya), me(ravi), me(extra[0])] });
  const m = await send(owner, sp.id, 'Plot plan Rev 3 for comments');
  await react(priya, m.id, '👍');
  await react(extra[0], m.id, '👍');
  const r = await ravi.request('reactions.insights', { messageId: m.id });
  assert.deepEqual(r.byDepartment, [
    { departmentId: civil.id, name: 'Civil', members: 1, reacted: 1, percent: 100 },
    { departmentId: piping.id, name: 'Piping', members: 2, reacted: 1, percent: 50 },
  ]);
});

test('announcements are compared with the office average', async () => {
  const { owner, priya, ravi } = await office();
  const office1 = (await owner.request('conv.list')).find((c) => c.everyone)!;
  const a1 = await send(owner, office1.id, 'Office closed on Monday');
  await react(priya, a1.id, '👍');
  await react(ravi, a1.id, '👍'); // 2 of 2
  const a2 = await send(owner, office1.id, 'New plotter on the 2nd floor'); // 0 of 2
  const a3 = await send(owner, office1.id, 'Fire drill at 4 pm');
  await react(priya, a3.id, '✅'); // 1 of 2
  const r = await priya.request('reactions.insights', { messageId: a3.id });
  assert.deepEqual(r.announcement, { responseRate: 50, officeAverage: 50, compared: 2 });
  void a2;
  // a Space where only moderators post counts as announcements too; an ordinary Space does not
  const notices = await owner.request('conv.create', { kind: 'space', name: 'Notices', members: [me(priya), me(ravi)] });
  await owner.request('conv.settings', { convId: notices.id, postPolicy: 'moderators' });
  const n = await send(owner, notices.id, 'Timesheets due Friday');
  assert.ok((await priya.request('reactions.insights', { messageId: n.id })).announcement);
  const chat = await owner.request('conv.create', { kind: 'space', name: 'Chat', members: [me(priya)] });
  const c = await send(owner, chat.id, 'Lunch?');
  assert.equal((await priya.request('reactions.insights', { messageId: c.id })).announcement, null);
});

test('only members of the conversation see insights', async () => {
  const { owner, priya, ravi } = await office();
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Bids', private: true, members: [me(priya)] });
  const m = await send(owner, sp.id, 'Bid due 20 Nov');
  await assert.rejects(ravi.request('reactions.insights', { messageId: m.id }), /Message not found/);
  await assert.rejects(priya.request('reactions.insights', { messageId: 'nope' }), /Message not found/);
  await owner.request('msg.delete', { messageId: m.id });
  await assert.rejects(priya.request('reactions.insights', { messageId: m.id }), /Message not found/);
});

test('anonymous polls: counts only, no departments, no read receipts', async () => {
  const { owner, priya, ravi } = await office();
  const dept = await owner.request('admin.org.saveDepartment', { name: 'Process' });
  await owner.request('admin.org.setProfile', { userId: me(priya), departmentId: dept.id });
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Polls', members: [me(priya), me(ravi)] });
  const poll = await owner.request('poll.create', { convId: sp.id, question: 'Team lunch on Friday?', options: ['Yes', 'No'], anonymous: true, clientId: 'p1' });
  await react(priya, poll.id, '😋');
  await ravi.request('conv.read', { convId: sp.id, messageId: poll.id });
  const r = await owner.request('reactions.insights', { messageId: poll.id });
  assert.equal(r.anonymous, true);
  assert.equal(r.byDepartment, null);
  assert.equal(r.audience.receipts, false);
  assert.equal(r.audience.seenNoReaction, 0);
  assert.equal(r.total, 1);
  const open = await owner.request('poll.create', { convId: sp.id, question: 'Shift start?', options: ['9', '10'], clientId: 'p2' });
  assert.equal((await owner.request('reactions.insights', { messageId: open.id })).anonymous, false);
});

test('reactions made before the history existed are taken in once', async () => {
  const { hub, owner, priya } = await office();
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Old', members: [me(priya)] });
  const m = await send(owner, sp.id, 'From before');
  await react(priya, m.id, '👍');
  hub.store.db.exec('DROP TABLE reaction_events');
  const fresh = new ReactionInsights(hub.store, hub.messaging);
  const rows = hub.store.db.prepare('SELECT user_id, action FROM reaction_events WHERE message_id = ?').all(m.id) as Array<{ user_id: string; action: string }>;
  assert.deepEqual(rows.map((r) => [r.user_id, r.action]), [[me(priya), 'add']]);
  new ReactionInsights(hub.store, hub.messaging); // a restart adds nothing again
  assert.equal((hub.store.db.prepare('SELECT COUNT(*) AS n FROM reaction_events').get() as { n: number }).n, 1);
  assert.equal(fresh.insights(priya.session!.me, m.id).firstAt !== null, true);
});
