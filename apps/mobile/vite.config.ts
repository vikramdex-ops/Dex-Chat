import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The phone app renders the same React UI as the desktop app; only the bridge differs.
export default defineConfig({
  root: 'src',
  base: './',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true, target: 'chrome110', assetsInlineLimit: 0 },
});
