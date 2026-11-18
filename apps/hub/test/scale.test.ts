// The hub at office scale: the queries rewritten for speed give the same answers as before, the
// search index keeps its order through edits, deletions and an upgrade, and the people list is read
// again after every change to people. Seeded with scripts/seed-office.ts (a small office here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PublicUser } from '@dex/core';
import { Hub } from '../src/hub.ts';
import { cacheStatements } from '../src/store.ts';
import { seedOffice } from '../scripts/seed-office.ts';
import { cleanups, me, office, send } from './office.ts';

async function seeded(people = 30, conversations = 40, messages = 4000) {
  const o = await office();
  const r = seedOffice(o.hub.store.db, { meId: me(o.priya), ownerId: me(o.owner), people, conversations, messages: 60_000, scale: messages / 60_000 });
  return { ...o, seed: r, viewer: o.hub.store.userById(me(o.priya))! };
}

test('the Switchboard list is the same as each conversation looked up on its own', async () => {
  const { hub, priya, owner, viewer } = await seeded();
  // some unread, mentions, a muted and a pinned conversation, a moderator, read receipts off
  const list = await priya.request('conv.list');
  assert.equal(list.length, 40);
  // the seeded history may leave no unread mention of this person (its message ids vary by run): make one
  const direct = await owner.request('conv.create', { kind: 'direct', members: [viewer.id] });
  await send(owner, direct.id, `<@${viewer.id}> the revised GA is in`);
  await priya.request('conv.mute', { convId: list[3].id, muted: true });
  await priya.request('conv.organise', { convId: list[4].id, pinned: true, section: 'Clients' });
  hub.store.db.prepare('UPDATE users SET receipts = 0 WHERE id = (SELECT id FROM users WHERE id != ? LIMIT 1)').run(viewer.id);
  hub.store.db.prepare('UPDATE conv_members SET moderator = 1 WHERE conv_id = ? AND user_id != ?').run(list[5].id, viewer.id);
  const rows = hub.store.db.prepare('SELECT c.* FROM conversations c JOIN conv_members m ON m.conv_id = c.id WHERE m.user_id = ?').all(viewer.id) as never[];
  const one = rows.map((c) => hub.messaging.view(c, viewer.id));
  const many = hub.messaging.handle('conv.list', viewer, {}) as typeof one;
  assert.deepEqual(many, one);
  assert.ok(many.some((c) => c.unread > 0) && many.some((c) => c.mentions > 0) && many.some((c) => c.muted) && many.some((c) => c.pinnedAt) && many.some((c) => c.moderators.length));
});

test('search: newest first, a page at a time, through edits and deletions', async () => {
  const { hub, priya, owner, seed, viewer } = await seeded();
  const db = hub.store.db;
  const expect = (q: string, extra = '', args: unknown[] = []) => (db.prepare(`SELECT m.id FROM messages_fts f JOIN messages m ON m.id = f.message_id
    JOIN conv_members cm ON cm.conv_id = m.conv_id AND cm.user_id = ? WHERE messages_fts MATCH ? AND m.deleted = 0 AND m.system IS NULL ${extra}
    ORDER BY m.id DESC LIMIT 20`).all(viewer.id, q, ...args as never[]) as Array<{ id: string }>).map((r) => r.id);
  const got = async (d: Record<string, unknown>) => (await priya.request('search', d as never)).messages.map((x) => x.message.id);
  assert.deepEqual(await got({ q: 'nozzle' }), expect('"nozzle"*'));
  assert.deepEqual(await got({ q: 'valve flange' }), expect('"valve"* "flange"*'));
  assert.deepEqual(await got({ q: 'pipe', convId: seed.busyConvId }), expect('"pipe"*', 'AND m.conv_id = ?', [seed.busyConvId]));
  const first = await got({ q: 'nozzle' });
  assert.deepEqual(await got({ q: 'nozzle', olderThan: first.at(-1) }), expect('"nozzle"*', 'AND m.id < ?', [first.at(-1)]));
  // filters without words walk the messages by id
  const byFile = (db.prepare(`SELECT m.id FROM messages m JOIN conv_members cm ON cm.conv_id = m.conv_id AND cm.user_id = ?
    WHERE m.deleted = 0 AND m.system IS NULL AND EXISTS (SELECT 1 FROM message_files x WHERE x.message_id = m.id) ORDER BY m.id DESC LIMIT 20`).all(viewer.id) as Array<{ id: string }>).map((r) => r.id);
  assert.deepEqual(await got({ q: '', hasFile: true }), byFile);
  // a new message comes first; an edited old one keeps its place; a deleted one is gone
  const fresh = await send(priya, seed.busyConvId, 'A zebracrossing nozzle note');
  assert.equal((await got({ q: 'nozzle' }))[0], fresh.id);
  const old = first[5];
  const oldRow = db.prepare('SELECT author_id FROM messages WHERE id = ?').get(old) as { author_id: string };
  if (oldRow.author_id === viewer.id) {
    db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(Date.now(), old); // inside the edit window
    await priya.request('msg.edit', { messageId: old, body: 'nozzle zebracrossing edited' });
    const after = await got({ q: 'zebracrossing' });
    assert.deepEqual(after, [fresh.id, old]);
  }
  await priya.request('msg.delete', { messageId: fresh.id });
  assert.ok(!(await got({ q: 'zebracrossing' })).includes(fresh.id));
  void owner;
});

test('a hub with the earlier search index is renumbered once, keeping what was indexed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexfts-'));
  let hub = new Hub({ dataDir: dir, port: 0, host: '127.0.0.1', discoveryPort: false, updates: false });
  await hub.start();
  const db0 = hub.store.db;
  db0.prepare("INSERT INTO users (id, account, display_name, role, created_at) VALUES ('01HZZZZZZZZZZZZZZZZZZZZZZZ', 'DEX\\\\amy', 'Amy', 'owner', 0)").run();
  db0.prepare("INSERT INTO devices (id, user_id, public_key, hostname, status, created_at) VALUES ('01HZZZZZZZZZZZZZZZZZZZZZZY', '01HZZZZZZZZZZZZZZZZZZZZZZZ', 'k', 'PC', 'approved', 0)").run();
  hub.messaging.ensureEveryoneSpace('01HZZZZZZZZZZZZZZZZZZZZZZZ');
  hub.messaging.welcome('01HZZZZZZZZZZZZZZZZZZZZZZZ');
  const amy = hub.store.userById('01HZZZZZZZZZZZZZZZZZZZZZZZ')!;
  const convId = (db0.prepare('SELECT id FROM conversations WHERE everyone = 1').get() as { id: string }).id;
  const ids: string[] = [];
  for (let i = 0; i < 30; i++) ids.push((hub.messaging.handle('msg.send', amy, { convId, body: `flange report ${i}`, clientId: `c${i}` }) as { id: string }).id);
  // the earlier layout: index rows numbered in any order, no search_rows
  db0.exec(`CREATE TEMP TABLE x AS SELECT body, message_id, conv_id FROM messages_fts; DELETE FROM messages_fts; DELETE FROM search_rows; DELETE FROM search_layout;
    INSERT INTO messages_fts (rowid, body, message_id, conv_id) SELECT abs(random() % 1000000) + 1, body, message_id, conv_id FROM x; DROP TABLE x;`);
  await hub.stop();
  hub = new Hub({ dataDir: dir, port: 0, host: '127.0.0.1', discoveryPort: false, updates: false });
  await hub.start();
  cleanups.push(async () => { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const res = hub.messaging.handle('search', amy, { q: 'flange', limit: 50 }) as { messages: Array<{ message: { id: string }; snippet: string }> };
  assert.deepEqual(res.messages.map((m) => m.message.id), [...ids].reverse());
  assert.match(res.messages[0].snippet, /\[\[flange\]\]/);
  assert.equal((hub.store.db.prepare('SELECT COUNT(*) AS n FROM search_rows').get() as { n: number }).n, 30);
});

test('the Activity feed and side-tracks list match the queries they replace', async () => {
  const { hub, viewer } = await seeded(30, 40, 6000);
  const db = hub.store.db;
  const id = viewer.id;
  const since = Date.now() - 60 * 86400_000;
  const before = db.prepare(`SELECT m.id, mn.user_id AS mentioned FROM messages m
    JOIN conv_members cm ON cm.conv_id = m.conv_id AND cm.user_id = ?
    LEFT JOIN mentions mn ON mn.message_id = m.id AND mn.user_id = ?
    WHERE m.deleted = 0 AND m.system IS NULL AND m.author_id != ? AND m.created_at > ? AND ((mn.user_id IS NOT NULL OR m.body LIKE '%<@all>%') OR (m.parent_id IS NOT NULL AND (EXISTS (SELECT 1 FROM messages p WHERE p.id = m.parent_id AND p.author_id = ?)
    OR EXISTS (SELECT 1 FROM messages r WHERE r.parent_id = m.parent_id AND r.author_id = ? AND r.id < m.id))))
    ORDER BY m.id DESC LIMIT 41`).all(id, id, id, since, id, id) as Array<{ id: string }>;
  const feed = hub.messaging.handle('activity.list', viewer, {}) as { items: Array<{ message: { id: string } }>; hasMore: boolean };
  assert.ok(before.length > 10);
  assert.deepEqual(feed.items.map((x) => x.message.id), before.slice(0, 40).map((r) => r.id));
  assert.equal(feed.hasMore, before.length > 40);
  const tracks = db.prepare(`SELECT p.id, MAX(r.created_at) AS last, COUNT(r.id) AS n FROM messages p
    JOIN messages r ON r.parent_id = p.id AND r.deleted = 0
    JOIN conv_members cm ON cm.conv_id = p.conv_id AND cm.user_id = ?
    WHERE p.deleted = 0 AND (p.author_id = ? OR EXISTS (SELECT 1 FROM messages x WHERE x.parent_id = p.id AND x.author_id = ?))
    GROUP BY p.id ORDER BY last DESC, p.id`).all(id, id, id) as Array<{ id: string; last: number; n: number }>;
  const got = hub.messaging.handle('activity.tracks', viewer, {}) as Array<{ parent: { id: string }; lastReplyAt: number; replyCount: number }>;
  assert.ok(tracks.length > 5);
  // (side-tracks whose last replies came at the same moment may be listed in either order)
  const key = (x: { id: string; last: number; n: number }) => `${x.last}:${x.n}:${x.id}`;
  const want = new Set(tracks.slice(0, 40).map(key));
  const cut = tracks[Math.min(39, tracks.length - 1)].last;
  for (const t of got) assert.ok(want.has(key({ id: t.parent.id, last: t.lastReplyAt, n: t.replyCount })) || t.lastReplyAt === cut);
  assert.equal(got.length, Math.min(40, tracks.length));
});

test('the people list is read again after any change to people, profiles or devices', async () => {
  const { hub, owner, priya } = await office();
  const names = () => hub.store.activeUsers().map((u: PublicUser) => u.displayName);
  assert.ok(names().includes('Priya'));
  await priya.request('me.update', { displayName: 'Priya Raman' });
  assert.ok(names().includes('Priya Raman'));
  hub.store.db.prepare("UPDATE profiles SET extension = '414' WHERE account = (SELECT account FROM users WHERE id = ?)").run(me(priya));
  hub.store.db.prepare("INSERT OR IGNORE INTO profiles (account, extension) SELECT account, '414' FROM users WHERE id = ?").run(me(priya));
  assert.equal(hub.store.activeUsers().find((u) => u.id === me(priya))!.profile.extension, '414');
  hub.store.db.prepare("UPDATE devices SET status = 'revoked' WHERE user_id = ?").run(me(priya));
  assert.ok(!names().includes('Priya Raman'));
  // the list handed out is a copy: changing it changes nothing kept
  const list = hub.store.activeUsers();
  list.length = 0;
  assert.ok(hub.store.activeUsers().length > 0);
  void owner;
});

test('a kept statement gives the same rows as a freshly prepared one', () => {
  const db = new DatabaseSync(':memory:');
  cacheStatements(db, 3);
  db.exec('CREATE TABLE t (a INTEGER)');
  for (let i = 0; i < 10; i++) db.prepare('INSERT INTO t (a) VALUES (?)').run(i);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get()!.n, 10);
  assert.equal(db.prepare('SELECT a FROM t WHERE a > ?').all(6).length, 3);
  assert.equal(db.prepare('SELECT a FROM t WHERE a > ?').all(2).length, 7);
  // more statements than it keeps: older ones are compiled again
  for (let i = 0; i < 5; i++) assert.equal(db.prepare(`SELECT ${i} AS v`).get()!.v, i);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get()!.n, 10);
});
