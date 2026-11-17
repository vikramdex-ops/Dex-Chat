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
async function openApp(username: string, displayName: string, opts: { width?: number; height?: number; join?: boolean; video?: string; env?: Record<string, string> } = {}): Promise<App> {
  const userData = fs.mkdtempSync(path.join(OUT, `ud-guide-${username}-`));
  const app = await pw._electron.launch({
    executablePath: ELECTRON,
    args: [path.join(ROOT, 'apps/desktop'), `--user-data-dir=${userData}`, '--no-sandbox', '--force-device-scale-factor=1',
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', ...(opts.video ? [`--use-file-for-fake-video-capture=${opts.video}`] : [])],
    env: { ...process.env, USERDOMAIN: 'DEX', DEXCONNECT_DEV_ACCOUNT: `${username}|${displayName}`, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ...opts.env },
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
    let b = await clip.boundingBox();
    // off screen (a sheet still settling): bring it into view first
    if (!b || b.y >= page.viewportSize().height - 10 || b.y + b.height <= 10) { await clip.scrollIntoViewIfNeeded().catch(() => {}); await sleep(400); b = await clip.boundingBox(); }
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
// the office's seats on the real floor plan (Directory ▸ Org chart ▸ Floor), by department
const SEATS: Array<[string, string]> = [
  ['W-A01', 'lalitha'], ['W-A02', 'manoj'], ['W-A03', 'asha'], ['W-A04', 'prakash'], ['W-A05', 'selvi'], ['W-A06', 'kiran'],
  ['W-A11', 'priya'], ['W-A12', 'ravi'], ['W-A13', 'karthik'], ['W-A14', 'deepa'], ['W-A15', 'rahul'], ['W-A16', 'lakshmi'], ['W-A17', 'imran'], ['W-A18', 'thomas'],
  ['W-A21', 'anita'], ['W-A22', 'sanjay'], ['W-A23', 'kavya'],
  ['POD1-1', 'suresh'], ['POD1-2', 'nikhil'], ['POD1-3', 'divya'], ['POD2-1', 'ramesh'], ['POD2-2', 'harini'], ['POD2-3', 'gopal'],
  ['W-C07', 'anand'], ['W-C08', 'sneha'], ['W-C09', 'vivek'], ['W-C10', 'pooja'], ['W-C11', 'farhan'],
  ['W-B01', 'rohan'], ['W-B02', 'neha'], ['W-B03', 'aditya'], ['W-B11', 'fatima'], ['W-B12', 'joseph'], ['W-B13', 'ganesh'],
  ['HC-03', 'sunil'], ['REC-01', 'bhavna'], ['HC-06', 'revathi'], ['MD-01', 'vikram'], ['MD-02', 'meera'], ['HC-09', 'arjun'],
];
const seatPlan = await owner.request('seating.draft' as never, { title: 'The office as it is', moves: SEATS.map(([seatId, u]) => ({ seatId, to: { kind: 'person', userId: u === 'priya' ? priyaId : id(u) } })) } as never) as any;
await owner.request('seating.apply' as never, { id: seatPlan.id } as never);
// Priya has read her seat notice already (the seating part shows a new one)
await P.evaluate((planId: string) => window.dex.request('seating.seen', { planId }), seatPlan.id).catch((e: Error) => console.log('seat seen', e.message));
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
  // the floor: the office's real plan, framed as it opens; then the walk to Anand's desk
  await P.getByRole('button', { name: 'Floor', exact: true }).click();
  await sleep(2600);
  if (await P.locator('.seat-notice').count()) { await P.locator('.seat-notice').getByRole('button', { name: 'Got it' }).click().catch(() => {}); await sleep(500); }
  await shot(P, 'org-floor');
  await P.locator('.os-find-input').fill('Anand');
  await P.keyboard.press('Enter');
  await P.locator('.os-callout', { hasText: 'Anand Pillai' }).waitFor();
  await P.locator('.os-callout').getByRole('button', { name: 'Walk there' }).click();
  await P.locator('.os-route', { hasText: 'round the desks' }).waitFor();
  await P.locator('.os-callout').getByRole('button', { name: 'Close' }).click().catch(() => {});
  await sleep(600);
  await P.getByRole('button', { name: 'Clear the route' }).click().catch(() => {});
  await P.locator('.os-find-input').fill('');
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

// ================================================================== revision 1: Nib, office bots, share paths, meeting links
// GUIDE_ONLY=nib,tracked,paths,meetlinks walks only these. They come last, so a full run's earlier
// figures are taken before Nib is set up. Nib's clock is the in-process hub's (hub.nib.setClock).
const dayStr = (n: number) => { const d = new Date(Date.now() + n * 86400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
/** An app for someone, reusing one a part before opened. */
async function appOf(username: string, displayName: string): Promise<App> {
  const open = apps.find((a) => a.name === username && a.page !== P);
  if (open) return open;
  autoApprove = true;
  const a = await openApp(username, displayName);
  await sleep(1500);
  return a;
}
/** Close the toasts, so they do not cover a figure. */
const noToasts = async (page: any) => { for (let i = 0; i < 20 && await page.locator('.toast').count(); i++) { await page.locator('.toast button').first().click({ timeout: 1000 }).catch(() => {}); await sleep(150); } };
/** A box around `el`, cut to what `within` shows (a card taller than its pane). */
const boxIn = async (el: any, within: any, pad = 10) => { const a = await el.boundingBox(); const b = await within.boundingBox(); const y0 = Math.max(a.y, b.y) - pad; const y1 = Math.min(a.y + a.height, b.y + b.height) + pad; return { x: a.x - pad, y: y0, width: a.width + 2 * pad, height: y1 - y0 }; };
const scrollEnd = async (page: any) => { await page.evaluate(() => document.querySelectorAll('.timeline').forEach((t) => { t.scrollTop = t.scrollHeight; })); await sleep(400); };

await part('nib', async () => {
  autoApprove = true;
  const user = (u: string) => (hub as any).store.userById(u === 'priya' ? priyaId : id(u));
  const nibClock = (h: number, m = 0) => { const at = today(h, m); (hub as any).nib.setClock(at); (hub as any).nib.tick(at); return at; };
  nibClock(9, 0);
  // the office's set-up, as an administrator makes it in Control room ▸ Nib & day sheets
  const cfg = await owner.request('admin.nib.get' as never) as any;
  const heads: Array<[string, string]> = [['priya', 'Piping'], ['anand', 'Structural'], ['anita', 'Civil'], ['suresh', 'Mechanical'], ['ramesh', 'E&I'], ['lalitha', 'Drafting']];
  const nibCfg = {
    ...cfg,
    givers: [{ userId: id('meera'), kind: 'area', scope: 'Area 3 and 4' }, ...heads.map(([u, scope]) => ({ userId: u === 'priya' ? priyaId : id(u), kind: 'discipline', scope })), { userId: id('rohan'), kind: 'team', scope: 'Projects' }],
    managers: [id('vikram'), id('meera'), id('arjun')],
    projects: [{ code: 'P-12', name: 'Hydrotreater revamp, Jamnagar' }, { code: 'P-14', name: 'Pipe rack and platforms' }, { code: 'J-0412', name: 'Pump house upgrade' }],
    workdays: [1, 2, 3, 4, 5, 6],
    // the walk below is timed to these (a new hub's defaults are now register 18:30, follow-up 19:00)
    digestAt: '19:00', followUpAt: '21:00',
  };
  await owner.request('admin.nib.set' as never, nibCfg as never);
  const V = (await appOf('vikram', 'Vikram Shah')).page;
  await V.locator('.me-btn').click();
  await V.getByRole('menuitem', { name: /Control room/ }).click();
  await V.getByRole('group', { name: 'Admin section' }).getByRole('button', { name: /^Nib & day sheets/ }).click();
  await V.locator('.nib-admin').waitFor();
  await sleep(1200);
  await shot(V, 'cr-nib', { x: W - 988, y: 0, width: 988, height: H });
  await V.keyboard.press('Escape');
  // the walk runs on whatever day it is: today is a workday for it
  await owner.request('admin.nib.set' as never, { ...nibCfg, workdays: [...new Set([...nibCfg.workdays, new Date().getDay()])] } as never);

  // Priya starts her day: Nib asks who gave her work
  await P.reload(); await P.locator('.frame').waitFor(); await sleep(1500);
  await lens(P, 'Pulse');
  nibClock(9, 40);
  await P.locator('.me-btn').click();
  await P.getByRole('menuitem', { name: /Start my day/ }).click();
  await P.locator('.nib-callout').waitFor({ timeout: 10000 });
  await sleep(600);
  await shot(P, 'nib-start', { x: W - 520, y: 0, width: 520, height: 420 });
  await P.locator('.nib-callout .nib-giver', { hasText: 'Meera' }).click();
  await P.locator('.nib-callout .nib-giver', { hasText: 'Anand' }).click();
  await P.locator('.nib-callout').getByRole('button', { name: 'Log these' }).click();
  await sleep(800);
  // two items already on her sheet, one with numbers and one in words
  await P.evaluate(async ({ anand, meera }: any) => {
    await window.dex.request('nib.item.save', { giverId: anand, project: 'P-14', activity: 'Support check, pipe rack PR-03', qty: { done: 6, total: 14, unit: 'supports' }, status: 'going' } as never);
    await window.dex.request('nib.item.save', { giverId: meera, project: 'P-12', activity: 'Bolt lengths for the 300# flanges', note: 'Waiting for the new gasket thickness from the vendor', status: 'blocked' } as never);
  }, { anand: id('anand'), meera: id('meera') });
  nibClock(11, 20);
  await P.reload(); await P.locator('.frame').waitFor(); await sleep(1500);
  await P.locator('.nib-btn').click();
  await P.locator('.nib-tray').waitFor();
  await P.locator('.nib-input').fill('got 12 isos from Meera for P-12 area 4 by Friday');
  await P.locator('.nib-ann.giver').waitFor();
  await P.locator('.nib-tray .nib-item').nth(1).waitFor();
  await noToasts(P);
  await sleep(700);
  await shot(P, 'nib-tray', P.locator('.nib-tray'), 10);
  await P.locator('.nib-input').press('Enter');
  await sleep(1200);
  await P.keyboard.press('Escape');

  // the rest of the office through the hub, as they would through their apps
  const kiran = await colleague('kiran', 'Kiran Desai');
  await kiran.c.request('nib.me' as never);
  for (const [u, kind, cover, lead] of [['sneha', 'sick', 'vivek', 'anand'], ['gopal', 'half', 'harini', 'ramesh'], ['joseph', 'annual', 'fatima', 'arjun']] as const) {
    (hub as any).nib.handle('nib.leave', user(u), { kind, from: dayStr(0), to: dayStr(0), half: kind === 'half' ? 'pm' : null, coverId: id(cover), leadIds: [id(lead)], reminders: 'move', handover: 'Spool drawings 4 to 9 left on P-12; vendor data due Friday.' });
  }
  const UNITS = ['isos', 'sheets', 'drawings', 'GAs', 'MTOs', 'supports'];
  const piping: Array<[string, string, string, number, number, string]> = [
    ['ravi', 'P-12', 'ISO checking, area 3', 14, 18, 'isos'], ['karthik', 'P-12', 'ISO routing, area 4', 9, 12, 'isos'], ['rahul', 'P-12', 'Line list update', 40, 60, 'lines'],
    ['lakshmi', 'P-14', 'Pipe rack GA mark-ups', 3, 5, 'GAs'], ['imran', 'P-12', 'Site queries answered', 0, 0, ''], ['thomas', 'P-12', 'Hydrotest pack, area 3', 6, 9, 'drawings'],
  ];
  // who gives each person work: their department's lead (the leads themselves get theirs from Meera)
  const DEPT_LEAD: Record<string, string> = { Piping: 'priya', Structural: 'anand', Civil: 'anita', Mechanical: 'suresh', 'Electrical & Instrumentation': 'ramesh', Drafting: 'lalitha', Projects: 'rohan', 'Document Control': 'arjun', 'IT & Admin': 'vikram', 'HR & Accounts': 'vikram' };
  const giverOf = (u: string) => { const g = DEPT_LEAD[OFFICE.find((p) => p.u === u)?.dept ?? ''] ?? 'meera'; return g === u ? (u === 'rohan' ? 'arjun' : 'meera') : g; };
  nibClock(17, 5);
  let n = 0;
  for (const p of OFFICE) {
    const u = p.u;
    if (['vikram', 'meera', 'arjun', 'priya', 'kiran', 'deepa', 'sneha', 'gopal', 'joseph', 'asha'].includes(u)) continue;
    const pu = user(u);
    if (!pu) continue;
    try { (hub as any).work.handle('work.checkIn', pu, { mode: n % 6 === 0 ? 'site' : n % 7 === 0 ? 'home' : 'office' }); } catch { /* already in */ }
    if (u === 'neha') { (hub as any).nib.handle('nib.day', pu, { nothing: true }); n++; continue; }
    const pip = piping.find((x) => x[0] === u);
    const g = pip ? 'priya' : giverOf(u);
    const gid = g === 'priya' ? priyaId : id(g);
    (hub as any).nib.handle('nib.start', pu, { givers: [gid] });
    if (pip) {
      (hub as any).nib.handle('nib.item.save', pu, { giverId: gid, project: pip[1], activity: pip[2], ...(pip[4] ? { qty: { done: pip[3], total: pip[4], unit: pip[5] } } : { note: 'Three RFIs closed with the client' }) });
      if (u === 'karthik') (hub as any).nib.handle('nib.item.save', pu, { giverId: gid, project: 'J-0412', activity: 'MTO check', note: 'Waiting for the vendor’s pump nozzle data', status: 'blocked' });
    } else {
      const total = 6 + (n * 7) % 24;
      (hub as any).nib.handle('nib.item.save', pu, { giverId: gid, project: ['P-12', 'P-14', 'J-0412'][n % 3], activity: ['Model review', 'Checking', 'Detailing', 'MTO take-off', 'Mark-ups', 'Routing'][n % 6], qty: { done: Math.round(total * ((n * 37) % 100) / 100), total, unit: UNITS[n % 6] } });
      if (n % 5 === 1) (hub as any).nib.handle('nib.item.save', pu, { giverId: gid, project: 'P-14', activity: 'Clash review', note: 'Waiting for the civil foundation drawing', status: 'blocked' });
    }
    (hub as any).nib.handle('nib.wrap', pu, n % 6 === 3 ? { blockers: 'Waiting for the civil foundation drawing' } : {});
    n++;
  }
  try { (hub as any).work.handle('work.checkIn', user('deepa'), { mode: 'office' }); } catch { /* already in */ }
  (hub as any).nib.handle('nib.start', user('deepa'), { givers: [priyaId] });

  // Priya wraps up: the sheet pre-filled, sent to the two who gave her work
  nibClock(17, 40);
  await P.locator('.nib-btn').click();
  await P.locator('.nib-tray').waitFor();
  await P.getByRole('button', { name: 'Wrap up and send' }).click();
  await P.locator('.nib-wrapup').waitFor();
  await noToasts(P);
  await sleep(600);
  await shot(P, 'nib-wrap', P.locator('.nib-tray'), 10);
  await P.getByRole('textbox', { name: 'Blockers' }).fill('Gasket thickness from the vendor');
  console.log('  wrap-up width', await P.locator('.nib-tray-body').evaluate((el: HTMLElement) => `${el.scrollWidth} in ${el.clientWidth}, scrolled ${el.scrollLeft}`));
  await P.locator('.nib-wrapup .btn.primary', { hasText: /^Send to / }).click();
  await sleep(1000);
  await P.keyboard.press('Escape');

  // the wrap-up time passes: Nib asks Kiran three times; the register goes to the management at 19:00
  for (const [h, m] of [[18, 0], [18, 26], [18, 46], [19, 0], [19, 5]]) { nibClock(h, m); await sleep(300); }
  // Deepa sends after the register: Priya's card marks her LATE, and one follow-up goes at 21:00
  nibClock(20, 15);
  (hub as any).nib.handle('nib.item.save', user('deepa'), { giverId: priyaId, project: 'P-12', activity: 'Stress check, 8"-P-1014', qty: { done: 60, total: 100, unit: '%' } });
  (hub as any).nib.handle('nib.wrap', user('deepa'), {});

  // Priya's lead card: one card for everyone who sent work from her
  await lens(P, 'Direct');
  await P.locator('.sb-nib').click();
  const lead = P.locator('.nib-card.k-lead').last();
  await lead.waitFor({ timeout: 15000 });
  await lead.locator('.nib-row', { hasText: 'Ravi' }).getByRole('button', { name: 'Seen' }).click();
  await lead.locator('.nib-row', { hasText: 'Ravi' }).locator('.nib-seen').waitFor();
  await lead.evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'start' }));
  await noToasts(P);
  await sleep(700);
  await shot(P, 'nib-lead', await boxIn(lead, P.locator('.timeline').first()));

  // the leave note, as Priya fills it in for tomorrow (and does not send)
  await P.locator('.nib-btn').click();
  await P.locator('.nib-tray').waitFor();
  await P.locator('.nib-skill', { hasText: 'Going on leave' }).click();
  await P.locator('.nib-leave').waitFor();
  await P.locator('.nib-leave .seg[aria-label="When"] button', { hasText: 'Tomorrow' }).click();
  const cover = P.getByRole('combobox', { name: 'Who covers your work' });
  await cover.fill('Ravi'); await cover.press('Enter');
  await P.getByRole('textbox', { name: 'Handover note' }).fill('Area 4 isos: 3 left, waiting for the vendor nozzle loads. Bolt lengths for the 300# flanges once the gasket data comes.');
  await noToasts(P);
  await sleep(800);
  await P.locator('.nib-tray-body').evaluate((el: HTMLElement) => { el.scrollTop = 0; });
  await shot(P, 'nib-leave', P.locator('.nib-tray'), 10);
  await P.locator('.nib-leave').getByRole('button', { name: 'Not now' }).click();
  await P.keyboard.press('Escape');

  // the management's register, as Vikram reads it
  await V.reload(); await V.locator('.frame').waitFor(); await sleep(1500);
  await lens(V, 'Direct');
  await V.locator('.sb-nib').click();
  const reg = V.locator('.nib-card.k-register').last();
  await reg.waitFor({ timeout: 15000 });
  await reg.evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'start' }));
  await noToasts(V);
  await sleep(1000);
  await shot(V, 'nib-register', reg, 10);
  await reg.locator('.nib-cell.s-blocked').first().click();
  await V.locator('.nib-person-panel .nib-lines li').first().waitFor();
  await reg.locator('.nib-head-cells').evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'start' }));
  await reg.locator('[role="tab"]', { hasText: 'Leave and missing' }).click();
  await V.locator('.nib-person-panel').evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'center' }));
  await sleep(700);
  const pb = await V.locator('.nib-person-panel').boundingBox();
  const rb = await reg.boundingBox();
  const top = Math.max(44, pb.y - 120);
  await shot(V, 'nib-register-person', { x: rb.x - 10, y: top, width: rb.width + 20, height: Math.min(H - top, rb.y + rb.height + 10 - top) });
  kiran.c.disconnect();
  (hub as any).nib.setClock(null);
});

await part('tracked', async () => {
  // Priya makes "Drawing check and issue" from its template and names document control
  await lens(P, 'Desk');
  await P.getByRole('tab', { name: 'Bots' }).click();
  await sleep(700);
  await P.getByRole('button', { name: 'Make a bot' }).first().click();
  await P.locator('.bm-start').waitFor({ timeout: 10000 });
  await P.getByRole('button', { name: 'Start from Drawing check and issue' }).click();
  await P.locator('.bm-steps').waitFor();
  await P.getByRole('tab', { name: /Afterwards/ }).click();
  await P.locator('.bm-stages').waitFor();
  await P.getByLabel('Who is Document control').selectOption({ label: 'Fatima Begum' });
  await P.locator('#bm-stage-check .bm-step-head').click();
  await P.locator('#bm-stage-check-edit').waitFor();
  await sleep(800);
  await shot(P, 'bot-afterwards');
  await P.getByRole('tab', { name: /Sharing/ }).click();
  await P.getByRole('radio', { name: /A Space/ }).click();
  await P.getByLabel('Which Space').selectOption({ label: 'Piping team' });
  await P.getByRole('button', { name: 'Save bot' }).click();
  await P.locator('.toast', { hasText: 'shared with Piping team' }).waitFor({ timeout: 10000 });
  await P.getByRole('button', { name: 'Close' }).first().click();
  await sleep(600);
  const flow = (await P.evaluate(() => window.dex.request('botflow.mine'))).find((b: any) => b.title === 'Drawing check and issue').name as string;
  // two requests: isometrics checked by Ravi, a GA checked by Deepa
  const send = (answers: Array<[string, string]>) => P.evaluate(async ({ flow, answers }: any) => {
    const r = await window.dex.request('botflow.start', { flow });
    for (const [stepId, value] of answers) { await new Promise((ok) => setTimeout(ok, 250)); await window.dex.request('botflow.answer', { sessionId: r.sessionId, stepId, value }); }
    return r.convId as string;
  }, { flow, answers });
  const convId = await send([['job', 'P-12513'], ['drawings', 'ISO-1001-01\nISO-1001-02'], ['rev', 'C'], ['purpose', 'IFC'], ['checker', id('ravi')], ['print', ''], ['due', dayStr(3)], ['ok', 'yes']]);
  await sleep(800);
  await send([['job', 'P-12513'], ['drawings', 'P12-GA-0301'], ['rev', 'D'], ['purpose', 'IFA'], ['checker', id('deepa')], ['print', ''], ['due', dayStr(5)], ['ok', 'yes']]);
  await sleep(800);
  const rows = async () => (await P.evaluate((f: string) => window.dex.request('botflow.register', { flow: f }), flow)).register.rows as any[];
  const dc1 = (await rows()).find((r) => / rev C /.test(` ${r.title} `)).itemId as string;
  const act = (c: Col, action: string, note = '') => c.c.request('botflow.act' as never, { itemId: dc1, action, note } as never);
  const tickAll = async (c: Col) => { for (let i = 0; i < 4; i++) { await c.c.request('botflow.tick' as never, { itemId: dc1, index: i, on: true } as never); } };
  // Ravi returns it with comments; Priya corrects it; Ravi back-checks it (round 2)
  await act(col.ravi, 'comments', 'Tag 101-P-02 is missing on ISO-1001-02, and the BOM still shows rev B.');
  await sleep(500);
  await P.evaluate((i: string) => window.dex.request('botflow.act', { itemId: i, action: 'done', note: 'Tag added; BOM at rev C.' }), dc1);
  await sleep(500);
  await tickAll(col.ravi);
  await act(col.ravi, 'pass');
  await sleep(800);
  // Priya's card follows it: in her conversation with the bot
  await lens(P, 'Direct');
  await P.locator('.sb-row', { hasText: 'Drawing check and issue' }).first().click();
  const live = P.locator('.flow-card.track:not(.moved)', { hasText: 'rev C' }).last();
  await live.locator('.trk-cell.here', { hasText: 'Approve' }).waitFor({ timeout: 10000 });
  await scrollEnd(P);
  await live.evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'center' }));
  await sleep(600);
  await shot(P, 'bot-track', live, 10);
  await shot(P, 'bot-head', P.locator('.pane-head').first(), 0);
  // Meera approves; Fatima issues it and records the client's receipt
  await act(col.meera, 'ok');
  await act(col.fatima, 'issued', 'DDSP-P12-TR-0143');
  await act(col.fatima, 'ack', 'Client receipt CR-0877');
  await sleep(800);
  // the register, on asking
  const dock = P.locator('.dock textarea').first();
  await dock.fill('register');
  await dock.press('Enter');
  const reg = P.locator('.flow-card.register').last();
  await reg.locator('.reg-ref').first().waitFor({ timeout: 10000 });
  await scrollEnd(P);
  await reg.evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'center' }));
  await sleep(600);
  await shot(P, 'bot-register', reg, 10);
  void convId;
});

await part('paths', async () => {
  // Priya's laptop maps \\nas01\Project as X: and \\nas01\Standards as S: (the TEST-ONLY drive hook
  // of development builds: nothing touches a real share or Explorer)
  autoApprove = true;
  const lap = await openApp('priya', 'Priya Raman', { env: { DEXCONNECT_TEST_DRIVES: JSON.stringify({ drives: [{ letter: 'X:', root: '\\\\nas01\\Project' }, { letter: 'S:', root: '\\\\nas01\\Standards' }] }) } });
  const L = lap.page;
  await sleep(2500);
  const m = await say(col.ravi, p12.id, 'Revised isometrics for area 3 are in \\\\nas01\\Project\\P12513\\Iso and the stress report is \\\\nas01\\Project\\P12513\\Stress\\SR-P12-007.pdf');
  void m;
  await openConv(L, 'Spaces', 'P-12 Piping');
  await expandSwitchboard(L);
  const msg = L.locator('.timeline .msg', { hasText: 'Revised isometrics for area 3' }).last();
  await msg.locator('.lcard.k-path').waitFor({ timeout: 15000 });
  await msg.evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'center' }));
  await sleep(1500);
  await shot(L, 'sharepath', msg, 10);
  await L.keyboard.press('Control+,');
  const sec = L.locator('section.net-drives');
  await sec.waitFor({ timeout: 10000 });
  await sec.evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'start' }));
  await sleep(800);
  await shot(L, 'prefs-drives', sec, 12);
  await L.keyboard.press('Escape');
  await closeApp(lap);
});

await part('meetlinks', async () => {
  // the office's meeting site, as an administrator sets it in Control room ▸ Outside the office
  // (the gateway's address is a placeholder that never resolves: nothing leaves this PC)
  await owner.request('admin.remote.set' as never, { url: 'https://dexconnect-gateway.example.invalid', enabled: true, siteUrl: 'https://dexterity-meet.pages.dev', orgName: 'Dexterity Design Services' } as never);
  const V = (await appOf('vikram', 'Vikram Shah')).page;
  await V.reload(); await V.locator('.frame').waitFor(); await sleep(1500);
  await V.locator('.me-btn').click();
  await V.getByRole('menuitem', { name: /Control room/ }).click();
  await V.getByRole('group', { name: 'Admin section' }).getByRole('button', { name: /^Outside the office/ }).click();
  const card = V.locator('.meet-site-card');
  await card.waitFor({ timeout: 10000 });
  await card.evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'center' }));
  await sleep(800);
  await shot(V, 'cr-meetsite', card, 10);
  await V.keyboard.press('Escape');
  // Priya plans the P-12 design review with the client, with a page of its own
  await P.reload(); await P.locator('.frame').waitFor(); await sleep(1500);
  await lens(P, 'Calendar');
  await P.getByRole('button', { name: 'New meeting' }).click();
  await P.getByLabel('Title', { exact: true }).fill('P-12 design review');
  const start = new Date(); start.setDate(start.getDate() + 3); start.setHours(15, 0, 0, 0);
  const local = (t: number) => new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  await P.getByLabel('Starts').fill(local(start.getTime()));
  await P.getByPlaceholder('Invite people').fill('Rohan');
  await P.locator('.ev-suggest button', { hasText: 'Rohan Kapoor' }).click();
  await P.locator('.toggle-row', { hasText: 'Guests from outside can join from a browser' }).click();
  await P.getByLabel("The meeting's name on the meeting site").fill('P12 Design Review');
  await P.getByText('Free: …/p12-design-review').waitFor({ timeout: 10000 });
  await P.getByRole('button', { name: 'Send invitations' }).click();
  await P.locator('.guest-url').waitFor({ timeout: 15000 });
  await P.getByLabel('A note guests see when they leave').fill('Thank you. The minutes and the marked-up isometrics follow by Friday.');
  await P.getByRole('button', { name: 'Save note' }).click();
  await sleep(800);
  const block = P.locator('.meet-invite-block');
  await block.evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'center' }));
  await sleep(600);
  await shot(P, 'meet-invite', block, 12);
  await P.keyboard.press('Escape');
  await owner.request('admin.remote.set' as never, { enabled: false } as never);
});

// ================================================================== revision 2: meeting threads, the notice board, the bot network, seating
// GUIDE_ONLY=recap,notices,botnet,seating walks only these.
const req = (page: any, op: string, d: unknown = {}) => page.evaluate(([o, x]: [string, unknown]) => window.dex.request(o as never, x as never), [op, d]);
/** Join a meeting by its ID from the Meet lens. */
const joinById = async (page: any, meetingId: string) => {
  await lens(page, 'Meet');
  await page.getByLabel('Meeting ID or link').fill(meetingId);
  await page.locator('.meet-join').getByRole('button', { name: 'Join' }).click();
  await page.getByRole('button', { name: 'Leave Room' }).waitFor({ timeout: 25000 });
};
/** A shot of `sel` when it is on screen, else of the whole window. */
const shotOf = async (page: any, name: string, sel: string, pad = 10) => { const l = page.locator(sel).first(); if (await l.count() && await l.isVisible().catch(() => false)) await shot(page, name, l, pad); else await shot(page, name); };
const nextDow = (dow: number, h = 12) => { const d = new Date(); d.setHours(h, 0, 0, 0); d.setDate(d.getDate() + (((dow - d.getDay()) + 7) % 7 || 7)); return d; };
const ymdOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

await part('recap', async () => {
  // Priya plans a weekly review with no conversation: it gets a thread of its own
  autoApprove = true;
  const start = Date.now() + 20 * 60_000;
  const ev = await req(P, 'cal.create', { title: 'P-12 pump skid weekly review', startAt: start, endAt: start + 3600_000, attendees: [id('ravi'), id('anand'), id('deepa')], online: true, recurrence: 'weekly' }) as any;
  if (!ev.convId) throw new Error('the meeting has no thread');
  // before the meeting: Ravi shares the agenda and the GA in the thread
  const ga = await upload(hub.port, col.ravi.token, 'P12-GA-0301 Rev C Area 3.pdf', fs.readFileSync(gaPdf));
  await say(col.ravi, ev.convId, 'Agenda for Tuesday: 1. the client’s GA comments 2. nozzle loads on the pump skid 3. next steps. The GA is attached.', { files: [ga.id] });
  await say(col.deepa, ev.convId, 'I will bring the nozzle load table for P-402A/B.');
  await P.reload(); await P.locator('.frame').waitFor(); await sleep(1500);
  await openConv(P, 'Spaces', 'P-12 pump skid weekly review');
  await expandSwitchboard(P);
  await scrollEnd(P);
  await sleep(800);
  await shot(P, 'meet-thread');
  // the meeting: Priya starts it early from its ID, Ravi joins
  const m = await req(P, 'meet.event', { eventId: ev.id }) as any;
  const ravi = await appOf('ravi', 'Ravi Kumar');
  await joinById(P, m.id);
  await joinById(ravi.page, m.id);
  await P.getByRole('tab', { name: /^Chat/ }).click();
  await ravi.page.getByRole('tab', { name: /^Chat/ }).click();
  await ravi.page.getByLabel('Message to the meeting').fill('The client wants the skid moved 300 mm north, clear of the cable tray.');
  await ravi.page.getByLabel('Message to the meeting').press('Enter');
  await P.locator('.meet-chat .meet-chat-line', { hasText: 'skid moved 300 mm' }).waitFor({ timeout: 15000 });
  // 1. an action point from a chat line: the card reads owner and date as it is typed
  const box = P.getByLabel('Message to the meeting');
  await box.fill('/action Ravi to send the revised GA by Fri');
  await P.locator('.meet-chat .ap-preview').waitFor();
  await sleep(600);
  await shotOf(P, 'ap-chat', '.meet-chat', 8);
  await box.press('Enter');
  await P.locator('.meet-chat .meet-chat-body', { hasText: 'Send the revised GA' }).waitFor({ timeout: 10000 });
  // 2. the capture strip: A on the stage
  await P.locator('.room-field').click({ position: { x: 300, y: 200 } });
  await P.keyboard.press('a');
  const strip = P.getByLabel('Action point: who, what, by when');
  await strip.waitFor({ timeout: 5000 });
  await strip.fill('Deepa to check the nozzle loads by 20 Nov');
  await P.locator('.ap-capture .ap-preview').waitFor();
  await sleep(600);
  await shot(P, 'ap-strip');
  await strip.press('Enter');
  await sleep(800);
  await P.keyboard.press('Escape');
  // 3. promote Ravi's line
  const line = P.locator('.meet-chat .meet-chat-line', { hasText: 'skid moved 300 mm' });
  await line.hover();
  await line.getByRole('button', { name: 'Make an action point' }).click();
  const dlg = P.getByRole('dialog', { name: 'Make an action point' });
  await dlg.getByRole('textbox', { name: 'What needs doing' }).fill('Move the skid 300 mm north on the model');
  await dlg.getByRole('combobox', { name: 'Owner' }).selectOption(id('anand'));
  await sleep(500);
  await shot(P, 'ap-make', dlg, 14);
  await dlg.getByRole('button', { name: 'Log action point' }).click();
  await dlg.waitFor({ state: 'detached' });
  // Ravi takes the notes; the agenda in the Register
  const roomId = ((await req(P, 'room.list')) as any[]).find((r) => r.meetingId === m.id)?.id;
  if (roomId) await req(P, 'meet.noteTaker', { roomId, userId: id('ravi') }).catch((e: Error) => console.log('note-taker', e.message));
  await P.getByRole('tab', { name: /^Register/ }).click();
  await P.getByRole('button', { name: 'Write the agenda' }).click().catch(() => {});
  await P.getByLabel('The agenda, one item a line, minutes first').fill('10 The client’s GA comments\n15 Nozzle loads on the pump skid\n5 Next steps').catch(() => {});
  await P.getByRole('button', { name: 'Save the agenda' }).click().catch(() => {});
  await P.locator('.meet-register .ap-ref', { hasText: 'AP-03' }).waitFor({ timeout: 10000 });
  await sleep(800);
  await shotOf(P, 'meet-register', '.meet-register', 8);
  // Anand comes in late: the room has been going for twelve minutes
  for (const r of (hub as any).rooms.rooms.values()) if (r.meeting?.id === m.id || r.meetingId === m.id) r.startedAt -= 12 * 60_000;
  const anand = await appOf('anand', 'Anand Pillai');
  await openConv(anand.page, 'Spaces', 'P-12 pump skid weekly review');
  await sleep(800);
  await joinById(anand.page, m.id);
  await anand.page.locator('.catch-up').waitFor({ timeout: 10000 });
  await sleep(600);
  await shotOf(anand.page, 'meet-missed-card', '.catch-up', 10);
  await anand.page.getByRole('button', { name: 'Leave Room' }).click().catch(() => {});
  await ravi.page.getByRole('button', { name: 'Leave Room' }).click().catch(() => {});
  // the end: the recap card in the thread, and the recap sheet. The meeting is drawn as forty minutes long
  // (its start and everyone's joining moved back), so the recap reads like a real one.
  const mdb = (hub as any).meetThreads.db;
  mdb.prepare('UPDATE meet_occurrences SET started_at = started_at - ? WHERE conv_id = ?').run(40 * 60_000, ev.convId);
  if (roomId) for (const [uid, back] of [[priyaId, 40], [id('ravi'), 39], [id('anand'), 28]] as const) mdb.prepare('UPDATE meeting_attendance SET joined_at = joined_at - ? WHERE room_id = ? AND user_id = ?').run(back * 60_000, roomId, uid);
  await P.getByRole('tab', { name: /^People/ }).click();
  await P.getByRole('button', { name: 'End for everyone' }).click();
  await P.locator('.confirm-actions').getByRole('button', { name: 'End for everyone' }).click().catch(() => {});
  await P.getByRole('button', { name: 'Leave Room' }).waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
  await sleep(1500);
  await openConv(P, 'Spaces', 'P-12 pump skid weekly review');
  const card = P.locator('.recap-card').last();
  await card.waitFor({ timeout: 20000 });
  await scrollEnd(P);
  await card.evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'center' }));
  await noToasts(P);
  await sleep(700);
  await shot(P, 'recap-card', card, 10);
  // Ravi's point, as the owner sees it in the thread
  await openConv(ravi.page, 'Spaces', 'P-12 pump skid weekly review');
  await scrollEnd(ravi.page);
  const ap = ravi.page.locator('.msg', { hasText: 'Send the revised GA' }).last();
  await ap.evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'center' })).catch(() => {});
  await sleep(600);
  await shot(ravi.page, 'ap-card', ap, 10);
  await card.getByRole('button', { name: 'Open the recap' }).click();
  const sheet = P.locator('.recap-sheet');
  await sheet.locator('.recap-table tbody tr').first().waitFor({ timeout: 15000 });
  await sleep(1000);
  await shot(P, 'recap-sheet');
  await sheet.getByRole('button', { name: 'Send by email' }).click();
  await sheet.getByRole('button', { name: 'For guests' }).click().catch(() => {});
  await sleep(600);
  const rb = await sheet.boundingBox();
  await shot(P, 'recap-email', { x: rb.x, y: rb.y, width: rb.width, height: 320 });
  await sheet.getByRole('button', { name: 'Cancel' }).click().catch(() => {});
  await P.keyboard.press('Escape');
});

await part('notices', async () => {
  autoApprove = true;
  const desks = (await owner.request('admin.notices.get' as never) as any).desks as any[];
  const desk = (code: string) => desks.find((d) => d.code === code)?.id as string;
  // the administrator makes Revathi an issuer for HR
  const V = (await appOf('vikram', 'Vikram Shah')).page;
  await V.reload(); await V.locator('.frame').waitFor(); await sleep(1200);
  await V.locator('.me-btn').click();
  await V.getByRole('menuitem', { name: /Control room/ }).click();
  await V.getByRole('group', { name: 'Admin section' }).getByRole('button', { name: /^Notice desks/ }).click();
  await V.locator('.nb-admin').waitFor();
  await V.getByRole('combobox', { name: 'Add an issuer for HR' }).selectOption({ label: 'Revathi Iyer' });
  await V.getByText('Revathi Iyer now issues for HR').waitFor();
  await noToasts(V);
  await sleep(500);
  await shot(V, 'cr-notices', { x: W - 988, y: 0, width: 988, height: H });
  await V.keyboard.press('Escape');
  // the office's other notices this week, from the IT and Admin desks
  const everyone = { everyone: true, departments: [], roles: [], locations: [], people: [] };
  const issue = async (v: Record<string, unknown>) => { const d = await owner.request('notices.save' as never, { ackRequired: false, audience: everyone, ...v } as never) as any; return owner.request('notices.issue' as never, { id: d.id } as never) as Promise<any>; };
  const friday = nextDow(5, 0);
  await issue({ deskId: desk('ADM'), category: 'holiday', title: 'Office closed for Guru Nanak Jayanti', body: 'The office is closed on Friday. Plotter jobs sent after 6 pm on Thursday are printed on Saturday morning. Site teams follow the client’s calendar.', effectiveAt: friday.getTime(), expiresAt: friday.getTime() + 86400_000 }).catch((e: Error) => console.log('holiday', e.message));
  const evening = new Date(); evening.setHours(18, 30, 0, 0);
  await issue({ deskId: desk('ADM'), category: 'event', title: 'Office get-together in the canteen', body: 'Tea and snacks in the canteen at 6:30 pm, to welcome the new joiners of November.', effectiveAt: evening.getTime(), expiresAt: evening.getTime() + 86400_000 }).catch((e: Error) => console.log('event', e.message));
  await issue({ deskId: desk('IT'), category: 'it', title: 'New A0 plotter on the 2nd floor', body: 'The new A0 plotter is installed. Its name on the network is **PLOT-A0-2F**. Ask on the Help desk if it does not show on your PC.' }).catch((e: Error) => console.log('it', e.message));
  await issue({ deskId: desk('ADM'), category: 'safety', title: 'Fire drill on Thursday at 11:00', body: 'Leave by the nearest stair when the alarm sounds and gather at the main gate. Floor wardens wear the orange vests.', ackRequired: true }).catch((e: Error) => console.log('safety', e.message));
  await issue({ deskId: desk('MGT'), category: 'circular', title: 'Timesheets for November by the 28th', body: 'Please fill in November’s timesheets in Dexterity Connect by the 28th, so that client invoices go out on time.' }).catch((e: Error) => console.log('circular', e.message));
  // Revathi drafts the leave policy with its PDF, for Piping and Drafting, and issues it
  const policyPdf = path.join(OUT, 'HR-POL Leave policy 2026.pdf');
  const pg = (n: number) => ({ w: 595, h: 842, ops: `0.11 0.46 0.5 RG 1.5 w 40 40 515 762 re S 0.5 w 40 760 m 555 760 l S\n` + text(60, 775, 14, 'DEXTERITY DESIGN SERVICES PVT. LTD.') + text(390, 775, 9, `HR LEAVE POLICY 2026 · ${n} OF 2`) + (n === 1
    ? text(60, 720, 18, 'Leave policy 2026') + ['1. Earned leave is 18 days a year, credited monthly.', '2. Carry forward is up to 30 days.', '3. Apply in the HR portal at least a week ahead.', '4. Sick leave needs a certificate after two days.', '5. Comp-off is taken within 60 days of the day worked.'].map((l, i) => text(60, 680 - i * 26, 11, l)).join('')
    : text(60, 720, 16, 'Annexure: holidays 2026') + text(60, 690, 11, 'The office calendar on the notice board lists the holidays.')) });
  fs.writeFileSync(policyPdf, makePdf([pg(1), pg(2)], { title: 'Leave policy 2026' }));
  const rv = await appOf('revathi', 'Revathi Iyer');
  const R = rv.page;
  await R.reload(); await R.locator('.frame').waitFor(); await sleep(1200);
  await lens(R, 'Notices');
  await R.locator('.nb-view').waitFor();
  await R.getByRole('button', { name: 'Draft a notice' }).first().click();
  await R.locator('.nb-compose').waitFor();
  await R.getByLabel('Kind', { exact: true }).selectOption('policy');
  await R.getByLabel('Title', { exact: true }).fill('Leave policy 2026');
  await R.getByLabel('The notice', { exact: true }).fill('Earned leave is 18 days a year, credited monthly.\n\nCarry forward is up to 30 days.\n\nApply for leave in the HR portal at least a week ahead.');
  await R.locator('input[type=file][aria-label="PDF to attach"]').setInputFiles(policyPdf);
  await R.locator('.nb-attached').waitFor({ timeout: 15000 });
  await R.locator('.toggle-row', { hasText: 'Everyone in the office' }).click();
  await R.locator('.nb-aud-set').getByText('Piping', { exact: true }).click();
  await R.locator('.nb-aud-set').getByText('Drafting', { exact: true }).click();
  await R.locator('.toggle-row', { hasText: 'Ask readers to acknowledge' }).click();
  await R.getByRole('button', { name: 'Add a check question' }).click();
  await R.getByLabel('Check question 1').fill('How many days of earned leave a year?');
  await R.getByLabel('Answer 1', { exact: true }).fill('12');
  await R.getByLabel('Answer 2', { exact: true }).fill('18');
  await R.getByLabel('Answer 2 is right').check();
  await R.locator('details.nb-tr summary').first().click().catch(() => {});
  await R.getByLabel('Title in Hindi').fill('अवकाश नीति 2026').catch(() => console.log('no Hindi title field'));
  await R.getByLabel('The notice in Hindi').fill('हर साल 18 दिन की अर्जित छुट्टी मिलती है, जो हर महीने जुड़ती है।\n\nअधिकतम 30 दिन की छुट्टी अगले साल ले जा सकते हैं।\n\nछुट्टी के लिए HR पोर्टल में कम से कम एक सप्ताह पहले आवेदन करें।').catch(() => {});
  const top = () => R.evaluate(() => document.querySelectorAll('.nb-compose, .nb-compose *').forEach((el) => { if (el.scrollHeight > el.clientHeight + 4) (el as HTMLElement).scrollTop = 0; }));
  await top();
  await sleep(500);
  await shot(R, 'nb-composer', R.locator('.nb-compose').first(), 0);
  await R.locator('.nb-num', { hasText: '04' }).evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'start' })).catch(() => {});
  await sleep(400);
  await shot(R, 'nb-composer-2', R.locator('.nb-compose').first(), 0);
  await R.getByRole('button', { name: 'Preview' }).click();
  await R.locator('.nb-preview-bar').waitFor({ timeout: 10000 }).catch(() => {});
  await R.locator('.nb-pdf .pdfv-inline').waitFor({ timeout: 15000 }).catch(() => {});
  await sleep(600);
  await R.getByRole('button', { name: 'Back to the draft' }).click().catch(() => {});
  await R.getByRole('button', { name: 'Issue now' }).first().click();
  await R.locator('.confirm-actions').getByRole('button', { name: 'Issue now' }).click({ timeout: 5000 }).catch(() => {});
  let policy: any = null;
  for (let i = 0; i < 40 && !policy; i++) { policy = ((await owner.request('notices.list' as never) as any).notices as any[]).find((n) => n.title === 'Leave policy 2026' && n.status === 'issued'); if (!policy) await sleep(250); }
  if (!policy) throw new Error('the leave policy was not issued');
  await R.keyboard.press('Escape');
  // Priya: Pulse, the board, the reading sheet, the acknowledgement
  await P.reload(); await P.locator('.frame').waitFor(); await sleep(1500);
  await lens(P, 'Pulse');
  await P.locator('.nb-pulse-rows .pulse-row', { hasText: 'Leave policy 2026' }).waitFor({ timeout: 10000 });
  await P.locator('.nb-pulse-rows').evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'start' })).catch(() => {});
  await P.locator('.view').first().evaluate((el: HTMLElement) => { el.scrollTop -= 60; }).catch(() => {});
  await noToasts(P);
  await sleep(600);
  await shot(P, 'nb-pulse', { x: 140, y: 44, width: W - 280, height: 360 });
  await P.locator('.nb-week').evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'center' })).catch(() => {});
  await sleep(500);
  await shotOf(P, 'nb-week', '.nb-week', 10);
  await P.locator('.view').first().evaluate((el: HTMLElement) => { el.scrollTop = 0; }).catch(() => {});
  await lens(P, 'Notices');
  await P.locator('.nb-view').waitFor();
  await P.locator('.nb-shelf .nb-stack').first().waitFor({ timeout: 8000 }).catch(() => {});
  await sleep(800);
  await shot(P, 'nb-board');
  await P.locator('.nb-row', { hasText: 'Leave policy 2026' }).first().click();
  await P.locator('.nb-sheet .nb-tb').waitFor();
  await P.locator('.nb-sheet .pdfv-inline .pdfv-page').first().waitFor({ timeout: 20000 }).catch(() => {});
  await sleep(1500);
  await shot(P, 'nb-sheet');
  await P.locator('.nb-ack').scrollIntoViewIfNeeded();
  await P.locator('.nb-check').getByText('18', { exact: true }).click();
  await sleep(300);
  await shotOf(P, 'nb-ack-form', '.nb-ack', 10);
  await P.locator('.nb-sure input').check();
  await P.getByRole('button', { name: 'Acknowledge', exact: true }).click();
  await P.locator('.nb-stamp').first().waitFor();
  await P.locator('.nb-sheet .nb-tb').scrollIntoViewIfNeeded();
  await sleep(1200);
  await shotOf(P, 'nb-stamp', '.nb-sheet .nb-tb', 10);
  await P.keyboard.press('Escape');
  // the acknowledgement register fills in as people acknowledge
  for (const u of ['ravi', 'karthik', 'lalitha', 'manoj']) await col[u].c.request('notices.ack' as never, { id: policy.id, answers: [1] } as never).catch((e: Error) => console.log('ack', u, e.message));
  await lens(R, 'Notices');
  await R.locator('.nb-row', { hasText: 'Leave policy 2026' }).first().click();
  await R.getByRole('tab', { name: /Acknowledgements/ }).click();
  await R.locator('.nb-acks').waitFor();
  await sleep(1000);
  const sb = await R.locator('.nb-sheet').first().boundingBox();
  await shot(R, 'nb-acks', { x: sb.x, y: sb.y, width: sb.width, height: 330 });
  // Rev B: a change note, and everyone asked again
  await R.getByRole('tab', { name: /^Notice/ }).click();
  await R.getByRole('button', { name: /Revise \(Rev B\)/ }).click();
  await R.locator('.nb-compose').waitFor();
  await R.getByLabel('The notice', { exact: true }).fill('Earned leave is 18 days a year, credited monthly.\n\nCarry forward is up to 45 days, and leave beyond that is encashed in April.\n\nApply for leave in the HR portal at least a week ahead.');
  await R.getByLabel('What changed').fill('Carry forward raised from 30 to 45 days; encashment in April.');
  await R.locator('.toggle-row', { hasText: 'Ask everyone to acknowledge again' }).click();
  await R.getByRole('button', { name: 'Add a check question' }).click().catch(() => {});
  await R.getByLabel('Check question 1').fill('How many days carry forward?').catch(() => {});
  await R.getByLabel('Answer 1', { exact: true }).fill('30').catch(() => {});
  await R.getByLabel('Answer 2', { exact: true }).fill('45').catch(() => {});
  await R.getByLabel('Answer 2 is right').check().catch(() => {});
  await R.getByRole('button', { name: 'Issue Rev B' }).click();
  await R.locator('.confirm-actions').getByRole('button', { name: 'Issue now' }).click();
  await R.locator('.nb-sheet .nb-change').waitFor({ timeout: 10000 });
  await R.keyboard.press('Escape');
  await lens(P, 'Pulse');
  await P.locator('.nb-pulse-rows .pulse-row', { hasText: 'Leave policy 2026' }).click({ timeout: 10000 });
  await P.locator('.nb-sheet .nb-cloud').first().waitFor({ timeout: 10000 });
  await P.locator('.nb-sheet .nb-change').evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'start' }));
  await sleep(800);
  const cb = await P.locator('.nb-sheet').first().boundingBox();
  await shot(P, 'nb-cloud', { x: cb.x, y: 0, width: cb.width, height: 250 });
  await P.keyboard.press('Escape');
  // an urgent notice from IT: a banner, once
  await issue({ deskId: desk('IT'), category: 'it', title: 'Mail server down until 3 pm', body: 'Outlook cannot send or receive. Use Dexterity Connect for anything urgent; IT will post here when mail is back.', urgent: true });
  await P.locator('.nb-banner', { hasText: 'Mail server down' }).waitFor({ timeout: 10000 });
  await noToasts(P);
  await sleep(500);
  await shot(P, 'nb-banner', { x: 0, y: 0, width: W, height: 160 });
  await P.locator('.nb-banner').getByRole('button', { name: 'Dismiss' }).click();
});

await part('botnet', async () => {
  const bf = (hub as any).botflows;
  const U = (uid: string) => (hub as any).store.userById(uid);
  const as = (uid: string, op: string, d: Record<string, unknown> = {}) => bf.handle(op, U(uid), d);
  const waitRow = async (sessionId: string, stepId: string) => { for (let i = 0; i < 200; i++) { if ((hub as any).store.db.prepare("SELECT 1 FROM bot_sessions WHERE id = ? AND step = ? AND status = 'active'").get(sessionId, stepId)) return; await sleep(50); } };
  const run = async (uid: string, flow: string, answers: Array<[string, string]>) => {
    const r = await as(uid, 'botflow.start', { flow });
    for (const [stepId, value] of answers) { await waitRow(r.sessionId, stepId); await as(uid, 'botflow.answer', { sessionId: r.sessionId, stepId, value }); }
    return r;
  };
  const { BOT_TEMPLATES } = await import('../../../packages/core/src/botmaker.ts');
  const tpl = (tid: string) => JSON.parse(JSON.stringify(BOT_TEMPLATES.find((x: any) => x.id === tid)!.definition));
  // the office's bots: the plot room (Bhavna), software seats, TQs (Rohan answers for the client)
  const plot = tpl('plot-request');
  plot.name = 'plot-room'; plot.title = 'Plot room'; plot.track.roles.plotroom.person = id('bhavna');
  await owner.request('botflow.make' as never, { definition: plot, scope: 'office' } as never);
  await owner.request('botflow.make' as never, { definition: tpl('licence-seat'), scope: 'office' } as never);
  const tq = tpl('rfi-log');
  tq.track.roles.client.person = id('rohan');
  await owner.request('botflow.make' as never, { definition: tq, scope: 'office' } as never);
  // Priya's iso check: once issued, the plot room's bot carries the Plot stage
  const dc = tpl('drawing-issue');
  dc.name = 'iso-issue'; dc.title = 'Iso check and plot';
  dc.track.roles.doccontrol.person = id('fatima');
  dc.track.stages.find((s: any) => s.id === 'issue').actions[0].to = 'plot';
  dc.track.stages.splice(4, 0, {
    id: 'plot', label: 'Plot', who: 'bot:plot-room', prompt: 'With the plot room',
    handoff: { to: 'plot-room', start: 'queue', carry: { size: 'A1', sets: '2', drawings: '{{drawings}} rev {{rev}}', due: '{{due.value}}' } },
    actions: [{ id: 'plotted', label: 'Plotted', to: 'receipt', tone: 'go' }, { id: 'none', label: 'Not plotted', to: 'receipt', tone: 'stop' }],
  });
  await as(priyaId, 'botflow.make', { definition: dc, scope: 'private', newBot: true });
  await run(priyaId, 'iso-issue', [['job', 'P-12513'], ['drawings', 'ISO-1001-03\nISO-1001-04'], ['rev', 'B'], ['purpose', 'IFC'], ['checker', id('ravi')], ['print', ''], ['due', dayStr(3)], ['ok', 'yes']]);
  const itemId = ((hub as any).store.db.prepare("SELECT id FROM bot_items WHERE flow = 'iso-issue'").get() as any).id;
  for (let i = 0; i < 4; i++) await as(id('ravi'), 'botflow.tick', { itemId, index: i, on: true });
  await as(id('ravi'), 'botflow.act', { itemId, action: 'pass' });
  await as(id('meera'), 'botflow.act', { itemId, action: 'ok' });
  await lens(P, 'Direct');
  await P.locator('.sb-row', { hasText: 'Iso check and plot' }).first().click({ timeout: 15000 });
  await as(id('fatima'), 'botflow.act', { itemId, action: 'issued', note: 'DDSP-P12-TR-0144' });
  const relay = P.locator('.flow-card.relay').last();
  await relay.waitFor({ timeout: 15000 });
  const dcCard = P.locator('.flow-card.done.track').last();
  await dcCard.locator('.trk-cell.here .trk-bot', { hasText: 'PLT-' }).waitFor({ timeout: 10000 }).catch(() => {});
  await scrollEnd(P);
  await noToasts(P);
  await sleep(2500);
  await shot(P, 'bn-relay');
  // a question that asks another bot: is a CAESAR II seat free?
  await as(priyaId, 'botflow.make', { scope: 'private', newBot: true, definition: {
    name: 'stress-check', title: 'Stress check', persona: { mark: { kind: 'glyph', glyph: 'flange' }, colour: 'petrol', tone: 'plain' },
    steps: [
      { id: 'line', label: 'Line', prompt: 'Which line needs a stress check?', input: { kind: 'text' } },
      { id: 'seat', label: 'CAESAR II seat', prompt: 'Is a CAESAR II seat free?', input: { kind: 'text', validate: { type: 'number', integer: true, min: 0 } }, ask: { skill: 'licence-seat.seats', with: { key: 'CAESAR II' } }, branches: [{ if: { equals: '0' }, goto: 'wait' }] },
      { id: 'go', label: 'Start', prompt: 'A CAESAR II seat is free ({{seat}}). Start the model now?', input: { kind: 'choice', options: [{ value: 'now', label: 'Start now' }, { value: 'later', label: 'Later today' }] }, next: 'end' },
      { id: 'wait', label: 'Wait', prompt: 'No seat is free. Wait in line?', input: { kind: 'choice', options: [{ value: 'yes', label: 'Wait in line' }, { value: 'no', label: 'Not now' }] } },
    ],
    finish: [{ do: 'remind', text: 'Stress check {{line}}', dueInDays: 1 }],
  } });
  await as(priyaId, 'botflow.start', { flow: 'stress-check' });
  await P.locator('.sb-row', { hasText: 'Stress check' }).first().click({ timeout: 15000 });
  const step = () => P.locator('.flow-card.step.active');
  await step().getByLabel('Your answer').fill('8"-P-1014-A1B');
  await step().getByRole('button', { name: 'Next' }).click();
  await step().locator('.flow-q', { hasText: 'CAESAR II seat is free' }).waitFor({ timeout: 10000 });
  await scrollEnd(P);
  await sleep(1500);
  await shot(P, 'bn-ask');
  await step().getByRole('button', { name: 'Start now' }).click().catch(() => {});
  // the bot maker: a question that asks a bot, and the Other bots part
  await P.evaluate(() => window.dispatchEvent(new CustomEvent('dex-botmaker', { detail: { name: 'stress-check' } })));
  await P.getByRole('tab', { name: /Questions/ }).click({ timeout: 10000 });
  await P.locator('#bm-step-seat .bm-step-head').click();
  await P.locator('.bm-askbot').first().waitFor();
  await sleep(700);
  await shot(P, 'bn-maker-ask');
  await P.getByRole('tab', { name: /Other bots/ }).click();
  await sleep(900);
  await shot(P, 'bn-otherbots');
  await P.getByRole('button', { name: 'Close' }).first().click();
  if (await P.getByRole('button', { name: 'Leave' }).isVisible().catch(() => false)) await P.getByRole('button', { name: 'Leave' }).click();
  // a scheduled job, in plain words: the Weekly TQ chaser from its template
  const real = Date.now();
  bf.now = () => real - 21 * 86400_000;
  const tqAnswers = (job: string): Array<[string, string]> => [['job', job], ['discipline', 'piping'], ['ref', 'P12-GA-0301 rev C'], ['question', 'Nozzle orientation on V-401?'], ['proposal', ''], ['markup', ''], ['due', dayStr(5)], ['ok', 'yes']];
  await run(priyaId, 'rfi-log', tqAnswers('P-12513'));
  await run(priyaId, 'rfi-log', tqAnswers('P-12514'));
  bf.now = () => Date.now();
  await owner.request('admin.botjob.holidays' as never, { holidays: [{ date: ymdOf(nextDow(5)), name: 'Guru Nanak Jayanti' }, { date: ymdOf(new Date(new Date().getFullYear(), 11, 25)), name: 'Christmas' }] } as never).catch((e: Error) => console.log('holidays', e.message));
  await lens(P, 'Desk');
  await P.getByRole('tab', { name: 'Bots' }).click();
  await P.getByRole('button', { name: 'Make a bot' }).first().click();
  await P.locator('.bm-start').waitFor({ timeout: 10000 });
  await P.getByRole('button', { name: 'Start from Weekly TQ chaser' }).click();
  await P.getByRole('tab', { name: /Schedule/ }).click();
  const when = P.getByLabel('When it runs, in plain words');
  await when.waitFor();
  await when.fill('every Monday at 10:00');
  await P.locator('.js-understood', { hasText: 'Every Monday at 10:00' }).waitFor();
  await sleep(600);
  await shot(P, 'bn-schedule');
  await P.getByRole('button', { name: 'Save bot' }).click();
  await P.locator('.toast', { hasText: 'Weekly TQ chaser saved' }).waitFor({ timeout: 8000 }).catch(() => {});
  await P.getByRole('button', { name: 'Close' }).first().click();
  await noToasts(P);
  // the job sheet: Monday's run at 10:00 (the hub's clock moved to Monday), then a dry run
  const monday10 = nextDow(1, 10).getTime();
  let clock = monday10 - 3600_000;
  bf.now = () => clock;
  await bf.jobs.tick(clock);
  clock = monday10 + 5000;
  await bf.jobs.tick(clock);
  clock = monday10 + 3 * 3600_000;
  await P.getByRole('button', { name: 'Job sheet' }).click();
  const lane = P.locator('.js-lane', { hasText: 'Monday chase' });
  await lane.waitFor({ timeout: 10000 });
  await lane.getByRole('button', { name: 'Dry run' }).click();
  await P.locator('.js-detail').waitFor({ timeout: 10000 });
  await sleep(800);
  await shot(P, 'bn-jobsheet');
  await P.getByRole('button', { name: 'Close' }).first().click();
  bf.now = () => Date.now();
  // the bot network sheet
  await P.getByRole('button', { name: 'Bot network' }).click();
  const net = P.locator('.net-sheet');
  await net.locator('.nw-svg').waitFor({ timeout: 10000 });
  await net.locator('.nw-list button', { hasText: 'Iso check and plot' }).first().click().catch(() => {});
  await sleep(800);
  await P.evaluate(() => document.querySelectorAll('.net-sheet, .net-sheet *').forEach((el) => { if (el.scrollHeight > el.clientHeight + 4) (el as HTMLElement).scrollTop = 0; }));
  await sleep(800);
  await shot(P, 'bn-network');
  await P.keyboard.press('Escape'); await P.keyboard.press('Escape');
  // the office's holidays, in the Control room
  const V = (await appOf('vikram', 'Vikram Shah')).page;
  await V.reload(); await V.locator('.frame').waitFor(); await sleep(1200);
  await V.locator('.me-btn').click();
  await V.getByRole('menuitem', { name: /Control room/ }).click();
  await V.getByRole('group', { name: 'Admin section' }).getByRole('button', { name: /^Bots & tools/ }).click();
  const hol = V.locator('.bots-holidays');
  await hol.waitFor({ timeout: 10000 });
  await hol.evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'center' }));
  await sleep(700);
  await shot(V, 'cr-holidays', hol, 12);
  await V.keyboard.press('Escape');
});

await part('seating', async () => {
  autoApprove = true;
  // the administrator names Bhavna office manager in Control room ▸ Organisation ▸ Office managers
  const V = (await appOf('vikram', 'Vikram Shah')).page;
  await V.reload(); await V.locator('.frame').waitFor(); await sleep(1200);
  await V.locator('.me-btn').click();
  await V.getByRole('menuitem', { name: /Control room/ }).click();
  await V.getByRole('group', { name: 'Admin section' }).getByRole('button', { name: /^Organisation/ }).click();
  const mgr = V.locator('.org-managers');
  await mgr.waitFor({ timeout: 10000 });
  await mgr.evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'center' }));
  const addMgr = V.getByRole('combobox', { name: 'Add an office manager' });
  await addMgr.fill('Bhav');
  await mgr.getByRole('option', { name: /Bhavna Shah/ }).waitFor();
  await addMgr.press('Enter');
  await V.getByText('Bhavna Shah is now an office manager').waitFor({ timeout: 8000 });
  await noToasts(V);
  // a second name being typed, to show the picker's list
  await addMgr.fill('Ra');
  await mgr.getByRole('listbox').waitFor();
  await sleep(600);
  { const cb = (await mgr.boundingBox())!; const lb = (await mgr.getByRole('listbox').boundingBox())!; const bottom = Math.max(cb.y + cb.height, lb.y + lb.height) + 12; await shot(V, 'cr-office-managers', { x: cb.x - 12, y: cb.y - 12, width: cb.width + 24, height: Math.min(H, bottom) - cb.y + 12 }); }
  await addMgr.fill('');
  await V.keyboard.press('Escape');
  const b = await appOf('bhavna', 'Bhavna Shah');
  const B = b.page;
  const at = (page: any, seat: string) => page.evaluate((x: string) => (globalThis as any).__seatScreen(x), seat);
  const openFloor = async (page: any) => {
    await page.reload(); await page.locator('.frame').waitFor(); await sleep(1200);
    await lens(page, 'Directory');
    await page.getByRole('tab', { name: 'Org chart', exact: true }).click();
    await page.locator('.os-stage').waitFor();
    await page.getByRole('button', { name: 'Floor', exact: true }).click();
    await sleep(2600);
  };
  await openFloor(B);
  if (await B.locator('.nb-banner').count()) { await B.locator('.nb-banner').getByRole('button', { name: 'Dismiss' }).click().catch(() => {}); await sleep(400); }
  if (await B.locator('.seat-notice').count()) { await B.locator('.seat-notice').getByRole('button', { name: 'Got it' }).click().catch(() => {}); await sleep(400); }
  // a free seat, found by its ID: the callout an office manager sees
  await B.locator('.os-find-input').fill('W-A08');
  await B.locator('.os-results li', { hasText: 'Seat W-A08' }).click();
  await B.locator('.seat-callout', { hasText: 'W-A08' }).waitFor();
  await sleep(900);
  await shot(B, 'seat-callout', B.locator('.seat-callout'), 12);
  await B.locator('.seat-callout').getByRole('button', { name: 'Close' }).click();
  await B.locator('.os-find-input').fill('');
  // Arrange: Priya dragged from the list onto W-A19
  await B.getByRole('button', { name: 'Arrange' }).click();
  await B.locator('.seat-panel').waitFor();
  await B.getByRole('button', { name: 'Show the whole sheet' }).click(); await sleep(800);
  const grip = B.locator(`.seat-grip[data-person="${priyaId}"]`);
  await grip.scrollIntoViewIfNeeded();
  const g = (await grip.boundingBox())!;
  const t = await at(B, 'W-A19');
  await B.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await B.mouse.down();
  for (let i = 1; i <= 12; i++) { await B.mouse.move(g.x + (t.x - g.x) * (i / 12), g.y + (t.y - g.y) * (i / 12)); await sleep(16); }
  await sleep(120); await B.mouse.up(); await sleep(800);
  await B.mouse.move(700, 880); await sleep(300);
  await B.locator('.seat-panel').evaluate((el: HTMLElement) => { el.scrollTop = 0; }).catch(() => {});
  await noToasts(B);
  await shot(B, 'seat-arrange');
  // the Structural team to the north-east benches, with a preview
  await B.locator('.seat-tabs').getByRole('tab', { name: 'Move a team' }).click();
  await B.getByLabel('Department').selectOption({ label: 'Structural' });
  await B.getByLabel('To', { exact: true }).selectOption({ label: 'North-east benches' });
  await B.getByRole('button', { name: 'Preview' }).click();
  await B.locator('.seat-preview li', { hasText: 'Anand Pillai' }).waitFor();
  await sleep(600);
  await shot(B, 'seat-team', { x: 0, y: 44, width: 560, height: H - 44 });
  await B.getByRole('button', { name: 'Add to the move plan' }).click();
  await sleep(800);
  // the move plan for next Monday
  await B.locator('.seat-tabs').getByRole('tab', { name: /Move plan/ }).click();
  const monday = ymdOf(nextDow(1));
  await B.getByLabel('From').fill(monday);
  await B.mouse.move(700, 880);
  await noToasts(B);
  await sleep(600);
  await shot(B, 'seat-moveplan');
  await B.getByRole('button', { name: /^Apply from/ }).click();
  await B.locator('.seat-plan', { hasText: 'From' }).waitFor({ timeout: 10000 }).catch(() => {});
  await sleep(600);
  // Monday comes: the moves take effect; Priya is told and walks to her new seat
  (hub as any).seating.setClock(Date.parse(`${monday}T09:00:00`));
  (hub as any).seating.tick();
  (hub as any).seating.setClock(null);
  await openFloor(P);
  await P.locator('.seat-notice', { hasText: 'W-A19' }).waitFor({ timeout: 10000 });
  await noToasts(P);
  await P.locator('.seat-notice').getByRole('button', { name: 'Walk there' }).click();
  await P.locator('.os-route', { hasText: 'round the desks' }).waitFor({ timeout: 10000 });
  await sleep(1600);
  await shot(P, 'seat-walk');
  await P.locator('.seat-notice').getByRole('button', { name: 'Got it' }).click().catch(() => {});
  await P.getByRole('button', { name: 'Clear the route' }).click().catch(() => {});
  // revisions B and C compared
  await B.locator('.seat-panel').getByRole('button', { name: 'Close arranging' }).click();
  await B.getByRole('button', { name: 'Revisions' }).click();
  await B.locator('.seat-revs').waitFor();
  await B.getByLabel('Compare', { exact: true }).selectOption('B');
  await B.getByLabel('with', { exact: true }).selectOption('C');
  await B.locator('.seat-compare').getByRole('button', { name: 'Compare' }).click();
  await B.locator('.seat-comparing', { hasText: /seats changed/ }).waitFor({ timeout: 10000 });
  await sleep(900);
  await shot(B, 'seat-compare');
  await B.locator('.seat-revs').getByRole('button', { name: 'Stop comparing' }).click().catch(() => {});
  await B.locator('.seat-revs').getByRole('button', { name: 'Close the revisions' }).click().catch(() => {});
  // the layout editor
  await B.getByRole('button', { name: 'Arrange' }).click();
  await B.locator('.seat-tabs').getByRole('tab', { name: 'Layout' }).click();
  await B.getByRole('button', { name: 'Edit the layout' }).click();
  await B.getByLabel('Add a bench of').fill('4');
  await B.getByRole('button', { name: 'Add bench' }).click();
  await sleep(900);
  await shot(B, 'seat-layout');
  await B.getByRole('button', { name: 'Discard changes' }).click().catch(() => {});
  if (await B.locator('.confirm-actions').count()) await B.locator('.confirm-actions').getByRole('button').last().click().catch(() => {});
  await B.keyboard.press('Escape');
});

console.log(failed.length ? `FAILED PARTS: ${failed.join(', ')}` : 'GUIDE SHOTS DONE');
for (const a of [...apps]) await closeApp(a);
for (const c of Object.values(col)) c.c.disconnect();
owner.disconnect();
await hub.stop();
setTimeout(() => process.exit(failed.length ? 1 : 0), 300);
