// The hub's side of the internet gateway. The hub keeps one outbound WebSocket to the gateway (no
// port is opened at the office). For each device that connects there, it answers the encrypted
// handshake with its certificate key, then replays the device's traffic into its own local
// endpoint, exactly as if the device were on the office network: sign-in, approval, messages,
// calls' signalling, everything. HTTP inside the channel is limited to files and updates.
//
// Guests joining a meeting from a browser (M2) are not devices: the gateway serves them a page
// and passes their JSON frames here as "guest" control frames on the same connection, which the
// hub hands to meet-guests.ts. They never reach the hub's local endpoint.
import crypto, { X509Certificate } from 'node:crypto';
import https from 'node:https';
import WebSocket from 'ws';
import { CHUNK, F, concat, fromUtf8, hubAnswer, hubUrl, readU32, u32, utf8 } from '@dex/core/remote';
import type { Channel, HubIdentity } from '@dex/core/remote';

export interface RemoteStatus {
  url: string | null;
  connected: boolean;
  since: number | null;
  error: string | null;
  devices: number;
  /** The gateway enforces this hub's fingerprint (HUB_FINGERPRINT), rather than trusting the first hub. */
  pinned: boolean;
}

interface Options {
  hubId: string;
  certPem: string;
  keyPem: string;
  localPort: () => number;
  /** Header value that marks the hub's own loopback connections as coming through the gateway. */
  secret: string;
  log: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
  onStatus: (s: RemoteStatus) => void;
  /** Browser guests on the gateway's meeting pages. */
  guests?: GuestSink;
}

/** Where guest frames go (meet-guests.ts). */
export interface GuestSink {
  open(gid: number, ip: string, meetingId: string): void;
  frame(gid: number, text: string): void;
  closed(gid: number): void;
  /** The gateway connection dropped: every guest is gone. */
  dropAll(): void;
}

/** What a device may fetch over HTTP through the gateway: files and update downloads, nothing else. */
const ALLOWED: Array<[string, RegExp]> = [
  ['POST', /^\/files(\?[^#]*)?$/],
  ['GET', /^\/files\/[0-9A-Z]{26}(\?[^#]*)?$/],
  ['HEAD', /^\/files\/[0-9A-Z]{26}(\?[^#]*)?$/],
  ['GET', /^\/updates\/[\w.-]+(\/[\w.-]+)*$/],
];
const PASS_HEADERS = ['authorization', 'content-type', 'content-length', 'range', 'if-none-match'];
const MAX_STREAMS = 600;
const HIGH_WATER = 8 * 1024 * 1024;

export class RemoteGateway {
  private ws: WebSocket | null = null;
  private url: string | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly streams = new Map<number, Stream>();
  private readonly identity: HubIdentity;
  status: RemoteStatus = { url: null, connected: false, since: null, error: null, devices: 0, pinned: false };
  readonly opts: Options;

  constructor(opts: Options) {
    this.opts = opts;
    const x = new X509Certificate(opts.certPem);
    this.identity = {
      hubId: opts.hubId,
      certDer: new Uint8Array(x.raw),
      spkiDer: new Uint8Array(x.publicKey.export({ type: 'spki', format: 'der' })),
      sign: (d) => new Uint8Array(crypto.sign('sha256', d, opts.keyPem)),
    };
  }

  /** Connect to this gateway (an https:// address), or disconnect with null. */
  configure(url: string | null): void {
    if (url === this.url && (this.ws || this.retry)) return;
    this.stop();
    this.url = url;
    this.setStatus({ url, connected: false, since: null, error: null, devices: 0 });
    if (url) this.connect();
  }

  stop(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    const ws = this.ws;
    // tell the gateway to close every device's socket, then leave cleanly
    for (const [sid, st] of this.streams) { this.closeStream(sid, 4403, 'Access from outside the office was turned off'); st.end(); }
    this.streams.clear();
    this.opts.guests?.dropAll();
    this.ws = null;
    if (ws) {
      ws.removeAllListeners();
      ws.on('error', () => {});
      try { ws.close(1000, 'Hub left the gateway'); } catch { /* not open */ }
      setTimeout(() => ws.terminate(), 1000).unref?.();
    }
  }

  private setStatus(p: Partial<RemoteStatus>): void {
    this.status = { ...this.status, ...p, devices: this.streams.size };
    this.opts.onStatus(this.status);
  }

  private connect(): void {
    if (!this.url) return;
    const ws = new WebSocket(hubUrl(this.url, this.opts.hubId), { handshakeTimeout: 15_000, maxPayload: 2 * 1024 * 1024 });
    this.ws = ws;
    ws.on('open', () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => { try { ws.ping(); } catch { /* closing */ } }, 30_000);
    });
    ws.on('message', (raw, isBinary) => {
      if (!isBinary) { this.control(ws, raw.toString()); return; }
      const buf = raw as Buffer;
      if (buf.length < 4) return;
      const sid = buf.readUInt32BE(0);
      this.streams.get(sid)?.onFrame(new Uint8Array(buf.buffer, buf.byteOffset + 4, buf.length - 4));
    });
    const down = (reason: string) => {
      if (this.ws !== ws) return;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.ws = null;
      for (const s of this.streams.values()) s.end();
      this.streams.clear();
      this.opts.guests?.dropAll();
      const delay = Math.min(60_000, 2000 * 2 ** Math.min(this.attempts++, 5));
      this.setStatus({ connected: false, since: null, error: reason });
      this.opts.log('warn', 'gateway disconnected', { reason, retryInMs: delay });
      this.retry = setTimeout(() => { this.retry = null; this.connect(); }, delay);
    };
    ws.on('close', (code, reason) => down(reason.toString() || `closed (${code})`));
    ws.on('error', (err) => down(err.message));
  }

  private control(ws: WebSocket, raw: string): void {
    let m: { t?: string; n?: string; s?: number; g?: number; m?: string; d?: string; ip?: string; country?: string | null; fp?: string; pinned?: boolean };
    try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'challenge' && typeof m.n === 'string') {
      const sig = crypto.sign('sha256', Buffer.from(`dexconnect-gw-hub-v1|${this.opts.hubId}|${m.n}`), this.opts.keyPem);
      ws.send(JSON.stringify({ t: 'auth', cert: Buffer.from(this.identity.certDer).toString('base64'), spki: Buffer.from(this.identity.spkiDer).toString('base64'), sig: sig.toString('base64') }));
    } else if (m.t === 'ready') {
      this.attempts = 0;
      this.setStatus({ connected: true, since: Date.now(), error: null, pinned: !!m.pinned });
      this.opts.log('info', 'gateway connected', { url: this.url, pinned: !!m.pinned });
    } else if (m.t === 'open' && typeof m.s === 'number') {
      if (this.streams.size >= MAX_STREAMS) { ws.send(JSON.stringify({ t: 'close', s: m.s, code: 4429, reason: 'The hub is busy' })); return; }
      const ip = `${m.ip ?? 'unknown'}${m.country ? ` (${m.country})` : ''}`;
      this.streams.set(m.s, new Stream(this, m.s, ip));
      this.setStatus({});
    } else if (m.t === 'closed' && typeof m.s === 'number') {
      this.streams.get(m.s)?.end();
    } else if (m.t === 'g-open' && typeof m.g === 'number') {
      const g = this.opts.guests;
      if (!g) { this.closeGuest(m.g, 4404, 'Guests cannot join meetings on this hub.'); return; }
      g.open(m.g, `${m.ip ?? 'unknown'}${m.country ? ` (${m.country})` : ''}`, String(m.m ?? ''));
    } else if (m.t === 'g' && typeof m.g === 'number' && typeof m.d === 'string') {
      this.opts.guests?.frame(m.g, m.d);
    } else if (m.t === 'g-closed' && typeof m.g === 'number') {
      this.opts.guests?.closed(m.g);
    }
  }

  /** A frame to a browser guest (through the gateway). */
  sendGuest(gid: number, frame: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'g', g: gid, d: JSON.stringify(frame) }));
  }

  /** Close a browser guest's connection; code 4403 tells the gateway the passcode was wrong. */
  closeGuest(gid: number, code: number, reason: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'g-close', g: gid, code, reason: reason.slice(0, 120) }));
  }

  // ---------------------------------------------------------------- used by streams
  get hubIdentity(): HubIdentity { return this.identity; }
  sendRaw(sid: number, data: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(concat(u32(sid), data));
  }
  closeStream(sid: number, code: number, reason: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'close', s: sid, code, reason }));
  }
  dropped(sid: number): void {
    if (this.streams.delete(sid)) this.setStatus({});
  }
  get buffered(): number { return this.ws?.bufferedAmount ?? 0; }
}

/** One device's encrypted channel, replayed into the hub's own local endpoint. */
class Stream {
  private channel: Channel | null = null;
  private local: WebSocket | null = null;
  private backlog: string[] = [];
  private ended = false;
  private readonly requests = new Map<number, { req: import('node:http').ClientRequest | null; refused: boolean }>();
  private readonly gw: RemoteGateway;
  private readonly sid: number;
  private readonly ip: string;

  constructor(gw: RemoteGateway, sid: number, ip: string) { this.gw = gw; this.sid = sid; this.ip = ip; }

  private seal(type: number, body: Uint8Array): Promise<void> {
    if (!this.channel || this.ended) return Promise.resolve();
    return this.channel.seal(type, body).then((f) => this.gw.sendRaw(this.sid, f));
  }

  onFrame(data: Uint8Array): void {
    if (this.ended) return;
    if (!this.channel) {
      void hubAnswer(this.gw.hubIdentity, data).then(({ channel, answer }) => {
        this.channel = channel;
        this.gw.sendRaw(this.sid, answer);
        this.openLocal();
      }).catch(() => this.fail(4400, 'Not a Dexterity Connect device'));
      return;
    }
    void this.channel.open(data).then(({ type, body }) => this.handle(type, body)).catch(() => this.fail(4400, 'The encrypted channel broke'));
  }

  private openLocal(): void {
    const local = new WebSocket(`wss://127.0.0.1:${this.gw.opts.localPort()}/ws`, {
      rejectUnauthorized: false, // the hub talking to itself
      headers: { 'x-dex-gateway': this.gw.opts.secret, 'x-dex-remote-ip': this.ip },
      maxPayload: 8 * 1024 * 1024,
    });
    this.local = local;
    local.on('open', () => { for (const t of this.backlog.splice(0)) local.send(t); });
    local.on('message', (raw) => { void this.seal(F.TEXT, utf8(raw.toString())); });
    local.on('close', () => this.fail(4000, 'Signed out'));
    local.on('error', () => this.fail(4500, 'The hub refused the connection'));
  }

  private handle(type: number, body: Uint8Array): void {
    if (type === F.TEXT) {
      const t = fromUtf8(body);
      if (this.local?.readyState === WebSocket.OPEN) this.local.send(t);
      else if (this.backlog.length < 200) this.backlog.push(t);
      return;
    }
    if (type === F.PING) { void this.seal(F.PONG, new Uint8Array(0)); return; }
    if (type === F.REQ) { this.request(readU32(body), body.subarray(4)); return; }
    if (type === F.REQ_BODY) { const r = this.requests.get(readU32(body)); if (r?.req) r.req.write(Buffer.from(body.subarray(4))); return; }
    if (type === F.REQ_END) { const r = this.requests.get(readU32(body)); if (r?.req && !r.req.writableEnded) r.req.end(); return; }
  }

  private request(id: number, headRaw: Uint8Array): void {
    let head: { method: string; path: string; headers: Record<string, string> };
    try { head = JSON.parse(fromUtf8(headRaw)); } catch { void this.seal(F.RES_ERR, concat(u32(id), utf8('Bad request'))); return; }
    const method = String(head.method).toUpperCase();
    const path = String(head.path);
    if (!ALLOWED.some(([m, re]) => m === method && re.test(path)) || this.requests.size > 16) {
      this.requests.set(id, { req: null, refused: true });
      void this.seal(F.RES, concat(u32(id), utf8(JSON.stringify({ status: 403, headers: { 'content-type': 'application/json' } }))))
        .then(() => this.seal(F.RES_BODY, concat(u32(id), utf8(JSON.stringify({ error: 'Not available outside the office.' })))))
        .then(() => this.seal(F.RES_END, u32(id)));
      return;
    }
    const headers: Record<string, string> = {};
    for (const k of PASS_HEADERS) { const v = head.headers?.[k] ?? head.headers?.[k.replace(/(^|-)\w/g, (c) => c.toUpperCase())]; if (typeof v === 'string') headers[k] = v; }
    headers['x-dex-gateway'] = this.gw.opts.secret;
    headers['x-dex-remote-ip'] = this.ip;
    const req = https.request({ host: '127.0.0.1', port: this.gw.opts.localPort(), method, path, headers, rejectUnauthorized: false }, (res) => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') out[k] = v;
      void this.seal(F.RES, concat(u32(id), utf8(JSON.stringify({ status: res.statusCode ?? 500, headers: out }))));
      let pending: Buffer = Buffer.alloc(0);
      const flush = (final: boolean) => {
        while (pending.length >= CHUNK || (final && pending.length)) {
          const part = pending.subarray(0, CHUNK);
          pending = pending.subarray(part.length);
          void this.seal(F.RES_BODY, concat(u32(id), new Uint8Array(part)));
        }
      };
      res.on('data', (c: Buffer) => {
        pending = pending.length ? Buffer.concat([pending, c]) : c;
        flush(false);
        // the gateway connection is slower than the disk: wait for it to drain
        if (this.gw.buffered > HIGH_WATER) {
          res.pause();
          const wait = setInterval(() => { if (this.ended || this.gw.buffered < HIGH_WATER / 2) { clearInterval(wait); res.resume(); } }, 50);
        }
      });
      res.on('end', () => { flush(true); void this.seal(F.RES_END, u32(id)); this.requests.delete(id); });
      res.on('error', () => { void this.seal(F.RES_ERR, concat(u32(id), utf8('Download interrupted'))); this.requests.delete(id); });
    });
    req.on('error', (e) => { void this.seal(F.RES_ERR, concat(u32(id), utf8(e.message))); this.requests.delete(id); });
    this.requests.set(id, { req, refused: false });
    if (method === 'GET' || method === 'HEAD') req.end();
  }

  private fail(code: number, reason: string): void {
    if (this.ended) return;
    this.gw.closeStream(this.sid, code, reason);
    this.end();
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const r of this.requests.values()) r.req?.destroy();
    this.requests.clear();
    const l = this.local;
    this.local = null;
    if (l) { l.removeAllListeners(); l.on('error', () => {}); l.terminate(); }
    this.gw.dropped(this.sid);
  }
}
