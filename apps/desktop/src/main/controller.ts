// Owns the hub connection for the desktop app: discovery, first-run join, silent sign-in on
// later launches, following the hub if its IP changes, and the state the UI renders.
import { EventEmitter } from 'node:events';
import type { PeerNet } from './peer.ts';
import { E2EClient } from '@dex/core/e2e-client';
import { signWith } from '@dex/core';
import type { EncKeyPair } from '@dex/core/e2e';
import { DEFAULT_HUB_PORT } from '@dex/core';
import type { DeviceIdentity, Message, OpName, Ops, WindowsAccount } from '@dex/core';
import { HubClient } from '@dex/core/client';
import type { ClientState, HubTarget } from '@dex/core/client';
import { HubFinder } from '@dex/core/discovery';
import { parsePairCode, parseSetupCode } from '@dex/core/remote';
import type { FoundHub } from '@dex/core/discovery';
import type { AppState, DiscoveredHub, JoinRequest, Phase, Settings, UpdateState } from '../shared/bridge.ts';
import { saveConfig } from './persist.ts';
import type { Config } from './persist.ts';

export function parseAddress(input: string): { host: string; port: number } | null {
  const s = input.trim().replace(/^(wss?|https?):\/\//i, '').replace(/\/.*$/, '');
  const m = s.match(/^(\[[0-9a-f:]+\]|[a-z0-9.\-]+)(?::(\d{1,5}))?$/i);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : DEFAULT_HUB_PORT;
  if (port < 1 || port > 65535) return null;
  return { host: m[1].replace(/^\[|\]$/g, ''), port };
}

const toDiscovered = (f: FoundHub): DiscoveredHub => ({
  id: f.beacon.id, name: f.beacon.name, address: f.address, port: f.beacon.port,
  fingerprint: f.beacon.fp, version: f.beacon.version,
});

export class Controller extends EventEmitter {
  /** Guest invite typed on the join screen (used for the first registration only). */
  private invite = '';
  /** Pairing token from a "DXP1-…" code (used for the first registration only). */
  private pair = '';
  private client: HubClient | null = null;
  /** Connected through the internet gateway (outside the office)? */
  get viaGateway(): boolean { return !!this.client?.viaGateway; }
  http(req: import('@dex/core/remote').TunnelRequest): Promise<import('@dex/core/remote').TunnelResponse> {
    if (!this.client) return Promise.reject(new Error('Not connected to the office hub.'));
    return this.client.http(req);
  }
  private readonly finder = new HubFinder();
  private account: WindowsAccount;
  private readonly identity: DeviceIdentity;
  private readonly config: Config;
  private readonly meta: { platform: NodeJS.Platform; version: string; update: () => UpdateState };
  readonly e2e: E2EClient;
  private peers: PeerNet | null = null;
  /** Hub events are opened (decrypted) one at a time so they reach the UI in order. */
  private events: Promise<void> = Promise.resolve();

  constructor(account: WindowsAccount, identity: DeviceIdentity, config: Config, meta: { platform: NodeJS.Platform; version: string; update: () => UpdateState }, encKeys: EncKeyPair) {
    super();
    this.identity = identity;
    this.e2e = new E2EClient({
      deviceId: identity.deviceId, encSecret: encKeys.secret, encPublic: encKeys.public,
      sign: (p) => signWith(identity, p),
      request: (op, data) => { if (!this.client) return Promise.reject(new Error('Not connected to the hub.')); return this.client.request(op as OpName, data as never); },
      log: (msg, extra) => this.emit('warning', Object.assign(new Error(msg), { extra })),
    });
    this.config = config;
    this.meta = meta;
    this.account = { ...account, displayName: config.displayName || account.displayName };
  }

  start(): void {
    this.finder.on('hub', (found: FoundHub) => this.onHubSeen(found));
    this.finder.on('warning', () => { /* no network yet; probes continue */ });
    this.finder.start();
    if (this.config.hub) this.connect(this.config.hub);
    this.push();
  }

  stop(): void {
    this.finder.stop();
    this.client?.disconnect();
  }

  get settings(): Settings { return this.config.settings; }

  state(): AppState {
    const cs: ClientState = this.client?.state ?? { kind: 'idle' };
    const phaseOf: Record<ClientState['kind'], Phase> = {
      idle: this.config.hub ? 'connecting' : 'welcome',
      connecting: 'connecting',
      pending: 'pending',
      ready: 'ready',
      offline: 'offline',
      rejected: 'rejected',
      'identity-mismatch': 'mismatch',
    };
    const hub = this.config.hub;
    return {
      phase: phaseOf[cs.kind],
      account: this.account,
      deviceId: this.identity.deviceId,
      hubs: [...this.finder.hubs.values()].map(toDiscovered),
      hub: hub ? { id: hub.hubId, name: hub.name, host: hub.host, port: hub.port, fingerprint: hub.fp, gateway: hub.remote?.url ?? null } : null,
      via: cs?.kind === 'ready' ? cs.via ?? 'lan' : undefined,
      session: cs.kind === 'ready' ? cs.session : null,
      pendingPosition: cs.kind === 'pending' ? cs.position : 0,
      retryInMs: cs.kind === 'offline' ? cs.retryInMs : 0,
      error: cs.kind === 'rejected' ? cs.reason
        : cs.kind === 'identity-mismatch' ? `The hub presented a different certificate (${cs.actual.slice(0, 23)}…) than the one this PC trusts.`
        : cs.kind === 'offline' ? cs.error : null,
      settings: this.config.settings,
      offices: (this.config.otherHubs ?? []).filter((h) => h.hubId).map((h) => ({ id: h.hubId!, name: h.name ?? h.host })),
      update: this.meta.update(),
      platform: this.meta.platform,
      version: this.meta.version,
      p2p: this.peers ? { active: this.peers.isActive, reachable: this.peers.reachableUsers(), queued: this.peers.pending.length } : undefined,
    };
  }

  /** The connected hub, for downloading updates from its mirror. */
  hubEndpoint(): { host: string; port: number; fp: string } | null {
    const hub = this.config.hub;
    return this.client?.state.kind === 'ready' && hub?.fp ? { host: hub.host, port: hub.port, fp: hub.fp } : null;
  }

  push(): void {
    this.emit('state', this.state());
  }

  private persist(): void {
    try { saveConfig(this.config); } catch (err) { this.emit('warning', err); }
  }

  private connect(target: HubTarget): void {
    this.client?.removeAllListeners();
    this.client?.disconnect();
    const client = new HubClient({ identity: this.identity, account: this.account });
    if (this.invite) client.setInvite(this.invite);
    if (this.pair) client.setPair(this.pair);
    this.client = client;
    client.on('state', (s: ClientState) => {
      if (s.kind === 'ready' || s.kind === 'rejected') this.pair = '';
      if (s.kind === 'ready') {
        const session = s.session;
        void this.e2e.ready(session.me.id, session.users.filter((u) => u.role === 'bot').map((u) => u.id))
          .then(async () => {
            this.peers?.setActive(false);
            await client.request('policy.get').then((p) => this.setPeerPolicy(p.peerFallback)).catch(() => {});
            // anything written while the hub was off goes to the hub now
            await this.peers?.flush((item) => client.request('msg.send', { convId: item.convId, body: item.body, clientId: item.clientId, parentId: item.parentId ?? undefined }).then(() => undefined));
            // keep keys and conversations for the next time the hub is off
            await this.e2e.cacheKeys(session.users.filter((u) => u.role !== 'bot').map((u) => u.id));
            this.peers?.saveDirectory();
            this.push();
          })
          .catch((err) => this.emit('warning', err));
        this.emit('hub-ready');
        if (this.idle) void client.request('me.idle', { idle: true }).catch(() => {});
      }
      if (s.kind === 'ready' || s.kind === 'pending') {
        // remember the hub (with the id and name it announced) once it has accepted us
        this.config.hub = { ...s.target };
        this.persist();
      }
      this.push();
    });
    client.on('pinned', (t: HubTarget) => { this.config.hub = { ...t }; this.persist(); });
    client.on('session', () => this.push());
    client.on('event', (name: string, data: unknown) => {
      if (name === 'policy.updated') this.setPeerPolicy((data as { peerFallback: boolean }).peerFallback);
      if (name === 'user.added' && (data as { role?: string }).role === 'bot') this.e2e.setBots([...(client.session?.users ?? []).filter((u) => u.role === 'bot').map((u) => u.id), (data as { id: string }).id]);
      this.events = this.events.then(async () => {
        await this.e2e.onEvent(name, data).catch(() => {});
        this.emit('hub-event', name, await this.e2e.incoming(data).catch(() => data));
      });
    });
    client.on('state', (s: ClientState) => {
      if (s.kind === 'offline') { this.e2e.reset(); if (this.peerAllowed) this.peers?.setActive(true); this.push(); }
    });
    client.on('warning', (err: Error) => this.emit('warning', err));
    client.connect({ ...target });
  }

  /** The hub moved to a new IP (DHCP): follow it, but only if it still has the same certificate. */
  private onHubSeen(found: FoundHub): void {
    const hub = this.config.hub;
    const cs = this.client?.state;
    if (hub && hub.hubId === found.beacon.id && hub.fp === found.beacon.fp
      && (hub.host !== found.address || hub.port !== found.beacon.port)
      && cs && (cs.kind === 'offline' || cs.kind === 'connecting' || (cs.kind === 'ready' && cs.via === 'remote'))) {
      // back in the office (or the hub moved): use the office network
      this.config.hub = { ...hub, host: found.address, port: found.beacon.port };
      this.persist();
      this.connect(this.config.hub);
    }
    this.push();
  }

  /** System idle / screen lock → shown as away to colleagues. */
  setIdle(idle: boolean): void {
    if (this.idle === idle) return;
    this.idle = idle;
    if (this.client?.state.kind === 'ready') void this.client.request('me.idle', { idle }).catch(() => {});
  }
  private idle = false;

  rescan(): void {
    this.finder.probe();
  }

  join(req: JoinRequest): void {
    const name = req.displayName.trim().slice(0, 80);
    if (name) {
      this.account = { ...this.account, displayName: name };
      this.config.displayName = name;
    }
    let target: HubTarget | null = null;
    if (req.hubId) {
      const f = this.finder.hubs.get(req.hubId);
      if (f) target = { host: f.address, port: f.beacon.port, hubId: f.beacon.id, name: f.beacon.name, fp: f.beacon.fp };
    } else if (req.address) {
      const a = parseAddress(req.address);
      if (a) target = { ...a };
    } else if (req.pairCode) {
      const p = parsePairCode(req.pairCode);
      if (!p) throw new Error('That pairing code is not complete. Copy all of it, starting with DXP1-.');
      const [host, port] = (p.lan[0] ?? ':0').split(':');
      target = { host, port: Number(port), hubId: p.hubId, name: p.name, fp: p.fp, ...(p.url ? { remote: { url: p.url, hubId: p.hubId } } : {}) };
      this.pair = p.token;
    } else if (req.setupCode) {
      const r = parseSetupCode(req.setupCode);
      if (!r) throw new Error('That setup code is not complete. Copy all of it, starting with DXC1-.');
      // no office address yet: straight to the gateway; discovery fills in the address in the office
      target = { host: '', port: 0, hubId: r.hubId, name: r.name, fp: r.fp, remote: { url: r.url, hubId: r.hubId } };
    }
    if (!target) throw new Error('That hub could not be found. Check the address and try again.');
    this.config.hub = target;
    this.invite = req.invite?.trim().toUpperCase() ?? '';
    this.persist();
    this.connect(target);
  }

  /** Keep this office and go to the welcome screen to join another. */
  addOffice(): void {
    this.stash();
    this.forgetHub();
  }

  /** Move to another office this device belongs to. */
  switchOffice(hubId: string): void {
    const next = (this.config.otherHubs ?? []).find((h) => h.hubId === hubId);
    if (!next) throw new Error('That office is not on this device any more.');
    this.stash();
    this.config.otherHubs = (this.config.otherHubs ?? []).filter((h) => h.hubId !== hubId);
    this.config.hub = next;
    this.persist();
    this.e2e.reset();
    this.connect(next);
  }

  removeOffice(hubId: string): void {
    this.config.otherHubs = (this.config.otherHubs ?? []).filter((h) => h.hubId !== hubId);
    this.persist();
    this.push();
  }

  /** Remember the current office in the list of others. */
  private stash(): void {
    const cur = this.config.hub;
    if (!cur?.hubId) return;
    const name = this.client?.state.kind === 'ready' ? this.client.state.session.hub.name : cur.name;
    this.config.otherHubs = [{ ...cur, name }, ...(this.config.otherHubs ?? []).filter((h) => h.hubId !== cur.hubId)].slice(0, 8);
  }

  forgetHub(): void {
    this.client?.removeAllListeners();
    this.client?.disconnect();
    this.client = null;
    this.config.hub = null;
    this.persist();
    this.push();
  }

  /** Turn on the hub-off fallback (Direct messages straight between PCs). */
  private get peerAllowed(): boolean { return this.config.peerFallback !== false; }
  private setPeerPolicy(on: boolean): void {
    if (this.config.peerFallback === on) return;
    this.config.peerFallback = on;
    this.persist();
    if (!on) this.peers?.setActive(false);
  }

  usePeers(peers: PeerNet): void {
    this.peers = peers;
    peers.on('changed', () => this.push());
    peers.on('message', (m: Message) => {
      this.events = this.events.then(async () => { this.emit('hub-event', 'msg.new', await this.e2e.incoming(m).catch(() => m)); });
    });
    peers.on('dropped', (item: { convId: string }, err: Error) => this.emit('warning', Object.assign(new Error(`A message written while the hub was off could not be posted: ${err.message}`), { convId: item.convId })));
    if (this.client?.state.kind === 'offline' && this.peerAllowed) peers.setActive(true);
  }

  async request<K extends OpName>(op: K, data?: Ops[K]['req']): Promise<Ops[K]['res']> {
    // hub off: Direct messages go straight to the other PCs and wait in the outbox for the hub
    if (op === 'msg.send' && this.peers?.isActive && this.client?.state.kind !== 'ready') {
      const d = data as Ops['msg.send']['req'];
      if (d.files?.length) throw new Error('Files can be sent once the office hub is back.');
      const m = await this.peers.send(d.convId, d.body, d.parentId ?? null, d.clientId);
      this.push();
      return this.e2e.incoming(m) as Promise<Ops[K]['res']>;
    }
    if (!this.client) throw new Error('Not connected to the hub.');
    const out = await this.e2e.outgoing(op, data) as Ops[K]['req'];
    return this.e2e.incoming(await this.client.request(op, out));
  }

  updateSettings(patch: Partial<Settings>): Settings {
    Object.assign(this.config.settings, patch);
    this.persist();
    this.push();
    return this.config.settings;
  }
}
