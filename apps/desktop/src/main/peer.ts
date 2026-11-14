// Hub-off mode: when the office hub cannot be reached, PCs on the same network find each other
// and pass end-to-end sealed Direct messages straight across. Every PC also keeps what it
// sent in an outbox and posts it to the hub when it is back (the hub drops duplicates by
// clientId), so history stays complete.
//
// Discovery: a signed UDP broadcast on port 47902. Transport: a TCP connection of JSON lines;
// the caller proves its device by signing the listener's challenge. Message bodies are sealed
// envelopes, so a PC can only read what was sealed for it, and only Direct conversations
// whose members all have keys use this path.
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ulid } from '@dex/core';
import type { Message } from '@dex/core';
import { verifySignature } from '@dex/core';
import { isSealed } from '@dex/core/e2e';
import type { E2EClient } from '@dex/core/e2e-client';

export const PEER_PORT = 47902;
const BEACON_MS = 4000;
const PEER_TTL = 15_000;
const MAX_LINE = 256 * 1024;

export interface OutboxItem { convId: string; body: string; clientId: string; parentId: string | null; createdAt: number; id: string }
interface Peer { deviceId: string; userId: string; address: string; port: number; seen: number }

const enc = (s: string) => new TextEncoder().encode(s);

export class PeerNet extends EventEmitter {
  private readonly e2e: E2EClient;
  private readonly deviceId: string;
  private readonly sign: (p: Uint8Array) => string;
  private readonly dir: string;
  private udp: dgram.Socket | null = null;
  private server: net.Server | null = null;
  private port = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = false;
  readonly peers = new Map<string, Peer>();
  private outbox: OutboxItem[] = [];

  constructor(opts: { e2e: E2EClient; deviceId: string; sign: (p: Uint8Array) => string; dataDir: string }) {
    super();
    this.e2e = opts.e2e;
    this.deviceId = opts.deviceId;
    this.sign = opts.sign;
    this.dir = opts.dataDir;
    try { this.outbox = JSON.parse(fs.readFileSync(path.join(this.dir, 'outbox.json'), 'utf8')) as OutboxItem[]; } catch { this.outbox = []; }
    try { this.e2e.seed(JSON.parse(fs.readFileSync(path.join(this.dir, 'directory-cache.json'), 'utf8'))); } catch { /* first run */ }
  }

  /** Save keys and conversations so Direct messages work after a restart with the hub off. */
  saveDirectory(): void {
    try { fs.writeFileSync(path.join(this.dir, 'directory-cache.json'), JSON.stringify(this.e2e.snapshot())); } catch { /* best effort */ }
  }

  private saveOutbox(): void {
    try { fs.writeFileSync(path.join(this.dir, 'outbox.json'), JSON.stringify(this.outbox)); } catch { /* best effort */ }
  }

  get pending(): OutboxItem[] { return this.outbox; }

  async start(): Promise<void> {
    this.server = net.createServer((sock) => this.accept(sock));
    await new Promise<void>((resolve) => this.server!.listen(0, '0.0.0.0', () => resolve()));
    this.port = (this.server.address() as net.AddressInfo).port;
    const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    udp.on('message', (buf, rinfo) => this.onBeacon(buf, rinfo.address));
    udp.on('error', () => { /* another app holds the port: we can still call out */ });
    await new Promise<void>((resolve) => udp.bind(PEER_PORT, () => { try { udp.setBroadcast(true); } catch { /* ignore */ } resolve(); })).catch(() => {});
    this.udp = udp;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.udp?.close();
    this.server?.close();
  }

  /** Turn hub-off mode on or off (beacons are only sent while the hub is unreachable). */
  setActive(on: boolean): void {
    if (this.active === on) return;
    this.active = on;
    this.e2e.setOffline(on);
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (on) {
      this.beacon();
      this.timer = setInterval(() => { this.beacon(); this.expire(); void this.retry(); }, BEACON_MS);
    }
    this.emit('changed');
  }

  get isActive(): boolean { return this.active; }

  /** People reachable directly right now. */
  reachableUsers(): string[] {
    this.expire();
    return [...new Set([...this.peers.values()].map((p) => p.userId))];
  }

  private expire(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, p] of this.peers) if (now - p.seen > PEER_TTL) { this.peers.delete(id); changed = true; }
    if (changed) this.emit('changed');
  }

  private beacon(): void {
    const me = this.e2e.me;
    if (!this.udp || !me || !this.port) return;
    const t = Date.now();
    const body = { app: 'dexconnect', kind: 'peer', v: 1, d: this.deviceId, u: me, p: this.port, t };
    const msg = Buffer.from(JSON.stringify({ ...body, s: this.sign(enc(`peer|${body.d}|${body.u}|${body.p}|${t}`)) }));
    for (const addr of broadcastAddresses()) this.udp.send(msg, PEER_PORT, addr, () => {});
  }

  private onBeacon(buf: Buffer, address: string): void {
    if (buf.length > 2048) return;
    let b: { app?: string; kind?: string; d?: string; u?: string; p?: number; t?: number; s?: string };
    try { b = JSON.parse(buf.toString('utf8')); } catch { return; }
    if (b.app !== 'dexconnect' || b.kind !== 'peer' || typeof b.d !== 'string' || typeof b.u !== 'string' || typeof b.p !== 'number' || typeof b.t !== 'number' || typeof b.s !== 'string') return;
    if (b.d === this.deviceId || Math.abs(Date.now() - b.t) > 60_000) return;
    const key = this.e2e.deviceKey(b.d);
    if (!key || key.userId !== b.u || !verifySignature(key.signKey, enc(`peer|${b.d}|${b.u}|${b.p}|${b.t}`), b.s)) return;
    const known = this.peers.has(b.d);
    this.peers.set(b.d, { deviceId: b.d, userId: b.u, address, port: b.p, seen: Date.now() });
    if (!known) { this.emit('changed'); void this.retry(); }
  }

  // ------------------------------------------------------------ sending
  /** Send a Direct message without the hub. Returns the message as the UI should show it. */
  async send(convId: string, text: string, parentId: string | null, clientId: string): Promise<Message> {
    const conv = this.e2e.conversationOf(convId);
    if (!conv || conv.kind !== 'direct') throw new Error('Only Direct messages can be sent while the hub is off.');
    const body = await this.e2e.sealDirect(convId, text);
    if (!body) throw new Error('This conversation cannot be reached without the hub.');
    const item: OutboxItem = { convId, body, clientId, parentId, createdAt: Date.now(), id: ulid() };
    this.outbox.push(item);
    this.saveOutbox();
    void this.deliver(item);
    return this.asMessage(item, this.e2e.me);
  }

  private asMessage(item: OutboxItem, authorId: string): Message {
    return {
      via: 'direct',
      id: item.id, convId: item.convId, authorId, body: item.body, parentId: item.parentId, createdAt: item.createdAt, editedAt: null, deleted: false,
      pinned: false, reactions: {}, mentions: [], replyCount: 0, lastReplyAt: null, clientId: item.clientId, files: [], forwardedFrom: null, poll: null, form: null,
    };
  }

  /** Who has this item already (so retries go only to the rest). */
  private readonly delivered = new Map<string, Set<string>>();

  private async deliver(item: OutboxItem): Promise<void> {
    const conv = this.e2e.conversationOf(item.convId);
    if (!conv) return;
    const done = this.delivered.get(item.clientId) ?? new Set<string>();
    this.delivered.set(item.clientId, done);
    const targets = [...this.peers.values()].filter((p) => conv.members.includes(p.userId) && !done.has(p.deviceId));
    await Promise.all(targets.map(async (p) => { if (await this.post(p, item)) done.add(p.deviceId); }));
  }

  private async retry(): Promise<void> {
    for (const item of this.outbox) if (Date.now() - item.createdAt < 24 * 3600_000) await this.deliver(item);
  }

  /** The hub is back: post everything queued, oldest first. */
  async flush(post: (item: OutboxItem) => Promise<void>): Promise<number> {
    let n = 0;
    while (this.outbox.length) {
      const item = this.outbox[0];
      try { await post(item); n++; } catch (err) {
        // a refusal (e.g. no longer a member) will never succeed: drop it; anything else waits
        if (!/not connected|timed out|closed/i.test((err as Error).message)) this.emit('dropped', item, err);
        else break;
      }
      this.outbox.shift();
      this.delivered.delete(item.clientId);
      this.saveOutbox();
    }
    return n;
  }

  private post(p: Peer, item: OutboxItem): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = net.connect({ host: p.address, port: p.port, timeout: 5000 });
      let buf = '';
      let ok = false;
      const end = () => { sock.destroy(); resolve(ok); };
      sock.on('timeout', end);
      sock.on('error', end);
      sock.on('close', () => resolve(ok));
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        if (buf.length > MAX_LINE) { end(); return; }
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let f: { t?: string; n?: string; clientId?: string };
          try { f = JSON.parse(line); } catch { end(); return; }
          if (f.t === 'challenge' && typeof f.n === 'string') {
            sock.write(`${JSON.stringify({ t: 'hello', d: this.deviceId, u: this.e2e.me, s: this.sign(enc(`p2p|${f.n}|${this.deviceId}`)) })}\n`);
            sock.write(`${JSON.stringify({ t: 'msg', m: { convId: item.convId, body: item.body, clientId: item.clientId, parentId: item.parentId, createdAt: item.createdAt, id: item.id } })}\n`);
          } else if (f.t === 'ack' && f.clientId === item.clientId) { ok = true; sock.end(); }
          else if (f.t === 'error') end();
        }
      });
    });
  }

  // ------------------------------------------------------------ receiving
  private accept(sock: net.Socket): void {
    const nonce = crypto.randomBytes(16).toString('base64');
    let who: { deviceId: string; userId: string } | null = null;
    let buf = '';
    sock.setTimeout(10_000, () => sock.destroy());
    sock.on('error', () => sock.destroy());
    sock.write(`${JSON.stringify({ t: 'challenge', n: nonce })}\n`);
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.length > MAX_LINE) { sock.destroy(); return; }
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let f: { t?: string; d?: string; u?: string; s?: string; m?: Partial<OutboxItem> };
        try { f = JSON.parse(line); } catch { sock.destroy(); return; }
        if (f.t === 'hello' && !who) {
          const key = typeof f.d === 'string' ? this.e2e.deviceKey(f.d) : null;
          const ok = !!key && key.userId === f.u && typeof f.s === 'string' && verifySignature(key.signKey, enc(`p2p|${nonce}|${f.d}`), f.s);
          if (!ok) { sock.end(`${JSON.stringify({ t: 'error', error: 'unknown device' })}\n`); return; }
          who = { deviceId: f.d!, userId: f.u! };
        } else if (f.t === 'msg' && who && f.m) {
          const m = f.m;
          const conv = typeof m.convId === 'string' ? this.e2e.conversationOf(m.convId) : null;
          if (!conv || conv.kind !== 'direct' || !conv.members.includes(who.userId) || !conv.members.includes(this.e2e.me)
            || !isSealed(m.body) || typeof m.clientId !== 'string' || m.clientId.length > 96) {
            sock.end(`${JSON.stringify({ t: 'error', error: 'refused' })}\n`);
            return;
          }
          const item: OutboxItem = { convId: m.convId!, body: m.body as string, clientId: m.clientId, parentId: typeof m.parentId === 'string' ? m.parentId : null,
            createdAt: typeof m.createdAt === 'number' ? Math.min(m.createdAt, Date.now()) : Date.now(), id: typeof m.id === 'string' && /^[0-9A-Z]{26}$/.test(m.id) ? m.id : ulid() };
          sock.write(`${JSON.stringify({ t: 'ack', clientId: item.clientId })}\n`);
          this.emit('message', this.asMessage(item, who.userId));
        }
      }
    });
  }
}

/** Broadcast addresses of this PC's IPv4 networks (plus the general one). */
function broadcastAddresses(): string[] {
  const out = new Set<string>(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.add(ip.map((o, i) => (o & mask[i]) | (~mask[i] & 255)).join('.'));
    }
  }
  return [...out];
}
