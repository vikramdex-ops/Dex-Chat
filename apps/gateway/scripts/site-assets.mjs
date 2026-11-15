// Builds Dexterity Meet's public pages: the landing page (meet/landing.ts and landing.css), the
// meeting itself (meet/room.ts and room.css, loaded only on Join), the webinar pages (webinar/),
// the fonts and the mark. Every file is named after its content (landing.3f9a1c2b.js), so it can be
// cached for a year; the HTML that names them is never cached.
// Used by build-guest.mjs (into the gateway Worker) and by apps/meet-site (the Pages site).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const target = ['chrome110', 'edge110', 'firefox115', 'safari16'];
const common = { bundle: true, minify: true, write: false, logLevel: 'warning', legalComments: 'none', target };
const short = (data) => crypto.createHash('sha256').update(data).digest('hex').slice(0, 10);
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

/** { files: Map<name, { type, data: Buffer }>, names: { landingJs, … } } */
export async function buildSite() {
  const files = new Map();
  const add = (base, ext, data) => {
    const name = `${base}.${short(data)}${ext}`;
    files.set(name, { type: TYPES[ext], data: Buffer.from(data) });
    return name;
  };
  const js = async (entry, base) => {
    const r = await build({ ...common, entryPoints: [path.join(root, entry)], format: 'iife', platform: 'browser' });
    return add(base, '.js', r.outputFiles[0].contents);
  };
  const css = async (entry, base) => {
    // fonts referenced from the styles become files of their own beside them
    const r = await build({ ...common, entryPoints: [path.join(root, entry)], loader: { '.woff2': 'file', '.svg': 'file' }, assetNames: '[name].[hash]', publicPath: '/assets', outdir: path.join(root, '.site-out') });
    let text = '';
    for (const f of r.outputFiles) {
      const name = path.basename(f.path);
      if (name.endsWith('.css')) text = f.text;
      else files.set(name, { type: TYPES[path.extname(name)] ?? 'application/octet-stream', data: Buffer.from(f.contents) });
    }
    return add(base, '.css', text);
  };
  const names = {
    landingJs: await js('meet/landing.ts', 'landing'),
    landingCss: await css('meet/landing.css', 'landing'),
    roomJs: await js('meet/room.ts', 'room'),
    roomCss: await css('meet/room.css', 'room'),
    webinarJs: await js('webinar/page.ts', 'webinar'),
    webinarCss: await css('webinar/page.css', 'webinar'),
    mark: add('mark', '.svg', fs.readFileSync(path.join(root, 'meet/mark.svg'))),
  };
  return { files, names };
}

/** Sizes for the build log: what a first visit downloads before Join, and the meeting's script. */
export function sizes({ files, names }) {
  const kb = (n) => `${(files.get(n).data.length / 1024).toFixed(1)} KB`;
  return `landing ${kb(names.landingJs)} script + ${kb(names.landingCss)} styles; meeting (on Join) ${kb(names.roomJs)} + ${kb(names.roomCss)}; webinar ${kb(names.webinarJs)} + ${kb(names.webinarCss)}`;
}
