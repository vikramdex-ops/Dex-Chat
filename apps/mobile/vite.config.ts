import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { pdfAssets, pdfjsDir } from '../desktop/pdf-assets.ts';

// The phone app renders the same React UI as the desktop app; only the bridge differs.
export default defineConfig({
  root: 'src',
  base: './',
  plugins: [react({ jsxImportSource: '@dex/i18n' }), pdfAssets({ legacy: true })],
  resolve: {
    alias: {
      '@dex/i18n/jsx-runtime': path.resolve(__dirname, '../desktop/src/renderer/i18n/jsx-runtime.ts'),
      '@dex/i18n/jsx-dev-runtime': path.resolve(__dirname, '../desktop/src/renderer/i18n/jsx-dev-runtime.ts'),
      // PDF.js's build for older Android WebViews (its workers are copied by pdfAssets)
      'pdfjs-dist': path.join(pdfjsDir(), 'legacy/build/pdf.mjs'),
    },
  },
  build: { outDir: '../dist', emptyOutDir: true, target: 'chrome110', assetsInlineLimit: 0 },
});
