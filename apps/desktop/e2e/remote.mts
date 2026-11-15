import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import pw from 'playwright-core';
import { createIdentity } from '../../../packages/core/src/index.ts';
import { HubClient } from '../../../packages/core/src/hub-client.ts';
import { setupCode } from '../../../packages/core/src/remote.ts';
import { Hub } from '../../../apps/hub/src/hub.ts';
import { OUT, shot, sleep } from './harness.mts';
import { fileURLToPath as rootPath } from 'node:url';
import { createRequire } from 'node:module';
const ROOT = rootPath(new URL('../../../', import.meta.url));
const electron = pw._electron;

const free = async () => { const s = net.createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r())); const p = (s.address() as net.AddressInfo).port; await new Promise<void>((r) => s.close(() => r())); return p; };
// the gateway Worker in Cloudflare's local runtime
const gwPort = await free();
const gwRoot = path.join(ROOT, 'apps/gateway');
const gw = spawn(path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler'), ['dev', '--ip', '127.0.0.1', '--port', String(gwPort), '--show-interactive-dev-session=false'], { cwd: gwRoot, detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise<void>((res) => { const on = (b: Buffer) => { if (/Ready on/.test(b.toString())) res(); }; gw.stdout!.on('data', on); gw.stderr!.on('data', on); });
gw.stdout!.resume(); gw.stderr!.resume();
const gwUrl = `http://127.0.0.1:${gwPort}`;

// a hub that cannot be found on the network (no discovery): only the gateway leads to it
const dir = fs.mkdtempSync(path.join(OUT, 'hub-remote-'));
const hub = new Hub({ dataDir: dir, name: 'Dexterity Office', updates: false, discoveryPort: false, host: '127.0.0.1' });
await hub.start();
const owner = new HubClient({ identity: createIdentity(), account: { username: 'vikram', domain: 'DEX', displayName: 'Vikram Shah', hostname: 'VIKRAM-PC' } });
owner.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
await new Promise<void>((r) => { const on = (s: { kind: string }) => { if (s.kind === 'ready') { owner.off('state', on); r(); } }; owner.on('state', on); });
owner.on('event', (n: string, d: any) => { if (n === 'admin.pending') void owner.request('admin.decide', { deviceId: d.id, approve: true }).catch(() => {}); });
await owner.request('admin.remote.set', { url: gwUrl, enabled: true });
for (let i = 0; i < 50 && !(await owner.request('admin.remote.get')).status.connected; i++) await sleep(100);
const code = setupCode({ url: gwUrl, hubId: hub.info.id, fp: hub.fingerprint, name: 'Dexterity Office' });

const userData = fs.mkdtempSync(path.join(OUT, 'ud-asha-'));
const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron') as unknown as string,
  args: [path.join(ROOT, 'apps/desktop'), `--user-data-dir=${userData}`, '--no-sandbox'],
  env: { ...process.env, DEXCONNECT_DEV_ACCOUNT: 'asha|Asha Menon', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
});
const page = await app.firstWindow();
await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
try {
  await page.getByRole('button', { name: 'I have a pairing code' }).click({ timeout: 20000 });
  await page.locator('#pair-code').fill(`Here's the code: ${code}`);
  await page.getByText('An older setup code').waitFor();
  await shot(page, 'remote-01-join');
  await page.getByRole('button', { name: 'Request access' }).click();
  await page.locator('.frame').waitFor({ timeout: 30000 });
  console.log('STATE', JSON.stringify(await page.evaluate(() => window.dex.getState().then((s: any) => ({ via: s.via, hub: s.hub, phase: s.phase })))));
  console.log('CONN', await page.evaluate(() => document.querySelector('.conn')?.outerHTML.slice(0, 300)));
  await shot(page, 'remote-01b');
  await page.locator('.conn.remote').waitFor({ timeout: 10000 });
  console.log('CONN OK');
  // messages both ways
  const users = (await owner.request('directory.list')).users;
  const asha = users.find((u: any) => u.account.endsWith('asha'))!;
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Site visit', members: [asha.id] });
  console.log('S1');
  await owner.request('msg.send', { convId: sp.id, body: 'Photos from the site please', clientId: 'r1' });
  console.log('S2');
  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  console.log('S3');
  await page.locator('.sb-row', { hasText: 'Site visit' }).click();
  console.log('S4');
  await page.locator('.msg', { hasText: 'Photos from the site please' }).waitFor({ timeout: 10000 });
  // an image through the encrypted channel, shown inline (downloaded back through it)
  const b64 = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 640; c.height = 360; const x = c.getContext('2d')!; x.fillStyle = '#2b6f78'; x.fillRect(0, 0, 640, 360); x.fillStyle = '#fff'; x.font = 'bold 48px sans-serif'; x.fillText('SITE PHOTO', 140, 200); return c.toDataURL('image/png').split(',')[1]; });
  const img = path.join(OUT, 'site-photo.png'); fs.writeFileSync(img, Buffer.from(b64, 'base64'));
  console.log('S5');
  await page.locator('.dock input[type=file]').setInputFiles(img);
  console.log('S6');
  await sleep(1500);
  console.log('S7');
  await page.locator('.dock textarea').first().fill('Here you go');
  console.log('S8');
  await page.locator('.dock textarea').first().press('Enter');
  console.log('S9');
  await page.locator('.img-tile img').waitFor({ timeout: 20000 });
  const w = await page.locator('.img-tile img').evaluate((i: HTMLImageElement) => new Promise((r) => (i.complete && i.naturalWidth ? r(i.naturalWidth) : (i.onload = () => r(i.naturalWidth)))));
  assert.equal(w, 640);
  const list = await owner.request('msg.list', { convId: sp.id });
  const mine = (list.messages ?? list).find((m: any) => m.body === 'Here you go');
  assert.equal(mine?.files?.[0]?.name, 'site-photo.png');
  console.log('S10');
  await shot(page, 'remote-02-chat');
  // Preferences shows the route and offers a phone setup code
  console.log('S11');
  await page.keyboard.press('Control+,');
  console.log('S12');
  await page.getByText('Connected through the internet gateway').waitFor();
  console.log('S13');
  await page.getByRole('button', { name: 'Add my phone' }).click();
  console.log('S14');
  await page.locator('.qr svg').waitFor();
  console.log('S15');
  await shot(page, 'remote-03-setup');
  console.log('S16');
  await page.keyboard.press('Escape');
  console.log('S17');
  await page.keyboard.press('Escape');
  // the Control room from outside, once allowed
  console.log('S18');
  await owner.request('admin.setRole', { userId: asha.id, role: 'admin' });
  console.log('S19');
  await owner.request('admin.remote.set', { allowAdmin: true });
  console.log('S20');
  await sleep(800);
  console.log('S21');
  await page.locator('.me-btn').click();
  console.log('S22');
  await page.getByRole('menuitem', { name: /Control room/ }).click();
  console.log('S23');
  await page.getByRole('button', { name: 'Outside the office' }).click();
  console.log('S24');
  await page.locator('.gw-status.ok').waitFor({ timeout: 10000 });
  console.log('S25');
  await shot(page, 'remote-04-admin');
  console.log('REMOTE E2E PASSED');
} catch (e) { await shot(page, 'remote-FAIL'); throw e; } finally {
  await app.close(); owner.disconnect(); await hub.stop();
  try { process.kill(-gw.pid!, 'SIGKILL'); } catch { /* gone */ }
}
