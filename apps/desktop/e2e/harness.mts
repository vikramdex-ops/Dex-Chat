// Shared e2e harness: a fresh hub, a scripted owner ("Vikram") who approves everyone, and
// helpers to launch desktop apps as different colleagues.
import pw from 'playwright-core';
const electron = pw._electron;
import fs from 'node:fs';
import path from 'node:path';
import { createIdentity } from '../../../packages/core/src/index.ts';
import { HubClient } from '../../../packages/core/src/hub-client.ts';
import { Hub } from '../../../apps/hub/src/hub.ts';
import type { HubOptions } from '../../../apps/hub/src/hub.ts';
import { fileURLToPath as rootPath } from 'node:url';
import { createRequire } from 'node:module';
const ROOT = rootPath(new URL('../../../', import.meta.url));

export const OUT = path.join(import.meta.dirname, 'out');
let isoPort = 0;
fs.mkdirSync(OUT, { recursive: true });
const DESKTOP = process.env.DEX_DESKTOP ?? path.join(ROOT, 'apps/desktop');
const ELECTRON = createRequire(import.meta.url)('electron') as unknown as string;

/** `extra`: hub options for one script (for example a pretend disk detector for the first start's backup folder,
 *  or `holidaySeed: true` for the built-in 2026 holiday circular; off by default so walks do not depend on the day they run). */
export async function startOffice(tag: string, extra: Partial<HubOptions> = {}) {
  const dir = fs.mkdtempSync(path.join(OUT, `hub-${tag}-`));
  // POL1_ISOLATED=1: a hub on a free port with no discovery (apps join by address), so walks need not wait for 47900
  const iso = process.env.POL1_ISOLATED === '1';
  const hub = new Hub({ dataDir: dir, name: 'E2E Hub', updates: false, holidaySeed: false, ...(iso ? { port: 0, discoveryPort: false } : {}), ...extra });
  await hub.start();
  isoPort = iso ? hub.port : 0;
  const owner = new HubClient({ identity: createIdentity(), account: { username: 'vikram', domain: 'DEX', displayName: 'Vikram Shah', hostname: 'VIKRAM-PC' } });
  owner.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
  await new Promise<void>((res) => { const on = (s: { kind: string }) => { if (s.kind === 'ready') { owner.off('state', on); res(); } }; owner.on('state', on); });
  owner.on('event', (name: string, d: any) => { if (name === 'admin.pending') void owner.request('admin.decide', { deviceId: d.id, approve: true }).catch(() => {}); });
  return { hub, owner, dir };
}

export async function launch(username: string, displayName: string, opts: { width?: number; height?: number; invite?: string; noJoin?: boolean; video?: string; audio?: string; userData?: string; rejoin?: boolean; realCapture?: boolean; /** extra environment for this app (test hooks such as DEXCONNECT_TEST_DRIVES) */ env?: Record<string, string> } = {}) {
  const userData = opts.userData ?? fs.mkdtempSync(path.join(OUT, `ud-${username}-`));
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [DESKTOP, `--user-data-dir=${userData}`, '--no-sandbox', '--use-fake-ui-for-media-stream', ...(opts.realCapture ? [] : ['--use-fake-device-for-media-stream']), ...(opts.video ? [`--use-file-for-fake-video-capture=${opts.video}`] : []), ...(opts.audio ? [`--use-file-for-fake-audio-capture=${opts.audio}`] : [])],
    env: { ...process.env, DEXCONNECT_DEV_ACCOUNT: `${username}|${displayName}`, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ...opts.env },
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

/**
 * Two 8-second "voices" for fake microphones (48 kHz mono WAV, written to out/ on first use):
 * a steady tone from 0 to 3.5 s, another from 4 to 7.5 s, so a recording gets one chapter for each
 * speaker. They are buzzes, not speech: scripts turn strong noise suppression off where it matters.
 */
export function voices(): { a: string; b: string } {
  const make = (file: string, from: number, to: number, pitch: number) => {
    const p = path.join(OUT, file);
    if (fs.existsSync(p)) return p;
    const rate = 48000;
    const n = rate * 8;
    const data = Buffer.alloc(44 + n * 2);
    data.write('RIFF', 0); data.writeUInt32LE(36 + n * 2, 4); data.write('WAVE', 8);
    data.write('fmt ', 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
    data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
    data.write('data', 36); data.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      const v = t >= from && t < to ? 0.31 * Math.sin(2 * Math.PI * pitch * t) : 0;
      data.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
    }
    fs.writeFileSync(p, data);
    return p;
  };
  return { a: make('voice-a.wav', 0, 3.5, 236), b: make('voice-b.wav', 4, 7.5, 700) };
}
