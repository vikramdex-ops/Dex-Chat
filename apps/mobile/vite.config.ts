import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// The phone app renders the same React UI as the desktop app; only the bridge differs.
export default defineConfig({
  root: 'src',
  base: './',
  plugins: [react({ jsxImportSource: '@dex/i18n' })],
  resolve: {
    alias: {
      '@dex/i18n/jsx-runtime': path.resolve(__dirname, '../desktop/src/renderer/i18n/jsx-runtime.ts'),
      '@dex/i18n/jsx-dev-runtime': path.resolve(__dirname, '../desktop/src/renderer/i18n/jsx-dev-runtime.ts'),
    },
  },
  build: { outDir: '../dist', emptyOutDir: true, target: 'chrome110', assetsInlineLimit: 0 },
});
