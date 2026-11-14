// Dexterity Connect Hub — entry point. Runs as a Windows service on the office's always-on PC.
//
// Settings (all optional, via environment variables):
//   DEXCONNECT_DATA_DIR   where the database, certificate and files live (default: ./hub-data beside the program)
//   DEXCONNECT_HUB_NAME   name shown to colleagues on first start
//   DEXCONNECT_PORT       TCP port for the app connection (default 47900)
//   DEXCONNECT_LOG_LEVEL  error | warn | info | debug (default info)
import path from 'node:path';
import { Hub } from './hub.ts';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type Level = keyof typeof LEVELS;
const threshold = LEVELS[(process.env.DEXCONNECT_LOG_LEVEL as Level) ?? 'info'] ?? LEVELS.info;

function log(level: Level, msg: string, extra?: Record<string, unknown>): void {
  if (LEVELS[level] > threshold) return;
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));
}

// Packaged as a single executable, process.execPath is the .exe; in development it is node.
const baseDir = process.env.DEXCONNECT_DATA_DIR
  ?? path.join(path.basename(process.execPath).toLowerCase().startsWith('node') ? process.cwd() : path.dirname(process.execPath), 'hub-data');

const hub = new Hub({
  dataDir: baseDir,
  name: process.env.DEXCONNECT_HUB_NAME || undefined,
  port: process.env.DEXCONNECT_PORT ? Number(process.env.DEXCONNECT_PORT) : undefined,
  log,
});

try {
  await hub.start();
  log('info', 'Dexterity Connect Hub ready', { name: hub.info.name, dataDir: baseDir });
} catch (err) {
  log('error', 'hub failed to start', { error: (err as Error).message });
  process.exit(1);
}

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log('info', 'shutting down', { signal });
  await hub.stop();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
