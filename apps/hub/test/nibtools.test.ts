import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import type { Message } from '@dex/core';
import { office, me } from './office.ts';
import { localDate } from '../src/work.ts';

const today = localDate(Date.now());
const later = (days: number) => { const d = new Date(); d.setDate(d.getDate() + days); return localDate(d.getTime()); };

type Reply = { status: number; body: Record<string, unknown> & { ok: boolean } };
function call(port: number, token: string, method: 'GET' | 'POST', path: string, payload?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const data = payload === undefined ? null : Buffer.from(JSON.stringify(payload));
    const r = https.request({ host: '127.0.0.1', port, path, method, rejectUnauthorized: false,
      headers: { authorization: `Bearer ${token}`, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(b) }));
    });
    r.on('error', reject); r.end(data ?? undefined);
  });
}

test('Nib keys for office tools: administrators mint scoped keys; a tool has Nib write to a member, once per id', async () => {
  const { hub, owner, priya } = await office();
  await assert.rejects(priya.request('admin.nib.tools.create', { name: 'Project Opener' }), /Only administrators/);
  await assert.rejects(owner.request('admin.nib.tools.create', { name: ' ' }), /Name the tool/);
  const { tool, token } = await owner.request('admin.nib.tools.create', { name: 'Project Opener', scopes: ['message', 'leave'] });
  assert.match(token, /^nibt_/);
  assert.deepEqual(tool.scopes, ['message', 'leave']);
  const post = (t: string, p: unknown) => call(hub.port, t, 'POST', '/api/nib/message', p);

  const r = await post(token, { id: 'mention-1', to: ['priya', 'nobody'], text: 'Vikram mentioned you in P-12 routing',
    card: { title: 'Open P-12 routing', lines: ['Activity: Area 4'], url: 'projectopener://activity/a1' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.delivered, ['dex\\priya']);
  assert.deepEqual(r.body.unknown, ['nobody']);
  const nibMe = await priya.request('nib.me');
  const msgs = (await priya.request('msg.list', { convId: nibMe.convId! })).messages as Message[];
  const got = msgs.filter((m) => m.body.includes('P-12 routing'));
  assert.equal(got.length, 1);
  assert.equal(got[0].authorId, nibMe.botId);
  assert.match(got[0].body, /^\*Project Opener\*/);
  assert.match(got[0].body, /\*\*\[Open P-12 routing\]\(projectopener:\/\/activity\/a1\)\*\*/);

  // a retry with the same id is not sent twice
  assert.equal((await post(token, { id: 'mention-1', to: ['priya'], text: 'Vikram mentioned you in P-12 routing' })).status, 200);
  const again = (await priya.request('msg.list', { convId: nibMe.convId! })).messages as Message[];
  assert.equal(again.filter((m) => m.body.includes('P-12 routing')).length, 1);

  // links only to the web and the office's tools
  await post(token, { id: 'm2', to: ['priya'], text: 'odd link', card: { title: 'x', url: 'file:///C:/evil.exe' } });
  const odd = ((await priya.request('msg.list', { convId: nibMe.convId! })).messages as Message[]).find((m) => m.body.includes('odd link'))!;
  assert.doesNotMatch(odd.body, /file:/);

  assert.equal((await post(token, { to: ['priya'], text: 'no id' })).status, 400);
  assert.equal((await post(token, { id: 'm3', to: ['priya'] })).status, 400);
  assert.equal((await post('nibt_wrong', { id: 'm4', to: ['priya'], text: 'x' })).status, 401);
  // an ordinary integration token is not a Nib key
  const { token: botToken } = await owner.request('admin.bots.create', { name: 'Hopper' });
  assert.equal((await post(botToken, { id: 'm5', to: ['priya'], text: 'x' })).status, 401);

  const trail = await owner.request('admin.audit', { limit: 50 });
  assert.ok(trail.some((a) => a.action === 'nib.tool.created' && a.target === tool.id));
  assert.ok(trail.some((a) => a.action === 'nib.tool.message' && a.target === tool.id));

  await owner.request('admin.nib.tools.revoke', { id: tool.id });
  assert.equal((await post(token, { id: 'm6', to: ['priya'], text: 'after revoke' })).status, 401);
  const list = await owner.request('admin.nib.tools');
  assert.ok(list.find((k) => k.id === tool.id)?.revokedAt);
  assert.ok((await owner.request('admin.audit', { limit: 50 })).some((a) => a.action === 'nib.tool.revoked'));
});

test('Nib keys for office tools: a member\'s leave (dates and cover only), a change cursor, and scopes enforced', async () => {
  const { hub, owner, priya, ravi } = await office();
  const { token: msgOnly } = await owner.request('admin.nib.tools.create', { name: 'Notifier', scopes: ['message'] });
  assert.equal((await call(hub.port, msgOnly, 'GET', '/api/nib/leave?account=priya')).status, 403);
  const { token } = await owner.request('admin.nib.tools.create', { name: 'Project Opener', scopes: ['leave'] });
  assert.equal((await call(hub.port, token, 'POST', '/api/nib/message', { id: 'x', to: ['priya'], text: 'x' })).status, 403);

  const none = await call(hub.port, token, 'GET', '/api/nib/leave?account=priya');
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.leave, []);
  assert.equal(none.body.today, today);
  assert.equal((await call(hub.port, token, 'GET', '/api/nib/leave?account=nobody')).status, 404);

  const start = await call(hub.port, token, 'GET', '/api/nib/leave/changes');
  const cursor = start.body.cursor as number;
  assert.deepEqual(start.body.accounts, []);

  const from = later(2); const to = later(4);
  const noted = await priya.request('nib.leave', { kind: 'sick', from, to, coverId: me(ravi), leadIds: [], handover: 'secret handover', note: 'private note', reminders: 'keep' });
  const changed = await call(hub.port, token, 'GET', `/api/nib/leave/changes?since=${cursor}`);
  assert.deepEqual(changed.body.accounts, ['dex\\priya']);
  assert.ok((changed.body.cursor as number) > cursor);

  const got = await call(hub.port, token, 'GET', '/api/nib/leave?account=DEX%5Cpriya');
  const ravi_ = ravi.session!.me;
  assert.deepEqual(got.body.leave, [{ id: noted.leave.id, from, to, half: null, current: false, cover: { account: ravi_.account, name: ravi_.displayName } }]);
  assert.doesNotMatch(JSON.stringify(got.body), /sick|secret|private/);

  await priya.request('nib.leave.cancel', { id: noted.leave.id });
  const after = await call(hub.port, token, 'GET', `/api/nib/leave/changes?since=${changed.body.cursor}`);
  assert.deepEqual(after.body.accounts, ['dex\\priya']);
  assert.deepEqual((await call(hub.port, token, 'GET', '/api/nib/leave?account=priya')).body.leave, []);
});
