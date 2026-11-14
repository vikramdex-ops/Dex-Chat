// Builds the hub into dist/hub.cjs (one bundled file). With --sea on Windows it also produces
// DexterityConnectHub.exe: Node's single-executable format, so the hub PC needs no Node install.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [path.join(root, 'src/main.ts')],
  outfile: path.join(dist, 'hub.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'info',
});

if (process.argv.includes('--sea')) {
  const exeName = process.platform === 'win32' ? 'DexterityConnectHub.exe' : 'dexterity-connect-hub';
  const blob = path.join(dist, 'sea-prep.blob');
  const config = path.join(dist, 'sea-config.json');
  fs.writeFileSync(config, JSON.stringify({ main: path.join(dist, 'hub.cjs'), output: blob, disableExperimentalSEAWarning: true }));
  execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });
  const exe = path.join(dist, exeName);
  fs.copyFileSync(process.execPath, exe);
  const args = ['postject', exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
  if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--no-install', ...args], { stdio: 'inherit', shell: process.platform === 'win32' });
  console.log(`built ${exe}`);
}
