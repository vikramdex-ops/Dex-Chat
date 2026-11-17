// The office's defaults, applied by the hub itself on its first start (docs/GO-LIVE.md), so a new
// office does not set them by hand from a manual.
//
// Each default is applied once per hub and recorded with its own flag in `meta`
// (`firstrun_<name>_v1`), so:
//   - a restart never applies it again;
//   - something an administrator already changed is never overwritten (the default is skipped,
//     and the flag is still set, when the setting is already saved);
//   - a hub upgraded from a version without this keeps what it was doing (see `nib` below).
//
// The defaults:
//   nib     Nib & day sheets: start of day 09:45, wrap-up 18:00, register 18:30, follow-up 19:00,
//           Monday to Saturday, day sheets private, no job codes, nobody receiving the register
//           until an administrator chooses.
//   desks   The notice desks Admin, HR, IT and Management, with no issuers.
//   backup  A backup folder on a second disk of the hub PC, made private, backed up to at once and
//           checked; only when such a disk is there. Otherwise the Control room says the hub needs
//           a second disk or a network share. See `autoBackup` and docs/BACKUP.md.
//
// Policies need nothing written: every policy the Control room shows has its default until an
// administrator changes it (policies.ts), and the audit log is always on (store.ts; there is no
// switch for it).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { NIB_DEFAULTS } from '@dex/core';
import type { BackupAuto, NibConfig } from '@dex/core';
import { dirSize } from './backup.ts';
import type { Backups } from './backup.ts';
import type { Nib } from './nib.ts';
import type { NoticeBoard } from './notices.ts';
import type { Store } from './store.ts';

export const FIRSTRUN_FLAGS = {
  nib: 'firstrun_nib_v1',
  desks: 'firstrun_desks_v1',
  backup: 'firstrun_backup_v1',
} as const;

/**
 * The times Nib used before these defaults (register 19:00, follow-up 21:00). A hub that ran an
 * older version, has people and never saved Nib's settings was working to these: it keeps them.
 */
export const NIB_LEGACY_TIMES: Pick<NibConfig, 'digestAt' | 'followUpAt'> = { digestAt: '19:00', followUpAt: '21:00' };

const GB = 1024 ** 3;
/** A backup disk needs at least this much free space, and at least twice the hub's data. */
export const BACKUP_MIN_FREE = 10 * GB;
export const BACKUP_FOLDER_NAME = 'DexConnectBackup';

// ---------------------------------------------------------------- the disks
/** One drive letter, as Windows reports it (Get-Volume, Get-Partition, Get-Disk). */
export interface DiskVolume {
  /** "E" */
  letter: string;
  /** Get-Volume's DriveType: "Fixed", "Removable", "Network", "CD-ROM", "Unknown". */
  driveType: string;
  /** The physical disk (Get-Partition's DiskNumber); null when Windows did not say. */
  disk: number | null;
  /** Get-Disk's BusType: "SATA", "NVMe", "SAS", "RAID", "USB"…; null when not known. */
  bus: string | null;
  /** The partition Windows starts from or keeps its system files on. */
  boot: boolean;
  free: number;
  size: number;
  label: string;
}
export interface DiskLayout {
  /** The Windows drive (SystemDrive), "C". */
  system: string;
  volumes: DiskVolume[];
}
/** Looks at the PC's disks; null when it cannot (not Windows, PowerShell missing or too slow). */
export type DiskDetector = () => Promise<DiskLayout | null>;

/** Buses that can be unplugged or are reached over the network: never a backup destination chosen on its own. */
const UNSAFE_BUS = new Set(['usb', 'sd', 'mmc', '1394', 'iscsi', 'file backed virtual', 'virtual']);

/**
 * The PowerShell the hub runs on Windows to map drive letters to physical disks. It only reads.
 * Kept here, whole, so it can be reviewed (docs/BACKUP.md quotes it).
 */
export const DISK_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$out = @()
foreach ($v in @(Get-Volume | Where-Object { $_.DriveLetter })) {
  $disk = $null; $bus = $null; $boot = $false
  try {
    $p = Get-Partition -DriveLetter $v.DriveLetter -ErrorAction Stop | Select-Object -First 1
    $disk = [int]$p.DiskNumber
    $boot = [bool]($p.IsBoot -or $p.IsSystem)
    $d = Get-Disk -Number $disk -ErrorAction Stop
    $bus = [string]$d.BusType
  } catch { }
  $out += [pscustomobject]@{
    letter = [string]$v.DriveLetter; driveType = [string]$v.DriveType; disk = $disk; bus = $bus; boot = $boot
    free = [int64]$v.SizeRemaining; size = [int64]$v.Size; label = [string]$v.FileSystemLabel
  }
}
ConvertTo-Json -Compress -Depth 4 -InputObject ([pscustomobject]@{ system = [string]$env:SystemDrive; volumes = $out })`;

/** Read PowerShell's answer (DISK_SCRIPT); null when it is not what the script prints. */
export function parseDiskLayout(json: string): DiskLayout | null {
  let raw: unknown;
  try { raw = JSON.parse(json.trim()); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { system?: unknown; volumes?: unknown };
  // a single volume can come back as an object rather than a list
  const list = Array.isArray(r.volumes) ? r.volumes : r.volumes && typeof r.volumes === 'object' ? [r.volumes] : [];
  const volumes: DiskVolume[] = [];
  for (const x of list as Array<Record<string, unknown>>) {
    const letter = typeof x.letter === 'string' ? x.letter.trim().toUpperCase() : '';
    if (!/^[A-Z]$/.test(letter)) continue;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
    volumes.push({
      letter, driveType: typeof x.driveType === 'string' ? x.driveType : 'Unknown',
      disk: typeof x.disk === 'number' && Number.isInteger(x.disk) ? x.disk : null,
      bus: typeof x.bus === 'string' && x.bus ? x.bus : null, boot: x.boot === true,
      free: num(x.free), size: num(x.size), label: typeof x.label === 'string' ? x.label : '',
    });
  }
  const system = typeof r.system === 'string' ? r.system.replace(/[:\\]/g, '').toUpperCase() : 'C';
  return { system: /^[A-Z]$/.test(system) ? system : 'C', volumes };
}

/** The detector the hub uses: PowerShell on Windows (20 seconds at most), nothing elsewhere. */
export const windowsDisks: DiskDetector = () => {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const encoded = Buffer.from(DISK_SCRIPT, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: 20_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? null : parseDiskLayout(String(stdout))));
  });
};

export type BackupChoice =
  | { kind: 'pick'; volume: DiskVolume; need: number }
  | { kind: 'none'; reason: 'unknown-data-disk' | 'single-disk' | 'same-disk-only' | 'system-only' | 'removable-only' | 'no-space'; need: number; detail: string };

/** "E: (Data, 931 GB, 702 GB free)" */
const volText = (v: DiskVolume) => `${v.letter}: (${v.label ? `${v.label}, ` : ''}${Math.round(v.size / GB)} GB, ${Math.round(v.free / GB)} GB free)`;

/**
 * Where a backup may go without asking anyone: a fixed volume (not removable, not on USB, not a
 * network or virtual disk) on a different physical disk from the hub's data, not the Windows
 * drive, with at least twice the hub's data and 10 GB free. The one with the most free space.
 * Anything else is not chosen: a backup on the same disk is lost with it.
 */
export function chooseBackupDrive(layout: DiskLayout, dataLetter: string | null, dataBytes: number): BackupChoice {
  const need = Math.max(BACKUP_MIN_FREE, 2 * Math.max(0, dataBytes));
  const data = dataLetter ? layout.volumes.find((v) => v.letter === dataLetter.toUpperCase()) : undefined;
  if (!data || data.disk === null) {
    return { kind: 'none', reason: 'unknown-data-disk', need, detail: dataLetter ? `Windows did not say which disk ${dataLetter.toUpperCase()}: is on.` : 'The hub\'s data is not on a lettered drive.' };
  }
  const others = layout.volumes.filter((v) => v.letter !== data.letter);
  const fixed = others.filter((v) => v.driveType.toLowerCase() === 'fixed');
  const safeBus = fixed.filter((v) => !UNSAFE_BUS.has((v.bus ?? '').toLowerCase()));
  const otherDisk = safeBus.filter((v) => v.disk !== null && v.disk !== data.disk && !v.boot && v.letter !== layout.system);
  const roomy = otherDisk.filter((v) => v.free >= need).sort((a, b) => b.free - a.free);
  if (roomy[0]) return { kind: 'pick', volume: roomy[0], need };
  if (otherDisk.length) return { kind: 'none', reason: 'no-space', need, detail: `The second disk has too little free space: ${otherDisk.map(volText).join(', ')}.` };
  const sameDisk = fixed.filter((v) => v.disk === data.disk);
  if (sameDisk.length) return { kind: 'none', reason: 'same-disk-only', need, detail: `${[data, ...sameDisk].map((v) => `${v.letter}:`).sort().join(', ')} are parts of the same physical disk (disk ${data.disk}).` };
  const windowsOnly = safeBus.filter((v) => v.disk !== null && v.disk !== data.disk);
  if (windowsOnly.length) return { kind: 'none', reason: 'system-only', need, detail: `The only other disk holds Windows (${windowsOnly.map((v) => `${v.letter}:`).join(', ')}).` };
  const unplug = others.filter((v) => v.driveType.toLowerCase() === 'removable' || (v.driveType.toLowerCase() === 'fixed' && UNSAFE_BUS.has((v.bus ?? '').toLowerCase())));
  if (unplug.length) return { kind: 'none', reason: 'removable-only', need, detail: `The other drives can be unplugged or are not a disk in the PC: ${unplug.map((v) => `${v.letter}: (${v.bus ?? v.driveType})`).join(', ')}.` };
  return { kind: 'none', reason: 'single-disk', need, detail: `The hub PC has one disk (disk ${data.disk}, ${data.letter}:).` };
}

/** Make the folder readable only by Administrators and SYSTEM (and the account the hub runs as). */
export const lockDownFolder = async (folder: string): Promise<void> => {
  if (process.platform !== 'win32') { await fsp.chmod(folder, 0o700); return; }
  const run = (cmd: string, args: string[]) => new Promise<string>((resolve, reject) => {
    execFile(cmd, args, { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve(String(stdout))));
  });
  // well-known SIDs, so it works whatever language Windows is in: Administrators, SYSTEM
  const grants = ['*S-1-5-32-544:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F'];
  // the hub's own account, when the service runs as someone else
  try {
    const sid = /"(S-1-[\d-]+)"/.exec(await run('whoami', ['/user', '/fo', 'csv', '/nh']))?.[1];
    if (sid && sid !== 'S-1-5-18') grants.push(`*${sid}:(OI)(CI)F`);
  } catch { /* SYSTEM and Administrators are enough for the service as installed */ }
  await run('icacls', [folder, '/inheritance:r', '/grant:r', ...grants]);
};

// ---------------------------------------------------------------- applying the defaults
export interface FirstRunHost {
  db: DatabaseSync;
  store: Store;
  dataDir: string;
  nib: Nib;
  notices: NoticeBoard;
  backups: Backups;
  audit: (actor: string | null, action: string, target: string | null, detail?: unknown) => void;
  systemId: () => string | null;
  log: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
  /** False once the hub is stopping: nothing more is written. */
  alive?: () => boolean;
}

export interface BackupPickOptions {
  /** Looks at the disks (tests pass their own; the hub uses PowerShell on Windows). */
  detector?: DiskDetector;
  /** The drive letter the hub's data is on (default: from the data folder's path). */
  dataDrive?: string | null;
  /** Where the folder goes on a drive (default `E:\DexConnectBackup`). */
  folderOn?: (letter: string) => string;
  /** Makes the folder private (default icacls on Windows). */
  lockDown?: (folder: string) => Promise<void>;
  /** Run and check the first backup (default yes). */
  firstBackup?: boolean;
}

const getMeta = (db: DatabaseSync, key: string): string | null => (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
const setMeta = (db: DatabaseSync, key: string, value: string) => db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

/** What each default did on this start: applied, or why it was left alone. Nothing for one already done. */
export type FirstRunResult = Partial<Record<keyof typeof FIRSTRUN_FLAGS, 'applied' | 'kept' | 'legacy' | 'skipped'>>;

/**
 * The defaults that need no disk or network (Nib, the notice desks). Runs at the start of
 * Hub.start(), before anyone can connect. Safe to call on every start.
 */
export function applyDefaults(h: FirstRunHost): FirstRunResult {
  const out: FirstRunResult = {};
  const once = (name: keyof typeof FIRSTRUN_FLAGS, fn: () => FirstRunResult[typeof name]) => {
    if (getMeta(h.db, FIRSTRUN_FLAGS[name])) return;
    const r = fn();
    setMeta(h.db, FIRSTRUN_FLAGS[name], JSON.stringify({ at: Date.now(), result: r }));
    out[name] = r;
  };
  // a hub with nobody in it has nothing anyone chose; one with people ran an older version
  const fresh = h.store.userCount() === 0;

  once('nib', () => {
    if (h.nib.hasSavedConfig()) return 'kept';
    h.nib.seedConfig(fresh ? { ...NIB_DEFAULTS } : { ...NIB_DEFAULTS, ...NIB_LEGACY_TIMES });
    return fresh ? 'applied' : 'legacy';
  });
  once('desks', () => (h.notices.seedDefaultDesks() ? 'applied' : 'kept'));

  if (Object.values(out).some((r) => r === 'applied' || r === 'legacy')) {
    h.audit(h.systemId(), 'setup.defaults', null, out);
    h.log('info', 'first-run defaults applied', out);
  }
  return out;
}

const messages = {
  'unknown-data-disk': 'The hub could not tell which disk its data is on, so it did not choose a backup folder.',
  'single-disk': 'The hub PC has only one disk, and a backup on the same disk is lost with it.',
  'same-disk-only': 'The other drive letters on the hub PC are parts of the same disk, and a backup there is lost with it.',
  'system-only': 'The only other disk is the one Windows runs from, and the hub does not put backups on the Windows drive.',
  'removable-only': 'The only other drives can be unplugged (USB or removable), so the hub did not choose one.',
  'no-space': 'The second disk is too full for the backups.',
} as const;
const ACTION = 'Add a second internal disk to the hub PC or make a folder on a network share (NAS), then enter it in Control room ▸ Backups & leavers ▸ Backup folder, for example E:\\DexConnectBackup or \\\\NAS\\backups\\dexconnect, and click Save folder.';

/**
 * Choose a backup folder when no administrator has (the setting was never saved): on Windows,
 * a second fixed disk with room (chooseBackupDrive). The folder is made, made private, set to
 * 02:00 keeping 14 daily, 8 weekly and 12 monthly copies, backed up to at once and the copy
 * checked. With no safe disk nothing is chosen and the Control room says what to do; the hub
 * looks again on its next start, until a folder is set.
 */
export async function autoBackup(h: FirstRunHost, o: BackupPickOptions = {}): Promise<BackupAuto | null> {
  if (getMeta(h.db, FIRSTRUN_FLAGS.backup)) return null;
  if (getMeta(h.db, 'backup_config') !== null) {
    // an administrator has chosen (or turned backups off): theirs stands
    setMeta(h.db, FIRSTRUN_FLAGS.backup, JSON.stringify({ at: Date.now(), result: 'kept' }));
    return null;
  }
  const now = Date.now();
  const record = (a: BackupAuto) => { h.backups.setAuto(a); return a; };
  const layout = await (o.detector ?? windowsDisks)().catch(() => null);
  // the hub may be stopping, or have been given a folder, while PowerShell ran
  if (h.alive?.() === false || getMeta(h.db, 'backup_config') !== null) return null;
  if (!layout) {
    return record({ state: 'unsupported', at: now, folder: null, first: null,
      message: process.platform === 'win32' ? 'The hub could not look at the PC\'s disks (PowerShell did not answer), so it did not choose a backup folder.' : 'The hub chooses a backup disk by itself on the Windows hub PC only.',
      action: ACTION });
  }
  const dataDrive = o.dataDrive !== undefined ? o.dataDrive : (/^([A-Za-z]):/.exec(path.resolve(h.dataDir))?.[1] ?? null);
  const dataBytes = await dirSize(h.dataDir).catch(() => 0);
  if (h.alive?.() === false) return null;
  const choice = chooseBackupDrive(layout, dataDrive, dataBytes);
  if (choice.kind === 'none') {
    h.log('warn', 'no safe backup disk', { reason: choice.reason, detail: choice.detail });
    return record({ state: choice.reason === 'unknown-data-disk' ? 'unsupported' : 'needs-disk', at: now, folder: null, first: null, message: `${messages[choice.reason]} ${choice.detail}`, action: ACTION });
  }
  const folder = (o.folderOn ?? ((l: string) => `${l}:\\${BACKUP_FOLDER_NAME}`))(choice.volume.letter);
  try {
    await fsp.mkdir(folder, { recursive: true });
    await (o.lockDown ?? lockDownFolder)(folder);
  } catch (err) {
    // a folder everyone can read holds every message and the hub's key: do not use it
    h.log('error', 'backup folder could not be made private', { folder, error: (err as Error).message });
    return record({ state: 'failed', at: now, folder: null, first: null,
      message: `The hub found a second disk (${choice.volume.letter}:) but could not make ${folder} private to administrators, so it did not use it (${(err as Error).message.slice(0, 160)}).`,
      action: `Make ${folder} readable only by Administrators and SYSTEM (or choose another folder), then enter it in Control room ▸ Backups & leavers ▸ Backup folder.` });
  }
  if (h.alive?.() === false || getMeta(h.db, 'backup_config') !== null) return null;
  try {
    await h.backups.configure(null, { folder, time: '02:00', keepDaily: 14, keepWeekly: 8, keepMonthly: 12 });
  } catch (err) {
    return record({ state: 'failed', at: now, folder: null, first: null, message: `The hub could not write to ${folder}: ${(err as Error).message}`, action: ACTION });
  }
  setMeta(h.db, FIRSTRUN_FLAGS.backup, JSON.stringify({ at: now, result: 'applied', folder }));
  h.log('info', 'backup folder chosen', { folder, disk: choice.volume.disk, free: choice.volume.free });
  const picked: BackupAuto = { state: 'picked', at: now, folder, first: null, action: null,
    message: `The hub chose ${folder}, on a second disk (${volText(choice.volume)}, disk ${choice.volume.disk}; the hub's data is on another disk), made it private to administrators, and backs up to it every night at 02:00.` };
  record(picked);
  if (o.firstBackup === false || h.alive?.() === false) return picked;
  const run = await h.backups.start(false, null).catch((err: Error) => ({ ok: false, error: err.message, finishedAt: Date.now(), dbBytes: 0, filesBytes: 0, check: null }));
  if (h.alive?.() === false) return picked;
  const verified = !!run.ok && run.check?.integrity === 'ok';
  return record({ ...picked, first: { ok: !!run.ok, at: run.finishedAt, bytes: run.dbBytes + run.filesBytes, verified, error: run.error ?? null } });
}

/** True once the folder exists (for the setup check: a chosen folder that vanished). */
export function folderThere(folder: string): boolean {
  try { return fs.statSync(folder).isDirectory(); } catch { return false; }
}
