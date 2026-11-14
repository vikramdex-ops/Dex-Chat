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
  assert.deepEqual((await priya.request('cmd.list')).map((c) => c.command), ['open']);

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
  assert.equal((await priya.request('cmd.list')).length, 0);
});
