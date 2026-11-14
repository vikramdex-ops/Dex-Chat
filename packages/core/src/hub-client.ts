// Connection to the office hub: pinned TLS, device sign-in, request/response and live events.
// Reconnects with backoff and keeps an up-to-date copy of the session (people + presence).
import { EventEmitter } from 'node:events';
import type { TLSSocket } from 'node:tls';
import WebSocket from 'ws';
import { authPayload } from './protocol.ts';
import type { ClientFrame, Events, OpName, Ops, PublicUser, ServerFrame, Session, WindowsAccount } from './protocol.ts';
import { signWith } from './identity.ts';
import type { DeviceIdentity } from './identity.ts';

export interface HubTarget {
  host: string;
  port: number;
  hubId?: string;
  name?: string;
  /** Expected certificate fingerprint. When absent the first certificate seen is trusted and reported via 'pinned'. */
  fp?: string;
}

export type ClientState =
  | { kind: 'idle' }
  | { kind: 'connecting'; target: HubTarget }
  | { kind: 'pending'; target: HubTarget; position: number }
  | { kind: 'ready'; target: HubTarget; session: Session }
  | { kind: 'rejected'; target: HubTarget; reason: string }
  | { kind: 'offline'; target: HubTarget; retryInMs: number; error: string }
  | { kind: 'identity-mismatch'; target: HubTarget; expected: string; actual: string };

export interface HubClientOptions {
  identity: DeviceIdentity;
  account: WindowsAccount;
  requestTimeoutMs?: number;
  maxBackoffMs?: number;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class HubClient extends EventEmitter {
  state: ClientState = { kind: 'idle' };
  private ws: WebSocket | null = null;
  private target: HubTarget | null = null;
  private fingerprint = '';
  private seq = 0;
  private attempts = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly opts: Required<HubClientOptions>;

  constructor(opts: HubClientOptions) {
    super();
    this.opts = { requestTimeoutMs: 15000, maxBackoffMs: 15000, ...opts };
  }

  get session(): Session | null {
    return this.state.kind === 'ready' ? this.state.session : null;
  }

  connect(target: HubTarget): void {
    this.disconnect();
    this.target = { ...target };
    this.attempts = 0;
    this.open();
  }

  disconnect(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    this.target = null;
    if (ws) { ws.removeAllListeners(); ws.on('error', () => {}); ws.terminate(); }
    this.failPending('disconnected');
    this.setState({ kind: 'idle' });
  }

  request<K extends OpName>(op: K, data?: Ops[K]['req']): Promise<Ops[K]['res']> {
    const ws = this.ws;
    if (!ws || this.state.kind !== 'ready') return Promise.reject(new Error('not connected to the hub'));
    const id = `r${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${op} timed out`));
      }, this.opts.requestTimeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ t: 'req', id, op, data });
    });
  }

  // ------------------------------------------------------------------ internals
  private setState(state: ClientState): void {
    this.state = state;
    this.emit('state', state);
  }

  private send(frame: ClientFrame): void {
    this.ws?.send(JSON.stringify(frame));
  }

  private open(): void {
    const target = this.target;
    if (!target) return;
    this.setState({ kind: 'connecting', target });
    const ws = new WebSocket(`wss://${target.host}:${target.port}/ws`, {
      rejectUnauthorized: false, // trust is established by pinning the fingerprint below
      handshakeTimeout: 8000,
      maxPayload: 8 * 1024 * 1024,
    });
    this.ws = ws;

    ws.on('upgrade', (res) => {
      const cert = (res.socket as TLSSocket).getPeerX509Certificate?.();
      const actual = cert?.fingerprint256 ?? '';
      this.fingerprint = actual;
      if (target.fp && target.fp !== actual) {
        this.setState({ kind: 'identity-mismatch', target, expected: target.fp, actual });
        this.target = null; // never auto-retry a hub that changed identity
        ws.terminate();
        return;
      }
      if (!target.fp) {
        target.fp = actual;
        this.emit('pinned', { ...target });
      }
    });

    ws.on('message', (raw) => {
      let frame: ServerFrame;
      try { frame = JSON.parse(raw.toString()); } catch { return; }
      this.handle(frame);
    });

    ws.on('close', () => this.onClosed('connection closed'));
    ws.on('error', (err) => this.onClosed(err.message));
  }

  private onClosed(reason: string): void {
    if (!this.ws) return;
    this.ws.removeAllListeners();
    this.ws.on('error', () => {});
    this.ws = null;
    this.failPending(reason);
    const target = this.target;
    if (!target || this.state.kind === 'rejected' || this.state.kind === 'identity-mismatch') return;
    const delay = Math.min(this.opts.maxBackoffMs, 1000 * 2 ** Math.min(this.attempts, 4));
    this.attempts++;
    this.setState({ kind: 'offline', target, retryInMs: delay, error: reason });
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.open(); }, delay);
  }

  private failPending(reason: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private handle(frame: ServerFrame): void {
    const target = this.target;
    if (!target) return;
    const { identity, account } = this.opts;
    switch (frame.t) {
      case 'hello': {
        this.lastNonce = frame.nonce;
        target.hubId ??= frame.hub.id;
        target.name = frame.hub.name;
        const sig = signWith(identity, authPayload(frame.nonce, this.fingerprint, identity.deviceId));
        this.send({ t: 'auth', deviceId: identity.deviceId, sig });
        break;
      }
      case 'unknown': {
        const sig = signWith(identity, authPayload(this.lastNonce, this.fingerprint, identity.deviceId));
        this.send({ t: 'register', deviceId: identity.deviceId, publicKey: identity.publicKey, account, sig });
        break;
      }
      case 'pending':
        this.setState({ kind: 'pending', target, position: frame.position });
        break;
      case 'rejected':
        this.setState({ kind: 'rejected', target, reason: frame.reason });
        break;
      case 'ready':
        this.attempts = 0;
        this.setState({ kind: 'ready', target, session: frame.session });
        break;
      case 'res': {
        const p = this.pending.get(frame.id);
        if (!p) return;
        this.pending.delete(frame.id);
        clearTimeout(p.timer);
        if (frame.ok) p.resolve(frame.data);
        else p.reject(new Error(frame.error));
        break;
      }
      case 'evt':
        this.applyEvent(frame.name, frame.data);
        this.emit('event', frame.name, frame.data);
        break;
      case 'error':
        this.emit('warning', new Error(frame.error));
        break;
    }
  }

  private lastNonce = '';

  private applyEvent(name: string, data: unknown): void {
    if (this.state.kind !== 'ready') return;
    const session = this.state.session;
    const upsert = (u: PublicUser) => {
      const i = session.users.findIndex((x) => x.id === u.id);
      if (i >= 0) session.users[i] = u; else session.users.push(u);
      if (u.id === session.me.id) session.me = u;
    };
    if (name === 'presence') {
      const { userId, online } = data as Events['presence'];
      const set = new Set(session.online);
      if (online) set.add(userId); else set.delete(userId);
      session.online = [...set];
    } else if (name === 'user.updated' || name === 'user.added') {
      upsert(data as PublicUser);
    } else {
      return;
    }
    this.emit('session', session);
  }
}
