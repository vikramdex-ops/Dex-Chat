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
import { Messaging, MsgError } from './messaging.ts';
import { Desk } from './desk.ts';
import { Org, OrgError } from './org.ts';
import { Work, WorkError } from './work.ts';
import { Calendar, CalError } from './calendar.ts';
import { Guests, GuestError } from './guests.ts';
import { Compliance, ComplianceError } from './compliance.ts';
import { Policies, PolicyError } from './policies.ts';
import { Emoji, EmojiError } from './emoji.ts';
import { Commands, CommandError } from './commands.ts';
import { Workspace, WorkspaceError } from './workspace.ts';
import { encKeyStatement } from '@dex/core/e2e';
import { FileStore } from './files.ts';
import { Rooms, RoomError } from './rooms.ts';
import type { MirrorOptions } from './update-mirror.ts';
import { loadOrCreateCertificate } from './tls.ts';

export const HUB_VERSION = '0.1.0';

export interface HubOptions {
  dataDir: string;
  name?: string;
  port?: number;
  host?: string;
  /** Largest file accepted (default 1 GB). */
  maxFileBytes?: number;
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
  fileToken: string | null;
  idle: boolean;
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
  readonly messaging: Messaging;
  readonly files: FileStore;
  readonly rooms: Rooms;
  readonly desk: Desk;
  readonly org: Org;
  readonly work: Work;
  readonly calendar: Calendar;
  readonly guests: Guests;
  readonly compliance: Compliance;
  readonly policies: Policies;
  readonly emoji: Emoji;
  readonly commands: Commands;
  readonly workspace: Workspace;
  private lastPurge = 0;
  private deskTimer: NodeJS.Timeout | null = null;
  /** file token -> user, one per signed-in connection */
  private readonly fileTokens = new Map<string, string>();
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
    this.files = new FileStore(this.store.db, path.join(opts.dataDir, 'files'), opts.maxFileBytes);
    this.messaging = new Messaging(this.store.db, (userIds, name, data) => this.deliver(userIds, name, data), () => this.store.activeUsers(), this.files);
    this.work = new Work(this.store.db, () => this.store.activeUsers(), (uid) => {
      // a connected device counts as seen now
      if ([...this.conns].some((c) => c.ready && c.userId === uid)) return Date.now();
      const r = this.store.db.prepare('SELECT MAX(last_seen) AS t FROM devices WHERE user_id = ?').get(uid) as { t: number | null };
      return r.t;
    }, (state) => this.emit('work.updated', state));
    this.calendar = new Calendar(this.store.db, this.messaging, () => this.store.activeUsers(), (userIds, name, data) => this.deliver(userIds, name, data), (name, data) => this.emit(name, data));
    this.guests = new Guests(this.store, this.messaging, (uid) => {
      for (const c of this.conns) {
        if (c.userId !== uid) continue;
        this.send(c, { t: 'rejected', reason: 'Your guest access has ended.' });
        c.ws.close();
      }
    });
    this.compliance = new Compliance(this.store, this.messaging, this.files);
    this.policies = new Policies(this.store, this.files, (p) => this.emit('policy.updated', p));
    this.messaging.editWindowMs = () => this.policies.editWindowMs();
    this.emoji = new Emoji(this.store, this.files, (list) => this.emit('emoji.updated', list));
    this.files.isPublic = (id) => this.emoji.isEmojiFile(id);
    this.messaging.customEmoji = (name) => this.emoji.exists(name);
    this.commands = new Commands(this.store, this.messaging);
    this.workspace = new Workspace(this.store.db, this.messaging, (userIds, name, data) => this.deliver(userIds, name, data));
    this.org = new Org(this.store, (u) => this.emit('user.updated', u), (info) => this.emit('org.updated', info));
    this.desk = new Desk(this.store.db, this.messaging, this.files, (userIds, name, data) => this.deliver(userIds, name, data), (uid) => {
      const u = this.store.userById(uid);
      return u && this.store.activeUsers().some((a) => a.id === u.id) ? u : null;
    });
    this.rooms = new Rooms({
      members: (convId) => this.messaging.members(convId),
      deliverToUsers: (userIds, name, data) => this.deliver(userIds, name, () => data),
      deliverToDevice: (deviceId, name, data) => { for (const c of this.conns) if (c.ready && c.deviceId === deviceId) this.send(c, { t: 'evt', name, data }); },
      broadcast: (name, data) => this.emit(name, data),
      allowRecording: () => this.policies.get().allowRecording,
      ended: (room, missed, durationMs) => this.policies.logCall(room.id, room.convId, room.startedBy, room.video, missed, durationMs),
    });
    // databases from before messaging existed: create the Office space and add everyone
    const owner = this.store.activeUsers().find((u) => u.role === 'owner');
    if (owner) {
      this.messaging.ensureEveryoneSpace(owner.id);
      for (const u of this.store.activeUsers()) this.messaging.welcome(u.id);
    }
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
    // reminders and scheduled messages (also catches up on anything due while the hub was off)
    const tick = () => {
      try { this.desk.tick(); } catch (err) { this.log('error', 'desk timer failed', { error: (err as Error).message }); }
      try { this.work.tick(); } catch (err) { this.log('error', 'attendance timer failed', { error: (err as Error).message }); }
      // retention runs hourly (and on start)
      if (Date.now() - this.lastPurge > 3600_000) {
        this.lastPurge = Date.now();
        try { this.compliance.purge(); } catch (err) { this.log('error', 'retention failed', { error: (err as Error).message }); }
      }
      try { this.presenceTick(); } catch (err) { this.log('error', 'presence timer failed', { error: (err as Error).message }); }
      try { this.messaging.tick(); } catch (err) { this.log('error', 'mute timer failed', { error: (err as Error).message }); }
      try { this.guests.tick(); } catch (err) { this.log('error', 'guest timer failed', { error: (err as Error).message }); }
      try { this.calendar.tick(); } catch (err) { this.log('error', 'calendar timer failed', { error: (err as Error).message }); }
    };
    tick();
    this.deskTimer = setInterval(tick, 10_000);
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
    if (this.deskTimer) clearInterval(this.deskTimer);
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
    if ((req.url ?? '').startsWith('/files')) { void this.fileRoute(req, res); return; }
    if ((req.url ?? '').startsWith('/api/bot/')) { void this.botRoute(req, res); return; }
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

  /**
   * Bot API for office tools (Hopper, Sheets, Sleuth…):
   *   POST /api/bot/message   Authorization: Bearer <token>
   *   { "text": "…", "to": ["DEXTERITY\\\\priya.raman" | "priya.raman"], "space": "Piping P-12",
   *     "card": { "title": "…", "lines": ["…"], "url": "https://…" } }
   * Delivers a Direct message from the bot to each person in "to", and/or posts into the Space.
   */
  private async botRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7).trim() : '';
    const bot = token ? this.store.botByTokenHash(crypto.createHash('sha256').update(token).digest('hex')) : null;
    if (!bot || bot.role !== 'bot') { req.resume(); reply(401, { ok: false, error: 'Unknown or revoked integration token.' }); return; }
    if (req.method !== 'POST' || req.url?.split('?')[0] !== '/api/bot/message') { req.resume(); reply(404, { ok: false, error: 'not found' }); return; }
    let raw = '';
    try {
      for await (const c of req) { raw += c; if (raw.length > 64 * 1024) throw new Error('too large'); }
    } catch { reply(413, { ok: false, error: 'Message too large.' }); return; }
    let body: { text?: unknown; to?: unknown; space?: unknown; card?: { title?: unknown; lines?: unknown; url?: unknown } };
    try { body = JSON.parse(raw); } catch { reply(400, { ok: false, error: 'Invalid JSON.' }); return; }

    const text = typeof body.text === 'string' ? body.text.trim().slice(0, 4000) : '';
    const card = body.card && typeof body.card === 'object' ? body.card : null;
    const cardLines: string[] = [];
    if (card) {
      if (typeof card.title === 'string' && card.title.trim()) cardLines.push(`**${card.title.trim().slice(0, 200)}**`);
      if (Array.isArray(card.lines)) for (const l of card.lines.slice(0, 12)) if (typeof l === 'string' && l.trim()) cardLines.push(`- ${l.trim().slice(0, 300)}`);
      if (typeof card.url === 'string' && /^https?:\/\/\S+$/.test(card.url)) cardLines.push(card.url);
    }
    const message = [text, cardLines.join('\n')].filter(Boolean).join('\n\n');
    if (!message) { reply(400, { ok: false, error: 'Nothing to send: give "text" or a "card".' }); return; }

    const delivered: string[] = [];
    const unknown: string[] = [];
    const clientId = () => `bot-${crypto.randomBytes(8).toString('hex')}`;
    const recipients = Array.isArray(body.to) ? body.to.filter((x): x is string => typeof x === 'string').slice(0, 50) : [];
    for (const who of recipients) {
      const person = this.store.userForAccount(who);
      if (!person || person.role === 'bot') { unknown.push(who); continue; }
      const conv = this.messaging.handle('conv.create', bot, { kind: 'direct', members: [person.id] }) as { id: string };
      this.messaging.handle('msg.send', bot, { convId: conv.id, body: message, clientId: clientId() });
      delivered.push(person.account);
    }
    if (typeof body.space === 'string' && body.space.trim()) {
      const space = this.messaging.spaceByName(body.space.trim());
      if (!space) unknown.push(`space:${body.space}`);
      else {
        this.messaging.ensureMember(space, bot.id);
        this.messaging.handle('msg.send', bot, { convId: space, body: message, clientId: clientId() });
        delivered.push(`space:${body.space.trim()}`);
      }
    }
    this.log('info', 'bot message', { bot: bot.displayName, delivered: delivered.length, unknown: unknown.length });
    reply(delivered.length ? 200 : 404, { ok: delivered.length > 0, delivered, unknown });
  }

  /** POST /files?name=…&type=…  and  GET /files/<id>[?download=1], authorised by a session file token. */
  private async fileRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'https://hub');
    const sendJson = (code: number, body: unknown) => {
      if (res.headersSent) { res.end(); return; }
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const auth = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : url.searchParams.get('t');
    const userId = auth ? this.fileTokens.get(auth) : undefined;
    const user = userId ? this.store.userById(userId) : null;
    if (!user) { req.resume(); sendJson(401, { error: 'Sign in again to use files.' }); return; }

    if (req.method === 'POST' && url.pathname === '/files') {
      if (user.role === 'guest') { req.resume(); sendJson(403, { error: 'Guests cannot upload files.' }); return; }
      try {
        const info = await this.files.receive(req, user.id, url.searchParams.get('name') ?? 'file', url.searchParams.get('type') ?? undefined);
        this.log('info', 'file uploaded', { user: user.account, size: info.size });
        sendJson(200, info);
      } catch (err) {
        const e = err as Error & { status?: number };
        req.resume();
        sendJson(e.status ?? 500, { error: e.status ? e.message : 'Upload failed.' });
      }
      return;
    }
    const m = url.pathname.match(/^\/files\/([0-9A-Z]{26})$/);
    if ((req.method === 'GET' || req.method === 'HEAD') && m) {
      if (!this.files.canRead(user.id, m[1])) { sendJson(404, { error: 'not found' }); return; }
      this.files.serve(req, res, m[1], url.searchParams.get('download') === '1');
      return;
    }
    sendJson(404, { error: 'not found' });
  }

  // ---------------------------------------------------------- websocket
  private accept(ws: WebSocket, req: IncomingMessage): void {
    const conn: Conn = {
      ws, nonce: crypto.randomBytes(24).toString('base64url'), ip: req.socket.remoteAddress ?? '',
      alive: true, deviceId: null, userId: null, ready: false, fileToken: null, idle: false,
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

  /** Send an event to every connected device of the given people. */
  private deliver(userIds: string[], name: string, data: (userId: string) => unknown): void {
    const wanted = new Set(userIds);
    const cache = new Map<string, unknown>();
    for (const c of this.conns) {
      if (!c.ready || !c.userId || !wanted.has(c.userId)) continue;
      if (!cache.has(c.userId)) cache.set(c.userId, data(c.userId));
      this.send(c, { t: 'evt', name, data: cache.get(c.userId) });
    }
  }

  /** People others can see online (invisible people are left out). */
  private onlineUserIds(viewer?: string): string[] {
    const ids = new Set([...this.conns].filter((c) => c.ready && c.userId).map((c) => c.userId!));
    for (const id of ids) {
      if (id !== viewer && this.store.userById(id)?.availability === 'invisible') ids.delete(id);
    }
    return [...ids];
  }

  /** Away = every connected device of the person is idle. */
  private isAway(userId: string): boolean {
    let any = false;
    for (const c of this.conns) {
      if (!c.ready || c.userId !== userId) continue;
      any = true;
      if (!c.idle) return false;
    }
    return any;
  }

  private announcePresence(userId: string, except?: Conn): void {
    const online = this.isOnline(userId, except) && this.store.userById(userId)?.availability !== 'invisible';
    this.emit('presence', { userId, online, away: online && this.isAway(userId) }, (c) => c !== except && c.userId !== userId);
  }

  private isOnline(userId: string, except?: Conn): boolean {
    for (const c of this.conns) if (c !== except && c.ready && c.userId === userId) return true;
    return false;
  }

  private onClose(conn: Conn): void {
    this.conns.delete(conn);
    if (conn.deviceId && conn.ready) this.rooms.leaveAll(conn.deviceId);
    // keep the token briefly so a download that is already running can finish
    if (conn.fileToken) { const t = conn.fileToken; setTimeout(() => this.fileTokens.delete(t), 10 * 60 * 1000).unref(); }
    if (conn.ready && conn.userId) this.announcePresence(conn.userId);
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
    // a guest invite approves a new person straight away, as a guest
    let invite: ReturnType<Guests['check']> | null = null;
    if (!first && typeof frame.invite === 'string' && frame.invite.trim() && (!user || user.role === 'guest')) {
      invite = this.guests.check(frame.invite.slice(0, 40));
      if ('error' in invite) {
        this.send(conn, { t: 'rejected', reason: invite.error });
        conn.ws.close();
        return;
      }
    }
    if (!user) user = this.store.createUser(key, account.displayName, first ? 'owner' : invite ? 'guest' : 'member');
    const device = this.store.createDevice(frame.deviceId, user.id, frame.publicKey, account.hostname, first || invite ? 'approved' : 'pending');
    if (invite && 'invite' in invite) {
      this.guests.admit(user.id, invite.invite);
      this.emit('user.added', user);
    }
    if (first) {
      this.messaging.ensureEveryoneSpace(user.id);
      this.messaging.welcome(user.id);
    }
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
    conn.fileToken = crypto.randomBytes(24).toString('base64url');
    this.fileTokens.set(conn.fileToken, device.userId);
    this.store.touchDevice(device.id);
    this.send(conn, { t: 'ready', session: this.sessionFor(conn) });
    if (!wasOnline || this.isAway(device.userId) === false) this.announcePresence(device.userId, undefined);
  }

  private sessionFor(conn: Conn): Session {
    return {
      hub: this.info,
      me: this.store.userById(conn.userId!)!,
      deviceId: conn.deviceId!,
      users: this.guests.visibleTo(this.store.userById(conn.userId!)!, this.store.activeUsers()),
      online: this.onlineUserIds(conn.userId!),
      away: [...new Set(this.onlineUserIds(conn.userId!).filter((id) => this.isAway(id)))],
      inRoom: this.rooms.inRoomUsers(),
      fileToken: conn.fileToken!,
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

  /** Timed availability returns to Available; out of office ends on its date. */
  private presenceTick(now = Date.now()): void {
    const rows = this.store.db.prepare('SELECT id, availability, availability_until, ooo FROM users WHERE (availability_until IS NOT NULL AND availability_until <= ?) OR ooo IS NOT NULL').all(now) as Array<{ id: string; availability: string; availability_until: number | null; ooo: string | null }>;
    for (const r of rows) {
      let changed = false;
      if (r.availability_until !== null && r.availability_until <= now) {
        this.store.updateUser(r.id, { availability: 'available' });
        this.store.setPresenceExtras(r.id, { availabilityUntil: null });
        changed = true;
        if (r.availability === 'invisible') this.announcePresence(r.id);
      }
      const u = this.store.userById(r.id);
      if (u?.ooo && u.ooo.until <= now) { this.store.setPresenceExtras(r.id, { ooo: null }); changed = true; }
      if (changed) { const fresh = this.store.userById(r.id); if (fresh) this.emit('user.updated', fresh); }
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
        return { users: this.guests.visibleTo(this.store.userById(conn.userId!)!, this.store.activeUsers()), online: this.onlineUserIds(conn.userId!) } satisfies Ops['directory.list']['res'];

      case 'me.update': {
        const patch: { displayName?: string; title?: string | null; statusText?: string | null } = {};
        if (d.displayName !== undefined) {
          const n = clean(d.displayName, 80);
          if (!n) throw new OpError('Name cannot be empty.');
          patch.displayName = n;
        }
        if (d.title !== undefined) patch.title = d.title === null ? null : clean(d.title, 80) || null;
        if (d.statusText !== undefined) patch.statusText = d.statusText === null ? null : clean(d.statusText, 120) || null;
        const before = this.store.userById(conn.userId!)!;
        if (d.availability !== undefined) {
          if (!['available', 'busy', 'dnd', 'invisible'].includes(String(d.availability))) throw new OpError('Unknown availability.');
          (patch as { availability?: string }).availability = String(d.availability);
        }
        this.store.updateUser(conn.userId!, patch as never);
        if (d.availability !== undefined) {
          const until = typeof d.until === 'number' && d.until > Date.now() && d.availability !== 'available' ? Math.floor(d.until) : null;
          this.store.setPresenceExtras(conn.userId!, { availabilityUntil: until });
        }
        if (d.ooo !== undefined) {
          const o = d.ooo as { until?: unknown; message?: unknown; delegateId?: unknown } | null;
          if (o === null) this.store.setPresenceExtras(conn.userId!, { ooo: null });
          else {
            if (typeof o.until !== 'number' || o.until <= Date.now()) throw new OpError('Choose when you are back.');
            const delegate = typeof o.delegateId === 'string' && o.delegateId !== conn.userId && this.store.userById(o.delegateId) ? o.delegateId : null;
            this.store.setPresenceExtras(conn.userId!, { ooo: { until: Math.floor(o.until), message: clean(o.message, 300) || null, delegateId: delegate } });
          }
        }
        const user = this.store.userById(conn.userId!)!;
        this.emit('user.updated', user);
        if (before.availability !== user.availability && (before.availability === 'invisible' || user.availability === 'invisible')) this.announcePresence(user.id);
        return user;
      }

      case 'me.idle': {
        const was = this.isAway(conn.userId!);
        conn.idle = d.idle === true;
        if (was !== this.isAway(conn.userId!)) this.announcePresence(conn.userId!);
        return { ok: true } satisfies Ops['me.idle']['res'];
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
          this.messaging.welcome(device.userId);
          // people who were imported as reporting to this person now resolve to them
          if (user) this.org.announceReportsOf(user.account);
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

      case 'admin.bots':
        this.requireAdmin(conn);
        return this.store.bots();

      case 'e2e.publish': {
        const encKey = typeof d.encKey === 'string' ? d.encKey : '';
        const sig = typeof d.sig === 'string' ? d.sig : '';
        const dev = this.store.device(conn.deviceId!);
        if (!dev || !/^[A-Za-z0-9+/]{43}=$/.test(encKey) || !verifySignature(dev.publicKey, encKeyStatement(dev.id, encKey), sig)) throw new OpError('That encryption key is not valid.');
        const cur = this.store.db.prepare('SELECT enc_key FROM devices WHERE id = ?').get(dev.id) as { enc_key: string | null };
        if (cur.enc_key !== encKey) {
          this.store.db.prepare('UPDATE devices SET enc_key = ?, enc_sig = ? WHERE id = ?').run(encKey, sig, dev.id);
          this.emit('e2e.keysChanged', { userId: dev.userId, deviceId: dev.id });
        }
        return { ok: true } satisfies Ops['e2e.publish']['res'];
      }

      case 'e2e.keys': {
        const ids = Array.isArray(d.userIds) ? d.userIds.filter((x): x is string => typeof x === 'string').slice(0, 200) : [];
        if (!ids.length) return [];
        const rows = this.store.db.prepare(`SELECT id, user_id, public_key, enc_key, enc_sig FROM devices WHERE status = 'approved' AND enc_key IS NOT NULL AND user_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Array<{ id: string; user_id: string; public_key: string; enc_key: string; enc_sig: string }>;
        return rows.map((r) => ({ userId: r.user_id, deviceId: r.id, signKey: r.public_key, encKey: r.enc_key, sig: r.enc_sig })) satisfies Ops['e2e.keys']['res'];
      }

      case 'e2e.addKeys': {
        const me = this.store.userById(conn.userId!)!;
        const owner = (deviceId: string) => this.store.device(deviceId)?.userId ?? null;
        return { updated: this.messaging.addKeys(me, d.items, owner) } satisfies Ops['e2e.addKeys']['res'];
      }

      case 'admin.bots.create': {
        const me = this.requireAdmin(conn);
        const name = clean(d.name, 40);
        if (!name) throw new OpError('Give the integration a name.');
        const key = `bot\\${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
        const bot = this.store.userByAccount(key) ?? this.store.createUser(key, name, 'bot');
        if (bot.role !== 'bot') throw new OpError('That name is taken.');
        const token = `dxc_${crypto.randomBytes(24).toString('base64url')}`;
        this.store.createBotToken(bot.id, crypto.createHash('sha256').update(token).digest('hex'), me.id);
        this.store.audit(me.id, 'bot.created', bot.id, { name });
        this.emit('user.added', bot);
        return { bot, token } satisfies Ops['admin.bots.create']['res'];
      }

      case 'admin.bots.revoke': {
        const me = this.requireAdmin(conn);
        const bot = typeof d.userId === 'string' ? this.store.userById(d.userId) : null;
        if (!bot || bot.role !== 'bot') throw new OpError('Integration not found.');
        this.store.revokeBotTokens(bot.id);
        this.store.audit(me.id, 'bot.revoked', bot.id, { name: bot.displayName });
        return { ok: true } satisfies Ops['admin.bots.revoke']['res'];
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

      default: {
        if (typeof op === 'string' && op.startsWith('room.')) {
          const me = this.store.userById(conn.userId!)!;
          try {
            const result = this.rooms.handle(op, me, conn.deviceId!, d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof RoomError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && /^(note\.|board\.)/.test(op)) {
          const me = this.store.userById(conn.userId!)!;
          try {
            const result = this.workspace.handle(op, me, d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof WorkspaceError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && /^(cmd\.|admin\.bots\.commands$)/.test(op)) {
          const me = this.store.userById(conn.userId!)!;
          try {
            const result = await this.commands.handle(op, me, d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof CommandError || err instanceof MsgError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && op.startsWith('admin.compliance.')) {
          const me = this.store.userById(conn.userId!)!;
          try {
            const result = this.compliance.handle(op, me, d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof ComplianceError) throw new OpError(err.message);
            if ((err as { status?: number }).status) throw new OpError((err as Error).message);
            throw err;
          }
        }
        if (typeof op === 'string' && op.startsWith('admin.guests.')) {
          const me = this.store.userById(conn.userId!)!;
          try {
            const result = this.guests.handle(op, me, d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof GuestError || err instanceof MsgError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && /^(cal\.|admin\.cal\.)/.test(op)) {
          const me = this.store.userById(conn.userId!)!;
          try {
            const result = this.calendar.handle(op, me, d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof CalError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && op.startsWith('work.')) {
          const me = this.store.userById(conn.userId!)!;
          try {
            const result = this.work.handle(op, me, d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof WorkError) throw new OpError(err.message);
            throw err;
          }
        }
        if (op === 'file.setText') {
          try {
            this.files.setText(conn.userId!, String(d.fileId ?? ''), typeof d.text === 'string' ? d.text : '');
            return { ok: true };
          } catch (err) {
            throw new OpError((err as Error).message);
          }
        }
        if (typeof op === 'string' && /^(emoji\.list|admin\.emoji\.(add|remove))$/.test(op)) {
          const me = this.store.userById(conn.userId!)!;
          try {
            const result = this.emoji.handle(op, me, d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof EmojiError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && /^(policy\.get|admin\.policy\.set|admin\.usage)$/.test(op)) {
          const me = this.store.userById(conn.userId!)!;
          try {
            const result = this.policies.handle(op, me, d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof PolicyError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && /^(org\.|admin\.org\.|me\.profile$)/.test(op)) {
          const me = this.store.userById(conn.userId!)!;
          try {
            const result = this.org.handle(op, me, d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof OrgError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && /^(desk\.|remind\.|sched\.|msg\.star$)/.test(op)) {
          const me = this.store.userById(conn.userId!)!;
          try {
            const result = this.desk.handle(op, me, d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof MsgError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && /^(conv\.|msg\.|file\.|poll\.|form\.|typing$|search$)/.test(op)) {
          const me = this.store.userById(conn.userId!)!;
          try {
            const result = this.messaging.handle(op, me, d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof MsgError) throw new OpError(err.message);
            throw err;
          }
        }
        throw new OpError(`Unknown operation: ${String(op)}`);
      }
    }
  }
}

