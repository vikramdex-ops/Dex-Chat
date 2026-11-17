// File transfer for the desktop app, done in the main process because only Node can talk to
// the hub's self-issued certificate (pinned by fingerprint): uploads with progress, a local
// cache behind the dexfile:// scheme for inline images, and Open / Save for attachments.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import type { IncomingMessage } from 'node:http';
import { app, protocol, shell } from 'electron';
import type { FileInfo } from '@dex/core';
import type { TunnelRequest, TunnelResponse } from '@dex/core/remote';
import type { UploadPlan } from '@dex/core/e2e-client';
import { DAMAGED_FILE } from '@dex/core/e2e-files';
import { MINIAPP_PRIVILEGES } from './miniapps.ts';

export interface HubAccess {
  host: string; port: number; fp: string; token: string;
  /** Outside the office: HTTP inside the gateway's encrypted channel instead of a direct connection. */
  tunnel?: (req: TunnelRequest) => Promise<TunnelResponse>;
}

export const FILE_SCHEME = 'dexfile';

type Bytes = AsyncIterable<Uint8Array>;
/**
 * End-to-end encrypted Direct attachments (set from main.ts with the E2E layer): how to plan an
 * upload (encrypted here first when it is for an encrypted conversation), and how to read a
 * download (decrypted here when this PC has the file's key from its message).
 */
let planner: (convId: string | undefined, file: { name: string; mime?: string; size: number }) => Promise<UploadPlan> = async (_c, file) => ({
  path: `/files?name=${encodeURIComponent(file.name)}${file.mime ? `&type=${encodeURIComponent(file.mime)}` : ''}`, size: file.size, sealed: false,
  transform: (src) => src as Bytes, done: (info) => info,
});
let decryptor: (fileId: string) => ((src: Bytes) => Bytes) | null = () => null;
export function useEncryption(opts: { plan: typeof planner; decrypt: typeof decryptor }): void {
  planner = opts.plan;
  decryptor = opts.decrypt;
}

/** Must run before app 'ready'. */
export function registerFileScheme(): void {
  // one call registers every scheme: the tools' scheme is registered here too
  protocol.registerSchemesAsPrivileged([{ scheme: FILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }, MINIAPP_PRIVILEGES]);
}

function pinnedRequest(access: HubAccess, method: string, pathname: string, headers: Record<string, string | number> = {}): Promise<{ req: ReturnType<typeof https.request>; res: Promise<IncomingMessage> }> {
  return new Promise((resolve) => {
    let resolveRes!: (r: IncomingMessage) => void;
    let rejectRes!: (e: Error) => void;
    const res = new Promise<IncomingMessage>((a, b) => { resolveRes = a; rejectRes = b; });
    const req = https.request({
      host: access.host, port: access.port, path: pathname, method, agent: false, rejectUnauthorized: false,
      headers: { authorization: `Bearer ${access.token}`, ...headers },
    }, resolveRes);
    req.on('socket', (sock) => {
      (sock as TLSSocket).once('secureConnect', () => {
        if ((sock as TLSSocket).getPeerX509Certificate?.()?.fingerprint256 !== access.fp) req.destroy(new Error('The hub presented an unexpected certificate.'));
      });
    });
    req.on('error', rejectRes);
    resolve({ req, res });
  });
}

async function readJson(res: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of res) chunks.push(c as Buffer);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

export interface UploadSource { path?: string; data?: ArrayBuffer; name: string; mime?: string; /** the conversation it is for (Direct files are encrypted here) */ convId?: string }

export async function uploadFile(access: HubAccess, src: UploadSource, onProgress: (sent: number, total: number) => void): Promise<FileInfo> {
  const plainSize = src.path ? (await fsp.stat(src.path)).size : src.data!.byteLength;
  const name = src.name || (src.path ? path.basename(src.path) : 'file');
  const plan = await planner(src.convId, { name, mime: src.mime, size: plainSize });
  const size = plan.size;
  const q = plan.path;
  // the file streams from disk (and through encryption) without being read into memory
  const read = (): Bytes => (src.path ? fs.createReadStream(src.path, { highWaterMark: 256 * 1024 }) : Readable.from([Buffer.from(src.data!)])) as Bytes;
  let sent = 0;
  let last = 0;
  async function* chunks(): AsyncIterable<Uint8Array> {
    for await (const c of plan.transform(read())) {
      sent += c.length;
      const now = Date.now();
      if (now - last > 120 || sent === size) { last = now; onProgress(sent, size); }
      yield c;
    }
  }
  if (access.tunnel) {
    const r = await access.tunnel({ method: 'POST', path: q, headers: { authorization: `Bearer ${access.token}`, 'content-length': String(size), 'content-type': 'application/octet-stream' }, body: chunks() });
    const parts: Uint8Array[] = [];
    for await (const p of r.body) parts.push(p);
    let json: FileInfo & { error?: string };
    try { json = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { json = {} as FileInfo & { error?: string }; }
    if (r.status !== 200) throw new Error(json.error ?? `Upload failed (${r.status}).`);
    return plan.done(json);
  }
  const { req, res } = await pinnedRequest(access, 'POST', q, { 'content-length': size, 'content-type': 'application/octet-stream' });
  const body = Readable.from(chunks(), { objectMode: false });
  body.on('error', (err) => req.destroy(err));
  body.pipe(req);
  const r = await res;
  const json = await readJson(r) as FileInfo & { error?: string };
  if ((r.statusCode ?? 0) !== 200) throw new Error(json.error ?? `Upload failed (${r.statusCode}).`);
  return plan.done(json);
}

/** Write a download to `part`, decrypting it on the way when it is an encrypted attachment. */
async function writeDownload(id: string, body: Bytes, part: string, total: number, onProgress?: Progress): Promise<void> {
  const decrypt = decryptor(id);
  let got = 0;
  let last = 0;
  async function* counted(): Bytes {
    for await (const p of body) {
      got += p.length;
      if (onProgress && (Date.now() - last > 100 || got === total)) { last = Date.now(); onProgress(got, total || got); }
      yield p;
    }
  }
  const out = fs.createWriteStream(part);
  const closed = new Promise<void>((res, rej) => { out.on('finish', () => res()); out.on('error', rej); });
  try {
    for await (const p of decrypt ? decrypt(counted()) : counted()) {
      if (!out.write(p)) await new Promise<void>((res) => out.once('drain', () => res()));
    }
    out.end();
    await closed;
  } catch (e) {
    out.destroy();
    await fsp.rm(part, { force: true });
    const msg = (e as Error).message;
    throw new Error(msg === DAMAGED_FILE ? msg : `Download interrupted: ${msg}`);
  }
}

const cacheDir = () => path.join(app.getPath('userData'), 'file-cache');
const safeName = (n: string) => n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 150) || 'file';

/** Download a file into the local cache (once) and return its path. */
/** Downloads in progress, so two requests for one file (a video asks more than once) share one. */
const inFlight = new Map<string, Promise<string>>();

type Progress = (got: number, total: number) => void;

function fetchToCache(access: HubAccess, id: string, name: string, onProgress?: Progress): Promise<string> {
  const target = path.join(cacheDir(), id, safeName(name));
  if (fs.existsSync(target)) { if (onProgress) { const n = fs.statSync(target).size; onProgress(n, n); } return Promise.resolve(target); }
  const running = inFlight.get(target);
  if (running) return running;
  const p = download(access, id, target, onProgress).finally(() => inFlight.delete(target));
  inFlight.set(target, p);
  return p;
}

async function download(access: HubAccess, id: string, target: string, onProgress?: Progress): Promise<string> {
  const dir = path.dirname(target);
  await fsp.mkdir(dir, { recursive: true });
  const part = `${target}.part`;
  if (access.tunnel) {
    const r = await access.tunnel({ method: 'GET', path: `/files/${id}?download=1`, headers: { authorization: `Bearer ${access.token}` } });
    if (r.status !== 200) { for await (const _ of r.body) { /* drain */ } throw new Error(r.status === 404 ? 'That file is no longer available.' : `Download failed (${r.status}).`); }
    await writeDownload(id, r.body, part, Number(r.headers['content-length'] ?? 0), onProgress);
    await fsp.rename(part, target);
    return target;
  }
  const { req, res } = await pinnedRequest(access, 'GET', `/files/${id}?download=1`);
  req.end();
  const r = await res;
  if ((r.statusCode ?? 0) !== 200) { r.resume(); throw new Error(r.statusCode === 404 ? 'That file is no longer available.' : `Download failed (${r.statusCode}).`); }
  // an aborted response ends its iteration with an error, which writeDownload reports
  await writeDownload(id, r as unknown as Bytes, part, Number(r.headers['content-length'] ?? 0), onProgress);
  await fsp.rename(part, target);
  return target;
}

/** The file downloaded into the local cache (for handing to another program). */
export const cachedFile = (access: HubAccess, id: string, name: string) => fetchToCache(access, id, name);

export async function openFile(access: HubAccess, id: string, name: string): Promise<void> {
  const p = await fetchToCache(access, id, name);
  const err = await shell.openPath(p);
  if (err) { shell.showItemInFolder(p); }
}

export async function saveFile(access: HubAccess, id: string, name: string, onProgress?: Progress): Promise<string> {
  const cached = await fetchToCache(access, id, name, onProgress);
  const dir = app.getPath('downloads');
  const ext = path.extname(name);
  const base = safeName(path.basename(name, ext));
  let target = path.join(dir, `${base}${ext}`);
  for (let i = 2; fs.existsSync(target); i++) target = path.join(dir, `${base} (${i})${ext}`);
  await fsp.copyFile(cached, target);
  shell.showItemInFolder(target);
  return target;
}

/** dexfile://f/<id> → the cached file (images shown inline in conversations). */
export function handleFileScheme(getAccess: () => HubAccess | null): void {
  protocol.handle(FILE_SCHEME, async (request) => {
    const u = new URL(request.url);
    const m = u.pathname.match(/^\/([0-9A-Z]{26})$/);
    const access = getAccess();
    if (!m || !access) return new Response('not found', { status: 404 });
    try {
      const p = await fetchToCache(access, m[1], 'image');
      let ext = (await sniffImage(p)) ?? 'application/octet-stream';
      const size = (await fsp.stat(p)).size;
      // video messages and screen recordings: the same containers as audio, played as video
      if (u.searchParams.get('as') === 'video' && (ext === 'audio/webm' || ext === 'audio/mp4')) ext = ext.replace('audio/', 'video/');
      // byte ranges, so audio and video can seek
      const range = request.headers.get('range')?.match(/^bytes=(\d*)-(\d*)$/);
      if (range && size > 0) {
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
        if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
        return new Response(Readable.toWeb(fs.createReadStream(p, { start, end })) as ReadableStream, {
          status: 206,
          headers: { 'content-type': ext, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1), 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=31536000, immutable', 'access-control-allow-origin': '*' },
        });
      }
      return new Response(Readable.toWeb(fs.createReadStream(p)) as ReadableStream, {
        headers: { 'content-type': ext, 'content-length': String(size), 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=31536000, immutable', 'access-control-allow-origin': '*' },
      });
    } catch {
      return new Response('unavailable', { status: 502 });
    }
  });
}

async function sniffImage(p: string): Promise<string | null> {
  const fh = await fsp.open(p, 'r');
  const buf = Buffer.alloc(12);
  await fh.read(buf, 0, 12, 0);
  await fh.close();
  if (buf.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.subarray(0, 3).toString() === 'GIF') return 'image/gif';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  // voice notes and other audio played inline
  if (buf.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'))) return 'audio/webm';
  if (buf.subarray(0, 4).toString() === 'OggS') return 'audio/ogg';
  if (buf.subarray(0, 3).toString() === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (buf.subarray(4, 8).toString() === 'ftyp') return 'audio/mp4';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WAVE') return 'audio/wav';
  if (buf.subarray(0, 2).toString() === 'BM') return 'image/bmp';
  return null;
}

/** Keep the image cache from growing without bound: drop entries untouched for 30 days. */
export async function pruneCache(): Promise<void> {
  try {
    const cutoff = Date.now() - 30 * 86400000;
    for (const d of await fsp.readdir(cacheDir())) {
      const st = await fsp.stat(path.join(cacheDir(), d));
      if (st.mtimeMs < cutoff) await fsp.rm(path.join(cacheDir(), d), { recursive: true, force: true });
    }
  } catch { /* nothing cached */ }
}
