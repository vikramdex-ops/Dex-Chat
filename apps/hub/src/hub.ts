// The office hub: pinned-TLS WebSocket API, device sign-in with admin approval, presence,
// people directory and an audit trail. Discovery answers LAN probes so apps find it unaided.
import https from 'node:https';
import crypto from 'node:crypto';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import {
  APP_ID, DEFAULT_HUB_PORT, DISCOVERY_PORT, PROTOCOL_VERSION,
  accountKey, authPayload, deviceIdFor, verifySignature,
} from '@dex/core';
import type { ClientFrame, DeviceRecord, HubInfo, OpName, Ops, PublicUser, Role, ServerFrame, Session, WindowsAccount } from '@dex/core';
import { HubAnnouncer } from '@dex/core/discovery';
import type { HubBeacon } from '@dex/core/discovery';
import { Store } from './store.ts';
import { UpdateMirror } from './update-mirror.ts';
import type { MirrorOptions } from './update-mirror.ts';
import { loadOrCreateCertificate } from './tls.ts';

export const HUB_VERSION = '0.1.0';

export interface HubOptions {
  dataDir: string;
  name?: string;
  port?: number;
  host?: string;
  /** Update mirror settings; `false` turns the mirror off. */
  updates?: Omit<MirrorOptions, 'dir' | 'log'> | false;
  /** UDP port for discovery; `false` disables discovery (tests). */
  discoveryPort?: number | false;
  log?: (level: 'info' | 'warn' | 'error' | 'debug', msg: string, extra?: Record<string, unknown>) => void;
}

interface Conn {
  ws: WebSocket;
  nonce: string;
  ip: string;
  alive: boolean;
  deviceId: string | null;
  userId: string | null;
  ready: boolean;
}

const isAdminRole = (r: Role) => r === 'owner' || r === 'admin';
const clean = (s: unknown, max: number): string => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');

function validAccount(a: unknown): WindowsAccount | null {
  if (!a || typeof a !== 'object') return null;
  const v = a as Record<string, unknown>;
  const account = {
    username: clean(v.username, 64),
    domain: clean(v.domain, 64),
    displayName: clean(v.displayName, 80),
    hostname: clean(v.hostname, 64),
  };
  if (!account.username || !account.domain || !account.hostname) return null;
  if (!account.displayName) account.displayName = account.username;
  return account;
}

class OpError extends Error {}

export class Hub {
  readonly store: Store;
  readonly info: HubInfo;
  readonly fingerprint: string;
  private readonly opts: HubOptions;
  private readonly server: https.Server;
  private readonly wss: WebSocketServer;
  private readonly conns = new Set<Conn>();
  private announcer: HubAnnouncer | null = null;
  readonly mirror: UpdateMirror | null;
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly startedAt = Date.now();
  private readonly log: NonNullable<HubOptions['log']>;

  constructor(opts: HubOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
    this.store = new Store(opts.dataDir);
    const id = this.store.meta('hub_id', () => crypto.randomBytes(8).toString('hex'));
    const name = opts.name ?? this.store.meta('hub_name', () => 'Dexterity Office Hub');
    this.info = { id, name, version: HUB_VERSION, protocol: PROTOCOL_VERSION };
    const tls = loadOrCreateCertificate(opts.dataDir, `Dexterity Connect Hub ${id}`);
    this.fingerprint = tls.fingerprint;

    this.server = https.createServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2' }, (req, res) => this.http(req, res));
    this.mirror = opts.updates === false ? null
      : new UpdateMirror({ ...(opts.updates ?? {}), dir: path.join(opts.dataDir, 'updates'), log: this.log });
    this.wss = new WebSocketServer({ server: this.server, path: '/ws', maxPayload: 1024 * 1024 });
    this.wss.on('connection', (ws, req) => this.accept(ws, req));
  }

  get port(): number {
    return (this.server.address() as AddressInfo | null)?.port ?? 0;
  }

  beacon(): HubBeacon {
    return { app: APP_ID, v: PROTOCOL_VERSION, kind: 'hub', id: this.info.id, name: this.info.name, port: this.port, fp: this.fingerprint, version: HUB_VERSION };
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.opts.port ?? DEFAULT_HUB_PORT, this.opts.host ?? '0.0.0.0', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    if (this.opts.discoveryPort !== false) {
      this.announcer = new HubAnnouncer(() => this.beacon(), this.opts.discoveryPort ?? DISCOVERY_PORT);
      try {
        await this.announcer.start();
      } catch (err) {
        this.log('warn', 'discovery unavailable; apps can still connect by address', { error: (err as Error).message });
        this.announcer = null;
      }
    }
    this.mirror?.start();
    this.heartbeat = setInterval(() => {
      for (const c of this.conns) {
        if (!c.alive) { c.ws.terminate(); continue; }
        c.alive = false;
        try { c.ws.ping(); } catch { /* closing */ }
      }
    }, 20000);
    this.log('info', 'hub listening', { port: this.port, hubId: this.info.id, fingerprint: this.fingerprint });
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.mirror?.stop();
    this.announcer?.stop();
    for (const c of this.conns) c.ws.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.store.close();
  }

  // --------------------------------------------------------------- http
  private http(req: IncomingMessage, res: ServerResponse): void {
    if (this.mirror?.handle(req, res)) return;
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'strict-transport-security': 'max-age=31536000',
    };
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        ok: true, hub: this.info, fingerprint: this.fingerprint,
        users: this.store.activeUsers().length, pendingDevices: this.store.pendingCount(),
        online: this.onlineUserIds().length, uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      }));
      return;
    }
    res.writeHead(404, headers);
    res.end(JSON.stringify({ error: 'not found' }));
  }

  // ---------------------------------------------------------- websocket
  private accept(ws: WebSocket, req: IncomingMessage): void {
    const conn: Conn = {
      ws, nonce: crypto.randomBytes(24).toString('base64url'), ip: req.socket.remoteAddress ?? '',
      alive: true, deviceId: null, userId: null, ready: false,
    };
    this.conns.add(conn);
    ws.on('pong', () => { conn.alive = true; });
    ws.on('message', (raw) => {
      conn.alive = true;
      let frame: ClientFrame;
      try { frame = JSON.parse(raw.toString()); } catch { this.send(conn, { t: 'error', error: 'invalid JSON' }); return; }
      this.onFrame(conn, frame).catch((err) => this.log('error', 'frame failed', { error: (err as Error).message }));
    });
    ws.on('close', () => this.onClose(conn));
    ws.on('error', () => { /* close follows */ });
    this.send(conn, { t: 'hello', hub: this.info, nonce: conn.nonce });
  }

  private send(conn: Conn, frame: ServerFrame): void {
    if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(frame));
  }

  private emit(name: string, data: unknown, filter: (c: Conn) => boolean = () => true): void {
    for (const c of this.conns) if (c.ready && filter(c)) this.send(c, { t: 'evt', name, data });
  }

  private onlineUserIds(): string[] {
    return [...new Set([...this.conns].filter((c) => c.ready && c.userId).map((c) => c.userId!))];
  }

  private isOnline(userId: string, except?: Conn): boolean {
    for (const c of this.conns) if (c !== except && c.ready && c.userId === userId) return true;
    return false;
  }

  private onClose(conn: Conn): void {
    this.conns.delete(conn);
    if (conn.ready && conn.userId && !this.isOnline(conn.userId)) {
      this.emit('presence', { userId: conn.userId, online: false });
    }
  }

  private proofOk(conn: Conn, deviceId: string, publicKey: string, sig: unknown): boolean {
    return typeof sig === 'string' && verifySignature(publicKey, authPayload(conn.nonce, this.fingerprint, deviceId), sig);
  }

  private async onFrame(conn: Conn, frame: ClientFrame): Promise<void> {
    if (frame.t === 'auth') return this.onAuth(conn, frame);
    if (frame.t === 'register') return this.onRegister(conn, frame);
    if (frame.t === 'req') return this.onRequest(conn, frame);
    this.send(conn, { t: 'error', error: 'unknown frame' });
  }

  private onAuth(conn: Conn, frame: Extract<ClientFrame, { t: 'auth' }>): void {
    if (conn.ready) return;
    const device = typeof frame.deviceId === 'string' ? this.store.device(frame.deviceId) : null;
    if (!device) { this.send(conn, { t: 'unknown' }); return; }
    if (!this.proofOk(conn, device.id, device.publicKey, frame.sig)) {
      this.send(conn, { t: 'rejected', reason: 'This device could not prove its identity.' });
      conn.ws.close();
      return;
    }
    conn.deviceId = device.id;
    conn.userId = device.userId;
    this.continueAs(conn, device);
  }

  private onRegister(conn: Conn, frame: Extract<ClientFrame, { t: 'register' }>): void {
    if (conn.ready) return;
    const account = validAccount(frame.account);
    if (!account || typeof frame.publicKey !== 'string' || deviceIdFor(frame.publicKey) !== frame.deviceId) {
      this.send(conn, { t: 'rejected', reason: 'Malformed registration.' });
      conn.ws.close();
      return;
    }
    if (!this.proofOk(conn, frame.deviceId, frame.publicKey, frame.sig)) {
      this.send(conn, { t: 'rejected', reason: 'This device could not prove its identity.' });
      conn.ws.close();
      return;
    }
    const existingDevice = this.store.device(frame.deviceId);
    if (existingDevice) {
      conn.deviceId = existingDevice.id;
      conn.userId = existingDevice.userId;
      this.continueAs(conn, existingDevice);
      return;
    }
    if (this.store.pendingCount() >= 500) {
      this.send(conn, { t: 'rejected', reason: 'Too many devices are waiting for approval. Ask an administrator.' });
      conn.ws.close();
      return;
    }

    const key = accountKey(account);
    const first = this.store.userCount() === 0;
    let user = this.store.userByAccount(key);
    if (!user) user = this.store.createUser(key, account.displayName, first ? 'owner' : 'member');
    const device = this.store.createDevice(frame.deviceId, user.id, frame.publicKey, account.hostname, first ? 'approved' : 'pending');
    this.store.audit(first ? user.id : null, 'device.registered', device.id, { account: key, hostname: account.hostname, ip: conn.ip, autoApproved: first });
    this.log('info', 'device registered', { account: key, hostname: account.hostname, status: device.status });

    conn.deviceId = device.id;
    conn.userId = user.id;
    if (device.status === 'pending') {
      this.emit('admin.pending', device, (c) => this.isAdminConn(c));
    }
    this.continueAs(conn, device);
  }

  private isAdminConn(c: Conn): boolean {
    if (!c.userId) return false;
    const u = this.store.userById(c.userId);
    return !!u && isAdminRole(u.role);
  }

  /** Move a connection into the state its device record dictates. */
  private continueAs(conn: Conn, device: DeviceRecord): void {
    if (device.status === 'pending') {
      this.send(conn, { t: 'pending', position: this.store.pendingPosition(device.id) });
      return;
    }
    if (device.status !== 'approved') {
      this.send(conn, { t: 'rejected', reason: device.status === 'revoked' ? 'This device was removed by an administrator.' : 'An administrator declined this device.' });
      conn.ws.close();
      return;
    }
    const wasOnline = this.isOnline(device.userId, conn);
    conn.ready = true;
    this.store.touchDevice(device.id);
    this.send(conn, { t: 'ready', session: this.sessionFor(conn) });
    if (!wasOnline) this.emit('presence', { userId: device.userId, online: true }, (c) => c !== conn);
  }

  private sessionFor(conn: Conn): Session {
    return {
      hub: this.info,
      me: this.store.userById(conn.userId!)!,
      deviceId: conn.deviceId!,
      users: this.store.activeUsers(),
      online: this.onlineUserIds(),
    };
  }

  // ----------------------------------------------------------- requests
  private async onRequest(conn: Conn, frame: Extract<ClientFrame, { t: 'req' }>): Promise<void> {
    if (!conn.ready || !conn.userId) { this.send(conn, { t: 'error', error: 'not signed in' }); return; }
    const id = typeof frame.id === 'string' ? frame.id.slice(0, 64) : '';
    try {
      const data = await this.op(conn, frame.op as OpName, frame.data);
      this.send(conn, { t: 'res', id, ok: true, data });
    } catch (err) {
      const message = err instanceof OpError ? err.message : 'internal error';
      if (!(err instanceof OpError)) this.log('error', 'request failed', { op: frame.op, error: (err as Error).message });
      this.send(conn, { t: 'res', id, ok: false, error: message });
    }
  }

  private requireAdmin(conn: Conn): PublicUser {
    const me = this.store.userById(conn.userId!);
    if (!me || !isAdminRole(me.role)) throw new OpError('Only administrators can do that.');
    return me;
  }

  private async op(conn: Conn, op: OpName, data: unknown): Promise<unknown> {
    const d = (data ?? {}) as Record<string, unknown>;
    switch (op) {
      case 'ping':
        return { at: Date.now() } satisfies Ops['ping']['res'];

      case 'directory.list':
        return { users: this.store.activeUsers(), online: this.onlineUserIds() } satisfies Ops['directory.list']['res'];

      case 'me.update': {
        const patch: { displayName?: string; title?: string | null; statusText?: string | null } = {};
        if (d.displayName !== undefined) {
          const n = clean(d.displayName, 80);
          if (!n) throw new OpError('Name cannot be empty.');
          patch.displayName = n;
        }
        if (d.title !== undefined) patch.title = d.title === null ? null : clean(d.title, 80) || null;
        if (d.statusText !== undefined) patch.statusText = d.statusText === null ? null : clean(d.statusText, 120) || null;
        const user = this.store.updateUser(conn.userId!, patch);
        this.emit('user.updated', user);
        return user;
      }

      case 'admin.devices':
        this.requireAdmin(conn);
        return this.store.devices();

      case 'admin.decide': {
        const me = this.requireAdmin(conn);
        const device = typeof d.deviceId === 'string' ? this.store.device(d.deviceId) : null;
        if (!device) throw new OpError('Device not found.');
        if (device.status !== 'pending') throw new OpError('That device was already handled.');
        const approve = d.approve === true;
        const wasActive = this.store.activeUsers().some((u) => u.id === device.userId);
        const updated = this.store.setDeviceStatus(device.id, approve ? 'approved' : 'rejected', me.id);
        this.store.audit(me.id, approve ? 'device.approved' : 'device.rejected', device.id, { account: device.account });
        this.emit('device.updated', updated, (c) => this.isAdminConn(c));
        if (approve && !wasActive) {
          const user = this.store.userById(device.userId);
          if (user) this.emit('user.added', user);
        }
        for (const c of this.conns) if (c.deviceId === device.id && !c.ready) this.continueAs(c, updated);
        return updated;
      }

      case 'admin.revoke': {
        const me = this.requireAdmin(conn);
        const device = typeof d.deviceId === 'string' ? this.store.device(d.deviceId) : null;
        if (!device) throw new OpError('Device not found.');
        if (device.id === conn.deviceId) throw new OpError('You cannot remove the device you are using.');
        const updated = this.store.setDeviceStatus(device.id, 'revoked', me.id);
        this.store.audit(me.id, 'device.revoked', device.id, { account: device.account });
        for (const c of [...this.conns]) {
          if (c.deviceId === device.id) {
            this.send(c, { t: 'rejected', reason: 'This device was removed by an administrator.' });
            c.ws.close();
          }
        }
        this.emit('device.updated', updated, (c) => this.isAdminConn(c));
        return updated;
      }

      case 'admin.setRole': {
        const me = this.requireAdmin(conn);
        const target = typeof d.userId === 'string' ? this.store.userById(d.userId) : null;
        if (!target) throw new OpError('Person not found.');
        if (target.id === me.id) throw new OpError('You cannot change your own role.');
        if (target.role === 'owner') throw new OpError('The workspace owner cannot be changed.');
        const role = d.role;
        if (role !== 'admin' && role !== 'member' && role !== 'guest') throw new OpError('Unknown role.');
        if (target.role === 'admin' && me.role !== 'owner') throw new OpError('Only the owner can change an administrator.');
        const user = this.store.updateUser(target.id, { role });
        this.store.audit(me.id, 'user.role', target.id, { from: target.role, to: role });
        this.emit('user.updated', user);
        return user;
      }

      case 'admin.audit': {
        this.requireAdmin(conn);
        const limit = typeof d.limit === 'number' ? Math.max(1, Math.min(1000, d.limit)) : 200;
        return this.store.auditTrail(limit);
      }

      case 'admin.updates': {
        this.requireAdmin(conn);
        if (d.refresh === true && this.mirror) void this.mirror.refresh();
        const st = this.mirror?.status;
        return {
          enabled: !!this.mirror,
          checking: st?.checking ?? false,
          lastCheck: st?.lastCheck ?? null,
          lastError: st?.lastError ?? null,
          channels: st?.channels ?? {},
        } satisfies Ops['admin.updates']['res'];
      }

      default:
        throw new OpError(`Unknown operation: ${String(op)}`);
    }
  }
}

