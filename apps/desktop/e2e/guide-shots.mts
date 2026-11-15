// Screenshots for the user guide (docs/guide/figures/fig-*.png). One realistic demo office is
// seeded into a fresh hub: 40 people in departments, project Spaces with real-looking messages,
// a PDF drawing, a poll, a Decision, reminders, meetings, a bot and an automation. Then the walk
// opens every screen the guide shows, as Priya Raman (Lead Piping Designer), as Vikram Shah (the
// owner, for the Control room) and as a new joiner, and saves each shot in the light theme at
// 1440 × 900 (phone shots at 390 px, a few dark ones).
//
//   npm run desktop:build && npm run build -w @dex/mobile
//   POL1_ISOLATED=1 TZ=Asia/Kolkata xvfb-run -a -s "-screen 0 2000x1000x24 -noreset" node apps/desktop/e2e/guide-shots.mts
//
// GUIDE_ONLY=pulse,messages,… runs only some parts (the office is always seeded); GUIDE_OUT puts
// the pictures somewhere else. Every part catches its own failure, saves a "-FAIL" picture in
// e2e/out and carries on, and the run ends with the list of parts that failed. The script is
// re-runnable: each run starts from an empty hub and overwrites the figures.
import pw from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { createRequire } from 'node:module';
import { createIdentity, signWith } from '../../../packages/core/src/index.ts';
import { createEncKeys } from '../../../packages/core/src/e2e.ts';
import { E2EClient } from '../../../packages/core/src/e2e-client.ts';
import { HubClient } from '../../../packages/core/src/hub-client.ts';
import { Hub } from '../../../apps/hub/src/hub.ts';
import { OFFICE, seedOffice } from './officeseed.mts';
import { upload } from './seed.mts';
import { makePdf, text } from '../../../apps/desktop/test/pdf-fixtures.ts';

process.env.TZ ??= 'Asia/Kolkata';
const ROOT = path.resolve(import.meta.dirname, '../../..');
const FIG = process.env.GUIDE_OUT ?? path.join(ROOT, 'docs/guide/figures');
const OUT = path.join(import.meta.dirname, 'out');
fs.mkdirSync(FIG, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const ELECTRON = createRequire(import.meta.url)('electron') as unknown as string;
const ONLY = process.env.GUIDE_ONLY ? process.env.GUIDE_ONLY.split(',') : null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const W = 1440, H = 900;

// ------------------------------------------------------------------ the hub and its owner
const hubDir = fs.mkdtempSync(path.join(OUT, 'hub-guide-'));
const hub = new Hub({ dataDir: hubDir, updates: false, port: 0, discoveryPort: false });
await hub.start();
let autoApprove = true;
const owner = new HubClient({ identity: createIdentity(), account: { username: 'vikram', domain: 'DEX', displayName: 'Vikram Shah', hostname: 'VIKRAM-PC' } });
owner.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
await new Promise<void>((res) => { const on = (s: any) => { if (s.kind === 'ready') { owner.off('state', on); res(); } }; owner.on('state', on); });
owner.on('event', (name: string, d: any) => { if (name === 'admin.pending' && autoApprove) void owner.request('admin.decide', { deviceId: d.id, approve: true }).catch(() => {}); });

/** The apps join by this PC's own network address (as an office PC would), else the loopback. */
const LAN = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? '127.0.0.1';

// ------------------------------------------------------------------ helpers
type App = { app: any; page: any; name: string };
const apps: App[] = [];
async function openApp(username: string, displayName: string, opts: { width?: number; height?: number; join?: boolean; video?: string } = {}): Promise<App> {
  const userData = fs.mkdtempSync(path.join(OUT, `ud-guide-${username}-`));
  const app = await pw._electron.launch({
    executablePath: ELECTRON,
    args: [path.join(ROOT, 'apps/desktop'), `--user-data-dir=${userData}`, '--no-sandbox', '--force-device-scale-factor=1',
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', ...(opts.video ? [`--use-file-for-fake-video-capture=${opts.video}`] : [])],
    env: { ...process.env, USERDOMAIN: 'DEX', DEXCONNECT_DEV_ACCOUNT: `${username}|${displayName}`, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  const page = await app.firstWindow();
  await size({ app, page, name: username }, opts.width ?? W, opts.height ?? H);
  page.on('pageerror', (e: Error) => console.log(`[${username} pageerror]`, e.message));
  page.on('console', (m: any) => { if (m.type() === 'error') console.log(`[${username} console]`, m.text().slice(0, 300)); });
  page.setDefaultTimeout(10000);
  const a = { app, page, name: username };
  apps.push(a);
  if (opts.join !== false) { await joinHub(page); await page.locator('.frame').waitFor({ timeout: 30000 }); await theme(page, 'light'); }
  return a;
}
async function size(a: App, w: number, h: number) {
  const win = await a.app.browserWindow(a.page);
  await win.evaluate((bw: any, [x, y]: number[]) => { bw.setContentSize(x, y); }, [w, h]).catch(() => {});
  await a.page.setViewportSize({ width: w, height: h }).catch(() => {});
}
async function joinHub(page: any, name?: string) {
  await page.locator('.onboard').waitFor({ timeout: 20000 });
  if (name) await page.locator('#display-name').fill(name);
  await page.locator('.stack-v .field .link').first().click();
  await page.locator('.stack-v .field input.input:not(#display-name)').fill(`${LAN}:${hub.port}`);
  await page.locator('.stack-v button[type="submit"]').click({ timeout: 20000 });
}
async function closeApp(a: App) { await a.app.close().catch(() => {}); apps.splice(apps.indexOf(a), 1); }
const theme = async (page: any, t: 'light' | 'dark') => { await page.evaluate((x: string) => window.dex.setSettings({ theme: x as 'light' }), t); await sleep(400); };

/** Save a figure. `clip` is a box, or a locator to crop to (with a margin). */
async function shot(page: any, name: string, clip?: any, pad = 12) {
  let box = clip;
  if (clip && typeof clip.boundingBox === 'function') {
    const b = await clip.boundingBox();
    const vp = page.viewportSize();
    const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad);
    box = { x, y, width: Math.min(vp.width - x, b.width + 2 * pad), height: Math.min(vp.height - y, b.height + 2 * pad) };
  }
  await sleep(250);
  await page.screenshot({ path: path.join(FIG, `fig-${name}.png`), ...(box ? { clip: box } : {}), animations: 'disabled', caret: 'hide' });
  console.log('  fig', name);
}
const failed: string[] = [];
async function part(name: string, fn: () => Promise<void>) {
  if (ONLY && !ONLY.includes(name)) return;
  console.log(`== ${name}`);
  try { await fn(); } catch (e) {
    console.log(`!! ${name} failed:`, (e as Error).message.split('\n')[0]);
    failed.push(name);
    for (const a of apps) await a.page.screenshot({ path: path.join(OUT, `guide-FAIL-${name}-${a.name}.png`) }).catch(() => {});
  }
  // whatever the part left open, start the next one from a quiet screen
  for (const a of apps) { await a.page.keyboard.press('Escape').catch(() => {}); await a.page.keyboard.press('Escape').catch(() => {}); }
}
const lens = async (page: any, n: string) => { await page.locator('.lens-bar .lens', { hasText: n }).first().click(); await sleep(700); };
async function openConv(page: any, kind: 'Spaces' | 'Direct', name: string) {
  await lens(page, kind);
  const row = page.locator('.sb-row', { hasText: name }).first();
  if (!(await row.isVisible().catch(() => false)) && await page.locator('.sb-fold[aria-expanded="false"]').count()) await page.locator('.sb-fold').first().click();
  await row.click();
  await sleep(900);
}
const expandSwitchboard = async (page: any) => { if (await page.locator('.sb-fold[aria-expanded="false"]').count()) { await page.locator('.sb-fold').first().click(); await sleep(400); } };

/** A colleague on their own device that encrypts Direct messages like the app. */
async function colleague(u: string, name: string) {
  const identity = createIdentity();
  const c = new HubClient({ identity, account: { username: u, domain: 'DEX', displayName: name, hostname: `${u.toUpperCase()}-LAPTOP` } });
  c.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${u} did not connect`)), 20000);
    const on = (s: any) => { if (s.kind === 'ready') { clearTimeout(t); c.off('state', on); res(); } };
    c.on('state', on);
  });
  const keys = createEncKeys();
  const e2e = new E2EClient({ deviceId: identity.deviceId, encSecret: keys.secret, encPublic: keys.public, sign: (p: Uint8Array) => signWith(identity, p), request: (op: string, d: unknown) => c.request(op as never, d as never) });
  await e2e.ready(c.session!.me.id, []);
  c.on('event', (n: string, d: unknown) => { void e2e.onEvent(n, d).catch(() => {}); });
  const req = async (op: string, d?: unknown) => e2e.incoming(await c.request(op as never, await e2e.outgoing(op, d) as never));
  return { c, e2e, req, id: c.session!.me.id as string, token: (c as any).session.fileToken as string };
}
type Col = Awaited<ReturnType<typeof colleague>>;
let seq = 0;
const say = (who: Col | HubClient, convId: string, body: string, extra: Record<string, unknown> = {}): Promise<any> =>
  ('req' in who ? who.req : (op: string, d: unknown) => (who as HubClient).request(op as never, d as never))('msg.send', { convId, body, clientId: `guide-${++seq}`, ...extra });
const db = (hub as any).messaging.db;
/** Move a message back in time, so the timeline reads like a working day rather than one minute. */
const backdate = (id: string, at: number) => db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(Math.floor(at), id);
const today = (h: number, m: number) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime(); };
const yesterday = (h: number, m: number) => today(h, m) - 86400_000;

/** A camera picture: a plain silhouette against a wall, so Room shots show video without anyone's face. */
function camera(name: string, wall: string, shirt: string): string {
  const file = path.join(OUT, `guide-cam-${name}.y4m`);
  if (fs.existsSync(file)) return file;
  const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [wr, wg, wb] = hex(wall), [sr, sg, sb] = hex(shirt);
  const head = 'lt(hypot(X-320,Y-185),72)';
  const body = 'lt(pow((X-320)/190,2)+pow((Y-470)/150,2),1)';
  const skin = [196, 160, 132];
  const px = (w: number, s: number, k: number) => `if(${head},${k},if(${body},${s},${w}-Y/12))`;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x480:r=5:d=2',
    '-vf', `geq=r='${px(wr, sr, skin[0])}':g='${px(wg, sg, skin[1])}':b='${px(wb, sb, skin[2])}',format=yuv420p`, '-t', '2', file]);
  return file;
}


/** A piping GA sheet (A1 landscape) drawn in vector lines: grid, pipe rack, equipment, pipe runs
 *  with line numbers and valves, notes, a revision table and a title block. Made up for the guide. */
function gaSheet(): Uint8Array {
  const W = 2384, H = 1684;
  const f = (n: number) => n.toFixed(1);
  let o = '0 0 0 RG 0.6 w\n';
  o += `20 20 ${W - 40} ${H - 40} re S\n2.2 w 50 50 ${W - 100} ${H - 100} re S\n0.4 w\n`;
  // grid references in the border
  for (let i = 0; i < 8; i++) { const x = 50 + (i + 0.5) * (W - 100) / 8; o += text(x - 4, H - 42, 14, String(i + 1)) + text(x - 4, 28, 14, String(i + 1)); }
  for (let i = 0; i < 6; i++) { const y = 50 + (i + 0.5) * (H - 100) / 6; o += text(30, y, 14, String.fromCharCode(70 - i)) + text(W - 42, y, 14, String.fromCharCode(70 - i)); }
  // structural grid lines with bubbles (chain lines)
  o += '0.5 0.5 0.5 RG [18 6 4 6] 0 d 0.5 w\n';
  const gx = [260, 560, 860, 1160, 1460, 1760];
  for (const x of gx) o += `${x} 140 m ${x} 1500 l S\n`;
  for (const y of [320, 760, 1200]) o += `140 ${y} m 1880 ${y} l S\n`;
  o += '[] 0 d 0 0 0 RG\n';
  const circle = (cx: number, cy: number, r: number) => { const k = 0.5523 * r; return `${f(cx + r)} ${f(cy)} m ${f(cx + r)} ${f(cy + k)} ${f(cx + k)} ${f(cy + r)} ${f(cx)} ${f(cy + r)} c ${f(cx - k)} ${f(cy + r)} ${f(cx - r)} ${f(cy + k)} ${f(cx - r)} ${f(cy)} c ${f(cx - r)} ${f(cy - k)} ${f(cx - k)} ${f(cy - r)} ${f(cx)} ${f(cy - r)} c ${f(cx + k)} ${f(cy - r)} ${f(cx + r)} ${f(cy - k)} ${f(cx + r)} ${f(cy)} c S\n`; };
  gx.forEach((x, i) => { o += circle(x, 1530, 22) + text(x - 5, 1525, 16, String(i + 1)); });
  ['A', 'B', 'C'].forEach((l, i) => { const y = [320, 760, 1200][i]; o += circle(110, y, 22) + text(104, y - 6, 16, l); });
  // pipe rack: two beams and columns
  o += '1.2 w 0.25 0.25 0.25 RG\n';
  o += `260 700 m 1760 700 l S\n260 820 m 1760 820 l S\n`;
  for (const x of gx) o += `${x - 10} 690 20 140 re S\n`;
  o += text(900, 840, 18, 'PIPE RACK PR-03  TOS EL +106.000');
  // equipment
  o += '1.4 w 0 0 0 RG\n';
  o += circle(420, 1080, 95) + text(372, 1074, 18, 'V-401');
  o += text(330, 950, 11, 'FEED SURGE DRUM');
  o += `1180 1000 360 110 re S\n` + circle(1180, 1055, 55) + circle(1540, 1055, 55) + text(1300, 1048, 18, 'E-403');
  o += text(1262, 975, 11, 'FEED / EFFLUENT EXCHANGER');
  for (const [x, t] of [[520, 'P-402A'], [700, 'P-402B']] as const) { o += `${x - 50} 380 100 70 re S\n` + circle(x, 470, 34) + text(x - 32, 350, 14, t); }
  o += `1640 260 120 380 re S\n` + text(1655, 440, 18, 'C-401') + text(1612, 230, 11, 'STRIPPER COLUMN');
  // pipe runs (blue), with line numbers and valves
  o += '0.1 0.3 0.62 RG 3 w\n';
  const runs: Array<Array<[number, number]>> = [
    [[420, 985], [420, 760], [520, 760], [520, 504]],
    [[700, 504], [700, 640], [980, 640], [980, 760], [1180, 760], [1180, 1000]],
    [[1540, 1000], [1540, 760], [1700, 760], [1700, 640]],
    [[515, 1080], [860, 1080], [860, 1300], [1460, 1300], [1460, 1110]],
    [[260, 760], [180, 760], [180, 300], [470, 300], [470, 380]],
  ];
  for (const r of runs) o += `${r.map(([x, y], i) => `${x} ${y} ${i ? 'l' : 'm'}`).join(' ')} S\n`;
  o += '0 0 0 RG 0.8 w\n';
  const valve = (x: number, y: number, vertical = false) => vertical
    ? `${x - 14} ${y - 18} m ${x + 14} ${y - 18} l ${x - 14} ${y + 18} l ${x + 14} ${y + 18} l h S\n`
    : `${x - 18} ${y - 14} m ${x - 18} ${y + 14} l ${x + 18} ${y - 14} l ${x + 18} ${y + 14} l h S\n`;
  o += valve(420, 880, true) + valve(840, 640) + valve(1300, 1300) + valve(1540, 900, true) + valve(320, 300);
  const tag = (x: number, y: number, t: string) => text(x, y, 13, t);
  o += tag(430, 800, '6"-P-1001-A1B') + tag(760, 652, '6"-P-1002-A1B') + tag(1555, 780, '4"-P-1006-A1B') + tag(900, 1312, '8"-P-1014-A1B') + tag(190, 312, '2"-CW-2045');
  o += text(984, 772, 11, 'EL +104.500') + text(1186, 772, 11, 'EL +104.500');
  // a revision cloud round the changed support
  o += '0.85 0.45 0.1 RG 1 w\n';
  for (let a = 0; a < 360; a += 30) { const r = (a * Math.PI) / 180; o += circle(980 + 70 * Math.cos(r), 700 + 50 * Math.sin(r), 16); }
  o += '0 0 0 RG\n' + text(1020, 600, 12, 'SUPPORT S-114 MOVED 150 EAST (REV C)');
  // north arrow
  o += `2000 1440 m 2030 1520 l 2060 1440 l 2030 1465 l h S\n` + text(2022, 1530, 16, 'N');
  // notes
  o += text(1960, 1360, 14, 'NOTES');
  ['1. ALL DIMENSIONS IN MM, ELEVATIONS IN M.', '2. FOR LINE CLASSES SEE THE PIPING SPEC.', '3. SUPPORTS TO STD DRG P12-SD-001.', '4. REFER ISO-1001-01 TO ISO-1001-09.'].forEach((n, i) => { o += text(1960, 1330 - i * 22, 11, n); });
  // revision table and title block, bottom right
  const tx = 1900, tw = W - 50 - tx;
  o += `1.5 w ${tx} 50 ${tw} 300 re S\n0.6 w`;
  for (const y of [110, 170, 230, 290]) o += ` ${tx} ${y} m ${W - 50} ${y} l S`;
  o += `\n${tx + 220} 50 m ${tx + 220} 230 l S\n`;
  o += text(tx + 14, 312, 16, 'DEXTERITY DESIGN SERVICES PVT. LTD.');
  o += text(tx + 14, 250, 13, 'P-12 HYDROTREATER REVAMP - UNIT 4');
  o += text(tx + 14, 190, 13, 'PIPING GENERAL ARRANGEMENT - AREA 3');
  o += text(tx + 14, 130, 11, 'SCALE 1:50') + text(tx + 234, 130, 11, 'SHEET 1 OF 1');
  o += text(tx + 14, 72, 11, 'DRAWN RK  CHECKED PR') + text(tx + 234, 72, 13, 'P12-GA-0301  REV C');
  o += `${tx} 360 ${tw} 120 re S\n` + text(tx + 14, 456, 11, 'REV  DATE         DESCRIPTION                BY  CHK');
  o += text(tx + 14, 430, 11, 'A    02-OCT-26  ISSUED FOR REVIEW          RK  PR') + text(tx + 14, 408, 11, 'B    21-OCT-26  CLIENT COMMENTS ADDED      RK  PR') + text(tx + 14, 386, 11, 'C    13-NOV-26  SUPPORT S-114 MOVED        RK  PR');
  return makePdf([{ w: W, h: H, ops: o }], { title: 'P12-GA-0301 Rev C' });
}

// ------------------------------------------------------------------ the office
console.log('seeding the office');
const seeded = await seedOffice(hub, owner, OFFICE, ['vikram', 'priya']);
const id = (u: string) => seeded.ids.get(u)!;
// Priya joins from the app, so her PC has real keys; the rest of the office is seeded
const priyaApp = await openApp('priya', 'Priya Raman', { video: camera('priya', '#D9DFE6', '#8A3B2E') });
const P = priyaApp.page;
const users0 = (await owner.request('directory.list')).users;
const priyaId: string = users0.find((u: any) => u.account.endsWith('priya')).id;
await seeded.profiles({ priya: priyaId });
const people = ['meera', 'ravi', 'anand', 'deepa', 'karthik', 'lalitha', 'imran', 'sneha', 'rohan', 'fatima', 'rahul', 'thomas', 'manoj', 'sunil', 'bhavna'];
const col: Record<string, Col> = {};
for (const u of people) col[u] = await colleague(u, OFFICE.find((p) => p.u === u)!.name);
const where: Record<string, string> = { meera: 'office', ravi: 'office', anand: 'office', deepa: 'office', karthik: 'office', lalitha: 'office', imran: 'site', sneha: 'home', rohan: 'client', fatima: 'office', rahul: 'office', thomas: 'site', manoj: 'office', sunil: 'office', bhavna: 'office' };
for (const u of people) await col[u].c.request('work.checkIn', { mode: where[u] } as never).catch(() => {});
await col.ravi.c.request('me.update', { statusText: 'Checking P-12 isometrics' } as never);
await col.imran.c.request('me.update', { statusText: 'At the Jamnagar site till Thursday' } as never);
await col.anand.c.request('me.update', { availability: 'busy' } as never);
await owner.request('admin.help.staff', { userId: id('sunil'), on: true } as never).catch((e: Error) => console.log('it desk', e.message));

// Spaces
const mk = (name: string, topic: string, members: string[], extra: Record<string, unknown> = {}) =>
  owner.request('conv.create', { kind: 'space', name, topic, members: [priyaId, ...members.map(id)], ...extra } as never) as Promise<any>;
const notices = await mk('Office notices', 'Announcements from the front office and IT', OFFICE.map((p) => p.u).filter((u) => u !== 'vikram' && u !== 'priya'));
const p12 = await mk('P-12 Piping', 'Jamnagar hydrotreater revamp, unit 4: isometrics, MTOs and stress', ['meera', 'ravi', 'anand', 'deepa', 'karthik', 'lalitha', 'imran', 'rahul', 'lakshmi', 'thomas', 'fatima']);
const site = await mk('Site team', 'Jamnagar site, day to day', ['imran', 'thomas', 'ravi', 'rohan']);
const steel = await mk('P-14 Structural steel', 'Pipe rack and platforms for P-14', ['anand', 'sneha', 'vivek', 'pooja', 'farhan', 'ravi']);
const docs = await mk('Document control', 'Transmittals, revisions and client comments', ['fatima', 'joseph', 'meera', 'arjun', 'rohan', 'lalitha']);
const drafting = await mk('Drafting standards', 'Title blocks, layers, line weights', ['lalitha', 'manoj', 'asha', 'prakash', 'selvi', 'kiran']);
// Priya runs the Piping team Space herself (so she can add its automations)
await P.evaluate((m: string[]) => window.dex.request('conv.create', { kind: 'space', name: 'Piping team', topic: 'Everyone in Piping', members: m }), ['ravi', 'karthik', 'deepa', 'rahul', 'lakshmi', 'imran', 'thomas'].map(id));

// Office notices
const n1 = await say(col.bhavna, notices.id, 'The office will be closed on **Friday 20 November** for the Guru Nanak Jayanti holiday. Plotter jobs sent after 6 pm on Thursday will be printed on Saturday morning.');
const n2 = await say(col.sunil, notices.id, 'IT: the new A0 plotter on the 2nd floor is installed. Its name on the network is `PLOT-A0-2F`. Ask on the Help desk if it does not show on your PC.');
backdate(n1.id, yesterday(17, 40)); backdate(n2.id, today(9, 5));

// P-12 Piping: a working day
const t: any[] = [];
t.push(await say(owner, p12.id, 'Morning all. The revised MTO for area 3 is on the share. Please check lines 6"-P-1001-A1B and 2"-CW-2045 before Friday.'));
t.push(await say(col.ravi, p12.id, 'Checked the first batch. Two supports on ISO-1001-01 clash with the cable tray at EL 104.5; I have marked them on the PDF. The remaining 14 isometrics look clean.'));
t.push(await say(col.anand, p12.id, 'Nozzle loads from the last run:\n```\nNOZZLE  FX(N)   FY(N)   FZ(N)   MX(Nm)\nN3      1240    -860    2210    410\nN4      980     -420    1650    290\n```\nAll within the vendor allowables.'));
t.push(await say(col.deepa, p12.id, 'Stress for the pump suction lines is done. I have added two guides on 8"-P-1014 to keep the nozzle loads down; see **SR-P12-007** on the share.'));
t.push(await say(col.karthik, p12.id, 'Status this morning:\n- **Area 3**: 42 isometrics, checked\n- **Area 4**: 37 isometrics, in progress\n- **Area 5**: 18 isometrics, on hold (client)'));
const gaPdf = path.join(OUT, 'P12-GA-0301 Rev C Area 3.pdf');
fs.writeFileSync(gaPdf, gaSheet());
const pdf = await upload(hub.port, col.meera.token, 'P12-GA-0301 Rev C Area 3.pdf', fs.readFileSync(gaPdf));
t.push(await say(col.meera, p12.id, 'GA for area 3, issued for review. Comments by Thursday please.', { files: [pdf.id] }));
const ask = await say(col.meera, p12.id, `<@${priyaId}> can you take the bolt lengths for the 300# flanges? The gasket thickness changed in the last revision of the line class.`);
t.push(ask);
for (const [c, e] of [[col.ravi, '👍'], [col.anand, '👍'], [col.deepa, '✅'], [col.karthik, '👀']] as const) await c.c.request('msg.react', { messageId: ask.id, emoji: e, on: true } as never).catch(() => {});
const clash = await say(col.ravi, p12.id, 'Starting a side-track for the cable tray clash at EL 104.5 so we do not flood the Space.');
t.push(clash);
const r1 = await say(col.anand, p12.id, 'I can move the tray 150 mm east if civil agrees.', { parentId: clash.id });
const r2 = await say(col.deepa, p12.id, 'That works for stress too. The support stays where it is.', { parentId: clash.id });
const r3 = await say(col.ravi, p12.id, 'Thanks both. I will update ISO-1001-01 and send it to Fatima for issue.', { parentId: clash.id });
const poll = await col.lalitha.req('poll.create', { convId: p12.id, question: 'Model review with the client: which day suits?', options: ['Tuesday 17th', 'Wednesday 18th', 'Thursday 19th'], clientId: `guide-${++seq}` });
for (const [c, i] of [[col.ravi, 1], [col.anand, 1], [col.deepa, 2], [col.karthik, 1], [col.meera, 0]] as const) await c.req('poll.vote', { messageId: poll.id, options: [i] }).catch((e: Error) => console.log('vote', e.message));
t.push(poll);
t.push(await say(col.fatima, p12.id, 'Transmittal **DDSP-P12-TR-0142** went to the client at 12:30 with 18 isometrics (Rev B). Their comments are due on the 24th.'));
// times: yesterday afternoon, then this morning
const times = [yesterday(16, 10), yesterday(16, 42), yesterday(17, 5), today(9, 18), today(9, 47), today(10, 30), today(11, 2), today(11, 25), today(11, 58), today(12, 41)];
t.forEach((m, i) => { if (times[i]) backdate(m.id, times[i]); });
backdate(r1.id, today(11, 31)); backdate(r2.id, today(11, 40)); backdate(r3.id, today(11, 52));

// the other Spaces
const s1 = await say(col.imran, site.id, 'Crane arrives at 8 tomorrow. Safety briefing at 7:45 at the main gate; bring your helmet and the gate pass.');
const s2 = await say(col.thomas, site.id, 'Hydrotest of the area 3 headers is booked for Tuesday. I need the test pack drawings printed by Monday evening.');
backdate(s1.id, today(8, 50)); backdate(s2.id, today(10, 12));
await say(col.anand, steel.id, 'Platform P-14-PL-03 is ready for checking. The handrail detail follows the new standard.');
await say(col.sneha, steel.id, 'I will check it this afternoon from home and mark up the PDF.');
await say(col.fatima, docs.id, 'Client comments on the P-12 GA (Rev B) are in. Code 2: proceed with comments. I have put them on the share under \\\\nas01\\Project\\P12513\\Comments.');
await say(col.lalitha, drafting.id, 'Reminder: the new title block (rev 4) is the only one to use from today. The old block is in the archive folder.');
await say(col.lalitha, drafting.id, 'The block and the layer template are here: \\\\nas01\\Standards\\TitleBlocks\\Rev4');
// a Decision for the document controllers
await col.fatima.c.request('decision.create', { convId: docs.id, clientId: `guide-${++seq}`, root: {
  prompt: 'Issue ISO-1001-01 Rev C to the client today?',
  options: [
    { label: 'Yes, issue it today', note: 'Fatima sends it with transmittal TR-0143.' },
    { label: 'Hold it', next: { prompt: 'What should happen first?', options: [
      { label: 'Stress check of the new guides' }, { label: 'Civil confirms the tray move' }, { label: 'Something else', next: { prompt: 'Tell Fatima what is missing', kind: 'text' } },
    ] } },
  ] } } as never).catch((e: Error) => console.log('decision', e.message));
// a lounge in the project Space
await col.ravi.c.request('lounge.create', { convId: p12.id, name: 'Piping desk' } as never).catch((e: Error) => console.log('lounge', e.message));

// Directs (end-to-end encrypted)
const dmRavi = await col.ravi.c.request('conv.create', { kind: 'direct', members: [priyaId] } as never) as any;
const d1 = await say(col.ravi, dmRavi.id, 'Hi Priya, are you free for a quick look at the pipe rack GA after lunch?');
const d2 = await say(col.ravi, dmRavi.id, 'No rush, 3:30 works too.');
const d4 = await P.evaluate((c: string) => window.dex.request('msg.send', { convId: c, body: 'Yes, 3:30 is good. Bring the clash list and I will open the model.', clientId: 'guide-priya-1' }), dmRavi.id);
const d5 = await say(col.ravi, dmRavi.id, 'Great, see you at 3:30 at your desk 👍');
backdate(d1.id, today(13, 5)); backdate(d2.id, today(13, 6)); backdate((d4 as any).id, today(13, 20)); backdate(d5.id, today(13, 22));
const dmDeepa = await col.deepa.c.request('conv.create', { kind: 'direct', members: [priyaId] } as never) as any;
const d3 = await say(col.deepa, dmDeepa.id, 'Sent you the stress report for N3. The summary is on page 2.');
backdate(d3.id, today(10, 2));
const dmGroup = await col.karthik.c.request('conv.create', { kind: 'direct', members: [priyaId, id('rahul'), id('lakshmi')] } as never) as any;
await say(col.karthik, dmGroup.id, 'Lunch at 1:15 today? The canteen has biryani.');

// Calendar: meetings this week, in a room
const at = (dayOffset: number, h: number, m = 0) => { const d = new Date(); d.setDate(d.getDate() + dayOffset); d.setHours(h, m, 0, 0); return d.getTime(); };
const venue = await owner.request('admin.cal.saveVenue', { name: 'Conference room 1', capacity: 12 } as never).catch(() => null) as any;
await owner.request('admin.cal.saveVenue', { name: 'Cabin 3 (small meetings)', capacity: 4 } as never).catch(() => null);
const cal = (c: Col, v: Record<string, unknown>) => c.c.request('cal.create', v as never).catch((e: Error) => console.log('cal', e.message));
await cal(col.meera, { title: 'P-12 model review with the client', startAt: at(2, 11), endAt: at(2, 12, 30), attendees: [priyaId, id('ravi'), id('anand'), id('deepa'), id('rohan')], online: true, convId: p12.id, ...(venue ? { venueId: venue.id } : {}) });
await cal(col.rohan, { title: 'P-12 weekly progress', startAt: at(1, 10), endAt: at(1, 11), attendees: [priyaId, id('meera'), id('lalitha'), id('fatima')], online: true, recurrence: 'weekly' });
await cal(col.deepa, { title: 'Stress check: pump suction lines', startAt: at(1, 15), endAt: at(1, 15, 45), attendees: [priyaId, id('ravi')], online: true });
await cal(col.lalitha, { title: 'Title block rev 4: walk-through', startAt: at(3, 14, 30), endAt: at(3, 15, 30), attendees: [priyaId, id('manoj'), id('karthik')], online: false });
await cal(col.thomas, { title: 'Hydrotest, area 3 headers', startAt: at(2, 9), endAt: at(2, 10), attendees: [priyaId, id('imran'), id('ravi')], online: true, location: 'Jamnagar site' });
await cal(col.rohan, { title: 'P-14 kick-off', startAt: at(4, 11), endAt: at(4, 12), attendees: [priyaId, id('anand'), id('sneha')], online: true });

// Priya's own Desk: reminders, kept messages, a message waiting to send
await P.evaluate(async ({ ask, clash, p12, site, now }: any) => {
  await window.dex.request('remind.create', { text: 'Send the bolt lengths to Meera', messageId: ask, dueAt: now + 50 * 60_000 });
  await window.dex.request('remind.create', { text: 'Call the client about the area 5 hold', dueAt: now + 22 * 3600_000 });
  await window.dex.request('remind.create', { text: 'Check the revised pipe rack GA against the structural model', dueAt: now + 46 * 3600_000, repeat: 'none' });
  await window.dex.request('msg.star', { messageId: clash, on: true, kind: 'followup' });
  await window.dex.request('msg.star', { messageId: ask, on: true, kind: 'todo' });
  await window.dex.request('sched.create', { convId: site, body: 'Good morning. Test pack drawings for the area 3 headers are on the share, printed copies at the front office.', sendAt: now + 18 * 3600_000 });
  void p12;
}, { ask: ask.id, clash: clash.id, p12: p12.id, site: site.id, now: Date.now() });
await P.reload(); await P.locator('.frame').waitFor(); await sleep(2500);

// ================================================================== the walk
const dialogOf = (page: any) => page.locator('[role=dialog]').last();
const scrollToMsg = async (page: any, text: string) => {
  const m = page.locator('.timeline .msg', { hasText: text }).first();
  await m.evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'center' }));
  await sleep(500);
  return m;
};

await part('install', async () => {
  // a new PC: the welcome screen, then waiting for an administrator
  autoApprove = false;
  const k = await openApp('nisha', 'Nisha Varma', { join: false });
  await k.page.locator('.onboard').waitFor({ timeout: 20000 });
  await k.page.locator('.stack-v .field .link').first().click();
  await k.page.locator('.stack-v .field input.input:not(#display-name)').fill(`${LAN}:${hub.port}`);
  await sleep(800);
  await shot(k.page, 'welcome', { x: 440, y: 150, width: 560, height: 640 });
  await k.page.locator('.stack-v button[type="submit"]').click();
  await k.page.getByText('Waiting for an administrator').waitFor({ timeout: 20000 });
  await sleep(600);
  await shot(k.page, 'waiting', { x: 400, y: 220, width: 640, height: 500 });
  await closeApp(k);
  autoApprove = true;
});

await part('window', async () => {
  await lens(P, 'Pulse');
  await shot(P, 'window');
  await P.locator('.me-btn').click();
  await P.getByRole('menu', { name: 'You' }).waitFor();
  await sleep(300);
  await shot(P, 'tile-menu', { x: W - 330, y: 0, width: 330, height: H });
  await P.keyboard.press('Escape');
  await P.keyboard.press('Control+g');
  await sleep(300);
  await P.keyboard.type('pip');
  await sleep(600);
  await shot(P, 'goto', { x: 220, y: 0, width: 1000, height: 520 });
  await P.keyboard.press('Escape');
});

await part('pulse', async () => {
  await lens(P, 'Pulse');
  await P.locator('.view').first().evaluate((el: HTMLElement) => { el.scrollTop = 0; });
  await shot(P, 'pulse');
  await P.locator('.office-card').first().evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'end' }));
  await sleep(600);
  await shot(P, 'pulse-cards');
  await P.locator('.view').first().evaluate((el: HTMLElement) => { el.scrollTop = 0; });
});

await part('messages', async () => {
  await openConv(P, 'Spaces', 'P-12 Piping');
  await expandSwitchboard(P);
  await P.locator('.timeline .msg', { hasText: 'Transmittal' }).waitFor();
  await sleep(800);
  await shot(P, 'switchboard', { x: 8, y: 44, width: 304, height: 700 });
  await scrollToMsg(P, 'GA for area 3');
  await shot(P, 'space');
  // a message's tools on the spine: the Stamp flyout, then the More menu
  const m = await scrollToMsg(P, 'Stress for the pump suction lines');
  await m.hover({ position: { x: 300, y: 10 } }); await sleep(400);
  await m.getByTitle('Stamp', { exact: true }).click({ force: true });
  await sleep(600);
  const b = await m.boundingBox();
  await shot(P, 'stamps', { x: 312, y: Math.max(44, b.y - 40), width: 760, height: 260 });
  await P.keyboard.press('Escape');
  await sleep(300);
  await m.hover({ position: { x: 300, y: 10 } }); await sleep(400);
  await m.getByTitle('More', { exact: true }).click({ force: true });
  await sleep(600);
  await shot(P, 'msg-menu');
  await P.keyboard.press('Escape');
  // the side-track
  await scrollToMsg(P, 'Starting a side-track');
  await P.locator('.branch-tag').first().click();
  await P.locator('.side-track').waitFor();
  await sleep(800);
  await shot(P, 'sidetrack');
  await P.keyboard.press('Escape');
  // the poll
  const poll = await scrollToMsg(P, 'which day suits');
  await shot(P, 'poll', poll, 10);
  // the PDF viewer
  await scrollToMsg(P, 'GA for area 3');
  await P.locator('.pdf-chip', { hasText: 'P12-GA-0301' }).getByRole('button', { name: /View/ }).first().click();
  await sleep(4000);
  await shot(P, 'pdf-viewer');
  await P.keyboard.press('Escape');
  await sleep(400);
  // a Decision and a share-path card
  await openConv(P, 'Spaces', 'Document control');
  const dec = await scrollToMsg(P, 'Issue ISO-1001-01');
  await shot(P, 'decision', dec, 10);
  await openConv(P, 'Spaces', 'Drafting standards');
  const card = await scrollToMsg(P, 'layer template');
  await P.locator('.lcard').last().waitFor({ timeout: 10000 });
  await sleep(1200);
  const cb = await card.boundingBox();
  const lb = await P.locator('.lcard').last().boundingBox();
  await shot(P, 'linkcard', { x: cb.x - 10, y: cb.y - 8, width: Math.max(lb.width + 40, 640), height: lb.y + lb.height - cb.y + 18 });
});

await part('writing', async () => {
  await openConv(P, 'Spaces', 'Site team');
  const box = P.locator('.dock textarea').first();
  await box.fill('Test pack for the **area 3 headers**:\n- ISO-1001-01 to ISO-1001-09\n- P&ID sheet 4 with the test limits marked\n\nPrinted copies will be at the front office by 6 pm.');
  await sleep(700);
  await shot(P, 'composer', { x: 312, y: H - 330, width: W - 312, height: 330 });
  // the + menu in the Dock
  await P.locator('.dock').getByTitle('Insert').first().click();
  await sleep(400);
  await shot(P, 'dock-insert', { x: 312, y: H - 520, width: 700, height: 520 });
  await P.keyboard.press('Escape');
  // send later
  await P.getByRole('button', { name: 'More ways to send' }).click();
  await P.getByRole('menuitem', { name: /Send later/ }).click();
  await sleep(600);
  await shot(P, 'send-later', dialogOf(P), 16);
  await P.keyboard.press('Escape');
  await box.fill('');
  // a new Space
  await lens(P, 'Spaces');
  await P.getByTitle('New Space').first().click();
  await sleep(600);
  await shot(P, 'new-space', dialogOf(P), 16);
  await P.keyboard.press('Escape');
});

await part('direct', async () => {
  await openConv(P, 'Direct', 'Ravi Kumar');
  await sleep(900);
  await shot(P, 'direct');
  await P.locator('.pane-head').getByText('ENCRYPTED', { exact: false }).first().click().catch(async () => { await P.getByText('Encrypted', { exact: true }).first().click(); });
  await sleep(700);
  await shot(P, 'safety-code', dialogOf(P), 16);
  await P.keyboard.press('Escape');
});

await part('search', async () => {
  await lens(P, 'Pulse');
  await P.keyboard.press('Control+Shift+F');
  await sleep(600);
  await P.keyboard.type('isometrics');
  await P.keyboard.press('Enter');
  await sleep(1500);
  await shot(P, 'search', { x: W - 640, y: 0, width: 640, height: H });
  await P.keyboard.press('Escape');
});

await part('lounges', async () => {
  await openConv(P, 'Spaces', 'P-12 Piping');
  await expandSwitchboard(P);
  await P.locator('.lg-row', { hasText: 'Piping desk' }).getByRole('button', { name: 'Join' }).click();
  await sleep(3500);
  await shot(P, 'lounge');
  await P.getByRole('button', { name: 'Leave', exact: true }).first().click().catch(() => {});
  await sleep(800);
});

await part('desk', async () => {
  await lens(P, 'Desk');
  await P.getByRole('tab', { name: /^Reminders/ }).click();
  await sleep(600);
  await shot(P, 'desk-reminders', { x: 0, y: 0, width: W, height: 640 });
  await P.getByRole('tab', { name: /^Kept/ }).click();
  await sleep(600);
  await shot(P, 'desk-kept', { x: 0, y: 0, width: W, height: 560 });
  await P.getByRole('button', { name: 'New reminder' }).first().click();
  await sleep(600);
  await shot(P, 'new-reminder', dialogOf(P), 16);
  await P.keyboard.press('Escape');
});

await part('bots', async () => {
  await lens(P, 'Desk');
  await P.getByRole('tab', { name: 'Bots' }).click();
  await sleep(700);
  await P.getByRole('button', { name: 'Make a bot' }).first().click();
  await P.locator('.bm-start').waitFor({ timeout: 10000 });
  await P.locator('.bm-template', { hasText: 'Plot request' }).hover();
  await P.locator('.bm-preview .flow-card').first().waitFor({ timeout: 8000 });
  await sleep(600);
  await shot(P, 'bot-start');
  await P.getByRole('button', { name: 'Start from Plot request' }).click();
  await P.locator('.bm-steps').waitFor();
  await sleep(800);
  await shot(P, 'bot-maker');
  await P.getByRole('tab', { name: /Identity/ }).click();
  await P.getByLabel('Name', { exact: true }).fill('Plot desk');
  await P.getByRole('button', { name: 'Plotter' }).click().catch(() => {});
  await P.locator('.bm-tone', { hasText: 'Warm' }).click().catch(() => {});
  await sleep(600);
  await shot(P, 'bot-identity');
  await P.getByRole('button', { name: 'Close' }).first().click();
  await P.getByRole('button', { name: 'Leave' }).click().catch(() => {});
  await sleep(400);
});

await part('automations', async () => {
  await openConv(P, 'Spaces', 'Piping team');
  await P.getByRole('button', { name: 'More for this conversation' }).click();
  await P.getByRole('menuitem', { name: 'Automations…' }).click();
  const sheet = P.getByRole('dialog', { name: 'Automations' });
  await sheet.waitFor();
  await sheet.getByLabel('Describe a rule in your own words').fill('When someone attaches a PDF here, read its title block, then tell Fatima Begum and put a To do on her Desk.');
  await sheet.getByRole('button', { name: 'Draft the rule' }).click();
  await sheet.getByRole('button', { name: 'Approve and turn on' }).waitFor({ timeout: 60000 });
  await sleep(1000);
  await shot(P, 'automation');
  await sheet.getByRole('button', { name: 'Approve and turn on' }).click();
  await sleep(1000);
  await P.keyboard.press('Escape');
});

await part('help', async () => {
  await lens(P, 'Pulse');
  await P.locator('.me-btn').click();
  await P.getByRole('menuitem', { name: /Help me/ }).click();
  await sleep(600);
  const d = dialogOf(P);
  await d.getByPlaceholder(/plotter/).fill('PLOT-A0-2F does not show in my list of printers');
  await d.getByPlaceholder(/What you were doing/).fill('Since this morning. The A3 printer works. I need to plot the area 3 test pack today.').catch(() => {});
  await sleep(400);
  await shot(P, 'help-me', d, 16);
  await P.keyboard.press('Escape');
});

await part('calendar', async () => {
  await lens(P, 'Calendar');
  await P.getByRole('button', { name: 'Next week' }).click();
  await sleep(1200);
  await P.locator('.cal-block').first().waitFor();
  await P.locator('[aria-label="The week, hour by hour"]').evaluate((el: HTMLElement) => { el.scrollTop = el.scrollHeight * 0.05; }).catch(() => {});
  await sleep(400);
  await shot(P, 'calendar');
  await P.locator('.cal-block', { hasText: 'model review' }).first().click();
  await sleep(800);
  await shot(P, 'meeting-card', dialogOf(P), 16);
  await P.keyboard.press('Escape');
  await P.getByRole('button', { name: 'New meeting' }).click();
  await sleep(800);
  await shot(P, 'new-meeting', dialogOf(P), 16);
  await P.keyboard.press('Escape');
});

await part('meet', async () => {
  await lens(P, 'Meet');
  await P.locator('.view.meet .meet-number span').first().waitFor({ timeout: 15000 });
  await sleep(600);
  await shot(P, 'meet');
  await P.getByRole('button', { name: 'Plan a webinar' }).click();
  await sleep(800);
  await shot(P, 'webinar-plan', dialogOf(P), 16);
  await P.keyboard.press('Escape');
});

await part('room', async () => {
  // Ravi and Anand on their own PCs, with cameras
  const ravi = await openApp('ravi', 'Ravi Kumar', { video: camera('ravi', '#C9D6D8', '#2F4F6F') });
  const anand = await openApp('anand', 'Anand Pillai', { video: camera('anand', '#DCD3C4', '#5B3A29') });
  for (const a of [ravi, anand]) await a.page.locator('.lens-bar').waitFor();
  await P.reload(); await P.locator('.frame').waitFor(); await sleep(1500);
  await lens(P, 'Meet');
  await P.getByLabel('Meeting title').fill('P-12 pipe rack clash review');
  for (const who of ['ravi', 'anand']) {
    await P.getByLabel('Ring people in').fill(who);
    await P.locator('.meet-suggest button').first().click();
  }
  await P.getByLabel('Start with my camera on').check();
  await P.getByRole('button', { name: 'Start meeting' }).click();
  await P.getByRole('button', { name: 'Leave Room' }).waitFor({ timeout: 20000 });
  for (const a of [ravi, anand]) {
    const banner = a.page.locator('.room-banner');
    await banner.waitFor({ timeout: 20000 });
    await banner.getByRole('button', { name: 'Join with video' }).click();
  }
  await sleep(6000);
  await shot(P, 'room');
  await P.getByRole('button', { name: /Breakout rooms/ }).click().catch(() => {});
  await sleep(800);
  if (await P.getByRole('dialog', { name: 'Breakout rooms' }).count()) { await shot(P, 'breakouts', dialogOf(P), 16); await P.keyboard.press('Escape'); }
  await P.getByRole('button', { name: 'Leave Room' }).click().catch(() => {});
  await sleep(500);
  await P.getByRole('button', { name: /End for everyone|Leave/ }).first().click().catch(() => {});
  await closeApp(ravi); await closeApp(anand);
});

await part('directory', async () => {
  await lens(P, 'Directory');
  await P.getByRole('tab', { name: 'People', exact: true }).click();
  await sleep(600);
  await shot(P, 'directory');
  await P.locator('.card.person', { hasText: 'Deepa Krishnan' }).click();
  await P.locator('.profile-panel').waitFor();
  await sleep(600);
  await shot(P, 'profile');
  await P.locator('.profile-panel').getByRole('button', { name: 'Close profile' }).click();
  await P.getByRole('tab', { name: 'Org chart' }).click();
  await P.locator('.os-stage').waitFor();
  await sleep(3500);
  await P.getByRole('button', { name: 'Show the whole sheet' }).click();
  await sleep(1200);
  await shot(P, 'org-lines');
  await P.locator('.os-find-input').fill('Farhan');
  await P.keyboard.press('Enter');
  await P.locator('.os-callout', { hasText: 'Farhan Qureshi' }).waitFor();
  await sleep(800);
  await shot(P, 'org-callout');
  await P.locator('.os-callout').getByRole('button', { name: 'How we connect' }).click();
  await sleep(1800);
  await P.locator('.os-callout').getByRole('button', { name: 'Close' }).click().catch(() => {});
  await sleep(600);
  await shot(P, 'org-route');
  await theme(P, 'dark'); await sleep(500);
  await shot(P, 'org-dark');
  await theme(P, 'light');
  await P.getByRole('button', { name: 'Clear the route' }).click().catch(() => {});
  await P.locator('.os-find-input').fill('');
  await P.getByRole('button', { name: 'Floor', exact: true }).click();
  await sleep(1500);
  await P.getByRole('button', { name: 'Show the whole sheet' }).click();
  await sleep(800);
  await P.getByRole('button', { name: 'Zoom in' }).click();
  await sleep(1200);
  await shot(P, 'org-floor');
  await P.getByRole('button', { name: 'Lines', exact: true }).click();
  await P.locator('.os-tools').getByRole('button', { name: 'Spaces', exact: true }).click();
  await P.locator('.os-menu-item', { hasText: 'P-14 Structural steel' }).click();
  await P.getByRole('button', { name: 'Show the whole sheet' }).click();
  await sleep(1500);
  await shot(P, 'org-spaces');
  await P.getByRole('tab', { name: 'People', exact: true }).click();
});

await part('prefs', async () => {
  await lens(P, 'Pulse');
  await P.keyboard.press('Control+,');
  await P.getByRole('heading', { name: 'Your devices' }).waitFor();
  await sleep(600);
  const sheet = { x: W - 628, y: 0, width: 628, height: H };
  await shot(P, 'prefs', sheet);
  for (const [h, fig] of [['Appearance', 'prefs-appearance'], ['Notifications', 'prefs-notifications'], ['Your devices', 'prefs-devices'], ['Outside the office', 'prefs-outside']] as const) {
    await P.getByRole('heading', { name: h, exact: true }).evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'start' }));
    await sleep(400);
    await shot(P, fig, sheet);
  }
  await P.getByRole('heading', { name: 'Your devices', exact: true }).evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'start' }));
  await P.getByRole('button', { name: 'Add my phone' }).click();
  await sleep(1000);
  await shot(P, 'pair-phone', dialogOf(P), 16);
  await P.keyboard.press('Escape');
  await sleep(300);
  if (!(await P.getByRole('heading', { name: 'Your devices' }).isVisible().catch(() => false))) await P.keyboard.press('Control+,');
  await P.getByRole('heading', { name: 'Your devices', exact: true }).evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'start' }));
  await P.getByRole('button', { name: 'Add my laptop' }).click();
  await sleep(1000);
  await shot(P, 'pair-laptop', dialogOf(P), 16);
  await P.keyboard.press('Escape');
  // Hindi, then back to English
  await P.keyboard.press('Escape'); await sleep(300);
  if (!(await P.getByRole('heading', { name: 'Appearance' }).isVisible().catch(() => false))) await P.keyboard.press('Control+,');
  await sleep(500);
  await P.getByRole('heading', { name: 'Appearance', exact: true }).evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'start' }));
  await P.getByLabel('Language').selectOption('hi');
  await sleep(1500);
  await P.keyboard.press('Escape');
  await sleep(800);
  await shot(P, 'hindi');
  await P.keyboard.press('Control+,');
  await sleep(800);
  await P.locator('select.lang-pick').selectOption('en');
  await sleep(1500);
  await P.keyboard.press('Escape');
});

await part('dark', async () => {
  await openConv(P, 'Spaces', 'P-12 Piping');
  await scrollToMsg(P, 'GA for area 3');
  await theme(P, 'dark');
  await sleep(700);
  await shot(P, 'dark');
  await theme(P, 'light');
});

// ------------------------------------------------------------------ Priya's phone (the same app at phone width)
await part('phone', async () => {
  const ph = await openApp('priya', 'Priya Raman', { width: 390, height: 844 });
  const F = ph.page;
  await sleep(2500);
  await shot(F, 'phone-pulse');
  await F.locator('.lens-dock').getByRole('button', { name: /Switchboard/ }).click();
  await sleep(800);
  await shot(F, 'phone-switchboard');
  await F.locator('.sb-row', { hasText: 'P-12 Piping' }).first().click();
  await sleep(1500);
  await shot(F, 'phone-space');
  await theme(F, 'dark');
  await sleep(500);
  await shot(F, 'phone-space-dark');
  await theme(F, 'light');
  await F.locator('.lens-dock').getByRole('button', { name: /Switchboard/ }).click();
  await F.locator('.lens-dock').getByRole('button', { name: /Calendar/ }).click();
  await sleep(1000);
  await shot(F, 'phone-calendar');
  await F.locator('.me-btn').click();
  await sleep(500);
  await shot(F, 'phone-menu');
  await closeApp(ph);
});

// ------------------------------------------------------------------ the owner's Control room
await part('admin', async () => {
  // a joiner waiting, so Approvals has someone to show
  // (Nisha, who joined in the "install" part, is still waiting)
  autoApprove = true;
  const v = await openApp('vikram', 'Vikram Shah');
  autoApprove = false;
  const V = v.page;
  await sleep(1500);
  await V.locator('.me-btn').click();
  await V.getByRole('menuitem', { name: /Control room/ }).click();
  await V.getByRole('group', { name: 'Admin section' }).waitFor();
  const sec = async (name: string, fig: string, wait = 1200) => {
    await V.getByRole('group', { name: 'Admin section' }).getByRole('button', { name: new RegExp(`^${name.replace(/[&]/g, '.')}`) }).click();
    await sleep(wait);
    await shot(V, fig, { x: W - 988, y: 0, width: 988, height: H });
  };
  await V.getByRole('group', { name: 'Admin section' }).getByRole('button', { name: /^Approvals/ }).click();
  await sleep(1200);
  await shot(V, 'cr-approvals', { x: W - 988, y: 0, width: 988, height: 420 });
  await sec('Devices', 'cr-devices');
  await sec('People & roles', 'cr-roles');
  await sec('Organisation', 'cr-organisation');
  await sec('Guests', 'cr-guests');
  await sec('Compliance', 'cr-compliance');
  await sec('Policies', 'cr-policies');
  await sec('Outside the office', 'cr-remote');
  await sec('Usage', 'cr-usage');
  await sec('Integrations', 'cr-integrations');
  await sec('Automations', 'cr-automations');
  await sec('Bots & tools', 'cr-bots');
  await sec('Backups & leavers', 'cr-backups');
  await sec('Audit log', 'cr-audit');
});

console.log(failed.length ? `FAILED PARTS: ${failed.join(', ')}` : 'GUIDE SHOTS DONE');
for (const a of [...apps]) await closeApp(a);
for (const c of Object.values(col)) c.c.disconnect();
owner.disconnect();
await hub.stop();
setTimeout(() => process.exit(failed.length ? 1 : 0), 300);
