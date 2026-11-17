// Builds the Dexterity Meet Pages site into dist/: the pages' files under dist/assets (the same
// build the gateway Worker embeds: apps/gateway/scripts/site-assets.mjs), the front door
// dist/_worker.js (src/worker.ts) and dist/_headers.
//   node apps/meet-site/scripts/build.mjs
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { buildSite, sizes } from '../../gateway/scripts/site-assets.mjs';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
const site = await buildSite();
for (const [name, f] of site.files) fs.writeFileSync(path.join(dist, 'assets', name), f.data);
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
console.log(`meet site in ${path.relative(process.cwd(), dist) || 'dist'}: ${site.files.size} files; ${sizes(site)}`);
