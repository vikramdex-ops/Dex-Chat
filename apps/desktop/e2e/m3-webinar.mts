// M3 end to end: a webinar, through the real gateway Worker (wrangler dev) and three Electron apps.
// Priya organises it, Ravi is a panelist, Sam watches from the office (the hub's relay), and Dana
// registers and watches from a browser (headless Chromium: straight from Priya's PC). Covered:
// planning it; registration from the browser, approval and the personal link; the "starting soon"
// sheet; the practice session and go-live; an attendee who cannot publish; Q&A with votes, answered
// live and shown on the stage; a poll with results; a raised hand, Sam invited to speak and brought
// back; a handout downloaded in the app and in the browser; the live stream to a local RTMP listener
// (ffmpeg in listen mode); ending it; the follow-up (in the app, and as email text) and the survey
// in the app and in the browser; the report. Screenshots in light and dark.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import pw from 'playwright-core';
import { startOffice, launch, shot, sleep, OUT, voices } from './harness.mts';
import { audit } from './tourlib.mts';
import { fileURLToPath as rootPath } from 'node:url';
const ROOT = rootPath(new URL('../../../', import.meta.url));

const free = async () => { const s = net.createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r())); const p = (s.address() as net.AddressInfo).port; await new Promise<void>((r) => s.close(() => r())); return p; };
// the hub takes the shared port first (another run could take it while the gateway starts)
const { owner, hub } = await startOffice('webinar');
const gwPort = await free();
const gwRoot = path.join(ROOT, 'apps/gateway');
const gw = spawn(path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler'), ['dev', '--ip', '127.0.0.1', '--port', String(gwPort), '--persist-to', path.join(OUT, `gw-state-${Date.now()}`), '--show-interactive-dev-session=false'], { cwd: gwRoot, detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise<void>((res, rej) => { const t = setTimeout(() => rej(new Error('wrangler did not start')), 90_000); const on = (b: Buffer) => { if (/Ready on/.test(b.toString())) { clearTimeout(t); res(); } }; gw.stdout!.on('data', on); gw.stderr!.on('data', on); });
gw.stdout!.resume(); gw.stderr!.resume();
const gwUrl = `http://127.0.0.1:${gwPort}`;
console.log('gateway on', gwUrl);

await owner.request('admin.remote.set', { url: gwUrl, enabled: true });
for (let i = 0; i < 80 && !(await owner.request('admin.remote.get')).status.connected; i++) await sleep(100);
assert.ok((await owner.request('admin.remote.get')).status.connected, 'hub reached the gateway');

const a = await launch('priya', 'Priya Raman', { audio: voices().a });
const b = await launch('ravi', 'Ravi Kumar', { audio: voices().b });
const c = await launch('sam', 'Sam Thomas');
const browser = await pw.chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const results: Record<string, unknown> = {};
const S = (n: string) => `m3-${n}`;
const both = async (p: any, name: string) => {
  await shot(p, S(name));
  await p.evaluate(() => { document.documentElement.dataset.theme = 'dark'; }); await sleep(300);
  await shot(p, S(`${name}-dark`));
  await p.evaluate(() => { document.documentElement.dataset.theme = 'light'; }); await sleep(150);
};
const bothWeb = async (p: any, name: string) => {
  await p.screenshot({ path: path.join(OUT, `${S(name)}.png`) });
  if (process.env.TAUDIT) await audit(p, `gw-${S(name)}`);
  await p.emulateMedia({ colorScheme: 'dark' }); await sleep(250);
  await p.screenshot({ path: path.join(OUT, `${S(name)}-dark.png`) });
  if (process.env.TAUDIT) await audit(p, `gw-${S(name)}`);
  await p.emulateMedia({ colorScheme: 'light' }); await sleep(100);
};
const advancing = async (page: any, sel: string) => page.evaluate(async (s: string) => { const v = document.querySelector(s) as HTMLVideoElement | null; if (!v) return -1; const t1 = v.currentTime; await new Promise((r) => setTimeout(r, 1500)); return v.currentTime - t1; }, sel);
let sink: ReturnType<typeof spawn> | null = null;

try {
  for (const x of [a, b, c]) { await x.page.reload(); await x.page.locator('.frame').waitFor(); }
  // ------------------------------------------------------------ Priya plans the webinar
  await a.page.locator('.lens-bar .lens', { hasText: 'Meet' }).click();
  await a.page.getByRole('button', { name: 'Plan a webinar' }).click();
  await a.page.locator('#wb-title').fill('Pump skid design review');
  await a.page.locator('#wb-desc').fill('How we size a pump skid for a process plant, and your questions answered live.');
  const startAt = new Date(Date.now() + 12 * 60_000);
  const p2 = (n: number) => String(n).padStart(2, '0');
  await a.page.getByLabel('Date').fill(`${startAt.getFullYear()}-${p2(startAt.getMonth() + 1)}-${p2(startAt.getDate())}`);
  await a.page.getByLabel('Starts').fill(`${p2(startAt.getHours())}:${p2(startAt.getMinutes())}`);
  await a.page.getByLabel('Add a panelist').fill('Ravi');
  await a.page.getByLabel('Add a panelist').press('Enter');
  await a.page.locator('.wb-plan-opts select').selectOption('manual');
  await a.page.getByRole('button', { name: 'Add a question' }).click();
  await a.page.getByLabel('Question 2', { exact: true }).fill('Your role');
  await a.page.getByLabel('Kind of answer to question 2').selectOption('choice');
  await a.page.getByLabel('Answers to choose from for question 2, one a line').fill('Process engineer\nProject manager\nOther');
  await a.page.locator('.wb-field-row').nth(1).locator('input[type=checkbox]').check();
  await sleep(200);
  await both(a.page, '01-plan-webinar');
  await a.page.getByRole('button', { name: 'Plan webinar' }).click();
  await a.page.locator('.wb-sheet-panel .wb-url').waitFor({ timeout: 15000 });
  const regUrl = (await a.page.locator('.wb-sheet-panel .wb-url').innerText()).trim();
  const meetingId = regUrl.match(/\/w\/(\d{9})$/)![1];
  assert.ok(regUrl.startsWith(`${gwUrl}/w/`), regUrl);
  await sleep(400);
  await both(a.page, '02-sheet-setup');

  // ------------------------------------------------------------ Dana registers from a browser (desktop and phone width)
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const g = await ctx.newPage();
  g.on('pageerror', (e: Error) => console.log('[dana pageerror]', e.message));
  await g.goto(regUrl);
  await g.locator('#reg-name').waitFor();
  await sleep(300);
  await bothWeb(g, '03-register-page');
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const gp = await phone.newPage();
  await gp.goto(regUrl);
  await gp.locator('#reg-name').waitFor();
  await sleep(300);
  await bothWeb(gp, '04-register-phone');
  await gp.screenshot({ path: path.join(OUT, `${S('04b-register-phone-full')}.png`), fullPage: true });
  // the form says what is missing
  await g.getByRole('button', { name: 'Register' }).click();
  await g.locator('.problem', { hasText: 'Enter your name' }).waitFor();
  await g.locator('#reg-name').fill('Dana Wright');
  await g.locator('#reg-email').fill('dana@acme-pumps.example');
  await g.locator('#f-q1').fill('Acme Pumps');
  await g.locator('#f-q2').selectOption('Process engineer');
  await g.getByRole('button', { name: 'Register' }).click();
  await g.getByText('your registration is with the organiser').waitFor({ timeout: 15000 });
  const watchUrl = (await g.locator('.reg-link').innerText()).trim();
  assert.match(watchUrl, new RegExp(`/w/${meetingId}/watch#[A-Za-z0-9_-]{22}$`));
  await sleep(200);
  await bothWeb(g, '05-registered-pending');

  // ------------------------------------------------------------ Priya approves her in the registrants table
  await a.page.getByRole('tab', { name: /Registrants/ }).click();
  const row = a.page.locator('.wb-table tbody tr', { hasText: 'Dana Wright' }).first();
  await row.waitFor({ timeout: 15000 });
  assert.match(await row.innerText(), /WAITING/);
  await sleep(300);
  await both(a.page, '06-registrants-waiting');
  await row.getByRole('button', { name: 'Approve' }).click();
  await a.page.locator('.wb-table tbody tr', { hasText: 'Dana Wright' }).first().getByText('APPROVED').waitFor();
  await a.page.locator('.wb-table .wb-name').first().click();
  await sleep(300);
  await both(a.page, '07-registrants-approved');
  // the invitation and its .ics carry her own link (no mail server: text to send)
  const mails = await a.page.evaluate((id: string) => window.dex.request('web.mail', { id, kind: 'invite', when: 'soon' }), meetingId) as Array<{ text: string; ics: string; email: string }>;
  assert.equal(mails[0].email, 'dana@acme-pumps.example');
  assert.ok(mails[0].text.includes(watchUrl), 'the invitation has her personal link');
  assert.ok(mails[0].ics.replace(/\r\n /g, '').includes(`URL:${watchUrl}`), 'and so does the .ics');
  results.registration = 'registered from a browser, approved, invitation and .ics with the personal link';

  // ------------------------------------------------------------ the starting-soon sheets: Dana in the browser, Sam in the app
  const w = await ctx.newPage();
  w.on('pageerror', (e: Error) => console.log('[dana watch pageerror]', e.message));
  w.on('console', (m: any) => { if (m.type() === 'error') console.log('[dana watch console]', m.text()); });
  await w.goto(watchUrl);
  await w.locator('.count').waitFor({ timeout: 15000 });
  assert.equal(new URL(w.url()).hash, '', 'the token is taken out of the address bar');
  await sleep(600);
  await bothWeb(w, '08-watch-starting-soon');
  const wp = await phone.newPage();
  await wp.goto(watchUrl);
  await wp.locator('.count').waitFor({ timeout: 15000 });
  await sleep(500);
  await bothWeb(wp, '09-watch-starting-soon-phone');
  await c.page.locator('.lens-bar .lens', { hasText: 'Meet' }).click();
  const srow = c.page.locator('.wb-register tr', { hasText: 'Pump skid design review' });
  await srow.waitFor({ timeout: 15000 });
  await srow.getByRole('button', { name: 'Watch' }).click();
  await c.page.locator('.wb-watch .wb-count').waitFor({ timeout: 15000 });
  await sleep(500);
  await both(c.page, '10-app-starting-soon');

  // an attendee cannot publish: not into the stage's Room, not onto its relay room
  const refusals = await c.page.evaluate(async (id: string) => {
    const out: string[] = [];
    try { await window.dex.request('meet.join', { id }); out.push('joined!'); } catch (e) { out.push((e as Error).message); }
    try { await window.dex.request('relay.produce' as never, { stage: id, transportId: 'x', kind: 'video', rtpParameters: {}, source: 'camera' } as never); out.push('produced!'); } catch (e) { out.push((e as Error).message); }
    return out;
  }, meetingId);
  assert.match(refusals[0], /attendee/);
  assert.match(refusals[1], /stage is not on|composing the stage/);
  results.attendeeCannotPublish = refusals;

  // ------------------------------------------------------------ the practice session: Priya and Ravi on the stage
  await a.page.getByRole('button', { name: 'Open the stage (practice)' }).click();
  await a.page.locator('.wb-bar').waitFor({ timeout: 20000 });
  await a.page.locator('.wb-bar', { hasText: 'PRACTICE' }).waitFor();
  await b.page.locator('.lens-bar .lens', { hasText: 'Meet' }).click();
  const brow = b.page.locator('.wb-register tr', { hasText: 'Pump skid design review' });
  await brow.waitFor({ timeout: 15000 });
  await brow.getByRole('button', { name: 'Join the stage' }).click();
  await b.page.locator('.wb-bar').waitFor({ timeout: 20000 });
  await a.page.locator('.room-tile').nth(1).waitFor({ timeout: 20000 });
  await w.locator('.soon-tag', { hasText: 'PANELISTS PREPARING' }).waitFor({ timeout: 15000 });
  await c.page.getByText('are on the stage, getting ready').waitFor({ timeout: 15000 });
  await sleep(1500);
  await both(a.page, '11-stage-practice');
  await bothWeb(w, '12-watch-practice');

  // ------------------------------------------------------------ go live
  const t0 = Date.now();
  await a.page.getByRole('button', { name: 'Go live' }).click();
  await a.page.locator('.wb-bar.live').waitFor({ timeout: 10000 });
  // Sam (office network) gets the composed stage through the relay; Dana straight from Priya's PC
  await c.page.waitForFunction(() => { const v = document.querySelector('.wb-stage video') as HTMLVideoElement | null; return !!v && v.videoWidth > 0 && v.currentTime > 0.3; }, null, { timeout: 30000 });
  results.relayFirstFrameMs = Date.now() - t0;
  await w.waitForFunction(() => { const v = document.querySelector('.stage-video') as HTMLVideoElement | null; return !!v && v.videoWidth > 0 && v.currentTime > 0.3; }, null, { timeout: 30000 });
  results.directFirstFrameMs = Date.now() - t0;
  assert.ok((await advancing(c.page, '.wb-stage video')) > 0.5, 'the relay stage moves');
  assert.ok((await advancing(w, '.stage-video')) > 0.5, 'the direct stage moves');
  assert.match(await c.page.locator('.wb-stage .room-cap').innerText(), /OFFICE RELAY/);
  const sizes = await c.page.evaluate(() => { const v = document.querySelector('.wb-stage video') as HTMLVideoElement; return [v.videoWidth, v.videoHeight]; });
  results.stageSize = sizes;
  const snap = hub.webinars.snapshot(meetingId);
  results.routes = snap.viewers.map((v) => `${v.name}:${v.route}`);
  assert.ok(snap.viewers.some((v) => v.name === 'Sam Thomas' && v.route === 'relay'));
  assert.ok(snap.viewers.some((v) => v.name === 'Dana Wright' && v.route === 'direct'));
  console.log('live', results);
  await sleep(1500);
  await both(c.page, '13-app-watching-live');
  await bothWeb(w, '14-watch-live');
  await wp.waitForFunction(() => { const v = document.querySelector('.stage-video') as HTMLVideoElement | null; return !!v && v.videoWidth > 0; }, null, { timeout: 30000 });
  await sleep(800);
  await bothWeb(wp, '15-watch-live-phone');
  // the organiser's preview of what attendees see
  await a.page.locator('.wb-link').click();
  await a.page.locator('.wb-preview canvas').waitFor({ timeout: 10000 });
  await sleep(1200);
  await both(a.page, '16-stage-live-preview');

  // ------------------------------------------------------------ Q&A: asked from the browser and the app, voted, answered live, shown on the stage
  await w.getByRole('tab', { name: /Questions/ }).click();
  await w.getByLabel('Your question').fill('What flow rate is the standard skid sized for?');
  await w.getByRole('button', { name: 'Ask' }).click();
  await c.page.getByLabel('Your question').fill('Can the skid be split into two lifts for transport?');
  await c.page.getByLabel('Without my name').check();
  await c.page.getByRole('button', { name: 'Ask' }).click();
  const danaQ = c.page.locator('.wb-q', { hasText: 'What flow rate' });
  await danaQ.waitFor({ timeout: 10000 });
  await danaQ.locator('.wb-vote').click();
  await a.page.getByRole('tab', { name: 'Questions' }).click();
  await a.page.locator('.wb-q', { hasText: 'What flow rate' }).waitFor({ timeout: 10000 });
  await a.page.locator('.wb-q', { hasText: 'two lifts' }).waitFor({ timeout: 10000 });
  await sleep(1300);
  const order = await a.page.locator('.wb-questions .wb-q .wb-q-text').allInnerTexts();
  assert.match(order[0], /What flow rate/, 'the most voted first');
  assert.match(await a.page.locator('.wb-q', { hasText: 'two lifts' }).innerText(), /ANONYMOUS/);
  await b.page.getByRole('tab', { name: 'Questions' }).click();
  await b.page.locator('.wb-q', { hasText: 'two lifts' }).getByRole('button', { name: 'Answered live' }).click();
  await a.page.locator('.wb-q', { hasText: 'What flow rate' }).getByRole('button', { name: 'Show on stage' }).click();
  await c.page.locator('.wb-q', { hasText: 'What flow rate' }).getByText(/ON STAGE/).waitFor({ timeout: 10000 });
  await w.locator('.q', { hasText: 'What flow rate' }).getByText(/ON STAGE/).waitFor({ timeout: 10000 });
  await sleep(1500);
  await both(a.page, '17-stage-questions');
  await both(c.page, '18-app-questions-on-stage');
  await bothWeb(w, '19-watch-questions');
  results.qa = 'asked from the browser and the app (anonymous), voted, sorted by votes, answered live, shown on the stage';

  // ------------------------------------------------------------ a poll with its results shown to attendees
  await a.page.getByRole('tab', { name: 'Polls' }).click();
  await a.page.getByRole('button', { name: 'New poll for the audience' }).click();
  await a.page.locator('#wb-pq').fill('Which skid size do you specify most?');
  await a.page.locator('#wb-po').fill('Small (under 50 m³/h)\nMedium\nLarge (over 300 m³/h)');
  await a.page.getByLabel('Attendees see the results as they come in').check();
  await a.page.getByRole('button', { name: 'Launch poll' }).click();
  await c.page.getByRole('tab', { name: /Poll/ }).click();
  await c.page.locator('.wb-opt', { hasText: 'Medium' }).click();
  await c.page.getByRole('button', { name: 'Answer' }).click();
  await w.getByRole('tab', { name: /Poll/ }).click();
  await w.locator('.opt', { hasText: 'Large' }).click();
  await w.getByRole('button', { name: 'Answer' }).click();
  await c.page.locator('.wb-opt b').first().waitFor({ timeout: 10000 });
  await w.getByText('2 answered').waitFor({ timeout: 10000 });
  await sleep(1200);
  await both(c.page, '20-app-poll-results');
  await bothWeb(w, '21-watch-poll');
  await both(a.page, '22-stage-poll');

  // ------------------------------------------------------------ a raised hand; Sam invited to speak, on the stage, then back to the audience
  await c.page.getByRole('button', { name: 'Raise hand' }).click();
  await a.page.getByRole('tab', { name: 'Audience' }).click();
  const samRow = a.page.locator('.wb-alist li', { hasText: 'Sam Thomas' });
  await samRow.locator('.wb-hand', { hasText: '1' }).waitFor({ timeout: 10000 });
  await sleep(400);
  await both(a.page, '23-stage-audience-hand');
  await samRow.getByRole('button', { name: 'Invite to speak' }).click();
  await c.page.locator('.wb-invite').waitFor({ timeout: 10000 });
  await sleep(300);
  await both(c.page, '24-app-invited-to-speak');
  await c.page.getByRole('button', { name: 'Speak with my mic' }).click();
  await c.page.getByRole('button', { name: 'Leave Room' }).waitFor({ timeout: 20000 });
  await a.page.locator('.room-tile').nth(2).waitFor({ timeout: 20000 });
  results.promoted = 'Sam accepted and came onto the stage';
  await sleep(1500);
  await both(a.page, '25-stage-speaker');
  await a.page.locator('.wb-speakers').getByRole('button', { name: 'Back to audience' }).click();
  await c.page.locator('.wb-watch').waitFor({ timeout: 20000 });
  await c.page.waitForFunction(() => { const v = document.querySelector('.wb-stage video') as HTMLVideoElement | null; return !!v && v.videoWidth > 0; }, null, { timeout: 30000 });
  results.demoted = 'back in the audience, watching through the relay again';

  // ------------------------------------------------------------ a handout: attached by Priya, downloaded in the app and in the browser
  const handoutPath = path.join(OUT, 'Skid sizing checklist.pdf');
  fs.writeFileSync(handoutPath, `%PDF-1.4\n% skid sizing checklist\n${'Pump duty, NPSH available, motor rating. '.repeat(4000)}\n%%EOF\n`);
  await a.page.getByRole('tab', { name: 'Handouts' }).click();
  await a.page.locator('.wb-handouts input[type=file]').setInputFiles(handoutPath);
  await a.page.locator('.wb-hlist li', { hasText: 'Skid sizing checklist.pdf' }).waitFor({ timeout: 15000 });
  await c.page.getByRole('tab', { name: /Handouts/ }).click();
  await c.page.locator('.wb-hlist li', { hasText: 'Skid sizing checklist.pdf' }).waitFor({ timeout: 10000 });
  await sleep(300);
  await both(c.page, '26-app-handouts');
  await c.page.locator('.wb-hlist li', { hasText: 'Skid sizing checklist.pdf' }).getByRole('button', { name: 'Download' }).click();
  const downloads = await c.app.evaluate(({ app }: any) => app.getPath('downloads'));
  let saved = '';
  for (let i = 0; i < 60 && !saved; i++) { saved = fs.existsSync(downloads) ? (fs.readdirSync(downloads).find((f) => f.startsWith('Skid sizing checklist')) ?? '') : ''; if (!saved) await sleep(250); }
  assert.ok(saved, `saved in ${downloads}`);
  assert.equal(fs.statSync(path.join(downloads, saved)).size, fs.statSync(handoutPath).size);
  await w.getByRole('tab', { name: /Handouts/ }).click();
  const [dl] = await Promise.all([w.waitForEvent('download', { timeout: 20000 }), w.locator('.handouts li', { hasText: 'Skid sizing checklist.pdf' }).getByRole('button', { name: 'Download' }).click()]);
  const dlPath = path.join(OUT, `dana-${dl.suggestedFilename()}`);
  await dl.saveAs(dlPath);
  assert.equal(fs.statSync(dlPath).size, fs.statSync(handoutPath).size, 'the browser got the whole file');
  await bothWeb(w, '27-watch-handouts');
  results.handouts = { app: path.join(downloads, saved), browser: dlPath };
  // Sam folds the webinar away to use the app; it keeps playing, and the chip brings it back
  await c.page.getByRole('button', { name: 'Fold' }).click();
  await c.page.locator('.wb-chip').waitFor({ timeout: 5000 });
  assert.ok((await advancing(c.page, '.wb-stage video')) > 0.5, 'the stage keeps playing while folded');
  await sleep(300);
  await both(c.page, '27b-app-folded');
  await c.page.locator('.wb-chip').click();
  await c.page.locator('.wb-watch:not(.folded)').waitFor();
  fs.rmSync(path.join(downloads, saved), { force: true });

  // ------------------------------------------------------------ the live stream: to a local RTMP listener (ffmpeg in listen mode)
  const rtmpPort = await free();
  let sinkLog = '';
  sink = spawn('ffmpeg', ['-hide_banner', '-listen', '1', '-i', `rtmp://127.0.0.1:${rtmpPort}/live/e2e-stream-key`, '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
  sink.stderr!.on('data', (x: Buffer) => { sinkLog += x.toString(); });
  await sleep(1500);
  await a.page.locator('.wb-bar').getByRole('button', { name: 'Sheet…' }).click();
  await a.page.locator('.wb-sheet-panel').waitFor({ timeout: 10000 });
  await a.page.getByRole('tab', { name: 'Live stream' }).click();
  await a.page.getByLabel('Stream address').fill(`rtmp://127.0.0.1:${rtmpPort}/live`);
  await a.page.getByLabel('Stream key').fill('e2e-stream-key');
  await a.page.getByRole('button', { name: 'Save', exact: true }).click();
  await a.page.getByText('(saved: ••••-key)').waitFor({ timeout: 10000 });
  await a.page.getByRole('button', { name: 'Start streaming' }).click();
  await a.page.locator('.wb-health.live').waitFor({ timeout: 30000 });
  await sleep(6000);
  const health = await a.page.locator('.wb-health').innerText();
  results.streamHealth = health.replace(/\s+/g, ' ').trim();
  await both(a.page, '28-sheet-live-stream');
  const frames = Math.max(0, ...[...sinkLog.matchAll(/frame=\s*(\d+)/g)].map((m) => Number(m[1])));
  assert.ok(frames > 30, `the RTMP listener received ${frames} frames`);
  assert.match(sinkLog, /Video: h264/);
  results.rtmpFrames = frames;
  await a.page.getByRole('button', { name: 'Stop streaming' }).click();
  await a.page.locator('.wb-health.stopped').waitFor({ timeout: 10000 });
  await a.page.locator('.sheet-close').click();

  // ------------------------------------------------------------ Priya ends it from the stage
  await a.page.locator('.room-chip-main').click();
  await a.page.getByRole('button', { name: 'End webinar' }).click();
  await a.page.locator('.dialog').getByRole('button', { name: 'End webinar' }).click();
  await w.getByText('The webinar has ended').waitFor({ timeout: 15000 });
  await c.page.getByText('The webinar has ended. Thank you for watching.').waitFor({ timeout: 15000 });
  await bothWeb(w, '29-watch-ended');
  await both(c.page, '30-app-ended');
  await c.page.locator('.wb-soon').getByRole('button', { name: 'Close' }).click();
  await b.page.getByRole('button', { name: 'Join the stage' }).first().waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});

  // ------------------------------------------------------------ the follow-up: in the app for Sam, email text for Dana (attended)
  await a.page.locator('.lens-bar .lens', { hasText: 'Meet' }).click();
  await a.page.locator('.wb-register tr', { hasText: 'Pump skid design review' }).getByRole('button', { name: 'Sheet' }).click();
  await a.page.getByRole('tab', { name: /Registrants/ }).click();
  await a.page.locator('.wb-table tbody tr', { hasText: 'Dana Wright' }).first().getByText(/ATTENDED/).waitFor({ timeout: 10000 });
  await sleep(300);
  await both(a.page, '31-registrants-attended');
  await a.page.getByRole('tab', { name: 'Follow-up' }).click();
  await a.page.getByLabel('Recording link for people outside').fill('https://videos.example.com/pump-skid-review');
  await a.page.getByRole('button', { name: 'Send the follow-up' }).click();
  await a.page.locator('.wb-followup .wb-table tbody tr', { hasText: 'Dana Wright' }).waitFor({ timeout: 15000 });
  assert.match(await a.page.locator('.wb-followup .wb-table tbody tr', { hasText: 'Dana Wright' }).innerText(), /ATTENDED/);
  await sleep(300);
  await both(a.page, '32-sheet-followup');
  const fu = await a.page.evaluate((id: string) => window.dex.request('web.report', { id }), meetingId) as { registrants: Array<{ name: string; attended: boolean | null }> };
  assert.equal(fu.registrants[0].attended, true);
  // Sam got the thank-you from the system bot, with the survey link
  const msg = hub.store.db.prepare(`SELECT m.body FROM messages m JOIN conv_members cm ON cm.conv_id = m.conv_id JOIN users u ON u.id = cm.user_id WHERE u.display_name = 'Sam Thomas' AND m.author_id = ? ORDER BY m.created_at DESC LIMIT 1`).get(hub.system.id) as { body: string } | undefined;
  assert.ok(msg && /Thank you for attending Pump skid design review/.test(msg.body), 'the follow-up reached Sam in the app');
  assert.ok(msg!.body.includes(`dexconnect://webinar/${meetingId}/survey`));
  // Sam answers the survey in the app (the link opens it)
  await c.app.evaluate(({ BrowserWindow }: any, url: string) => { BrowserWindow.getAllWindows()[0].webContents.send('app:deeplink', url); }, `dexconnect://webinar/${meetingId}/survey`);
  await c.page.locator('.dialog', { hasText: 'Survey' }).waitFor({ timeout: 15000 });
  await c.page.locator('.wb-survey-q select').first().selectOption({ index: 1 });
  await c.page.locator('.wb-survey-q input').first().fill('Pipe supports on skids');
  await sleep(200);
  await both(c.page, '33-app-survey');
  await c.page.getByRole('button', { name: 'Send answers' }).click();
  await c.page.getByText('Your answers are with the organiser.').waitFor({ timeout: 10000 });
  // Dana answers on the gateway's survey page (the link from her follow-up email)
  const danaMail = await a.page.evaluate(() => [...document.querySelectorAll('.wb-followup .wb-table tbody tr')].length);
  assert.ok(danaMail >= 1);
  const token = watchUrl.split('#')[1];
  const sv = await phone.newPage();
  await sv.goto(`${gwUrl}/w/${meetingId}/survey#${token}`);
  await sv.locator('#f-q1').waitFor({ timeout: 15000 });
  await sv.locator('#f-q1').selectOption({ index: 1 });
  await sv.locator('#f-q2').fill('Skid frames and lifting lugs');
  await sleep(200);
  await bothWeb(sv, '34-survey-phone');
  await sv.getByRole('button', { name: 'Send answers' }).click();
  await sv.getByText('Your answers are with the organiser.').waitFor({ timeout: 10000 });
  await bothWeb(sv, '35-survey-thanks-phone');
  results.followUp = 'thank-you in the app for Sam (system bot), email text for Dana marked attended; survey answered in the app and in the browser';

  // ------------------------------------------------------------ the report
  await a.page.getByRole('tab', { name: 'Report' }).click();
  await a.page.locator('.wb-report').waitFor({ timeout: 10000 });
  await sleep(500);
  await both(a.page, '36-sheet-report');
  const rep = await a.page.evaluate((id: string) => window.dex.request('web.report', { id }), meetingId) as any;
  results.report = { registrants: rep.registrants.length, attendees: rep.attendees.map((x: any) => `${x.name}${x.office ? ' (office)' : ''}: ${x.minutes} min`), questions: rep.questions.length, pollAnswers: rep.polls[0].answers.map((x: any) => `${x.name}: ${x.choices.join(',')}`), downloads: rep.handouts[0].downloads.map((d: any) => d.name), survey: rep.survey.answers.length };
  assert.equal(rep.survey.answers.length, 2);
  assert.deepEqual(rep.handouts[0].downloads.map((d: any) => d.name).sort(), ['Dana Wright', 'Sam Thomas']);
  const audit = await owner.request('admin.audit', { limit: 200 }) as Array<{ action: string }>;
  for (const x of ['webinar.created', 'webinar.registered', 'webinar.registrantsApproved', 'webinar.practice', 'webinar.live', 'webinar.invitedToSpeak', 'webinar.streamStarted', 'webinar.ended', 'webinar.followUp']) assert.ok(audit.some((e) => e.action === x), x);
  console.log('RESULTS', JSON.stringify(results, null, 1));
  console.log('WEBINAR E2E PASSED');
} catch (e) {
  for (const [n, x] of [['priya', a], ['ravi', b], ['sam', c]] as const) await shot(x.page, S(`FAIL-${n}`)).catch(() => {});
  for (const p of browser.contexts().flatMap((cx: any) => cx.pages())) await p.screenshot({ path: path.join(OUT, `${S('FAIL-browser')}-${Math.random().toString(36).slice(2, 6)}.png`) }).catch(() => {});
  throw e;
} finally {
  try { sink?.kill('SIGKILL'); } catch { /* gone */ }
  await browser.close().catch(() => {});
  for (const x of [a, b, c]) await x.app.close().catch(() => {});
  owner.disconnect();
  await hub.stop();
  try { process.kill(-gw.pid!, 'SIGKILL'); } catch { /* gone */ }
}
