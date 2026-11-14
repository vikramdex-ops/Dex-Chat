// In-app updater: finds, downloads, verifies and installs new builds without leaving the app.
//
// Where builds come from, in order of preference for the same version:
//   1. the office hub's mirror (fast LAN copy, works with no internet)
//   2. the public release feed on GitHub
// When it checks: shortly after start-up, every 4 hours, when the hub (re)connects, and on demand.
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chooseUpdate, compareVersions, downloadVerified, feedUrl, fetchFeed, HttpError } from '@dex/core/updates';
import type { Channel, Platform, UpdateChoice, UpdateFeed } from '@dex/core/updates';
import type { UpdateState } from '../shared/bridge.ts';

export interface UpdaterOptions {
  version: string;
  enabled: boolean;
  downloadDir: string;
  channel: () => Channel;
  autoDownload: () => boolean;
  hub: () => { host: string; port: number; fp: string } | null;
  /** Development only: test against a local feed, pretending to be another platform. */
  feedBase?: string;
  platformOverride?: Platform;
  allowHttp?: boolean;
  /** Called right before quitting into the installer, to remember the notes for "what's new". */
  beforeInstall: (version: string, notes: string) => void;
  quit: () => void;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

const CHECK_EVERY_MS = 4 * 3600 * 1000;
const FIRST_CHECK_MS = 8000;
const RETRY_MS = 5 * 60 * 1000;

export function currentPlatform(): Platform | null {
  if (process.platform === 'win32') return 'win-x64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  return null;
}

interface Candidate extends UpdateChoice {
  source: 'hub' | 'internet';
  /** Absolute download URL */
  url: string;
  pin?: string;
}

export class Updater extends EventEmitter {
  state: UpdateState;
  private readonly opts: UpdaterOptions;
  private readonly platform: Platform | null;
  private timer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retries = 0;
  private candidate: Candidate | null = null;
  private readyFile: string | null = null;
  private abort: AbortController | null = null;
  private lastProgressPush = 0;

  constructor(opts: UpdaterOptions, justUpdated: UpdateState['justUpdated']) {
    super();
    this.opts = opts;
    this.platform = opts.platformOverride ?? currentPlatform();
    const enabled = opts.enabled && !!this.platform;
    this.state = {
      phase: enabled ? 'idle' : 'disabled', currentVersion: opts.version, lastCheck: null,
      available: null, progress: null, error: null, justUpdated,
    };
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  start(): void {
    if (this.state.phase === 'disabled') return;
    void this.cleanup();
    this.timer = setTimeout(() => {
      void this.check(false);
      this.timer = setInterval(() => void this.check(false), CHECK_EVERY_MS);
    }, FIRST_CHECK_MS);
  }

  stop(): void {
    if (this.timer) { clearTimeout(this.timer); clearInterval(this.timer); }
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.abort?.abort();
  }

  dismissWhatsNew(): void {
    this.set({ justUpdated: null });
  }

  /** Remove leftovers from earlier updates, keeping only a file that is ready to install. */
  private async cleanup(): Promise<void> {
    try {
      for (const f of await fsp.readdir(this.opts.downloadDir)) {
        const full = path.join(this.opts.downloadDir, f);
        if (full !== this.readyFile && !f.endsWith('.part')) await fsp.rm(full, { recursive: true, force: true });
      }
    } catch { /* nothing downloaded yet */ }
  }

  private async feedsFrom(source: 'hub' | 'internet', channels: Channel[]): Promise<{ feeds: UpdateFeed[]; reachable: boolean; base?: string; pin?: string }> {
    let base: string;
    let pin: string | undefined;
    if (source === 'hub') {
      const hub = this.opts.hub();
      if (!hub) return { feeds: [], reachable: false };
      base = `https://${hub.host.includes(':') ? `[${hub.host}]` : hub.host}:${hub.port}/updates`;
      pin = hub.fp;
    } else {
      base = this.opts.feedBase ?? '';
    }
    const results = await Promise.allSettled(channels.map((ch) =>
      fetchFeed(source === 'hub' || this.opts.feedBase ? `${base}/${ch}.json` : feedUrl(ch), { pinnedFingerprint: pin, timeoutMs: 10000, allowHttp: this.opts.allowHttp })));
    const feeds = results.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []));
    // a 404 means "reachable, nothing published there yet"
    const reachable = results.some((r) => r.status === 'fulfilled' || (r.reason instanceof HttpError && r.reason.status === 404));
    return { feeds, reachable, base, pin };
  }

  /** Look for a newer build. `manual` checks report "up to date" and errors loudly. */
  async check(manual: boolean): Promise<void> {
    const phase = this.state.phase;
    if (phase === 'disabled' || phase === 'checking' || phase === 'downloading' || phase === 'installing') return;
    if (!this.platform) return;
    this.set({ phase: 'checking', error: null });
    const channels: Channel[] = this.opts.channel() === 'beta' ? ['stable', 'beta'] : ['stable'];
    const [hub, net] = await Promise.all([this.feedsFrom('hub', channels), this.feedsFrom('internet', channels)]);

    const hubPick = chooseUpdate(this.opts.version, hub.feeds, this.platform);
    const netPick = chooseUpdate(this.opts.version, net.feeds, this.platform);
    let pick: Candidate | null = null;
    if (hubPick && (!netPick || compareVersions(hubPick.feed.version, netPick.feed.version) >= 0)) {
      pick = { ...hubPick, source: 'hub', url: `${hub.base!.replace(/\/updates$/, '')}${hubPick.asset.url}`, pin: hub.pin };
    } else if (netPick) {
      pick = { ...netPick, source: 'internet', url: netPick.asset.url };
    }

    if (!pick) {
      if (!hub.reachable && !net.reachable) {
        this.set({ phase: this.readyFile ? 'ready' : 'error', lastCheck: Date.now(), error: 'Could not reach the office hub or the internet to check for updates.' });
        if (!manual) this.set({ phase: this.readyFile ? 'ready' : 'idle' });
        return;
      }
      this.set({ phase: this.readyFile ? 'ready' : 'up-to-date', lastCheck: Date.now() });
      return;
    }

    // Already downloaded this (or something newer)? Nothing to do.
    if (this.readyFile && this.candidate && compareVersions(this.candidate.feed.version, pick.feed.version) >= 0) {
      this.set({ phase: 'ready', lastCheck: Date.now() });
      return;
    }

    this.candidate = pick;
    this.readyFile = null;
    this.set({
      phase: 'available', lastCheck: Date.now(), progress: null,
      available: {
        version: pick.feed.version, notes: pick.feed.notes, releasedAt: pick.feed.releasedAt,
        mandatory: pick.mandatory, size: pick.asset.size, source: pick.source,
      },
    });
    if (pick.mandatory || this.opts.autoDownload() || manual) await this.download();
  }

  async download(): Promise<void> {
    const c = this.candidate;
    if (!c || this.state.phase === 'downloading' || this.state.phase === 'installing') return;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.abort = new AbortController();
    const dest = path.join(this.opts.downloadDir, c.asset.file);
    this.set({ phase: 'downloading', error: null, progress: { received: 0, total: c.asset.size } });
    try {
      await this.ensureSpace(c.asset.size);
      await downloadVerified(c.url, dest, c.asset, {
        pinnedFingerprint: c.pin,
        signal: this.abort.signal,
        timeoutMs: 60000,
        onProgress: (p) => {
          const now = Date.now();
          if (now - this.lastProgressPush > 250 || p.received === p.total) {
            this.lastProgressPush = now;
            this.set({ progress: p });
          }
        },
      });
      this.readyFile = dest;
      this.retries = 0;
      this.set({ phase: 'ready', progress: { received: c.asset.size, total: c.asset.size } });
      this.emit('ready', c.feed.version, c.mandatory);
    } catch (err) {
      const message = (err as Error).name === 'AbortError' ? 'Download cancelled.' : (err as Error).message;
      this.opts.log?.('update download failed', { error: message, source: c.source });
      // if the hub copy failed, the next attempt goes to the internet (and vice versa)
      if (c.source === 'hub' && /certificate|ECONNREFUSED|timed out|EHOSTUNREACH/.test(message)) this.candidate = { ...c, source: 'internet', url: c.asset.url.startsWith('/') ? c.url : c.asset.url, pin: undefined };
      this.set({ phase: 'error', error: message });
      if (this.retries < 3) {
        this.retries++;
        this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.download(); }, RETRY_MS);
      }
    } finally {
      this.abort = null;
    }
  }

  private async ensureSpace(bytes: number): Promise<void> {
    await fsp.mkdir(this.opts.downloadDir, { recursive: true });
    try {
      const st = await fsp.statfs(this.opts.downloadDir);
      if (st.bavail * st.bsize < bytes * 1.2 + 50 * 1024 * 1024) throw new Error('Not enough free disk space to download the update.');
    } catch (err) {
      if ((err as Error).message.startsWith('Not enough')) throw err;
    }
  }

  /**
   * Install the downloaded build. `relaunch` = restart into the new version now; otherwise the
   * install happens silently as the app quits (install-on-quit).
   */
  install(relaunch = true): boolean {
    const file = this.readyFile;
    const c = this.candidate;
    if (!file || !c || !fs.existsSync(file)) return false;
    this.set({ phase: 'installing' });
    this.opts.beforeInstall(c.feed.version, c.feed.notes);
    try {
      if (process.platform === 'win32') {
        // NSIS: /S silent, --updated keeps settings, --force-run starts the new version afterwards
        const args = ['/S', '--updated', ...(relaunch ? ['--force-run'] : [])];
        spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } else if (process.platform === 'darwin') {
        this.installMac(file, relaunch);
      } else {
        throw new Error('Self-update is not supported on this platform.');
      }
    } catch (err) {
      this.set({ phase: 'error', error: (err as Error).message });
      return false;
    }
    if (relaunch) this.opts.quit();
    return true;
  }

  /** Swap the .app bundle from the DMG once this process has exited, then reopen it. */
  private installMac(dmg: string, relaunch: boolean): void {
    const bundle = process.execPath.replace(/\/Contents\/MacOS\/[^/]+$/, '');
    if (!bundle.endsWith('.app')) throw new Error('Could not locate the installed application.');
    const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'dexconnect-update-'));
    const script = [
      'set -e',
      `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done`,
      `hdiutil attach -nobrowse -readonly -mountpoint "${mount}" "${dmg}" >/dev/null`,
      `APP=$(find "${mount}" -maxdepth 1 -name "*.app" | head -n 1)`,
      `rm -rf "${bundle}.old" && mv "${bundle}" "${bundle}.old"`,
      `if ditto "$APP" "${bundle}"; then rm -rf "${bundle}.old"; else rm -rf "${bundle}"; mv "${bundle}.old" "${bundle}"; fi`,
      `hdiutil detach "${mount}" -quiet || true`,
      relaunch ? `open "${bundle}"` : 'true',
    ].join('\n');
    spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' }).unref();
  }

  /** Called when the user quits normally: install silently if a build is ready. */
  installOnQuit(): void {
    if (this.state.phase === 'ready' && this.readyFile) this.install(false);
  }
}
