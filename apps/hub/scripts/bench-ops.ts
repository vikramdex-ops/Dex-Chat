// Hub latency for the operations the apps call most, against the seeded office
// (scripts/seed-office.ts): a real hub, a real client over the WebSocket, p50 and p95 per op.
//
//   node apps/hub/scripts/bench-ops.ts [--runs 40] [--json out.json] [--check]
//
// --check exits with 1 when any hot op's p95 is over the budget (30 ms).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIdentity } from '@dex/core';
import { HubClient } from '@dex/core/client';
import { Hub } from '../src/hub.ts';
import { seedOffice } from './seed-office.ts';

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const RUNS = Number(flag('runs') ?? 40);
const BUDGET = 30;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dex-bench-'));
const hub = new Hub({ dataDir: dir, name: 'Bench Hub', updates: false, port: 0, discoveryPort: false, relay: false, log: () => {} });
await hub.start();

async function client(username: string, displayName: string): Promise<HubClient> {
  const c = new HubClient({ identity: createIdentity(), account: { username, domain: 'DEX', displayName, hostname: `${username.toUpperCase()}-PC` } });
  c.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
  await new Promise<void>((res) => { const on = (s: { kind: string }) => { if (s.kind === 'ready') { c.off('state', on); res(); } }; c.on('state', on); });
  return c;
}
const owner = await client('vikram', 'Vikram Shah');
owner.on('event', (name: string, d: { id: string }) => { if (name === 'admin.pending') void owner.request('admin.decide', { deviceId: d.id, approve: true }).catch(() => {}); });
const me = await client('priya', 'Priya Raman');
const meId = (me as unknown as { session?: { me: { id: string } } }).session?.me.id
  ?? (await me.request('directory.list')).users.find((u) => u.account.endsWith('priya'))!.id;
const ownerId = (await owner.request('directory.list')).users.find((u) => u.account.endsWith('vikram'))!.id;
const t0 = performance.now();
const seed = seedOffice(hub.store.db, { meId, ownerId, filesDir: path.join(dir, 'files') });
console.log(`seeded ${seed.messages} messages, ${seed.conversations} conversations, ${seed.users} people in ${Math.round(performance.now() - t0)} ms`);

const convs = await me.request('conv.list');
const busy = seed.busyConvId;
const latest = await me.request('msg.list', { convId: busy, limit: 60 });
// a page about 5,000 messages back
const old = hub.store.db.prepare('SELECT id FROM messages WHERE conv_id = ? AND parent_id IS NULL ORDER BY id DESC LIMIT 1 OFFSET 5000').get(busy) as { id: string };
const withTrack = hub.store.db.prepare('SELECT parent_id AS id FROM messages WHERE conv_id = ? AND parent_id IS NOT NULL GROUP BY parent_id ORDER BY COUNT(*) DESC LIMIT 1').get(busy) as { id: string };
const now = Date.now();
const weekStart = now - ((new Date().getDay() + 6) % 7) * 86400_000;

type Case = [string, string, () => unknown];
const cases: Case[] = [
  ['conv.list', 'conv.list', () => ({})],
  ['msg.list (latest, busy Space)', 'msg.list', () => ({ convId: busy, limit: 60 })],
  ['msg.list (5,000 back)', 'msg.list', () => ({ convId: busy, before: old.id, limit: 60 })],
  ['msg.list (side-track)', 'msg.list', () => ({ convId: busy, parentId: withTrack.id, limit: 60 })],
  ['msg.list (Direct)', 'msg.list', () => ({ convId: seed.busyDirectId, limit: 60 })],
  ['search (word)', 'search', () => ({ q: seed.searchWord })],
  ['search (two words)', 'search', () => ({ q: 'valve flange' })],
  ['search (word, one Space)', 'search', () => ({ q: 'pipe', convId: busy })],
  ['search (from a person)', 'search', () => ({ q: '', from: ownerId })],
  ['search (files only)', 'search', () => ({ q: '', hasFile: true })],
  ['directory.list', 'directory.list', () => ({})],
  ['desk.saved', 'desk.saved', () => ({})],
  ['remind.list', 'remind.list', () => ({ includeDone: true })],
  ['sched.list', 'sched.list', () => ({})],
  ['activity.list', 'activity.list', () => ({ kind: 'all' })],
  ['activity.tracks', 'activity.tracks', () => ({})],
  ['cal.list (week)', 'cal.list', () => ({ from: weekStart, to: weekStart + 7 * 86400_000 })],
  ['cal.list (agenda, 60 days)', 'cal.list', () => ({ from: now, to: now + 60 * 86400_000 })],
  ['meet.recent', 'meet.recent', () => ({ limit: 30 })],
  ['rec.list', 'rec.list', () => ({})],
  ['file.list', 'file.list', () => ({ convId: busy })],
  ['msg.pins', 'msg.pins', () => ({ convId: busy })],
  ['tags.top', 'tags.top', () => ({})],
  ['conv.read', 'conv.read', () => ({ convId: busy, messageId: latest.messages.at(-1)!.id })],
  ['msg.send', 'msg.send', () => ({ convId: busy, body: `Bench message ${Math.random()}`, clientId: `b-${Math.random()}` })],
];

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const results: Array<{ name: string; op: string; p50: number; p95: number; max: number; bytes: number }> = [];
for (const [name, op, params] of cases) {
  const times: number[] = [];
  let bytes = 0;
  for (let i = 0; i < RUNS + 3; i++) {
    const t = performance.now();
    const res = await me.request(op as never, params() as never);
    const dt = performance.now() - t;
    if (i >= 3) times.push(dt); // the first few warm SQLite's page cache
    if (i === 0) bytes = JSON.stringify(res ?? null).length;
  }
  results.push({ name, op, p50: +pct(times, 0.5).toFixed(1), p95: +pct(times, 0.95).toFixed(1), max: +Math.max(...times).toFixed(1), bytes });
}
console.log(`conversations visible: ${convs.length}`);
console.log('op'.padEnd(32), 'p50 ms'.padStart(8), 'p95 ms'.padStart(8), 'max ms'.padStart(8), 'KB'.padStart(8));
for (const r of results) console.log(r.name.padEnd(32), String(r.p50).padStart(8), String(r.p95).padStart(8), String(r.max).padStart(8), (r.bytes / 1024).toFixed(1).padStart(8), r.p95 > BUDGET ? '  over budget' : '');
const out = flag('json');
if (out) fs.writeFileSync(out, JSON.stringify({ seed, results }, null, 2));
me.disconnect(); owner.disconnect();
await hub.stop();
fs.rmSync(dir, { recursive: true, force: true });
if (args.includes('--check') && results.some((r) => r.p95 > BUDGET)) process.exit(1);
