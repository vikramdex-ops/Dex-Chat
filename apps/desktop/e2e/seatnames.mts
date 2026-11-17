// Names from the office drawing, end to end (docs/SEATING.md, "Names from the drawing"). A fresh
// hub: nobody has imported anything, yet the plan shows the names written on the drawing's seats.
// The owner (Vikram Shah) took POD2-1, "Vikram" on the drawing, as he set the hub up. Bhavna, the
// office manager, finds "Sharada" by name and sees her seat. Sharada Venkat joins from her PC: she
// is seated at W-A31 at once, told, and walks there. Anand Kumar (perhaps "Anandh") and two
// Pavithras wait to be matched; Bhavna confirms one Pavithra in one click. Screenshots at 1440 and
// 390 px, light and dark, and in Hindi, in SEATNAMES_OUT (default e2e/out).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startOffice, launch, sleep, OUT as BASE_OUT } from './harness.mts';
import { bringOnline } from './officeseed.mts';

const OUT = process.env.SEATNAMES_OUT ?? BASE_OUT;
fs.mkdirSync(OUT, { recursive: true });
const snap = (page: any, name: string) => page.screenshot({ path: path.join(OUT, `seatnames-${name}.png`) });
const theme = (page: any, t: string) => page.evaluate((x: string) => { document.documentElement.dataset.theme = x; }, t);
const pair = async (page: any, name: string) => {
  for (const t of ['light', 'dark']) { await theme(page, t); await sleep(300); await snap(page, `${name}-${t}`); }
  await theme(page, 'light');
};
/** Nib's start-of-day card can open over the bar; it is not what this walk is about. */
const quietNib = async (page: any) => { await page.locator('.nib-callout').getByRole('button', { name: 'Not now' }).click({ timeout: 1500 }).catch(() => {}); };

const { hub, owner } = await startOffice('seatnames');
const apps: any[] = [];
let clients: any[] = [];
try {
  // a fresh hub: the 40 names are on their seats, and the owner already sits at "Vikram"
  let v = await owner.request('seating.get');
  const ownerId = owner.session.me.id;
  assert.deepEqual(v.holders['POD2-1'], { kind: 'person', userId: ownerId }, 'Vikram Shah took the seat the drawing names "Vikram"');
  assert.equal(Object.values(v.holders).filter((h: any) => h.kind === 'named').length, 39);
  assert.deepEqual(v.holders['W-A31'], { kind: 'named', name: 'Sharada' });

  const b = await launch('bhavna', 'Bhavna Shah', { width: 1440, height: 900 });
  apps.push(b.app);
  const B = b.page;
  const bhavnaId = (await owner.request('directory.list')).users.find((u: any) => u.account.endsWith('\\bhavna')).id;
  await owner.request('admin.seating.managers', { userIds: [bhavnaId] });

  const openFloor = async (page: any) => {
    await page.reload(); await page.locator('.frame').waitFor();
    await quietNib(page);
    await page.locator('nav.lens-bar, .lens-dock').getByRole('button', { name: /^Directory/ }).first().click();
    await page.getByRole('tab', { name: 'Org chart', exact: true }).click();
    await page.locator('.os-stage').waitFor();
    await page.getByRole('button', { name: 'Floor', exact: true }).click();
    await sleep(2600);
    await quietNib(page);
  };

  // 1. the plan with the drawing's names, and "Sharada" found by name
  await openFloor(B);
  await pair(B, '01-fresh-plan-1440');
  await B.locator('.os-find-input').fill('Shar');
  const hit = B.locator('.os-results li', { hasText: 'Sharada' });
  await hit.waitFor();
  assert.match((await hit.textContent())!, /Seat W-A31 · from the office drawing/);
  await snap(B, '02-search-by-name');
  await hit.click();
  await B.locator('.seat-callout', { hasText: 'W-A31' }).waitFor();
  assert.match((await B.locator('.seat-callout').textContent())!, /Held by\s*Sharada/);
  assert.match((await B.locator('.seat-callout').textContent())!, /Not joined yet/);
  await sleep(1000);
  await pair(B, '03-named-seat-callout');
  await B.locator('.seat-callout').getByRole('button', { name: 'Walk there' }).click();
  await B.locator('.os-route').waitFor();
  await sleep(1400);
  await snap(B, '04-walk-to-sharada');
  await B.getByRole('button', { name: 'Clear the route' }).click().catch(() => {});

  // 2. Sharada Venkat joins from her PC: her first device is approved and W-A31 is hers at once
  const sh = await launch('sharada', 'Sharada Venkat', { width: 1440, height: 900 });
  apps.push(sh.app);
  const S = sh.page;
  const sharadaId = (await owner.request('directory.list')).users.find((u: any) => u.account.endsWith('\\sharada')).id;
  v = await owner.request('seating.get');
  assert.deepEqual(v.holders['W-A31'], { kind: 'person', userId: sharadaId }, 'seated automatically');
  assert.match(v.revisions[0].note, /W-A31 taken by Sharada Venkat/);
  const audit = (await owner.request('admin.audit', { limit: 50 })) as Array<{ action: string; target: string; detail: any }>;
  assert.ok(audit.some((a) => a.action === 'seating.claim' && a.target === 'W-A31' && a.detail.auto === true), 'audited');
  await openFloor(S);
  await S.locator('.seat-notice', { hasText: 'W-A31 · Left benches' }).waitFor();
  await pair(S, '05-sharada-told');
  await S.locator('.seat-notice').getByRole('button', { name: 'Walk there' }).click();
  await S.locator('.os-route', { hasText: 'round the desks' }).waitFor();
  await sleep(1400);
  await snap(S, '06-sharada-walks-there');
  await S.locator('.seat-notice').getByRole('button', { name: 'Got it' }).click();
  // her Directory seat follows
  const sv = (await owner.request('directory.list')).users.find((u: any) => u.id === sharadaId);
  assert.equal(sv.profile.location, 'W-A31 · Left benches');

  // 3. not certain: Anand Kumar (perhaps "Anandh"), and two people who become Pavithra in one import
  clients = await bringOnline(hub.port, hub.fingerprint, [
    { u: 'anand.k', name: 'Anand Kumar' }, { u: 'pav.r', name: 'P Ramesh' }, { u: 'pav.s', name: 'P Suresh' },
  ]);
  await owner.request('admin.org.import', { rows: [{ account: 'DEX\\pav.r', displayName: 'Pavithra Ramesh' }, { account: 'DEX\\pav.s', displayName: 'Pavithra Suresh' }] });
  v = await owner.request('seating.get');
  assert.deepEqual(v.holders['W-A45'], { kind: 'named', name: 'Pavithra' }, 'two Pavithras: nobody takes it alone');
  assert.deepEqual(v.holders['W-C13'], { kind: 'named', name: 'Anandh' });
  const users = (await owner.request('directory.list')).users;
  const idOf = (acct: string) => users.find((u: any) => u.account.endsWith(`\\${acct}`)).id;

  await openFloor(B);
  await B.getByRole('button', { name: /^Arrange/ }).click();
  const waiting = B.locator('.seat-waiting');
  await waiting.waitFor();
  assert.match((await waiting.textContent())!, /Waiting to be matched/);
  const row = (name: string) => waiting.locator('.seat-wait').filter({ has: B.locator('.seat-who b', { hasText: new RegExp(`^${name}$`) }) });
  await row('Anandh').waitFor();
  await row('Pavithra').waitFor();
  await pair(B, '07-waiting-to-be-matched');
  // Bhavna knows it is Pavithra Suresh: one click
  await waiting.getByLabel('Who is Pavithra on the drawing?').selectOption({ label: 'Pavithra Suresh' });
  await waiting.getByRole('button', { name: 'Confirm Pavithra Suresh for W-A45' }).click();
  await B.locator('.toast', { hasText: 'Pavithra Suresh now holds W-A45' }).first().waitFor();
  v = await owner.request('seating.get');
  assert.deepEqual(v.holders['W-A45'], { kind: 'person', userId: idOf('pav.s') });
  await row('Pavithra').waitFor({ state: 'detached' });
  await sleep(600);
  await snap(B, '08-confirmed');

  // 4. the phone: Sharada at 390 px, light and dark
  await S.setViewportSize({ width: 390, height: 844 });
  await S.reload(); await S.locator('.frame').waitFor();
  await quietNib(S);
  await S.locator('.lens-dock').getByRole('button', { name: /Directory/ }).click();
  await S.getByRole('tab', { name: 'Org chart', exact: true }).click();
  await S.getByRole('button', { name: 'Floor', exact: true }).click();
  await sleep(2600);
  await S.locator('.os-find-input').fill('Madhu');
  await S.locator('.os-results li', { hasText: 'Madhu' }).click();
  await S.locator('.seat-callout', { hasText: 'W-A33' }).waitFor();
  await sleep(1000);
  const wide = await S.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(wide <= 390, `no sideways scroll (${wide})`);
  await pair(S, '09-phone-named-seat');
  await B.setViewportSize({ width: 390, height: 844 });
  await sleep(800);
  await pair(B, '10-phone-waiting');
  await B.setViewportSize({ width: 1440, height: 900 });

  // 5. Hindi: the Arrange panel with what still waits
  await B.evaluate(() => localStorage.setItem('dex.language', 'hi'));
  await B.reload(); await B.locator('.frame').waitFor();
  await quietNib(B);
  await B.getByRole('button', { name: /^(Directory|निर्देशिका)/ }).first().click();
  await B.locator('.sheet-tab').nth(1).click();
  await B.locator('.os-stage').waitFor();
  await B.locator('.os-sheets button').nth(1).click();
  await sleep(2000);
  // Arrange: Spaces, Departments, Revisions, then Arrange
  await B.locator('.os-tools .os-tool').nth(3).click();
  await B.locator('.seat-waiting').waitFor();
  await sleep(800);
  await snap(B, '11-hindi-waiting');
  await B.evaluate(() => localStorage.setItem('dex.language', 'en'));
  console.log('SEATNAMES E2E PASSED');
} catch (e) {
  for (const [i, a] of apps.entries()) { try { const pg = await a.firstWindow(); await pg.screenshot({ path: path.join(OUT, `seatnames-FAIL-${i}.png`) }); } catch { /* closed */ } }
  throw e;
} finally {
  for (const c of clients) c.disconnect();
  for (const a of apps) await a.close().catch(() => {});
  owner.disconnect(); await hub.stop();
}
