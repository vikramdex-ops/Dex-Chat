import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DAMAGED_FILE, decryptBytes, decryptFile, encryptBytes, encryptFile, newFileSecret, sealedFileSize } from '../src/e2e-files.ts';
import type { SealedFileMeta } from '../src/e2e-files.ts';
import { createEncKeys, open, rawEd25519FromSpki, seal, sealsFiles } from '../src/e2e.ts';
import { createIdentity, signWith } from '../src/identity.ts';

const bytes = (n: number, seed = 1) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff; return b; };

async function collect(it: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const p of it) out.push(p);
  return out;
}
const join = (parts: Uint8Array[]) => { const n = parts.reduce((a, p) => a + p.length, 0); const o = new Uint8Array(n); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };

test('files round-trip at every size around a chunk edge, and the size on the hub is known up front', async () => {
  const chunk = 1024;
  for (const n of [0, 1, chunk - 1, chunk, chunk + 1, 3 * chunk, 3 * chunk + 17]) {
    const secret = newFileSecret();
    const plain = bytes(n, n);
    const sealed = await encryptBytes(plain, secret, chunk);
    assert.equal(sealed.length, sealedFileSize(n, chunk), `size of a ${n}-byte file`);
    assert.deepEqual(await decryptBytes(sealed, secret), plain);
  }
  // the default chunk, fed in odd-sized pieces
  const secret = newFileSecret();
  const plain = bytes(700_001);
  const pieces = [plain.subarray(0, 3), plain.subarray(3, 200_000), plain.subarray(200_000, 200_001), plain.subarray(200_001)];
  const sealed = join(await collect(encryptFile(pieces, secret)));
  assert.equal(sealed.length, sealedFileSize(plain.length));
  assert.equal(Buffer.from(sealed).indexOf(Buffer.from(plain.subarray(1000, 1064))), -1, 'no plaintext in the ciphertext');
  const back = join(await collect(decryptFile([sealed.subarray(0, 5), sealed.subarray(5, 140_000), sealed.subarray(140_000)], secret)));
  assert.deepEqual(back, plain);
});

test('a changed, reordered, dropped or cut-off chunk is rejected, and so is the wrong key', async () => {
  const chunk = 1024;
  const secret = newFileSecret();
  const plain = bytes(4 * chunk + 100);
  const sealed = await encryptBytes(plain, secret, chunk);
  const C = chunk + 16;
  const at = (i: number) => 8 + i * C;
  const tampered = sealed.slice(); tampered[at(2) + 5] ^= 1;
  await assert.rejects(decryptBytes(tampered, secret), { message: DAMAGED_FILE });
  // swap chunks 1 and 2
  const swapped = sealed.slice(); swapped.set(sealed.subarray(at(2), at(3)), at(1)); swapped.set(sealed.subarray(at(1), at(2)), at(2));
  await assert.rejects(decryptBytes(swapped, secret), { message: DAMAGED_FILE });
  // drop a middle chunk
  await assert.rejects(decryptBytes(join([sealed.subarray(0, at(1)), sealed.subarray(at(2))]), secret), { message: DAMAGED_FILE });
  // cut off after a whole chunk (the last kept chunk was not sealed as the last one)
  await assert.rejects(decryptBytes(sealed.subarray(0, at(3)), secret), { message: DAMAGED_FILE });
  // extra bytes at the end
  await assert.rejects(decryptBytes(join([sealed, new Uint8Array(20)]), secret), { message: DAMAGED_FILE });
  // a changed header (chunk size)
  const head = sealed.slice(); head[7] ^= 0x04;
  await assert.rejects(decryptBytes(head, secret), { message: DAMAGED_FILE });
  await assert.rejects(decryptBytes(sealed, newFileSecret()), { message: DAMAGED_FILE });
  await assert.rejects(decryptBytes(new Uint8Array(3), secret), { message: DAMAGED_FILE });
  // the stream stops at the first bad chunk: nothing after it is released
  const out: Uint8Array[] = [];
  await assert.rejects(async () => { for await (const p of decryptFile([tampered], secret)) out.push(p); }, { message: DAMAGED_FILE });
  assert.equal(join(out).length, 2 * chunk);
});

test('a large file streams through a fixed amount of memory in both directions', async () => {
  const secret = newFileSecret();
  const PIECE = 64 * 1024;
  const TOTAL = 64 * 1024 * 1024; // 64 MB, never held at once
  let read = 0;
  const hashIn = crypto.createHash('sha256');
  async function* source() {
    for (let i = 0; i < TOTAL / PIECE; i++) {
      const p = bytes(PIECE, i);
      hashIn.update(p);
      read += p.length;
      yield p;
    }
  }
  let sealedBytes = 0;
  let maxAhead = 0;
  let firstOutAfter = -1;
  async function* sealed() {
    for await (const c of encryptFile(source(), secret)) {
      if (firstOutAfter < 0 && c.length > 8) firstOutAfter = read;
      sealedBytes += c.length;
      yield c;
    }
  }
  const hashOut = crypto.createHash('sha256');
  let plainOut = 0;
  for await (const p of decryptFile(sealed(), secret)) {
    plainOut += p.length;
    // what has been read from the source but not yet handed out decrypted
    maxAhead = Math.max(maxAhead, read - plainOut);
    hashOut.update(p);
  }
  assert.equal(plainOut, TOTAL);
  assert.equal(sealedBytes, sealedFileSize(TOTAL));
  assert.equal(hashOut.digest('hex'), hashIn.digest('hex'));
  assert.ok(firstOutAfter > 0 && firstOutAfter <= 256 * 1024, `the first chunk left after ${firstOutAfter} bytes were read`);
  assert.ok(maxAhead <= 3 * 128 * 1024 + PIECE, `at most a few chunks in flight (${maxAhead} bytes)`);
});

test("a sealed message carries its files' keys and real names; the signature covers them", async () => {
  const id = createIdentity();
  const keys = createEncKeys();
  const ravi = createEncKeys();
  const raviId = createIdentity();
  const files: SealedFileMeta[] = [{ id: '01J0000000000000000000000A', ...newFileSecret(), name: 'Tender BOQ.pdf', mime: 'application/pdf', size: 123456 }];
  const recipients = [
    { deviceId: id.deviceId, encKey: keys.public },
    { deviceId: raviId.deviceId, encKey: ravi.public },
  ];
  const body = await seal({ convId: 'C1', text: '', senderDeviceId: id.deviceId, sign: (p) => signWith(id, p), recipients, files });
  assert.ok(sealsFiles(body));
  assert.doesNotMatch(atob(body.slice(5)), /Tender BOQ|application\/pdf/);
  const signKeyOf = (d: string) => (d === id.deviceId ? rawEd25519FromSpki(id.publicKey) : null);
  const opened = await open({ convId: 'C1', body, myDeviceId: raviId.deviceId, mySecret: ravi.secret, signKeyOf });
  assert.deepEqual(opened, { text: '', verified: true, files });
  // the same keys in another conversation do not open (bound to the conversation)
  assert.deepEqual(await open({ convId: 'C2', body, myDeviceId: raviId.deviceId, mySecret: ravi.secret, signKeyOf }), { error: 'damaged' });
  // without files the envelope (and its signature) is exactly as before
  const plainBody = await seal({ convId: 'C1', text: 'hi', senderDeviceId: id.deviceId, sign: (p) => signWith(id, p), recipients });
  assert.equal(sealsFiles(plainBody), false);
  assert.deepEqual(await open({ convId: 'C1', body: plainBody, myDeviceId: raviId.deviceId, mySecret: ravi.secret, signKeyOf }), { text: 'hi', verified: true });
  // another sender's files spliced into a message are caught by the signature
  const other = await seal({ convId: 'C1', text: '', senderDeviceId: id.deviceId, sign: (p) => signWith(id, p), recipients, files: [{ ...files[0], name: 'other.pdf' }] });
  const a = JSON.parse(atob(body.slice(5)));
  const b = JSON.parse(atob(other.slice(5)));
  const spliced = 'e2e1:' + btoa(JSON.stringify({ ...a, f: b.f, fn: b.fn }));
  const r = await open({ convId: 'C1', body: spliced, myDeviceId: raviId.deviceId, mySecret: ravi.secret, signKeyOf });
  assert.ok('error' in r || r.verified === false, 'not accepted as signed');
});
