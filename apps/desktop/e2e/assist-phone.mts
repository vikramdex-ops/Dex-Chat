// Phone layout (the same UI the Android app renders): drop into a lounge from the Switchboard
// lens and hear a colleague, then ask IT for help with the request form.
import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';

const { owner, hub } = await startOffice('phone');
const a = await launch('priya', 'Priya Raman', { width: 390, height: 844 });
const b = await launch('ravi', 'Ravi Kumar');
try {
  const win = await a.app.browserWindow(a.page);
  await win.evaluate((w: any) => w.setSize(390, 844));
  await a.page.setViewportSize({ width: 390, height: 844 });
  const users = (await owner.request('directory.list')).users;
  const id = (u: string) => users.find((x: any) => x.account.endsWith(u))!.id;
  const space = await owner.request('conv.create', { kind: 'space', name: 'Site team', members: [id('priya'), id('ravi')] });
  await owner.request('lounge.create', { convId: space.id, name: 'Site desk' });
  await owner.request('admin.help.staff', { userId: id('ravi'), on: true });
  await sleep(500);
  for (const p of [a.page, b.page]) { await p.reload(); await p.locator('.frame').waitFor(); }
  // Ravi is already in the lounge
  await b.page.evaluate(async (lid: string) => { (window as any).__lid = lid; }, '');
  await b.page.getByRole('button', { name: /^Spaces/ }).first().click();
  if (await b.page.locator('.switchboard.folded').count()) await b.page.getByTitle('Open the Switchboard').click();
  await b.page.locator('.lg-row', { hasText: 'Site desk' }).getByRole('button', { name: 'Join' }).click({ timeout: 15000 });
  await b.page.locator('.lg-bar').waitFor({ timeout: 20000 });
  // the phone: Switchboard lens, the lounge row, Join
  await a.page.locator('.lens-dock').getByRole('button', { name: /Switchboard/ }).click();
  const row = a.page.locator('.lg-row', { hasText: 'Site desk' });
  await row.waitFor({ timeout: 15000 });
  await shot(a.page, 'phone-01-lounge-row');
  await row.getByRole('button', { name: 'Join' }).click();
  await a.page.locator('.lg-bar').waitFor({ timeout: 20000 });
  await a.page.waitForFunction(() => [...document.querySelectorAll('audio')].some((el) => ((el as HTMLAudioElement).srcObject as MediaStream | null)?.getAudioTracks().length), null, { timeout: 30000 });
  await sleep(800);
  await shot(a.page, 'phone-02-lounge-bar');
  const share = await a.page.locator('.lg-bar').getByRole('button', { name: 'Share' }).count();
  console.log('share button on the phone layout (desktop bridge):', share);
  await a.page.locator('.lg-bar').getByRole('button', { name: 'Leave' }).click();
  // Help me from the tile menu
  await a.page.locator('.me-btn').click();
  await a.page.getByRole('menuitem', { name: 'Help me…' }).click();
  const dlg = a.page.getByRole('dialog', { name: 'Ask IT for help' });
  await dlg.getByLabel('What is wrong?').fill('VPN drops on site Wi-Fi');
  await dlg.getByRole('radio', { name: /Network or internet/ }).click();
  await dlg.getByLabel(/Details/).fill('Every 10 minutes at the Jamnagar site office.');
  await shot(a.page, 'phone-03-help-me');
  await dlg.getByRole('button', { name: 'Send to IT' }).click();
  await a.page.getByRole('dialog', { name: 'Sent to the IT desk' }).waitFor({ timeout: 10000 });
  await shot(a.page, 'phone-04-help-sent');
  const q = await owner.request('help.queue').catch(() => null);
  assert.equal(q, null, 'the owner is not on the IT desk');
  const mine = await a.page.evaluate(() => (window as any).dex.request('help.mine'));
  assert.equal(mine[0].summary, 'VPN drops on site Wi-Fi');
  console.log('PHONE E2E PASSED');
} catch (e) { await shot(a.page, 'phone-FAIL-a').catch(() => {}); throw e; } finally {
  for (const x of [a, b]) await x.app.close().catch(() => {});
  owner.disconnect(); await hub.stop();
}
