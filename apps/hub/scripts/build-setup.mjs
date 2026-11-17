// Builds DexterityConnectHub-Setup-<version>.exe (the hub's Windows installer) with NSIS from the
// assembled hub folder: the same files that go into the hub zip.
//
//   node apps/hub/scripts/build-setup.mjs --stage hub-package/DexterityConnectHub --version 0.1.42 \
//        --out hub-package/DexterityConnectHub-Setup-0.1.42.exe
//
// makensis is found in MAKENSIS, on PATH, in Program Files\NSIS, or in electron-builder's cache
// (the Windows app's build downloads NSIS there). On Linux: apt-get install nsis.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values: a } = parseArgs({ options: { stage: { type: 'string' }, version: { type: 'string' }, out: { type: 'string' } } });
for (const k of ['stage', 'version', 'out']) if (!a[k]) throw new Error(`--${k} is required`);
if (!/^\d+\.\d+\.\d+$/.test(a.version)) throw new Error(`--version must look like 0.1.42 (got ${a.version})`);

const stage = path.resolve(a.stage);
const out = path.resolve(a.out);
const nsi = path.resolve(import.meta.dirname, '../installer/hub-setup.nsi');

// everything the hub zip has, and nothing missing that the service needs
const required = ['DexterityConnectHub.exe', 'DexterityConnectHubService.exe', 'DexterityConnectHubService.xml', 'Install-Hub.ps1', 'mediasoup-worker.exe'];
const entries = fs.readdirSync(stage, { withFileTypes: true });
for (const r of required) if (!entries.some((e) => e.isFile() && e.name === r)) throw new Error(`${r} is missing from ${stage}`);
const sub = entries.find((e) => !e.isFile());
if (sub) throw new Error(`${stage} has a folder (${sub.name}); the setup installs a flat folder only`);
const files = entries.map((e) => e.name).sort();
for (const f of files) if (!/^[\w .\-]+$/.test(f)) throw new Error(`unexpected file name: ${f}`);

// the file lists, so the uninstaller removes exactly what the setup installed (never hub-data)
const gen = fs.mkdtempSync(path.join(os.tmpdir(), 'dexhub-nsis-'));
fs.writeFileSync(path.join(gen, 'files.nsh'), files.map((f) => `File "${path.join(stage, f)}"`).join('\r\n') + '\r\n');
fs.writeFileSync(path.join(gen, 'unfiles.nsh'), files.map((f) => `Delete "$INSTDIR\\${f}"`).join('\r\n') + '\r\n');

// Windows file versions hold four numbers up to 65535; the full version is in the text fields
const [maj, min, build] = a.version.split('.').map(Number);
const viVersion = `${maj}.${min}.${build <= 65535 ? build : 0}.0`;

function findMakensis() {
  if (process.env.MAKENSIS && fs.existsSync(process.env.MAKENSIS)) return process.env.MAKENSIS;
  const exe = process.platform === 'win32' ? 'makensis.exe' : 'makensis';
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, exe))) return path.join(dir, exe);
  }
  if (process.platform !== 'win32') return null;
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'NSIS', exe),
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'NSIS', exe),
  ];
  const cache = path.join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache', 'nsis');
  if (fs.existsSync(cache)) {
    for (const d of fs.readdirSync(cache).sort().reverse()) {
      candidates.push(path.join(cache, d, exe), path.join(cache, d, 'Bin', exe));
    }
  }
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

const makensis = findMakensis();
if (!makensis) {
  throw new Error('makensis (NSIS) was not found. Install NSIS (winget install NSIS.NSIS, or choco install nsis), or set MAKENSIS to makensis.exe.');
}
fs.mkdirSync(path.dirname(out), { recursive: true });
console.log(`building ${path.basename(out)} with ${makensis}`);
try {
  execFileSync(makensis, [
    '-V2', '-INPUTCHARSET', 'UTF8',
    // in CI a warning fails the build; on the office build PC an older NSIS may warn about less
    ...(process.env.CI ? ['-WX'] : []),
    `-DVERSION=${a.version}`, `-DVIVERSION=${viVersion}`,
    `-DSTAGE=${stage}`, `-DGENERATED=${gen}`, `-DOUTFILE=${out}`,
    nsi,
  ], { stdio: 'inherit' });
} finally {
  fs.rmSync(gen, { recursive: true, force: true });
}
console.log(`built ${out} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
