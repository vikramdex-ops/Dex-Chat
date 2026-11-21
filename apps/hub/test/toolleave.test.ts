// Leave for office tools: an integration an administrator allowed reads who is on leave (dates and
// cover only) and whose leave changed, with its integration token (toolleave.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { office, me } from './office.ts';

const later = (days: number) => { const d = new Date(); d.setDate(d.getDate() + days); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

type Reply = { status: number; body: Record<string, unknown> & { ok: boolean } };
function get(port: number, token: string, path: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const r = https.request({ host: '127.0.0.1', port, path, method: 'GET', rejectUnauthorized: false, headers: { authorization: `Bearer ${token}` } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(b) }));
    });
    r.on('error', reject); r.end();
  });
}

test('tool leave: off until an administrator turns it on; then dates and cover only, and a change cursor', async () => {
  const { hub, owner, priya, ravi } = await office();
  const { bot, token } = await owner.request('admin.bots.create', { name: 'Project Opener' });
  assert.equal((await owner.request('admin.bots')).find((b) => b.bot.id === bot.id)?.readsLeave, false);

  // off by default
  const refused = await get(hub.port, token, '/api/bot/leave?account=priya');
  assert.equal(refused.status, 403);
  assert.match(String(refused.body.error), /Reads leave/);
  assert.equal((await get(hub.port, token, '/api/bot/leave/changes')).status, 403);

  // only administrators switch it, and the switch is audited
  await assert.rejects(priya.request('admin.bots.leave', { userId: bot.id, readsLeave: true }), /Only administrators/);
  assert.deepEqual(await owner.request('admin.bots.leave', { userId: bot.id, readsLeave: true }), { ok: true, readsLeave: true });
  assert.equal((await owner.request('admin.bots')).find((b) => b.bot.id === bot.id)?.readsLeave, true);
  assert.ok((await owner.request('admin.audit', { limit: 20 })).some((a) => a.action === 'bot.leave' && a.target === bot.id));

  const none = await get(hub.port, token, '/api/bot/leave?account=priya');
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.leave, []);
  assert.equal((await get(hub.port, token, '/api/bot/leave?account=nobody')).status, 404);
  assert.equal((await get(hub.port, 'dxc_wrong', '/api/bot/leave?account=priya')).status, 401);

  const start = await get(hub.port, token, '/api/bot/leave/changes');
  const cursor = start.body.cursor as number;
  assert.deepEqual(start.body.accounts, []);

  const from = later(2); const to = later(4);
  const noted = await priya.request('nib.leave', { kind: 'sick', from, to, coverId: me(ravi), leadIds: [], handover: 'secret handover', note: 'private note', reminders: 'keep' });
  const changed = await get(hub.port, token, `/api/bot/leave/changes?since=${cursor}`);
  assert.deepEqual(changed.body.accounts, [priya.session!.me.account]);
  assert.ok((changed.body.cursor as number) > cursor);

  const got = await get(hub.port, token, '/api/bot/leave?account=DEX%5Cpriya');
  const cover = ravi.session!.me;
  assert.deepEqual(got.body.leave, [{ id: noted.leave.id, from, to, half: null, current: false, cover: { account: cover.account, name: cover.displayName } }]);
  assert.doesNotMatch(JSON.stringify(got.body), /sick|secret|private/);

  await priya.request('nib.leave.cancel', { id: noted.leave.id });
  const after = await get(hub.port, token, `/api/bot/leave/changes?since=${changed.body.cursor}`);
  assert.deepEqual(after.body.accounts, [priya.session!.me.account]);
  assert.deepEqual((await get(hub.port, token, '/api/bot/leave?account=priya')).body.leave, []);

  // switched off again: refused at once; a revoked token is refused too
  await owner.request('admin.bots.leave', { userId: bot.id, readsLeave: false });
  assert.equal((await get(hub.port, token, '/api/bot/leave?account=priya')).status, 403);
  await owner.request('admin.bots.leave', { userId: bot.id, readsLeave: true });
  await owner.request('admin.bots.revoke', { userId: bot.id });
  assert.equal((await get(hub.port, token, '/api/bot/leave?account=priya')).status, 401);
});
