// Builds the Dexterity Meet Pages site into dist/: the pages' files under dist/assets (the same
// build the gateway Worker embeds: apps/gateway/scripts/site-assets.mjs), Dexterity Connect for
// iPhone under dist/app (apps/web, built here), the front door dist/_worker.js (src/worker.ts) and
// dist/_headers. The hub's cloud bundle (apps/hub/scripts/build-cloud.mjs) carries all of it, so
// "Update the gateway" in the Control room ships a new iPhone app too.
//   node apps/meet-site/scripts/build.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { buildSite, sizes } from '../../gateway/scripts/site-assets.mjs';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
const site = await buildSite();
for (const [name, f] of site.files) fs.writeFileSync(path.join(dist, 'assets', name), f.data);
// the iPhone web app: built with its own Vite config (apps/web), then copied in
const web = path.resolve(root, '../web');
execFileSync(process.execPath, [path.resolve(root, '../../node_modules/vite/bin/vite.js'), 'build', '--logLevel', 'warn'], { cwd: web, stdio: 'inherit' });
fs.cpSync(path.join(web, 'dist'), path.join(dist, 'app'), { recursive: true });
const big = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (fs.statSync(p).size > 24 * 1024 * 1024) big.push(p); } })(path.join(dist, 'app'));
// Cloudflare Pages takes files of up to 25 MB
if (big.length) throw new Error(`files too big for the meeting site: ${big.join(', ')}`);
await build({ entryPoints: [path.join(root, 'src/worker.ts')], outfile: path.join(dist, '_worker.js'), bundle: true, format: 'esm', target: 'es2022', minify: false, logLevel: 'warning', legalComments: 'none' });
fs.writeFileSync(path.join(dist, '_headers'), `# Cloudflare Pages headers for Dexterity Meet's files (the front door, _worker.js, sets them as well).
/assets/*
  Cache-Control: public, max-age=31536000, immutable
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  Cross-Origin-Resource-Policy: same-origin
  X-Robots-Tag: noindex, nofollow, noarchive
  Strict-Transport-Security: max-age=31536000; includeSubDomains
`);
const appFiles = (function count(d) { return fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(path.join(d, e.name)) : 1), 0); })(path.join(dist, 'app'));
console.log(`meet site in ${path.relative(process.cwd(), dist) || 'dist'}: ${site.files.size} files; ${sizes(site)}; iPhone app ${appFiles} files`);
