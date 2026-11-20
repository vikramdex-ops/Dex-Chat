// In-app updater: finds, downloads, verifies and installs new builds without leaving the app.
//
// Where builds come from (packages/core/src/update-sources.ts): all asked at once, newest wins,
// and for the same version in this order of preference:
//   1. the office hub's mirror on the office network (fast LAN copy, works with no internet)
//   2. the same mirror through the internet gateway, when the app is connected that way (at home)
//   3. the public release feed on GitHub
//   4. the same feed through a second CDN (jsDelivr), for networks that block GitHub's raw files
// The download falls back from one route to the next; every route ends in the same size and
// SHA-512 check (downloadVerified / downloadVerifiedFrom).
// When it checks: shortly after start-up, every 4 hours, when the hub (re)connects, and on demand.
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkSources, compareVersions, parseFeed, downloadVerified, downloadVerifiedFrom, fetchFeed, hubFeedPath, HttpError, internetFeedUrl, pickUpdate, reportOf, tryRoutes } from '@dex/core/updates';
import type { Channel, Platform, Route, UpdateFeed, UpdatePick, UpdateSource } from '@dex/core/updates';
import type { TunnelRequest, TunnelResponse } from '@dex/core/remote';
import type { UpdateState } from '../shared/bridge.ts';

export interface UpdaterOptions {
  version: string;
  enabled: boolean;
  downloadDir: string;
  channel: () => Channel;
  autoDownload: () => boolean;
  /** The hub on the office network (null when not connected that way). */
  hub: () => { host: string; port: number; fp: string } | null;
  /** HTTP to the hub through the internet gateway's encrypted channel, while connected that way. */
  tunnel?: () => ((req: TunnelRequest) => Promise<TunnelResponse>) | null;
  /** Development only: test against a local feed (and mirror), pretending to be another platform. */
  feedBase?: string;
  mirrorBase?: string;
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

const hubBaseOf = (hub: { host: string; port: number }) => `https://${hub.host.includes(':') ? `[${hub.host}]` : hub.host}:${hub.port}`;
type Candidate = UpdatePick;

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

  /** How each source is asked for a channel's feed; a source that does not apply now is left out. */
  private fetchers(): Partial<Record<UpdateSource, (ch: Channel) => Promise<UpdateFeed | null>>> {
    const o = this.opts;
    const quiet404 = (p: Promise<UpdateFeed | null>) => p.catch((err) => { if (err instanceof HttpError && err.status === 404) return null; throw err; });
    const out: Partial<Record<UpdateSource, (ch: Channel) => Promise<UpdateFeed | null>>> = {};
    const hub = o.hub();
    if (hub) out['hub-lan'] = (ch) => quiet404(fetchFeed(`${hubBaseOf(hub)}${hubFeedPath(ch)}`, { pinnedFingerprint: hub.fp, timeoutMs: 10000, allowHttp: o.allowHttp }));
    const tunnel = o.tunnel?.();
    if (tunnel) out['hub-gateway'] = (ch) => feedThroughTunnel(tunnel, hubFeedPath(ch), o.allowHttp);
    // development: a local feed stands in for GitHub, and the mirror only when one is given
    if (o.feedBase) out.internet = (ch) => quiet404(fetchFeed(`${o.feedBase}/${ch}.json`, { timeoutMs: 10000, allowHttp: o.allowHttp }));
    else out.internet = (ch) => quiet404(fetchFeed(internetFeedUrl('internet', ch), { timeoutMs: 10000 }));
    if (o.mirrorBase) out.mirror = (ch) => quiet404(fetchFeed(`${o.mirrorBase}/${ch}.json`, { timeoutMs: 10000, allowHttp: o.allowHttp }));
    else if (!o.feedBase) out.mirror = (ch) => quiet404(fetchFeed(internetFeedUrl('mirror', ch), { timeoutMs: 10000 }));
    return out;
  }

  /** Look for a newer build. `manual` checks report "up to date" and errors loudly. */
  async check(manual: boolean): Promise<void> {
    const phase = this.state.phase;
    if (phase === 'disabled' || phase === 'checking' || phase === 'downloading' || phase === 'installing') return;
    if (!this.platform) return;
    this.set({ phase: 'checking', error: null });
    const channels: Channel[] = this.opts.channel() === 'beta' ? ['stable', 'beta'] : ['stable'];
    const results = await checkSources(this.fetchers(), channels);
    const checked = reportOf(results);
    const pick = pickUpdate(this.opts.version, results, this.platform);
    this.opts.log?.('update check', { sources: checked.map((c) => `${c.source}:${c.ok ? 'ok' : 'no answer'}`).join(' '), found: pick?.feed.version ?? '' });

    if (!pick) {
      if (!results.some((r) => r.reachable)) {
        this.set({ phase: this.readyFile ? 'ready' : 'error', lastCheck: Date.now(), checked, error: 'Could not check for updates: neither the office hub nor the update servers on the internet answered.' });
        if (!manual) this.set({ phase: this.readyFile ? 'ready' : 'idle' });
        return;
      }
      this.set({ phase: this.readyFile ? 'ready' : 'up-to-date', lastCheck: Date.now(), checked });
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
      phase: 'available', lastCheck: Date.now(), progress: null, checked,
      available: {
        version: pick.feed.version, notes: pick.feed.notes, releasedAt: pick.feed.releasedAt,
        mandatory: pick.mandatory, size: pick.asset.size, source: pick.source === 'hub-lan' || pick.source === 'hub-gateway' ? 'hub' : 'internet',
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
    const onProgress = (p: { received: number; total: number }) => {
      const now = Date.now();
      if (now - this.lastProgressPush > 250 || p.received === p.total) {
        this.lastProgressPush = now;
        this.set({ progress: p });
      }
    };
    const signal = this.abort.signal;
    try {
      await this.ensureSpace(c.asset.size);
      const { route } = await tryRoutes(c.routes, (r) => this.downloadFrom(r, dest, c, signal, onProgress),
        (r, err) => this.opts.log?.('update download failed; trying the next source', { route: r.route, error: err.message }));
      this.readyFile = dest;
      this.retries = 0;
      this.set({ phase: 'ready', progress: { received: c.asset.size, total: c.asset.size } });
      this.opts.log?.('update downloaded', { version: c.feed.version, route: route.route });
      this.emit('ready', c.feed.version, c.mandatory);
    } catch (err) {
      const message = (err as Error).name === 'AbortError' ? 'Download cancelled.' : (err as Error).message;
      this.opts.log?.('update download failed', { error: message });
      this.set({ phase: 'error', error: message });
      if (this.retries < 3 && (err as Error).name !== 'AbortError') {
        this.retries++;
        this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.download(); }, RETRY_MS);
      }
    } finally {
      this.abort = null;
    }
  }

  /** One route: the hub on the office network (pinned), the hub through the gateway, or GitHub. */
  private async downloadFrom(r: Route, dest: string, c: Candidate, signal: AbortSignal, onProgress: (p: { received: number; total: number }) => void): Promise<string> {
    if (r.route === 'hub-lan') {
      const hub = this.opts.hub();
      if (!hub) throw new Error('not on the office network any more');
      return downloadVerified(`${hubBaseOf(hub)}${r.url}`, dest, c.asset, { pinnedFingerprint: hub.fp, signal, timeoutMs: 60000, onProgress });
    }
    if (r.route === 'hub-gateway') {
      const tunnel = this.opts.tunnel?.();
      if (!tunnel) throw new Error('not connected through the internet gateway any more');
      return downloadVerifiedFrom(async (headers) => tunnel({ method: 'GET', path: r.url, headers }), dest, c.asset, { signal, onProgress });
    }
    return downloadVerified(r.url, dest, c.asset, { signal, timeoutMs: 60000, onProgress, allowHttp: this.opts.allowHttp });
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

/** A channel's feed from the hub through the gateway's channel (the hub's links are paths on the hub). */
async function feedThroughTunnel(tunnel: (req: TunnelRequest) => Promise<TunnelResponse>, p: string, allowHttp?: boolean): Promise<UpdateFeed | null> {
  const res = await tunnel({ method: 'GET', path: p, headers: { 'cache-control': 'no-cache' } });
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const part of res.body) {
    size += part.length;
    if (size > 256 * 1024) throw new Error('update feed is too large');
    parts.push(part);
  }
  if (res.status === 404) return null;
  if (res.status !== 200) throw new HttpError(res.status, `HTTP ${res.status} from the hub through the gateway`);
  try {
    return parseFeed(JSON.parse(Buffer.concat(parts).toString('utf8')), { allowHttp });
  } catch {
    return null;
  }
}
