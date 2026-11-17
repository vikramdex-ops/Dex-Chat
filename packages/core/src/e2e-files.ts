// End-to-end encryption for files in Direct messages. Portable like e2e.ts (WebCrypto only), so
// the desktop main process, the phone's WebView and the tests share one implementation.
//
// Each file gets its own random AES-256-GCM key and a random 7-byte nonce prefix. The file is
// cut into chunks that are encrypted one by one, so a large file streams through a fixed amount
// of memory in both directions. A chunk's nonce is the prefix, the chunk's number and a flag for
// the last chunk, so chunks cannot be reordered, dropped, repeated or cut off at the end without
// the decryption failing. The key and prefix travel inside the sealed message body (see
// SealedFileMeta), so only the people in the conversation can read the file; the hub stores
// ciphertext it has no key for.
import { b64, unb64 } from './e2e.ts';

/** Plaintext bytes per chunk. */
export const FILE_CHUNK = 128 * 1024;
const TAG = 16;
const MAGIC = [0x44, 0x58, 0x46, 0x31]; // "DXF1"
const HEADER = 8;
const MIN_CHUNK = 1024;
const MAX_CHUNK = 4 * 1024 * 1024;
const PREFIX = 7;

/** The secret for one file: base64 AES-256 key and base64 nonce prefix. */
export interface FileSecret { k: string; n: string }

/** What a sealed message carries for each encrypted attachment (never seen by the hub). */
export interface SealedFileMeta {
  /** The hub's file id (of the ciphertext). */
  id: string;
  k: string;
  n: string;
  /** The real name, type and size; the hub only knows them as "sealed". */
  name: string;
  mime: string;
  size: number;
}

export const DAMAGED_FILE = 'This file was changed after it was sent, or is damaged, and cannot be opened.';

export function newFileSecret(): FileSecret {
  const r = globalThis.crypto.getRandomValues(new Uint8Array(32 + PREFIX));
  return { k: b64(r.subarray(0, 32)), n: b64(r.subarray(32)) };
}

export function isSealedFileMeta(v: unknown): v is SealedFileMeta {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  if (typeof m.id !== 'string' || !/^[0-9A-Z]{26}$/.test(m.id)) return false;
  if (typeof m.name !== 'string' || !m.name || m.name.length > 200) return false;
  if (typeof m.mime !== 'string' || m.mime.length > 100 || !/^[\w.+-]+\/[\w.+-]+$/.test(m.mime)) return false;
  if (typeof m.size !== 'number' || !Number.isSafeInteger(m.size) || m.size < 0) return false;
  try { return typeof m.k === 'string' && typeof m.n === 'string' && unb64(m.k).length === 32 && unb64(m.n).length === PREFIX; } catch { return false; }
}

/** Bytes the hub stores for a file of `plain` bytes. */
export function sealedFileSize(plain: number, chunk = FILE_CHUNK): number {
  return HEADER + plain + TAG * Math.max(1, Math.ceil(plain / chunk));
}

function header(chunk: number): Uint8Array {
  const h = new Uint8Array(HEADER);
  h.set(MAGIC, 0);
  new DataView(h.buffer).setUint32(4, chunk);
  return h;
}

function nonce(prefix: Uint8Array, index: number, last: boolean): Uint8Array {
  const iv = new Uint8Array(12);
  iv.set(prefix, 0);
  new DataView(iv.buffer).setUint32(PREFIX, index);
  iv[11] = last ? 1 : 0;
  return iv;
}

async function importKey(secret: FileSecret, use: 'encrypt' | 'decrypt'): Promise<{ key: CryptoKey; prefix: Uint8Array }> {
  let raw: Uint8Array;
  let prefix: Uint8Array;
  try { raw = unb64(secret.k); prefix = unb64(secret.n); } catch { throw new Error(DAMAGED_FILE); }
  if (raw.length !== 32 || prefix.length !== PREFIX) throw new Error(DAMAGED_FILE);
  const key = await globalThis.crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, [use]);
  return { key, prefix };
}

/** Collects incoming pieces and hands out exact-sized blocks without copying everything each time. */
class Buffered {
  private parts: Uint8Array[] = [];
  length = 0;
  push(p: Uint8Array): void { if (p.length) { this.parts.push(p); this.length += p.length; } }
  take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let o = 0;
    while (o < n) {
      const p = this.parts[0];
      const k = Math.min(p.length, n - o);
      out.set(p.subarray(0, k), o);
      o += k;
      if (k === p.length) this.parts.shift(); else this.parts[0] = p.subarray(k);
    }
    this.length -= n;
    return out;
  }
}

type Source = AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

/**
 * Encrypt a stream. Yields the header, then one encrypted chunk at a time; at most one chunk of
 * plaintext is held, whatever the size of the file.
 */
export async function* encryptFile(source: Source, secret: FileSecret, chunk = FILE_CHUNK): AsyncGenerator<Uint8Array> {
  if (!Number.isInteger(chunk) || chunk < MIN_CHUNK || chunk > MAX_CHUNK) throw new Error('Invalid chunk size.');
  const { key, prefix } = await importKey(secret, 'encrypt');
  const head = header(chunk);
  const seal = async (data: Uint8Array, index: number, last: boolean) => new Uint8Array(await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce(prefix, index, last) as BufferSource, additionalData: head as BufferSource }, key, data as BufferSource));
  yield head;
  const buf = new Buffered();
  let index = 0;
  for await (const piece of source) {
    buf.push(piece instanceof Uint8Array ? piece : new Uint8Array(piece as ArrayBufferLike));
    // a full chunk is known not to be the last once more data follows it
    while (buf.length > chunk) yield await seal(buf.take(chunk), index++, false);
  }
  yield await seal(buf.take(buf.length), index, true);
}

/** Decrypt a stream made by encryptFile. Throws DAMAGED_FILE on any change, reordering or truncation. */
export async function* decryptFile(source: Source, secret: FileSecret): AsyncGenerator<Uint8Array> {
  const { key, prefix } = await importKey(secret, 'decrypt');
  const buf = new Buffered();
  let head: Uint8Array | null = null;
  let size = 0;
  let index = 0;
  const open = async (data: Uint8Array, last: boolean) => {
    try {
      return new Uint8Array(await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce(prefix, index++, last) as BufferSource, additionalData: head as BufferSource }, key, data as BufferSource));
    } catch { throw new Error(DAMAGED_FILE); }
  };
  for await (const piece of source) {
    buf.push(piece instanceof Uint8Array ? piece : new Uint8Array(piece as ArrayBufferLike));
    if (!head && buf.length >= HEADER) {
      head = buf.take(HEADER);
      const chunk = new DataView(head.buffer, head.byteOffset).getUint32(4);
      if (!MAGIC.every((b, i) => head![i] === b) || chunk < MIN_CHUNK || chunk > MAX_CHUNK) throw new Error(DAMAGED_FILE);
      size = chunk + TAG;
    }
    if (head) while (buf.length > size) yield await open(buf.take(size), false);
  }
  if (!head || buf.length < TAG) throw new Error(DAMAGED_FILE);
  yield await open(buf.take(buf.length), true);
}

async function collect(it: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const p of it) { parts.push(p); n += p.length; }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Whole-buffer helpers (phones, which already hold the file in memory). */
export const encryptBytes = (data: Uint8Array, secret: FileSecret, chunk = FILE_CHUNK) => collect(encryptFile([data], secret, chunk));
export const decryptBytes = (data: Uint8Array, secret: FileSecret) => collect(decryptFile([data], secret));
