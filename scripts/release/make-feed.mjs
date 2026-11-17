// Builds the update feed (<channel>.json) and SHA256SUMS.txt for a release from the files in
// a folder. Used by CI right before publishing to the public release repository.
//
//   node scripts/release/make-feed.mjs --dir release-files --channel beta --version 0.1.12 \
//        --base-url https://github.com/dexterity-admin/dexterity-connect/releases/download/v0.1.12 \
//        --notes-file notes.md --out feed/beta.json
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values: a } = parseArgs({
  options: {
    dir: { type: 'string' }, channel: { type: 'string' }, version: { type: 'string' },
    'base-url': { type: 'string' }, 'notes-file': { type: 'string' }, out: { type: 'string' },
    mandatory: { type: 'boolean', default: false }, 'min-version': { type: 'string' },
  },
});
for (const k of ['dir', 'channel', 'version', 'base-url', 'out']) if (!a[k]) throw new Error(`--${k} is required`);
if (a.channel !== 'stable' && a.channel !== 'beta') throw new Error('--channel must be stable or beta');

const PATTERNS = [
  [/^DexterityConnect-Setup-.*\.exe$/, 'win-x64'],
  [/^DexterityConnect-.*-mac-arm64\.dmg$/, 'mac-arm64'],
  [/^DexterityConnect-.*-mac-x64\.dmg$/, 'mac-x64'],
  [/^DexterityConnect-.*\.apk$/, 'android'],
  // the hub updates itself from its setup (apps/hub/src/hub-update.ts); the hub zip stays a
  // release file for installing by hand, but is not in the feed
  [/^DexterityConnectHub-Setup-\d+(\.\d+){1,3}\.exe$/, 'hub-win-x64'],
];

const assets = [];
const sums = [];
for (const file of fs.readdirSync(a.dir).sort()) {
  const full = path.join(a.dir, file);
  if (!fs.statSync(full).isFile()) continue;
  const data = fs.readFileSync(full);
  sums.push(`${crypto.createHash('sha256').update(data).digest('hex')}  ${file}`);
  const platform = PATTERNS.find(([re]) => re.test(file))?.[1];
  if (!platform) continue;
  assets.push({
    platform, file, url: `${a['base-url']}/${encodeURIComponent(file)}`, size: data.length,
    sha512: crypto.createHash('sha512').update(data).digest('base64'),
  });
}
if (!assets.length) throw new Error(`no installers found in ${a.dir}`);
const hub = assets.find((x) => x.platform === 'hub-win-x64');
if (hub && hub.file !== `DexterityConnectHub-Setup-${a.version}.exe`) throw new Error(`the hub setup ${hub.file} is not this release's version (${a.version})`);
if (!hub) console.warn('note: no DexterityConnectHub-Setup-<version>.exe in this release, so hubs will not update themselves to it');

const feed = {
  schema: 1,
  channel: a.channel,
  version: a.version,
  releasedAt: new Date().toISOString(),
  notes: a['notes-file'] && fs.existsSync(a['notes-file']) ? fs.readFileSync(a['notes-file'], 'utf8').trim() : '',
  ...(a.mandatory ? { mandatory: true } : {}),
  ...(a['min-version'] ? { minVersion: a['min-version'] } : {}),
  assets,
};
fs.mkdirSync(path.dirname(a.out), { recursive: true });
fs.writeFileSync(a.out, `${JSON.stringify(feed, null, 2)}\n`);
fs.writeFileSync(path.join(a.dir, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
console.log(`feed ${a.channel} ${a.version}: ${assets.map((x) => x.platform).join(', ')}`);
