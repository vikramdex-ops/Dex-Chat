// Outside the office: devices reach their hub through the internet gateway (a small relay on the
// office's own Cloudflare account) inside an encrypted channel that only the device and the hub can
// read. The gateway, and anyone between, sees sizes and timing, never content.
//
// Handshake (one round trip, inside the gateway's WebSocket):
//   device → hub   {"v":1,"e":<device X25519 ephemeral>}
//   hub → device   {"v":1,"e":<hub X25519 ephemeral>,"cert":<hub certificate DER>,"spki":<its public key>,"sig":<RSA-SHA256>}
// The hub signs  "dexconnect-gw-v1|<hubId>|<device eph>|<hub eph>"  with the private key of the same
// TLS certificate devices already pin by SHA-256 fingerprint on the office network (or from the
// setup code). A device checks: the certificate's fingerprint is the pinned one, the public key is
// the certificate's own, and the signature is good. Then both sides derive one AES-256-GCM key per
// direction with HKDF-SHA256 over the X25519 secret; frames carry a 64-bit counter as the nonce, so
// a frame cannot be replayed, dropped or reordered without the channel failing.
//
// Inside the channel, frame type 0x01 carries the ordinary hub protocol (the same JSON frames as on
// the office network), and 0x10–0x23 carry HTTP requests for files and updates.
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { b64, unb64 } from './e2e.ts';
import type { HubSocket, HubTarget, SocketHandlers } from './session.ts';

export const GW_PROTO = 'dexconnect-gw-v1';
const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;

/** Frame types inside the channel. */
export const F = {
  TEXT: 0x01, PING: 0x02, PONG: 0x03,
  REQ: 0x10, REQ_BODY: 0x11, REQ_END: 0x12,
  RES: 0x20, RES_BODY: 0x21, RES_END: 0x22, RES_ERR: 0x23,
} as const;

/** Largest frame through the gateway (the gateway closes the socket on anything bigger). */
export const MAX_FRAME = 1 << 20;
/** Body chunk size for files, well under the frame limit. */
export const CHUNK = 256 * 1024;

/** The same format as Node's X509Certificate.fingerprint256: upper-case hex pairs joined by ':'. */
export function fingerprintOf(der: Uint8Array): string {
  return [...sha256(der)].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const transcript = (hubId: string, deviceEph: Uint8Array, hubEph: Uint8Array) =>
  enc.encode(`${GW_PROTO}|${hubId}|${b64(deviceEph)}|${b64(hubEph)}`);

async function keys(shared: Uint8Array, deviceEph: Uint8Array, hubEph: Uint8Array) {
  const salt = new Uint8Array([...deviceEph, ...hubEph]);
  const mk = async (label: string) => subtle().importKey('raw', hkdf(sha256, shared, salt, enc.encode(`${GW_PROTO} ${label}`), 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { toHub: await mk('device-to-hub'), toDevice: await mk('hub-to-device') };
}

/** One direction-pair of AES-GCM with counters; seal and open each run strictly in order. */
export class Channel {
  private sendCtr = 0n;
  private recvCtr = 0n;
  private sendChain: Promise<unknown> = Promise.resolve();
  private recvChain: Promise<unknown> = Promise.resolve();
  private readonly sendKey: CryptoKey;
  private readonly recvKey: CryptoKey;
  constructor(sendKey: CryptoKey, recvKey: CryptoKey) { this.sendKey = sendKey; this.recvKey = recvKey; }

  private static iv(n: bigint): Uint8Array {
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setBigUint64(4, n);
    return iv;
  }

  seal(type: number, body: Uint8Array): Promise<Uint8Array> {
    const p = this.sendChain.then(async () => {
      const iv = Channel.iv(this.sendCtr++);
      const plain = new Uint8Array(body.length + 1);
      plain[0] = type;
      plain.set(body, 1);
      return new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, this.sendKey, plain as BufferSource));
    });
    this.sendChain = p.catch(() => {});
    return p;
  }

  /** Decrypts the next frame; rejects (and the caller must close) if it was tampered with or reordered. */
  open(frame: Uint8Array): Promise<{ type: number; body: Uint8Array }> {
    const p = this.recvChain.then(async () => {
      const iv = Channel.iv(this.recvCtr++);
      const plain = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, this.recvKey, frame as BufferSource));
      if (!plain.length) throw new Error('empty frame');
      return { type: plain[0], body: plain.subarray(1) };
    });
    this.recvChain = p.catch(() => {});
    return p;
  }
}

// ------------------------------------------------------------------ device side
export interface DeviceHandshake { secret: Uint8Array; eph: Uint8Array; hello: Uint8Array }

export function deviceHello(): DeviceHandshake {
  const secret = x25519.utils.randomSecretKey();
  const eph = x25519.getPublicKey(secret);
  return { secret, eph, hello: enc.encode(JSON.stringify({ v: 1, e: b64(eph) })) };
}

/**
 * Checks the hub's answer against the pinned fingerprint. Returns the channel and the hub's
 * certificate fingerprint (to bind sign-in proofs to, exactly as on the office network).
 */
export async function deviceFinish(h: DeviceHandshake, answer: Uint8Array, hubId: string, pinnedFp: string): Promise<{ channel: Channel; fingerprint: string }> {
  let a: { v: number; e: string; cert: string; spki: string; sig: string };
  try { a = JSON.parse(dec.decode(answer)); } catch { throw new Error('The gateway answered with something that is not the hub.'); }
  if (a.v !== 1 || typeof a.e !== 'string' || typeof a.cert !== 'string' || typeof a.spki !== 'string' || typeof a.sig !== 'string') throw new Error('The gateway answered with something that is not the hub.');
  const cert = unb64(a.cert);
  const spki = unb64(a.spki);
  const hubEph = unb64(a.e);
  const fingerprint = fingerprintOf(cert);
  if (fingerprint !== pinnedFp) throw Object.assign(new Error('The hub behind the gateway is not the one this device trusts.'), { code: 'identity-mismatch', fingerprint });
  // the public key must be the certificate's own (it appears in the certificate's DER as-is)
  if (spki.length < 64 || indexOf(cert, spki) < 0) throw new Error('The hub\'s key does not belong to its certificate.');
  const key = await subtle().importKey('spki', spki as BufferSource, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await subtle().verify('RSASSA-PKCS1-v1_5', key, unb64(a.sig) as BufferSource, transcript(hubId, h.eph, hubEph) as BufferSource);
  if (!ok) throw new Error('The hub\'s signature did not check out.');
  const k = await keys(x25519.getSharedSecret(h.secret, hubEph), h.eph, hubEph);
  return { channel: new Channel(k.toHub, k.toDevice), fingerprint };
}

// ------------------------------------------------------------------ hub side
export interface HubIdentity {
  hubId: string;
  certDer: Uint8Array;
  spkiDer: Uint8Array;
  /** RSASSA-PKCS1-v1_5 / SHA-256 with the certificate's private key. */
  sign(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

export async function hubAnswer(id: HubIdentity, hello: Uint8Array): Promise<{ channel: Channel; answer: Uint8Array }> {
  let h: { v: number; e: string };
  try { h = JSON.parse(dec.decode(hello)); } catch { throw new Error('not a device hello'); }
  if (h.v !== 1 || typeof h.e !== 'string') throw new Error('not a device hello');
  const deviceEph = unb64(h.e);
  if (deviceEph.length !== 32) throw new Error('bad key');
  const secret = x25519.utils.randomSecretKey();
  const hubEph = x25519.getPublicKey(secret);
  const sig = await id.sign(transcript(id.hubId, deviceEph, hubEph));
  const k = await keys(x25519.getSharedSecret(secret, deviceEph), deviceEph, hubEph);
  const answer = enc.encode(JSON.stringify({ v: 1, e: b64(hubEph), cert: b64(id.certDer), spki: b64(id.spkiDer), sig: b64(sig) }));
  return { channel: new Channel(k.toDevice, k.toHub), answer };
}

// ------------------------------------------------------------------ framing helpers
export function u32(n: number): Uint8Array { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; }
export function readU32(b: Uint8Array, at = 0): number { return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at); }
export const concat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
export const utf8 = (s: string) => enc.encode(s);
export const fromUtf8 = (b: Uint8Array) => dec.decode(b);

// ------------------------------------------------------------------ setup codes
/** Where a device finds its hub from outside the office, and how it knows it is the right one. */
export interface RemoteInfo { url: string; hubId: string; fp: string; name?: string }

/** "DXC1-…": everything a new phone or home laptop needs to reach the hub through the gateway. */
export function setupCode(r: RemoteInfo): string {
  return `DXC1-${b64(enc.encode(JSON.stringify({ u: r.url, h: r.hubId, f: r.fp, n: r.name ?? '' }))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

export function parseSetupCode(raw: string): RemoteInfo | null {
  const m = raw.trim().match(/DXC1-([A-Za-z0-9_-]+)/);
  if (!m) return null;
  try {
    const s = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const j = JSON.parse(dec.decode(unb64(s + '='.repeat((4 - (s.length % 4)) % 4)))) as { u: string; h: string; f: string; n?: string };
    if (!/^(https:\/\/[^\s/]+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)(\/[^\s]*)?$/.test(j.u) || !/^[0-9A-Za-z_-]{6,64}$/.test(j.h) || !/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(j.f)) return null;
    return { url: j.u.replace(/\/+$/, ''), hubId: j.h, fp: j.f, name: j.n || undefined };
  } catch { return null; }
}

/** The gateway address a device connects to for this hub. */
export const deviceUrl = (r: { url: string; hubId: string }) => `${r.url.replace(/^http/, 'ws').replace(/\/+$/, '')}/c/${encodeURIComponent(r.hubId)}`;
export const hubUrl = (url: string, hubId: string) => `${url.replace(/^http/, 'ws').replace(/\/+$/, '')}/hub/${encodeURIComponent(hubId)}`;

// ------------------------------------------------------------------ device transport
/** A raw binary WebSocket to the gateway (Node `ws`, the browser's, or Android's native one). */
export interface RawSocket { send(data: Uint8Array): void; close(): void }
export interface RawHandlers { onOpen(): void; onBinary(data: Uint8Array): void; onClose(reason: string): void }
export type OpenRaw = (url: string, h: RawHandlers) => RawSocket;

export interface TunnelResponse { status: number; headers: Record<string, string>; body: AsyncIterable<Uint8Array> }
export interface TunnelRequest { method: string; path: string; headers?: Record<string, string>; body?: Uint8Array | AsyncIterable<Uint8Array> }

/** A hub socket that also carries HTTP (files) through the encrypted channel. */
export interface RemoteHubSocket extends HubSocket { remote: true; http(req: TunnelRequest): Promise<TunnelResponse> }

class Queue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private ended: Error | null | undefined;
  push(v: T) { const w = this.waiters.shift(); if (w) w({ value: v, done: false }); else this.items.push(v); }
  end(err?: Error) { this.ended = err ?? null; for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true }); }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.ended !== undefined) return this.ended ? Promise.reject(this.ended) : Promise.resolve({ value: undefined as never, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
    };
  }
}

/**
 * Opens the hub through the gateway: the same HubSocket the session uses on the office network,
 * reporting the hub's (verified) certificate fingerprint so sign-in proofs bind to it as usual.
 */
export function openRemoteSocket(openRaw: OpenRaw, target: HubTarget & { remote: { url: string; hubId: string } }, h: SocketHandlers): RemoteHubSocket {
  const hs = deviceHello();
  let channel: Channel | null = null;
  let closed = false;
  let nextReq = 1;
  const responses = new Map<number, { resolve: (r: TunnelResponse) => void; reject: (e: Error) => void; body: Queue<Uint8Array> | null }>();
  let pinger: ReturnType<typeof setInterval> | null = null;
  const finish = (reason: string) => {
    if (closed) return;
    closed = true;
    if (pinger) clearInterval(pinger);
    for (const r of responses.values()) { r.reject(new Error(reason)); r.body?.end(new Error(reason)); }
    responses.clear();
    h.onClose(reason);
  };
  const sendSealed = async (type: number, body: Uint8Array) => {
    if (!channel || closed) throw new Error('not connected');
    raw.send(await channel.seal(type, body));
  };
  const raw = openRaw(deviceUrl(target.remote), {
    onOpen: () => raw.send(hs.hello),
    onBinary: (data) => {
      if (closed) return;
      if (!channel) {
        if (!target.fp) { finish('This device has no fingerprint for the hub yet. Use the setup code from a colleague\'s PC.'); raw.close(); return; }
        void deviceFinish(hs, data, target.remote.hubId, target.fp).then((r) => {
          channel = r.channel;
          // keep NAT and the gateway's idle timers happy
          pinger = setInterval(() => { void sendSealed(F.PING, new Uint8Array(0)).catch(() => {}); }, 25_000);
          h.onOpen(r.fingerprint);
        }).catch((e: Error & { fingerprint?: string }) => {
          if (e.fingerprint) h.onOpen(e.fingerprint); // lets the session report the mismatch
          finish(e.message);
          raw.close();
        });
        return;
      }
      void channel.open(data).then(({ type, body }) => {
        if (type === F.TEXT) h.onMessage(fromUtf8(body));
        else if (type === F.RES) {
          const id = readU32(body);
          const r = responses.get(id);
          if (!r) return;
          const head = JSON.parse(fromUtf8(body.subarray(4))) as { status: number; headers: Record<string, string> };
          r.body = new Queue();
          r.resolve({ status: head.status, headers: head.headers, body: r.body });
        } else if (type === F.RES_BODY) responses.get(readU32(body))?.body?.push(body.slice(4));
        else if (type === F.RES_END) { const id = readU32(body); responses.get(id)?.body?.end(); responses.delete(id); }
        else if (type === F.RES_ERR) {
          const id = readU32(body);
          const r = responses.get(id);
          const err = new Error(fromUtf8(body.subarray(4)) || 'Request failed');
          r?.reject(err); r?.body?.end(err); responses.delete(id);
        }
      }).catch(() => { finish('The encrypted channel to the hub broke.'); raw.close(); });
    },
    onClose: (reason) => finish(reason),
  });
  return {
    remote: true,
    send: (data) => { void sendSealed(F.TEXT, utf8(data)).catch(() => {}); },
    close: () => { if (!closed) { closed = true; if (pinger) clearInterval(pinger); raw.close(); } },
    http: async (req) => {
      const id = nextReq++;
      const p = new Promise<TunnelResponse>((resolve, reject) => responses.set(id, { resolve, reject, body: null }));
      await sendSealed(F.REQ, concat(u32(id), utf8(JSON.stringify({ method: req.method, path: req.path, headers: req.headers ?? {} }))));
      if (req.body) {
        const parts: AsyncIterable<Uint8Array> | Uint8Array[] = req.body instanceof Uint8Array ? [req.body] : req.body;
        for await (const part of parts) {
          for (let o = 0; o < part.length; o += CHUNK) await sendSealed(F.REQ_BODY, concat(u32(id), part.subarray(o, o + CHUNK)));
        }
      }
      await sendSealed(F.REQ_END, u32(id));
      return p;
    },
  };
}
