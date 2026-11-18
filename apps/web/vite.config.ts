import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { pdfAssets, pdfjsDir } from '../desktop/pdf-assets.ts';
// @ts-expect-error a plain .mjs helper without types
import { compose, decodePng, encodePng, resize } from './scripts/png.mjs';

// Dexterity Connect for iPhone: the same React UI as the desktop and Android apps, with a bridge
// built from browser APIs (src/bridge.ts). The office's meeting site serves it at /app/
// (apps/meet-site copies dist/ there), so it is part of the bundle the hub deploys to Cloudflare.

const BASE = '/app/';
const brand = path.resolve(__dirname, '../../brand/icon');
const LIGHT = '#eef3f3';
const DARK = '#0e1b1d';
const TEAL = '#1c7680';

/** Launch screens for the iPhones and iPads Safari asks for by exact size (CSS pixels × scale, portrait). */
const SCREENS: Array<[number, number, number]> = [
  [430, 932, 3], [393, 852, 3], [390, 844, 3], [428, 926, 3], [375, 812, 3], [414, 896, 3], [414, 896, 2], [375, 667, 2], [414, 736, 3],
  [810, 1080, 2], [820, 1180, 2], [834, 1194, 2], [1024, 1366, 2],
];

/** The app's icon cropped to its drawn body (the PNG has a transparent margin). */
function iconBody() {
  const img = decodePng(fs.readFileSync(path.join(brand, 'icon-1024.png')));
  let x0 = img.width, y0 = img.height, x1 = 0, y1 = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (img.data[(y * img.width + x) * 4 + 3] > 200) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  }
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) out.set(img.data.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4), y * w * 4);
  return { full: img, body: { width: w, height: h, data: out } };
}

/**
 * The installable parts, made at build time from the app's own icon (brand/icon): the Home Screen
 * icons, the launch screens, the web app manifest, and the service worker with the list of the
 * app shell's files and the build's version (a new build is a new version, so the app knows).
 */
function webApp(): Plugin {
  let version = 'dev';
  return {
    name: 'dex-web-app',
    transformIndexHtml(html) {
      const startup = SCREENS.flatMap(([w, hgt, s]) => (['light', 'dark'] as const).map((theme) =>
        `<link rel="apple-touch-startup-image" href="${BASE}splash/${theme}-${w * s}x${hgt * s}.png" media="(device-width: ${w}px) and (device-height: ${hgt}px) and (-webkit-device-pixel-ratio: ${s}) and (orientation: portrait) and (prefers-color-scheme: ${theme})">`));
      return html.replace('<!--startup-->', startup.join('\n  '));
    },
    async generateBundle(_o, bundle) {
      // the version: the build's own content
      const h = crypto.createHash('sha256');
      for (const name of Object.keys(bundle).sort()) { const f = bundle[name]; h.update(name); h.update(f.type === 'chunk' ? f.code : typeof f.source === 'string' ? f.source : Buffer.from(f.source)); }
      version = `${JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')).version}+${h.digest('hex').slice(0, 8)}`;
      for (const f of Object.values(bundle)) if (f.type === 'chunk') f.code = f.code.replaceAll('__APP_VERSION_PLACEHOLDER__', version);

      const png = (fileName: string, img: unknown) => this.emitFile({ type: 'asset', fileName, source: encodePng(img) });
      const { full, body } = iconBody();
      png('icon-192.png', resize(full, 192, 192));
      png('icon-512.png', resize(full, 512, 512));
      // maskable and Home Screen: the body fills the square (iOS rounds the corners itself)
      png('icon-maskable-512.png', compose(512, 512, TEAL, resize(body, 410, 410), 51, 51));
      png('apple-touch-icon.png', compose(180, 180, TEAL, resize(body, 180, 180), 0, 0));
      for (const [w, hgt, s] of SCREENS) {
        const W = w * s, H = hgt * s, size = Math.round(Math.min(W, H) * 0.28);
        const mark = resize(full, size, size);
        for (const [theme, bg] of [['light', LIGHT], ['dark', DARK]] as const) {
          const name = `splash/${theme}-${W}x${H}.png`;
          png(name, compose(W, H, bg, mark, Math.round((W - size) / 2), Math.round((H - size) / 2.4)));
        }
      }
      this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: JSON.stringify({
        name: 'Dexterity Connect', short_name: 'Dexterity', id: BASE, start_url: BASE, scope: BASE, display: 'standalone',
        background_color: LIGHT, theme_color: TEAL, orientation: 'any', lang: 'en',
        description: 'Messages, calls and files from your office, on your iPhone.',
        icons: [
          { src: `${BASE}icon-192.png`, sizes: '192x192', type: 'image/png' },
          { src: `${BASE}icon-512.png`, sizes: '512x512', type: 'image/png' },
          { src: `${BASE}icon-maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      }, null, 2) });

      // the app shell: the page, the entry script and what it loads straight away, its styles and fonts
      // the page is kept as /app/ itself ('' here): the meeting site serves index.html there and redirects the longer name
      const shell = new Set<string>(['', 'manifest.webmanifest', 'icon-192.png', 'apple-touch-icon.png']);
      const walk = (name: string) => {
        const f = bundle[name];
        if (!f || f.type !== 'chunk' || shell.has(name)) return;
        shell.add(name);
        const meta = (f as { viteMetadata?: { importedCss: Set<string>; importedAssets: Set<string> } }).viteMetadata;
        for (const c of meta?.importedCss ?? []) shell.add(c);
        for (const a of meta?.importedAssets ?? []) shell.add(a);
        for (const i of f.imports) walk(i);
      };
      // the entry, and what it loads as soon as it starts (the interface itself, the language): not what loads only when used
      for (const [name, f] of Object.entries(bundle)) if (f.type === 'chunk' && f.isEntry) { walk(name); for (const d of f.dynamicImports) walk(d); }
      for (const [name, f] of Object.entries(bundle)) if (f.type === 'asset' && /\.woff2$/.test(name) && /latin-wght/.test(name)) shell.add(name);

      const sw = await build({
        entryPoints: [path.resolve(__dirname, 'src/sw.ts')], bundle: true, write: false, minify: true, format: 'iife', target: ['safari16'],
        define: { __APP_VERSION__: JSON.stringify(version), __PRECACHE__: JSON.stringify([...shell].sort()) }, logLevel: 'warning', legalComments: 'none',
      });
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: sw.outputFiles[0].text });

      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version }) });
    },
  };
}

/** Describe-to-Automation's on-device model needs a 26 MB WebAssembly runtime: too big for the
 * meeting site (Pages takes files up to 25 MB) and for a phone. The iPhone app drafts rules with the
 * keyword ranker, which the drafter says it falls back to. */
function noOnDeviceModel(): Plugin {
  const stub = `self.postMessage({ type: 'failed', message: 'the on-device model is not part of the iPhone app' });`;
  return { name: 'dex-no-model', enforce: 'pre', load(id) { return /flows[\\/]describe\.worker\.ts/.test(id) ? stub : null; } };
}

export default defineConfig({
  root: 'src',
  base: BASE,
  define: { __APP_VERSION__: JSON.stringify('__APP_VERSION_PLACEHOLDER__') },
  plugins: [react({ jsxImportSource: '@dex/i18n' }), noOnDeviceModel(), pdfAssets({ legacy: true }), webApp()],
  worker: { format: 'es', plugins: () => [noOnDeviceModel()] },
  resolve: {
    alias: {
      '@dex/i18n/jsx-runtime': path.resolve(__dirname, '../desktop/src/renderer/i18n/jsx-runtime.ts'),
      '@dex/i18n/jsx-dev-runtime': path.resolve(__dirname, '../desktop/src/renderer/i18n/jsx-dev-runtime.ts'),
      // PDF.js's build for older browsers (Safari on iOS 16), as on Android
      'pdfjs-dist': path.join(pdfjsDir(), 'legacy/build/pdf.mjs'),
    },
  },
  build: { outDir: '../dist', emptyOutDir: true, target: ['safari16', 'chrome110'], assetsInlineLimit: 0 },
});
