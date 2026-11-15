// Tracked requests on the hub, with a clock the test moves: the drawing check going from the
// drafter to the checker and back, the lead and document control; reminders gathered into one
// list, passed up once, taken over; the register on asking and on its schedule; software seats
// with a waiting line; the plot room's queue; defaults from the directory; out of office.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BotFlowCard, BotFlowDefinition, Message } from '@dex/core';
import type { HubClient } from '@dex/core/client';
import { BOT_TEMPLATES } from '@dex/core/botmaker';
import { office, me, send } from './office.ts';

type CardMsg = Message & { botflow: BotFlowCard };
const H = 3600_000;
const cards = async (c: HubClient, convId: string): Promise<CardMsg[]> =>
  (await c.request('msg.list', { convId, limit: 200 })).messages.filter((m): m is CardMsg => !!m.botflow);
const texts = async (c: HubClient, convId: string): Promise<string[]> =>
  (await c.request('msg.list', { convId, limit: 200 })).messages.filter((m) => !m.botflow).map((m) => m.body);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async <T>(fn: () => Promise<T | undefined | null | false>, ms = 4000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(25);
  }
};
const dayStr = (n: number) => { const d = new Date(Date.now() + n * 86400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
/** The coming Monday at 10:00 (the office is open; reminders may go out). */
const monday = () => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); d.setHours(10, 0, 0, 0); return d.getTime(); };
const template = (id: string): BotFlowDefinition => JSON.parse(JSON.stringify(BOT_TEMPLATES.find((t) => t.id === id)!.definition)) as BotFlowDefinition;

/** The conversation between a person and a bot (once the bot has written to them). */
const dmWith = (c: HubClient, botId: string) => waitFor(async () => (await c.request('conv.list')).find((x) => x.kind === 'direct' && x.members.includes(botId))?.id);
/** The newest card of a kind in a conversation. */
const newest = (c: HubClient, convId: string, kind: BotFlowCard['kind'], pred: (m: CardMsg) => boolean = () => true) =>
  waitFor(async () => (await cards(c, convId)).filter((m) => m.botflow.kind === kind && pred(m)).pop());

async function run(c: HubClient, flow: string, answers: Array<[string, string]>): Promise<{ convId: string }> {
  const r = await c.request('botflow.start', { flow });
  for (const [stepId, value] of answers) {
    await waitFor(async () => (await cards(c, r.convId)).some((m) => m.botflow.kind === 'step' && m.botflow.state === 'active' && m.botflow.stepId === stepId));
    await c.request('botflow.answer', { sessionId: r.sessionId, stepId, value });
  }
  return { convId: r.convId };
}

test('drawing check: drafter → checker → back to the drafter → back-check → lead → document control, each card following it live', async () => {
  const { hub, owner, priya, ravi } = await office();
  let clock = monday();
  hub.botflows.now = () => clock;
  // Vikram leads Priya; he also keeps document control
  await owner.request('admin.org.setProfile', { userId: me(priya), managerId: me(owner) });
  const def = template('drawing-issue');
  def.track!.roles!.doccontrol.person = me(owner);
  const made = await priya.request('botflow.make', { definition: def, scope: 'private' });
  const answers: Array<[string, string]> = [['job', 'P-12513'], ['drawings', 'ISO-1001-01\nISO-1001-02'], ['rev', 'C'], ['purpose', 'IFC'], ['checker', me(ravi)], ['print', ''], ['due', dayStr(3)], ['ok', 'yes']];
  const { convId } = await run(priya, 'drawing-issue', answers);

  // Priya's closing card is the request's card from now on
  const done = await newest(priya, convId, 'done');
  assert.equal(done.body, 'With Ravi to check.');
  let t = done.botflow.track!;
  assert.equal(t.ref, 'DC-0001');
  assert.equal(t.stage?.id, 'check');
  assert.equal(t.stage?.who, me(ravi));
  assert.equal(t.role, 'requester');
  assert.ok(t.canWithdraw);
  assert.match(done.botflow.notes?.join(' ') ?? '', /DC-0001: Check, with Ravi/);

  // Ravi has a card of his own with the buttons, and a task on his Desk
  const raviDm = await dmWith(ravi, made.botId);
  const rc = await newest(ravi, raviDm, 'track');
  assert.equal(rc.botflow.track?.role, 'actor');
  assert.deepEqual(rc.botflow.track?.actions.map((a) => a.id), ['pass', 'comments']);
  assert.equal(rc.botflow.track?.stage?.checklist.length, 4);
  const tasks = await ravi.request('remind.list');
  assert.ok(tasks.some((x) => x.text.startsWith('DC-0001 · Check: P-12513')), 'a Desk task for the checker');
  // only the person acting may act; the checklist comes first; comments need words
  await assert.rejects(priya.request('botflow.act', { itemId: t.itemId, action: 'pass' }), /not waiting for you/);
  await assert.rejects(ravi.request('botflow.act', { itemId: t.itemId, action: 'pass' }), /Tick every line/);
  await assert.rejects(ravi.request('botflow.act', { itemId: t.itemId, action: 'comments' }), /Write the comments first/);
  clock += 2 * H;
  const r1 = await ravi.request('botflow.act', { itemId: t.itemId, action: 'comments', note: 'Tag 101-P-02 is missing on ISO-1001-02.' });
  assert.equal(r1.track.stage?.id, 'correct');
  assert.equal(r1.track.role, 'watcher', 'passed back: Ravi watches now');
  assert.ok((await ravi.request('remind.list')).every((x) => !x.text.startsWith('DC-0001 · Check')), 'his task is done when he acts');

  // back to Priya: a card asking her to correct, and her first card has moved on too
  const pc = await newest(priya, convId, 'track');
  assert.equal(pc.botflow.track?.stage?.id, 'correct');
  assert.match(pc.botflow.track?.stage?.prompt ?? '', /Tag 101-P-02 is missing/);
  t = (await newest(priya, convId, 'done')).botflow.track!;
  assert.equal(t.stage?.id, 'correct', 'the original card follows it');
  assert.equal(t.stages.find((s) => s.id === 'check')?.state, 'returned');
  clock += H;
  await priya.request('botflow.act', { itemId: t.itemId, action: 'done', note: 'Tag added.' });

  // round two of the check: a fresh card for Ravi, his first folded
  const rc2 = await waitFor(async () => { const list = (await cards(ravi, raviDm)).filter((m) => m.botflow.kind === 'track'); return list.length === 2 ? list : null; });
  assert.equal(rc2[0].botflow.track?.moved, true);
  assert.equal(rc2[1].botflow.track?.stage?.round, 2);
  for (let i = 0; i < 4; i++) await ravi.request('botflow.tick', { itemId: t.itemId, index: i, on: true });
  await ravi.request('botflow.act', { itemId: t.itemId, action: 'pass' });

  // Vikram approves (her lead, from the directory), then issues it as document control
  const ownerDm = await dmWith(owner, made.botId);
  const vc = await newest(owner, ownerDm, 'track');
  assert.equal(vc.botflow.track?.stage?.id, 'approve');
  await owner.request('botflow.act', { itemId: t.itemId, action: 'ok' });
  await assert.rejects(owner.request('botflow.act', { itemId: t.itemId, action: 'issued' }), /transmittal number/);
  await owner.request('botflow.act', { itemId: t.itemId, action: 'issued', note: 'DDS-TR-0412' });
  clock += 30 * H;
  const last = await owner.request('botflow.act', { itemId: t.itemId, action: 'ack', note: 'Received, K. Menon' });
  assert.equal(last.track.status, 'done');
  assert.equal(last.track.stamp, 'ISSUED');
  t = (await newest(priya, convId, 'done')).botflow.track!;
  assert.equal(t.stamp, 'ISSUED');
  assert.deepEqual(t.history.map((e) => e.action), ['start', 'comments', 'done', 'pass', 'ok', 'issued', 'ack']);
  // one word to her that it closed
  assert.ok((await waitFor(async () => (await texts(priya, convId)).find((b) => /^DC-0001 · ISSUED/.test(b)))));
  assert.ok((await owner.request('admin.audit')).some((a: { action: string }) => a.action === 'botflow.item.acted'));
});

test('reminders: one list per person, polite and limited, during working hours; passed up once; taken over', async () => {
  const { hub, owner, priya, ravi } = await office();
  let clock = monday();
  hub.botflows.now = () => clock;
  // Vikram leads Ravi (the checker)
  await owner.request('admin.org.setProfile', { userId: me(ravi), managerId: me(owner) });
  const made = await priya.request('botflow.make', { definition: template('drawing-issue'), scope: 'private' });
  const answers = (job: string): Array<[string, string]> => [['job', job], ['drawings', 'GA-200'], ['rev', 'B'], ['purpose', 'IFR'], ['checker', me(ravi)], ['print', ''], ['due', dayStr(20)], ['ok', 'yes']];
  await run(priya, 'drawing-issue', answers('P-12513'));
  await run(priya, 'drawing-issue', answers('P-20410'));
  const raviDm = await dmWith(ravi, made.botId);
  await waitFor(async () => (await cards(ravi, raviDm)).filter((m) => m.botflow.kind === 'track').length === 2);

  // not before a day has passed, and not at night
  hub.botflows.tickItems(clock + 20 * H);
  hub.botflows.tickItems(clock + 24 * H + 12 * H); // Tuesday 22:00
  assert.equal((await cards(ravi, raviDm)).filter((m) => m.botflow.kind === 'register').length, 0);
  // Tuesday 11:00: one list with both requests, not two messages
  clock += 25 * H;
  hub.botflows.tickItems(clock);
  const list1 = await newest(ravi, raviDm, 'register');
  assert.equal(list1.botflow.register?.mode, 'mine');
  assert.deepEqual(list1.botflow.register?.rows.map((r) => r.ref).sort(), ['DC-0001', 'DC-0002']);
  assert.match(list1.body, /Reminder: 2 requests wait for you/);
  assert.ok(list1.botflow.register?.rows.every((r) => r.role === 'actor' && r.actions.length === 2), 'he can act from the list');
  hub.botflows.tickItems(clock + H);
  assert.equal((await cards(ravi, raviDm)).filter((m) => m.botflow.kind === 'register').length, 1, 'no second reminder an hour later');
  // he deals with one from the list: it leaves the list at once
  await ravi.request('botflow.act', { itemId: list1.botflow.register!.rows.find((r) => r.ref === 'DC-0001')!.itemId, action: 'comments', note: 'See mark-up.' });
  const shrunk = await waitFor(async () => { const m = await newest(ravi, raviDm, 'register'); return m.botflow.register?.rows.length === 1 ? m : null; });
  assert.equal(shrunk.botflow.register?.rows[0].ref, 'DC-0002');

  // Wednesday: the second (and last) reminder replaces the first
  clock += 24 * H;
  hub.botflows.tickItems(clock);
  const regs = await waitFor(async () => { const l = (await cards(ravi, raviDm)).filter((m) => m.botflow.kind === 'register'); return l.length === 2 ? l : null; });
  assert.equal(regs[0].botflow.register?.moved, true, 'the older list folds');
  // Thursday: no third reminder; passed up to his lead, once
  clock += 24 * H;
  hub.botflows.tickItems(clock);
  hub.botflows.tickItems(clock + H);
  assert.equal((await cards(ravi, raviDm)).filter((m) => m.botflow.kind === 'register').length, 2);
  const ownerDm = await dmWith(owner, made.botId);
  const team = await newest(owner, ownerDm, 'register');
  assert.equal(team.botflow.register?.mode, 'team');
  assert.deepEqual(team.botflow.register?.rows.map((r) => r.ref), ['DC-0002']);
  assert.equal(team.botflow.register?.rows[0].canTakeOver, true);
  assert.equal((await cards(owner, ownerDm)).filter((m) => m.botflow.kind === 'register').length, 1);
  // Vikram takes it over: it is his now; Ravi is told
  const took = await owner.request('botflow.takeover', { itemId: team.botflow.register!.rows[0].itemId });
  assert.equal(took.track.stage?.who, me(owner));
  assert.equal(took.track.role, 'actor');
  await waitFor(async () => (await texts(ravi, raviDm)).find((b) => /Vikram has taken this over/.test(b)));
  // Priya cannot take over her own request, and Ravi cannot take over from his lead
  await assert.rejects(ravi.request('botflow.takeover', { itemId: took.track.itemId }), /Only the lead/);
});

test('the register: on asking in the bot\'s conversation, and on its schedule to document control, one card replacing the last', async () => {
  const { hub, owner, priya, ravi } = await office();
  let clock = monday();
  hub.botflows.now = () => clock;
  const def = template('drawing-issue');
  def.track!.roles!.doccontrol.person = me(owner);
  const made = await priya.request('botflow.make', { definition: def, scope: 'private' });
  const { convId } = await run(priya, 'drawing-issue', [['job', 'P-12513'], ['drawings', 'GA-200'], ['rev', 'B'], ['purpose', 'IFR'], ['checker', me(ravi)], ['print', ''], ['due', dayStr(20)], ['ok', 'yes']]);
  await newest(priya, convId, 'done');
  // written in the conversation
  await send(priya, convId, 'register');
  const reg = await newest(priya, convId, 'register');
  assert.equal(reg.botflow.register?.counts.open, 1);
  assert.equal(reg.botflow.register?.byStage.find((s) => s.id === 'check')?.open, 1);
  assert.equal(reg.botflow.register?.rows[0].title, 'P-12513 · rev B IFR');
  // the op, for the Desk
  const op = await priya.request('botflow.register', { flow: 'drawing-issue' });
  assert.equal(op.register.counts.open, 1);
  // someone with nothing to do with it sees no rows
  await owner.request('admin.org.setProfile', { userId: me(ravi), managerId: null });
  // scheduled: 09:20 on working days, to document control (Vikram); not before, once a day
  const next = new Date(clock); next.setDate(next.getDate() + 1); next.setHours(9, 10, 0, 0);
  clock = next.getTime();
  hub.botflows.tickItems(clock);
  await sleep(100);
  assert.equal((await owner.request('conv.list')).filter((x) => x.kind === 'direct' && x.members.includes(made.botId)).length, 0, 'nothing before 09:20');
  clock += 15 * 60_000;
  hub.botflows.tickItems(clock);
  const ownerDm = await dmWith(owner, made.botId);
  const daily = await newest(owner, ownerDm, 'register');
  assert.equal(daily.botflow.register?.mode, 'all');
  assert.equal(daily.botflow.register?.counts.open, 1);
  assert.match(daily.body, /Drawing check and issue: 1 open request/);
  hub.botflows.tickItems(clock + 60_000);
  hub.botflows.tickItems(clock + 2 * H);
  assert.equal((await cards(owner, ownerDm)).filter((m) => m.botflow.kind === 'register').length, 1, 'once a day');
  // the next day's replaces it
  clock += 24 * H;
  hub.botflows.tickItems(clock);
  const two = await waitFor(async () => { const l = (await cards(owner, ownerDm)).filter((m) => m.botflow.kind === 'register'); return l.length === 2 ? l : null; });
  assert.equal(two[0].botflow.register?.moved, true);
  assert.equal(two[1].botflow.register?.oldestDays, 1);
});

test('software seats: a place each, a waiting line with its place, the holder asked once, and the next person moved up', async () => {
  const { hub, owner, priya, ravi } = await office();
  let clock = monday();
  hub.botflows.now = () => clock;
  const made = await priya.request('botflow.make', { definition: template('licence-seat'), scope: 'office' });
  await owner.request('admin.botflows.review', { name: 'licence-seat', approve: true });
  const a = await run(priya, 'licence-seat', [['software', 'CAESAR II'], ['job', 'P-12513']]);
  const mine = (await newest(priya, a.convId, 'done')).botflow.track!;
  assert.equal(mine.stage?.id, 'use');
  assert.equal(mine.role, 'actor', 'it starts with her: she holds the seat');
  assert.deepEqual(mine.actions.map((x) => x.id), ['release', 'keep']);
  clock += 2 * H;
  const b = await run(ravi, 'licence-seat', [['software', 'CAESAR II'], ['job', 'P-20410']]);
  const his = (await newest(ravi, b.convId, 'done')).botflow.track!;
  assert.equal(his.queue?.position, 1);
  assert.equal(his.queue?.key, 'CAESAR II');
  assert.deepEqual(his.queue?.holders.map((h) => h.userId), [me(priya)]);
  assert.deepEqual(his.actions, [], 'nothing to press while waiting');
  assert.match((await newest(ravi, b.convId, 'done')).botflow.notes?.join(' ') ?? '', /in line for a place/);
  // the holder is asked, once
  await waitFor(async () => (await texts(priya, a.convId)).find((b2) => /Ravi is waiting for CAESAR II/.test(b2)));
  // a third person in line
  const c = await run(owner, 'licence-seat', [['software', 'CAESAR II'], ['job', 'P-100']]);
  assert.equal((await newest(owner, c.convId, 'done')).botflow.track?.queue?.position, 2);
  assert.equal((await texts(priya, a.convId)).filter((x) => /is waiting for CAESAR II/.test(x)).length, 1, 'asked once, not again for the next in line (one reminder for seats)');
  // the register: who has one now
  const reg = (await ravi.request('botflow.register', { flow: 'licence-seat' })).register;
  const caesar = reg.seats.find((s) => s.key === 'CAESAR II')!;
  assert.deepEqual([caesar.seats, caesar.used.map((u) => u.userId), caesar.waiting.length], [1, [me(priya)], 2]);
  // released: Ravi moves up and is told; Vikram is first in line now
  await priya.request('botflow.act', { itemId: mine.itemId, action: 'release' });
  const turn = await newest(ravi, b.convId, 'track');
  assert.match(turn.body, /CAESAR II is free\. It is yours now/);
  assert.equal(turn.botflow.track?.role, 'actor');
  assert.equal((await newest(owner, c.convId, 'done')).botflow.track?.queue?.position, 1);
  // "Still using it" keeps the place
  await ravi.request('botflow.act', { itemId: his.itemId, action: 'keep' });
  assert.equal((await newest(owner, c.convId, 'done')).botflow.track?.queue?.position, 1);
});

test('plot request: the lead from the directory and job numbers from Spaces as one-tap defaults; the plot room\'s queue; out of office goes to the delegate', async () => {
  const { hub, owner, priya, ravi } = await office();
  hub.botflows.now = () => monday();
  await owner.request('admin.org.setProfile', { userId: me(priya), managerId: me(owner) });
  await owner.request('conv.create', { kind: 'space', name: 'P-12513 Refinery revamp', members: [me(priya)] });
  const def = template('plot-request');
  def.track!.roles!.plotroom.person = me(ravi);
  // the hub's own Front Office has a flow called plot-request: hers gets the next free name
  const made = await priya.request('botflow.make', { definition: def, scope: 'private', newBot: true });
  assert.equal(made.name, 'plot-request-2');
  const r = await priya.request('botflow.start', { flow: made.name });
  const first = await newest(priya, r.convId, 'step', (m) => m.botflow.state === 'active');
  assert.ok(first.botflow.input?.suggestions?.includes('P-12513'), 'job numbers from her Spaces');
  for (const [id, v] of [['job', 'P-12513'], ['drawings', 'GA-200 rev B'], ['size', 'A1'], ['sets', '2'], ['due', dayStr(2)]] as const) {
    await waitFor(async () => (await cards(priya, r.convId)).some((m) => m.botflow.state === 'active' && m.botflow.stepId === id));
    await priya.request('botflow.answer', { sessionId: r.sessionId, stepId: id, value: v });
  }
  const lead = await newest(priya, r.convId, 'step', (m) => m.botflow.state === 'active' && m.botflow.stepId === 'lead');
  assert.equal(lead.botflow.suggested?.value, me(owner), 'her lead, from the directory');
  assert.equal(lead.botflow.suggestedWhy, 'lead');
  await priya.request('botflow.answer', { sessionId: r.sessionId, stepId: 'lead', value: me(owner) });
  await waitFor(async () => (await cards(priya, r.convId)).some((m) => m.botflow.state === 'active' && m.botflow.stepId === 'ok'));
  await priya.request('botflow.answer', { sessionId: r.sessionId, stepId: 'ok', value: 'yes' });
  const one = (await newest(priya, r.convId, 'done')).botflow.track!;
  await owner.request('botflow.act', { itemId: one.itemId, action: 'ok' });
  // a second request, approved too: the plot room has two, in order
  const r2 = await run(priya, made.name, [['job', 'P-12513'], ['drawings', 'ISO-1001'], ['size', 'A3'], ['sets', '1'], ['due', dayStr(2)], ['lead', me(owner)], ['ok', 'yes']]);
  const two = (await newest(priya, r2.convId, 'done')).botflow.track!;
  await owner.request('botflow.act', { itemId: two.itemId, action: 'ok' });
  const v1 = await priya.request('botflow.item', { itemId: one.itemId });
  const v2 = await priya.request('botflow.item', { itemId: two.itemId });
  assert.equal(v1.track.stage?.label, 'Plot queue');
  assert.deepEqual([v1.track.queue?.position, v2.track.queue?.position, v2.track.queue?.of], [1, 2, 2]);
  // the plot room plots the first; the second moves up
  await ravi.request('botflow.act', { itemId: one.itemId, action: 'start' });
  assert.equal((await priya.request('botflow.item', { itemId: two.itemId })).track.queue, null, 'alone in the queue now');
  await ravi.request('botflow.act', { itemId: one.itemId, action: 'ready', note: 'Tray 3' });
  const collect = await newest(priya, r.convId, 'track');
  assert.match(collect.botflow.track?.stage?.prompt ?? '', /ready to collect\. Tray 3/);
  await priya.request('botflow.act', { itemId: one.itemId, action: 'got' });
  assert.equal((await priya.request('botflow.item', { itemId: one.itemId })).track.stamp, 'COLLECTED');
  // Ravi away, Vikram covering: a new request for the plot room goes to Vikram, and says why
  await ravi.request('me.update', { ooo: { until: Date.now() + 3 * 86400_000, message: 'On site', delegateId: me(owner) } });
  await owner.request('botflow.act', { itemId: two.itemId, action: 'cannot', note: 'Out of A3 paper' }).catch(() => {});
  const r3 = await run(priya, made.name, [['job', 'P-12513'], ['drawings', 'ISO-1002'], ['size', 'A1'], ['sets', '1'], ['due', dayStr(2)], ['lead', me(owner)], ['ok', 'yes']]);
  const three = (await newest(priya, r3.convId, 'done')).botflow.track!;
  const ok3 = await owner.request('botflow.act', { itemId: three.itemId, action: 'ok' });
  assert.equal(ok3.track.stage?.who, me(owner));
  assert.equal(ok3.track.stage?.whoNote, `ooo:${me(ravi)}`);
  // withdrawn by Priya: closed, and the plot room's task with it
  const w = await priya.request('botflow.withdraw', { itemId: three.itemId });
  assert.equal(w.track.status, 'withdrawn');
  await assert.rejects(owner.request('botflow.act', { itemId: three.itemId, action: 'start' }), /already closed/);
});
