// Bundles the Electron main process and preload into self-contained CommonJS files,
// so the packaged app ships no node_modules.
import { build } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: 'linked',
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  logLevel: 'info',
};

await build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist-electron/main.cjs' });
await build({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist-electron/preload.cjs' });
