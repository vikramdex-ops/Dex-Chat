// The iPhone web app's service worker (built to sw.js beside the app by vite.config.ts):
// - the app shell is kept on the iPhone, so the app opens at once, and without a connection opens
//   to its own "Reaching the office" screen instead of Safari's error page;
// - every build has its own cache, named after the build: when the office updates its gateway, the
//   new app waits until the person taps Reload (the old one keeps working until then);
// - Web Push: shows the notification the hub sent (encrypted to this iPhone), sets the Home Screen
//   badge, and a tap opens the conversation.
// Typed without the WebWorker library (the project compiles with the DOM one): the few service
// worker types it uses are declared here.
import { noticeFor, openUrl } from './notice.ts';

declare const __APP_VERSION__: string;
declare const __PRECACHE__: string[];

interface ExtendableEvent extends Event { waitUntil(p: Promise<unknown>): void }
interface FetchEvent extends ExtendableEvent { request: Request; respondWith(r: Response | Promise<Response>): void }
interface PushEvent extends ExtendableEvent { data: { json(): unknown; text(): string } | null }
interface NotificationEvent extends ExtendableEvent { notification: Notification & { data: { link?: string | null } | null } }
interface WindowClient { url: string; focus(): Promise<WindowClient>; postMessage(m: unknown): void; navigate?(url: string): Promise<WindowClient | null> }
interface Scope {
  registration: ServiceWorkerRegistration;
  clients: { matchAll(o: { type: 'window'; includeUncontrolled: boolean }): Promise<WindowClient[]>; openWindow(url: string): Promise<WindowClient | null>; claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', fn: (e: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', fn: (e: FetchEvent) => void): void;
  addEventListener(type: 'push', fn: (e: PushEvent) => void): void;
  addEventListener(type: 'notificationclick', fn: (e: NotificationEvent) => void): void;
  addEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
}
const sw = self as unknown as Scope;
const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };

const BASE = new URL('./', sw.registration.scope).pathname;
const CACHE = `dexconnect-app-${__APP_VERSION__}`;

sw.addEventListener('install', (e) => {
  // each file on its own: one that fails to load (a gateway mid-update) must not cost the app its offline copy and
  // its notifications; only the page itself is required, and anything missed is cached when it is first used
  e.waitUntil(caches.open(CACHE).then(async (c) => {
    await c.add(BASE);
    await Promise.allSettled(__PRECACHE__.filter((p) => p !== '').map((p) => c.add(`${BASE}${p}`)));
  }));
  // the first install takes over at once; an update waits for the person's Reload (message below)
});

sw.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('dexconnect-app-') && k !== CACHE) await caches.delete(k);
    await sw.clients.claim();
  })());
});

sw.addEventListener('message', (e) => {
  if ((e.data as { type?: string } | null)?.type === 'skip-waiting') void sw.skipWaiting();
});

sw.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(BASE)) return;
  if (req.mode === 'navigate') {
    // the page: the network first (a new app is found at once), this build's copy when offline
    e.respondWith(fetch(req).then((r) => (r.ok ? r : caches.match(BASE).then((c) => c ?? r))).catch(async () => (await caches.match(BASE)) ?? new Response('Offline', { status: 503 })));
    return;
  }
  if (url.pathname.startsWith(`${BASE}assets/`) || url.pathname.startsWith(`${BASE}pdfjs/`)) {
    // named after their content: kept once fetched (parts of the app loaded only when used, too)
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok) { const c = await caches.open(CACHE); await c.put(req, r.clone()); }
      return r;
    })());
  }
});

sw.addEventListener('push', (e) => {
  let data: unknown = null;
  try { data = e.data?.json() ?? null; } catch { data = null; }
  const n = noticeFor(data, BASE);
  e.waitUntil((async () => {
    // the app is on screen: it shows the message itself (pushes only go while it is in the background, but timing can cross)
    const open = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visible = open.some((c) => (c as WindowClient & { visibilityState?: string }).visibilityState === 'visible');
    if (n.badge !== null) await (n.badge > 0 ? nav.setAppBadge?.(n.badge) : nav.clearAppBadge?.())?.catch(() => {});
    // Safari requires a notification for every push, so it is shown even then (and replaced by the next one)
    await sw.registration.showNotification(n.title, { ...n.options, silent: n.options.silent || visible } as NotificationOptions);
  })());
});

sw.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const link = e.notification.data?.link ?? null;
  e.waitUntil((async () => {
    const list = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = list.find((c) => new URL(c.url).pathname.startsWith(BASE));
    if (client) {
      await client.focus().catch(() => {});
      if (link) client.postMessage({ type: 'open', link });
      return;
    }
    await sw.clients.openWindow(openUrl(BASE, link));
  })());
});
