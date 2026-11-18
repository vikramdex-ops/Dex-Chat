// Standard Web Push, as browsers do it, with nothing but WebCrypto (Node 22, browsers and service
// workers alike) and no account anywhere: the iPhone web app's notifications.
//
// - Message encryption (RFC 8291 over RFC 8188 "aes128gcm"): every push is encrypted to the
//   browser's own subscription keys (p256dh, auth), so the push service in between (Apple's, for an
//   iPhone) carries ciphertext only.
// - VAPID (RFC 8292): the hub signs a short-lived ES256 token for the push service's origin with
//   the office's own key pair; the public half goes into the browser's subscription
//   (applicationServerKey), so only this office can push to it.
// The push service's address comes from the browser's subscription; there is nothing to register.
const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();

export const b64url = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const unb64url = (s: string): Uint8Array => {
  const t = s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(t + '='.repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
const cat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const buf = (u: Uint8Array) => u as unknown as BufferSource;

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', buf(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', k, buf(data)));
}

/** A P-256 public key in the uncompressed form (65 bytes, 0x04‖X‖Y) as a JWK, with the private part when given. */
function jwkOf(pub: Uint8Array, d?: Uint8Array): JsonWebKey {
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('not an uncompressed P-256 public key');
  return { kty: 'EC', crv: 'P-256', x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)), ...(d ? { d: b64url(d) } : {}), ext: true };
}

/** The office's VAPID key pair: the public key (base64url, 65 bytes) and the private scalar (base64url, 32 bytes). */
export interface VapidKeys { publicKey: string; privateKey: string }

export async function generateVapidKeys(): Promise<VapidKeys> {
  const kp = await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const pub = new Uint8Array(await subtle().exportKey('raw', kp.publicKey));
  const jwk = await subtle().exportKey('jwk', kp.privateKey);
  return { publicKey: b64url(pub), privateKey: jwk.d! };
}

export function validVapidKeys(k: unknown): k is VapidKeys {
  if (!k || typeof k !== 'object') return false;
  const { publicKey, privateKey } = k as VapidKeys;
  try { return typeof publicKey === 'string' && typeof privateKey === 'string' && unb64url(publicKey).length === 65 && unb64url(privateKey).length === 32; } catch { return false; }
}

/**
 * The VAPID token for one push service (RFC 8292): `Authorization: vapid t=<JWT>, k=<public key>`.
 * `aud` is the push service's origin; the token lasts `ttlSeconds` (at most 24 hours).
 */
export async function vapidAuthorization(o: { endpoint: string; subject: string; keys: VapidKeys; now?: number; ttlSeconds?: number }): Promise<string> {
  const aud = new URL(o.endpoint).origin;
  const now = Math.floor((o.now ?? Date.now()) / 1000);
  const exp = now + Math.min(24 * 3600, Math.max(60, o.ttlSeconds ?? 12 * 3600));
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc.encode(JSON.stringify({ aud, exp, sub: o.subject })));
  const key = await subtle().importKey('jwk', jwkOf(unb64url(o.keys.publicKey), unb64url(o.keys.privateKey)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // WebCrypto's ECDSA signature is r‖s (64 bytes): exactly what JWS ES256 wants
  const sig = new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, key, buf(enc.encode(`${header}.${claims}`))));
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${o.keys.publicKey}`;
}

/** Checks a VAPID token against a public key (the tests, and the local push service the e2e test runs). */
export async function verifyVapid(authorization: string): Promise<{ ok: boolean; claims: { aud: string; exp: number; sub: string } | null; publicKey: string | null }> {
  const m = authorization.match(/^vapid t=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/);
  if (!m) return { ok: false, claims: null, publicKey: null };
  try {
    const key = await subtle().importKey('jwk', jwkOf(unb64url(m[4])), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, key, buf(unb64url(m[3])), buf(enc.encode(`${m[1]}.${m[2]}`)));
    const header = JSON.parse(new TextDecoder().decode(unb64url(m[1]))) as { alg?: string };
    const claims = JSON.parse(new TextDecoder().decode(unb64url(m[2]))) as { aud: string; exp: number; sub: string };
    return { ok: ok && header.alg === 'ES256', claims, publicKey: m[4] };
  } catch { return { ok: false, claims: null, publicKey: m[4] }; }
}

/** What a browser's PushSubscription gives (toJSON().keys). */
export interface PushKeys { p256dh: string; auth: string }

/** Record size: one record carries the whole message (pushes are small). */
const RS = 4096;
/** Push services accept at least 4096 bytes of body; leave room for the header and the tag. */
export const MAX_PUSH_PLAINTEXT = RS - 86 - 16 - 1;

/**
 * Encrypts one push message for a subscription (RFC 8291). `salt` and `sender` are for the
 * RFC's test vectors only; normally both are fresh for every message.
 */
export async function encryptPush(keys: PushKeys, plaintext: Uint8Array, test?: { salt: Uint8Array; sender: { publicKey: Uint8Array; privateKey: Uint8Array } }): Promise<Uint8Array> {
  const uaPublic = unb64url(keys.p256dh);
  const authSecret = unb64url(keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('The subscription\'s key is not a P-256 key.');
  if (authSecret.length < 16) throw new Error('The subscription\'s auth secret is too short.');
  if (plaintext.length > MAX_PUSH_PLAINTEXT) throw new Error('The push message is too long.');
  const salt = test?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  let asPublic: Uint8Array;
  let asPrivate: CryptoKey;
  if (test) {
    asPublic = test.sender.publicKey;
    asPrivate = await subtle().importKey('jwk', jwkOf(asPublic, test.sender.privateKey), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  } else {
    const kp = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
    asPublic = new Uint8Array(await subtle().exportKey('raw', kp.publicKey));
    asPrivate = kp.privateKey;
  }
  const uaKey = await subtle().importKey('raw', buf(uaPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256));
  const { cek, nonce } = await derive(ecdhSecret, authSecret, uaPublic, asPublic, salt);
  const key = await subtle().importKey('raw', buf(cek), 'AES-GCM', false, ['encrypt']);
  // one record, the last: the plaintext and the 0x02 delimiter, no padding
  const sealed = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: buf(nonce) }, key, buf(cat(plaintext, new Uint8Array([2])))));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RS);
  header[20] = asPublic.length;
  return cat(header, asPublic, sealed);
}

async function derive(ecdhSecret: Uint8Array, authSecret: Uint8Array, uaPublic: Uint8Array, asPublic: Uint8Array, salt: Uint8Array) {
  const prkKey = await hmac(authSecret, ecdhSecret);
  const ikm = await hmac(prkKey, cat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  return { cek, nonce, ikm, prk };
}

/**
 * The receiving side (what the browser does): for the tests and the e2e test's local push
 * service, with the subscription's private key.
 */
export async function decryptPush(body: Uint8Array, ua: { publicKey: Uint8Array; privateKey: Uint8Array; auth: Uint8Array }): Promise<Uint8Array> {
  if (body.length < 21 + 65 + 17) throw new Error('too short');
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const uaPriv = await subtle().importKey('jwk', jwkOf(ua.publicKey, ua.privateKey), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const asKey = await subtle().importKey('raw', buf(asPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: asKey }, uaPriv, 256));
  const { cek, nonce } = await derive(ecdhSecret, ua.auth, ua.publicKey, asPublic, salt);
  const key = await subtle().importKey('raw', buf(cek), 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: buf(nonce) }, key, buf(body.subarray(21 + idlen))));
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  if (end < 0 || plain[end] !== 2) throw new Error('not the last record');
  return plain.subarray(0, end);
}

/** Exposed for the RFC 8291 test: the intermediate values. */
export const _derive = derive;

/** What a notification push carries (JSON, encrypted as above). */
export interface PushPayload {
  /** The notification's heading and text (the text is "New message" when previews are off). */
  title: string;
  body: string;
  /** dexconnect://conversation/<id>: the conversation a tap opens. */
  link?: string;
  /** One notification per conversation: a newer one replaces it. */
  tag?: string;
  /** Messages waiting, for the app's badge. */
  badge?: number;
  silent?: boolean;
  /** A test from Preferences. */
  test?: boolean;
}

/** A push service address a hub may send to: https only, a public host name (not an address on the office network). */
export function pushEndpointProblem(endpoint: string, allowLocal = false): string | null {
  let u: URL;
  try { u = new URL(endpoint); } catch { return 'That is not an address.'; }
  if (allowLocal && u.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/.test(u.hostname)) return null;
  if (u.protocol !== 'https:') return 'Push services use https.';
  if (u.username || u.password) return 'That push address carries a password.';
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || /^[\d.]+$/.test(h) || h.startsWith('[') || /\.(local|lan|internal|home|corp|localhost)$/.test(h) || h === 'localhost') return 'Push services are on the internet, not on the office network.';
  if (endpoint.length > 1024) return 'That push address is too long.';
  return null;
}
