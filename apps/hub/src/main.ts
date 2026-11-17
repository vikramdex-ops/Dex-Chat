// Dexterity Connect Hub — entry point. Runs as a Windows service on the office's always-on PC.
//
// Settings (all optional, via environment variables):
//   DEXCONNECT_DATA_DIR   where the database, certificate and files live (default: the folder named in
//                         hub-data-location.txt beside the program, else ./hub-data beside it; see data-dir.ts)
//   DEXCONNECT_HUB_NAME   name shown to colleagues on first start
//   DEXCONNECT_PORT       TCP port for the app connection (default 47900)
//   DEXCONNECT_LOG_LEVEL  error | warn | info | debug (default info)
//
// Restoring a backup (the hub service stopped first; see docs/BACKUP.md):
//   DexterityConnectHub.exe --restore "E:\DexConnectBackup"            the newest copy there
//   DexterityConnectHub.exe --restore "E:\DexConnectBackup\snapshots\2026-11-15_0200"   that copy
import { DEFAULT_HUB_PORT } from '@dex/core';
import { Hub } from './hub.ts';
import { restoreBackup } from './backup.ts';
import { resolveDataDir } from './data-dir.ts';

// node:sqlite prints an "experimental" notice on every start; it is stable for our use.
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.warn(w); });

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type Level = keyof typeof LEVELS;
const threshold = LEVELS[(process.env.DEXCONNECT_LOG_LEVEL as Level) ?? 'info'] ?? LEVELS.info;

function log(level: Level, msg: string, extra?: Record<string, unknown>): void {
  if (LEVELS[level] > threshold) return;
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));
}

// Packaged as a single executable, process.execPath is the .exe; in development it is node.
const baseDir = resolveDataDir({ env: process.env, execPath: process.execPath, cwd: process.cwd() });

const restoreAt = process.argv.indexOf('--restore');
if (restoreAt >= 0) {
  const from = process.argv[restoreAt + 1];
  if (!from || from.startsWith('--')) {
    console.error('Give the backup folder: --restore "E:\\DexConnectBackup" (the newest copy there) or one of the folders inside its "snapshots" folder.');
    process.exit(2);
  }
  const port = process.env.DEXCONNECT_PORT ? Number(process.env.DEXCONNECT_PORT) : DEFAULT_HUB_PORT;
  restoreBackup({ from, dataDir: baseDir, port, log: (line) => console.log(line) }).then(
    (r) => {
      console.log('');
      console.log(`Done. ${r.hubName} is restored to its backup of ${new Date(r.takenAt).toLocaleString('en-IN')}.`);
      if (r.aside) console.log(`What was in the data folder before is kept in ${r.aside}. Delete it once the hub works.`);
      console.log('Start the hub service again (Services > Dexterity Connect Hub > Start, or "DexterityConnectHubService.exe start").');
      process.exit(0);
    },
    (err: Error) => {
      console.error(`The restore did not run: ${err.message}`);
      process.exit(1);
    },
  );
} else {
  startHub();
}

function startHub(): void {
  const hub = new Hub({
    dataDir: baseDir,
    name: process.env.DEXCONNECT_HUB_NAME || undefined,
    port: process.env.DEXCONNECT_PORT ? Number(process.env.DEXCONNECT_PORT) : undefined,
    log,
  });

  hub.start().then(
    () => log('info', 'Dexterity Connect Hub ready', { name: hub.info.name, dataDir: baseDir }),
    (err: Error) => {
      log('error', 'hub failed to start', { error: err.message });
      process.exit(1);
    },
  );

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
}
