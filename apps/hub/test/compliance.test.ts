import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { office, nextEvent, me, send } from './office.ts';

test('retention removes old messages except those on legal hold; holds keep every version', async () => {
  const { hub, owner, priya } = await office();
  const space = await owner.request('conv.create', { kind: 'space', name: 'Bids', members: [me(priya)] });
  const kept = await owner.request('conv.create', { kind: 'space', name: 'Litigation', members: [me(priya)] });
  const a = await send(priya, space.id, 'old quote');
  const b = await send(priya, kept.id, 'old evidence');
  await send(priya, space.id, 'reply', a.id);
  await assert.rejects(priya.request('admin.compliance.setPolicy', { spaceRetentionDays: 30, directRetentionDays: null }), /administrators/);
  await assert.rejects(owner.request('admin.compliance.setPolicy', { spaceRetentionDays: 3, directRetentionDays: null }), /at least 30 days/);
  await owner.request('admin.compliance.setPolicy', { spaceRetentionDays: 30, directRetentionDays: null });
  await owner.request('admin.compliance.hold', { kind: 'conv', targetId: kept.id, note: 'Matter 2026-14' });
  // edits under hold keep the earlier text
  await priya.request('msg.edit', { messageId: b.id, body: 'evidence (corrected)' });
  const removed = nextEvent<{ convId: string; messageIds: string[] }>(priya, 'msg.removed');
  const n = hub.compliance.purge(Date.now() + 31 * 86400_000);
  assert.equal(n, 2, 'the old message and its reply');
  assert.deepEqual((await removed).messageIds.length, 2);
  assert.equal((await priya.request('msg.list', { convId: space.id })).messages.length, 0);
  assert.equal((await priya.request('msg.list', { convId: kept.id })).messages.length, 1, 'held conversation untouched');
  assert.equal((await owner.request('admin.compliance.get')).policy.lastPurged, 2);

  // export with history
  const exp = await owner.request('admin.compliance.export', { convIds: [kept.id], from: 0, to: Date.now() + 1000, format: 'json', includeHistory: true });
  assert.equal(exp.messages, 1);
  const sha = (hub.files.db.prepare('SELECT sha256 FROM files WHERE id = ?').get(exp.file.id) as { sha256: string }).sha256;
  const json = JSON.parse(fs.readFileSync(path.join(hub.files.dir, sha.slice(0, 2), sha), 'utf8')) as { messages: Array<{ text: string; history: Array<{ text: string; change: string }> }> };
  assert.equal(json.messages[0].text, 'evidence (corrected)');
  assert.deepEqual(json.messages[0].history.map((h) => [h.change, h.text]), [['edit', 'old evidence']]);
  await assert.rejects(priya.request('admin.compliance.export', { convIds: [kept.id], from: 0, to: Date.now(), format: 'csv' }), /administrators/);
});

test('exports never include the text of Direct messages', async () => {
  const { hub, owner, priya } = await office();
  const dm = await priya.request('conv.create', { kind: 'direct', members: [me(owner)] });
  await send(priya, dm.id, 'salary discussion');
  const space = await owner.request('conv.create', { kind: 'space', name: 'Open', members: [me(priya)] });
  await send(priya, space.id, 'public note');
  const exp = await owner.request('admin.compliance.export', { userIds: [me(priya)], from: 0, to: Date.now() + 1000, format: 'csv' });
  assert.equal(exp.messages, 2);
  const sha = (hub.files.db.prepare('SELECT sha256 FROM files WHERE id = ?').get(exp.file.id) as { sha256: string }).sha256;
  const csv = fs.readFileSync(path.join(hub.files.dir, sha.slice(0, 2), sha), 'utf8');
  assert.match(csv, /public note/);
  assert.doesNotMatch(csv, /salary/);
  assert.match(csv, /private Direct message/);
  const list = await owner.request('admin.compliance.conversations');
  assert.ok(list.some((c) => c.kind === 'direct' && c.messages === 1));
});
