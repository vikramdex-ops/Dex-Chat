// Dexterity Meet end to end, in the topology the office runs: the hub, the gateway Worker
// (wrangler dev) and the meeting site (wrangler pages dev, the Pages project apps/meet-site, whose
// service binding passes everything to that gateway). Guests use only the site's address.
//
// Priya schedules a weekly meeting in the Calendar with a name (p12-design-review), guests on;
// the dialog stays open on the invitation: Copy invitation (text) and Download invitation (.ics,
// with the clean link in URL and LOCATION and one UID). Dana opens the clean link without the
// passcode: with the title hidden the page and its network answers hold only the date, the time
// and the office; then with the passcode the whole title block, the countdown and Add to calendar.
// The device check (camera preview, mic level, speakers, choosing devices); waiting before the
// start; Priya reschedules and the page moves by itself, the room opens; the lobby; admitted;
// talking both ways; the gateway dropping (reconnecting, let in again); leaving (time spent, the
// host's note, the next time). Then: a personal room link, an old /m/ link redirected, a
// cancellation shown on the page, one answer for nothing-here, and the wrong-passcode lockout.
// Screenshots at 1440 and 390 wide, light and dark, of every page state and of the dialog.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import pw from 'playwright-core';
import { startOffice, launch, sleep, OUT, voices } from './harness.mts';
import { fileURLToPath as rootPath } from 'node:url';
const ROOT = rootPath(new URL('../../../', import.meta.url));
const SHOTS = process.env.MEETLINK_OUT ?? path.join(OUT, 'meetlink');
fs.mkdirSync(SHOTS, { recursive: true });

const free = async () => { const s = net.createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r())); const p = (s.address() as net.AddressInfo).port; await new Promise<void>((r) => s.close(() => r())); return p; };
const wrangler = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
// a dev registry of our own: the site's service binding finds this gateway, not another one running here
const registry = fs.mkdtempSync(path.join(OUT, 'wr-registry-'));
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', WRANGLER_REGISTRY_PATH: registry };
const ready = (child: ReturnType<typeof spawn>, what: string) => new Promise<void>((res, rej) => {
  const t = setTimeout(() => rej(new Error(`${what} did not start`)), 120_000);
  const on = (b: Buffer) => { if (/Ready on/.test(b.toString())) { clearTimeout(t); res(); } };
  child.stdout!.on('data', on); child.stderr!.on('data', on);
});

const { owner, hub } = await startOffice('meetlink');
const gwPort = await free();
const gw = spawn(wrangler, ['dev', '--ip', '127.0.0.1', '--port', String(gwPort), '--persist-to', path.join(OUT, `gw-state-${Date.now()}`), '--show-interactive-dev-session=false'], { cwd: path.join(ROOT, 'apps/gateway'), detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
await ready(gw, 'the gateway');
gw.stdout!.resume(); gw.stderr!.resume();
const sitePort = await free();
await new Promise<void>((res, rej) => { const b = spawn(process.execPath, [path.join(ROOT, 'apps/meet-site/scripts/build.mjs')], { stdio: 'inherit' }); b.on('exit', (c) => (c === 0 ? res() : rej(new Error('site build failed')))); });
const pages = spawn(wrangler, ['pages', 'dev', '--ip', '127.0.0.1', '--port', String(sitePort), '--show-interactive-dev-session=false'], { cwd: path.join(ROOT, 'apps/meet-site'), detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
await ready(pages, 'the meeting site');
pages.stdout!.resume(); pages.stderr!.resume();
const gwUrl = `http://127.0.0.1:${gwPort}`;
const site = `http://127.0.0.1:${sitePort}`;
console.log('gateway', gwUrl, 'meeting site', site);

await owner.request('admin.remote.set', { url: gwUrl, enabled: true, siteUrl: site, orgName: 'Dexterity Design Services' });
for (let i = 0; i < 100 && !(await owner.request('admin.remote.get')).status.connected; i++) await sleep(100);
assert.ok((await owner.request('admin.remote.get')).status.connected, 'hub reached the gateway');
await sleep(500);

// the drives test hook (development builds only) records what the app would open instead of opening it:
// here, the email draft for "Send by email"
process.env.DEXCONNECT_TEST_DRIVES = '{"drives":[]}';
const a = await launch('priya', 'Priya Raman', { audio: voices().a, width: 1440, height: 900 });
// Nib's start-of-day prompt depends on the time of day the walk runs; it is not what this walk tests
await a.page.addLocatorHandler(a.page.locator('.nib-callout'), async () => {
  await a.page.locator('.nib-callout').getByRole('button', { name: 'Not now' }).click({ timeout: 2000 }).catch(() => {});
});
const browser = await pw.chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${voices().b}`, '--autoplay-policy=no-user-gesture-required'] });
const results: Record<string, unknown> = {};
const appShot = async (p: any, name: string) => {
  for (const t of ['light', 'dark']) { await p.evaluate((x: string) => { document.documentElement.dataset.theme = x; }, t); await sleep(250); await p.screenshot({ path: path.join(SHOTS, `${name}-${t}.png`) }); }
  await p.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
};
/** A page state at 1440 and 390 wide, light and dark (the page's own theme toggle uses data-theme too). */
const snap = async (p: any, name: string, opts: { full?: boolean } = {}) => {
  // the sheet plots itself in on the first view of a visit: let it finish
  await sleep(1800);
  for (const [w, hgt] of [[1440, 900], [390, 844]]) {
    await p.setViewportSize({ width: w, height: hgt });
    for (const t of ['light', 'dark']) {
      await p.emulateMedia({ colorScheme: t });
      await sleep(350);
      await p.screenshot({ path: path.join(SHOTS, `${name}-${w}-${t}.png`), fullPage: opts.full ?? true });
    }
  }
  await p.setViewportSize({ width: 1440, height: 900 });
  await p.emulateMedia({ colorScheme: 'light' });
};
/** Every answer the meeting site gave this page, for leak checks. */
const watchNet = (p: any) => {
  const bodies: string[] = [];
  p.on('response', async (r: any) => { if (new URL(r.url()).pathname.startsWith('/api/')) { try { bodies.push(await r.text()); } catch { /* a socket */ } } });
  return bodies;
};
const guestPage = async (ctx: any) => {
  const g = await ctx.newPage();
  g.on('pageerror', (e: Error) => console.log('[guest pageerror]', e.message));
  g.on('console', (m: any) => { if (m.type() === 'error' && !/favicon|ERR_ABORTED/.test(m.text())) console.log('[guest console]', m.text()); });
  return g;
};

try {
  await a.page.reload(); await a.page.locator('.frame').waitFor();
  const users = (await owner.request('directory.list')).users;
  const vikram = users.find((u: any) => u.account.endsWith('vikram'))!;
  await owner.request('admin.org.setProfile', { userId: users.find((u: any) => u.account.endsWith('priya'))!.id, email: 'priya.raman@dexteritydesign.co.in' });

  // ------------------------------------------------------------ Priya schedules it in the Calendar, with a name
  await a.page.getByRole('button', { name: /^Calendar/ }).first().click();
  await a.page.getByRole('button', { name: 'New meeting' }).click();
  await a.page.getByLabel('Title', { exact: true }).fill('P-12 design review');
  const start = new Date(Date.now() + 2 * 3600_000); start.setSeconds(0, 0); start.setMinutes(Math.ceil(start.getMinutes() / 5) * 5);
  const local = (t: number) => new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  await a.page.getByLabel('Starts').fill(local(start.getTime()));
  await a.page.getByLabel('Repeat').selectOption('weekly');
  await a.page.getByPlaceholder('Invite people').fill('Vik');
  await a.page.locator('.ev-suggest button', { hasText: 'Vikram Shah' }).click();
  await a.page.locator('.toggle-row', { hasText: 'Guests from outside can join from a browser' }).click();
  await a.page.getByLabel("The meeting's name on the meeting site").fill('P12 Design Review');
  await a.page.getByText('Free: …/p12-design-review').waitFor({ timeout: 10000 });
  await a.page.locator('.dialog').evaluate((d: HTMLElement) => { d.querySelector('.ev-page')?.scrollIntoView({ block: 'center' }); });
  await sleep(300);
  await appShot(a.page, 'ml-01-dialog-new');
  await a.page.getByRole('button', { name: 'Send invitations' }).click();
  // the dialog stays open on the invitation
  await a.page.locator('.guest-url').waitFor({ timeout: 15000 });
  const guestUrl = (await a.page.locator('.guest-url').innerText()).trim();
  const pass = (await a.page.locator('.guest-pass').innerText()).trim();
  assert.equal(guestUrl, `${site}/p12-design-review#${pass}`, 'the clean link, the passcode after #');
  console.log('meeting link', guestUrl);
  // the host's note for afterwards
  await a.page.getByLabel('A note guests see when they leave').fill('Thank you. The minutes and the marked-up isometrics follow by Friday.');
  await a.page.getByRole('button', { name: 'Save note' }).click();
  await sleep(400);
  await a.page.locator('.meet-invite-block').scrollIntoViewIfNeeded();
  await appShot(a.page, 'ml-02-dialog-invitation');
  await a.page.setViewportSize({ width: 390, height: 844 });
  await sleep(500);
  await a.page.locator('.meet-invite-block').scrollIntoViewIfNeeded();
  await appShot(a.page, 'ml-02b-dialog-invitation-390');
  await a.page.setViewportSize({ width: 1440, height: 900 });
  // Copy invitation (text) and Download invitation (.ics)
  await a.page.getByRole('button', { name: 'Copy invitation' }).click();
  await sleep(300);
  const invite = await a.app.evaluate(({ clipboard }: any) => clipboard.readText());
  assert.match(invite, /Priya Raman invites you to a meeting: P-12 design review/);
  assert.ok(invite.includes(guestUrl) && invite.includes(`Passcode: ${pass}`), invite);
  await a.page.evaluate(() => { const o = URL.createObjectURL; (window as any).__ics = null; URL.createObjectURL = (b: Blob) => { void b.text().then((t) => { (window as any).__ics = t; }); return o(b); }; });
  await a.page.getByRole('button', { name: 'Download invitation (.ics)' }).click();
  await a.page.waitForFunction(() => !!(window as any).__ics);
  const ics = (await a.page.evaluate(() => (window as any).__ics as string)).replace(/\r\n /g, '');
  const meetingId = (await a.page.evaluate(async () => { const l = await window.dex.request('cal.list', { from: Date.now(), to: Date.now() + 86400_000 }); const o = l.find((x: any) => x.event.title === 'P-12 design review'); return (await window.dex.request('meet.event', { eventId: o.event.id })).id; })) as string;
  const dashed = `${meetingId.slice(0, 3)}-${meetingId.slice(3, 6)}-${meetingId.slice(6)}`;
  assert.match(ics, new RegExp(`\\r\\nUID:meeting-${meetingId}@dexconnect\\r\\n`));
  assert.ok(ics.includes(`\r\nURL:${guestUrl}\r\n`), 'URL: the one-click link');
  assert.ok(ics.includes(`\r\nLOCATION:${site}/p12-design-review\r\n`), 'LOCATION: the page without the passcode');
  results.ics = ics.split('\r\n').filter((l) => /^(UID|URL|LOCATION|SUMMARY)/.test(l));
  // Send by email: an .eml draft written and opened in the mail program, with the .ics attached
  await a.page.getByRole('button', { name: 'Send by email' }).click();
  await a.page.getByText(/Email draft opened in your mail program/).waitFor({ timeout: 10000 });
  const opened = await a.app.evaluate(() => (globalThis as unknown as { __dexTestShell: Array<{ kind: string; path: string }> }).__dexTestShell.slice());
  const draftPath = opened.map((x: { path: string }) => x.path).filter((x: string) => x.endsWith('.eml')).pop()!;
  assert.ok(draftPath && /dexterity-connect-mail/.test(draftPath), JSON.stringify(opened));
  const eml = fs.readFileSync(draftPath, 'utf8');
  const [emlHead] = eml.split('\r\n\r\n');
  assert.ok(!/[^\r]\n/.test(eml), 'CRLF line ends');
  assert.match(emlHead, /\r\nX-Unsent: 1\r\n/);
  const subject = /\r\nSubject: ([^]*?)\r\n(?=\S)/.exec(`\r\n${emlHead}`)![1].split('\r\n ').map((w) => { const x = /^=\?UTF-8\?B\?(.*)\?=$/.exec(w); return x ? Buffer.from(x[1], 'base64').toString('utf8') : w; }).join('');
  assert.match(subject, /^Invitation: P-12 design review · \w{3} \d+ \w{3}, \d+:\d{2} [AP]M /);
  const emlParts = eml.split(/\r\n--=_dex_(?:mixed|alt)_[a-z0-9]+(?:--)?\r\n/).slice(1).map((pt) => { const [hd, ...b] = pt.split('\r\n\r\n'); return { hd, body: /base64/.test(hd) ? Buffer.from(b.join('').replace(/\r\n/g, '').replace(/--=_dex.*$/, ''), 'base64').toString('utf8') : '' }; });
  const plain = emlParts.find((x) => /text\/plain/.test(x.hd))!;
  const htmlPart = emlParts.find((x) => /text\/html/.test(x.hd))!;
  const att = emlParts.find((x) => /text\/calendar; method=PUBLISH/.test(x.hd))!;
  assert.ok(plain.body.includes(guestUrl) && plain.body.includes(`Passcode: ${pass}`));
  assert.ok(htmlPart.body.includes(`href="${guestUrl}"`) && /Join from your browser/.test(htmlPart.body));
  assert.ok(/attachment; filename="P-12 design review\.ics"/.test(att.hd) && att.body.includes(`UID:meeting-${meetingId}@dexconnect`));
  results.emailDraft = { file: path.basename(draftPath), subject, parts: emlParts.map((x) => /Content-Type: ([^;\r\n]+)/.exec(x.hd)?.[1]) };
  await a.page.keyboard.press('Escape');

  // ------------------------------------------------------------ Dana opens the clean link without the passcode: the title hidden first
  // only hosts may change the page: Priya hides the title from her app
  await assert.rejects(owner.request('meet.public.set', { id: meetingId, showTitle: false }), /host/);
  await a.page.evaluate((id: string) => window.dex.request('meet.public.set', { id, showTitle: false }), meetingId);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const g = await guestPage(ctx);
  const seen = watchNet(g);
  await g.goto(`${site}/p12-design-review`);
  await g.getByLabel('Passcode from your invitation').waitFor();
  assert.equal(new URL(g.url()).host, `127.0.0.1:${sitePort}`, 'only the site\'s address');
  await sleep(1200);
  const hiddenText = await g.evaluate(() => document.body.innerText);
  for (const leak of ['P-12 design review', 'Priya', 'Vikram', 'priya.raman@', 'Raman', hub.info.id, `${gwPort}`]) {
    assert.ok(!hiddenText.includes(leak), `no "${leak}" on the page before the passcode`);
    assert.ok(!seen.join('\n').includes(leak), `no "${leak}" in what the site answered`);
  }
  assert.match(hiddenText, /Meeting with Dexterity Design Services/);
  assert.match(hiddenText, new RegExp(dashed));
  results.beforePasscode = JSON.parse(seen[0]);
  await snap(g, 'ml-03-locked-title-hidden');
  // with the title shown (the default for scheduled meetings), the title and first name only
  await a.page.evaluate((id: string) => window.dex.request('meet.public.set', { id, showTitle: true }), meetingId);
  await g.reload();
  await g.getByRole('heading', { name: 'P-12 design review' }).waitFor();
  const shownText = await g.evaluate(() => document.body.innerText);
  assert.match(shownText, /Priya · Dexterity Design Services/);
  assert.ok(!shownText.includes('Raman') && !shownText.includes('Vikram') && !seen.join('\n').includes('Vikram'), 'first name only, no attendees');
  await snap(g, 'ml-04-locked-title-shown');

  // ------------------------------------------------------------ with the passcode: the whole title block, the countdown, Add to calendar
  await g.goto(guestUrl);
  await g.locator('#join-name').waitFor({ timeout: 15000 });
  await g.locator('.state.soon .count').waitFor({ timeout: 15000 });
  assert.equal(new URL(g.url()).hash, '', 'the passcode is taken out of the address bar');
  const calLinks = await g.locator('.cal-row a').evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).href));
  assert.ok(calLinks.some((h) => h.startsWith('https://calendar.google.com/')) && calLinks.some((h) => h.startsWith('https://outlook.live.com/')));
  assert.ok(calLinks.every((h) => !h.includes(pass)), 'no passcode to Google or Outlook');
  assert.ok(await g.getByRole('button', { name: /Ask to join/ }).isDisabled(), 'the room is not open yet');
  await g.getByText(/The room opens at/).first().waitFor();
  await snap(g, 'ml-05-waiting-before-start');

  // the device check
  await g.getByRole('button', { name: 'Check camera and mic' }).click();
  await g.locator('.preview video').waitFor({ timeout: 15000 });
  await g.waitForFunction(() => (document.querySelector('.preview video') as HTMLVideoElement)?.videoWidth > 0);
  await g.waitForFunction(() => Number(document.querySelector('.meter')?.getAttribute('aria-valuenow') ?? 0) > 0, null, { timeout: 15000 });
  await g.getByRole('button', { name: 'Test speakers' }).click();
  await g.locator('.choose summary').click();
  await g.getByLabel('Camera', { exact: true }).waitFor();
  results.devices = await g.locator('.devices select').evaluateAll((s) => s.map((x) => (x as HTMLSelectElement).id));
  await sleep(600);
  // the living drawing: the visitor's own readiness, filled in as they check
  const caption = () => g.locator('.living figcaption').textContent();
  await g.waitForFunction(() => /network \d+ milliseconds/.test(document.querySelector('.living figcaption')?.textContent ?? ''), null, { timeout: 15000 });
  await g.waitForFunction(() => /camera working; microphone heard; speakers tested/.test(document.querySelector('.living figcaption')?.textContent ?? ''), null, { timeout: 20000 });
  assert.match((await caption())!, /Checked and ready/);
  assert.match((await caption())!, /your time .*office time|the same as the office/);
  assert.equal(await g.locator('.plate .tag.ok').count(), 4, 'all four tags checked');
  results.readiness = await caption();
  await snap(g, 'ml-06-device-check', { full: true });

  // ------------------------------------------------------------ Priya reschedules: the page moves by itself, and the room opens
  await g.locator('#join-name').fill('Dana Wright');
  const soon = Date.now() + 10 * 60_000 + 40_000;
  await a.page.getByRole('button', { name: 'Agenda' }).click();
  await a.page.locator('.agenda-row', { hasText: 'P-12 design review' }).first().click();
  await a.page.getByRole('button', { name: 'Edit' }).click();
  await a.page.getByLabel('Starts').fill(local(soon));
  await a.page.getByRole('button', { name: 'Save', exact: true }).click();
  await a.page.getByText('Meeting updated').waitFor();
  const newTime = new Date(new Date(local(soon)).getTime()).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  await g.waitForFunction((t: string) => document.querySelector('.when')?.textContent?.includes(t), newTime, { timeout: 40_000 });
  results.rescheduledTo = newTime;
  assert.equal(await g.locator('#join-name').inputValue(), 'Dana Wright', 'what the guest typed survives the update');
  // ten minutes before the start the room opens: Ask to join turns on without a reload
  await g.getByRole('button', { name: /Ask to join|Join the meeting/ }).and(g.locator(':enabled')).waitFor({ timeout: 90_000 });
  await snap(g, 'ml-07-room-open');

  // ------------------------------------------------------------ Priya opens the Room; Dana asks to join, waits in the lobby, is let in
  await a.page.evaluate((id: string) => window.dispatchEvent(new CustomEvent('dex-deeplink', { detail: `dexconnect://meet/${id}` })), dashed);
  await a.page.getByRole('button', { name: 'Leave Room' }).waitFor({ timeout: 20000 });
  await a.page.getByTitle('Turn your camera on').click();
  await g.waitForFunction(() => document.querySelector('.state.live') !== null, null, { timeout: 40_000 }).catch(() => {});
  await g.getByRole('button', { name: /Join the meeting|Ask to join/ }).click();
  await g.getByRole('heading', { name: 'The host will let you in' }).waitFor({ timeout: 20000 });
  await sleep(500);
  assert.match((await g.locator('.living figcaption').textContent())!, /Awaiting approval from the host/);
  await snap(g, 'ml-08-lobby');
  const row = a.page.locator('.room-lobby li', { hasText: 'Dana Wright' });
  await row.waitFor({ timeout: 15000 });
  await row.getByRole('button', { name: 'Admit' }).click();
  await g.locator('.room .tile').first().waitFor({ timeout: 20000 });
  // talking: video and sound both ways
  await g.waitForFunction(() => [...document.querySelectorAll('.tile video')].some((v) => !(v as HTMLVideoElement).classList.contains('mirror') && (v as HTMLVideoElement).videoWidth > 0 && (v as HTMLVideoElement).currentTime > 0.3), null, { timeout: 30000 });
  await a.page.waitForFunction(() => { const v = document.querySelector('.room-tile[data-device^="guestdev:"] video') as HTMLVideoElement | null; return !!v && v.videoWidth > 0 && v.currentTime > 0.3; }, null, { timeout: 30000 });
  const heard = await g.evaluate(async () => {
    const el = [...document.querySelectorAll('audio')].find((x) => (x as HTMLAudioElement).srcObject) as HTMLAudioElement | undefined;
    const s = el?.srcObject as MediaStream | undefined;
    if (!s?.getAudioTracks().length) return 0;
    const ctx = new AudioContext(); const an = ctx.createAnalyser(); ctx.createMediaStreamSource(s).connect(an);
    const buf = new Uint8Array(an.fftSize); let peak = 0;
    for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 100)); an.getByteTimeDomainData(buf); for (const b of buf) peak = Math.max(peak, Math.abs(b - 128)); }
    return peak;
  });
  results.guestHearsHost = heard;
  assert.ok(heard > 2, `the guest hears the host (peak ${heard})`);
  await sleep(1000);
  await snap(g, 'ml-09-in-meeting', { full: false });
  await appShot(a.page, 'ml-09b-host-with-guest');

  // the line drops (the hub and the gateway reconnect): the guest page says so and joins again
  await owner.request('admin.remote.set', { enabled: false });
  await g.locator('#reconnect, .state .spin').first().waitFor({ timeout: 15000 });
  await sleep(300);
  await snap(g, 'ml-10-reconnecting', { full: false });
  await owner.request('admin.remote.set', { enabled: true });
  const again = a.page.locator('.room-lobby li', { hasText: 'Dana Wright' });
  await again.waitFor({ timeout: 40000 });
  await again.getByRole('button', { name: 'Admit' }).click();
  await g.locator('.room .tile').first().waitFor({ timeout: 20000 });
  results.reconnected = true;
  await sleep(1500);

  // Dana leaves: time spent, Priya's note, the next time
  await g.getByRole('button', { name: 'Leave' }).click();
  await g.getByRole('heading', { name: 'Thanks for joining' }).waitFor({ timeout: 10000 });
  const closing = await g.evaluate(() => document.body.innerText);
  assert.match(closing, /Time in the meeting/i);
  assert.match(closing, /The minutes and the marked-up isometrics follow by Friday/);
  assert.match(closing, /Next: /);
  await g.getByRole('group', { name: 'Add the next one' }).waitFor();
  assert.match((await g.locator('.living figcaption').textContent())!, /Approved for entry at .*Issued: \d+ minutes? in the meeting/);
  await snap(g, 'ml-11-closing');
  await a.page.getByRole('button', { name: 'Leave Room' }).click();

  // ------------------------------------------------------------ a personal room: /priya
  await a.page.locator('.lens-bar .lens', { hasText: 'Meet' }).click();
  await a.page.locator('.meet-personal .page-url').waitFor({ timeout: 15000 });
  const personalPage = (await a.page.locator('.meet-personal .page-url').innerText()).trim();
  assert.equal(personalPage, `127.0.0.1:${sitePort}/priya`);
  await a.page.locator('.meet-guests summary').click();
  await a.page.locator('.meet-guests').getByRole('switch', { name: 'Guests can join from a browser' }).click();
  await a.page.locator('.meet-guests .guest-url').waitFor({ timeout: 10000 });
  const personalUrl = (await a.page.locator('.meet-guests .guest-url').innerText()).trim();
  assert.match(personalUrl, new RegExp(`^${site.replace(/[.]/g, '\\.')}/priya#[A-Za-z0-9]{8}$`));
  await sleep(300);
  await appShot(a.page, 'ml-12-meet-lens');
  const pctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pg = await guestPage(pctx);
  await pg.goto(personalUrl);
  await pg.getByText('Personal room', { exact: false }).first().waitFor({ timeout: 15000 });
  await pg.getByRole('heading', { name: /room$/ }).waitFor();
  await snap(pg, 'ml-13-personal-room');

  // ------------------------------------------------------------ an old /m/ link: redirected to the clean page, passcode kept
  const og = await guestPage(pctx);
  await og.goto(`${gwUrl}/m/${meetingId}#${pass}`);
  await og.waitForURL(`${site}/${dashed}`, { timeout: 15000 });
  await og.getByRole('heading', { name: 'P-12 design review' }).waitFor({ timeout: 15000 });
  results.oldLink = og.url();
  await og.close();

  // ------------------------------------------------------------ cancelled: the page says so (after the passcode)
  const cg = await guestPage(ctx);
  await cg.goto(guestUrl);
  await cg.getByRole('heading', { name: 'P-12 design review' }).waitFor({ timeout: 15000 });
  await a.page.getByRole('button', { name: /^Calendar/ }).first().click();
  await a.page.getByRole('button', { name: 'Agenda' }).click();
  await a.page.locator('.agenda-row', { hasText: 'P-12 design review' }).first().click();
  await a.page.getByRole('button', { name: 'Cancel meeting' }).click();
  await a.page.getByRole('button', { name: 'Cancel meeting' }).last().click();
  await a.page.getByText('Meeting cancelled').waitFor();
  await cg.getByRole('heading', { name: 'This meeting was cancelled' }).waitFor({ timeout: 40_000 });
  await snap(cg, 'ml-14-cancelled');

  // ------------------------------------------------------------ one answer for nothing here: an unknown name and the cancelled one look the same
  const ng = await guestPage(ctx);
  const nseen = watchNet(ng);
  await ng.goto(`${site}/p12-design-review`);
  await ng.getByRole('heading', { name: 'No meeting to show here yet' }).waitFor();
  const t1 = (await ng.evaluate(() => document.querySelector('.work')!.textContent!)).replace(/Address · \/[a-z0-9-]+/, '');
  await ng.goto(`${site}/no-such-meeting`);
  await ng.getByRole('heading', { name: 'No meeting to show here yet' }).waitFor();
  const t2 = (await ng.evaluate(() => document.querySelector('.work')!.textContent!)).replace(/Address · \/[a-z0-9-]+/, '');
  assert.equal(t1, t2, 'a cancelled meeting and an unknown name read the same before the passcode');
  assert.ok(nseen.every((b) => b === '{"found":false}'), nseen.join(' | '));
  await snap(ng, 'ml-15-nothing-here');
  await ng.goto(`${site}/`);
  await ng.getByRole('heading', { name: 'Join a meeting with Dexterity Design Services' }).waitFor();
  await snap(ng, 'ml-16-home');

  // ------------------------------------------------------------ wrong passcodes: five, then this network is turned away
  await ng.goto(`${site}/${dashed}`);
  for (let i = 0; i < 6; i++) {
    await ng.getByLabel('Passcode from your invitation').fill(`Wrong${i}xyz`);
    const answered = ng.waitForResponse((r: any) => r.url().endsWith('/check'));
    await ng.getByRole('button', { name: 'Continue' }).click();
    const r = await answered;
    if (i < 5) { assert.equal(r.status(), 403); await ng.getByText('That passcode does not open a meeting at this address.').waitFor({ timeout: 10000 }); } else assert.equal(r.status(), 429);
    await sleep(400);
  }
  await ng.getByRole('heading', { name: 'Too many tries from your network' }).waitFor({ timeout: 10000 });
  await snap(ng, 'ml-17-locked-out');
  const audit = await owner.request('admin.audit', { limit: 300 }) as Array<{ action: string }>;
  for (const x of ['meeting.nameSet', 'meeting.guestLinkOn', 'meeting.guestKnocked', 'meeting.guestJoined']) assert.ok(audit.some((e) => e.action === x), x);
  console.log('RESULTS', JSON.stringify(results));
  console.log('MEETLINK E2E PASSED');
} catch (e) {
  await a.page.screenshot({ path: path.join(SHOTS, 'ml-FAIL-app.png') }).catch(() => {});
  for (const [i, p] of browser.contexts().flatMap((c: any) => c.pages()).entries()) await p.screenshot({ path: path.join(SHOTS, `ml-FAIL-guest-${i}.png`), fullPage: true }).catch(() => {});
  throw e;
} finally {
  await browser.close().catch(() => {});
  await a.app.close().catch(() => {});
  owner.disconnect();
  await hub.stop();
  for (const c of [gw, pages]) { try { process.kill(-c.pid!, 'SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(registry, { recursive: true, force: true });
}
