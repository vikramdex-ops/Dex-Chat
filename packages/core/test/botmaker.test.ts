// The bot maker's shared rules: personas, voices and opening hours; templates that validate; a
// test run that behaves like the hub; and "describe it in words" with and without the model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BotFlowError, checkAnswer, checkPersona, hoursText, nextOpening, stepCard, validateFlow, voiceOf, withinHours } from '../src/botflow-engine.ts';
import { BOT_TEMPLATES, blankBot, describeAction, duplicateBot, monogram, slugify, testAnswer, testBack, testCancel, testStart } from '../src/botmaker.ts';
import { clausesOf, draftBot, listIn } from '../src/bot-describe.ts';
import type { BotFlowDefinition } from '../src/bots.ts';

const ME = { id: 'u1', name: 'Priya Raman', account: 'DEX\\priya' };
const people = [{ id: 'u2', name: 'Vikram Shah' }];
const ctx = { now: Date.now(), person: (v: string) => people.find((p) => p.id === v || p.name === v) ?? null, file: () => null };

test('personas: marks, colours, voices and hours are checked and tidied', () => {
  const p = checkPersona({ mark: { kind: 'monogram', letters: ' pr x' }, colour: 'nope', tone: 'shouty' });
  assert.deepEqual(p, { mark: { kind: 'monogram', letters: 'PR' }, colour: 'teal', tone: 'plain' });
  assert.throws(() => checkPersona({ mark: { kind: 'glyph', glyph: 'rocket' }, colour: 'teal', tone: 'plain' }), /symbol is one of/);
  assert.throws(() => checkPersona({ mark: { kind: 'monogram', letters: '' } }), /one or two letters/);
  assert.throws(() => checkPersona({ mark: { kind: 'glyph', glyph: 'stamp' }, hours: { days: [], from: '09:00', to: '18:00' } }), /at least one day/);
  assert.throws(() => checkPersona({ mark: { kind: 'glyph', glyph: 'stamp' }, hours: { days: [1], from: '9am', to: '18:00' } }), /times like 09:00/);
  const hours = { days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' };
  assert.equal(hoursText(hours), 'Mon–Fri 09:00–18:00');
  assert.equal(hoursText({ days: [1, 3], from: '10:00', to: '12:00' }), 'Mon, Wed 10:00–12:00');
  const wed10 = new Date(2026, 10, 18, 10, 0).getTime();
  const wed19 = new Date(2026, 10, 18, 19, 0).getTime();
  const fri19 = new Date(2026, 10, 20, 19, 0).getTime();
  assert.equal(withinHours(hours, wed10), true);
  assert.equal(withinHours(hours, wed19), false);
  assert.equal(withinHours(null, wed19), true);
  assert.equal(nextOpening(hours, wed19), '09:00 tomorrow');
  assert.equal(nextOpening(hours, fri19), '09:00 Mon');
  assert.equal(nextOpening(hours, new Date(2026, 10, 18, 7, 0).getTime()), '09:00 today');
});

test('the tone rewrites the bot\'s own phrases, never the author\'s questions', () => {
  const def = validateFlow({ ...BOT_TEMPLATES[0].definition, persona: { ...BOT_TEMPLATES[0].definition.persona, tone: 'formal' } });
  const step = def.steps.find((s) => s.id === 'size')!;
  assert.throws(() => checkAnswer(step, 'A9', { ...ctx, tone: 'formal' }), /Please select one of: A0, A1, A3/);
  assert.throws(() => checkAnswer(step, 'A9', { ...ctx, tone: 'brief' }), /^BotFlowError: One of: A0, A1, A3\.$|One of: A0, A1, A3\./);
  assert.throws(() => checkAnswer(step, '', { ...ctx, tone: 'warm' }), /Pick one of the options, please/);
  const card = stepCard(def, { step: 'job', history: [], answers: {}, vars: { 'user.first': { value: 'Priya', label: 'Priya' } } }, { fresh: true });
  assert.equal(card.prompt, 'Which job is it for?');
  assert.equal(card.intro, 'Good day, Priya. Plot request will take your request.');
  // confirm buttons left unworded take the tone's words
  const confirm = validateFlow({ name: 'x-y', title: 'X', persona: { mark: { kind: 'monogram', letters: 'X' }, tone: 'formal' }, steps: [{ id: 'ok', prompt: 'Send?', input: { kind: 'confirm' } }], finish: [] });
  const c = stepCard(confirm, { step: 'ok', history: [], answers: {}, vars: {} });
  assert.deepEqual([c.input.yes, c.input.no], ['Confirm', 'Amend']);
  for (const t of ['plain', 'warm', 'brief', 'formal'] as const) assert.ok(voiceOf(t).sameAsLast('A1').includes('A1'));
});

test('templates, blank bots and copies are valid bots as they stand', () => {
  assert.ok(BOT_TEMPLATES.length >= 5);
  for (const t of BOT_TEMPLATES) {
    const def = validateFlow(t.definition);
    assert.equal(def.name, t.id);
    assert.ok(def.persona, `${t.title} has an identity`);
    assert.ok(!def.finish.some((a) => a.do === 'webhook'), 'members cannot use webhooks, so templates do not');
    assert.ok(!def.command, 'commands are for office-wide bots');
    assert.ok(def.finish.every((a) => describeAction(a, def).length > 10));
  }
  validateFlow(blankBot('Model review'));
  assert.equal(slugify('RFI log: Pump house!'), 'rfi-log-pump-house');
  assert.equal(slugify('42 things'), 'bot-42-things');
  assert.equal(slugify('!'), 'my-bot');
  assert.equal(monogram('Drawing issue request'), 'DI');
  assert.equal(monogram('Plot'), 'PL');
  const copy = duplicateBot({ ...BOT_TEMPLATES[0].definition, command: 'plot', finish: [{ do: 'webhook' }] }, 'Plot request (Pune)');
  assert.equal(copy.name, 'plot-request-pune');
  assert.equal(copy.command, undefined);
  assert.ok(!copy.finish.some((a) => a.do === 'webhook'));
  validateFlow(copy);
});

test('a test run walks through a bot as a colleague would: checks, branches, Back, the end, and memory', () => {
  const def = validateFlow(BOT_TEMPLATES[0].definition);
  let t = testStart(def, ME);
  assert.equal(t.cards.length, 1);
  assert.equal(t.cards[0].card?.intro, 'Hi Priya! Plot request here. This only takes a minute.');
  assert.throws(() => testAnswer(t, 'job', 'twelve', ctx), BotFlowError);
  t = testAnswer(t, 'job', 'P-12513', ctx);
  assert.equal(t.cards[0].card?.state, 'answered');
  assert.equal(t.cards[1].card?.stepNo, 2);
  t = testAnswer(t, 'drawings', 'ISO-1001-01 rev C', ctx);
  t = testBack(t);
  assert.equal(t.step, 'drawings');
  assert.equal(t.cards[t.cards.length - 1].card?.previous?.value, 'ISO-1001-01 rev C', 'Back shows the earlier answer');
  t = testAnswer(t, 'drawings', 'GA-200 rev B', ctx);
  t = testAnswer(t, 'size', 'A1', ctx);
  t = testAnswer(t, 'sets', '2', ctx);
  const day = new Date(Date.now() + 86400_000);
  t = testAnswer(t, 'due', `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`, ctx);
  t = testAnswer(t, 'lead', 'u2', ctx);
  // "Change something" goes back to the start
  t = testAnswer(t, 'ok', 'no', ctx);
  assert.equal(t.step, 'job');
  t = testAnswer(t, 'job', 'P-12513', ctx);
  for (const [id, v] of [['drawings', 'GA-200 rev B'], ['size', 'A1'], ['sets', '2'], ['due', t.answers.due.value], ['lead', 'u2'], ['ok', 'yes']] as const) t = testAnswer(t, id, v, ctx);
  assert.equal(t.status, 'done');
  const done = t.cards[t.cards.length - 1].card!;
  assert.equal(done.kind, 'done');
  assert.match(done.notes?.[0] ?? '', /^Would put a task on Vikram Shah's Desk: Approve plot for P-12513: 2 × A1 for Priya Raman/);
  assert.equal(done.lines?.find((l) => l.label === 'Sheet size')?.value, 'A1');
  // the next test run offers last time's answers
  const again = testStart(def, ME, t.memory);
  assert.equal(again.cards[0].card?.lastTime?.value, 'P-12513');
  assert.equal(again.cards[0].card?.lastTimeWords, 'Same as last time? P-12513');
  const stopped = testCancel(again);
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.cards[stopped.cards.length - 1].card, null);
  assert.equal(stopped.cards[stopped.cards.length - 1].body, 'No problem, I have stopped. Nothing was sent.');
});

test('describe it in words: clauses, choices, kinds and the end, with keywords only', async () => {
  assert.deepEqual(listIn('the sheet size (A0, A1 or A3)'), ['A0', 'A1', 'A3']);
  assert.deepEqual(listIn('what type of leave: annual, sick or comp-off'), ['annual', 'sick', 'comp-off']);
  assert.ok(clausesOf('Ask for the job number, which drawings and the sheet size (A0, A1, A3). Then confirm.').length >= 4);
  const words = 'A friendly bot for plot requests. Ask for the job number, which drawings, the sheet size (A0, A1 or A3), how many sets and when they are needed. Then ask who approves it, confirm, and put a task on their Desk. Remember my answers.';
  const d = await draftBot(words, { spaces: [] });
  const def: BotFlowDefinition = d.definition;
  assert.equal(def.title, 'Plot request');
  assert.equal(def.name, 'plot-request');
  assert.equal(def.persona?.tone, 'warm');
  assert.equal(def.persona?.remember, true);
  assert.equal(def.persona?.mark.glyph, 'plotter');
  const kinds = def.steps.map((s) => (s.input.validate?.type ?? s.input.kind));
  assert.deepEqual(kinds, ['regex', 'text', 'choice', 'number', 'date', 'person', 'confirm']);
  assert.deepEqual(def.steps[2].input.options?.map((o) => o.label), ['A0', 'A1', 'A3']);
  assert.equal(def.steps[3].prompt, 'How many sets?');
  assert.equal(def.steps[6].branches?.[0].goto, def.steps[0].id, 'No goes back to the first question');
  assert.equal(def.finish[0].do, 'task');
  assert.equal(d.method, 'keywords');
  validateFlow(def);

  // posts go to a Space the person is in when it is named; a reminder uses the date asked for
  const rfi = await draftBot('An RFI log bot. Ask which drawing, the question, and the date the answer is needed by. Post it in Piping desk and remind me on that day.', { spaces: [{ id: 's1', name: 'Piping desk' }] });
  assert.ok(rfi.definition.finish.some((a) => a.do === 'post' && a.to === 'space:Piping desk'));
  const remind = rfi.definition.finish.find((a) => a.do === 'remind');
  assert.ok(remind && 'due' in remind && remind.due, 'the reminder is due on the date step');
  assert.equal(rfi.definition.persona?.mark.glyph, 'rfi');
  // nothing usable: one open question, and a note saying so
  const empty = await draftBot('hello', { spaces: [] });
  assert.equal(empty.definition.steps.length, 1);
  assert.ok(empty.notes.some((n) => /No questions/.test(n)));
});

test('describe it in words: the sentence model is blended in when it answers, and ignored when it fails', async () => {
  const words = 'A bot for model review bookings. Ask the area of the model and who chairs it.';
  const rank = async (_c: string, cands: Array<{ kind: string }>) => cands.map((c) => (c.kind === 'choice' ? 0.9 : 0.1));
  const d = await draftBot(words, { spaces: [] }, rank);
  assert.equal(d.method, 'model');
  // "who chairs it" stays a person: the keyword cue outweighs the model's guess
  assert.equal(d.definition.steps.find((s) => /chair/i.test(s.prompt))?.input.kind, 'person');
  const broken = async () => { throw new Error('no model'); };
  const k = await draftBot(words, { spaces: [] }, broken);
  assert.equal(k.definition.steps.find((s) => /chair/i.test(s.prompt))?.input.kind, 'person');
});

test('problems are placed beside the step or end action that causes them, all at once, in plain words', async () => {
  const { problemsOf } = await import('../src/botmaker.ts');
  const good = BOT_TEMPLATES[0].definition;
  assert.equal(problemsOf(good).count, 0);
  const bad: BotFlowDefinition = {
    ...good,
    steps: [
      { ...good.steps[0], prompt: '' },
      { ...good.steps[1] },
      { ...good.steps[2], input: { kind: 'choice', options: [{ value: 'A1', label: 'A1' }] } },
      { ...good.steps[3], branches: [{ if: { equals: '2' }, goto: 'gone' }] },
      ...good.steps.slice(4),
    ],
    finish: [{ do: 'task', assignee: 'size', text: 'x' }, { do: 'post', to: 'origin', text: '' }],
  };
  const p = problemsOf(bad);
  assert.deepEqual(p.steps.job, ['Write the question.']);
  assert.match(p.steps.size[0], /at least two options/);
  assert.match(p.steps.sets[0], /goes to "gone", which is not a step any more/);
  assert.equal(p.steps.drawings, undefined);
  assert.deepEqual(p.finish[0], ['Choose which answer names the person who gets the task.']);
  assert.deepEqual(p.finish[1], ['Write what it posts.']);
  assert.equal(p.count, 5);
  assert.deepEqual(problemsOf({ ...good, title: '' }).general, ['Give the bot a name.']);
});
