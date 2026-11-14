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

/** Background blur for calls: MediaPipe's image segmenter (Apache-2.0) and its selfie model,
 * copied beside the app so it works with no internet. */
function segmenterAssets(): Plugin {
  const wasm = path.join(path.dirname(require.resolve('@mediapipe/tasks-vision')), 'wasm');
  const files: Array<[string, string]> = [
    [path.join(wasm, 'vision_wasm_internal.js'), 'vision_wasm_internal.js'],
    [path.join(wasm, 'vision_wasm_internal.wasm'), 'vision_wasm_internal.wasm'],
    [path.resolve(__dirname, 'assets/models/selfie_segmenter.tflite'), 'selfie_segmenter.tflite'],
  ];
  let outDir = '';
  return {
    name: 'dex-segmenter-assets',
    configResolved(c) { outDir = path.resolve(c.root, c.build.outDir); },
    writeBundle() {
      fs.mkdirSync(path.join(outDir, 'segmenter'), { recursive: true });
      for (const [from, to] of files) fs.copyFileSync(from, path.join(outDir, 'segmenter', to));
    },
    configureServer(server) {
      server.middlewares.use('/segmenter/', (req, res, next) => {
        const hit = files.find(([, to]) => req.url === `/${to}`);
        if (!hit) return next();
        res.setHeader('content-type', hit[1].endsWith('.js') ? 'text/javascript' : hit[1].endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
        fs.createReadStream(hit[0]).pipe(res);
      });
    },
  };
}

/** Strong noise suppression in Rooms: RNNoise (BSD-3-Clause) built to WebAssembly with its audio
 * worklet (@sapphi-red/web-noise-suppressor, MIT), copied beside the app like the segmenter. */
function noiseAssets(): Plugin {
  const dist = path.dirname(require.resolve('@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js'));
  const files: Array<[string, string]> = [
    [path.join(dist, 'workletProcessor.js'), 'rnnoiseWorklet.js'],
    [path.join(dist, '..', 'rnnoise.wasm'), 'rnnoise.wasm'],
    [path.join(dist, '..', 'rnnoise_simd.wasm'), 'rnnoise_simd.wasm'],
  ];
  let outDir = '';
  return {
    name: 'dex-noise-assets',
    configResolved(c) { outDir = path.resolve(c.root, c.build.outDir); },
    writeBundle() {
      fs.mkdirSync(path.join(outDir, 'noise'), { recursive: true });
      for (const [from, to] of files) fs.copyFileSync(from, path.join(outDir, 'noise', to));
    },
    configureServer(server) {
      server.middlewares.use('/noise/', (req, res, next) => {
        const hit = files.find(([, to]) => req.url === `/${to}`);
        if (!hit) return next();
        res.setHeader('content-type', hit[1].endsWith('.js') ? 'text/javascript' : 'application/wasm');
        fs.createReadStream(hit[0]).pipe(res);
      });
    },
  };
}

export default defineConfig({
  root: 'src/renderer',
  base: './',
  // the interface's JSX runtime translates literal text into the chosen language (src/renderer/i18n)
  plugins: [react({ jsxImportSource: '@dex/i18n' }), ocrAssets(), segmenterAssets(), noiseAssets()],
  resolve: {
    alias: {
      '@dex/i18n/jsx-runtime': path.resolve(__dirname, 'src/renderer/i18n/jsx-runtime.ts'),
      '@dex/i18n/jsx-dev-runtime': path.resolve(__dirname, 'src/renderer/i18n/jsx-dev-runtime.ts'),
    },
  },
  build: {
    outDir: '../../dist-renderer',
    emptyOutDir: true,
    target: 'chrome140',
    assetsInlineLimit: 0,
  },
  server: { port: 5199, strictPort: true, fs: { allow: ['../..', '../../../..'] } },
});
