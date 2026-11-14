import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Conversation, FileInfo, Flow, FlowGraph, FlowRun, Message } from '@dex/core';
import type { HubClient } from '@dex/core/client';
import type { Hub } from '../src/hub.ts';
import { office, me, send, nextEvent, nextClientId } from './office.ts';
import { buildPdf, drawingSheet } from './pdfs.ts';

function upload(hub: Hub, c: HubClient, name: string, data: Buffer, type = 'application/pdf'): Promise<FileInfo> {
  return new Promise((resolve, reject) => {
    const r = https.request({ host: '127.0.0.1', port: hub.port, method: 'POST', path: `/files?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`, rejectUnauthorized: false,
      headers: { authorization: `Bearer ${c.session!.fileToken}`, 'content-length': data.length } }, (res) => {
      let body = '';
      res.on('data', (x) => { body += x; });
      res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(body)) : reject(new Error(body))));
    });
    r.on('error', reject);
    r.end(data);
  });
}

async function sendFile(hub: Hub, c: HubClient, convId: string, name: string, data: Buffer, body = ''): Promise<Message> {
  const f = await upload(hub, c, name, data);
  return c.request('msg.send', { convId, body, files: [f.id], clientId: nextClientId() });
}

const runsOf = async (c: HubClient, id: string): Promise<FlowRun[]> => c.request('flow.runs', { id });
const dmText = async (c: HubClient, fromId: string): Promise<string[]> => {
  const convs = await c.request('conv.list');
  const dm = convs.find((x: Conversation) => x.kind === 'direct' && x.members.includes(fromId));
  if (!dm) return [];
  const list = await c.request('msg.list', { convId: dm.id }) as { messages: Message[] } | Message[];
  const msgs = Array.isArray(list) ? list : list.messages;
  return msgs.map((m) => m.body);
};
const systemId = (hub: Hub) => hub.system.id;

async function department(owner: HubClient, name: string, people: HubClient[]): Promise<string> {
  const dep = await owner.request('admin.org.saveDepartment', { name });
  for (const p of people) await owner.request('admin.org.setProfile', { userId: me(p), departmentId: dep.id });
  return dep.id;
}

const pdfFile = (title: string[], rev: string, number: string) => buildPdf({ pages: [{ content: drawingSheet({ title, rev, number }), compress: true }], info: { Title: `${number}.dwg` } });

test('a PDF uploaded in a Space is read and the review group is told its title and revision', async () => {
  const { hub, owner, priya, ravi } = await office();
  const review = await department(owner, 'Document Review', [ravi]);
  const design = await priya.request('conv.create', { kind: 'space', name: 'Design', members: [me(ravi), me(owner)] });
  const graph: FlowGraph = {
    trigger: { id: 't1', kind: 'file.added', types: ['pdf'] },
    conditions: [],
    actions: [
      { id: 'a1', kind: 'extract' },
      { id: 'a2', kind: 'notify', to: [{ kind: 'group', id: review }], text: '{{author.name}} shared {{file.name}}: {{file.title}} (rev {{file.revision}}, {{file.number}})' },
    ],
  };
  const flow = await priya.request('flow.save', { convId: design.id, name: 'PDF review', graph });
  assert.equal(flow.version, 1);
  assert.equal(flow.canManage, true);
  // a spreadsheet is not a PDF: nothing runs
  await sendFile(hub, priya, design.id, 'MTO.xlsx', Buffer.from('not really a sheet'));
  const told = nextEvent<Message>(ravi, 'msg.new', (m) => m.authorId === systemId(hub));
  const msg = await sendFile(hub, priya, design.id, 'GA-101.pdf', pdfFile(['GENERAL ARRANGEMENT', 'PUMP HOUSE'], 'C', 'DDS-GA-101'));
  const note = await told;
  assert.match(note.body, /^Priya shared GA-101\.pdf: GENERAL ARRANGEMENT PUMP HOUSE \(rev C, DDS-GA-101\)/);
  assert.ok(note.body.includes(`dexconnect://message/${design.id}/${msg.id}`), 'the notification links to the message');
  await hub.flows.idle();
  const runs = await runsOf(priya, flow.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].outcome, 'ok');
  assert.equal(runs[0].event, 'Priya shared GA-101.pdf in Design');
  assert.deepEqual(runs[0].steps.map((s) => [s.kind, s.status]), [['extract', 'done'], ['notify', 'done']]);
  assert.match(runs[0].steps[0].note, /title “GENERAL ARRANGEMENT PUMP HOUSE”, revision C/);
  // the owner (not in the group) was not told
  assert.equal((await dmText(owner, systemId(hub))).filter((b) => b.includes('GA-101')).length, 0);
});

test('reactions, with an author filter, post into another Space; the post never triggers rules again', async () => {
  const { hub, owner, priya, ravi } = await office();
  const site = await owner.request('conv.create', { kind: 'space', name: 'Site', members: [me(priya), me(ravi)] });
  const log = await owner.request('conv.create', { kind: 'space', name: 'Approvals log', members: [me(priya)] });
  const approved = await owner.request('flow.save', { convId: site.id, name: 'Approved', graph: {
    trigger: { id: 't1', kind: 'reaction.added', emoji: '✅', by: [{ kind: 'user', id: me(priya) }] },
    conditions: [],
    actions: [{ id: 'a1', kind: 'post', convId: log.id, text: '{{actor.name}} approved “{{message.text}}” {{message.link}}' }],
  } });
  // a keyword rule in the log Space that would match the post's own words
  const echo = await owner.request('flow.save', { convId: log.id, name: 'Echo', graph: {
    trigger: { id: 't1', kind: 'message.matched', mode: 'keywords', pattern: 'approved' },
    conditions: [],
    actions: [{ id: 'a1', kind: 'post', convId: null, text: 'Seen: {{message.text}}' }],
  } });
  const byRavi = await send(ravi, site.id, 'Valve list rev 2');
  await owner.request('msg.react', { messageId: byRavi.id, emoji: '✅', on: true });
  const byPriya = await send(priya, site.id, 'Pipe rack drawings issued');
  await owner.request('msg.react', { messageId: byPriya.id, emoji: '👍', on: true });
  const posted = nextEvent<Message>(priya, 'msg.new', (m) => m.convId === log.id);
  await owner.request('msg.react', { messageId: byPriya.id, emoji: '✅', on: true });
  const post = await posted;
  assert.equal(post.authorId, hub.flows.botId);
  assert.ok(post.body.startsWith('Vikram approved “Pipe rack drawings issued” dexconnect://message/'));
  await hub.flows.idle();
  assert.equal((await runsOf(owner, approved.id)).length, 1, 'only the ✅ on Priya\'s message ran');
  assert.equal((await runsOf(owner, echo.id)).length, 0, 'the posted message did not start the echo rule');
  // a person writing the same word does start it
  await send(priya, log.id, 'All approved now');
  await hub.flows.idle();
  assert.equal((await runsOf(owner, echo.id)).length, 1);
  assert.equal((await runsOf(owner, echo.id))[0].outcome, 'ok');
  await hub.flows.idle();
  // and its own "Seen:" post did not start it again
  assert.equal((await runsOf(owner, echo.id)).length, 1);
});

test('poll votes and form answers confirm a response: reminders and To dos on the Desk', async () => {
  const { hub, owner, priya, ravi } = await office();
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Planning', members: [me(priya), me(ravi)] });
  const poll = await owner.request('poll.create', { convId: sp.id, question: 'Site visit on Friday?', options: ['Yes', 'No'], clientId: nextClientId() });
  const yes = await owner.request('flow.save', { convId: sp.id, name: 'Yes voters', graph: {
    trigger: { id: 't1', kind: 'response.confirmed', source: 'poll', choice: 'yes' },
    conditions: [],
    actions: [
      { id: 'a1', kind: 'task', mode: 'reminder', to: [{ kind: 'role', id: 'actor' }], text: 'Book transport ({{response.choice}})', dueInMinutes: 120 },
      { id: 'a2', kind: 'task', mode: 'todo', to: [{ kind: 'role', id: 'owner' }], text: '', dueInMinutes: 0 },
    ],
  } });
  await ravi.request('poll.vote', { messageId: poll.id, options: [1] });
  await priya.request('poll.vote', { messageId: poll.id, options: [0] });
  // voting again for the same choice does not count twice
  await priya.request('poll.vote', { messageId: poll.id, options: [0] });
  await hub.flows.idle();
  const runs = await runsOf(owner, yes.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].event, 'Priya voted “Yes” in Planning');
  const rem = await priya.request('remind.list');
  assert.equal(rem.length, 1);
  assert.equal(rem[0].text, 'Book transport (Yes)');
  assert.equal(rem[0].createdBy, me(owner));
  assert.equal(rem[0].message?.id, poll.id);
  assert.ok(Math.abs(rem[0].dueAt - (Date.now() + 120 * 60_000)) < 10_000);
  assert.equal((await ravi.request('remind.list')).length, 0);
  const saved = await owner.request('desk.saved');
  assert.deepEqual(saved.map((s) => [s.message.id, s.kind]), [[poll.id, 'todo']]);

  // forms: the choice is the first multiple-choice answer
  const form = await owner.request('form.create', { convId: sp.id, title: 'Leave request', fields: [{ label: 'Type', type: 'choice', options: ['Casual', 'Sick'], required: true }, { label: 'Days', type: 'number', required: false }], clientId: nextClientId() });
  const sick = await owner.request('flow.save', { convId: sp.id, name: 'Sick leave', graph: {
    trigger: { id: 't1', kind: 'response.confirmed', source: 'form', choice: 'Sick' },
    conditions: [],
    actions: [{ id: 'a1', kind: 'notify', to: [{ kind: 'role', id: 'owner' }], text: '{{actor.name}} asked for {{response.choice}} leave' }],
  } });
  const told = nextEvent<Message>(owner, 'msg.new', (m) => m.authorId === systemId(hub) && m.body.includes('leave'));
  await ravi.request('form.respond', { formId: form.form!.id, answers: { q1: 'Casual', q2: '1' } });
  await priya.request('form.respond', { formId: form.form!.id, answers: { q1: 'Sick', q2: '2' } });
  assert.match((await told).body, /^Priya asked for Sick leave/);
  await hub.flows.idle();
  assert.equal((await runsOf(owner, sick.id)).length, 1);
});

test('keywords and regular expressions: matched text and groups are variables; unsafe patterns are refused', async () => {
  const { hub, owner, priya } = await office();
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Piping', members: [me(priya)] });
  const urgent = await owner.request('flow.save', { convId: sp.id, name: 'Urgent', graph: {
    trigger: { id: 't1', kind: 'message.matched', mode: 'keywords', pattern: 'urgent, "stop work"' },
    conditions: [],
    actions: [{ id: 'a1', kind: 'notify', to: [{ kind: 'role', id: 'owner' }], text: '“{{match.text}}” from {{author.name}}: {{message.text}}' }],
  } });
  const tags = await owner.request('flow.save', { convId: sp.id, name: 'Line numbers', graph: {
    trigger: { id: 't1', kind: 'message.matched', mode: 'regex', pattern: '\\b(\\d{1,2})"-([A-Z]{1,3})-(\\d{3,5})\\b' },
    conditions: [],
    actions: [{ id: 'a1', kind: 'post', convId: null, text: 'Line {{match.3}} ({{match.1}} inch, service {{match.2}})' }],
  } });
  await send(priya, sp.id, 'Is this urgently needed?'); // not the whole word
  const told = nextEvent<Message>(owner, 'msg.new', (m) => m.authorId === systemId(hub));
  await send(priya, sp.id, 'Please STOP WORK on area 3');
  assert.match((await told).body, /^“STOP WORK” from Priya: Please STOP WORK on area 3/);
  const posted = nextEvent<Message>(priya, 'msg.new', (m) => m.authorId === hub.flows.botId);
  await send(priya, sp.id, 'Check 6"-P-10234 before Friday');
  assert.equal((await posted).body, 'Line 10234 (6 inch, service P)');
  await hub.flows.idle();
  assert.equal((await runsOf(owner, urgent.id)).length, 1);
  assert.equal((await runsOf(owner, tags.id)).length, 1);
  for (const pattern of ['(a+)+$', '(x|xy)*z', '(\\w+)\\1', '(?<=a)b', 'a'.repeat(201)]) {
    await assert.rejects(owner.request('flow.save', { convId: sp.id, name: 'Bad', graph: { trigger: { id: 't1', kind: 'message.matched', mode: 'regex', pattern }, conditions: [], actions: [{ id: 'a1', kind: 'tag', tag: 'x1' }] } }), /pattern|Back-references|Look-ahead|repeated group/i, pattern);
  }
});

test('mentions of a person or a group tag the message; the tag is found by search and survives an edit', async () => {
  const { hub, owner, priya, ravi } = await office();
  const qa = await department(owner, 'Quality', [ravi]);
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Civil', members: [me(priya), me(ravi)] });
  const flow = await owner.request('flow.save', { convId: sp.id, name: 'QA mentions', graph: {
    trigger: { id: 't1', kind: 'message.mentioned', targets: [{ kind: 'group', id: qa }] },
    conditions: [],
    actions: [{ id: 'a1', kind: 'tag', tag: '#qa-check' }],
  } });
  await send(priya, sp.id, `<@${me(owner)}> please look`); // not in the group
  const m = await send(priya, sp.id, `<@${me(ravi)}> concrete cube results attached`);
  await hub.flows.idle();
  const runs = await runsOf(owner, flow.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].steps[0].note, 'Tagged #qa-check.');
  const found = await priya.request('search', { q: '#qa-check' });
  assert.deepEqual(found.messages.map((x) => x.message.id), [m.id]);
  await priya.request('msg.edit', { messageId: m.id, body: `<@${me(ravi)}> concrete cube results attached (7 day)` });
  assert.deepEqual((await priya.request('search', { q: '#qa-check' })).messages.map((x) => x.message.id), [m.id]);
  assert.ok((await priya.request('tags.top', {})).some((t) => t.tag === 'qa-check'));
});

test('conditions: who did it, office hours and the file name', async () => {
  const { hub, owner, priya, ravi } = await office();
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Drawings', members: [me(priya), me(ravi)] });
  const now = new Date();
  const hh = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const inHour = { id: 'c2', kind: 'time' as const, days: [0, 1, 2, 3, 4, 5, 6], from: hh(new Date(now.getTime() - 3600_000)), to: hh(new Date(now.getTime() + 3600_000)) };
  const flow = await owner.request('flow.save', { convId: sp.id, name: 'GA sheets from Priya', graph: {
    trigger: { id: 't1', kind: 'file.added' },
    conditions: [
      { id: 'c1', kind: 'author', people: [{ kind: 'user', id: me(priya) }] },
      inHour,
      { id: 'c3', kind: 'file', types: ['pdf'], namePattern: 'GA-*' },
    ],
    actions: [{ id: 'a1', kind: 'tag', tag: 'ga' }],
  } });
  await sendFile(hub, ravi, sp.id, 'GA-200.pdf', pdfFile(['X'], 'A', 'GA-200')); // wrong person
  await sendFile(hub, priya, sp.id, 'PID-300.pdf', pdfFile(['X'], 'A', 'PID-300')); // wrong name
  await sendFile(hub, priya, sp.id, 'GA-301.pdf', pdfFile(['X'], 'A', 'GA-301'));
  await hub.flows.idle();
  assert.equal((await runsOf(owner, flow.id)).length, 1);
  // leaving people out, and hours that are not now
  const later = { ...inHour, from: hh(new Date(now.getTime() + 2 * 3600_000)), to: hh(new Date(now.getTime() + 3 * 3600_000)) };
  await owner.request('flow.save', { id: flow.id, convId: sp.id, name: flow.name, version: flow.version, graph: { ...flow.graph, conditions: [{ id: 'c1', kind: 'author', people: [{ kind: 'user', id: me(priya) }], exclude: true }] } });
  await sendFile(hub, ravi, sp.id, 'GA-302.pdf', pdfFile(['X'], 'A', 'GA-302'));
  await hub.flows.idle();
  assert.equal((await runsOf(owner, flow.id)).length, 2);
  await owner.request('flow.save', { id: flow.id, convId: sp.id, name: flow.name, graph: { ...flow.graph, conditions: [later] } });
  await sendFile(hub, ravi, sp.id, 'GA-303.pdf', pdfFile(['X'], 'A', 'GA-303'));
  await hub.flows.idle();
  assert.equal((await runsOf(owner, flow.id)).length, 2);
  // the same window marked "outside" runs now
  await owner.request('flow.save', { id: flow.id, convId: sp.id, name: flow.name, graph: { ...flow.graph, conditions: [{ ...later, outside: true }] } });
  await sendFile(hub, ravi, sp.id, 'GA-304.pdf', pdfFile(['X'], 'A', 'GA-304'));
  await hub.flows.idle();
  assert.equal((await runsOf(owner, flow.id)).length, 3);
  // office-wide rules watch every Space, with a conversation condition
  const other = await owner.request('conv.create', { kind: 'space', name: 'Structural', members: [me(priya)] });
  const officeRule = await owner.request('flow.save', { convId: null, name: 'Structural PDFs', graph: {
    trigger: { id: 't1', kind: 'file.added', types: ['pdf'] }, conditions: [{ id: 'c1', kind: 'conversation', convIds: [other.id] }], actions: [{ id: 'a1', kind: 'tag', tag: 'structural' }],
  } });
  await sendFile(hub, priya, sp.id, 'A.pdf', pdfFile(['X'], 'A', 'A-1'));
  await sendFile(hub, priya, other.id, 'B.pdf', pdfFile(['X'], 'A', 'B-1'));
  await hub.flows.idle();
  const runs = await runsOf(owner, officeRule.id);
  assert.deepEqual(runs.map((r) => r.event), ['Priya shared B.pdf in Structural']);
});

test('webhooks: office-network addresses are refused until an administrator allows them; replies feed later steps', async () => {
  const { hub, owner, priya } = await office();
  const got: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { got.push({ headers: req.headers, body }); res.writeHead(201, { 'content-type': 'text/plain' }); res.end('ticket DDS-77'); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const sp = await owner.request('conv.create', { kind: 'space', name: 'Hopper', members: [me(priya)] });
    const flow = await owner.request('flow.save', { convId: sp.id, name: 'Raise a ticket', graph: {
      trigger: { id: 't1', kind: 'message.matched', mode: 'keywords', pattern: 'ticket' },
      conditions: [],
      actions: [
        { id: 'a1', kind: 'webhook', url: `http://127.0.0.1:${port}/hooks/new`, body: '{"title": "{{message.text}}", "by": "{{author.name}}"}' },
        { id: 'a2', kind: 'post', convId: null, text: 'Raised: {{webhook.reply}} ({{webhook.status}})' },
      ],
    } });
    await send(priya, sp.id, 'Please raise a ticket for the "pump" alarm');
    await hub.flows.idle();
    let runs = await runsOf(owner, flow.id);
    assert.equal(runs[0].outcome, 'failed');
    assert.match(runs[0].error ?? '', /office network/);
    assert.deepEqual(runs[0].steps.map((s) => s.status), ['failed', 'skipped']);
    assert.equal(got.length, 0, 'nothing reached the office server');
    await assert.rejects(priya.request('admin.flows.settings', { allowLan: true }), /administrators/);
    assert.deepEqual(await owner.request('admin.flows.settings', { allowLan: true }), { allowLan: true });
    const posted = nextEvent<Message>(priya, 'msg.new', (m) => m.authorId === hub.flows.botId);
    await send(priya, sp.id, 'Another ticket: "valve" leak');
    assert.equal((await posted).body, 'Raised: ticket DDS-77 (201)');
    assert.equal(got.length, 1);
    assert.deepEqual(JSON.parse(got[0].body), { title: 'Another ticket: "valve" leak', by: 'Priya' });
    assert.equal(got[0].headers['content-type'], 'application/json');
    assert.equal(got[0].headers['x-dex-rule'], flow.id);
    await hub.flows.idle();
    runs = await runsOf(owner, flow.id);
    assert.equal(runs[0].outcome, 'ok');
    assert.ok(hub.store.auditTrail(50).some((a) => a.action === 'flow.settings'));
  } finally {
    server.close();
  }
});

test('a rule runs at most 30 times a minute and says once that it was held back', async () => {
  const { hub, owner } = await office();
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Busy', members: [] });
  const flow = await owner.request('flow.save', { convId: sp.id, name: 'Every message', graph: {
    trigger: { id: 't1', kind: 'message.matched', mode: 'regex', pattern: '.' }, conditions: [], actions: [{ id: 'a1', kind: 'tag', tag: 'seen' }],
  } });
  for (let i = 0; i < 36; i++) await send(owner, sp.id, `message ${i}`);
  await hub.flows.idle();
  const runs = await runsOf(owner, flow.id);
  assert.equal(runs.filter((r) => r.outcome === 'ok').length, 30);
  const held = runs.filter((r) => r.outcome === 'limited');
  assert.equal(held.length, 1);
  assert.match(held[0].error ?? '', /30 times in the last minute/);
});

test('the run log keeps the last 50 runs', async () => {
  const { hub, owner } = await office();
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Log', members: [] });
  const flow = await owner.request('flow.save', { convId: sp.id, name: 'Count', graph: {
    trigger: { id: 't1', kind: 'message.matched', mode: 'keywords', pattern: 'count' }, conditions: [], actions: [{ id: 'a1', kind: 'tag', tag: 'counted' }],
  } });
  // spread over "minutes" so the rate limit does not hold them back
  let clock = Date.now();
  (hub.flows as unknown as { d: { now: () => number } }).d.now = () => clock;
  for (let i = 0; i < 55; i++) { clock += 3000; await send(owner, sp.id, `count ${i}`); await hub.flows.idle(); }
  const runs = await runsOf(owner, flow.id);
  assert.equal(runs.length, 50);
  assert.ok(runs.every((r) => r.outcome === 'ok'));
});

test('permissions: who may see and change automations, versions, and the audit trail', async () => {
  const { hub, owner, priya, ravi, join } = await office();
  const sp = await priya.request('conv.create', { kind: 'space', name: 'Mechanical', members: [me(ravi)] });
  const graph: FlowGraph = { trigger: { id: 't1', kind: 'file.added', types: ['dwg'] }, conditions: [], actions: [{ id: 'a1', kind: 'tag', tag: 'cad' }] };
  // a member who did not start the Space cannot add rules
  await assert.rejects(ravi.request('flow.save', { convId: sp.id, name: 'Mine', graph }), /started this conversation, its moderators or an administrator/);
  const flow = await priya.request('flow.save', { convId: sp.id, name: 'CAD files', graph });
  // members see the rules (but cannot change them); people outside cannot see them
  const seen = await ravi.request('flow.list', { convId: sp.id });
  assert.deepEqual(seen.map((f: Flow) => [f.id, f.canManage]), [[flow.id, false]]);
  await assert.rejects(ravi.request('flow.enable', { id: flow.id, enabled: false }), /cannot change/);
  await assert.rejects(ravi.request('flow.delete', { id: flow.id }), /cannot remove/);
  const outsider = (await join('anil')).c;
  await assert.rejects(owner.request('flow.list', { convId: sp.id }), /not found/);
  // a moderator can
  await priya.request('conv.settings', { convId: sp.id, moderators: [me(ravi)] });
  const disabled = await ravi.request('flow.enable', { id: flow.id, enabled: false });
  assert.equal(disabled.enabled, false);
  // two people editing: the second save with an old version is refused
  const v2 = await priya.request('flow.save', { id: flow.id, convId: sp.id, name: 'CAD drawings', version: 1, graph });
  assert.equal(v2.version, 2);
  await assert.rejects(ravi.request('flow.save', { id: flow.id, convId: sp.id, name: 'Old copy', version: 1, graph }), /changed this rule since you opened it/);
  // office-wide rules are for administrators
  await assert.rejects(priya.request('flow.save', { convId: null, name: 'Everywhere', graph }), /administrators/);
  await assert.rejects(priya.request('flow.list', { scope: 'office' }), /administrators/);
  const officeRule = await owner.request('flow.save', { convId: null, name: 'Everywhere', graph });
  assert.deepEqual((await owner.request('flow.list', { scope: 'office' })).map((f: Flow) => f.id), [officeRule.id]);
  // administrators oversee every rule, but change only those in conversations they are in
  const all = await owner.request('flow.list', { scope: 'all' });
  assert.deepEqual(all.map((f: Flow) => [f.name, f.convName, f.canManage]), [['Everywhere', null, true], ['CAD drawings', 'Mechanical', false]]);
  await assert.rejects(owner.request('flow.enable', { id: flow.id, enabled: true }), /cannot change/);
  // posting needs a Space the editor is in
  const secret = await owner.request('conv.create', { kind: 'space', name: 'Board', private: true, members: [] });
  await assert.rejects(priya.request('flow.save', { convId: sp.id, name: 'Leak', graph: { ...graph, actions: [{ id: 'a1', kind: 'post', convId: secret.id, text: 'x' }] } }), /Space you are in/);
  // people and groups must exist
  await assert.rejects(priya.request('flow.save', { convId: sp.id, name: 'Ghost', graph: { ...graph, actions: [{ id: 'a1', kind: 'notify', to: [{ kind: 'user', id: '01HZZZZZZZZZZZZZZZZZZZZZZZ' }], text: 'x' }] } }), /not in the Directory/);
  void outsider;
  await priya.request('flow.delete', { id: flow.id });
  assert.equal((await ravi.request('flow.list', { convId: sp.id })).length, 0);
  const actions = hub.store.auditTrail(100).filter((a) => a.action.startsWith('flow.')).map((a) => a.action).sort();
  assert.deepEqual(actions, ['flow.created', 'flow.created', 'flow.deleted', 'flow.disabled', 'flow.updated']);
});

test('a test run shows what would happen with a real message or a made-up one, and does nothing', async () => {
  const { hub, owner, priya } = await office();
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Review', members: [me(priya)] });
  const graph: FlowGraph = {
    trigger: { id: 't1', kind: 'file.added', types: ['pdf'] },
    conditions: [],
    actions: [
      { id: 'a1', kind: 'extract' },
      { id: 'a2', kind: 'notify', to: [{ kind: 'user', id: me(priya) }], text: 'Check {{file.title}} rev {{file.revision}}' },
      { id: 'a3', kind: 'tag', tag: 'review' },
    ],
  };
  const m = await sendFile(hub, priya, sp.id, 'PID-12.pdf', pdfFile(['PIPING AND INSTRUMENT', 'DIAGRAM UNIT 12'], 'B', 'PID-12'));
  const real = await owner.request('flow.test', { convId: sp.id, graph, sample: { messageId: m.id } });
  assert.equal(real.matched, true);
  assert.deepEqual(real.steps.map((s) => s.status), ['would', 'would', 'would']);
  assert.equal(real.variables['file.title'], 'PIPING AND INSTRUMENT DIAGRAM UNIT 12');
  assert.equal(real.variables['file.revision'], 'B');
  assert.match(real.steps[1].note, /^Would tell Priya: “Check PIPING AND INSTRUMENT DIAGRAM UNIT 12 rev B/);
  const made = await owner.request('flow.test', { convId: sp.id, graph, sample: { fileName: 'GA-9.pdf' } });
  assert.equal(made.matched, true);
  assert.match(made.steps[0].note, /Would read the title block of GA-9\.pdf/);
  const miss = await owner.request('flow.test', { convId: sp.id, graph, sample: { fileName: 'notes.txt' } });
  assert.equal(miss.matched, false);
  assert.match(miss.reason ?? '', /\.pdf/);
  // nothing was sent or tagged
  assert.equal((await dmText(priya, systemId(hub))).filter((b) => b.includes('Check')).length, 0);
  assert.equal((await priya.request('search', { q: '#review' })).messages.length, 0);
});

test('Direct conversations: their own rules can be made by whoever started them, and rules never post into them', async () => {
  const { hub, owner, priya } = await office();
  const dm = await owner.request('conv.create', { kind: 'direct', members: [me(priya)] }) as Conversation;
  await assert.rejects(owner.request('flow.save', { convId: dm.id, name: 'Echo', graph: { trigger: { id: 't1', kind: 'file.added' }, conditions: [], actions: [{ id: 'a1', kind: 'post', convId: null, text: 'x' }] } }), /post only in Spaces/);
  const flow = await owner.request('flow.save', { convId: dm.id, name: 'Files', graph: { trigger: { id: 't1', kind: 'file.added' }, conditions: [], actions: [{ id: 'a1', kind: 'notify', to: [{ kind: 'role', id: 'owner' }], text: '{{file.name}} arrived' }] } });
  await sendFile(hub, priya, dm.id, 'photo.pdf', pdfFile(['X'], 'A', 'X-1'));
  await hub.flows.idle();
  assert.equal((await runsOf(owner, flow.id))[0].outcome, 'ok');
  // office-wide rules do not see Direct conversations
  const officeRule = await owner.request('flow.save', { convId: null, name: 'All files', graph: { trigger: { id: 't1', kind: 'file.added' }, conditions: [], actions: [{ id: 'a1', kind: 'tag', tag: 'file' }] } });
  await sendFile(hub, priya, dm.id, 'second.pdf', pdfFile(['X'], 'A', 'X-2'));
  await hub.flows.idle();
  assert.equal((await runsOf(owner, officeRule.id)).length, 0);
});
