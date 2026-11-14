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

export interface HubAccess { host: string; port: number; fp: string; token: string }

export const FILE_SCHEME = 'dexfile';

/** Must run before app 'ready'. */
export function registerFileScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: FILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
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

export interface UploadSource { path?: string; data?: ArrayBuffer; name: string; mime?: string }

export async function uploadFile(access: HubAccess, src: UploadSource, onProgress: (sent: number, total: number) => void): Promise<FileInfo> {
  const size = src.path ? (await fsp.stat(src.path)).size : src.data!.byteLength;
  const name = src.name || (src.path ? path.basename(src.path) : 'file');
  const q = `/files?name=${encodeURIComponent(name)}${src.mime ? `&type=${encodeURIComponent(src.mime)}` : ''}`;
  const { req, res } = await pinnedRequest(access, 'POST', q, { 'content-length': size, 'content-type': 'application/octet-stream' });
  let sent = 0;
  let last = 0;
  const tick = (n: number) => {
    sent += n;
    const now = Date.now();
    if (now - last > 120 || sent === size) { last = now; onProgress(sent, size); }
  };
  const body: Readable = src.path ? fs.createReadStream(src.path, { highWaterMark: 256 * 1024 }) : Readable.from([Buffer.from(src.data!)]);
  body.on('data', (c: Buffer) => tick(c.length));
  body.pipe(req);
  const r = await res;
  const json = await readJson(r) as FileInfo & { error?: string };
  if ((r.statusCode ?? 0) !== 200) throw new Error(json.error ?? `Upload failed (${r.statusCode}).`);
  return json;
}

const cacheDir = () => path.join(app.getPath('userData'), 'file-cache');
const safeName = (n: string) => n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 150) || 'file';

/** Download a file into the local cache (once) and return its path. */
async function fetchToCache(access: HubAccess, id: string, name: string): Promise<string> {
  const dir = path.join(cacheDir(), id);
  const target = path.join(dir, safeName(name));
  if (fs.existsSync(target)) return target;
  await fsp.mkdir(dir, { recursive: true });
  const { req, res } = await pinnedRequest(access, 'GET', `/files/${id}?download=1`);
  req.end();
  const r = await res;
  if ((r.statusCode ?? 0) !== 200) { r.resume(); throw new Error(r.statusCode === 404 ? 'That file is no longer available.' : `Download failed (${r.statusCode}).`); }
  const part = `${target}.part`;
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(part);
    r.pipe(out);
    out.on('finish', () => resolve());
    out.on('error', reject);
    r.on('aborted', () => reject(new Error('Download interrupted.')));
  });
  await fsp.rename(part, target);
  return target;
}

export async function openFile(access: HubAccess, id: string, name: string): Promise<void> {
  const p = await fetchToCache(access, id, name);
  const err = await shell.openPath(p);
  if (err) { shell.showItemInFolder(p); }
}

export async function saveFile(access: HubAccess, id: string, name: string): Promise<string> {
  const cached = await fetchToCache(access, id, name);
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
    const m = new URL(request.url).pathname.match(/^\/([0-9A-Z]{26})$/);
    const access = getAccess();
    if (!m || !access) return new Response('not found', { status: 404 });
    try {
      const p = await fetchToCache(access, m[1], 'image');
      const ext = (await sniffImage(p)) ?? 'application/octet-stream';
      return new Response(Readable.toWeb(fs.createReadStream(p)) as ReadableStream, {
        headers: { 'content-type': ext, 'cache-control': 'private, max-age=31536000, immutable' },
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
