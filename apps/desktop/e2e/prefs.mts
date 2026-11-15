import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';
const { owner, hub } = await startOffice('prefs');
const { app, page } = await launch('priya', 'Priya Raman');
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  const sp = await owner.request('conv.create', { kind: 'space', name: 'P-12 Piping', members: [priya.id] });
  for (let i = 1; i <= 8; i++) await owner.request('msg.send', { convId: sp.id, body: `Update ${i}: line 10${i} checked`, clientId: `c${i}` });
  // capture notifications in the main process
  await app.evaluate(({ ipcMain }) => { (globalThis as any).notes = []; ipcMain.removeAllListeners('app:notify'); ipcMain.on('app:notify', (_e, t, b) => (globalThis as any).notes.push([t, b])); });
  await page.keyboard.press('Control+,');
  await page.getByRole('heading', { name: 'Notifications' }).waitFor();
  await page.getByRole('group', { name: 'Ping me for' }).getByRole('button', { name: "Only what's addressed to me" }).click();
  await page.getByRole('group', { name: 'Sound' }).getByRole('button', { name: 'Drop' }).click();
  await page.getByRole('group', { name: 'Density' }).getByRole('button', { name: 'Compact' }).click();
  await page.getByLabel('Show message text in notifications').click();
  await page.getByRole('heading', { name: 'Notifications' }).scrollIntoViewIfNeeded();
  await shot(page, 'prefs-01-settings');
  let s = await page.evaluate(() => window.dex.getState().then((x) => x.settings));
  assert.equal(s.notifyFor, 'mentions'); assert.equal(s.sound, 'drop'); assert.equal(s.density, 'compact'); assert.equal(s.showPreviews, false);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.density), 'compact');
  // text size from the keyboard
  await page.keyboard.press('Control+=');
  await sleep(300);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()), 1.1);
  await page.keyboard.press('Control+0');
  await sleep(300);
  // ordinary Space message: no notification; a mention: notification without text
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.blur());
  await sleep(800);
  await app.evaluate(() => { (globalThis as any).notes = []; });
  await owner.request('msg.send', { convId: sp.id, body: 'ordinary update', clientId: 'o1' });
  await owner.request('msg.send', { convId: sp.id, body: `<@${priya.id}> please look`, clientId: 'o2' });
  await sleep(1200);
  const notes = await app.evaluate(() => (globalThis as any).notes);
  console.log(JSON.stringify(notes)); assert.equal(notes.length, 1);
  assert.match(notes[0][0], /^@ you in P-12 Piping · Vikram Shah$/); assert.equal(notes[0][1], 'New message');
  // compact timeline and the shortcuts sheet
  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  await page.locator('.sb-row', { hasText: 'P-12 Piping' }).click();
  await page.locator('.msg', { hasText: 'Update 8' }).waitFor();
  await shot(page, 'prefs-02-compact');
  await page.keyboard.press('Control+/');
  const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await sheet.waitFor();
  await sheet.getByText('Go to a person, conversation or command').waitFor();
  assert.equal(await sheet.getByText('/away').count(), 0, 'no command that does not exist');
  // Ctrl+Shift+Q quiets sounds
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Shift+Q');
  await page.getByText(/^Sounds quiet/).waitFor();
  assert.equal((await page.evaluate(() => window.dex.getState().then((x) => x.settings))).sound, 'none');
  await page.keyboard.press('Control+Shift+Q');
  await page.getByText('Sounds back on').waitFor();
  await page.keyboard.press('Control+/');
  await shot(page, 'prefs-03-shortcuts');
  console.log('PREFS E2E PASSED');
} catch (e) { await shot(page, 'prefs-FAIL'); throw e; } finally { await app.close(); owner.disconnect(); await hub.stop(); }
