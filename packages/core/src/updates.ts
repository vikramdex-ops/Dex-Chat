// Update feed format and the download machinery shared by the desktop app, the hub mirror and
// (later) the Android app. A feed is a small JSON file per channel describing the newest build.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { once } from 'node:events';
import type { TLSSocket } from 'node:tls';

export * from './feed.ts';
export * from './update-sources.ts';
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

/** A response from wherever a build comes from: a URL, or the hub through the gateway's channel. */
export interface RangeResponse {
  status: number;
  body: AsyncIterable<Uint8Array>;
}
/** Starts a download; `headers` carries the Range header when a partial file is resumed. */
export type RangeOpener = (headers: Record<string, string>) => Promise<RangeResponse>;

/**
 * Download `url` to `dest`, resuming a previous partial download (`dest.part`) when the server
 * supports ranges, and verify size and SHA-512 before the file appears under its final name.
 * A file that fails verification is deleted so the next attempt starts clean.
 */
export function downloadVerified(
  url: string,
  dest: string,
  expected: { size: number; sha512: string },
  opts: FetchOptions & { onProgress?: (p: DownloadProgress) => void } = {},
): Promise<string> {
  const open: RangeOpener = async (headers) => {
    const res = await httpGet(url, { ...opts, timeoutMs: opts.timeoutMs ?? 30000, headers });
    return { status: res.statusCode ?? 0, body: res };
  };
  return downloadVerifiedFrom(open, dest, expected, opts);
}

/**
 * The same, from any source that streams bytes (the hub through the internet gateway): the same
 * resume, size limit and SHA-512 check, so where a build came from never decides whether it is trusted.
 */
export async function downloadVerifiedFrom(
  open: RangeOpener,
  dest: string,
  expected: { size: number; sha512: string },
  opts: { onProgress?: (p: DownloadProgress) => void; signal?: AbortSignal } = {},
): Promise<string> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest) && (await fsp.stat(dest)).size === expected.size && (await sha512File(dest)) === expected.sha512) {
    opts.onProgress?.({ received: expected.size, total: expected.size });
    return dest;
  }
  const part = `${dest}.part`;
  let offset = fs.existsSync(part) ? (await fsp.stat(part)).size : 0;
  if (offset >= expected.size) { await fsp.rm(part, { force: true }); offset = 0; }

  const res = await open(offset ? { range: `bytes=${offset}-` } : {});
  if (res.status < 200 || res.status >= 300) {
    void drain(res.body);
    throw new HttpError(res.status, `Download failed (HTTP ${res.status})`);
  }
  if (offset && res.status !== 206) offset = 0; // the server ignored the range: start over
  const out = fs.createWriteStream(part, { flags: offset ? 'a' : 'w' });
  let outError: NodeJS.ErrnoException | null = null;
  out.on('error', (err) => { outError = err; });
  let received = offset;
  opts.onProgress?.({ received, total: expected.size });
  try {
    for await (const chunk of res.body) {
      if (opts.signal?.aborted) throw Object.assign(new Error('Download cancelled.'), { name: 'AbortError' });
      if (outError) throw outError;
      received += chunk.length;
      if (received > expected.size) throw new Error('download is larger than expected');
      if (!out.write(chunk)) await once(out, 'drain');
      opts.onProgress?.({ received, total: expected.size });
    }
    if (outError) throw outError;
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } catch (err) {
    // keep what arrived (the next attempt resumes from it); a broken disk write is not kept
    if (outError) out.destroy(); else await new Promise<void>((resolve) => out.end(() => resolve()));
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOSPC') throw new Error('not enough free disk space for the update');
    if (e.name === 'AbortError' || /larger than expected/.test(e.message)) throw e;
    throw new Error(`download interrupted (${e.message}); it will resume`);
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

async function drain(body: AsyncIterable<Uint8Array>): Promise<void> {
  try { for await (const _ of body) { /* discard */ } } catch { /* gone */ }
}
