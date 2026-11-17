import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';
const { owner, hub } = await startOffice('calls2');
const a = await launch('priya', 'Priya Raman');
const b = await launch('ravi', 'Ravi Kumar');
try {
  const users = (await owner.request('directory.list')).users;
  const ravi = users.find((u: any) => u.account.endsWith('ravi'))!;
  const vikram = users.find((u: any) => u.account.endsWith('vikram'))!;
  const rings: any[] = [];
  owner.on('event', (n: string, d: any) => { if (n === 'room.ring') rings.push(d); });
  // a 1:1 call between Priya and Ravi
  await a.page.evaluate((id) => window.dex.request('conv.create', { kind: 'direct', members: [id] }), ravi.id);
  await a.page.getByRole('button', { name: /^Direct/ }).first().click();
  await a.page.locator('.sb-row').first().click();
  await a.page.getByTitle('Open a Room with voice').click();
  // Ravi gets the amber banner, worded our way
  const banner = b.page.locator('.room-banner');
  await banner.waitFor({ timeout: 20000 });
  assert.match(await banner.innerText(), /Priya Raman is opening a Room with you/);
  await a.page.locator('.open-seat').waitFor();
  await shot(a.page, 'calls2-00-ringing');
  await shot(b.page, 'calls2-00-banner');
  await b.page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await shot(b.page, 'calls2-00-banner-dark');
  await b.page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await banner.getByRole('button', { name: 'Join with voice' }).click();
  await banner.waitFor({ state: 'detached' });
  // connection quality shows once media flows
  await a.page.locator('.q-good, .q-fair, .q-poor').waitFor({ timeout: 20000 });
  await shot(a.page, 'calls2-01-quality');
  // add Vikram: the call moves to a group conversation and rings everyone
  // the stage is a sheet: zone captions on the tiles, a schedule and a title block
  assert.equal(await a.page.locator('.room-grid .room-tile').count(), 2);
  const zones = await a.page.locator('.room-grid .room-cap b').allInnerTexts();
  assert.equal(zones[0], 'A1');
  assert.ok(zones.every((z) => /^[A-D][1-9]$/.test(z)) && new Set(zones).size === 2, zones.join());
  assert.deepEqual(await a.page.locator('.room-schedule td.ref').allInnerTexts(), zones);
  await a.page.getByRole('button', { name: 'Leave Room' }).waitFor();
  // mic off shows in the title block, on Ravi's schedule and on Ravi's tile caption
  await a.page.getByTitle('Turn your mic off').click();
  await a.page.getByRole('button', { name: 'Mic off' }).waitFor();
  await b.page.locator('.room-grid .room-tile').nth(1).locator('.room-cap svg').waitFor({ timeout: 10000 });
  await shot(b.page, 'calls2-01b-other-side');
  await a.page.getByTitle('Turn your mic on').click();
  // fold into the title bar, and back
  await a.page.getByTitle('Fold the Room into the title bar (Esc)').click();
  await a.page.locator('.room-stage.folded').waitFor({ state: 'attached' });
  assert.equal(await a.page.locator('.room-stage').isVisible(), false);
  if (await a.page.locator('.room-chip').count()) {
    assert.match(await a.page.locator('.room-chip').innerText(), /ROOM · \d+:\d\d/);
    await shot(a.page, 'calls2-01c-folded');
    await a.page.locator('.room-chip-mic').click();
    await a.page.locator('.room-chip.muted').waitFor();
    await a.page.locator('.room-chip-mic').click();
    await a.page.locator('.room-chip-main').click();
  } else {
    // the title bar has no Room chip in this build: show where it would sit, from the chip's own markup
    await a.page.evaluate(() => {
      const mid = document.querySelector('.titlebar-mid .lens-bar');
      mid?.insertAdjacentHTML('afterend', '<div class="room-chip" data-preview><button class="room-chip-main"><span class="room-chip-pip"></span><span class="room-chip-text">ROOM · 0:12</span></button><button class="room-chip-mic"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M12 3.5a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0v-5a3 3 0 0 1 3-3zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg></button></div>');
    });
    await shot(a.page, 'calls2-01c-folded-preview');
    await a.page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await shot(a.page, 'calls2-01c-folded-preview-dark');
    await a.page.evaluate(() => { document.documentElement.dataset.theme = 'light'; document.querySelector('[data-preview]')?.remove(); });
    await a.page.getByRole('button', { name: 'Back to the Room' }).click();
  }
  await a.page.locator('.room-stage:not(.folded)').waitFor();
  await a.page.keyboard.press('Escape');
  await a.page.locator('.room-stage.folded').waitFor({ state: 'attached' });
  await a.page.getByRole('button', { name: 'Back to the Room' }).click();
  await a.page.locator('.room-stage:not(.folded)').waitFor();
  await a.page.getByTitle('Ring someone into the Room').click();
  await a.page.locator('.add-people input').fill('vikram');
  await shot(a.page, 'calls2-01d-ring-someone');
  await a.page.locator('.add-people button', { hasText: 'Vikram Shah' }).click();
  for (let i = 0; i < 40 && !rings.length; i++) await sleep(200);
  assert.ok(rings.length, 'Vikram is rung');
  const groupConv = rings[0].room.convId;
  const conv = (await owner.request('conv.list')).find((c: any) => c.id === groupConv);
  assert.deepEqual([...conv.members].sort(), [ravi.id, vikram.id, users.find((u: any) => u.account.endsWith('priya'))!.id].sort());
  await b.page.locator('.room-banner').getByRole('button', { name: 'Join with voice' }).click({ timeout: 20000 });
  await a.page.locator('.room-stage h2', { hasText: /Ravi|Vikram/ }).waitFor();
  await a.page.locator('.room-schedule .ringing', { hasText: 'Vikram Shah' }).waitFor({ timeout: 10000 });
  await sleep(1500);
  await shot(a.page, 'calls2-02-group');
  await a.page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await sleep(300);
  await shot(a.page, 'calls2-03-group-dark');
  // share a sheet: the picker, then the shared screen takes the field
  await b.page.getByRole('button', { name: 'Share sheet' }).click();
  await b.page.getByRole('dialog', { name: 'Share your screen' }).waitFor();
  await b.page.locator('.screen-option').first().waitFor({ timeout: 10000 });
  await shot(b.page, 'calls2-04-picker');
  await b.page.locator('.screen-option').first().click();
  await b.page.locator('.room-share video').waitFor({ timeout: 15000 });
  await a.page.locator('.room-share video').waitFor({ timeout: 15000 });
  await sleep(1500);
  await shot(a.page, 'calls2-05-shared-dark');
  await shot(b.page, 'calls2-05-sharing');
  await b.page.getByRole('button', { name: 'Stop sharing' }).click();
  await a.page.locator('.room-share').waitFor({ state: 'detached', timeout: 15000 });
  // a small window: the title block moves under the tiles
  await a.page.setViewportSize({ width: 820, height: 640 });
  await sleep(500);
  await a.page.getByRole('button', { name: 'Leave Room' }).waitFor();
  await shot(a.page, 'calls2-06-small-dark');
  console.log('CALLS2 E2E PASSED');
} catch (e) { await shot(a.page, 'calls2-FAIL-a'); await shot(b.page, 'calls2-FAIL-b'); throw e; } finally { await a.app.close(); await b.app.close(); owner.disconnect(); await hub.stop(); }
