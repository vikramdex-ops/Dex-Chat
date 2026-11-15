// Decisions: the builder's rules (options, labels, depth), each person's own path, closing, the
// author's results, and the Automations event when someone reaches an end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DecisionStepInput, FlowRun, Message } from '@dex/core';
import { createIdentity } from '@dex/core';
import { HubClient } from '@dex/core/client';
import { buildDecisionTree, DecisionError } from '../src/decisions.ts';
import { cleanups, office, me, nextClientId, nextEvent, until } from './office.ts';

const approval: DecisionStepInput = {
  prompt: 'Issue the pump skid GA for construction?', kind: 'choice', options: [
    { label: 'Approved', note: 'Send the drawings to site by Friday.' },
    { label: 'Needs changes', next: { prompt: 'Which part?', kind: 'choice', options: [
      { label: 'Nozzle loads' },
      { label: 'Something else', next: { prompt: 'Describe it', kind: 'text' } },
    ] } },
    { label: 'Rejected', next: { prompt: 'Why?', kind: 'text' } },
  ],
};

/** A chain of choice steps n deep (each step: one option closes, one goes deeper). */
function chain(n: number): DecisionStepInput {
  const step = (i: number): DecisionStepInput => ({ prompt: `Level ${i}`, kind: 'choice', options: [{ label: 'Stop' }, i < n ? { label: 'Deeper', next: step(i + 1) } : { label: 'Done' }] });
  return step(1);
}

const runsOf = async (c: HubClient, id: string): Promise<FlowRun[]> => c.request('flow.runs', { id });

test('the builder checks questions, options and labels, and gives every step and option an id', () => {
  const t = buildDecisionTree(approval);
  assert.equal(t.id, 's1');
  assert.deepEqual(t.options.map((o) => [o.id, o.label, o.closes]), [['s1.1', 'Approved', true], ['s1.2', 'Needs changes', false], ['s1.3', 'Rejected', false]]);
  assert.equal(t.options[0].note, 'Send the drawings to site by Friday.');
  assert.equal(t.options[1].next?.id, 's2');
  assert.equal(t.options[1].next?.options[1].next?.kind, 'text');
  assert.equal(t.options[1].next?.options[1].next?.depth, 3);
  const bad: Array<[unknown, RegExp]> = [
    [{ prompt: '', kind: 'choice', options: [{ label: 'A' }, { label: 'B' }] }, /Ask a question/],
    [{ prompt: 'One?', kind: 'choice', options: [{ label: 'A' }] }, /at least two options/],
    [{ prompt: 'Same?', kind: 'choice', options: [{ label: 'Yes' }, { label: 'yes' }] }, /twice/],
    [{ prompt: 'Blank?', kind: 'choice', options: [{ label: 'A' }, { label: '  ' }] }, /needs a label/],
    [{ prompt: 'Many?', kind: 'choice', options: 'ABCDEFG'.split('').map((label) => ({ label })) }, /up to 6 options/],
    [{ prompt: 'Write', kind: 'text' }, /Start with a question that has options/],
    [{ prompt: 'Then?', kind: 'choice', options: [{ label: 'A', next: { prompt: '', kind: 'text' } }, { label: 'B' }] }, /needs a question/],
    [null, /missing/],
  ];
  for (const [input, re] of bad) assert.throws(() => buildDecisionTree(input), (e: unknown) => e instanceof DecisionError && re.test(e.message), String(re));
  // a note only belongs to an option that closes
  const t2 = buildDecisionTree({ prompt: 'Q', kind: 'choice', options: [{ label: 'A', note: 'kept' }, { label: 'B', note: 'dropped', next: { prompt: 'Why', kind: 'text' } }] });
  assert.equal(t2.options[0].note, 'kept');
  assert.equal(t2.options[1].note, null);
});

test('a Decision goes at most four steps deep', () => {
  assert.equal(buildDecisionTree(chain(4)).options[1].next?.options[1].next?.options[1].next?.depth, 4);
  assert.throws(() => buildDecisionTree(chain(5)), /4 steps deep/);
  // a written answer as a fifth step is too deep as well
  const four = chain(4);
  four.options![1].next!.options![1].next!.options![1].next!.options![1] = { label: 'Explain', next: { prompt: 'Explain', kind: 'text' } };
  assert.throws(() => buildDecisionTree(four), /4 steps deep/);
});

test('each person walks their own path; the author sees where everyone is', async () => {
  const { owner, priya, ravi } = await office();
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Pump skid', members: [me(priya), me(ravi)] });
  const msg = await owner.request('decision.create', { convId: sp.id, root: approval, clientId: nextClientId() });
  assert.equal(msg.body, 'Decision: Issue the pump skid GA for construction?');
  assert.equal(msg.decision?.tree?.id, 's1', 'the author has the whole tree');
  assert.equal(msg.decision?.current?.id, 's1');
  // everyone else sees only the step in front of them
  const seen = (await priya.request('msg.get', { messageId: msg.id })).decision!;
  assert.equal(seen.tree, null);
  assert.deepEqual(seen.current?.options.map((o) => [o.label, o.closes]), [['Approved', true], ['Needs changes', false], ['Rejected', false]]);
  assert.equal(JSON.stringify(seen).includes('Nozzle loads'), false, 'follow-up steps stay hidden until reached');

  // Priya: Needs changes → Something else → a written answer
  const updated = nextEvent<Message>(ravi, 'msg.updated', (m) => m.id === msg.id && m.decision?.started === 1);
  let p = await priya.request('decision.answer', { messageId: msg.id, stepId: 's1', optionId: 's1.2' });
  assert.equal(p.decision?.current?.prompt, 'Which part?');
  assert.equal(p.decision?.done, false);
  const forRavi = await updated;
  assert.equal(forRavi.decision?.started, 1);
  assert.equal(forRavi.decision?.trail.length, 0, 'an update carries each person their own path');
  await assert.rejects(priya.request('decision.answer', { messageId: msg.id, stepId: 's1', optionId: 's1.1' }), /no longer the one in front of you/);
  await assert.rejects(priya.request('decision.answer', { messageId: msg.id, stepId: 's2', optionId: 's1.1' }), /Choose one of the options/);
  p = await priya.request('decision.answer', { messageId: msg.id, stepId: 's2', optionId: 's2.2' });
  assert.equal(p.decision?.current?.kind, 'text');
  await assert.rejects(priya.request('decision.answer', { messageId: msg.id, stepId: 's3', text: '   ' }), /Write an answer/);
  p = await priya.request('decision.answer', { messageId: msg.id, stepId: 's3', text: 'The platform clashes with the cable tray' });
  assert.equal(p.decision?.done, true);
  assert.equal(p.decision?.current, null);
  assert.equal(p.decision?.outcome, 'Something else');
  assert.deepEqual(p.decision?.trail.map((t) => t.optionId ?? t.text), ['s1.2', 's2.2', 'The platform clashes with the cable tray']);
  await assert.rejects(priya.request('decision.answer', { messageId: msg.id, stepId: 's1', optionId: 's1.1' }), /reached the end/);

  // Ravi: Approved, with the closing note
  const r = await ravi.request('decision.answer', { messageId: msg.id, stepId: 's1', optionId: 's1.1' });
  assert.equal(r.decision?.outcome, 'Approved');
  assert.equal(r.decision?.note, 'Send the drawings to site by Friday.');
  assert.equal(r.decision?.finished, 2);

  // only the author (or an administrator) sees everyone's answers
  await assert.rejects(priya.request('decision.results', { messageId: msg.id }), /Only the person who started/);
  const res = await owner.request('decision.results', { messageId: msg.id });
  assert.equal(res.people.length, 2);
  const pr = res.people.find((x) => x.userId === me(priya))!;
  assert.deepEqual(pr.steps.map((s) => s.answer), ['Needs changes', 'Something else', 'The platform clashes with the cable tray']);
  assert.equal(pr.steps[2].text, 'The platform clashes with the cable tray');
  assert.equal(res.counts['s1.1'], 1);
  assert.equal(res.counts['s1.2'], 1);
  assert.equal(res.counts['s1.3'], 0);
  assert.deepEqual(res.notStarted, []);

  // starting again clears only your own path
  const again = await priya.request('decision.reset', { messageId: msg.id });
  assert.equal(again.decision?.current?.id, 's1');
  assert.equal(again.decision?.trail.length, 0);
  assert.equal(again.decision?.finished, 1);
  assert.equal((await ravi.request('msg.get', { messageId: msg.id })).decision?.done, true);

  // closing: no more answers; only the author closes it
  await assert.rejects(ravi.request('decision.close', { messageId: msg.id }), /Only the person who started/);
  const closed = await owner.request('decision.close', { messageId: msg.id });
  assert.equal(closed.decision?.closed, true);
  await assert.rejects(priya.request('decision.answer', { messageId: msg.id, stepId: 's1', optionId: 's1.1' }), /closed/);
  assert.equal((await priya.request('msg.get', { messageId: msg.id })).decision?.current, null);
});

test('outsiders cannot see or answer a Decision; guests cannot start one', async () => {
  const { hub, owner, priya, ravi } = await office();
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Leads', private: true, members: [me(priya)] });
  const msg = await owner.request('decision.create', { convId: sp.id, root: approval, clientId: nextClientId() });
  await assert.rejects(ravi.request('decision.answer', { messageId: msg.id, stepId: 's1', optionId: 's1.1' }), /Decision not found/);
  await assert.rejects(ravi.request('decision.results', { messageId: msg.id }), /Decision not found/);
  await assert.rejects(ravi.request('decision.create', { convId: sp.id, root: approval }), /Conversation not found/);
  await assert.rejects(owner.request('decision.create', { convId: sp.id, root: chain(5) }), /4 steps deep/);
  // a guest in the Space can answer, but not start one
  const client = await owner.request('conv.create', { kind: 'space', name: 'Client P-12', members: [] });
  const inv = await owner.request('admin.guests.invite', { spaceIds: [client.id], accessDays: 30, validDays: 7, uses: 1 });
  const guest = new HubClient({ identity: createIdentity(), account: { username: 'ana', domain: 'CLIENTCO', displayName: 'Ana Client', hostname: 'ANA-LAPTOP' } });
  cleanups.push(() => guest.disconnect());
  guest.setInvite(inv.code);
  guest.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
  await until(guest, (st) => st.kind === 'ready');
  await assert.rejects(guest.request('decision.create', { convId: client.id, root: approval }), /Guests cannot start/);
  const asked = await owner.request('decision.create', { convId: client.id, root: approval, clientId: nextClientId() });
  assert.equal((await guest.request('decision.answer', { messageId: asked.id, stepId: 's1', optionId: 's1.1' })).decision?.outcome, 'Approved');
  // a deleted Decision stops answering
  await owner.request('msg.delete', { messageId: msg.id });
  await assert.rejects(priya.request('decision.answer', { messageId: msg.id, stepId: 's1', optionId: 's1.1' }), /Decision not found/);
});

test('reaching an end confirms a response for Automations, with the choice and the path', async () => {
  const { hub, owner, priya, ravi } = await office();
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Approvals', members: [me(priya), me(ravi)] });
  const events: Array<{ kind: string; source?: string; choice?: string; userId?: string; answers?: unknown }> = [];
  const was = hub.messaging.observe;
  hub.messaging.observe = (e) => { events.push(e as never); was?.(e); };
  const msg = await owner.request('decision.create', { convId: sp.id, root: approval, clientId: nextClientId() });
  const rule = await owner.request('flow.save', { convId: sp.id, name: 'Approved', graph: {
    trigger: { id: 't1', kind: 'response.confirmed', source: 'decision', choice: 'Approved' },
    conditions: [],
    actions: [{ id: 'a1', kind: 'task', mode: 'reminder', to: [{ kind: 'role', id: 'actor' }], text: 'Send to site ({{response.choice}})', dueInMinutes: 60 }],
  } });
  // a step that does not close confirms nothing
  await priya.request('decision.answer', { messageId: msg.id, stepId: 's1', optionId: 's1.3' });
  assert.equal(events.filter((e) => e.kind === 'response.confirmed').length, 0);
  await priya.request('decision.answer', { messageId: msg.id, stepId: 's4', text: 'Wrong revision' });
  await ravi.request('decision.answer', { messageId: msg.id, stepId: 's1', optionId: 's1.1' });
  const confirmed = events.filter((e) => e.kind === 'response.confirmed');
  assert.deepEqual(confirmed.map((e) => [e.source, e.choice]), [['decision', 'Rejected'], ['decision', 'Approved']]);
  assert.deepEqual(confirmed[0].answers, { path: 'Rejected › Wrong revision', answer: 'Wrong revision' });
  await hub.flows.idle();
  const runs = await runsOf(owner, rule.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].event, 'Ravi reached “Approved” in a Decision in Approvals');
  const rem = await ravi.request('remind.list');
  assert.equal(rem.length, 1);
  assert.equal(rem[0].text, 'Send to site (Approved)');
  assert.equal((await priya.request('remind.list')).length, 0);
});
