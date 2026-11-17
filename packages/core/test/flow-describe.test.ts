import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clauses, draftFlow, timeCondition } from '../src/flow-describe.ts';
import type { DescribeContext, Ranker } from '../src/flow-describe.ts';
import { validateGraph } from '../src/flows.ts';
import type { FlowGraph } from '../src/flows.ts';

const ctx: DescribeContext = {
  meId: 'ME', convId: null,
  conversations: [
    { id: 'C_DESIGN', name: 'Design', kind: 'space' }, { id: 'C_PIPING', name: 'Piping P-12', kind: 'space' },
    { id: 'C_OFFICE', name: 'Office', kind: 'space' }, { id: 'C_SITE', name: 'Site updates', kind: 'space' },
    { id: 'C_DM', name: 'Ravi', kind: 'direct' },
  ],
  people: [{ id: 'U_PRIYA', name: 'Priya Raman', account: 'dex\\priya' }, { id: 'U_RAVI', name: 'Ravi Kumar', account: 'dex\\ravi' }, { id: 'ME', name: 'Vikram Shah', account: 'dex\\vikram' }],
  groups: [{ id: 'G_DOCREV', name: 'Document Review' }, { id: 'G_CIVIL', name: 'Civil' }],
};
const user = (id: string) => ({ kind: 'user' as const, id });
const group = (id: string) => ({ kind: 'group' as const, id });
/** The graph without the default message texts (checked separately). */
const shape = (g: FlowGraph) => ({ ...g, actions: g.actions.map((a) => ('text' in a && a.kind !== 'task' ? { ...a, text: '…' } : a)) });

const cases: Array<{ say: string; convId: string | null; graph: FlowGraph; text?: RegExp }> = [
  {
    say: 'When someone uploads a PDF in the design channel, extract its title and revision, then notify the document review group.',
    convId: 'C_DESIGN',
    graph: { trigger: { id: 't1', kind: 'file.added', types: ['pdf'] }, conditions: [], actions: [{ id: 'a1', kind: 'extract' }, { id: 'a2', kind: 'notify', to: [group('G_DOCREV')], text: '…' }] },
    text: /Title: \{\{file\.title\}\}\nRevision: \{\{file\.revision\}\}/,
  },
  {
    say: 'Whenever a DWG or DXF is attached in Piping P-12 during office hours, tag it #cad and remind Ravi to check it in 2 hours',
    convId: 'C_PIPING',
    graph: { trigger: { id: 't1', kind: 'file.added', types: ['dwg', 'dxf'] }, conditions: [{ id: 'c1', kind: 'time', days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' }], actions: [{ id: 'a1', kind: 'tag', tag: 'cad' }, { id: 'a2', kind: 'task', to: [user('U_RAVI')], text: 'Check {{file.name}}', mode: 'reminder', dueInMinutes: 120 }] },
  },
  {
    say: 'When anyone votes Yes in a poll, add it to my desk as a to-do',
    convId: null,
    graph: { trigger: { id: 't1', kind: 'response.confirmed', source: 'poll', choice: 'Yes' }, conditions: [], actions: [{ id: 'a1', kind: 'task', to: [user('ME')], text: '', mode: 'todo', dueInMinutes: 0 }] },
  },
  {
    say: "If a message says 'stop work' or 'urgent', alert the Civil team",
    convId: null,
    graph: { trigger: { id: 't1', kind: 'message.matched', mode: 'keywords', pattern: 'stop work, urgent' }, conditions: [], actions: [{ id: 'a1', kind: 'notify', to: [group('G_CIVIL')], text: '…' }] },
  },
  {
    say: 'When a message matches /RFI-\\d+/, call https://hooks.example.com/rfi.',
    convId: null,
    graph: { trigger: { id: 't1', kind: 'message.matched', mode: 'regex', pattern: 'RFI-\\d+' }, conditions: [], actions: [{ id: 'a1', kind: 'webhook', url: 'https://hooks.example.com/rfi', body: '' }] },
  },
  {
    say: 'When Priya posts a drawing named GA-*, read the title block and post a summary in Design',
    convId: null,
    graph: { trigger: { id: 't1', kind: 'file.added', types: ['pdf', 'dwg', 'dxf'], namePattern: 'GA-*' }, conditions: [{ id: 'c1', kind: 'author', people: [user('U_PRIYA')] }], actions: [{ id: 'a1', kind: 'extract' }, { id: 'a2', kind: 'post', convId: 'C_DESIGN', text: '…' }] },
  },
  {
    say: 'Each time someone reacts ✅ in Design, tell the author',
    convId: 'C_DESIGN',
    graph: { trigger: { id: 't1', kind: 'reaction.added', emoji: '✅' }, conditions: [], actions: [{ id: 'a1', kind: 'notify', to: [{ kind: 'role', id: 'author' }], text: '…' }] },
  },
  {
    say: 'If Ravi reacts with a thumbs up to a message from Priya, post it in Site updates',
    convId: null,
    graph: { trigger: { id: 't1', kind: 'reaction.added', emoji: '👍', by: [user('U_PRIYA')] }, conditions: [{ id: 'c1', kind: 'author', people: [user('U_RAVI')] }], actions: [{ id: 'a1', kind: 'post', convId: 'C_SITE', text: '…' }] },
  },
  {
    say: 'Notify me when someone mentions Ravi',
    convId: null,
    graph: { trigger: { id: 't1', kind: 'message.mentioned', targets: [user('U_RAVI')] }, conditions: [], actions: [{ id: 'a1', kind: 'notify', to: [user('ME')], text: '…' }] },
  },
  {
    say: 'When someone mentions the Document Review team, notify Priya Raman',
    convId: null,
    graph: { trigger: { id: 't1', kind: 'message.mentioned', targets: [group('G_DOCREV')] }, conditions: [], actions: [{ id: 'a1', kind: 'notify', to: [user('U_PRIYA')], text: '…' }] },
  },
  {
    say: 'When a form is submitted, remind me tomorrow to review the answers',
    convId: null,
    graph: { trigger: { id: 't1', kind: 'response.confirmed', source: 'form' }, conditions: [], actions: [{ id: 'a1', kind: 'task', to: [user('ME')], text: 'Review the answers', mode: 'reminder', dueInMinutes: 1440 }] },
  },
  {
    say: 'If someone uploads an Excel sheet outside office hours, let Ravi know',
    convId: null,
    graph: { trigger: { id: 't1', kind: 'file.added', types: ['xlsx', 'xls', 'csv'] }, conditions: [{ id: 'c1', kind: 'time', days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00', outside: true }], actions: [{ id: 'a1', kind: 'notify', to: [user('U_RAVI')], text: '…' }] },
  },
  {
    say: "When a new PDF arrives in the design channel, extract the revision; then tag it #review; then post 'New revision {{file.revision}} is in' here",
    convId: 'C_DESIGN',
    graph: { trigger: { id: 't1', kind: 'file.added', types: ['pdf'] }, conditions: [], actions: [{ id: 'a1', kind: 'extract' }, { id: 'a2', kind: 'tag', tag: 'review' }, { id: 'a3', kind: 'post', convId: null, text: '…' }] },
  },
  {
    say: 'When someone writes urgent in Site updates on weekends, ping me',
    convId: 'C_SITE',
    graph: { trigger: { id: 't1', kind: 'message.matched', mode: 'keywords', pattern: 'urgent' }, conditions: [{ id: 'c1', kind: 'time', days: [0, 6], from: '00:00', to: '00:00' }], actions: [{ id: 'a1', kind: 'notify', to: [user('ME')], text: '…' }] },
  },
  {
    say: "When a message with the word 'handover' is posted by someone in Civil, create a task for Ravi",
    convId: null,
    graph: { trigger: { id: 't1', kind: 'message.matched', mode: 'keywords', pattern: 'handover' }, conditions: [{ id: 'c1', kind: 'author', people: [group('G_CIVIL')] }], actions: [{ id: 'a1', kind: 'task', to: [user('U_RAVI')], text: 'Follow up on the message from {{author.name}}', mode: 'reminder', dueInMinutes: 60 }] },
  },
  {
    say: "When someone reacts with :approved: to Ravi's messages, notify Priya",
    convId: null,
    graph: { trigger: { id: 't1', kind: 'reaction.added', emoji: ':approved:', by: [user('U_RAVI')] }, conditions: [], actions: [{ id: 'a1', kind: 'notify', to: [user('U_PRIYA')], text: '…' }] },
  },
  {
    say: 'Whenever someone mentions me between 8am and 6pm on weekdays, send it to https://ntfy.example.org/vikram',
    convId: null,
    graph: { trigger: { id: 't1', kind: 'message.mentioned', targets: [user('ME')] }, conditions: [{ id: 'c1', kind: 'time', days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' }], actions: [{ id: 'a1', kind: 'webhook', url: 'https://ntfy.example.org/vikram', body: '' }] },
  },
  {
    say: 'When a file is shared in the Office space, but only PDFs named like *-IFC-*, tell Priya and Ravi',
    convId: 'C_OFFICE',
    graph: { trigger: { id: 't1', kind: 'file.added' }, conditions: [{ id: 'c1', kind: 'file', types: ['pdf'], namePattern: '*-IFC-*' }], actions: [{ id: 'a1', kind: 'notify', to: [user('U_PRIYA'), user('U_RAVI')], text: '…' }] },
  },
  {
    say: 'Tell me when someone votes No',
    convId: null,
    graph: { trigger: { id: 't1', kind: 'response.confirmed', source: 'poll', choice: 'No' }, conditions: [], actions: [{ id: 'a1', kind: 'notify', to: [user('ME')], text: '…' }] },
  },
];

for (const c of cases) {
  test(`drafts: ${c.say}`, async () => {
    const d = await draftFlow(c.say, ctx);
    assert.equal(d.method, 'keywords');
    assert.equal(d.convId, c.convId);
    assert.deepEqual(shape(d.graph), c.graph);
    if (c.text) { const a = d.graph.actions.find((x) => x.kind === 'notify'); assert.match(a && 'text' in a ? a.text : '', c.text); }
    // a complete draft is a valid rule as it stands
    assert.doesNotThrow(() => validateGraph(d.graph));
    assert.deepEqual(d.notes, []);
    for (const n of Object.values(d.nodes)) { assert.deepEqual(n.missing, []); assert.ok(n.confidence >= 0.7, `${n.source}: ${n.confidence}`); }
    assert.ok(d.name.length > 0 && d.name.length <= 80);
  });
}

test('names that are not in the office are marked for the person to fill in', async () => {
  const d = await draftFlow('When someone uploads a PDF in the marketing channel, notify the finance group', ctx);
  assert.equal(d.convId, null);
  assert.deepEqual(d.nodes.t1.missing, ['conversation']);
  assert.deepEqual(d.nodes.a1.missing, ['to']);
  assert.ok(d.nodes.a1.confidence < 0.7);
  assert.deepEqual(d.notes, ['No Space called “marketing” was found. Choose where the rule should watch.', 'No group called “finance” was found. Choose who to notify.']);
  assert.throws(() => validateGraph(d.graph), /choose at least one person/);
  const e = await draftFlow('When someone reacts, tag it', ctx);
  assert.deepEqual(e.nodes.t1.missing, ['emoji']);
  assert.deepEqual(e.nodes.a1.missing, ['tag']);
});

test('opened from a conversation, the rule watches it unless another is named', async () => {
  const here = await draftFlow('When someone attaches a photo, ping Ravi', { ...ctx, convId: 'C_SITE' });
  assert.equal(here.convId, 'C_SITE');
  const there = await draftFlow('When someone attaches a photo in Design, ping Ravi', { ...ctx, convId: 'C_SITE' });
  assert.equal(there.convId, 'C_DESIGN');
  const both = await draftFlow('When someone attaches a PDF in Design or in Piping P-12, ping Ravi', ctx);
  assert.equal(both.convId, null);
  assert.deepEqual(both.graph.conditions, [{ id: 'c1', kind: 'conversation', convIds: ['C_PIPING', 'C_DESIGN'] }]);
});

test('the sentence model ranks clauses the keywords cannot place; a failing model falls back to keywords', async () => {
  // "give … a heads-up" has no keyword for any step
  const words = await draftFlow('When someone uploads a PDF, give Priya a heads-up', ctx);
  assert.equal(words.graph.actions.length, 1, 'only the fallback step');
  assert.match(words.notes[0], /“give Priya a heads-up” was not understood/);
  const model: Ranker = async (_clause, candidates) => candidates.map((c) => (c.kind === 'notify' || c.kind === 'file.added' ? 0.8 : 0.2));
  const ranked = await draftFlow('When someone uploads a PDF, give Priya a heads-up', ctx, model);
  assert.equal(ranked.method, 'model');
  assert.deepEqual(shape(ranked.graph).actions, [{ id: 'a1', kind: 'notify', to: [user('U_PRIYA')], text: '…' }]);
  const broken: Ranker = async () => { throw new Error('no model'); };
  const fallback = await draftFlow('When someone uploads a PDF in Design, notify Ravi', ctx, broken);
  assert.equal(fallback.method, 'keywords');
  assert.equal(fallback.graph.actions[0].kind, 'notify');
  // where keywords are clear, a model that disagrees does not overturn them
  const contrary: Ranker = async (_c, candidates) => candidates.map((c) => (c.kind === 'webhook' || c.kind === 'message.matched' ? 0.9 : 0.1));
  const steady = await draftFlow('When someone uploads a PDF in Design, extract its title and revision, then notify Ravi', ctx, contrary);
  assert.deepEqual(steady.graph.actions.map((a) => a.kind), ['extract', 'notify']);
  assert.equal(steady.graph.trigger.kind, 'file.added');
});

test('clauses and times', () => {
  assert.deepEqual(clauses('When a PDF is shared, read it, tag it #x and then tell Ravi and Priya. Only on weekdays'), ['When a PDF is shared', 'read it', 'tag it #x', 'tell Ravi and Priya', 'Only on weekdays']);
  assert.deepEqual(clauses('extract its title and revision'), ['extract its title and revision']);
  assert.deepEqual(timeCondition('between 9 and 6'), { kind: 'time', days: [0, 1, 2, 3, 4, 5, 6], from: '09:00', to: '18:00' });
  assert.deepEqual(timeCondition('after 7pm on Fridays'), { kind: 'time', days: [5], from: '19:00', to: '00:00' });
  assert.deepEqual(timeCondition('before 9:30 on Monday and Tuesday'), { kind: 'time', days: [1, 2], from: '00:00', to: '09:30' });
  assert.equal(timeCondition('remind me in 2 hours'), null);
});
