// The real Cloudflare parts, deployed by "Set up with Cloudflare" and run in Cloudflare's own local
// runtime: the hub's package is built (scripts/build-cloud.mjs: wrangler's bundle of the gateway,
// the meeting site's files and front door), the hub deploys it to the API stand-in (cfmock.ts),
// and what it uploaded is started with `wrangler dev` (workerd) exactly as received: the gateway
// module with its Durable Object, migration and the HUB_FINGERPRINT the hub set; the site's
// _worker module with its files and the GATEWAY service binding the deployment carried. The hub
// then signs in to that gateway and must be pinned, and the site must reach it through the binding.
// Skipped when wrangler cannot run here (as the gateway's own tests are).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { CloudflareMock } from './cfmock.ts';
import type { MockProject, MockScript } from './cfmock.ts';
import { office } from './office.ts';
import { siteFileBase64 } from '../src/cfdeploy.ts';
import type { CloudBundle } from '../src/cfdeploy.ts';
import type { CfSetupView } from '@dex/core';

const repo = path.resolve(import.meta.dirname, '../../..');
// wrangler's own script under this node: the .bin shim is a shell script that Windows cannot spawn
const wrangler = path.join(repo, 'node_modules/wrangler/bin/wrangler.js');
const win = process.platform === 'win32';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dexcf-workerd-'));
const registry = path.join(work, 'registry');
let mock: CloudflareMock;
let bundle: CloudBundle | null = null;
let skip: string | false = false;
const children: ChildProcess[] = [];

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const p = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

/** `wrangler dev` on a generated config, in its own process group. */
function dev(dir: string, port: number, inspector: number): ChildProcess {
  const child = spawn(process.execPath, [wrangler, 'dev', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspector), '--config', path.join(dir, 'wrangler.jsonc'), '--persist-to', path.join(work, `state-${path.basename(dir)}`), '--show-interactive-dev-session=false', '--log-level', 'info'],
    { cwd: dir, detached: !win, windowsHide: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', WRANGLER_REGISTRY_PATH: registry }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', () => { /* reported through 'exit' */ });
  const log = fs.createWriteStream(path.join(work, `${path.basename(dir)}.log`));
  child.stdout!.pipe(log); child.stderr!.pipe(log);
  children.push(child);
  return child;
}
// the whole tree (wrangler and its workerd): a process group here, taskkill /T on Windows
const kill = (c: ChildProcess) => { try { if (win) spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); else process.kill(-c.pid!, 'SIGKILL'); } catch { /* gone */ } };

before(async () => {
  try {
    const out = path.join(work, 'cloud-bundle.json');
    await promisify(execFile)(process.execPath, [path.join(repo, 'apps/hub/scripts/build-cloud.mjs'), out], { cwd: repo, maxBuffer: 16 << 20, timeout: 180_000 });
    bundle = JSON.parse(fs.readFileSync(out, 'utf8')) as CloudBundle;
  } catch (err) {
    skip = `the Cloudflare parts could not be built here: ${(err as Error).message.slice(0, 200)}`;
  }
  mock = await new CloudflareMock().start();
});
after(async () => {
  for (const c of children) kill(c);
  await mock?.stop();
  fs.rmSync(work, { recursive: true, force: true });
});

test('the deployed gateway and site run in workerd: the hub signs in pinned, the site reaches it through its binding', { timeout: 300_000 }, async (t) => {
  if (skip || !bundle) { t.skip(String(skip)); return; }
  const A = 'd'.repeat(32);
  const TOKEN = 'tok_workerd_0123456789abcdefghij';
  mock.addAccount(A, 'Dexterity Design Services', null);
  mock.tokens.set(TOKEN, { perms: ['workers', 'pages', 'calls', 'accounts'] });
  const gwPort = await freePort();
  const sitePort = await freePort();
  const gwInspector = await freePort();
  const siteInspector = await freePort();
  let gwChild: ChildProcess | null = null;
  let started: Promise<void> | null = null;

  // the gateway, as uploaded: once the pin is set, run that exact module with that secret
  mock.onScript = (name: string, s: MockScript) => {
    const fp = s.secrets.get('HUB_FINGERPRINT');
    if (!fp) return;
    const dir = path.join(work, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, m] of s.modules) fs.writeFileSync(path.join(dir, file), m.text);
    const meta = s.metadata as { main_module: string; compatibility_date: string; bindings: Array<{ name: string; type: string; class_name?: string }>; migrations?: { new_tag: string; steps: unknown[] } };
    const config = {
      name, main: meta.main_module, compatibility_date: meta.compatibility_date, no_bundle: true,
      rules: [{ type: 'ESModule', globs: [meta.main_module] }],
      durable_objects: { bindings: meta.bindings.filter((b) => b.type === 'durable_object_namespace').map((b) => ({ name: b.name, class_name: b.class_name })) },
      migrations: (meta.migrations?.steps ?? []).map((st, i) => ({ tag: `v${i + 1}`, ...(st as object) })),
      vars: { HUB_FINGERPRINT: fp },
    };
    fs.writeFileSync(path.join(dir, 'wrangler.jsonc'), JSON.stringify(config));
    if (gwChild) kill(gwChild);
    gwChild = dev(dir, gwPort, gwInspector);
  };
  // the site, as deployed: its files, and the front door bound to the gateway by the bundle's metadata
  mock.onDeployment = (proj: MockProject, dep: MockProject['deployments'][number]) => {
    const dir = path.join(work, proj.name);
    for (const [p, h] of Object.entries(dep.manifest)) {
      const file = path.join(dir, 'public', p);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(mock.assets.get(h)!.b64, 'base64'));
    }
    const meta = dep.bundle!.metadata as { main_module: string; compatibility_date: string; bindings: Array<{ name: string; type: string; service?: string }> };
    fs.writeFileSync(path.join(dir, meta.main_module), dep.bundle!.main);
    const config = {
      name: `${proj.name}-local`, main: meta.main_module, compatibility_date: meta.compatibility_date, no_bundle: true,
      rules: [{ type: 'ESModule', globs: [meta.main_module] }],
      assets: { directory: 'public', binding: 'ASSETS', run_worker_first: true },
      services: meta.bindings.filter((b) => b.type === 'service').map((b) => ({ binding: b.name, service: b.service })),
    };
    fs.writeFileSync(path.join(dir, 'wrangler.jsonc'), JSON.stringify(config));
    if (!started) { dev(dir, sitePort, siteInspector); started = Promise.resolve(); }
  };

  const { hub, owner } = await office({
    cloudflare: {
      bundle: () => bundle,
      endpoints: { api: mock.apiBase, rtc: mock.rtcBase, workersDev: () => `http://127.0.0.1:${gwPort}`, pagesDev: () => `http://127.0.0.1:${sitePort}` },
      waits: { addressMs: 60_000, connectMs: 60_000, deployMs: 2000, pollMs: 500 },
    },
  });
  await owner.request('admin.cloudflare.start', { token: TOKEN });
  let v: CfSetupView = await owner.request('admin.cloudflare.get');
  for (let i = 0; i < 600 && v.phase === 'running'; i++) { await new Promise((r) => setTimeout(r, 500)); v = await owner.request('admin.cloudflare.get'); }
  if (v.phase !== 'done') for (const l of fs.readdirSync(work).filter((f) => f.endsWith('.log'))) console.error(l, fs.readFileSync(path.join(work, l), 'utf8').slice(-3000));
  assert.equal(v.phase, 'done', JSON.stringify(v.problem));

  // the real gateway pinned this hub (it answered "ready" with pinned, from the HUB_FINGERPRINT the hub set)
  const rv = await owner.request('admin.remote.get');
  assert.equal(rv.status.connected, true);
  assert.equal(rv.status.pinned, true);
  // the site: its own files, the gateway's answers through the binding, and a meeting page with the site's CSP
  const site = `http://127.0.0.1:${sitePort}`;
  assert.equal(await (await fetch(`${site}/health`)).text(), 'Dexterity Connect gateway\n');
  const asset = bundle.site.files.find((f) => f.path.endsWith('.css'))!;
  const a = await fetch(`${site}${asset.path}`);
  assert.equal(a.status, 200);
  assert.equal(Buffer.from(await a.arrayBuffer()).toString('base64'), siteFileBase64(asset));
  const page = await fetch(`${site}/482-913-207`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') ?? '', /connect-src/);
  // a hub with another certificate is refused by the pinned gateway
  const other = await office({ cloudflare: { bundle: () => bundle, endpoints: { api: mock.apiBase, rtc: mock.rtcBase, workersDev: () => '', pagesDev: () => '' } } });
  await other.owner.request('admin.remote.set', { url: `http://127.0.0.1:${gwPort}`, enabled: true });
  let st = (await other.owner.request('admin.remote.get')).status;
  for (let i = 0; i < 40 && !st.error; i++) { await new Promise((r) => setTimeout(r, 250)); st = (await other.owner.request('admin.remote.get')).status; }
  assert.equal(st.connected, false);
  assert.match(st.error ?? '', /another hub/);
  void hub;
});
