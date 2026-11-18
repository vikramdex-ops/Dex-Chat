// Dexterity Connect for iPhone (the web app, apps/web) end to end: a real hub and the gateway Worker
// in Cloudflare's local runtime, the built web app served the way the meeting site serves it
// (apps/meet-site/src/app-headers.ts), and Chromium emulating an iPhone (WebKit is not installed
// here). A stand-in push service on this machine receives the hub's Web Push requests; the test
// holds the subscription's private key, so it opens them and checks what they say.
//
//   npm run build -w @dex/web && node apps/desktop/e2e/iphone.mts
//
// Walks: the page opened in Safari shows the Add to Home Screen guide (and copies the code); the
// app "on the Home Screen" pastes the code and joins through the gateway; messages both ways; a
// photo shown inline and a file opened (downloaded through the encrypted channel); notifications
// switched on, a push for a message while the app is in the background, with and without the text;
// a tapped notification's link opening its conversation; Preferences; a code from an office with no
// way in from outside. Screenshots at 390 px light and dark, one in Hindi, and the guide at desktop width.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import pw from 'playwright-core';
import { createIdentity } from '../../../packages/core/src/index.ts';
import { HubClient } from '../../../packages/core/src/hub-client.ts';
import { b64url, decryptPush, verifyVapid } from '../../../packages/core/src/webpush.ts';
import { pairCode } from '../../../packages/core/src/remote.ts';
import { Hub } from '../../../apps/hub/src/hub.ts';
import { appHeaders } from '../../../apps/meet-site/src/app-headers.ts';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const OUT = process.env.IPHONE_OUT ?? path.join(import.meta.dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const free = async () => { const s = net.createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r())); const p = (s.address() as net.AddressInfo).port; await new Promise<void>((r) => s.close(() => r())); return p; };
const step = (s: string) => console.log(`· ${s}`);

const DIST = path.join(ROOT, 'apps/web/dist');
if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('Build the web app first: npm run build -w @dex/web');

// ---- the gateway Worker in Cloudflare's local runtime
const gwPort = await free();
const gw = spawn(path.join(ROOT, 'node_modules/.bin/wrangler'), ['dev', '--ip', '127.0.0.1', '--port', String(gwPort), '--show-interactive-dev-session=false'],
  { cwd: path.join(ROOT, 'apps/gateway'), detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise<void>((res, rej) => {
  const t = setTimeout(() => rej(new Error('wrangler did not start')), 120_000);
  const on = (b: Buffer) => { if (/Ready on/.test(b.toString())) { clearTimeout(t); res(); } };
  gw.stdout!.on('data', on); gw.stderr!.on('data', on);
});
gw.stdout!.resume(); gw.stderr!.resume();
const gwUrl = `http://127.0.0.1:${gwPort}`;

// ---- the meeting site's copy of the app: the built files with the site's headers
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json; charset=utf-8', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.icc': 'application/octet-stream', '.ttf': 'font/ttf' };
const sitePort = await free();
const site = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${sitePort}`);
  if (url.pathname === '/app') { res.writeHead(301, { location: '/app/' }).end(); return; }
  const rel = url.pathname === '/app/' ? 'index.html' : decodeURIComponent(url.pathname.replace(/^\/app\//, ''));
  const file = path.join(DIST, rel);
  if (!url.pathname.startsWith('/app/') || !file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end('Not found'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', ...appHeaders(url.pathname === '/app/' ? '/app/' : url.pathname, `http://127.0.0.1:${sitePort}`) });
  fs.createReadStream(file).pipe(res);
});
await new Promise<void>((r) => site.listen(sitePort, '127.0.0.1', () => r()));
const appUrl = `http://127.0.0.1:${sitePort}/app/`;

// ---- a push service on this machine, and the iPhone's subscription keys for it
const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
const uaPrivate = new Uint8Array(Buffer.from((await crypto.subtle.exportKey('jwk', ua.privateKey)).d!, 'base64url'));
const authSecret = crypto.getRandomValues(new Uint8Array(16));
const pushes: Array<{ headers: http.IncomingHttpHeaders; payload: { title: string; body: string; link?: string; badge?: number; test?: boolean } }> = [];
const pushPort = await free();
const pushSvc = http.createServer((req, res) => {
  const parts: Buffer[] = [];
  req.on('data', (c: Buffer) => parts.push(c));
  req.on('end', () => {
    void decryptPush(new Uint8Array(Buffer.concat(parts)), { publicKey: uaPublic, privateKey: uaPrivate, auth: authSecret })
      .then((plain) => { pushes.push({ headers: req.headers, payload: JSON.parse(new TextDecoder().decode(plain)) }); res.writeHead(201).end(); })
      .catch((e: Error) => { console.log('push not readable', e.message); res.writeHead(400).end(); });
  });
});
await new Promise<void>((r) => pushSvc.listen(pushPort, '127.0.0.1', () => r()));
const endpoint = `http://127.0.0.1:${pushPort}/push/iphone-1`;
const nextPush = async (n: number, ms = 15000) => { const end = Date.now() + ms; while (pushes.length < n) { if (Date.now() > end) throw new Error(`expected push ${n}, have ${pushes.length}`); await sleep(100); } return pushes[n - 1]; };

// ---- the office: a hub only the gateway leads to, Vikram (owner) and Priya on PCs
const dir = fs.mkdtempSync(path.join(OUT, 'hub-iphone-'));
const hub = new Hub({ dataDir: dir, name: 'Dexterity Office', updates: false, holidaySeed: false, discoveryPort: false, host: '127.0.0.1', port: 0, webPush: { allowLocal: true } });
await hub.start();
const client = async (username: string, displayName: string) => {
  const c = new HubClient({ identity: createIdentity(), account: { username, domain: 'DEX', displayName, hostname: `${username.toUpperCase()}-PC` } });
  c.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
  await new Promise<void>((r) => { const on = (s: { kind: string }) => { if (s.kind === 'ready') { c.off('state', on); r(); } }; c.on('state', on); });
  return c;
};
const owner = await client('vikram', 'Vikram Shah');
owner.on('event', (n: string, d: any) => { if (n === 'admin.pending') void owner.request('admin.decide', { deviceId: d.id, approve: true }).catch(() => {}); });
const priya = await client('priya', 'Priya Raman');
await owner.request('admin.remote.set', { url: gwUrl, enabled: true });
for (let i = 0; i < 80 && !(await owner.request('admin.remote.get')).status.connected; i++) await sleep(100);
assert.ok((await owner.request('admin.remote.get')).status.connected, 'the hub is connected to the gateway');

const browser = await pw.chromium.launch();
const iPhone = pw.devices['iPhone 13'];
/** The browser's push subscription points at the push service above (a real one would be Apple's). */
const fakePush = ({ endpoint, p256dh, auth, standalone }: { endpoint: string; p256dh: string; auth: string; standalone: boolean }) => {
  const sub = {
    endpoint, options: { applicationServerKey: null as unknown },
    toJSON: () => ({ endpoint, keys: { p256dh, auth } }),
    unsubscribe: async () => { localStorage.removeItem('fake-sub'); return true; },
  };
  PushManager.prototype.subscribe = async function (o?: PushSubscriptionOptionsInit) { sub.options.applicationServerKey = o?.applicationServerKey; localStorage.setItem('fake-sub', '1'); return sub as unknown as PushSubscription; };
  PushManager.prototype.getSubscription = async function () { return (localStorage.getItem('fake-sub') ? sub : null) as unknown as PushSubscription; };
  // headless Chromium answers "denied" whatever is granted: the iPhone's own question, answered Allow
  Object.defineProperty(Notification, 'permission', { configurable: true, get: () => (localStorage.getItem('fake-perm') ?? 'default') });
  Notification.requestPermission = async () => { localStorage.setItem('fake-perm', 'granted'); return 'granted'; };
  // opened from the Home Screen
  if (standalone) Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true });
};
const newPhone = async (o: { standalone: boolean; width?: number; dark?: boolean; device?: boolean }) => {
  const ctx = await browser.newContext({
    ...(o.device === false ? { viewport: { width: o.width ?? 1440, height: 900 } } : { ...iPhone, viewport: { width: 390, height: 844 } }),
    colorScheme: o.dark ? 'dark' : 'light',
    permissions: ['notifications', 'clipboard-read', 'clipboard-write'],
    acceptDownloads: true,
  });
  await ctx.grantPermissions(['notifications', 'clipboard-read', 'clipboard-write'], { origin: `http://127.0.0.1:${sitePort}` });
  await ctx.addInitScript(fakePush, { endpoint, p256dh: b64url(uaPublic), auth: b64url(authSecret), standalone: o.standalone });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[iphone pageerror]', e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.log('[iphone console]', m.text()); });
  return { ctx, page };
};
// after the cards' entrance animation
const shot = async (page: pw.Page, name: string) => { await sleep(500); await page.screenshot({ path: path.join(OUT, `${name}.png`) }); };
const theme = async (page: pw.Page, t: 'light' | 'dark') => { await page.emulateMedia({ colorScheme: t }); await sleep(250); };

let failPage: pw.Page | null = null;
try {
  const vikramId = owner.session!.me.id;
  const { code } = await owner.request('pair.create', { kind: 'phone' });
  assert.match(code, /^DXP1-/);

  // ---- 1. opened in Safari from the QR code: the Add to Home Screen guide, with the code to copy
  step('Safari: the install guide');
  const safari = await newPhone({ standalone: false });
  failPage = safari.page;
  await safari.page.goto(`${appUrl}#${code}`);
  await safari.page.getByRole('heading', { name: 'Add Dexterity Connect to your iPhone' }).waitFor({ timeout: 30000 });
  assert.equal(new URL(safari.page.url()).hash, '', 'the code is taken out of the address');
  await shot(safari.page, 'iphone-01-install-guide-light');
  await theme(safari.page, 'dark');
  await shot(safari.page, 'iphone-01-install-guide-dark');
  await theme(safari.page, 'light');
  await safari.page.getByRole('button', { name: 'Copy the code' }).click();
  await safari.page.getByRole('button', { name: 'Copied' }).waitFor();
  assert.equal(await safari.page.evaluate(() => navigator.clipboard.readText()), code);
  // the page's manifest and icons, as Safari reads them for the Home Screen
  const manifest = await safari.page.evaluate(async () => (await fetch(document.querySelector<HTMLLinkElement>('link[rel=manifest]')!.href)).json());
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/app/');
  assert.ok(await safari.page.evaluate(async () => (await fetch(document.querySelector<HTMLLinkElement>('link[rel=apple-touch-icon]')!.href)).ok));
  assert.ok(await safari.page.locator('link[rel=apple-touch-startup-image]').count() >= 20);
  // every file the app keeps for offline use exists (one missing file used to cost the app its offline copy and its notifications)
  const missing = await safari.page.evaluate(async () => {
    const text = await (await fetch('/app/sw.js')).text();
    const list = JSON.parse(text.match(/\[("[^\]]*)\]/)![0]) as string[];
    const bad: string[] = [];
    for (const p of list) if (!(await fetch(`/app/${p}`)).ok) bad.push(p);
    return { bad, n: list.length };
  });
  assert.ok(missing.n > 10, 'the offline list is there');
  assert.deepEqual(missing.bad, [], 'every file on the offline list exists');
  // the app shell is kept for offline use
  await safari.page.waitForFunction(() => navigator.serviceWorker.controller !== null || navigator.serviceWorker.ready.then(() => true), null, { timeout: 15000 });
  await safari.ctx.close();

  // ---- the guide at desktop width (a PC's browser)
  step('a PC browser: the guide says what this page is');
  const pc = await newPhone({ standalone: false, device: false });
  await pc.page.goto(appUrl);
  await pc.page.getByRole('heading', { name: 'This is the iPhone app' }).waitFor({ timeout: 30000 });
  await shot(pc.page, 'iphone-02-guide-desktop-light');
  await theme(pc.page, 'dark');
  await shot(pc.page, 'iphone-02-guide-desktop-dark');
  await pc.ctx.close();

  // ---- 2. a code from an office with no way in from outside: said plainly, before anything is tried
  step('a code without a gateway');
  const lanOnly = pairCode({ hubId: hub.info.id, fp: hub.fingerprint, name: 'Dexterity Office', lan: ['192.168.1.20:47900'], url: null, token: 'tok_0123456789abcdefABCD', kind: 'phone' });
  const nogw = await newPhone({ standalone: true });
  failPage = nogw.page;
  await nogw.page.goto(appUrl);
  await nogw.page.locator('#pair-code').fill(lanOnly, { timeout: 30000 });
  await nogw.page.getByText('Your office has not set up access from outside yet').waitFor();
  assert.ok(await nogw.page.getByRole('button', { name: 'Pair this phone' }).isDisabled());
  assert.equal(await nogw.page.getByRole('button', { name: 'Join the office hub instead' }).count(), 0, 'no office hub to choose on an iPhone');
  await shot(nogw.page, 'iphone-03-no-gateway');
  await nogw.ctx.close();

  // ---- 3. the app on the Home Screen: paste the code, joined through the gateway
  step('Home Screen app: paste the code and join');
  const phone = await newPhone({ standalone: true });
  const page = phone.page;
  failPage = page;
  await page.goto(appUrl);
  await page.getByRole('button', { name: /Paste the code/ }).waitFor({ timeout: 30000 });
  await shot(page, 'iphone-04-welcome-light');
  await page.evaluate((c) => navigator.clipboard.writeText(c), code);
  await page.getByRole('button', { name: /Paste the code/ }).click();
  await page.locator('.frame').waitFor({ timeout: 30000 });
  const st = await page.evaluate(() => window.dex.getState());
  assert.equal(st.platform, 'ios-web');
  assert.equal(st.via, 'remote');
  assert.equal(st.session?.me.id, vikramId, 'paired as the person who made the code');
  const devs = await owner.request('me.devices');
  assert.ok(devs.some((d: any) => d.hostname === 'iPhone (web app)' && d.paired), 'Your devices lists the iPhone');

  // ---- 4. messages both ways
  step('messages both ways');
  const dm = await priya.request('conv.create', { kind: 'direct', members: [vikramId] });
  await priya.request('msg.send', { convId: dm.id, body: 'Morning! Are the **P-12 isometrics** ready?', clientId: 'p1' });
  // turn notifications on from the one-time question
  await page.getByRole('button', { name: 'Turn on', exact: true }).click({ timeout: 15000 });
  await page.waitForFunction(() => window.dex.web!.pushState().then((s) => s === 'on'), null, { timeout: 15000 });
  await page.locator('.lens-dock').getByRole('button', { name: /Switchboard/ }).click();
  await page.locator('.sb-row', { hasText: 'Priya' }).click();
  await page.locator('.msg', { hasText: 'P-12 isometrics' }).waitFor({ timeout: 15000 });
  await page.locator('.dock textarea').first().fill('Yes, sending the photo now');
  await page.locator('.dock textarea').first().press('Enter');
  for (let i = 0; i < 50; i++) {
    const list = await priya.request('msg.list', { convId: dm.id });
    if ((list.messages ?? list).some((m: any) => m.body === 'Yes, sending the photo now')) break;
    if (i === 49) throw new Error('the reply did not reach Priya');
    await sleep(200);
  }

  // ---- 5. a photo (shown inline, fetched back through the channel) and a file opened
  step('a photo and a file');
  const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 640; c.height = 360; const x = c.getContext('2d')!; x.fillStyle = '#2b6f78'; x.fillRect(0, 0, 640, 360); x.fillStyle = '#fff'; x.font = 'bold 44px sans-serif'; x.fillText('SITE PHOTO · P-12', 90, 200); return c.toDataURL('image/png').split(',')[1]; });
  const img = path.join(OUT, 'iphone-site-photo.png');
  fs.writeFileSync(img, Buffer.from(png, 'base64'));
  const csv = path.join(OUT, 'nozzle-loads.csv');
  fs.writeFileSync(csv, 'Nozzle,Fx,Fy,Fz\nN1,1200,-340,560\nN2,900,410,-220\n');
  await page.locator('.dock input[type=file]').setInputFiles([img, csv]);
  await sleep(1500);
  await page.locator('.dock textarea').first().press('Enter');
  await page.locator('.img-tile img').waitFor({ timeout: 20000 });
  const w = await page.locator('.img-tile img').first().evaluate((i: HTMLImageElement) => new Promise((r) => (i.complete && i.naturalWidth ? r(i.naturalWidth) : (i.onload = () => r(i.naturalWidth)))));
  assert.equal(w, 640, 'the photo came back through the gateway');
  const fileRow = page.locator('.file-card', { hasText: 'nozzle-loads.csv' }).first();
  await fileRow.waitFor({ timeout: 15000 });
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), fileRow.getByRole('button', { name: 'Open' }).click()]);
  assert.equal(dl.suggestedFilename(), 'nozzle-loads.csv');
  assert.match(fs.readFileSync(await dl.path()!, 'utf8'), /N1,1200,-340,560/);
  await sleep(500);
  await shot(page, 'iphone-05-chat-light');
  await theme(page, 'dark');
  await shot(page, 'iphone-05-chat-dark');
  await theme(page, 'light');

  // ---- 6. a push while the app is in the background
  step('Web Push while in the background');
  const hide = (hidden: boolean) => page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  // (a page in the background on an iPhone is stopped; this one keeps running, so it leaves the conversation first or it would read the message)
  await page.locator('.lens-dock').getByRole('button', { name: /Pulse/ }).click();
  await hide(true);
  await sleep(600);
  await priya.request('msg.send', { convId: dm.id, body: 'Thanks! Nozzle N2 looks high, can you check?', clientId: 'p2' });
  const p1 = await nextPush(1);
  assert.equal(p1.payload.title, 'Priya Raman');
  assert.equal(p1.payload.body, 'Thanks! Nozzle N2 looks high, can you check?');
  assert.equal(p1.payload.link, `dexconnect://conversation/${dm.id}`);
  assert.equal(p1.payload.badge, 1);
  assert.equal(p1.headers['content-encoding'], 'aes128gcm');
  const v = await verifyVapid(String(p1.headers.authorization));
  assert.ok(v.ok, 'signed with the office\'s VAPID key');
  assert.equal(v.claims!.aud, `http://127.0.0.1:${pushPort}`);
  // previews off (Preferences): the push carries no text
  await hide(false);
  await page.evaluate(() => window.dex.setSettings({ showPreviews: false }));
  await sleep(600);
  await hide(true);
  await sleep(600);
  await priya.request('msg.send', { convId: dm.id, body: 'The client password is on the board', clientId: 'p3' });
  const p2 = await nextPush(2);
  assert.equal(p2.payload.title, 'Dexterity Connect');
  assert.equal(p2.payload.body, 'New message');
  assert.ok(!JSON.stringify(p2.payload).includes('password'));
  await hide(false);
  await page.evaluate(() => window.dex.setSettings({ showPreviews: true }));
  // on screen: no push
  await sleep(600);
  await priya.request('msg.send', { convId: dm.id, body: 'Seen it, thanks', clientId: 'p4' });
  await sleep(2500);
  assert.equal(pushes.length, 2, 'nothing is pushed while the app is on screen');

  // ---- 7. Preferences: notifications on this iPhone, a test push
  step('Preferences');
  await page.locator('.me-btn').click();
  await page.getByRole('menuitem', { name: /Preferences/ }).click();
  const sec = page.locator('section', { has: page.getByRole('heading', { name: 'On this iPhone' }) });
  await sec.waitFor({ timeout: 10000 });
  await sec.scrollIntoViewIfNeeded();
  await sec.getByText('Your office sends them through Apple\'s push service').waitFor();
  await sec.getByRole('button', { name: 'Send a test' }).click();
  const p3 = await nextPush(3);
  assert.equal(p3.payload.test, true);
  await sleep(400);
  await shot(page, 'iphone-06-preferences-light');
  await theme(page, 'dark');
  await shot(page, 'iphone-06-preferences-dark');
  await theme(page, 'light');
  await page.keyboard.press('Escape');

  // ---- 8. a tapped notification opens its conversation (the service worker opens /app/#open=…)
  step('a tapped notification');
  await priya.request('msg.send', { convId: dm.id, body: 'Site visit moved to **Thursday 10:00**', clientId: 'p5' });
  // the app is running: the service worker hands it the link (as a link to the app would)
  await page.locator('.lens-dock').getByRole('button', { name: /Pulse/ }).click();
  await page.evaluate((id) => { location.hash = `open=${encodeURIComponent(`dexconnect://conversation/${id}`)}`; }, dm.id);
  await page.locator('.msg', { hasText: 'Site visit moved' }).waitFor({ timeout: 15000 });
  await page.locator('.lens-dock').getByRole('button', { name: /Pulse/ }).click();
  // the app was closed: the notification's tap starts it with the link
  await page.goto('about:blank');
  await page.goto(`${appUrl}#open=${encodeURIComponent(`dexconnect://conversation/${dm.id}`)}`);
  await page.locator('.msg', { hasText: 'Site visit moved' }).waitFor({ timeout: 30000 });
  assert.equal(new URL(page.url()).hash, '');
  await shot(page, 'iphone-07-opened-from-notification');

  // ---- 9. Hindi
  step('Hindi');
  await page.evaluate(() => localStorage.setItem('dex.language', 'hi'));
  await page.goto(appUrl);
  await page.locator('.frame').waitFor({ timeout: 30000 });
  await page.locator('.me-btn').click();
  await page.locator('[role=menuitem]').filter({ hasText: /प्राथमिकताएँ|Preferences/ }).first().click();
  await sleep(800);
  await page.locator('.sheet-body section').filter({ has: page.locator('.wa-prompt, h3') }).first().waitFor();
  await page.getByRole('heading', { name: /iPhone/ }).first().scrollIntoViewIfNeeded();
  await shot(page, 'iphone-08-preferences-hindi');
  await page.evaluate(() => localStorage.setItem('dex.language', 'en'));

  // ---- 10. offline: the app shell still opens, to its own "reaching the office" screen
  step('offline');
  await phone.ctx.setOffline(true);
  await page.reload();
  await page.locator('.onboard, .frame').first().waitFor({ timeout: 30000 });
  await sleep(1500);
  await shot(page, 'iphone-09-offline');
  await phone.ctx.setOffline(false);

  console.log('IPHONE E2E PASSED');
} catch (e) {
  if (failPage) await shot(failPage, 'iphone-FAIL').catch(() => {});
  throw e;
} finally {
  await browser.close();
  owner.disconnect(); priya.disconnect();
  await hub.stop();
  site.close(); pushSvc.close();
  try { process.kill(-gw.pid!, 'SIGKILL'); } catch { /* gone */ }
}
