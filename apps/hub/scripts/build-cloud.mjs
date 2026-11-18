// Builds the office's two Cloudflare parts into one file the hub carries (dist/cloud-bundle.json),
// so "Set up with Cloudflare" in the Control room can deploy them with nothing but an API token:
//   - the gateway Worker exactly as `wrangler deploy` uploads it (wrangler's own --dry-run bundle of
//     apps/gateway, with its Durable Object binding, migrations and compatibility date from
//     apps/gateway/wrangler.jsonc);
//   - Dexterity Meet's site (apps/meet-site): its files, hashed the way `wrangler pages deploy` hashes
//     them (BLAKE3 of the base64 content and the extension, 32 hex characters), its _headers, and its
//     front door _worker.js with the GATEWAY service binding from apps/meet-site/wrangler.jsonc.
// The hub's deployer (src/cfdeploy.ts) sends these the way wrangler does; nothing here talks to
// Cloudflare. Run by scripts/build.mjs (and embedded in the single-executable hub), or alone:
//   node apps/hub/scripts/build-cloud.mjs [out.json]
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { blake3 } from '@noble/hashes/blake3.js';

const run = promisify(execFile);
const hubRoot = path.resolve(import.meta.dirname, '..');
const repo = path.resolve(hubRoot, '../..');
const gatewayDir = path.join(repo, 'apps/gateway');
const siteDir = path.join(repo, 'apps/meet-site');

/** wrangler.jsonc: JSON with // and /* comments (outside strings) and trailing commas. */
export function readJsonc(file) {
  const src = fs.readFileSync(file, 'utf8');
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2) + 1;
      if (i === 0) break;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** The hash `wrangler pages deploy` gives a file (deploy-helpers ▸ hash.ts). */
export function pagesHash(content, name) {
  const ext = path.extname(name).slice(1);
  return Buffer.from(blake3(new TextEncoder().encode(Buffer.from(content).toString('base64') + ext))).toString('hex').slice(0, 32);
}

const TYPES = { js: 'application/javascript', mjs: 'application/javascript', css: 'text/css', html: 'text/html', svg: 'image/svg+xml', woff2: 'font/woff2', woff: 'font/woff', png: 'image/png', ico: 'image/x-icon', json: 'application/json', txt: 'text/plain', webmanifest: 'application/manifest+json', wasm: 'application/wasm' };
const sha256 = (...parts) => { const h = crypto.createHash('sha256'); for (const p of parts) h.update(p); return h.digest('hex'); };

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative(base, p).split(path.sep).join('/');
    // what wrangler leaves out of the manifest (pages ▸ validate)
    if (['_worker.js', '_redirects', '_headers', '_routes.json', 'functions', '.wrangler'].includes(rel) || e.name === '.DS_Store' || e.name === 'node_modules' || e.name === '.git') continue;
    if (e.isDirectory()) walk(p, base, out); else if (e.isFile()) out.push(rel);
  }
  return out.sort();
}

export async function buildCloudBundle(outFile = path.join(hubRoot, 'dist/cloud-bundle.json')) {
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' };
  const wrangler = path.join(repo, 'node_modules/.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');

  // ---- the gateway Worker: what `wrangler deploy` would upload (it runs the custom build first)
  const gwConfig = readJsonc(path.join(gatewayDir, 'wrangler.jsonc'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dex-cloud-'));
  try {
    await run(wrangler, ['deploy', '--dry-run', '--outdir', tmp], { cwd: gatewayDir, env, shell: process.platform === 'win32', maxBuffer: 16 << 20 });
    const main = fs.readFileSync(path.join(tmp, 'index.js'), 'utf8');
    const metadata = {
      main_module: 'index.js',
      bindings: (gwConfig.durable_objects?.bindings ?? []).map((b) => ({ name: b.name, type: 'durable_object_namespace', class_name: b.class_name })),
      compatibility_date: gwConfig.compatibility_date,
      compatibility_flags: gwConfig.compatibility_flags ?? [],
      ...(gwConfig.observability ? { observability: gwConfig.observability } : {}),
    };
    const migrations = (gwConfig.migrations ?? []).map(({ tag, ...steps }) => ({ tag, ...steps }));
    const gateway = {
      name: gwConfig.name,
      metadata,
      migrations,
      modules: [{ name: 'index.js', type: 'application/javascript+module', text: main }],
      workersDev: gwConfig.workers_dev !== false,
      previews: gwConfig.preview_urls === true,
    };
    gateway.hash = sha256(JSON.stringify(metadata), JSON.stringify(migrations), main).slice(0, 16);

    // ---- the meeting site (Pages): its files, _headers and the front door with its binding
    await run(process.execPath, [path.join(siteDir, 'scripts/build.mjs')], { cwd: repo, env, maxBuffer: 16 << 20 });
    const siteConfigPath = path.join(siteDir, 'wrangler.jsonc');
    const siteConfig = readJsonc(siteConfigPath);
    const dist = path.join(siteDir, siteConfig.pages_build_output_dir ?? 'dist');
    // each file brotli-compressed when that saves something (the hub unpacks it just before the upload:
    // Cloudflare takes the plain file and compresses it itself), so the hub carries a smaller bundle
    const files = walk(dist).map((rel) => {
      const data = fs.readFileSync(path.join(dist, rel));
      const br = zlib.brotliCompressSync(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
      const body = br.length < data.length * 0.9 ? { br: br.toString('base64'), size: data.length } : { b64: data.toString('base64') };
      return { path: `/${rel}`, hash: pagesHash(data, rel), contentType: TYPES[path.extname(rel).slice(1)] ?? 'application/octet-stream', ...body };
    });
    const worker = fs.readFileSync(path.join(dist, '_worker.js'), 'utf8');
    const headers = fs.existsSync(path.join(dist, '_headers')) ? fs.readFileSync(path.join(dist, '_headers'), 'utf8') : null;
    const site = {
      name: siteConfig.name,
      productionBranch: 'main',
      compatibility_date: siteConfig.compatibility_date,
      compatibility_flags: siteConfig.compatibility_flags ?? [],
      services: (siteConfig.services ?? []).map((s) => ({ name: s.binding, type: 'service', service: s.service, ...(s.environment ? { environment: s.environment } : {}) })),
      // wrangler sends these with a deployment made from a wrangler.jsonc (the project's bindings then come from it)
      configHash: sha256(fs.readFileSync(siteConfigPath)),
      outputDir: siteConfig.pages_build_output_dir ?? 'dist',
      files,
      headers,
      worker: { name: '_worker.mjs', text: worker },
    };
    site.hash = sha256(JSON.stringify(files.map((f) => [f.path, f.hash])), worker, headers ?? '', JSON.stringify(site.services), site.compatibility_date).slice(0, 16);
    if (!site.services.some((s) => s.service === gateway.name)) throw new Error(`apps/meet-site/wrangler.jsonc does not bind the gateway (${gateway.name})`);

    const bundle = { format: 1, builtAt: new Date().toISOString(), gateway, site };
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(bundle));
    const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
    console.log(`cloud bundle: gateway ${gateway.hash} (${kb(main.length)}), meeting site ${site.hash} (${files.length} files, ${kb(files.reduce((n, f) => n + (f.size ?? f.b64.length * 0.75), 0))}) → ${path.relative(process.cwd(), outFile)} (${kb(fs.statSync(outFile).size)})`);
    return outFile;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await buildCloudBundle(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
}
