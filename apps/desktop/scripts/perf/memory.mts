// Memory and idle CPU of the desktop app against the seeded office (fixture.mts): every Electron
// process at rest after start-up, after opening the busiest conversation, and with the window
// hidden in the tray, plus the main process's own heap and the window's JavaScript heap. Idle CPU
// is measured over 20 s with the office quiet (no background messages): an app at rest should
// cost next to nothing. Build the desktop app first (npm run desktop:build). Under Xvfb:
//
//   PLAYWRIGHT=/path/to/playwright-core/index.mjs xvfb-run -a node apps/desktop/scripts/perf/memory.mts [--label after] [--check]
//
// --check exits with 1 when a budget is missed (BUDGETS at the end). Working sets on Linux count
// shared pages too, and Xvfb draws in software (the GPU process holds its frames), so compare
// runs on one machine rather than with a Windows PC's Task Manager.
import fs from 'node:fs';
import path from 'node:path';
import { seededOffice, DESKTOP, ELECTRON, OUT, sleep } from './fixture.mts';
const pw = (await import(process.env.PLAYWRIGHT ?? 'playwright')).default ?? await import(process.env.PLAYWRIGHT ?? 'playwright');
const electron = pw._electron;

const args = process.argv.slice(2);
const flag = (name: string, def: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const LABEL = flag('label', 'run');
const IDLE_S = Number(flag('idle-seconds', '20'));
const results: Record<string, unknown> = { label: LABEL, at: new Date().toISOString() };
const log = (k: string, v: unknown) => { results[k] = v; console.log(`${k}:`, typeof v === 'object' ? JSON.stringify(v) : v); };

const { hub, owner, userData, seed } = await seededOffice(`mem-${LABEL}`);
const app = await electron.launch({
  executablePath: ELECTRON,
  args: [DESKTOP, `--user-data-dir=${userData}`, '--no-sandbox', '--enable-precise-memory-info'],
  env: { ...process.env, DEXCONNECT_DEV_ACCOUNT: 'priya|Priya Raman', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
});
const proc = app.process();
const elog = fs.createWriteStream(path.join(OUT, `electron-mem-${LABEL}.log`), { flags: 'a' });
proc.stdout?.pipe(elog); proc.stderr?.pipe(elog);
const page = await app.firstWindow();
await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
await page.waitForFunction(() => performance.getEntriesByName('dex:usable').length > 0, null, { timeout: 60000, polling: 50 });

type Proc = { pid: number; type: string; name: string; wsMB: number; cpuS: number };
async function processes(): Promise<Proc[]> {
  return app.evaluate(({ app: a }: any) => a.getAppMetrics().map((p: any) => ({
    pid: p.pid, type: p.type, name: p.name ?? p.serviceName ?? '',
    wsMB: Math.round((p.memory.workingSetSize ?? 0) / 1024),
    cpuS: p.cpu.cumulativeCPUUsage ?? 0,
  })));
}
async function snapshot() {
  const ps = await processes();
  const main = await app.evaluate(() => { const m = process.memoryUsage(); return { rssMB: Math.round(m.rss / 1048576), heapMB: Math.round(m.heapUsed / 1048576), externalMB: Math.round(m.external / 1048576) }; });
  const win = await page.evaluate(() => ({ heapMB: Math.round((performance as any).memory.usedJSHeapSize / 1048576), domNodes: document.getElementsByTagName('*').length }));
  const byType: Record<string, number> = {};
  for (const p of ps) byType[p.type] = (byType[p.type] ?? 0) + p.wsMB;
  return { totalMB: ps.reduce((s, p) => s + p.wsMB, 0), byType, processes: ps.map((p) => `${p.type}${p.name ? `:${p.name}` : ''} ${p.wsMB}`), main, window: win };
}
/** CPU used by all the app's processes over `seconds`, as a percentage of one core. */
async function idleCpu(seconds: number): Promise<{ pct: number; byType: Record<string, number> }> {
  const a = await processes();
  await sleep(seconds * 1000);
  const b = await processes();
  const byType: Record<string, number> = {};
  let total = 0;
  for (const p of b) {
    const was = a.find((x) => x.pid === p.pid)?.cpuS ?? 0;
    const used = Math.max(0, p.cpuS - was);
    total += used;
    byType[p.type] = +((byType[p.type] ?? 0) + (used / seconds) * 100).toFixed(1);
  }
  return { pct: +((total / seconds) * 100).toFixed(1), byType };
}

// at rest after start-up
await sleep(8000);
log('idle.start', await snapshot());
log('idle.cpu', await idleCpu(IDLE_S));

// the busiest conversation open (6,000 messages; the timeline draws a window of them)
await page.evaluate((cid: string) => window.dispatchEvent(new CustomEvent('dex-open', { detail: cid })), seed.busyConvId);
await page.waitForFunction(() => document.querySelectorAll('section.pane .timeline .msg').length > 0, null, { timeout: 30000 });
await sleep(5000);
log('busy.open', await snapshot());
log('busy.cpu', await idleCpu(IDLE_S));

// the window hidden in the tray (closing it with "keep running in the tray")
await app.evaluate(({ BrowserWindow }: any) => { for (const w of BrowserWindow.getAllWindows()) w.hide(); });
await sleep(5000);
log('hidden.cpu', await idleCpu(IDLE_S));
log('hidden', await snapshot().catch(() => null));

const r = results as any;
const BUDGETS: Array<[string, number, number]> = [
  ['all processes at rest after start (MB)', r['idle.start'].totalMB, 900],
  ['window at rest after start (MB)', r['idle.start'].byType.Tab ?? 0, 300],
  ['main process at rest (MB)', r['idle.start'].byType.Browser ?? 0, 260],
  ['window with the busiest conversation (MB)', r['busy.open'].byType.Tab ?? 0, 600],
  ['CPU at rest (% of a core)', r['idle.cpu'].pct, 8],
  ['CPU hidden in the tray (% of a core)', r['hidden.cpu'].pct, 5],
];
console.log('\nbudget'.padEnd(46), 'value'.padStart(9), 'limit'.padStart(9));
let missed = 0;
for (const [name, v, limit] of BUDGETS) { const ok = v <= limit; if (!ok) missed++; console.log(name.padEnd(45), String(Math.round(v * 10) / 10).padStart(9), String(limit).padStart(9), ok ? '' : '  missed'); }
const outFile = path.join(OUT, `memory-${LABEL}.json`);
fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
console.log('MEMORY DONE', outFile, missed ? `${missed} budgets missed` : 'all budgets met');
await app.close();
owner.disconnect();
await hub.stop();
process.exit(args.includes('--check') && missed ? 1 : 0);
