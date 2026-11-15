// Automatic backups of the hub, and restoring one.
//
// A backup is a consistent copy of the database, taken with SQLite's online backup while the hub
// keeps working, plus the shared files. Files are stored by their SHA-256 and never change, so the
// backup folder keeps one shared pool of them and each run copies only files it does not have yet.
//
//   <backup folder>\
//     README.txt                         what this folder is
//     files\ab\ab12…                      the shared files, as in the hub's own files folder
//     snapshots\2026-11-15_0200\
//       hub.db                            the database (one file, rollback journal)
//       hub-cert.pem, hub-key.pem         the hub's identity, so devices trust a restored hub
//       files.txt                         the files this copy refers to, one SHA-256 a line
//       manifest.json                     when, which hub, what the check after the run found
//
// A copy is written as snapshots\.partial-… and renamed only once it is complete and checked, so a
// run that stops half-way never looks like a backup. After each run the copy is opened read-only,
// checked with PRAGMA integrity_check and its rows counted (in a worker thread, so the hub does not
// pause), and a sample of its files is read back and compared with their hashes. Older copies are
// then removed by the keeping rules (one a day for 14 days, a week for 8 weeks, a month for 12
// months, by default), and files no remaining copy refers to leave the pool.
//
// Restoring (`--restore <folder>`, see restoreBackup) refuses while the hub is running, moves the
// current data folder aside, and puts the copy in its place.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { BACKUP_ALERT_MS, BACKUP_DEFAULTS } from '@dex/core';
import type { BackupCheck, BackupConfig, BackupCopy, BackupRun, BackupStatus, PublicUser } from '@dex/core';

const DAY = 86_400_000;
/** Files read back and compared with their hash after each run. */
export const HASH_SAMPLE = 24;
/** Runs remembered for the Control room. */
const HISTORY = 30;
/** After a failed run, try again this much later (until the next nightly run). */
const RETRY_MS = 3600_000;
/** Tables counted in the check (whichever exist). */
const COUNTED = ['users', 'devices', 'conversations', 'messages', 'files', 'events', 'audit'];
const FORMAT = 1;

export class BackupFailure extends Error {}

export interface BackupHost {
  db: DatabaseSync;
  dataDir: string;
  hubId: string;
  hubName: () => string;
  version: string;
  /** Who the audit log names for a nightly run (the system bot). */
  systemId: () => string | null;
  admins: () => PublicUser[];
  tell: (userId: string, text: string, key: string) => void;
  changed: (status: BackupStatus) => void;
  audit: (actor: string | null, action: string, target: string | null, detail?: unknown) => void;
  log: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
}

interface State {
  lastRun: BackupRun | null;
  lastSuccess: BackupRun | null;
  history: BackupRun[];
  lastAttemptAt: number | null;
  configuredAt: number | null;
  alertDay: string | null;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** 2026-11-15_0200, in the hub PC's time. */
export function copyName(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}
const dayKey = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
/** Whole days since 1970 in local time (so "the last 14 days" follows the office's calendar). */
const dayIndex = (t: number) => { const d = new Date(t); return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY); };
/** Weeks start on Monday. 1 Jan 1970 was a Thursday: day index 4 is a Monday. */
const weekIndex = (t: number) => Math.floor((dayIndex(t) - 4) / 7);
const monthIndex = (t: number) => { const d = new Date(t); return d.getFullYear() * 12 + d.getMonth(); };

/**
 * Which copies the keeping rules keep: the latest always, and the newest copy of each of the last
 * `keepDaily` days, `keepWeekly` weeks and `keepMonthly` months (today, this week and this month count).
 */
export function chooseKeep(copies: Array<{ name: string; at: number }>, policy: Pick<BackupConfig, 'keepDaily' | 'keepWeekly' | 'keepMonthly'>, now: number): Map<string, BackupCopy['kept']> {
  const out = new Map<string, BackupCopy['kept']>();
  const add = (name: string, why: BackupCopy['kept'][number]) => { const l = out.get(name) ?? []; if (!l.includes(why)) l.push(why); out.set(name, l); };
  const newest = [...copies].sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
  if (newest[0]) add(newest[0].name, 'latest');
  const rules: Array<[BackupCopy['kept'][number], (t: number) => number, number]> = [
    ['daily', dayIndex, policy.keepDaily], ['weekly', weekIndex, policy.keepWeekly], ['monthly', monthIndex, policy.keepMonthly],
  ];
  for (const [why, index, keep] of rules) {
    const current = index(now);
    const seen = new Set<number>();
    for (const c of newest) {
      const i = index(c.at);
      if (i > current || current - i >= keep || seen.has(i)) continue;
      seen.add(i);
      add(c.name, why);
    }
  }
  return out;
}

/** What went wrong, in words an office manager can act on. */
export function plainError(err: unknown, folder: string): string {
  if (err instanceof BackupFailure) return err.message;
  const e = err as NodeJS.ErrnoException;
  switch (e?.code) {
    case 'ENOENT': case 'ENOTDIR':
      return `The backup folder ${folder} could not be reached. Check that the disk is plugged in, or that the network share is switched on and its name is right.`;
    case 'EACCES': case 'EPERM':
      return `The hub is not allowed to write to ${folder}. Give the account the hub service runs as permission to change that folder (see docs/BACKUP.md).`;
    case 'ENOSPC': case 'EDQUOT':
      return `The backup folder ${folder} is full. Free some space or choose a bigger disk. Older copies are removed only after a new one has worked.`;
    case 'EROFS':
      return `The backup folder ${folder} is read-only. Choose a folder the hub can write to.`;
    case 'ENETUNREACH': case 'EHOSTUNREACH': case 'ETIMEDOUT': case 'ECONNRESET': case 'EBADNETPATH': case 'EIO': case 'UNKNOWN':
      return `The network share for ${folder} did not answer. Check that it is switched on and reachable from the hub PC.`;
    case 'EBUSY':
      return `Another program is using a file in ${folder}. Try again in a few minutes.`;
  }
  return `The backup stopped: ${(e?.message ?? String(err)).slice(0, 200)}`;
}

// ---------------------------------------------------------------- the check, in a worker thread
// Plain JavaScript: the worker runs this source, so it works the same from a source checkout and
// from the single-file hub program.
const INSPECT = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
try {
  if (workerData.single) {
    // one file: no -wal or -shm beside the copy
    const rw = new DatabaseSync(workerData.db);
    rw.exec('PRAGMA journal_mode = DELETE');
    rw.close();
  }
  const db = new DatabaseSync(workerData.db, { readOnly: true });
  const integrity = db.prepare('PRAGMA integrity_check').all().map((r) => String(Object.values(r)[0])).slice(0, 5).join('; ');
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
  const rows = {};
  for (const t of workerData.tables) if (tables.has(t)) rows[t] = Number(db.prepare('SELECT COUNT(*) AS n FROM "' + t + '"').get().n);
  const files = tables.has('files') ? db.prepare('SELECT sha256 AS s, MAX(size) AS z FROM files GROUP BY sha256').all().map((r) => [String(r.s), Number(r.z)]) : [];
  const hub = tables.has('meta') ? (db.prepare("SELECT value FROM meta WHERE key = 'hub_id'").get() || {}).value || null : null;
  db.close();
  parentPort.postMessage({ ok: true, integrity, rows, files, hub });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String((e && e.message) || e) });
}
`;

interface Inspection { integrity: string; rows: Record<string, number>; files: Array<[string, number]>; hub: string | null }

/** Open a database copy read-only in a worker: SQLite's integrity check, row counts and the files it refers to. */
export function inspectCopy(dbPath: string, single: boolean): Promise<Inspection> {
  return new Promise((resolve, reject) => {
    const w = new Worker(INSPECT, { eval: true, workerData: { db: dbPath, single, tables: COUNTED } });
    let done = false;
    w.once('message', (m: { ok: boolean; error?: string } & Inspection) => {
      done = true;
      void w.terminate();
      if (m.ok) resolve({ integrity: m.integrity, rows: m.rows, files: m.files, hub: m.hub });
      else reject(new BackupFailure(`The copy of the database could not be opened to check it (${m.error}).`));
    });
    w.once('error', (e) => { if (!done) reject(new BackupFailure(`The copy could not be checked (${e.message}).`)); });
    w.once('exit', () => { if (!done) reject(new BackupFailure('The copy could not be checked.')); });
  });
}

/** SHA-256 of a file, read in chunks. */
export function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

const blobPath = (root: string, sha: string) => path.join(root, sha.slice(0, 2), sha);
const SHA_RE = /^[0-9a-f]{64}$/;

async function exists(p: string): Promise<fs.Stats | null> {
  try { return await fsp.stat(p); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}

async function dirSize(dir: string): Promise<number> {
  let n = 0;
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += await dirSize(p);
    else n += (await fsp.stat(p).catch(() => null))?.size ?? 0;
  }
  return n;
}

const README = `DEXTERITY CONNECT HUB BACKUP
============================

This folder holds automatic backups of a Dexterity Connect hub. Do not change or remove files in
it by hand: the hub keeps it tidy itself.

  snapshots\\   one folder per backup: the database, the hub's certificate and a list of files
  files\\       the shared files, kept once for every backup (only new files are added each night)

The snapshots hold the hub's private key (hub-key.pem). Keep this folder where only
administrators can read it.

To restore, stop the hub service and run, in the hub's folder:
  DexterityConnectHub.exe --restore "<this folder>"
The hub's current data is moved aside first. See README-HUB.txt or docs/BACKUP.md.
`;

interface Manifest { format: number; hubId: string; hubName: string; version: string; takenAt: number; dbBytes: number; filesBytes: number; files: number; missing: number; check: BackupCheck }

async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    const m = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
    return typeof m.takenAt === 'number' && typeof m.hubId === 'string' ? m : null;
  } catch { return null; }
}

/** The complete copies in a backup folder, newest first. */
export async function listCopies(root: string): Promise<Array<{ name: string; dir: string; manifest: Manifest }>> {
  const snaps = path.join(root, 'snapshots');
  const out: Array<{ name: string; dir: string; manifest: Manifest }> = [];
  for (const e of await fsp.readdir(snaps, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const m = await readManifest(path.join(snaps, e.name));
    if (m) out.push({ name: e.name, dir: path.join(snaps, e.name), manifest: m });
  }
  return out.sort((a, b) => b.manifest.takenAt - a.manifest.takenAt);
}

export class Backups {
  private readonly h: BackupHost;
  private running: BackupStatus['running'] = null;
  private current: Promise<BackupRun> | null = null;
  private copies: BackupCopy[] = [];
  private folderBytes: number | null = null;
  private scanned = false;
  /** Set when the hub is stopping: a run stops at its next step. */
  private halted = false;
  private copying: Promise<unknown> | null = null;

  constructor(host: BackupHost) {
    this.h = host;
  }

  // ------------------------------------------------------------ settings and state
  private meta(key: string): string | null {
    const r = this.h.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }
  private setMeta(key: string, value: string): void {
    this.h.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  config(): BackupConfig {
    try { return { ...BACKUP_DEFAULTS, ...(JSON.parse(this.meta('backup_config') ?? '{}') as Partial<BackupConfig>) }; } catch { return { ...BACKUP_DEFAULTS }; }
  }

  private state(): State {
    const empty: State = { lastRun: null, lastSuccess: null, history: [], lastAttemptAt: null, configuredAt: null, alertDay: null };
    try { return { ...empty, ...(JSON.parse(this.meta('backup_state') ?? '{}') as Partial<State>) }; } catch { return empty; }
  }
  private saveState(patch: Partial<State>): void {
    this.setMeta('backup_state', JSON.stringify({ ...this.state(), ...patch }));
  }

  /** Change where and when; a new folder is checked by writing to it. */
  async configure(me: PublicUser, patch: Record<string, unknown>): Promise<BackupStatus> {
    const cur = this.config();
    const next: BackupConfig = { ...cur };
    if (patch.folder !== undefined) {
      const raw = patch.folder === null ? '' : String(patch.folder).trim();
      if (!raw) next.folder = null;
      else {
        if (raw.length > 400 || /[\u0000-\u001f<>"|?*]/.test(raw.replace(/^[A-Za-z]:/, ''))) throw new BackupFailure('That folder name has characters Windows does not allow.');
        if (!path.isAbsolute(raw)) throw new BackupFailure('Give the whole folder path, for example E:\\DexConnectBackup or \\\\NAS\\backups\\dexconnect.');
        const abs = path.resolve(raw);
        // Windows paths are the same whatever their case
        const same = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
        const a = same(abs);
        const data = same(path.resolve(this.h.dataDir));
        if (a === data || a.startsWith(data + path.sep) || data.startsWith(a + path.sep)) throw new BackupFailure('Choose a folder outside the hub\'s data folder, ideally on another disk or a network share.');
        await this.probe(abs);
        next.folder = abs;
      }
    }
    if (patch.time !== undefined) {
      const t = String(patch.time);
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new BackupFailure('Choose a time like 02:00.');
      next.time = t;
    }
    const keep = (k: 'keepDaily' | 'keepWeekly' | 'keepMonthly', max: number, what: string) => {
      if (patch[k] === undefined) return;
      const n = Number(patch[k]);
      if (!Number.isInteger(n) || n < (k === 'keepDaily' ? 1 : 0) || n > max) throw new BackupFailure(`Keep between ${k === 'keepDaily' ? 1 : 0} and ${max} ${what}.`);
      next[k] = n;
    };
    keep('keepDaily', 366, 'daily copies');
    keep('keepWeekly', 260, 'weekly copies');
    keep('keepMonthly', 240, 'monthly copies');
    this.setMeta('backup_config', JSON.stringify(next));
    if (next.folder !== cur.folder) {
      // the first copy is tonight's (or "Back up now"); the two-day warning counts from here
      this.saveState({ configuredAt: Date.now(), alertDay: null });
      this.copies = []; this.folderBytes = null; this.scanned = false;
      if (next.folder) await this.scan();
    }
    this.h.audit(me.id, 'backup.settings', null, { folder: next.folder, time: next.time, keepDaily: next.keepDaily, keepWeekly: next.keepWeekly, keepMonthly: next.keepMonthly });
    const s = this.status();
    this.h.changed(s);
    return s;
  }

  /** Can the hub write here? Makes the folder if it is missing (on a disk or share that is there). */
  private async probe(folder: string): Promise<void> {
    try {
      await fsp.mkdir(path.join(folder, 'snapshots'), { recursive: true });
      await fsp.mkdir(path.join(folder, 'files'), { recursive: true });
      const p = path.join(folder, `.write-test-${crypto.randomBytes(4).toString('hex')}`);
      await fsp.writeFile(p, 'Dexterity Connect checks it can write here.');
      await fsp.rm(p, { force: true });
      if (!(await exists(path.join(folder, 'README.txt')))) await fsp.writeFile(path.join(folder, 'README.txt'), README.replace(/\n/g, '\r\n'));
    } catch (err) { throw new BackupFailure(plainError(err, folder)); }
  }

  // ------------------------------------------------------------ when
  private slot(day: number, time: string): number {
    const [h, m] = time.split(':').map(Number);
    const d = new Date(day);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  }

  nextRunAt(now = Date.now()): number | null {
    const c = this.config();
    if (!c.folder) return null;
    const st = this.state();
    const since = Math.max(st.lastAttemptAt ?? 0, st.configuredAt ?? 0);
    const today = this.slot(now, c.time);
    let next = since < today ? today : this.slot(now + DAY, c.time);
    // after a failure, try again in an hour rather than waiting for tomorrow night
    if (st.lastRun && !st.lastRun.ok) next = Math.min(next, st.lastRun.finishedAt + RETRY_MS);
    return next;
  }

  private hubAge(now: number): number {
    const r = this.h.db.prepare("SELECT MIN(created_at) AS t FROM users WHERE role != 'bot'").get() as { t: number | null };
    return r.t ? now - r.t : 0;
  }

  /** Amber in the Control room, and what the system bot says. */
  warning(now = Date.now()): string | null {
    const c = this.config();
    const st = this.state();
    if (!c.folder) return this.hubAge(now) > BACKUP_ALERT_MS ? 'Backups are not set up. Choose a backup folder so a copy of the hub is kept every night.' : null;
    const last = st.lastSuccess?.finishedAt ?? null;
    const since = last ?? st.configuredAt ?? now;
    if (now - since <= BACKUP_ALERT_MS) return null;
    const why = st.lastRun && !st.lastRun.ok && st.lastRun.error ? ` The last try said: ${st.lastRun.error}` : '';
    if (!last) return `No backup has worked yet since the backup folder was chosen ${Math.floor((now - since) / DAY)} days ago.${why}`;
    return `No backup has worked for ${Math.floor((now - last) / DAY)} days (the last one was on ${new Date(last).toLocaleDateString('en-IN', { day: 'numeric', month: 'long' })}).${why}`;
  }

  status(now = Date.now()): BackupStatus {
    const st = this.state();
    if (!this.scanned && this.config().folder) { this.scanned = true; void this.scan().then(() => this.h.changed(this.status())).catch(() => {}); }
    return {
      config: this.config(), running: this.running, lastRun: st.lastRun, lastSuccess: st.lastSuccess,
      nextRunAt: this.running ? null : this.nextRunAt(now), warning: this.warning(now), copies: this.copies, folderBytes: this.folderBytes,
      history: st.history,
    };
  }

  /** Called on the hub's timer: start the nightly run when it is due; tell administrators when backups need them. */
  tick(now = Date.now()): void {
    const w = this.warning(now);
    if (w) {
      const day = dayKey(now);
      if (this.state().alertDay !== day) {
        this.saveState({ alertDay: day });
        for (const a of this.h.admins()) this.h.tell(a.id, `**Backups need attention.** ${w}\n\nOpen **Control room ▸ Backups & leavers** to see what happened and to back up now.`, `backup-alert-${day}`);
        this.h.log('warn', 'backups need attention', { warning: w });
      }
    }
    if (this.running) return;
    const next = this.nextRunAt(now);
    if (next !== null && next <= now) void this.start(false, null).catch(() => { /* recorded in the status */ });
  }

  // ------------------------------------------------------------ a run
  /** Start a run (or join the one in progress); `by` is the administrator who pressed "Back up now". */
  start(manual: boolean, by: string | null = null): Promise<BackupRun> {
    if (this.current) return this.current;
    if (!this.config().folder) return Promise.reject(new BackupFailure('Choose a backup folder first.'));
    this.current = this.run(manual, by).finally(() => { this.current = null; });
    return this.current;
  }

  /** The hub is stopping: a run in progress stops at its next step (the database copy is let finish first). */
  async halt(): Promise<void> {
    this.halted = true;
    if (this.copying) await Promise.race([this.copying.catch(() => {}), new Promise((r) => setTimeout(r, 15_000).unref())]);
  }

  private checkHalted(): void {
    if (this.halted) throw new BackupFailure('The hub was stopping, so this backup stopped. It runs again when the hub is back.');
  }

  private step(step: string): void {
    this.checkHalted();
    if (!this.running) return;
    this.running = { ...this.running, step };
    this.h.changed(this.status());
  }

  private async run(manual: boolean, by: string | null): Promise<BackupRun> {
    const cfg = this.config();
    const root = cfg.folder!;
    const startedAt = Date.now();
    this.running = { since: startedAt, step: 'Checking the backup folder', manual };
    this.saveState({ lastAttemptAt: startedAt });
    this.h.changed(this.status());
    const result: BackupRun = { startedAt, finishedAt: startedAt, ok: false, manual, name: null, error: null, dbBytes: 0, filesBytes: 0, filesAdded: 0, bytesAdded: 0, check: null, removed: 0 };
    let partial: string | null = null;
    try {
      await this.probe(root);
      let name = copyName(startedAt);
      for (let i = 2; await exists(path.join(root, 'snapshots', name)); i++) name = `${copyName(startedAt)}-${i}`;
      partial = path.join(root, 'snapshots', `.partial-${name}-${crypto.randomBytes(3).toString('hex')}`);
      await fsp.mkdir(partial, { recursive: true });

      this.step('Copying the database');
      const dbCopy = path.join(partial, 'hub.db');
      // SQLite's online backup: the hub keeps reading and writing while it copies
      this.copying = sqliteBackup(this.h.db, dbCopy, { rate: 256 });
      try { await this.copying; } finally { this.copying = null; }

      this.step('Checking the copy');
      const seen = await inspectCopy(dbCopy, true);
      if (seen.integrity !== 'ok') throw new BackupFailure(`The copy of the database did not pass SQLite's check (${seen.integrity}). Nothing was kept; the hub's own database is checked next time it starts.`);
      result.dbBytes = (await fsp.stat(dbCopy)).size;

      this.step('Copying new files');
      const pool = path.join(root, 'files');
      const source = path.join(this.h.dataDir, 'files');
      let missing = 0;
      for (const [sha, size] of seen.files) {
        if (!SHA_RE.test(sha)) continue;
        this.checkHalted();
        result.filesBytes += size;
        const dest = blobPath(pool, sha);
        const have = await exists(dest);
        if (have && have.size === size) continue;
        const src = blobPath(source, sha);
        if (!(await exists(src))) { missing++; continue; }
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        const part = `${dest}.part`;
        await fsp.copyFile(src, part);
        await fsp.rename(part, dest);
        result.filesAdded++;
        result.bytesAdded += size;
      }
      await fsp.writeFile(path.join(partial, 'files.txt'), seen.files.map(([s]) => s).join('\n'));
      for (const f of ['hub-cert.pem', 'hub-key.pem']) {
        const src = path.join(this.h.dataDir, f);
        if (await exists(src)) await fsp.copyFile(src, path.join(partial, f));
      }

      this.step('Comparing files with their hashes');
      const present: string[] = [];
      for (const [sha, size] of seen.files) {
        const st = await exists(blobPath(pool, sha));
        if (st && st.size === size) present.push(sha);
        else if (!st && !(await exists(blobPath(source, sha)))) continue; // removed from the hub while this ran (counted above)
        else throw new BackupFailure('A file in the backup folder is not the size it should be. The next run copies it again.');
      }
      const sample = [...present].sort(() => Math.random() - 0.5).slice(0, HASH_SAMPLE);
      for (const sha of sample) {
        if (await hashFile(blobPath(pool, sha)) !== sha) {
          await fsp.rm(blobPath(pool, sha), { force: true });
          throw new BackupFailure('A file in the backup folder did not match its fingerprint and was removed. The next run copies it again.');
        }
      }
      result.check = { integrity: seen.integrity, rows: seen.rows, files: seen.files.length, hashed: sample.length, missing };

      const manifest: Manifest = { format: FORMAT, hubId: this.h.hubId, hubName: this.h.hubName(), version: this.h.version, takenAt: startedAt, dbBytes: result.dbBytes, filesBytes: result.filesBytes, files: seen.files.length, missing, check: result.check };
      await fsp.writeFile(path.join(partial, 'manifest.json'), JSON.stringify(manifest, null, 2));
      await fsp.rename(partial, path.join(root, 'snapshots', name));
      partial = null;
      result.name = name;

      this.step('Removing older copies');
      result.removed = await this.prune(root, cfg, Date.now());
      result.ok = true;
    } catch (err) {
      result.error = plainError(err, root);
      this.h.log('error', 'backup failed', { error: result.error, detail: (err as Error)?.message });
    } finally {
      if (partial) await fsp.rm(partial, { recursive: true, force: true }).catch(() => {});
    }
    result.finishedAt = Date.now();
    this.running = null;
    // a hub that is stopping may have closed its database already: nothing more to record
    if (this.halted) return result;
    const st = this.state();
    this.saveState({
      lastRun: result,
      ...(result.ok ? { lastSuccess: result, alertDay: null } : {}),
      history: [result, ...st.history].slice(0, HISTORY),
    });
    await this.scan().catch(() => {});
    this.h.audit(by ?? this.h.systemId(), result.ok ? 'backup.done' : 'backup.failed', result.name, { manual, ...(result.ok ? { dbBytes: result.dbBytes, filesAdded: result.filesAdded, bytesAdded: result.bytesAdded, removed: result.removed } : { error: result.error }) });
    this.h.log(result.ok ? 'info' : 'warn', result.ok ? 'backup done' : 'backup did not work', { name: result.name, ms: result.finishedAt - startedAt });
    this.h.changed(this.status());
    return result;
  }

  /** Remove copies the keeping rules let go, then files no remaining copy refers to. */
  private async prune(root: string, cfg: BackupConfig, now: number): Promise<number> {
    const copies = await listCopies(root);
    const keep = chooseKeep(copies.map((c) => ({ name: c.name, at: c.manifest.takenAt })), cfg, now);
    let removed = 0;
    for (const c of copies) {
      if (keep.has(c.name)) continue;
      await fsp.rm(c.dir, { recursive: true, force: true });
      removed++;
    }
    // half-written copies from a run that stopped (the hub PC switched off): gone after a day
    for (const e of await fsp.readdir(path.join(root, 'snapshots'), { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || !e.name.startsWith('.partial-')) continue;
      const st = await exists(path.join(root, 'snapshots', e.name));
      if (st && now - st.mtimeMs > DAY) await fsp.rm(path.join(root, 'snapshots', e.name), { recursive: true, force: true });
    }
    // the shared files: only when every remaining copy says what it needs
    const wanted = new Set<string>();
    for (const c of copies.filter((x) => keep.has(x.name))) {
      let list: string;
      try { list = await fsp.readFile(path.join(c.dir, 'files.txt'), 'utf8'); } catch { return removed; }
      for (const s of list.split('\n')) if (SHA_RE.test(s.trim())) wanted.add(s.trim());
    }
    const pool = path.join(root, 'files');
    for (const d of await fsp.readdir(pool, { withFileTypes: true }).catch(() => [])) {
      if (!d.isDirectory() || !/^[0-9a-f]{2}$/.test(d.name)) continue;
      for (const f of await fsp.readdir(path.join(pool, d.name)).catch(() => [] as string[])) {
        if (wanted.has(f)) continue;
        if (SHA_RE.test(f) || f.endsWith('.part')) await fsp.rm(path.join(pool, d.name, f), { force: true });
      }
    }
    return removed;
  }

  /** What is in the backup folder now (for the Control room). */
  private async scan(): Promise<void> {
    const cfg = this.config();
    if (!cfg.folder) { this.copies = []; this.folderBytes = null; return; }
    const list = await listCopies(cfg.folder);
    const keep = chooseKeep(list.map((c) => ({ name: c.name, at: c.manifest.takenAt })), cfg, Date.now());
    this.copies = list.map((c) => ({ name: c.name, at: c.manifest.takenAt, dbBytes: c.manifest.dbBytes, kept: keep.get(c.name) ?? [] }));
    this.folderBytes = (await dirSize(path.join(cfg.folder, 'snapshots'))) + (await dirSize(path.join(cfg.folder, 'files')));
    this.scanned = true;
  }
}

// ---------------------------------------------------------------- restoring
export interface RestoreResult {
  copy: string;
  takenAt: number;
  hubName: string;
  /** Where the data that was there before went (null when the data folder was empty or new). */
  aside: string | null;
  files: number;
}

/** The hub writes this while it runs, so a restore can tell it is running. */
export const LOCK_FILE = 'hub.lock';

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Something answering on the hub's port (the service, most likely). */
function portAnswers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v: boolean) => { s.destroy(); resolve(v); };
    s.setTimeout(1500, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** Is a hub using this data folder? Reads the hub's lock file and asks its port. */
export async function hubRunning(dataDir: string, port: number): Promise<string | null> {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(dataDir, LOCK_FILE), 'utf8')) as { pid?: number };
    if (lock.pid && pidAlive(lock.pid)) return `The hub is running (program ${lock.pid} is using ${dataDir}).`;
  } catch { /* no lock: not running from this folder */ }
  if (await portAnswers(port)) return `Something is answering on port ${port}: the hub service is probably running.`;
  return null;
}

/** Find the copy to restore: a copy's own folder, or a backup folder (its newest copy). */
async function pickCopy(from: string): Promise<{ dir: string; root: string; manifest: Manifest }> {
  const abs = path.resolve(from);
  const own = await readManifest(abs);
  if (own) return { dir: abs, root: path.resolve(abs, '..', '..'), manifest: own };
  const list = await listCopies(abs);
  if (list[0]) return { dir: list[0].dir, root: abs, manifest: list[0].manifest };
  throw new BackupFailure(`No backup was found in ${abs}. Give the backup folder (the one with "snapshots" in it) or one of the folders inside "snapshots".`);
}

/**
 * Put a backup back. Refuses while a hub is running (it stops nothing itself). The copy is checked
 * first; the current data folder is then moved aside (<data>-before-restore-<time>) and the copy's
 * database, certificate and files are put in its place.
 */
export async function restoreBackup(opts: { from: string; dataDir: string; port: number; now?: number; log?: (line: string) => void }): Promise<RestoreResult> {
  const log = opts.log ?? (() => {});
  const dataDir = path.resolve(opts.dataDir);
  const busy = await hubRunning(dataDir, opts.port);
  if (busy) throw new BackupFailure(`${busy} Stop it first (Services ▸ Dexterity Connect Hub ▸ Stop, or "DexterityConnectHubService.exe stop"), then run the restore again. If the hub is really stopped, delete ${path.join(dataDir, LOCK_FILE)}.`);
  const { dir, root, manifest } = await pickCopy(opts.from);
  log(`Restoring the backup of ${manifest.hubName} taken ${new Date(manifest.takenAt).toLocaleString('en-IN')} (${path.basename(dir)}).`);

  // check the copy before anything is moved
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dexconnect-restore-'));
  let seen: Inspection;
  try {
    await fsp.copyFile(path.join(dir, 'hub.db'), path.join(scratch, 'hub.db'));
    seen = await inspectCopy(path.join(scratch, 'hub.db'), false);
  } catch (err) {
    fs.rmSync(scratch, { recursive: true, force: true });
    throw err instanceof BackupFailure ? err : new BackupFailure(`The backup's database could not be read (${(err as Error).message}).`);
  }
  fs.rmSync(scratch, { recursive: true, force: true });
  if (seen.integrity !== 'ok') throw new BackupFailure(`The backup's database did not pass SQLite's check (${seen.integrity}). Choose an older copy in ${path.join(root, 'snapshots')}.`);
  const pool = path.join(root, 'files');
  const lost: string[] = [];
  for (const [sha] of seen.files) if (SHA_RE.test(sha) && !(await exists(blobPath(pool, sha)))) lost.push(sha);
  if (lost.length > manifest.missing) throw new BackupFailure(`${lost.length} files this copy needs are not in ${pool}. Choose an older copy, or copy the whole backup folder again.`);
  log(`The copy passed SQLite's check: ${Object.entries(seen.rows).map(([t, n]) => `${n} ${t}`).join(', ')}.`);

  // the data that is there now goes aside, never deleted
  let aside: string | null = null;
  if (fs.existsSync(dataDir) && fs.readdirSync(dataDir).length) {
    aside = `${dataDir}-before-restore-${copyName(opts.now ?? Date.now()).replace('_', '-')}`;
    for (let i = 2; fs.existsSync(aside); i++) aside = `${dataDir}-before-restore-${copyName(opts.now ?? Date.now()).replace('_', '-')}-${i}`;
    try { fs.renameSync(dataDir, aside); } catch (err) {
      throw new BackupFailure(`The current data folder could not be moved aside (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}). Close any program using ${dataDir} and try again. Nothing was changed.`);
    }
    log(`The data that was there is kept in ${aside}.`);
  }
  fs.mkdirSync(path.join(dataDir, 'files'), { recursive: true });
  await fsp.copyFile(path.join(dir, 'hub.db'), path.join(dataDir, 'hub.db'));
  for (const f of ['hub-cert.pem', 'hub-key.pem']) if (fs.existsSync(path.join(dir, f))) await fsp.copyFile(path.join(dir, f), path.join(dataDir, f));
  let files = 0;
  for (const [sha] of seen.files) {
    if (!SHA_RE.test(sha)) continue;
    const src = blobPath(pool, sha);
    if (!(await exists(src))) continue;
    const dest = blobPath(path.join(dataDir, 'files'), sha);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(src, dest);
    files++;
  }
  await fsp.writeFile(path.join(dataDir, 'restored-from.txt'), `Restored ${new Date(opts.now ?? Date.now()).toISOString()} from ${dir}\r\nTaken ${new Date(manifest.takenAt).toISOString()}\r\n${aside ? `The data that was here before is in ${aside}\r\n` : ''}`);
  log(`Restored the database and ${files} files into ${dataDir}.`);
  return { copy: dir, takenAt: manifest.takenAt, hubName: manifest.hubName, aside, files };
}
