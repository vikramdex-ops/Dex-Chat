import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import type { FileInfo, MiniAppState } from '@dex/core';
import type { HubClient } from '@dex/core/client';
import { MINIAPP_SANDBOX, miniAppCsp, miniAppDocument, miniAppFrame, miniAppFrameMarkup, normaliseHost } from '@dex/core/miniapp';
import type { Hub } from '../src/hub.ts';
import { parseBundle } from '../src/miniapps.ts';
import { writeZip } from '../src/zip.ts';
import { office, me, nextEvent } from './office.ts';

function uploadFile(hub: Hub, c: HubClient, name: string, data: Buffer): Promise<FileInfo> {
  return new Promise((resolve, reject) => {
    const r = https.request({ host: '127.0.0.1', port: hub.port, path: `/files?name=${encodeURIComponent(name)}`, method: 'POST', rejectUnauthorized: false,
      headers: { authorization: `Bearer ${c.session!.fileToken}`, 'content-length': String(data.length) } }, (res) => {
      let raw = '';
      res.on('data', (x) => { raw += x; });
      res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(raw) as FileInfo) : reject(new Error(raw))));
    });
    r.on('error', reject);
    r.end(data);
  });
}

const page = (manifest: Record<string, unknown>, body = '<main>Hello</main><script>dex.context()</script>') =>
  Buffer.from(`<!doctype html><html><head><script type="application/dex-manifest+json">${JSON.stringify(manifest)}</script></head><body>${body}</body></html>`);

test('the frame and its policy: sandboxed scripts only, no network unless granted', () => {
  const f = miniAppFrame('01JCXK3W0ZQ7Y5D4S0M3RTB9A2', 'Calculator', 3);
  assert.equal(f.sandbox, 'allow-scripts');
  assert.equal(MINIAPP_SANDBOX, 'allow-scripts');
  assert.ok(!/allow-same-origin|allow-top-navigation|allow-popups|allow-forms|allow-modals|allow-downloads/.test(f.sandbox));
  assert.equal(f.src, 'dexapp://tool/01JCXK3W0ZQ7Y5D4S0M3RTB9A2?r=3');
  assert.equal(f.referrerPolicy, 'no-referrer');
  for (const feature of ['camera', 'microphone', 'geolocation', 'clipboard-read', 'display-capture']) assert.match(f.allow, new RegExp(`${feature} 'none'`));
  assert.throws(() => miniAppFrame('../../etc', 'x', 1), /instance/);
  const markup = miniAppFrameMarkup('01JCXK3W0ZQ7Y5D4S0M3RTB9A2', 'Calc "x"', 1, 320);
  assert.match(markup, /^<iframe src="dexapp:\/\/tool\/01JCXK3W0ZQ7Y5D4S0M3RTB9A2\?r=1" sandbox="allow-scripts" allow="[^"]+" referrerpolicy="no-referrer" title="Calc &quot;x&quot; \(tool\)" loading="lazy" height="320"><\/iframe>$/);

  const csp = miniAppCsp([]);
  const directives = Object.fromEntries(csp.split('; ').map((d) => { const [k, ...v] = d.split(' '); return [k, v.join(' ')]; }));
  assert.equal(directives['default-src'], "'none'");
  assert.equal(directives['connect-src'], "'none'");
  assert.equal(directives['script-src'], "'unsafe-inline'");
  assert.equal(directives['frame-src'], "'none'");
  assert.equal(directives['form-action'], "'none'");
  assert.equal(directives['base-uri'], "'none'");
  assert.equal(directives['object-src'], "'none'");
  assert.ok(!/unsafe-eval|https?:|\*/.test(csp.replace(/connect-src [^;]+/, '')), 'nothing loads from anywhere');
  assert.match(miniAppCsp(['https://plotter.dex.local:8443/', 'ftp://x', 'https://evil.example/path', '*']), /connect-src https:\/\/plotter\.dex\.local:8443;/);
  assert.equal(normaliseHost('https://*.example.com'), null);
  assert.equal(normaliseHost('https://user:pw@example.com'), null);

  // the page carries the policy before any of the tool's markup, and the API before its scripts
  const doc = miniAppDocument('<!DOCTYPE html><html><head><script>evil()</script></head></html>', csp);
  assert.ok(doc.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, '&quot;')}">`));
  assert.ok(doc.indexOf('Content-Security-Policy') < doc.indexOf('evil()'));
  assert.ok(doc.indexOf("Object.defineProperty(window, 'dex'") < doc.indexOf('evil()'));
});

test('bundles: one page or a zip, inlined; outside resources and unsafe paths are refused', () => {
  const zip = writeZip([
    ['site-photos/manifest.json', Buffer.from(JSON.stringify({ id: 'site-photos', name: 'Site photos', version: '2.1.0', permissions: ['state', 'files'], hosts: ['https://photos.office.local'], height: 2000 }))],
    ['site-photos/index.html', Buffer.from('<html><head><link rel="stylesheet" href="css/app.css"></head><body><img src="img/logo.png"><script src="app.js"></script></body></html>')],
    ['site-photos/app.js', Buffer.from('const img = document.querySelector("img"); img.src = "other.png"; console.log("</script>")')],
    ['site-photos/css/app.css', Buffer.from('body { background: url(../img/logo.png) }')],
    ['site-photos/img/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  ]);
  const b = parseBundle('site-photos.zip', zip);
  assert.equal(b.manifest.id, 'site-photos');
  assert.deepEqual(b.manifest.permissions.sort(), ['files', 'network', 'state']);
  assert.deepEqual(b.manifest.hosts, ['https://photos.office.local']);
  assert.equal(b.manifest.height, 900, 'heights are capped');
  assert.match(b.html, /<style>body \{ background: url\("data:image\/png;base64,iVBORw=="\) \}<\/style>/);
  assert.match(b.html, /<img src="data:image\/png;base64,iVBORw==">/);
  assert.match(b.html, /img\.src = "other\.png"; console\.log\("<\\\/script>"\)/, 'scripts are inlined as they are');
  assert.throws(() => parseBundle('x.zip', writeZip([['manifest.json', Buffer.from('{"id":"abc","name":"A"}')], ['index.html', Buffer.from('<script src="https://cdn.example/x.js"></script>')]])), /from elsewhere/);
  assert.throws(() => parseBundle('x.zip', writeZip([['../manifest.json', Buffer.from('{}')]])), /not a safe path/);
  assert.throws(() => parseBundle('x.zip', writeZip([['index.html', Buffer.from('<body></body>')]])), /manifest\.json/);
  assert.throws(() => parseBundle('x.html', Buffer.from('<body>no manifest</body>')), /dex-manifest/);
  assert.throws(() => parseBundle('x.html', page({ id: 'dex-calculator', name: 'Fake' })), /come with Dexterity Connect/);
  assert.throws(() => parseBundle('x.html', page({ id: 'abc', name: 'A', permissions: ['camera'] })), /Unknown permission/);
  assert.throws(() => parseBundle('x.html', page({ id: 'abc', name: 'A', hosts: ['*.example.com'] })), /not a host/);
  assert.throws(() => parseBundle('x.html', page({ id: 'abc', name: 'A' }, '<img src="http://tracker.example/p.gif">')), /from elsewhere/);
  assert.throws(() => parseBundle('x.zip', Buffer.from('PK\u0003\u0004 not really')), /zip/);
});

test('administrators review a tool: permissions, hosts, approve, reject, switch off, all audited', async () => {
  const { hub, owner, priya } = await office();
  const builtins = await priya.request('miniapp.list');
  assert.deepEqual(builtins.map((a) => a.id).sort(), ['dex-calculator', 'dex-diagram', 'dex-punchlist', 'dex-table', 'dex-units']);
  assert.ok(builtins.every((a) => a.status === 'approved' && a.builtin));

  const html = page({ id: 'rfi-log', name: 'RFI log', version: '1.0.0', description: 'Track RFIs', permissions: ['state', 'post'], hosts: ['https://docs.office.local', 'https://other.office.local'] });
  const mine = await uploadFile(hub, priya, 'rfi-log.html', html);
  await assert.rejects(priya.request('admin.miniapps.upload', { fileId: mine.id }), /administrators/);
  const file = await uploadFile(hub, owner, 'rfi-log.html', html);
  await assert.rejects(owner.request('admin.miniapps.upload', { fileId: mine.id }), /Upload the bundle again/, 'only your own upload');
  const up = await owner.request('admin.miniapps.upload', { fileId: file.id });
  assert.equal(up.status, 'pending');
  assert.deepEqual(up.requestedHosts, ['https://docs.office.local', 'https://other.office.local']);
  assert.deepEqual(up.hosts, []);
  assert.ok(!(await priya.request('miniapp.list')).some((a) => a.id === 'rfi-log'), 'not offered until approved');
  const space = await owner.request('conv.create', { kind: 'space', name: 'RFIs', members: [me(priya)] });
  await assert.rejects(priya.request('miniapp.add', { convId: space.id, appId: 'rfi-log', clientId: 'a' }), /not available/);
  assert.match((await owner.request('admin.miniapps.source', { id: 'rfi-log' })).html, /RFI log/);
  await assert.rejects(priya.request('admin.miniapps.review', { id: 'rfi-log', approve: true }), /administrators/);

  // approve, granting one of the two hosts it asked for
  const ok = await owner.request('admin.miniapps.review', { id: 'rfi-log', approve: true, hosts: ['https://docs.office.local', 'https://not-asked.example'], note: 'Docs only' });
  assert.equal(ok.status, 'approved');
  assert.deepEqual(ok.hosts, ['https://docs.office.local']);
  const msg = await priya.request('miniapp.add', { convId: space.id, appId: 'rfi-log', clientId: 'add-1' });
  assert.equal(msg.miniapp?.appId, 'rfi-log');
  assert.equal(msg.miniapp?.available, true);
  assert.deepEqual((await priya.request('miniapp.add', { convId: space.id, appId: 'rfi-log', clientId: 'add-1' })).id, msg.id, 'a retry does not add it twice');
  const bundle = await priya.request('miniapp.bundle', { instanceId: msg.miniapp!.instanceId });
  assert.match(bundle.csp, /connect-src https:\/\/docs\.office\.local;/);
  assert.ok(bundle.html.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"'));
  await assert.rejects(priya.request('miniapp.state.get', { instanceId: 'nope' }), /not found/);

  // switched off: the card says so and the tool cannot run
  const refreshed = nextEvent<{ id: string; miniapp?: { available: boolean } }>(priya, 'msg.updated', (m) => m.id === msg.id);
  await owner.request('admin.miniapps.enable', { id: 'rfi-log', enabled: false });
  assert.equal((await refreshed).miniapp?.available, false);
  await assert.rejects(priya.request('miniapp.bundle', { instanceId: msg.miniapp!.instanceId }), /switched this tool off/);
  await assert.rejects(priya.request('miniapp.add', { convId: space.id, appId: 'rfi-log', clientId: 'add-2' }), /not available/);
  await owner.request('admin.miniapps.enable', { id: 'rfi-log', enabled: true });

  // a new version goes back for review
  const v2 = await uploadFile(hub, owner, 'rfi-log.html', page({ id: 'rfi-log', name: 'RFI log', version: '1.1.0', permissions: ['state', 'post', 'members'] }));
  assert.equal((await owner.request('admin.miniapps.upload', { fileId: v2.id })).status, 'pending');
  await assert.rejects(priya.request('miniapp.bundle', { instanceId: msg.miniapp!.instanceId }), /waiting for an administrator/);
  assert.equal((await owner.request('admin.miniapps.review', { id: 'rfi-log', approve: false, note: 'Asks for too much' })).status, 'rejected');
  await assert.rejects(owner.request('admin.miniapps.review', { id: 'dex-calculator', approve: false }), /approved already/);

  const actions = (await owner.request('admin.audit', { limit: 50 })).filter((e) => e.action.startsWith('miniapp.')).map((e) => e.action);
  for (const a of ['miniapp.uploaded', 'miniapp.approved', 'miniapp.added', 'miniapp.disabled', 'miniapp.enabled', 'miniapp.rejected']) assert.ok(actions.includes(a), a);
  const approved = (await owner.request('admin.audit', { limit: 50 })).find((e) => e.action === 'miniapp.approved');
  assert.deepEqual((approved?.detail as { hosts: string[] }).hosts, ['https://docs.office.local']);
});

test('a tool\'s shared state reaches everyone in the conversation: last writer wins, with versions and a 64 KB cap', async () => {
  const { hub, owner, priya, ravi } = await office();
  const space = await owner.request('conv.create', { kind: 'space', name: 'Pump house', members: [me(priya), me(ravi)] });
  const msg = await priya.request('miniapp.add', { convId: space.id, appId: 'dex-calculator', clientId: 'calc' });
  const id = msg.miniapp!.instanceId;
  assert.deepEqual(await ravi.request('miniapp.state.get', { instanceId: id }), { instanceId: id, convId: space.id, state: null, version: 0, updatedBy: null, updatedAt: null });
  const seen = nextEvent<MiniAppState>(ravi, 'miniapp.state', (s) => s.instanceId === id);
  const w1 = await priya.request('miniapp.state.set', { instanceId: id, state: { tape: [{ id: 'a', expr: '12 × 3', result: '36' }] }, baseVersion: 0 });
  assert.equal(w1.version, 1);
  assert.equal(w1.conflict, false);
  const ev = await seen;
  assert.equal(ev.version, 1);
  assert.equal(ev.updatedBy, me(priya));
  assert.deepEqual(ev.state, { tape: [{ id: 'a', expr: '12 × 3', result: '36' }] });
  // Ravi writes from version 0 too: his write wins, and he is told someone wrote in between
  const w2 = await ravi.request('miniapp.state.set', { instanceId: id, state: { tape: [] }, baseVersion: 0 });
  assert.equal(w2.version, 2);
  assert.equal(w2.conflict, true);
  assert.deepEqual((await priya.request('miniapp.state.get', { instanceId: id })).state, { tape: [] });
  await assert.rejects(priya.request('miniapp.state.set', { instanceId: id, state: { big: 'x'.repeat(64 * 1024) } }), /up to 64 KB/);
  assert.equal((await priya.request('miniapp.state.get', { instanceId: id })).version, 2, 'a refused write changes nothing');
  // people outside the conversation cannot reach it
  const other = await owner.request('conv.create', { kind: 'space', name: 'Elsewhere', members: [me(priya)] });
  const there = await priya.request('miniapp.add', { convId: other.id, appId: 'dex-calculator', clientId: 'calc2' });
  await assert.rejects(ravi.request('miniapp.state.get', { instanceId: there.miniapp!.instanceId }), /not found/);
  await assert.rejects(ravi.request('miniapp.bundle', { instanceId: there.miniapp!.instanceId }), /not found/);
  // each tool added keeps its own state
  assert.equal((await priya.request('miniapp.state.get', { instanceId: there.miniapp!.instanceId })).version, 0);
  // a tool without the state permission cannot keep any
  const file = await (async () => {
    const html = page({ id: 'poster', name: 'Poster', permissions: ['post'] });
    return new Promise<FileInfo>((resolve, reject) => {
      const r = https.request({ host: '127.0.0.1', port: hub.port, path: '/files?name=poster.html', method: 'POST', rejectUnauthorized: false, headers: { authorization: `Bearer ${owner.session!.fileToken}`, 'content-length': String(html.length) } }, (res) => { let raw = ''; res.on('data', (x) => { raw += x; }); res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(raw)) : reject(new Error(raw)))); });
      r.on('error', reject); r.end(html);
    });
  })();
  await owner.request('admin.miniapps.upload', { fileId: file.id });
  await owner.request('admin.miniapps.review', { id: 'poster', approve: true });
  const p = await priya.request('miniapp.add', { convId: space.id, appId: 'poster', clientId: 'p1' });
  await assert.rejects(priya.request('miniapp.state.set', { instanceId: p.miniapp!.instanceId, state: 1 }), /not approved to use state/);
  await assert.rejects(priya.request('miniapp.add', { convId: 'nope', appId: 'dex-calculator', clientId: 'z' }), /not found/i);
});
