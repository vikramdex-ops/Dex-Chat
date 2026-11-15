// The phone's device keys move from plain preferences into the Android Keystore, with a
// stand-in for the DexNative plugin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSecret } from '../src/keys.ts';
import type { PlainStore, SecureStore } from '../src/keys.ts';

type Key = { secret: string; public: string };
const valid = (v: unknown): v is Key => !!v && typeof (v as Key).secret === 'string' && typeof (v as Key).public === 'string';

function prefs(initial: Record<string, string> = {}): PlainStore & { m: Map<string, string> } {
  const m = new Map(Object.entries(initial));
  return {
    m,
    get: async ({ key }) => ({ value: m.get(key) ?? null }),
    set: async ({ key, value }) => { m.set(key, value); },
    remove: async ({ key }) => { m.delete(key); },
  };
}

/** Like the plugin: values are wrapped with a Keystore key; "wiped" loses that key. */
function keystore(opts: { down?: boolean; failWrites?: boolean } = {}): SecureStore & { wrapped: Map<string, string>; wipe(): void; calls: string[] } {
  const wrapped = new Map<string, string>();
  let ks = 'k1';
  const calls: string[] = [];
  return {
    wrapped, calls,
    wipe() { ks = 'k2'; },
    secureGet: async ({ key }) => {
      calls.push(`get ${key}`);
      if (opts.down) throw Object.assign(new Error('Keystore unavailable'), { code: 'unavailable' });
      const v = wrapped.get(key);
      if (!v) return { value: null };
      const [k, data] = v.split('|');
      if (k !== ks) throw Object.assign(new Error('cannot unwrap'), { code: 'unreadable' });
      return { value: Buffer.from(data, 'base64').toString() };
    },
    secureSet: async ({ key, value }) => {
      calls.push(`set ${key}`);
      if (opts.down || opts.failWrites) throw new Error('Keystore unavailable');
      wrapped.set(key, `${ks}|${Buffer.from(value).toString('base64')}`);
    },
  };
}

let n = 0;
const create = (): Key => ({ secret: `s${++n}`, public: `p${n}` });

test('keys kept in plain preferences by an older version move into the Keystore on first start', async () => {
  const old = { secret: 'old-secret', public: 'old-public' };
  const plain = prefs({ 'device-enc': JSON.stringify(old), config: '{}' });
  const secure = keystore();
  assert.deepEqual(await loadSecret({ key: 'device-enc', valid, create, secure, plain }), old, 'the same key: messages stay readable');
  assert.equal(plain.m.has('device-enc'), false, 'the readable copy is gone');
  assert.equal(plain.m.get('config'), '{}', 'nothing else is touched');
  assert.doesNotMatch(secure.wrapped.get('device-enc')!, /old-secret/);
  // the next start reads it from the Keystore
  assert.deepEqual(await loadSecret({ key: 'device-enc', valid, create, secure, plain }), old);
});

test('a new phone makes its key and keeps it only in the Keystore', async () => {
  const plain = prefs();
  const secure = keystore();
  const k = await loadSecret({ key: 'device-key', valid, create, secure, plain });
  assert.equal(plain.m.size, 0);
  assert.deepEqual(await loadSecret({ key: 'device-key', valid, create, secure, plain }), k);
});

test('if the Keystore cannot take the key, the old copy stays where it was (nothing is lost)', async () => {
  const old = { secret: 'old', public: 'pub' };
  const plain = prefs({ 'device-key': JSON.stringify(old) });
  assert.deepEqual(await loadSecret({ key: 'device-key', valid, create, secure: keystore({ failWrites: true }), plain }), old);
  assert.equal(plain.m.get('device-key'), JSON.stringify(old));
  // unavailable altogether: still the same key, and it moves later
  assert.deepEqual(await loadSecret({ key: 'device-key', valid, create, secure: keystore({ down: true }), plain }), old);
  const later = keystore();
  assert.deepEqual(await loadSecret({ key: 'device-key', valid, create, secure: later, plain }), old);
  assert.equal(plain.m.has('device-key'), false);
});

test('a wrapped key that can no longer be opened (the Keystore was wiped) is replaced', async () => {
  const plain = prefs();
  const secure = keystore();
  const first = await loadSecret({ key: 'device-key', valid, create, secure, plain });
  secure.wipe();
  const second = await loadSecret({ key: 'device-key', valid, create, secure, plain });
  assert.notDeepEqual(second, first);
  assert.deepEqual(await loadSecret({ key: 'device-key', valid, create, secure, plain }), second);
});

test('a copy left in preferences by an interrupted move is cleaned up', async () => {
  const k = { secret: 'a', public: 'b' };
  const secure = keystore();
  await secure.secureSet({ key: 'device-key', value: JSON.stringify(k) });
  const plain = prefs({ 'device-key': JSON.stringify(k) });
  assert.deepEqual(await loadSecret({ key: 'device-key', valid, create, secure, plain }), k);
  assert.equal(plain.m.has('device-key'), false);
});
