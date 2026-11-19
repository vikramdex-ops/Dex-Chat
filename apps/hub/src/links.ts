// Link cards. Internal links (dexconnect://, the office tools' own links, paths on the office
// share) are answered from the hub's data as the viewer may see it: a viewer without access gets
// a 'restricted' card that says nothing about what is behind it. Web pages are fetched by the hub
// behind a strict guard (http/https only, no private addresses, few redirects, short timeout,
// small cap) and read with a small HTML scanner; their cards are cached for a day.
//
// links.discuss finds or starts the side-track about a link in a conversation, using the same
// side-tracks as the rest of messaging (replies under a root message).
import crypto from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { isSealed } from '@dex/core/e2e';
import { formatMeetingId } from '@dex/core';
import { bookName, parseWorkbookLink } from '@dex/core/sheets';
import { cleanMappings, networkRoots } from '@dex/core/sharepaths';
import type { CalEvent, FileInfo, LinkAction, LinkCard, LinkCardMeta, LinkSettings, LinkThread, MeetingInfo, Message, PublicUser } from '@dex/core';
import type { FileStore } from './files.ts';
import type { Messaging } from './messaging.ts';
import type { Store } from './store.ts';

export class LinkError extends Error {}

export const USER_AGENT = 'DexterityConnect-LinkPreview';
const DAY = 24 * 3600_000;
const FAILED_TTL = 15 * 60_000;
const RATE_WINDOW = 60_000;
export const RATE_LIMIT = 30;
const PREFETCH_PER_MINUTE = 60;
const MAX_URL = 2048;

// ------------------------------------------------------------------ addresses

function v4(ip: string): number | null {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const x of p) {
    if (!/^\d{1,3}$/.test(x) || Number(x) > 255) return null;
    n = n * 256 + Number(x);
  }
  return n;
}

const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const V4_RANGES = V4_BLOCKED.map(([base, bits]) => [v4(base) ?? 0, bits] as const);

function v4Blocked(n: number): boolean {
  for (const [base, bits] of V4_RANGES) {
    const size = 2 ** (32 - bits);
    if (n >= base && n < base + size) return true;
  }
  return false;
}

/** An IPv6 address as eight 16-bit groups (embedded IPv4 allowed), or null. */
function v6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!/^[0-9a-f:.]+$/.test(s)) return null;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(':');
  if (s.includes('.')) {
    const n = v4(s.slice(lastColon + 1));
    if (n === null) return null;
    tail = [Math.floor(n / 65536), n % 65536];
    s = s.slice(0, lastColon + 1);
    if (s.endsWith(':') && !s.endsWith('::')) s = s.slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (x: string) => (x ? x.split(':') : []);
  const head = part(halves[0]);
  const rest = halves.length === 2 ? part(halves[1]) : [];
  const groups = [...head, ...rest];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const total = groups.length + tail.length;
  if (halves.length === 1 && total !== 8) return null;
  if (total > 8 || (halves.length === 2 && total > 7)) return null;
  const fill = new Array(8 - total).fill(0) as number[];
  return [...head.map((g) => parseInt(g, 16)), ...(halves.length === 2 ? fill : []), ...rest.map((g) => parseInt(g, 16)), ...tail];
}

/** Loopback, private, link-local, carrier-grade NAT, multicast, documentation and reserved addresses. */
export function isBlockedAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '');
  if (net.isIPv4(bare)) { const n = v4(bare); return n === null || v4Blocked(n); }
  const g = v6(bare);
  if (!g) return true;
  const embedded = (hi: number, lo: number) => v4Blocked(hi * 65536 + lo);
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return embedded(g[6], g[7]); // ::ffff:a.b.c.d
  if (g.slice(0, 6).every((x) => x === 0)) return true; // ::a.b.c.d (deprecated compatible)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded(g[6], g[7]); // NAT64
  if (g[0] === 0x2002) return embedded(g[1], g[2]); // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true; // link-local, site-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return true; // discard
  if (g[0] === 0x2001 && g[1] < 0x0200) return true; // IETF protocol assignments (Teredo, ORCHID…)
  return false;
}

// ------------------------------------------------------------------ guarded fetch

export interface FetchOptions {
  /** Every address a host name has (the default asks the system resolver). */
  resolve?: (host: string) => Promise<string[]>;
  /** Host names on the office network that may resolve to private addresses. */
  allowLanHosts?: string[];
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Tests: where to connect for an address the guard approved (the address is still the one that was checked). */
  connectTo?: (address: string, port: number) => { host: string; port: number };
}

export interface FetchResult {
  url: string;
  status: number;
  contentType: string;
  contentLength: number | null;
  body: Buffer;
  truncated: boolean;
  disposition: string | null;
}

export class FetchBlocked extends Error {
  readonly reason: 'scheme' | 'address' | 'dns' | 'port' | 'redirects' | 'url';
  constructor(reason: FetchBlocked['reason'], message: string) { super(message); this.reason = reason; }
}

const defaultResolve = async (host: string): Promise<string[]> => (await dns.promises.lookup(host, { all: true, verbatim: true })).map((a) => a.address);
const PUBLIC_PORTS = new Set([80, 443, 8080, 8443]);

/** Check a URL and pick the one address the request will use (resolved once, so a second answer cannot differ). */
export async function vet(u: URL, opts: FetchOptions): Promise<{ address: string; port: number }> {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FetchBlocked('scheme', 'Only http and https pages are previewed.');
  if (u.username || u.password) throw new FetchBlocked('url', 'Links with a user name or password are not previewed.');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw new FetchBlocked('url', 'That link has no host.');
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  const allowed = (opts.allowLanHosts ?? []).some((h) => h.toLowerCase() === host);
  let addresses: string[];
  if (net.isIP(host)) addresses = [host];
  else {
    try { addresses = await (opts.resolve ?? defaultResolve)(host); } catch { throw new FetchBlocked('dns', 'That site could not be found.'); }
  }
  addresses = addresses.filter((a) => typeof a === 'string' && net.isIP(a));
  if (!addresses.length) throw new FetchBlocked('dns', 'That site could not be found.');
  if (!allowed) {
    // every address must be public: a host with one private answer is refused
    if (addresses.some(isBlockedAddress)) throw new FetchBlocked('address', 'Links to the office network or this PC are not previewed.');
    if (!PUBLIC_PORTS.has(port)) throw new FetchBlocked('port', 'Only pages on the usual web ports are previewed.');
  }
  return { address: addresses[0], port };
}

function readBody(res: IncomingMessage, max: number): Promise<{ body: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (truncated: boolean) => { if (done) return; done = true; resolve({ body: Buffer.concat(chunks, Math.min(size, max)), truncated }); };
    res.on('data', (c: Buffer) => {
      if (done) return;
      const room = max - size;
      chunks.push(room < c.length ? c.subarray(0, room) : c);
      size += Math.min(c.length, room);
      if (size >= max) { finish(true); res.destroy(); }
    });
    res.on('end', () => finish(false));
    res.on('close', () => finish(size >= max));
    res.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

/**
 * GET a web page behind the guard: http/https, public addresses (or listed office hosts), at
 * most 3 redirects each checked again, 4 s in all, at most 512 KB read. HTML, PDF and image
 * responses are read; anything else only by its headers.
 */
export async function guardedFetch(raw: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? 4000;
  const maxBytes = opts.maxBytes ?? 512 * 1024;
  const maxRedirects = opts.maxRedirects ?? 3;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let u: URL;
    try { u = new URL(raw); } catch { throw new FetchBlocked('url', 'That is not a web address.'); }
    for (let hop = 0; ; hop++) {
      const { address, port } = await vet(u, opts);
      if (ac.signal.aborted) throw new Error('The page took too long to answer.');
      const target = opts.connectTo ? opts.connectTo(address, port) : { host: address, port };
      const lib = u.protocol === 'https:' ? https : http;
      const res = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = lib.request({
          host: target.host, port: target.port, method: 'GET', path: `${u.pathname}${u.search}`, agent: false, signal: ac.signal,
          servername: net.isIP(u.hostname.replace(/^\[|\]$/g, '')) ? undefined : u.hostname,
          headers: { host: u.host, 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'accept-encoding': 'identity', 'accept-language': 'en-IN,en;q=0.8' },
        }, resolve);
        req.on('error', reject);
        req.end();
      });
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.destroy();
        if (hop >= maxRedirects) throw new FetchBlocked('redirects', 'That link redirects too many times.');
        try { u = new URL(String(res.headers.location), u); } catch { throw new FetchBlocked('url', 'That link redirects somewhere invalid.'); }
        continue;
      }
      const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
      const lenHeader = Number(res.headers['content-length']);
      const contentLength = Number.isFinite(lenHeader) && lenHeader >= 0 ? lenHeader : null;
      const disposition = res.headers['content-disposition'] ? String(res.headers['content-disposition']) : null;
      const mime = contentType.split(';')[0].trim();
      let body: Buffer = Buffer.alloc(0);
      let truncated = false;
      if (status < 400 && (mime === 'text/html' || mime === 'application/xhtml+xml')) ({ body, truncated } = await readBody(res, maxBytes));
      else if (status < 400 && /^image\/(?:png|jpeg|gif|webp)$/.test(mime)) ({ body, truncated } = await readBody(res, Math.min(maxBytes, 64 * 1024)));
      else res.destroy();
      return { url: u.toString(), status, contentType: mime, contentLength, body, truncated, disposition };
    }
  } catch (err) {
    if (ac.signal.aborted && !(err instanceof FetchBlocked)) throw new Error('The page took too long to answer.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ HTML scanner

export interface PageMeta {
  title?: string;
  description?: string;
  siteName?: string;
  image?: string;
  favicon?: string;
  type?: string;
  canonical?: string;
  twitterCard?: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', middot: '·', bull: '•', laquo: '«', raquo: '»', rupee: '₹' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});?/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const cleanText = (s: string, max: number) => decodeEntities(s).replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) || undefined;

function attrs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s"'=<>/`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let n = 0;
  for (let m = re.exec(src); m && n < 40; m = re.exec(src), n++) {
    const k = m[1].toLowerCase();
    if (!(k in out)) out[k] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

function absolute(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined;
  try {
    const u = new URL(decodeEntities(href.trim()), base);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.toString().length <= MAX_URL ? u.toString() : undefined;
  } catch { return undefined; }
}

/**
 * Read a page's title, description, site name, picture and icon from og:*, twitter:*, <title>,
 * <meta name="description"> and <link rel="icon">. A scanner, not a parser: it skips comments,
 * scripts and styles, tolerates broken markup and stops after the head.
 */
export function scanHtml(html: string, pageUrl: string): PageMeta {
  const src = html.length > 512 * 1024 ? html.slice(0, 512 * 1024) : html;
  const lower = src.toLowerCase();
  const props: Record<string, string> = {};
  let title: string | undefined;
  let base = pageUrl;
  let icon: string | undefined;
  let canonical: string | undefined;
  let headEnded = false;
  let i = 0;
  for (let guard = 0; guard < 20_000; guard++) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (lower.startsWith('<!--', lt)) { const end = src.indexOf('-->', lt + 4); i = end < 0 ? src.length : end + 3; continue; }
    const name = /^<\/?\s*([a-z][a-z0-9:-]*)/.exec(lower.slice(lt, lt + 40))?.[1];
    if (!name) { i = lt + 1; continue; }
    const closing = lower[lt + 1] === '/';
    // the end of the tag, respecting quoted attribute values
    let gt = lt + 1;
    let quote = '';
    for (; gt < src.length; gt++) {
      const c = src[gt];
      if (quote) { if (c === quote) quote = ''; } else if (c === '"' || c === "'") quote = c; else if (c === '>') break; else if (c === '<' && gt > lt + 1 && /[a-z!/]/i.test(src[gt + 1] ?? '')) break;
      if (gt - lt > 8192) break;
    }
    const tagEnd = gt < src.length && src[gt] === '>' ? gt + 1 : gt;
    const inner = src.slice(lt + 1 + (closing ? 1 : 0) + name.length, gt);
    i = Math.max(tagEnd, lt + 1);
    if (closing) {
      if (name === 'head') headEnded = true;
      if (headEnded && (title || props['og:title'])) break;
      continue;
    }
    if (name === 'script' || name === 'style' || name === 'noscript' || name === 'template' || name === 'textarea' || name === 'svg') {
      const end = lower.indexOf(`</${name}`, i);
      i = end < 0 ? src.length : end;
      continue;
    }
    if (name === 'body') { headEnded = true; if (title || props['og:title']) break; continue; }
    if (name === 'title' && title === undefined) {
      const end = lower.indexOf('</title', i);
      title = cleanText(src.slice(i, end < 0 ? Math.min(src.length, i + 1000) : end), 300) ?? '';
      i = end < 0 ? i : end;
      continue;
    }
    if (name === 'meta') {
      const a = attrs(inner);
      const key = (a.property ?? a.name ?? a.itemprop ?? '').toLowerCase().trim();
      if (key && a.content !== undefined && !(key in props)) props[key] = a.content;
      continue;
    }
    if (name === 'base') { const a = attrs(inner); const b = absolute(a.href, pageUrl); if (b) base = b; continue; }
    if (name === 'link') {
      const a = attrs(inner);
      const rel = (a.rel ?? '').toLowerCase().split(/\s+/);
      if (!icon && (rel.includes('icon') || rel.includes('apple-touch-icon'))) icon = absolute(a.href, base);
      if (!canonical && rel.includes('canonical')) canonical = absolute(a.href, base);
    }
  }
  const pick = (...keys: string[]) => { for (const k of keys) { const v = props[k]; if (v && v.trim()) return v; } return undefined; };
  const out: PageMeta = {};
  const t = cleanText(pick('og:title', 'twitter:title') ?? '', 300) ?? (title || undefined) ?? cleanText(pick('title') ?? '', 300);
  if (t) out.title = t;
  const d = cleanText(pick('og:description', 'twitter:description', 'description') ?? '', 500);
  if (d) out.description = d;
  const site = cleanText(pick('og:site_name', 'application-name') ?? '', 120);
  if (site) out.siteName = site;
  const img = absolute(pick('og:image:secure_url', 'og:image:url', 'og:image', 'twitter:image', 'twitter:image:src'), base);
  if (img) out.image = img;
  const type = cleanText(pick('og:type') ?? '', 60);
  if (type) out.type = type;
  const tw = cleanText(pick('twitter:card') ?? '', 60);
  if (tw) out.twitterCard = tw;
  const canon = absolute(pick('og:url'), base) ?? canonical;
  if (canon) out.canonical = canon;
  out.favicon = icon ?? absolute('/favicon.ico', base);
  return out;
}

/** Width and height of a PNG, GIF, JPEG or WebP from its first bytes, or null. */
export function imageSize(buf: Buffer): { width: number; height: number } | null {
  const ok = (w: number, h: number) => (w > 0 && h > 0 && w <= 100_000 && h <= 100_000 ? { width: w, height: h } : null);
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('latin1', 12, 16) === 'IHDR') return ok(buf.readUInt32BE(16), buf.readUInt32BE(20));
  if (buf.length >= 10 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return ok(buf.readUInt16LE(6), buf.readUInt16LE(8));
  if (buf.length >= 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = buf.toString('latin1', 12, 16);
    if (chunk === 'VP8 ' && buf.length >= 30) return ok(buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff);
    if (chunk === 'VP8L' && buf.length >= 25) { const b = buf.readUInt32LE(21); return ok((b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1); }
    if (chunk === 'VP8X' && buf.length >= 30) return ok(buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1);
    return null;
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    for (let n = 0; n < 200 && o + 9 < buf.length; n++) {
      if (buf[o] !== 0xff) { o++; continue; }
      const marker = buf[o + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
      if (marker === 0xff) { o++; continue; }
      const len = buf.readUInt16BE(o + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return ok(buf.readUInt16BE(o + 7), buf.readUInt16BE(o + 5));
      if (len < 2) return null;
      o += 2 + len;
    }
  }
  return null;
}

// ------------------------------------------------------------------ helpers

export const urlHash = (url: string) => crypto.createHash('sha256').update(normaliseUrl(url)).digest('hex').slice(0, 32);

/** The form links are compared and cached by: web addresses without their #fragment. */
export function normaliseUrl(raw: string): string {
  const s = raw.trim();
  if (/^https?:\/\//i.test(s)) {
    try { const u = new URL(s); u.hash = ''; return u.toString(); } catch { return s; }
  }
  return s;
}

const humanSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);
const when = (t: number, zone?: string | null) => {
  try { return new Date(t).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, ...(zone ? { timeZone: zone } : {}) }); } catch { return new Date(t).toISOString(); }
};
const plain = (s: string, names: Map<string, string>, max = 300) => {
  const t = s.replace(/<@all>/g, '@everyone').replace(/<@([0-9A-Z]{26})>/g, (_, id: string) => `@${names.get(id) ?? 'someone'}`)
    .replace(/```[\s\S]*?```/g, ' [code] ').replace(/[*_~`>#]+/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** File types people in a design office share, by extension. */
const FILE_TYPES: Record<string, string> = {
  dwg: 'AutoCAD drawing', dxf: 'Drawing exchange file', dgn: 'MicroStation drawing', pdf: 'PDF document', xlsx: 'Excel workbook', xls: 'Excel workbook',
  xlsm: 'Excel workbook (macros)', csv: 'CSV table', docx: 'Word document', doc: 'Word document', pptx: 'PowerPoint presentation', txt: 'Text file',
  pcf: 'Piping component file', idf: 'Isogen data file', nwd: 'Navisworks model', nwc: 'Navisworks cache', nwf: 'Navisworks file set', rvt: 'Revit model',
  ifc: 'IFC model', step: 'STEP model', stp: 'STEP model', iges: 'IGES model', igs: 'IGES model', sat: 'ACIS model', e3d: 'E3D model', rvm: 'Review model',
  zip: 'ZIP archive', '7z': '7-Zip archive', rar: 'RAR archive', png: 'PNG image', jpg: 'JPEG image', jpeg: 'JPEG image', tif: 'TIFF image', tiff: 'TIFF image',
  msg: 'Outlook message', eml: 'Email message', mpp: 'Project plan', xer: 'Primavera schedule', sql: 'SQL script', json: 'JSON file', xml: 'XML file',
};

const meta = (key: LinkCardMeta['key'], label: string, value: string, ref?: string | number): LinkCardMeta => (ref === undefined ? { key, label, value } : { key, label, value, ref });
const action = (kind: LinkAction['kind'], label: string, target: string, tool?: string): LinkAction => (tool ? { kind, label, target, tool } : { kind, label, target });

function restricted(url: string): LinkCard {
  return { url, kind: 'restricted', title: null, subtitle: null, meta: [], preview: null, actions: [], fetchedAt: Date.now() };
}

const ID = /^[0-9A-Za-z_-]{1,64}$/;

// ------------------------------------------------------------------ the engine

export interface LinkDeps {
  store: Store;
  messaging: Messaging;
  files: FileStore;
  /** The calendar's own "may this person see the meeting" check (throws when not). */
  event: (viewer: PublicUser, eventId: string) => CalEvent | null;
  /** People this viewer may see (guests see only people they share a Space with). */
  visibleUsers: (viewer: PublicUser) => PublicUser[];
  /** A meeting by its nine-digit ID, as meet.get shows it, and whether the viewer is inside it. */
  meeting?: (viewer: PublicUser, id: string) => { info: MeetingInfo; insider: boolean } | null;
}

interface CacheRow { card: string; fetched_at: number; ok: number }

export class Links {
  private readonly db: DatabaseSync;
  private readonly deps: LinkDeps;
  /** Tests point the fetcher at a local server and a fake resolver. */
  fetchOptions: FetchOptions = {};
  private readonly recent = new Map<string, number[]>();
  private readonly inflight = new Map<string, Promise<LinkCard>>();
  private prefetches: number[] = [];

  constructor(deps: LinkDeps) {
    this.deps = deps;
    this.db = deps.store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS link_cache (url_hash TEXT PRIMARY KEY, url TEXT NOT NULL, card TEXT NOT NULL, ok INTEGER NOT NULL, fetched_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_link_cache_at ON link_cache(fetched_at);
      CREATE TABLE IF NOT EXISTS link_threads (conv_id TEXT NOT NULL, url_hash TEXT NOT NULL, url TEXT NOT NULL, root_message_id TEXT NOT NULL,
        created_by TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (conv_id, url_hash));
      CREATE TABLE IF NOT EXISTS link_hidden (message_id TEXT NOT NULL, url TEXT NOT NULL, PRIMARY KEY (message_id, url));
      CREATE TABLE IF NOT EXISTS device_drives (device_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, drives TEXT NOT NULL, updated_at INTEGER NOT NULL);`);
    // cards the author removed from their message are left out for everyone
    deps.messaging.viewExtras.push((r) => {
      if (r.deleted) return {};
      const hidden = (this.db.prepare('SELECT url FROM link_hidden WHERE message_id = ?').all(r.id) as Array<{ url: string }>).map((x) => x.url);
      return hidden.length ? { hiddenPreviews: hidden } : {};
    });
    deps.messaging.purgeExtras.push((id) => { this.db.prepare('DELETE FROM link_hidden WHERE message_id = ?').run(id); });
  }

  // ---------------------------------------------------------------- settings
  private metaValue(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? r.value : null;
  }
  private setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  settings(): LinkSettings {
    let hosts: string[] = [];
    try { const v = JSON.parse(this.metaValue('links_allow_lan_hosts') ?? '[]') as unknown; if (Array.isArray(v)) hosts = v.filter((x): x is string => typeof x === 'string'); } catch { /* keep none */ }
    return {
      externalPreviews: this.metaValue('links_external') !== '0',
      guestExternalPreviews: this.metaValue('links_external_guests') === '1',
      allowLanHosts: hosts,
    };
  }

  // ---------------------------------------------------------------- operations
  async handle(op: string, me: PublicUser, d: Record<string, unknown>): Promise<unknown> {
    const isAdmin = me.role === 'owner' || me.role === 'admin';
    switch (op) {
      case 'links.preview': {
        const url = typeof d.url === 'string' ? d.url.trim() : '';
        if (!url || url.length > MAX_URL) throw new LinkError('Give a link to preview.');
        return this.preview(url, me);
      }
      case 'links.discuss': return this.discuss(me, d);
      case 'links.drives.of': return this.drivesOf(me, d);
      case 'links.hide': {
        const msg = typeof d.messageId === 'string' ? this.deps.messaging.row(d.messageId) : undefined;
        if (!msg || msg.deleted || !this.deps.messaging.isMember(msg.conv_id, me.id)) throw new LinkError('Message not found.');
        if (msg.author_id !== me.id) throw new LinkError('Only the person who wrote the message can remove its link cards.');
        const url = typeof d.url === 'string' ? d.url.trim() : '';
        if (!url || url.length > MAX_URL) throw new LinkError('Give the link whose card to remove.');
        if (d.hidden === false) this.db.prepare('DELETE FROM link_hidden WHERE message_id = ? AND url = ?').run(msg.id, url);
        else {
          const n = (this.db.prepare('SELECT COUNT(*) AS n FROM link_hidden WHERE message_id = ?').get(msg.id) as { n: number }).n;
          if (n >= 20) throw new LinkError('This message already has 20 link cards removed.');
          this.db.prepare('INSERT OR IGNORE INTO link_hidden (message_id, url) VALUES (?, ?)').run(msg.id, url);
        }
        this.deps.messaging.pushUpdate(msg.id);
        const view = this.deps.messaging.messageFor(msg.id, me.id);
        if (!view) throw new LinkError('Message not found.');
        return view;
      }
      case 'admin.links.get': {
        if (!isAdmin) throw new LinkError('Only administrators can do that.');
        return this.settings();
      }
      case 'admin.links.set': {
        if (!isAdmin) throw new LinkError('Only administrators can do that.');
        if (typeof d.externalPreviews === 'boolean') this.setMeta('links_external', d.externalPreviews ? '1' : '0');
        if (typeof d.guestExternalPreviews === 'boolean') this.setMeta('links_external_guests', d.guestExternalPreviews ? '1' : '0');
        if (d.allowLanHosts !== undefined) {
          if (!Array.isArray(d.allowLanHosts)) throw new LinkError('List the office host names, one per line.');
          const hosts = [...new Set(d.allowLanHosts.filter((x): x is string => typeof x === 'string').map((h) => h.trim().toLowerCase().replace(/^\[|\]$/g, '')).filter(Boolean))];
          const bad = hosts.find((h) => !(net.isIP(h) || /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(h)));
          if (bad) throw new LinkError(`“${bad.slice(0, 60)}” is not a host name.`);
          if (hosts.length > 50) throw new LinkError('List up to 50 office hosts.');
          this.setMeta('links_allow_lan_hosts', JSON.stringify(hosts));
          // cards fetched under the old list are fetched again
          this.db.prepare('DELETE FROM link_cache WHERE ok = 0').run();
        }
        this.deps.store.audit(me.id, 'links.settings', null, this.settings());
        return this.settings();
      }
    }
    return undefined;
  }

  // ---------------------------------------------------------------- drive maps
  /**
   * A device publishes its network drives (X: → \\nas01\Project), so the drive-letter paths its
   * person wrote before messages stored UNC paths can be read on PCs that map the share
   * differently. Only letters and UNC roots are kept: local and subst drives, user names, server
   * addresses or anything else never reach the hub. Guests and bots neither publish nor read them.
   */
  setDrives(me: PublicUser, deviceId: string, d: Record<string, unknown>): { ok: true; count: number } {
    if (me.role === 'guest' || me.role === 'bot') throw new LinkError('Only members of the office share their network drives.');
    if (!Array.isArray(d.drives) || d.drives.length > 26) throw new LinkError('Give up to 26 network drives.');
    const roots = networkRoots(cleanMappings(d.drives)).filter((x) => x.root.startsWith('\\\\') && x.root.length <= 400);
    this.db.prepare('INSERT INTO device_drives (device_id, user_id, drives, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET user_id = excluded.user_id, drives = excluded.drives, updated_at = excluded.updated_at')
      .run(deviceId, me.id, JSON.stringify(roots), Date.now());
    return { ok: true, count: roots.length };
  }

  /** The drive maps of message writers, for members: every approved device of each person together; a letter mapped two ways is left out. */
  drivesOf(me: PublicUser, d: Record<string, unknown>): Record<string, { known: boolean; drives: Array<{ letter: string; root: string }> }> {
    if (me.role === 'guest' || me.role === 'bot') throw new LinkError('Network drives are only shown to members of the office.');
    const ids = Array.isArray(d.userIds) ? [...new Set(d.userIds.filter((x): x is string => typeof x === 'string' && ID.test(x)))].slice(0, 100) : [];
    const approved = new Set(this.deps.store.devices().filter((x) => x.status === 'approved').map((x) => x.id));
    const active = new Set(this.deps.store.activeUsers().filter((u) => u.role !== 'guest').map((u) => u.id));
    const out: Record<string, { known: boolean; drives: Array<{ letter: string; root: string }> }> = {};
    const q = this.db.prepare('SELECT device_id, drives FROM device_drives WHERE user_id = ?');
    for (const id of ids) {
      if (!active.has(id)) { out[id] = { known: false, drives: [] }; continue; }
      const rows = (q.all(id) as Array<{ device_id: string; drives: string }>).filter((r) => approved.has(r.device_id));
      const seen = new Map<string, string | null>();
      for (const r of rows) {
        let list: Array<{ letter: string; root: string }> = [];
        try { list = networkRoots(cleanMappings(JSON.parse(r.drives))); } catch { /* skip */ }
        for (const m of list) {
          const had = seen.get(m.letter);
          if (had === undefined) seen.set(m.letter, m.root);
          else if (had !== null && had.toLowerCase() !== m.root.toLowerCase()) seen.set(m.letter, null);
        }
      }
      out[id] = { known: rows.length > 0, drives: [...seen].filter((e): e is [string, string] => e[1] !== null).map(([letter, root]) => ({ letter, root })) };
    }
    return out;
  }

  /** A card for any link, as this viewer may see it. */
  async preview(url: string, me: PublicUser): Promise<LinkCard> {
    const internal = this.internal(url, me);
    if (internal) return internal;
    if (/^https?:\/\//i.test(url)) return this.web(url, me);
    return { url, kind: 'unavailable', title: null, subtitle: null, meta: [], preview: null, actions: [], status: 'failed', reason: 'Dexterity Connect does not preview this kind of link.', fetchedAt: Date.now() };
  }

  // ---------------------------------------------------------------- internal links
  private internal(url: string, me: PublicUser): LinkCard | null {
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
    if (scheme === 'dexconnect') return this.dexconnect(url, me);
    if (scheme === 'sleuth' || scheme === 'dexterity' || scheme === 'projectopener' || scheme === 'datum') return this.tool(url, scheme);
    if (scheme === 'file' || /^\\\\[^\\]/.test(url) || /^[a-z]:\\/i.test(url)) return this.path(url);
    return null;
  }

  private dexconnect(url: string, me: PublicUser): LinkCard {
    const m = /^dexconnect:\/\/([a-z]+)((?:\/[^/?#]*)*)/i.exec(url);
    if (!m) return restricted(url);
    const target = m[1].toLowerCase();
    const parts = m[2].split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
    const names = new Map(this.deps.store.activeUsers().map((u) => [u.id, u.displayName] as const));
    try {
      if (target === 'message' && parts.length >= 2) return this.messageCard(url, me, parts[0], parts[1], names);
      if ((target === 'conversation' || target === 'conv' || target === 'space') && parts[0]) return this.convCard(url, me, parts[0], names);
      if ((target === 'people' || target === 'person' || target === 'user') && parts[0]) return this.personCard(url, me, parts[0]);
      if (target === 'file' && parts[0]) return this.fileCard(url, me, parts[0], names);
      if (target === 'calendar' && parts[0] === 'event' && parts[1]) return this.eventCard(url, me, parts[1], names);
      if ((target === 'event' || target === 'meeting') && parts[0]) return this.eventCard(url, me, parts[0], names);
      if (target === 'desk' && (parts[0] === 'task' || parts[0] === 'reminder') && parts[1]) return this.taskCard(url, me, parts[1], names);
      if ((target === 'task' || target === 'reminder') && parts[0]) return this.taskCard(url, me, parts[0], names);
      if (target === 'meet' && parts[0]) return this.meetingCard(url, me, parts[0], names);
    } catch { return restricted(url); }
    const screens: Record<string, string> = { desk: 'Your Desk', calendar: 'Calendar', settings: 'Preferences', admin: 'Control room' };
    if (screens[target] && !parts.length) {
      return { url, kind: 'tool', title: screens[target], subtitle: 'Dexterity Connect', meta: [], preview: null, actions: [action('open', 'Open', url)], fetchedAt: Date.now() };
    }
    return restricted(url);
  }

  private messageCard(url: string, me: PublicUser, convId: string, messageId: string, names: Map<string, string>): LinkCard {
    if (!ID.test(convId) || !ID.test(messageId)) return restricted(url);
    const msg = this.deps.messaging.messageFor(messageId, me.id);
    if (!msg || msg.convId !== convId) return restricted(url);
    const conv = this.convName(convId, me.id, names);
    if (msg.deleted) return { url, kind: 'unavailable', title: null, subtitle: conv, meta: [], preview: null, actions: [action('open', 'Open the conversation', `dexconnect://conversation/${convId}`)], status: 'failed', reason: 'This message was deleted.', ref: { convId, messageId }, fetchedAt: Date.now() };
    const author = names.get(msg.authorId) ?? this.deps.store.userById(msg.authorId)?.displayName ?? 'Someone';
    const rows: LinkCardMeta[] = [meta('author', 'From', author, msg.authorId), meta('updated', msg.editedAt ? 'Edited' : 'Sent', when(msg.editedAt ?? msg.createdAt), msg.editedAt ?? msg.createdAt)];
    if (msg.replyCount) rows.push(meta('replies', 'Side-track', `${msg.replyCount} ${msg.replyCount === 1 ? 'reply' : 'replies'}`, msg.replyCount));
    if (msg.pinned) rows.push(meta('status', 'Status', 'Pinned'));
    if (msg.files.length) rows.push(meta('type', 'Files', msg.files.length === 1 ? msg.files[0].name : `${msg.files.length} files`));
    const excerpt = isSealed(msg.body) ? 'Encrypted message: open it to read' : msg.poll ? `Poll: ${plain(msg.poll.question, names)}` : plain(msg.body, names);
    const image = msg.files.find((f) => f.mime.startsWith('image/'));
    return {
      url, kind: 'message', title: author, subtitle: conv, meta: rows,
      preview: { ...(excerpt ? { excerpt } : {}), ...(image ? { fileId: image.id } : {}) },
      actions: [action('open', 'Open', url), action('reply', 'Reply in a side-track', msg.parentId ? `dexconnect://message/${convId}/${msg.parentId}` : url)],
      ref: { convId, messageId: msg.parentId ?? msg.id }, fetchedAt: Date.now(),
    };
  }

  private convName(convId: string, viewer: string, names: Map<string, string>): string {
    const c = this.db.prepare('SELECT kind, name FROM conversations WHERE id = ?').get(convId) as { kind: string; name: string | null } | undefined;
    if (!c) return 'Conversation';
    if (c.kind === 'space') return c.name ?? 'Space';
    const others = this.deps.messaging.members(convId).filter((u) => u !== viewer).map((u) => names.get(u) ?? 'Someone');
    return others.length ? others.slice(0, 4).join(', ') + (others.length > 4 ? ` and ${others.length - 4} more` : '') : 'Direct conversation';
  }

  private convCard(url: string, me: PublicUser, convId: string, names: Map<string, string>): LinkCard {
    if (!ID.test(convId)) return restricted(url);
    const c = this.db.prepare('SELECT id, kind, name, topic, private, everyone, archived, post_policy FROM conversations WHERE id = ?').get(convId) as { id: string; kind: string; name: string | null; topic: string | null; private: number; everyone: number; archived: number; post_policy: string | null } | undefined;
    if (!c) return restricted(url);
    const member = this.deps.messaging.isMember(c.id, me.id);
    // open Spaces can be seen (and joined) by members of the office; nothing else by outsiders
    if (!member && (c.kind !== 'space' || c.private || me.role === 'guest' || me.role === 'bot')) return restricted(url);
    const members = this.deps.messaging.members(c.id).length;
    const last = this.db.prepare('SELECT MAX(created_at) AS t FROM messages WHERE conv_id = ? AND deleted = 0').get(c.id) as { t: number | null };
    const rows: LinkCardMeta[] = [meta('members', 'Members', `${members} ${members === 1 ? 'person' : 'people'}`, members)];
    if (last.t) rows.push(meta('updated', 'Last message', when(last.t), last.t));
    const status = [c.kind === 'direct' ? 'Direct' : c.private ? 'Private Space' : 'Open Space', c.archived ? 'archived' : '', c.post_policy === 'moderators' ? 'announcements' : ''].filter(Boolean).join(', ');
    rows.push(meta('status', 'Kind', status));
    const actions = [action('open', 'Open', `dexconnect://conversation/${c.id}`)];
    if (!member) actions.push(action('join', 'Join', `dexconnect://conversation/${c.id}`));
    return {
      url, kind: 'conversation', title: c.kind === 'space' ? c.name ?? 'Space' : this.convName(c.id, me.id, names), subtitle: c.topic ?? null,
      meta: rows, preview: null, actions, ref: { convId: c.id }, fetchedAt: Date.now(),
    };
  }

  private personCard(url: string, me: PublicUser, userId: string): LinkCard {
    const u = this.deps.visibleUsers(me).find((x) => x.id === userId);
    if (!u) return restricted(url);
    const rows: LinkCardMeta[] = [];
    const dept = u.profile.departmentId ? this.db.prepare('SELECT name FROM departments WHERE id = ?').get(u.profile.departmentId) as { name: string } | undefined : undefined;
    if (dept) rows.push(meta('department', 'Department', dept.name));
    if (u.profile.location) rows.push(meta('location', 'Seat', u.profile.location));
    if (u.profile.extension) rows.push(meta('type', 'Extension', u.profile.extension));
    const status = u.ooo && u.ooo.until > Date.now() ? 'Out of office' : u.availability === 'invisible' ? '' : ({ available: 'Available', busy: 'Busy', dnd: 'Do not disturb' } as Record<string, string>)[u.availability] ?? '';
    if (status) rows.push(meta('status', 'Status', status));
    return {
      url, kind: 'person', title: u.displayName, subtitle: u.title ?? (u.role === 'guest' ? 'Guest' : u.role === 'bot' ? 'Integration' : null), meta: rows,
      preview: u.statusText ? { excerpt: `${u.statusEmoji ? `${u.statusEmoji} ` : ''}${u.statusText}`.slice(0, 300) } : null,
      actions: [action('open', 'Open profile', `dexconnect://people/${u.id}`)], ref: { userId: u.id }, fetchedAt: Date.now(),
    };
  }

  private fileCard(url: string, me: PublicUser, fileId: string, names: Map<string, string>): LinkCard {
    if (!ID.test(fileId)) return restricted(url);
    const f: FileInfo | null = this.deps.files.info(fileId);
    if (!f || !this.deps.files.canRead(me.id, fileId)) return restricted(url);
    const ext = /\.([a-z0-9]{1,8})$/i.exec(f.name)?.[1]?.toLowerCase() ?? '';
    return {
      url, kind: 'file', title: f.name, subtitle: FILE_TYPES[ext] ?? f.mime,
      meta: [meta('size', 'Size', humanSize(f.size), f.size), meta('author', 'Shared by', names.get(f.uploaderId) ?? 'Someone', f.uploaderId), meta('updated', 'Added', when(f.createdAt), f.createdAt)],
      preview: f.mime.startsWith('image/') ? { fileId: f.id } : null,
      actions: [action('open', 'Open', `dexconnect://file/${f.id}`)], ref: { fileId: f.id }, fetchedAt: Date.now(),
    };
  }

  private eventCard(url: string, me: PublicUser, eventId: string, names: Map<string, string>): LinkCard {
    if (!ID.test(eventId)) return restricted(url);
    const ev = this.deps.event(me, eventId);
    if (!ev) return restricted(url);
    const mine = ev.attendees.find((a) => a.userId === me.id)?.response;
    const going = ev.attendees.filter((a) => a.response === 'yes').length + 1;
    const rows: LinkCardMeta[] = [
      meta('when', 'When', ev.allDay ? new Date(ev.startAt).toDateString() : `${when(ev.startAt, ev.timeZone)} – ${when(ev.endAt, ev.timeZone).split(', ').pop()}`, ev.startAt),
      meta('author', 'Organiser', names.get(ev.organizerId) ?? 'Someone', ev.organizerId),
      meta('members', 'Invited', `${ev.attendees.length + 1} (${going} going)`, ev.attendees.length + 1),
    ];
    if (ev.location) rows.push(meta('location', 'Where', ev.location));
    rows.push(meta('status', 'Status', ev.cancelled ? 'Cancelled' : ev.organizerId === me.id ? 'You organise it' : mine === 'yes' ? 'You are going' : mine === 'maybe' ? 'Maybe' : mine === 'no' ? 'Not going' : 'Not answered'));
    const actions = [action('open', 'Open', `dexconnect://calendar/event/${ev.id}`)];
    if (ev.online && ev.convId && !ev.cancelled) actions.push(action('join', 'Join the call', `dexconnect://conversation/${ev.convId}`));
    return {
      url, kind: 'event', title: ev.title, subtitle: ev.location ?? (ev.online ? 'Online in Dexterity Connect' : null), meta: rows,
      preview: ev.description ? { excerpt: plain(ev.description, names) } : null, actions, ref: { eventId: ev.id, ...(ev.convId ? { convId: ev.convId } : {}) }, fetchedAt: Date.now(),
    };
  }

  private taskCard(url: string, me: PublicUser, taskId: string, names: Map<string, string>): LinkCard {
    if (!ID.test(taskId)) return restricted(url);
    const r = this.db.prepare('SELECT id, user_id, created_by, text, due_at, done_at, conv_id, message_id FROM reminders WHERE id = ?').get(taskId) as
      { id: string; user_id: string; created_by: string; text: string; due_at: number; done_at: number | null; conv_id: string | null; message_id: string | null } | undefined;
    // a Desk task is its owner's (and whoever set it for them)
    if (!r || (r.user_id !== me.id && r.created_by !== me.id)) return restricted(url);
    const rows: LinkCardMeta[] = [
      meta('when', 'Due', when(r.due_at), r.due_at),
      meta('status', 'Status', r.done_at ? 'Done' : r.due_at < Date.now() ? 'Overdue' : 'Open'),
    ];
    if (r.created_by !== r.user_id) rows.push(meta('author', 'Set by', names.get(r.created_by) ?? 'Someone', r.created_by));
    return {
      url, kind: 'task', title: r.text.slice(0, 200), subtitle: r.user_id === me.id ? 'On your Desk' : `For ${names.get(r.user_id) ?? 'someone'}`, meta: rows,
      preview: null, actions: [action('open', 'Open', `dexconnect://desk/task/${r.id}`)],
      ref: { taskId: r.id, ...(r.conv_id ? { convId: r.conv_id } : {}), ...(r.message_id ? { messageId: r.message_id } : {}) }, fetchedAt: Date.now(),
    };
  }

  /** dexconnect://meet/482-913-207: what meet.get shows anyone with the ID; who is in it only for people inside the meeting. */
  private meetingCard(url: string, me: PublicUser, rawId: string, names: Map<string, string>): LinkCard {
    const id = rawId.replace(/[\s-]/g, '');
    if (!/^\d{9}$/.test(id) || !this.deps.meeting) return restricted(url);
    const found = this.deps.meeting(me, id);
    if (!found) return restricted(url);
    const m = found.info;
    const kinds: Record<string, string> = { instant: 'Instant meeting', personal: 'Personal room', conversation: 'A conversation’s Room', event: 'Calendar meeting' };
    const rows: LinkCardMeta[] = [meta('author', 'Host', names.get(m.hostId) ?? 'Someone', m.hostId), meta('type', 'Kind', kinds[m.kind] ?? 'Meeting')];
    if (m.live) rows.push(meta('status', 'Status', found.insider ? `In progress · ${m.live.participants} ${m.live.participants === 1 ? 'person' : 'people'}` : 'In progress', m.live.participants));
    else rows.push(meta('status', 'Status', 'Not started'));
    if (m.settings.lobby !== 'off') rows.push(meta('location', 'Lobby', m.settings.lobby === 'everyone' ? 'Everyone waits to be let in' : 'Guests and people from outside wait'));
    return {
      url, kind: 'meeting', title: m.title || 'Meeting', subtitle: `Meeting ${formatMeetingId(m.id)}`, meta: rows, preview: null,
      actions: [action('join', m.live ? 'Join the meeting' : 'Start or join', m.link), action('copy-path', 'Copy meeting link', m.link)],
      ref: { ...(found.insider && m.convId ? { convId: m.convId } : {}), ...(found.insider && m.eventId ? { eventId: m.eventId } : {}) }, fetchedAt: Date.now(),
    };
  }

  private tool(url: string, scheme: string): LinkCard {
    let u: URL | null = null;
    try { u = new URL(url); } catch { /* shown as a plain tool link */ }
    const at = Date.now();
    const segs = u ? `${u.host}${u.pathname}`.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } }) : [];
    const card = (kind: LinkCard['kind'], title: string, subtitle: string, tool: string, label: string, rows: LinkCardMeta[] = []): LinkCard => ({
      url, kind, title: title.slice(0, 200), subtitle, meta: [meta('tool', 'Opens in', subtitle.split(' · ')[0]), ...rows], preview: null,
      actions: [action('open-in-tool', label, url, tool), action('copy-path', 'Copy link', url)], fetchedAt: at,
    });
    if (scheme === 'sleuth') {
      const q = (u?.searchParams.get('q') ?? '').trim().slice(0, 200);
      return card('search', q ? `Find “${q}” in the drawings` : 'Search the drawings', 'Sleuth', 'sleuth', 'Search in Sleuth');
    }
    if (scheme === 'dexterity') {
      if (segs[0] === 'open' && segs[2]) {
        // the whole link opens, ?at=<Sheet>!<Cell> included, so Sheets goes to the cell
        const wb = parseWorkbookLink(url);
        const book = wb?.book ?? segs.slice(2).join('/');
        const rows: LinkCardMeta[] = [];
        if (wb?.sheet) rows.push(meta('sheet', 'Sheet', wb.sheet.slice(0, 80)));
        if (wb?.cell) rows.push(meta('location', 'Cell', wb.cell.slice(0, 80)));
        return card('workbook', bookName(book), `Dexterity Sheets · ${segs[1]}`, 'sheets', wb?.cell ? `Open at ${wb.cell.slice(0, 20)}` : 'Open in Dexterity Sheets', rows);
      }
      return card('tool', 'Dexterity Sheets', 'Dexterity Sheets', 'sheets', 'Open Dexterity Sheets');
    }
    if (scheme === 'projectopener') {
      const id = segs[0] === 'open' ? segs.slice(1).join('/') : segs.join('/');
      return card('project', id || 'Project', 'Project Opener', 'project-opener', 'Open the project');
    }
    // datum://c/<component>, datum://m/<module>/<calculator>
    if (segs[0] === 'c' && segs[1]) return card('component', segs[1], 'Datum · component', 'datum', 'Open in Datum');
    if (segs[0] === 'm' && segs[1]) return card('calculator', segs.slice(1).join(' / '), 'Datum · calculator', 'datum', 'Open in Datum');
    return card('tool', 'Datum', 'Datum', 'datum', 'Open Datum');
  }

  /** A path on the office share: the card shows it and opens the folder on the person's own PC (the hub reads nothing). */
  private path(url: string): LinkCard {
    let p = url.trim();
    if (/^file:/i.test(p)) {
      try {
        const u = new URL(p);
        const pathname = decodeURIComponent(u.pathname);
        p = u.host ? `\\\\${u.host}${pathname.replace(/\//g, '\\')}` : pathname.replace(/^\/([a-z]:)/i, '$1').replace(/\//g, '\\');
      } catch { return { url, kind: 'unavailable', title: null, subtitle: null, meta: [], preview: null, actions: [], status: 'failed', reason: 'That path could not be read.', fetchedAt: Date.now() }; }
    }
    p = p.replace(/[\\]+$/, (s) => (p.length === s.length ? s : '\\'));
    const folder = /\\$/.test(p) || !/\.[a-z0-9]{1,8}$/i.test(p.split('\\').pop() ?? '');
    const segs = p.split('\\').filter(Boolean);
    const name = segs[segs.length - 1] ?? p;
    const parent = folder ? p.replace(/\\$/, '') : p.slice(0, p.length - name.length).replace(/\\$/, '');
    const ext = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase() ?? '';
    const server = /^\\\\([^\\]+)/.exec(p)?.[1];
    const rows: LinkCardMeta[] = [meta('type', 'Type', folder ? 'Folder' : FILE_TYPES[ext] ?? (ext ? `${ext.toUpperCase()} file` : 'File')), meta('path', 'Path', p)];
    if (server) rows.push(meta('site', 'Server', server));
    return {
      url, kind: folder ? 'folder' : 'path', title: name, subtitle: folder ? parent.split('\\').slice(0, -1).join('\\') || parent : parent, meta: rows, preview: null,
      actions: [action('open-in-tool', 'Open folder', folder ? p : parent, 'folder'), action('copy-path', 'Copy path', p)], fetchedAt: Date.now(),
    };
  }

  // ---------------------------------------------------------------- web pages
  private allowedExternal(me: PublicUser): boolean {
    const s = this.settings();
    return me.role === 'guest' ? s.externalPreviews && s.guestExternalPreviews : s.externalPreviews;
  }

  private cached(hash: string, now = Date.now()): LinkCard | null {
    const r = this.db.prepare('SELECT card, fetched_at, ok FROM link_cache WHERE url_hash = ?').get(hash) as CacheRow | undefined;
    if (!r || now - r.fetched_at > (r.ok ? DAY : FAILED_TTL)) return null;
    try { return { ...(JSON.parse(r.card) as LinkCard), cached: true }; } catch { return null; }
  }

  private async web(url: string, me: PublicUser): Promise<LinkCard> {
    const norm = normaliseUrl(url);
    let host = '';
    try { host = new URL(norm).hostname; } catch { /* reported below */ }
    if (!this.allowedExternal(me)) {
      return { url, kind: 'web', title: null, subtitle: host || null, meta: host ? [meta('site', 'Site', host)] : [], preview: null, actions: [action('open', 'Open', url)], status: 'disabled', reason: 'Previews of web pages are turned off for this office.', fetchedAt: Date.now() };
    }
    const hash = urlHash(norm);
    const hit = this.cached(hash);
    if (hit) return { ...hit, url };
    const running = this.inflight.get(hash);
    if (running) return { ...(await running), url };
    this.limit(me.id);
    return { ...(await this.fetchCard(norm, hash)), url };
  }

  /** At most 30 web previews a minute per person (cached ones are free). */
  private limit(userId: string, now = Date.now()): void {
    const list = (this.recent.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW);
    if (list.length >= RATE_LIMIT) { this.recent.set(userId, list); throw new LinkError('Too many link previews in a minute. Try again shortly.'); }
    list.push(now);
    this.recent.set(userId, list);
    if (this.recent.size > 5000) for (const [k, v] of this.recent) if (!v.some((t) => now - t < RATE_WINDOW)) this.recent.delete(k);
  }

  private fetchCard(norm: string, hash: string): Promise<LinkCard> {
    const job = this.build(norm).then((card) => {
      const ok = card.status === 'ok' ? 1 : 0;
      this.db.prepare('INSERT INTO link_cache (url_hash, url, card, ok, fetched_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(url_hash) DO UPDATE SET card = excluded.card, ok = excluded.ok, fetched_at = excluded.fetched_at, url = excluded.url')
        .run(hash, norm.slice(0, MAX_URL), JSON.stringify(card), ok, card.fetchedAt);
      // old entries go
      this.db.prepare('DELETE FROM link_cache WHERE fetched_at < ?').run(Date.now() - 2 * DAY);
      return card;
    }).finally(() => this.inflight.delete(hash));
    this.inflight.set(hash, job);
    return job;
  }

  private async build(url: string): Promise<LinkCard> {
    const at = Date.now();
    let u: URL;
    try { u = new URL(url); } catch { return { url, kind: 'unavailable', title: null, subtitle: null, meta: [], preview: null, actions: [], status: 'failed', reason: 'That is not a web address.', fetchedAt: at }; }
    const host = u.hostname.replace(/^www\./, '');
    const base: LinkCard = { url, kind: 'web', title: null, subtitle: host, meta: [meta('site', 'Site', host)], preview: null, actions: [action('open', 'Open', url)], status: 'ok', fetchedAt: at };
    const yt = youtubeId(u);
    const gh = github(u);
    if (yt) Object.assign(base, { kind: 'video', subtitle: 'YouTube', preview: { imageUrl: `https://i.ytimg.com/vi/${yt}/hqdefault.jpg` } });
    if (gh) Object.assign(base, { kind: gh.kind, subtitle: gh.kind === 'repo' ? 'GitHub' : `${gh.repo} #${gh.number}`, title: gh.repo });
    let res: FetchResult;
    try {
      res = await guardedFetch(url, { ...this.fetchOptions, allowLanHosts: [...(this.fetchOptions.allowLanHosts ?? []), ...this.settings().allowLanHosts] });
    } catch (err) {
      const blocked = err instanceof FetchBlocked;
      // a YouTube or GitHub card is still useful without the page
      if (!blocked && (yt || gh)) return { ...base, status: 'failed', reason: (err as Error).message };
      return { ...base, kind: blocked ? 'unavailable' : base.kind, status: blocked ? 'blocked' : 'failed', reason: blocked ? (err as Error).message : `The page could not be fetched (${(err as Error).message}).`, preview: base.preview };
    }
    if (res.status >= 400) return { ...base, status: 'failed', reason: `The site answered ${res.status}.` };
    const fileName = (() => {
      const cd = res.disposition ? /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(res.disposition)?.[1] : undefined;
      const last = new URL(res.url).pathname.split('/').filter(Boolean).pop();
      try { return decodeURIComponent(cd ?? last ?? host).slice(0, 200); } catch { return (cd ?? last ?? host).slice(0, 200); }
    })();
    const size = res.contentLength ?? (res.truncated ? null : res.body.length || null);
    if (res.contentType === 'application/pdf') {
      return { ...base, url, kind: 'pdf', title: fileName, subtitle: host, meta: [meta('type', 'Type', 'PDF document'), ...(size !== null ? [meta('size', 'Size', humanSize(size), size)] : []), meta('site', 'Site', host)] };
    }
    if (res.contentType.startsWith('image/')) {
      const dim = imageSize(res.body);
      return {
        ...base, kind: 'image', title: fileName, subtitle: host, preview: { imageUrl: res.url },
        meta: [...(dim ? [meta('dimensions', 'Size', `${dim.width} × ${dim.height}`)] : []), ...(size !== null ? [meta('size', 'File size', humanSize(size), size)] : []), meta('site', 'Site', host)],
      };
    }
    if (res.contentType !== 'text/html' && res.contentType !== 'application/xhtml+xml') {
      return { ...base, title: base.title ?? fileName, meta: [...base.meta, ...(res.contentType ? [meta('type', 'Type', res.contentType)] : []), ...(size !== null ? [meta('size', 'Size', humanSize(size), size)] : [])] };
    }
    const page = scanHtml(decode(res.body, res.contentType), res.url);
    let title = page.title ?? null;
    if (gh && title) title = title.replace(/\s+·\s+(?:Issue|Pull Request) #\d+\s+·\s+.+$/i, '').replace(/^GitHub - /, '').slice(0, 300);
    return {
      ...base, url,
      title: title ?? base.title,
      subtitle: gh ? base.subtitle : yt ? page.siteName ?? 'YouTube' : page.siteName ?? host,
      preview: {
        ...(page.description ? { excerpt: page.description.slice(0, 300) } : {}),
        ...(yt ? { imageUrl: `https://i.ytimg.com/vi/${yt}/hqdefault.jpg` } : page.image ? { imageUrl: page.image } : {}),
        ...(page.favicon ? { favicon: page.favicon } : {}),
      },
    };
  }

  /** After a message is posted (never on the way in): warm the cache for its web links. */
  prefetch(msg: Message, author: PublicUser): void {
    if (!msg.body || isSealed(msg.body) || !this.allowedExternal(author)) return;
    const urls = [...new Set((msg.body.match(/https?:\/\/[^\s<>"'`)\]]+/g) ?? []).map((x) => x.replace(/[.,;:!?]+$/, '')))].slice(0, 3);
    if (!urls.length) return;
    setImmediate(() => {
      const now = Date.now();
      this.prefetches = this.prefetches.filter((t) => now - t < RATE_WINDOW);
      for (const url of urls) {
        if (this.prefetches.length >= PREFETCH_PER_MINUTE) return;
        const norm = normaliseUrl(url);
        const hash = urlHash(norm);
        if (this.inflight.has(hash) || this.cached(hash)) continue;
        this.prefetches.push(now);
        this.fetchCard(norm, hash).catch(() => { /* the person asks again when they look */ });
      }
    });
  }

  // ---------------------------------------------------------------- side-tracks about a link
  private discuss(me: PublicUser, d: Record<string, unknown>): LinkThread {
    const url = typeof d.url === 'string' ? d.url.trim() : '';
    if (!url || url.length > MAX_URL) throw new LinkError('Give the link to discuss.');
    const convId = typeof d.convId === 'string' ? d.convId : '';
    let conv: ReturnType<Messaging['memberConv']>;
    try { conv = this.deps.messaging.memberConv(convId, me.id); } catch { throw new LinkError('Conversation not found.'); }
    const norm = normaliseUrl(url);
    const hash = urlHash(norm);
    const usable = (id: string | undefined | null) => {
      if (!id) return null;
      const m = this.db.prepare('SELECT id FROM messages WHERE id = ? AND conv_id = ? AND parent_id IS NULL AND deleted = 0 AND system IS NULL').get(id, conv.id) as { id: string } | undefined;
      return m?.id ?? null;
    };
    const view = (rootId: string, created: boolean): LinkThread => {
      const root = this.deps.messaging.messageFor(rootId, me.id);
      if (!root) throw new LinkError('Message not found.');
      return { convId: conv.id, url: norm, urlHash: hash, rootMessageId: rootId, root, created };
    };
    const save = (rootId: string) => this.db.prepare(`INSERT INTO link_threads (conv_id, url_hash, url, root_message_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(conv_id, url_hash) DO UPDATE SET root_message_id = excluded.root_message_id`).run(conv.id, hash, norm.slice(0, MAX_URL), rootId, me.id, Date.now());
    const known = this.db.prepare('SELECT root_message_id FROM link_threads WHERE conv_id = ? AND url_hash = ?').get(conv.id, hash) as { root_message_id: string } | undefined;
    const existing = usable(known?.root_message_id);
    if (existing) return view(existing, false);
    // the person chose the message (the only way in an encrypted Direct conversation)
    if (typeof d.messageId === 'string') {
      const chosen = usable(d.messageId);
      if (!chosen) throw new LinkError('That message cannot start a side-track.');
      save(chosen);
      return view(chosen, false);
    }
    if (conv.kind === 'direct') throw new LinkError('In a Direct conversation, start the side-track from the message with the link.');
    // the latest message that already holds the link
    const holder = this.db.prepare(`SELECT id FROM messages WHERE conv_id = ? AND parent_id IS NULL AND deleted = 0 AND system IS NULL AND (instr(body, ?) > 0 OR instr(body, ?) > 0)
      ORDER BY id DESC LIMIT 1`).get(conv.id, url, norm) as { id: string } | undefined;
    if (holder) { save(holder.id); return view(holder.id, false); }
    // otherwise a new message with the link starts the side-track
    const msg = this.deps.messaging.sendAs(me, conv, url, undefined, [], `link-${hash.slice(0, 16)}-${Date.now().toString(36)}`, {});
    save(msg.id);
    return view(msg.id, true);
  }
}

function decode(body: Buffer, contentType: string): string {
  const declared = /charset=([\w-]+)/i.exec(contentType)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.subarray(0, 2048).toString('latin1'))?.[1] ?? 'utf-8';
  try { return new TextDecoder(declared.toLowerCase(), { fatal: false }).decode(body); } catch { return new TextDecoder('utf-8').decode(body); }
}

/** The video id of a YouTube link (watch, youtu.be, shorts, embed, live). */
export function youtubeId(u: URL): string | null {
  const host = u.hostname.replace(/^(?:www\.|m\.|music\.)/, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = u.pathname.split('/')[1] ?? null;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else { const m = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(u.pathname); id = m?.[1] ?? null; }
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

const GITHUB_RESERVED = new Set(['settings', 'orgs', 'organizations', 'marketplace', 'explore', 'topics', 'features', 'about', 'pricing', 'login', 'join', 'notifications', 'sponsors', 'search', 'new', 'apps', 'enterprise', 'collections', 'trending', 'pulls', 'issues', 'codespaces', 'security', 'site', 'contact']);

/** A GitHub repository, issue or pull request. */
export function github(u: URL): { kind: 'repo' | 'issue' | 'pull'; repo: string; number?: number } | null {
  if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') return null;
  const [owner, repo, section, num] = u.pathname.split('/').filter(Boolean);
  if (!owner || !repo || GITHUB_RESERVED.has(owner.toLowerCase()) || !/^[\w.-]{1,100}$/.test(owner) || !/^[\w.-]{1,100}$/.test(repo)) return null;
  const name = `${owner}/${repo.replace(/\.git$/, '')}`;
  if (!section) return { kind: 'repo', repo: name };
  if ((section === 'issues' || section === 'pull') && num && /^\d{1,9}$/.test(num)) return { kind: section === 'pull' ? 'pull' : 'issue', repo: name, number: Number(num) };
  return null;
}
