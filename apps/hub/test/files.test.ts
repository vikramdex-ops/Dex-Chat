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
