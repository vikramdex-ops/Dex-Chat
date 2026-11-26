// Windows only: the real IT Support service exe against a real hub, without installing anything.
// Builds DexSupport.exe, starts an office hub in this process, runs the exe as this user
// ("--console --config", worker in this session), and checks: the PC appears online for IT, a
// technician connects, screen pictures (JPEG) arrive, a pointer move reaches the real pointer, the
// session ends and the PC lets go. Prints "SUPPORT SERVICE SMOKE PASSED".
//   node apps/desktop/support-service/smoke.ts
// SYSTEM, the secure desktop and Ctrl+Alt+Del need the installed service: docs/HELP-DESK.md, "Elevated control".
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hub } from '../../hub/src/hub.ts';
import { HubClient } from '@dex/core/client';
import { createIdentity } from '@dex/core';
import type { ElevatedSession, MachineFrame, MachineInfo } from '@dex/core';

if (process.platform !== 'win32') { console.log('The IT Support service runs on Windows only; nothing to check here.'); process.exit(0); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexsupport-'));
const exe = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(import.meta.dirname, 'build.ps1'), '-Out', path.join(dir, 'bin')], { encoding: 'utf8' }).trim().split(/\r?\n/).pop()!;
const hub = new Hub({ dataDir: path.join(dir, 'hub'), port: 0, host: '127.0.0.1', discoveryPort: false, updates: false, holidaySeed: false });
await hub.start();
const wait = async (f: () => Promise<boolean> | boolean, what: string, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await f()) return; await new Promise((r) => setTimeout(r, 200)); }
  throw new Error(`Timed out: ${what}`);
};
const join = async (username: string) => {
  const c = new HubClient({ identity: createIdentity(), account: { username, domain: 'DEX', displayName: username, hostname: `${username}-pc` } });
  c.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
  await wait(() => c.state.kind === 'ready' || c.state.kind === 'pending', `${username} connects`);
  return c;
};
const owner = await join('owner');
const ravi = await join('ravi');
for (const d of await owner.request('admin.devices')) if (d.status === 'pending') await owner.request('admin.decide', { deviceId: d.id, approve: true });
await wait(() => ravi.state.kind === 'ready', 'ravi approved');
await owner.request('admin.help.staff', { userId: ravi.session!.me.id, on: true });
await owner.request('admin.policy.set', { assistElevated: true });

const cfg = path.join(dir, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ hub: `127.0.0.1:${hub.port}`, fingerprint: hub.fingerprint }), 'utf8');
const svc = spawn(exe, ['--console', '--config', cfg], { stdio: ['pipe', 'inherit', 'inherit'] });
const pointer = () => execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; "$($p.X),$($p.Y)"'], { encoding: 'utf8' }).trim();
const before = pointer();
let passed = false;
try {
  let list: MachineInfo[] = [];
  await wait(async () => { list = await ravi.request('machine.list'); return list.some((m) => m.online); }, 'the PC appears online');
  const m = list.find((x) => x.online)!;
  console.log(`online: ${m.hostname} (${m.id}) user ${m.consoleUser} version ${m.version}`);
  assert.equal(m.hostname.toUpperCase(), os.hostname().toUpperCase());

  const frames: MachineFrame[] = [];
  const onFrame = (name: string, f: unknown) => { if (name !== 'machine.frame') return; const fr = f as MachineFrame; frames.push(fr); void ravi.request('machine.ack', { s: fr.s, seq: fr.seq }).catch(() => {}); };
  ravi.on('event', onFrame);
  const s: ElevatedSession = await ravi.request('machine.connect', { machineId: m.id });
  await wait(() => frames.length >= 3, 'three pictures arrive');
  const jpeg = Buffer.from(frames[0].d, 'base64');
  assert.equal(jpeg[0], 0xff); assert.equal(jpeg[1], 0xd8);
  console.log(`pictures: ${frames.length}, ${frames[0].w}x${frames[0].h}, ${jpeg.length} bytes`);

  // IT's input waits while the arrival screen is up (12 s): keep sending until it reaches the pointer
  const nudge = setInterval(() => void ravi.request('machine.input', { s: s.id, msg: { k: 'in', e: [{ t: 'move', x: 0.5, y: 0.5 }] } }).catch(() => {}), 1000);
  const vs = execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; $v=[System.Windows.Forms.SystemInformation]::VirtualScreen; "$($v.X),$($v.Y),$($v.Width),$($v.Height)"'], { encoding: 'utf8' }).trim().split(',').map(Number);
  await wait(() => { const [x, y] = pointer().split(',').map(Number); return Math.abs(x - (vs[0] + vs[2] / 2)) <= 2 && Math.abs(y - (vs[1] + vs[3] / 2)) <= 2; }, 'the pointer moves to the middle of the screen', 25000);
  clearInterval(nudge);
  console.log('input: the pointer moved to the middle of the virtual screen');

  await ravi.request('machine.end', { s: s.id });
  const n = frames.length;
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(frames.length <= n + 2, 'no more pictures after the session ended');
  ravi.off('event', onFrame);
  const audit = (await owner.request('admin.audit', { limit: 30 })).map((a: { action: string }) => a.action);
  for (const a of ['machine.added', 'help.elevated.started', 'help.elevated.ended']) assert.ok(audit.includes(a), a);
  console.log('SUPPORT SERVICE SMOKE PASSED');
  passed = true;
} finally {
  const [x, y] = before.split(',');
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y})`]);
  svc.stdin.end('\n');
  await new Promise((r) => { svc.once('exit', r); setTimeout(() => { svc.kill(); r(null); }, 5000); });
  try { execFileSync(exe, ['--drop-dev-key']); } catch { /* gone */ }
  owner.disconnect(); ravi.disconnect();
  await hub.stop();
  if (!passed) { try { console.log('--- service log'); console.log(fs.readFileSync(`${cfg}.log`, 'utf8').split(os.EOL).slice(-30).join(os.EOL)); } catch { /* none */ } }
  fs.rmSync(dir, { recursive: true, force: true });
}
