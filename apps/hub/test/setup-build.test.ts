// The hub's Windows setup: the scripts Windows PowerShell 5.1 runs must stay ASCII, and when NSIS is
// installed (apt-get install nsis) the installer is built from a dummy hub folder and checked.
// Installing it for real happens on Windows only: the hub-smoke job in .github/workflows/build.yml.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const hub = path.resolve(import.meta.dirname, '..');
const packaging = path.join(hub, 'packaging');

test('the setup scripts are plain ASCII (Windows PowerShell 5.1 reads them as ANSI)', () => {
  for (const f of ['Install-Hub.ps1', 'Install-Hub.cmd', 'Uninstall-Hub.cmd', 'Restore-Hub.cmd', 'README-HUB.txt', 'DexterityConnectHubService.xml']) {
    const bytes = fs.readFileSync(path.join(packaging, f));
    const bad = bytes.findIndex((b) => b > 0x7e || (b < 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09));
    assert.equal(bad, -1, `${f} has a non-ASCII byte at ${bad}`);
  }
  for (const f of ['hub-setup.nsi', 'smoke-test.ps1']) {
    const bytes = fs.readFileSync(path.join(hub, 'installer', f));
    assert.equal(bytes.findIndex((b) => b > 0x7e), -1, `${f} must be ASCII`);
  }
});

test('the service definition starts late, restarts three times and takes its data folder from setup', () => {
  const xml = fs.readFileSync(path.join(packaging, 'DexterityConnectHubService.xml'), 'utf8');
  assert.match(xml, /<delayedAutoStart>true<\/delayedAutoStart>/);
  assert.equal(xml.match(/<onfailure action="restart"/g)?.length, 3);
  assert.match(xml, /<env name="DEXCONNECT_DATA_DIR" value="%BASE%\\hub-data" \/>/);
});

const makensis = spawnSync('makensis', ['-VERSION'], { encoding: 'utf8' });
test('the setup builds with NSIS and asks for administrator rights', { skip: makensis.status !== 0 && 'makensis is not installed' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexhub-setup-'));
  try {
    const stage = path.join(dir, 'DexterityConnectHub');
    fs.mkdirSync(stage);
    for (const f of fs.readdirSync(packaging)) fs.copyFileSync(path.join(packaging, f), path.join(stage, f));
    for (const f of ['DexterityConnectHub.exe', 'mediasoup-worker.exe', 'DexterityConnectHubService.exe']) fs.writeFileSync(path.join(stage, f), `dummy ${f}`);
    const out = path.join(dir, 'DexterityConnectHub-Setup-0.1.26111712.exe');
    execFileSync(process.execPath, [path.join(hub, 'scripts/build-setup.mjs'), '--stage', stage, '--version', '0.1.26111712', '--out', out],
      { stdio: 'pipe', env: { ...process.env, CI: '1' } });
    const exe = fs.readFileSync(out);
    assert.equal(exe.subarray(0, 2).toString('latin1'), 'MZ');
    assert.ok(exe.includes('requireAdministrator'), 'the manifest asks for administrator rights');
    assert.ok(exe.includes(Buffer.from('0.1.26111712', 'utf16le')), 'the version is in the file properties');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
