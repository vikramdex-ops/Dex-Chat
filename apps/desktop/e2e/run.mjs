// Runs the end-to-end scripts against the built desktop app, one after another.
//
//   npm run e2e                     every script
//   npm run e2e -- nav search pdf   only these
//   npm run e2e -- --isolated ...   each hub on a free port (apps join by address), for busy machines
//
// Build first (npm run desktop:build; the phone scripts also need npm run build -w @dex/mobile).
// Set DEX_E2E_KEEP=1 to keep the hubs and app profiles of passing scripts (they are removed to save disk).
// On Linux without a display the scripts run under xvfb-run when it is installed. Screenshots and
// hub data go to apps/desktop/e2e/out. A script that lost the hub port to another program is run again.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const HERE = import.meta.dirname;
const LIBS = new Set(['harness', 'tourlib', 'seed', 'officeseed']);
const args = process.argv.slice(2);
const isolated = args.includes('--isolated');
const wanted = args.filter((a) => !a.startsWith('--'));
const all = fs.readdirSync(HERE).filter((f) => f.endsWith('.mts')).map((f) => f.slice(0, -4)).filter((n) => !LIBS.has(n)).sort();
const unknown = wanted.filter((n) => !all.includes(n));
if (unknown.length) { console.error(`No such script: ${unknown.join(', ')}`); process.exit(2); }
const names = wanted.length ? wanted : all;

const xvfb = process.platform === 'linux' && !process.env.DISPLAY && spawnSync('which', ['xvfb-run']).status === 0;
const portFree = () => new Promise((resolve) => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(47900, '0.0.0.0', () => s.close(() => resolve(true))); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runOne(name) {
  const log = path.join(HERE, 'out', `${name}.log`);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const cmd = xvfb ? 'xvfb-run' : process.execPath;
  const argv = xvfb ? ['-a', '-s', '-screen 0 2000x1000x24 -noreset', process.execPath, `${name}.mts`] : [`${name}.mts`];
  return new Promise((resolve) => {
    const started = Date.now();
    const out = fs.createWriteStream(log);
    const p = spawn(cmd, argv, { cwd: HERE, env: { ...process.env, ...(isolated ? { POL1_ISOLATED: '1' } : {}) } });
    p.stdout.pipe(out); p.stderr.pipe(out);
    // a script that printed its PASSED line but hangs while closing is stopped after a while
    const limit = setTimeout(() => p.kill('SIGKILL'), 8 * 60_000);
    p.on('close', (code) => {
      clearTimeout(limit);
      out.end(() => {
        const text = fs.readFileSync(log, 'utf8');
        const passed = /[A-Z0-9]+ E2E PASSED|SHOTS DONE|nav ok/.test(text);
        resolve({ name, code, passed: passed && (code === 0 || code === null), lostPort: /EADDRINUSE/.test(text), secs: Math.round((Date.now() - started) / 1000), log });
      });
    });
  });
}

const results = [];
for (const name of names) {
  let r;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!isolated) for (let i = 0; i < 60 && !(await portFree()); i++) await sleep(5000);
    r = await runOne(name);
    if (!r.lostPort) break;
    await sleep(15000);
  }
  results.push(r);
  // a passing script's hubs and app profiles are not needed again: they fill the disk on long runs
  if (r.passed && !process.env.DEX_E2E_KEEP) {
    for (const d of fs.readdirSync(path.join(HERE, 'out'))) {
      if (/^(hub|ud|gw-state)-/.test(d)) fs.rmSync(path.join(HERE, 'out', d), { recursive: true, force: true });
    }
  }
  console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${name.padEnd(14)} ${String(r.secs).padStart(4)} s${r.passed ? '' : `   see ${path.relative(process.cwd(), r.log)}`}`);
}
const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length} of ${results.length} passed`);
process.exit(failed.length ? 1 : 0);
