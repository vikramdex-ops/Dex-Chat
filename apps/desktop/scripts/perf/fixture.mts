// The seeded office for performance runs (apps/hub/scripts/seed-office.ts), made once per checkout
// and kept: joining it takes the hub's usual port (47900) and its discovery beacon, like a new PC
// in the office. Each run then copies it and serves it on a private port (no beacon, no relay), so
// runs need nothing else on the machine and disturb nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { seedOffice } from '../../../hub/scripts/seed-office.ts';

/** The checkout to measure (this one by default; another worktree to compare with). */
export const ROOT = process.env.DEX_ROOT ?? path.resolve(import.meta.dirname, '../../../..');
/** Where fixtures, logs and results go. */
export const OUT = process.env.DEX_PERF_OUT ?? path.join(os.tmpdir(), 'dex-perf');
fs.mkdirSync(OUT, { recursive: true });
// Playwright drives Electron; it is not one of the app's dependencies (PLAYWRIGHT=path/to/playwright)
const pw = (await import(process.env.PLAYWRIGHT ?? 'playwright')).default ?? await import(process.env.PLAYWRIGHT ?? 'playwright');
const electron = pw._electron;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Wait until the hub's usual port is free (other hubs on this machine may hold it). */
async function portFree(): Promise<void> {
  for (let i = 0; i < 600; i++) {
    const ok = await new Promise<boolean>((res) => { const s = net.createServer(); s.once('error', () => res(false)); s.listen(47900, '0.0.0.0', () => s.close(() => res(true))); });
    if (ok) return;
    await sleep(2000);
  }
}

const { createIdentity } = await import(`${ROOT}/packages/core/src/index.ts`);
const { HubClient } = await import(`${ROOT}/packages/core/src/hub-client.ts`);
const { Hub } = await import(`${ROOT}/apps/hub/src/hub.ts`);
export const ELECTRON = process.env.DEX_ELECTRON ?? path.join(ROOT, 'node_modules/electron/dist/electron');
export const DESKTOP = `${ROOT}/apps/desktop`;

async function client(identity: unknown, port: number, fp: string) {
  const c = new HubClient({ identity, account: { username: 'vikram', domain: 'DEX', displayName: 'Vikram Shah', hostname: 'VIKRAM-PC' } });
  c.connect({ host: '127.0.0.1', port, fp });
  await new Promise<void>((res) => { const on = (s: { kind: string }) => { if (s.kind === 'ready') { c.off('state', on); res(); } }; c.on('state', on); });
  return c;
}

export async function seededOffice(tag: string) {
  const fixture = path.join(OUT, `fixture-${path.basename(ROOT)}`);
  const ready = path.join(fixture, 'ready.json');
  if (!fs.existsSync(ready)) {
    fs.rmSync(fixture, { recursive: true, force: true });
    fs.mkdirSync(fixture, { recursive: true });
    await portFree();
    const hub = new Hub({ dataDir: path.join(fixture, 'hub'), name: 'E2E Hub', updates: false, relay: false });
    await hub.start();
    const identity = createIdentity();
    const owner = await client(identity, hub.port, hub.fingerprint);
    owner.on('event', (name: string, d: any) => { if (name === 'admin.pending') void owner.request('admin.decide', { deviceId: d.id, approve: true }).catch(() => {}); });
    const ud = path.join(fixture, 'ud');
    const app = await electron.launch({ executablePath: ELECTRON, args: [DESKTOP, `--user-data-dir=${ud}`, '--no-sandbox'], env: { ...process.env, DEXCONNECT_DEV_ACCOUNT: 'priya|Priya Raman', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' } });
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Request access' }).click({ timeout: 30000 });
    await page.locator('.frame').waitFor({ timeout: 30000 });
    await sleep(1500);
    await app.close();
    const users = (await owner.request('directory.list')).users;
    const priyaId = users.find((u: any) => u.account.endsWith('priya'))!.id;
    const vikramId = users.find((u: any) => u.account.endsWith('vikram'))!.id;
    const seed = seedOffice(hub.store.db, { meId: priyaId, ownerId: vikramId, filesDir: path.join(fixture, 'hub', 'files') });
    owner.disconnect();
    await hub.stop();
    for (const d of ['Code Cache', 'Cache', 'GPUCache']) fs.rmSync(path.join(ud, d), { recursive: true, force: true });
    fs.writeFileSync(ready, JSON.stringify({ identity, seed, priyaId, vikramId }));
  }
  const { identity, seed, priyaId, vikramId } = JSON.parse(fs.readFileSync(ready, 'utf8'));
  const dir = fs.mkdtempSync(path.join(OUT, `hub-${tag}-`));
  fs.cpSync(path.join(fixture, 'hub'), dir, { recursive: true });
  const userData = fs.mkdtempSync(path.join(OUT, `ud-${tag}-`));
  fs.cpSync(path.join(fixture, 'ud'), userData, { recursive: true });
  const hub = new Hub({ dataDir: dir, name: 'E2E Hub', updates: false, relay: false, port: 0, host: '127.0.0.1', discoveryPort: false });
  await hub.start();
  const cfgPath = path.join(userData, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.hub.host = '127.0.0.1';
  cfg.hub.port = hub.port;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const owner = await client(identity, hub.port, hub.fingerprint);
  return { hub, owner, dir, userData, seed, priyaId, vikramId };
}
