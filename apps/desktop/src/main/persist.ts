// On-disk state for the desktop app, kept in Electron's per-user data folder.
// The device's private key is sealed with Windows DPAPI (safeStorage) so another Windows
// account, or a copy of the files on another PC, cannot use it.
import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import { createEncKeys } from '@dex/core/e2e';
import type { EncKeyPair } from '@dex/core/e2e';
import { createIdentity, isValidIdentity } from '@dex/core';
import type { DeviceIdentity } from '@dex/core';
import type { HubTarget } from '@dex/core/client';
import { SETTINGS_EXTRA_DEFAULTS, type Settings } from '../shared/bridge.ts';

export interface Config {
  hub: HubTarget | null;
  displayName: string | null;
  settings: Settings;
  /** Version that ran last time; used to detect "just updated". */
  lastRunVersion?: string;
  /** Notes of the update being installed, shown after relaunch. */
  pendingNotes?: { version: string; notes: string } | null;
}

const DEFAULT_CONFIG: Config = {
  hub: null,
  displayName: null,
  settings: { theme: 'system', startAtLogin: true, closeToTray: true, updateChannel: 'stable', autoDownloadUpdates: true, ...SETTINGS_EXTRA_DEFAULTS },
};

const file = (name: string) => path.join(app.getPath('userData'), name);

function writeAtomic(target: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, target);
}

export function loadConfig(): Config {
  try {
    const raw = JSON.parse(fs.readFileSync(file('config.json'), 'utf8')) as Partial<Config>;
    return { ...DEFAULT_CONFIG, ...raw, settings: { ...DEFAULT_CONFIG.settings, ...raw.settings } };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(config: Config): void {
  writeAtomic(file('config.json'), JSON.stringify(config, null, 2));
}

/** This device's end-to-end encryption key pair, sealed like the identity. */
export function loadEncKeys(): EncKeyPair {
  const sealedPath = file('device.enc');
  const plainPath = file('device.enc.json');
  const valid = (v: unknown): v is EncKeyPair => !!v && typeof (v as EncKeyPair).secret === 'string' && typeof (v as EncKeyPair).public === 'string';
  try {
    if (fs.existsSync(sealedPath) && safeStorage.isEncryptionAvailable()) {
      const k = JSON.parse(safeStorage.decryptString(fs.readFileSync(sealedPath)));
      if (valid(k)) return k;
    } else if (fs.existsSync(plainPath)) {
      const k = JSON.parse(fs.readFileSync(plainPath, 'utf8'));
      if (valid(k)) return k;
    }
  } catch { /* unreadable: make a new key (older messages stay readable on the user's other devices) */ }
  const k = createEncKeys();
  if (safeStorage.isEncryptionAvailable()) writeAtomic(sealedPath, safeStorage.encryptString(JSON.stringify(k)));
  else writeAtomic(plainPath, JSON.stringify(k));
  return k;
}

export function loadIdentity(): DeviceIdentity {
  const sealedPath = file('device.key');
  const plainPath = file('device.key.json');
  try {
    if (fs.existsSync(sealedPath) && safeStorage.isEncryptionAvailable()) {
      const id = JSON.parse(safeStorage.decryptString(fs.readFileSync(sealedPath)));
      if (isValidIdentity(id)) return id;
    } else if (fs.existsSync(plainPath)) {
      const id = JSON.parse(fs.readFileSync(plainPath, 'utf8'));
      if (isValidIdentity(id)) return id;
    }
  } catch {
    // unreadable (e.g. copied from another account): fall through and create a new identity
  }
  const id = createIdentity();
  if (safeStorage.isEncryptionAvailable()) {
    writeAtomic(sealedPath, safeStorage.encryptString(JSON.stringify(id)));
  } else {
    // Development on Linux without a keyring only; Windows always has DPAPI.
    writeAtomic(plainPath, JSON.stringify(id));
  }
  return id;
}
