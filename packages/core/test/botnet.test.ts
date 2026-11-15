// Bots talking to bots: the skills a bot publishes from what it is, the parts of a definition that
// ask, hand over and listen, answers carried across, and the safety rules (who may ask whom,
// loops and depth, rate limits, timeouts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NET_MAX_DEPTH, RateWindow, SYSTEM_SKILLS, answerWords, askRefusal, askWords, carryFor, declaredLinks, eventWords, extendTrail, handoffRefusal, inputsFor, isPublic, loopRefusal, skillsOf, tagLetters, trailOf, withTimeout } from '../src/botnet.ts';
import type { NetParty } from '../src/botnet.ts';
import { flowPosition, startVars, validateFlow } from '../src/botflow-engine.ts';
import { trackHandBack, trackOpen } from '../src/botflow-track.ts';
import { BOT_TEMPLATES } from '../src/botmaker.ts';
import type { BotFlowDefinition } from '../src/bots.ts';

const tpl = (id: string): BotFlowDefinition => JSON.parse(JSON.stringify(BOT_TEMPLATES.find((t) => t.id === id)!.definition)) as BotFlowDefinition;

test('a bot publishes skills from what it is', () => {
  const seat = skillsOf(tpl('licence-seat'), { public: true });
  assert.deepEqual(seat.map((s) => s.id), ['licence-seat.open', 'licence-seat.status', 'licence-seat.seats', 'licence-seat.release']);
  const free = seat.find((s) => s.id === 'licence-seat.seats')!;
  assert.equal(free.title, 'Is a place free?');
  assert.ok(free.inputs[0].options?.includes('CAESAR II'));
  assert.equal(seat.find((s) => s.id === 'licence-seat.release')!.effect, 'act');
  const tq = skillsOf(tpl('rfi-log'), { public: false });
  assert.deepEqual(tq.map((s) => s.id), ['rfi-log.open', 'rfi-log.status']);
  assert.ok(tq[0].inputs.find((i) => i.id === 'stage')!.options!.includes('With client'));
  const plain = skillsOf(tpl('leave-note'), { public: true });
  assert.deepEqual(plain.map((s) => s.id), ['leave-note.sent']);
  assert.deepEqual(SYSTEM_SKILLS.map((s) => s.id), ['directory.lead', 'nib.away', 'nib.awayList', 'calendar.workday']);
});

test('what was asked and what came back, in a few words for the relay line', () => {
  const free = skillsOf(tpl('licence-seat'), { public: true }).find((s) => s.id === 'licence-seat.seats')!;
  assert.equal(askWords(free, { key: { value: 'CAESAR II', label: 'CAESAR II' } }), 'SEAT? · CAESAR II');
  assert.equal(answerWords(free, { free: { value: '1', label: '1' } }), '1 free');
  const away = SYSTEM_SKILLS.find((s) => s.id === 'nib.away')!;
  assert.equal(answerWords(away, { away: { value: 'yes', label: 'Yes' }, back: { value: '2026-11-18', label: 'Wed 18 Nov' } }), 'on leave, back Wed 18 Nov');
  assert.equal(answerWords(away, { away: { value: 'no', label: 'No' } }), 'in the office');
  assert.equal(eventWords('drawing-issue.closed', () => 'Drawing check', 'ISSUED'), 'When a Drawing check request is ISSUED');
  assert.equal(tagLetters('Drawing check and issue'), 'DCI');
  assert.equal(tagLetters('Nib', 'NB'), 'NB');
});

test('steps that ask a bot, handoffs and listening are checked with the definition', () => {
  const def = validateFlow({
    name: 'issue-plot', title: 'Issue and plot',
    steps: [
      { id: 'software', prompt: 'Which?', input: { kind: 'choice', options: ['E3D', 'CAESAR II'] } },
      { id: 'seat', label: 'Seat', prompt: 'Is one free?', input: { kind: 'text' }, ask: { skill: 'licence-seat.seats', with: { key: '{{software}}' }, onFail: 'skip' } },
    ],
    finish: [{ do: 'handoff', to: 'plot-request', carry: { job: '{{software}}' } }],
    network: { share: 'owner', on: [{ on: 'drawing-issue.closed', stamp: 'issued', do: 'tell', text: '{{ref}} is out' }] },
  });
  assert.deepEqual(def.steps[1].ask, { skill: 'licence-seat.seats', with: { key: '{{software}}' }, onFail: 'skip' });
  assert.deepEqual(def.finish[0], { do: 'handoff', to: 'plot-request', carry: { job: '{{software}}' } });
  assert.equal(def.network?.on?.[0].stamp, 'ISSUED');
  assert.deepEqual(declaredLinks(def), [{ to: 'licence-seat', kind: 'query' }, { to: 'plot-request', kind: 'handoff' }, { to: 'drawing-issue', kind: 'event' }]);
  // the person's steps are counted; the bot's are not
  assert.deepEqual(flowPosition(def, 'software', [], {}), { stepNo: 1, stepCount: 1 });
  const base = { name: 'x-bot', title: 'X', steps: [{ id: 'q', prompt: 'Q?', input: { kind: 'text' } }], finish: [] };
  assert.throws(() => validateFlow({ ...base, steps: [{ id: 'q', prompt: 'Q?', input: { kind: 'confirm' }, ask: { skill: 'nib.away' } }] }), /not a confirmation or a file/);
  assert.throws(() => validateFlow({ ...base, steps: [{ id: 'q', prompt: 'Q?', input: { kind: 'text' }, ask: { skill: 'nope' } }] }), /choose which bot to ask/);
  assert.throws(() => validateFlow({ ...base, finish: [{ do: 'handoff', to: 'Not A Bot' }] }), /which bot it is handed to/);
  assert.throws(() => validateFlow({ ...base, network: { on: [{ on: 'x-bot.closed', do: 'tell', text: 'hi' }] } }), /does not listen to itself/);
  assert.throws(() => validateFlow({ ...base, network: { on: [{ on: 'whenever', do: 'tell', text: 'hi' }] } }), /"on" is/);
});

test('a stage that waits on another bot comes back through one of its buttons', () => {
  const def = tpl('drawing-issue');
  def.track!.stages.splice(4, 0, {
    id: 'plot', label: 'Plot', who: 'bot:plot-request', prompt: 'With the plot room', handoff: { to: 'plot-request', start: 'queue', carry: { job: '{{job}}' } },
    actions: [{ id: 'plotted', label: 'Plotted', to: 'receipt', tone: 'go' }, { id: 'notplotted', label: 'Not plotted', to: 'receipt', tone: 'stop' }],
  } as never);
  def.track!.stages[3].actions[0].to = 'plot';
  const v = validateFlow(def);
  const plot = v.track!.stages.find((s) => s.id === 'plot')!;
  assert.deepEqual(plot.handoff, { to: 'plot-request', carry: { job: '{{job}}' }, start: 'queue', back: { done: 'plotted', stopped: 'notplotted' } });
  const people = { resolve: (who: string) => (who.startsWith('bot:') ? null : { id: 'U1' }) };
  let item = trackOpen(v, { id: 'i1', num: 1, requesterId: 'U1', vars: {}, lines: [], now: 1, people });
  item = { ...item, stage: 'plot', actorId: null };
  const back = trackHandBack(v, item, 'plot-request', 'done', 'PLT-0001 · COLLECTED', 2, people);
  assert.equal(back.stage, 'receipt');
  assert.equal(back.vars.note.value, 'PLT-0001 · COLLECTED');
  assert.throws(() => trackHandBack(v, { ...item, stage: 'check' }, 'plot-request', 'done', '', 2, people), /not waiting for that bot/);
  assert.throws(() => validateFlow({ ...def, track: { ...def.track!, stages: def.track!.stages.map((s) => (s.id === 'plot' ? { ...s, handoff: { to: 'plot-request', back: { done: 'nope' } } } : s)) } }), /not one of its buttons/);
});

test('answers carried across: named ones, then the same names; the other bot checks them again', () => {
  const plot = tpl('plot-request');
  const vars = { ...startVars(plot, { id: 'U1', name: 'Priya Raman', account: 'dex\\priya' }), job: { value: 'P-12513', label: 'P-12513' }, drawings: { value: 'ISO-1', label: 'ISO-1' }, rev: { value: 'C', label: 'C' } };
  assert.deepEqual(carryFor({ carry: { drawings: '{{drawings}} rev {{rev}}', size: 'A1' } }, vars, plot), { job: 'P-12513', drawings: 'ISO-1 rev C', size: 'A1' });
  assert.deepEqual(inputsFor({ skill: 'x.y', with: { key: '{{job}}', none: '{{missing}}' } }, vars), { key: 'P-12513' });
});

const party = (o: Partial<NetParty> = {}): NetParty => ({ flow: 'b', ownerId: 'O2', source: 'member', scope: 'space', network: null, ...o });

test('who may ask whom: what its maker may use, never someone else’s private bot; errands only for the person', () => {
  const caller = party({ flow: 'a', ownerId: 'O1', scope: 'private' });
  const ask = (target: NetParty | 'system', ownerMayUse: boolean, effect: 'read' | 'act' = 'read', forSelf = true, ownerIsAdmin = false) => askRefusal({ caller, target, ownerMayUse, effect, forSelf, ownerIsAdmin, targetTitle: 'Software seat' });
  assert.equal(ask('system', false), null);
  assert.equal(ask(party({ scope: 'office' }), false), null, 'office-wide skills are public');
  assert.ok(isPublic(party({ scope: 'office' })));
  assert.equal(ask(party({ scope: 'space' }), true), null, 'a Space bot its maker is in');
  assert.match(ask(party({ scope: 'space' }), false)!, /not shared with this bot’s maker/);
  assert.match(ask(party({ scope: 'private' }), false)!, /private to the person who made it/);
  assert.equal(ask(party({ scope: 'private', ownerId: 'O1' }), true), null, 'its maker’s own private bot');
  assert.match(ask(party({ scope: 'office', network: { share: 'owner' } }), true)!, /only its own maker’s bots/);
  assert.match(ask(party({ scope: 'office' }), true, 'act', false)!, /only for the person it is for/);
  assert.equal(ask(party({ scope: 'office' }), true, 'act', true), null);
  assert.equal(ask(party({ scope: 'office' }), true, 'act', false, true), null, 'an administrator’s bot may');
  const target = tpl('plot-request');
  const hand = (t: NetParty, ownerMayUse: boolean, personMayUse: boolean, start?: string) => handoffRefusal({ caller, target: t, targetDef: target, ownerMayUse, personMayUse, targetTitle: 'Plot request', start });
  assert.equal(hand(party({ scope: 'office' }), true, true, 'queue'), null);
  assert.match(hand(party({ scope: 'office', network: { accept: false } }), true, true)!, /does not take requests from other bots/);
  assert.match(hand(party({ scope: 'office' }), true, false)!, /not one this person can use/);
  assert.match(hand(party({ scope: 'office' }), true, true, 'nowhere')!, /no stage “nowhere”/);
  assert.match(hand(party({ scope: 'private' }), false, true)!, /private/);
});

test('loops and depth are stopped, with the path in the words', () => {
  assert.deepEqual(trailOf('a-bot>b-bot>Not valid'), ['a-bot', 'b-bot']);
  assert.equal(extendTrail(['a-bot'], 'b-bot'), 'a-bot>b-bot');
  assert.equal(extendTrail(['a-bot', 'b-bot'], 'b-bot'), 'a-bot>b-bot');
  assert.equal(loopRefusal([], 'a-bot', 'b-bot', 'B'), null);
  assert.match(loopRefusal(['a-bot'], 'b-bot', 'a-bot', 'A')!, /Stopped a loop: A already had this request \(a-bot → b-bot → a-bot\)/);
  assert.match(loopRefusal([], 'a-bot', 'a-bot', 'A')!, /Stopped a loop/);
  const deep = Array.from({ length: NET_MAX_DEPTH }, (_x, i) => `bot-${i}`);
  assert.match(loopRefusal(deep, `bot-${NET_MAX_DEPTH - 1}`, 'bot-z', 'Z')!, new RegExp(`${NET_MAX_DEPTH} bots at most`));
});

test('rate windows count per key and forget after a minute; slow answers time out', async () => {
  const r = new RateWindow();
  for (let i = 0; i < 3; i++) assert.ok(r.take('k', 3, 1000));
  assert.equal(r.take('k', 3, 1500), false);
  assert.ok(r.take('other', 3, 1500));
  assert.ok(r.take('k', 3, 61_001), 'a minute later it may again');
  const slow = await withTimeout(new Promise((res) => setTimeout(() => res(1), 200)), 20);
  assert.deepEqual(slow, { ok: false, timeout: true, error: 'timeout' });
  const fine = await withTimeout(Promise.resolve(2), 20);
  assert.deepEqual(fine, { ok: true, value: 2 });
  const broken = await withTimeout(Promise.reject(new Error('no')), 20);
  assert.deepEqual(broken, { ok: false, timeout: false, error: 'no' });
});
