import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startOffice, launch, shot, sleep, OUT } from './harness.mts';
const { owner, hub } = await startOffice('share');
const { app, page } = await launch('priya', 'Priya Raman');
try {
  const file = path.join(OUT, 'ISO-1001 Rev B.csv');
  fs.writeFileSync(file, 'Line,Size,Spec\n6"-P-1001-A1B,6,A1B\n');
  const owner_ = (await owner.request('directory.list')).users.find((u: any) => u.account.endsWith('vikram'))!;
  const url = `dexconnect://share?from=${encodeURIComponent('Project Opener')}&to=vikram&text=${encodeURIComponent('Rev B of ISO-1001 is ready for checking')}&file=${encodeURIComponent(file)}&title=Job%20P-12513&link=${encodeURIComponent('https://example.invalid/p12513')}`;
  await app.evaluate(({ BrowserWindow }, u) => BrowserWindow.getAllWindows()[0].webContents.send('app:deeplink', u), url);
  await page.getByRole('dialog', { name: 'Share to Dexterity Connect' }).waitFor();
  await page.locator('.share-to', { hasText: 'Vikram Shah' }).waitFor();
  await sleep(300);
  await shot(page, 'share-01-dialog');
  await page.getByRole('dialog').getByRole('button', { name: 'Share' }).click();
  await page.getByText('Shared').first().waitFor();
  await sleep(800);
  // the direct conversation with the colleague who shared, not one with a bot (the system bot tells the owner their seat)
  const bots = new Set((await owner.request('directory.list')).users.filter((u: any) => u.role === 'bot').map((u: any) => u.id));
  const dm = (await owner.request('conv.list')).find((c: any) => c.kind === 'direct' && c.members.every((m: string) => !bots.has(m)));
  const msgs = (await owner.request('msg.list', { convId: dm.id })).messages;
  const last = msgs.at(-1);
  assert.match(last.body.startsWith('e2e1:') ? 'sealed' : last.body, /sealed|Rev B of ISO-1001/);
  assert.equal(last.files[0].name, 'ISO-1001 Rev B.csv');
  await shot(page, 'share-02-sent');
  console.log('SHARE E2E PASSED', last.body.startsWith('e2e1:') ? '(sealed)' : '(plain)');
} catch (e) { await shot(page, 'share-FAIL'); throw e; } finally { await app.close(); owner.disconnect(); await hub.stop(); }
