// The phone's implementation of the bridge the shared UI talks to. It plays the role the
// Electron main process plays on desktop: identity, hub discovery and connection, settings and
// the in-app updater. Networking that a WebView cannot do (UDP discovery, TLS pinned to a
// self-issued certificate, installing an APK) goes through the small native DexNative plugin.
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { createEncKeys } from '@dex/core/e2e';
import type { EncKeyPair } from '@dex/core/e2e';
import { E2EClient } from '@dex/core/e2e-client';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { DEFAULT_HUB_PORT, DISCOVERY_PORT, PROTOCOL_VERSION } from '@dex/core/protocol';
import type { FileInfo, OpName, Ops, WindowsAccount } from '@dex/core/protocol';
import { HubSession } from '@dex/core/session';
import type { ClientState, HubTarget } from '@dex/core/session';
import { chooseUpdate, feedUrl, parseFeed } from '@dex/core/feed';
import type { Channel, UpdateChoice } from '@dex/core/feed';
import type { AppState, DexBridge, DiscoveredHub, JoinRequest, Phase, Settings, UpdateState } from '../../desktop/src/shared/bridge.ts';

interface DexNativePlugin {
  discover(o: { port: number; timeoutMs: number; probe: string }): Promise<{ hubs: Array<{ address: string; data: string }> }>;
  wsOpen(o: { id: string; url: string }): Promise<void>;
  wsSend(o: { id: string; data: string }): Promise<void>;
  wsClose(o: { id: string }): Promise<void>;
  httpGet(o: { url: string; fingerprint?: string }): Promise<{ status: number; body: string }>;
  download(o: { url: string; fingerprint?: string; file: string; size: number; sha512: string }): Promise<{ path: string }>;
  installApk(o: { path: string }): Promise<void>;
  deviceInfo(): Promise<{ model: string; manufacturer: string; androidVersion: string; appVersion: string }>;
  fileGet(o: { url: string; fingerprint: string; token: string; id: string; name: string }): Promise<{ path: string }>;
  fileUpload(o: { url: string; fingerprint: string; token: string; data: string }): Promise<{ status: number; body: string }>;
  openFile(o: { path: string; mime: string }): Promise<void>;
  saveToDownloads(o: { path: string; name: string; mime: string }): Promise<{ path: string }>;
  addListener(event: 'wsOpen', fn: (e: { id: string; fingerprint: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'wsMessage', fn: (e: { id: string; data: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'wsClose', fn: (e: { id: string; reason: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'downloadProgress', fn: (e: { received: number; total: number }) => void): Promise<PluginListenerHandle>;
}

const Native = registerPlugin<DexNativePlugin>('DexNative');

// ------------------------------------------------------------------ helpers
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
// SPKI DER prefix for an Ed25519 public key; matches what the hub and desktop use.
const SPKI_PREFIX = Uint8Array.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);

interface MobileIdentity { deviceId: string; publicKey: string; secret: string }

async function loadIdentity(): Promise<MobileIdentity> {
  const { value } = await Preferences.get({ key: 'device-key' });
  if (value) {
    try { return JSON.parse(value) as MobileIdentity; } catch { /* regenerate */ }
  }
  const secret = ed25519.utils.randomSecretKey();
  const spki = new Uint8Array([...SPKI_PREFIX, ...ed25519.getPublicKey(secret)]);
  const id: MobileIdentity = { deviceId: hex(sha256(spki)).slice(0, 32), publicKey: b64(spki), secret: b64(secret) };
  await Preferences.set({ key: 'device-key', value: JSON.stringify(id) });
  return id;
}

/** End-to-end encryption keys for Direct messages (kept with the device key). */
async function loadEncKeys(): Promise<EncKeyPair> {
  const { value } = await Preferences.get({ key: 'device-enc' });
  if (value) {
    try { const k = JSON.parse(value) as EncKeyPair; if (k.secret && k.public) return k; } catch { /* regenerate */ }
  }
  const k = createEncKeys();
  await Preferences.set({ key: 'device-enc', value: JSON.stringify(k) });
  return k;
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  txt: 'text/plain', csv: 'text/csv', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', zip: 'application/zip', mp4: 'video/mp4', webm: 'audio/webm', dwg: 'image/vnd.dwg',
};
const mimeOf = (name: string) => MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? '*/*';

interface MobileConfig {
  hub: HubTarget | null;
  displayName: string | null;
  officeAccount: { domain: string; username: string } | null;
  settings: Settings;
  lastRunVersion?: string;
  pendingNotes?: { version: string; notes: string } | null;
}

const DEFAULTS: MobileConfig = {
  hub: null, displayName: null, officeAccount: null,
  settings: { theme: 'system', startAtLogin: false, closeToTray: false, updateChannel: 'stable', autoDownloadUpdates: true },
};

async function loadConfig(): Promise<MobileConfig> {
  const { value } = await Preferences.get({ key: 'config' });
  try {
    const c = JSON.parse(value ?? '{}') as Partial<MobileConfig>;
    return { ...DEFAULTS, ...c, settings: { ...DEFAULTS.settings, ...c.settings } };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

function parseOfficeAccount(input: string | undefined): { domain: string; username: string } | null {
  const m = (input ?? '').trim().match(/^([\w.\-]+)\\([\w.\-]+)$/);
  return m ? { domain: m[1].toUpperCase(), username: m[2] } : null;
}

// ------------------------------------------------------------------ the app
class MobileApp {
  private invite = '';
  private session!: HubSession;
  private config!: MobileConfig;
  private identity!: MobileIdentity;
  private e2e!: E2EClient;
  private events: Promise<void> = Promise.resolve();
  private account!: WindowsAccount;
  private version = '0.0.0';
  private readonly hubs = new Map<string, DiscoveredHub>();
  private readonly listeners = { state: new Set<(s: AppState) => void>(), event: new Set<(n: string, d: unknown) => void>() };
  private update: UpdateState = { phase: 'idle', currentVersion: '0.0.0', lastCheck: null, available: null, progress: null, error: null, justUpdated: null };
  private choice: (UpdateChoice & { source: 'hub' | 'internet'; url: string; pin?: string }) | null = null;
  private readyPath: string | null = null;

  async init(): Promise<void> {
    this.identity = await loadIdentity();
    const encKeys = await loadEncKeys();
    const signSecret = unb64(this.identity.secret);
    this.e2e = new E2EClient({
      deviceId: this.identity.deviceId, encSecret: encKeys.secret, encPublic: encKeys.public,
      sign: (p) => b64(ed25519.sign(p, signSecret)),
      request: (op, data) => this.session.request(op as OpName, data as never),
    });
    this.config = await loadConfig();
    const info = await Native.deviceInfo().catch(() => ({ model: 'Phone', manufacturer: '', androidVersion: '', appVersion: '0.0.0' }));
    this.version = info.appVersion;
    this.update.currentVersion = info.appVersion;
    const hostname = `${info.manufacturer} ${info.model}`.trim().slice(0, 60) || 'Phone';
    const office = this.config.officeAccount;
    this.account = {
      domain: office?.domain ?? 'PHONE',
      username: office?.username ?? `phone-${this.identity.deviceId.slice(0, 8)}`,
      displayName: this.config.displayName ?? '',
      hostname,
    };

    // "what's new" after an update
    if (this.config.lastRunVersion && this.config.lastRunVersion !== this.version && this.config.pendingNotes?.version === this.version) {
      this.update.justUpdated = this.config.pendingNotes;
    }
    this.config.lastRunVersion = this.version;
    this.config.pendingNotes = null;
    await this.save();

    await this.wireNativeSockets();
    this.session = this.newSession();
    if (this.config.hub) this.session.connect(this.config.hub);
    void this.discoverLoop();
    setTimeout(() => void this.checkForUpdates(false), 8000);
    setInterval(() => void this.checkForUpdates(false), 4 * 3600 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) void this.checkForUpdates(false, true);
      // a phone in a pocket counts as away
      if (this.session.state.kind === 'ready') void this.session.request('me.idle', { idle: document.hidden }).catch(() => {});
    });
  }

  private async save(): Promise<void> {
    await Preferences.set({ key: 'config', value: JSON.stringify(this.config) });
  }

  // ---------------------------------------------------------- transport
  private sockets = new Map<string, { onOpen: (fp: string) => void; onMessage: (d: string) => void; onClose: (r: string) => void }>();
  private sockSeq = 0;

  private async wireNativeSockets(): Promise<void> {
    await Native.addListener('wsOpen', (e) => this.sockets.get(e.id)?.onOpen(e.fingerprint));
    await Native.addListener('wsMessage', (e) => this.sockets.get(e.id)?.onMessage(e.data));
    await Native.addListener('wsClose', (e) => { const s = this.sockets.get(e.id); this.sockets.delete(e.id); s?.onClose(e.reason); });
    await Native.addListener('downloadProgress', (e) => this.setUpdate({ progress: e }));
  }

  /** Where and how to reach the hub's file endpoint for this session. */
  private hubAccess(): { base: string; fp: string; token: string } {
    const hub = this.config.hub;
    const session = this.session.state.kind === 'ready' ? this.session.state.session : null;
    if (!hub?.fp || !session) throw new Error('The office hub is not connected.');
    const host = hub.host.includes(':') ? `[${hub.host}]` : hub.host;
    return { base: `https://${host}:${hub.port}`, fp: hub.fp, token: session.fileToken };
  }

  private readonly fileCache = new Map<string, Promise<{ path: string }>>();
  private fetchFile(id: string, name: string): Promise<{ path: string }> {
    let p = this.fileCache.get(id);
    if (!p) {
      const hub = this.hubAccess();
      p = Native.fileGet({ url: `${hub.base}/files/${id}?download=1`, fingerprint: hub.fp, token: hub.token, id, name });
      p.catch(() => this.fileCache.delete(id));
      this.fileCache.set(id, p);
    }
    return p;
  }

  private newSession(): HubSession {
    const secret = unb64(this.identity.secret);
    const s = new HubSession({
      deviceId: this.identity.deviceId,
      publicKey: this.identity.publicKey,
      sign: (payload) => b64(ed25519.sign(payload, secret)),
      account: this.account,
      invite: this.invite,
      open: (target, h) => {
        const id = `ws${++this.sockSeq}`;
        this.sockets.set(id, h);
        const host = target.host.includes(':') ? `[${target.host}]` : target.host;
        Native.wsOpen({ id, url: `wss://${host}:${target.port}/ws` }).catch((err: Error) => { this.sockets.delete(id); h.onClose(err.message); });
        return {
          send: (data) => { void Native.wsSend({ id, data }); },
          close: () => { this.sockets.delete(id); void Native.wsClose({ id }); },
        };
      },
    });
    s.on('state', (st: ClientState) => {
      if (st.kind === 'ready' || st.kind === 'pending') { this.config.hub = { ...st.target }; void this.save(); }
      if (st.kind === 'ready') {
        void this.checkForUpdates(false, true);
        void this.e2e.ready(st.session.me.id, st.session.users.filter((u) => u.role === 'bot').map((u) => u.id)).catch(() => {});
      }
      if (st.kind === 'offline') this.e2e.reset();
      this.push();
    });
    s.on('pinned', (t: HubTarget) => { this.config.hub = { ...t }; void this.save(); });
    s.on('session', () => this.push());
    s.on('event', (name: string, data: unknown) => {
      this.events = this.events.then(async () => {
        await this.e2e.onEvent(name, data).catch(() => {});
        const opened = await this.e2e.incoming(data).catch(() => data);
        for (const fn of this.listeners.event) fn(name, opened);
      });
    });
    return s;
  }

  private async discoverLoop(): Promise<void> {
    const probe = JSON.stringify({ app: 'dexconnect', v: PROTOCOL_VERSION, kind: 'probe' });
    for (;;) {
      try {
        const { hubs } = await Native.discover({ port: DISCOVERY_PORT, timeoutMs: 1500, probe });
        for (const h of hubs) {
          try {
            const b = JSON.parse(h.data);
            if (b.app !== 'dexconnect' || b.kind !== 'hub') continue;
            this.hubs.set(b.id, { id: b.id, name: String(b.name), address: h.address, port: b.port, fingerprint: b.fp, version: String(b.version) });
            // follow the hub to a new address, but only with the same certificate
            const cur = this.config.hub;
            if (cur && cur.hubId === b.id && cur.fp === b.fp && cur.host !== h.address && this.session.state.kind === 'offline') {
              this.config.hub = { ...cur, host: h.address, port: b.port };
              void this.save();
              this.session.connect(this.config.hub);
            }
          } catch { /* ignore malformed answers */ }
        }
        this.push();
      } catch { /* Wi-Fi off; try again */ }
      const ready = this.session?.state.kind === 'ready';
      await new Promise((r) => setTimeout(r, ready ? 30000 : 4000));
    }
  }

  // ---------------------------------------------------------- state
  state(): AppState {
    const cs = this.session?.state ?? { kind: 'idle' as const };
    const phaseOf: Record<ClientState['kind'], Phase> = {
      idle: this.config.hub ? 'connecting' : 'welcome', connecting: 'connecting', pending: 'pending', ready: 'ready',
      offline: 'offline', rejected: 'rejected', 'identity-mismatch': 'mismatch',
    };
    const hub = this.config.hub;
    return {
      phase: phaseOf[cs.kind],
      account: this.account,
      deviceId: this.identity.deviceId,
      hubs: [...this.hubs.values()],
      hub: hub ? { id: hub.hubId, name: hub.name, host: hub.host, port: hub.port, fingerprint: hub.fp } : null,
      session: cs.kind === 'ready' ? cs.session : null,
      pendingPosition: cs.kind === 'pending' ? cs.position : 0,
      retryInMs: cs.kind === 'offline' ? cs.retryInMs : 0,
      error: cs.kind === 'rejected' ? cs.reason : cs.kind === 'identity-mismatch' ? 'The hub presented a different certificate than the one this phone trusts.' : cs.kind === 'offline' ? cs.error : null,
      settings: this.config.settings,
      update: this.update,
      platform: 'android',
      version: this.version,
    };
  }

  private push(): void {
    const s = this.state();
    for (const fn of this.listeners.state) fn(s);
  }

  private setUpdate(patch: Partial<UpdateState>): void {
    this.update = { ...this.update, ...patch };
    this.push();
  }

  // ---------------------------------------------------------- updates
  async checkForUpdates(manual: boolean, quiet = false): Promise<void> {
    const ph = this.update.phase;
    if (ph === 'checking' || ph === 'downloading' || ph === 'installing') return;
    if (quiet && this.update.lastCheck && Date.now() - this.update.lastCheck < 30 * 60 * 1000) return;
    this.setUpdate({ phase: 'checking', error: null });
    const channels: Channel[] = this.config.settings.updateChannel === 'beta' ? ['stable', 'beta'] : ['stable'];
    const hub = this.session.state.kind === 'ready' ? this.config.hub : null;
    const hubBase = hub ? `https://${hub.host}:${hub.port}` : null;

    const fromHub = hub && hubBase ? await Promise.all(channels.map((ch) =>
      Native.httpGet({ url: `${hubBase}/updates/${ch}.json`, fingerprint: hub.fp })
        .then((r) => (r.status === 200 ? parseFeed(JSON.parse(r.body)) : null)).catch(() => null))) : [];
    const fromNet = await Promise.all(channels.map((ch) =>
      fetch(feedUrl(ch), { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((j) => parseFeed(j)).catch(() => null)));

    const hubPick = chooseUpdate(this.version, fromHub, 'android');
    const netPick = chooseUpdate(this.version, fromNet, 'android');
    if (hubPick && (!netPick || hubPick.feed.version >= netPick.feed.version)) {
      this.choice = { ...hubPick, source: 'hub', url: `${hubBase}${hubPick.asset.url}`, pin: hub!.fp };
    } else if (netPick) {
      this.choice = { ...netPick, source: 'internet', url: netPick.asset.url };
    } else {
      const reachable = fromHub.some(Boolean) || fromNet.some(Boolean);
      this.setUpdate({
        phase: this.readyPath ? 'ready' : reachable || !manual ? 'up-to-date' : 'error',
        lastCheck: Date.now(),
        error: reachable || !manual ? null : 'Could not reach the office hub or the internet to check for updates.',
      });
      return;
    }
    const c = this.choice;
    this.setUpdate({
      phase: 'available', lastCheck: Date.now(),
      available: { version: c.feed.version, notes: c.feed.notes, releasedAt: c.feed.releasedAt, mandatory: c.mandatory, size: c.asset.size, source: c.source },
    });
    if (c.mandatory || this.config.settings.autoDownloadUpdates || manual) await this.downloadUpdate();
  }

  async downloadUpdate(): Promise<void> {
    const c = this.choice;
    if (!c || this.update.phase === 'downloading') return;
    this.setUpdate({ phase: 'downloading', progress: { received: 0, total: c.asset.size }, error: null });
    try {
      const { path } = await Native.download({ url: c.url, fingerprint: c.pin, file: c.asset.file, size: c.asset.size, sha512: c.asset.sha512 });
      this.readyPath = path;
      this.setUpdate({ phase: 'ready' });
    } catch (err) {
      this.setUpdate({ phase: 'error', error: (err as Error).message });
    }
  }

  async installUpdate(): Promise<void> {
    if (!this.readyPath || !this.choice) return;
    this.config.pendingNotes = { version: this.choice.feed.version, notes: this.choice.feed.notes };
    await this.save();
    this.setUpdate({ phase: 'installing' });
    try {
      await Native.installApk({ path: this.readyPath });
      // Android shows its own "Update this app?" sheet; if the user backs out we stay ready.
      setTimeout(() => this.setUpdate({ phase: 'ready' }), 4000);
    } catch (err) {
      this.setUpdate({ phase: 'error', error: (err as Error).message });
    }
  }

  // ---------------------------------------------------------- bridge
  bridge(): DexBridge {
    return {
      getState: async () => this.state(),
      onState: (cb) => { this.listeners.state.add(cb); return () => this.listeners.state.delete(cb); },
      onHubEvent: (cb) => { this.listeners.event.add(cb); return () => this.listeners.event.delete(cb); },
      onDeepLink: () => () => {},
      join: async (req: JoinRequest) => {
        const name = req.displayName.trim().slice(0, 80);
        const office = parseOfficeAccount(req.officeAccount);
        if (req.officeAccount?.trim() && !office) throw new Error('Write your office sign-in as DOMAIN\\name, for example DEXTERITY\\priya.raman.');
        this.config.displayName = name || null;
        this.config.officeAccount = office;
        this.invite = req.invite?.trim().toUpperCase() ?? '';
        this.session.setInvite(this.invite);
        this.account = {
          ...this.account,
          displayName: name || this.account.username,
          ...(office ?? { domain: 'PHONE', username: `phone-${this.identity.deviceId.slice(0, 8)}` }),
        };
        let target: HubTarget | null = null;
        if (req.hubId) {
          const h = this.hubs.get(req.hubId);
          if (h) target = { host: h.address, port: h.port, hubId: h.id, name: h.name, fp: h.fingerprint };
        } else if (req.address) {
          const m = req.address.trim().replace(/^\w+:\/\//, '').match(/^([\w.\-]+)(?::(\d+))?$/);
          if (m) target = { host: m[1], port: m[2] ? Number(m[2]) : DEFAULT_HUB_PORT };
        }
        if (!target) throw new Error('That hub could not be found. Check the address and try again.');
        this.config.hub = target;
        await this.save();
        this.session.setAccount(this.account);
        this.session.connect(target);
      },
      forgetHub: async () => {
        this.session.disconnect();
        this.config.hub = null;
        await this.save();
        this.push();
      },
      rescan: async () => { /* the discovery loop runs continuously */ },
      request: async <K extends OpName>(op: K, data?: Ops[K]['req']) => {
        const out = await this.e2e.outgoing(op, data) as Ops[K]['req'];
        return this.e2e.incoming(await this.session.request(op, out));
      },
      e2eStatus: (convId: string) => this.e2e.status(convId),
      // files: downloaded once into the app's cache through the pinned connection
      uploadFile: async (_uploadId: string, src: { path?: string; data?: ArrayBuffer; name: string; mime?: string }) => {
        if (!src.data) throw new Error('Choose the file again.');
        if (src.data.byteLength > 100 * 1024 * 1024) throw new Error('Files from a phone can be up to 100 MB.');
        const hub = this.hubAccess();
        const q = `/files?name=${encodeURIComponent(src.name)}${src.mime ? `&type=${encodeURIComponent(src.mime)}` : ''}`;
        const r = await Native.fileUpload({ url: `${hub.base}${q}`, fingerprint: hub.fp, token: hub.token, data: b64(new Uint8Array(src.data)) });
        const json = JSON.parse(r.body || '{}') as FileInfo & { error?: string };
        if (r.status !== 200) throw new Error(json.error ?? `Upload failed (${r.status}).`);
        return json;
      },
      fileUrl: async (id: string, name: string) => Capacitor.convertFileSrc((await this.fetchFile(id, name)).path),
      openFile: async (id: string, name: string) => { const f = await this.fetchFile(id, name); await Native.openFile({ path: f.path, mime: mimeOf(name) }); },
      saveFile: async (id: string, name: string) => { const f = await this.fetchFile(id, name); return (await Native.saveToDownloads({ path: f.path, name, mime: mimeOf(name) })).path; },
      setSettings: async (patch) => {
        Object.assign(this.config.settings, patch);
        await this.save();
        this.push();
        if (patch.updateChannel) void this.checkForUpdates(false);
        return this.config.settings;
      },
      notify: () => { /* in-app toasts for now; system notifications arrive with messaging */ },
      checkForUpdates: () => this.checkForUpdates(true),
      downloadUpdate: () => this.downloadUpdate(),
      installUpdate: () => this.installUpdate(),
      dismissWhatsNew: async () => { this.setUpdate({ justUpdated: null }); },
    };
  }
}

export async function installMobileBridge(): Promise<void> {
  const app = new MobileApp();
  await app.init();
  window.dex = app.bridge();
}
