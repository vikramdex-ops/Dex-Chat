// Live pointers end to end. Part 1: Priya opens a drawing (a picture) and asks the Space to look at
// it together; Ravi accepts and points: Priya sees his labelled cursor, a highlight and a numbered
// marker with a note; Priya, presenting, clears them and turns pointers off. Part 2: in a lounge,
// Priya shares her screen; Ravi points at it and his pointer shows in the click-through window on
// Priya's own screen.
import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep, OUT } from './harness.mts';

process.env.DEXCONNECT_POINTER_OVERLAY = '1'; // Xvfb has no compositor; the window still draws, for this check
const { owner, hub } = await startOffice('pointers');
const a = await launch('priya', 'Priya Raman');
const b = await launch('ravi', 'Ravi Kumar');
const theme = (p: any, t: 'light' | 'dark') => p.evaluate((x: string) => { document.documentElement.dataset.theme = x; }, t);
try {
  const users = (await owner.request('directory.list')).users;
  const id = (u: string) => users.find((x: any) => x.account.endsWith(u))!.id;
  const space = await owner.request('conv.create', { kind: 'space', name: 'Checking', members: [id('priya'), id('ravi')] });
  await sleep(500);
  // Priya posts a drawing: a general arrangement, drawn here
  await a.page.evaluate(async (convId: string) => {
    const c = document.createElement('canvas'); c.width = 1600; c.height = 1000;
    const x = c.getContext('2d')!;
    x.fillStyle = '#f7f9f9'; x.fillRect(0, 0, 1600, 1000);
    x.strokeStyle = '#1e6066'; x.lineWidth = 3; x.strokeRect(40, 40, 1520, 920);
    x.lineWidth = 2;
    for (let i = 0; i < 6; i++) { x.strokeRect(160 + i * 220, 300, 160, 360); x.beginPath(); x.arc(240 + i * 220, 280, 40, 0, Math.PI * 2); x.stroke(); }
    x.beginPath(); x.moveTo(100, 760); x.lineTo(1500, 760); x.stroke();
    x.fillStyle = '#15191b'; x.font = '600 34px sans-serif'; x.fillText('PUMP HOUSE · GA · REV C', 80, 110);
    x.strokeRect(1180, 820, 360, 120); x.font = '20px monospace'; x.fillText('DWG P-12513-GA-004', 1200, 870);
    const blob: Blob = await new Promise((r) => c.toBlob((bl) => r(bl!), 'image/png'));
    const f = await (window as any).dex.uploadFile(`e2e-${Date.now()}`, { data: await blob.arrayBuffer(), name: 'P-12513-GA-004.png', mime: 'image/png' });
    await (window as any).dex.request('msg.send', { convId, body: 'GA for the pump house, rev C', files: [f.id], clientId: `e2e-${Date.now()}` });
  }, space.id);
  for (const p of [a.page, b.page]) { await p.reload(); await p.locator('.frame').waitFor(); }
  await a.page.getByRole('button', { name: /^Spaces/ }).first().click();
  if (await a.page.locator('.switchboard.folded').count()) await a.page.getByTitle('Open the Switchboard').click();
  await a.page.locator('.sb-row', { hasText: 'Checking' }).first().click();
  await a.page.locator('.pane img').first().click({ timeout: 15000 });
  await a.page.locator('.lightbox').waitFor();
  await a.page.getByRole('button', { name: 'Look together' }).click();
  await a.page.locator('.coview img').waitFor({ timeout: 15000 });
  // Ravi is asked, and looks
  const card = b.page.locator('.look-card');
  await card.waitFor({ timeout: 15000 });
  assert.match(await card.innerText(), /Priya Raman asks you to look at a picture together/);
  await shot(b.page, 'pointers-00-invite');
  await card.getByRole('button', { name: 'Look' }).click();
  await b.page.locator('.coview img').waitFor({ timeout: 15000 });
  await a.page.locator('.coview .pt-lookers', { hasText: 'LOOKING · 2' }).waitFor({ timeout: 10000 });
  // Ravi points
  await b.page.waitForFunction(() => { const i = document.querySelector('.coview img') as HTMLImageElement; return i && i.naturalWidth > 0; });
  const box = await b.page.locator('.coview img').boundingBox();
  const at = (fx: number, fy: number) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  let p = at(0.3, 0.3);
  await b.page.mouse.move(p.x, p.y);
  p = at(0.33, 0.32);
  await b.page.mouse.move(p.x, p.y, { steps: 6 });
  await a.page.locator('.coview .pt-cursor').waitFor({ timeout: 10000 });
  assert.match(await a.page.locator('.coview .pt-cursor').innerHTML(), /RAVI K\./);
  // where Priya sees it: the same spot of the drawing
  const pa = await a.page.locator('.coview img').boundingBox();
  const seen = await a.page.evaluate(() => { const t = document.querySelector('.coview .pt-cursor')!.getAttribute('transform')!; const m = t.match(/translate\(([\d.]+) ([\d.]+)\)/)!; return { x: Number(m[1]), y: Number(m[2]) }; });
  const layer = await a.page.locator('.coview .pt-layer').boundingBox();
  const fx = (seen.x + layer.x - pa.x) / pa.width, fy = (seen.y + layer.y - pa.y) / pa.height;
  assert.ok(Math.abs(fx - 0.33) < 0.01 && Math.abs(fy - 0.32) < 0.01, `the cursor is on the same spot (${fx.toFixed(3)}, ${fy.toFixed(3)})`);
  // a highlight (kept) and a marker with a note
  await b.page.locator('.coview .pt-tool[title^="Highlight an area"]').click();
  await b.page.locator('.coview .pt-keep input').check();
  const h1 = at(0.12, 0.27), h2 = at(0.45, 0.68);
  await b.page.mouse.move(h1.x, h1.y); await b.page.mouse.down(); await b.page.mouse.move(h2.x, h2.y, { steps: 8 }); await b.page.mouse.up();
  await b.page.locator('.coview .pt-tool[title^="Drop a numbered marker"]').click();
  const m1 = at(0.66, 0.27);
  await b.page.mouse.click(m1.x, m1.y);
  await b.page.locator('.coview .pt-note input').fill('Check this nozzle');
  await b.page.keyboard.press('Enter');
  await a.page.locator('.coview .pt-pin', { hasText: 'Check this nozzle' }).waitFor({ timeout: 10000 });
  await a.page.locator('.coview .pt-hl.kept').waitFor({ timeout: 10000 });
  // Priya drops one too: numbered 2
  await a.page.locator('.coview .pt-tool[title^="Drop a numbered marker"]').click();
  const pb = await a.page.locator('.coview img').boundingBox();
  await a.page.mouse.click(pb.x + pb.width * 0.82, pb.y + pb.height * 0.82);
  await a.page.locator('.coview .pt-note input').fill('Title block: rev C');
  await a.page.keyboard.press('Enter');
  await b.page.locator('.coview .pt-pin', { hasText: 'Title block' }).waitFor({ timeout: 10000 });
  assert.match(await b.page.locator('.coview .pt-pin', { hasText: 'Title block' }).innerHTML(), />2</);
  // ink that fades
  await b.page.locator('.coview .pt-tool[title^="Draw"]').click();
  const i1 = at(0.55, 0.75);
  await b.page.mouse.move(i1.x, i1.y); await b.page.mouse.down();
  for (let k = 1; k <= 12; k++) await b.page.mouse.move(i1.x + k * 14, i1.y + Math.sin(k / 2) * 18);
  await b.page.mouse.up();
  await a.page.locator('.coview .pt-ink').waitFor({ timeout: 10000 });
  p = at(0.7, 0.45);
  await b.page.locator('.coview .pt-tool[title^="Point"]').click();
  await b.page.mouse.move(p.x, p.y, { steps: 4 });
  await sleep(300);
  await theme(a.page, 'light'); await shot(a.page, 'pointers-01-marks-light');
  await theme(a.page, 'dark'); await shot(a.page, 'pointers-01-marks-dark'); await theme(a.page, 'light');
  await shot(b.page, 'pointers-02-ravi-view');
  // the ink fades by itself
  await a.page.locator('.coview .pt-ink').waitFor({ state: 'detached', timeout: 10000 });
  // only the presenter clears and turns pointers off
  assert.equal(await b.page.locator('.coview button', { hasText: 'Clear all' }).count(), 0);
  await a.page.locator('.coview button', { hasText: 'Clear all' }).click();
  await b.page.locator('.coview .pt-pin').first().waitFor({ state: 'detached', timeout: 10000 });
  await a.page.locator('.coview button', { hasText: 'Pointers on' }).click();
  await b.page.locator('.coview .pt-tools-label', { hasText: 'OFF' }).waitFor({ timeout: 10000 });
  assert.ok(await b.page.locator('.coview .pt-tool[title^="Drop a numbered marker"]').isDisabled());
  await a.page.locator('.coview button', { hasText: 'Pointers off' }).click();
  await b.page.keyboard.press('Escape');
  await a.page.keyboard.press('Escape');
  await a.page.keyboard.press('Escape');

  // ---- part 2: a screen shared in a lounge; Ravi's pointer on Priya's own screen
  const lounge = await owner.request('lounge.create', { convId: space.id, name: 'Checking desk' });
  for (const pg of [a.page, b.page]) {
    await pg.getByRole('button', { name: /^Spaces/ }).first().click();
    if (await pg.locator('.switchboard.folded').count()) await pg.getByTitle('Open the Switchboard').click();
    await pg.locator('.lg-row', { hasText: 'Checking desk' }).getByRole('button', { name: 'Join' }).click({ timeout: 15000 });
    await pg.locator('.lg-bar').waitFor({ timeout: 20000 });
  }
  await a.page.locator('.lg-bar').getByRole('button', { name: 'Share' }).click();
  await a.page.locator('.screen-option').first().click({ timeout: 15000 });
  await b.page.locator('.lg-screen video').waitFor({ timeout: 20000 });
  await b.page.waitForFunction(() => { const v = document.querySelector('.lg-screen video') as HTMLVideoElement | null; return !!v && v.videoWidth > 0; }, null, { timeout: 20000 });
  const vb = await b.page.locator('.lg-screen video').boundingBox();
  await b.page.mouse.move(vb.x + vb.width * 0.4, vb.y + vb.height * 0.5);
  await b.page.mouse.move(vb.x + vb.width * 0.45, vb.y + vb.height * 0.52, { steps: 6 });
  let pw: any = null;
  for (let i = 0; i < 50 && !pw; i++) { pw = a.app.windows().find((w: any) => w.url().includes('overlay=pointers')); if (!pw) await sleep(200); }
  assert.ok(pw, 'the presenter has the pointer window');
  await b.page.mouse.move(vb.x + vb.width * 0.5, vb.y + vb.height * 0.55, { steps: 6 });
  await pw.locator('.pt-cursor').waitFor({ timeout: 10000 });
  assert.match(await pw.locator('.pt-cursor').innerHTML(), /RAVI K\./);
  await b.page.locator('.lg-screen .pt-tool[title^="Drop a numbered marker"]').click();
  await b.page.mouse.click(vb.x + vb.width * 0.6, vb.y + vb.height * 0.4);
  await b.page.locator('.lg-screen .pt-note input').fill('this cell');
  await b.page.keyboard.press('Enter');
  await pw.locator('.pt-pin', { hasText: 'this cell' }).waitFor({ timeout: 10000 });
  await sleep(300);
  await pw.screenshot({ path: `${OUT}/pointers-03-presenter-overlay.png`, omitBackground: true });
  await shot(b.page, 'pointers-04-lounge-screen');
  console.log('POINTERS E2E PASSED');
} catch (e) { await shot(a.page, 'pointers-FAIL-a').catch(() => {}); await shot(b.page, 'pointers-FAIL-b').catch(() => {}); throw e; } finally {
  for (const x of [a, b]) await x.app.close().catch(() => {});
  owner.disconnect(); await hub.stop();
}
