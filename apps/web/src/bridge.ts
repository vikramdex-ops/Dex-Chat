// The iPhone web app's implementation of the bridge the shared UI talks to (the Android app's is
// apps/mobile/src/bridge.ts). Everything here is a browser API: the office is reached through its
// internet gateway with the browser's own WebSocket, inside the end-to-end encrypted channel
// pinned to the hub's certificate (packages/core/src/remote.ts); the device keys are kept in this
// app's IndexedDB; files travel through the same channel and are handed to iOS's share sheet;
// notifications are Web Push (sw.ts receives them; the hub sends them, apps/hub/src/webpush.ts).
import { b64 as b64Chunked, createEncKeys } from '@dex/core/e2e';
import type { EncKeyPair } from '@dex/core/e2e';
import { DAMAGED_FILE } from '@dex/core/e2e-files';
import { E2EClient } from '@dex/core/e2e-client';
import { ed25519, sha256 } from '@dex/core/noble';
import type { FileInfo, OpName, Ops, WindowsAccount } from '@dex/core/protocol';
import { HubSession } from '@dex/core/session';
import type { ClientState, HubTarget } from '@dex/core/session';
import { openRemoteSocket } from '@dex/core/remote';
import { SETTINGS_EXTRA_DEFAULTS, type AppState, type DexBridge, type JoinRequest, type Phase, type Settings, type UpdateState, type WebPushState } from '../../desktop/src/shared/bridge.ts';
import { codeFromHash, deviceName, deviceOf, openFromHash, webTarget } from './pair.ts';
import { kv, persist } from './store.ts';

declare const __APP_VERSION__: string;
/** The app's version: the web app's build, named after its content (vite.config.ts). */
const VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev';
const BASE = new URL('./', location.href).pathname;

const b64 = (u: Uint8Array) => b64Chunked(u);
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const SPKI_PREFIX = Uint8Array.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);
const urlB64 = (u: Uint8Array) => b64(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromUrlB64 = (s: string) => { const t = s.replace(/-/g, '+').replace(/_/g, '/'); return unb64(t + '='.repeat((4 - (t.length % 4)) % 4)); };

interface WebIdentity { deviceId: string; publicKey: string; secret: string }

async function loadOrMake<T>(key: string, valid: (v: unknown) => v is T, create: () => T): Promise<T> {
  const v = await kv.get<T>(key).catch(() => undefined);
  if (valid(v)) return v;
  const fresh = create();
  await kv.set(key, fresh);
  return fresh;
}

const loadIdentity = () => loadOrMake<WebIdentity>('device-key',
  (v): v is WebIdentity => !!v && typeof (v as WebIdentity).deviceId === 'string' && /^[0-9a-f]{32}$/.test((v as WebIdentity).deviceId) && typeof (v as WebIdentity).secret === 'string',
  () => {
    const secret = ed25519.utils.randomSecretKey();
    const spki = new Uint8Array([...SPKI_PREFIX, ...ed25519.getPublicKey(secret)]);
    return { deviceId: hex(sha256(spki)).slice(0, 32), publicKey: b64(spki), secret: b64(secret) };
  });

const loadEncKeys = () => loadOrMake<EncKeyPair>('device-enc',
  (v): v is EncKeyPair => !!v && typeof (v as EncKeyPair).secret === 'string' && !!(v as EncKeyPair).secret && typeof (v as EncKeyPair).public === 'string',
  createEncKeys);

interface WebConfig {
  hub: HubTarget | null;
  displayName: string | null;
  settings: Settings;
  lastRunVersion?: string;
  otherHubs?: HubTarget[];
  push?: boolean;
}

const DEFAULTS: WebConfig = {
  hub: null, displayName: null,
  settings: { theme: 'system', startAtLogin: false, updateChannel: 'stable', autoDownloadUpdates: true, ...SETTINGS_EXTRA_DEFAULTS, closeToTray: true },
};

const MIME: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  txt: 'text/plain', csv: 'text/csv', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', zip: 'application/zip', mp4: 'video/mp4', mov: 'video/quicktime',
  webm: 'audio/webm', m4a: 'audio/mp4', mp3: 'audio/mpeg', dwg: 'image/vnd.dwg',
};
const mimeOf = (name: string) => MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

/** Files fetched this session, kept in memory up to this size (oldest dropped first). */
const CACHE_BYTES = 160 * 1024 * 1024;
const MAX_UPLOAD = 100 * 1024 * 1024;

const standalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

class WebApp {
  private session!: HubSession;
  private config!: WebConfig;
  private identity!: WebIdentity;
  private e2e!: E2EClient;
  private events: Promise<void> = Promise.resolve();
  private account!: WindowsAccount;
  private readonly device = deviceOf(navigator.userAgent, navigator.maxTouchPoints);
  private readonly listeners = { state: new Set<(s: AppState) => void>(), event: new Set<(n: string, d: unknown) => void>(), link: new Set<(url: string) => void>() };
  private update: UpdateState = { phase: 'up-to-date', currentVersion: VERSION, lastCheck: null, available: null, progress: null, error: null, justUpdated: null };
  /** A pairing code the page was opened with (the get page sends iPhones here with it in the #fragment). */
  private pending: string | null = null;
  private links: string[] = [];
  private linksUntil: number | null = null;
  private reg: ServiceWorkerRegistration | null = null;

  async init(): Promise<void> {
    // the code and any notification link come in the #fragment, which never reaches a server; take them out of the address
    this.pending = codeFromHash(location.hash);
    const open = openFromHash(location.hash);
    if (open) this.links.push(open);
    if (this.pending || open) history.replaceState(null, '', location.pathname + location.search);

    this.identity = await loadIdentity();
    const encKeys = await loadEncKeys();
    const signSecret = unb64(this.identity.secret);
    this.e2e = new E2EClient({
      deviceId: this.identity.deviceId, encSecret: encKeys.secret, encPublic: encKeys.public,
      sign: (p) => b64(ed25519.sign(p, signSecret)),
      request: (op, data) => this.session.request(op as OpName, data as never),
      nameOf: (id) => (this.session.state.kind === 'ready' ? this.session.state.session.users.find((u) => u.id === id)?.displayName : undefined),
    });
    const c = (await kv.get<Partial<WebConfig>>('config').catch(() => undefined)) ?? {};
    this.config = { ...DEFAULTS, ...c, settings: { ...DEFAULTS.settings, ...c.settings } };
    this.account = {
      domain: 'PHONE', username: `phone-${this.identity.deviceId.slice(0, 8)}`,
      displayName: this.config.displayName ?? '', hostname: deviceName(this.device),
    };
    if (this.config.lastRunVersion && this.config.lastRunVersion !== VERSION) {
      this.update.justUpdated = { version: VERSION, notes: 'Your office updated Dexterity Connect for iPhone.' };
    }
    this.config.lastRunVersion = VERSION;
    await this.save();
    void persist();

    this.session = this.newSession();
    if (this.config.hub) this.session.connect(this.config.hub);
    void this.registerWorker();
    document.addEventListener('visibilitychange', () => this.onVisibility());
    // a link to the app opened while it runs (a notification's, or a new pairing code)
    addEventListener('hashchange', () => {
      const link = openFromHash(location.hash);
      const code = codeFromHash(location.hash);
      if (!link && !code) return;
      history.replaceState(null, '', location.pathname + location.search);
      if (link) this.deliverLink(link);
      if (code && !this.config.hub) { this.pending = code; this.deliverLink(`dexconnect://pair?code=${encodeURIComponent(code)}`); }
    });
    addEventListener('online', () => { if (this.config.hub && this.session.state.kind === 'offline') this.session.connect(this.config.hub); });
  }

  private async save(): Promise<void> { await kv.set('config', this.config); }

  // ---------------------------------------------------------- service worker: the app shell, updates, notification taps
  private async registerWorker(): Promise<void> {
    if (!('serviceWorker' in navigator)) return;
    try {
      this.reg = await navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE });
      const watch = (w: ServiceWorker | null) => {
        if (!w) return;
        const done = () => { if (w.state === 'installed' && navigator.serviceWorker.controller) this.updateWaiting(); };
        w.addEventListener('statechange', done);
        done();
      };
      if (this.reg.waiting && navigator.serviceWorker.controller) this.updateWaiting();
      watch(this.reg.installing);
      this.reg.addEventListener('updatefound', () => watch(this.reg!.installing));
      navigator.serviceWorker.addEventListener('message', (e) => {
        const m = e.data as { type?: string; link?: string } | null;
        if (m?.type === 'open' && typeof m.link === 'string') this.deliverLink(m.link);
      });
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (this.update.phase === 'installing' && !reloading) { reloading = true; location.reload(); } });
      // a new gateway bundle means a new app: look now and then, and whenever the app comes back
      setInterval(() => void this.reg?.update().catch(() => {}), 60 * 60 * 1000);
    } catch { /* no service worker (a private window): the app still works while online */ }
  }

  private updateWaiting(): void {
    this.setUpdate({ phase: 'ready', available: { version: 'new', notes: '', releasedAt: new Date().toISOString(), mandatory: false, size: 0, source: 'hub' }, lastCheck: Date.now() });
  }

  private deliverLink(link: string): void {
    if (this.listeners.link.size) for (const fn of this.listeners.link) fn(link);
    else this.links.push(link);
  }

  private onVisibility(): void {
    const visible = !document.hidden;
    if (this.session.state.kind === 'ready') {
      void this.session.request('me.idle', { idle: !visible }).catch(() => {});
      // in the background an iPhone stops the page soon: from now on the hub pushes instead
      if (this.config.push) void this.session.request('push.active', { active: visible }).catch(() => {});
    }
    if (visible) {
      void this.reg?.update().catch(() => {});
      void (navigator as Navigator & { clearAppBadge?: () => Promise<void> }).clearAppBadge?.().catch(() => {});
      // notifications for what is now on screen are done with
      void this.reg?.getNotifications().then((list) => list.forEach((n) => n.close())).catch(() => {});
      if (this.config.hub && this.session.state.kind === 'offline') this.session.connect(this.config.hub);
    }
  }

  // ---------------------------------------------------------- the connection: always the gateway
  private newSession(): HubSession {
    const secret = unb64(this.identity.secret);
    const s = new HubSession({
      deviceId: this.identity.deviceId,
      publicKey: this.identity.publicKey,
      sign: (payload) => b64(ed25519.sign(payload, secret)),
      account: this.account,
      // a browser cannot reach the hub on the office network (its certificate is the office's own)
      open: (_t, h) => { setTimeout(() => h.onClose('A browser cannot reach the office network directly.'), 0); return { send: () => {}, close: () => {} }; },
      openRemote: (target, h) => openRemoteSocket((url, rh) => {
        let ws: WebSocket;
        try { ws = new WebSocket(url); } catch (e) { setTimeout(() => rh.onClose((e as Error).message), 0); return { send: () => {}, close: () => {} }; }
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => rh.onOpen();
        ws.onmessage = (e) => { if (e.data instanceof ArrayBuffer) rh.onBinary(new Uint8Array(e.data)); };
        ws.onclose = (e) => rh.onClose(e.reason || (navigator.onLine ? 'The office could not be reached.' : 'This iPhone is offline.'));
        ws.onerror = () => { /* close follows */ };
        return { send: (data) => { if (ws.readyState === 1) ws.send(data as Uint8Array<ArrayBuffer>); }, close: () => ws.close() };
      }, target as HubTarget & { remote: { url: string; hubId: string } }, h),
    });
    s.on('state', (st: ClientState) => {
      if (st.kind === 'ready' || st.kind === 'pending') { this.config.hub = { ...st.target, host: '', port: 0 }; void this.save(); }
      if (st.kind === 'ready' || st.kind === 'rejected') s.setPair('');
      if (st.kind === 'ready') {
        void this.e2e.ready(st.session.me.id, st.session.users.filter((u) => u.role === 'bot').map((u) => u.id)).catch(() => {});
        void this.refreshPush().catch(() => {});
        if (this.config.push) void s.request('push.active', { active: !document.hidden }).catch(() => {});
      }
      if (st.kind === 'offline') this.e2e.reset();
      this.push();
    });
    s.on('pinned', (t: HubTarget) => { this.config.hub = { ...t, host: '', port: 0 }; void this.save(); });
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

  private stashOffice(): void {
    const cur = this.config.hub;
    if (!cur?.hubId) return;
    const name = this.session.state.kind === 'ready' ? this.session.state.session.hub.name : cur.name;
    this.config.otherHubs = [{ ...cur, name }, ...(this.config.otherHubs ?? []).filter((h) => h.hubId !== cur.hubId)].slice(0, 8);
  }

  // ---------------------------------------------------------- files: through the encrypted channel, kept in memory
  private readonly files = new Map<string, Promise<Blob>>();
  private readonly urls = new Map<string, string>();
  private readonly sizes = new Map<string, number>();

  private async download(id: string): Promise<Blob> {
    const session = this.session.state.kind === 'ready' ? this.session.state.session : null;
    if (!session) throw new Error('The office hub is not connected.');
    const r = await this.session.http({ method: 'GET', path: `/files/${id}?download=1`, headers: { authorization: `Bearer ${session.fileToken}` } });
    if (r.status !== 200) { for await (const _ of r.body) { /* drain */ } throw new Error(r.status === 404 ? 'This file is no longer available.' : `Download failed (${r.status})`); }
    const decrypt = this.e2e.downloadTransform(id);
    const parts: BlobPart[] = [];
    try {
      for await (const part of decrypt ? decrypt(r.body) : r.body) parts.push(part.slice() as Uint8Array<ArrayBuffer>);
    } catch (e) {
      throw new Error((e as Error).message === DAMAGED_FILE ? DAMAGED_FILE : `Download interrupted: ${(e as Error).message}`);
    }
    return new Blob(parts);
  }

  private fetchFile(id: string, name: string): Promise<Blob> {
    let p = this.files.get(id);
    if (!p) {
      p = this.download(id).then((b) => new Blob([b], { type: mimeOf(name) }));
      this.files.set(id, p);
      p.then((b) => { this.sizes.set(id, b.size); this.trim(); }, () => this.files.delete(id));
    } else {
      // most recently used last
      this.files.delete(id); this.files.set(id, p);
    }
    return p;
  }

  private trim(): void {
    let total = [...this.sizes.values()].reduce((n, s) => n + s, 0);
    for (const id of this.files.keys()) {
      if (total <= CACHE_BYTES) break;
      const size = this.sizes.get(id);
      if (size === undefined) continue;
      total -= size;
      this.files.delete(id); this.sizes.delete(id);
      const u = this.urls.get(id);
      if (u) { URL.revokeObjectURL(u); this.urls.delete(id); }
    }
  }

  /** iOS's share sheet (Open in…, Save to Files, AirDrop); a download where the sheet cannot open. */
  private async handOver(id: string, name: string, prefer: 'share' | 'download'): Promise<string> {
    const blob = await this.fetchFile(id, name);
    const file = new File([blob], name, { type: blob.type });
    if (prefer === 'share' && navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return 'shared'; }
      catch (e) {
        if ((e as Error).name === 'AbortError') return 'cancelled';
        // the tap was too long ago (a large file took a while): fall through to a download
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    return 'Files ▸ Downloads';
  }

  // ---------------------------------------------------------- notifications (Web Push)
  private pushSupported(): boolean {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  async pushState(): Promise<WebPushState> {
    if (!this.pushSupported()) return this.device !== 'other' && !standalone() ? 'not-installed' : 'unsupported';
    if (this.device !== 'other' && !standalone()) return 'not-installed';
    if (Notification.permission === 'denied') return 'denied';
    if (Notification.permission !== 'granted' || !this.config.push) return 'off';
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription().catch(() => null);
    return sub ? 'on' : 'off';
  }

  private prefs() {
    const s = this.config.settings;
    return { notifyFor: s.notifyFor, showPreviews: s.showPreviews, quietFrom: s.quietFrom ?? null, quietTo: s.quietTo ?? null, zone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', silent: s.sound === 'none' };
  }

  /** Subscribe (or refresh the subscription and the preferences the hub applies). */
  private async subscribe(): Promise<void> {
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await this.session.request('push.key');
    let sub = await reg.pushManager.getSubscription();
    const key = sub?.options.applicationServerKey;
    // a subscription made for another office's key cannot carry this office's pushes
    if (sub && key && urlB64(new Uint8Array(key)) !== publicKey) { await sub.unsubscribe().catch(() => {}); sub = null; }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromUrlB64(publicKey) as Uint8Array<ArrayBuffer> });
    const j = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
    await this.session.request('push.subscribe', { endpoint: j.endpoint, keys: j.keys, prefs: this.prefs() });
  }

  private async refreshPush(): Promise<void> {
    if (!this.config.push || !this.pushSupported() || Notification.permission !== 'granted') return;
    await this.subscribe();
  }

  async enablePush(): Promise<WebPushState> {
    const st = await this.pushState();
    if (st === 'unsupported' || st === 'not-installed' || st === 'denied') return st;
    // asked straight from the tap: Safari only asks then
    const answer = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (answer !== 'granted') return answer === 'denied' ? 'denied' : 'off';
    this.config.push = true;
    await this.save();
    await this.subscribe();
    void this.session.request('push.active', { active: !document.hidden }).catch(() => {});
    return 'on';
  }

  async disablePush(): Promise<void> {
    this.config.push = false;
    await this.save();
    await this.session.request('push.unsubscribe').catch(() => {});
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription().catch(() => null);
    await sub?.unsubscribe().catch(() => {});
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
      hubs: [],
      hub: hub ? { id: hub.hubId, name: hub.name, host: hub.host, port: hub.port, fingerprint: hub.fp, gateway: hub.remote?.url ?? null } : null,
      offices: (this.config.otherHubs ?? []).filter((h) => h.hubId).map((h) => ({ id: h.hubId!, name: h.name ?? h.hubId! })),
      via: cs.kind === 'ready' ? 'remote' : undefined,
      session: cs.kind === 'ready' ? cs.session : null,
      pendingPosition: cs.kind === 'pending' ? cs.position : 0,
      retryInMs: cs.kind === 'offline' ? cs.retryInMs : 0,
      error: cs.kind === 'rejected' ? cs.reason : cs.kind === 'identity-mismatch' ? 'The hub presented a different certificate than the one this iPhone trusts.' : cs.kind === 'offline' ? cs.error : null,
      settings: this.config.settings,
      update: this.update,
      platform: 'ios-web',
      version: VERSION,
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

  // ---------------------------------------------------------- bridge
  bridge(): DexBridge {
    return {
      getState: async () => this.state(),
      onState: (cb) => { this.listeners.state.add(cb); return () => this.listeners.state.delete(cb); },
      onHubEvent: (cb) => { this.listeners.event.add(cb); return () => this.listeners.event.delete(cb); },
      onDeepLink: (cb) => {
        this.listeners.link.add(cb);
        // a code the page opened with, and a tapped notification from before the app was drawn
        const code = this.pending && (standalone() || this.bridgeWeb.continued()) ? this.pending : null;
        setTimeout(() => {
          if (code && !this.config.hub) cb(`dexconnect://pair?code=${encodeURIComponent(code)}`);
          // the interface subscribes again as conversations load: a launch link is offered each time
          // until a little after the office is connected (by then its conversation is known)
          if (this.session.state.kind === 'ready') this.linksUntil ??= Date.now() + 8000;
          if (this.linksUntil && Date.now() > this.linksUntil) this.links = [];
          for (const l of this.links) cb(l);
        }, 0);
        return () => { this.listeners.link.delete(cb); };
      },
      join: async (req: JoinRequest) => {
        const name = req.displayName.trim().slice(0, 80);
        this.config.displayName = name || null;
        this.account = { ...this.account, displayName: name || this.account.username };
        const code = req.pairCode ?? req.setupCode;
        if (!code) throw new Error('An iPhone joins with a code from your PC: Preferences → Your devices → Add my phone.');
        const { target, pairToken } = webTarget(code);
        this.session.setPair(pairToken ?? '');
        this.config.hub = target;
        this.pending = null;
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
        if (!next) throw new Error('That office is not on this iPhone any more.');
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
        if (this.config.push) await this.bridgeWeb.disablePush().catch(() => {});
        this.session.disconnect();
        this.config.hub = null;
        await this.save();
        this.push();
      },
      rescan: async () => { /* nothing to look for: the gateway is the only way */ },
      request: async <K extends OpName>(op: K, data?: Ops[K]['req']) => {
        const out = await this.e2e.outgoing(op, data) as Ops[K]['req'];
        return this.e2e.incoming(await this.session.request(op, out));
      },
      e2eStatus: (convId: string) => this.e2e.status(convId),
      uploadFile: async (_uploadId: string, src: { path?: string; data?: ArrayBuffer; name: string; mime?: string; convId?: string }) => {
        if (!src.data) throw new Error('Choose the file again.');
        if (src.data.byteLength > MAX_UPLOAD) throw new Error('Files from a phone can be up to 100 MB.');
        const session = this.session.state.kind === 'ready' ? this.session.state.session : null;
        if (!session) throw new Error('The office hub is not connected.');
        const plan = await this.e2e.planUpload(src.convId, { name: src.name, mime: src.mime, size: src.data.byteLength });
        const parts: Uint8Array[] = [];
        let n = 0;
        for await (const p of plan.transform([new Uint8Array(src.data)])) { parts.push(p); n += p.length; }
        const body = new Uint8Array(n);
        let o = 0;
        for (const p of parts) { body.set(p, o); o += p.length; }
        const r = await this.session.http({ method: 'POST', path: plan.path, headers: { authorization: `Bearer ${session.fileToken}`, 'content-length': String(body.byteLength), 'content-type': 'application/octet-stream' }, body });
        let text = '';
        const dec = new TextDecoder();
        for await (const part of r.body) text += dec.decode(part, { stream: true });
        const json = JSON.parse(text || '{}') as FileInfo & { error?: string };
        if (r.status !== 200) throw new Error(json.error ?? `Upload failed (${r.status}).`);
        return plan.done(json);
      },
      fileUrl: async (id: string, name: string) => {
        const have = this.urls.get(id);
        if (have) return have;
        const u = URL.createObjectURL(await this.fetchFile(id, name));
        this.urls.set(id, u);
        return u;
      },
      openFile: async (id: string, name: string) => { await this.handOver(id, name, 'share'); },
      saveFile: async (id: string, name: string) => this.handOver(id, name, 'download'),
      setSettings: async (patch) => {
        Object.assign(this.config.settings, patch);
        await this.save();
        this.push();
        // the hub applies the notification preferences before it pushes
        if ('notifyFor' in patch || 'showPreviews' in patch || 'quietFrom' in patch || 'quietTo' in patch || 'sound' in patch) void this.refreshPush().catch(() => {});
        return this.config.settings;
      },
      notify: (title: string, body: string, link?: string) => {
        // on screen the app shows it itself; the moment before iOS stops a page in the background, a notification
        if (!document.hidden || !this.reg || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
        void this.reg.showNotification(title, { body, tag: link ?? 'dexconnect', data: { link: link ?? null }, icon: `${BASE}icon-192.png`, silent: this.config.settings.sound === 'none' }).catch(() => {});
      },
      setBadge: (count: number) => {
        const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
        void (count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.())?.catch(() => {});
      },
      web: this.bridgeWeb,
      checkForUpdates: async () => {
        this.setUpdate({ phase: 'checking', error: null });
        try { await this.reg?.update(); } catch { /* offline */ }
        await new Promise((r) => setTimeout(r, 1500));
        if (this.update.phase === 'checking') this.setUpdate({ phase: navigator.onLine ? 'up-to-date' : 'error', error: navigator.onLine ? null : 'This iPhone is offline.', lastCheck: Date.now() });
      },
      downloadUpdate: async () => { /* the new app arrives with the office's gateway update by itself */ },
      installUpdate: async () => {
        const w = this.reg?.waiting;
        if (!w) { location.reload(); return; }
        this.setUpdate({ phase: 'installing' });
        w.postMessage({ type: 'skip-waiting' });
        // the controller changes, and the page reloads into the new app (above); in case it does not
        setTimeout(() => location.reload(), 4000);
      },
      dismissWhatsNew: async () => { this.setUpdate({ justUpdated: null }); },
    };
  }

  private continued = false;
  private readonly bridgeWeb: NonNullable<DexBridge['web']> = {
    device: this.device,
    standalone: standalone(),
    continueInBrowser: () => {
      this.continued = true;
      try { sessionStorage.setItem('dex-continue', '1'); } catch { /* private mode */ }
      if (this.pending && !this.config.hub) this.deliverLink(`dexconnect://pair?code=${encodeURIComponent(this.pending)}`);
      this.push();
    },
    continued: () => { if (!this.continued) { try { this.continued = sessionStorage.getItem('dex-continue') === '1'; } catch { /* private mode */ } } return this.continued; },
    pushState: () => this.pushState(),
    enablePush: () => this.enablePush(),
    disablePush: () => this.disablePush(),
    testPush: () => this.session.request('push.test'),
    pendingCode: () => this.pending,
    pasteCode: async () => (await navigator.clipboard?.readText?.().catch(() => '')) ?? '',
  };
}

export async function installWebBridge(): Promise<void> {
  const app = new WebApp();
  await app.init();
  window.dex = app.bridge();
}
