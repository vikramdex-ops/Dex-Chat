// The phone app's own code (apps/mobile: its bridge and the shared UI) in Chromium at phone size,
// with a stand-in for the native DexNative plugin (Keystore, pinned sockets and downloads,
// notifications) so the JavaScript side runs for real against a real hub:
// - device keys kept by an older version in plain preferences move into the Keystore, unchanged;
// - an encrypted Direct photo and PDF from a desktop app are decrypted on the phone (shown, saved);
// - a photo sent from the phone is encrypted on the phone and opens on the desktop;
// - messages that arrive while the phone is disconnected are shown when it reconnects;
// - Preferences ▸ Notifications check and the battery explanation sheet.
// What it cannot cover: the Java side (Keystore, the foreground service, makers' settings pages).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import pw from 'playwright-core';
import { ed25519 } from '../../../node_modules/@noble/curves/ed25519.js';
import { sha256 } from '../../../node_modules/@noble/hashes/sha2.js';
import { createEncKeys } from '../../../packages/core/src/e2e.ts';
import { startOffice, launch, shot, sleep, OUT } from './harness.mts';
import { fileURLToPath as rootPath } from 'node:url';
const ROOT = rootPath(new URL('../../../', import.meta.url));

if (fs.existsSync('/opt/pw-browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';
const DIST = path.join(ROOT, 'apps/mobile/dist');
const server = http.createServer((req, res) => {
  const p = path.join(DIST, decodeURIComponent((req.url ?? '/').split('?')[0]));
  const file = fs.existsSync(p) && fs.statSync(p).isFile() ? p : path.join(DIST, 'index.html');
  const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : file.endsWith('.woff2') ? 'font/woff2' : file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
  res.writeHead(200, { 'content-type': type });
  fs.createReadStream(file).pipe(res);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const servePort = (server.address() as { port: number }).port;

// a phone identity and key made by an older version, stored as plain JSON in preferences
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const secret = ed25519.utils.randomSecretKey();
const spki = new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00, ...ed25519.getPublicKey(secret)]);
const legacyId = { deviceId: Buffer.from(sha256(spki)).toString('hex').slice(0, 32), publicKey: b64(spki), secret: b64(secret) };
const legacyEnc = createEncKeys();

const { owner, hub, dir } = await startOffice('phonesec');
const desk = await launch('ravi', 'Ravi Kumar');
const browser = await pw.chromium.launch({ args: ['--ignore-certificate-errors', '--disable-web-security'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true, bypassCSP: true, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[phone pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error' || /\[keys\]/.test(m.text())) console.log('[phone console]', m.text()); });

await page.addInitScript(({ fp, legacy }) => {
  if (!localStorage.getItem('seeded')) {
    localStorage.setItem('seeded', '1');
    localStorage.setItem('CapacitorStorage.device-key', JSON.stringify(legacy.id));
    localStorage.setItem('CapacitorStorage.device-enc', JSON.stringify(legacy.enc));
  }
  const listeners: Record<string, Array<(d: unknown) => void>> = {};
  const emit = (ev: string, d: unknown) => (listeners[ev] ?? []).forEach((fn) => fn(d));
  const files = new Map<string, Uint8Array>();
  const sockets = new Map<string, WebSocket>();
  const ub64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const tb64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
  const cat = (a: Uint8Array, b: Uint8Array) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
  const F: any = {
    offline: false, notes: [] as unknown[], saved: {} as Record<string, string>, opened: [] as string[], settings: [] as string[], watch: null, connected: null, cursor: null as string | null, keepAlive: null,
    health: { notifications: true, batteryExempt: false, backgroundRestricted: false, maker: 'xiaomi', manufacturer: 'Xiaomi', model: 'Redmi Note 13', androidVersion: '14', autostartPage: true, keepAlive: true, serviceRunning: true, watching: true, lastOk: null, lastError: null },
    files, sockets,
    drop() { for (const [id, ws] of sockets) { sockets.delete(id); ws.close(); emit('wsClose', { id, reason: 'network lost' }); } },
    // ---- the plugin's methods
    discover: async () => ({ hubs: [] }),
    deviceInfo: async () => ({ model: 'Redmi Note 13', manufacturer: 'Xiaomi', androidVersion: '14', appVersion: '0.1.0' }),
    wsOpen: async ({ id, url }: { id: string; url: string }) => {
      if (F.offline) throw new Error('Network is unreachable');
      const ws = new WebSocket(url);
      sockets.set(id, ws);
      ws.onopen = () => emit('wsOpen', { id, fingerprint: fp });
      ws.onmessage = (e) => emit('wsMessage', { id, data: e.data });
      ws.onclose = () => { if (sockets.delete(id)) emit('wsClose', { id, reason: 'connection closed' }); };
    },
    wsSend: async ({ id, data }: { id: string; data: string }) => { sockets.get(id)?.send(data); },
    wsClose: async ({ id }: { id: string }) => { const ws = sockets.get(id); sockets.delete(id); ws?.close(); },
    httpGet: async ({ url }: { url: string }) => { const r = await fetch(url); return { status: r.status, body: await r.text() }; },
    fileGet: async ({ url, token, id, name }: { url: string; token: string; id: string; name: string }) => {
      const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`Download failed (HTTP ${r.status})`);
      const p = `/files/${id}/${name}`;
      files.set(p, new Uint8Array(await r.arrayBuffer()));
      return { path: p };
    },
    fileUpload: async ({ url, token, data }: { url: string; token: string; data: string }) => {
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
    openFile: async ({ path }: { path: string }) => { F.opened.push(path); },
    saveToDownloads: async ({ path, name }: { path: string; name: string }) => { F.saved[name] = tb64(files.get(path)!); return { path: `Downloads/Dexterity Connect/${name}` }; },
    showNotification: async (o: unknown) => { F.notes.push(o); },
    keepAlive: async (o: { on: boolean }) => { F.keepAlive = o.on; },
    askNotifications: async () => {},
    takeLaunchLink: async () => ({ url: null }),
    clipboardText: async () => ({ text: null }),
    secureGet: async ({ key }: { key: string }) => { const v = localStorage.getItem(`keystore.${key}`); return { value: v === null ? null : atob(v.replace(/^wrapped:/, '')) }; },
    secureSet: async ({ key, value }: { key: string; value: string }) => { localStorage.setItem(`keystore.${key}`, `wrapped:${btoa(value)}`); },
    notifyHealth: async () => ({ ...F.health }),
    openSettings: async ({ target }: { target: string }) => { F.settings.push(target); return { opened: target === 'autostart' ? 'maker' : target }; },
    requestBatteryExemption: async () => { F.health.batteryExempt = true; return { opened: 'battery' }; },
    watchConfig: async (o: unknown) => { F.watch = o; },
    setConnected: async (o: { connected: boolean; cursor?: string }) => { F.connected = o.connected; if (o.cursor && (!F.cursor || o.cursor > F.cursor)) F.cursor = o.cursor; },
    watchCursor: async () => ({ cursor: F.cursor }),
    download: async () => { throw new Error('not in this test'); },
  };
  (window as any).__F = F;
  const methods = Object.keys(F).filter((k) => typeof F[k] === 'function' && k !== 'drop');
  (window as any).Capacitor = {
    PluginHeaders: [{ name: 'DexNative', methods: [...methods.map((name) => ({ name, rtype: 'promise' })), { name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'promise' }] }],
    nativePromise: (_plugin: string, method: string, options: unknown) => Promise.resolve().then(() => (method === 'removeListener' ? undefined : F[method](options ?? {}))),
    nativeCallback: (_plugin: string, method: string, options: { eventName: string }, cb: (d: unknown) => void) => {
      if (method === 'addListener') (listeners[options.eventName] ??= []).push(cb);
      return `cb-${Math.random()}`;
    },
    convertFileSrc: (p: string) => { const f = files.get(p); return f ? URL.createObjectURL(new Blob([f as BlobPart])) : p; },
  };
}, { fp: hub.fingerprint, legacy: { id: legacyId, enc: legacyEnc } });

const MARK = 'BOQ-PHONE-7.9-LAKH';
try {
  await page.goto(`http://127.0.0.1:${servePort}/`);
  await page.waitForFunction(() => !!(window as any).dex, null, { timeout: 30000 });
  // the older version's keys moved into the Keystore, unchanged, and are gone from preferences
  const store = await page.evaluate(() => ({ key: localStorage.getItem('keystore.device-key'), enc: localStorage.getItem('keystore.device-enc'), plainKey: localStorage.getItem('CapacitorStorage.device-key'), plainEnc: localStorage.getItem('CapacitorStorage.device-enc') }));
  assert.equal(store.plainKey, null, 'no readable identity left in preferences');
  assert.equal(store.plainEnc, null, 'no readable encryption key left in preferences');
  assert.deepEqual(JSON.parse(Buffer.from(store.key!.replace('wrapped:', ''), 'base64').toString()), legacyId, 'the same identity');
  assert.deepEqual(JSON.parse(Buffer.from(store.enc!.replace('wrapped:', ''), 'base64').toString()), legacyEnc, 'the same encryption key');
  assert.equal((await page.evaluate(() => window.dex.getState())).deviceId, legacyId.deviceId);
  console.log('keys moved into the Keystore stand-in; device id unchanged');

  await page.evaluate(({ port }) => window.dex.join({ address: `127.0.0.1:${port}`, displayName: 'Priya Raman', officeAccount: 'DEX\\priya' }), { port: hub.port });
  await page.locator('.frame').waitFor({ timeout: 30000 });
  // the device the hub approved is the old identity
  const dev = hub.store.device(legacyId.deviceId);
  assert.equal(dev?.status, 'approved');
  // first start with the background connection on: the battery sheet explains before Android asks
  await page.getByRole('dialog', { name: 'Let Dexterity Connect run in the background' }).waitFor({ timeout: 15000 });
  for (const t of ['light', 'dark']) { await page.evaluate((x) => { document.documentElement.dataset.theme = x; }, t); await sleep(200); await shot(page, `phonesec-01-battery-sheet-${t}`); }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.getByRole('button', { name: 'Continue' }).click();
  assert.equal(await page.evaluate(() => (window as any).__F.health.batteryExempt), true, "Android's own question was asked after the explanation");
  const watch = await page.evaluate(() => (window as any).__F.watch);
  assert.equal(watch.on, true);
  assert.equal(watch.fingerprint, hub.fingerprint);
  assert.match(watch.url, /^https:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(watch.token && watch.token.length > 20, 'the background service got its own token');

  // Ravi (desktop) sends an encrypted photo and PDF
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  const dm = await desk.page.evaluate((id) => window.dex.request('conv.create', { kind: 'direct', members: [id] }), priya.id);
  await sleep(1500);
  await desk.page.getByRole('button', { name: /^Direct/ }).first().click();
  await desk.page.locator('.sb-row', { hasText: 'Priya' }).click();
  await desk.page.locator('.e2e-chip', { hasText: 'Encrypted' }).waitFor({ timeout: 15000 });
  const pngB64 = await desk.page.evaluate((mark) => { const c = document.createElement('canvas'); c.width = 640; c.height = 400; const x = c.getContext('2d')!; x.fillStyle = '#e4eeef'; x.fillRect(0, 0, 640, 400); x.fillStyle = '#1e6066'; x.fillRect(60, 60, 520, 280); x.font = 'bold 34px sans-serif'; x.fillStyle = '#fff'; x.fillText('PIPE RACK PR-03', 170, 200); x.font = '18px monospace'; x.fillText(mark, 200, 250); return c.toDataURL('image/png').split(',')[1]; }, MARK);
  const png = Buffer.from(pngB64, 'base64');
  const img = path.join(OUT, 'rack PR-03.png'); fs.writeFileSync(img, png);
  const pdf = Buffer.from(`%PDF-1.4\n% ${MARK}\n${'0123456789 '.repeat(30000)}\n%%EOF\n`); // ~330 KB: several chunks
  const doc = path.join(OUT, 'Rack BOQ.pdf'); fs.writeFileSync(doc, pdf);
  await desk.page.locator('.dock input[type=file]').setInputFiles([img, doc]);
  await desk.page.locator('.attach-chip.done').nth(1).waitFor({ timeout: 15000 });
  await desk.page.locator('.dock textarea').first().fill('Rack photo and BOQ for site');
  await desk.page.locator('.dock textarea').first().press('Enter');
  await desk.page.locator('.msg', { hasText: 'Rack photo and BOQ for site' }).locator('.img-tile img').waitFor({ timeout: 15000 });

  // the phone shows the photo, decrypted on the phone
  await page.locator('.lens-dock').getByRole('button', { name: /Switchboard/ }).click();
  await page.locator('.sb-row', { hasText: 'Ravi' }).click();
  const msg = page.locator('.msg', { hasText: 'Rack photo and BOQ for site' });
  await msg.waitFor({ timeout: 15000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.img-tile img')].some((i) => (i as HTMLImageElement).naturalWidth === 640), null, { timeout: 20000 });
  await msg.locator('.file-card', { hasText: 'Rack BOQ.pdf' }).waitFor();
  for (const t of ['light', 'dark']) { await page.evaluate((x) => { document.documentElement.dataset.theme = x; }, t); await sleep(200); await shot(page, `phonesec-02-received-${t}`); }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  // saved to Downloads: the original PDF; the ciphertext was not kept
  const info = (await page.evaluate((id) => window.dex.request('msg.list', { convId: id }), dm.id)).messages.at(-1).files.find((f: any) => f.name === 'Rack BOQ.pdf');
  await page.evaluate(({ id, name }) => window.dex.saveFile!(id, name), { id: info.id, name: info.name });
  const saved = Buffer.from(await page.evaluate(() => (window as any).__F.saved['Rack BOQ.pdf']), 'base64');
  assert.deepEqual(saved, pdf, 'the phone decrypted the PDF chunk by chunk');
  const left = await page.evaluate(() => [...(window as any).__F.files.keys()]);
  assert.ok(!left.some((k: string) => k.endsWith('encrypted.part')), 'no ciphertext left in the cache');
  console.log('phone opened the photo and saved the PDF (%d bytes, identical)', pdf.length);

  // a photo from the phone: encrypted on the phone, opened on the desktop
  const phonePng = Buffer.from(await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 480; c.height = 320; const x = c.getContext('2d')!; x.fillStyle = '#132b2e'; x.fillRect(0, 0, 480, 320); x.fillStyle = '#f7af44'; x.font = 'bold 30px sans-serif'; x.fillText('FROM THE PHONE', 100, 170); return c.toDataURL('image/png').split(',')[1]; }), 'base64');
  const pimg = path.join(OUT, 'site from phone.png'); fs.writeFileSync(pimg, phonePng);
  await page.locator('.dock input[type=file]').setInputFiles([pimg]);
  await page.locator('.attach-chip.done').first().waitFor({ timeout: 15000 });
  await page.locator('.dock textarea').first().fill('Taken just now');
  await page.locator('.dock textarea').first().press('Enter');
  await desk.page.locator('.msg', { hasText: 'Taken just now' }).locator('.img-tile img').waitFor({ timeout: 15000 });
  await desk.page.waitForFunction(() => [...document.querySelectorAll('.img-tile img')].some((i) => (i as HTMLImageElement).naturalWidth === 480), null, { timeout: 15000 });
  const row = hub.files.db.prepare('SELECT sealed, sha256, name FROM files ORDER BY created_at DESC LIMIT 1').get() as { sealed: number; sha256: string; name: string };
  assert.equal(row.sealed, 1);
  assert.equal(row.name, 'Encrypted file');
  const blob = fs.readFileSync(path.join(dir, 'files', row.sha256.slice(0, 2), row.sha256));
  assert.ok(!blob.subarray(0, 8).equals(phonePng.subarray(0, 8)), 'the hub stores ciphertext from the phone too');
  console.log('phone photo encrypted on the phone, opened on the desktop');

  // the phone loses its connection; Ravi writes meanwhile; on reconnect the phone shows what it missed
  await sleep(2500); // the cursor reaches the background service
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); (window as any).__F.offline = true; (window as any).__F.drop(); });
  await page.waitForFunction(() => (window as any).__F.connected === false, null, { timeout: 10000 });
  await desk.page.locator('.dock textarea').first().fill('Crane arrives at 3 pm, confirm the lift plan');
  await desk.page.locator('.dock textarea').first().press('Enter');
  await desk.page.locator('.dock textarea').first().fill('Also bring the rigging sketch');
  await desk.page.locator('.dock textarea').first().press('Enter');
  await sleep(1000);
  await page.evaluate(() => { (window as any).__F.offline = false; });
  await page.waitForFunction(() => (window as any).__F.notes.some((n: any) => /rigging sketch/.test(n.body)), null, { timeout: 60000 });
  const notes = await page.evaluate(() => (window as any).__F.notes);
  const note = notes.find((n: any) => /rigging sketch/.test(n.body));
  assert.equal(note.title, 'Ravi Kumar');
  assert.equal(note.body, '2 new messages · Also bring the rigging sketch', 'decrypted on the phone, one notification per conversation');
  assert.equal(note.link, `dexconnect://conversation/${dm.id}`);
  // live notifications (shown by the app while connected) and the catch-up never repeat a message
  console.log('notifications on the phone:', JSON.stringify(notes.map((n: any) => n.body)));
  assert.ok(notes.filter((n: any) => /Rack photo/.test(n.body)).length <= 1, 'nothing shown twice');
  assert.equal(notes.filter((n: any) => /Crane arrives|rigging sketch/.test(n.body)).length, 1, 'the missed messages once, together');
  console.log('missed while disconnected, shown on reconnect:', JSON.stringify(note));
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); });

  // Preferences ▸ Notifications check
  await page.locator('.me-btn').click();
  await page.getByRole('menuitem', { name: /Preferences/ }).click();
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  const check = page.getByRole('dialog', { name: 'Notifications check' });
  await check.locator('.check-row').first().waitFor();
  assert.match(await check.innerText(), /Xiaomi, Redmi and POCO/);
  assert.match(await check.innerText(), /Autostart: on/);
  for (const t of ['light', 'dark']) { await page.evaluate((x) => { document.documentElement.dataset.theme = x; }, t); await sleep(200); await shot(page, `phonesec-03-check-${t}`); }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await check.locator('.check-row', { hasText: 'Autostart' }).getByRole('button', { name: 'Open' }).click();
  assert.deepEqual(await page.evaluate(() => (window as any).__F.settings), ['autostart']);
  await check.getByText('I have done these steps').click();
  await page.waitForFunction(() => /Everything is set/.test(document.querySelector('.notify-check')?.textContent ?? ''), null, { timeout: 5000 });
  await check.evaluate((el) => el.scrollTo(0, 0));
  for (const t of ['light', 'dark']) { await page.evaluate((x) => { document.documentElement.dataset.theme = x; }, t); await sleep(200); await shot(page, `phonesec-04-check-done-${t}`); }
  console.log('PHONE SECURITY E2E PASSED');
} catch (e) {
  await shot(page, 'phonesec-FAIL-phone');
  await shot(desk.page, 'phonesec-FAIL-desk');
  throw e;
} finally {
  await browser.close();
  await desk.app.close();
  owner.disconnect();
  await hub.stop().catch(() => {});
  server.close();
}
