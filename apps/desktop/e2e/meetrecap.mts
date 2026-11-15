// Meeting threads, action points and recaps, end to end, with the real gateway (wrangler dev) for a
// browser guest. Priya schedules a weekly meeting with no conversation: it gets a thread. Before it,
// Ravi writes the agenda in the thread and shares the GA. In the meeting: the chat (to everyone,
// guests too), Mr Rao from a browser chatting and sending a file through the gateway, action points
// captured three ways (a chat line, the capture strip on the stage, promoting the guest's line), and
// a Decision. The hub restarts mid-meeting and the chat is still there. The meeting ends: the recap
// card in the thread and the recap sheet. Ravi ticks his point done; Priya's register shows it. A
// week later the next occurrence brings the open points forward.
// Screenshots at 1440 and 390 wide, light and dark, and one in Hindi.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import pw from 'playwright-core';
import { Hub } from '../../../apps/hub/src/hub.ts';
import { startOffice, launch, sleep, OUT } from './harness.mts';
import { fileURLToPath as rootPath } from 'node:url';
import type { ActionPoint, CalEvent, MeetRecap, MeetingInfo, Message } from '../../../packages/core/src/index.ts';
const ROOT = rootPath(new URL('../../../', import.meta.url));
const SHOTS = process.env.RECAP_OUT ?? path.join(OUT, 'meetrecap');
fs.mkdirSync(SHOTS, { recursive: true });

const free = async () => { const s = net.createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r())); const p = (s.address() as net.AddressInfo).port; await new Promise<void>((r) => s.close(() => r())); return p; };
const office = await startOffice('recap');
const { owner, dir } = office;
let hub: Hub = office.hub;
const gwPort = await free();
const gw = spawn(path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler'), ['dev', '--ip', '127.0.0.1', '--port', String(gwPort), '--persist-to', path.join(OUT, `gw-state-${Date.now()}`), '--show-interactive-dev-session=false'], { cwd: path.join(ROOT, 'apps/gateway'), detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise<void>((res, rej) => { const t = setTimeout(() => rej(new Error('wrangler did not start')), 120_000); const on = (b: Buffer) => { if (/Ready on/.test(b.toString())) { clearTimeout(t); res(); } }; gw.stdout!.on('data', on); gw.stderr!.on('data', on); });
gw.stdout!.resume(); gw.stderr!.resume();
const gwUrl = `http://127.0.0.1:${gwPort}`;
await owner.request('admin.remote.set', { url: gwUrl, enabled: true });
for (let i = 0; i < 80 && !(await owner.request('admin.remote.get')).status.connected; i++) await sleep(100);
assert.ok((await owner.request('admin.remote.get')).status.connected, 'hub reached the gateway');

process.env.DEXCONNECT_TEST_DRIVES = '{"drives":[]}';
const a = await launch('priya', 'Priya Raman', { width: 1440, height: 900 });
const b = await launch('ravi', 'Ravi Kumar', { width: 1280, height: 800 });
const browser = await pw.chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const results: Record<string, unknown> = {};

/** 1440 and 390 wide, light and dark. */
const snap = async (p: any, name: string, sizes: Array<[number, number]> = [[1440, 900], [390, 844]]) => {
  for (const [w, h] of sizes) {
    await p.setViewportSize({ width: w, height: h });
    await sleep(350);
    for (const t of ['light', 'dark']) {
      await p.evaluate((x: string) => { document.documentElement.dataset.theme = x; }, t);
      await sleep(250);
      await p.screenshot({ path: path.join(SHOTS, `${name}-${w}-${t}.png`) });
    }
  }
  await p.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await p.setViewportSize({ width: 1440, height: 900 });
  await sleep(250);
};
const req = (p: any, op: string, data: unknown) => p.evaluate(([o, d]: [string, unknown]) => (window as any).dex.request(o, d), [op, data]);
const joinById = async (p: any, id: string) => {
  // a Room left over from the hub that restarted is left first
  if (await p.getByRole('button', { name: 'Leave Room' }).count()) { await p.getByRole('button', { name: 'Leave Room' }).click().catch(() => {}); await sleep(800); }
  await p.locator('.lens-bar .lens', { hasText: 'Meet' }).click();
  await p.getByLabel('Meeting ID or link').fill(id);
  await p.locator('.meet-join').getByRole('button', { name: 'Join' }).click();
  await p.getByRole('button', { name: 'Leave Room' }).waitFor({ timeout: 25000 });
};
/** Open the meeting's thread from the Switchboard (the Spaces lens). */
const openThread = async (p: any, name: string) => {
  await p.locator('.lens-bar .lens', { hasText: 'Spaces' }).click();
  await p.locator('.sb-row', { hasText: name }).first().click({ timeout: 15000 });
};
const thread = async (convId: string) => (await req(a.page, 'msg.list', { convId, limit: 200 }).catch(() => ({ messages: [] as Message[] }))).messages as Message[];

try {
  for (const p of [a.page, b.page]) { await p.reload(); await p.locator('.frame').waitFor(); }
  const ravi = hub.store.activeUsers().find((u) => /ravi/.test(u.account))!;
  const priyaId = hub.store.activeUsers().find((u) => /priya/.test(u.account))!.id;

  // ------------------------------------------------------------ scheduled, with no conversation: it gets a thread
  const start = Date.now() + 20 * 60_000;
  const ev = await req(a.page, 'cal.create', { title: 'Pump skid P-12 weekly review', startAt: start, endAt: start + 3600_000, attendees: [ravi.id], online: true, recurrence: 'weekly' }) as CalEvent;
  assert.ok(ev.convId, 'the meeting has a thread');
  results.thread = ev.convId;
  // before the meeting: Ravi writes the agenda and shares the GA in the thread
  await openThread(b.page, 'Pump skid P-12 weekly review');
  const ga = path.join(OUT, 'P12-GA-rev3.pdf');
  fs.writeFileSync(ga, '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  await b.page.locator('.dock input[type=file]').setInputFiles([ga]);
  await b.page.locator('.attach-chip.done').first().waitFor({ timeout: 15000 });
  await b.page.locator('.dock textarea').first().fill('Agenda: 1. client GA comments 2. nozzle loads. GA rev 3 attached.');
  await b.page.locator('.dock textarea').first().press('Enter');
  await b.page.locator('.msg', { hasText: 'GA rev 3 attached' }).waitFor({ timeout: 15000 });
  await sleep(500);
  await snap(b.page, 'recap-01-thread-before', [[1440, 900]]);

  // ------------------------------------------------------------ the meeting: Priya starts it early, Ravi joins, the guest link
  const m = await req(a.page, 'meet.event', { eventId: ev.id }) as MeetingInfo;
  await joinById(a.page, m.id);
  // the files shared beforehand are in the Room's panel
  await a.page.getByRole('tab', { name: /Files/ }).click();
  await a.page.locator('.room-panel-body', { hasText: 'P12-GA-rev3.pdf' }).waitFor({ timeout: 15000 });
  await joinById(b.page, m.id);
  await a.page.getByRole('tab', { name: /People/ }).click();
  await a.page.locator('.guest-settings summary').click();
  await a.page.getByRole('switch', { name: 'Guests can join from a browser' }).click();
  await a.page.locator('.guest-url').waitFor({ timeout: 10000 });
  const url = (await a.page.locator('.guest-url').innerText()).trim();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const g = await ctx.newPage();
  g.on('pageerror', (e: Error) => console.log('[guest pageerror]', e.message));
  await g.goto(url);
  await g.locator('#join-name').fill('Mr Rao');
  await g.getByRole('button', { name: /Join the meeting|Ask to join/ }).click();
  const row = a.page.locator('.room-lobby li', { hasText: 'Mr Rao' });
  await row.waitFor({ timeout: 20000 });
  await row.getByRole('button', { name: 'Admit' }).click();
  await g.locator('.room .tile').first().waitFor({ timeout: 20000 });
  // the guest chats and sends a file through the gateway
  await g.getByLabel('Message to the meeting').fill('Good morning. The pump curves are attached.');
  await g.getByLabel('Message to the meeting').press('Enter');
  const curves = path.join(OUT, 'pump-curves-P12.csv');
  fs.writeFileSync(curves, 'flow,head\n' + Array.from({ length: 3000 }, (_, i) => `${i},${(80 - i / 50).toFixed(2)}`).join('\n'));
  await g.locator('.compose input[type=file]').setInputFiles(curves);
  await a.page.getByRole('tab', { name: /Chat/ }).click();
  await a.page.locator('.room-chat .meet-chat-body', { hasText: 'pump curves are attached' }).waitFor({ timeout: 15000 });
  await a.page.locator('.room-chat .meet-chat-file', { hasText: 'pump-curves-P12.csv' }).waitFor({ timeout: 30000 });
  await a.page.getByLabel('Message to everyone in the Room').fill('Welcome Mr Rao. Sheet 3 first.');
  await a.page.getByLabel('Message to everyone in the Room').press('Enter');
  await g.locator('.chat .line-body', { hasText: 'Sheet 3 first' }).waitFor({ timeout: 10000 });
  await g.screenshot({ path: path.join(SHOTS, 'recap-02-guest-chat-file.png') });

  // ------------------------------------------------------------ action points, three ways
  // 1. a chat line: the preview reads owner and date as it is typed
  const box = a.page.getByLabel('Message to everyone in the Room');
  await box.fill('/action Ravi to send the revised GA by Fri');
  await a.page.locator('.room-chat .ap-preview').waitFor();
  assert.match(await a.page.locator('.room-chat .ap-preview').innerText(), /Send the revised GA/);
  assert.equal(await a.page.locator('.room-chat .ap-preview select[aria-label="Owner"]').inputValue(), ravi.id);
  await snap(a.page, 'recap-03-chat-preview', [[1440, 900]]);
  await box.press('Enter');
  await a.page.locator('.room-chat .meet-chat-body', { hasText: '→ Send the revised GA' }).waitFor({ timeout: 10000 });
  // 2. the capture strip: A on the stage
  await a.page.locator('.room-field').click({ position: { x: 300, y: 200 } });
  await a.page.keyboard.press('a');
  const strip = a.page.getByLabel('Action point: who, what, by when');
  await strip.waitFor({ timeout: 5000 });
  await strip.fill('Mr Rao to confirm the nozzle loads by 20 Nov');
  await a.page.locator('.ap-capture .ap-preview').waitFor();
  await snap(a.page, 'recap-04-capture-strip');
  await strip.press('Enter');
  await sleep(800);
  await a.page.keyboard.press('Escape');
  // 3. promote the guest's line
  const line = a.page.locator('.room-chat .meet-chat-line', { hasText: 'pump curves are attached' });
  await line.hover();
  await line.getByRole('button', { name: 'Make an action point' }).click();
  const dlg = a.page.getByRole('dialog', { name: 'Make an action point' });
  await dlg.getByRole('textbox', { name: 'What needs doing' }).fill('Check the pump curves against the datasheet');
  await dlg.getByRole('combobox', { name: 'Owner' }).selectOption(ravi.id);
  await dlg.getByRole('button', { name: 'Log action point' }).click();
  await dlg.waitFor({ state: 'detached' });
  // a Decision in the meeting
  await req(a.page, 'decision.create', { convId: ev.convId, root: { prompt: 'Go with the vendor nozzle loads?', options: [{ label: 'Accept' }, { label: 'Ask for revision' }] } });
  // the register: AP-01…03 and the decision
  await a.page.getByRole('tab', { name: /Register/ }).click();
  await a.page.locator('.meet-register .ap-ref', { hasText: 'AP-03' }).waitFor({ timeout: 10000 });
  await a.page.locator('.meet-register .reg-decision', { hasText: 'Go with the vendor nozzle loads?' }).waitFor({ timeout: 10000 });
  const reg = (await req(a.page, 'ap.list', { convId: ev.convId })) as { actions: ActionPoint[] };
  results.register = reg.actions.map((x) => `AP-${String(x.n).padStart(2, '0')} ${x.text} · ${x.ownerId ? 'Ravi' : x.ownerName} · ${x.due ?? '—'} · ${x.source}`);
  assert.deepEqual(reg.actions.map((x) => x.source), ['chat', 'strip', 'promote']);
  assert.equal(reg.actions[1].ownerName, 'Mr Rao');
  assert.equal(reg.actions[0].ownerId, ravi.id);
  await snap(a.page, 'recap-05-register');
  // the owner heard once, and it is on his Desk and day sheet
  const saved = await req(b.page, 'desk.saved', {}) as Array<{ message: Message; kind: string }>;
  assert.ok(saved.filter((s) => s.kind === 'todo').length >= 2, 'on his Desk as To-dos');
  const sheet = await req(b.page, 'nib.me', {}) as { items: Array<{ activity: string; giverId: string | null }> };
  assert.ok(sheet.items.some((i) => /AP-01/.test(i.activity) && i.giverId === priyaId), 'on his day sheet, given by Priya');

  // ------------------------------------------------------------ the guest leaves; the hub restarts mid-meeting
  await g.getByRole('button', { name: 'Leave' }).click();
  await g.getByRole('heading', { name: 'Thanks for joining' }).waitFor({ timeout: 10000 });
  const port = hub.port;
  owner.disconnect();
  await hub.stop();
  // the same data folder and port: the apps and the gateway connection come back by themselves
  hub = new Hub({ dataDir: dir, name: 'E2E Hub', updates: false, port, ...(process.env.POL1_ISOLATED === '1' ? { discoveryPort: false } : {}) });
  await hub.start();
  // the apps come back by themselves; the Room is gone with the old hub: Priya and Ravi rejoin by the ID
  for (const p of [a.page, b.page]) {
    await p.getByRole('button', { name: 'Leave Room' }).waitFor({ state: 'detached', timeout: 60000 }).catch(() => {});
  }
  await sleep(1500);
  for (const p of [a.page, b.page]) {
    for (let i = 0; i < 30; i++) { const ok = await req(p, 'meet.get', { id: m.id }).then(() => true, () => false); if (ok) break; await sleep(1000); }
  }
  await joinById(a.page, m.id);
  await a.page.getByRole('tab', { name: /Chat/ }).click();
  const sheetBtn = a.page.getByRole('tab', { name: /Everyone here/ });
  if (await sheetBtn.count()) await sheetBtn.click();
  // the meeting chat said before the restart is still there (read from the thread)
  const after = await req(a.page, 'room.chatLog', { roomId: (await req(a.page, 'room.list', {}) as Array<{ id: string; meetingId?: string }>).find((r) => r.meetingId === m.id)!.id }) as Array<{ text: string; name: string }>;
  results.chatAfterRestart = after.map((l) => `${l.name}: ${l.text}`);
  assert.ok(after.some((l) => /pump curves are attached/.test(l.text) && l.name === 'Mr Rao'), 'the guest\'s line survived the restart');
  assert.ok(after.some((l) => /Sheet 3 first/.test(l.text)), 'Priya\'s line survived the restart');
  await joinById(b.page, m.id);
  await sleep(800);
  await a.page.screenshot({ path: path.join(SHOTS, 'recap-06-after-restart-1440-light.png') });

  // ------------------------------------------------------------ the end: the recap card and the recap sheet
  await a.page.getByRole('tab', { name: /People/ }).click();
  await a.page.getByRole('button', { name: 'End for everyone' }).click();
  await a.page.locator('.confirm-actions').getByRole('button', { name: 'End for everyone' }).click();
  await a.page.getByRole('button', { name: 'Leave Room' }).waitFor({ state: 'detached', timeout: 15000 });
  await openThread(a.page, 'Pump skid P-12 weekly review');
  const card = a.page.locator('.recap-card').last();
  await card.waitFor({ timeout: 20000 });
  results.recapCard = (await card.innerText()).replace(/\s+/g, ' ');
  assert.match(results.recapCard as string, /MEETING RECAP/);
  await snap(a.page, 'recap-07-card-in-thread');
  await card.getByRole('button', { name: 'Open the recap' }).click();
  const sheetEl = a.page.locator('.recap-sheet');
  await sheetEl.locator('.recap-table tbody tr', { hasText: 'Mr Rao' }).waitFor({ timeout: 15000 });
  assert.match(await sheetEl.innerText(), /AP-03/);
  assert.match(await sheetEl.innerText(), /pump-curves-P12\.csv/);
  assert.match(await sheetEl.innerText(), /Go with the vendor nozzle loads\?/);
  await sheetEl.locator('.recap-chat summary').click();
  await sheetEl.locator('.recap-lines li', { hasText: 'pump curves are attached' }).waitFor({ timeout: 10000 });
  await snap(a.page, 'recap-08-sheet');
  await sheetEl.locator('.recap-body').evaluate((el: HTMLElement) => { el.scrollTop = el.scrollHeight; });
  await snap(a.page, 'recap-09-sheet-chat', [[1440, 900]]);
  // Send by email: only action points and files, for the guest
  await sheetEl.getByRole('button', { name: 'Send by email' }).click();
  await sheetEl.getByRole('button', { name: 'For guests' }).click();
  await a.page.screenshot({ path: path.join(SHOTS, 'recap-10-send-1440-light.png') });
  await sheetEl.getByRole('button', { name: 'Cancel' }).click();
  await a.page.keyboard.press('Escape');

  // ------------------------------------------------------------ Ravi ticks his point done; Priya's recap follows
  await openThread(b.page, 'Pump skid P-12 weekly review');
  const tick = b.page.getByRole('checkbox', { name: 'Mark AP-01 done' }).first();
  await tick.waitFor({ timeout: 15000 });
  await tick.click();
  await b.page.getByRole('checkbox', { name: /AP-01 is done/ }).first().waitFor({ timeout: 10000 });
  await snap(b.page, 'recap-11-owner-ticked', [[1440, 900]]);
  const occs = await req(a.page, 'meet.thread', { convId: ev.convId }) as { occurrences: Array<{ id: string }> };
  const recap = await req(a.page, 'meet.recap', { occurrenceId: occs.occurrences[0].id }) as MeetRecap;
  assert.equal(recap.actions.find((x) => x.n === 1)?.status, 'done');
  results.recapActions = recap.actions.map((x) => `AP-${x.n} ${x.status}`);
  // in Hindi
  await a.page.evaluate(() => localStorage.setItem('dex.language', 'hi'));
  await a.page.reload(); await a.page.locator('.frame').waitFor();
  await a.page.evaluate((id: string) => window.dispatchEvent(new CustomEvent('dex-recap', { detail: id })), occs.occurrences[0].id);
  await a.page.locator('.recap-sheet .recap-table').waitFor({ timeout: 15000 });
  await sleep(500);
  await a.page.screenshot({ path: path.join(SHOTS, 'recap-12-sheet-hindi-1440-light.png') });
  await a.page.keyboard.press('Escape');
  await a.page.evaluate(() => localStorage.setItem('dex.language', 'en'));
  await a.page.reload(); await a.page.locator('.frame').waitFor();

  // ------------------------------------------------------------ between meetings: an action point from the thread's Dock
  await openThread(a.page, 'Pump skid P-12 weekly review');
  await a.page.locator('.dock textarea').first().fill('→ Ravi to issue the line list tomorrow');
  await a.page.locator('.ap-preview').first().waitFor({ timeout: 5000 });
  await a.page.locator('.dock textarea').first().press('Enter');
  await a.page.locator('.msg', { hasText: 'Issue the line list' }).locator('.ap-strip', { hasText: 'AP-04' }).waitFor({ timeout: 10000 });
  await a.page.screenshot({ path: path.join(SHOTS, 'recap-12b-dock-action-1440-light.png') });

  // ------------------------------------------------------------ a week later: the next occurrence brings the open points forward
  hub.meetThreads.setClock(start + 7 * 86400_000 - 5 * 60_000);
  await joinById(a.page, m.id);
  await a.page.getByRole('tab', { name: /Register/ }).click();
  await a.page.locator('.meet-register .reg-sub', { hasText: 'BROUGHT FORWARD' }).waitFor({ timeout: 15000 });
  const forward = await a.page.locator('.meet-register .reg-ap').allInnerTexts();
  results.broughtForward = forward.map((x) => x.replace(/\s+/g, ' '));
  assert.ok(forward.some((x) => /AP-02/.test(x)) && forward.some((x) => /AP-03/.test(x)) && forward.some((x) => /AP-04/.test(x)), 'open points carried');
  assert.ok(!forward.some((x) => /AP-01/.test(x)), 'the done one is not');
  await snap(a.page, 'recap-13-next-occurrence');
  await a.page.getByRole('button', { name: 'Leave Room' }).click();
  hub.meetThreads.setClock(null);
  const cards = (await thread(ev.convId!)).filter((x) => x.meetCard).map((x) => x.meetCard!.kind);
  results.cards = cards;
  console.log('RESULTS', JSON.stringify(results, null, 1));
  console.log('MEETRECAP E2E PASSED');
} catch (e) {
  await a.page.screenshot({ path: path.join(SHOTS, 'recap-FAIL-priya.png') }).catch(() => {});
  await b.page.screenshot({ path: path.join(SHOTS, 'recap-FAIL-ravi.png') }).catch(() => {});
  console.log('RESULTS so far', JSON.stringify(results, null, 1));
  throw e;
} finally {
  await browser.close().catch(() => {});
  await a.app.close().catch(() => {});
  await b.app.close().catch(() => {});
  owner.disconnect();
  await hub.stop().catch(() => {});
  try { process.kill(-gw.pid!, 'SIGKILL'); } catch { /* gone */ }
}

