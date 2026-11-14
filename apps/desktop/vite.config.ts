import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../../dist-renderer',
    emptyOutDir: true,
    target: 'chrome140',
    assetsInlineLimit: 0,
  },
  server: { port: 5199, strictPort: true, fs: { allow: ['../..', '../../../..'] } },
});
