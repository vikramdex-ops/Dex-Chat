// End-to-end API tests: node --test tests/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = 18000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'lattice-test-'));
let child;

async function call(p, { method = 'GET', token, json, headers = {}, body } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let payload = body;
  if (json !== undefined) {
    h['content-type'] = 'application/json';
    payload = JSON.stringify(json);
  }
  const res = await fetch(BASE + p, { method, headers: h, body: payload });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers, text };
}

const expectOk = async (p, opts) => {
  const r = await call(p, opts);
  assert.ok(r.status < 400, `${p} -> ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};

let admin; let member; let third;

before(async () => {
  child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR, LATTICE_NO_DISCOVERY: '1', LOG_LEVEL: 'error' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not start: ${err}`);
});

after(() => {
  child?.kill('SIGTERM');
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('health endpoint reports workspace state', async () => {
  const h = await expectOk('/api/health');
  assert.equal(h.ok, true);
  assert.equal(h.workspace, 'Office');
  assert.ok(h.version);
});

test('first user becomes admin, second becomes member', async () => {
  admin = await expectOk('/api/join', { method: 'POST', json: { name: 'Priya Raman', device: 'Accounts' } });
  member = await expectOk('/api/join', { method: 'POST', json: { name: 'Vikram Dex', device: 'Engineering' } });
  third = await expectOk('/api/join', { method: 'POST', json: { name: 'Meera S' } });
  assert.equal(admin.user.role, 'admin');
  assert.equal(member.user.role, 'member');
  assert.ok(admin.token.length >= 32);
});

test('joining without a name is rejected', async () => {
  const r = await call('/api/join', { method: 'POST', json: { name: '   ' } });
  assert.equal(r.status, 400);
});

test('unauthenticated API access is rejected', async () => {
  for (const p of ['/api/bootstrap', '/api/peers']) {
    const r = await call(p);
    if (p === '/api/peers') assert.equal(r.status, 200);
    else assert.equal(r.status, 401);
  }
});

test('bootstrap includes general channel and directory', async () => {
  const b = await expectOk('/api/bootstrap', { token: admin.token });
  const general = b.channels.find((c) => c.name === 'general');
  assert.ok(general, 'general channel exists');
  assert.ok(general.members.length >= 3);
  assert.ok(b.users.length >= 3);
});

test('static shell is served with security headers', async () => {
  const r = await call('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('path traversal on static files is blocked', async () => {
  const r = await call('/../package.json');
  assert.notEqual(r.status, 200);
});

test('message send, list and validation', async () => {
  const b = await expectOk('/api/bootstrap', { token: member.token });
  const general = b.channels.find((c) => c.name === 'general');
  const sent = await expectOk(`/api/channels/${general.id}/messages`, {
    method: 'POST', token: member.token, json: { body: 'hello from the LAN' },
  });
  assert.equal(sent.message.body, 'hello from the LAN');
  const list = await expectOk(`/api/channels/${general.id}/messages`, { token: admin.token });
  assert.ok(list.messages.some((m) => m.id === sent.message.id));

  const empty = await call(`/api/channels/${general.id}/messages`, { method: 'POST', token: member.token, json: { body: '  ' } });
  assert.equal(empty.status, 400);
});

test('pagination walks backwards without gaps or repeats', async () => {
  const b = await expectOk('/api/bootstrap', { token: admin.token });
  const general = b.channels.find((c) => c.name === 'general');
  for (let i = 0; i < 25; i += 1) {
    await expectOk(`/api/channels/${general.id}/messages`, { method: 'POST', token: admin.token, json: { body: `bulk ${i}` } });
  }
  const seen = new Set();
  let cursor = null;
  let pages = 0;
  while (pages < 20) {
    const page = await expectOk(`/api/channels/${general.id}/messages?limit=7${cursor ? `&before=${cursor}` : ''}`, { token: admin.token });
    for (const m of page.messages) {
      assert.ok(!seen.has(m.id), 'no duplicate messages across pages');
      seen.add(m.id);
    }
    pages += 1;
    if (!page.hasMore) break;
    cursor = page.oldestCursor;
    assert.ok(cursor, 'cursor provided when more pages exist');
  }
  assert.ok(seen.size >= 26, `saw ${seen.size} messages`);
});

test('replies, threads, reactions, pins, edits and deletes', async () => {
  const b = await expectOk('/api/bootstrap', { token: member.token });
  const general = b.channels.find((c) => c.name === 'general');
  const root = await expectOk(`/api/channels/${general.id}/messages`, { method: 'POST', token: admin.token, json: { body: 'thread root' } });
  const reply = await expectOk(`/api/channels/${general.id}/messages`, {
    method: 'POST', token: member.token, json: { body: 'first reply', replyTo: root.message.id },
  });
  const thread = await expectOk(`/api/messages/${root.message.id}/thread`, { token: admin.token });
  assert.equal(thread.replies.length, 1);
  assert.equal(thread.replies[0].id, reply.message.id);

  const reacted = await expectOk(`/api/messages/${root.message.id}/reactions`, { method: 'POST', token: member.token, json: { emoji: '👍' } });
  assert.equal(reacted.message.reactions.length, 1);
  const unreacted = await expectOk(`/api/messages/${root.message.id}/reactions`, { method: 'POST', token: member.token, json: { emoji: '👍' } });
  assert.equal(unreacted.message.reactions.length, 0);

  const pinned = await expectOk(`/api/messages/${root.message.id}/pin`, { method: 'POST', token: admin.token, json: {} });
  assert.equal(pinned.message.pinned, true);

  const edited = await expectOk(`/api/messages/${reply.message.id}/edit`, { method: 'POST', token: member.token, json: { body: 'edited reply' } });
  assert.equal(edited.message.body, 'edited reply');
  assert.ok(edited.message.editedAt);

  const now = Date.now();
  assert.ok(edited.message.editedAt >= now - 5000);

  const notAuthor = await call(`/api/messages/${reply.message.id}/edit`, { method: 'POST', token: admin.token, json: { body: 'hijack' } });
  assert.equal(notAuthor.status, 403);

  const notMine = await call(`/api/messages/${root.message.id}/delete`, { method: 'POST', token: member.token, json: {} });
  assert.equal(notMine.status, 403, 'a member cannot delete a message they did not write');

  const deleted = await expectOk(`/api/messages/${root.message.id}/delete`, { method: 'POST', token: admin.token, json: {} });
  assert.equal(deleted.message.deleted, true);
  const afterDelete = await expectOk(`/api/channels/${general.id}/messages`, { token: admin.token });
  const gone = afterDelete.messages.find((m) => m.id === root.message.id);
  assert.equal(gone.deleted, true);
  assert.equal(gone.body, '');
});

test('forwarding copies a message into another conversation', async () => {
  const b = await expectOk('/api/bootstrap', { token: admin.token });
  const general = b.channels.find((c) => c.name === 'general');
  const source = await expectOk(`/api/channels/${general.id}/messages`, { method: 'POST', token: admin.token, json: { body: 'forward me' } });
  const dm = await expectOk('/api/channels', { method: 'POST', token: admin.token, json: { kind: 'dm', memberIds: [member.user.id] } });
  const res = await expectOk(`/api/messages/${source.message.id}/forward`, {
    method: 'POST', token: admin.token, json: { channelIds: [dm.channel.id, 'does-not-exist'] },
  });
  assert.equal(res.forwarded, 1);
  const msgs = await expectOk(`/api/channels/${dm.channel.id}/messages`, { token: member.token });
  assert.ok(msgs.messages.some((m) => m.body === 'forward me' && m.forwardedFrom === admin.user.id));
});

test('direct messages are private and reused', async () => {
  const a = await expectOk('/api/channels', { method: 'POST', token: admin.token, json: { kind: 'dm', memberIds: [member.user.id] } });
  const b = await expectOk('/api/channels', { method: 'POST', token: member.token, json: { kind: 'dm', memberIds: [admin.user.id] } });
  assert.equal(a.channel.id, b.channel.id);

  await expectOk(`/api/channels/${a.channel.id}/messages`, { method: 'POST', token: admin.token, json: { body: 'private note' } });
  const peek = await call(`/api/channels/${a.channel.id}/messages`, { token: third.token });
  assert.equal(peek.status, 403);
  const intrude = await call(`/api/channels/${a.channel.id}/messages`, { method: 'POST', token: third.token, json: { body: 'hi' } });
  assert.equal(intrude.status, 403);
  const denied = await call('/api/channels', { method: 'POST', token: third.token, json: { kind: 'dm', memberIds: [admin.user.id] } });
  assert.ok(denied.status === 200 || denied.status === 201, 'anyone may open a DM with someone');
});

test('file upload, dedupe, download and empty-file rejection', async () => {
  const bytes = new TextEncoder().encode('drawing rev C - line list');
  const up = await expectOk('/api/upload', {
    method: 'POST', token: admin.token, body: bytes,
    headers: { 'x-file-name': encodeURIComponent('iso-24013.pdf'), 'content-type': 'application/pdf' },
  });
  assert.equal(up.file.size, bytes.length);

  const again = await expectOk('/api/upload', {
    method: 'POST', token: member.token, body: bytes,
    headers: { 'x-file-name': encodeURIComponent('drawing-copy.pdf'), 'content-type': 'application/pdf' },
  });
  assert.notEqual(again.file.id, up.file.id, 'separate records for separate uploads');

  const onDisk = readdirSync(path.join(DATA_DIR, 'files')).filter((f) => !f.endsWith('.part'));
  assert.equal(onDisk.length, 1, 'identical bytes are stored once');

  const dl = await fetch(`${BASE}/api/files/${up.file.id}`, { headers: { authorization: `Bearer ${member.token}` } });
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  assert.equal(await dl.text(), 'drawing rev C - line list');

  const missing = await call(`/api/upload`, {
    method: 'POST', token: admin.token, body: new Uint8Array(), headers: { 'x-file-name': 'empty.txt' },
  });
  assert.equal(missing.status, 400);
});

test('attachments must exist before a message references them', async () => {
  const b = await expectOk('/api/bootstrap', { token: admin.token });
  const general = b.channels.find((c) => c.name === 'general');
  const r = await call(`/api/channels/${general.id}/messages`, {
    method: 'POST', token: admin.token, json: { body: 'x', fileId: 'nope' },
  });
  assert.equal(r.status, 400);
});

test('search only returns conversations the caller belongs to', async () => {
  const b = await expectOk('/api/bootstrap', { token: admin.token });
  const general = b.channels.find((c) => c.name === 'general');
  await expectOk(`/api/channels/${general.id}/messages`, { method: 'POST', token: admin.token, json: { body: 'unique-token-zebra' } });
  const dm = await expectOk('/api/channels', { method: 'POST', token: admin.token, json: { kind: 'dm', memberIds: [member.user.id] } });
  await expectOk(`/api/channels/${dm.channel.id}/messages`, { method: 'POST', token: admin.token, json: { body: 'secret-zebra' } });

  const asMember = await expectOk('/api/search?q=zebra', { token: member.token });
  assert.ok(asMember.results.some((r) => r.body === 'unique-token-zebra'));
  assert.ok(asMember.results.some((r) => r.body === 'secret-zebra'));

  const asOutsider = await expectOk('/api/search?q=zebra', { token: third.token });
  assert.ok(asOutsider.results.some((r) => r.body === 'unique-token-zebra'), 'shared channel stays searchable');
  assert.ok(!asOutsider.results.some((r) => r.body === 'secret-zebra'), 'DM results never leak to outsiders');
});

test('read state drives unread counts', async () => {
  const b = await expectOk('/api/bootstrap', { token: third.token });
  const general = b.channels.find((c) => c.name === 'general');
  const before = await expectOk('/api/bootstrap', { token: third.token });
  assert.ok(before.channels.find((c) => c.id === general.id).unread > 0);
  const last = await expectOk(`/api/channels/${general.id}/messages`, { token: third.token });
  await expectOk('/api/read', { method: 'POST', token: third.token, json: { channelId: general.id, messageId: last.messages.at(-1).id } });
  const afterRead = await expectOk('/api/bootstrap', { token: third.token });
  assert.equal(afterRead.channels.find((c) => c.id === general.id).unread, 0);
  await expectOk('/api/read-all', { method: 'POST', token: third.token, json: {} });
});

test('channels: create, duplicate, join, rename, leave, delete', async () => {
  const created = await expectOk('/api/channels', { method: 'POST', token: admin.token, json: { name: 'Site Work', topic: 'D-24013', memberIds: [] } });
  assert.equal(created.channel.name, 'site-work');
  const dup = await call('/api/channels', { method: 'POST', token: admin.token, json: { name: 'site work' } });
  assert.equal(dup.status, 409);

  const joined = await expectOk(`/api/channels/${created.channel.id}/join`, { method: 'POST', token: third.token, json: {} });
  assert.ok(joined.channel.members.some((m) => m.id === third.user.id));

  const renamed = await expectOk(`/api/channels/${created.channel.id}`, { method: 'PATCH', token: admin.token, json: { topic: 'rev C issued' } });
  assert.equal(renamed.channel.topic, 'rev C issued');

  const left = await call(`/api/channels/${created.channel.id}/leave`, { method: 'POST', token: third.token, json: {} });
  assert.equal(left.status, 200);

  const deniedDelete = await call(`/api/channels/${created.channel.id}`, { method: 'DELETE', token: member.token });
  assert.equal(deniedDelete.status, 403);
  const deleted = await call(`/api/channels/${created.channel.id}`, { method: 'DELETE', token: admin.token });
  assert.equal(deleted.status, 200);

  const generalDenied = await call('/api/channels', { method: 'DELETE', token: admin.token });
  assert.equal(generalDenied.status, 404);
});

test('general channel cannot be left', async () => {
  const b = await expectOk('/api/bootstrap', { token: admin.token });
  const general = b.channels.find((c) => c.name === 'general');
  const r = await call(`/api/channels/${general.id}/leave`, { method: 'POST', token: admin.token, json: {} });
  assert.equal(r.status, 400);
});

test('admin overview and export are admin-only', async () => {
  const forbidden = await call('/api/admin/overview', { token: member.token });
  assert.equal(forbidden.status, 403);
  const overview = await expectOk('/api/admin/overview', { token: admin.token });
  assert.ok(overview.counts.users >= 3);
  assert.ok(overview.counts.messages > 0);
  const exportRes = await fetch(`${BASE}/api/admin/export`, { headers: { authorization: `Bearer ${admin.token}` } });
  assert.equal(exportRes.status, 200);
  const dump = await exportRes.json();
  assert.ok(Array.isArray(dump.messages));
  assert.ok(dump.users.every((u) => !('token' in u)), 'tokens are never exported');
});

test('roles can be granted but not self-demoted', async () => {
  const promote = await expectOk('/api/users/role', { method: 'POST', token: admin.token, json: { userId: member.user.id, role: 'admin' } });
  assert.equal(promote.user.role, 'admin');
  const selfDemote = await call('/api/users/role', { method: 'POST', token: admin.token, json: { userId: admin.user.id, role: 'member' } });
  assert.equal(selfDemote.status, 400);
  await expectOk('/api/users/role', { method: 'POST', token: admin.token, json: { userId: member.user.id, role: 'member' } });
});

test('unknown endpoints return 404 JSON', async () => {
  const r = await call('/api/nope', { token: admin.token });
  assert.equal(r.status, 404);
  assert.ok(r.data.error);
});

test('server-sent events deliver live messages', async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/api/events?t=${member.token}`, { signal: ctrl.signal });
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const readUntil = async (needle, ms = 5000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const { value, done } = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({ value: undefined }), 300))]);
      if (value) buf += dec.decode(value, { stream: true });
      if (buf.includes(needle)) return true;
      if (done) break;
    }
    return false;
  };
  assert.equal(await readUntil('event: ready'), true);
  const b = await expectOk('/api/bootstrap', { token: admin.token });
  const general = b.channels.find((c) => c.name === 'general');
  await expectOk(`/api/channels/${general.id}/messages`, { method: 'POST', token: admin.token, json: { body: 'live push test' } });
  assert.equal(await readUntil('live push test'), true);
  ctrl.abort();
});

test('mentions are detected, counted and scoped to the conversation', async () => {
  const b = await expectOk('/api/bootstrap', { token: member.token });
  const general = b.channels.find((c) => c.name === 'general');
  await expectOk('/api/read-all', { method: 'POST', token: member.token, json: {} });

  const sent = await expectOk(`/api/channels/${general.id}/messages`, {
    method: 'POST', token: admin.token, json: { body: `@${member.user.name} please review the line list` },
  });
  assert.ok(sent.message.mentions.includes(member.user.id), 'the mentioned person is recorded');

  const fresh = await expectOk('/api/bootstrap', { token: member.token });
  assert.ok(fresh.channels.find((c) => c.id === general.id).mentions >= 1);

  const nobody = await expectOk(`/api/channels/${general.id}/messages`, {
    method: 'POST', token: admin.token, json: { body: '@SomeoneNotHere hello' },
  });
  assert.equal(nobody.message.mentions.length, 0, 'unknown names are not mentions');
});

test('a channel can be muted by one person without affecting others', async () => {
  const b = await expectOk('/api/bootstrap', { token: member.token });
  const general = b.channels.find((c) => c.name === 'general');

  const muted = await expectOk(`/api/channels/${general.id}/mute`, { method: 'POST', token: member.token, json: { muted: true } });
  assert.equal(muted.channel.muted, true);

  const mine = await expectOk('/api/bootstrap', { token: member.token });
  assert.equal(mine.channels.find((c) => c.id === general.id).muted, true);

  const theirs = await expectOk('/api/bootstrap', { token: admin.token });
  assert.equal(theirs.channels.find((c) => c.id === general.id).muted, false, 'mute is per person');

  const unmuted = await expectOk(`/api/channels/${general.id}/mute`, { method: 'POST', token: member.token, json: { muted: false } });
  assert.equal(unmuted.channel.muted, false);
});

test('read receipts report who has caught up, and stay private', async () => {
  const b = await expectOk('/api/bootstrap', { token: admin.token });
  const general = b.channels.find((c) => c.name === 'general');
  const dm = await expectOk('/api/channels', { method: 'POST', token: admin.token, json: { kind: 'dm', memberIds: [member.user.id] } });

  const sent = await expectOk(`/api/channels/${general.id}/messages`, {
    method: 'POST', token: admin.token, json: { body: 'read receipt check' },
  });

  const page = await expectOk(`/api/channels/${general.id}/messages`, { token: admin.token });
  assert.ok(Array.isArray(page.reads), 'message pages carry read state');
  assert.ok(page.reads.every((r) => 'userId' in r && 'messageId' in r));

  await expectOk('/api/read', { method: 'POST', token: member.token, json: { channelId: general.id, messageId: sent.message.id } });
  const reads = await expectOk(`/api/channels/${general.id}/reads`, { token: admin.token });
  const theirs = reads.reads.find((r) => r.userId === member.user.id);
  assert.equal(theirs.messageId, sent.message.id);
  assert.ok(theirs.readAt >= sent.message.createdAt);

  const outsider = await call(`/api/channels/${dm.channel.id}/reads`, { token: third.token });
  assert.equal(outsider.status, 403, 'outsiders cannot read a private conversation\'s receipts');
});

test('discovery reports this server', async () => {
  const p = await expectOk('/api/peers');
  assert.ok(p.self.hostname);
  assert.ok(Array.isArray(p.peers));
});
