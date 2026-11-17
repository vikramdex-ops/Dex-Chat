// Portable hub session: sign-in, certificate pinning, reconnect with backoff, request/response
// and a live copy of the session. The transport (WebSocket over pinned TLS) and the signer are
// injected, so the same logic runs in the desktop app (Node) and on Android (native socket).
import { Emitter } from './emitter.ts';
import { authPayload } from './protocol.ts';
import type { ClientFrame, Events, OpName, Ops, PublicUser, ServerFrame, Session, WindowsAccount } from './protocol.ts';

export interface HubTarget {
  host: string;
  port: number;
  hubId?: string;
  name?: string;
  /** Expected certificate fingerprint. When absent the first certificate seen is trusted and reported via 'pinned'. */
  fp?: string;
  /** The internet gateway for this hub, used when the office network cannot be reached. */
  remote?: { url: string; hubId: string };
}

export type ClientState =
  | { kind: 'idle' }
  | { kind: 'connecting'; target: HubTarget }
  | { kind: 'pending'; target: HubTarget; position: number }
  | { kind: 'ready'; target: HubTarget; session: Session; via?: 'lan' | 'remote' }
  | { kind: 'rejected'; target: HubTarget; reason: string }
  | { kind: 'offline'; target: HubTarget; retryInMs: number; error: string }
  | { kind: 'identity-mismatch'; target: HubTarget; expected: string; actual: string };

export interface SocketHandlers {
  /** TLS is up; `fingerprint` is the SHA-256 of the certificate the server presented. */
  onOpen(fingerprint: string): void;
  onMessage(data: string): void;
  onClose(reason: string): void;
}

export interface HubSocket {
  send(data: string): void;
  close(): void;
  /** Present on the internet gateway's socket: HTTP (files) inside the encrypted channel. */
  http?(req: import('./remote.ts').TunnelRequest): Promise<import('./remote.ts').TunnelResponse>;
}

export type OpenSocket = (target: HubTarget, handlers: SocketHandlers) => HubSocket;
export type Signer = (payload: Uint8Array) => string | Promise<string>;

export interface SessionOptions {
  deviceId: string;
  publicKey: string;
  sign: Signer;
  account: WindowsAccount;
  open: OpenSocket;
  /** Opens the hub through the internet gateway (target.remote), when the office network fails. */
  openRemote?: OpenSocket;
  requestTimeoutMs?: number;
  maxBackoffMs?: number;
  /** Guest invite code sent with the first registration. */
  invite?: string;
  /** Pairing token sent with the first registration. */
  pair?: string;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class HubSession extends Emitter {
  state: ClientState = { kind: 'idle' };
  private sock: HubSocket | null = null;
  private target: HubTarget | null = null;
  private fingerprint = '';
  private nonce = '';
  private seq = 0;
  private attempts = 0;
  private generation = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Which way the current connection goes, and how often the office network failed in a row. */
  private via: 'lan' | 'remote' = 'lan';
  private lanFails = 0;
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly opts: Required<Omit<SessionOptions, 'openRemote'>> & { openRemote?: OpenSocket };

  constructor(opts: SessionOptions) {
    super();
    this.opts = { ...opts, requestTimeoutMs: opts.requestTimeoutMs ?? 15000, maxBackoffMs: opts.maxBackoffMs ?? 15000, invite: opts.invite ?? '', pair: opts.pair ?? '' };
  }

  get session(): Session | null {
    return this.state.kind === 'ready' ? this.state.session : null;
  }

  setAccount(account: WindowsAccount): void {
    this.opts.account = account;
  }

  setInvite(code: string): void {
    this.opts.invite = code;
  }

  setPair(token: string): void {
    this.opts.pair = token;
  }

  connect(target: HubTarget): void {
    this.disconnect();
    this.target = { ...target };
    this.attempts = 0;
    this.lanFails = 0;
    this.open();
  }

  /** Is the current connection through the internet gateway? */
  get viaGateway(): boolean { return this.via === 'remote' && this.state.kind === 'ready'; }

  /** HTTP to the hub through the gateway's encrypted channel (files from outside the office). */
  http(req: import('./remote.ts').TunnelRequest): Promise<import('./remote.ts').TunnelResponse> {
    if (!this.sock?.http) return Promise.reject(new Error('not connected through the gateway'));
    return this.sock.http(req);
  }

  disconnect(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stopProbe();
    this.generation++;
    const sock = this.sock;
    this.sock = null;
    this.target = null;
    sock?.close();
    this.failPending('disconnected');
    this.setState({ kind: 'idle' });
  }

  request<K extends OpName>(op: K, data?: Ops[K]['req']): Promise<Ops[K]['res']> {
    if (!this.sock || this.state.kind !== 'ready') return Promise.reject(new Error('not connected to the hub'));
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
    try { this.sock?.send(JSON.stringify(frame)); } catch { /* close handler follows */ }
  }

  private open(): void {
    const target = this.target;
    if (!target) return;
    const gen = ++this.generation;
    const live = () => gen === this.generation;
    this.setState({ kind: 'connecting', target });
    const remote = !!(target.remote && this.opts.openRemote && (this.lanFails > 0 || !target.host));
    this.via = remote ? 'remote' : 'lan';
    let opened = false;
    this.sock = (remote ? this.opts.openRemote! : this.opts.open)(target, {
      onOpen: (fp) => {
        if (!live()) return;
        opened = true;
        this.fingerprint = fp;
        if (target.fp && target.fp !== fp) {
          this.setState({ kind: 'identity-mismatch', target, expected: target.fp, actual: fp });
          this.target = null; // never auto-retry a hub that changed identity
          this.generation++;
          this.sock?.close();
          this.sock = null;
          return;
        }
        if (!target.fp) {
          target.fp = fp;
          this.emit('pinned', { ...target });
        }
      },
      onMessage: (data) => {
        if (!live()) return;
        let frame: ServerFrame;
        try { frame = JSON.parse(data); } catch { return; }
        void this.handle(frame);
      },
      onClose: (reason) => {
        if (!live()) return;
        if (!remote && !opened && target.remote && this.opts.openRemote) {
          // the office network is not reachable: go through the gateway straight away
          this.lanFails++;
          this.generation++;
          this.sock = null;
          this.open();
          return;
        }
        if (remote) this.lanFails = 0; // next time, try the office network first again
        this.onClosed(reason);
      },
    });
  }

  /** While on the gateway, check now and then whether the office network is back, and move to it. */
  private startProbe(): void {
    this.stopProbe();
    this.probeTimer = setInterval(() => {
      const target = this.target;
      if (!target || this.via !== 'remote' || !target.host) return;
      let done = false;
      const probe = this.opts.open(target, {
        onOpen: (fp) => {
          if (done) return;
          done = true;
          probe.close();
          if (fp === target.fp && this.target === target) { this.lanFails = 0; this.connect(target); }
        },
        onMessage: () => {},
        onClose: () => { done = true; },
      });
      setTimeout(() => { if (!done) { done = true; probe.close(); } }, 4000);
    }, 60_000);
  }

  private stopProbe(): void {
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
  }

  private onClosed(reason: string): void {
    this.generation++;
    this.sock = null;
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

  private async proof(): Promise<string> {
    return this.opts.sign(authPayload(this.nonce, this.fingerprint, this.opts.deviceId));
  }

  private async handle(frame: ServerFrame): Promise<void> {
    const target = this.target;
    if (!target) return;
    switch (frame.t) {
      case 'hello': {
        this.nonce = frame.nonce;
        target.hubId ??= frame.hub.id;
        target.name = frame.hub.name;
        // learn (or forget) the internet gateway while on the office network, for use outside it
        const was = JSON.stringify(target.remote ?? null);
        if (frame.hub.remote?.url) target.remote = { url: frame.hub.remote.url, hubId: frame.hub.id };
        else if (frame.hub.remote === null && this.via === 'lan') delete target.remote;
        if (JSON.stringify(target.remote ?? null) !== was) this.emit('pinned', { ...target });
        this.send({ t: 'auth', deviceId: this.opts.deviceId, sig: await this.proof() });
        break;
      }
      case 'unknown':
        this.send({ t: 'register', deviceId: this.opts.deviceId, publicKey: this.opts.publicKey, account: this.opts.account, sig: await this.proof(), ...(this.opts.invite ? { invite: this.opts.invite } : {}), ...(this.opts.pair ? { pair: this.opts.pair } : {}) });
        break;
      case 'pending':
        this.setState({ kind: 'pending', target, position: frame.position });
        break;
      case 'rejected':
        this.setState({ kind: 'rejected', target, reason: frame.reason });
        break;
      case 'ready':
        this.attempts = 0;
        this.setState({ kind: 'ready', target, session: frame.session, via: this.via });
        if (this.via === 'remote') this.startProbe(); else this.stopProbe();
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

  private applyEvent(name: string, data: unknown): void {
    if (this.state.kind !== 'ready') return;
    const session = this.state.session;
    const upsert = (u: PublicUser) => {
      const i = session.users.findIndex((x) => x.id === u.id);
      if (i >= 0) session.users[i] = u; else session.users.push(u);
      if (u.id === session.me.id) session.me = u;
    };
    if (name === 'presence') {
      const { userId, online, away } = data as Events['presence'];
      const set = new Set(session.online);
      if (online) set.add(userId); else set.delete(userId);
      session.online = [...set];
      const idle = new Set(session.away ?? []);
      if (online && away) idle.add(userId); else idle.delete(userId);
      session.away = [...idle];
    } else if (name === 'room.busy') {
      const { userId, inRoom } = data as Events['room.busy'];
      const set = new Set(session.inRoom ?? []);
      if (inRoom) set.add(userId); else set.delete(userId);
      session.inRoom = [...set];
    } else if (name === 'meeting.busy') {
      const { userId, inMeeting } = data as Events['meeting.busy'];
      const set = new Set(session.inMeeting ?? []);
      if (inMeeting) set.add(userId); else set.delete(userId);
      session.inMeeting = [...set];
    } else if (name === 'user.updated' || name === 'user.added') {
      upsert(data as PublicUser);
    } else if (name === 'user.left') {
      // offboarded: no longer among the colleagues you can reach
      const { userId } = data as Events['user.left'];
      session.users = session.users.filter((u) => u.id !== userId);
      session.online = session.online.filter((u) => u !== userId);
      session.away = (session.away ?? []).filter((u) => u !== userId);
    } else {
      return;
    }
    this.emit('session', session);
  }
}
