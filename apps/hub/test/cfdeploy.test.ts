// "Set up with Cloudflare" against a stand-in for Cloudflare's API (cfmock.ts): the whole run from
// one token (gateway Worker with its Durable Object migration, the pin, workers.dev, the Pages
// project and its direct upload with the GATEWAY binding, outside access on, the hub signed in and
// pinned, the meeting site reaching the gateway, a TURN key that gives credentials), and what goes
// wrong in real life: a missing permission, several accounts, taken names, a failure part-way and
// Retry, running it again (nothing duplicated), the token kept or forgotten, gateway updates.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { CloudflareMock } from './cfmock.ts';
import type { Perm } from './cfmock.ts';
import { office, nextEvent } from './office.ts';
import { cfSlug, pendingMigrations } from '../src/cfdeploy.ts';
import type { CloudBundle, CfEndpoints } from '../src/cfdeploy.ts';
import type { CfSetupView } from '@dex/core';
import type { HubClient } from '@dex/core/client';

const ALL: Perm[] = ['workers', 'pages', 'calls', 'accounts'];
const A1 = '1'.repeat(32);
const A2 = '2'.repeat(32);
const TOKEN = 'tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** A small bundle shaped like scripts/build-cloud.mjs's (the real one is deployed in cfdeploy-workerd.test.ts). */
function bundle(version = 'g1'): CloudBundle {
  return {
    format: 1,
    builtAt: '2026-11-17T00:00:00Z',
    gateway: {
      name: 'dexconnect-gateway', hash: version,
      metadata: { main_module: 'index.js', bindings: [{ name: 'RELAY', type: 'durable_object_namespace', class_name: 'Relay' }], compatibility_date: '2026-10-01', compatibility_flags: [], observability: { enabled: true } },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['Relay'] }],
      modules: [{ name: 'index.js', type: 'application/javascript+module', text: `export default { fetch() { return new Response('${version}'); } }; export class Relay {}` }],
      workersDev: true, previews: false,
    },
    site: {
      name: 'dexterity-meet', hash: `s-${version}`, productionBranch: 'main', compatibility_date: '2026-10-01', compatibility_flags: [],
      services: [{ name: 'GATEWAY', type: 'service', service: 'dexconnect-gateway' }],
      configHash: 'c'.repeat(64), outputDir: 'dist',
      files: [
        { path: '/assets/landing.0001.js', hash: 'a'.repeat(32), contentType: 'application/javascript', b64: Buffer.from('console.log(1)').toString('base64') },
        { path: '/assets/mark.0001.svg', hash: 'b'.repeat(32), contentType: 'image/svg+xml', b64: Buffer.from('<svg/>').toString('base64') },
      ],
      headers: '/assets/*\n  X-Content-Type-Options: nosniff\n',
      worker: { name: '_worker.mjs', text: 'export default { fetch(r, env) { return env.GATEWAY.fetch(r); } };' },
    },
  };
}

let mock: CloudflareMock;
before(async () => { mock = await new CloudflareMock().start(); process.env.DEX_CLOUDFLARE_RTC = mock.rtcBase; });
after(async () => { await mock.stop(); });

/** A fresh account world and an office whose hub talks to the stand-in. */
async function setup(opts: { perms?: Perm[]; accounts?: Array<[string, string, string | null]>; bundle?: () => CloudBundle; accountOwned?: boolean } = {}) {
  mock.accounts.clear(); mock.tokens.clear(); mock.log.length = 0; mock.hubs.length = 0; mock.takenSubdomains.clear(); mock.takenPagesNames.clear();
  for (const [id, name, sub] of opts.accounts ?? [[A1, 'Dexterity Design Services', null]]) mock.addAccount(id, name, sub);
  mock.tokens.set(TOKEN, { perms: opts.perms ?? ALL, accountOwned: opts.accountOwned });
  const seen = { workersDev: [] as string[], pagesDev: [] as string[] };
  const endpoints: CfEndpoints = {
    api: mock.apiBase, rtc: mock.rtcBase,
    workersDev: (script, sub) => { seen.workersDev.push(`${script}.${sub}`); return mock.workersDevUrl; },
    pagesDev: (sub) => { seen.pagesDev.push(sub); return mock.pagesDevUrl; },
  };
  const b = opts.bundle ?? (() => bundle());
  const o = await office({ cloudflare: { endpoints, bundle: b, waits: { addressMs: 4000, connectMs: 8000, deployMs: 2000, pollMs: 50 } } });
  return { ...o, seen };
}

async function settle(c: HubClient): Promise<CfSetupView> {
  for (let i = 0; i < 300; i++) {
    const v = await c.request('admin.cloudflare.get');
    if (v.phase !== 'running') return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the setup did not finish');
}

test('one token: the gateway, its pin, the meeting site and a TURN key, outside access on and checked', async () => {
  const { hub, owner, priya, seen } = await setup();
  // the office had turned new joins from outside off: the setup leaves that alone
  await owner.request('admin.remote.set', { allowJoin: false });
  await assert.rejects(priya.request('admin.cloudflare.start', { token: TOKEN }), /administrators/);
  const first = await owner.request('admin.cloudflare.get');
  assert.equal(first.phase, 'idle');
  assert.equal(first.bundled, true);
  const progress = nextEvent<CfSetupView>(owner, 'admin.cloudflare', (v) => v.steps.some((s) => s.id === 'gateway' && s.state === 'done'));
  const started = await owner.request('admin.cloudflare.start', { token: TOKEN });
  assert.equal(started.phase, 'running');
  await progress;
  const v = await settle(owner);
  assert.equal(v.phase, 'done', JSON.stringify(v.problem));
  assert.ok(v.steps.every((s) => s.state === 'done'));
  assert.deepEqual(v.account, { id: A1, name: 'Dexterity Design Services' });

  const acct = mock.account(A1);
  // the workers.dev name, from the office's name
  assert.equal(acct.subdomain, cfSlug(hub.info.name));
  assert.deepEqual(seen.workersDev, [`dexconnect-gateway.${acct.subdomain}`]);
  // the Worker, as wrangler uploads it: the module, the Durable Object and its first migration, secrets kept
  const script = acct.scripts.get('dexconnect-gateway')!;
  assert.equal(script.metadata.main_module, 'index.js');
  assert.deepEqual(script.metadata.migrations, { new_tag: 'v1', steps: [{ new_sqlite_classes: ['Relay'] }] });
  assert.deepEqual(script.metadata.keep_bindings, ['secret_text', 'secret_key']);
  assert.equal(script.metadata.compatibility_date, '2026-10-01');
  assert.equal(script.modules.get('index.js')?.type, 'application/javascript+module');
  // pinned to this hub, and reachable on workers.dev
  assert.equal(script.secrets.get('HUB_FINGERPRINT'), hub.fingerprint);
  assert.equal(script.workersDev, true);
  // the meeting site: a Pages project, its files by hash, and the front door bound to the gateway
  const proj = acct.projects.get('dexterity-meet')!;
  assert.equal(proj.production_branch, 'main');
  assert.deepEqual(seen.pagesDev, ['dexterity-meet.pages.dev']);
  const dep = proj.deployments.at(-1)!;
  assert.deepEqual(dep.manifest, { '/assets/landing.0001.js': 'a'.repeat(32), '/assets/mark.0001.svg': 'b'.repeat(32) });
  assert.deepEqual(dep.bundle?.metadata.bindings, [{ name: 'GATEWAY', type: 'service', service: 'dexconnect-gateway' }]);
  assert.equal(dep.branch, 'main');
  assert.equal(dep.fields.wrangler_config_hash, 'c'.repeat(64));
  assert.match(dep.headers ?? '', /nosniff/);
  // the hub is on the gateway, which pinned it; outside access on, the device policy as it was
  const rv = await owner.request('admin.remote.get');
  assert.equal(rv.config.enabled, true);
  assert.equal(rv.config.url, mock.workersDevUrl);
  assert.equal(rv.config.siteUrl, mock.pagesDevUrl);
  assert.equal(rv.config.allowJoin, false, 'who may join from outside is untouched');
  assert.equal(rv.status.connected, true);
  assert.equal(rv.status.pinned, true);
  assert.deepEqual(mock.hubs.at(-1), { hubId: hub.info.id, fp: hub.fingerprint, pinned: true });
  // calls: a TURN key, saved as Cloudflare TURN, its token on the hub only
  assert.equal(acct.turnKeys.size, 1);
  const key = [...acct.turnKeys.values()][0];
  assert.equal(key.name, `dexterity-connect-${hub.info.id}`);
  const ice = await owner.request('admin.ice.get');
  assert.equal(ice.mode, 'cloudflare');
  assert.equal(ice.keyId, key.uid);
  assert.equal(ice.hasToken, true);
  assert.equal(v.turnKeyId, key.uid);
  const servers = (await priya.request('room.ice')).iceServers;
  assert.ok(servers.some((s) => [s.urls].flat().some((u) => u.startsWith('turn:'))), 'calls get TURN credentials');
  // the token was used and forgotten
  assert.equal(v.tokenKept, false);
  assert.equal(v.tokenHeld, false);
  assert.equal(JSON.stringify(v).includes(TOKEN), false);
  assert.equal(JSON.stringify(v).includes(key.secret), false);
  assert.equal(hub.store.meta('cf_token', () => ''), '');
  assert.equal(v.updateAvailable, false);
  // the API calls carried the token, and the asset uploads the upload token
  assert.ok(mock.log.filter((l) => l.path.startsWith('/client/v4/accounts')).every((l) => l.auth === TOKEN));
  assert.ok(mock.log.filter((l) => l.path.startsWith('/client/v4/pages/assets')).every((l) => l.auth && l.auth !== TOKEN));
});

test('running it again updates in place: no second project, TURN key or migration', async () => {
  const { owner } = await setup();
  await owner.request('admin.cloudflare.start', { token: TOKEN });
  assert.equal((await settle(owner)).phase, 'done');
  const acct = mock.account(A1);
  const key = [...acct.turnKeys.keys()];
  const sub = acct.subdomain;
  mock.log.length = 0;
  await owner.request('admin.cloudflare.start', { token: TOKEN });
  const v = await settle(owner);
  assert.equal(v.phase, 'done', JSON.stringify(v.problem));
  assert.equal(acct.projects.size, 1);
  assert.equal(acct.projects.get('dexterity-meet')!.deployments.length, 2);
  assert.deepEqual([...acct.turnKeys.keys()], key, 'the working TURN key is kept');
  assert.equal(acct.subdomain, sub);
  const script = acct.scripts.get('dexconnect-gateway')!;
  assert.equal(script.uploads, 2);
  assert.equal(script.metadata.migrations, undefined, 'v1 was applied the first time');
  assert.equal(mock.log.some((l) => l.method === 'PUT' && l.path.endsWith('/workers/subdomain')), false);
  assert.equal(mock.log.some((l) => l.method === 'POST' && l.path.endsWith('/pages/projects')), false);
  // the files Cloudflare already has are not sent again
  assert.equal(mock.log.some((l) => l.path.endsWith('/pages/assets/upload')), false);
});

test('a missing permission says which, and Retry continues from that step', async () => {
  const { owner } = await setup({ perms: ['workers', 'calls', 'accounts'] });
  await owner.request('admin.cloudflare.start', { token: TOKEN });
  const v = await settle(owner);
  assert.equal(v.phase, 'failed');
  assert.deepEqual(v.problem, { step: 'project', code: 'permission', perm: 'pages' });
  assert.equal(v.steps.find((s) => s.id === 'gateway')!.state, 'done');
  assert.equal(v.tokenHeld, true, 'the token stays in memory for Retry');
  assert.equal((await owner.request('admin.remote.get')).config.enabled, false, 'outside access is not turned on half-way');
  // the owner adds the permission in Cloudflare (the same token) and presses Retry
  mock.tokens.get(TOKEN)!.perms.push('pages');
  mock.log.length = 0;
  await owner.request('admin.cloudflare.retry', {});
  const done = await settle(owner);
  assert.equal(done.phase, 'done', JSON.stringify(done.problem));
  assert.equal(mock.log.some((l) => l.method === 'PUT' && /\/workers\/scripts\/[a-z-]+$/.test(l.path)), false, 'the gateway was not uploaded again');
  assert.equal(mock.account(A1).scripts.get('dexconnect-gateway')!.uploads, 1);
  assert.equal(done.tokenHeld, false);
});

test('without the Realtime permission everything else works, and calls say what to add', async () => {
  const { owner } = await setup({ perms: ['workers', 'pages', 'accounts'] });
  await owner.request('admin.cloudflare.start', { token: TOKEN });
  const v = await settle(owner);
  assert.equal(v.phase, 'failed');
  assert.deepEqual(v.problem, { step: 'turn', code: 'permission', perm: 'calls' });
  const rv = await owner.request('admin.remote.get');
  assert.equal(rv.config.enabled, true);
  assert.equal(rv.status.pinned, true);
  assert.equal((await owner.request('admin.ice.get')).mode, 'auto');
});

test('several accounts: the owner picks one', async () => {
  const { owner } = await setup({ accounts: [[A1, 'Personal', null], [A2, 'Dexterity Design Services', 'dexoffice']] });
  await owner.request('admin.cloudflare.start', { token: TOKEN });
  const v = await settle(owner);
  assert.equal(v.phase, 'choose');
  assert.deepEqual(v.accounts.map((a) => a.name), ['Personal', 'Dexterity Design Services']);
  await assert.rejects(owner.request('admin.cloudflare.choose', { accountId: '9'.repeat(32) }), /not one this token/);
  await owner.request('admin.cloudflare.choose', { accountId: A2 });
  const done = await settle(owner);
  assert.equal(done.phase, 'done', JSON.stringify(done.problem));
  assert.equal(done.account?.id, A2);
  assert.equal(mock.account(A2).subdomain, 'dexoffice', 'the account\'s own workers.dev name is used');
  assert.equal(mock.account(A1).scripts.size, 0);
  assert.ok(mock.account(A2).scripts.has('dexconnect-gateway'));
});

test('taken names: another workers.dev name, and the meeting site on the address Cloudflare gives', async () => {
  const { hub, owner, seen } = await setup();
  mock.takenSubdomains.add(cfSlug(hub.info.name));
  mock.takenPagesNames.add('dexterity-meet');
  await owner.request('admin.cloudflare.start', { token: TOKEN });
  const v = await settle(owner);
  assert.equal(v.phase, 'done', JSON.stringify(v.problem));
  const acct = mock.account(A1);
  assert.match(acct.subdomain!, new RegExp(`^${cfSlug(hub.info.name).slice(0, 24)}-[a-z0-9]{4}$`));
  assert.equal(v.projectName, 'dexterity-meet');
  assert.match(seen.pagesDev[0], /^dexterity-meet-[0-9a-f]{4}\.pages\.dev$/, 'the site address comes from the project, not from its name');
});

test('a Pages project of the same name already in the account (an earlier manual deploy) is reused', async () => {
  const { owner } = await setup({ accounts: [[A1, 'Office', 'dexoffice']] });
  mock.account(A1).projects.set('dexterity-meet', { name: 'dexterity-meet', subdomain: 'dexterity-meet.pages.dev', production_branch: 'main', deployment_configs: {}, deployments: [] });
  await owner.request('admin.cloudflare.start', { token: TOKEN });
  const v = await settle(owner);
  assert.equal(v.phase, 'done', JSON.stringify(v.problem));
  assert.equal(mock.account(A1).projects.size, 1);
  assert.equal(mock.account(A1).projects.get('dexterity-meet')!.deployments.length, 1);
});

test('a failure part-way: Retry finishes it without duplicates', async () => {
  const { owner } = await setup();
  mock.failOnce.set('POST /accounts/[0-9a-f]+/pages/projects/[a-z-]+/deployments', { status: 500, code: 8000000, message: 'An unknown error occurred.' });
  await owner.request('admin.cloudflare.start', { token: TOKEN });
  const v = await settle(owner);
  assert.equal(v.phase, 'failed');
  assert.equal(v.problem?.step, 'site');
  assert.equal(v.problem?.code, 'cloudflare');
  assert.match(v.problem?.detail ?? '', /unknown error/);
  await owner.request('admin.cloudflare.retry', {});
  const done = await settle(owner);
  assert.equal(done.phase, 'done', JSON.stringify(done.problem));
  const acct = mock.account(A1);
  assert.equal(acct.projects.size, 1);
  assert.equal(acct.projects.get('dexterity-meet')!.deployments.length, 1);
  assert.equal(acct.scripts.get('dexconnect-gateway')!.uploads, 1);
  assert.equal(acct.turnKeys.size, 1);
});

test('tokens: a wrong one is refused plainly, an account-owned one works, and Retry asks for it again once forgotten', async () => {
  const { hub, owner } = await setup({ accountOwned: true });
  await assert.rejects(owner.request('admin.cloudflare.start', { token: 'not a token' }), /does not look like/);
  await owner.request('admin.cloudflare.start', { token: 'tok_wrongwrongwrongwrongwrong' });
  const bad = await settle(owner);
  assert.deepEqual(bad.problem, { step: 'token', code: 'token' });
  await owner.request('admin.cloudflare.forget');
  await assert.rejects(owner.request('admin.cloudflare.retry', {}), /Paste the Cloudflare API token/);
  await owner.request('admin.cloudflare.retry', { token: TOKEN });
  assert.equal((await settle(owner)).phase, 'done');
  assert.equal(hub.store.meta('cf_token', () => ''), '');
});

test('"Keep for updates": the token stays on the hub (never sent back), and a newer gateway is one click', async () => {
  let version = 'g1';
  const { hub, owner } = await setup({ bundle: () => bundle(version) });
  await owner.request('admin.cloudflare.start', { token: TOKEN, keep: true });
  const v = await settle(owner);
  assert.equal(v.phase, 'done');
  assert.equal(v.tokenKept, true);
  assert.equal(JSON.stringify(v).includes(TOKEN), false);
  assert.equal(hub.store.meta('cf_token', () => ''), TOKEN);
  assert.equal(v.updateAvailable, false);
  // the hub is updated to a version with a newer gateway
  version = 'g2';
  const offered = await owner.request('admin.cloudflare.get');
  assert.equal(offered.updateAvailable, true);
  await owner.request('admin.cloudflare.update', {});
  const updated = await settle(owner);
  assert.equal(updated.phase, 'done', JSON.stringify(updated.problem));
  assert.equal(updated.updateAvailable, false);
  const script = mock.account(A1).scripts.get('dexconnect-gateway')!;
  assert.match(script.modules.get('index.js')!.text, /g2/);
  assert.equal(script.secrets.get('HUB_FINGERPRINT'), hub.fingerprint, 'still pinned');
  assert.equal(mock.account(A1).turnKeys.size, 1);
  // forgetting it: updates then need the token pasted
  const f = await owner.request('admin.cloudflare.forget');
  assert.equal(f.tokenKept, false);
  assert.equal(hub.store.meta('cf_token', () => ''), '');
  version = 'g3';
  await assert.rejects(owner.request('admin.cloudflare.update', {}), /Paste/);
});

test('a hub that was stopped mid-run offers Retry from that step', async () => {
  const { hub, owner } = await setup();
  hub.store.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('cf_setup', JSON.stringify({ phase: 'running', steps: { token: { state: 'done', at: 1 }, account: { state: 'running', at: 2 } } }));
  const { CfSetup } = await import('../src/cfdeploy.ts');
  const again = new CfSetup({
    hubId: 'h', hubName: () => 'x', fingerprint: 'F', version: '0', meta: { get: (k) => hub.store.meta(k, () => ''), set: () => {} }, bundle: () => bundle(),
    connect: () => {}, reconnect: () => {}, gatewayStatus: () => ({ connected: false, pinned: false, error: null, url: null }), turnConfig: () => ({ mode: 'auto', keyId: null, token: null }),
    setTurn: () => {}, changed: () => {}, audit: () => {}, log: () => {},
  });
  const v = again.view();
  assert.equal(v.phase, 'failed');
  assert.deepEqual(v.problem, { step: 'account', code: 'interrupted' });
  void owner;
});

test('migrations: only those the Worker does not have yet, as wrangler sends them', () => {
  const all = [{ tag: 'v1', new_sqlite_classes: ['Relay'] }, { tag: 'v2', renamed_classes: [{ from: 'Relay', to: 'Relay2' }] }];
  assert.deepEqual(pendingMigrations(all, null), { new_tag: 'v2', steps: [{ new_sqlite_classes: ['Relay'] }, { renamed_classes: [{ from: 'Relay', to: 'Relay2' }] }] });
  assert.deepEqual(pendingMigrations(all, 'v1'), { old_tag: 'v1', new_tag: 'v2', steps: [{ renamed_classes: [{ from: 'Relay', to: 'Relay2' }] }] });
  assert.equal(pendingMigrations(all, 'v2'), undefined);
  assert.equal(pendingMigrations([], null), undefined);
  assert.equal(cfSlug('Dexterity Design Services'), 'dexterity-design-services');
  assert.equal(cfSlug('ॐ 42'), 'dexconnect-42');
});
