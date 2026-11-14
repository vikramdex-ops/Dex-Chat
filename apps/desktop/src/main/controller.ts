// Owns the hub connection for the desktop app: discovery, first-run join, silent sign-in on
// later launches, following the hub if its IP changes, and the state the UI renders.
import { EventEmitter } from 'node:events';
import { DEFAULT_HUB_PORT } from '@dex/core';
import type { DeviceIdentity, OpName, Ops, WindowsAccount } from '@dex/core';
import { HubClient } from '@dex/core/client';
import type { ClientState, HubTarget } from '@dex/core/client';
import { HubFinder } from '@dex/core/discovery';
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
  private client: HubClient | null = null;
  private readonly finder = new HubFinder();
  private account: WindowsAccount;
  private readonly identity: DeviceIdentity;
  private readonly config: Config;
  private readonly meta: { platform: NodeJS.Platform; version: string; update: () => UpdateState };

  constructor(account: WindowsAccount, identity: DeviceIdentity, config: Config, meta: { platform: NodeJS.Platform; version: string; update: () => UpdateState }) {
    super();
    this.identity = identity;
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
      hub: hub ? { id: hub.hubId, name: hub.name, host: hub.host, port: hub.port, fingerprint: hub.fp } : null,
      session: cs.kind === 'ready' ? cs.session : null,
      pendingPosition: cs.kind === 'pending' ? cs.position : 0,
      retryInMs: cs.kind === 'offline' ? cs.retryInMs : 0,
      error: cs.kind === 'rejected' ? cs.reason
        : cs.kind === 'identity-mismatch' ? `The hub presented a different certificate (${cs.actual.slice(0, 23)}…) than the one this PC trusts.`
        : cs.kind === 'offline' ? cs.error : null,
      settings: this.config.settings,
      update: this.meta.update(),
      platform: this.meta.platform,
      version: this.meta.version,
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
    this.client = client;
    client.on('state', (s: ClientState) => {
      if (s.kind === 'ready') this.emit('hub-ready');
      if (s.kind === 'ready' || s.kind === 'pending') {
        // remember the hub (with the id and name it announced) once it has accepted us
        this.config.hub = { ...s.target };
        this.persist();
      }
      this.push();
    });
    client.on('pinned', (t: HubTarget) => { this.config.hub = { ...t }; this.persist(); });
    client.on('session', () => this.push());
    client.on('event', (name: string, data: unknown) => this.emit('hub-event', name, data));
    client.on('warning', (err: Error) => this.emit('warning', err));
    client.connect({ ...target });
  }

  /** The hub moved to a new IP (DHCP): follow it, but only if it still has the same certificate. */
  private onHubSeen(found: FoundHub): void {
    const hub = this.config.hub;
    const cs = this.client?.state;
    if (hub && hub.hubId === found.beacon.id && hub.fp === found.beacon.fp
      && (hub.host !== found.address || hub.port !== found.beacon.port)
      && cs && (cs.kind === 'offline' || cs.kind === 'connecting')) {
      this.config.hub = { ...hub, host: found.address, port: found.beacon.port };
      this.persist();
      this.connect(this.config.hub);
    }
    this.push();
  }

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
    }
    if (!target) throw new Error('That hub could not be found. Check the address and try again.');
    this.config.hub = target;
    this.persist();
    this.connect(target);
  }

  forgetHub(): void {
    this.client?.removeAllListeners();
    this.client?.disconnect();
    this.client = null;
    this.config.hub = null;
    this.persist();
    this.push();
  }

  async request<K extends OpName>(op: K, data?: Ops[K]['req']): Promise<Ops[K]['res']> {
    if (!this.client) throw new Error('Not connected to the hub.');
    return this.client.request(op, data);
  }

  updateSettings(patch: Partial<Settings>): Settings {
    Object.assign(this.config.settings, patch);
    this.persist();
    this.push();
    return this.config.settings;
  }
}
