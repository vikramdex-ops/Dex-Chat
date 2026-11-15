// Performance run: the desktop app against a seeded office (120 people, 300 conversations, 60,000
// messages, 3,000 files, 2,000 Desk items, 400 events, meetings and recordings), with background
// office activity (a message and a presence change every 1.5 s), measured with performance marks
// (dex:boot, dex:usable), long tasks, Event Timing, frame times and the app's process metrics.
// Build the desktop app first (npm run desktop:build). On Linux without a display, under Xvfb:
//
//   PLAYWRIGHT=/path/to/playwright xvfb-run -a node apps/desktop/scripts/perf/perf.mts [--label after] [--nav-minutes 10] [--quick] [--check]
//
// --check exits with 1 when a budget is missed (see BUDGETS at the end). DEX_ROOT measures another
// checkout (a worktree of an earlier commit) with these same scripts, for before/after tables.
import fs from 'node:fs';
import path from 'node:path';
import { seededOffice, DESKTOP, ELECTRON, OUT, sleep } from './fixture.mts';
const pw = (await import(process.env.PLAYWRIGHT ?? 'playwright')).default ?? await import(process.env.PLAYWRIGHT ?? 'playwright');
const electron = pw._electron;

const args = process.argv.slice(2);
const flag = (name: string, def: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const LABEL = flag('label', 'run');
const NAV_MIN = Number(flag('nav-minutes', '10'));
const OUTFILE = flag('out', path.join(OUT, `perf-${LABEL}.json`));

const results: Record<string, unknown> = { label: LABEL, at: new Date().toISOString() };
const log = (k: string, v: unknown) => { results[k] = v; console.log(`${k}:`, typeof v === 'object' ? JSON.stringify(v) : v); };
const pct = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1); };
const stats = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 0.5), p95: pct(xs, 0.95), max: xs.length ? +Math.max(...xs).toFixed(1) : 0 });

const { hub, owner, userData, seed, priyaId, vikramId } = await seededOffice(`perf-${LABEL}`);
log('seed', seed);

// every hub operation, timed where it runs (no network)
const opTimes = new Map<string, number[]>();
const hubAny = hub as unknown as { op: (conn: unknown, op: string, data: unknown) => Promise<unknown> };
const realOp = hubAny.op.bind(hub);
hubAny.op = async (conn, op, data) => {
  const t = performance.now();
  try { return await realOp(conn, op, data); } finally { const a = opTimes.get(op) ?? []; a.push(performance.now() - t); opTimes.set(op, a); }
};

async function launchApp(userData: string, join: boolean) {
  const t0 = Date.now();
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [DESKTOP, `--user-data-dir=${userData}`, '--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--enable-precise-memory-info'],
    env: { ...process.env, DEXCONNECT_DEV_ACCOUNT: 'priya|Priya Raman', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  const proc = app.process();
  const elog = fs.createWriteStream(path.join(OUT, `electron-${LABEL}.log`), { flags: 'a' });
  proc.stdout?.pipe(elog); proc.stderr?.pipe(elog);
  const page = await app.firstWindow();
  page.on('crash', () => console.log('[renderer crashed]'));
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  page.on('pageerror', (e: Error) => console.log('[pageerror]', e.message));
  if (join) {
    await page.getByRole('button', { name: 'Request access' }).click({ timeout: 30000 });
    await page.locator('.frame').waitFor({ timeout: 30000 });
    return { app, page, startMs: 0 };
  }
  await page.waitForFunction(() => performance.getEntriesByName('dex:usable').length > 0, null, { timeout: 60000, polling: 50 });
  const usableWall = await page.evaluate(() => performance.timeOrigin + performance.getEntriesByName('dex:usable')[0].startTime);
  return { app, page, startMs: usableWall - t0 };
}

let app: any;
let page: any;
const priya = { id: priyaId };
const vikram = { id: vikramId };

// background office: a message somewhere and a presence change every 1.5 s
const convIds = (hub.store.db.prepare('SELECT conv_id FROM conv_members WHERE user_id = ? AND conv_id IN (SELECT conv_id FROM conv_members WHERE user_id = ?)').all(priya.id, vikram.id) as Array<{ conv_id: string }>).map((r) => r.conv_id).filter((c) => c !== seed.busyConvId);
const seeded = (hub.store.db.prepare("SELECT id FROM users WHERE role = 'member'").all() as Array<{ id: string }>).map((r) => r.id);
let noise: ReturnType<typeof setInterval> | null = null;
let noiseN = 0;
const startNoise = () => {
  noise = setInterval(() => {
    noiseN++;
    const c = convIds[noiseN % convIds.length];
    void owner.request('msg.send', { convId: c, body: `Background note ${noiseN} about the pipe rack`, clientId: `noise-${LABEL}-${noiseN}` }).catch(() => {});
    const u = seeded[(noiseN * 7) % seeded.length];
    (hub as any).emit('presence', { userId: u, online: noiseN % 3 !== 0, away: noiseN % 5 === 0 });
  }, 1500);
};
const stopNoise = () => { if (noise) clearInterval(noise); noise = null; };

const clearCaches = () => { for (const d of ['Code Cache', 'Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache']) fs.rmSync(path.join(userData, d), { recursive: true, force: true }); };

// ---------------------------------------------------------------- start
const cold: number[] = [];
const warm: number[] = [];
const QUICK = args.includes('--quick');
for (let i = 0; i < (QUICK ? 1 : 2); i++) {
  clearCaches();
  const r = await launchApp(userData, false);
  cold.push(r.startMs);
  await sleep(1500);
  await r.app.close();
}
for (let i = 0; i < (QUICK ? 1 : 3); i++) {
  const r = await launchApp(userData, false);
  warm.push(r.startMs);
  if (i < (QUICK ? 0 : 2)) { await sleep(1500); await r.app.close(); } else { app = r.app; page = r.page; }
}
log('start.cold.ms', cold.map(Math.round));
log('start.warm.ms', warm.map(Math.round));
const boot = await page.evaluate(() => ({ boot: Math.round(performance.getEntriesByName('dex:boot')[0]?.startTime ?? -1), usable: Math.round(performance.getEntriesByName('dex:usable')[0]?.startTime ?? -1) }));
log('start.renderer', boot);
// scripts the renderer has compiled (Debugger.scriptParsed lists them all, then each new one)
const parsed = new Set<string>();
const cdp0 = await page.context().newCDPSession(page);
cdp0.on('Debugger.scriptParsed', (e: { url: string }) => { if (/\/assets\/.+\.js$/.test(e.url)) parsed.add(e.url.split('/').pop()!); });
await cdp0.send('Debugger.enable');
await sleep(300);
const startScripts = [...parsed];
log('chunks.atStart', startScripts);

// in-page helpers
await page.evaluate(() => {
  const w = window as any;
  w.__long = [] as Array<{ s: number; d: number }>;
  new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__long.push({ s: e.startTime, d: e.duration }); }).observe({ type: 'longtask', buffered: true });
  w.__events = [] as Array<{ n: string; d: number; s: number }>;
  new PerformanceObserver((l) => { for (const e of l.getEntries() as any[]) w.__events.push({ n: e.name, d: e.duration, s: e.startTime }); }).observe({ type: 'event', durationThreshold: 16, buffered: false } as any);
  w.__frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  w.__until = async (test: () => boolean, timeout = 30000) => { const t = performance.now(); while (!test()) { if (performance.now() - t > timeout) throw new Error('timed out'); await new Promise((r) => requestAnimationFrame(r)); } };
  w.__lens = async (label: string, sel: string) => {
    const btn = [...document.querySelectorAll('.lens-bar .lens')].find((b) => b.querySelector('.lens-label')?.textContent === label) as HTMLElement;
    const t = performance.now();
    btn.click();
    await w.__until(() => !!document.querySelector(sel));
    await w.__frame();
    return performance.now() - t;
  };
});
const longSince = async (s: number) => page.evaluate((x: number) => (window as any).__long.filter((e: any) => e.s >= x).map((e: any) => +e.d.toFixed(0)), s);
const now = () => page.evaluate(() => performance.now());
const metrics = async () => {
  const m = await app.evaluate(({ app: a }: any) => a.getAppMetrics().map((p: any) => ({ type: p.type, ws: p.memory.workingSetSetSize ?? p.memory.workingSetSize })));
  const heap = await page.evaluate(() => ({ used: Math.round((performance as any).memory.usedJSHeapSize / 1048576), nodes: document.getElementsByTagName('*').length }));
  return { totalMB: Math.round(m.reduce((s: number, p: any) => s + p.ws, 0) / 1024), byType: Object.fromEntries(m.map((p: any) => [p.type, Math.round(p.ws / 1024)])), heapMB: heap.used, domNodes: heap.nodes };
};
log('memory.afterStart', await metrics());
startNoise();
await sleep(1500);

// ---------------------------------------------------------------- lenses (first visit, then again)
const LENS: Array<[string, string]> = [
  ['Direct', '.pane .timeline'], ['Spaces', '.pane .timeline'], ['Desk', '.view.desk .desk-row'], ['Calendar', '.cal-block, .cal-chip'],
  ['Directory', '.directory .card.person'], ['Meet', '.meet-sheet .meet-recent'], ['Pulse', '.view .pulse-row, .view-head'],
];
const lensFirst: Record<string, number> = {};
const lensAgain: Record<string, number[]> = {};
const t1 = await now();
for (const [l, sel] of LENS) { lensFirst[l] = Math.round(await page.evaluate(([a, b]) => (window as any).__lens(a, b), [l, sel])); await sleep(400); }
for (let k = 0; k < 3; k++) for (const [l, sel] of LENS) { (lensAgain[l] ??= []).push(Math.round(await page.evaluate(([a, b]) => (window as any).__lens(a, b), [l, sel]))); await sleep(250); }
log('lens.first.ms', lensFirst);
log('lens.again.ms', Object.fromEntries(Object.entries(lensAgain).map(([k, v]) => [k, stats(v).p50])));
log('lens.longtasks', stats(await longSince(t1)));
log('chunks.lazyLoaded', [...parsed].filter((c: string) => !startScripts.includes(c)));
log('dom.desk', await page.evaluate(async () => { await (window as any).__lens('Desk', '.view.desk .desk-row'); return { rows: document.querySelectorAll('.desk-row').length, nodes: document.querySelector('.view.desk')?.getElementsByTagName('*').length }; }));
log('dom.calendar', await page.evaluate(async () => { await (window as any).__lens('Calendar', '.cal-block, .cal-chip'); return { blocks: document.querySelectorAll('.cal-block, .cal-chip').length }; }));
// Calendar: agenda
log('calendar.agenda.ms', Math.round(await page.evaluate(async () => {
  const w = window as any;
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === 'Agenda') as HTMLElement;
  const t = performance.now(); b.click(); await w.__until(() => !!document.querySelector('.agenda-row')); await w.__frame();
  const ms = performance.now() - t;
  ([...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === 'Week') as HTMLElement)?.click();
  return ms;
})));
// Directory: filter
await page.evaluate(() => (window as any).__lens('Directory', '.directory .card.person'));
const td = await now();
await page.getByLabel('Search people').click();
await page.keyboard.type('an', { delay: 120 });
await sleep(300);
log('directory.filter.eventMax', await page.evaluate((s) => Math.max(0, ...(window as any).__events.filter((e: any) => e.s >= s).map((e: any) => e.d)), td));
log('directory.people', await page.locator('.directory .card.person').count());
await page.getByLabel('Search people').fill('');

// ---------------------------------------------------------------- Switchboard with 300 conversations
await page.evaluate(() => (window as any).__lens('Spaces', '.pane .timeline'));
const sbOpen = await page.evaluate(async () => {
  const w = window as any;
  const b = document.querySelector('[title="Open the Switchboard"]') as HTMLElement | null;
  const t = performance.now(); b?.click();
  await w.__until(() => !!document.querySelector('.sb-lenses'));
  const all = [...document.querySelectorAll('.sb-lenses button')].find((x) => x.textContent?.startsWith('All')) as HTMLElement;
  await w.__frame();
  const open = performance.now() - t;
  const t2 = performance.now(); all.click(); await w.__frame();
  return { unfoldMs: Math.round(open), allChipMs: Math.round(performance.now() - t2), rows: document.querySelectorAll('.sb-row').length };
});
log('switchboard.open', sbOpen);
const tf = await now();
await page.getByLabel('Filter conversations').click();
await page.keyboard.type('p-1', { delay: 120 });
await sleep(300);
log('switchboard.filter.events', stats(await page.evaluate((s) => (window as any).__events.filter((e: any) => e.s >= s && /key|input/.test(e.n)).map((e: any) => e.d), tf)));
log('switchboard.filter.longtasks', stats(await longSince(tf)));
await page.getByLabel('Filter conversations').fill('');
await sleep(300);

// ---------------------------------------------------------------- open a busy conversation
const openConv = async (id: string, name: string | null) => page.evaluate(async ([cid, title]) => {
  const w = window as any;
  const t = performance.now();
  window.dispatchEvent(new CustomEvent('dex-open', { detail: cid }));
  await w.__until(() => [...document.querySelectorAll('section.pane')].some((p) => (!title || p.getAttribute('aria-label') === title) && p.querySelector('.timeline .msg')));
  await w.__frame();
  return performance.now() - t;
}, [id, name]);
const busyTitle = 'P-12 Piping';
const directName = await page.evaluate(() => null);
const openFirst = await openConv(seed.busyConvId, busyTitle);
await sleep(500);
const otherSpace = convIds.find((c) => (hub.store.db.prepare("SELECT kind FROM conversations WHERE id = ?").get(c) as { kind: string }).kind === 'space')!;
const reopen: number[] = [];
const firstOthers: number[] = [];
for (let i = 0; i < 4; i++) {
  const c = convIds[(i * 37) % convIds.length];
  firstOthers.push(await openConv(c, null)); await sleep(300);
  reopen.push(await openConv(seed.busyConvId, busyTitle)); await sleep(300);
}
log('conv.open.first.ms', Math.round(openFirst));
log('conv.open.otherFirst.ms', stats(firstOthers));
log('conv.open.again.ms', stats(reopen));
void directName; void otherSpace;

// ---------------------------------------------------------------- scroll back through 5,000 messages
const busyPane = page.locator(`section.pane[aria-label="${busyTitle}"]`);
const tlBox = (await busyPane.locator('.timeline').boundingBox())!;
await page.mouse.move(tlBox.x + tlBox.width / 2, tlBox.y + tlBox.height / 2);
const memBeforeScroll = await metrics();
const ts = await now();
await page.evaluate(() => {
  const w = window as any;
  w.__frames = [] as number[];
  let last = performance.now();
  w.__frameRun = true;
  const tick = () => { const n = performance.now(); w.__frames.push(n - last); last = n; if (w.__frameRun) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
const scrollStart = Date.now();
// messages loaded (the timeline says so where it draws a window of them; otherwise every one is drawn)
const loaded = async () => page.evaluate((t) => { const el = document.querySelector(`section.pane[aria-label="${t}"] .timeline`) as HTMLElement | null; return el ? Number(el.dataset.loaded ?? el.querySelectorAll('.msg').length) : 0; }, busyTitle);
let count = await loaded();
const seen = (hub.store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conv_id = ? AND parent_id IS NULL').get(seed.busyConvId) as { n: number }).n;
const target = Math.min(5000, seen - 10);
const pageTimes: number[] = [];
while (Date.now() - scrollStart < 300_000) {
  // a reader scrolling up: about 3 wheel notches a beat
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -900); await sleep(60); }
  const c = await loaded();
  if (c !== count) { pageTimes.push(Date.now()); count = c; }
  // with the hub's message ids, a store count is exact (the DOM may lay runs out lazily)
  const inStore = await page.evaluate(() => 0);
  void inStore;
  if (count >= target) break;
}
const scrollMs = Date.now() - scrollStart;
await page.evaluate(() => { (window as any).__frameRun = false; });
const frames: number[] = await page.evaluate(() => (window as any).__frames);
const longScroll = await longSince(ts);
log('scroll.loaded', count);
log('scroll.ms', scrollMs);
log('scroll.msgsPerSec', Math.round(count / (scrollMs / 1000)));
log('scroll.longtasks', { ...stats(longScroll), over50: longScroll.filter((d: number) => d > 50).length, totalMs: longScroll.reduce((a: number, b: number) => a + b, 0) });
log('scroll.frames', { n: frames.length, dropped: frames.filter((f) => f > 34).length, p95: pct(frames, 0.95), max: Math.round(Math.max(...frames)) });
const memAfterScroll = await metrics();
log('memory.beforeScroll', memBeforeScroll);
log('memory.afterScroll', memAfterScroll);
// scroll down and up through what is loaded
const tsj = await now();
await page.evaluate(() => {
  const w = window as any; w.__frames = []; let last = performance.now(); w.__frameRun = true;
  const tick = () => { const n = performance.now(); w.__frames.push(n - last); last = n; if (w.__frameRun) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, 1200); await sleep(40); }
for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, -1200); await sleep(40); }
await page.evaluate(() => { (window as any).__frameRun = false; });
const frames2: number[] = await page.evaluate(() => (window as any).__frames);
const long2 = await longSince(tsj);
log('scroll.loadedJank', { long: { ...stats(long2), over50: long2.filter((d: number) => d > 50).length }, frames: { n: frames2.length, dropped: frames2.filter((f) => f > 34).length, p95: pct(frames2, 0.95) } });

// ---------------------------------------------------------------- typing with the big conversation open
const dock = busyPane.locator('.dock textarea, textarea').last();
await dock.click();
const tt = await now();
await page.evaluate(() => {
  const w = window as any; w.__keys = [];
  document.addEventListener('keydown', (e) => { const s = e.timeStamp; requestAnimationFrame(() => setTimeout(() => w.__keys.push(performance.now() - s), 0)); }, true);
});
await page.keyboard.type('Checking the nozzle loads on the pump suction line now', { delay: 60 });
await sleep(400);
const keyLat: number[] = await page.evaluate(() => (window as any).__keys);
const keyEvents: number[] = await page.evaluate((s) => (window as any).__events.filter((e: any) => e.s >= s && /key|input|beforeinput/.test(e.n)).map((e: any) => e.d), tt);
const longType = await longSince(tt);
log('typing.nextPaint.ms', stats(keyLat));
log('typing.eventTiming.over16', stats(keyEvents));
log('typing.longtasks', { ...stats(longType), over50: longType.filter((d: number) => d > 50).length });
await page.keyboard.press('Control+a'); await page.keyboard.press('Delete');

// ---------------------------------------------------------------- search
const searchRuns: number[] = [];
for (const q of ['nozzle', 'flange support', 'spool', 'valve']) {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Shift+F');
  await page.getByLabel('Search messages and files').waitFor();
  const ms = await page.evaluate(async (query) => {
    const w = window as any;
    const input = document.querySelector('input[aria-label="Search messages and files"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    const t = performance.now();
    setter.call(input, query);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await w.__until(() => document.querySelectorAll('.search-hit').length > 0);
    await w.__frame();
    return performance.now() - t;
  }, q);
  searchRuns.push(ms);
  await sleep(300);
}
await page.keyboard.press('Escape');
log('search.ms', stats(searchRuns));

// ---------------------------------------------------------------- memory after navigation
const navEnd = Date.now() + NAV_MIN * 60_000;
const navSamples: Array<{ min: number; totalMB: number; heapMB: number; domNodes: number }> = [];
let lap = 0;
const tn = await now();
while (Date.now() < navEnd) {
  lap++;
  for (const [l, sel] of LENS) { await page.evaluate(([a, b]) => (window as any).__lens(a, b), [l, sel]).catch(() => {}); await sleep(300); }
  for (let i = 0; i < 3; i++) { await openConv(convIds[(lap * 11 + i * 29) % convIds.length], null).catch(() => {}); await sleep(300); }
  await openConv(seed.busyConvId, busyTitle).catch(() => {});
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -900); await sleep(80); }
  if (lap % 3 === 0) { const m = await metrics(); navSamples.push({ min: +((NAV_MIN * 60_000 - (navEnd - Date.now())) / 60_000).toFixed(1), totalMB: m.totalMB, heapMB: m.heapMB, domNodes: m.domNodes }); }
}
const longNav = await longSince(tn);
log('nav.laps', lap);
log('nav.samples', navSamples);
log('nav.longtasks', { ...stats(longNav), over50: longNav.filter((d: number) => d > 50).length });
log('memory.afterNav', await metrics());
try {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  await sleep(500);
  log('memory.afterNavGC', await metrics());
} catch (e) { log('memory.afterNavGC', `n/a: ${(e as Error).message}`); }
stopNoise();

// ---------------------------------------------------------------- hub
const hot = ['conv.list', 'msg.list', 'search', 'directory.list', 'desk.saved', 'remind.list', 'sched.list', 'activity.list', 'activity.tracks', 'cal.list', 'meet.recent', 'rec.list', 'msg.send', 'conv.read'];
log('hub.ops', Object.fromEntries([...opTimes].filter(([k]) => hot.includes(k) || opTimes.get(k)!.length > 5).map(([k, v]) => [k, stats(v)])));
fs.writeFileSync(OUTFILE, JSON.stringify(results, null, 2));

// ---------------------------------------------------------------- budgets
const r = results as any;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const BUDGETS: Array<[string, number, number]> = [
  ['start, warm (ms)', median(r['start.warm.ms']), 1500],
  ['start, cold (ms)', Math.max(...r['start.cold.ms']), 3000],
  ...Object.entries(r['lens.again.ms'] as Record<string, number>).map(([k, v]): [string, number, number] => [`lens switch: ${k} (ms)`, v, 100]),
  ['conversation open, first (ms)', r['conv.open.first.ms'], 150],
  ['conversation open, again (ms, p50)', r['conv.open.again.ms'].p50, 150],
  ['long tasks over 50 ms while scrolling', r['scroll.longtasks'].over50, 0],
  ['long tasks over 50 ms while typing', r['typing.longtasks'].over50, 0],
  ...Object.entries(r['hub.ops'] as Record<string, { p95: number }>).filter(([k]) => hot.includes(k)).map(([k, v]): [string, number, number] => [`hub ${k} p95 (ms)`, v.p95, 30]),
  ['renderer memory after navigating (MB)', r['memory.afterNav'].byType.Tab, 400],
];
console.log('\nbudget'.padEnd(46), 'value'.padStart(9), 'limit'.padStart(9));
let missed = 0;
for (const [name, v, limit] of BUDGETS) { const ok = v <= limit; if (!ok) missed++; console.log(name.padEnd(45), String(Math.round(v)).padStart(9), String(limit).padStart(9), ok ? '' : '  missed'); }
console.log('PERF DONE', OUTFILE, missed ? `${missed} budgets missed` : 'all budgets met');
await app.close();
owner.disconnect();
await hub.stop();
process.exit(args.includes('--check') && missed ? 1 : 0);
