import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';
const { owner, hub } = await startOffice('clips');
const { app, page } = await launch('priya', 'Priya Raman');
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  const sp = await owner.request('conv.create', { kind: 'space', name: 'P-12 Piping', members: [priya.id] });
  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  await page.locator('.sb-row', { hasText: 'P-12 Piping' }).click();
  await page.getByTitle('Insert', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Video message' }).click();
  await page.getByRole('button', { name: 'Start recording' }).click({ timeout: 15000 });
  await sleep(2600);
  await shot(page, 'clips-01-recording');
  await page.getByRole('button', { name: 'Stop' }).click();
  await page.locator('.dialog .btn.primary', { hasText: 'Send' }).waitFor();
  console.log('review', await page.locator('.clip-stage video').evaluate((v: HTMLVideoElement) => [v.readyState, v.videoWidth]));
  await sleep(1500);
  await shot(page, 'clips-02-review');
  await page.locator('.dialog .btn.primary', { hasText: 'Send' }).click();
  await page.locator('.video-clip video').waitFor({ timeout: 15000 });
  const tl = await owner.request('msg.list', { convId: sp.id });
  const f = (tl.messages ?? tl).flatMap((m: any) => m.files)[0];
  assert.equal(f.mime, 'video/webm');
  assert.match(f.name, /^Video message \ds\.webm$/);
  // it plays as video
  const dims = await page.locator('.video-clip video').evaluate((v: HTMLVideoElement) => new Promise((r) => { const done = () => r([v.videoWidth, v.videoHeight]); if (v.readyState >= 1) done(); else v.onloadedmetadata = done; setTimeout(() => r([v.videoWidth, v.videoHeight]), 5000); }));
  assert.ok((dims as number[])[0] > 0, `video has a picture: ${dims}`);
  await shot(page, 'clips-03-message');
  console.log('CLIPS E2E PASSED');
} catch (e) { await shot(page, 'clips-FAIL'); throw e; } finally { await app.close(); owner.disconnect(); await hub.stop(); }
