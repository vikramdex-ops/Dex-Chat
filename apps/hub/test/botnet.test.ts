// Bots talking to bots on a real hub: a step that asks another bot, the drawing check handing its
// issued set to the plot room's bot and getting it back "collected", a bot listening for another's
// requests, refusals (private bots, bots its maker cannot use), a loop stopped, rate limits,
// timeouts falling back to the person, idempotent hops, the audit log and the network sheet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BotFlowCard, BotFlowDefinition, Message, PublicUser } from '@dex/core';
import type { HubClient } from '@dex/core/client';
import { BOT_TEMPLATES } from '@dex/core/botmaker';
import { office, me } from './office.ts';

type CardMsg = Message & { botflow: BotFlowCard };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async <T>(fn: () => Promise<T | undefined | null | false> | T | undefined | null | false, ms = 5000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(25);
  }
};
const cards = async (c: HubClient, convId: string): Promise<CardMsg[]> => (await c.request('msg.list', { convId, limit: 200 })).messages.filter((m): m is CardMsg => !!m.botflow);
const texts = async (c: HubClient, convId: string): Promise<string[]> => (await c.request('msg.list', { convId, limit: 200 })).messages.filter((m) => !m.botflow).map((m) => m.body);
const dmWith = (c: HubClient, botId: string) => waitFor(async () => (await c.request('conv.list')).find((x) => x.kind === 'direct' && x.members.includes(botId))?.id);
const template = (id: string): BotFlowDefinition => JSON.parse(JSON.stringify(BOT_TEMPLATES.find((t) => t.id === id)!.definition)) as BotFlowDefinition;
const step = (c: HubClient, convId: string, stepId: string) => waitFor(async () => (await cards(c, convId)).find((m) => m.botflow.kind === 'step' && m.botflow.state === 'active' && m.botflow.stepId === stepId));

/** The plot room's office-wide bot (made by the administrator), with Vikram as the plot room. */
async function plotRoom(owner: HubClient) {
  const plot = template('plot-request');
  // Front Office already has a flow called plot-request
  plot.name = 'plot-room';
  plot.title = 'Plot room';
  plot.track!.roles!.plotroom.person = me(owner);
  return owner.request('botflow.make', { definition: plot, scope: 'office' });
}
/** Software seats, office-wide. */
async function seats(owner: HubClient) {
  return owner.request('botflow.make', { definition: template('licence-seat'), scope: 'office' });
}
const stressCheck = (extra: Partial<BotFlowDefinition> = {}): BotFlowDefinition => ({
  name: 'stress-check', title: 'Stress check',
  persona: { mark: { kind: 'monogram', letters: 'SC' }, colour: 'petrol', tone: 'plain' },
  steps: [
    { id: 'line', label: 'Line', prompt: 'Which line?', input: { kind: 'text' } },
    { id: 'seat', label: 'CAESAR II seat', prompt: 'Is a CAESAR II seat free?', input: { kind: 'text' }, ask: { skill: 'licence-seat.seats', with: { key: 'CAESAR II' } }, branches: [{ if: { equals: '0' }, goto: 'wait' }] },
    { id: 'go', label: 'Start', prompt: 'A seat is free ({{seat}}). Start now?', input: { kind: 'choice', options: ['Now', 'Later'] }, next: 'end' },
    { id: 'wait', label: 'Wait', prompt: 'No seat is free. Wait in line?', input: { kind: 'choice', options: ['Yes', 'No'] } },
  ],
  finish: [{ do: 'remind', text: 'Stress check {{line}}', dueInDays: 1 }],
  ...extra,
});

test('a step asks another bot mid-flow: the answer drives the next step, and a relay card shows the hop', async () => {
  const { hub, owner, priya, ravi } = await office();
  await seats(owner);
  const made = await priya.request('botflow.make', { definition: stressCheck(), scope: 'private' });
  // the maker's blocks: the system's skills and the seat bot's
  const skills = await priya.request('botnet.skills', { flow: 'stress-check' });
  assert.ok(skills.some((s) => s.id === 'nib.away') && skills.some((s) => s.id === 'licence-seat.seats'));
  assert.ok(!skills.some((s) => s.id.startsWith('stress-check.')), 'not its own');

  let r = await priya.request('botflow.start', { flow: 'stress-check' });
  await step(priya, r.convId, 'line');
  await priya.request('botflow.answer', { sessionId: r.sessionId, stepId: 'line', value: '10"-P-1001' });
  const go = await step(priya, r.convId, 'go');
  assert.equal(go.botflow.prompt, 'A seat is free (1 free). Start now?');
  assert.equal(go.botflow.stepNo, 2, 'the bot’s step is not one of the person’s');
  const relay = await waitFor(async () => (await cards(priya, r.convId)).find((m) => m.botflow.kind === 'relay'));
  assert.deepEqual(relay.botflow.relay?.tags.map((t) => t.key), ['stress-check', 'licence-seat']);
  const hop = relay.botflow.relay!.hops[0];
  assert.equal(hop.kind, 'query');
  assert.equal(hop.ask, 'SEAT? · CAESAR II');
  assert.equal(hop.answer, '1 free');
  assert.equal(hop.status, 'ok');
  await priya.request('botflow.answer', { sessionId: r.sessionId, stepId: 'go', value: 'Now' });

  // Ravi takes the only CAESAR II seat: now the answer is 0 and the flow goes the other way
  const rs = await ravi.request('botflow.start', { flow: 'licence-seat' });
  await step(ravi, rs.convId, 'software');
  await ravi.request('botflow.answer', { sessionId: rs.sessionId, stepId: 'software', value: 'CAESAR II' });
  await step(ravi, rs.convId, 'job');
  await ravi.request('botflow.answer', { sessionId: rs.sessionId, stepId: 'job', value: 'P-12513' });
  r = await priya.request('botflow.start', { flow: 'stress-check' });
  await step(priya, r.convId, 'line');
  await priya.request('botflow.answer', { sessionId: r.sessionId, stepId: 'line', value: '8"-P-2002' });
  const wait = await step(priya, r.convId, 'wait');
  assert.match(wait.botflow.prompt ?? '', /No seat is free/);
  // audited, and on the network sheet with its traffic
  const audit = hub.store.db.prepare("SELECT action, detail FROM audit WHERE action = 'botnet.query'").all() as Array<{ action: string; detail: string }>;
  assert.ok(audit.length >= 2);
  const map = await priya.request('botnet.map', { scope: 'mine' });
  const edge = map.edges.find((e) => e.from === 'stress-check' && e.to === 'licence-seat');
  assert.ok(edge && edge.declared && edge.count >= 2 && edge.kinds.includes('query'));
  const ex = await priya.request('botnet.edge', { from: 'stress-check', to: 'licence-seat' });
  assert.ok(ex.exchanges.every((x) => x.userId === null), 'a maker sees exchanges, not who');
  await assert.rejects(ravi.request('botnet.edge', { from: 'stress-check', to: 'licence-seat' }), /not one of your bots/);
  void made;
});

test('a bot that cannot answer in time: the person is asked instead, and can ask the bot again', async () => {
  const { hub, owner, priya } = await office();
  await seats(owner);
  await priya.request('botflow.make', { definition: stressCheck(), scope: 'private' });
  hub.botflows.net.timeoutMs = 40;
  hub.botflows.net.overrides.set('licence-seat.seats', () => new Promise((res) => setTimeout(() => res({ free: { value: '1', label: '1' } }), 400)));
  const r = await priya.request('botflow.start', { flow: 'stress-check' });
  await step(priya, r.convId, 'line');
  await priya.request('botflow.answer', { sessionId: r.sessionId, stepId: 'line', value: 'L-1' });
  const fallback = await step(priya, r.convId, 'seat');
  assert.equal(fallback.botflow.prompt, 'Is a CAESAR II seat free?');
  assert.ok((await texts(priya, r.convId)).some((t) => /Software seat did not answer in time/.test(t)));
  const relay = await waitFor(async () => (await cards(priya, r.convId)).filter((m) => m.botflow.kind === 'relay').pop());
  const hop = relay.botflow.relay!.hops.at(-1)!;
  assert.equal(hop.status, 'timeout');
  assert.ok(hop.canRetry);
  // ask again once it is quick
  hub.botflows.net.overrides.delete('licence-seat.seats');
  hub.botflows.net.timeoutMs = 3000;
  await priya.request('botnet.retry', { hopId: hop.id });
  await step(priya, r.convId, 'go');
});

test('a stage that waits on another bot: the drawing check hands the issued set to the plot room and gets it back collected', async () => {
  const { hub, owner, priya, ravi } = await office();
  await owner.request('admin.org.setProfile', { userId: me(priya), managerId: me(owner) });
  await plotRoom(owner);
  const dc = template('drawing-issue');
  dc.track!.roles!.doccontrol.person = me(owner);
  // after Issue: plotted by the plot room's bot, straight into its queue (approved here already)
  dc.track!.stages.find((s) => s.id === 'issue')!.actions[0].to = 'plot';
  dc.track!.stages.splice(4, 0, {
    id: 'plot', label: 'Plot', who: 'bot:plot-room', prompt: 'With the plot room',
    handoff: { to: 'plot-room', start: 'queue', carry: { size: 'A1', sets: '2', drawings: '{{drawings}} rev {{rev}}', due: '{{due.value}}', lead: '{{lead.value}}' } },
    actions: [{ id: 'plotted', label: 'Plotted', to: 'receipt', tone: 'go' }, { id: 'none', label: 'Not plotted', to: 'receipt', tone: 'stop' }],
  });
  await priya.request('botflow.make', { definition: dc, scope: 'private' });
  const day = new Date(Date.now() + 3 * 86400_000);
  const due = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  const r = await priya.request('botflow.start', { flow: 'drawing-issue' });
  for (const [id, v] of [['job', 'P-12513'], ['drawings', 'ISO-1001-01'], ['rev', 'C'], ['purpose', 'IFC'], ['checker', me(ravi)], ['print', ''], ['due', due], ['ok', 'yes']] as Array<[string, string]>) {
    await step(priya, r.convId, id);
    await priya.request('botflow.answer', { sessionId: r.sessionId, stepId: id, value: v });
  }
  const done = await waitFor(async () => (await cards(priya, r.convId)).find((m) => m.botflow.kind === 'done'));
  const itemId = done.botflow.track!.itemId;
  for (let i = 0; i < 4; i++) await ravi.request('botflow.tick', { itemId, index: i, on: true });
  await ravi.request('botflow.act', { itemId, action: 'pass' });
  await owner.request('botflow.act', { itemId, action: 'ok' });
  await owner.request('botflow.act', { itemId, action: 'issued', note: 'TR-0042' });
  // handed to the plot room's bot: its request opens at the queue, for the plot room (Vikram)
  const handed = await waitFor(() => (hub.store.db.prepare("SELECT * FROM bot_links WHERE kind = 'handoff' AND to_bot = 'plot-room'").get() as { status: string; target_item: string | null } | undefined)?.target_item ? hub.store.db.prepare("SELECT * FROM bot_links WHERE kind = 'handoff'").get() as { status: string; target_item: string; answer: string } : null);
  assert.equal(handed.status, 'ok');
  assert.equal(handed.answer, 'PLT-0001');
  let view = (await priya.request('botflow.item', { itemId })).track;
  const cell = view.stages.find((s) => s.id === 'plot')!;
  assert.equal(cell.state, 'here');
  assert.equal(cell.bot?.flow, 'plot-room');
  assert.equal(cell.bot?.ref, 'PLT-0001');
  assert.equal(cell.bot?.label, 'Plot queue');
  assert.equal(view.stage?.who, null, 'no person acts while the bot has it');
  const plt = (await owner.request('botflow.item', { itemId: handed.target_item })).track;
  assert.equal(plt.stage?.id, 'queue');
  assert.equal(plt.role, 'actor');
  assert.match(plt.lines.map((l) => `${l.label}: ${l.value}`).join('\n'), /Drawings: ISO-1001-01 rev C/);
  // the relay card in Priya's conversation with the drawing check bot
  const relay = await waitFor(async () => (await cards(priya, r.convId)).filter((m) => m.botflow.kind === 'relay').pop());
  assert.deepEqual(relay.botflow.relay!.tags.map((t) => t.key), ['drawing-issue', 'plot-room']);
  assert.equal(relay.botflow.relay!.hops[0].kind, 'handoff');
  assert.equal(relay.botflow.relay!.hops[0].ref, 'PLT-0001');
  // the plot room plots it, Priya collects it: the drawing check carries on by itself
  await owner.request('botflow.act', { itemId: handed.target_item, action: 'start' });
  await owner.request('botflow.act', { itemId: handed.target_item, action: 'ready', note: 'Rack 3' });
  await priya.request('botflow.act', { itemId: handed.target_item, action: 'got' });
  view = await waitFor(async () => { const v = (await priya.request('botflow.item', { itemId })).track; return v.stage?.id === 'receipt' ? v : null; });
  assert.equal(view.stages.find((s) => s.id === 'plot')!.state, 'done');
  assert.equal(view.stages.find((s) => s.id === 'plot')!.bot?.label, 'COLLECTED');
  assert.match(view.history.map((e) => `${e.label} ${e.note ?? ''}`).join('|'), /Plotted PLT-0001 · COLLECTED/);
  const back = await waitFor(async () => (await cards(priya, r.convId)).filter((m) => m.botflow.kind === 'relay').pop()?.botflow.relay?.hops.find((h) => h.status === 'returned'));
  assert.equal(back.back?.stamp, 'COLLECTED');
  // the same stage handed again does not open a second plot request
  const n = (hub.store.db.prepare("SELECT COUNT(*) AS n FROM bot_links WHERE kind = 'handoff'").get() as { n: number }).n;
  assert.equal(n, 1);
});

test('the end of a flow hands to another bot: the steps answered are carried, the person carries on there', async () => {
  const { owner, priya } = await office();
  await owner.request('admin.org.setProfile', { userId: me(priya), managerId: me(owner) });
  const plot = await plotRoom(owner);
  await priya.request('botflow.make', {
    scope: 'private', definition: {
      name: 'iso-ready', title: 'Iso ready',
      steps: [{ id: 'job', label: 'Job', prompt: 'Job?', input: { kind: 'text' } }, { id: 'drawings', label: 'Drawings', prompt: 'Which?', input: { kind: 'text' } }],
      finish: [{ do: 'handoff', to: 'plot-room', carry: { size: 'A3' } }],
    },
  });
  const r = await priya.request('botflow.start', { flow: 'iso-ready' });
  await step(priya, r.convId, 'job');
  await priya.request('botflow.answer', { sessionId: r.sessionId, stepId: 'job', value: 'P-12513' });
  await step(priya, r.convId, 'drawings');
  await priya.request('botflow.answer', { sessionId: r.sessionId, stepId: 'drawings', value: 'ISO-7' });
  const done = await waitFor(async () => (await cards(priya, r.convId)).find((m) => m.botflow.kind === 'done'));
  assert.match(done.botflow.notes?.join(' ') ?? '', /Plot room carries on in its own conversation/);
  // in the plot bot's conversation: job, drawings and size carried, she answers "how many sets" next
  const pdm = await dmWith(priya, plot.botId);
  assert.ok((await texts(priya, pdm)).some((t) => t === 'From Iso ready: 3 answers carried across.'));
  await step(priya, pdm, 'sets');
});

test('a bot listens for another bot’s requests; a bot it cannot use is refused; a loop is stopped', async () => {
  const { hub, owner, priya, ravi } = await office();
  await owner.request('admin.org.setProfile', { userId: me(priya), managerId: me(owner) });
  await seats(owner);
  // Vikram hears whenever a seat is borrowed
  const watch = await owner.request('botflow.make', { scope: 'private', definition: { name: 'seat-watch', title: 'Seat watch', steps: [{ id: 'q', prompt: 'Q?', input: { kind: 'text' } }], finish: [], network: { on: [{ on: 'licence-seat.opened', do: 'tell', text: '{{user}} has {{ref}}: {{software}}' }] } } });
  const rs = await priya.request('botflow.start', { flow: 'licence-seat' });
  await step(priya, rs.convId, 'software');
  await priya.request('botflow.answer', { sessionId: rs.sessionId, stepId: 'software', value: 'E3D' });
  await step(priya, rs.convId, 'job');
  await priya.request('botflow.answer', { sessionId: rs.sessionId, stepId: 'job', value: 'P-12513' });
  await hub.botflows.net.settle();
  const vdm = await dmWith(owner, watch.botId);
  assert.ok((await texts(owner, vdm)).includes('Priya has LIC-0001: E3D'));
  // and when Priya goes on leave, the seat bot's listener releases her seats
  await owner.request('botflow.make', { scope: 'private', definition: { name: 'leave-seats', title: 'Seats on leave', steps: [{ id: 'q', prompt: 'Q?', input: { kind: 'text' } }], finish: [], network: { on: [{ on: 'nib.away', do: 'ask', ask: { skill: 'licence-seat.release', with: { person: '{{user.value}}' } }, text: '{{user}} is away: {{result}} released' }] } } });
  hub.botflows.net.emitAway(me(priya), '2026-11-20', '2026-11-22');
  await hub.botflows.net.settle();
  const seat = (await priya.request('botflow.register', { flow: 'licence-seat' })).register;
  assert.equal(seat.counts.open, 0, 'her seat was released');

  // Ravi's private bot: saving a bot that asks it is refused
  await ravi.request('botflow.make', { scope: 'private', definition: { ...template('licence-seat'), name: 'ravi-seat', title: 'Ravi seat' } });
  await assert.rejects(priya.request('botflow.make', { scope: 'private', definition: stressCheck({ steps: [{ id: 'seat', label: 'Seat', prompt: 'Free?', input: { kind: 'text' }, ask: { skill: 'ravi-seat.seats', with: { key: 'E3D' } } }] }) }), /not a skill your bots can ask/);
  // and asked at run time anyway (a bot saved before it went private), it is refused and audited
  await priya.request('botflow.make', { scope: 'private', definition: stressCheck() });
  const priyaUser = hub.store.userById(me(priya)) as PublicUser;
  const res = await hub.botflows.net.ask({ from: 'stress-check', person: priyaUser, trail: [], group: 'g1' }, { skill: 'ravi-seat.seats', with: { key: 'E3D' } }, {});
  assert.equal(res.status, 'refused');
  assert.match(res.reason ?? '', /Ravi seat is private to the person who made it/);
  assert.ok(hub.store.db.prepare("SELECT 1 FROM audit WHERE action = 'botnet.query' AND detail LIKE '%refused%'").get());

  // two bots that hand to each other: the second hand back is stopped
  const ping = (name: string, to: string): BotFlowDefinition => ({ name, title: name === 'ping-bot' ? 'Ping' : 'Pong', steps: [{ id: 'job', label: 'Job', prompt: 'Job?', input: { kind: 'text' } }], finish: [{ do: 'handoff', to }] });
  await priya.request('botflow.make', { scope: 'private', definition: { ...ping('ping-bot', 'pong-bot'), finish: [] } });
  await priya.request('botflow.make', { scope: 'private', definition: ping('pong-bot', 'ping-bot') });
  await priya.request('botflow.make', { scope: 'private', definition: ping('ping-bot', 'pong-bot') });
  const p = await priya.request('botflow.start', { flow: 'ping-bot' });
  await step(priya, p.convId, 'job');
  await priya.request('botflow.answer', { sessionId: p.sessionId, stepId: 'job', value: 'P-1' });
  const loop = await waitFor(() => hub.store.db.prepare("SELECT * FROM bot_links WHERE status = 'loop'").get() as { reason: string; from_bot: string; to_bot: string } | undefined);
  assert.equal(loop.from_bot, 'pong-bot');
  assert.match(loop.reason, /Stopped a loop: Ping already had this request \(ping-bot → pong-bot → ping-bot\)/);
});

test('a bot asking too often in a minute is slowed down, in plain words', async () => {
  const { hub, owner, priya } = await office();
  await seats(owner);
  await priya.request('botflow.make', { scope: 'private', definition: stressCheck() });
  const u = hub.store.userById(me(priya)) as PublicUser;
  let limited = null;
  for (let i = 0; i < 40 && !limited; i++) {
    const r = await hub.botflows.net.ask({ from: 'stress-check', person: u, trail: [], group: 'g' }, { skill: 'licence-seat.seats', with: { key: 'E3D' } }, {});
    if (r.status === 'limited') limited = r;
  }
  assert.ok(limited, 'the limit was reached');
  assert.match(limited.reason ?? '', /asked too often in the last minute/);
});
