// The hub updates itself. The office runs DexterityConnectHub-Setup.exe once on the server PC; after
// that the hub looks in the release feed for its channel (on start and every few hours), downloads
// a newer setup once (resumable; size and SHA-512 checked against the feed, as the apps' updater
// does), and runs it itself at a quiet time:
//
//   - at 03:00 hub-local time by default (after the 02:00 backup), within a two-hour window;
//   - never while a meeting, call or webinar is live on the hub (it waits, up to the window's end);
//   - after a fresh backup when backups are set up (or tonight's, if the fresh one fails); without
//     a good backup in the last day it waits for the next night. Without backups set up it still
//     updates, and says so.
//
// Running the setup: the hub (a service, as Local System) registers a one-off scheduled task that
// runs `DexterityConnectHub-Setup-<v>.exe /S /SELFUPDATE /NOPOWER` as SYSTEM, so the setup is not a
// child of the service it is about to stop. The setup (Install-Hub.ps1 -SelfUpdate) keeps a copy of
// the running version's programs in `<install>\previous`, replaces them, starts the hub and waits for
// /health to answer with the new version. If it does not, it puts the old programs back and starts
// them again (a rollback), and writes what happened to `<data>\hub-update\result.json`.
//
// The hub writes down its intent before it starts the setup. When it starts again it compares its
// version with that intent: the new version means it worked ("Updated from A to B" in the audit log,
// and a note to the administrators); the old one means the setup went back, and that version is
// not tried again by itself (the Control room shows it, with the setup log and "Try again").
//
// Trust: the same as the apps' updater. The feed comes over HTTPS from the public release
// repository; the setup is used only if its size and SHA-512 match the feed, and it is checked
// again just before it runs. The installers are not code-signed. Never a lower version, never a
// beta on the stable channel.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HUB_UPDATE_DEFAULTS, HUB_UPDATE_WINDOW_MS } from '@dex/core';
import type { HubUpdateConfig, HubUpdateRun, HubUpdateView, HubUpdateWait } from '@dex/core';
import { chooseUpdate, compareVersions, downloadVerified, feedUrl, fetchFeed, sha512File } from '@dex/core/updates';
import type { Channel, UpdateAsset, UpdateFeed } from '@dex/core/updates';

/** The hub setup in the feed, named for the feed's version. */
export const SETUP_FILE_RE = /^DexterityConnectHub-Setup-(\d+(?:\.\d+){1,3})\.exe$/;
export const TASK_NAME = 'Dexterity Connect Hub update';
export const RESULT_FILE = 'result.json';
const DAY = 86_400_000;
/** A backup this recent counts as made for the update. */
const FRESH_MS = 20 * 60_000;
/** The setup should have stopped the hub long before this. */
const ATTEMPT_TIMEOUT_MS = 30 * 60_000;
const DOWNLOAD_RETRY_MS = 30 * 60_000;
const HISTORY = 20;

export class HubUpdateError extends Error {}

export interface LaunchPlan {
  /** The setup, checked against the feed just before. */
  setup: string;
  args: string[];
  version: string;
  from: string;
  /** Where the setup reports what it did (Install-Hub.ps1 -SelfUpdate). */
  result: string;
}
/** Starts the setup so that it outlives the hub's own process (tests pass a stand-in). */
export type Launcher = (plan: LaunchPlan) => Promise<void>;

/** What Install-Hub.ps1 -SelfUpdate writes to result.json. */
export interface SetupResult { mode: string; code: number; version: string; previous: string; message: string; log: string; at: string }

export interface HubUpdateHost {
  dataDir: string;
  /** The version running now. */
  version: string;
  /** null when this hub can install updates itself; otherwise why not. */
  unsupported: string | null;
  launcher: Launcher;
  feedUrls?: Partial<Record<Channel, string>>;
  /** Tests only: a plain-http feed. */
  allowHttp?: boolean;
  meta(key: string): string;
  setMeta(key: string, value: string): void;
  /** Something live on the hub that an update must not cut off, or null. */
  live(): 'webinar' | 'meeting' | 'call' | null;
  backups: {
    configured(): boolean;
    running(): boolean;
    lastSuccessAt(): number | null;
    /** A backup now; resolves when it has finished. */
    run(): Promise<{ ok: boolean; error: string | null }>;
  };
  admins(): Array<{ id: string }>;
  tell(userId: string, text: string, key: string): void;
  audit(actor: string | null, action: string, target: string | null, detail: Record<string, unknown>): void;
  changed(view: HubUpdateView): void;
  log(level: 'info' | 'warn' | 'error' | 'debug', msg: string, extra?: Record<string, unknown>): void;
  /** Where the setup writes its log on the hub PC. */
  setupLog: string;
  now?: () => number;
  checkEveryMs?: number;
  firstCheckDelayMs?: number;
}

interface Target { version: string; channel: Channel; asset: UpdateAsset; releasedAt: string; notes: string }
interface Attempt { version: string; from: string; startedAt: number; by: string | null; backup: HubUpdateRun['backup'] }
interface Failed { version: string; at: number; message: string; log: string | null }
interface State {
  lastCheck: number | null;
  lastError: string | null;
  available: Target | null;
  /** The version whose setup is on disk and matched the feed. */
  downloaded: string | null;
  attempt: Attempt | null;
  /** Versions that did not work: not tried again by themselves. */
  failed: Failed[];
  requested: { by: string; force: boolean; at: number } | null;
  history: HubUpdateRun[];
  /** The version the administrators were told about. */
  told: string | null;
}

const EMPTY: State = { lastCheck: null, lastError: null, available: null, downloaded: null, attempt: null, failed: [], requested: null, history: [], told: null };

export class HubUpdater {
  private readonly h: HubUpdateHost;
  private readonly dir: string;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly every: number;
  private readonly firstDelay: number;
  private busy: Promise<void> | null = null;
  private checking = false;
  private stopped = false;
  private waiting: HubUpdateWait | null = null;
  private checkSoon = false;
  private lastDownloadTry = 0;
  /** The quiet window (its start) or "Update now" (its time) the fresh backup was made for. */
  private backupFor: number | null = null;

  constructor(host: HubUpdateHost) {
    this.h = host;
    this.dir = path.join(host.dataDir, 'hub-update');
    this.now = host.now ?? Date.now;
    this.startedAt = this.now();
    this.every = host.checkEveryMs ?? 4 * 3600_000;
    this.firstDelay = host.firstCheckDelayMs ?? 60_000;
  }

  // ------------------------------------------------------------ settings and state
  config(): HubUpdateConfig {
    try {
      const c = { ...HUB_UPDATE_DEFAULTS, ...(JSON.parse(this.h.meta('hub_update_config') || '{}') as Partial<HubUpdateConfig>) };
      return { auto: c.auto !== false, time: /^([01]\d|2[0-3]):[0-5]\d$/.test(c.time) ? c.time : HUB_UPDATE_DEFAULTS.time, channel: c.channel === 'beta' ? 'beta' : 'stable' };
    } catch { return { ...HUB_UPDATE_DEFAULTS }; }
  }

  private state(): State {
    try { return { ...EMPTY, ...(JSON.parse(this.h.meta('hub_update_state') || '{}') as Partial<State>) }; } catch { return { ...EMPTY }; }
  }

  private save(patch: Partial<State>): State {
    const next = { ...this.state(), ...patch };
    if (!this.stopped) this.h.setMeta('hub_update_state', JSON.stringify(next));
    return next;
  }

  private emit(): void {
    if (!this.stopped) { try { this.h.changed(this.view()); } catch { /* nobody listening */ } }
  }

  private setupPath(version: string): string { return path.join(this.dir, `DexterityConnectHub-Setup-${version}.exe`); }
  get resultPath(): string { return path.join(this.dir, RESULT_FILE); }

  private isFailed(st: State, version: string): boolean { return st.failed.some((f) => f.version === version); }

  // ------------------------------------------------------------ when
  private slot(day: number): number {
    const [h, m] = this.config().time.split(':').map(Number);
    const d = new Date(day);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  }

  /** The start of the quiet window `now` is in, or null outside it. */
  private windowAt(now: number): number | null {
    let s = this.slot(now);
    if (s > now) s = this.slot(now - DAY);
    return now - s < HUB_UPDATE_WINDOW_MS ? s : null;
  }

  private nextWindow(now: number): number {
    const inside = this.windowAt(now);
    if (inside !== null) return now;
    const today = this.slot(now);
    return today > now ? today : this.slot(now + DAY);
  }

  view(now = this.now()): HubUpdateView {
    const st = this.state();
    const cfg = this.config();
    const a = st.available;
    const failed = st.failed.length ? st.failed[st.failed.length - 1] : null;
    const pending = !!a && !this.isFailed(st, a.version) && !this.h.unsupported && !st.attempt;
    return {
      version: this.h.version,
      supported: !this.h.unsupported,
      unsupportedReason: this.h.unsupported,
      config: cfg,
      lastCheck: st.lastCheck,
      lastError: st.lastError,
      checking: this.checking,
      available: a ? { version: a.version, channel: a.channel, size: a.asset.size, releasedAt: a.releasedAt, notes: a.notes } : null,
      downloaded: !!a && st.downloaded === a.version,
      nextAt: pending && (cfg.auto || st.requested) ? (st.requested ? now : this.nextWindow(now)) : null,
      waiting: pending ? this.waiting : null,
      installing: st.attempt ? { version: st.attempt.version, since: st.attempt.startedAt } : null,
      failed: failed && compareVersions(failed.version, this.h.version) > 0 ? failed : null,
      requested: st.requested,
      history: st.history,
      setupLog: this.h.setupLog,
    };
  }

  // ------------------------------------------------------------ the hub's timer
  /** Called on the hub's timer (every few seconds); cheap when there is nothing to do. */
  tick(now = this.now()): void {
    if (this.busy || this.stopped) return;
    this.busy = this.step(now)
      .catch((err: Error) => this.h.log('error', 'hub update step failed', { error: err.message }))
      .finally(() => { this.busy = null; });
  }

  /** Let a step that is running finish (tests), or nothing. */
  idle(): Promise<void> { return this.busy ?? Promise.resolve(); }

  stop(): void { this.stopped = true; }

  private async step(now: number): Promise<void> {
    let st = this.state();
    if (st.attempt) { await this.watch(st.attempt, now); return; }
    // a hub that cannot install updates itself does not look at the internet by itself either
    // (a clock set back counts as due, so a wrong date on the PC cannot stop the checks for good)
    const since = (t: number) => (now < t ? Infinity : now - t);
    const due = !this.h.unsupported && (st.lastCheck === null ? since(this.startedAt) >= this.firstDelay : since(st.lastCheck) >= this.every);
    if (due || this.checkSoon) { this.checkSoon = false; await this.check(now); st = this.state(); }
    const t = st.available;
    if (!t || this.h.unsupported || this.stopped) { this.setWaiting(null); return; }
    const cfg = this.config();
    if (this.isFailed(st, t.version) || (!cfg.auto && !st.requested)) { this.setWaiting(null); return; }
    // the channel or the running version may have changed since the check
    if (compareVersions(t.version, this.h.version) <= 0 || (t.channel === 'beta' && cfg.channel !== 'beta')) {
      this.save({ available: null, requested: null });
      this.emit();
      return;
    }
    if (st.downloaded !== t.version) {
      if (now - this.lastDownloadTry < DOWNLOAD_RETRY_MS && !st.requested) return;
      this.lastDownloadTry = now;
      if (!(await this.download(t))) return;
      st = this.state();
    }
    if (cfg.auto && st.told !== t.version && !st.requested) {
      for (const a of this.h.admins()) {
        this.h.tell(a.id, `**The hub updates itself to ${t.version} at ${cfg.time}** (the hub PC's time, after the night's backup). It is offline for about a minute; if a meeting is going on then, it waits until it ends.\n\nControl room ▸ Backups & leavers ▸ Hub updates shows it, and can update now instead.`, `hub-update-${t.version}`);
      }
      st = this.save({ told: t.version });
      this.h.log('info', 'hub update ready', { version: t.version, at: cfg.time });
      this.emit();
    }

    const req = st.requested;
    const windowStart = this.windowAt(now);
    if (!req && windowStart === null) { this.setWaiting(null); return; }
    if (!req?.force) {
      const live = this.h.live();
      if (live) { this.setWaiting(live); return; }
    }
    if (this.h.backups.running()) { this.setWaiting('backup-running'); return; }

    let backup: HubUpdateRun['backup'] = 'none';
    if (this.h.backups.configured()) {
      const key = req ? req.at : windowStart!;
      const last = this.h.backups.lastSuccessAt();
      if ((!last || now - last > FRESH_MS) && this.backupFor !== key) {
        this.backupFor = key;
        this.setWaiting('backing-up');
        const r = await this.h.backups.run();
        if (!r.ok) this.h.log('warn', 'the backup before the hub update did not work', { error: r.error });
        if (this.stopped) return;
        now = this.now();
      }
      const after = this.h.backups.lastSuccessAt();
      if (after && now - after <= FRESH_MS) backup = 'fresh';
      else if (after && now - after < DAY) backup = 'recent';
      else { this.setWaiting('backup-failed'); return; }
      // a meeting may have started while the backup ran
      if (!req?.force && this.h.live()) { this.setWaiting(this.h.live()); return; }
    }
    await this.apply(t, backup, req?.by ?? null, now);
  }

  private setWaiting(w: HubUpdateWait | null): void {
    if (this.waiting === w) return;
    this.waiting = w;
    this.emit();
  }

  // ------------------------------------------------------------ the feed
  /** Look at the feed now; resolves when done. */
  async check(now = this.now()): Promise<HubUpdateView> {
    if (this.checking) return this.view();
    this.checking = true;
    this.emit();
    const cfg = this.config();
    try {
      const channels: Channel[] = cfg.channel === 'beta' ? ['stable', 'beta'] : ['stable'];
      const feeds: Array<UpdateFeed | null> = [];
      for (const ch of channels) {
        let feed: UpdateFeed | null = null;
        try {
          feed = await fetchFeed(this.h.feedUrls?.[ch] ?? feedUrl(ch), { timeoutMs: 15000, allowHttp: this.h.allowHttp });
        } catch (err) {
          // 404: nothing published on this channel yet
          if (!/HTTP 404/.test((err as Error).message)) throw err;
        }
        // a feed is trusted for its own channel only
        if (feed && feed.channel !== ch) feed = null;
        // only the hub's setup, named for the feed's version (older feeds listed the hub zip)
        if (feed) feed = { ...feed, assets: feed.assets.filter((a) => a.platform === 'hub-win-x64' && SETUP_FILE_RE.exec(a.file)?.[1] === feed!.version) };
        feeds.push(feed);
      }
      const choice = chooseUpdate(this.h.version, feeds, 'hub-win-x64');
      const st = this.state();
      const available: Target | null = choice
        ? { version: choice.feed.version, channel: choice.feed.channel, asset: choice.asset, releasedAt: choice.feed.releasedAt, notes: choice.feed.notes.slice(0, 4000) }
        : null;
      const same = !!available && !!st.available && st.available.version === available.version && st.available.asset.sha512 === available.asset.sha512;
      this.save({ lastCheck: now, lastError: null, available, ...(same ? {} : { downloaded: null }) });
      if (!same) await this.prune(available?.version ?? null);
      if (available && !same) this.h.log('info', 'a newer hub is available', { version: available.version, channel: available.channel });
    } catch (err) {
      this.save({ lastCheck: now, lastError: `The release feed could not be read: ${(err as Error).message}` });
      this.h.log('debug', 'hub update check failed', { error: (err as Error).message });
    } finally {
      this.checking = false;
      this.emit();
    }
    return this.view();
  }

  private async download(t: Target): Promise<boolean> {
    try {
      await downloadVerified(t.asset.url, this.setupPath(t.version), t.asset, { timeoutMs: 60000 });
      this.save({ downloaded: t.version, lastError: null });
      this.h.log('info', 'hub update downloaded and checked', { version: t.version, bytes: t.asset.size });
      this.emit();
      return true;
    } catch (err) {
      this.save({ downloaded: null, lastError: `The setup for ${t.version} could not be downloaded: ${(err as Error).message}` });
      this.h.log('warn', 'hub update download failed', { version: t.version, error: (err as Error).message });
      this.emit();
      return false;
    }
  }

  /** Remove setups no longer needed (keeps `keep`'s, and partial downloads of it). */
  private async prune(keep: string | null): Promise<void> {
    for (const name of await fsp.readdir(this.dir).catch(() => [] as string[])) {
      const v = /^DexterityConnectHub-Setup-(.+?)\.exe(\.part)?$/.exec(name)?.[1];
      if (v && v !== keep) await fsp.rm(path.join(this.dir, name), { force: true }).catch(() => {});
    }
  }

  // ------------------------------------------------------------ installing
  private async apply(t: Target, backup: HubUpdateRun['backup'], by: string | null, now: number): Promise<void> {
    const file = this.setupPath(t.version);
    // checked again just before it runs: the file must still be what the feed described
    let ok = false;
    try { ok = (await fsp.stat(file)).size === t.asset.size && (await sha512File(file)) === t.asset.sha512; } catch { ok = false; }
    if (!ok) {
      await fsp.rm(file, { force: true }).catch(() => {});
      this.save({ downloaded: null, lastError: `The setup for ${t.version} on the hub no longer matched the release feed, so it was not run. It is downloaded again.` });
      this.h.log('warn', 'hub update file changed on disk; not run', { version: t.version });
      this.emit();
      return;
    }
    if (this.stopped) return;
    await fsp.rm(this.resultPath, { force: true }).catch(() => {});
    const from = this.h.version;
    const attempt: Attempt = { version: t.version, from, startedAt: now, by, backup };
    this.save({ attempt, requested: null });
    this.waiting = null;
    this.h.audit(by, 'hub.update.started', null, { from, to: t.version, backup });
    this.h.log('info', 'hub update starting the setup', { from, to: t.version, backup });
    this.emit();
    try {
      await this.h.launcher({ setup: file, args: ['/S', '/SELFUPDATE', '/NOPOWER'], version: t.version, from, result: this.resultPath });
    } catch (err) {
      this.fail(attempt, `The setup could not be started: ${(err as Error).message}`, null, now);
    }
  }

  /** Read what the setup reported, if it reported on this attempt. */
  private readResult(a: Attempt): SetupResult | null {
    try {
      const r = JSON.parse(fs.readFileSync(this.resultPath, 'utf8').replace(/^\uFEFF/, '')) as SetupResult;
      return r && r.version === a.version && typeof r.code === 'number' ? r : null;
    } catch { return null; }
  }

  /** While an attempt is recorded: did it work (the new version runs), or did the setup give up? */
  private async watch(a: Attempt, now: number): Promise<void> {
    if (this.h.version === a.version) { await this.succeed(a, now); return; }
    if (this.h.version !== a.from) {
      // someone installed another version by hand meanwhile
      this.save({ attempt: null });
      this.h.log('info', 'hub update superseded', { from: a.from, to: a.version, running: this.h.version });
      this.emit();
      return;
    }
    const r = this.readResult(a);
    if (r && r.code !== 0) { this.fail(a, r.message || `The setup stopped with exit code ${r.code}.`, r.log || this.h.setupLog, now); return; }
    if (now - a.startedAt > ATTEMPT_TIMEOUT_MS) this.fail(a, 'The setup did not finish (the hub is still the version it was).', this.h.setupLog, now);
  }

  private async succeed(a: Attempt, now: number): Promise<void> {
    const run: HubUpdateRun = { at: now, from: a.from, to: a.version, ok: true, by: a.by, message: `Updated from ${a.from} to ${a.version}.`, log: null, backup: a.backup };
    const st = this.state();
    this.save({ attempt: null, available: null, downloaded: null, requested: null, failed: st.failed.filter((f) => compareVersions(f.version, a.version) > 0), history: [run, ...st.history].slice(0, HISTORY) });
    this.h.audit(null, 'hub.updated', null, { from: a.from, to: a.version, startedAt: a.startedAt, backup: a.backup });
    const at = new Date(now).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const note = a.backup === 'none' ? '\n\nBackups are not set up, so there was no backup just before. Choose a backup folder in Control room ▸ Backups & leavers.' : '';
    for (const ad of this.h.admins()) this.h.tell(ad.id, `**The hub updated itself** from ${a.from} to ${a.version} on ${at}. Everything carries on as before.${note}`, `hub-updated-${a.version}`);
    this.h.log('info', 'hub updated', { from: a.from, to: a.version });
    await this.prune(null);
    this.emit();
  }

  private fail(a: Attempt, message: string, log: string | null, now: number): void {
    const run: HubUpdateRun = { at: now, from: a.from, to: a.version, ok: false, by: a.by, message, log, backup: a.backup };
    const st = this.state();
    this.save({ attempt: null, requested: null, failed: [...st.failed.filter((f) => f.version !== a.version), { version: a.version, at: now, message, log }].slice(-10), history: [run, ...st.history].slice(0, HISTORY) });
    this.h.audit(null, 'hub.update.failed', null, { from: a.from, to: a.version, message });
    for (const ad of this.h.admins()) {
      this.h.tell(ad.id, `**The hub could not update itself to ${a.version}.** It is running ${a.from}, as before. ${message}\n\nIt does not try ${a.version} again by itself. Control room ▸ Backups & leavers ▸ Hub updates has the details and **Try again**.${log ? `\n\nSetup log on the hub PC: ${log}` : ''}`, `hub-update-failed-${a.version}`);
    }
    this.h.log('warn', 'hub update failed', { from: a.from, to: a.version, message });
    this.emit();
  }

  // ------------------------------------------------------------ administrators
  configure(by: string, patch: Record<string, unknown>): HubUpdateView {
    const cur = this.config();
    const next: HubUpdateConfig = { ...cur };
    if (patch.auto !== undefined) {
      if (typeof patch.auto !== 'boolean') throw new HubUpdateError('Choose on or off for automatic updates.');
      next.auto = patch.auto;
    }
    if (patch.time !== undefined) {
      if (typeof patch.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.time)) throw new HubUpdateError('Choose a time like 03:00.');
      next.time = patch.time;
    }
    if (patch.channel !== undefined) {
      if (patch.channel !== 'stable' && patch.channel !== 'beta') throw new HubUpdateError('The channel is stable or beta.');
      next.channel = patch.channel;
    }
    this.h.setMeta('hub_update_config', JSON.stringify(next));
    if (next.channel !== cur.channel) {
      // what was found on the other channel no longer counts: look again
      this.save({ available: null, downloaded: null, requested: null });
      this.checkSoon = true;
    }
    this.h.audit(by, 'hub.update.settings', null, { ...next });
    this.emit();
    return this.view();
  }

  /** "Update now": installs as soon as nothing is live (or at once when forced). */
  async updateNow(by: string, force: boolean): Promise<HubUpdateView> {
    if (this.h.unsupported) throw new HubUpdateError('This hub cannot update itself. Run the new DexterityConnectHub-Setup.exe on the hub PC.');
    if (this.state().attempt) throw new HubUpdateError('The hub is already installing an update.');
    if (!this.state().available) await this.check();
    const st = this.state();
    if (!st.available) throw new HubUpdateError(st.lastError ? 'The hub could not look for a newer version. Check that the hub PC can reach the internet.' : 'The hub is already the newest version.');
    this.save({ requested: { by, force, at: this.now() }, failed: st.failed.filter((f) => f.version !== st.available!.version) });
    this.h.audit(by, 'hub.update.requested', null, { version: st.available.version, force });
    this.emit();
    this.tick();
    return this.view();
  }

  /** Allow a version that did not work to be tried again (at the quiet time, or with "Update now"). */
  retry(by: string): HubUpdateView {
    const st = this.state();
    const f = st.failed[st.failed.length - 1];
    if (!f) throw new HubUpdateError('No update has failed.');
    this.save({ failed: st.failed.filter((x) => x.version !== f.version) });
    this.h.audit(by, 'hub.update.retry', null, { version: f.version });
    this.checkSoon = true;
    this.emit();
    return this.view();
  }
}

// ------------------------------------------------------------ Windows: a one-off scheduled task
const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The task: no trigger (it is run once, now), as SYSTEM, at most an hour, on mains or battery. */
export function taskXml(plan: Pick<LaunchPlan, 'setup' | 'args' | 'version'>): string {
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>${xmlEscape(`Installs Dexterity Connect Hub ${plan.version}. Started by the hub itself; it can be deleted.`)}</Description>`,
    '  </RegistrationInfo>',
    '  <Principals>',
    '    <Principal id="Author">',
    '      <UserId>S-1-5-18</UserId>',
    '      <RunLevel>HighestAvailable</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>false</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <IdleSettings>',
    '      <StopOnIdleEnd>false</StopOnIdleEnd>',
    '      <RestartOnIdle>false</RestartOnIdle>',
    '    </IdleSettings>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    '    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>',
    '    <Priority>7</Priority>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${xmlEscape(plan.setup)}</Command>`,
    `      <Arguments>${xmlEscape(plan.args.join(' '))}</Arguments>`,
    `      <WorkingDirectory>${xmlEscape(path.win32.dirname(plan.setup))}</WorkingDirectory>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

type Run = (file: string, args: string[]) => Promise<void>;
const runTool: Run = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => {
    if (err) reject(new Error(`${path.basename(file)} ${args[0]}: ${(String(stderr) || String(stdout) || err.message).trim()}`));
    else resolve();
  });
});

/**
 * Runs the setup through Task Scheduler, so it is not a child of the hub service it stops (Windows
 * would end it with the service). The task is replaced on every update and left behind afterwards;
 * it has no trigger, so it never runs again by itself.
 */
export function windowsLauncher(dir: string, run: Run = runTool): Launcher {
  return async (plan) => {
    const system = process.env.SystemRoot ?? 'C:\\Windows';
    const schtasks = path.win32.join(system, 'System32', 'schtasks.exe');
    const file = path.join(dir, 'task.xml');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml(plan), 'utf16le')]));
    await run(schtasks, ['/Create', '/TN', TASK_NAME, '/XML', file, '/F']);
    await run(schtasks, ['/Run', '/TN', TASK_NAME]);
  };
}

/** Why this hub cannot update itself, or null when it can: it must be the installed Windows service. */
export function selfUpdateSupport(execPath = process.execPath, platform = process.platform): string | null {
  if (platform !== 'win32') return 'The hub updates itself only on the Windows hub PC, where DexterityConnectHub-Setup.exe installed it.';
  if (path.win32.basename(execPath).toLowerCase() !== 'dexterityconnecthub.exe') return 'This hub runs from source, not from DexterityConnectHub.exe, so it does not update itself.';
  if (!fs.existsSync(path.win32.join(path.win32.dirname(execPath), 'DexterityConnectHubService.exe'))) return 'This hub does not run as the Windows service, so it does not update itself. Install it with DexterityConnectHub-Setup.exe.';
  return null;
}
