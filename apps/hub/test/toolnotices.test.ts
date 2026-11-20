// Tool notices (docs/TOOL-NOTICES.md): an office tool tells people something through Nib with its
// integration token. The hub writes the line (the tool's name first), delivers each key once,
// falls back to the integration's own Direct message when Nib is switched off for it or cannot
// write to the person, refuses a flood whole with Retry-After, and tells the tool who is away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import type { Message } from '@dex/core';
import type { Hub } from '../src/hub.ts';
import { NOTICES_PER_MINUTE } from '../src/toolnotices.ts';
import type { NoticeAnswer } from '../src/toolnotices.ts';
import { me, office } from './office.ts';
import { localDate } from '../src/work.ts';

function call<T>(hub: Hub, token: string, method: string, path: string, payload?: unknown): Promise<{ status: number; headers: Record<string, unknown>; body: T }> {
  return new Promise((resolve, reject) => {
    const data = payload === undefined ? null : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
    const r = https.request({ host: '127.0.0.1', port: hub.port, path, method, rejectUnauthorized: false,
      headers: { authorization: `Bearer ${token}`, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: JSON.parse(b) as T }));
    });
    r.on('error', reject); r.end(data ?? undefined);
  });
}
const notify = (hub: Hub, token: string, payload: unknown) => call<NoticeAnswer>(hub, token, 'POST', '/api/bot/notify', payload);
const nibConv = async (c: Awaited<ReturnType<typeof office>>['priya']) => (await c.request('nib.me')).convId!;
const bodies = async (c: Awaited<ReturnType<typeof office>>['priya'], convId: string) => (await c.request('msg.list', { convId })).messages.map((m: Message) => m.body ?? '');

test('hello: a tool checks its token and learns what the hub offers', async () => {
  const { hub, owner } = await office();
  const { bot, token } = await owner.request('admin.bots.create', { name: 'Project Opener' });
  const r = await call<{ ok: boolean; api: number; integration: { id: string; name: string }; hub: { id: string; name: string }; features: string[]; notices: { via: string; perMinute: number } }>(hub, token, 'GET', '/api/bot/hello');
  assert.equal(r.status, 200);
  assert.deepEqual({ ok: r.body.ok, api: r.body.api, integration: r.body.integration }, { ok: true, api: 1, integration: { id: bot.id, name: 'Project Opener' } });
  assert.equal(r.body.hub.id, hub.info.id);
  assert.ok(r.body.features.includes('notify'));
  assert.deepEqual(r.body.notices.via, 'nib');
  assert.equal((await call(hub, 'dxc_wrong', 'GET', '/api/bot/hello')).status, 401);
});

test('a notice arrives in the conversation with Nib, in the tool\'s name, once per key', async () => {
  const { hub, owner, priya, ravi } = await office();
  const { bot, token } = await owner.request('admin.bots.create', { name: 'Project Opener' });
  const notice = {
    to: ['priya', 'DEX\\priya', 'DEX\\ravi', 'nobody'], key: 'task:01J:assigned', kind: 'task', from: 'vikram',
    title: 'Check **ISO-1001** rev B', text: 'Due Friday.', lines: ['3 drawings'],
    link: { title: 'Open in [Project Opener]', url: 'projectopener://open/p(1)' },
  };
  const r = await notify(hub, token, notice);
  assert.equal(r.status, 200);
  assert.deepEqual({ ok: r.body.ok, delivered: r.body.delivered, duplicates: r.body.duplicates, failed: r.body.failed, unknown: r.body.unknown }, { ok: true, delivered: 2, duplicates: 0, failed: 0, unknown: ['nobody'] });
  assert.deepEqual(r.body.results.map((x) => [x.to, x.status, x.via, x.account]), [
    ['priya', 'delivered', 'nib', 'dex\\priya'], ['DEX\\ravi', 'delivered', 'nib', 'dex\\ravi'], ['nobody', 'unknown', undefined, undefined],
  ]);
  const conv = await nibConv(priya);
  const said = (await bodies(priya, conv)).filter((b) => b.startsWith('**Project Opener**'));
  assert.deepEqual(said, ['**Project Opener** · Task · from Vikram\n**Check ISO-1001 rev B**\nDue Friday.\n- 3 drawings\n[Open in Project Opener](projectopener://open/p%281%29)']);
  // it is Nib's message (not the integration's), and a plain line, not one of Nib's cards
  const msg = (await priya.request('msg.list', { convId: conv })).messages.find((m) => (m.body ?? '').startsWith('**Project Opener**'))!;
  assert.equal(msg.authorId, (await priya.request('nib.me')).botId);
  assert.notEqual(msg.authorId, bot.id);
  assert.equal(msg.nib, undefined);
  assert.ok(!(await priya.request('conv.list')).some((c) => c.kind === 'direct' && c.members.includes(bot.id)), 'no conversation with the integration is made');

  // the tool's outbox sends it again (a timeout it could not tell from a failure): nothing is repeated
  const again = await notify(hub, token, { ...notice, to: ['priya', 'ravi'] });
  assert.deepEqual({ status: again.status, ok: again.body.ok, delivered: again.body.delivered, duplicates: again.body.duplicates }, { status: 200, ok: true, delivered: 0, duplicates: 2 });
  assert.equal((await bodies(priya, conv)).filter((b) => b.startsWith('**Project Opener**')).length, 1);
  // a different key is a different notice; another integration's same key is its own
  assert.equal((await notify(hub, token, { ...notice, to: ['priya'], key: 'task:01J:done' })).body.delivered, 1);
  const other = await owner.request('admin.bots.create', { name: 'Hopper' });
  assert.equal((await notify(hub, other.token, { to: ['priya'], key: 'task:01J:assigned', text: 'A file for you' })).body.delivered, 1);
  assert.ok((await bodies(ravi, await nibConv(ravi))).some((b) => b.startsWith('**Project Opener** · Task')));
});

test('without a key the same words are not repeated within ten minutes', async () => {
  const { hub, owner, priya } = await office();
  const { token } = await owner.request('admin.bots.create', { name: 'Sleuth' });
  assert.equal((await notify(hub, token, { to: ['priya'], text: 'Index rebuilt' })).body.delivered, 1);
  assert.equal((await notify(hub, token, { to: ['priya'], text: 'Index rebuilt' })).body.duplicates, 1);
  assert.equal((await notify(hub, token, { to: ['priya'], text: 'Index rebuilt again' })).body.delivered, 1);
  hub.nib.setClock(Date.now() + 11 * 60_000);
  assert.equal((await notify(hub, token, { to: ['priya'], text: 'Index rebuilt' })).body.delivered, 1);
  hub.nib.setClock(null);
  assert.equal((await bodies(priya, await nibConv(priya))).filter((b) => b === '**Sleuth**\nIndex rebuilt').length, 2);
});

test('an administrator switches "through Nib" off: the notice comes from the integration itself', async () => {
  const { hub, owner, priya } = await office();
  const { bot, token } = await owner.request('admin.bots.create', { name: 'Hopper' });
  const row = async () => (await owner.request('admin.bots')).find((b) => b.bot.id === bot.id)!;
  assert.equal((await row()).viaNib, true);
  await assert.rejects(priya.request('admin.bots.notices', { userId: bot.id, viaNib: false }), /Only administrators/);
  assert.deepEqual(await owner.request('admin.bots.notices', { userId: bot.id, viaNib: false }), { ok: true, viaNib: false });
  assert.equal((await call<{ notices: { via: string } }>(hub, token, 'GET', '/api/bot/hello')).body.notices.via, 'integration');
  const r = await notify(hub, token, { to: ['priya'], kind: 'alert', title: '3 files arrived', link: 'https://hopper.office/inbox' });
  assert.deepEqual(r.body.results.map((x) => [x.status, x.via]), [['delivered', 'integration']]);
  const dm = (await priya.request('conv.list')).find((c) => c.kind === 'direct' && c.members.includes(bot.id))!;
  assert.deepEqual(await bodies(priya, dm.id), ['Alert\n**3 files arrived**\nhttps://hopper.office/inbox']);
  assert.ok(!(await bodies(priya, await nibConv(priya))).some((b) => b.includes('3 files arrived')));
  assert.deepEqual({ viaNib: (await row()).viaNib, notices: (await row()).notices }, { viaNib: false, notices: 1 });
  assert.ok((await owner.request('admin.audit', { limit: 20 })).some((a) => a.action === 'bot.notices'));
  // a tool may also ask for its own name for one notice
  await owner.request('admin.bots.notices', { userId: bot.id, viaNib: true });
  assert.equal((await notify(hub, token, { to: ['priya'], text: 'In my own name', via: 'integration' })).body.results[0].via, 'integration');
  assert.equal((await notify(hub, token, { to: ['priya'], text: 'Through Nib again' })).body.results[0].via, 'nib');
});

test('a Space hears the tool in its own name; a missing Space is unknown, not an error', async () => {
  const { hub, owner, priya } = await office();
  const { bot, token } = await owner.request('admin.bots.create', { name: 'Project Opener' });
  const space = await owner.request('conv.create', { kind: 'space', name: 'Piping P-12', members: [me(priya)] });
  const r = await notify(hub, token, { space: 'piping p-12', key: 'wrapped:2026-W47', title: 'Vikram\'s week', lines: ['12 activities'] });
  assert.deepEqual(r.body.results, [{ to: 'space:piping p-12', status: 'delivered', via: 'integration' }]);
  const posted = (await priya.request('msg.list', { convId: space.id })).messages.filter((m) => m.authorId === bot.id);
  assert.deepEqual(posted.map((m) => m.body), ['**Vikram\'s week**\n- 12 activities']);
  assert.equal((await notify(hub, token, { space: 'Piping P-12', key: 'wrapped:2026-W47', title: 'Vikram\'s week' })).body.duplicates, 1);
  const none = await notify(hub, token, { space: 'No such space', text: 'x' });
  assert.deepEqual({ status: none.status, ok: none.body.ok, unknown: none.body.unknown }, { status: 200, ok: false, unknown: ['space:No such space'] });
});

test('someone on leave still gets the notice, and the tool is told when they are back and who covers', async () => {
  const { hub, owner, priya, ravi } = await office();
  const { token } = await owner.request('admin.bots.create', { name: 'Project Opener' });
  const today = localDate(Date.now());
  await priya.request('nib.leave', { kind: 'annual', from: today, to: today, coverId: me(ravi), leadIds: [], spaceIds: [], reminders: 'keep' });
  const r = await notify(hub, token, { to: ['priya', 'ravi'], text: 'Rev C is out' });
  const p = r.body.results.find((x) => x.to === 'priya')!;
  assert.equal(p.status, 'delivered');
  assert.equal(p.away?.cover, 'dex\\ravi');
  assert.match(p.away?.back ?? '', /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(r.body.results.find((x) => x.to === 'ravi')!.away, undefined);
});

test('refusals a tool can act on: bad requests are not retried, a flood is refused whole with Retry-After', async () => {
  const { hub, owner, priya } = await office();
  const { bot, token } = await owner.request('admin.bots.create', { name: 'Project Opener' });
  assert.equal((await notify(hub, 'dxc_wrong', { to: ['priya'], text: 'x' })).status, 401);
  assert.equal((await notify(hub, token, '{nope')).status, 400);
  assert.match((await notify(hub, token, { to: ['priya'] })).body.error ?? '', /Nothing to say/);
  assert.match((await notify(hub, token, { text: 'x' })).body.error ?? '', /Nobody to tell/);
  assert.match((await notify(hub, token, { to: 'priya', text: 'x' })).body.error ?? '', /list of Windows sign-ins/);
  assert.match((await notify(hub, token, { to: Array.from({ length: 51 }, (_, i) => `u${i}`), text: 'x' })).body.error ?? '', /Up to 50/);
  assert.match((await notify(hub, token, { to: ['priya'], text: 'x', key: 'k'.repeat(161) })).body.error ?? '', /160 characters/);
  assert.equal((await notify(hub, token, { to: ['priya'], text: 'x'.repeat(70_000) })).status, 413);
  // a link that is not the web or an office tool is left out, never written as a link
  await notify(hub, token, { to: ['priya'], title: 'Odd link', link: { title: 'Run', url: 'javascript:alert(1)' } });
  assert.ok((await bodies(priya, await nibConv(priya))).includes('**Project Opener**\n**Odd link**'));
  // a bot is nobody to tell; neither is someone who cannot sign in
  assert.deepEqual((await notify(hub, token, { to: [bot.account], text: 'x' })).body.unknown, [bot.account]);

  const people = Array.from({ length: 50 }, (_, i) => `ghost${i}`);
  for (let sent = 9; sent + 50 <= NOTICES_PER_MINUTE; sent += 50) assert.equal((await notify(hub, token, { to: people, text: 'x' })).status, 200);
  const before = (await bodies(priya, await nibConv(priya))).length;
  const flood = await notify(hub, token, { to: ['priya', ...people.slice(1)], text: 'One too many' });
  assert.equal(flood.status, 429);
  assert.ok(Number(flood.headers['retry-after']) >= 1 && flood.body.retryAfterSec === Number(flood.headers['retry-after']));
  assert.equal((await bodies(priya, await nibConv(priya))).length, before, 'nothing of a refused request is delivered');
  // the minute passes: the same request goes through
  hub.nib.setClock(Date.now() + 61_000);
  assert.equal((await notify(hub, token, { to: ['priya'], text: 'One too many' })).body.delivered, 1);
  hub.nib.setClock(null);
});

test('the older Bot API is unchanged beside it', async () => {
  const { hub, owner, priya } = await office();
  const { bot, token } = await owner.request('admin.bots.create', { name: 'Hopper' });
  const r = await call<{ ok: boolean; delivered: string[] }>(hub, token, 'POST', '/api/bot/message', { text: 'Plain as before', to: ['priya'] });
  assert.deepEqual({ status: r.status, delivered: r.body.delivered }, { status: 200, delivered: ['dex\\priya'] });
  assert.ok((await priya.request('conv.list')).some((c) => c.kind === 'direct' && c.members.includes(bot.id)));
  assert.equal((await call(hub, token, 'GET', '/api/bot/nothing')).status, 404);
});
