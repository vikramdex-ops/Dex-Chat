import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromMrkdwn, slackToMarkdown } from '../src/slack.ts';

test('Slack mrkdwn and payloads become Markdown', () => {
  assert.equal(fromMrkdwn('*Build* _passed_ on <https://ci.example/1|run 1> ~old~ <!here>'), '**Build** *passed* on [run 1](https://ci.example/1) ~~old~~ @here');
  assert.equal(fromMrkdwn('a &lt;b&gt; &amp; c'), 'a <b> & c');
  const md = slackToMarkdown({
    text: 'Deploy finished',
    blocks: [{ type: 'header', text: { type: 'plain_text', text: 'Release 2.3' } }, { type: 'section', text: { type: 'mrkdwn', text: '*All* checks green' }, fields: [{ type: 'mrkdwn', text: '*Env:* prod' }] }, { type: 'divider' }],
    attachments: [{ color: 'good', title: 'Grafana', title_link: 'https://grafana.example/d/1', text: 'CPU normal', fields: [{ title: 'Host', value: 'hub-pc' }], footer: 'Grafana' }],
  });
  assert.equal(md, 'Deploy finished\n\n### Release 2.3\n\n**All** checks green\n\n- **Env:** prod\n\n---\n\n> **[Grafana](https://grafana.example/d/1)**\n> CPU normal\n> - **Host:** hub-pc\n> *Grafana*');
  assert.equal(slackToMarkdown({}), '');
});

import https from 'node:https';
import { office, me } from './office.ts';

const post = (port: number, path: string, body: string, type = 'application/json') => new Promise<{ status: number; text: string }>((resolve, reject) => {
  const r = https.request({ host: '127.0.0.1', port, path, method: 'POST', rejectUnauthorized: false, headers: { 'content-type': type, 'content-length': Buffer.byteLength(body) } }, (res) => {
    let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, text: t }));
  });
  r.on('error', reject); r.end(body);
});

test('a Slack-style webhook posts into its Space as the integration; revoking stops it', async () => {
  const { hub, owner, priya } = await office();
  const space = await owner.request('conv.create', { kind: 'space', name: 'Builds', members: [me(priya)] });
  const { bot } = await owner.request('admin.bots.create', { name: 'Jenkins' });
  await assert.rejects(priya.request('admin.hooks.create', { botId: bot.id, convId: space.id }), /administrator/i);
  const hook = await owner.request('admin.hooks.create', { botId: bot.id, convId: space.id });
  const ok = await post(hub.port, hook.path, JSON.stringify({ text: '*Build #42* passed on <https://ci.example/42|main>' }));
  assert.deepEqual(ok, { status: 200, text: 'ok' });
  const form = await post(hub.port, hook.path, `payload=${encodeURIComponent(JSON.stringify({ attachments: [{ title: 'Deploy', text: 'done' }] }))}`, 'application/x-www-form-urlencoded');
  assert.equal(form.status, 200);
  const msgs = (await priya.request('msg.list', { convId: space.id })).messages.filter((m) => m.authorId === bot.id).map((m) => m.body);
  assert.deepEqual(msgs, ['**Build #42** passed on [main](https://ci.example/42)', '> **Deploy**\n> done']);
  assert.equal((await post(hub.port, '/api/hooks/' + 'x'.repeat(32), '{"text":"hi"}')).status, 404);
  assert.equal((await post(hub.port, hook.path, '{}')).status, 400);
  assert.equal((await owner.request('admin.hooks.list'))[0].convName, 'Builds');
  await owner.request('admin.bots.revoke', { userId: bot.id });
  assert.equal((await post(hub.port, hook.path, '{"text":"after revoke"}')).status, 404);
});
