// End-to-end encryption for Direct messages. Portable (desktop main process, phone WebView,
// Node tests): X25519 and Ed25519 from @noble/curves, HKDF from @noble/hashes, AES-GCM from
// WebCrypto.
//
// Each device has an X25519 key, published through the hub with a statement signed by the
// device's Ed25519 identity. A message is encrypted once with a random content key; that key
// is wrapped for every device of every member (ephemeral X25519 + HKDF + AES-GCM), and the
// sender's device signs the result. The hub stores and relays only the sealed envelope.
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

export const SEALED_PREFIX = 'e2e1:';
const INFO = new TextEncoder().encode('dexconnect-e2e-v1');
const ZERO_IV = new Uint8Array(12);

// ------------------------------------------------------------------ encoding
export function b64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const enc = (s: string) => new TextEncoder().encode(s);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const rand = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const subtle = () => globalThis.crypto.subtle;

/** Ed25519 public key bytes from a base64 SPKI DER (the device identity format). */
export function rawEd25519FromSpki(spkiB64: string): Uint8Array | null {
  try {
    const der = unb64(spkiB64);
    return der.length === 44 ? der.subarray(12) : null;
  } catch { return null; }
}

// ------------------------------------------------------------------ keys
export interface EncKeyPair { secret: string; public: string }

export function createEncKeys(): EncKeyPair {
  const secret = x25519.utils.randomSecretKey();
  return { secret: b64(secret), public: b64(x25519.getPublicKey(secret)) };
}

/** What a device signs to vouch for its encryption key. */
export function encKeyStatement(deviceId: string, encKey: string): Uint8Array {
  return enc(`dexconnect-enc-v1|${deviceId}|${encKey}`);
}

export interface DeviceKey {
  userId: string;
  deviceId: string;
  /** Ed25519 identity, base64 SPKI */
  signKey: string;
  /** X25519, base64 raw */
  encKey: string;
  /** Ed25519 signature over encKeyStatement */
  sig: string;
}

export function verifyDeviceKey(k: DeviceKey): boolean {
  const raw = rawEd25519FromSpki(k.signKey);
  if (!raw) return false;
  try { return ed25519.verify(unb64(k.sig), encKeyStatement(k.deviceId, k.encKey), raw); } catch { return false; }
}

// ------------------------------------------------------------------ envelopes
interface Envelope {
  /** ephemeral X25519 public key */
  e: string;
  /** content nonce */
  n: string;
  /** ciphertext of the text */
  c: string;
  /** deviceId -> wrapped content key */
  k: Record<string, string>;
  /** sender device */
  s: string;
  /** Ed25519 signature over the content */
  g: string;
}

export const isSealed = (body: unknown): boolean => typeof body === 'string' && body.startsWith(SEALED_PREFIX);

function parse(body: string): Envelope | null {
  if (!isSealed(body)) return null;
  try {
    const v = JSON.parse(atob(body.slice(SEALED_PREFIX.length))) as Envelope;
    return typeof v.e === 'string' && typeof v.n === 'string' && typeof v.c === 'string' && v.k && typeof v.k === 'object' && typeof v.s === 'string' && typeof v.g === 'string' ? v : null;
  } catch { return null; }
}
const serialise = (v: Envelope) => SEALED_PREFIX + btoa(JSON.stringify(v));

const signed = (convId: string, v: Pick<Envelope, 'e' | 'n' | 'c' | 's'>) => sha256(enc(`dexconnect-msg-v1|${convId}|${v.s}|${v.e}|${v.n}|${v.c}`));

async function aes(key: Uint8Array, iv: Uint8Array, data: Uint8Array, aad: Uint8Array | undefined, decrypt: boolean): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', key as BufferSource, 'AES-GCM', false, [decrypt ? 'decrypt' : 'encrypt']);
  const params: AesGcmParams = { name: 'AES-GCM', iv: iv as BufferSource, ...(aad ? { additionalData: aad as BufferSource } : {}) };
  return new Uint8Array(decrypt ? await subtle().decrypt(params, k, data as BufferSource) : await subtle().encrypt(params, k, data as BufferSource));
}

function kek(ephSecretOrPub: { secret: Uint8Array; pub: Uint8Array } | { mySecret: Uint8Array; ephPub: Uint8Array }, devicePub: Uint8Array): Uint8Array {
  const shared = 'secret' in ephSecretOrPub ? x25519.getSharedSecret(ephSecretOrPub.secret, devicePub) : x25519.getSharedSecret(ephSecretOrPub.mySecret, ephSecretOrPub.ephPub);
  const ephPub = 'secret' in ephSecretOrPub ? ephSecretOrPub.pub : ephSecretOrPub.ephPub;
  return hkdf(sha256, shared, cat(ephPub, devicePub), INFO, 32);
}

async function wrapFor(contentKey: Uint8Array, eph: { secret: Uint8Array; pub: Uint8Array }, devices: Array<{ deviceId: string; encKey: string }>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const d of devices) {
    const pub = unb64(d.encKey);
    if (pub.length !== 32) continue;
    out[d.deviceId] = b64(await aes(kek(eph, pub), ZERO_IV, contentKey, undefined, false));
  }
  return out;
}

export async function seal(opts: {
  convId: string; text: string; senderDeviceId: string; sign: (payload: Uint8Array) => string | Promise<string>;
  recipients: Array<{ deviceId: string; encKey: string }>;
}): Promise<string> {
  const contentKey = rand(32);
  const nonce = rand(12);
  const ephSecret = x25519.utils.randomSecretKey();
  const eph = { secret: ephSecret, pub: x25519.getPublicKey(ephSecret) };
  const c = await aes(contentKey, nonce, enc(opts.text), enc(opts.convId), false);
  const v = { e: b64(eph.pub), n: b64(nonce), c: b64(c), s: opts.senderDeviceId };
  const g = await opts.sign(signed(opts.convId, v));
  return serialise({ ...v, k: await wrapFor(contentKey, eph, opts.recipients), g });
}

/** The content key for this device, or null when the message was not sealed for it. */
async function contentKey(v: Envelope, myDeviceId: string, mySecret: Uint8Array): Promise<Uint8Array | null> {
  const wrapped = v.k[myDeviceId];
  if (!wrapped) return null;
  const myPub = x25519.getPublicKey(mySecret);
  try { return await aes(kek({ mySecret, ephPub: unb64(v.e) }, myPub), ZERO_IV, unb64(wrapped), undefined, true); } catch { return null; }
}

export type Opened = { text: string; verified: boolean } | { error: 'not-for-this-device' | 'damaged' };

export interface OpenOptions { convId: string; body: string; myDeviceId: string; mySecret: string; signKeyOf: (deviceId: string) => Uint8Array | null }

async function openOriginal(opts: OpenOptions): Promise<Opened> {
  const v = parse(opts.body);
  if (!v) return { error: 'damaged' };
  const key = await contentKey(v, opts.myDeviceId, unb64(opts.mySecret));
  if (!key) return { error: 'not-for-this-device' };
  let text: string;
  try { text = new TextDecoder().decode(await aes(key, unb64(v.n), unb64(v.c), enc(opts.convId), true)); } catch { return { error: 'damaged' }; }
  const signer = opts.signKeyOf(v.s);
  let verified = false;
  if (signer) { try { verified = ed25519.verify(unb64(v.g), signed(opts.convId, v), signer); } catch { verified = false; } }
  return { text, verified };
}

/** Wrap a message's key for more devices (sharing history with a new device of your own). */
export async function rewrap(opts: { body: string; myDeviceId: string; mySecret: string; devices: Array<{ deviceId: string; encKey: string }> }): Promise<Record<string, string> | null> {
  const v = parse(opts.body);
  if (!v) return null;
  const key = await contentKey(v, opts.myDeviceId, unb64(opts.mySecret));
  if (!key) return null;
  const ephSecret = x25519.utils.randomSecretKey();
  // a fresh ephemeral key per rewrap; the envelope keeps its original "e", so store it with the wrap
  const eph = { secret: ephSecret, pub: x25519.getPublicKey(ephSecret) };
  const wraps = await wrapFor(key, eph, opts.devices);
  const out: Record<string, string> = {};
  for (const [id, w] of Object.entries(wraps)) out[id] = `${b64(eph.pub)}.${w}`;
  return out;
}

/** Open a key added later by rewrap (format "ephPub.wrapped"). */
export async function openRewrapped(entry: string, mySecret: string): Promise<Uint8Array | null> {
  const [e, w] = entry.split('.');
  if (!e || !w) return null;
  const secret = unb64(mySecret);
  try { return await aes(kek({ mySecret: secret, ephPub: unb64(e) }, x25519.getPublicKey(secret)), ZERO_IV, unb64(w), undefined, true); } catch { return null; }
}

/** Decrypt a sealed message on this device (its original wrap, or one added later by rewrap). */
export async function open(opts: OpenOptions): Promise<Opened> {
  const v = parse(opts.body);
  if (!v) return { error: 'damaged' };
  const entry = v.k[opts.myDeviceId];
  if (entry && entry.includes('.')) {
    const key = await openRewrapped(entry, opts.mySecret);
    if (!key) return { error: 'damaged' };
    let text: string;
    try { text = new TextDecoder().decode(await aes(key, unb64(v.n), unb64(v.c), enc(opts.convId), true)); } catch { return { error: 'damaged' }; }
    const signer = opts.signKeyOf(v.s);
    let verified = false;
    if (signer) { try { verified = ed25519.verify(unb64(v.g), signed(opts.convId, v), signer); } catch { verified = false; } }
    return { text, verified };
  }
  return openOriginal(opts);
}

/** Devices a sealed message is readable on. */
export function sealedFor(body: string): string[] {
  return Object.keys(parse(body)?.k ?? {});
}

/** Add wrapped keys to an envelope (the hub does this for history sharing). */
export function addWraps(body: string, wraps: Record<string, string>): string | null {
  const v = parse(body);
  if (!v) return null;
  for (const [id, w] of Object.entries(wraps)) if (!v.k[id] && /^[0-9a-f]{32}$/.test(id) && w.length < 200) v.k[id] = w;
  return serialise(v);
}

/** A short code two people can compare to confirm nobody swapped their keys (sorted, so both see the same). */
export function safetyCode(keys: DeviceKey[]): string {
  const material = keys.map((k) => `${k.deviceId}:${k.encKey}`).sort().join('|');
  const h = sha256(enc(material));
  let n = '';
  for (let i = 0; i < 6; i++) n += String(((h[i * 2] << 8) | h[i * 2 + 1]) % 100000).padStart(5, '0');
  return n.match(/.{5}/g)!.join(' ');
}
