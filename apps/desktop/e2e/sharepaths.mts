// Share paths whatever drive letter each person uses. Two colleagues map \\nas01\Project as X:
// (Priya) and Z: (Ravi) through the TEST-ONLY DEXCONNECT_TEST_DRIVES hook (development builds
// only), so nothing here touches a real share or Explorer: what Open and Open folder would hand
// to Explorer is read back from the main process.
// Covers: the message is stored as UNC and each person sees their own letter (UNC in the
// tooltip); Copy path / Copy UNC path; Open and Open folder; "only on this PC"; an older
// drive-letter message read through the writer's published map, and one with no known map;
// "no access"; editing shows the writer's letter; Preferences → Your network drives and Refresh.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startOffice, launch, shot, both, sleep, OUT } from './harness.mts';
import { createIdentity } from '../../../packages/core/src/index.ts';
import { HubClient } from '../../../packages/core/src/hub-client.ts';

const { owner, hub } = await startOffice('paths');
const UNC = '\\\\nas01\\Project';
const priyaHook = JSON.stringify({ drives: [{ letter: 'X:', root: UNC }, { letter: 'S:', root: 'C:\\Work' }] });
// Ravi's map is a file, so the test can change it and press Refresh
const raviFile = path.join(OUT, 'paths-ravi-drives.json');
const raviMap = (extra: Array<{ letter: string; root: string }> = []) => fs.writeFileSync(raviFile, JSON.stringify({
  drives: [{ letter: 'Z:', root: UNC }, ...extra], access: { [`${UNC}\\HR`]: 'denied', '\\\\nas09': 'offline' },
}));
raviMap();
const P = await launch('priya', 'Priya Raman', { width: 1440, height: 900, env: { DEXCONNECT_TEST_DRIVES: priyaHook } });
const R = await launch('ravi', 'Ravi Kumar', { width: 1440, height: 900, env: { DEXCONNECT_TEST_DRIVES: raviFile } });
const shell = (app: typeof P.app) => app.evaluate(() => (globalThis as unknown as { __dexTestShell: Array<{ kind: string; path: string }> }).__dexTestShell.slice());
const clip = (app: typeof P.app) => app.evaluate(({ clipboard }) => clipboard.readText());
let lalitha: HubClient | null = null;
try {
  const users = (await owner.request('directory.list')).users;
  const id = (name: string) => users.find((u: { account: string }) => u.account.endsWith(name))!.id;
  const sp = await owner.request('conv.create', { kind: 'space', name: 'P-12513 Piping', members: [id('priya'), id('ravi')] });
  const open = async (page: typeof P.page) => {
    await page.getByRole('button', { name: /^Spaces/ }).first().click();
    await page.locator('.sb-row', { hasText: 'P-12513 Piping' }).click();
    await page.locator('.dock textarea').waitFor();
  };
  await open(P.page);
  await open(R.page);

  // ---------------------------------------------------------------- Priya writes with her X:
  await P.page.locator('.dock textarea').fill('GA is at X:\\P12513\\Iso\\GA-101.pdf. Line list in "X:\\P12513\\Line List\\".');
  await P.page.locator('.dock textarea').press('Enter');
  const stored = async () => (await owner.request('msg.list', { convId: sp.id })).messages.at(-1).body as string;
  await sleep(500);
  assert.equal(await stored(), `GA is at ${UNC}\\P12513\\Iso\\GA-101.pdf. Line list in "${UNC}\\P12513\\Line List\\".`, 'stored as UNC, so it is right for everyone');
  const pMsg = P.page.locator('.msg', { hasText: 'GA is at' }).last();
  await pMsg.locator('.share-path').first().waitFor();
  assert.deepEqual(await pMsg.locator('.share-path').allInnerTexts(), ['X:\\P12513\\Iso\\GA-101.pdf', '"X:\\P12513\\Line List\\"'], 'the writer still sees what they typed');
  assert.equal(await pMsg.locator('.share-path').first().getAttribute('title'), `${UNC}\\P12513\\Iso\\GA-101.pdf`);

  // ---------------------------------------------------------------- Ravi reads with his Z:
  const rMsg = R.page.locator('.msg', { hasText: 'GA is at' }).last();
  await rMsg.locator('.share-path').first().waitFor();
  assert.deepEqual(await rMsg.locator('.share-path').allInnerTexts(), ['Z:\\P12513\\Iso\\GA-101.pdf', '"Z:\\P12513\\Line List\\"']);
  assert.equal(await rMsg.locator('.share-path').first().getAttribute('title'), `${UNC}\\P12513\\Iso\\GA-101.pdf`, 'the UNC form in the tooltip');
  const card = rMsg.locator('.lcard.k-path');
  await card.waitFor();
  assert.match(await card.innerText(), /GA-101\.pdf[\s\S]*Z:\\P12513\\Iso[\s\S]*PDF document[\s\S]*Open[\s\S]*Open folder[\s\S]*Copy path/);
  const folderCard = rMsg.locator('.lcard.k-folder');
  assert.match(await folderCard.innerText(), /Line List[\s\S]*Open folder[\s\S]*Copy path/);
  // Copy path: the reader's form; Copy UNC path: the form for everyone
  await card.getByRole('button', { name: 'Copy path' }).click();
  await sleep(200);
  assert.equal(await clip(R.app), 'Z:\\P12513\\Iso\\GA-101.pdf');
  await card.getByRole('button', { name: 'More ways to copy' }).click();
  await R.page.getByRole('menuitem', { name: /Copy UNC path/ }).click();
  await sleep(200);
  assert.equal(await clip(R.app), `${UNC}\\P12513\\Iso\\GA-101.pdf`);
  await R.page.locator('.toast', { hasText: 'UNC path copied' }).first().waitFor();
  // Open folder and Open: Explorer gets a form that works here (recorded by the test hook)
  await card.getByRole('button', { name: 'Open folder' }).click();
  await sleep(300);
  await card.getByRole('button', { name: 'Open', exact: true }).click();
  await sleep(300);
  await folderCard.getByRole('button', { name: 'Open folder' }).click();
  await sleep(300);
  assert.deepEqual(await shell(R.app), [
    { kind: 'folder', path: `${UNC}\\P12513\\Iso` }, { kind: 'file', path: `${UNC}\\P12513\\Iso\\GA-101.pdf` }, { kind: 'folder', path: `${UNC}\\P12513\\Line List` },
  ]);
  await rMsg.scrollIntoViewIfNeeded();
  await both(R.page, 'paths-01-ravi-sees-z');
  await both(P.page, 'paths-02-priya-sees-x');

  // ---------------------------------------------------------------- a path only on Priya's PC
  await P.page.locator('.dock textarea').fill('My notes: C:\\Users\\priya\\notes.txt and S:\\Calc\\pump.xlsx');
  await P.page.locator('.dock textarea').press('Enter');
  await sleep(500);
  assert.equal(await stored(), 'My notes: C:\\Users\\priya\\notes.txt and S:\\Calc\\pump.xlsx', 'local drives (and subst onto them) stay as written');
  const pLocal = P.page.locator('.msg', { hasText: 'My notes' }).last().locator('.lcard.local').first();
  await pLocal.waitFor();
  assert.match(await pLocal.innerText(), /Only on this PC/);
  const rLocal = R.page.locator('.msg', { hasText: 'My notes' }).last().locator('.lcard.local').first();
  await rLocal.waitFor();
  assert.match(await rLocal.innerText(), /Only on Priya Raman's PC/);
  assert.equal(await rLocal.getByRole('button', { name: /^Open/ }).count(), 0, 'nothing to open on another PC');
  assert.equal(await rLocal.getByRole('button', { name: 'Copy path' }).count(), 1);

  // ---------------------------------------------------------------- older messages with drive letters
  // Vikram (a script, so nothing converts his text) maps the share as W: and has published that
  await owner.request('links.drives.set', { drives: [{ letter: 'W:', root: UNC }] });
  await owner.request('msg.send', { convId: sp.id, body: 'Old note: W:\\P12513\\Iso\\GA-102.pdf', clientId: 'legacy1' });
  const rOld = R.page.locator('.msg', { hasText: 'Old note' }).last();
  await rOld.locator('.share-path').waitFor();
  await sleep(400);
  assert.equal(await rOld.locator('.share-path').innerText(), 'Z:\\P12513\\Iso\\GA-102.pdf', "translated through the writer's map, shown with the reader's letter");
  assert.equal(await P.page.locator('.msg', { hasText: 'Old note' }).last().locator('.share-path').innerText(), 'X:\\P12513\\Iso\\GA-102.pdf');
  // Lalitha never published a map: as written, with a quiet hint
  const identity = createIdentity();
  lalitha = new HubClient({ identity, account: { username: 'lalitha', domain: 'DEX', displayName: 'Lalitha Iyer', hostname: 'LALITHA-PC' } });
  const ready = new Promise<void>((res) => { const on = (st: { kind: string }) => { if (st.kind === 'ready') { lalitha!.off('state', on); res(); } }; lalitha!.on('state', on); });
  lalitha.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
  await ready;
  await owner.request('conv.addMembers', { convId: sp.id, userIds: [lalitha.session!.me.id] });
  await lalitha.request('msg.send', { convId: sp.id, body: 'From my PC: Y:\\P12513\\Iso', clientId: 'legacy2' });
  const rUnknown = R.page.locator('.msg', { hasText: 'From my PC' }).last();
  await rUnknown.locator('.share-path.maybe').waitFor();
  assert.match(await rUnknown.locator('.share-path').innerText(), /^Y:\\P12513\\Iso/);
  assert.equal(await rUnknown.locator('.share-path').getAttribute('title'), 'This drive letter may be mapped differently on your PC');
  assert.match(await rUnknown.locator('.lcard').innerText(), /May be mapped differently on your PC/);
  assert.equal(await rUnknown.locator('.lcard').getByRole('button', { name: /^Open/ }).count(), 0, 'Ravi has no Y: to try');

  // ---------------------------------------------------------------- no access, quietly
  await P.page.locator('.dock textarea').fill('Rates: X:\\HR\\rates.xlsx and \\\\nas09\\Archive\\P1');
  await P.page.locator('.dock textarea').press('Enter');
  const rNo = R.page.locator('.msg', { hasText: 'Rates' }).last();
  await rNo.waitFor();
  // access is checked once the card is on screen
  await rNo.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await rNo.locator('.lcard .path-note.no-access').first().waitFor();
  assert.match(await rNo.locator('.lcard').first().innerText(), /You don't have access to this file/);
  assert.match(await rNo.locator('.lcard').nth(1).innerText(), /The file server isn't reachable from here/);
  assert.equal(await rNo.locator('.lcard').first().getByRole('button', { name: /^Open/ }).count(), 0);
  for (const h of await rNo.locator('.lcard-slot').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)))) assert.equal(h, 108, 'the same reserved box');
  await rNo.scrollIntoViewIfNeeded();
  await both(R.page, 'paths-03-local-legacy-noaccess');

  // ---------------------------------------------------------------- editing shows the writer's letters
  assert.match(await stored(), /^Rates: \\\\nas01\\Project\\HR\\rates\.xlsx/);
  await P.page.locator('.dock textarea').press('Control+ArrowUp');
  const box = P.page.locator('.edit-box textarea');
  await box.waitFor();
  assert.equal(await box.inputValue(), 'Rates: X:\\HR\\rates.xlsx and \\\\nas09\\Archive\\P1', 'the edit box shows the letters the writer typed');
  await box.press('Escape');

  // ---------------------------------------------------------------- Preferences → Your network drives
  await R.page.locator('.me-btn').click();
  await R.page.getByRole('menuitem', { name: /Preferences/ }).click();
  const sec = R.page.locator('section.net-drives');
  await sec.waitFor();
  await sec.scrollIntoViewIfNeeded();
  assert.match(await sec.innerText(), /Z:\s+\\\\nas01\\Project/);
  raviMap([{ letter: 'J:', root: `${UNC}\\Jobs` }]);
  await sec.getByRole('button', { name: 'Refresh' }).click();
  await sec.locator('td', { hasText: 'J:' }).waitFor();
  await R.page.locator('.toast', { hasText: '2 network drives' }).first().waitFor();
  await both(R.page, 'paths-04-preferences');
  // the refreshed map reaches the hub (only the letters and UNC roots)
  await sleep(500);
  const maps = await owner.request('links.drives.of', { userIds: [id('ravi')] });
  assert.deepEqual(maps[id('ravi')].drives, [{ letter: 'J:', root: `${UNC}\\Jobs` }, { letter: 'Z:', root: UNC }]);

  // ---------------------------------------------------------------- phone width and Hindi
  await R.page.keyboard.press('Escape');
  await open(R.page);
  await R.page.setViewportSize({ width: 390, height: 844 });
  await sleep(500);
  await R.page.locator('.msg', { hasText: 'GA is at' }).last().scrollIntoViewIfNeeded();
  await both(R.page, 'paths-05-phone');
  const overflow = await R.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(overflow, false, 'no sideways scrolling at 390 px');
  await R.page.setViewportSize({ width: 1440, height: 900 });
  await R.page.evaluate(() => localStorage.setItem('dex.language', 'hi'));
  await R.page.reload();
  await R.page.locator('.frame').waitFor();
  await sleep(800);
  await R.page.locator('.lens-bar button').nth(2).click();
  await R.page.locator('.sb-row', { hasText: 'P-12513 Piping' }).click();
  const hiMsg = R.page.locator('.msg', { hasText: 'Rates' }).last();
  await hiMsg.locator('.lcard').first().waitFor();
  await hiMsg.scrollIntoViewIfNeeded();
  await sleep(600);
  await shot(R.page, 'paths-06-hindi');
  await R.page.evaluate(() => localStorage.setItem('dex.language', 'en'));
  console.log('SHAREPATHS E2E PASSED');
} catch (e) {
  await shot(P.page, 'paths-FAIL-priya').catch(() => {});
  await shot(R.page, 'paths-FAIL-ravi').catch(() => {});
  throw e;
} finally {
  lalitha?.disconnect();
  await P.app.close(); await R.app.close(); owner.disconnect(); await hub.stop();
}
