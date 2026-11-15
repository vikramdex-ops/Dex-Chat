// PDF.js (pdfjs-dist, Apache-2.0) beside the app: its parser worker, the worker that draws pages,
// the image decoders (WebAssembly), the standard fonts and the character maps for Asian text,
// copied to <out>/pdfjs/ so PDFs open with nothing downloaded. The library itself is bundled by
// Vite into a chunk that loads the first time a PDF is opened. Used by the desktop and phone
// builds (the phone takes the "legacy" build for older Android WebViews).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Plugin } from 'vite';

const require = createRequire(import.meta.url);

export function pdfjsDir(): string {
  return path.dirname(require.resolve('pdfjs-dist/package.json'));
}

/** [source file, path under pdfjs/] for every file PDF.js may ask for. */
function pdfFiles(legacy: boolean): Array<[string, string]> {
  const root = pdfjsDir();
  const build = path.join(root, legacy ? 'legacy/build' : 'build');
  const out: Array<[string, string]> = [
    [path.join(build, 'pdf.worker.min.mjs'), 'pdf.worker.min.mjs'],
    [path.join(build, 'pdf.renderer.min.mjs'), 'pdf.renderer.min.mjs'],
    [path.join(root, 'LICENSE'), 'LICENSE'],
  ];
  const dir = (sub: string, keep: (f: string) => boolean = () => true) => {
    for (const f of fs.readdirSync(path.join(root, sub))) if (keep(f)) out.push([path.join(root, sub, f), `${sub}/${f}`]);
  };
  // JavaScript in PDFs is never run, so QuickJS is left out
  dir('wasm', (f) => !/quickjs/i.test(f));
  // the Foxit standard fonts (BSD-3-Clause). Liberation Sans (GPL-2.0 with a font exception) is
  // left out: PDF.js uses the PC's own Arial or Helvetica for those, and that file only after them
  dir('standard_fonts', (f) => !/liberation/i.test(f));
  dir('cmaps');
  dir('iccs');
  return out;
}

const TYPES: Record<string, string> = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.icc': 'application/vnd.iccprofile' };

export function pdfAssets(opts: { legacy?: boolean } = {}): Plugin {
  const files = pdfFiles(!!opts.legacy);
  const byPath = new Map(files.map(([from, to]) => [`/${to}`, from]));
  let outDir = '';
  return {
    name: 'dex-pdf-assets',
    configResolved(c) { outDir = path.resolve(c.root, c.build.outDir); },
    writeBundle() {
      for (const [from, to] of files) {
        const target = path.join(outDir, 'pdfjs', to);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(from, target);
      }
    },
    configureServer(server) {
      server.middlewares.use('/pdfjs/', (req, res, next) => {
        const from = byPath.get(decodeURIComponent(req.url?.split('?')[0] ?? ''));
        if (!from) return next();
        res.setHeader('content-type', TYPES[path.extname(from)] ?? 'application/octet-stream');
        fs.createReadStream(from).pipe(res);
      });
    },
  };
}
