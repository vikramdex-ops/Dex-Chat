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
import { loadSealedSecret } from './sealed-store.ts';
import type { KeyFiles, SealBox } from './sealed-store.ts';

export interface Config {
  hub: HubTarget | null;
  displayName: string | null;
  settings: Settings;
  /** Version that ran last time; used to detect "just updated". */
  lastRunVersion?: string;
  /** Notes of the update being installed, shown after relaunch. */
  pendingNotes?: { version: string; notes: string } | null;
  /** The office policy allows PC-to-PC messages while the hub is off (remembered for then). */
  peerFallback?: boolean;
  /** Other offices (hubs) this device belongs to, to switch to. */
  otherHubs?: HubTarget[];
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

const box: SealBox = {
  // Linux without a keyring falls back to "basic_text", which only obfuscates; a key sealed that
  // way could not be unsealed once a keyring appears, so it is treated as no sealing at all
  available: () => safeStorage.isEncryptionAvailable() && !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text'),
  encrypt: (text) => safeStorage.encryptString(text),
  decrypt: (data) => safeStorage.decryptString(data),
};
const files: KeyFiles = {
  exists: (p) => fs.existsSync(p),
  read: (p) => fs.readFileSync(p),
  write: (p, data) => writeAtomic(p, data),
  remove: (p) => fs.rmSync(p, { force: true }),
};

/** This device's end-to-end encryption key pair, sealed like the identity. */
export function loadEncKeys(): EncKeyPair {
  const valid = (v: unknown): v is EncKeyPair => !!v && typeof (v as EncKeyPair).secret === 'string' && typeof (v as EncKeyPair).public === 'string';
  // unreadable on this account: a new key (older messages stay readable on the user's other devices)
  return loadSealedSecret({ sealedPath: file('device.enc'), plainPath: file('device.enc.json'), valid, create: createEncKeys, box, files });
}

export function loadIdentity(): DeviceIdentity {
  // Windows always has DPAPI; an unsealed file exists only on Linux without a keyring (development)
  return loadSealedSecret({ sealedPath: file('device.key'), plainPath: file('device.key.json'), valid: (v): v is DeviceIdentity => isValidIdentity(v), create: createIdentity, box, files });
}
