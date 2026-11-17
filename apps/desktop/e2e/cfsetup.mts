// Control room ▸ Outside the office ▸ Set up with Cloudflare, against a stand-in for Cloudflare's
// API (apps/hub/test/cfmock.ts) with the hub's real Cloudflare parts (scripts/build-cloud.mjs):
// the empty card with its three things to do, a token that reaches two accounts (choose one), a
// token without the Pages permission (the step stops and names it), Retry once it is added, the
// finished sheet (gateway, meeting site, TURN, and the status turning green and pinned below), and
// "Update the gateway" when the hub carries a newer one. Screenshots at 1440 and 390 px, light and
// dark, and in Hindi, in CFSETUP_OUT (default out/cfsetup).
//   POL1_ISOLATED=1 xvfb-run -a node apps/desktop/e2e/cfsetup.mts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import pw from 'playwright-core';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createIdentity } from '../../../packages/core/src/index.ts';
import { HubClient } from '../../../packages/core/src/hub-client.ts';
import { Hub } from '../../../apps/hub/src/hub.ts';
import type { CloudBundle } from '../../../apps/hub/src/cfdeploy.ts';
import { CloudflareMock } from '../../../apps/hub/test/cfmock.ts';
import { OUT, sleep } from './harness.mts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SHOTS = process.env.CFSETUP_OUT ?? path.join(OUT, 'cfsetup');
fs.mkdirSync(SHOTS, { recursive: true });
const shot = (page: any, name: string) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

// the hub's real Cloudflare parts (built once)
const bundleFile = path.join(OUT, 'cloud-bundle.json');
if (!fs.existsSync(bundleFile)) execFileSync(process.execPath, [path.join(ROOT, 'apps/hub/scripts/build-cloud.mjs'), bundleFile], { stdio: 'inherit' });
const real = JSON.parse(fs.readFileSync(bundleFile, 'utf8')) as CloudBundle;
let newer = false;
const bundle = (): CloudBundle => (newer ? { ...real, gateway: { ...real.gateway, hash: `${real.gateway.hash}-next` } } : real);

const mock = await new CloudflareMock().start();
const A1 = 'a1'.repeat(16);
const A2 = 'b2'.repeat(16);
mock.addAccount(A1, 'Meera\'s personal account', null);
mock.addAccount(A2, 'Dexterity Design Services', null);
const TOKEN = 'cfut_e2eSetupToken0123456789abcdefABCDEF';
mock.tokens.set(TOKEN, { perms: ['workers', 'calls', 'accounts'] });

const dir = fs.mkdtempSync(path.join(OUT, 'hub-cfsetup-'));
const hub = new Hub({
  dataDir: dir, name: 'Dexterity Design Services', updates: false, port: 0, discoveryPort: false, host: '127.0.0.1',
  cloudflare: {
    bundle,
    endpoints: { api: mock.apiBase, rtc: mock.rtcBase, workersDev: () => mock.workersDevUrl, pagesDev: () => mock.pagesDevUrl },
    waits: { addressMs: 20_000, connectMs: 20_000, deployMs: 3000, pollMs: 300 },
  },
});
await hub.start();
const owner = new HubClient({ identity: createIdentity(), account: { username: 'vikram', domain: 'DEX', displayName: 'Vikram Shah', hostname: 'VIKRAM-PC' } });
owner.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
await new Promise<void>((r) => { const on = (s: { kind: string }) => { if (s.kind === 'ready') { owner.off('state', on); r(); } }; owner.on('state', on); });
owner.on('event', (n: string, d: any) => { if (n === 'admin.pending') void owner.request('admin.decide', { deviceId: d.id, approve: true }).catch(() => {}); });

const userData = fs.mkdtempSync(path.join(OUT, 'ud-meera-'));
const app = await pw._electron.launch({
  executablePath: createRequire(import.meta.url)('electron') as unknown as string,
  args: [process.env.DEX_DESKTOP ?? path.join(ROOT, 'apps/desktop'), `--user-data-dir=${userData}`, '--no-sandbox'],
  env: { ...process.env, DEXCONNECT_DEV_ACCOUNT: 'meera|Meera Iyer', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
});
const page = await app.firstWindow();
await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
page.on('pageerror', (e: Error) => console.log('[pageerror]', e.message));

/** Light and dark at the size the window has now. */
async function both(name: string) {
  for (const t of ['light', 'dark']) {
    await page.evaluate((x: string) => { document.documentElement.dataset.theme = x; }, t);
    await sleep(250);
    await shot(page, `${name}-${t}`);
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}
const card = () => page.locator('.cf-sheet');
async function scrollToCard() { await card().evaluate((e: HTMLElement) => e.scrollIntoView({ block: 'start' })); await sleep(200); }
async function phone(name: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(500);
  await scrollToCard();
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1 || [...document.querySelectorAll('.cf-sheet *')].some((e) => e.getBoundingClientRect().right > window.innerWidth + 1));
  assert.equal(wide, false, `${name}: nothing sticks out at 390 px`);
  await both(`${name}-390`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await sleep(400);
  await scrollToCard();
}

try {
  // join on the address (no discovery here), then the owner makes Meera an administrator
  await page.locator('.onboard').waitFor({ timeout: 20000 });
  await page.locator('.stack-v .field .link').first().click();
  await page.locator('.stack-v .field input.input:not(#display-name)').fill(`127.0.0.1:${hub.port}`);
  await page.locator('.stack-v button[type="submit"]').click({ timeout: 20000 });
  await page.locator('.frame').waitFor({ timeout: 30000 });
  const meera = (await owner.request('directory.list')).users.find((u: any) => u.account.endsWith('meera'))!;
  await owner.request('admin.setRole', { userId: meera.id, role: 'admin' });
  await owner.request('admin.remote.set', { allowJoin: false });
  await sleep(800);
  await page.locator('.me-btn').click();
  await page.getByRole('menuitem', { name: /Control room/ }).click();
  await page.getByRole('button', { name: 'Outside the office' }).click();
  await card().waitFor({ timeout: 10000 });
  await scrollToCard();

  // 1. nothing set up yet: the three things to do
  await page.getByText('Put the office online in one step').waitFor();
  const tokenLink = await page.getByRole('link', { name: 'Open the token form' }).getAttribute('href');
  assert.match(tokenLink!, /^https:\/\/dash\.cloudflare\.com\/profile\/api-tokens\?permissionGroupKeys=/);
  assert.ok(decodeURIComponent(tokenLink!).includes('"key":"workers_scripts","type":"edit"'));
  await both('cf-01-start');
  await phone('cf-01-start');

  // 2. the token reaches two accounts: choose the office's
  await page.locator('#cf-token').fill(TOKEN);
  await page.getByText('Keep it on the hub for gateway updates').click();
  await page.getByRole('button', { name: 'Set up', exact: true }).click();
  await page.getByText('Which one is the office\'s?', { exact: false }).waitFor({ timeout: 15000 });
  await both('cf-02-choose');
  await page.getByRole('radio', { name: /Dexterity Design Services/ }).check();
  // 3. the token has no Pages permission: the step stops and says which
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('.cf-problem', { hasText: 'missing this permission' }).waitFor({ timeout: 20000 });
  assert.ok((await page.locator('.cf-problem').innerText()).includes('Cloudflare Pages · Edit'));
  assert.equal(await page.locator('.cf-step.done').count(), 6, 'six steps done before the project');
  await both('cf-03-permission');
  await phone('cf-03-permission');

  // 4. the owner adds the permission in Cloudflare and presses Retry: it finishes and checks itself
  mock.tokens.get(TOKEN)!.perms.push('pages');
  await page.getByRole('button', { name: 'Retry' }).click();
  await page.locator('.cf-sheet.ok').waitFor({ timeout: 60000 });
  await page.locator('.gw-status.ok', { hasText: 'gateway pinned to this hub' }).waitFor({ timeout: 10000 });
  const rv = await owner.request('admin.remote.get');
  assert.equal(rv.config.enabled, true);
  assert.equal(rv.config.allowJoin, false, 'the device policy is untouched');
  assert.equal(rv.status.pinned, true);
  assert.equal(mock.account(A2).scripts.get('dexconnect-gateway')!.secrets.get('HUB_FINGERPRINT'), hub.fingerprint);
  assert.equal(mock.account(A2).turnKeys.size, 1);
  assert.equal((await owner.request('admin.ice.get')).mode, 'cloudflare');
  assert.equal(await page.locator('#gw-url').inputValue(), mock.workersDevUrl);
  await both('cf-04-done');
  await phone('cf-04-done');
  // the whole page below: status green and pinned, the site filled in, calls on Cloudflare TURN
  await page.locator('.gw-status').evaluate((e: HTMLElement) => e.scrollIntoView({ block: 'center' }));
  await sleep(200);
  await shot(page, 'cf-05-status-light');

  // 5. a hub update carries a newer gateway: one click (the token was kept)
  newer = true;
  await page.getByRole('button', { name: 'Outside the office' }).click();
  await page.reload(); await page.locator('.frame').waitFor();
  await page.locator('.me-btn').click();
  await page.getByRole('menuitem', { name: /Control room/ }).click();
  await page.getByRole('button', { name: 'Outside the office' }).click();
  await page.getByRole('button', { name: 'Update the gateway' }).waitFor({ timeout: 10000 });
  await scrollToCard();
  await both('cf-06-update');
  const uploads = mock.account(A2).scripts.get('dexconnect-gateway')!.uploads;
  await page.getByRole('button', { name: 'Update the gateway' }).click();
  await page.waitForFunction(() => document.querySelector('.cf-sheet.ok') && !document.querySelector('.cf-update'), null, { timeout: 60000 });
  assert.equal(mock.account(A2).scripts.get('dexconnect-gateway')!.uploads, uploads + 1);
  assert.equal(mock.account(A2).projects.size, 1);
  assert.equal(mock.account(A2).turnKeys.size, 1);

  // 6. in Hindi
  await page.evaluate(() => localStorage.setItem('dex.language', 'hi'));
  await page.reload(); await page.locator('.frame').waitFor(); await sleep(600);
  await page.locator('.me-btn').click();
  await page.locator('[role=menuitem]').filter({ hasText: /कंट्रोल|Control/ }).first().click();
  await page.getByRole('button', { name: /ऑफ़िस के बाहर/ }).first().click();
  await card().waitFor();
  await page.getByRole('button', { name: /Run the setup again|सेटअप फिर से चलाएँ/ }).click();
  await scrollToCard();
  await shot(page, 'cf-07-hindi-light');
  await page.evaluate(() => localStorage.setItem('dex.language', 'en'));
  console.log('CFSETUP E2E PASSED');
} catch (e) {
  await shot(page, 'cf-FAIL');
  throw e;
} finally {
  await app.close();
  owner.disconnect();
  await hub.stop();
  await mock.stop();
}
