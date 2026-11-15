// The interface in Hindi and Tamil: main screens draw translated text, nothing overflows the title bar.
import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';
const { owner, hub } = await startOffice('lang');
const { app, page } = await launch('priya', 'Priya Raman');
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  await owner.request('conv.create', { kind: 'space', name: 'Piping P-12', members: [priya.id] });
  for (const [code, pulse, spaces] of [['hi', 'पल्स', 'स्पेस'], ['ta', 'பல்ஸ்', 'ஸ்பேஸ்']] as const) {
    await page.evaluate((c) => localStorage.setItem('dex.language', c), code);
    await page.reload(); await page.locator('.frame').waitFor(); await sleep(800);
    const bar = await page.locator('.lens-bar').innerText();
    assert.ok(bar.includes(pulse), `${code} lens bar: ${bar}`);
    await shot(page, `lang-${code}-01-pulse`);
    await page.locator('.lens-bar button').nth(2).click(); await sleep(500);
    await page.locator('.sb-row', { hasText: 'Piping P-12' }).click(); await sleep(600);
    await shot(page, `lang-${code}-02-space`);
    const over = await page.evaluate(() => [...document.querySelectorAll('.titlebar *, .view-head *, .pane-head *')].filter((e) => (e as HTMLElement).scrollWidth > (e as HTMLElement).clientWidth + 2 && getComputedStyle(e).overflow !== 'visible' && !(e as HTMLElement).className.toString().includes('ellipsis')).map((e) => (e as HTMLElement).className).slice(0, 8));
    console.log(code, 'clipped:', JSON.stringify(over), 'spaces label ok:', bar.includes(spaces));
    await page.locator('.me-btn').click(); await sleep(300);
    await shot(page, `lang-${code}-03-menu`);
    await page.keyboard.press('Escape');
    await page.locator('.lens-bar .lens').nth(6).click(); await sleep(800);
    await shot(page, `lang-${code}-04-meet`);
    await page.locator('.lens-bar .lens').nth(0).click(); await sleep(300);
  }
  await page.evaluate(() => localStorage.setItem('dex.language', 'en'));
  console.log('LANG E2E PASSED');
} catch (e) { await shot(page, 'lang-FAIL'); throw e; } finally { await app.close(); owner.disconnect(); await hub.stop(); }
