// Zero-configuration hub discovery on the office LAN.
// Clients broadcast a small UDP probe; every hub that hears it answers the sender directly.
// No multicast group, firewall rule or port reservation is needed on client PCs.
import dgram from 'node:dgram';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { APP_ID, DISCOVERY_PORT, PROTOCOL_VERSION } from './protocol.ts';

export interface HubBeacon {
  app: typeof APP_ID;
  v: number;
  kind: 'hub';
  id: string;
  name: string;
  port: number;
  /** SHA-256 fingerprint of the hub's TLS certificate (colon-separated hex) */
  fp: string;
  version: string;
}

export interface Probe {
  app: typeof APP_ID;
  v: number;
  kind: 'probe';
}

export interface FoundHub {
  beacon: HubBeacon;
  address: string;
  seenAt: number;
}

const FP_RE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

export function parsePacket(buf: Buffer): HubBeacon | Probe | null {
  if (buf.length > 2048) return null;
  let v: unknown;
  try { v = JSON.parse(buf.toString('utf8')); } catch { return null; }
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  if (p.app !== APP_ID || typeof p.v !== 'number') return null;
  if (p.kind === 'probe') return { app: APP_ID, v: p.v, kind: 'probe' };
  if (p.kind === 'hub'
    && typeof p.id === 'string' && p.id.length <= 64
    && typeof p.name === 'string' && p.name.length <= 120
    && typeof p.port === 'number' && Number.isInteger(p.port) && p.port > 0 && p.port < 65536
    && typeof p.fp === 'string' && FP_RE.test(p.fp)
    && typeof p.version === 'string') {
    return { app: APP_ID, v: p.v, kind: 'hub', id: p.id, name: p.name, port: p.port, fp: p.fp, version: p.version };
  }
  return null;
}

/** Directed broadcast address of every active IPv4 interface, plus the limited broadcast. */
export function broadcastTargets(): string[] {
  const out = new Set<string>(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal || !ni.netmask) continue;
      const ip = ni.address.split('.').map(Number);
      const mask = ni.netmask.split('.').map(Number);
      out.add(ip.map((b, i) => (b | (~mask[i] & 255)) & 255).join('.'));
    }
  }
  return [...out];
}

export interface HubFinderOptions {
  port?: number;
  /** Override the broadcast targets (tests use 127.0.0.1). */
  targets?: string[];
  intervalMs?: number;
}

/** Client side: probes the LAN and emits 'hub' (FoundHub) for every answer. */
export class HubFinder extends EventEmitter {
  private socket: dgram.Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  readonly hubs = new Map<string, FoundHub>();
  private readonly opts: Required<HubFinderOptions>;

  constructor(opts: HubFinderOptions = {}) {
    super();
    this.opts = {
      port: opts.port ?? DISCOVERY_PORT,
      targets: opts.targets ?? [],
      intervalMs: opts.intervalMs ?? 4000,
    };
  }

  start(): void {
    if (this.socket) return;
    const socket = dgram.createSocket({ type: 'udp4' });
    this.socket = socket;
    socket.on('error', (err) => this.emit('warning', err));
    socket.on('message', (msg, rinfo) => {
      const p = parsePacket(msg);
      if (!p || p.kind !== 'hub') return;
      const found: FoundHub = { beacon: p, address: rinfo.address, seenAt: Date.now() };
      const isNew = !this.hubs.has(p.id);
      this.hubs.set(p.id, found);
      this.emit('hub', found, isNew);
    });
    socket.bind(0, () => {
      try { socket.setBroadcast(true); } catch { /* not fatal */ }
      this.probe();
      this.timer = setInterval(() => this.probe(), this.opts.intervalMs);
    });
  }

  probe(): void {
    if (!this.socket) return;
    const msg = Buffer.from(JSON.stringify({ app: APP_ID, v: PROTOCOL_VERSION, kind: 'probe' } satisfies Probe));
    const targets = this.opts.targets.length ? this.opts.targets : broadcastTargets();
    for (const addr of targets) {
      this.socket.send(msg, this.opts.port, addr, () => { /* unreachable subnets are normal */ });
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.socket?.close();
    this.socket = null;
  }
}

/** Hub side: answers probes with this hub's beacon. */
export class HubAnnouncer {
  private socket: dgram.Socket | null = null;
  private readonly beacon: () => HubBeacon;
  private readonly port: number;

  constructor(beacon: () => HubBeacon, port: number = DISCOVERY_PORT) {
    this.beacon = beacon;
    this.port = port;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.socket = socket;
      socket.once('error', reject);
      socket.on('message', (msg, rinfo) => {
        const p = parsePacket(msg);
        if (!p || p.kind !== 'probe') return;
        const reply = Buffer.from(JSON.stringify(this.beacon()));
        socket.send(reply, rinfo.port, rinfo.address, () => { /* best effort */ });
      });
      socket.bind(this.port, () => {
        socket.off('error', reject);
        socket.on('error', () => { /* keep serving */ });
        resolve();
      });
    });
  }

  stop(): void {
    this.socket?.close();
    this.socket = null;
  }
}
