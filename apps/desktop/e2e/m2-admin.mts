// M2: the Control room's meeting settings and meeting totals (an administrator's Electron app),
// after a few meetings held through the hub by scripted colleagues; and the Calendar meeting
// dialog's invitations.
import assert from 'node:assert/strict';
import { createIdentity } from '../../../packages/core/src/index.ts';
import { HubClient } from '../../../packages/core/src/hub-client.ts';
import { startOffice, launch, shot, sleep } from './harness.mts';

const { owner, hub } = await startOffice('admin');
const ready = (c: HubClient) => new Promise<void>((r) => { const on = (s: { kind: string }) => { if (s.kind === 'ready') { c.off('state', on); r(); } }; c.on('state', on); });
const ravi = new HubClient({ identity: createIdentity(), account: { username: 'ravi', domain: 'DEX', displayName: 'Ravi Kumar', hostname: 'RAVI-PC' } });
ravi.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
await ready(ravi);
const a = await launch('priya', 'Priya Raman');
const dark = async (p: any, name: string) => { await p.evaluate(() => { document.documentElement.dataset.theme = 'dark'; }); await sleep(250); await shot(p, name); await p.evaluate(() => { document.documentElement.dataset.theme = 'light'; }); };
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  const raviId = users.find((u: any) => u.account.endsWith('ravi'))!.id;
  await owner.request('admin.setRole', { userId: priya.id, role: 'admin' });
  // three short meetings between the owner and Ravi
  for (const title of ['Pump skid review', 'Weekly coordination', 'Vendor call']) {
    const m = await owner.request('meet.create', { title, invite: [raviId] });
    const room = (await owner.request('meet.join', { id: m.id })).room;
    await ravi.request('meet.join', { id: m.id });
    await ravi.request('room.react', { roomId: room.id, emoji: '👍' });
    await sleep(600);
    await owner.request('room.end', { roomId: room.id });
  }
  // a Calendar meeting held as a call, organised by Priya
  const start = Date.now() + 86400_000;
  await a.page.reload(); await a.page.locator('.frame').waitFor();
  const ev = await a.page.evaluate(async ({ start, raviId }) => window.dex.request('cal.create', { title: 'Site handover with the client', startAt: start, endAt: start + 3600_000, attendees: [raviId], online: true }), { start, raviId });
  assert.ok(ev.id);
  await a.page.locator('.lens-bar .lens', { hasText: 'Calendar' }).click();
  if (new Date().getDay() === 0) await a.page.getByRole('button', { name: 'Next week' }).click(); // tomorrow is in next week's sheet
  await a.page.getByText('Site handover with the client').first().click({ timeout: 15000 });
  const edit = a.page.getByRole('button', { name: /Edit/ });
  if (await edit.count()) await edit.first().click();
  await a.page.getByRole('button', { name: 'Download invitation (.ics)' }).waitFor({ timeout: 15000 });
  await a.page.getByRole('switch', { name: 'Guests can join from a browser' }).click();
  await a.page.locator('.guest-pass').waitFor({ timeout: 10000 });
  await sleep(300);
  await a.page.locator('.meet-invite-block').scrollIntoViewIfNeeded();
  await shot(a.page, 'm2-30-calendar-invitations');
  await dark(a.page, 'm2-30b-calendar-invitations-dark');
  await a.page.keyboard.press('Escape');

  // the Control room
  await a.page.locator('.me-btn').click();
  await a.page.getByRole('menuitem', { name: /Control room/ }).click();
  await a.page.getByRole('button', { name: 'Policies' }).click();
  await a.page.locator('.card', { hasText: 'Hosts can invite guests who join from a browser' }).scrollIntoViewIfNeeded();
  await sleep(300);
  await shot(a.page, 'm2-31-control-room-meetings');
  await dark(a.page, 'm2-31b-control-room-meetings-dark');
  await a.page.getByRole('button', { name: 'Usage' }).click();
  await a.page.locator('.meet-totals .usage-tiles').waitFor({ timeout: 15000 });
  await a.page.locator('.meet-totals').scrollIntoViewIfNeeded();
  await sleep(400);
  const meetings = await a.page.locator('.meet-totals .usage-tiles .tile').first().innerText();
  assert.match(meetings, /3/);
  await shot(a.page, 'm2-32-control-room-totals');
  await dark(a.page, 'm2-32b-control-room-totals-dark');
  console.log('ADMIN E2E PASSED');
} catch (e) { await shot(a.page, 'm2-admin-FAIL'); throw e; } finally {
  await a.app.close().catch(() => {});
  ravi.disconnect(); owner.disconnect();
  await hub.stop();
}
