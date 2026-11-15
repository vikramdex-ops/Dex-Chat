import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createIdentity } from '@dex/core';
import type { FileInfo, Message } from '@dex/core';
import { HubClient } from '@dex/core/client';
import type { ClientState } from '@dex/core/client';
import { Hub } from '../src/hub.ts';

const cleanups: Array<() => unknown> = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

function until(c: HubClient, pred: (s: ClientState) => boolean): Promise<void> {
  if (pred(c.state)) return Promise.resolve();
  return new Promise((resolve) => { const on = (s: ClientState) => { if (pred(s)) { c.off('state', on); resolve(); } }; c.on('state', on); });
}

async function office() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexfiles-'));
  const hub = new Hub({ dataDir: dir, port: 0, host: '127.0.0.1', discoveryPort: false, updates: false, maxFileBytes: 200_000 });
  await hub.start();
  cleanups.push(async () => { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const join = async (username: string) => {
    const identity = createIdentity();
    const c = new HubClient({ identity, account: { username, domain: 'DEX', displayName: username, hostname: `${username}-pc` } });
    cleanups.push(() => c.disconnect());
    c.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
    await until(c, (s) => s.kind === 'ready' || s.kind === 'pending');
    return { c, identity };
  };
  const owner = (await join('vikram')).c;
  const approve = async (name: string) => {
    const { c, identity } = await join(name);
    await owner.request('admin.decide', { deviceId: identity.deviceId, approve: true });
    await until(c, (s) => s.kind === 'ready');
    return c;
  };
  return { hub, dir, owner, priya: await approve('priya'), ravi: await approve('ravi') };
}

function req(hub: Hub, method: string, pathname: string, token: string | null, body?: Buffer, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const r = https.request({ host: '127.0.0.1', port: hub.port, path: pathname, method, rejectUnauthorized: false,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-length': String(body.length) } : {}), ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end(body);
  });
}

const upload = async (hub: Hub, c: HubClient, name: string, data: Buffer, type?: string) => {
  const r = await req(hub, 'POST', `/files?name=${encodeURIComponent(name)}${type ? `&type=${encodeURIComponent(type)}` : ''}`, c.session!.fileToken, data);
  return { status: r.status, info: JSON.parse(r.body.toString()) as FileInfo & { error?: string } };
};

test('files upload, travel with messages and are readable only by members', async () => {
  const { hub, owner, priya, ravi } = await office();
  const dm = await owner.request('conv.create', { kind: 'direct', members: [priya.session!.me.id] });
  const pdf = crypto.randomBytes(50_000);
  const { status, info } = await upload(hub, owner, 'ISO-1001 Rev B.pdf', pdf, 'application/pdf');
  assert.equal(status, 200);
  assert.equal(info.name, 'ISO-1001 Rev B.pdf');
  assert.equal(info.size, pdf.length);

  const incoming = new Promise<Message>((r) => priya.on('event', (n: string, d: Message) => { if (n === 'msg.new') r(d); }));
  const sent = await owner.request('msg.send', { convId: dm.id, body: '', clientId: 'f1', files: [info.id] });
  assert.equal(sent.files[0].id, info.id);
  assert.equal((await incoming).files[0].name, 'ISO-1001 Rev B.pdf');
  assert.equal((await priya.request('conv.list')).find((c) => c.id === dm.id)!.lastMessage!.body, '📎 ISO-1001 Rev B.pdf');

  const got = await req(hub, 'GET', `/files/${info.id}`, priya.session!.fileToken);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body, pdf);
  assert.equal(got.headers['content-type'], 'application/octet-stream', 'non-images always download');
  assert.match(String(got.headers['content-disposition']), /^attachment/);

  assert.equal((await req(hub, 'GET', `/files/${info.id}`, ravi.session!.fileToken)).status, 404, 'not in the conversation');
  assert.equal((await req(hub, 'GET', `/files/${info.id}`, null)).status, 401);
  assert.equal((await req(hub, 'GET', `/files/${info.id}`, 'forged')).status, 401);

  const part = await req(hub, 'GET', `/files/${info.id}`, priya.session!.fileToken, undefined, { range: 'bytes=100-199' });
  assert.equal(part.status, 206);
  assert.deepEqual(part.body, pdf.subarray(100, 200));

  const listed = await priya.request('file.list', { convId: dm.id });
  assert.deepEqual(listed.map((f) => f.id), [info.id]);
  // someone else cannot attach a file they cannot see
  await assert.rejects(ravi.request('msg.send', { convId: (await ravi.request('conv.create', { kind: 'direct', members: [owner.session!.me.id] })).id, body: 'x', clientId: 'f2', files: [info.id] }), /no longer available/);
});

test('images display inline, identical files are stored once, limits are enforced', async () => {
  const { hub, dir, owner } = await office();
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), crypto.randomBytes(2000)]);
  const a = await upload(hub, owner, 'site photo.png', png);
  const b = await upload(hub, owner, 'copy.png', png);
  assert.notEqual(a.info.id, b.info.id);
  const blobs = fs.readdirSync(path.join(dir, 'files')).filter((d) => d !== 'tmp').flatMap((d) => fs.readdirSync(path.join(dir, 'files', d)));
  assert.equal(blobs.length, 1, 'stored once');
  const img = await req(hub, 'GET', `/files/${a.info.id}`, owner.session!.fileToken);
  assert.equal(img.headers['content-type'], 'image/png');
  assert.match(String(img.headers['content-disposition']), /^inline/);
  const dl = await req(hub, 'GET', `/files/${a.info.id}?download=1`, owner.session!.fileToken);
  assert.match(String(dl.headers['content-disposition']), /^attachment/);

  const big = await upload(hub, owner, 'huge.bin', crypto.randomBytes(250_000));
  assert.equal(big.status, 413);
  const weird = await upload(hub, owner, '../../etc/passwd', Buffer.from('x'));
  assert.equal(weird.info.name, '.._.._etc_passwd');
});

test('search filters: person, Direct or Spaces, dates, files, paging', async () => {
  const { hub, owner, priya, ravi } = await office();
  const pid = priya.session!.me.id;
  const space = await owner.request('conv.create', { kind: 'space', name: 'Filters', members: [pid, ravi.session!.me.id] });
  const dm = await owner.request('conv.create', { kind: 'direct', members: [pid] });
  let n = 0;
  const say = (c: HubClient, convId: string, body: string, files?: string[]) => c.request('msg.send', { convId, body, clientId: `s${n++}`, files });
  await say(owner, space.id, 'valve schedule draft');
  await say(priya, space.id, 'valve schedule checked');
  await say(owner, dm.id, 'valve schedule private copy');
  const { info } = await upload(hub, ravi, 'Valve list.xlsx', Buffer.from('xlsx'));
  await say(ravi, space.id, 'list attached', [info.id]);

  assert.equal((await priya.request('search', { q: 'valve' })).messages.length, 3);
  assert.deepEqual((await priya.request('search', { q: 'valve', from: pid })).messages.map((m) => m.message.body), ['valve schedule checked']);
  assert.equal((await priya.request('search', { q: 'valve', kind: 'direct' })).messages.length, 1);
  assert.equal((await priya.request('search', { q: 'valve', kind: 'space' })).messages.length, 2);
  assert.equal((await priya.request('search', { q: 'valve', after: Date.now() + 60_000 })).messages.length, 0);
  assert.equal((await priya.request('search', { q: 'valve', before: Date.now() + 60_000 })).messages.length, 3);
  // filters alone: every message with a file, everything in one conversation
  const withFiles = await priya.request('search', { q: '', hasFile: true });
  assert.deepEqual(withFiles.messages.map((m) => m.message.body), ['list attached']);
  assert.equal(withFiles.files[0].name, 'Valve list.xlsx');
  assert.equal((await priya.request('search', { q: '', convId: dm.id })).messages.length, 1);
  assert.equal((await priya.request('search', { q: '', kind: 'space' })).messages.length, 0, 'a kind alone is too broad');
  // paging back
  const first = await priya.request('search', { q: 'valve', limit: 2 });
  const more = await priya.request('search', { q: 'valve', limit: 2, olderThan: first.messages[1].message.id });
  assert.equal(more.messages.length, 1);
  // never someone else's Direct conversation
  assert.equal((await ravi.request('search', { q: 'valve', kind: 'direct' })).messages.length, 0);
  assert.equal((await ravi.request('search', { q: '', convId: dm.id })).messages.length, 0);
});

test('custom emoji: admins add them, everyone can see the image and react with them', async () => {
  const { hub, owner, priya, ravi } = await office();
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), crypto.randomBytes(200)]);
  const { info } = await upload(hub, owner, 'pipe.png', png, 'image/png');
  const { info: mine } = await upload(hub, priya, 'mine.png', png, 'image/png');
  await assert.rejects(priya.request('admin.emoji.add', { name: 'pipe', fileId: mine.id }), /administrators/);
  await assert.rejects(owner.request('admin.emoji.add', { name: 'No Spaces', fileId: info.id }), /lowercase/);
  await assert.rejects(owner.request('admin.emoji.add', { name: 'pipe', fileId: mine.id }), /Upload the image first/);
  const updated = new Promise((r) => ravi.on('event', (n: string, d: unknown) => { if (n === 'emoji.updated') r(d); }));
  const e = await owner.request('admin.emoji.add', { name: ':pipe:', fileId: info.id });
  assert.equal(e.name, 'pipe');
  assert.deepEqual((await updated as Array<{ name: string }>).map((x) => x.name), ['pipe']);
  await assert.rejects(owner.request('admin.emoji.add', { name: 'pipe', fileId: info.id }), /already exists/);
  // anyone can load the image, though it was never sent in a conversation they are in
  assert.equal((await req(hub, 'GET', `/files/${info.id}`, ravi.session!.fileToken)).status, 200);
  assert.equal((await req(hub, 'GET', `/files/${mine.id}`, ravi.session!.fileToken)).status, 404);
  // reactions
  const space = await owner.request('conv.create', { kind: 'space', name: 'Emoji', members: [priya.session!.me.id] });
  const m = await owner.request('msg.send', { convId: space.id, body: 'Pipe rack done :pipe:', clientId: 'e1' });
  const r = await priya.request('msg.react', { messageId: m.id, emoji: ':pipe:', on: true });
  assert.deepEqual(r.reactions[':pipe:'], [priya.session!.me.id]);
  await assert.rejects(priya.request('msg.react', { messageId: m.id, emoji: ':nope:', on: true }), /not supported/);
  // not removed by file clean-up while in use, and removable
  assert.equal(hub.files.gc(Date.now() + 1000), 1, 'only the unused upload is cleaned up');
  assert.ok(hub.files.info(info.id));
  await owner.request('admin.emoji.remove', { name: 'pipe' });
  assert.equal((await priya.request('emoji.list')).length, 0);
});

test('text read from images is searchable, never for Direct conversations', async () => {
  const { hub, owner, priya, ravi } = await office();
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), crypto.randomBytes(100)]);
  const space = await owner.request('conv.create', { kind: 'space', name: 'Scans', members: [priya.session!.me.id] });
  const { info } = await upload(hub, owner, 'IMG_2041.png', png, 'image/png');
  await owner.request('msg.send', { convId: space.id, body: '', clientId: 'o1', files: [info.id] });
  await assert.rejects(priya.request('file.setText', { fileId: info.id, text: 'nope' }), /not found/);
  await owner.request('file.setText', { fileId: info.id, text: 'NOZZLE SCHEDULE\nN1 150# RF  N2 300# RF\nTag V-2201' });
  const r = await priya.request('search', { q: 'v-2201' });
  assert.equal(r.files.length, 1);
  assert.match(r.files[0].textMatch!, /\[\[V-2201\]\]/);
  assert.equal((await priya.request('search', { q: 'nozzle 300' })).files.length, 1, 'every word, anywhere in the text');
  assert.equal((await ravi.request('search', { q: 'v-2201' })).files.length, 0, 'not a member');
  // Direct conversations stay private
  const dm = await owner.request('conv.create', { kind: 'direct', members: [priya.session!.me.id] });
  const { info: d } = await upload(hub, owner, 'private.png', Buffer.concat([png, Buffer.from('x')]), 'image/png');
  await owner.request('msg.send', { convId: dm.id, body: '', clientId: 'o2', files: [d.id] });
  await assert.rejects(owner.request('file.setText', { fileId: d.id, text: 'secret' }), /stay private/);
});

test('an encrypted Direct attachment is stored as the ciphertext it arrived as, under a neutral name', async () => {
  const { hub, dir, owner, priya } = await office();
  const { encryptBytes, decryptBytes, newFileSecret } = await import('@dex/core/e2e-files');
  const plain = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('Tender BOQ: 4.2 crore\n'.repeat(500))]);
  const secret = newFileSecret();
  const sealed = Buffer.from(await encryptBytes(plain, secret));
  const r = await req(hub, 'POST', '/files?name=sealed&sealed=1', owner.session!.fileToken, sealed);
  assert.equal(r.status, 200);
  const info = JSON.parse(r.body.toString()) as FileInfo;
  assert.equal(info.sealed, true);
  assert.equal(info.name, 'Encrypted file');
  assert.equal(info.mime, 'application/octet-stream');
  assert.equal(info.size, sealed.length);
  // on the hub's disk: exactly the ciphertext, nothing of the file
  const sha = crypto.createHash('sha256').update(sealed).digest('hex');
  const blob = fs.readFileSync(path.join(dir, 'files', sha.slice(0, 2), sha));
  assert.deepEqual(blob, sealed);
  assert.notDeepEqual(blob, plain);
  assert.equal(blob.indexOf('crore'), -1);
  assert.equal(blob.indexOf('%PDF'), -1);
  const anyBlob = fs.readdirSync(path.join(dir, 'files')).filter((d) => d !== 'tmp').flatMap((d) => fs.readdirSync(path.join(dir, 'files', d)).map((f) => fs.readFileSync(path.join(dir, 'files', d, f))));
  assert.ok(anyBlob.every((b) => b.indexOf('crore') === -1), 'no stored file holds the text');
  // never read by the hub: no previews, no text, no tools
  assert.equal(hub.files.read(info.id, 10_000_000), null);
  await assert.rejects(owner.request('file.setText', { fileId: info.id, text: 'x' }), /stay private/);
  // only an encrypted Direct message can carry it
  const space = await owner.request('conv.create', { kind: 'space', name: 'Tenders', members: [priya.session!.me.id] });
  await assert.rejects(owner.request('msg.send', { convId: space.id, body: 'here', clientId: 's1', files: [info.id] }), /stay in the end-to-end encrypted Direct conversation/);
  const dm = await owner.request('conv.create', { kind: 'direct', members: [priya.session!.me.id] });
  await assert.rejects(owner.request('msg.send', { convId: dm.id, body: 'plain text', clientId: 's2', files: [info.id] }), /stay in the end-to-end encrypted Direct conversation/);
  // served as an attachment, never inline; a recipient decrypts it back
  const got = await req(hub, 'GET', `/files/${info.id}`, owner.session!.fileToken);
  assert.equal(got.headers['content-type'], 'application/octet-stream');
  assert.match(String(got.headers['content-disposition']), /^attachment; filename\*=UTF-8''Encrypted%20file/);
  assert.deepEqual(Buffer.from(await decryptBytes(got.body, secret)), plain);
  // the type check for encrypted files happens on the sender's device; plain uploads are still checked here
  await owner.request('admin.policy.set', { blockedFileTypes: ['exe'] });
  assert.equal((await upload(hub, owner, 'setup.exe', Buffer.from('MZ'))).status, 403);
});
