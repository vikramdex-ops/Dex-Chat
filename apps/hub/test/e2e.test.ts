import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity, signWith } from '@dex/core';
import { createEncKeys, isSealed } from '@dex/core/e2e';
import { E2EClient } from '@dex/core/e2e-client';
import type { FileInfo, Message } from '@dex/core';
import https from 'node:https';
import { HubClient } from '@dex/core/client';
import { office, until, me, cleanups } from './office.ts';

async function person(hub: { port: number; fingerprint: string }, owner: HubClient, username: string) {
  const identity = createIdentity();
  const c = new HubClient({ identity, account: { username, domain: 'DEX', displayName: username, hostname: `${username}-pc` } });
  cleanups.push(() => c.disconnect());
  c.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
  await until(c, (s) => s.kind === 'pending' || s.kind === 'ready');
  if (c.state.kind === 'pending') await owner.request('admin.decide', { deviceId: identity.deviceId, approve: true });
  await until(c, (s) => s.kind === 'ready');
  const keys = createEncKeys();
  const e2e = new E2EClient({ deviceId: identity.deviceId, encSecret: keys.secret, encPublic: keys.public, sign: (p) => signWith(identity, p), request: (op, d) => c.request(op as never, d as never) });
  await e2e.ready(c.session!.me.id, []);
  // what the app does: everything through the E2E layer
  const req = async (op: string, d?: unknown) => e2e.incoming(await c.request(op as never, await e2e.outgoing(op, d) as never));
  return { c, e2e, req, identity };
}

test('Direct messages are sealed end to end; the hub never sees the text; new devices get history', async () => {
  const { hub, owner } = await office();
  const a = await person(hub, owner, 'asha');
  const b = await person(hub, owner, 'bala');
  const dm = await a.c.request('conv.create', { kind: 'direct', members: [me(b.c)] });
  await a.e2e.ready(me(a.c), []);
  assert.equal((await a.e2e.status(dm.id)).encrypted, true);
  const sent = await a.req('msg.send', { convId: dm.id, body: 'Tender price is 4.2 crore', clientId: 'x1' }) as Message;
  assert.equal(sent.body, 'Tender price is 4.2 crore');
  assert.equal(sent.e2e, 'ok');
  // on the hub: only the envelope
  const raw = hub.messaging['db'].prepare('SELECT body FROM messages WHERE id = ?').get(sent.id) as { body: string };
  assert.ok(isSealed(raw.body));
  assert.doesNotMatch(raw.body, /crore/);
  assert.equal((await owner.request('search', { q: 'crore' })).messages.length, 0);
  const preview = (await b.c.request('conv.list')).find((c) => c.id === dm.id)!.lastMessage!.body;
  assert.equal(preview, '🔒 Encrypted message');
  // Bala reads it
  const list = await b.req('msg.list', { convId: dm.id }) as { messages: Message[] };
  assert.equal(list.messages[0].body, 'Tender price is 4.2 crore');
  assert.equal(list.messages[0].e2e, 'ok');
  // edits stay sealed
  await a.req('msg.edit', { messageId: sent.id, body: 'Tender price is 4.1 crore' });
  const edited = await b.req('msg.list', { convId: dm.id }) as { messages: Message[] };
  assert.equal(edited.messages[0].body, 'Tender price is 4.1 crore');
  // Bala's new laptop: cannot read old messages until one of his devices shares them
  const laptopId = createIdentity();
  const lc = new HubClient({ identity: laptopId, account: { username: 'bala', domain: 'DEX', displayName: 'bala', hostname: 'bala-laptop' } });
  cleanups.push(() => lc.disconnect());
  lc.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
  await until(lc, (s) => s.kind === 'pending');
  await owner.request('admin.decide', { deviceId: laptopId.deviceId, approve: true });
  await until(lc, (s) => s.kind === 'ready');
  const lkeys = createEncKeys();
  const le2e = new E2EClient({ deviceId: laptopId.deviceId, encSecret: lkeys.secret, encPublic: lkeys.public, sign: (p) => signWith(laptopId, p), request: (op, d) => lc.request(op as never, d as never) });
  await le2e.ready(me(lc), []);
  const before = await le2e.incoming(await lc.request('msg.list', { convId: dm.id }));
  assert.equal(before.messages[0].e2e, 'locked');
  // Bala's PC hears about the new key and shares
  await b.e2e.onEvent('e2e.keysChanged', { userId: me(b.c), deviceId: laptopId.deviceId });
  const after = await le2e.incoming(await lc.request('msg.list', { convId: dm.id }));
  assert.equal(after.messages[0].body, 'Tender price is 4.1 crore');
  // forwarding an encrypted message into a Space posts readable text there
  const space = await a.c.request('conv.create', { kind: 'space', name: 'Bids', members: [me(b.c)] });
  const fwd = await a.req('msg.forward', { messageId: sent.id, convIds: [space.id] }) as Message[];
  assert.equal(fwd[0].body, 'Tender price is 4.1 crore');
  await assert.rejects(a.c.request('msg.forward', { messageId: sent.id, convIds: [space.id] }), /only be forwarded from the app/);
  lc.disconnect();
});

test('a Direct conversation with someone on an old app stays readable (not sealed)', async () => {
  const { hub, owner, priya } = await office();
  const a = await person(hub, owner, 'asha');
  const dm = await a.c.request('conv.create', { kind: 'direct', members: [me(priya)] });
  assert.deepEqual((await a.e2e.status(dm.id)).missing, [me(priya)]);
  const sent = await a.req('msg.send', { convId: dm.id, body: 'hello', clientId: 'y1' }) as Message;
  assert.equal(sent.e2e, undefined);
  assert.equal((await priya.request('msg.list', { convId: dm.id })).messages[0].body, 'hello');
});

test("the office's data-loss rules run on the sender's device before a Direct message is sealed", async () => {
  const { hub, owner } = await office();
  await owner.request('admin.policy.set', { dlp: [
    { id: 'c', name: 'Card numbers', detector: 'card', action: 'mask', scope: 'everywhere' },
    { id: 'w', name: 'Project Falcon', detector: 'words', words: 'Project Falcon', action: 'block', scope: 'everywhere' },
  ] });
  const a = await person(hub, owner, 'asha');
  const b = await person(hub, owner, 'bala');
  const dm = await a.c.request('conv.create', { kind: 'direct', members: [me(b.c)] });
  await a.e2e.ready(me(a.c), []);
  assert.equal((await a.e2e.status(dm.id)).encrypted, true);
  await assert.rejects(a.req('msg.send', { convId: dm.id, body: 'Project Falcon numbers', clientId: 'f1' }), /doesn't allow project falcon/);
  const sent = await a.req('msg.send', { convId: dm.id, body: 'Pay with 4111 1111 1111 1111', clientId: 'f2' }) as Message;
  assert.equal(sent.body, 'Pay with ••••');
  const raw = hub.messaging['db'].prepare('SELECT body FROM messages WHERE id = ?').get(sent.id) as { body: string };
  assert.ok(isSealed(raw.body), 'sealed after masking');
  const list = await b.req('msg.list', { convId: dm.id }) as { messages: Message[] };
  assert.equal(list.messages[0].body, 'Pay with ••••');
});

/** What the apps do for an attachment: plan, encrypt on the way if needed, upload, and hand back the file. */
async function attach(hub: { port: number }, who: Awaited<ReturnType<typeof person>>, convId: string | undefined, name: string, mime: string, data: Buffer) {
  const plan = await who.e2e.planUpload(convId, { name, mime, size: data.length });
  const parts: Buffer[] = [];
  for await (const p of plan.transform([new Uint8Array(data)])) parts.push(Buffer.from(p));
  const body = Buffer.concat(parts);
  assert.equal(body.length, plan.size, 'the announced size');
  const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const r = https.request({ host: '127.0.0.1', port: hub.port, path: plan.path, method: 'POST', rejectUnauthorized: false,
      headers: { authorization: `Bearer ${who.c.session!.fileToken}`, 'content-length': String(body.length) } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    r.on('error', reject);
    r.end(body);
  });
  assert.equal(res.status, 200, res.body);
  return { plan, info: plan.done(JSON.parse(res.body) as FileInfo), uploaded: body };
}

function download(hub: { port: number }, token: string, id: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', port: hub.port, path: `/files/${id}?download=1`, rejectUnauthorized: false, headers: { authorization: `Bearer ${token}` } }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve(Buffer.concat(parts)));
    }).on('error', reject);
  });
}

async function readThrough(e2e: E2EClient, id: string, data: Buffer): Promise<Buffer> {
  const t = e2e.downloadTransform(id);
  if (!t) return data;
  const parts: Buffer[] = [];
  for await (const p of t([new Uint8Array(data)])) parts.push(Buffer.from(p));
  return Buffer.concat(parts);
}

test('files in an encrypted Direct message are encrypted on the device; the hub stores ciphertext; recipients open them', async () => {
  const { hub, owner } = await office();
  const a = await person(hub, owner, 'asha');
  const b = await person(hub, owner, 'bala');
  const dm = await a.c.request('conv.create', { kind: 'direct', members: [me(b.c)] });
  await a.e2e.ready(me(a.c), []);
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('SITE PHOTO GRID C-4 '.repeat(300))]);
  const pdf = Buffer.from(`%PDF-1.7\n${'Tender BOQ 4.2 crore\n'.repeat(400)}`);
  const img = await attach(hub, a, dm.id, 'grid C-4.png', 'image/png', png);
  const doc = await attach(hub, a, dm.id, 'Tender BOQ.pdf', 'application/pdf', pdf);
  assert.equal(img.plan.sealed, true);
  assert.equal(img.info.name, 'grid C-4.png', 'the sender sees the real name');
  assert.equal(img.info.size, png.length);
  // the hub never saw the name, type or bytes
  const row = hub.files.db.prepare('SELECT name, mime, sealed FROM files WHERE id = ?').get(doc.info.id) as { name: string; mime: string; sealed: number };
  assert.deepEqual({ ...row }, { name: 'Encrypted file', mime: 'application/octet-stream', sealed: 1 });
  const sent = await a.req('msg.send', { convId: dm.id, body: 'Photo and the BOQ', clientId: 'p1', files: [img.info.id, doc.info.id] }) as Message;
  assert.deepEqual(sent.files.map((f) => f.name), ['grid C-4.png', 'Tender BOQ.pdf']);
  assert.equal(sent.plain, undefined, 'an encrypted message carries no open-lock mark');
  const raw = hub.messaging['db'].prepare('SELECT body FROM messages WHERE id = ?').get(sent.id) as { body: string };
  assert.doesNotMatch(atob(raw.body.slice(5)), /grid|Tender|png|pdf/);
  for (const f of [img, doc]) {
    const stored = await download(hub, b.c.session!.fileToken, f.info.id);
    assert.deepEqual(stored, f.uploaded, 'the hub holds exactly the ciphertext');
    assert.equal(stored.indexOf('crore'), -1);
    assert.equal(stored.indexOf('SITE PHOTO'), -1);
  }
  // Bala's app shows the real names and types, and decrypts the bytes
  const list = await b.req('msg.list', { convId: dm.id }) as { messages: Message[] };
  const got = list.messages[0];
  assert.deepEqual(got.files.map((f) => [f.name, f.mime, f.size, f.sealed]), [['grid C-4.png', 'image/png', png.length, true], ['Tender BOQ.pdf', 'application/pdf', pdf.length, true]]);
  assert.deepEqual(await readThrough(b.e2e, img.info.id, await download(hub, b.c.session!.fileToken, img.info.id)), png);
  assert.deepEqual(await readThrough(b.e2e, doc.info.id, await download(hub, b.c.session!.fileToken, doc.info.id)), pdf);
  // a fresh app that only lists the conversation's files learns the keys from the message
  const fresh = await person(hub, owner, 'bala');
  await b.e2e.onEvent('e2e.keysChanged', { userId: me(b.c), deviceId: fresh.identity.deviceId });
  const files = await fresh.req('file.list', { convId: dm.id }) as FileInfo[];
  assert.deepEqual(files.map((f) => f.name).sort(), ['Tender BOQ.pdf', 'grid C-4.png']);
  assert.ok(fresh.e2e.downloadTransform(doc.info.id));
  // an edit keeps the files readable; an edit that would drop their keys is refused by the hub
  await a.req('msg.edit', { messageId: sent.id, body: 'Photo and the revised BOQ' });
  const edited = (await b.req('msg.list', { convId: dm.id }) as { messages: Message[] }).messages[0];
  assert.equal(edited.body, 'Photo and the revised BOQ');
  assert.equal(edited.files[1].name, 'Tender BOQ.pdf');
  await assert.rejects(a.c.request('msg.edit', { messageId: sent.id, body: 'plain now' }), /has encrypted files/);
  // forwarding: into another encrypted Direct conversation (keys go along), never into a Space
  const c = await person(hub, owner, 'chetan');
  const dm2 = await a.c.request('conv.create', { kind: 'direct', members: [me(c.c)] });
  const fwd = await a.req('msg.forward', { messageId: sent.id, convIds: [dm2.id] }) as Message[];
  assert.equal(fwd[0].files[0].name, 'grid C-4.png');
  const cl = await c.req('msg.list', { convId: dm2.id }) as { messages: Message[] };
  assert.deepEqual(await readThrough(c.e2e, img.info.id, await download(hub, c.c.session!.fileToken, img.info.id)), png);
  assert.equal(cl.messages[0].files[1].name, 'Tender BOQ.pdf');
  const space = await a.c.request('conv.create', { kind: 'space', name: 'Bids', members: [me(b.c)] });
  await assert.rejects(a.req('msg.forward', { messageId: sent.id, convIds: [space.id] }), /only be forwarded to Direct conversations that are end-to-end encrypted/);
  // files for a Space go up as they are
  const plainUp = await attach(hub, a, space.id, 'Space notes.txt', 'text/plain', Buffer.from('open notes'));
  assert.equal(plainUp.plan.sealed, false);
  assert.equal(plainUp.info.name, 'Space notes.txt');
});

test("the office's blocked file types are checked on the device before a Direct attachment is encrypted", async () => {
  const { hub, owner } = await office();
  await owner.request('admin.policy.set', { blockedFileTypes: ['exe', 'ps1'] });
  const a = await person(hub, owner, 'asha');
  const b = await person(hub, owner, 'bala');
  const dm = await a.c.request('conv.create', { kind: 'direct', members: [me(b.c)] });
  await a.e2e.ready(me(a.c), []);
  await assert.rejects(a.e2e.planUpload(dm.id, { name: 'Setup.EXE', size: 10 }), /doesn't allow \.exe files/);
  assert.equal((await a.e2e.planUpload(dm.id, { name: 'drawing.pdf', size: 10 })).sealed, true);
  // policy changes reach the device
  await a.e2e.onEvent('policy.updated', await owner.request('admin.policy.set', { blockedFileTypes: ['pdf'] }));
  await assert.rejects(a.e2e.planUpload(dm.id, { name: 'drawing.pdf', size: 10 }), /doesn't allow \.pdf files/);
});

test('a Direct message to someone without a key is marked as not end-to-end encrypted, with the reason', async () => {
  const { hub, owner, priya } = await office();
  const a = await person(hub, owner, 'asha');
  const b = await person(hub, owner, 'bala');
  // Priya's app has no key (an older version)
  const dm = await a.c.request('conv.create', { kind: 'direct', members: [me(priya)] });
  const sent = await a.req('msg.send', { convId: dm.id, body: 'hello', clientId: 'k1' }) as Message;
  assert.deepEqual(sent.plain, { reason: 'no-key', users: [me(priya)] });
  // everyone sees the mark, also Priya's older app (it is on the hub's message)
  assert.deepEqual((await priya.request('msg.list', { convId: dm.id })).messages[0].plain, { reason: 'no-key', users: [me(priya)] });
  // an attachment there is not encrypted either
  assert.equal((await a.e2e.planUpload(dm.id, { name: 'a.pdf', size: 1 })).sealed, false);
  // an older app that does not encrypt, though everyone has keys
  const dm2 = await a.c.request('conv.create', { kind: 'direct', members: [me(b.c)] });
  const old = await a.c.request('msg.send', { convId: dm2.id, body: 'from an old app', clientId: 'k2' });
  assert.deepEqual(old.plain, { reason: 'sender', users: [me(a.c)] });
  const sealed = await a.req('msg.send', { convId: dm2.id, body: 'sealed', clientId: 'k3' }) as Message;
  assert.equal(sealed.plain, undefined);
  // Spaces and integrations are not marked
  const space = await a.c.request('conv.create', { kind: 'space', name: 'Open', members: [me(b.c)] });
  assert.equal((await a.c.request('msg.send', { convId: space.id, body: 'hi all', clientId: 'k4' })).plain, undefined);
  // the status the sender sees before sending names who is missing
  assert.deepEqual(await a.e2e.status(dm.id), { encrypted: false, code: null, missing: [me(priya)], required: false });
});

test('the office can require encryption: nothing plain is sent until the person updates', async () => {
  const { hub, owner, priya } = await office();
  const a = await person(hub, owner, 'asha');
  const b = await person(hub, owner, 'bala');
  a.e2e['host'].nameOf = (id: string) => (id === me(priya) ? 'Priya Raman' : undefined);
  await a.e2e.onEvent('policy.updated', await owner.request('admin.policy.set', { requireE2E: true }));
  assert.equal((await owner.request('policy.get')).requireE2E, true);
  const dm = await a.c.request('conv.create', { kind: 'direct', members: [me(priya)] });
  assert.equal((await a.e2e.status(dm.id)).required, true);
  // the app refuses before anything leaves the device, and says why
  const sending = new Promise<boolean>((resolve) => { const orig = a.c.request.bind(a.c); let seen = false; a.c.request = ((op: string, d: unknown) => { if (op === 'msg.send') seen = true; return orig(op as never, d as never); }) as typeof a.c.request; setTimeout(() => resolve(seen), 300); });
  await assert.rejects(a.req('msg.send', { convId: dm.id, body: 'hello', clientId: 'r1' }), /requires Direct messages to be end-to-end encrypted\. Priya Raman needs to update Dexterity Connect/);
  assert.equal(await sending, false, 'the text never went to the hub');
  await assert.rejects(a.e2e.planUpload(dm.id, { name: 'x.pdf', size: 1 }), /requires Direct messages to be end-to-end encrypted/);
  // the hub enforces it too, for older apps
  await assert.rejects(a.c.request('msg.send', { convId: dm.id, body: 'hello', clientId: 'r2' }), /Priya needs to update/);
  await assert.rejects(priya.request('msg.send', { convId: dm.id, body: 'hello from an old app', clientId: 'r3' }), /requires Direct messages to be end-to-end encrypted/);
  // encrypted conversations work as before; Spaces are not affected
  const dm2 = await a.c.request('conv.create', { kind: 'direct', members: [me(b.c)] });
  assert.equal((await a.req('msg.send', { convId: dm2.id, body: 'sealed', clientId: 'r4' }) as Message).e2e, 'ok');
  await assert.rejects(a.c.request('msg.send', { convId: dm2.id, body: 'old app', clientId: 'r5' }), /This app needs to update/);
  const space = await a.c.request('conv.create', { kind: 'space', name: 'Open', members: [me(priya)] });
  assert.ok(await a.req('msg.send', { convId: space.id, body: 'fine here', clientId: 'r6' }));
  // once Priya updates (her updated app publishes a key), Direct messages to her go out encrypted
  await person(hub, owner, 'priya');
  await a.e2e.onEvent('e2e.keysChanged', { userId: me(priya), deviceId: '' });
  assert.equal((await a.req('msg.send', { convId: dm.id, body: 'now encrypted', clientId: 'r7' }) as Message).e2e, 'ok');
});
