// Bots members make for themselves: who may make, see, start, change and review them; revisions
// that leave runs in progress alone; pausing; remembered answers; opening hours and the bot's voice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BotFlowCard, BotFlowDefinition, Message } from '@dex/core';
import type { HubClient } from '@dex/core/client';
import { office, me } from './office.ts';

const cards = async (c: HubClient, convId: string): Promise<Array<Message & { botflow: BotFlowCard }>> =>
  (await c.request('msg.list', { convId, limit: 200 })).messages.filter((m): m is Message & { botflow: BotFlowCard } => !!m.botflow);
const current = async (c: HubClient, convId: string) => {
  for (let i = 0; i < 100; i++) {
    const list = (await cards(c, convId)).filter((m) => m.botflow.state === 'active' && m.botflow.kind === 'step');
    if (list.length === 1) return list[0].botflow;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('no single active card');
};

const PLOT: BotFlowDefinition = {
  name: 'plot-desk',
  title: 'Plot desk',
  description: 'Ask for a plot.',
  persona: { mark: { kind: 'glyph', glyph: 'plotter' }, colour: 'rust', tone: 'warm', greeting: 'Hi {{user.first}}, plots this way.', remember: true },
  steps: [
    { id: 'size', label: 'Sheet size', prompt: 'Which size?', input: { kind: 'choice', options: [{ value: 'A1', label: 'A1' }, { value: 'A3', label: 'A3' }] } },
    { id: 'sets', label: 'Sets', prompt: 'How many sets?', input: { kind: 'text', validate: { type: 'number', integer: true, min: 1, max: 9 }, suggestions: ['1', '2'] } },
    { id: 'ok', prompt: 'Send it?\n{{summary}}', input: { kind: 'confirm' } },
  ],
  finish: [{ do: 'remind', text: 'Collect {{sets}} × {{size}}', dueInDays: 1 }],
};

test('a member makes a private bot: theirs only; shared with a Space: its people only; office-wide: after review', async () => {
  const { owner, priya, ravi } = await office();
  // permissions on what a member's bot may do
  await assert.rejects(priya.request('botflow.make', { definition: { ...PLOT, finish: [{ do: 'webhook' }] }, scope: 'private' }), /Only administrators can call a webhook/);
  await assert.rejects(priya.request('botflow.make', { definition: { ...PLOT, command: 'plotme' }, scope: 'private' }), /slash command is for office-wide/);
  await owner.request('conv.create', { kind: 'space', name: 'Plot room', members: [me(ravi)] });
  await assert.rejects(priya.request('botflow.make', { definition: { ...PLOT, finish: [{ do: 'post', to: 'space:Plot room', text: 'x' }] }, scope: 'private' }), /only if you are in that Space/);

  const made = await priya.request('botflow.make', { definition: PLOT, scope: 'private' });
  assert.equal(made.scope, 'private');
  assert.equal(made.ownerId, me(priya));
  assert.equal(made.version, 1);
  assert.equal(made.botName, 'Plot desk', 'the bot speaks with its own name');
  assert.ok(!(await owner.request('admin.bots')).some((b) => b.bot.id === made.botId), 'it is not listed as an integration');
  assert.ok((await priya.request('botflow.list')).some((f) => f.name === 'plot-desk'));
  assert.ok(!(await ravi.request('botflow.list')).some((f) => f.name === 'plot-desk'), 'a private bot is not listed for others');
  await assert.rejects(ravi.request('botflow.start', { flow: 'plot-desk' }), /not available/);
  await assert.rejects(ravi.request('botflow.make', { definition: { ...PLOT, title: 'Mine now' }, scope: 'private' }), /Another bot already uses that name/);
  await assert.rejects(ravi.request('botflow.stats', { name: 'plot-desk' }), /Only the person who made/);
  await assert.rejects(ravi.request('botflow.status', { name: 'plot-desk', status: 'paused' }), /Only the person who made/);
  await assert.rejects(ravi.request('botflow.definition', { name: 'plot-desk' }), /not found/);
  // a new bot whose short name is taken gets the next free one
  const theirs = await ravi.request('botflow.make', { definition: { ...PLOT, title: 'Plot desk' }, scope: 'private', newBot: true });
  assert.equal(theirs.name, 'plot-desk-2');
  await ravi.request('botflow.delete', { name: 'plot-desk-2' });
  // marks are public (they draw the bot's tile in conversations), its definition is not
  assert.ok((await ravi.request('botflow.marks')).some((m) => m.botId === made.botId && m.mark.glyph === 'plotter'));

  // shared with a Space she is in: its people can start it, others cannot; the Space gets a Start card
  const space = await priya.request('conv.create', { kind: 'space', name: 'Piping desk', members: [me(ravi)] });
  await assert.rejects(priya.request('botflow.make', { definition: PLOT, scope: 'space', spaceId: 'nope' }), /Choose a Space you are in/);
  const shared = await priya.request('botflow.make', { definition: PLOT, scope: 'space', spaceId: space.id, baseVersion: 1 });
  assert.equal(shared.scope, 'space');
  assert.equal(shared.version, 2);
  const offer = (await cards(ravi, space.id)).find((m) => m.botflow.kind === 'offer');
  assert.ok(offer, 'the Space gets a card with a Start button');
  assert.ok((await ravi.request('botflow.list')).some((f) => f.name === 'plot-desk'));
  assert.ok(!(await owner.request('botflow.list')).some((f) => f.name === 'plot-desk'), 'not for people outside the Space');
  // a stale editor cannot overwrite a newer revision
  await assert.rejects(priya.request('botflow.make', { definition: PLOT, scope: 'space', spaceId: space.id, baseVersion: 1 }), /saved elsewhere/);

  // office-wide: asked of an administrator; until then it stays with the Space
  const asked = await priya.request('botflow.make', { definition: PLOT, scope: 'office', baseVersion: 2 });
  assert.equal(asked.requested, 'office');
  assert.equal(asked.scope, 'space');
  const audit = await owner.request('admin.audit');
  assert.ok(audit.some((a: { action: string }) => a.action === 'botflow.requested'));
  await assert.rejects(priya.request('admin.botflows.review', { name: 'plot-desk', approve: true }), /Only administrators/);
  // turned down, with a note she can read
  await owner.request('admin.botflows.review', { name: 'plot-desk', approve: false, note: 'Use the Plot room Space instead.' });
  const mine1 = (await priya.request('botflow.mine')).find((b) => b.name === 'plot-desk')!;
  assert.equal(mine1.requested, null);
  assert.equal(mine1.review?.approved, false);
  assert.equal(mine1.review?.note, 'Use the Plot room Space instead.');
  // asked again and approved: everyone can start it
  await priya.request('botflow.make', { definition: PLOT, scope: 'office' });
  const ok = await owner.request('admin.botflows.review', { name: 'plot-desk', approve: true, note: 'Fine' });
  assert.equal(ok.scope, 'office');
  assert.ok((await owner.request('botflow.list')).some((f) => f.name === 'plot-desk'));
  assert.ok((await owner.request('admin.audit')).some((a: { action: string }) => a.action === 'botflow.approved'));

  // a member's change to an office-wide bot waits for review; people keep the approved revision
  const changed = { ...PLOT, steps: PLOT.steps.map((s) => (s.id === 'size' ? { ...s, prompt: 'Which sheet size, please?' } : s)) };
  const pend = await priya.request('botflow.make', { definition: changed, scope: 'office' });
  assert.equal(pend.requested, 'office');
  assert.ok(pend.pendingVersion && pend.pendingVersion > pend.version);
  assert.equal(pend.definition.steps[0].prompt, 'Which sheet size, please?', 'its maker edits the newest revision');
  const r = await ravi.request('botflow.start', { flow: 'plot-desk' });
  assert.equal((await current(ravi, r.convId)).prompt, 'Which size?');
  const list = await owner.request('admin.botflows.list');
  assert.equal(list.find((f) => f.name === 'plot-desk')?.pending?.steps[0].prompt, 'Which sheet size, please?');
});

test('revisions: an edit does not change a run in progress; pausing stops new runs only; the bot remembers and speaks in its voice', async () => {
  const { priya, ravi } = await office();
  await priya.request('botflow.make', { definition: PLOT, scope: 'private' });
  // a run on revision 1, halfway
  const run = await priya.request('botflow.start', { flow: 'plot-desk' });
  let card = await current(priya, run.convId);
  assert.equal(card.intro, 'Hi Priya, plots this way.', 'the greeting addresses her by name');
  assert.equal(card.persona?.mark.glyph, 'plotter');
  await priya.request('botflow.answer', { sessionId: run.sessionId, stepId: 'size', value: 'A1' });
  card = await current(priya, run.convId);
  assert.equal(card.stepId, 'sets');
  assert.deepEqual(card.input?.suggestions, ['1', '2'], 'quick replies reach the card');
  // the warm voice words the refusals
  await assert.rejects(priya.request('botflow.answer', { sessionId: run.sessionId, stepId: 'sets', value: '' }), /Could you write an answer first/);

  // revision 2 drops the sets step and changes the question
  const v2: BotFlowDefinition = { ...PLOT, steps: [{ ...PLOT.steps[0], prompt: 'Size?' }, PLOT.steps[2]] };
  await priya.request('botflow.make', { definition: v2, scope: 'private' });
  await priya.request('botflow.answer', { sessionId: run.sessionId, stepId: 'sets', value: '2' });
  card = await current(priya, run.convId);
  assert.equal(card.stepId, 'ok', 'the run carries on with the steps it started with');
  assert.equal(card.input?.yes, 'Yes, please', 'confirm buttons are worded by the tone');
  await priya.request('botflow.answer', { sessionId: run.sessionId, stepId: 'ok', value: 'yes' });
  const done = (await cards(priya, run.convId)).filter((m) => m.botflow.kind === 'done').pop()!;
  assert.match(done.body, /All done\. Thanks/, 'the closing line in the warm voice');
  assert.match(done.botflow.notes?.join(' ') ?? '', /reminder is on your Desk/);
  const reminders = await priya.request('remind.list');
  assert.ok(reminders.some((x: { text: string }) => x.text === 'Collect 2 × A1'));

  // a new run uses revision 2, and offers last time's answer
  const again = await priya.request('botflow.start', { flow: 'plot-desk' });
  card = await current(priya, again.convId);
  assert.equal(card.prompt, 'Size?');
  assert.equal(card.lastTime?.value, 'A1');
  assert.equal(card.lastTimeWords, 'Same as last time? A1');
  await priya.request('botflow.forget', { name: 'plot-desk' });
  await priya.request('botflow.resume', { sessionId: again.sessionId, over: true });
  card = await current(priya, again.convId);
  assert.equal(card.lastTime, undefined, 'forgotten on request');

  // paused: no new runs, but the one in progress may finish
  await priya.request('botflow.status', { name: 'plot-desk', status: 'paused' });
  await priya.request('botflow.answer', { sessionId: again.sessionId, stepId: 'size', value: 'A3' });
  await assert.rejects(priya.request('botflow.start', { flow: 'plot-desk' }), /paused/);
  await priya.request('botflow.answer', { sessionId: again.sessionId, stepId: 'ok', value: 'yes' });
  await priya.request('botflow.status', { name: 'plot-desk', status: 'live' });

  // where people stop, and who ran it (finished runs only)
  const third = await priya.request('botflow.start', { flow: 'plot-desk' });
  await priya.request('botflow.cancel', { sessionId: third.sessionId });
  const stats = await priya.request('botflow.stats', { name: 'plot-desk' });
  assert.equal(stats.runs, 3);
  assert.equal(stats.finished, 2);
  assert.equal(stats.cancelled, 1);
  assert.equal(stats.steps.find((s) => s.id === 'size')?.stopped, 1);
  assert.equal(stats.recent[0].userId, null, 'who stopped is not shown');
  assert.equal(stats.recent[1].userId, me(priya));
  assert.deepEqual(stats.versions.map((v) => v.version), [2, 1]);

  // retired and deleted
  await priya.request('botflow.status', { name: 'plot-desk', status: 'retired' });
  await assert.rejects(priya.request('botflow.start', { flow: 'plot-desk' }), /retired/);
  await assert.rejects(ravi.request('botflow.delete', { name: 'plot-desk' }), /not found|Only the person/);
  await priya.request('botflow.delete', { name: 'plot-desk' });
  assert.equal((await priya.request('botflow.mine')).length, 0);
});

test('opening hours: outside them a bot says when it is back, in its voice', async () => {
  const { priya } = await office();
  const tomorrow = (new Date().getDay() + 1) % 7;
  const def = { ...PLOT, name: 'after-hours', persona: { ...PLOT.persona!, tone: 'formal' as const, hours: { days: [tomorrow], from: '00:00', to: '23:59' } } };
  const made = await priya.request('botflow.make', { definition: def, scope: 'private' });
  assert.equal(made.openNow, false);
  await assert.rejects(priya.request('botflow.start', { flow: 'after-hours' }), /accepts requests .* Please return at 00:00 tomorrow/);
  await assert.rejects(priya.request('botflow.make', { definition: { ...def, persona: { ...def.persona, hours: { days: [1], from: '18:00', to: '09:00' } } }, scope: 'private' }), /close after it opens/);
});
