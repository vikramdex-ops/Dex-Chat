// Zoho Calendar sync (docs/ZOHO-CALENDAR.md). The office registers one Zoho OAuth client in the
// Control room; each person connects their own Zoho account once (Preferences → Calendar). The
// hub keeps their refresh token, sealed with a key file beside the database, so syncing goes on
// while their PC is off.
//
// Dexterity → Zoho: every meeting a person organises or said "Going" to is copied into the Zoho
// calendar they chose (one event, with Zoho's repeat rule where it gives the same days, else one
// event per time), changed when the meeting changes, and removed when it is cancelled, declined or
// they are taken off it. A table maps each meeting (or each time of it) to Zoho's uid and etag, so
// a restart or a retry never makes a second copy. Dexterity is the source of truth for its own
// meetings: an edit made in Zoho is put back, and a copy deleted in Zoho is made again.
//
// Zoho → Dexterity: the person's Zoho events for the next month are read every ten minutes and
// shown read-only in their Calendar as busy time (free/busy, "in a meeting", Nib), never as meetings.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ZOHO_CALLBACK_PORT, ZOHO_DCS, ZOHO_DEFAULT_DC, ZOHO_SCOPES, parseZohoTime, zohoDay, zohoDcFromLocation, zohoRedirectUri, zohoRrule, zohoUtc } from '@dex/core/zoho';
import type { ZohoAdminView, ZohoCalendarChoice, ZohoCallback, ZohoDc, ZohoDcInfo, ZohoState, ZohoStatus } from '@dex/core/zoho';
import type { PublicUser, Recurrence } from '@dex/core';
import { expand } from './calendar.ts';
import type { ExternalBlock } from './calendar.ts';

export class ZohoError extends Error {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS zoho_accounts (
  user_id TEXT PRIMARY KEY,
  dc TEXT NOT NULL,
  accounts_url TEXT NOT NULL,
  api_url TEXT NOT NULL,
  refresh_token TEXT,
  access_token TEXT,
  access_expires INTEGER NOT NULL DEFAULT 0,
  email TEXT,
  calendar_uid TEXT,
  calendar_name TEXT,
  calendars TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'connected',
  connected_at INTEGER NOT NULL,
  last_sync_at INTEGER,
  last_pull_at INTEGER,
  last_error TEXT,
  last_error_at INTEGER,
  fails INTEGER NOT NULL DEFAULT 0,
  next_try_at INTEGER NOT NULL DEFAULT 0,
  due INTEGER NOT NULL DEFAULT 1,
  told_reconnect INTEGER NOT NULL DEFAULT 0,
  pushed INTEGER NOT NULL DEFAULT 0,
  imported INTEGER NOT NULL DEFAULT 0,
  restored INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS zoho_map (
  user_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  occ_start INTEGER NOT NULL,
  zoho_uid TEXT,
  calendar_uid TEXT NOT NULL,
  etag TEXT,
  hash TEXT,
  stale INTEGER NOT NULL DEFAULT 0,
  told INTEGER NOT NULL DEFAULT 0,
  failed_hash TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, event_id, occ_start)
);
CREATE INDEX IF NOT EXISTS idx_zoho_map_event ON zoho_map(event_id);
CREATE TABLE IF NOT EXISTS zoho_external (
  user_id TEXT NOT NULL,
  zoho_uid TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  calendar TEXT,
  PRIMARY KEY (user_id, zoho_uid, start_at)
);
CREATE INDEX IF NOT EXISTS idx_zoho_external_user ON zoho_external(user_id, start_at);
CREATE TABLE IF NOT EXISTS zoho_auth (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

const MIN = 60_000;
const DAY = 86_400_000;
/** Zoho events are read this often for each person (and after "Sync now"). */
export const PULL_EVERY = 10 * MIN;
/** Zoho reads at most 31 days at a time; the hub reads yesterday and the next four weeks. */
const PULL_BACK = DAY;
const PULL_AHEAD = 29 * DAY;
/** Times of a repeat that Zoho's rule cannot express are written one by one, this far ahead. */
const EXPAND_AHEAD = 90 * DAY;
const EXPAND_MAX = 60;
/** Writes to Zoho in one run for one person; the rest follow in the next run (rate limits). */
const WRITES_PER_RUN = 40;
/** Meetings looked at for one person. */
const MAX_EVENTS = 500;
const MAX_EXTERNAL = 500;
/** A sign-in started in Preferences must come back within this time. */
const AUTH_TTL = 10 * MIN;
const STATE_RE = /^[A-Za-z0-9_-]{43}$/;

export interface ZohoTestOptions {
  /** Data centres replaced by local addresses (tests and the mock server only). */
  dcs?: Partial<Record<ZohoDc, ZohoDcInfo>>;
  /** The loopback port in the redirect address. */
  callbackPort?: number;
  /** First retry delay after a busy or failing Zoho (doubles each time). */
  retryDelayMs?: number;
  /** Debounce before a changed meeting is copied (ms). */
  kickMs?: number;
}

export interface ZohoHost {
  db: DatabaseSync;
  dataDir: string;
  meta: (key: string) => string;
  setMeta: (key: string, value: string) => void;
  userById: (id: string) => PublicUser | null;
  activeUsers: () => PublicUser[];
  /** Can this person still use the office (not offboarded)? */
  active: (userId: string) => boolean;
  /** The meeting's title, description, place and link as the private calendar feed has them (no passcode). */
  details: (user: PublicUser, eventId: string) => { title: string; description: string | null; location: string | null } | null;
  /** The zone the hub counts repeats in (the office's own). */
  zone: () => string;
  deliver: (userIds: string[], name: string, data: unknown) => void;
  toAdmins: (name: string, data: unknown) => void;
  tell: (userId: string, text: string, key: string) => void;
  audit: (actor: string | null, action: string, target: string | null, detail?: unknown) => void;
  log: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
  test?: ZohoTestOptions;
}

interface AccountRow {
  user_id: string; dc: ZohoDc; accounts_url: string; api_url: string; refresh_token: string | null; access_token: string | null; access_expires: number;
  email: string | null; calendar_uid: string | null; calendar_name: string | null; calendars: string; state: 'connected' | 'reconnect'; connected_at: number;
  last_sync_at: number | null; last_pull_at: number | null; last_error: string | null; last_error_at: number | null; fails: number; next_try_at: number; due: number;
  told_reconnect: number; pushed: number; imported: number; restored: number;
}
interface MapRow { user_id: string; event_id: string; occ_start: number; zoho_uid: string | null; calendar_uid: string; etag: string | null; hash: string | null; stale: number; told: number; failed_hash: string | null }
interface EventRow {
  id: string; title: string; start_at: number; end_at: number; all_day: number; organizer_id: string; recurrence: Recurrence; until_at: number | null;
  cancelled: number; time_zone: string | null;
}

/** What went wrong talking to Zoho, sorted by what to do about it. */
export class ZohoApiError extends Error {
  readonly kind: 'auth' | 'revoked' | 'client' | 'conflict' | 'notfound' | 'busy' | 'bad';
  readonly status: number;
  constructor(kind: ZohoApiError['kind'], status: number, message: string) { super(message); this.kind = kind; this.status = status; }
}

/** Words for a person or an administrator; never the contents of an event. */
function words(err: unknown): string {
  if (err instanceof ZohoApiError) {
    switch (err.kind) {
      case 'revoked': return 'Zoho no longer accepts this connection (it was revoked, or the password changed). Reconnect to sync again.';
      case 'client': return 'Zoho did not accept the office\'s Zoho client. An administrator should check it in the Control room.';
      case 'busy': return `Zoho was busy or could not be reached (${err.status || 'no answer'}). Trying again shortly.`;
      case 'auth': return 'Zoho refused the sign-in. Reconnect to sync again.';
      default: return `Zoho refused a change (${err.status || err.kind}).`;
    }
  }
  return 'Zoho could not be reached. Trying again shortly.';
}

export class ZohoSync {
  private readonly h: ZohoHost;
  private key: Buffer | null = null;
  private running: Promise<void> | null = null;
  private kickTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(host: ZohoHost) {
    this.h = host;
    host.db.exec(SCHEMA);
  }

  stop(): void {
    this.stopped = true;
    if (this.kickTimer) clearTimeout(this.kickTimer);
    this.kickTimer = null;
  }

  // ------------------------------------------------------------ configuration
  private dcs(): Record<ZohoDc, ZohoDcInfo> {
    return { ...ZOHO_DCS, ...(this.h.test?.dcs ?? {}) } as Record<ZohoDc, ZohoDcInfo>;
  }
  private config() {
    const dc = (this.h.meta('zoho_dc') || ZOHO_DEFAULT_DC) as ZohoDc;
    return {
      dc: dc in ZOHO_DCS ? dc : ZOHO_DEFAULT_DC,
      clientId: this.h.meta('zoho_client_id') || null,
      secret: this.unseal(this.h.meta('zoho_client_secret')),
      enabled: this.h.meta('zoho_enabled') !== '0',
    };
  }
  /** Zoho is set up and switched on for the office. */
  available(): boolean {
    const c = this.config();
    return !!(c.clientId && c.secret && c.enabled);
  }
  redirectUri(): string { return zohoRedirectUri(this.h.test?.callbackPort ?? ZOHO_CALLBACK_PORT); }

  // tokens and the client secret are sealed with a key kept beside the database, not in it,
  // so a copy of the database alone does not carry them
  private sealKey(): Buffer {
    if (this.key) return this.key;
    const file = path.join(this.h.dataDir, 'zoho.key');
    try {
      const k = fs.readFileSync(file);
      if (k.length === 32) { this.key = k; return k; }
    } catch { /* first use */ }
    const k = crypto.randomBytes(32);
    fs.writeFileSync(file, k, { mode: 0o600 });
    this.key = k;
    return k;
  }
  private seal(text: string): string {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.sealKey(), iv);
    const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return `v1.${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')}`;
  }
  private unseal(sealed: string | null | undefined): string | null {
    if (!sealed || !sealed.startsWith('v1.')) return null;
    try {
      const raw = Buffer.from(sealed.slice(3), 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', this.sealKey(), raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    } catch { return null; }
  }

  adminView(): ZohoAdminView {
    const c = this.config();
    const rows = this.h.db.prepare('SELECT * FROM zoho_accounts ORDER BY connected_at').all() as unknown as AccountRow[];
    return {
      configured: !!(c.clientId && c.secret), enabled: c.enabled, dc: c.dc, clientId: c.clientId, hasSecret: !!c.secret,
      redirectUri: this.redirectUri(), scopes: ZOHO_SCOPES,
      people: rows.map((r) => ({
        userId: r.user_id, state: this.stateOf(r), email: r.email, calendarName: r.calendar_name, connectedAt: r.connected_at,
        lastSyncAt: r.last_sync_at, lastError: r.last_error, lastErrorAt: r.last_error_at, pushed: r.pushed, imported: r.imported,
      })),
    };
  }

  private configure(me: PublicUser, d: Record<string, unknown>): ZohoAdminView {
    const before = this.config();
    const wasReady = this.available();
    if (d.dc !== undefined) {
      if (typeof d.dc !== 'string' || !(d.dc in ZOHO_DCS)) throw new ZohoError('Choose the Zoho data centre from the list.');
      this.h.setMeta('zoho_dc', d.dc);
    }
    if (d.clientId !== undefined) {
      const id = d.clientId === null ? '' : String(d.clientId).trim();
      if (id && !/^[\w.-]{6,120}$/.test(id)) throw new ZohoError('The client ID is the "1000.…" value from Zoho\'s API console.');
      this.h.setMeta('zoho_client_id', id);
    }
    if (d.clientSecret === null) this.h.setMeta('zoho_client_secret', '');
    else if (typeof d.clientSecret === 'string' && d.clientSecret.trim()) {
      const s = d.clientSecret.trim();
      if (s.length > 200 || /\s/.test(s)) throw new ZohoError('That does not look like a Zoho client secret.');
      this.h.setMeta('zoho_client_secret', this.seal(s));
    }
    if (typeof d.enabled === 'boolean') this.h.setMeta('zoho_enabled', d.enabled ? '1' : '0');
    const after = this.config();
    // tokens belong to the client that issued them: a different client means everyone connects again
    if (before.clientId && after.clientId !== before.clientId) {
      this.h.db.prepare(`UPDATE zoho_accounts SET state = 'reconnect', refresh_token = NULL, access_token = NULL, last_error = ?, last_error_at = ?`)
        .run('The office changed its Zoho client. Reconnect to sync again.', Date.now());
      for (const r of this.h.db.prepare('SELECT user_id FROM zoho_accounts').all() as Array<{ user_id: string }>) this.emitStatus(r.user_id);
    }
    this.h.audit(me.id, 'zoho.set', null, { dc: after.dc, clientId: after.clientId, secret: after.secret ? 'saved' : 'none', enabled: after.enabled });
    // the first time Zoho is ready, everyone hears once how to connect
    if (!wasReady && this.available() && this.h.meta('zoho_nudged') !== '1') {
      this.h.setMeta('zoho_nudged', '1');
      for (const u of this.h.activeUsers()) {
        if (u.role === 'guest' || u.role === 'bot') continue;
        if (this.account(u.id)) continue;
        this.h.tell(u.id, 'Your office now works with **Zoho Calendar**. Connect yours once in **Preferences → Calendar → Connect Zoho Calendar**: your Dexterity Connect meetings then appear in Zoho, and your Zoho appointments show here as busy time.', 'zoho-invite');
      }
    }
    if (wasReady !== this.available()) for (const u of this.h.activeUsers()) this.emitStatus(u.id);
    const view = this.adminView();
    this.h.toAdmins('admin.zoho', view);
    return view;
  }

  // ------------------------------------------------------------ one person's status
  private account(userId: string): AccountRow | undefined {
    return this.h.db.prepare('SELECT * FROM zoho_accounts WHERE user_id = ?').get(userId) as AccountRow | undefined;
  }
  private stateOf(r: AccountRow | undefined): ZohoState {
    if (!this.available()) return 'off';
    if (!r) return 'not-connected';
    return r.state === 'reconnect' || !r.refresh_token ? 'reconnect' : 'connected';
  }
  status(userId: string): ZohoStatus {
    const r = this.account(userId);
    let calendars: ZohoCalendarChoice[] = [];
    try { calendars = JSON.parse(r?.calendars ?? '[]') as ZohoCalendarChoice[]; } catch { /* none */ }
    return {
      available: this.available(), state: this.stateOf(r), email: r?.email ?? null, calendarUid: r?.calendar_uid ?? null, calendarName: r?.calendar_name ?? null,
      calendars, connectedAt: r?.connected_at ?? null, lastSyncAt: r?.last_sync_at ?? null, lastPullAt: r?.last_pull_at ?? null,
      lastError: r?.last_error ?? null, lastErrorAt: r?.last_error_at ?? null, pushed: r?.pushed ?? 0, imported: r?.imported ?? 0, restored: r?.restored ?? 0,
    };
  }
  private emitStatus(userId: string): void {
    this.h.deliver([userId], 'zoho.status', this.status(userId));
  }
  private emitAll(userId: string): void {
    this.emitStatus(userId);
    this.h.toAdmins('admin.zoho', this.adminView());
  }

  // ------------------------------------------------------------ operations
  async handle(op: string, me: PublicUser, d: Record<string, unknown>): Promise<unknown> {
    const isAdmin = me.role === 'owner' || me.role === 'admin';
    if (op.startsWith('admin.zoho.')) {
      if (!isAdmin) throw new ZohoError('Only administrators can do that.');
      if (op === 'admin.zoho.get') return this.adminView();
      if (op === 'admin.zoho.set') return this.configure(me, d);
      return undefined;
    }
    if (me.role === 'guest' || me.role === 'bot') throw new ZohoError('Zoho Calendar is for members of the office.');
    switch (op) {
      case 'zoho.status': return this.status(me.id);
      case 'zoho.connect.start': return this.start(me);
      case 'zoho.connect.finish': return await this.finish(me, d as unknown as ZohoCallback);
      case 'zoho.disconnect': await this.disconnect(me.id, true); this.h.audit(me.id, 'zoho.disconnect', me.id); return this.status(me.id);
      case 'zoho.calendar.set': {
        const r = this.account(me.id);
        if (!r) throw new ZohoError('Connect Zoho Calendar first.');
        const list = JSON.parse(r.calendars) as ZohoCalendarChoice[];
        const pick = list.find((c) => c.uid === d.calendarUid);
        if (!pick) throw new ZohoError('That Zoho calendar is not in your list. Sync again to refresh it.');
        if (pick.uid !== r.calendar_uid) {
          // copies made in the old calendar are removed there and made again in the new one
          await this.withLock(() => this.removeCopies(r, false));
          this.h.db.prepare('UPDATE zoho_accounts SET calendar_uid = ?, calendar_name = ?, due = 1 WHERE user_id = ?').run(pick.uid, pick.name, me.id);
          this.h.db.prepare('DELETE FROM zoho_external WHERE user_id = ?').run(me.id);
          this.h.db.prepare('UPDATE zoho_accounts SET last_pull_at = NULL WHERE user_id = ?').run(me.id);
          this.kick();
        }
        this.emitAll(me.id);
        return this.status(me.id);
      }
      case 'zoho.syncNow': {
        const r = this.account(me.id);
        if (!r) throw new ZohoError('Connect Zoho Calendar first.');
        if (this.stateOf(r) === 'reconnect') throw new ZohoError('Reconnect Zoho Calendar first.');
        this.h.db.prepare('UPDATE zoho_accounts SET due = 1, next_try_at = 0, last_pull_at = NULL WHERE user_id = ?').run(me.id);
        await this.runNow(me.id);
        return this.status(me.id);
      }
    }
    return undefined;
  }

  private start(me: PublicUser): { authUrl: string; state: string; redirectUri: string } {
    const c = this.config();
    if (!this.available() || !c.clientId) throw new ZohoError('Your office has not set up Zoho Calendar yet. Ask an administrator (Control room → Integrations).');
    const now = Date.now();
    this.h.db.prepare('DELETE FROM zoho_auth WHERE created_at < ? OR user_id = ?').run(now - AUTH_TTL, me.id);
    const state = crypto.randomBytes(32).toString('base64url');
    this.h.db.prepare('INSERT INTO zoho_auth (state, user_id, created_at) VALUES (?, ?, ?)').run(state, me.id, now);
    const q = new URLSearchParams({
      scope: ZOHO_SCOPES.join(','), client_id: c.clientId, response_type: 'code', access_type: 'offline', prompt: 'consent',
      redirect_uri: this.redirectUri(), state,
    });
    return { authUrl: `${this.dcs()[c.dc].accounts}/oauth/v2/auth?${q}`, state, redirectUri: this.redirectUri() };
  }

  /** The accounts server to trust: only a known Zoho one (never an address from the redirect as such). */
  private accountsFor(cb: ZohoCallback): { dc: ZohoDc; info: ZohoDcInfo } {
    const dcs = this.dcs();
    if (typeof cb.accountsServer === 'string' && cb.accountsServer) {
      const want = cb.accountsServer.trim().replace(/\/+$/, '').toLowerCase();
      const hit = (Object.keys(dcs) as ZohoDc[]).find((k) => dcs[k].accounts.toLowerCase() === want);
      if (!hit) throw new ZohoError('Zoho answered from an address that is not one of Zoho\'s. Nothing was saved.');
      return { dc: hit, info: dcs[hit] };
    }
    const byLocation = zohoDcFromLocation(cb.location);
    const dc = byLocation ?? this.config().dc;
    return { dc, info: dcs[dc] };
  }

  private async finish(me: PublicUser, cb: ZohoCallback): Promise<ZohoStatus> {
    const c = this.config();
    if (!this.available() || !c.clientId || !c.secret) throw new ZohoError('Your office has not set up Zoho Calendar yet.');
    if (typeof cb?.state !== 'string' || !STATE_RE.test(cb.state)) throw new ZohoError('The answer from Zoho did not match. Start again.');
    const pending = this.h.db.prepare('SELECT user_id, created_at FROM zoho_auth WHERE state = ?').get(cb.state) as { user_id: string; created_at: number } | undefined;
    this.h.db.prepare('DELETE FROM zoho_auth WHERE state = ?').run(cb.state);
    if (!pending || pending.user_id !== me.id || pending.created_at < Date.now() - AUTH_TTL) throw new ZohoError('That Zoho sign-in has expired or was not started here. Start again.');
    if (cb.error) throw new ZohoError(cb.error === 'access_denied' ? 'Zoho was not given access, so nothing changed.' : 'Zoho did not complete the sign-in. Start again.');
    if (typeof cb.code !== 'string' || !cb.code || cb.code.length > 1000) throw new ZohoError('Zoho did not send a sign-in code. Start again.');
    const { dc, info } = this.accountsFor(cb);
    let tokens: { access_token?: string; refresh_token?: string; expires_in?: number; api_domain?: string; error?: string };
    try {
      tokens = await this.post(`${info.accounts}/oauth/v2/token`, {
        grant_type: 'authorization_code', client_id: c.clientId, client_secret: c.secret, redirect_uri: this.redirectUri(), code: cb.code,
      });
    } catch (err) { throw new ZohoError(err instanceof ZohoApiError ? words(err) : 'Zoho could not be reached. Check the hub\'s internet connection and try again.'); }
    if (tokens.error || !tokens.access_token) {
      const e = tokens.error ?? 'no token';
      this.h.log('warn', 'zoho sign-in refused', { error: e, dc });
      throw new ZohoError(e === 'invalid_client' || e === 'invalid_client_secret' ? 'Zoho did not accept the office\'s Zoho client. Ask an administrator to check it.'
        : e === 'invalid_redirect_uri' ? 'Zoho does not know this app\'s return address. An administrator must add it to the Zoho client exactly as shown in the Control room.'
          : 'Zoho did not accept the sign-in code (it lasts two minutes). Start again.');
    }
    if (!tokens.refresh_token) throw new ZohoError('Zoho did not give lasting access. Start again and allow access when Zoho asks.');
    const now = Date.now();
    const existing = this.account(me.id);
    // an earlier connection's copies stay mapped (same person): a reconnect does not duplicate them
    this.h.db.prepare(`INSERT INTO zoho_accounts (user_id, dc, accounts_url, api_url, refresh_token, access_token, access_expires, connected_at, state, due, told_reconnect, fails, next_try_at, last_error, last_error_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'connected', 1, 0, 0, 0, NULL, NULL)
      ON CONFLICT(user_id) DO UPDATE SET dc = excluded.dc, accounts_url = excluded.accounts_url, api_url = excluded.api_url, refresh_token = excluded.refresh_token,
        access_token = excluded.access_token, access_expires = excluded.access_expires, connected_at = excluded.connected_at, state = 'connected', due = 1,
        told_reconnect = 0, fails = 0, next_try_at = 0, last_error = NULL, last_error_at = NULL`)
      .run(me.id, dc, info.accounts, info.calendar, this.seal(tokens.refresh_token), this.seal(tokens.access_token), now + Math.max(60, Math.min(Number(tokens.expires_in) || 3600, 86400)) * 1000 - MIN, existing?.connected_at && existing.dc === dc ? existing.connected_at : now);
    const r = this.account(me.id)!;
    // the account's email (optional: Zoho may not share it) and the calendars to choose from
    try {
      const info2 = await this.api<{ Email?: string; email?: string }>(r, 'GET', `${info.accounts}/oauth/user/info`);
      const email = typeof info2.Email === 'string' ? info2.Email : typeof info2.email === 'string' ? info2.email : null;
      if (email) this.h.db.prepare('UPDATE zoho_accounts SET email = ? WHERE user_id = ?').run(email.slice(0, 200), me.id);
    } catch { /* the email is a nicety */ }
    try { await this.loadCalendars(this.account(me.id)!); } catch (err) {
      this.fail(me.id, err);
      throw new ZohoError(`Connected, but your Zoho calendars could not be read: ${words(err)}`);
    }
    this.h.audit(me.id, 'zoho.connect', me.id, { dc });
    this.emitAll(me.id);
    this.kick(0);
    return this.status(me.id);
  }

  private async loadCalendars(r: AccountRow): Promise<void> {
    const res = await this.api<{ calendars?: Array<{ uid?: string; name?: string; isdefault?: boolean; privilege?: string }> }>(r, 'GET', `${r.api_url}/api/v1/calendars`);
    const list = (res.calendars ?? []).filter((c) => typeof c.uid === 'string' && (!c.privilege || /owner|edit|write|all/i.test(c.privilege)))
      .slice(0, 50).map((c) => ({ uid: c.uid!, name: String(c.name ?? 'Calendar').slice(0, 80), isDefault: c.isdefault === true }));
    if (!list.length) throw new ZohoApiError('bad', 0, 'no calendars');
    const cur = list.find((c) => c.uid === r.calendar_uid) ?? list.find((c) => c.isDefault) ?? list[0];
    this.h.db.prepare('UPDATE zoho_accounts SET calendars = ?, calendar_uid = ?, calendar_name = ? WHERE user_id = ?').run(JSON.stringify(list), cur.uid, cur.name, r.user_id);
  }

  /** Stop syncing someone: copies of future meetings removed (best effort), the access revoked. */
  async disconnect(userId: string, removeCopies: boolean): Promise<void> {
    const r = this.account(userId);
    if (!r) return;
    await this.withLock(async () => {
      if (removeCopies && r.refresh_token && r.state === 'connected') {
        try { await this.removeCopies(r, true); } catch { /* best effort */ }
      }
      const refresh = this.unseal(r.refresh_token);
      const c = this.config();
      if (refresh && c.clientId && c.secret) {
        try { await this.post(`${r.accounts_url}/oauth/v2/revoke/token`, { token: refresh, token_type: 'refresh_token', client_id: c.clientId, client_secret: c.secret }); } catch { /* revoked or unreachable */ }
      }
      this.h.db.prepare('DELETE FROM zoho_accounts WHERE user_id = ?').run(userId);
      this.h.db.prepare('DELETE FROM zoho_map WHERE user_id = ?').run(userId);
      this.h.db.prepare('DELETE FROM zoho_external WHERE user_id = ?').run(userId);
    });
    this.emitAll(userId);
  }

  /** Remove the copies Dexterity made (future ones only when `futureOnly`; past meetings stay as a record). */
  private async removeCopies(r: AccountRow, futureOnly: boolean): Promise<void> {
    const now = Date.now();
    const rows = this.h.db.prepare('SELECT m.*, e.end_at, e.recurrence, e.until_at FROM zoho_map m LEFT JOIN events e ON e.id = m.event_id WHERE m.user_id = ? LIMIT 400').all(r.user_id) as unknown as Array<MapRow & { end_at: number | null; recurrence: string | null; until_at: number | null }>;
    for (const m of rows) {
      const ended = m.occ_start ? m.occ_start < now : (m.end_at ?? 0) < now && (m.recurrence === 'none' || (m.until_at !== null && m.until_at < now));
      if (futureOnly && ended) continue;
      if (m.zoho_uid) {
        try { await this.deleteRemote(r, m); } catch (err) { if (err instanceof ZohoApiError && (err.kind === 'revoked' || err.kind === 'client')) break; }
      }
      this.h.db.prepare('DELETE FROM zoho_map WHERE user_id = ? AND event_id = ? AND occ_start = ?').run(m.user_id, m.event_id, m.occ_start);
    }
  }

  // ------------------------------------------------------------ HTTP
  private retryDelay(i: number): number { return (this.h.test?.retryDelayMs ?? 1000) * 2 ** i; }

  private async raw(url: string, init: RequestInit): Promise<{ status: number; json: unknown; text: string }> {
    let res: Response;
    try {
      res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new ZohoApiError('busy', 0, 'unreachable');
    }
    const text = (await res.text()).slice(0, 2_000_000);
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, json, text };
  }

  /** A form POST to the accounts server (tokens, revoking), retried while Zoho is busy. */
  private async post<T>(url: string, form: Record<string, string>): Promise<T> {
    for (let i = 0; ; i++) {
      const r = await this.raw(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() })
        .catch((err: unknown) => { if (err instanceof ZohoApiError && i < 2) return null; throw err; });
      if (r && r.status < 500 && r.status !== 429) {
        const j = (r.json ?? {}) as T & { error?: string };
        // Zoho answers refusals with 200 and {"error": …} as often as with 400
        return j;
      }
      if (i >= 2) throw new ZohoApiError('busy', r?.status ?? 0, 'accounts server busy');
      await new Promise((res) => setTimeout(res, this.retryDelay(i)));
    }
  }

  /** A fresh access token: refreshed when it is about to expire (Zoho allows ten an hour per refresh token, so they are kept). */
  private async accessToken(r: AccountRow, force = false): Promise<string> {
    const cur = this.account(r.user_id) ?? r;
    const access = this.unseal(cur.access_token);
    if (!force && access && cur.access_expires > Date.now()) return access;
    const refresh = this.unseal(cur.refresh_token);
    const c = this.config();
    if (!refresh) throw new ZohoApiError('revoked', 401, 'no refresh token');
    if (!c.clientId || !c.secret) throw new ZohoApiError('client', 0, 'not configured');
    const j = await this.post<{ access_token?: string; expires_in?: number; error?: string }>(`${cur.accounts_url}/oauth/v2/token`, {
      grant_type: 'refresh_token', refresh_token: refresh, client_id: c.clientId, client_secret: c.secret,
    });
    if (j.error === 'invalid_code' || j.error === 'invalid_grant') throw new ZohoApiError('revoked', 400, j.error);
    if (j.error === 'invalid_client' || j.error === 'invalid_client_secret') throw new ZohoApiError('client', 400, j.error);
    if (j.error || !j.access_token) throw new ZohoApiError('busy', 400, j.error ?? 'no access token');
    const expires = Date.now() + Math.max(60, Math.min(Number(j.expires_in) || 3600, 86400)) * 1000 - MIN;
    this.h.db.prepare('UPDATE zoho_accounts SET access_token = ?, access_expires = ? WHERE user_id = ?').run(this.seal(j.access_token), expires, r.user_id);
    return j.access_token;
  }

  /** A Calendar API call: a token refreshed once on 401, retries with growing waits while Zoho is busy. */
  private async api<T>(r: AccountRow, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, headers: Record<string, string> = {}): Promise<T> {
    let refreshed = false;
    for (let i = 0; ; i++) {
      const token = await this.accessToken(r, false);
      let res: { status: number; json: unknown; text: string } | null = null;
      try {
        res = await this.raw(url, { method, headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...headers } });
      } catch (err) {
        if (!(err instanceof ZohoApiError) || i >= 2) throw err;
      }
      if (res) {
        const { status, json, text } = res;
        if (status >= 200 && status < 300) return (json ?? {}) as T;
        if (status === 401) {
          if (refreshed) throw new ZohoApiError('auth', 401, 'token refused');
          refreshed = true;
          await this.accessToken(r, true);
          i--;
          continue;
        }
        if (status === 404) throw new ZohoApiError('notfound', 404, 'not found');
        // Zoho does not document its answer to a stale etag: 409, 412 and an etag error code are all treated as one
        if (status === 409 || status === 412 || (status === 400 && /etag/i.test(text))) throw new ZohoApiError('conflict', status, 'etag');
        if (status !== 429 && status < 500) throw new ZohoApiError('bad', status, 'refused');
        if (i >= 2) throw new ZohoApiError('busy', status, 'busy');
      }
      await new Promise((res2) => setTimeout(res2, this.retryDelay(i)));
    }
  }

  // ------------------------------------------------------------ what a meeting looks like in Zoho
  private entries(user: PublicUser, ev: EventRow, now: number): Array<{ occ: number; data: Record<string, unknown> }> {
    const det = this.h.details(user, ev.id);
    if (!det) return [];
    const office = this.h.zone();
    // repeats are counted on the office's clock (as Dexterity counts them); a single meeting keeps its own zone
    const zone = ev.recurrence === 'none' ? (ev.time_zone || office) : office;
    const base = (startAt: number, endAt: number): Record<string, unknown> => ({
      title: det.title.slice(0, 250),
      dateandtime: ev.all_day
        ? { timezone: zone, start: zohoDay(startAt, zone), end: zohoDay(endAt, zone) }
        : { timezone: zone, start: zohoUtc(startAt), end: zohoUtc(endAt) },
      isallday: !!ev.all_day,
      description: (det.description ?? '').slice(0, 2000),
      location: (det.location ?? '').slice(0, 250),
      transparency: 0,
    });
    if (ev.recurrence === 'none') return [{ occ: 0, data: base(ev.start_at, ev.end_at) }];
    const rule = zohoRrule(ev.recurrence, ev.start_at, ev.until_at, zone);
    if (rule) return [{ occ: 0, data: { ...base(ev.start_at, ev.end_at), rrule: rule } }];
    return expand(ev, now - DAY, now + EXPAND_AHEAD, EXPAND_MAX).map((o) => ({ occ: o.startAt, data: base(o.startAt, o.endAt) }));
  }

  private eventsPath(r: AccountRow, cal: string, uid?: string): string {
    return `${r.api_url}/api/v1/calendars/${encodeURIComponent(cal)}/events${uid ? `/${encodeURIComponent(uid)}` : ''}`;
  }

  private async deleteRemote(r: AccountRow, m: MapRow): Promise<void> {
    if (!m.zoho_uid) return;
    const url = this.eventsPath(r, m.calendar_uid, m.zoho_uid);
    try {
      await this.api(r, 'DELETE', url, { etag: m.etag ?? '' });
    } catch (err) {
      if (err instanceof ZohoApiError && err.kind === 'notfound') return;
      if (err instanceof ZohoApiError && err.kind === 'conflict') {
        const etag = await this.remoteEtag(r, m.calendar_uid, m.zoho_uid);
        if (etag === null) return;
        await this.api(r, 'DELETE', url, { etag });
        return;
      }
      throw err;
    }
  }

  private async remoteEtag(r: AccountRow, cal: string, uid: string): Promise<string | null> {
    try {
      const j = await this.api<{ events?: Array<{ etag?: unknown }> }>(r, 'GET', this.eventsPath(r, cal, uid));
      const e = j.events?.[0]?.etag;
      return e === undefined || e === null ? null : String(e);
    } catch (err) {
      if (err instanceof ZohoApiError && err.kind === 'notfound') return null;
      throw err;
    }
  }

  private static etagOf(j: { events?: Array<{ uid?: unknown; etag?: unknown }> }): { uid: string | null; etag: string | null } {
    const e = j.events?.[0];
    return { uid: typeof e?.uid === 'string' ? e.uid : null, etag: e?.etag === undefined || e?.etag === null ? null : String(e.etag) };
  }

  // ------------------------------------------------------------ the sync itself
  /** Mark everyone affected by a meeting change; the copy follows within seconds. */
  changed(eventId: string): void {
    if (!this.available()) return;
    const users = this.h.db.prepare(`SELECT user_id FROM zoho_accounts WHERE user_id IN (
      SELECT organizer_id FROM events WHERE id = ? UNION SELECT user_id FROM event_attendees WHERE event_id = ? UNION SELECT user_id FROM zoho_map WHERE event_id = ?)`)
      .all(eventId, eventId, eventId) as Array<{ user_id: string }>;
    if (!users.length) return;
    const mark = this.h.db.prepare('UPDATE zoho_accounts SET due = 1 WHERE user_id = ?');
    for (const u of users) mark.run(u.user_id);
    this.kick();
  }

  private kick(ms = this.h.test?.kickMs ?? 1500): void {
    if (this.stopped || this.kickTimer) return;
    this.kickTimer = setTimeout(() => { this.kickTimer = null; void this.runDue().catch((err: Error) => this.h.log('error', 'zoho sync failed', { error: err.message })); }, ms);
    this.kickTimer.unref?.();
  }

  /** The hub's ten-second timer: people with changes, or whose Zoho events are due a read. */
  tick(now = Date.now()): void {
    if (!this.available() || this.running) return;
    const due = this.h.db.prepare(`SELECT 1 FROM zoho_accounts WHERE state = 'connected' AND next_try_at <= ? AND (due = 1 OR last_pull_at IS NULL OR last_pull_at <= ?) LIMIT 1`).get(now, now - PULL_EVERY);
    if (due) void this.runDue(now).catch((err: Error) => this.h.log('error', 'zoho sync failed', { error: err.message }));
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    while (this.running) await this.running.catch(() => {});
    let done!: () => void;
    this.running = new Promise<void>((res) => { done = res; });
    try { return await fn(); } finally { this.running = null; done(); }
  }

  /** Everyone due, one after another (gentle on Zoho's rate limits). */
  async runDue(now = Date.now()): Promise<void> {
    if (!this.available()) return;
    await this.withLock(async () => {
      const rows = this.h.db.prepare(`SELECT user_id FROM zoho_accounts WHERE state = 'connected' AND next_try_at <= ? AND (due = 1 OR last_pull_at IS NULL OR last_pull_at <= ?) ORDER BY next_try_at LIMIT 20`)
        .all(now, now - PULL_EVERY) as Array<{ user_id: string }>;
      for (const { user_id } of rows) {
        if (this.stopped) return;
        await this.syncUser(user_id, Date.now());
      }
    });
  }

  /** One person now (Sync now, and tests). */
  async runNow(userId?: string): Promise<void> {
    if (this.kickTimer) { clearTimeout(this.kickTimer); this.kickTimer = null; }
    if (!userId) { await this.runDue(Date.now() + 1); return; }
    await this.withLock(() => this.syncUser(userId, Date.now()));
  }

  private async syncUser(userId: string, now: number): Promise<void> {
    const r = this.account(userId);
    if (!r || r.state !== 'connected' || !this.available()) return;
    const user = this.h.userById(userId);
    if (!user || !this.h.active(userId)) {
      // someone who left the office: their connection is dropped (their copies stay with their Zoho account)
      await this.disconnectInside(r);
      return;
    }
    try {
      if (!r.calendar_uid) await this.loadCalendars(r);
      const acct = this.account(userId)!;
      const pullDue = !acct.last_pull_at || acct.last_pull_at <= now - PULL_EVERY;
      if (pullDue) await this.pull(acct, now);
      const more = await this.push(this.account(userId)!, user, now);
      this.h.db.prepare(`UPDATE zoho_accounts SET due = ?, fails = 0, next_try_at = 0, last_sync_at = ?, last_error = NULL, last_error_at = NULL WHERE user_id = ?`)
        .run(more ? 1 : 0, Date.now(), userId);
      if (more) this.kick(2000);
    } catch (err) {
      this.fail(userId, err);
    }
    this.emitAll(userId);
  }

  private async disconnectInside(r: AccountRow): Promise<void> {
    const refresh = this.unseal(r.refresh_token);
    const c = this.config();
    if (refresh && c.clientId && c.secret) {
      try { await this.post(`${r.accounts_url}/oauth/v2/revoke/token`, { token: refresh, token_type: 'refresh_token', client_id: c.clientId, client_secret: c.secret }); } catch { /* best effort */ }
    }
    for (const t of ['zoho_accounts', 'zoho_map', 'zoho_external']) this.h.db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(r.user_id);
  }

  private fail(userId: string, err: unknown): void {
    const now = Date.now();
    const msg = words(err);
    const r = this.account(userId);
    if (!r) return;
    if (err instanceof ZohoApiError && (err.kind === 'revoked' || err.kind === 'auth')) {
      this.h.db.prepare(`UPDATE zoho_accounts SET state = 'reconnect', access_token = NULL, last_error = ?, last_error_at = ? WHERE user_id = ?`).run(msg, now, userId);
      if (!r.told_reconnect) {
        this.h.db.prepare('UPDATE zoho_accounts SET told_reconnect = 1 WHERE user_id = ?').run(userId);
        this.h.tell(userId, 'Zoho Calendar has stopped syncing: Zoho no longer accepts the connection (it was revoked, or the Zoho password changed). Open **Preferences → Calendar** and choose **Reconnect Zoho Calendar**. Nothing is lost: your meetings are copied again once you reconnect.', `zoho-reconnect-${now}`);
      }
      this.h.log('warn', 'zoho connection needs reconnecting', { userId, kind: err.kind });
      return;
    }
    const fails = r.fails + 1;
    const wait = Math.min(60 * MIN, MIN * 2 ** Math.min(fails - 1, 6));
    this.h.db.prepare('UPDATE zoho_accounts SET fails = ?, next_try_at = ?, last_error = ?, last_error_at = ? WHERE user_id = ?').run(fails, now + wait, msg, now, userId);
    this.h.log('warn', 'zoho sync will retry', { userId, kind: err instanceof ZohoApiError ? err.kind : 'error', status: err instanceof ZohoApiError ? err.status : 0, retryInMin: Math.round(wait / MIN) });
  }

  /** Dexterity → Zoho. Returns true when there is more to write than one run allows. */
  private async push(r: AccountRow, user: PublicUser, now: number): Promise<boolean> {
    const cal = r.calendar_uid!;
    const events = this.h.db.prepare(`SELECT e.* FROM events e WHERE e.cancelled = 0
        AND (e.organizer_id = ? OR EXISTS (SELECT 1 FROM event_attendees a WHERE a.event_id = e.id AND a.user_id = ? AND a.response = 'yes'))
        AND (e.end_at >= ? OR (e.recurrence != 'none' AND (e.until_at IS NULL OR e.until_at >= ?)))
      ORDER BY e.start_at LIMIT ${MAX_EVENTS}`).all(r.user_id, r.user_id, now - DAY, now - DAY) as unknown as EventRow[];
    const mapped = new Map<string, MapRow>();
    for (const m of this.h.db.prepare('SELECT * FROM zoho_map WHERE user_id = ?').all(r.user_id) as unknown as MapRow[]) mapped.set(`${m.event_id}|${m.occ_start}`, m);
    const want = new Set<string>();
    let budget = WRITES_PER_RUN;
    let pushed = 0;
    let restored = 0;
    const save = this.h.db.prepare(`INSERT INTO zoho_map (user_id, event_id, occ_start, zoho_uid, calendar_uid, etag, hash, stale, told, failed_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?)
      ON CONFLICT(user_id, event_id, occ_start) DO UPDATE SET zoho_uid = excluded.zoho_uid, calendar_uid = excluded.calendar_uid, etag = excluded.etag, hash = excluded.hash,
        stale = 0, told = excluded.told, failed_hash = NULL, updated_at = excluded.updated_at`);

    for (const ev of events) {
      for (const { occ, data } of this.entries(user, ev, now)) {
        const k = `${ev.id}|${occ}`;
        want.add(k);
        const hash = crypto.createHash('sha256').update(JSON.stringify(data)).digest('base64url');
        const m = mapped.get(k);
        if (m && m.zoho_uid && m.hash === hash && !m.stale && m.calendar_uid === cal) continue;
        if (m && m.failed_hash === hash && !m.stale) continue; // Zoho refused this exact version: wait for a change
        if (budget <= 0) return true;
        budget--;
        try {
          if (m?.zoho_uid && m.calendar_uid === cal) {
            const res = await this.update(r, cal, m, data);
            if (res) {
              if (m.stale) {
                restored++;
                if (!m.told) this.h.tell(r.user_id, `**${String(data.title)}** was changed or removed in Zoho Calendar. Dexterity Connect keeps its own meetings, so it was put back as it is here. To change it, change the meeting in Dexterity Connect.`, `zoho-restored-${ev.id}-${occ}`);
              }
              save.run(r.user_id, ev.id, occ, res.uid, cal, res.etag, hash, m.stale ? 1 : m.told, now);
              pushed++;
              continue;
            }
          }
          const created = ZohoSync.etagOf(await this.api(r, 'POST', `${this.eventsPath(r, cal)}?eventdata=${encodeURIComponent(JSON.stringify(data))}`));
          if (!created.uid) throw new ZohoApiError('bad', 200, 'no uid');
          if (m?.stale && m.zoho_uid) { restored++; if (!m.told) this.h.tell(r.user_id, `**${String(data.title)}** was removed in Zoho Calendar. Dexterity Connect keeps its own meetings, so it was added again. To leave it, decline it in Dexterity Connect.`, `zoho-restored-${ev.id}-${occ}`); }
          save.run(r.user_id, ev.id, occ, created.uid, cal, created.etag, hash, m?.stale ? 1 : (m?.told ?? 0), now);
          pushed++;
        } catch (err) {
          if (err instanceof ZohoApiError && err.kind === 'bad') {
            // this version is refused (too long, a rule Zoho does not take…): note it and go on with the rest
            this.h.db.prepare(`INSERT INTO zoho_map (user_id, event_id, occ_start, zoho_uid, calendar_uid, etag, hash, failed_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(user_id, event_id, occ_start) DO UPDATE SET failed_hash = excluded.failed_hash, updated_at = excluded.updated_at`).run(r.user_id, ev.id, occ, m?.zoho_uid ?? null, m?.calendar_uid ?? cal, m?.etag ?? null, m?.hash ?? null, hash, now);
            this.h.db.prepare('UPDATE zoho_accounts SET last_error = ?, last_error_at = ? WHERE user_id = ?').run(words(err), now, r.user_id);
            this.h.log('warn', 'zoho refused a meeting', { userId: r.user_id, eventId: ev.id, status: err.status });
            continue;
          }
          throw err;
        }
      }
    }

    // copies no longer wanted: cancelled, declined, taken off, deleted, or moved to another calendar
    for (const [k, m] of mapped) {
      if (want.has(k)) continue;
      const ev = this.h.db.prepare('SELECT * FROM events WHERE id = ?').get(m.event_id) as EventRow | undefined;
      const stillMine = !!ev && !ev.cancelled && (ev.organizer_id === r.user_id
        || !!this.h.db.prepare(`SELECT 1 FROM event_attendees WHERE event_id = ? AND user_id = ? AND response = 'yes'`).get(ev.id, r.user_id));
      const pastTime = m.occ_start ? m.occ_start < now - DAY : !!ev && ev.end_at < now - DAY && (ev.recurrence === 'none' || (ev.until_at !== null && ev.until_at < now - DAY));
      if (stillMine && pastTime) { this.h.db.prepare('DELETE FROM zoho_map WHERE user_id = ? AND event_id = ? AND occ_start = ?').run(r.user_id, m.event_id, m.occ_start); continue; }
      if (budget <= 0) return true;
      budget--;
      if (m.zoho_uid) await this.deleteRemote(r, m);
      this.h.db.prepare('DELETE FROM zoho_map WHERE user_id = ? AND event_id = ? AND occ_start = ?').run(r.user_id, m.event_id, m.occ_start);
    }
    if (pushed || restored) this.h.db.prepare('UPDATE zoho_accounts SET pushed = pushed + ?, restored = restored + ? WHERE user_id = ?').run(pushed, restored, r.user_id);
    return false;
  }

  /** Change a copy in place; null when it is gone from Zoho (it is made again). */
  private async update(r: AccountRow, cal: string, m: MapRow, data: Record<string, unknown>): Promise<{ uid: string; etag: string | null } | null> {
    const put = async (etag: string | null) => ZohoSync.etagOf(await this.api(r, 'PUT',
      `${this.eventsPath(r, cal, m.zoho_uid!)}?eventdata=${encodeURIComponent(JSON.stringify({ ...data, etag: etag ?? undefined }))}`, { etag: etag ?? '' }));
    try {
      const res = await put(m.etag);
      return { uid: res.uid ?? m.zoho_uid!, etag: res.etag };
    } catch (err) {
      if (err instanceof ZohoApiError && err.kind === 'notfound') return null;
      if (!(err instanceof ZohoApiError) || err.kind !== 'conflict') throw err;
      // changed in Zoho since our copy: Dexterity's version wins (with Zoho's current etag)
      const etag = await this.remoteEtag(r, cal, m.zoho_uid!);
      if (etag === null) return null;
      this.h.db.prepare('UPDATE zoho_map SET stale = 1 WHERE user_id = ? AND event_id = ? AND occ_start = ?').run(m.user_id, m.event_id, m.occ_start);
      m.stale = 1;
      const res = await put(etag);
      return { uid: res.uid ?? m.zoho_uid!, etag: res.etag };
    }
  }

  /** Zoho → Dexterity: the chosen calendar's events from yesterday to four weeks ahead. */
  private async pull(r: AccountRow, now: number): Promise<void> {
    const cal = r.calendar_uid!;
    const from = now - PULL_BACK;
    const to = now + PULL_AHEAD;
    const zone = this.h.zone();
    const range = JSON.stringify({ start: zohoUtc(from), end: zohoUtc(to) });
    const j = await this.api<{ events?: Array<Record<string, unknown>> }>(r, 'GET', `${this.eventsPath(r, cal)}?range=${encodeURIComponent(range)}&byinstance=true`);
    const list = Array.isArray(j.events) ? j.events.slice(0, 2000) : [];
    const mine = new Map<string, MapRow[]>();
    for (const m of this.h.db.prepare('SELECT * FROM zoho_map WHERE user_id = ? AND zoho_uid IS NOT NULL').all(r.user_id) as unknown as MapRow[]) {
      mine.set(m.zoho_uid!, [...(mine.get(m.zoho_uid!) ?? []), m]);
    }
    const seen = new Set<string>();
    const outside: Array<{ uid: string; startAt: number; endAt: number; allDay: boolean; title: string }> = [];
    for (const e of list) {
      const uid = typeof e.uid === 'string' ? e.uid : null;
      if (!uid) continue;
      const own = mine.get(uid);
      if (own) {
        seen.add(uid);
        // a copy Dexterity made, changed in Zoho since (its etag moved): put back on the next push
        const etag = e.etag === undefined || e.etag === null ? null : String(e.etag);
        for (const m of own) {
          if (etag && m.etag && etag !== m.etag && !m.stale) this.h.db.prepare('UPDATE zoho_map SET stale = 1, etag = ? WHERE user_id = ? AND event_id = ? AND occ_start = ?').run(etag, r.user_id, m.event_id, m.occ_start);
        }
        continue;
      }
      if (outside.length >= MAX_EXTERNAL) continue;
      if (Number(e.transparency) === 1) continue; // marked free in Zoho
      const dt = (e.dateandtime ?? {}) as { start?: unknown; end?: unknown; timezone?: unknown };
      const tz = typeof dt.timezone === 'string' && isZone(dt.timezone) ? dt.timezone : zone;
      const allDay = e.isallday === true || e.isallday === 'true';
      const startAt = parseZohoTime(dt.start ?? e.start, allDay ? zone : tz);
      let endAt = parseZohoTime(dt.end ?? e.end, allDay ? zone : tz);
      if (startAt === null || endAt === null) continue;
      if (endAt <= startAt) endAt = startAt + (allDay ? DAY : 30 * MIN);
      if (endAt - startAt > 31 * DAY || endAt <= from || startAt >= to) continue;
      const title = typeof e.title === 'string' && e.title.trim() ? e.title.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 140) : 'Busy';
      outside.push({ uid: uid.slice(0, 200), startAt, endAt, allDay, title });
    }
    // copies that should be inside the range but are gone from Zoho: made again on the push
    for (const [uid, rows] of mine) {
      if (seen.has(uid)) continue;
      for (const m of rows) {
        const ev = this.h.db.prepare('SELECT start_at, end_at, recurrence FROM events WHERE id = ?').get(m.event_id) as { start_at: number; end_at: number; recurrence: string } | undefined;
        if (!ev) continue;
        const at = m.occ_start || (ev.recurrence === 'none' ? ev.start_at : null);
        if (at !== null && at >= from && at < to && m.calendar_uid === cal) this.h.db.prepare('UPDATE zoho_map SET stale = 1 WHERE user_id = ? AND event_id = ? AND occ_start = ?').run(r.user_id, m.event_id, m.occ_start);
      }
    }
    const db = this.h.db;
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM zoho_external WHERE user_id = ? AND start_at < ? AND end_at > ?').run(r.user_id, to, from);
      const ins = db.prepare('INSERT OR REPLACE INTO zoho_external (user_id, zoho_uid, start_at, end_at, all_day, title, calendar) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const x of outside) ins.run(r.user_id, x.uid, x.startAt, x.endAt, x.allDay ? 1 : 0, x.title, r.calendar_name);
      // events read long ago and not read again are dropped
      db.prepare('DELETE FROM zoho_external WHERE user_id = ? AND end_at < ?').run(r.user_id, now - 7 * DAY);
      db.prepare('UPDATE zoho_accounts SET last_pull_at = ?, imported = ? WHERE user_id = ?').run(Date.now(), outside.length, r.user_id);
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
  }

  // ------------------------------------------------------------ what the rest of the hub reads
  /** People's Zoho events between two times, for the Calendar, free/busy and "in a meeting". */
  externals(userIds: string[], from: number, to: number): ExternalBlock[] {
    if (!userIds.length || !this.available()) return [];
    const rows = this.h.db.prepare(`SELECT x.* FROM zoho_external x JOIN zoho_accounts a ON a.user_id = x.user_id
      WHERE x.user_id IN (${userIds.map(() => '?').join(',')}) AND x.start_at < ? AND x.end_at > ? ORDER BY x.start_at LIMIT 2000`)
      .all(...userIds, to, from) as Array<{ user_id: string; zoho_uid: string; start_at: number; end_at: number; all_day: number; title: string; calendar: string | null }>;
    return rows.map((x) => ({ userId: x.user_id, key: `${x.zoho_uid}|${x.start_at}`, title: x.title, startAt: x.start_at, endAt: x.end_at, allDay: !!x.all_day, calendar: x.calendar }));
  }

  /** Who has a timed Zoho event right now (they show as in a meeting). */
  busyNow(now = Date.now()): Set<string> {
    if (!this.available()) return new Set();
    const rows = this.h.db.prepare(`SELECT DISTINCT x.user_id FROM zoho_external x JOIN zoho_accounts a ON a.user_id = x.user_id WHERE x.all_day = 0 AND x.start_at <= ? AND x.end_at > ?`).all(now, now) as Array<{ user_id: string }>;
    return new Set(rows.map((r) => r.user_id));
  }
}

function isZone(z: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: z }); return true; } catch { return false; }
}
