import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { pdfAssets, pdfjsDir } from '../desktop/pdf-assets.ts';

/** The phone app has no on-device sentence model: its files are copied into the desktop app only, so
 * Describe-to-Automation always drafted from keywords here. Without this, the drafter's worker
 * still pulled in the ONNX runtime and its two WebAssembly builds (41 MB, about 10 MB of the APK)
 * that could never load anything. The same stand-in as the iPhone app's (apps/web/vite.config.ts). */
function noOnDeviceModel(): Plugin {
  const stub = `self.postMessage({ type: 'failed', message: 'the on-device model is not part of the phone app' });`;
  return { name: 'dex-no-model', enforce: 'pre', load(id) { return /flows[\\/]describe\.worker\.ts/.test(id) ? stub : null; } };
}

// The phone app renders the same React UI as the desktop app; only the bridge differs.
export default defineConfig({
  root: 'src',
  base: './',
  plugins: [react({ jsxImportSource: '@dex/i18n' }), pdfAssets({ legacy: true }), noOnDeviceModel()],
  resolve: {
    alias: {
      '@dex/i18n/jsx-runtime': path.resolve(__dirname, '../desktop/src/renderer/i18n/jsx-runtime.ts'),
      '@dex/i18n/jsx-dev-runtime': path.resolve(__dirname, '../desktop/src/renderer/i18n/jsx-dev-runtime.ts'),
      // PDF.js's build for older Android WebViews (its workers are copied by pdfAssets)
      'pdfjs-dist': path.join(pdfjsDir(), 'legacy/build/pdf.mjs'),
    },
  },
  // the Automations drafter's worker is bundled on its own, with its own plugins
  worker: { plugins: () => [noOnDeviceModel()] },
  build: { outDir: '../dist', emptyOutDir: true, target: 'chrome110', assetsInlineLimit: 0 },
});
