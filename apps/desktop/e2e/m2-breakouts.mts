// M2 end to end: breakout rooms with four PCs. Priya starts a meeting and rings Ravi, Asha and
// Kiran in; she splits them into two breakout rooms (Ravi and Asha in B1, Kiran in B2), each a
// Room of its own with its own video; sends a note to every room; visits B2; calls everyone back,
// and after the 60-second countdown all four are in the main Room again with video both ways.
// Also measures the renderer's CPU with strong noise suppression on and off, and the main
// thread's long tasks while it runs.
import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';

const { owner, hub } = await startOffice('breakouts');
const apps = {
  priya: await launch('priya', 'Priya Raman'),
  ravi: await launch('ravi', 'Ravi Kumar'),
  asha: await launch('asha', 'Asha Menon'),
  kiran: await launch('kiran', 'Kiran Rao'),
};
const pages = Object.fromEntries(Object.entries(apps).map(([k, v]) => [k, v.page])) as Record<keyof typeof apps, any>;
const results: Record<string, unknown> = {};
const dark = async (p: any, name: string) => { await p.evaluate(() => { document.documentElement.dataset.theme = 'dark'; }); await sleep(250); await shot(p, name); await p.evaluate(() => { document.documentElement.dataset.theme = 'light'; }); };
/** Tiles with moving video from other PCs on this page. */
const liveVideos = (p: any) => p.evaluate(async () => {
  const vids = [...document.querySelectorAll('.room-field .room-tile video')].filter((v) => !(v as HTMLVideoElement).style.transform.includes('scaleX(-1)')) as HTMLVideoElement[];
  const before = vids.map((v) => v.currentTime);
  await new Promise((r) => setTimeout(r, 1200));
  return vids.filter((v, i) => v.videoWidth > 0 && v.currentTime - before[i] > 0.3).length;
});
const waitVideos = async (p: any, n: number, ms = 30000) => { const end = Date.now() + ms; for (;;) { const k = await liveVideos(p); if (k >= n) return k; if (Date.now() > end) throw new Error(`only ${k} of ${n} videos live`); await sleep(500); } };

try {
  for (const p of Object.values(pages)) await p.reload().then(() => p.locator('.frame').waitFor());
  // ------------------------------------------------------------ the meeting, with everyone rung in
  const a = pages.priya;
  await a.locator('.lens-bar .lens', { hasText: 'Meet' }).click();
  await a.getByLabel('Meeting title').fill('Design workshop');
  for (const who of ['Ravi Kumar', 'Asha Menon', 'Kiran Rao']) {
    await a.getByLabel('Ring people in').fill(who.split(' ')[0].toLowerCase());
    await a.locator('.meet-suggest button', { hasText: who }).click();
  }
  await a.getByLabel('Start with my camera on').check();
  await a.getByRole('button', { name: 'Start meeting' }).click();
  await a.getByRole('button', { name: 'Leave Room' }).waitFor({ timeout: 20000 });
  for (const k of ['ravi', 'asha', 'kiran'] as const) {
    const banner = pages[k].locator('.room-banner');
    await banner.waitFor({ timeout: 20000 });
    await banner.getByRole('button', { name: 'Join with video' }).click();
    await pages[k].getByRole('button', { name: 'Leave Room' }).waitFor({ timeout: 20000 });
  }
  for (const p of Object.values(pages)) await waitVideos(p, 3);
  console.log('four in the main Room, video both ways');

  // ------------------------------------------------------------ noise suppression: CPU on and off, and the main thread
  const cpu = async () => apps.priya.app.evaluate(async ({ app }) => {
    const pick = () => app.getAppMetrics().filter((m) => m.type === 'Tab').reduce((n, m) => n + m.cpu.percentCPUUsage, 0);
    pick(); const out: number[] = [];
    for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 4000)); out.push(pick()); }
    return out.sort((x, y) => x - y)[1];
  });
  await a.locator('.tb-sound').click();
  await a.getByText('ON · CLEANING YOUR MIC').waitFor({ timeout: 10000 });
  await shot(a, 'm2-20-sound-menu');
  await a.keyboard.press('Escape');
  // long tasks on the main thread (over 50 ms), counted while the CPU is measured
  await a.evaluate(() => { (window as any).__long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) (window as any).__long.push(e.duration); }).observe({ type: 'longtask', buffered: false }); });
  const longTasks = () => a.evaluate(() => { const l = (window as any).__long as number[]; const out = { count: l.length, maxMs: Math.round(Math.max(0, ...l)), totalMs: Math.round(l.reduce((x, y) => x + y, 0)) }; (window as any).__long = []; return out; });
  await longTasks();
  results.cpuNoiseOn = Math.round(await cpu() * 10) / 10;
  results.longTasksNoiseOn = await longTasks();
  await a.locator('.tb-sound').click();
  await a.getByRole('switch', { name: 'Strong noise suppression' }).click();
  await a.getByText('OFF · BROWSER FILTERS ONLY').waitFor();
  await a.keyboard.press('Escape');
  await longTasks();
  results.cpuNoiseOff = Math.round(await cpu() * 10) / 10;
  results.longTasksNoiseOff = await longTasks();
  await a.locator('.tb-sound').click();
  await a.getByRole('switch', { name: 'Strong noise suppression' }).click();
  await a.getByText('ON · CLEANING YOUR MIC').waitFor({ timeout: 10000 });
  await a.keyboard.press('Escape');
  console.log('noise suppression CPU (renderer, % of one core, median of 3 x 4 s):', results.cpuNoiseOn, 'on,', results.cpuNoiseOff, 'off; long tasks on/off:', results.longTasksNoiseOn, results.longTasksNoiseOff);

  // ------------------------------------------------------------ breakout setup: two rooms, by hand
  await a.getByRole('button', { name: 'Breakout rooms…' }).click();
  await a.locator('.bo-setup').waitFor();
  await a.getByLabel('Room for Ravi Kumar').selectOption('0');
  await a.getByLabel('Room for Asha Menon').selectOption('0');
  await a.getByLabel('Name of breakout room 1').fill('Piping');
  await a.getByLabel('Name of breakout room 2').fill('Civil');
  // Kiran by dragging into the second column
  await a.locator('.bo-col.main li', { hasText: 'Kiran Rao' }).dragTo(a.locator('.bo-col', { has: a.locator('input[aria-label="Name of breakout room 2"]') }));
  await a.locator('.bo-col', { has: a.locator('input[aria-label="Name of breakout room 2"]') }).locator('li', { hasText: 'Kiran Rao' }).waitFor({ timeout: 3000 })
    .catch(async () => { await a.getByLabel('Room for Kiran Rao').selectOption('1'); results.dragFallback = true; });
  await a.locator('.dialog').getByLabel('Timer').selectOption('10');
  await sleep(300);
  await shot(a, 'm2-21-breakout-setup');
  await dark(a, 'm2-21b-breakout-setup-dark');
  await a.getByRole('button', { name: 'Open 2 rooms' }).click();

  // each breakout is a Room of its own, with its own video
  await pages.ravi.locator('.bo-banner', { hasText: 'B1 · PIPING' }).waitFor({ timeout: 15000 });
  await pages.asha.locator('.bo-banner', { hasText: 'B1 · PIPING' }).waitFor({ timeout: 15000 });
  await pages.kiran.locator('.bo-banner', { hasText: 'B2 · CIVIL' }).waitFor({ timeout: 15000 });
  await waitVideos(pages.ravi, 1); await waitVideos(pages.asha, 1);
  assert.equal(await pages.ravi.locator('.room-field .room-tile:not(.open-seat)').count(), 2, 'Ravi sees Asha and himself');
  assert.equal(await pages.kiran.locator('.room-field .room-tile:not(.open-seat)').count(), 1, 'Kiran is alone in B2');
  await pages.priya.locator('.bo-host').waitFor();
  assert.equal(await pages.priya.locator('.room-field .room-tile:not(.open-seat)').count(), 1, 'the host stays in the main Room');
  await sleep(600);
  await shot(pages.ravi, 'm2-22-in-breakout');
  await dark(pages.ravi, 'm2-22b-in-breakout-dark');
  await shot(a, 'm2-23-host-breakouts-running');
  await dark(a, 'm2-23b-host-breakouts-running-dark');

  // a note to every room
  await a.getByLabel('A note to every room').fill('Five minutes left: agree on one routing option');
  await a.getByLabel('A note to every room').press('Enter');
  await pages.kiran.locator('.bo-banner', { hasText: 'agree on one routing option' }).waitFor({ timeout: 10000 });
  await pages.asha.locator('.bo-banner', { hasText: 'agree on one routing option' }).waitFor({ timeout: 10000 });
  // the meeting chat is shared by every room
  // the host visits B2: Kiran sees her
  await a.locator('.bo-list li', { hasText: 'Civil' }).getByRole('button', { name: 'Visit' }).click();
  await waitVideos(pages.kiran, 1);
  assert.equal(await pages.kiran.locator('.room-field .room-tile:not(.open-seat)').count(), 2);
  await waitVideos(a, 1);
  // back to the main Room, then call everyone back
  await a.locator('.bo-list li', { hasText: 'Main Room' }).getByRole('button', { name: 'Back' }).click();
  await a.locator('.bo-list li', { hasText: 'Piping' }).waitFor();
  await sleep(500);
  await a.getByRole('button', { name: 'Call everyone back' }).click();
  for (const p of Object.values(pages)) await p.locator('.bo-banner.amber', { hasText: 'BACK TO THE MAIN ROOM IN' }).waitFor({ timeout: 10000 });
  await sleep(1500);
  await shot(pages.asha, 'm2-24-countdown');
  await dark(pages.asha, 'm2-24b-countdown-dark');
  const t0 = Date.now();
  // the countdown runs its 60 seconds; then everyone is back
  for (const p of Object.values(pages)) await p.locator('.bo-banner').waitFor({ state: 'detached', timeout: 80000 });
  results.callBackSeconds = Math.round((Date.now() - t0) / 1000);
  for (const p of Object.values(pages)) await waitVideos(p, 3, 40000);
  await sleep(800);
  await shot(a, 'm2-25-everyone-back');
  console.log('RESULTS', JSON.stringify(results));
  console.log('BREAKOUTS E2E PASSED');
} catch (e) {
  for (const [k, p] of Object.entries(pages)) await shot(p, `m2-breakouts-FAIL-${k}`).catch(() => {});
  throw e;
} finally {
  for (const x of Object.values(apps)) await x.app.close().catch(() => {});
  owner.disconnect();
  await hub.stop();
}
