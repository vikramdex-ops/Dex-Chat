// Update feed format and the download machinery shared by the desktop app, the hub mirror and
// (later) the Android app. A feed is a small JSON file per channel describing the newest build.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import type { TLSSocket } from 'node:tls';

export * from './feed.ts';
import { parseFeed } from './feed.ts';
import type { UpdateFeed } from './feed.ts';

// ------------------------------------------------------------------ transport

export interface FetchOptions {
  /** Tests only: accept plain-http asset links in a feed. */
  allowHttp?: boolean;
  /** Pin a self-issued certificate (the hub) by SHA-256 fingerprint instead of normal TLS trust. */
  pinnedFingerprint?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxRedirects?: number;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** GET with redirects, timeouts, abort and optional certificate pinning. Resolves with the response stream. */
export function httpGet(url: string, opts: FetchOptions = {}): Promise<http.IncomingMessage> {
  const { pinnedFingerprint, headers = {}, timeoutMs = 20000, signal, maxRedirects = 5 } = opts;
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!lib) { reject(new Error(`unsupported URL: ${url}`)); return; }
    const req = (lib as typeof https).request(u, {
      method: 'GET',
      headers: { 'user-agent': 'DexterityConnect-Updater', ...headers },
      timeout: timeoutMs,
      signal,
      // pinned requests use a fresh connection so the certificate is checked on every handshake
      ...(pinnedFingerprint ? { rejectUnauthorized: false, agent: false } : {}),
    }, (res) => {
      if (pinFailed) { res.destroy(); return; }
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (maxRedirects <= 0) { reject(new Error('too many redirects')); return; }
        const next = new URL(res.headers.location, u).toString();
        // never carry a pin to another host, and never downgrade to http
        const nextPin = new URL(next).host === u.host ? pinnedFingerprint : undefined;
        if (u.protocol === 'https:' && next.startsWith('http:')) { reject(new Error('refusing https → http redirect')); return; }
        httpGet(next, { ...opts, pinnedFingerprint: nextPin, maxRedirects: maxRedirects - 1 }).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        reject(new HttpError(status, `HTTP ${status} for ${u.host}${u.pathname}`));
        return;
      }
      resolve(res);
    });
    let pinFailed = false;
    if (pinnedFingerprint) {
      req.on('socket', (sock) => {
        (sock as TLSSocket).once('secureConnect', () => {
          const fp = (sock as TLSSocket).getPeerX509Certificate?.()?.fingerprint256;
          if (fp !== pinnedFingerprint) {
            pinFailed = true;
            req.destroy(new Error('the hub presented an unexpected certificate'));
          }
        });
      });
    }
    req.on('timeout', () => req.destroy(new Error(`timed out contacting ${u.host}`)));
    req.on('error', reject);
    req.end();
  });
}

export async function fetchFeed(url: string, opts: FetchOptions = {}): Promise<UpdateFeed | null> {
  const res = await httpGet(url, { ...opts, headers: { 'cache-control': 'no-cache', ...opts.headers } });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of res) {
    size += (c as Buffer).length;
    if (size > 256 * 1024) throw new Error('update feed is too large');
    chunks.push(c as Buffer);
  }
  try {
    return parseFeed(JSON.parse(Buffer.concat(chunks).toString('utf8')), { allowHttp: opts.allowHttp });
  } catch {
    return null;
  }
}

export async function sha512File(file: string): Promise<string> {
  const hash = crypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('base64');
}

export interface DownloadProgress {
  received: number;
  total: number;
}

/**
 * Download `url` to `dest`, resuming a previous partial download (`dest.part`) when the server
 * supports ranges, and verify size and SHA-512 before the file appears under its final name.
 * A file that fails verification is deleted so the next attempt starts clean.
 */
export async function downloadVerified(
  url: string,
  dest: string,
  expected: { size: number; sha512: string },
  opts: FetchOptions & { onProgress?: (p: DownloadProgress) => void } = {},
): Promise<string> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest) && (await fsp.stat(dest)).size === expected.size && (await sha512File(dest)) === expected.sha512) {
    opts.onProgress?.({ received: expected.size, total: expected.size });
    return dest;
  }
  const part = `${dest}.part`;
  let offset = fs.existsSync(part) ? (await fsp.stat(part)).size : 0;
  if (offset >= expected.size) { await fsp.rm(part, { force: true }); offset = 0; }

  const res = await httpGet(url, { ...opts, timeoutMs: opts.timeoutMs ?? 30000, headers: offset ? { range: `bytes=${offset}-` } : {} });
  if (offset && res.statusCode !== 206) offset = 0; // server ignored the range: start over
  const out = fs.createWriteStream(part, { flags: offset ? 'a' : 'w' });
  let received = offset;
  opts.onProgress?.({ received, total: expected.size });
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => { if (!settled) { settled = true; reject(err); } res.destroy(); };
      res.on('data', (chunk: Buffer) => {
        if (settled) return;
        received += chunk.length;
        if (received > expected.size) { fail(new Error('download is larger than expected')); return; }
        if (!out.write(chunk)) { res.pause(); out.once('drain', () => res.resume()); }
        opts.onProgress?.({ received, total: expected.size });
      });
      res.on('end', () => { if (!settled) out.end(() => { settled = true; resolve(); }); });
      res.on('error', (err) => fail(err));
      res.on('aborted', () => fail(new Error('download interrupted; it will resume')));
      out.on('error', (err: NodeJS.ErrnoException) => fail(err.code === 'ENOSPC' ? new Error('not enough free disk space for the update') : err));
    });
  } catch (err) {
    out.destroy();
    throw err;
  }

  const size = (await fsp.stat(part)).size;
  if (size !== expected.size) throw new Error(`download incomplete (${size} of ${expected.size} bytes); it will resume`);
  const digest = await sha512File(part);
  if (digest !== expected.sha512) {
    await fsp.rm(part, { force: true });
    throw new Error('the downloaded file failed its integrity check and was discarded');
  }
  await fsp.rm(dest, { force: true });
  await fsp.rename(part, dest);
  return dest;
}
