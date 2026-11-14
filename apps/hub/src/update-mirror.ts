// Keeps a verified copy of the newest Dexterity Connect builds on the hub, so office PCs and
// phones can update over the LAN even when they have no internet. Whenever the hub can reach
// the public release feed it downloads new builds once, checks their SHA-512, and serves them.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { downloadVerified, feedUrl, fetchFeed, parseFeed } from '@dex/core/updates';
import type { Channel, Platform, UpdateFeed } from '@dex/core/updates';

export interface MirrorOptions {
  dir: string;
  feedUrls?: Partial<Record<Channel, string>>;
  platforms?: Platform[];
  intervalMs?: number;
  firstCheckDelayMs?: number;
  /** Tests only: allow a plain-http feed. */
  allowHttp?: boolean;
  log?: (level: 'info' | 'warn' | 'error' | 'debug', msg: string, extra?: Record<string, unknown>) => void;
}

export interface MirrorStatus {
  lastCheck: number | null;
  lastError: string | null;
  checking: boolean;
  channels: Partial<Record<Channel, { version: string; mirroredAt: number }>>;
}

const CHANNELS: Channel[] = ['stable', 'beta'];
const FILE_RE = /^\/updates\/files\/(\d+(?:\.\d+){1,3})\/([\w.\-]+)$/;

export class UpdateMirror {
  private readonly dir: string;
  private readonly feedUrls: Record<Channel, string>;
  private readonly platforms: Platform[];
  private readonly intervalMs: number;
  private readonly firstDelay: number;
  private readonly allowHttp: boolean;
  private readonly log: NonNullable<MirrorOptions['log']>;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  readonly status: MirrorStatus = { lastCheck: null, lastError: null, checking: false, channels: {} };

  constructor(opts: MirrorOptions) {
    this.dir = opts.dir;
    this.feedUrls = { stable: opts.feedUrls?.stable ?? feedUrl('stable'), beta: opts.feedUrls?.beta ?? feedUrl('beta') };
    this.platforms = opts.platforms ?? ['win-x64', 'mac-arm64', 'mac-x64', 'android'];
    this.intervalMs = opts.intervalMs ?? 6 * 3600 * 1000;
    this.firstDelay = opts.firstCheckDelayMs ?? 30_000;
    this.allowHttp = opts.allowHttp === true;
    this.log = opts.log ?? (() => {});
    for (const ch of CHANNELS) {
      const feed = this.readManifest(ch);
      if (feed) this.status.channels[ch] = { version: feed.version, mirroredAt: fs.statSync(this.manifestPath(ch)).mtimeMs };
    }
  }

  start(): void {
    const tick = () => { void this.refresh(); };
    this.timer = setTimeout(function loop(this: UpdateMirror) {
      tick();
      this.timer = setTimeout(loop.bind(this), this.intervalMs);
    }.bind(this), this.firstDelay);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private manifestPath(ch: Channel): string { return path.join(this.dir, `${ch}.json`); }
  private filesDir(version: string): string { return path.join(this.dir, 'files', version); }

  readManifest(ch: Channel): UpdateFeed | null {
    try { return parseFeed(JSON.parse(fs.readFileSync(this.manifestPath(ch), 'utf8')), { allowHttp: this.allowHttp }); } catch { return null; }
  }

  /** Check the public feed and mirror anything new. Concurrent calls share one run. */
  refresh(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.doRefresh().finally(() => { this.running = null; });
    return this.running;
  }

  private async doRefresh(): Promise<void> {
    this.status.checking = true;
    this.status.lastError = null;
    try {
      for (const ch of CHANNELS) {
        let feed: UpdateFeed | null;
        try {
          feed = await fetchFeed(this.feedUrls[ch], { timeoutMs: 15000, allowHttp: this.allowHttp });
        } catch (err) {
          const msg = (err as Error).message;
          // 404 just means nothing has been published on this channel yet
          if (!/HTTP 404/.test(msg)) throw err;
          continue;
        }
        if (!feed) continue;
        const current = this.readManifest(ch);
        if (current && current.version === feed.version) continue;
        this.log('info', 'mirroring update', { channel: ch, version: feed.version });
        for (const asset of feed.assets.filter((a) => this.platforms.includes(a.platform))) {
          await downloadVerified(asset.url, path.join(this.filesDir(feed.version), asset.file), asset, { timeoutMs: 60000 });
        }
        const tmp = `${this.manifestPath(ch)}.tmp`;
        await fsp.mkdir(this.dir, { recursive: true });
        await fsp.writeFile(tmp, JSON.stringify(feed, null, 2));
        await fsp.rename(tmp, this.manifestPath(ch));
        this.status.channels[ch] = { version: feed.version, mirroredAt: Date.now() };
        this.log('info', 'update mirrored', { channel: ch, version: feed.version });
      }
      await this.prune();
    } catch (err) {
      this.status.lastError = (err as Error).message;
      this.log('debug', 'update mirror could not refresh', { error: this.status.lastError });
    } finally {
      this.status.checking = false;
      this.status.lastCheck = Date.now();
    }
  }

  /** Delete builds no channel points at any more. */
  private async prune(): Promise<void> {
    const keep = new Set(CHANNELS.map((c) => this.readManifest(c)?.version).filter(Boolean));
    const root = path.join(this.dir, 'files');
    if (!fs.existsSync(root)) return;
    for (const v of await fsp.readdir(root)) {
      if (!keep.has(v)) await fsp.rm(path.join(root, v), { recursive: true, force: true });
    }
  }

  /** The channel feed as served by the hub: asset URLs point at the hub itself. */
  localFeed(ch: Channel): UpdateFeed | null {
    const feed = this.readManifest(ch);
    if (!feed) return null;
    return {
      ...feed,
      assets: feed.assets
        .filter((a) => fs.existsSync(path.join(this.filesDir(feed.version), a.file)))
        .map((a) => ({ ...a, url: `/updates/files/${feed.version}/${a.file}` })),
    };
  }

  /** Handles /updates/* requests. Returns false when the URL is not an update URL. */
  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = (req.url ?? '').split('?')[0];
    if (!url.startsWith('/updates/')) return false;
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') { send(405, { error: 'method not allowed' }); return true; }

    const feedMatch = url.match(/^\/updates\/(stable|beta)\.json$/);
    if (feedMatch) {
      const feed = this.localFeed(feedMatch[1] as Channel);
      if (!feed) send(404, { error: 'no build mirrored for this channel yet' });
      else send(200, feed);
      return true;
    }

    const m = url.match(FILE_RE);
    const file = m ? path.join(this.filesDir(m[1]), m[2]) : null;
    if (!file || !fs.existsSync(file)) { send(404, { error: 'not found' }); return true; }
    const size = fs.statSync(file).size;
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    const headers = { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        res.writeHead(416, { 'content-range': `bytes */${size}` });
        res.end();
        return true;
      }
      res.writeHead(206, { ...headers, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}` });
      if (req.method === 'HEAD') res.end(); else fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...headers, 'content-length': size });
      if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
    }
    return true;
  }
}
