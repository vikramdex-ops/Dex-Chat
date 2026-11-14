// Data-loss rules, blocked file types and allowed outside networks (Control room ▸ Policies).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { office, me, send } from './office.ts';

const post = (port: number, path: string, token: string, body: Buffer) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const r = https.request({ host: '127.0.0.1', port, path, method: 'POST', rejectUnauthorized: false, headers: { authorization: `Bearer ${token}`, 'content-length': String(body.length) } }, (res) => {
    let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: s }));
  });
  r.on('error', reject); r.end(body);
});

test('card numbers are masked, chosen words are blocked, edits too; file types and networks', async () => {
  const { hub, owner, priya } = await office();
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Accounts', members: [me(priya)] });
  await assert.rejects(priya.request('admin.policy.set', { dlp: [] }), /administrators/);
  const p = await owner.request('admin.policy.set', { dlp: [
    { id: 'c', name: 'Card numbers', detector: 'card', action: 'mask', scope: 'everywhere' },
    { id: 'w', detector: 'words', words: 'Project Falcon', name: 'Project Falcon', action: 'block', scope: 'everywhere' },
  ] });
  assert.equal(p.dlp?.length, 2);
  const m = await send(priya, sp.id, 'Charge 4111 1111 1111 1111 for the plotter');
  assert.equal(m.body, 'Charge •••• for the plotter');
  await assert.rejects(send(priya, sp.id, 'Notes on project falcon'), /doesn't allow project falcon/);
  const ok = await send(priya, sp.id, 'Fine');
  await assert.rejects(priya.request('msg.edit', { messageId: ok.id, body: 'Project Falcon is late' }), /Not sent/);
  const ed = await priya.request('msg.edit', { messageId: ok.id, body: 'Card 5500 0000 0000 0004' });
  assert.equal(ed.body, 'Card ••••');
  // file types
  await owner.request('admin.policy.set', { blockedFileTypes: ['.EXE', 'bat', 'not a type!'] });
  assert.deepEqual((await priya.request('policy.get')).blockedFileTypes, ['exe', 'bat']);
  const up = await post(hub.port, '/files?name=setup.exe', priya.session!.fileToken, Buffer.from('MZ'));
  assert.equal(up.status, 403);
  assert.match(up.body, /\.exe files/);
  assert.equal((await post(hub.port, '/files?name=notes.txt', priya.session!.fileToken, Buffer.from('ok'))).status, 200);
  // networks: checked when saved
  await assert.rejects(owner.request('admin.policy.set', { outsideNetworks: ['10.0.0.0/8', 'my office'] }), /not an address or network/);
  assert.deepEqual((await owner.request('admin.policy.set', { outsideNetworks: ['203.0.113.0/24'] })).outsideNetworks, ['203.0.113.0/24']);
});
