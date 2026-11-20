// The phone app's own code (apps/mobile: its bridge and the shared UI) in Chromium at phone size,
// with a stand-in for the native DexNative plugin, as phone-sec.mts does, plus what the update and
// reconnect walks need: the gateway's binary WebSocket (gwOpen/gwSend), native feed requests and
// downloads (with a switch that makes the internet unreachable, as GitHub is on some mobile
// networks), the update file writer (updateResume/updateWrite, with the native side's checks),
// and the Network Information API (Wi-Fi or mobile data). What it cannot cover: the Java side.
//
// Switches, from a script: window.__F.offline (no network at all), window.__F.blockInternet (only
// 127.0.0.1 answers), window.__F.drop() (every socket closes, as when Android cut it), and
// localStorage 'mock.offline' = '1' to start offline after a reload.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DIST = path.join(ROOT, 'apps/mobile/dist');

/** Serves the built phone app (npm run build -w @dex/mobile). */
export async function servePhoneApp(): Promise<{ url: string; close: () => void }> {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('Build the phone app first: npm run build -w @dex/mobile');
  const server = http.createServer((req, res) => {
    const p = path.join(DIST, decodeURIComponent((req.url ?? '/').split('?')[0]));
    const file = p.startsWith(DIST) && fs.existsSync(p) && fs.statSync(p).isFile() ? p : path.join(DIST, 'index.html');
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : file.endsWith('.woff2') ? 'font/woff2' : file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, close: () => server.close() };
}

export interface PhoneMockOptions {
  /** The hub's certificate fingerprint, reported for the office-network sockets. */
  fp: string;
  appVersion?: string;
  network?: 'wifi' | 'cellular';
  blockInternet?: boolean;
}

/** Install the stand-in before the page's scripts run (survives reloads). */
export async function installPhoneMock(page: { addInitScript: (fn: (o: PhoneMockOptions) => void, arg: PhoneMockOptions) => Promise<void> }, opts: PhoneMockOptions): Promise<void> {
  await page.addInitScript((o: PhoneMockOptions) => {
    const listeners: Record<string, Array<(d: unknown) => void>> = {};
    const emit = (ev: string, d: unknown) => (listeners[ev] ?? []).forEach((fn) => fn(d));
    const files = new Map<string, Uint8Array>();
    const sockets = new Map<string, WebSocket>();
    const ub64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const tb64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
    const cat = (a: Uint8Array, b: Uint8Array) => { const r = new Uint8Array(a.length + b.length); r.set(a); r.set(b, a.length); return r; };
    const sha512 = async (u: Uint8Array) => tb64(new Uint8Array(await crypto.subtle.digest('SHA-512', u as BufferSource)));
    const local = (url: string) => /^(https?|wss?):\/\/(127\.0\.0\.1|localhost)[:/]/.test(url);
    const reachable = (url: string) => { if (F.offline) throw new Error('Network is unreachable'); if (F.blockInternet && !local(url)) throw new Error(`Unable to resolve host "${new URL(url).host}"`); };
    let offlineAtStart = false;
    try { offlineAtStart = localStorage.getItem('mock.offline') === '1'; } catch { /* none */ }
    const conn = { type: o.network ?? 'wifi', fns: [] as Array<() => void>, addEventListener(_t: string, fn: () => void) { conn.fns.push(fn); } };
    Object.defineProperty(navigator, 'connection', { configurable: true, get: () => conn });
    const F: any = {
      offline: offlineAtStart, blockInternet: !!o.blockInternet, notes: [] as unknown[], connected: null, cursor: null as string | null, keepAlive: null, watch: null,
      requests: [] as string[], downloads: [] as string[], installed: [] as string[], writes: 0, files, sockets, conn,
      health: { notifications: true, batteryExempt: true, backgroundRestricted: false, maker: 'other', manufacturer: 'Samsung', model: 'Galaxy M34', androidVersion: '14', autostartPage: false, keepAlive: true, serviceRunning: true, watching: true, lastOk: null, lastError: null },
      drop() { for (const [id, ws] of sockets) { sockets.delete(id); ws.close(); emit('wsClose', { id, reason: 'network lost' }); } },
      setNetwork(type: string) { conn.type = type; conn.fns.forEach((fn) => fn()); },
      // ---- the plugin's methods
      discover: async () => ({ hubs: [] }),
      deviceInfo: async () => ({ model: 'Galaxy M34', manufacturer: 'Samsung', androidVersion: '14', appVersion: o.appVersion ?? '0.1.0' }),
      wsOpen: async ({ id, url }: { id: string; url: string }) => {
        reachable(url);
        const ws = new WebSocket(url);
        sockets.set(id, ws);
        ws.onopen = () => emit('wsOpen', { id, fingerprint: o.fp });
        ws.onmessage = (e) => emit('wsMessage', { id, data: e.data });
        ws.onclose = () => { if (sockets.delete(id)) emit('wsClose', { id, reason: 'connection closed' }); };
      },
      wsSend: async ({ id, data }: { id: string; data: string }) => { sockets.get(id)?.send(data); },
      wsClose: async ({ id }: { id: string }) => { const ws = sockets.get(id); sockets.delete(id); ws?.close(); },
      gwOpen: async ({ id, url }: { id: string; url: string }) => {
        reachable(url);
        const ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';
        sockets.set(id, ws);
        ws.onopen = () => emit('gwOpen', { id });
        ws.onmessage = (e) => emit('gwBinary', { id, data: tb64(new Uint8Array(e.data as ArrayBuffer)) });
        ws.onclose = () => { if (sockets.delete(id)) emit('wsClose', { id, reason: 'connection closed' }); };
      },
      gwSend: async ({ id, data }: { id: string; data: string }) => { sockets.get(id)?.send(ub64(data)); },
      httpGet: async ({ url }: { url: string }) => { F.requests.push(url); reachable(url); const r = await fetch(url, { cache: 'no-store' }); return { status: r.status, body: await r.text() }; },
      fileGet: async ({ url, token, id, name }: { url: string; token: string; id: string; name: string }) => {
        reachable(url);
        const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
        if (!r.ok) throw new Error(`Download failed (HTTP ${r.status})`);
        const p = `/files/${id}/${name}`;
        files.set(p, new Uint8Array(await r.arrayBuffer()));
        return { path: p };
      },
      fileUpload: async ({ url, token, data }: { url: string; token: string; data: string }) => {
        reachable(url);
        const r = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body: ub64(data) });
        return { status: r.status, body: await r.text() };
      },
      fileRead: async ({ path, offset, length }: { path: string; offset: number; length: number }) => {
        const f = files.get(path);
        if (!f) throw new Error('The file is missing.');
        const part = f.subarray(offset, offset + length);
        return { data: tb64(part), eof: offset + part.length >= f.length };
      },
      fileWrite: async ({ id, name, data, first, done }: { id: string; name: string; data: string; first?: boolean; done?: boolean }) => {
        const part = `/files/${id}/${name}.part`;
        if (data) files.set(part, first ? ub64(data) : cat(files.get(part) ?? new Uint8Array(), ub64(data)));
        else if (first) files.set(part, new Uint8Array());
        if (!done) return {};
        const p = `/files/${id}/${name}`;
        files.set(p, files.get(part)!); files.delete(part);
        return { path: p };
      },
      fileDelete: async ({ path }: { path: string }) => { files.delete(path); },
      // ---- updates, with the native side's rules: only cache/updates, size and SHA-512 checked
      download: async ({ url, file, size, sha512: want }: { url: string; file: string; size: number; sha512: string }) => {
        F.downloads.push(url);
        reachable(url);
        const r = await fetch(url);
        if (!r.ok) throw new Error(`Download failed (HTTP ${r.status})`);
        const b = new Uint8Array(await r.arrayBuffer());
        if (b.length !== size) throw new Error('The download was incomplete; it will resume.');
        if ((await sha512(b)) !== want) throw new Error('The downloaded update failed its integrity check and was discarded.');
        files.set(`/cache/updates/${file}`, b);
        return { path: `/cache/updates/${file}` };
      },
      updateResume: async ({ file, size, sha512: want }: { file: string; size: number; sha512: string }) => {
        const dest = files.get(`/cache/updates/${file}`);
        if (dest && dest.length === size && (await sha512(dest)) === want) return { offset: size, path: `/cache/updates/${file}` };
        const part = files.get(`/cache/updates/${file}.part`);
        return { offset: part && part.length < size ? part.length : 0 };
      },
      updateWrite: async ({ file, size, sha512: want, offset, data, done }: { file: string; size: number; sha512: string; offset: number; data: string; done?: boolean }) => {
        F.writes++;
        const key = `/cache/updates/${file}.part`;
        const have = files.get(key)?.length ?? 0;
        if (offset !== 0 && offset !== have) throw new Error('The download went out of order; it will resume.');
        const bytes = data ? ub64(data) : new Uint8Array();
        if (offset + bytes.length > size) { files.delete(key); throw new Error('The download is larger than expected.'); }
        const now = offset === 0 ? bytes : cat(files.get(key) ?? new Uint8Array(), bytes);
        files.set(key, now);
        if (!done) return { received: now.length };
        if (now.length !== size) throw new Error('The download was incomplete; it will resume.');
        if ((await sha512(now)) !== want) { files.delete(key); throw new Error('The downloaded update failed its integrity check and was discarded.'); }
        files.set(`/cache/updates/${file}`, now); files.delete(key);
        return { received: now.length, path: `/cache/updates/${file}` };
      },
      installApk: async ({ path }: { path: string }) => { if (!path.startsWith('/cache/updates/') || !files.has(path)) throw new Error('The update file is missing.'); F.installed.push(path); },
      // ---- the rest
      openFile: async () => {},
      saveToDownloads: async ({ name }: { name: string }) => ({ path: `Downloads/Dexterity Connect/${name}` }),
      showNotification: async (n: unknown) => { F.notes.push(n); },
      keepAlive: async (x: { on: boolean }) => { F.keepAlive = x.on; },
      askNotifications: async () => {},
      takeLaunchLink: async () => ({ url: null }),
      clipboardText: async () => ({ text: null }),
      secureGet: async ({ key }: { key: string }) => { const v = localStorage.getItem(`keystore.${key}`); return { value: v === null ? null : atob(v) }; },
      secureSet: async ({ key, value }: { key: string; value: string }) => { localStorage.setItem(`keystore.${key}`, btoa(value)); },
      notifyHealth: async () => ({ ...F.health }),
      openSettings: async ({ target }: { target: string }) => ({ opened: target }),
      requestBatteryExemption: async () => ({ opened: 'battery' }),
      watchConfig: async (x: unknown) => { F.watch = x; },
      setConnected: async (x: { connected: boolean; cursor?: string }) => { F.connected = x.connected; if (x.cursor && (!F.cursor || x.cursor > F.cursor)) F.cursor = x.cursor; },
      watchCursor: async () => ({ cursor: F.cursor }),
    };
    (window as any).__F = F;
    const methods = Object.keys(F).filter((k) => typeof F[k] === 'function' && k !== 'drop' && k !== 'setNetwork');
    (window as any).Capacitor = {
      PluginHeaders: [{ name: 'DexNative', methods: [...methods.map((name) => ({ name, rtype: 'promise' })), { name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'promise' }] }],
      nativePromise: (_plugin: string, method: string, options: unknown) => Promise.resolve().then(() => (method === 'removeListener' ? undefined : F[method](options ?? {}))),
      nativeCallback: (_plugin: string, method: string, options: { eventName: string }, cb: (d: unknown) => void) => {
        if (method === 'addListener') (listeners[options.eventName] ??= []).push(cb);
        return `cb-${Math.random()}`;
      },
      convertFileSrc: (p: string) => { const f = files.get(p); return f ? URL.createObjectURL(new Blob([f as BlobPart])) : p; },
    };
  }, opts);
}

/** Pretend Android sent the app to the background, or brought it back. */
export async function setHidden(page: { evaluate: (fn: (h: boolean) => void, arg: boolean) => Promise<void> }, hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}
