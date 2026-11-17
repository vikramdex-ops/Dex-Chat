// A stand-in for Zoho (accounts and Calendar API) for tests: never the real Zoho, no real
// credentials. It answers the endpoints the hub relies on (docs/ZOHO-CALENDAR.md) in several
// "data centres" on local ports, and can be told to misbehave: a busy server, an expired access
// token, a revoked refresh token, an edit or deletion made in Zoho, a stale etag.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import crypto from 'node:crypto';

export interface MockEvent {
  uid: string;
  calendar: string;
  owner: string;
  etag: string;
  title: string;
  dateandtime: { timezone: string; start: string; end: string };
  isallday: boolean;
  description?: string;
  location?: string;
  rrule?: string;
  transparency?: number;
  lastmodifiedtime: string;
}

interface MockUser { email: string; dc: string; calendars: Array<{ uid: string; name: string; isdefault: boolean; privilege: string }> }
interface Grant { email: string; dc: string; revoked: boolean }

export class ZohoMock {
  readonly clientId = 'mock.1000.CLIENTID';
  readonly clientSecret = 'mock-secret-not-real';
  /** The redirect address registered for the mock client (set by the test). */
  redirectUri = 'http://127.0.0.1:47917/zoho/callback';
  /** The person who "signs in" when the app opens the sign-in page. */
  signIn: string | null = null;
  /** Answer the sign-in page with access_denied. */
  deny = false;
  /** Leave accounts-server out of the redirect (only location). */
  omitAccountsServer = false;
  readonly users = new Map<string, MockUser>();
  readonly events = new Map<string, MockEvent>();
  readonly log: Array<{ dc: string; method: string; path: string; status: number }> = [];
  refreshes = 0;
  revokes = 0;
  private servers = new Map<string, { server: http.Server; base: string }>();
  private codes = new Map<string, { email: string; dc: string; redirect: string; at: number }>();
  private refreshTokens = new Map<string, Grant>();
  private accessTokens = new Map<string, { email: string; dc: string; expires: number }>();
  private failures: number[] = [];
  private seq = 1700000000000;

  async start(dcs: string[] = ['in', 'com']): Promise<this> {
    for (const dc of dcs) {
      const server = http.createServer((req, res) => { void this.route(dc, req, res); });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      this.servers.set(dc, { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    }
    return this;
  }

  async stop(): Promise<void> {
    for (const { server } of this.servers.values()) { server.closeAllConnections(); await new Promise((r) => server.close(() => r(null))); }
  }

  /** The table the hub uses in place of Zoho's real data centres. */
  dcs(): Record<string, { label: string; accounts: string; calendar: string }> {
    const out: Record<string, { label: string; accounts: string; calendar: string }> = {};
    for (const [dc, { base }] of this.servers) out[dc] = { label: `Mock ${dc}`, accounts: base, calendar: base };
    return out;
  }
  base(dc: string): string { return this.servers.get(dc)!.base; }

  addUser(email: string, dc = 'in', calendars = [{ uid: `cal-${email}==`, name: 'My Calendar', isdefault: true, privilege: 'owner' }, { uid: `work-${email}==`, name: 'Work', isdefault: false, privilege: 'owner' }]): void {
    this.users.set(email, { email, dc, calendars });
  }

  /** Every access token stops working (they expired). */
  expireAccess(): void { for (const t of this.accessTokens.values()) t.expires = 0; }
  /** The person revoked the app in Zoho (refresh tokens stop working). */
  revokeAll(email: string): void { for (const g of this.refreshTokens.values()) if (g.email === email) g.revoked = true; for (const [k, t] of this.accessTokens) if (t.email === email) this.accessTokens.delete(k); }
  /** The next Calendar API calls answer with these statuses (429, 503…). */
  failNext(...statuses: number[]): void { this.failures.push(...statuses); }

  eventsOf(email: string, calendar?: string): MockEvent[] { return [...this.events.values()].filter((e) => e.owner === email && (!calendar || e.calendar === calendar)); }
  /** A change made by the person in Zoho's own calendar. */
  editInZoho(uid: string, patch: Partial<Pick<MockEvent, 'title' | 'dateandtime'>>): void {
    const e = this.events.get(uid)!;
    Object.assign(e, patch, { etag: String(++this.seq) });
  }
  deleteInZoho(uid: string): void { this.events.delete(uid); }
  /** An appointment made in Zoho (Zoho Mail invitation, a client call…). */
  addZohoEvent(email: string, ev: { title: string; start: string; end: string; timezone?: string; isallday?: boolean; transparency?: number; calendar?: string }): MockEvent {
    const u = this.users.get(email)!;
    const e: MockEvent = {
      uid: `${crypto.randomBytes(8).toString('hex')}@zoho.com`, calendar: ev.calendar ?? u.calendars.find((c) => c.isdefault)!.uid, owner: email, etag: String(++this.seq),
      title: ev.title, dateandtime: { timezone: ev.timezone ?? 'Asia/Kolkata', start: ev.start, end: ev.end }, isallday: !!ev.isallday, transparency: ev.transparency ?? 0,
      lastmodifiedtime: '20261117T000000Z',
    };
    this.events.set(e.uid, e);
    return e;
  }
  count(method: string, pathRe: RegExp): number { return this.log.filter((l) => l.method === method && pathRe.test(l.path)).length; }

  // ------------------------------------------------------------ routes
  private async route(dc: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    let body = '';
    for await (const c of req) body += c;
    const send = (status: number, data: unknown, headers: Record<string, string> = {}) => {
      this.log.push({ dc, method: req.method ?? '', path: url.pathname, status });
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(typeof data === 'string' ? data : JSON.stringify(data));
    };
    const form = new URLSearchParams(body);
    const p = url.pathname;

    // ---- accounts
    if (p === '/oauth/v2/auth' && req.method === 'GET') {
      const q = url.searchParams;
      if (q.get('client_id') !== this.clientId) return send(400, { error: 'invalid_client' });
      if (q.get('redirect_uri') !== this.redirectUri) return send(400, 'Invalid Redirect Uri');
      if (q.get('response_type') !== 'code' || q.get('access_type') !== 'offline' || q.get('prompt') !== 'consent') return send(400, { error: 'bad request' });
      const back = new URL(this.redirectUri);
      const state = q.get('state');
      if (state) back.searchParams.set('state', state);
      const user = this.signIn ? this.users.get(this.signIn) : undefined;
      if (this.deny || !user) back.searchParams.set('error', 'access_denied');
      else {
        const code = `1000.${crypto.randomBytes(16).toString('hex')}`;
        this.codes.set(code, { email: user.email, dc: user.dc, redirect: q.get('redirect_uri')!, at: Date.now() });
        back.searchParams.set('code', code);
        back.searchParams.set('location', user.dc === 'com' ? 'us' : user.dc);
        if (!this.omitAccountsServer) back.searchParams.set('accounts-server', this.base(user.dc));
      }
      return send(302, '', { location: back.toString() });
    }
    if (p === '/oauth/v2/token' && req.method === 'POST') {
      const f = (k: string) => form.get(k) ?? url.searchParams.get(k);
      if (f('client_id') !== this.clientId) return send(200, { error: 'invalid_client' });
      if (f('client_secret') !== this.clientSecret) return send(200, { error: 'invalid_client_secret' });
      if (f('grant_type') === 'authorization_code') {
        const c = this.codes.get(f('code') ?? '');
        // a code is good once, for two minutes, at its own data centre only
        if (!c || c.dc !== dc || Date.now() - c.at > 120_000) return send(200, { error: 'invalid_code' });
        this.codes.delete(f('code')!);
        if (f('redirect_uri') !== c.redirect) return send(200, { error: 'invalid_redirect_uri' });
        const refresh = `1000.r${crypto.randomBytes(16).toString('hex')}`;
        this.refreshTokens.set(refresh, { email: c.email, dc, revoked: false });
        return send(200, { access_token: this.issue(c.email, dc), refresh_token: refresh, api_domain: this.base(dc), token_type: 'Bearer', expires_in: 3600 });
      }
      if (f('grant_type') === 'refresh_token') {
        this.refreshes++;
        const g = this.refreshTokens.get(f('refresh_token') ?? '');
        if (!g || g.revoked || g.dc !== dc) return send(200, { error: 'invalid_code' });
        return send(200, { access_token: this.issue(g.email, dc), api_domain: this.base(dc), token_type: 'Bearer', expires_in: 3600 });
      }
      return send(400, { error: 'unsupported_grant_type' });
    }
    if (p === '/oauth/v2/revoke/token' && req.method === 'POST') {
      this.revokes++;
      const g = this.refreshTokens.get(form.get('token') ?? '');
      if (!g) return send(400, { error: 'invalid token' });
      g.revoked = true;
      return send(200, { status: 'success' });
    }

    // ---- everything else needs an access token from this data centre
    const auth = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
    const tok = auth ? this.accessTokens.get(auth) : undefined;
    if (!tok || tok.expires < Date.now() || tok.dc !== dc) return send(401, { error: { code: 'INVALID_OAUTHTOKEN', message: 'Invalid OAuth token' } });
    if (p === '/oauth/user/info') return send(200, { Email: tok.email, ZUID: 12345, Display_Name: tok.email.split('@')[0] });
    const fail = this.failures.shift();
    if (fail) return send(fail, { error: 'busy' }, fail === 429 ? { 'retry-after': '1' } : {});
    const user = this.users.get(tok.email)!;
    if (p === '/api/v1/calendars' && req.method === 'GET') return send(200, { calendars: user.calendars.map((c) => ({ ...c, color: '#1c7680' })) });
    const m = /^\/api\/v1\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(p);
    if (!m) return send(404, { error: 'not found' });
    const cal = decodeURIComponent(m[1]);
    if (!user.calendars.some((c) => c.uid === cal)) return send(404, { error: 'no such calendar' });
    const uid = m[2] ? decodeURIComponent(m[2]) : null;
    const data = url.searchParams.get('eventdata') ? JSON.parse(url.searchParams.get('eventdata')!) as Record<string, unknown> : null;
    const view = (e: MockEvent) => ({ uid: e.uid, etag: Number(e.etag), title: e.title, dateandtime: e.dateandtime, isallday: e.isallday, description: e.description, location: e.location, rrule: e.rrule, transparency: e.transparency, lastmodifiedtime: e.lastmodifiedtime, caluid: e.calendar });
    if (!uid && req.method === 'POST') {
      if (!data || !data.title || !data.dateandtime) return send(400, { error: 'eventdata missing' });
      const e: MockEvent = { uid: `${crypto.randomBytes(12).toString('hex')}@zoho.com`, calendar: cal, owner: tok.email, etag: String(++this.seq), lastmodifiedtime: '20261117T000000Z', ...this.pick(data) };
      this.events.set(e.uid, e);
      return send(200, { events: [view(e)] });
    }
    if (!uid && req.method === 'GET') {
      const range = JSON.parse(url.searchParams.get('range') ?? 'null') as { start: string; end: string } | null;
      if (!range) return send(400, { error: 'range missing' });
      const from = toMs(range.start); const to = toMs(range.end);
      if (to - from > 31 * 86_400_000) return send(400, { error: 'range exceeds 31 days' });
      const list = this.eventsOf(tok.email, cal).filter((e) => e.rrule ? toMs(e.dateandtime.start) < to : toMs(e.dateandtime.start) < to && toMs(e.dateandtime.end) > from);
      return send(200, { events: list.map(view) });
    }
    const e = uid ? this.events.get(uid) : undefined;
    if (!e || e.calendar !== cal || e.owner !== tok.email) return send(404, { error: { code: 'NOT_FOUND' } });
    const etag = String(req.headers.etag ?? (data?.etag as string | undefined) ?? '');
    if (req.method === 'GET') return send(200, { events: [view(e)] });
    if (req.method === 'PUT') {
      if (!data) return send(400, { error: 'eventdata missing' });
      if (etag !== e.etag) return send(400, { error: [{ code: 'ETAG_MISMATCH', message: 'etag does not match' }] });
      Object.assign(e, this.pick(data), { etag: String(++this.seq) });
      if (!data.rrule) delete e.rrule;
      return send(200, { events: [view(e)] });
    }
    if (req.method === 'DELETE') {
      if (etag !== e.etag) return send(400, { error: [{ code: 'ETAG_MISMATCH', message: 'etag does not match' }] });
      this.events.delete(e.uid);
      return send(200, { events: [{ uid: e.uid, caluid: cal, estatus: 'deleted' }] });
    }
    return send(405, { error: 'method' });
  }

  private pick(d: Record<string, unknown>): Pick<MockEvent, 'title' | 'dateandtime' | 'isallday' | 'description' | 'location' | 'rrule' | 'transparency'> {
    return {
      title: String(d.title), dateandtime: d.dateandtime as MockEvent['dateandtime'], isallday: d.isallday === true,
      description: d.description as string | undefined, location: d.location as string | undefined, rrule: d.rrule as string | undefined, transparency: d.transparency as number | undefined,
    };
  }

  private issue(email: string, dc: string): string {
    const t = `1000.a${crypto.randomBytes(16).toString('hex')}`;
    this.accessTokens.set(t, { email, dc, expires: Date.now() + 3600_000 });
    return t;
  }
}

/** yyyyMMdd, yyyyMMddTHHmmssZ or with an offset, to milliseconds (dates as UTC midnight: enough for the mock). */
function toMs(s: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z|[+-]\d{4})?)?$/.exec(s);
  if (!m) return NaN;
  const base = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  if (!m[7] || m[7] === 'Z') return base;
  const sign = m[7][0] === '-' ? -1 : 1;
  return base - sign * (Number(m[7].slice(1, 3)) * 60 + Number(m[7].slice(3))) * 60_000;
}
