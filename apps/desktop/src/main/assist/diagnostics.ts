// "Send diagnostics" in a support session: facts about this PC and its connection that help IT,
// gathered only when the requester asks and shown to them in full before anything is sent. It
// holds the app's version and update channel; the OS, CPU, memory and free disk; the displays;
// whether the hub, the gateway and the TURN servers answer and how fast; the app's own recent log
// lines and recent errors in its window. Never message content, names of files people shared,
// keys, tokens or passwords (TURN credentials included).
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import type { DiagnosticsReport } from '../../shared/bridge.ts';
import type { LogLine } from '../applog.ts';
import { redact } from '../applog.ts';

export interface IceUrl { scheme: 'stun' | 'turn' | 'turns'; host: string; port: number; transport: 'udp' | 'tcp' }

/** stun:host[:port], turn:host[:port][?transport=udp|tcp], turns:host[:port]. Credentials are never part of a URL here. */
export function parseIceUrl(url: string): IceUrl | null {
  const m = url.trim().match(/^(stun|turns?):(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?(?:\?transport=(udp|tcp))?$/i);
  if (!m) return null;
  const scheme = m[1].toLowerCase() as IceUrl['scheme'];
  const port = m[3] ? Number(m[3]) : scheme === 'turns' ? 5349 : 3478;
  if (port < 1 || port > 65535) return null;
  const transport = scheme === 'turns' ? 'tcp' : ((m[4]?.toLowerCase() as 'udp' | 'tcp' | undefined) ?? 'udp');
  return { scheme, host: m[2].replace(/^\[|\]$/g, ''), port, transport };
}

/** A STUN Binding Request (RFC 5389): 20 bytes, with the magic cookie and a random transaction id. */
export function stunRequest(id = crypto.randomBytes(12)): Buffer {
  const b = Buffer.alloc(20);
  b.writeUInt16BE(0x0001, 0);
  b.writeUInt16BE(0, 2);
  b.writeUInt32BE(0x2112a442, 4);
  id.copy(b, 8, 0, 12);
  return b;
}

/** Is this datagram a STUN answer (success or error) to our transaction? */
export function isStunAnswer(msg: Buffer, id: Buffer): boolean {
  if (msg.length < 20) return false;
  const type = msg.readUInt16BE(0);
  return (type === 0x0101 || type === 0x0111) && msg.readUInt32BE(4) === 0x2112a442 && msg.subarray(8, 20).equals(id.subarray(0, 12));
}

const since = (t: number) => Math.round(performance.now() - t);

function udpProbe(host: string, port: number, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4');
    const id = crypto.randomBytes(12);
    const t0 = performance.now();
    const done = (ms: number | null) => { clearTimeout(timer); try { sock.close(); } catch { /* closed */ } resolve(ms); };
    const timer = setTimeout(() => done(null), timeoutMs);
    sock.on('error', () => done(null));
    sock.on('message', (msg) => { if (isStunAnswer(msg, id)) done(since(t0)); });
    sock.send(stunRequest(id), port, host, (err) => { if (err) done(null); });
  });
}

function tcpProbe(host: string, port: number, secure: boolean, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const s = secure ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false }) : net.connect({ host, port });
    const done = (ms: number | null) => { clearTimeout(timer); s.destroy(); resolve(ms); };
    const timer = setTimeout(() => done(null), timeoutMs);
    s.once(secure ? 'secureConnect' : 'connect', () => done(since(t0)));
    s.once('error', () => done(null));
  });
}

/** Does a STUN/TURN server answer from here? (A binding request over UDP, a connection over TCP/TLS.) */
export async function probeIce(url: string, timeoutMs = 2000): Promise<DiagnosticsReport['network']['turn'][number]> {
  const u = parseIceUrl(url);
  // never echo an address that could not be read: it might carry a user name or password
  if (!u) return { url: `${(url.match(/^[a-z]+:/i)?.[0] ?? '')}…`, transport: '?', reachable: false, ms: null, note: 'Not a STUN or TURN address' };
  const ms = u.transport === 'udp' ? await udpProbe(u.host, u.port, timeoutMs) : await tcpProbe(u.host, u.port, u.scheme === 'turns', timeoutMs);
  return { url: `${u.scheme}:${u.host}:${u.port}`, transport: u.scheme === 'turns' ? 'tls' : u.transport, reachable: ms !== null, ms, note: ms === null ? 'No answer' : null };
}

export interface DiagnosticsSources {
  app: DiagnosticsReport['app'];
  displays: DiagnosticsReport['displays'];
  /** The folder whose disk is measured (the app's data folder). */
  dataDir: string;
  /** How the app reaches the hub now. */
  route: DiagnosticsReport['network']['route'];
  hubAddress: string | null;
  gateway: string | null;
  /** One round trip to the hub (rejects when it does not answer). */
  ping: () => Promise<void>;
  /** The STUN/TURN addresses the hub gives for calls. */
  iceUrls: () => Promise<string[]>;
  log: LogLine[];
  rendererErrors: Array<{ at: number; message: string; source?: string }>;
}

async function diskOf(dir: string): Promise<DiagnosticsReport['disk']> {
  try {
    const s = await fs.promises.statfs(dir);
    return { path: process.platform === 'win32' ? dir.slice(0, 3) : '/', totalGb: Math.round((s.blocks * s.bsize) / 1e8) / 10, freeGb: Math.round((s.bavail * s.bsize) / 1e8) / 10 };
  } catch { return { path: '', totalGb: null, freeGb: null }; }
}

export async function collectDiagnostics(src: DiagnosticsSources): Promise<DiagnosticsReport> {
  const latency: number[] = [];
  let reachable = false;
  if (src.route !== 'not connected') {
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      try {
        await Promise.race([src.ping(), new Promise((_r, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
        latency.push(since(t0));
        reachable = true;
      } catch { /* counted as no answer */ }
    }
  }
  const sorted = [...latency].sort((a, b) => a - b);
  let urls: string[] = [];
  try { urls = (await Promise.race([src.iceUrls(), new Promise<string[]>((r) => setTimeout(() => r([]), 3000))])).slice(0, 8); } catch { urls = []; }
  const [turn, disk] = await Promise.all([Promise.all(urls.map((u) => probeIce(u))), diskOf(src.dataDir)]);
  const cpus = os.cpus();
  const mem = process.memoryUsage();
  return {
    kind: 'dexconnect-diagnostics',
    version: 1,
    createdAt: new Date().toISOString(),
    app: src.app,
    os: { name: os.type(), release: os.release(), version: typeof os.version === 'function' ? os.version() : '', arch: os.arch(), uptimeHours: Math.round(os.uptime() / 360) / 10 },
    cpu: { model: cpus[0]?.model.trim() ?? 'unknown', cores: cpus.length, speedMHz: cpus[0]?.speed ?? 0, load1m: process.platform === 'win32' ? null : Math.round(os.loadavg()[0] * 100) / 100 },
    memory: { totalMb: Math.round(os.totalmem() / 1048576), freeMb: Math.round(os.freemem() / 1048576), appMb: Math.round(mem.rss / 1048576) },
    disk,
    displays: src.displays,
    network: {
      route: src.route,
      hub: { address: src.hubAddress, reachable, latencyMs: latency, medianMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null },
      gateway: src.gateway,
      turn,
    },
    log: src.log.map((l) => ({ ...l, msg: redact(l.msg) })),
    rendererErrors: src.rendererErrors.slice(-50).map((e) => ({ at: e.at, message: redact(String(e.message)).slice(0, 400), ...(e.source ? { source: redact(e.source).slice(0, 200) } : {}) })),
  };
}
