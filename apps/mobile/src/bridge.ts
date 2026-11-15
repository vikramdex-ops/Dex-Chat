// The phone's implementation of the bridge the shared UI talks to. It plays the role the
// Electron main process plays on desktop: identity, hub discovery and connection, settings and
// the in-app updater. Networking that a WebView cannot do (UDP discovery, TLS pinned to a
// self-issued certificate, installing an APK) goes through the small native DexNative plugin.
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { b64 as b64Chunked, createEncKeys } from '@dex/core/e2e';
import type { EncKeyPair } from '@dex/core/e2e';
import { DAMAGED_FILE } from '@dex/core/e2e-files';
import { loadSecret } from './keys.ts';
import type { MissedNotice } from '@dex/core/protocol';
import { E2EClient } from '@dex/core/e2e-client';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { DEFAULT_HUB_PORT, DISCOVERY_PORT, PROTOCOL_VERSION } from '@dex/core/protocol';
import type { FileInfo, OpName, Ops, WindowsAccount } from '@dex/core/protocol';
import { HubSession } from '@dex/core/session';
import type { ClientState, HubTarget } from '@dex/core/session';
import { chooseUpdate, feedUrl, parseFeed } from '@dex/core/feed';
import type { Channel, UpdateChoice } from '@dex/core/feed';
import { openRemoteSocket, parsePairCode, parseSetupCode } from '@dex/core/remote';
import type { RawHandlers } from '@dex/core/remote';
import { SETTINGS_EXTRA_DEFAULTS, type AppState, type DexBridge, type DiscoveredHub, type JoinRequest, type NotifyHealth, type Phase, type Settings, type SettingsPage, type UpdateState } from '../../desktop/src/shared/bridge.ts';

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
  showNotification(o: { title: string; body: string; link?: string; silent: boolean }): Promise<void>;
  keepAlive(o: { on: boolean; text?: string }): Promise<void>;
  askNotifications(): Promise<void>;
  takeLaunchLink(): Promise<{ url: string | null }>;
  clipboardText(): Promise<{ text: string | null }>;
  gwOpen(o: { id: string; url: string }): Promise<void>;
  gwSend(o: { id: string; data: string }): Promise<void>;
  fileWrite(o: { id: string; name: string; data: string; first?: boolean; done?: boolean }): Promise<{ path?: string }>;
  addListener(event: 'gwOpen', fn: (e: { id: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'gwBinary', fn: (e: { id: string; data: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'deepLink', fn: (e: { url: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'downloadProgress', fn: (e: { received: number; total: number }) => void): Promise<PluginListenerHandle>;
  /** Secrets wrapped by an AES key in the Android Keystore (rejects with code "unreadable" or "unavailable"). */
  secureGet(o: { key: string }): Promise<{ value: string | null }>;
  secureSet(o: { key: string; value: string }): Promise<void>;
  /** Part of a cached file, base64 (to decrypt an encrypted attachment), and removing one. */
  fileRead(o: { path: string; offset: number; length: number }): Promise<{ data: string; eof: boolean }>;
  fileDelete(o: { path: string }): Promise<void>;
  notifyHealth(): Promise<NotifyHealth>;
  openSettings(o: { target: SettingsPage }): Promise<{ opened: string | null }>;
  requestBatteryExemption(): Promise<{ opened: string | null }>;
  /** What the background service needs to wait for messages on its own when the app is not connected. */
  watchConfig(o: { on: boolean; url?: string; fingerprint?: string; token?: string; notifyFor?: string; showPreviews?: boolean; quietFrom?: string | null; quietTo?: string | null; silent?: boolean }): Promise<void>;
  setConnected(o: { connected: boolean; cursor?: string }): Promise<void>;
  watchCursor(): Promise<{ cursor: string | null }>;
}

const Native = registerPlugin<DexNativePlugin>('DexNative');
const isSealedText = (s: string) => s.startsWith('e2e1:');

// ------------------------------------------------------------------ helpers
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
// SPKI DER prefix for an Ed25519 public key; matches what the hub and desktop use.
const SPKI_PREFIX = Uint8Array.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);

interface MobileIdentity { deviceId: string; publicKey: string; secret: string }

// the device keys are wrapped by the Android Keystore; older versions' plain copies move there on first start
const secure = { secureGet: (o: { key: string }) => Native.secureGet(o), secureSet: (o: { key: string; value: string }) => Native.secureSet(o) };
const keyLog = (msg: string) => console.warn(`[keys] ${msg}`);

function loadIdentity(): Promise<MobileIdentity> {
  const valid = (v: unknown): v is MobileIdentity => !!v && typeof (v as MobileIdentity).deviceId === 'string' && /^[0-9a-f]{32}$/.test((v as MobileIdentity).deviceId)
    && typeof (v as MobileIdentity).publicKey === 'string' && typeof (v as MobileIdentity).secret === 'string';
  const create = (): MobileIdentity => {
    const secret = ed25519.utils.randomSecretKey();
    const spki = new Uint8Array([...SPKI_PREFIX, ...ed25519.getPublicKey(secret)]);
    return { deviceId: hex(sha256(spki)).slice(0, 32), publicKey: b64(spki), secret: b64(secret) };
  };
  return loadSecret({ key: 'device-key', valid, create, secure, plain: Preferences, log: keyLog });
}

/** End-to-end encryption keys for Direct messages (kept with the device key). */
function loadEncKeys(): Promise<EncKeyPair> {
  const valid = (v: unknown): v is EncKeyPair => !!v && typeof (v as EncKeyPair).secret === 'string' && !!(v as EncKeyPair).secret && typeof (v as EncKeyPair).public === 'string' && !!(v as EncKeyPair).public;
  return loadSecret({ key: 'device-enc', valid, create: createEncKeys, secure, plain: Preferences, log: keyLog });
}

/** A cached file read back through the plugin, in pieces. */
async function* readCached(path: string): AsyncIterable<Uint8Array> {
  for (let offset = 0; ;) {
    const r = await Native.fileRead({ path, offset, length: 512 * 1024 });
    const data = unb64(r.data);
    offset += data.length;
    if (data.length) yield data;
    if (r.eof || !data.length) return;
  }
}

async function collect(src: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const p of src) { parts.push(p); n += p.length; }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
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
  /** Other offices this phone belongs to. */
  otherHubs?: HubTarget[];
}

const DEFAULTS: MobileConfig = {
  hub: null, displayName: null, officeAccount: null,
  settings: { theme: 'system', startAtLogin: false, updateChannel: 'stable', autoDownloadUpdates: true, ...SETTINGS_EXTRA_DEFAULTS, closeToTray: true },
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
      nameOf: (id) => (this.session.state.kind === 'ready' ? this.session.state.session.users.find((u) => u.id === id)?.displayName : undefined),
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
  /** Gateway sockets (outside the office): binary frames, base64 across the bridge. */
  private gwSockets = new Map<string, RawHandlers>();

  private async wireNativeSockets(): Promise<void> {
    await Native.addListener('wsOpen', (e) => this.sockets.get(e.id)?.onOpen(e.fingerprint));
    await Native.addListener('wsMessage', (e) => this.sockets.get(e.id)?.onMessage(e.data));
    await Native.addListener('wsClose', (e) => {
      const s = this.sockets.get(e.id); this.sockets.delete(e.id); s?.onClose(e.reason);
      const g = this.gwSockets.get(e.id); this.gwSockets.delete(e.id); g?.onClose(e.reason);
    });
    await Native.addListener('gwOpen', (e) => this.gwSockets.get(e.id)?.onOpen());
    await Native.addListener('gwBinary', (e) => this.gwSockets.get(e.id)?.onBinary(unb64(e.data)));
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
  private async fetchViaGateway(id: string, name: string): Promise<{ path: string }> {
    const session = this.session.state.kind === 'ready' ? this.session.state.session : null;
    if (!session) throw new Error('The office hub is not connected.');
    const r = await this.session.http({ method: 'GET', path: `/files/${id}?download=1`, headers: { authorization: `Bearer ${session.fileToken}` } });
    if (r.status !== 200) { for await (const _ of r.body) { /* drain */ } throw new Error(r.status === 404 ? 'This file is no longer available.' : `Download failed (${r.status})`); }
    let first = true;
    for await (const part of r.body) { await Native.fileWrite({ id, name, data: b64(part), first }); first = false; }
    const done = await Native.fileWrite({ id, name, data: '', first, done: true });
    return { path: done.path! };
  }

  /**
   * An end-to-end encrypted attachment: the ciphertext is downloaded (into the cache, or streamed
   * through the gateway), decrypted here chunk by chunk, and only the decrypted file is kept.
   * Images and previews are then shown from that file: the hub never sees them.
   */
  private async fetchSealed(id: string, name: string, decrypt: (src: AsyncIterable<Uint8Array>) => AsyncIterable<Uint8Array>): Promise<{ path: string }> {
    let cipher: string | null = null;
    let source: AsyncIterable<Uint8Array>;
    if (this.session.viaGateway) {
      const session = this.session.state.kind === 'ready' ? this.session.state.session : null;
      if (!session) throw new Error('The office hub is not connected.');
      const r = await this.session.http({ method: 'GET', path: `/files/${id}?download=1`, headers: { authorization: `Bearer ${session.fileToken}` } });
      if (r.status !== 200) { for await (const _ of r.body) { /* drain */ } throw new Error(r.status === 404 ? 'This file is no longer available.' : `Download failed (${r.status})`); }
      source = r.body;
    } else {
      const hub = this.hubAccess();
      cipher = (await Native.fileGet({ url: `${hub.base}/files/${id}?download=1`, fingerprint: hub.fp, token: hub.token, id, name: 'encrypted.part' })).path;
      source = readCached(cipher);
    }
    try {
      let first = true;
      for await (const part of decrypt(source)) { await Native.fileWrite({ id, name, data: b64Chunked(part), first }); first = false; }
      return { path: (await Native.fileWrite({ id, name, data: '', first, done: true })).path! };
    } catch (e) {
      throw new Error((e as Error).message === DAMAGED_FILE ? DAMAGED_FILE : `Download interrupted: ${(e as Error).message}`);
    } finally {
      if (cipher) await Native.fileDelete({ path: cipher }).catch(() => {});
    }
  }

  private fetchFile(id: string, name: string): Promise<{ path: string }> {
    let p = this.fileCache.get(id);
    const decrypt = this.e2e.downloadTransform(id);
    if (!p && decrypt) {
      p = this.fetchSealed(id, name, decrypt);
      p.catch(() => this.fileCache.delete(id));
      this.fileCache.set(id, p);
    }
    if (!p && this.session.viaGateway) {
      p = this.fetchViaGateway(id, name);
      p.catch(() => this.fileCache.delete(id));
      this.fileCache.set(id, p);
    }
    if (!p) {
      const hub = this.hubAccess();
      p = Native.fileGet({ url: `${hub.base}/files/${id}?download=1`, fingerprint: hub.fp, token: hub.token, id, name });
      p.catch(() => this.fileCache.delete(id));
      this.fileCache.set(id, p);
    }
    return p;
  }

  /** Remember the current office among the others. */
  private stashOffice(): void {
    const cur = this.config.hub;
    if (!cur?.hubId) return;
    const name = this.session.state.kind === 'ready' ? this.session.state.session.hub.name : cur.name;
    this.config.otherHubs = [{ ...cur, name }, ...(this.config.otherHubs ?? []).filter((h) => h.hubId !== cur.hubId)].slice(0, 8);
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
      // outside the office: through the gateway, encrypted to the hub
      openRemote: (target, h) => openRemoteSocket((url, rh) => {
        const id = `gw${++this.sockSeq}`;
        this.gwSockets.set(id, rh);
        Native.gwOpen({ id, url }).catch((err: Error) => { this.gwSockets.delete(id); rh.onClose(err.message); });
        return {
          send: (data) => { void Native.gwSend({ id, data: b64(data) }); },
          close: () => { this.gwSockets.delete(id); void Native.wsClose({ id }); },
        };
      }, target as HubTarget & { remote: { url: string; hubId: string } }, h),
    });
    s.on('state', (st: ClientState) => {
      if (st.kind === 'ready' || st.kind === 'pending') { this.config.hub = { ...st.target }; void this.save(); }
      if (st.kind === 'ready' || st.kind === 'rejected') s.setPair('');
      if (st.kind === 'ready') {
        void this.checkForUpdates(false, true);
        const e2eReady = this.e2e.ready(st.session.me.id, st.session.users.filter((u) => u.role === 'bot').map((u) => u.id)).catch(() => {});
        // what arrived while the phone was not connected, shown now (after the keys, to open encrypted ones)
        void e2eReady.then(() => this.catchUp()).catch(() => {});
        void this.configureWatch().catch(() => {});
      }
      if (st.kind === 'offline') {
        this.e2e.reset();
        // the background service waits for messages itself until the app is back
        void Native.setConnected({ connected: false }).catch(() => {});
      }
      this.push();
    });
    s.on('pinned', (t: HubTarget) => { this.config.hub = { ...t }; void this.save(); });
    s.on('session', () => this.push());
    s.on('event', (name: string, data: unknown) => {
      if (name === 'msg.new' && typeof (data as { id?: unknown }).id === 'string') this.heard((data as { id: string }).id);
      this.events = this.events.then(async () => {
        await this.e2e.onEvent(name, data).catch(() => {});
        const opened = await this.e2e.incoming(data).catch(() => data);
        for (const fn of this.listeners.event) fn(name, opened);
      });
    });
    return s;
  }

  // ---------------------------------------------------------- notifications that keep working
  private heardTimer: ReturnType<typeof setTimeout> | null = null;
  private lastHeard: string | null = null;

  /** The app's own connection heard about this message: the background service starts after it. */
  private heard(id: string): void {
    if (!/^[0-9A-Z]{26}$/.test(id) || (this.lastHeard && id <= this.lastHeard)) return;
    this.lastHeard = id;
    if (this.heardTimer) return;
    this.heardTimer = setTimeout(() => {
      this.heardTimer = null;
      void Native.setConnected({ connected: this.session.state.kind === 'ready', cursor: this.lastHeard ?? undefined }).catch(() => {});
    }, 1500);
  }

  /**
   * After every reconnect: fetch the messages that arrived while the phone was not connected
   * (Android may have stopped the app, or the network dropped) and show them as notifications,
   * with the same preferences as live ones. Starts where the background service left off, so
   * nothing is shown twice.
   */
  private async catchUp(): Promise<void> {
    await Native.setConnected({ connected: true }).catch(() => {});
    let after = (await Native.watchCursor().catch(() => ({ cursor: null }))).cursor;
    for (let page = 0; page < 4; page++) {
      const r = await this.session.request('notify.missed', { after });
      if (!after) { after = r.cursor; break; }
      await this.showMissed(r.items);
      after = r.cursor ?? after;
      if (!r.more) break;
    }
    if (after) await Native.setConnected({ connected: true, cursor: after }).catch(() => {});
  }

  private inQuietHours(): boolean {
    const { quietFrom, quietTo } = this.config.settings;
    if (!quietFrom || !quietTo) return false;
    const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    const now = new Date();
    const t = now.getHours() * 60 + now.getMinutes();
    const a = m(quietFrom), b = m(quietTo);
    return a <= b ? t >= a && t < b : t >= a || t < b;
  }

  private async showMissed(items: MissedNotice[]): Promise<void> {
    const s = this.config.settings;
    // someone looking at the app sees it there; nothing to interrupt them with
    if (!items.length || !document.hidden || s.notifyFor === 'none' || this.inQuietHours()) return;
    const users = this.session.state.kind === 'ready' ? this.session.state.session.users : [];
    const meId = this.session.state.kind === 'ready' ? this.session.state.session.me.id : '';
    if (users.find((u) => u.id === meId)?.availability === 'dnd') return;
    const names = new Map(users.map((u) => [u.id, u.displayName]));
    const wanted = items.filter((i) => !(i.muted && !i.mentioned) && (s.notifyFor !== 'mentions' || i.personal));
    // one notification per conversation, with how many arrived
    const byConv = new Map<string, MissedNotice[]>();
    for (const i of wanted) byConv.set(i.convId, [...(byConv.get(i.convId) ?? []), i]);
    for (const list of byConv.values()) {
      const last = list[list.length - 1];
      let text = last.text;
      if (last.sealed) {
        const opened = await this.e2e.incoming({ id: last.id, convId: last.convId, body: last.body }).catch(() => null);
        text = opened && opened.body && !isSealedText(opened.body) ? opened.body.replace(/<@([0-9A-Z]{26}|all)>/g, (_m, id: string) => `@${id === 'all' ? 'all' : names.get(id) ?? 'someone'}`).slice(0, 200) : 'New encrypted message';
      }
      if (!s.showPreviews) text = 'New message';
      const body = list.length > 1 ? `${list.length} new messages · ${text}` : text || 'New message';
      await Native.showNotification({ title: last.title, body, link: last.link, silent: s.sound === 'none' }).catch(() => {});
    }
  }

  /** Give the background service what it needs to wait for messages on its own (office network). */
  private async configureWatch(): Promise<void> {
    const hub = this.config.hub;
    const s = this.config.settings;
    const ready = this.session.state.kind === 'ready';
    if (!ready || !hub?.fp || !hub.host || !s.closeToTray) { await Native.watchConfig({ on: false }); return; }
    const { token } = await this.session.request('notify.token');
    const host = hub.host.includes(':') ? `[${hub.host}]` : hub.host;
    await Native.watchConfig({
      on: true, url: `https://${host}:${hub.port}`, fingerprint: hub.fp, token,
      notifyFor: s.notifyFor, showPreviews: s.showPreviews, quietFrom: s.quietFrom ?? null, quietTo: s.quietTo ?? null, silent: s.sound === 'none',
    });
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
            const st = this.session.state;
            const outside = st.kind === 'ready' && st.via === 'remote';
            if (cur && cur.hubId === b.id && cur.fp === b.fp && (cur.host !== h.address || outside) && (st.kind === 'offline' || outside)) {
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
      hub: hub ? { id: hub.hubId, name: hub.name, host: hub.host, port: hub.port, fingerprint: hub.fp, gateway: hub.remote?.url ?? null } : null,
      offices: (this.config.otherHubs ?? []).filter((h) => h.hubId).map((h) => ({ id: h.hubId!, name: h.name ?? h.host })),
      via: cs.kind === 'ready' ? cs.via ?? 'lan' : undefined,
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

  private keptAlive: boolean | null = null;
  private push(): void {
    const s = this.state();
    // stay connected in the background while joined to a hub (Preferences can turn this off)
    const want = !!this.config.hub && this.config.settings.closeToTray;
    if (want !== this.keptAlive && (s.phase === 'ready' || !want)) {
      this.keptAlive = want;
      void Native.keepAlive({ on: want, text: `Connected to ${this.session.state.kind === "ready" ? this.session.state.session.hub.name : "the office"}` }).catch(() => {});
      if (want) void Native.askNotifications().catch(() => {});
    }
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
      onDeepLink: (cb) => {
        // a tapped notification: at launch, then while running
        void Native.takeLaunchLink().then((r) => { if (r.url) cb(r.url); }).catch(() => {});
        const h = Native.addListener('deepLink', (e) => cb(e.url));
        return () => { void h.then((x) => x.remove()); };
      },
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
        } else if (req.pairCode) {
          const p = parsePairCode(req.pairCode);
          if (!p) throw new Error('That pairing code is not complete. Copy all of it, starting with DXP1-.');
          const [host, port] = (p.lan[0] ?? ':0').split(':');
          target = { host, port: Number(port), hubId: p.hubId, name: p.name, fp: p.fp, ...(p.url ? { remote: { url: p.url, hubId: p.hubId } } : {}) };
          this.session.setPair(p.token);
        } else if (req.setupCode) {
          const r = parseSetupCode(req.setupCode);
          if (!r) throw new Error('That setup code is not complete. Copy all of it, starting with DXC1-.');
          target = { host: '', port: 0, hubId: r.hubId, name: r.name, fp: r.fp, remote: { url: r.url, hubId: r.hubId } };
        }
        if (!target) throw new Error('That hub could not be found. Check the address and try again.');
        this.config.hub = target;
        await this.save();
        this.session.setAccount(this.account);
        this.session.connect(target);
      },
      addOffice: async () => {
        this.stashOffice();
        this.session.disconnect();
        this.config.hub = null;
        await this.save();
        this.push();
      },
      switchOffice: async (hubId: string) => {
        const next = (this.config.otherHubs ?? []).find((h) => h.hubId === hubId);
        if (!next) throw new Error('That office is not on this phone any more.');
        this.stashOffice();
        this.config.otherHubs = (this.config.otherHubs ?? []).filter((h) => h.hubId !== hubId);
        this.config.hub = next;
        await this.save();
        this.e2e.reset();
        this.session.connect(next);
      },
      removeOffice: async (hubId: string) => {
        this.config.otherHubs = (this.config.otherHubs ?? []).filter((h) => h.hubId !== hubId);
        await this.save();
        this.push();
      },
      forgetHub: async () => {
        this.session.disconnect();
        this.config.hub = null;
        await this.save();
        this.push();
      },
      rescan: async () => { /* the discovery loop runs continuously */ },
      readClipboard: async () => (await Native.clipboardText().catch(() => ({ text: null }))).text ?? '',
      request: async <K extends OpName>(op: K, data?: Ops[K]['req']) => {
        const out = await this.e2e.outgoing(op, data) as Ops[K]['req'];
        return this.e2e.incoming(await this.session.request(op, out));
      },
      e2eStatus: (convId: string) => this.e2e.status(convId),
      // files: downloaded once into the app's cache through the pinned connection
      uploadFile: async (_uploadId: string, src: { path?: string; data?: ArrayBuffer; name: string; mime?: string; convId?: string }) => {
        if (!src.data) throw new Error('Choose the file again.');
        if (src.data.byteLength > 100 * 1024 * 1024) throw new Error('Files from a phone can be up to 100 MB.');
        // for an end-to-end encrypted Direct conversation the file is encrypted here, chunk by chunk
        const plan = await this.e2e.planUpload(src.convId, { name: src.name, mime: src.mime, size: src.data.byteLength });
        const body = await collect(plan.transform([new Uint8Array(src.data)]));
        const q = plan.path;
        if (this.session.viaGateway) {
          const session = this.session.state.kind === 'ready' ? this.session.state.session : null;
          const r = await this.session.http({ method: 'POST', path: q, headers: { authorization: `Bearer ${session?.fileToken ?? ''}`, 'content-length': String(body.byteLength), 'content-type': 'application/octet-stream' }, body });
          let text = '';
          for await (const part of r.body) text += new TextDecoder().decode(part, { stream: true });
          const json = JSON.parse(text || '{}') as FileInfo & { error?: string };
          if (r.status !== 200) throw new Error(json.error ?? `Upload failed (${r.status}).`);
          return plan.done(json);
        }
        const hub = this.hubAccess();
        const r = await Native.fileUpload({ url: `${hub.base}${q}`, fingerprint: hub.fp, token: hub.token, data: b64Chunked(body) });
        const json = JSON.parse(r.body || '{}') as FileInfo & { error?: string };
        if (r.status !== 200) throw new Error(json.error ?? `Upload failed (${r.status}).`);
        return plan.done(json);
      },
      fileUrl: async (id: string, name: string) => Capacitor.convertFileSrc((await this.fetchFile(id, name)).path),
      openFile: async (id: string, name: string) => { const f = await this.fetchFile(id, name); await Native.openFile({ path: f.path, mime: mimeOf(name) }); },
      saveFile: async (id: string, name: string) => { const f = await this.fetchFile(id, name); return (await Native.saveToDownloads({ path: f.path, name, mime: mimeOf(name) })).path; },
      setSettings: async (patch) => {
        Object.assign(this.config.settings, patch);
        await this.save();
        this.push();
        if (patch.updateChannel) void this.checkForUpdates(false);
        // the background service follows the notification preferences too
        if ('closeToTray' in patch || 'notifyFor' in patch || 'showPreviews' in patch || 'quietFrom' in patch || 'sound' in patch) void this.configureWatch().catch(() => {});
        return this.config.settings;
      },
      phone: {
        notifyHealth: () => Native.notifyHealth(),
        openSettings: async (page) => (await Native.openSettings({ target: page })).opened,
        requestBatteryExemption: async () => { await Native.requestBatteryExemption(); },
        askNotifications: () => Native.askNotifications(),
      },
      notify: (title: string, body: string, link?: string) => {
        void Native.showNotification({ title, body, link, silent: this.config.settings.sound === 'none' }).catch(() => {});
      },
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
