// Keys for the on-device search index of end-to-end encrypted Direct messages (the index itself
// lives in the window's IndexedDB, encrypted with AES-GCM). One random 256-bit key per office,
// kept only sealed by the operating system's secure storage through Electron's safeStorage:
// DPAPI on Windows, the Keychain on macOS, the desktop keyring on Linux. Signing out of an office
// or the device being removed drops its key, which makes whatever the index left on disk
// unreadable even before the window deletes it.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { app, safeStorage } from 'electron';

const file = () => path.join(app.getPath('userData'), 'search-index-keys.bin');
const SCOPE = /^[A-Za-z0-9_.:-]{1,128}$/;
let queue: Promise<unknown> = Promise.resolve();

/** One change at a time, so two windows asking at once cannot make two different keys. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function available(): Promise<boolean> {
  try { return await safeStorage.isAsyncEncryptionAvailable(); } catch { return false; }
}

async function load(): Promise<Record<string, string>> {
  if (!fs.existsSync(file())) return {};
  try {
    const { result } = await safeStorage.decryptStringAsync(await fsp.readFile(file()));
    const v = JSON.parse(result) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, string>;
  } catch { /* sealed for another account or PC: start again (the old index cannot be read either) */ }
  return {};
}

async function store(keys: Record<string, string>): Promise<void> {
  if (!Object.keys(keys).length) { await fsp.rm(file(), { force: true }); return; }
  const sealed = await safeStorage.encryptStringAsync(JSON.stringify(keys));
  const tmp = `${file()}.tmp`;
  await fsp.writeFile(tmp, sealed);
  await fsp.rename(tmp, file());
}

/** The index key for an office (base64), made on first use; null when there is no secure storage. */
export function indexKey(scope: string): Promise<string | null> {
  return serial(async () => {
    if (typeof scope !== 'string' || !SCOPE.test(scope) || !(await available())) return null;
    const keys = await load();
    if (!keys[scope]) {
      keys[scope] = randomBytes(32).toString('base64');
      await store(keys);
    }
    return keys[scope];
  });
}

/** Forget an office's index key (or every one), on sign-out or when the device is removed. */
export function dropIndexKey(scope?: string | null): Promise<void> {
  return serial(async () => {
    if (!fs.existsSync(file())) return;
    if (!scope) { await fsp.rm(file(), { force: true }); return; }
    if (!(await available())) return;
    const keys = await load();
    if (!(scope in keys)) return;
    delete keys[scope];
    await store(keys);
  });
}
