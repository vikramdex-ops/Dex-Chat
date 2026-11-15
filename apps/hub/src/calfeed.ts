// A person's private calendar feed: an address with a long random token that Outlook or a phone
// subscribes to (GET /cal/<token>.ics), listing the meetings in their Dexterity Connect Calendar.
// Only a SHA-256 of the token is kept, so the hub cannot show an address again: it is shown when
// the feed is turned on or reset, and resetting makes the old address stop working at once.
// The same path works on the office network and, when it is on, through the internet gateway.
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { CAL_FEED_PATH_RE, formatMeetingId, meetingLink } from '@dex/core';
import type { CalendarFeedInfo, PublicUser, Recurrence } from '@dex/core';
import { buildCalendarFeed } from '@dex/core/ics';
import type { FeedEvent } from '@dex/core/ics';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cal_feeds (
  user_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_fetched_at INTEGER,
  fetches INTEGER NOT NULL DEFAULT 0
);
`;

const DAY = 86_400_000;
/** Meetings that ended longer ago than this are left out (calendars keep what they already have). */
const PAST_DAYS = 120;
/** Cancelled meetings stay in the feed this long, marked cancelled, so calendars remove them. */
const CANCELLED_DAYS = 45;
/** Under the gateway's frame limit with room to spare (it counts three bytes a character). */
export const FEED_MAX_LENGTH = 250_000;
/** Wrong addresses from one network before it is turned away for a while. */
const FAILS_PER_HOUR = 30;

const sha = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

interface EventRow {
  id: string; title: string; description: string | null; location: string | null; venue_id: string | null; start_at: number; end_at: number;
  all_day: number; organizer_id: string; online: number; recurrence: Recurrence; until_at: number | null; cancelled: number;
  created_at: number; seq: number | null; updated_at: number | null; response: string | null;
}

export interface FeedHost {
  db: DatabaseSync;
  hubId: () => string;
  office: () => string;
  userById: (id: string) => PublicUser | null;
  /** Can this person still use the office (not offboarded, has an approved device)? */
  active: (userId: string) => boolean;
  /** The office addresses of this hub ("192.168.1.20:47900"). */
  lan: () => string[];
  /** The gateway's address when access from outside is on. */
  gateway: () => string | null;
  /** The meeting a Calendar event held as a call takes place in (made the first time). */
  meetingFor: (organizer: PublicUser, eventId: string) => string | null;
  venueName: (id: string) => string | null;
  audit: (actor: string | null, action: string, target: string | null, detail?: unknown) => void;
}

export class CalFeedError extends Error {}

export class CalendarFeeds {
  private readonly h: FeedHost;
  private fails = new Map<string, number[]>();

  constructor(host: FeedHost) {
    this.h = host;
    host.db.exec(SCHEMA);
  }

  private row(userId: string): { token_hash: string; created_at: number; last_fetched_at: number | null } | undefined {
    return this.h.db.prepare('SELECT token_hash, created_at, last_fetched_at FROM cal_feeds WHERE user_id = ?').get(userId) as { token_hash: string; created_at: number; last_fetched_at: number | null } | undefined;
  }

  private info(userId: string, token: string | null): CalendarFeedInfo {
    const r = this.row(userId);
    const gateway = this.h.gateway();
    return {
      enabled: !!r,
      urls: token ? this.urls(token) : null,
      createdAt: r?.created_at ?? null,
      lastFetchedAt: r?.last_fetched_at ?? null,
      gateway,
    };
  }

  /** The addresses for a token: on the office network, and through the gateway when it is on. */
  urls(token: string): NonNullable<CalendarFeedInfo['urls']> {
    const gateway = this.h.gateway();
    return {
      path: `/cal/${token}.ics`,
      office: this.h.lan().map((a) => `https://${a}/cal/${token}.ics`),
      outside: gateway ? `${gateway.replace(/\/+$/, '')}/cal/${token}.ics` : null,
    };
  }

  /** A fresh token replaces any earlier one (the old address stops working). */
  private issue(userId: string): string {
    const token = crypto.randomBytes(32).toString('base64url');
    this.h.db.prepare(`INSERT INTO cal_feeds (user_id, token_hash, created_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at, last_fetched_at = NULL, fetches = 0`).run(userId, sha(token), Date.now());
    return token;
  }

  /** Turn someone's feed off (offboarding, or they asked). */
  revoke(userId: string): boolean {
    return this.h.db.prepare('DELETE FROM cal_feeds WHERE user_id = ?').run(userId).changes > 0;
  }

  handle(op: string, me: PublicUser, d: Record<string, unknown>): unknown {
    switch (op) {
      case 'cal.feed.get':
        return this.info(me.id, null);
      case 'cal.feed.set': {
        if (me.role === 'bot') throw new CalFeedError('Integrations have no calendar.');
        if (d.enabled === true) {
          if (this.row(me.id)) return this.info(me.id, null);
          const token = this.issue(me.id);
          this.h.audit(me.id, 'calfeed.on', me.id);
          return this.info(me.id, token);
        }
        if (this.revoke(me.id)) this.h.audit(me.id, 'calfeed.off', me.id);
        return this.info(me.id, null);
      }
      case 'cal.feed.reset': {
        if (me.role === 'bot') throw new CalFeedError('Integrations have no calendar.');
        const token = this.issue(me.id);
        this.h.audit(me.id, 'calfeed.reset', me.id);
        return this.info(me.id, token);
      }
    }
    return undefined;
  }

  /** Who a token belongs to, or null (unknown, reset, or the person can no longer use the office). */
  owner(token: string): PublicUser | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const r = this.h.db.prepare('SELECT user_id FROM cal_feeds WHERE token_hash = ?').get(sha(token)) as { user_id: string } | undefined;
    if (!r || !this.h.active(r.user_id)) return null;
    return this.h.userById(r.user_id);
  }

  /** Too many wrong addresses from one network: refuse for a while. */
  private limited(ip: string, add: boolean): boolean {
    const hour = Date.now() - 3600_000;
    const list = (this.fails.get(ip) ?? []).filter((t) => t > hour);
    if (add) list.push(Date.now());
    if (list.length) this.fails.set(ip, list); else this.fails.delete(ip);
    if (this.fails.size > 5000) this.fails = new Map([...this.fails].slice(-2500));
    return list.length >= FAILS_PER_HOUR;
  }

  /** The feed for a token: status and body (text/calendar), as the hub and the gateway serve it. */
  fetch(token: string, ip: string, now = Date.now()): { status: number; body: string; type: string } {
    const text = (status: number, body: string) => ({ status, body, type: 'text/plain; charset=utf-8' });
    if (this.limited(ip, false)) return text(429, 'Too many wrong calendar addresses from your network. Try again in an hour.\n');
    const user = this.owner(token);
    if (!user) { this.limited(ip, true); return text(404, 'This calendar address does not work any more. Make a new one in Dexterity Connect: Preferences → Calendar.\n'); }
    this.h.db.prepare('UPDATE cal_feeds SET last_fetched_at = ?, fetches = fetches + 1 WHERE user_id = ?').run(now, user.id);
    return { status: 200, body: this.build(user, now), type: 'text/calendar; charset=utf-8' };
  }

  /** The person's meetings: organised, invited to (not declined), or in one of their conversations. */
  build(user: PublicUser, now = Date.now()): string {
    const from = now - PAST_DAYS * DAY;
    const rows = this.h.db.prepare(`SELECT DISTINCT e.*, a.response FROM events e
      LEFT JOIN event_attendees a ON a.event_id = e.id AND a.user_id = ?
      LEFT JOIN conv_members cm ON cm.conv_id = e.conv_id AND cm.user_id = ?
      WHERE (e.organizer_id = ? OR a.user_id IS NOT NULL OR cm.user_id IS NOT NULL)
        AND (a.response IS NULL OR a.response != 'no')
        AND (e.end_at >= ? OR (e.recurrence != 'none' AND (e.until_at IS NULL OR e.until_at >= ?)))
      ORDER BY e.start_at LIMIT 3000`).all(user.id, user.id, user.id, from, from) as unknown as EventRow[];
    const people = new Map<string, PublicUser | null>();
    const person = (id: string) => { if (!people.has(id)) people.set(id, this.h.userById(id)); return people.get(id) ?? null; };
    const events: FeedEvent[] = [];
    for (const r of rows) {
      if (r.cancelled && (r.updated_at ?? r.created_at) < now - CANCELLED_DAYS * DAY) continue;
      const organizer = person(r.organizer_id);
      let link: string | null = null;
      let id: string | null = null;
      if (r.online && !r.cancelled && organizer) {
        try { id = this.h.meetingFor(organizer, r.id); } catch { id = null; }
        if (id) link = meetingLink(id);
      }
      const venue = r.venue_id ? this.h.venueName(r.venue_id) : null;
      const where = [venue, r.location].filter((x): x is string => !!x?.trim());
      if (link) where.push('Dexterity Connect');
      const description = [
        r.description?.trim() ?? '',
        link && id ? `Join in Dexterity Connect: ${link}\nMeeting ID: ${formatMeetingId(id)}` : '',
        organizer && organizer.id !== user.id ? `Organised by ${organizer.displayName}` : '',
      ].filter(Boolean).join('\n\n');
      events.push({
        uid: `${r.id}@dexconnect-${this.h.hubId()}`,
        title: r.title,
        startAt: r.start_at,
        endAt: r.end_at,
        allDay: !!r.all_day,
        recurrence: r.recurrence,
        until: r.recurrence === 'none' ? null : r.until_at,
        description: description || null,
        location: [...new Set(where)].join(' · ') || null,
        url: link,
        organizer: { name: organizer?.displayName ?? 'Former colleague', email: organizer?.profile.email ?? null, id: r.organizer_id },
        sequence: r.seq ?? 0,
        modifiedAt: r.updated_at ?? r.created_at,
        cancelled: !!r.cancelled,
        tentative: r.response === 'maybe',
      });
    }
    return buildCalendarFeed({ name: `${user.displayName} · ${this.h.office()}`, office: this.h.office(), events, stamp: now, maxLength: FEED_MAX_LENGTH });
  }

  /** GET (or HEAD) /cal/<token>.ics on the hub's own address. */
  route(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? '').split('?')[0];
    const m = CAL_FEED_PATH_RE.exec(path);
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
    req.resume();
    if (!m) { res.writeHead(404, { ...headers, 'content-type': 'text/plain; charset=utf-8' }); res.end('Not found\n'); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { ...headers, allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' }); res.end('Method not allowed\n'); return; }
    const out = this.fetch(m[1], String(req.headers['x-dex-remote-ip'] ?? req.socket.remoteAddress ?? ''));
    const etag = `"${crypto.createHash('sha256').update(out.body.replace(/^DTSTAMP:.*$/gm, '')).digest('base64url').slice(0, 27)}"`;
    if (out.status === 200 && req.headers['if-none-match'] === etag) { res.writeHead(304, { ...headers, etag }); res.end(); return; }
    res.writeHead(out.status, {
      ...headers, 'content-type': out.type, 'content-length': Buffer.byteLength(out.body),
      ...(out.status === 200 ? { etag, 'content-disposition': 'inline; filename="dexterity-connect.ics"' } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : out.body);
  }
}
