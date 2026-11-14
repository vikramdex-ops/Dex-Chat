// Reading a .zip uploaded as a tool bundle: the central directory, stored and deflated entries,
// with limits on entry count and size so a hostile archive cannot exhaust the hub.
import zlib from 'node:zlib';

export class ZipError extends Error {}

export interface ZipLimits { maxEntries: number; maxTotal: number; maxEntry: number }

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;

/** Files in the archive by path (folders left out). Throws ZipError when it is not a plain zip within the limits. */
export function readZip(buf: Buffer, limits: ZipLimits): Map<string, Buffer> {
  // the end-of-central-directory record is in the last 64 KB + 22 bytes
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('This is not a zip file.');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError('Large (zip64) archives are not supported.');
  if (count > limits.maxEntries) throw new ZipError(`A bundle can hold up to ${limits.maxEntries} files.`);
  if (cdOffset + cdSize > buf.length) throw new ZipError('The zip file is damaged.');
  const out = new Map<string, Buffer>();
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN) throw new ZipError('The zip file is damaged.');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8').replace(/\\/g, '/');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new ZipError('Encrypted zip files are not supported.');
    if (name.startsWith('/') || name.split('/').some((s) => s === '..' || s === '') || /^[A-Za-z]:/.test(name)) throw new ZipError(`"${name}" is not a safe path.`);
    if (name.startsWith('__MACOSX/')) continue;
    if (usize > limits.maxEntry) throw new ZipError(`"${name}" is larger than ${Math.round(limits.maxEntry / 1024)} KB.`);
    total += usize;
    if (total > limits.maxTotal) throw new ZipError(`The bundle unpacks to more than ${Math.round(limits.maxTotal / 1024)} KB.`);
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOC) throw new ZipError('The zip file is damaged.');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + csize > buf.length) throw new ZipError('The zip file is damaged.');
    const raw = buf.subarray(start, start + csize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try { data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, usize) }); } catch { throw new ZipError(`"${name}" could not be unpacked.`); }
    } else throw new ZipError(`"${name}" uses a compression this hub cannot read.`);
    if (data.length !== usize) throw new ZipError(`"${name}" is damaged.`);
    out.set(name, data);
  }
  return out;
}

/** Build a zip of deflated entries (tests, and for anyone scripting a bundle). */
export function writeZip(files: Array<[string, Buffer]>): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(LOC, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0, 6); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(crc(data), 14); h.writeUInt32LE(deflated.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nameBuf.length, 26);
    locals.push(h, nameBuf, deflated);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(CEN, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc(data), 16); c.writeUInt32LE(deflated.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + deflated.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
