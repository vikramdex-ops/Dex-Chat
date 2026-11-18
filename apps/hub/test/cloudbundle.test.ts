// The Cloudflare bundle the hub carries is large (the meeting site's files as text): the hub keeps
// only its versions all day, and the parsed bundle only while a setup or update is using it.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('the parsed cloud bundle is let go after a while; its versions stay', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dex-cloudbundle-'));
  const file = path.join(dir, 'cloud-bundle.json');
  const bundle = (g: string) => ({ format: 1, builtAt: '2026-11-18T00:00:00Z', gateway: { name: 'dex-gateway', hash: g, metadata: {}, migrations: [], modules: [], workersDev: true, previews: false }, site: { name: 'dexterity-meet', hash: 'site1', files: [] } });
  fs.writeFileSync(file, JSON.stringify(bundle('gw1')));
  process.env.DEX_CLOUD_BUNDLE = file;
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { loadCloudBundle, cloudBundleVersions } = await import('../src/cfdeploy.ts');
    const a = loadCloudBundle();
    assert.equal(a?.gateway.hash, 'gw1');
    assert.equal(loadCloudBundle(), a, 'kept while in use');
    assert.deepEqual(cloudBundleVersions(), { gateway: 'gw1', site: 'site1' });
    // a new file on disk shows the bundle was read again once let go
    fs.writeFileSync(file, JSON.stringify(bundle('gw2')));
    mock.timers.tick(60_000);
    assert.equal(loadCloudBundle(), a, 'each use keeps it a while longer');
    mock.timers.tick(2 * 60_000 + 1);
    const b = loadCloudBundle();
    assert.notEqual(b, a, 'let go after two minutes unused');
    assert.equal(b?.gateway.hash, 'gw2');
    // the versions shown in the Control room are read once and kept
    assert.deepEqual(cloudBundleVersions(), { gateway: 'gw1', site: 'site1' });
  } finally {
    mock.timers.reset();
    delete process.env.DEX_CLOUD_BUNDLE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('meeting-site files carried compressed are unpacked to the plain file for Cloudflare', async () => {
  const zlib = await import('node:zlib');
  const { siteFileBase64 } = await import('../src/cfdeploy.ts');
  const plain = Buffer.from('body { color: teal; }\n'.repeat(200));
  const br = zlib.brotliCompressSync(plain).toString('base64');
  const base = { path: '/assets/app.css', hash: 'c'.repeat(32), contentType: 'text/css' };
  assert.equal(siteFileBase64({ ...base, br, size: plain.length }), plain.toString('base64'));
  assert.equal(siteFileBase64({ ...base, b64: plain.toString('base64') }), plain.toString('base64'));
  assert.throws(() => siteFileBase64({ ...base, br, size: plain.length - 1 }));
  assert.throws(() => siteFileBase64(base));
});
