// Device keys on a PC: sealed by the system (DPAPI on Windows) and never silently replaced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyringLockedError, loadSealedSecret } from '../src/main/sealed-store.ts';
import type { KeyFiles, SealBox } from '../src/main/sealed-store.ts';

type Key = { secret: string };
const valid = (v: unknown): v is Key => !!v && typeof (v as Key).secret === 'string';

function disk(initial: Record<string, string | Buffer> = {}) {
  const m = new Map<string, Buffer>(Object.entries(initial).map(([k, v]) => [k, Buffer.from(v)]));
  const files: KeyFiles = {
    exists: (p) => m.has(p),
    read: (p) => { const b = m.get(p); if (!b) throw new Error('ENOENT'); return b; },
    write: (p, d) => { m.set(p, Buffer.from(d)); },
    remove: (p) => { m.delete(p); },
  };
  return { m, files };
}

/** A stand-in for DPAPI: reversible only with this "account's" secret. */
function dpapi(account: string, on = true): SealBox {
  return {
    available: () => on,
    encrypt: (t) => Buffer.from(`${account}:${Buffer.from(t).toString('base64')}`),
    decrypt: (d) => { const [a, b] = d.toString().split(':'); if (a !== account) throw new Error('cannot unseal'); return Buffer.from(b, 'base64').toString(); },
  };
}

let n = 0;
const create = (): Key => ({ secret: `new-${++n}` });
const opts = (files: KeyFiles, box: SealBox) => ({ sealedPath: 'device.key', plainPath: 'device.key.json', valid, create, box, files });

test('a new key is sealed by the system and nothing readable is left on disk', () => {
  const { m, files } = disk();
  const k = loadSealedSecret(opts(files, dpapi('priya')));
  assert.ok(m.has('device.key'));
  assert.equal(m.has('device.key.json'), false);
  assert.doesNotMatch(m.get('device.key')!.toString(), new RegExp(k.secret));
  assert.deepEqual(loadSealedSecret(opts(files, dpapi('priya'))), k, 'the same key on the next start');
});

test('a key kept unsealed (made while sealing was unavailable) is sealed on the next start and the readable copy removed', () => {
  const { m, files } = disk({ 'device.key.json': JSON.stringify({ secret: 'old' }) });
  assert.deepEqual(loadSealedSecret(opts(files, dpapi('priya'))), { secret: 'old' });
  assert.equal(m.has('device.key.json'), false);
  assert.ok(m.has('device.key'));
  assert.deepEqual(loadSealedSecret(opts(files, dpapi('priya'))), { secret: 'old' });
});

test('a sealed key the keyring cannot unseal right now is never replaced', () => {
  const { m, files } = disk();
  const k = loadSealedSecret(opts(files, dpapi('priya')));
  const sealed = m.get('device.key');
  assert.throws(() => loadSealedSecret(opts(files, dpapi('priya', false))), KeyringLockedError);
  assert.deepEqual(m.get('device.key'), sealed, 'the sealed key is untouched');
  assert.equal(m.has('device.key.json'), false, 'no second, readable identity');
  assert.deepEqual(loadSealedSecret(opts(files, dpapi('priya'))), k, 'back once the keyring is unlocked');
});

test('a sealed key copied to another account is replaced, which is what sealing is for', () => {
  const { files } = disk();
  const k = loadSealedSecret(opts(files, dpapi('priya')));
  const other = loadSealedSecret(opts(files, dpapi('ravi')));
  assert.notDeepEqual(other, k);
  assert.deepEqual(loadSealedSecret(opts(files, dpapi('ravi'))), other);
});

test('without any sealing (Linux without a keyring, development) the key is kept as a plain file', () => {
  const { m, files } = disk();
  const k = loadSealedSecret(opts(files, dpapi('dev', false)));
  assert.equal(m.has('device.key'), false);
  assert.deepEqual(JSON.parse(m.get('device.key.json')!.toString()), k);
  assert.deepEqual(loadSealedSecret(opts(files, dpapi('dev', false))), k);
});
