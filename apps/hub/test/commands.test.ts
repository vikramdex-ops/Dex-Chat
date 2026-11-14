import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Message } from '@dex/core';
import { office, nextEvent, me } from './office.ts';

test('integration slash commands call a signed webhook and post the reply', async () => {
  const { owner, priya } = await office();
  let secret = '';
  const seen: Array<{ body: Record<string, unknown>; ok: boolean }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const sig = crypto.createHmac('sha256', secret).update(`${req.headers['x-dex-timestamp']}.${raw}`).digest('hex');
      const body = JSON.parse(raw) as Record<string, unknown>;
      seen.push({ body, ok: req.headers['x-dex-signature'] === `sha256=${sig}` });
      res.setHeader('content-type', 'application/json');
      if (body.text === 'secret') res.end(JSON.stringify({ text: 'Only you can see this', ephemeral: true }));
      else if (body.text === 'boom') { res.statusCode = 500; res.end('{}'); }
      else res.end(JSON.stringify({ text: `Opened job ${body.text}` }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;

  const { bot } = await owner.request('admin.bots.create', { name: 'Project Opener' });
  await assert.rejects(owner.request('admin.bots.commands', { userId: bot.id, webhookUrl: url, commands: [{ command: 'remind', description: 'x' }] }), /built into the app/);
  await assert.rejects(owner.request('admin.bots.commands', { userId: bot.id, webhookUrl: 'ftp://x', commands: [] }), /http/);
  secret = (await owner.request('admin.bots.commands', { userId: bot.id, webhookUrl: url, commands: [{ command: '/open', description: 'Open a job folder' }] })).secret;
  assert.deepEqual((await priya.request('cmd.list')).filter((c) => c.botId === bot.id).map((c) => c.command), ['open']);

  const space = await owner.request('conv.create', { kind: 'space', name: 'Jobs', members: [me(priya)] });
  const posted = nextEvent<Message>(priya, 'msg.new', (m) => m.authorId === bot.id);
  const r = await priya.request('cmd.run', { convId: space.id, command: 'open', text: 'P-12513' });
  assert.deepEqual(r, { text: 'Opened job P-12513', ephemeral: false });
  assert.equal((await posted).body, 'Opened job P-12513');
  assert.ok(seen[0].ok, 'signature verifies');
  assert.equal((seen[0].body.user as { account: string }).account, priya.session!.me.account);
  const quiet = await priya.request('cmd.run', { convId: space.id, command: 'open', text: 'secret' });
  assert.deepEqual(quiet, { text: 'Only you can see this', ephemeral: true });
  await assert.rejects(priya.request('cmd.run', { convId: space.id, command: 'open', text: 'boom' }), /error \(500\)/);
  await assert.rejects(priya.request('cmd.run', { convId: space.id, command: 'nope', text: '' }), /no \/nope/);
  // revoking the integration removes its commands
  await owner.request('admin.bots.revoke', { userId: bot.id });
  assert.equal((await priya.request('cmd.list')).filter((c) => c.botId === bot.id).length, 0);
});

test('integration message actions get the message, signed; widgets come from the Bot API', async () => {
  const { hub, owner, priya } = await office();
  let secret = '';
  const seen: Array<{ body: { action: { label: string }; message: { text: string; author: { name: string } } }; ok: boolean }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const sig = crypto.createHmac('sha256', secret).update(`${req.headers['x-dex-timestamp']}.${raw}`).digest('hex');
      seen.push({ body: JSON.parse(raw), ok: req.headers['x-dex-signature'] === `sha256=${sig}` });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ text: 'RFI-0042 raised' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  const { bot, token } = await owner.request('admin.bots.create', { name: 'Doc control' });
  secret = (await owner.request('admin.bots.commands', { userId: bot.id, webhookUrl: url, commands: [], actions: [{ label: 'Raise an RFI', scope: 'spaces' }] })).secret;
  const actions = await priya.request('actions.list');
  assert.deepEqual(actions.map((a) => [a.label, a.scope, a.botName]), [['Raise an RFI', 'spaces', 'Doc control']]);
  const sp = await owner.request('conv.create', { kind: 'space', name: 'P-12', members: [me(priya)] });
  const m = await owner.request('msg.send', { convId: sp.id, body: 'Nozzle N3 clashes with the platform', clientId: 'a1' });
  const r = await priya.request('action.run', { actionId: actions[0].id, messageId: m.id });
  assert.deepEqual(r, { text: 'RFI-0042 raised', ephemeral: false });
  assert.equal(seen[0].ok, true);
  assert.equal(seen[0].body.message.text, 'Nozzle N3 clashes with the platform');
  assert.equal(seen[0].body.message.author.name, 'Vikram');
  const dm = await owner.request('conv.create', { kind: 'direct', members: [me(priya)] });
  const dmm = await owner.request('msg.send', { convId: dm.id, body: 'hi', clientId: 'a2' });
  await assert.rejects(priya.request('action.run', { actionId: actions[0].id, messageId: dmm.id }), /Spaces only/);
  // widgets
  const post = (body: unknown) => fetch(`https://127.0.0.1:${hub.port}/api/bot/widget`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const changed = nextEvent<unknown[]>(priya, 'widgets.updated');
  assert.equal((await post({ key: 'plotter', title: 'Plotter queue', lines: ['3 sheets waiting', 'A0 roll low'] })).status, 200);
  assert.equal((await changed).length, 1);
  assert.deepEqual((await priya.request('widgets.list'))[0].lines, ['3 sheets waiting', 'A0 roll low']);
  assert.equal((await post({ key: 'bad key!', title: 'x' })).status, 400);
  await post({ key: 'plotter', remove: true });
  assert.equal((await priya.request('widgets.list')).length, 0);
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
});
