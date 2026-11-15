// Dexterity Connect gateway: lets phones and home laptops reach the office hub from any network
// without opening a single port at the office. The hub keeps one outbound WebSocket here; each
// device opens another; this Worker pairs them and passes opaque, end-to-end encrypted frames
// between them (packages/core/src/remote.ts has the channel). It never sees a message, a file or
// a password, and holds no data: only who is connected right now.
//
// Hardening, in the spirit of the relays it learnt from:
// - Only the hub that proves it holds the pinned certificate key can take the hub side.
// - Device sockets are binary-only, at most 1 MiB a frame, rate limited per address, and capped.
// - Nothing but /hub/<id>, /c/<id>, /join, the meeting site (below), /m/<meeting> (old links),
//   /w/<webinar>, /cal/<token>.ics and /health answers; every reply carries strict headers.
//
// Guests (meetings, M2): the meeting's page (below) loads the meeting itself (meet/room.ts) on
// Join. Its WebSocket, /api/m/<meeting ID>/ws (old pages: /m/<ID>/ws), goes to the office hub's
// relay as a "guest" socket: JSON frames, passed to the hub as guest frames on the hub's own
// connection. The page sends the passcode (from the link's #fragment, which never reaches a server
// log) in its first frame; the hub checks it. Connections and wrong passcodes are limited per address.
//
// Webinars (M3): /w/<meeting ID> is the public registration page, /w/<ID>/watch#<token> an
// attendee's personal link and /w/<ID>/survey#<token> the follow-up survey (webinar/page.ts). The
// page's requests (the webinar's details, registering, the survey) are passed to the hub over its
// own connection and answered there; the gateway limits them per address (in the Durable
// Object's storage), drops a form whose hidden honeypot field is filled, and caps how many
// registrations it passes on in an hour. The watch page's socket, /w/<ID>/ws, is a guest socket
// like the meeting page's (the token is checked by the hub; a wrong one counts as a wrong passcode).
//
// Dexterity Meet (docs/DEXTERITY-MEET.md): every meeting's public page, /<meeting ID or name>, on
// the office's meeting site. The site is a Cloudflare Pages project (apps/meet-site) whose only
// code passes requests here through a service binding, so browsers only ever see its clean address
// (https://dexterity-meet.pages.dev, or the office's own domain); the hub tells this gateway which
// address that is. Before the site is set up, the gateway serves the pages on its own address.
// - /<ref>: the landing page (meet/landing.ts), the same small shell for every meeting: it holds no
//   meeting data; the page asks /api/m/<ref> (what the host allowed before a passcode) and POSTs
//   /api/m/<ref>/check (the passcode, in the body). The hub answers both; this gateway passes only
//   the fields a page may have, whatever the hub sends, and limits the questions per address and per
//   meeting; wrong passcodes count with the guest socket's (five in ten minutes, then a lock).
// - /api/m/<ID>/ws: the guest's socket, as before; /m/<ID> links redirect to the clean page.
// - /assets/<name>: the pages' scripts, styles, fonts and mark, named after their content.
// - Strict headers: a CSP with no inline code and connect-src only this address, no framing, no
//   referrer, HSTS, nosniff, camera and microphone for this page only, no third-party requests.
//
// Calendar feeds: /cal/<token>.ics is a person's private calendar, for Outlook or a phone to
// subscribe to. Calendar apps cannot open the devices' encrypted channel, so the token goes to the
// hub over its own connection and the feed comes back as text: the gateway can read it (meeting
// titles and times), which docs/REMOTE-ACCESS.md says. Fetches are limited per address.
import { DurableObject } from 'cloudflare:workers';
import { parseMeetRef, refSegment } from '@dex/core/meetlink';
import { SITE_FILES, SITE_NAMES } from './site-assets.gen.ts';

interface Env {
  RELAY: DurableObjectNamespace<Relay>;
  /** The hub's certificate fingerprint (Control room ▸ Outside the office). Without it, the first hub to connect is trusted. */
  HUB_FINGERPRINT?: string;
}

const MAX_FRAME = (1 << 20) + 64;
const MAX_DEVICES = 600;
const CONNECTS_PER_MINUTE = 40;
const ID_RE = '[0-9A-Za-z_-]{6,64}';
/** Guests: at most this many at once, frames of at most 64 KiB, and few wrong passcodes per address. */
const MAX_GUESTS = 300;
const MAX_GUEST_FRAME = 64 * 1024;
const GUEST_CONNECTS_PER_MINUTE = 20;
const GUEST_FAILS = 5;
const GUEST_FAIL_WINDOW_MS = 10 * 60_000;
const GUEST_FRAMES_PER_10S = 400;
/** The relay that remembers which hub's meetings /m/ leads to (not a hub id: ID_RE never matches it). */
const HOME = '~home';
const MEETING_RE = /^\/m\/([1-9]\d{8})(\/ws)?\/?$/;
/** Webinar pages and their requests: by ID or by name. */
const WEBINAR_RE = /^\/w\/([a-z0-9-]{3,64})(?:\/(watch|survey|info|register|survey-info|answers|ws))?\/?$/;
/** Dexterity Meet: a meeting's page (by ID, dashed or not, or by name), and what the page asks. */
const PAGE_RE = /^\/([A-Za-z0-9-]{3,64})\/?$/;
const PAGE_API_RE = /^\/api\/m\/([a-z0-9-]{3,64})(\/check|\/ws)?$/;
const ASSET_RE = /^\/assets\/([A-Za-z0-9.-]{3,80})$/;
/** Questions a page may ask: per address a minute, per meeting a minute, and names that lead nowhere per address in ten minutes. */
const PAGE_INFO_PER_MINUTE = 60;
const PAGE_PER_MEETING_MINUTE = 240;
const PAGE_MISSES = 30;
const PAGE_MISS_WINDOW_MS = 10 * 60_000;
const MAX_CHECK = 1024;
/** The only fields a page may receive, before and after the passcode (anything else the hub sends is dropped here). */
const PUBLIC_FIELDS = ['found', 'id', 'ref', 'kind', 'org', 'title', 'host', 'startAt', 'endAt', 'zone', 'repeats', 'state', 'liveSince', 'opensAt'];
const DETAIL_FIELDS = ['ok', 'id', 'ref', 'kind', 'org', 'title', 'host', 'startAt', 'endAt', 'zone', 'repeats', 'recurrence', 'state', 'liveSince', 'opensAt', 'next', 'followUp'];
const WEBINAR_PAGES = new Set(['', 'watch', 'survey']);
/** Registrations passed to the hub: per address an hour, and for the whole gateway an hour. */
const REGISTER_PER_HOUR = 5;
const REGISTER_ALL_PER_HOUR = 300;
const SURVEY_PER_HOUR = 10;
const INFO_PER_MINUTE = 60;
const MAX_FORM = 16 * 1024;
const HUB_ANSWER_MS = 10_000;
/** Calendar feeds: the token (32 random bytes), and how often one address may fetch. */
const CAL_RE = /^\/cal\/([A-Za-z0-9_-]{43})\.ics$/;
const CAL_PER_MINUTE = 30;
/** The only types a feed answer may carry. */
const CAL_TYPES = new Set(['text/calendar; charset=utf-8', 'text/plain; charset=utf-8']);

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
  'cross-origin-resource-policy': 'same-origin',
  'x-robots-tag': 'noindex, nofollow, noarchive',
};
const text = (body: string, status = 200, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS, ...extra } });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS } });

/** A socket that closes with a code as soon as it opens: a browser cannot read why an upgrade was refused. */
function refuse(code: number, reason: string): Response {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
}

/** Which hub the meeting pages lead to, and the meeting site's address (told by that hub). */
async function homeOf(env: Env): Promise<{ hubId?: string; site?: string }> {
  const home = await env.RELAY.get(env.RELAY.idFromName(HOME)).fetch('https://gateway/~home/get');
  return home.ok ? await home.json() as { hubId?: string; site?: string } : {};
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const asset = path.match(ASSET_RE);
    if (asset) return siteAsset(asset[1], req);
    if (path === '/health') return text('Dexterity Connect gateway\n');
    if (path === '/join') return joinPage();
    if (path === '/hub' || path.startsWith('/hub/') || path.startsWith('/c/')) {
      const m = path.match(new RegExp(`^/(hub|c)/(${ID_RE})$`));
      if (!m) return text('Not found\n', 404);
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return text('Expected a WebSocket\n', 426);
      return env.RELAY.get(env.RELAY.idFromName(m[2])).fetch(req);
    }
    const cal = path.match(CAL_RE);
    if (cal) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return text('Method not allowed\n', 405, { allow: 'GET, HEAD' });
      const { hubId } = await homeOf(env);
      if (!hubId) return text('The office is not connected right now. Your calendar tries again later.\n', 503, { 'retry-after': '600' });
      return env.RELAY.get(env.RELAY.idFromName(hubId)).fetch(req);
    }

    // ---- Dexterity Meet: the meeting site's pages, its questions and the guest socket
    const home = await homeOf(env);
    const site = home.site ? safeOrigin(home.site) : null;
    // on the meeting site's own address (or here, while there is none)
    const onSite = !site || url.origin === site;
    const toSite = (p: string) => Response.redirect(`${site ?? url.origin}${p}`, 301);

    if (path === '/') return onSite && site ? landingPage('', url) : text('Dexterity Connect gateway\n');
    // old links: /m/<ID>#passcode to the meeting's clean page (browsers keep the #fragment across a redirect)
    const meet = path.match(MEETING_RE);
    if (meet) {
      if (meet[2]) {
        if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return text('Expected a WebSocket\n', 426);
        if (!home.hubId) return refuse(4404, 'The office is not connected to the gateway');
        return env.RELAY.get(env.RELAY.idFromName(home.hubId)).fetch(req);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return text('Method not allowed\n', 405);
      return toSite(`/${refSegment(meet[1])}`);
    }
    const papi = path.match(PAGE_API_RE);
    if (papi) {
      // the gateway's own address answers no meeting questions once the site has its own
      if (!onSite) return json({ error: 'Not found' }, 404);
      const ref = parseMeetRef(papi[1]);
      if (!ref) return json({ found: false }, 404);
      const sub = papi[2] ?? '';
      if (sub === '/ws') {
        if (ref.kind !== 'id') return text('Not found\n', 404);
        if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return text('Expected a WebSocket\n', 426);
      } else if (sub === '/check' ? req.method !== 'POST' : req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      if (!home.hubId) return sub === '/ws' ? refuse(4404, 'The office is not connected to the gateway') : json({ error: 'The office is not connected right now. Try again in a few minutes.' }, 503);
      return env.RELAY.get(env.RELAY.idFromName(home.hubId)).fetch(req);
    }
    const wb = path.match(WEBINAR_RE);
    if (wb) {
      const ref = parseMeetRef(wb[1]);
      if (!ref) return text('Not found\n', 404);
      const sub = wb[2] ?? '';
      if (WEBINAR_PAGES.has(sub) && req.method !== 'POST') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return text('Method not allowed\n', 405);
        if (!onSite) return toSite(path);
        return webinarPage(ref.kind === 'id' ? ref.id : ref.slug, sub === 'watch' || sub === 'survey' ? sub : 'register', url);
      }
      if (!onSite) return json({ error: 'Not found' }, 404);
      if (sub === 'ws' && req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return text('Expected a WebSocket\n', 426);
      if (!home.hubId) return sub === 'ws' ? refuse(4404, 'The office is not connected to the gateway') : json({ error: 'The office is not connected right now. Try again later.' }, 503);
      return env.RELAY.get(env.RELAY.idFromName(home.hubId)).fetch(req);
    }
    const page = path.match(PAGE_RE);
    if (page) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return text('Method not allowed\n', 405, { allow: 'GET, HEAD' });
      // names are lower case: /P12-Review is /p12-review
      const lower = page[1].toLowerCase();
      const ref = parseMeetRef(lower);
      if (!ref) return text('Not found\n', 404);
      const canonical = `/${ref.kind === 'id' ? refSegment(ref.id) : ref.slug}`;
      if (!onSite || path !== canonical) return onSite ? Response.redirect(`${url.origin}${canonical}`, 301) : toSite(canonical);
      return landingPage(canonical.slice(1), url);
    }
    return text('Not found\n', 404);
  },
};

/** A configured site address as an origin (https, or a local test address), or null. */
function safeOrigin(v: string): string | null {
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/.test(u.hostname))) return null;
    return u.origin;
  } catch { return null; }
}

interface Attachment { kind: 'hub' | 'device' | 'guest'; hubId: string; authed?: boolean; nonce?: string; sid?: number; gid?: number; ip?: string; meetingId?: string; webinar?: boolean }

const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; };
const b64d = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(':');
function contains(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** One relay per hub id. Uses hibernating WebSockets, so a quiet office costs nothing between frames. */
export class Relay extends DurableObject<Env> {
  private readonly attempts = new Map<string, { n: number; until: number }>();
  private readonly frames = new Map<number, { n: number; until: number }>();
  /** Webinar page requests waiting for the hub's answer. */
  private readonly answers = new Map<number, (r: { s: number; d: string; ct?: string }) => void>();
  private nextAnswer = 1;

  private limited(ip: string, max = CONNECTS_PER_MINUTE, key = ip): boolean {
    const now = Date.now();
    for (const [k, w] of this.attempts) { if (w.until > now) break; this.attempts.delete(k); }
    const w = this.attempts.get(key) ?? { n: 0, until: now + 60_000 };
    w.n++;
    this.attempts.set(key, w);
    return w.n > max;
  }

  /** Wrong passcodes from an address in the last ten minutes (kept in storage: they outlast hibernation). */
  private async guestFails(ip: string): Promise<number[]> {
    const now = Date.now();
    return ((await this.ctx.storage.get<number[]>(`gf:${ip}`)) ?? []).filter((t) => now - t < GUEST_FAIL_WINDOW_MS);
  }

  private async guestFailed(ip: string): Promise<void> {
    const list = await this.guestFails(ip);
    list.push(Date.now());
    await this.ctx.storage.put(`gf:${ip}`, list.slice(-GUEST_FAILS * 2));
  }

  /** The relay named ~home: which hub /m/ pages lead to. The first hub to sign in claims it; only it (same certificate) may change it. */
  private async home(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/~home/get') {
      const h = await this.ctx.storage.get<{ hubId: string; fp: string }>('home');
      const site = await this.ctx.storage.get<string>('site');
      return h ? Response.json({ hubId: h.hubId, ...(site ? { site } : {}) }) : new Response('none', { status: 404 });
    }
    // the hub that owns the meeting pages says where its meeting site is (or that it has none)
    if (url.pathname === '/~home/site' && req.method === 'POST') {
      const c = await req.json() as { hubId: string; url: string | null };
      const h = await this.ctx.storage.get<{ hubId: string; fp: string }>('home');
      if (!h || h.hubId !== c.hubId) return new Response('not yours', { status: 403 });
      const origin = c.url ? safeOrigin(c.url) : null;
      if (origin) await this.ctx.storage.put('site', origin); else await this.ctx.storage.delete('site');
      return new Response('ok');
    }
    if (url.pathname === '/~home/claim' && req.method === 'POST') {
      const c = await req.json() as { hubId: string; fp: string; pinned: boolean };
      const h = await this.ctx.storage.get<{ hubId: string; fp: string }>('home');
      if (!h || h.fp === c.fp || c.pinned) await this.ctx.storage.put('home', { hubId: c.hubId, fp: c.fp });
      return new Response('ok');
    }
    return new Response('not found', { status: 404 });
  }

  private hub(): WebSocket | null {
    for (const ws of this.ctx.getWebSockets('hub')) if (ws.readyState === 1 && (ws.deserializeAttachment() as Attachment).authed) return ws;
    return null;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/~home/')) return this.home(req);
    const [, kind, hubId] = url.pathname.split('/');
    const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
    if (kind === 'api') {
      const m = url.pathname.match(PAGE_API_RE)!;
      const ref = parseMeetRef(m[1])!;
      const id = ref.kind === 'id' ? ref.id : ref.slug;
      if (m[2] === '/ws') return this.guest(req, ip, id);
      return this.page(req, ip, id, m[2] === '/check');
    }
    if (kind === 'm') return this.guest(req, ip, hubId);
    if (kind === 'w') return this.webinar(req, ip, hubId, url.pathname.split('/')[3] ?? '');
    if (kind === 'cal') return this.calendar(req, ip, url.pathname.match(CAL_RE)?.[1] ?? '');
    if (this.limited(ip)) return refuse(4429, 'Too many connections; try again in a minute');
    const { 0: client, 1: server } = new WebSocketPair();

    if (kind === 'hub') {
      if (this.ctx.getWebSockets('hub').length >= 4) return refuse(4429, 'Too many hub connections');
      const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))));
      this.ctx.acceptWebSocket(server, ['hub']);
      server.serializeAttachment({ kind: 'hub', hubId, authed: false, nonce } satisfies Attachment);
      server.send(JSON.stringify({ t: 'challenge', v: 1, n: nonce }));
      return new Response(null, { status: 101, webSocket: client });
    }

    const hub = this.hub();
    if (!hub) return refuse(4404, 'The office hub is not connected to the gateway');
    if (this.ctx.getWebSockets('device').length >= MAX_DEVICES) return refuse(4429, 'The gateway is full');
    let sid = 0;
    do sid = crypto.getRandomValues(new Uint32Array(1))[0] || 1; while (this.ctx.getWebSockets(`s:${sid}`).length);
    this.ctx.acceptWebSocket(server, ['device', `s:${sid}`]);
    server.serializeAttachment({ kind: 'device', hubId, sid, ip } satisfies Attachment);
    const cf = (req as Request & { cf?: { country?: string } }).cf;
    hub.send(JSON.stringify({ t: 'open', s: sid, ip, country: cf?.country ?? null }));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Timestamps in storage for a key, within the last hour (they outlast hibernation). */
  private async hourly(key: string, max: number, add: boolean): Promise<boolean> {
    const now = Date.now();
    const list = ((await this.ctx.storage.get<number[]>(key)) ?? []).filter((t) => now - t < 3600_000);
    if (list.length >= max) return false;
    if (add) { list.push(now); await this.ctx.storage.put(key, list.slice(-max)); }
    return true;
  }

  /** Ask the hub (over its own connection) and wait for its answer. */
  private ask(op: string, meetingId: string, ip: string, country: string | null, body: unknown): Promise<Response> {
    const hub = this.hub();
    if (!hub) return Promise.resolve(json({ error: 'The office is not connected right now. Try again later.' }, 503));
    const r = this.nextAnswer++;
    if (this.nextAnswer > 0x7fffffff) this.nextAnswer = 1;
    return new Promise<Response>((resolve) => {
      const t = setTimeout(() => { this.answers.delete(r); resolve(json({ error: 'The office did not answer. Try again in a moment.' }, 504)); }, HUB_ANSWER_MS);
      this.answers.set(r, (a) => { clearTimeout(t); resolve(new Response(a.d, { status: a.s >= 200 && a.s < 600 ? a.s : 502, headers: { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS } })); });
      hub.send(JSON.stringify({ t: 'w', r, op, m: meetingId, ip, country, b: body }));
    });
  }

  /**
   * A meeting page's two questions: what may be shown (GET), and the passcode (POST …/check).
   * Limited per address and per meeting; names that lead nowhere and wrong passcodes are counted
   * per address in storage (they outlast hibernation), and only the fields a page may have pass.
   */
  private async page(req: Request, ip: string, ref: string, check: boolean): Promise<Response> {
    if (this.limited(ip, PAGE_INFO_PER_MINUTE, `pi:${ip}`)) return json({ error: 'Too many requests from your network. Wait a minute.' }, 429);
    if (this.limited(ref, PAGE_PER_MEETING_MINUTE, `pm:${ref}`)) return json({ error: 'This meeting\'s page is very busy. Try again in a minute.' }, 429);
    const country = (req as Request & { cf?: { country?: string } }).cf?.country ?? null;
    if (!check) {
      const misses = ((await this.ctx.storage.get<number[]>(`pmiss:${ip}`)) ?? []).filter((t) => Date.now() - t < PAGE_MISS_WINDOW_MS);
      if (misses.length >= PAGE_MISSES) return json({ error: 'Too many addresses that lead nowhere were tried from your network. Wait ten minutes.' }, 429);
      const res = await this.ask('page.info', ref, ip, country, {});
      if (res.status === 404) {
        misses.push(Date.now());
        await this.ctx.storage.put(`pmiss:${ip}`, misses.slice(-PAGE_MISSES * 2));
        return json({ found: false }, 404);
      }
      return res.status === 200 ? only(res, PUBLIC_FIELDS) : res;
    }
    if ((await this.guestFails(ip)).length >= GUEST_FAILS) return json({ error: 'Too many wrong passcodes from your network. Try again in 10 minutes.' }, 429);
    if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) return json({ error: 'Send the passcode as JSON.' }, 415);
    const raw = await req.text();
    if (raw.length > MAX_CHECK) return json({ error: 'That is more than a passcode.' }, 413);
    let passcode: unknown;
    try { passcode = (JSON.parse(raw) as { passcode?: unknown }).passcode; } catch { return json({ error: 'The passcode could not be read.' }, 400); }
    if (typeof passcode !== 'string' || !/^[A-Za-z0-9]{6,10}$/.test(passcode)) {
      await this.guestFailed(ip);
      return json({ error: 'That passcode does not open a meeting at this address. Check the invitation.' }, 403);
    }
    const res = await this.ask('page.check', ref, ip, country, { passcode });
    if (res.status === 403) await this.guestFailed(ip);
    return res.status === 200 ? only(res, DETAIL_FIELDS) : res;
  }

  /** A calendar app fetching someone's private feed: the hub checks the token and makes the feed. */
  private calendar(req: Request, ip: string, token: string): Promise<Response> {
    const plain = (body: string, status: number, extra: Record<string, string> = {}) => text(body, status, extra);
    if (!token) return Promise.resolve(plain('Not found\n', 404));
    if (this.limited(ip, CAL_PER_MINUTE, `cal:${ip}`)) return Promise.resolve(plain('Too many calendar requests from your network. Wait a minute.\n', 429, { 'retry-after': '60' }));
    const hub = this.hub();
    if (!hub) return Promise.resolve(plain('The office is not connected right now. Your calendar tries again later.\n', 503, { 'retry-after': '600' }));
    const country = (req as Request & { cf?: { country?: string } }).cf?.country ?? null;
    const r = this.nextAnswer++;
    if (this.nextAnswer > 0x7fffffff) this.nextAnswer = 1;
    return new Promise<Response>((resolve) => {
      const t = setTimeout(() => { this.answers.delete(r); resolve(plain('The office did not answer. Your calendar tries again later.\n', 504)); }, HUB_ANSWER_MS);
      this.answers.set(r, (a) => {
        clearTimeout(t);
        const type = a.ct && CAL_TYPES.has(a.ct) ? a.ct : 'text/plain; charset=utf-8';
        const status = a.s >= 200 && a.s < 600 ? a.s : 502;
        resolve(new Response(req.method === 'HEAD' ? null : a.d, { status, headers: {
          'content-type': type, ...SECURITY_HEADERS,
          ...(status === 200 ? { 'content-disposition': 'inline; filename="dexterity-connect.ics"' } : {}),
        } }));
      });
      hub.send(JSON.stringify({ t: 'cal', r, k: token, ip, country }));
    });
  }

  /** The webinar pages' requests and the watch page's socket. */
  private async webinar(req: Request, ip: string, meetingId: string, sub: string): Promise<Response> {
    if (sub === 'ws') return this.guest(req, ip, meetingId, true);
    const country = (req as Request & { cf?: { country?: string } }).cf?.country ?? null;
    if (sub === 'info') {
      if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      if (this.limited(ip, INFO_PER_MINUTE, `wi:${ip}`)) return json({ error: 'Too many requests from your network. Wait a minute.' }, 429);
      return this.ask('info', meetingId, ip, country, {});
    }
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) return json({ error: 'Send the form as JSON.' }, 415);
    const raw = await req.text();
    if (raw.length > MAX_FORM) return json({ error: 'That is more than the form takes.' }, 413);
    let body: Record<string, unknown>;
    try { const v = JSON.parse(raw) as unknown; if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object'); body = v as Record<string, unknown>; } catch { return json({ error: 'The form could not be read.' }, 400); }
    if (sub === 'register') {
      // the honeypot: a field people never see. A form with it filled is thanked and dropped.
      if (typeof body.website === 'string' && body.website.trim()) return json({ status: 'pending', name: '' });
      if (!(await this.hourly(`wr:${ip}`, REGISTER_PER_HOUR, false))) return json({ error: 'Too many registrations from your network. Try again in an hour.' }, 429);
      if (!(await this.hourly('wr:*', REGISTER_ALL_PER_HOUR, false))) return json({ error: 'Registration is very busy. Try again in a while.' }, 429);
      await this.hourly(`wr:${ip}`, REGISTER_PER_HOUR, true);
      await this.hourly('wr:*', REGISTER_ALL_PER_HOUR, true);
      return this.ask('register', meetingId, ip, country, body);
    }
    if (sub === 'survey-info' || sub === 'answers') {
      if (this.limited(ip, INFO_PER_MINUTE, `wi:${ip}`)) return json({ error: 'Too many requests from your network. Wait a minute.' }, 429);
      if (sub === 'answers' && !(await this.hourly(`ws:${ip}`, SURVEY_PER_HOUR, true))) return json({ error: 'Too many answers from your network. Try again in an hour.' }, 429);
      return this.ask(sub === 'answers' ? 'survey' : 'surveyInfo', meetingId, ip, country, body);
    }
    return json({ error: 'Not found' }, 404);
  }

  /** A browser guest's socket for a meeting (or a webinar's watch page): limited per address, then announced to the hub. */
  private async guest(req: Request, ip: string, meetingId: string, webinar = false): Promise<Response> {
    if (this.limited(ip, GUEST_CONNECTS_PER_MINUTE, `g:${ip}`)) return refuse(4429, 'Too many tries from your network. Wait a minute.');
    if ((await this.guestFails(ip)).length >= GUEST_FAILS) return refuse(4429, 'Too many wrong passcodes from your network. Try again in 10 minutes.');
    const hub = this.hub();
    if (!hub) return refuse(4404, 'The office is not connected to the gateway');
    if (this.ctx.getWebSockets('guest').length >= MAX_GUESTS) return refuse(4429, 'Too many guests are connected. Try again soon.');
    let gid = 0;
    do gid = crypto.getRandomValues(new Uint32Array(1))[0] || 1; while (this.ctx.getWebSockets(`g:${gid}`).length);
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, ['guest', `g:${gid}`]);
    server.serializeAttachment({ kind: 'guest', hubId: (hub.deserializeAttachment() as Attachment).hubId, gid, ip, meetingId, webinar } satisfies Attachment);
    const cf = (req as Request & { cf?: { country?: string } }).cf;
    hub.send(JSON.stringify({ t: 'g-open', g: gid, ip, country: cf?.country ?? null, m: meetingId, ...(webinar ? { k: 'w' } : {}) }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    const a = ws.deserializeAttachment() as Attachment;
    const size = typeof msg === 'string' ? msg.length * 3 : msg.byteLength;
    if (size > MAX_FRAME) { ws.close(1009, 'Message too big'); return; }

    if (a.kind === 'guest') {
      if (typeof msg !== 'string') { ws.close(1003, 'Text frames only'); return; }
      if (msg.length > MAX_GUEST_FRAME) { ws.close(1009, 'Message too big'); return; }
      const now = Date.now();
      const f = this.frames.get(a.gid!) ?? { n: 0, until: now + 10_000 };
      if (f.until < now) { f.n = 0; f.until = now + 10_000; }
      if (++f.n > GUEST_FRAMES_PER_10S) { ws.close(4429, 'Slow down'); return; }
      this.frames.set(a.gid!, f);
      const hub = this.hub();
      if (!hub) { ws.close(4404, 'The office disconnected'); return; }
      hub.send(JSON.stringify({ t: 'g', g: a.gid, d: msg }));
      return;
    }

    if (a.kind === 'device') {
      if (typeof msg === 'string') { ws.close(1003, 'Binary frames only'); return; }
      const hub = this.hub();
      if (!hub) { ws.close(4404, 'The office hub disconnected'); return; }
      const out = new Uint8Array(msg.byteLength + 4);
      out.set(u32(a.sid!), 0);
      out.set(new Uint8Array(msg), 4);
      hub.send(out);
      return;
    }

    if (!a.authed) {
      if (typeof msg !== 'string') { ws.close(4401, 'Authenticate first'); return; }
      await this.authenticate(ws, a, msg);
      return;
    }
    if (typeof msg === 'string') {
      let c: { t?: string; s?: number; g?: number; r?: number; d?: string; code?: number; reason?: string };
      try { c = JSON.parse(msg); } catch { return; }
      if (c.t === 'site') {
        // where the hub's meeting site is: kept with the claim on the meeting pages (only that hub's is taken)
        const u = (c as { url?: unknown }).url;
        await this.env.RELAY.get(this.env.RELAY.idFromName(HOME)).fetch('https://gateway/~home/site', { method: 'POST', body: JSON.stringify({ hubId: a.hubId, url: typeof u === 'string' ? u.slice(0, 200) : null }) });
        return;
      }
      if (c.t === 'w-res' && typeof c.r === 'number' && typeof c.d === 'string') {
        const done = this.answers.get(c.r);
        this.answers.delete(c.r);
        const ct = (c as { ct?: unknown }).ct;
        done?.({ s: Number((c as { s?: unknown }).s) || 502, d: c.d, ...(typeof ct === 'string' ? { ct } : {}) });
        return;
      }
      const code = c.code && c.code >= 4000 && c.code < 5000 ? c.code : 4000;
      if (c.t === 'close' && typeof c.s === 'number') {
        for (const d of this.ctx.getWebSockets(`s:${c.s}`)) d.close(code, (c.reason ?? 'Closed by the hub').slice(0, 120));
      } else if (c.t === 'g' && typeof c.g === 'number' && typeof c.d === 'string') {
        for (const g of this.ctx.getWebSockets(`g:${c.g}`)) g.send(c.d);
      } else if (c.t === 'g-close' && typeof c.g === 'number') {
        for (const g of this.ctx.getWebSockets(`g:${c.g}`)) {
          const ga = g.deserializeAttachment() as Attachment;
          // the hub refused the passcode: it counts against the address
          if (code === 4403 && ga.ip) await this.guestFailed(ga.ip);
          this.frames.delete(c.g);
          g.close(code, (c.reason ?? 'Closed by the office').slice(0, 120));
        }
      }
      return;
    }
    const bytes = new Uint8Array(msg);
    if (bytes.length < 4) return;
    const sid = new DataView(msg).getUint32(0);
    for (const d of this.ctx.getWebSockets(`s:${sid}`)) d.send(bytes.subarray(4));
  }

  private async authenticate(ws: WebSocket, a: Attachment, raw: string): Promise<void> {
    try {
      const m = JSON.parse(raw) as { t: string; cert: string; spki: string; sig: string };
      if (m.t !== 'auth') throw new Error('expected auth');
      const cert = b64d(m.cert);
      const spki = b64d(m.spki);
      const fp = hex(await crypto.subtle.digest('SHA-256', cert));
      if (!contains(cert, spki)) throw new Error('key is not the certificate\'s');
      const key = await crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
      const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64d(m.sig), new TextEncoder().encode(`dexconnect-gw-hub-v1|${a.hubId}|${a.nonce}`));
      if (!ok) throw new Error('bad signature');
      const pinned = this.env.HUB_FINGERPRINT?.trim().toUpperCase() || (await this.ctx.storage.get<string>('fp'));
      if (pinned && pinned !== fp) { ws.close(4403, 'This gateway belongs to another hub'); return; }
      if (!pinned) await this.ctx.storage.put('fp', fp);
      // a reconnecting hub replaces the old connection; devices reconnect to reach it
      for (const old of this.ctx.getWebSockets('hub')) if (old !== ws && (old.deserializeAttachment() as Attachment).authed) old.close(4001, 'Replaced');
      for (const d of this.ctx.getWebSockets('device')) d.close(4404, 'The office hub reconnected');
      for (const g of this.ctx.getWebSockets('guest')) g.close(4404, 'The office reconnected');
      ws.serializeAttachment({ ...a, authed: true, nonce: undefined } satisfies Attachment);
      // meeting pages (/m/…) lead to this hub
      await this.env.RELAY.get(this.env.RELAY.idFromName(HOME)).fetch('https://gateway/~home/claim', { method: 'POST', body: JSON.stringify({ hubId: a.hubId, fp, pinned: !!this.env.HUB_FINGERPRINT }) });
      ws.send(JSON.stringify({ t: 'ready', fp, pinned: !!this.env.HUB_FINGERPRINT }));
    } catch {
      ws.close(4401, 'Authentication failed');
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> { this.gone(ws); }
  async webSocketError(ws: WebSocket): Promise<void> { this.gone(ws); }

  private gone(ws: WebSocket): void {
    const a = ws.deserializeAttachment() as Attachment | null;
    if (!a) return;
    if (a.kind === 'device') {
      this.hub()?.send(JSON.stringify({ t: 'closed', s: a.sid }));
    } else if (a.kind === 'guest') {
      this.frames.delete(a.gid!);
      this.hub()?.send(JSON.stringify({ t: 'g-closed', g: a.gid }));
    } else if (a.authed && !this.ctx.getWebSockets('hub').some((h) => h !== ws && (h.deserializeAttachment() as Attachment).authed)) {
      // (the closing socket is still listed while this runs)
      for (const d of this.ctx.getWebSockets('device')) d.close(4404, 'The office hub disconnected');
      for (const g of this.ctx.getWebSockets('guest')) g.close(4404, 'The office disconnected');
    }
  }
}

/** /join#DXC1-…: a QR code on a colleague's screen leads here; it opens the app with the code. */
function joinPage(): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dexterity Connect</title><style>
:root{color-scheme:light dark;--a:#1c7680}body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f4f6f6;color:#15191b;display:grid;place-items:center;min-height:100vh}
@media(prefers-color-scheme:dark){body{background:#0d1416;color:#e8f2f3}.card{background:#172729!important}}
.card{max-width:420px;margin:16px;padding:28px;border-radius:16px;background:#fff;box-shadow:0 8px 30px rgba(0,0,0,.12)}
h1{font-size:22px;margin:0 0 8px}a.btn,button{display:block;width:100%;box-sizing:border-box;text-align:center;padding:12px;border-radius:10px;border:0;margin-top:12px;font:600 15px system-ui;cursor:pointer;text-decoration:none}
a.btn{background:var(--a);color:#fff}button{background:transparent;color:inherit;border:1px solid rgba(127,127,127,.4)}code{word-break:break-all;font-size:12px;opacity:.75}
</style></head><body><div class="card"><h1>Join Dexterity Connect</h1>
<p>Install Dexterity Connect, then open it with this code. Your office administrator approves the new device before it can see anything.</p>
<a class="btn" id="open" href="#">Open Dexterity Connect</a><button id="copy">Copy the setup code</button>
<p><a href="https://github.com/dexterity-admin/dexterity-connect/releases/latest" rel="noreferrer">Download the app</a></p>
<p><code id="code"></code></p></div>
<script>
const code=(location.hash.slice(1).match(/DXC1-[A-Za-z0-9_-]+/)||[''])[0];
document.getElementById('code').textContent=code||'No setup code in this link.';
document.getElementById('open').href='dexconnect://remote?code='+encodeURIComponent(code);
document.getElementById('copy').onclick=()=>navigator.clipboard.writeText(code).then(()=>{document.getElementById('copy').textContent='Copied'});
</script></body></html>`;
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS,
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}

// ---------------------------------------------------------------- the meeting site's pages
const decoded = new Map<string, Uint8Array>();
/** A script, style, font or the mark, named after its content: cached for a year, on any address. */
function siteAsset(name: string, req: Request): Response {
  const f = SITE_FILES[name];
  if (!f) return text('Not found\n', 404);
  if (req.method !== 'GET' && req.method !== 'HEAD') return text('Method not allowed\n', 405);
  let body: string | Uint8Array | undefined = f.text;
  if (body === undefined) {
    body = decoded.get(name);
    if (!body) { body = Uint8Array.from(atob(f.b64 ?? ''), (c) => c.charCodeAt(0)); decoded.set(name, body); }
  }
  return new Response(req.method === 'HEAD' ? null : body, { headers: { 'content-type': f.type, ...SECURITY_HEADERS, 'cache-control': 'public, max-age=31536000, immutable' } });
}

/**
 * The headers of every page on the meeting site: no inline code, nothing from anywhere else,
 * requests and the socket only to this address, never in a frame, no referrer, camera and
 * microphone for this page only (none for webinar pages, which only watch).
 */
function pageHeaders(url: URL, media: boolean): Record<string, string> {
  const ws = `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}`;
  return {
    'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS,
    'content-security-policy': `default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; connect-src 'self' ${ws}; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    'permissions-policy': media
      ? 'camera=(self), microphone=(self), display-capture=(self), fullscreen=(self), autoplay=(self), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()'
      : 'camera=(), microphone=(), display-capture=(), fullscreen=(self), autoplay=(self), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()',
    'cross-origin-opener-policy': 'same-origin',
  };
}

const A = (name: string) => `/assets/${name}`;
const outfit = Object.keys(SITE_FILES).find((n) => n.startsWith('outfit-')) ?? '';

/**
 * /<meeting ID or name> (and / for the site's front page): the same small shell for every
 * meeting. It holds no meeting data at all: the page asks for what it may show.
 */
function landingPage(ref: string, url: URL): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer"><meta name="format-detection" content="telephone=no">
<meta name="theme-color" content="#eef3f3" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0e1b1d" media="(prefers-color-scheme: dark)">
<title>Dexterity Meet</title><meta name="description" content="A meeting with Dexterity Design Services. Join from your browser.">
<link rel="icon" href="${A(SITE_NAMES.mark)}" type="image/svg+xml">${outfit ? `<link rel="preload" href="${A(outfit)}" as="font" type="font/woff2" crossorigin>` : ''}
<link rel="stylesheet" href="${A(SITE_NAMES.landingCss)}"></head>
<body><div id="app" data-ref="${ref}" data-mark="${A(SITE_NAMES.mark)}" data-room-js="${A(SITE_NAMES.roomJs)}" data-room-css="${A(SITE_NAMES.roomCss)}"><noscript>This meeting page needs JavaScript. Switch it on for this site, or join from the Dexterity Connect app.</noscript></div><script src="${A(SITE_NAMES.landingJs)}" defer></script></body></html>`;
  return new Response(html, { headers: pageHeaders(url, true) });
}

/**
 * /w/<ID or name> (register), /w/<…>/watch#<token> and /w/<…>/survey#<token>: one page with
 * three sheets. The token stays in the fragment; the page sends it to the hub itself.
 */
function webinarPage(ref: string, mode: 'register' | 'watch' | 'survey', url: URL): Response {
  const id = /^\d{9}$/.test(ref) ? refSegment(ref) : ref;
  const what = mode === 'watch' ? 'Watch' : mode === 'survey' ? 'Survey' : 'Register';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer">
<title>${what} · Webinar ${id} · Dexterity Meet</title><link rel="icon" href="${A(SITE_NAMES.mark)}" type="image/svg+xml">
<link rel="stylesheet" href="${A(SITE_NAMES.webinarCss)}"></head>
<body><main id="app" data-webinar="${ref}" data-mode="${mode}"><noscript>This page needs JavaScript.</noscript></main><script src="${A(SITE_NAMES.webinarJs)}" defer></script></body></html>`;
  return new Response(html, { headers: pageHeaders(url, false) });
}

/** The hub's answer to a page, with only the fields a page may have (anything else is dropped here). */
async function only(res: Response, fields: string[]): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = await res.json() as Record<string, unknown>; } catch { return json({ error: 'The office answered with something unexpected.' }, 502); }
  const out: Record<string, unknown> = {};
  for (const k of fields) if (k in body) out[k] = body[k];
  if (out.next && typeof out.next === 'object') { const n = out.next as Record<string, unknown>; out.next = { startAt: n.startAt, endAt: n.endAt }; }
  if (typeof out.followUp === 'string') out.followUp = out.followUp.slice(0, 280);
  return json(out, res.status);
}
