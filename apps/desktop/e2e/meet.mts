// Meetings M1 end to end with three PCs (Priya hosts, Ravi is invited, Asha comes by the ID):
// the Meet lens, an instant meeting, the lobby, co-hosts, mute and ask to unmute, hands,
// reactions, layouts with pin and spotlight, presentation, the panel's tabs (chat, polls, board,
// files), a virtual background, lock, remove, end for everyone, recent meetings, a personal room
// by link, a Calendar meeting held as a call with the camera consent policy, and Meet on phones.
// Also measures the time from Join to the first remote frame, and the renderer's CPU in a
// three-person gallery.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startOffice, launch, shot, sleep, OUT } from './harness.mts';

const { owner, hub } = await startOffice('meet');
const a = await launch('priya', 'Priya Raman');
const b = await launch('ravi', 'Ravi Kumar');
const c = await launch('asha', 'Asha Menon');
const pages = { priya: a.page, ravi: b.page, asha: c.page } as const;
const results: Record<string, unknown> = {};
const dark = async (p: any, name: string) => { await p.evaluate(() => { document.documentElement.dataset.theme = 'dark'; }); await sleep(250); await shot(p, name); await p.evaluate(() => { document.documentElement.dataset.theme = 'light'; }); };
const toast = (p: any, text: RegExp | string) => p.locator('.toast', { hasText: text }).first().waitFor({ timeout: 10000 });
const rowMenu = async (p: any, who: string) => { await p.locator('.room-schedule tr', { hasText: who }).locator('.row-menu').click(); await p.locator('.room-person-menu').waitFor(); };
const tab = (p: any, name: RegExp) => p.getByRole('tab', { name }).click();
const devices = async () => {
  const list = await a.page.evaluate(() => window.dex.request('room.list'));
  const r = list[0];
  const by = (re: RegExp) => r.participants.find((p: any) => re.test(users.find((u: any) => u.id === p.userId)!.displayName))?.deviceId;
  return { room: r, priya: by(/Priya/), ravi: by(/Ravi/), asha: by(/Asha/) };
};
let users: any[] = [];

try {
  users = (await owner.request('directory.list')).users;
  for (const p of Object.values(pages)) await p.reload().then(() => p.locator('.frame').waitFor());

  // ---------------------------------------------------------------- the Meet lens
  await a.page.locator('.lens-bar .lens', { hasText: 'Meet' }).click();
  await a.page.locator('.view.meet .meet-number span').first().waitFor({ timeout: 15000 });
  await sleep(400);
  await shot(a.page, 'meet-01-lens');
  await dark(a.page, 'meet-01b-lens-dark');

  // ---------------------------------------------------------------- an instant meeting, with Ravi rung in
  await a.page.getByLabel('Meeting title').fill('Pump skid review');
  await a.page.getByLabel('Ring people in').fill('ravi');
  await a.page.locator('.meet-suggest button', { hasText: 'Ravi Kumar' }).click();
  await a.page.getByLabel('Start with my camera on').check();
  await a.page.getByRole('button', { name: 'Start meeting' }).click();
  await a.page.getByRole('button', { name: 'Leave Room' }).waitFor({ timeout: 20000 });
  const idText = (await a.page.locator('.tb-id').innerText()).trim();
  const meetingId = idText.replace(/\D/g, '');
  assert.match(idText, /^ID \d{3}-\d{3}-\d{3}$/);
  assert.equal(await a.page.locator('.room-block h2').innerText(), 'Pump skid review');
  assert.equal(await a.page.locator('.tb-kind').innerText(), 'INSTANT');
  await shot(a.page, 'meet-02-started-alone');

  // Ravi answers the ring with video; time from Join to the first frame of Priya's camera
  const banner = b.page.locator('.room-banner');
  await banner.waitFor({ timeout: 20000 });
  await b.page.evaluate(() => { (window as any).__t0 = performance.now(); });
  await banner.getByRole('button', { name: 'Join with video' }).click();
  const firstFrameMs = await b.page.waitForFunction(() => {
    const v = [...document.querySelectorAll('.room-field video')].find((x) => !(x as HTMLVideoElement).style.transform.includes('scaleX(-1)') && (x as HTMLVideoElement).videoWidth > 0 && (x as HTMLVideoElement).currentTime > 0);
    return v ? performance.now() - (window as any).__t0 : null;
  }, null, { timeout: 30000, polling: 'raf' }).then((h: any) => h.jsonValue());
  results.joinToFirstRemoteFrameMs = Math.round(firstFrameMs as number);
  console.log('join to first remote frame (ms):', results.joinToFirstRemoteFrameMs);

  // ---------------------------------------------------------------- Asha comes by the ID: the lobby
  await c.page.locator('.lens-bar .lens', { hasText: 'Meet' }).click();
  await c.page.getByLabel('Meeting ID or link').fill(`dexconnect://meet/${idText.slice(3)}`);
  await c.page.locator('.meet-found b', { hasText: 'Pump skid review' }).waitFor({ timeout: 10000 });
  await shot(c.page, 'meet-03-join-by-id');
  await c.page.getByRole('button', { name: 'Join', exact: true }).click();
  await c.page.locator('.lobby-sheet').waitFor({ timeout: 15000 });
  assert.match(await c.page.locator('.lobby-status').innerText(), /let you in/);
  await sleep(500);
  await shot(c.page, 'meet-04-lobby');
  await dark(c.page, 'meet-04b-lobby-dark');
  // the host sees her waiting, and is told
  await a.page.locator('.room-lobby li', { hasText: 'Asha Menon' }).waitFor({ timeout: 10000 });
  await toast(a.page, 'Asha Menon is waiting in the lobby');
  assert.equal(await b.page.locator('.room-lobby').count(), 0, 'only hosts see the lobby');
  await shot(a.page, 'meet-05-host-lobby');
  await dark(a.page, 'meet-05b-host-lobby-dark');
  await a.page.locator('.room-lobby li', { hasText: 'Asha Menon' }).getByRole('button', { name: 'Admit' }).click();
  await c.page.getByRole('button', { name: 'Leave Room' }).waitFor({ timeout: 20000 });
  await c.page.getByTitle('Turn your camera on').click();
  for (const p of Object.values(pages)) await p.waitForFunction(() => [...document.querySelectorAll('.room-field video')].filter((v) => (v as HTMLVideoElement).videoWidth > 0).length >= 3, null, { timeout: 30000 });
  await sleep(1500);
  await shot(a.page, 'meet-06-gallery');
  await dark(a.page, 'meet-06b-gallery-dark');

  // CPU of Priya's renderer in a three-person gallery with three cameras, over ten seconds
  // three samples of five seconds each (percent of one core; the machine is shared, so the median is reported)
  const cpu = await a.app.evaluate(async ({ app }) => {
    const pick = () => app.getAppMetrics().filter((m) => m.type === 'Tab').reduce((n, m) => n + m.cpu.percentCPUUsage, 0);
    const out: number[] = [];
    pick();
    for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 5000)); out.push(pick()); }
    return out;
  });
  results.rendererCpuSamples = cpu.map((x: number) => Math.round(x * 10) / 10);
  results.rendererCpuMedian = [...cpu].sort((x: number, y: number) => x - y).map((x: number) => Math.round(x * 10) / 10)[1];
  console.log('renderer CPU % of one core (3-person gallery, 3 x 5 s):', results.rendererCpuSamples, 'median', results.rendererCpuMedian);

  // ---------------------------------------------------------------- hands and reactions
  await b.page.getByRole('button', { name: 'Raise hand' }).click();
  await sleep(200);
  await c.page.getByRole('button', { name: 'Raise hand' }).click();
  await a.page.locator('.room-schedule tr.hand-up').nth(1).waitFor({ timeout: 10000 });
  const handRows = await a.page.locator('.room-schedule tr.hand-up .who').allInnerTexts();
  assert.match(handRows[0], /Ravi/); assert.match(handRows[1], /Asha/);
  assert.equal(await a.page.locator('.room-field .room-hand').count(), 2);
  await b.page.getByRole('button', { name: /^Hand up · 1/ }).waitFor();
  await b.page.getByTitle('Send a reaction to everyone').click();
  await b.page.getByRole('menuitem', { name: 'React 👏' }).click();
  await a.page.locator('.room-reacts span').first().waitFor({ timeout: 5000 });
  await sleep(350);
  await shot(a.page, 'meet-07-hands-reaction');
  await dark(a.page, 'meet-07b-hands-reaction-dark');

  // ---------------------------------------------------------------- co-host, mute, ask to unmute, mute all, lower hands
  await rowMenu(a.page, 'Ravi Kumar');
  await shot(a.page, 'meet-08-person-menu');
  await a.page.getByRole('menuitem', { name: 'Make co-host' }).click();
  await b.page.locator('.room-hostbox').waitFor({ timeout: 10000 });
  await rowMenu(b.page, 'Asha Menon');
  await b.page.getByRole('menuitem', { name: 'Mute Asha' }).click();
  await toast(c.page, 'Ravi Kumar muted you');
  await c.page.getByRole('button', { name: 'Mic off' }).waitFor();
  await rowMenu(a.page, 'Asha Menon');
  await a.page.getByRole('menuitem', { name: 'Ask Asha to unmute' }).click();
  await c.page.locator('.room-ask').waitFor({ timeout: 10000 });
  await shot(c.page, 'meet-09-ask-unmute');
  // never forced on: still muted until she says yes
  assert.equal(await c.page.getByRole('button', { name: 'Mic off' }).count(), 1);
  await c.page.locator('.room-ask').getByRole('button', { name: 'Turn mic on' }).click();
  await c.page.getByRole('button', { name: 'Mic on' }).waitFor();
  await a.page.getByRole('button', { name: 'Mute all' }).click();
  await b.page.getByRole('button', { name: 'Mic off' }).waitFor({ timeout: 10000 });
  await c.page.getByRole('button', { name: 'Mic off' }).waitFor({ timeout: 10000 });
  await a.page.getByRole('button', { name: 'Lower all hands' }).click();
  await a.page.locator('.room-field .room-hand').first().waitFor({ state: 'detached', timeout: 10000 });
  await shot(a.page, 'meet-10-host-controls');

  // ---------------------------------------------------------------- layouts: speaker, pin, spotlight
  const d = await devices();
  await a.page.getByTitle('Gallery, speaker or presentation').click();
  await shot(a.page, 'meet-11-layout-menu');
  await a.page.getByRole('menuitemradio', { name: /Speaker/ }).click();
  await a.page.locator('.room-main .room-tile').waitFor();
  await rowMenu(a.page, 'Asha Menon');
  await a.page.getByRole('menuitem', { name: 'Pin Asha for me' }).click();
  await a.page.locator(`.room-main .room-tile[data-device="${d.asha}"]`).waitFor();
  assert.equal(await b.page.locator('.room-main').count(), 0, 'a pin is only for yourself');
  await sleep(800);
  await shot(a.page, 'meet-12-speaker-pinned');
  await rowMenu(a.page, 'Ravi Kumar');
  await a.page.getByRole('menuitem', { name: 'Spotlight Ravi for everyone' }).click();
  await c.page.locator(`.room-main .room-tile[data-device="${d.ravi}"]`).waitFor({ timeout: 10000 });
  await c.page.locator('.room-main .room-flag', { hasText: 'SPOTLIGHT' }).waitFor();
  await sleep(800);
  await shot(c.page, 'meet-13-spotlight');
  await dark(c.page, 'meet-13b-spotlight-dark');
  await a.page.getByRole('button', { name: 'End spotlight' }).click();
  await c.page.locator('.room-main').waitFor({ state: 'detached', timeout: 10000 });

  // ---------------------------------------------------------------- presentation: Ravi shares a sheet
  await b.page.getByRole('button', { name: 'Share sheet' }).click();
  await b.page.locator('.screen-option').first().click({ timeout: 15000 });
  await c.page.locator('.room-field.layout-presentation .room-share video').waitFor({ timeout: 15000 });
  await c.page.locator('.room-strip .room-tile').first().waitFor();
  await sleep(1500);
  await shot(c.page, 'meet-14-presentation');
  await b.page.getByRole('button', { name: 'Stop sharing' }).click();
  await c.page.locator('.room-share').waitFor({ state: 'detached', timeout: 15000 });
  assert.equal(await c.page.locator('.room-field.layout-gallery').count(), 1, 'back to the gallery when the sharing stops');

  // ---------------------------------------------------------------- the panel: chat, polls, board, files
  await tab(a.page, /^Chat/);
  await a.page.getByLabel('Message to the meeting').fill('Agenda: pump skid nozzle loads, then the P-12 isometrics');
  await a.page.keyboard.press('Enter');
  await tab(c.page, /^Chat/);
  await c.page.locator('.meet-chat-line', { hasText: 'nozzle loads' }).waitFor({ timeout: 10000 });
  await c.page.getByLabel('Message to the meeting').fill('Joining from the site office');
  await c.page.keyboard.press('Enter');
  await a.page.locator('.meet-chat-line', { hasText: 'site office' }).waitFor({ timeout: 10000 });
  await shot(a.page, 'meet-15-chat');
  await dark(a.page, 'meet-15b-chat-dark');
  await tab(a.page, /^Polls/);
  await a.page.getByRole('button', { name: 'New poll' }).click();
  await a.page.locator('#poll-q').fill('Which day for the site visit?');
  await a.page.getByPlaceholder('Choice 1').fill('Tuesday');
  await a.page.getByPlaceholder('Choice 2').fill('Thursday');
  await a.page.getByRole('button', { name: 'Post poll' }).click();
  await tab(b.page, /^Polls/);
  await b.page.locator('.poll', { hasText: 'Which day for the site visit?' }).getByRole('button', { name: /Thursday/ }).click({ timeout: 10000 });
  await a.page.locator('.poll-foot', { hasText: '1 vote' }).waitFor({ timeout: 10000 });
  await shot(a.page, 'meet-16-polls');
  await tab(a.page, /^Board/);
  await a.page.getByRole('button', { name: 'New whiteboard' }).click();
  await a.page.locator('.board-stage').waitFor({ timeout: 10000 });
  await shot(a.page, 'meet-17-board');
  await a.page.getByLabel('Close whiteboard').click();
  await a.page.locator('.board-stage').waitFor({ state: 'detached' });
  await a.page.locator('.room-stage:not(.folded)').waitFor();
  await tab(a.page, /^Files/);
  await a.page.locator('.meet-files .side-head', { hasText: 'Files' }).waitFor({ timeout: 10000 });
  await shot(a.page, 'meet-18-files');
  await tab(a.page, /^People/);

  // ---------------------------------------------------------------- a virtual background drawn in code
  if (await a.page.getByTitle('What is behind you on camera (done on this PC)').count()) {
    await a.page.getByTitle('What is behind you on camera (done on this PC)').click();
    await shot(a.page, 'meet-19-backgrounds');
    await a.page.getByRole('radio', { name: 'Blueprint' }).click();
    await a.page.getByRole('button', { name: 'Blueprint' }).waitFor({ timeout: 20000 });
    await a.page.keyboard.press('Escape');
    await sleep(2500);
    const blue = await a.page.evaluate(() => {
      const v = document.querySelector('.room-tile video[style*="scaleX(-1)"]') as HTMLVideoElement | null;
      if (!v || !v.videoWidth) return -1;
      const cv = document.createElement('canvas'); cv.width = 64; cv.height = 36;
      const x = cv.getContext('2d')!; x.drawImage(v, 0, 0, 64, 36);
      const d = x.getImageData(0, 0, 64, 36).data;
      let bl = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { if (d[i + 2] > d[i] + 25 && d[i + 2] > d[i + 1]) bl++; n++; }
      return bl / n;
    });
    console.log('share of blueprint-blue pixels in your picture:', blue.toFixed(2));
    assert.ok(blue > 0.25, `the blueprint is behind the person (${blue})`);
    await shot(a.page, 'meet-20-blueprint');
    await shot(c.page, 'meet-20b-blueprint-seen-by-asha');
    await a.page.getByTitle('What is behind you on camera (done on this PC)').click();
    await a.page.getByRole('radio', { name: 'As it is' }).click();
    await a.page.keyboard.press('Escape');
  } else console.log('background picker not offered on this build (no segmenter)');

  // ---------------------------------------------------------------- lock, remove, end for everyone
  await a.page.getByRole('button', { name: 'Lock meeting' }).click();
  await a.page.locator('.tb-lock').waitFor();
  await assert.rejects(owner.request('meet.join', { id: meetingId }), /locked/);
  await a.page.getByRole('button', { name: 'Unlock' }).click();
  a.page.once('dialog', (dlg: any) => void dlg.accept());
  await rowMenu(a.page, 'Asha Menon');
  await a.page.getByRole('menuitem', { name: 'Remove from the meeting' }).click();
  await a.page.locator('.confirm-actions').getByRole('button', { name: 'Remove from the meeting' }).click();
  await toast(c.page, 'Priya Raman took you out of the meeting');
  await c.page.locator('.room-stage').waitFor({ state: 'detached', timeout: 10000 });
  a.page.once('dialog', (dlg: any) => void dlg.accept());
  await a.page.getByRole('button', { name: 'End for everyone' }).click();
  await a.page.locator('.confirm-actions').getByRole('button', { name: 'End for everyone' }).click();
  await toast(b.page, 'Priya Raman ended the meeting for everyone');
  await b.page.locator('.room-stage').waitFor({ state: 'detached', timeout: 10000 });
  await a.page.locator('.room-stage').waitFor({ state: 'detached', timeout: 10000 });
  // recent meetings: who, when, how long
  await a.page.locator('.meet-log tr', { hasText: 'Pump skid review' }).waitFor({ timeout: 10000 });
  assert.match(await a.page.locator('.meet-log tr', { hasText: 'Pump skid review' }).innerText(), /3 people/);
  await shot(a.page, 'meet-21-recent');
  await dark(a.page, 'meet-21b-recent-dark');

  // ---------------------------------------------------------------- a personal room, joined by its link
  await b.page.locator('.lens-bar .lens', { hasText: 'Meet' }).click();
  await b.page.locator('.meet-personal .meet-number span').first().waitFor({ timeout: 10000 });
  const roomLink = (await b.page.locator('.meet-link').innerText()).trim();
  // Asha opens the link before Ravi is there: she waits for him
  await c.page.evaluate((l) => window.dex.openLink!(l), roomLink);
  await c.page.locator('.lobby-sheet').waitFor({ timeout: 15000 });
  assert.match(await c.page.locator('.lobby-status').innerText(), /Ravi Kumar to start|let you in/);
  await shot(c.page, 'meet-22-waiting-for-host');
  await b.page.getByRole('button', { name: 'Open your room' }).click();
  await b.page.getByRole('button', { name: 'Leave Room' }).waitFor({ timeout: 20000 });
  await b.page.locator('.room-lobby li', { hasText: 'Asha Menon' }).getByRole('button', { name: 'Admit' }).click({ timeout: 10000 });
  await c.page.getByRole('button', { name: 'Leave Room' }).waitFor({ timeout: 20000 });
  assert.equal(await c.page.locator('.tb-kind').innerText(), 'PERSONAL');
  await c.page.getByRole('button', { name: 'Leave Room' }).click();
  await b.page.getByRole('button', { name: 'Leave Room' }).click();
  await b.page.locator('.room-stage').waitFor({ state: 'detached', timeout: 10000 });

  // ---------------------------------------------------------------- a Calendar meeting held as a call; the camera consent policy
  await owner.request('admin.policy.set', { cameraConsent: true });
  const ravi = users.find((u: any) => u.account.endsWith('ravi'))!;
  const now = Date.now();
  await a.page.evaluate(({ ravi, now }) => window.dex.request('cal.create', { title: 'Isometrics review', startAt: now + 5 * 60_000, endAt: now + 65 * 60_000, attendees: [ravi], online: true }), { ravi: ravi.id, now });
  await b.page.locator('.meet-upcoming li', { hasText: 'Isometrics review' }).waitFor({ timeout: 15000 });
  await shot(b.page, 'meet-23-coming-up');
  await b.page.locator('.meet-upcoming li', { hasText: 'Isometrics review' }).getByRole('button', { name: 'Join' }).click();
  await b.page.getByRole('button', { name: 'Leave Room' }).waitFor({ timeout: 20000 });
  assert.equal(await b.page.locator('.tb-kind').innerText(), 'SCHEDULED');
  await b.page.getByRole('button', { name: 'Camera off' }).waitFor();
  await b.page.getByTitle('Turn your camera on (you are asked first)').click();
  await b.page.getByRole('dialog', { name: 'Turn your camera on?' }).waitFor();
  await shot(b.page, 'meet-24-consent');
  await b.page.getByRole('button', { name: 'Turn camera on' }).click();
  await b.page.getByRole('button', { name: 'Camera on' }).waitFor({ timeout: 10000 });
  await b.page.getByRole('button', { name: 'Leave Room' }).click();
  await owner.request('admin.policy.set', { cameraConsent: false });

  // ---------------------------------------------------------------- phones: Meet is a card on Pulse
  await c.page.setViewportSize({ width: 390, height: 820 });
  await c.page.locator('.lens-dock .lens', { hasText: 'Pulse' }).click();
  await c.page.locator('.meet-pulse').waitFor({ timeout: 10000 });
  await shot(c.page, 'meet-25-phone-pulse');
  await c.page.locator('.meet-pulse').click();
  await c.page.locator('.view.meet').waitFor();
  await shot(c.page, 'meet-26-phone-lens');

  fs.writeFileSync(path.join(OUT, 'meet-results.json'), JSON.stringify(results, null, 2));
  console.log('RESULTS', JSON.stringify(results));
  console.log('MEET E2E PASSED');
} catch (e) {
  for (const [n, p] of Object.entries(pages)) await shot(p, `meet-FAIL-${n}`).catch(() => {});
  throw e;
} finally {
  for (const x of [a, b, c]) await x.app.close().catch(() => {});
  owner.disconnect();
  await hub.stop();
}
