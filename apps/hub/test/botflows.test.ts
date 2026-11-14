import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import type { BotFlowCard, Message } from '@dex/core';
import { HubClient } from '@dex/core/client';
import { checkAnswer, nextAfter, remainingPath, validateFlow } from '@dex/core/botflows';
import type { Hub } from '../src/hub.ts';
import { office, me, until, nextEvent } from './office.ts';

/** Call the hub's Bot API with an integration token. */
function api(hub: Hub, token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = https.request({ host: '127.0.0.1', port: hub.port, path, method, rejectUnauthorized: false, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) as Record<string, unknown> : {} }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

/** A webhook that records what it is sent and answers with `answer(body)`. */
async function webhook(answer: (body: Record<string, unknown>) => unknown) {
  const seen: Array<{ body: Record<string, unknown>; signed: boolean }> = [];
  let secret = '';
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      seen.push({ body, signed: req.headers['x-dex-signature'] === `sha256=${crypto.createHmac('sha256', secret).update(`${req.headers['x-dex-timestamp']}.${raw}`).digest('hex')}` });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(answer(body) ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  after(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, seen, setSecret: (s: string) => { secret = s; } };
}

const cards = async (c: HubClient, convId: string): Promise<Array<Message & { botflow: BotFlowCard }>> =>
  (await c.request('msg.list', { convId, limit: 200 })).messages.filter((m): m is Message & { botflow: BotFlowCard } => !!m.botflow);
const current = async (c: HubClient, convId: string) => {
  const list = (await cards(c, convId)).filter((m) => m.botflow.state === 'active');
  assert.equal(list.length, 1, 'exactly one card waits for an answer');
  return list[0].botflow;
};
const waitFor = async <T>(fn: () => Promise<T | undefined>, ms = 3000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

const SITE_VISIT = {
  title: 'Site visit',
  description: 'Book a visit to site',
  command: 'sitevisit',
  keywords: ['site visit'],
  steps: [
    { id: 'site', label: 'Site', prompt: 'Which site?', input: { kind: 'choice', options: ['Refinery', 'Depot'] },
      branches: [{ if: { equals: 'Depot' }, goto: 'people', set: { ppe: 'Hard hat only' } }] },
    { id: 'permit', label: 'Permit', prompt: 'Permit number?', input: { kind: 'regex', pattern: 'WP-\\d{4}', message: 'Permit numbers look like WP-1234.' } },
    { id: 'people', label: 'People', prompt: 'How many people?', input: { kind: 'number', integer: true, min: 1, max: 8 } },
    { id: 'day', label: 'Day', prompt: 'Which day?', input: { kind: 'date', notBefore: 'today' } },
    { id: 'mail', label: 'Contact', prompt: 'Contact email?', input: { kind: 'email', optional: true } },
    { id: 'host', label: 'Host', prompt: 'Who hosts you on site?', input: { kind: 'person' } },
    { id: 'ok', prompt: 'Book it?\n{{summary}}\nPPE: {{ppe}}', input: { kind: 'confirm', yes: 'Book', no: 'Start again' }, branches: [{ if: { equals: 'no' }, goto: 'site' }] },
  ],
  finish: [
    { do: 'task', assignee: 'host', text: 'Host {{people}} from {{user}} at {{site}} on {{day.value}}', due: 'day' },
    { do: 'post', to: 'origin', text: 'Site visit booked: {{site}}, {{people}} people.' },
    { do: 'webhook' },
  ],
  done: 'Booked with {{host}}.',
};

test('flow rules: validation, branching and the route ahead', () => {
  const def = validateFlow(SITE_VISIT, 'site-visit');
  assert.throws(() => validateFlow({ ...SITE_VISIT, steps: [{ id: 'a', prompt: 'x', input: { kind: 'choice', options: ['one'] } }] }, 'x-y'), /at least two options/);
  assert.throws(() => validateFlow({ ...SITE_VISIT, steps: [{ id: 'a', prompt: 'x', input: { kind: 'text' }, next: 'nowhere' }] }, 'x-y'), /not a step/);
  assert.throws(() => validateFlow({ ...SITE_VISIT, finish: [{ do: 'task', assignee: 'site', text: 't' }] }, 'x-y'), /picks a person/);
  assert.throws(() => validateFlow(SITE_VISIT, 'Bad Name'), /lower-case/);
  const ctx = { now: Date.now(), person: () => null, file: () => null };
  const step = (id: string) => def.steps.find((s) => s.id === id)!;
  assert.throws(() => checkAnswer(step('permit'), 'P-12', ctx), /WP-1234/);
  assert.equal(checkAnswer(step('permit'), 'WP-0042', ctx).value, 'WP-0042');
  assert.throws(() => checkAnswer(step('people'), '2.5', ctx), /whole number/);
  assert.throws(() => checkAnswer(step('people'), '9', ctx), /at most 8/);
  assert.throws(() => checkAnswer(step('day'), '2020-01-01', ctx), /today or a later/);
  assert.throws(() => checkAnswer(step('day'), '2031-02-30', ctx), /date/);
  assert.throws(() => checkAnswer(step('mail'), 'not an email', ctx), /email/);
  assert.equal(checkAnswer(step('mail'), '', ctx).value, '', 'optional answers can be skipped');
  assert.equal(checkAnswer(step('site'), 'depot', ctx).value, 'Depot', 'typed choices match the options');
  assert.equal(checkAnswer(step('ok'), 'yes', ctx).value, 'yes');
  // the Depot branch skips the permit step and sets a variable
  const vars = { site: { value: 'Depot', label: 'Depot' } };
  assert.deepEqual(nextAfter(def, step('site'), vars), { goto: 'people', set: { ppe: 'Hard hat only' } });
  assert.deepEqual(remainingPath(def, 'site', vars), ['site', 'people', 'day', 'mail', 'host', 'ok']);
  assert.deepEqual(remainingPath(def, 'site', {}), ['site', 'permit', 'people', 'day', 'mail', 'host', 'ok']);
});

test('a flow from the Bot API: branching, validation, Back, Pick up where you left off, and the end actions', async () => {
  const { hub, owner, priya, ravi, join } = await office();
  const hook = await webhook((b) => (b.type === 'botflow.completed' ? { text: 'Gate pass ordered.' } : {}));
  const { bot, token } = await owner.request('admin.bots.create', { name: 'Site Desk' });
  hook.setSecret((await owner.request('admin.bots.commands', { userId: bot.id, webhookUrl: hook.url, commands: [] })).secret);
  // flows are kept by the integration through the Bot API
  assert.equal((await api(hub, 'nope', 'GET', '/api/flows')).status, 401);
  const bad = await api(hub, token, 'PUT', '/api/flows/site-visit', { ...SITE_VISIT, steps: [] });
  assert.equal(bad.status, 400);
  const put = await api(hub, token, 'PUT', '/api/flows/site-visit', SITE_VISIT);
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal((await api(hub, token, 'PUT', '/api/flows/other', { ...SITE_VISIT, command: 'remind' })).status, 409, 'built-in commands are not for flows');
  assert.ok((await priya.request('cmd.list')).some((c) => c.command === 'sitevisit'));
  assert.ok((await priya.request('botflow.list')).some((f) => f.name === 'site-visit' && f.botName === 'Site Desk'));

  const space = await owner.request('conv.create', { kind: 'space', name: 'Site team', members: [me(priya), me(ravi)] });
  const started = await priya.request('cmd.run', { convId: space.id, command: 'sitevisit', text: '' });
  assert.equal(started.ephemeral, true);
  const [s] = await priya.request('botflow.sessions');
  assert.equal(s.flow, 'site-visit');
  assert.equal(s.originConvId, space.id);
  const dm = s.convId;
  let card = await current(priya, dm);
  assert.equal(card.stepId, 'site');
  assert.equal(card.stepNo, 1);
  assert.equal(card.stepCount, 7);
  assert.equal(card.canBack, false);
  await assert.rejects(priya.request('botflow.answer', { sessionId: s.id, stepId: 'site', value: 'Moon base' }), /Choose one of: Refinery, Depot/);
  await assert.rejects(ravi.request('botflow.answer', { sessionId: s.id, stepId: 'site', value: 'Depot' }), /not found/, 'only the person whose conversation it is answers');
  const arriving = nextEvent<Message>(priya, 'msg.new', (m) => m.botflow?.stepId === 'permit');
  await priya.request('botflow.answer', { sessionId: s.id, stepId: 'site', value: 'Refinery' });
  assert.equal((await arriving).botflow?.state, 'active', 'the next card arrives ready to answer');
  card = await current(priya, dm);
  assert.equal(card.stepId, 'permit');
  assert.equal(card.stepNo, 2);
  // Back returns to the choice, with the answer given before
  await priya.request('botflow.back', { sessionId: s.id });
  card = await current(priya, dm);
  assert.equal(card.stepId, 'site');
  assert.deepEqual(card.previous, { value: 'Refinery', label: 'Refinery' });
  await assert.rejects(priya.request('botflow.answer', { sessionId: s.id, stepId: 'permit', value: 'WP-1234' }), /already answered/);
  // the Depot branch skips the permit: 6 steps in all
  await priya.request('botflow.answer', { sessionId: s.id, stepId: 'site', value: 'Depot' });
  card = await current(priya, dm);
  assert.equal(card.stepId, 'people');
  assert.equal(card.stepNo, 2);
  assert.equal(card.stepCount, 6);
  await assert.rejects(priya.request('botflow.answer', { sessionId: s.id, stepId: 'people', value: '12' }), /at most 8/);
  // an answer can also be written in the conversation
  await priya.request('msg.send', { convId: dm, body: 'lots', clientId: 'w1' });
  await waitFor(async () => (await priya.request('msg.list', { convId: dm })).messages.find((m) => m.authorId === bot.id && /Write a number/.test(m.body)));
  await priya.request('msg.send', { convId: dm, body: '3', clientId: 'w2' });
  card = await waitFor(async () => { const c = (await cards(priya, dm)).find((m) => m.botflow.state === 'active' && m.botflow.stepId === 'day'); return c?.botflow; });
  const tomorrow = new Date(Date.now() + 86400_000);
  const day = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
  await priya.request('botflow.answer', { sessionId: s.id, stepId: 'day', value: day });
  await priya.request('botflow.answer', { sessionId: s.id, stepId: 'mail', value: '' });

  // Priya leaves; when she comes back on another device the integration offers to carry on
  hub.botflows.resumeAfterMs = 0;
  hub.store.db.prepare('UPDATE bot_sessions SET updated_at = updated_at - 1000 WHERE id = ?').run(s.id);
  const again = await join('priya');
  await owner.request('admin.decide', { deviceId: again.identity.deviceId, approve: true });
  await until(again.c, (st) => st.kind === 'ready');
  const resume = await waitFor(async () => (await cards(priya, dm)).find((m) => m.botflow.kind === 'resume' && m.botflow.state === 'active'));
  assert.match(resume.body, /^Pick up where you left off: Site visit, step 5 of 6\./);
  assert.equal(resume.botflow.stepNo, 5);
  assert.equal((await cards(priya, dm)).filter((m) => m.botflow.state === 'active').length, 1, 'the old step card stands aside');
  await priya.request('botflow.resume', { sessionId: s.id });
  card = await current(priya, dm);
  assert.equal(card.stepId, 'host');
  await assert.rejects(priya.request('botflow.answer', { sessionId: s.id, stepId: 'host', value: me(priya) }), /No one in the office matches/, 'not yourself');
  await priya.request('botflow.answer', { sessionId: s.id, stepId: 'host', value: 'Ravi' });
  card = await current(priya, dm);
  assert.equal(card.stepId, 'ok');
  assert.match(card.prompt ?? '', /- \*\*Site:\*\* Depot/);
  assert.match(card.prompt ?? '', /PPE: Hard hat only/);
  const done = await priya.request('botflow.answer', { sessionId: s.id, stepId: 'ok', value: 'yes' });
  assert.equal(done.done, true);

  // the task is on Ravi's Desk, the Space heard about it, the webhook has the answers
  const tasks = await ravi.request('remind.list');
  const task = tasks.find((t) => t.createdBy === me(priya));
  assert.ok(task, 'a Desk task for the host');
  assert.equal(task.text, `Host 3 from Priya at Depot on ${day}`);
  assert.equal(new Date(task.dueAt).getHours(), 9);
  const posted = (await priya.request('msg.list', { convId: space.id })).messages.find((m) => m.authorId === bot.id);
  assert.equal(posted?.body, 'Site visit booked: Depot, 3 people.');
  const completed = hook.seen.find((x) => x.body.type === 'botflow.completed');
  assert.ok(completed?.signed);
  assert.deepEqual((completed!.body.answers as Record<string, string>).site, 'Depot');
  assert.equal((completed!.body.answers as Record<string, string>).host, me(ravi));
  const end = (await cards(priya, dm)).find((m) => m.botflow.kind === 'done');
  assert.equal(end?.botflow.prompt, 'Booked with Ravi.');
  assert.ok(end?.botflow.notes?.some((n) => /task is on Ravi's Desk/.test(n)));
  assert.ok((await priya.request('msg.list', { convId: dm })).messages.some((m) => m.body === 'Gate pass ordered.'), 'the webhook reply is posted');
  assert.deepEqual(await priya.request('botflow.sessions'), []);
  // Ravi has the details in his own conversation with the integration
  const raviDm = (await ravi.request('conv.list')).find((c) => c.kind === 'direct' && c.members.includes(bot.id));
  assert.ok(raviDm);
  assert.equal((await cards(ravi, raviDm.id)).find((m) => m.botflow.kind === 'summary')?.botflow.requesterId, me(priya));
  again.c.disconnect();
});

test('cancel, expiry and switching a flow off', async () => {
  const { hub, owner, priya } = await office();
  const { token } = await owner.request('admin.bots.create', { name: 'Stores' });
  assert.equal((await api(hub, token, 'PUT', '/api/flows/site-visit', { ...SITE_VISIT, command: undefined })).status, 200);
  const a = await priya.request('botflow.start', { flow: 'site-visit' });
  await priya.request('botflow.cancel', { sessionId: a.sessionId });
  assert.equal((await cards(priya, a.convId)).find((m) => m.botflow.kind === 'step')?.botflow.state, 'cancelled');
  await assert.rejects(priya.request('botflow.answer', { sessionId: a.sessionId, stepId: 'site', value: 'Depot' }), /cancelled/);
  // the same flow again carries on rather than starting twice
  const b = await priya.request('botflow.start', { flow: 'site-visit' });
  assert.equal((await priya.request('botflow.start', { flow: 'site-visit' })).resumed, true);
  assert.equal((await priya.request('botflow.sessions')).length, 1);
  hub.botflows.tick(Date.now() + 8 * 86400_000);
  assert.deepEqual(await priya.request('botflow.sessions'), []);
  assert.equal((await cards(priya, b.convId)).filter((m) => m.botflow.kind === 'step').pop()?.botflow.state, 'expired');
  await assert.rejects(priya.request('botflow.answer', { sessionId: b.sessionId, stepId: 'site', value: 'Depot' }), /expired/);
  // an administrator switches it off; it can no longer be started
  await assert.rejects(priya.request('admin.botflows.enable', { name: 'site-visit', enabled: false }), /administrators/);
  await owner.request('admin.botflows.enable', { name: 'site-visit', enabled: false });
  await assert.rejects(priya.request('botflow.start', { flow: 'site-visit' }), /not available/);
  assert.ok((await owner.request('admin.audit', { limit: 20 })).some((e) => e.action === 'botflow.disabled'));
});

test('writing to the integration starts a flow, and Front Office comes with two', async () => {
  const { priya } = await office();
  const flows = await priya.request('botflow.list');
  assert.deepEqual(flows.filter((f) => f.source === 'builtin').map((f) => f.name).sort(), ['leave-request', 'plot-request']);
  const front = flows[0].botId;
  const dm = await priya.request('conv.create', { kind: 'direct', members: [front] });
  await priya.request('msg.send', { convId: dm.id, body: 'hello', clientId: 'h1' });
  const menu = await waitFor(async () => (await cards(priya, dm.id)).find((m) => m.botflow.kind === 'menu'));
  assert.deepEqual(menu.botflow.flows?.map((f) => f.title).sort(), ['Leave request', 'Request a plot']);
  await priya.request('msg.send', { convId: dm.id, body: 'I need a plot of the GA', clientId: 'h2' });
  const step = await waitFor(async () => (await cards(priya, dm.id)).find((m) => m.botflow.kind === 'step' && m.botflow.state === 'active'));
  assert.equal(step.botflow.title, 'Request a plot');
  assert.equal(step.botflow.stepId, 'job');
  await priya.request('msg.send', { convId: dm.id, body: 'cancel', clientId: 'h3' });
  await waitFor(async () => ((await priya.request('botflow.sessions')).length === 0 ? true : undefined));
});

test('integrations with their own logic keep sessions on the hub and get answers at their webhook', async () => {
  const { hub, owner, priya } = await office();
  const hook = await webhook((b) => {
    if (b.type === 'answer') return { text: `Noted ${b.label}.`, session: { step: 'drawing', data: { qty: b.value }, prompt: { text: 'Which drawing?', input: { kind: 'text' }, of: 2 } } };
    if (b.type === 'message') return { text: `You wrote ${b.text} at step ${b.step}` };
    return {};
  });
  const { bot, token } = await owner.request('admin.bots.create', { name: 'Plot spooler' });
  hook.setSecret((await owner.request('admin.bots.commands', { userId: bot.id, webhookUrl: hook.url, commands: [] })).secret);
  assert.equal((await api(hub, token, 'GET', '/api/sessions/priya')).status, 404);
  assert.equal((await api(hub, token, 'GET', '/api/sessions/nobody')).status, 404);
  const put = await api(hub, token, 'PUT', '/api/sessions/priya', { step: 'qty', data: { job: 'P-12513' }, expiresInDays: 2, prompt: { title: 'Plot spooler', text: 'How many sets?', input: { kind: 'number', min: 1 }, of: 2 } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const session = put.body.session as { id: string; convId: string; step: string; data: Record<string, unknown>; expiresAt: number; startedAt: number };
  assert.equal(session.step, 'qty');
  assert.equal(session.data.job, 'P-12513');
  assert.ok(session.expiresAt - Date.now() <= 2 * 86400_000 + 1000);
  let card = await current(priya, session.convId);
  assert.equal(card.prompt, 'How many sets?');
  assert.equal(card.stepCount, 2);
  await assert.rejects(priya.request('botflow.answer', { sessionId: session.id, stepId: 'qty', value: 'x' }), /number/);
  await priya.request('botflow.answer', { sessionId: session.id, stepId: 'qty', value: '4' });
  const answer = hook.seen.find((x) => x.body.type === 'answer')!;
  assert.ok(answer.signed);
  assert.equal(answer.body.sessionId, session.id);
  assert.equal(answer.body.step, 'qty');
  assert.equal(answer.body.value, '4');
  // its reply moved the session on and showed the next card
  card = await current(priya, session.convId);
  assert.equal(card.stepId, 'drawing');
  assert.equal(card.canBack, true);
  const got = await api(hub, token, 'GET', `/api/sessions/${me(priya)}`);
  assert.deepEqual((got.body.session as { history: string[] }).history, ['qty']);
  assert.deepEqual((got.body.session as { data: unknown }).data, { qty: '4' });
  // what Priya writes goes to the webhook with the session and step
  await priya.request('msg.send', { convId: session.convId, body: 'GA-200', clientId: 'x1' });
  await waitFor(async () => (await priya.request('msg.list', { convId: session.convId })).messages.find((m) => m.body === 'You wrote GA-200 at step drawing'));
  assert.equal(hook.seen.find((x) => x.body.type === 'message')?.body.sessionId, session.id);
  // Back shows the earlier card again and tells the integration
  await priya.request('botflow.back', { sessionId: session.id });
  assert.equal((await current(priya, session.convId)).stepId, 'qty');
  await waitFor(async () => hook.seen.find((x) => x.body.type === 'back'));
  // a hub-run flow and its own state don't mix; ending it works
  assert.equal((await api(hub, token, 'PUT', '/api/sessions/priya', { data: [] })).status, 400);
  assert.equal((await api(hub, token, 'PUT', '/api/sessions/priya', { data: { big: 'x'.repeat(70_000) } })).status, 413);
  assert.equal((await api(hub, token, 'DELETE', '/api/sessions/priya')).status, 200);
  assert.equal((await api(hub, token, 'GET', '/api/sessions/priya')).status, 404);
  assert.equal((await current(priya, session.convId).catch(() => null)), null, 'no card waits any more');
});

