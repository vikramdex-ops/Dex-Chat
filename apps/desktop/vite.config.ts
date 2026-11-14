import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** The OCR engine (Tesseract, Apache-2.0) and its English model, copied beside the app so images
 * are read on this PC with nothing downloaded. */
function ocrAssets(): Plugin {
  const files: Array<[string, string]> = [
    [require.resolve('tesseract.js/dist/worker.min.js'), 'worker.min.js'],
    [path.join(path.dirname(require.resolve('tesseract.js-core/package.json')), 'tesseract-core-simd-lstm.wasm.js'), 'tesseract-core-simd-lstm.wasm.js'],
    [path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int', 'eng.traineddata.gz'), 'eng.traineddata.gz'],
  ];
  let outDir = '';
  return {
    name: 'dex-ocr-assets',
    configResolved(c) { outDir = path.resolve(c.root, c.build.outDir); },
    writeBundle() {
      fs.mkdirSync(path.join(outDir, 'ocr'), { recursive: true });
      for (const [from, to] of files) fs.copyFileSync(from, path.join(outDir, 'ocr', to));
    },
    configureServer(server) {
      server.middlewares.use('/ocr/', (req, res, next) => {
        const hit = files.find(([, to]) => req.url === `/${to}`);
        if (!hit) return next();
        res.setHeader('content-type', hit[1].endsWith('.js') ? 'text/javascript' : 'application/gzip');
        fs.createReadStream(hit[0]).pipe(res);
      });
    },
  };
}

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react(), ocrAssets()],
  build: {
    outDir: '../../dist-renderer',
    emptyOutDir: true,
    target: 'chrome140',
    assetsInlineLimit: 0,
  },
  server: { port: 5199, strictPort: true, fs: { allow: ['../..', '../../../..'] } },
});
