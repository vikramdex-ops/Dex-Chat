// Nine fixes walked in the real app, two colleagues (Priya maps \\nas01\Project as X:, Ravi as Z:,
// through the TEST-ONLY DEXCONNECT_TEST_DRIVES hook) and Vikram as a scripted owner:
// sheets clear of the Windows caption buttons, Help me in the tile menu, the Switchboard row's arrow
// and the Drawer form, share paths with spaces that open, the transmittal mark (sent, delivered,
// seen), bots apart from people (Switchboard, Desk → Bots), Show screen without voice or camera,
// and Hold with call waiting.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startOffice, launch, shot, both, sleep, OUT } from './harness.mts';

const { owner } = await startOffice('nine');
const UNC = '\\\\nas01\\Project';
const P = await launch('priya', 'Priya Raman', { width: 1440, height: 900, env: { DEXCONNECT_TEST_DRIVES: JSON.stringify({ drives: [{ letter: 'X:', root: UNC }] }) } });
const R = await launch('ravi', 'Ravi Kumar', { width: 1440, height: 900, env: { DEXCONNECT_TEST_DRIVES: JSON.stringify({ drives: [{ letter: 'Z:', root: UNC }] }) } });
const shell = (app: typeof P.app) => app.evaluate(() => (globalThis as unknown as { __dexTestShell: Array<{ kind: string; path: string }> }).__dexTestShell.slice());
try {
  const users = (await owner.request('directory.list')).users;
  const id = (name: string) => users.find((u: { account: string }) => u.account.endsWith(name))!.id;
  const dm = await P.page.evaluate((ravi) => window.dex.request('conv.create', { kind: 'direct', members: [ravi] }), id('ravi'));
  const openDm = async (page: typeof P.page, name: string) => {
    await page.getByRole('button', { name: /^Direct/ }).first().click();
    await page.locator('.sb-row', { hasText: name }).first().click();
    await page.locator('.dock textarea').waitFor();
  };

  // ---- 1. sheets start below the Windows title bar (its caption buttons are drawn over the top right)
  await P.page.evaluate(() => { document.documentElement.dataset.platform = 'win32'; });
  await P.page.locator('.me-btn').click();
  await P.page.getByRole('menuitem', { name: /^Preferences/ }).click();
  const sheet = await P.page.locator('.sheet').boundingBox();
  assert.ok(sheet && sheet.y >= 44, `the sheet starts below the 44px title bar (top ${sheet?.y})`);
  const close = await P.page.locator('.sheet-close').boundingBox();
  assert.ok(close && close.y >= 44 + 8, 'its Close is not in the caption buttons\' band');
  await shot(P.page, 'nine-01-sheet-below-titlebar');
  await P.page.keyboard.press('Escape');
  await P.page.evaluate(() => { document.documentElement.dataset.platform = 'linux'; });

  // ---- 3. Help me stands out in the tile menu
  await P.page.locator('.me-btn').click();
  const help = P.page.locator('.menu button.help-entry');
  await help.waitFor();
  const hb = await help.boundingBox();
  const plain = await P.page.getByRole('menuitem', { name: /^Preferences/ }).boundingBox();
  assert.ok(hb && plain && hb.height > plain.height, 'Help me is a larger cell than the rows around it');
  await both(P.page, 'nine-03-help-me');
  await P.page.keyboard.press('Escape');

  // ---- 9. the row's arrow opens and closes its menu; the Drawer form has a usable field and a small Add
  await P.page.getByRole('button', { name: /^Direct/ }).first().click();
  const unfold = async (page: typeof P.page) => { if (await page.locator('.switchboard.folded').count()) await page.getByTitle('Open the Switchboard').click(); };
  await unfold(P.page);
  const row = P.page.locator('.sb-row-wrap', { hasText: 'Ravi Kumar' }).first();
  await row.hover();
  await row.locator('.sb-more').click();
  await P.page.locator('.conv-menu').waitFor();
  assert.equal(await row.locator('.sb-more').getAttribute('aria-expanded'), 'true');
  await P.page.locator('.conv-menu').getByRole('menuitem', { name: 'New drawer…' }).click();
  const field = await P.page.locator('.drawer-new input').boundingBox();
  const add = await P.page.locator('.drawer-new .drawer-add').boundingBox();
  assert.ok(field && add && field.width > 140 && add.width <= 34, `field ${field?.width}px, Add ${add?.width}px`);
  await P.page.locator('.drawer-new input').fill('Clients');
  await both(P.page, 'nine-09-drawer-form');
  await P.page.keyboard.press('Enter');
  await P.page.locator('.sb-drawer .sb-group-title', { hasText: 'Clients' }).waitFor({ timeout: 10000 });
  await shot(P.page, 'nine-09-drawer-group');

  // ---- 4. a path with spaces is one link, read with each person's own letter, and opens the file
  await openDm(P.page, 'Ravi Kumar');
  await openDm(R.page, 'Priya Raman');
  const written = 'X:\\J123– DM-ACF PACKAGE- TECHNIMONT\\2- Piping\\2- P&IDs\\ACF_MB\\Received on (18-07-2026)\\ACF_MB.pdf';
  await P.page.locator('.dock textarea').fill(written);
  await P.page.keyboard.press('Enter');
  const link = R.page.locator('.share-path-go').last();
  await link.waitFor({ timeout: 15000 });
  assert.equal(await link.innerText(), written.replace('X:', 'Z:'), 'the whole path, with the reader\'s letter');
  await R.page.locator('.lcard-title', { hasText: 'ACF_MB.pdf' }).waitFor({ timeout: 15000 });
  await link.click();
  for (let i = 0; i < 30 && !(await shell(R.app)).some((x) => x.kind === 'file'); i++) await sleep(200);
  const opened = (await shell(R.app)).find((x) => x.kind === 'file');
  assert.ok(opened && opened.path.endsWith('ACF_MB.pdf'), `the file opens (${opened?.path})`);
  await R.page.locator('.share-path-folder').last().click();
  for (let i = 0; i < 30 && !(await shell(R.app)).some((x) => x.kind === 'folder'); i++) await sleep(200);
  assert.ok((await shell(R.app)).some((x) => x.kind === 'folder' && x.path.endsWith('Received on (18-07-2026)')), 'and its folder');
  await shot(R.page, 'nine-04-path-reader');

  // ---- 5. the transmittal mark: delivered while Ravi's app has it, seen once he reads it
  await R.page.getByRole('button', { name: /^Pulse/ }).first().click();
  await P.page.locator('.dock textarea').fill('Isos for P-12 are in the folder');
  await P.page.keyboard.press('Enter');
  const mark = P.page.locator('.msg', { hasText: 'Isos for P-12' }).locator('.dlv');
  await P.page.locator('.msg', { hasText: 'Isos for P-12' }).locator('.dlv-delivered').waitFor({ timeout: 15000 });
  assert.equal(await mark.getAttribute('aria-label'), 'Delivered');
  await P.page.locator('.msg', { hasText: 'Isos for P-12' }).hover();
  await shot(P.page, 'nine-05-delivered');
  await openDm(R.page, 'Priya Raman');
  await P.page.locator('.msg', { hasText: 'Isos for P-12' }).locator('.dlv-seen').waitFor({ timeout: 15000 });
  await P.page.locator('.msg', { hasText: 'Isos for P-12' }).hover();
  await both(P.page, 'nine-05-seen');

  // ---- 7 and 8. bots: their own heading and tag in the Switchboard; every office bot on Desk → Bots
  const bots = users.filter((u: { role: string }) => u.role === 'bot');
  console.log('bots in the directory:', bots.map((b: { displayName: string; account: string }) => `${b.displayName} (${b.account})`).join(', '));
  const anyBot = bots.find((b: { account: string }) => !b.account.endsWith('nib'));
  if (anyBot) {
    await P.page.evaluate((b) => window.dex.request('conv.create', { kind: 'direct', members: [b] }).catch(() => null), anyBot.id);
    await sleep(800);
  }
  await P.page.getByRole('button', { name: /^Direct/ }).first().click();
  await unfold(P.page);
  if (anyBot) {
    await P.page.locator('.sb-bots-title').waitFor({ timeout: 10000 });
    assert.equal(await P.page.locator('.sb-row.bot .tag.bot-tag').first().innerText(), 'BOT');
  }
  await both(P.page, 'nine-07-switchboard-bots');
  await P.page.getByRole('button', { name: /^Desk/ }).first().click();
  await P.page.getByRole('tab', { name: /^Bots/ }).click();
  await P.page.locator('.ob-rack').waitFor({ timeout: 10000 });
  assert.ok(await P.page.locator('.ob-plate').count() >= 1, 'office bots are listed');
  await both(P.page, 'nine-08-desk-bots');

  // ---- 2. Show screen: no voice or camera; Ravi gets a calm card and watches
  await openDm(P.page, 'Ravi Kumar');
  await openDm(R.page, 'Priya Raman');
  await P.page.getByRole('button', { name: 'Show my screen' }).click();
  await P.page.locator('.screen-option').first().click({ timeout: 15000 });
  const card = R.page.locator('.room-banner.share');
  await card.waitFor({ timeout: 20000 });
  assert.match(await card.innerText(), /Priya Raman is showing you their screen/);
  await shot(R.page, 'nine-02-share-card');
  await card.getByRole('button', { name: 'Watch' }).click();
  await R.page.waitForFunction(() => { const v = document.querySelector('.room-share video') as HTMLVideoElement | null; return !!v && v.videoWidth > 0; }, null, { timeout: 25000 });
  assert.equal(await R.page.locator('.tb-controls button', { hasText: 'Mic off' }).count(), 1, 'Ravi watches with no microphone on');
  assert.match(await P.page.locator('.tb-kind').innerText(), /SCREEN/);
  await shot(R.page, 'nine-02-watching');
  await shot(P.page, 'nine-02-presenting');
  await P.page.getByRole('button', { name: /Leave Room/ }).click();
  await R.page.locator('.room-stage').waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});

  // ---- 6. Hold: Priya holds her call with Ravi; Vikram rings her meanwhile (call waiting); swap back
  await sleep(1000);
  await P.page.getByTitle('Open a Room with voice').click();
  await R.page.locator('.room-banner').waitFor({ timeout: 20000 });
  await R.page.locator('.room-banner').getByRole('button', { name: 'Join with voice' }).click();
  await P.page.locator('.room-grid .room-tile').nth(1).waitFor({ timeout: 20000 });
  await P.page.locator('.tb-controls button.held-btn').click();
  await P.page.locator('.held-bar').waitFor({ timeout: 10000 });
  await R.page.locator('.room-tile.on-hold').waitFor({ timeout: 10000 });
  await R.page.locator('.room-held-by-others').waitFor({ timeout: 10000 });
  await shot(P.page, 'nine-06-held-bar');
  await shot(R.page, 'nine-06-other-side-on-hold');
  // back from hold, then call waiting from Vikram
  await P.page.locator('.held-bar').getByRole('button', { name: 'Resume' }).click();
  await P.page.locator('.held-bar').waitFor({ state: 'detached', timeout: 15000 });
  await R.page.locator('.room-tile.on-hold').waitFor({ state: 'detached', timeout: 15000 });
  const vp = await owner.request('conv.create', { kind: 'direct', members: [id('priya')] });
  await owner.request('room.start', { convId: vp.id, video: false });
  const waiting = P.page.locator('.room-banner.waiting');
  await waiting.waitFor({ timeout: 20000 });
  await shot(P.page, 'nine-06-call-waiting');
  await waiting.getByRole('button', { name: 'Hold and answer' }).click();
  await P.page.locator('.held-bar').waitFor({ timeout: 15000 });
  assert.match(await P.page.locator('.held-bar').innerText(), /Ravi Kumar/);
  await R.page.locator('.room-tile.on-hold').waitFor({ timeout: 10000 });
  await shot(P.page, 'nine-06-hold-and-answer');
  await P.page.locator('.held-bar').getByRole('button', { name: 'Swap to it' }).click();
  await P.page.locator('.held-bar', { hasText: 'Vikram' }).waitFor({ timeout: 15000 });
  await R.page.locator('.room-tile.on-hold').waitFor({ state: 'detached', timeout: 15000 });
  await shot(P.page, 'nine-06-swapped');
  await P.page.locator('.held-bar').getByRole('button', { name: 'End' }).click();
  await P.page.locator('.held-bar').waitFor({ state: 'detached', timeout: 10000 });
  console.log('NINE E2E PASSED');
} catch (e) {
  console.error('FAILED:', e);
  await shot(P.page, 'nine-zz-fail-priya').catch(() => {});
  await shot(R.page, 'nine-zz-fail-ravi').catch(() => {});
  process.exitCode = 1;
} finally {
  for (const x of [P, R]) await x.app.close().catch(() => {});
  fs.writeFileSync(path.join(OUT, 'nine.done'), String(Date.now()));
  process.exit(process.exitCode ?? 0);
}
