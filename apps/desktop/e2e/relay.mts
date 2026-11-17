// A large Room (a Space of 9) runs through the hub's relay: three PCs see and hear each other.
import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';
import { createIdentity } from '../../../packages/core/src/index.ts';
import { HubClient } from '../../../packages/core/src/hub-client.ts';
const { owner, hub } = await startOffice('relay');
const a = await launch('priya', 'Priya Raman');
const b = await launch('ravi', 'Ravi Kumar');
const c = await launch('asha', 'Asha Menon');
const extra: any[] = [];
try {
  for (let i = 0; i < 5; i++) {
    const identity = createIdentity();
    const x = new HubClient({ identity, account: { username: `p${i}`, domain: 'DEX', displayName: `Person ${i}`, hostname: `p${i}` } });
    x.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
    extra.push(x);
    await sleep(300);
  }
  await sleep(1500);
  const users = (await owner.request('directory.list')).users.filter((u: any) => u.role !== 'bot' && u.account !== (owner.session!.me as any).account);
  assert.ok(users.length >= 8, `members: ${users.length}`);
  await owner.request('conv.create', { kind: 'space', name: 'All hands', members: users.map((u: any) => u.id) });
  await sleep(800);
  for (const p of [a.page, b.page, c.page]) { await p.reload(); await p.locator('.frame').waitFor(); }
  await a.page.getByRole('button', { name: /^Spaces/ }).first().click();
  await a.page.locator('.sb-row', { hasText: 'All hands' }).click();
  await a.page.getByRole('button', { name: 'More ways to open a Room' }).click(); await shot(a.page, 'relay-menu');
  await a.page.locator('.room-menu').getByRole('menuitem', { name: /With video/ }).click();
  await a.page.getByRole('button', { name: 'Leave Room' }).waitFor({ timeout: 20000 });
  const mode = await a.page.evaluate(() => window.dex.request('room.list').then((r: any[]) => r[0]?.mode));
  assert.equal(mode, 'relay');
  for (const p of [b.page, c.page]) {
    const banner = p.locator('.room-banner');
    await banner.waitFor({ timeout: 20000 });
    await banner.getByRole('button', { name: 'Join with video' }).click();
    await p.getByRole('button', { name: 'Leave Room' }).waitFor({ timeout: 20000 });
  }
  // everyone sees two others with moving video, and has their sound
  for (const [name, p] of [['priya', a.page], ['ravi', b.page], ['asha', c.page]] as const) {
    await p.waitForFunction(() => {
      const vids = [...document.querySelectorAll('.room-grid video')] as HTMLVideoElement[];
      const playing = vids.filter((v) => v.videoWidth > 0 && v.currentTime > 0.2);
      return playing.length >= 3;
    }, null, { timeout: 30000 }).catch(async (e) => { await shot(p, `relay-FAIL-${name}`); throw e; });
    const audio = await p.evaluate(() => [...document.querySelectorAll('audio, video')].reduce((n, el) => n + (((el as HTMLMediaElement).srcObject as MediaStream | null)?.getAudioTracks().length ?? 0), 0));
    assert.ok(audio >= 2, `${name} hears the others (${audio})`);
  }
  await shot(a.page, 'relay-01-room');
  // someone leaves: the others drop their tile
  await c.page.getByRole('button', { name: 'Leave Room' }).click();
  await a.page.waitForFunction(() => document.querySelectorAll('.room-grid video').length <= 2 || [...document.querySelectorAll('.room-grid video')].filter((v) => (v as HTMLVideoElement).videoWidth > 0).length === 2, null, { timeout: 15000 });
  console.log('RELAY E2E PASSED');
} catch (e) { await shot(a.page, 'relay-FAIL'); throw e; } finally {
  for (const x of [a, b, c]) await x.app.close().catch(() => {});
  for (const x of extra) x.disconnect();
  owner.disconnect(); await hub.stop();
}
