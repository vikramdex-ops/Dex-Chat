// Windows, by hand, with an administrator: the INSTALLED IT Support service (SYSTEM) against a hub.
// Starts an office hub in this process on port 47950 and prints the install command; once the
// service is online it connects as IT and checks what only SYSTEM can do: a picture of the desktop,
// Ctrl+Alt+Del (SendSAS) bringing up the Windows security screen, a picture of that secure desktop
// with the hub told the PC is on it, Escape typed there taking it away again, and the end. Pictures
// are saved next to the hub's data for a person to look at. Prints "ELEVATED CHECK PASSED".
//   node apps/desktop/support-service/elevated-check.ts [outDir]
// Then remove the service: "%ProgramFiles%\Dexterity Connect Support\DexSupport.exe" --uninstall (as administrator).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hub } from '../../hub/src/hub.ts';
import { HubClient } from '@dex/core/client';
import { createIdentity } from '@dex/core';
import type { ElevatedSession, MachineFrame, MachineInfo } from '@dex/core';

const out = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dexsupport-check-'));
fs.mkdirSync(out, { recursive: true });
const hub = new Hub({ dataDir: path.join(out, 'hub'), port: 47950, host: '127.0.0.1', discoveryPort: false, updates: false, holidaySeed: false });
await hub.start();
fs.writeFileSync(path.join(out, 'hub.txt'), `127.0.0.1:${hub.port} ${hub.fingerprint}`, 'utf8');
console.log(`HUB 127.0.0.1:${hub.port} ${hub.fingerprint}`);
console.log(`install (administrator): DexSupport.exe --install --hub 127.0.0.1:${hub.port} --fingerprint ${hub.fingerprint}`);
const wait = async (f: () => Promise<boolean> | boolean, what: string, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await f()) return; await new Promise((r) => setTimeout(r, 250)); }
  throw new Error(`Timed out: ${what}`);
};
const join = async (username: string) => {
  const c = new HubClient({ identity: createIdentity(), account: { username, domain: 'DEX', displayName: username, hostname: `${username}-pc` } });
  c.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
  await wait(() => c.state.kind === 'ready' || c.state.kind === 'pending', `${username} connects`);
  return c;
};
const owner = await join('owner');
const it = await join('it');
for (const d of await owner.request('admin.devices')) if (d.status === 'pending') await owner.request('admin.decide', { deviceId: d.id, approve: true });
await wait(() => it.state.kind === 'ready', 'IT approved');
await owner.request('admin.help.staff', { userId: it.session!.me.id, on: true });
await owner.request('admin.policy.set', { assistElevated: true, assistPrivacy: true });
const frames: MachineFrame[] = [];
it.on('event', (name: string, f: unknown) => {
  if (name !== 'machine.frame') return;
  const fr = f as MachineFrame;
  frames.push(fr);
  if (frames.length > 50) frames.shift();
  void it.request('machine.ack', { s: fr.s, seq: fr.seq }).catch(() => {});
});
const pc = async () => ((await it.request('machine.list')) as MachineInfo[]).find((m) => m.online) ?? null;
const save = (name: string) => { const f = frames.at(-1)!; fs.writeFileSync(path.join(out, name), Buffer.from(f.d, 'base64')); return f; };
const nextFrame = async (after: number) => { await wait(() => frames.length > 0 && frames.at(-1)!.seq > after, 'a new picture', 15000); return frames.at(-1)!; };
let passed = false;
try {
  console.log('waiting for the installed service to come online (5 minutes)…');
  await wait(async () => !!(await pc()), 'the service comes online', 300_000);
  const m = (await pc())!;
  console.log(`online: ${m.hostname} ${m.id} version ${m.version} user ${m.consoleUser} locked ${m.locked}`);
  // with the privacy screen: the person sees the cover, IT's pictures must not
  const s: ElevatedSession = await it.request('machine.connect', { machineId: m.id, privacy: true });
  const first = await nextFrame(0);
  save('1-desktop.jpg');
  console.log(`desktop picture ${first.w}x${first.h}`);

  await it.request('machine.sas', { s: s.id });
  await wait(async () => (await pc())?.locked === true, 'the PC reports the secure desktop (Winlogon) after Ctrl+Alt+Del', 15000);
  await new Promise((r) => setTimeout(r, 1500));
  const sec = await nextFrame(frames.at(-1)!.seq);
  save('2-secure-desktop.jpg');
  console.log(`secure desktop picture ${sec.w}x${sec.h}: the service follows Winlogon`);

  await it.request('machine.input', { s: s.id, msg: { k: 'in', e: [{ t: 'key', code: 'Escape', down: true }, { t: 'key', code: 'Escape', down: false }] } });
  await wait(async () => (await pc())?.locked === false, 'Escape typed on the secure desktop takes it away', 15000);
  await new Promise((r) => setTimeout(r, 1500));
  await nextFrame(frames.at(-1)!.seq);
  save('3-back.jpg');
  console.log('input on the secure desktop works: back on the desktop');

  const after = ((await it.request('machine.mine')) as ElevatedSession[]).find((x) => x.id === s.id);
  assert.equal(after?.privacy, true, 'the PC kept the privacy screen out of the picture (it did not report it could not)');
  console.log('privacy screen: on as SYSTEM, still on after Ctrl+Alt+Del');
  await it.request('machine.end', { s: s.id });
  const audit = (await owner.request('admin.audit', { limit: 40 })).map((a: { action: string }) => a.action);
  for (const a of ['machine.added', 'help.elevated.started', 'help.elevated.sas', 'help.elevated.ended']) assert.ok(audit.includes(a), a);
  console.log(`pictures in ${out}`);
  console.log('ELEVATED CHECK PASSED');
  passed = true;
} finally {
  if (!passed) console.log(`pictures so far in ${out}`);
  owner.disconnect(); it.disconnect();
  await hub.stop();
}
