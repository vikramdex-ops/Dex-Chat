// Files shared in conversations. Uploads stream straight to disk while being hashed; identical
// files are stored once (content-addressed by SHA-256). Who may download a file is decided by
// the conversations it was posted in.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { ulid } from '@dex/core';
import type { FileInfo } from '@dex/core';

export const MAX_FILE_BYTES = 1024 * 1024 * 1024; // 1 GB, as in Cliq

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  uploader_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_sha ON files(sha256);
CREATE TABLE IF NOT EXISTS message_files (
  message_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  conv_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (message_id, file_id)
);
CREATE INDEX IF NOT EXISTS idx_message_files_file ON message_files(file_id);
CREATE INDEX IF NOT EXISTS idx_message_files_conv ON message_files(conv_id, message_id);
`;

interface FileRow { id: string; name: string; mime: string; size: number; sha256: string; uploader_id: string; created_at: number; sealed?: number }

/** What the hub calls a file encrypted on the sender's device (it never learns the real name). */
export const SEALED_NAME = 'Encrypted file';

/** Types a browser may render inline. Everything else is always a download. */
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);

export const toFileInfo = (r: FileRow): FileInfo => ({ id: r.id, name: r.name, mime: r.mime, size: r.size, uploaderId: r.uploader_id, createdAt: r.created_at, ...(r.sealed ? { sealed: true } : {}) });

function cleanName(name: string): string {
  const base = name.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f<>:"|?*]/g, '').trim().slice(0, 180);
  return base || 'file';
}

function cleanMime(mime: string | undefined, name: string): string {
  if (mime && /^[\w.+-]+\/[\w.+-]+$/.test(mime) && mime.length < 100) return mime.toLowerCase();
  const ext = path.extname(name).toLowerCase();
  const map: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.zip': 'application/zip',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.dwg': 'image/vnd.dwg', '.dxf': 'image/vnd.dxf', '.mp4': 'video/mp4', '.webm': 'audio/webm', '.m4a': 'audio/mp4',
  };
  return map[ext] ?? 'application/octet-stream';
}

export class FileStore {
  readonly db: DatabaseSync;
  readonly dir: string;
  /** The largest upload; the office policy can change it while the hub runs. */
  maxBytes: number;

  constructor(db: DatabaseSync, dir: string, max = MAX_FILE_BYTES) {
    this.db = db;
    this.dir = dir;
    this.maxBytes = max;
    db.exec(SCHEMA);
    // text read from images (by the sender's PC), for search
    try { db.exec('ALTER TABLE files ADD COLUMN ocr_text TEXT'); } catch { /* already there */ }
    // encrypted on the sender's device (end-to-end encrypted Direct messages): ciphertext only
    try { db.exec('ALTER TABLE files ADD COLUMN sealed INTEGER NOT NULL DEFAULT 0'); } catch { /* already there */ }
    fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true });
    // half-finished uploads from a previous run
    for (const f of fs.readdirSync(path.join(dir, 'tmp'))) fs.rmSync(path.join(dir, 'tmp', f), { force: true });
  }

  private blobPath(sha: string): string {
    return path.join(this.dir, sha.slice(0, 2), sha);
  }

  info(id: string): FileInfo | null {
    const r = this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRow | undefined;
    return r ? toFileInfo(r) : null;
  }

  /** Was this file encrypted on the sender's device (the hub has no key)? */
  isSealed(id: string): boolean {
    return !!(this.db.prepare('SELECT sealed FROM files WHERE id = ?').get(id) as { sealed: number } | undefined)?.sealed;
  }

  /** A stored file's content (up to `max` bytes; null when missing, larger, or encrypted end to end). */
  read(id: string, max: number): Buffer | null {
    const r = this.db.prepare('SELECT sha256, size, sealed FROM files WHERE id = ?').get(id) as { sha256: string; size: number; sealed: number } | undefined;
    if (!r || r.size > max || r.sealed) return null;
    try { return fs.readFileSync(this.blobPath(r.sha256)); } catch { return null; }
  }

  /** May this person read the file? Uploaders always can; others through a conversation they are in. */
  /**
   * Text found in an image, sent by the PC that uploaded it. Not for images in Direct
   * conversations: those are private and their text must not sit on the hub.
   */
  setText(userId: string, fileId: string, text: string): void {
    const f = this.db.prepare('SELECT uploader_id, mime, sealed FROM files WHERE id = ?').get(fileId) as { uploader_id: string; mime: string; sealed: number } | undefined;
    if (!f || f.uploader_id !== userId) throw Object.assign(new Error('File not found.'), { status: 404 });
    if (f.sealed) throw Object.assign(new Error('Images in Direct conversations stay private.'), { status: 400 });
    if (!f.mime.startsWith('image/')) throw Object.assign(new Error('Only images have text to read.'), { status: 400 });
    const direct = this.db.prepare(`SELECT 1 FROM message_files mf JOIN conversations c ON c.id = mf.conv_id WHERE mf.file_id = ? AND c.kind = 'direct' LIMIT 1`).get(fileId);
    if (direct) throw Object.assign(new Error('Images in Direct conversations stay private.'), { status: 400 });
    const clean = text.replace(/[\u0000-\u0008\u000b-\u001f]+/g, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, 20_000);
    this.db.prepare('UPDATE files SET ocr_text = ? WHERE id = ?').run(clean || null, fileId);
  }

  /** More reasons a file is in use, as SQL conditions on `f` (meeting recordings). */
  readonly keep: string[] = [];

  /** Store a file that was written to disk elsewhere (a recording uploaded in chunks); the file is moved. */
  adopt(src: string, uploaderId: string, rawName: string, rawMime: string): FileInfo {
    const name = cleanName(rawName);
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(src, 'r');
    const buf = Buffer.alloc(1024 * 1024);
    let size = 0;
    try {
      for (let n = fs.readSync(fd, buf); n > 0; n = fs.readSync(fd, buf)) { hash.update(buf.subarray(0, n)); size += n; }
    } finally { fs.closeSync(fd); }
    const sha = hash.digest('hex');
    const blob = this.blobPath(sha);
    if (fs.existsSync(blob)) fs.rmSync(src, { force: true });
    else { fs.mkdirSync(path.dirname(blob), { recursive: true }); fs.renameSync(src, blob); }
    const id = ulid();
    this.db.prepare('INSERT INTO files (id, name, mime, size, sha256, uploader_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, name, cleanMime(rawMime, name), size, sha, uploaderId, Date.now());
    return this.info(id)!;
  }

  /** Forget a file now (its blob goes when nothing else uses it). */
  drop(fileId: string): void {
    const r = this.db.prepare('SELECT sha256 FROM files WHERE id = ?').get(fileId) as { sha256: string } | undefined;
    if (!r) return;
    this.db.prepare('DELETE FROM message_files WHERE file_id = ?').run(fileId);
    this.db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
    if (!this.db.prepare('SELECT 1 FROM files WHERE sha256 = ? LIMIT 1').get(r.sha256)) fs.rmSync(this.blobPath(r.sha256), { force: true });
  }

  /** Files everyone may read (custom emoji images). */
  isPublic: (fileId: string) => boolean = () => false;

  canRead(userId: string, fileId: string): boolean {
    if (this.isPublic(fileId)) return true;
    const own = this.db.prepare('SELECT 1 FROM files WHERE id = ? AND uploader_id = ?').get(fileId, userId);
    if (own) return true;
    return !!this.db.prepare(`SELECT 1 FROM message_files mf JOIN messages m ON m.id = mf.message_id
      JOIN conv_members cm ON cm.conv_id = mf.conv_id
      WHERE mf.file_id = ? AND cm.user_id = ? AND m.deleted = 0 LIMIT 1`).get(fileId, userId) || this.extraRead(userId, fileId);
  }

  /** Other ways a file is shared (an answer to a form: its author can open it). */
  extraRead: (userId: string, fileId: string) => boolean = () => false;

  /**
   * Stream an upload to disk. Resolves with the stored file, or rejects with an HTTP-ready error.
   * A `sealed` upload was encrypted on the sender's device: the hub stores the ciphertext under a
   * neutral name and type, never shows it inline and never reads it.
   */
  async receive(req: IncomingMessage, uploaderId: string, rawName: string, rawMime: string | undefined, sealed = false): Promise<FileInfo> {
    const declared = Number(req.headers['content-length'] ?? NaN);
    if (!Number.isFinite(declared)) throw Object.assign(new Error('Content-Length is required.'), { status: 411 });
    // an encrypted file carries 16 bytes per 128 KB chunk and an 8-byte header on top of its size
    const limit = sealed ? this.maxBytes + 8 + 16 * Math.ceil(this.maxBytes / (128 * 1024)) : this.maxBytes;
    if (declared > limit) throw Object.assign(new Error(`Files can be up to ${Math.round(this.maxBytes / 1024 / 1024)} MB.`), { status: 413 });
    const name = sealed ? SEALED_NAME : cleanName(rawName);
    const mime = sealed ? 'application/octet-stream' : cleanMime(rawMime, name);
    const tmp = path.join(this.dir, 'tmp', ulid());
    const hash = crypto.createHash('sha256');
    let received = 0;
    const out = fs.createWriteStream(tmp);
    try {
      await new Promise<void>((resolve, reject) => {
        req.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > declared) { req.destroy(); reject(Object.assign(new Error('More data than announced.'), { status: 400 })); return; }
          hash.update(chunk);
          if (!out.write(chunk)) { req.pause(); out.once('drain', () => req.resume()); }
        });
        req.on('end', () => out.end(resolve));
        req.on('aborted', () => reject(Object.assign(new Error('Upload interrupted.'), { status: 400 })));
        req.on('error', reject);
        out.on('error', (e: NodeJS.ErrnoException) => reject(e.code === 'ENOSPC' ? Object.assign(new Error('The hub is out of disk space.'), { status: 507 }) : e));
      });
      if (received !== declared) throw Object.assign(new Error('Upload incomplete.'), { status: 400 });
      const sha = hash.digest('hex');
      const blob = this.blobPath(sha);
      if (fs.existsSync(blob)) {
        await fsp.rm(tmp, { force: true }); // already stored: keep one copy
      } else {
        await fsp.mkdir(path.dirname(blob), { recursive: true });
        await fsp.rename(tmp, blob);
      }
      const id = ulid();
      this.db.prepare('INSERT INTO files (id, name, mime, size, sha256, uploader_id, created_at, sealed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, name, mime, received, sha, uploaderId, Date.now(), sealed ? 1 : 0);
      return this.info(id)!;
    } catch (err) {
      out.destroy();
      await fsp.rm(tmp, { force: true });
      throw err;
    }
  }

  /** Store generated content (an export) as a file the given person can download. */
  storeBuffer(uploaderId: string, rawName: string, rawMime: string, data: Buffer): FileInfo {
    if (data.length > this.maxBytes) throw Object.assign(new Error('That export is too large. Choose a shorter period.'), { status: 413 });
    const sha = crypto.createHash('sha256').update(data).digest('hex');
    const blob = this.blobPath(sha);
    if (!fs.existsSync(blob)) {
      fs.mkdirSync(path.dirname(blob), { recursive: true });
      fs.writeFileSync(blob, data);
    }
    const id = ulid();
    const name = cleanName(rawName);
    this.db.prepare('INSERT INTO files (id, name, mime, size, sha256, uploader_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, name, cleanMime(rawMime, name), data.length, sha, uploaderId, Date.now());
    return this.info(id)!;
  }

  /**
   * Remove files no message uses any more (deleted or purged messages, abandoned uploads,
   * old exports), keeping anything waiting in a scheduled message. Blobs go when no file uses them.
   */
  gc(olderThan: number): number {
    const rows = this.db.prepare(`SELECT f.id, f.sha256 FROM files f WHERE f.created_at < ?
      AND NOT EXISTS (SELECT 1 FROM message_files mf JOIN messages m ON m.id = mf.message_id WHERE mf.file_id = f.id AND m.deleted = 0)
      AND NOT EXISTS (SELECT 1 FROM scheduled s WHERE s.files LIKE '%' || f.id || '%')
      AND NOT EXISTS (SELECT 1 FROM custom_emoji e WHERE e.file_id = f.id)${this.keep.map((k) => ` AND ${k}`).join('')} LIMIT 1000`).all(olderThan) as Array<{ id: string; sha256: string }>;
    for (const r of rows) {
      this.db.prepare('DELETE FROM message_files WHERE file_id = ?').run(r.id);
      this.db.prepare('DELETE FROM files WHERE id = ?').run(r.id);
      if (!this.db.prepare('SELECT 1 FROM files WHERE sha256 = ? LIMIT 1').get(r.sha256)) fs.rmSync(this.blobPath(r.sha256), { force: true });
    }
    return rows.length;
  }

  /** Serve a file with range support. Images can be shown inline; everything else downloads. */
  serve(req: IncomingMessage, res: ServerResponse, fileId: string, asDownload: boolean): void {
    const r = this.db.prepare('SELECT * FROM files WHERE id = ?').get(fileId) as FileRow | undefined;
    const blob = r ? this.blobPath(r.sha256) : '';
    if (!r || !fs.existsSync(blob)) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not found"}'); return; }
    const inline = !asDownload && !r.sealed && INLINE.has(r.mime);
    const headers: Record<string, string | number> = {
      'content-type': inline ? r.mime : 'application/octet-stream',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(r.name)}`,
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    };
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), r.size - 1) : r.size - 1;
      if (start >= r.size || start > end) { res.writeHead(416, { 'content-range': `bytes */${r.size}` }); res.end(); return; }
      res.writeHead(206, { ...headers, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${r.size}` });
      if (req.method === 'HEAD') res.end(); else fs.createReadStream(blob, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, 'content-length': r.size });
    if (req.method === 'HEAD') res.end(); else fs.createReadStream(blob).pipe(res);
  }

  /** Attach uploaded files to a message (validated by the caller). */
  link(messageId: string, convId: string, fileIds: string[]): void {
    const ins = this.db.prepare('INSERT OR IGNORE INTO message_files (message_id, file_id, conv_id, position) VALUES (?, ?, ?, ?)');
    fileIds.forEach((f, i) => ins.run(messageId, f, convId, i));
  }

  forMessage(messageId: string): FileInfo[] {
    return (this.db.prepare(`SELECT f.* FROM message_files mf JOIN files f ON f.id = mf.file_id WHERE mf.message_id = ? ORDER BY mf.position`)
      .all(messageId) as unknown as FileRow[]).map(toFileInfo);
  }

  inConversation(convId: string, before: string, limit: number): Array<FileInfo & { messageId: string; authorId: string }> {
    const rows = this.db.prepare(`SELECT f.*, mf.message_id, m.author_id FROM message_files mf
      JOIN files f ON f.id = mf.file_id JOIN messages m ON m.id = mf.message_id
      WHERE mf.conv_id = ? AND m.deleted = 0 AND mf.message_id < ? ORDER BY mf.message_id DESC, mf.position LIMIT ?`)
      .all(convId, before, limit) as unknown as Array<FileRow & { message_id: string; author_id: string }>;
    return rows.map((r) => ({ ...toFileInfo(r), messageId: r.message_id, authorId: r.author_id }));
  }
}
