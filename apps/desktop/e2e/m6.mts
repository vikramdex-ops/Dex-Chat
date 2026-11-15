import assert from 'node:assert/strict';
import { Hub } from '../../../apps/hub/src/hub.ts';
import { startOffice, launch, shot, sleep } from './harness.mts';

let { owner, hub, dir } = await startOffice('m6');
const p = await launch('priya', 'Priya Raman');
const r = await launch('ravi', 'Ravi Kumar');
try {
  const users = (await owner.request('directory.list')).users;
  const ravi = users.find((u: any) => u.account.endsWith('ravi'))!;
  const dm = await p.page.evaluate((id) => window.dex.request('conv.create', { kind: 'direct', members: [id] }), ravi.id);
  await sleep(1500); // both apps publish their keys
  await p.page.getByRole('button', { name: /^Direct/ }).first().click();
  await p.page.locator('.sb-row', { hasText: 'Ravi' }).click();
  await p.page.locator('.e2e-chip', { hasText: 'Encrypted' }).waitFor({ timeout: 15000 });
  const dock = p.page.locator('.dock textarea').first();
  await dock.fill('Tender figure: 4.2 crore. Keep it between us.');
  await dock.press('Enter');
  await sleep(800);
  const raw = (hub as any).messaging.db.prepare('SELECT body FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT 1').get(dm.id).body as string;
  assert.ok(raw.startsWith('e2e1:'), 'the hub stores only the sealed envelope');
  assert.doesNotMatch(raw, /crore/);
  await r.page.getByRole('button', { name: /^Direct/ }).first().click();
  await r.page.locator('.sb-row', { hasText: 'Priya' }).click();
  await r.page.locator('.timeline').getByText('Tender figure: 4.2 crore').waitFor({ timeout: 10000 });
  await p.page.locator('.e2e-chip').click();
  await p.page.locator('.code.safety').waitFor();
  const codeP = await p.page.locator('.code.safety').innerText();
  await shot(p.page, 'm6-01-encrypted');
  await p.page.keyboard.press('Escape');
  await r.page.locator('.e2e-chip').click();
  assert.equal(await r.page.locator('.code.safety').innerText(), codeP, 'both people see the same safety code');
  await r.page.keyboard.press('Escape');

  // the hub goes down
  owner.disconnect();
  await hub.stop();
  await p.page.locator('.direct-banner').waitFor({ timeout: 30000 });
  await r.page.locator('.direct-banner').waitFor({ timeout: 30000 });
  await sleep(6000); // beacons
  await dock.fill('Hub is down, can you still read me?');
  await dock.press('Enter');
  await r.page.locator('.timeline').getByText('Hub is down, can you still read me?').waitFor({ timeout: 20000 });
  const rdock = r.page.locator('.dock textarea').first();
  await rdock.fill('Yes, straight across the network.');
  await rdock.press('Enter');
  await p.page.locator('.timeline').getByText('Yes, straight across the network.').waitFor({ timeout: 20000 });
  await shot(p.page, 'm6-02-hub-off');
  await shot(r.page, 'm6-03-hub-off-ravi');

  // the hub comes back: what was written meanwhile is added to the history
  hub = new Hub({ dataDir: dir, name: 'E2E Hub', updates: false });
  await hub.start();
  await p.page.locator('.direct-banner').waitFor({ state: 'detached', timeout: 60000 });
  await sleep(3000);
  const rows = (hub as any).messaging.db.prepare('SELECT body FROM messages WHERE conv_id = ? ORDER BY id').all(dm.id) as Array<{ body: string }>;
  assert.equal(rows.length, 3, 'both hub-off messages reached the hub');
  assert.ok(rows.every((x) => x.body.startsWith('e2e1:')));
  // no duplicates on screen after the sync
  await sleep(1000);
  assert.equal(await p.page.locator('.timeline').getByText('Hub is down, can you still read me?').count(), 1);
  assert.equal(await r.page.locator('.timeline').getByText('Yes, straight across the network.').count(), 1);
  await shot(p.page, 'm6-04-synced');
  console.log('M6 E2E PASSED');
} catch (e) {
  await shot(p.page, 'm6-FAIL-p');
  await shot(r.page, 'm6-FAIL-r');
  throw e;
} finally {
  await p.app.close();
  await r.app.close();
  await hub.stop().catch(() => {});
}
