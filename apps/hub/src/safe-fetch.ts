// Outgoing webhooks from Automations, guarded against reaching places they should not: only
// http and https, the host's addresses checked before connecting (and the connection pinned to
// the checked address, so a second DNS answer cannot swap it), addresses on the office network
// refused unless an administrator allowed them, cloud metadata and other special ranges always
// refused, every redirect checked the same way, a time limit, and caps on what is sent and read.
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { LookupFunction } from 'node:net';

export class FetchBlocked extends Error {}

export interface SafeFetchOptions {
  /** Allow addresses on the office network (private ranges and this PC). */
  allowLan: boolean;
  method?: 'POST' | 'GET';
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBody?: number;
  maxReply?: number;
  maxRedirects?: number;
  /** Name resolution (tests give their own). */
  resolve?: (host: string) => Promise<string[]>;
}

export interface SafeReply { status: number; text: string; truncated: boolean; url: string }

/** What kind of address this is: public, on a private network, or never to be called. */
export function classifyAddress(address: string): 'public' | 'private' | 'blocked' {
  let a = address.toLowerCase().replace(/^\[|\]$/g, '');
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  // IPv4 inside IPv6 (::ffff:10.0.0.1 or ::ffff:a00:1)
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) a = mapped[1];
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    a = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  if (net.isIPv4(a)) {
    const [o1, o2, o3] = a.split('.').map(Number);
    if (o1 === 0) return 'blocked'; // "this network"
    if (o1 === 169 && o2 === 254) return 'blocked'; // link-local, cloud metadata
    if (o1 >= 224) return 'blocked'; // multicast, reserved, broadcast
    if (o1 === 192 && o2 === 0 && o3 === 0) return 'blocked'; // IETF protocol assignments
    if (o1 === 198 && (o2 === 18 || o2 === 19)) return 'private'; // benchmarking
    if (o1 === 127 || o1 === 10) return 'private';
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return 'private';
    if (o1 === 192 && o2 === 168) return 'private';
    if (o1 === 100 && o2 >= 64 && o2 <= 127) return 'private'; // carrier-grade NAT
    return 'public';
  }
  if (net.isIPv6(a)) {
    if (a === '::' ) return 'blocked';
    if (a === '::1') return 'private';
    const first = parseInt(a.split(':')[0] || '0', 16);
    if ((first & 0xffc0) === 0xfe80) return 'blocked'; // link-local
    if ((first & 0xff00) === 0xff00) return 'blocked'; // multicast
    if ((first & 0xfe00) === 0xfc00) return 'private'; // unique local
    if (a.startsWith('64:ff9b:') || a.startsWith('2002:') || a.startsWith('::')) return 'blocked'; // translated, 6to4, IPv4-compatible
    return 'public';
  }
  return 'blocked';
}

const defaultResolve = async (host: string): Promise<string[]> => (await dns.lookup(host, { all: true, verbatim: true })).map((r) => r.address);

/** The address to connect to for a URL, after checking every address the name resolves to. */
async function checkedAddress(u: URL, opts: SafeFetchOptions): Promise<string> {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FetchBlocked('Only http:// and https:// addresses can be called.');
  if (u.username || u.password) throw new FetchBlocked('Addresses with a user name or password cannot be called.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new FetchBlocked('The address has no host.');
  let addresses: string[];
  if (net.isIP(host)) addresses = [host];
  else {
    if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host) && !opts.allowLan) throw new FetchBlocked(`${host} is on the office network, and calling the office network is turned off.`);
    try { addresses = await (opts.resolve ?? defaultResolve)(host); } catch { throw new FetchBlocked(`${host} could not be found.`); }
    if (!addresses.length) throw new FetchBlocked(`${host} could not be found.`);
  }
  for (const a of addresses) {
    const kind = classifyAddress(a);
    if (kind === 'blocked') throw new FetchBlocked(`${host} points to an address that cannot be called (${a}).`);
    if (kind === 'private' && !opts.allowLan) throw new FetchBlocked(`${host} is on the office network (${a}), and calling the office network is turned off. An administrator can allow it in the Control room.`);
  }
  return addresses[0];
}

/** Make one request (following up to a few redirects, each checked again). */
export async function safeFetch(url: string, opts: SafeFetchOptions): Promise<SafeReply> {
  const maxBody = opts.maxBody ?? 16 * 1024;
  const maxReply = opts.maxReply ?? 64 * 1024;
  const body = opts.body ?? '';
  if (Buffer.byteLength(body) > maxBody) throw new FetchBlocked(`The body is larger than ${Math.round(maxBody / 1024)} KB.`);
  const deadline = Date.now() + (opts.timeoutMs ?? 8000);
  let current: URL;
  try { current = new URL(url); } catch { throw new FetchBlocked('That is not a web address.'); }
  let method = opts.method ?? 'POST';
  for (let hop = 0; ; hop++) {
    const address = await checkedAddress(current, opts);
    const left = deadline - Date.now();
    if (left <= 0) throw new FetchBlocked('The address did not answer in time.');
    const res = await once(current, address, method, method === 'POST' ? body : '', opts, left, maxReply);
    if (res.status >= 300 && res.status < 400 && res.location) {
      if (hop >= (opts.maxRedirects ?? 3)) throw new FetchBlocked('The address redirected too many times.');
      let next: URL;
      try { next = new URL(res.location, current); } catch { throw new FetchBlocked('The address redirected somewhere invalid.'); }
      // a redirect may not leave http(s) or reach a refused address: checked at the top of the loop
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) method = 'GET';
      current = next;
      continue;
    }
    return { status: res.status, text: res.text, truncated: res.truncated, url: current.href };
  }
}

function once(u: URL, address: string, method: string, body: string, opts: SafeFetchOptions, timeoutMs: number, maxReply: number): Promise<{ status: number; text: string; truncated: boolean; location: string | null }> {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    const family = net.isIPv6(address) ? 6 : 4;
    // connect to the address that was checked, whatever the name resolves to now
    const lookup: LookupFunction = (_host, options, cb) => {
      if ((options as { all?: boolean }).all) (cb as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [{ address, family }]);
      else cb(null, address, family);
    };
    const headers: Record<string, string | number> = {
      'user-agent': 'DexterityConnect-Automations/1',
      accept: 'application/json, text/plain;q=0.9, */*;q=0.5',
      ...(opts.headers ?? {}),
    };
    if (method === 'POST') { headers['content-type'] = opts.contentType ?? 'application/json'; headers['content-length'] = Buffer.byteLength(body); }
    const lan = classifyAddress(address) === 'private';
    const req = lib.request(u, {
      method, headers, lookup, timeout: timeoutMs,
      // office servers often use their own certificates; public addresses must have a valid one
      ...(u.protocol === 'https:' ? { rejectUnauthorized: !lan, servername: net.isIP(u.hostname) ? undefined : u.hostname } : {}),
    }, (res) => {
      let text = '';
      let size = 0;
      let truncated = false;
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        if (truncated) return;
        size += Buffer.byteLength(c);
        if (size > maxReply) { truncated = true; text += c.slice(0, Math.max(0, maxReply - (size - Buffer.byteLength(c)))); res.destroy(); finish(); return; }
        text += c;
      });
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve({ status: res.statusCode ?? 0, text, truncated, location: typeof res.headers.location === 'string' ? res.headers.location : null }); };
      res.on('end', finish);
      res.on('close', finish);
      res.on('error', () => finish());
    });
    const timer = setTimeout(() => req.destroy(new FetchBlocked('The address did not answer in time.')), timeoutMs);
    req.on('timeout', () => req.destroy(new FetchBlocked('The address did not answer in time.')));
    req.on('error', (e) => { clearTimeout(timer); reject(e instanceof FetchBlocked ? e : new FetchBlocked(`The call failed: ${(e as NodeJS.ErrnoException).code ?? e.message}.`)); });
    req.end(method === 'POST' ? body : undefined);
  });
}
