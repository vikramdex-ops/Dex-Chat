// Shared e2e harness: a fresh hub, a scripted owner ("Vikram") who approves everyone, and
// helpers to launch desktop apps as different colleagues.
import pw from 'playwright-core';
const electron = pw._electron;
import fs from 'node:fs';
import path from 'node:path';
import { createIdentity } from '../../../packages/core/src/index.ts';
import { HubClient } from '../../../packages/core/src/hub-client.ts';
import { Hub } from '../../../apps/hub/src/hub.ts';
import { fileURLToPath as rootPath } from 'node:url';
import { createRequire } from 'node:module';
const ROOT = rootPath(new URL('../../../', import.meta.url));

export const OUT = path.join(import.meta.dirname, 'out');
let isoPort = 0;
fs.mkdirSync(OUT, { recursive: true });
const DESKTOP = process.env.DEX_DESKTOP ?? path.join(ROOT, 'apps/desktop');
const ELECTRON = createRequire(import.meta.url)('electron') as unknown as string;

export async function startOffice(tag: string) {
  const dir = fs.mkdtempSync(path.join(OUT, `hub-${tag}-`));
  // POL1_ISOLATED=1: a hub on a free port with no discovery (apps join by address), so walks need not wait for 47900
  const iso = process.env.POL1_ISOLATED === '1';
  const hub = new Hub({ dataDir: dir, name: 'E2E Hub', updates: false, ...(iso ? { port: 0, discoveryPort: false } : {}) });
  await hub.start();
  isoPort = iso ? hub.port : 0;
  const owner = new HubClient({ identity: createIdentity(), account: { username: 'vikram', domain: 'DEX', displayName: 'Vikram Shah', hostname: 'VIKRAM-PC' } });
  owner.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
  await new Promise<void>((res) => { const on = (s: { kind: string }) => { if (s.kind === 'ready') { owner.off('state', on); res(); } }; owner.on('state', on); });
  owner.on('event', (name: string, d: any) => { if (name === 'admin.pending') void owner.request('admin.decide', { deviceId: d.id, approve: true }).catch(() => {}); });
  return { hub, owner, dir };
}

export async function launch(username: string, displayName: string, opts: { width?: number; height?: number; invite?: string; noJoin?: boolean; video?: string; audio?: string; userData?: string; rejoin?: boolean; realCapture?: boolean } = {}) {
  const userData = opts.userData ?? fs.mkdtempSync(path.join(OUT, `ud-${username}-`));
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [DESKTOP, `--user-data-dir=${userData}`, '--no-sandbox', '--use-fake-ui-for-media-stream', ...(opts.realCapture ? [] : ['--use-fake-device-for-media-stream']), ...(opts.video ? [`--use-file-for-fake-video-capture=${opts.video}`] : []), ...(opts.audio ? [`--use-file-for-fake-audio-capture=${opts.audio}`] : [])],
    env: { ...process.env, DEXCONNECT_DEV_ACCOUNT: `${username}|${displayName}`, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: opts.width ?? 1280, height: opts.height ?? 800 }).catch(() => {});
  page.on('pageerror', (e) => console.log(`[${username} pageerror]`, e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[${username} console]`, m.text()); });
  if (opts.noJoin) return { app, page, userData };
  if (opts.rejoin) { await page.locator('.frame').waitFor({ timeout: 30000 }); return { app, page, userData }; }
  // join the hub
  if (opts.invite) {
    await page.getByRole('button', { name: "I'm a guest with an invite code" }).click({ timeout: 20000 });
    await page.getByLabel('Guest invite code').fill(opts.invite);
    await page.locator('.hub-option').first().click({ timeout: 20000 });
    await page.getByRole('button', { name: 'Join as a guest' }).click({ timeout: 20000 });
  } else if (isoPort) {
    await page.locator('.onboard').waitFor({ timeout: 20000 });
    await page.locator('.stack-v .field .link').first().click();
    await page.locator('.stack-v .field input.input:not(#display-name)').fill(`127.0.0.1:${isoPort}`);
    await page.locator('.stack-v button[type="submit"]').click({ timeout: 20000 });
  } else await page.getByRole('button', { name: 'Request access' }).click({ timeout: 20000 });
  await page.locator('.frame').waitFor({ timeout: 20000 });
  return { app, page, userData };
}

export const shot = (page: any, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A screenshot in the light theme and one in the dark theme. */
export async function both(page: any, name: string) {
  for (const t of ['light', 'dark']) {
    await page.evaluate((x: string) => { document.documentElement.dataset.theme = x; }, t);
    await sleep(200);
    await shot(page, `${name}-${t}`);
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

/** Wait until the hub port is free (other agents share it). */
export async function portFree() {
  const net = await import('node:net');
  for (let i = 0; i < 120; i++) {
    const ok = await new Promise<boolean>((res) => { const s = net.createServer(); s.once('error', () => res(false)); s.listen(47900, '0.0.0.0', () => s.close(() => res(true))); });
    if (ok) return;
    await sleep(2000);
  }
}
