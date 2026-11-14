import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message, Note } from '@dex/core';
import { office, nextEvent, me, nextClientId } from './office.ts';

test('forms: questions, validation, one answer per person, responses for the creator', async () => {
  const { owner, priya, ravi } = await office();
  const space = await owner.request('conv.create', { kind: 'space', name: 'HR', members: [me(priya), me(ravi)] });
  await assert.rejects(owner.request('form.create', { convId: space.id, title: 'Trip', fields: [{ label: 'Pick', type: 'choice', options: ['A'], required: true }], clientId: nextClientId() }), /two choices/);
  const m = await owner.request('form.create', {
    convId: space.id, title: 'Site trip sign-up', description: 'Bus leaves 7am', clientId: nextClientId(),
    fields: [
      { label: 'Coming?', type: 'choice', options: ['Yes', 'No'], required: true },
      { label: 'Meals', type: 'multi', options: ['Veg', 'Non-veg', 'Jain'], required: false },
      { label: 'Phone', type: 'text', required: false },
      { label: 'Seats needed', type: 'number', required: false },
    ],
  });
  const form = m.form!;
  assert.equal(form.fields.length, 4);
  await assert.rejects(priya.request('form.respond', { formId: form.id, answers: {} }), /required/);
  await assert.rejects(priya.request('form.respond', { formId: form.id, answers: { q1: 'Maybe' } }), /Choose one/);
  await assert.rejects(priya.request('form.respond', { formId: form.id, answers: { q1: 'Yes', q4: 'two' } }), /number/);
  const seen = nextEvent<Message>(owner, 'msg.updated', (x) => x.id === m.id && (x.form?.responses ?? 0) > 0);
  const r = await priya.request('form.respond', { formId: form.id, answers: { q1: 'Yes', q2: ['Veg', 'Bogus'], q4: '2' } });
  assert.deepEqual(r.form?.mine, { q1: 'Yes', q2: ['Veg'], q4: '2' });
  assert.equal((await seen).form?.mine, null, "the creator's view has no answers of their own");
  await priya.request('form.respond', { formId: form.id, answers: { q1: 'No' } }); // changes her answer
  await ravi.request('form.respond', { formId: form.id, answers: { q1: 'Yes' } });
  await assert.rejects(ravi.request('form.responses', { formId: form.id }), /Only the person/);
  const all = await owner.request('form.responses', { formId: form.id });
  assert.equal(all.responses.length, 2);
  assert.equal(all.responses.find((x) => x.userId === me(priya))?.answers.q1, 'No');
  await owner.request('form.close', { formId: form.id });
  await assert.rejects(ravi.request('form.respond', { formId: form.id, answers: { q1: 'No' } }), /closed/);
});

test('notes: personal and shared, live updates, no lost edits', async () => {
  const { owner, priya, ravi } = await office();
  const space = await owner.request('conv.create', { kind: 'space', name: 'Notes', members: [me(priya)] });
  const mine = await ravi.request('note.save', { title: 'My list', body: '- buy pens' });
  assert.equal(mine.convId, null);
  await assert.rejects(owner.request('note.get', { id: mine.id }), /not found/);
  const live = nextEvent<Note>(priya, 'note.updated');
  const shared = await owner.request('note.save', { convId: space.id, title: 'Site checklist', body: '# Checklist\n- PPE' });
  assert.equal((await live).id, shared.id);
  const p = await priya.request('note.save', { id: shared.id, title: 'Site checklist', body: '# Checklist\n- PPE\n- Torch', baseVersion: 1 });
  assert.equal(p.version, 2);
  // Vikram still has version 1 open: his save is refused instead of overwriting Priya's
  await assert.rejects(owner.request('note.save', { id: shared.id, title: 'x', body: 'old', baseVersion: 1 }), /CONFLICT/);
  assert.equal((await owner.request('note.list', { convId: space.id }))[0].preview, 'Checklist PPE Torch');
  await assert.rejects(ravi.request('note.list', { convId: space.id }), /not found/);
  await assert.rejects(priya.request('note.delete', { id: shared.id }), /Only the person/);
  await owner.request('note.delete', { id: shared.id });
  assert.equal((await priya.request('note.list', { convId: space.id })).length, 0);
});

test('whiteboards: live drawing relayed to the conversation, replay, erase and clear', async () => {
  const { owner, priya, ravi } = await office();
  const space = await owner.request('conv.create', { kind: 'space', name: 'Boards', members: [me(priya)] });
  const b = await owner.request('board.create', { convId: space.id, title: 'Layout sketch' });
  await assert.rejects(ravi.request('board.open', { boardId: b.id }), /not found/);
  const got = nextEvent<{ boardId: string; op: { t: string } }>(priya, 'board.op');
  await owner.request('board.draw', { boardId: b.id, op: { t: 'stroke', id: 's1', color: '#ff0000', width: 4, points: [0, 0, 10, 10, 20, 5] } });
  assert.equal((await got).op.t, 'stroke');
  await priya.request('board.draw', { boardId: b.id, op: { t: 'shape', id: 'r1', shape: 'rect', color: '#00aa00', width: 2, x1: 5, y1: 5, x2: 50, y2: 40 } });
  await priya.request('board.draw', { boardId: b.id, op: { t: 'text', id: 't1', color: '#000000', x: 10, y: 60, size: 18, text: 'Pump P-101' } });
  await assert.rejects(priya.request('board.draw', { boardId: b.id, op: { t: 'stroke', id: 's2', points: [1] } as never }), /Bad drawing/);
  await priya.request('board.draw', { boardId: b.id, op: { t: 'erase', ids: ['s1'] } });
  await assert.rejects(ravi.request('board.list', { convId: space.id }), /not found/);
  const replay = await owner.request('board.open', { boardId: b.id });
  assert.deepEqual(replay.ops.map((o) => o.op.t), ['stroke', 'shape', 'text', 'erase']);
  await owner.request('board.draw', { boardId: b.id, op: { t: 'clear' } });
  assert.deepEqual((await priya.request('board.open', { boardId: b.id })).ops.map((o) => o.op.t), []);
});
