// Dexterity Meet's public face on the hub: every meeting's page on the office's meeting site
// (https://dexterity-meet.pages.dev/482-913-207, a name the host chose such as /p12-design-review,
// or a person's room such as /vikram), and what that page may learn.
//
// The page asks through the gateway (remote.ts, "w" frames with the ops page.info and page.check);
// nothing it asks reaches the rest of the hub. The rules, in docs/DEXTERITY-MEET.md:
// - Before a passcode, a page learns only what the host allowed: the date and time and "Meeting
//   with <office>"; the title and the host's first name only when "Show the title on the invitation
//   page" is on. Never people, emails, other ids, the hub's address, or other meetings.
// - Unknown names, meetings that ended or were cancelled, links turned off and wrong passcodes get
//   one answer each, the same for all of them.
// - A wrong passcode counts against the address (the gateway turns it away after a few, as for the
//   guest socket) and against the meeting, which slows its passcode checks for a minute after many.
// - Names are checked for uniqueness. A released name keeps leading only to the meeting it named,
//   and only its host can take it back, for 30 days; then anyone may.
import type { DatabaseSync } from 'node:sqlite';
import { MEET_ORG_DEFAULT, ROOM_OPENS_BEFORE_MS, SLUG_GRACE_MS, formatMeetingId, meetPageUrl, normalizeSlug, parseMeetRef, refSegment, slugProblem } from '@dex/core';
import type { LobbyRule, MeetPageDetails, MeetPageInfo, MeetPagePublic, MeetPageState, MeetPublicView, PublicUser, Recurrence, RoomInfo } from '@dex/core';
import { expand } from './calendar.ts';
import type { Meeting, Meetings } from './meetings.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meeting_slugs (
  slug TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  released_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_meeting_slugs_meeting ON meeting_slugs(meeting_id);
`;

const FOLLOW_UP_MAX = 280;
/** Wrong passcodes for one meeting in ten minutes before its checks pause for a minute. */
const MEETING_FAILS = 50;
const MEETING_FAIL_WINDOW = 10 * 60_000;
const MEETING_PAUSE = 60_000;
const DAY = 86_400_000;

export class PublicPageError extends Error {}

interface EventRow { id: string; start_at: number; end_at: number; recurrence: Recurrence; until_at: number | null; cancelled: number; time_zone: string | null; updated_at: number | null; all_day: number }
interface SlugRow { slug: string; meeting_id: string; owner_id: string; created_at: number; released_at: number | null }

export interface PublicHost {
  db: DatabaseSync;
  meetings: Meetings;
  /** The live Room of a meeting, if it runs. */
  live: (meetingId: string) => RoomInfo | null;
  userById: (id: string) => PublicUser | null;
  /** The meeting site's address (or the gateway's when no site is set), or null when neither is set up. */
  site: () => string | null;
  /** The office's name on the pages. */
  org: () => string;
  /** The office's time zone, noted beside the visitor's. */
  zone: () => string;
  /** The office allows guest links (Control room ▸ Meetings). */
  allowed: () => boolean;
  /** Access from outside is on (the gateway is set up). */
  gatewayOn: () => boolean;
  audit: (actor: string | null, action: string, target: string | null, meta?: Record<string, unknown>) => void;
  log: (level: 'info' | 'warn', msg: string, extra?: Record<string, unknown>) => void;
}

/** The answer the page gets for anything it may not learn about (the same body for every case). */
const NONE = { status: 404, body: { found: false } as MeetPageInfo };
const WRONG = { status: 403, body: { error: 'That passcode does not open a meeting at this address. Check the invitation.' } };

export class MeetPublic {
  private readonly h: PublicHost;
  private readonly fails = new Map<string, number[]>();
  private readonly paused = new Map<string, number>();

  constructor(host: PublicHost) {
    this.h = host;
    host.db.exec(SCHEMA);
    try { host.db.exec('ALTER TABLE meetings ADD COLUMN show_title INTEGER'); } catch { /* already there */ }
    try { host.db.exec('ALTER TABLE meetings ADD COLUMN follow_up TEXT'); } catch { /* already there */ }
  }

  // ---------------------------------------------------------------- names
  /** The meeting's current name, or null. */
  slugOf(meetingId: string): string | null {
    const r = this.h.db.prepare('SELECT slug FROM meeting_slugs WHERE meeting_id = ? AND released_at IS NULL').get(meetingId) as { slug: string } | undefined;
    return r?.slug ?? null;
  }

  private slugRow(slug: string): SlugRow | undefined {
    return this.h.db.prepare('SELECT * FROM meeting_slugs WHERE slug = ?').get(slug) as SlugRow | undefined;
  }

  /** A meeting that is over for good (cancelled, or a single meeting that ended): since when, or null. */
  private dormantSince(m: Meeting | null, now: number): number | null {
    if (!m) return 0;
    if (!m.eventId) return null;
    const ev = this.event(m.eventId);
    if (!ev) return 0;
    if (ev.cancelled) return ev.updated_at ?? ev.end_at;
    if (ev.recurrence === 'none') return ev.end_at < now ? ev.end_at : null;
    return ev.until_at !== null && ev.until_at < now ? ev.until_at : null;
  }

  /**
   * Can `meetingId` (hosted by `ownerId`) take this name? Taken by another meeting: no. Released,
   * or held by a meeting over for good, less than 30 days ago: only by the same host. Older: yes.
   */
  availability(slug: string, meetingId: string | null, ownerId: string, now = Date.now()): string | null {
    const problem = slugProblem(slug);
    if (problem) return problem;
    const r = this.slugRow(slug);
    if (!r || r.meeting_id === meetingId) return null;
    const since = r.released_at ?? this.dormantSince(this.h.meetings.get(r.meeting_id), now);
    if (since === null) return 'That name is taken. Try another.';
    if (now - since < SLUG_GRACE_MS && r.owner_id !== ownerId) {
      return `That name was used until recently. It is free again on ${new Date(since + SLUG_GRACE_MS).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.`;
    }
    return null;
  }

  /** Give a meeting a name (or none). The old name is released, not forgotten (see availability). */
  setSlug(m: Meeting, input: string | null, actorId: string, now = Date.now()): string | null {
    const current = this.slugOf(m.id);
    const slug = input === null || input.trim() === '' ? null : normalizeSlug(input);
    if (slug === current) return current;
    if (slug) {
      const problem = this.availability(slug, m.id, m.hostId, now);
      if (problem) throw new PublicPageError(problem);
    }
    this.h.db.exec('BEGIN');
    try {
      if (current) this.h.db.prepare('UPDATE meeting_slugs SET released_at = ? WHERE slug = ?').run(now, current);
      if (slug) {
        this.h.db.prepare(`INSERT INTO meeting_slugs (slug, meeting_id, owner_id, created_at, released_at) VALUES (?, ?, ?, ?, NULL)
          ON CONFLICT(slug) DO UPDATE SET meeting_id = excluded.meeting_id, owner_id = excluded.owner_id, created_at = excluded.created_at, released_at = NULL`).run(slug, m.id, m.hostId, now);
      }
      this.h.db.exec('COMMIT');
    } catch (err) { this.h.db.exec('ROLLBACK'); throw err; }
    this.h.audit(actorId, 'meeting.nameSet', m.id, { name: slug ?? '', was: current ?? '' });
    return slug;
  }

  /** A personal room's name: from the person's first name (then first and last, then a number), if free. */
  ensurePersonalSlug(m: Meeting, now = Date.now()): string | null {
    if (m.kind !== 'personal') return this.slugOf(m.id);
    const have = this.slugOf(m.id);
    if (have) return have;
    // a name released by this person's room (they cleared it) is not given back unasked
    if (this.h.db.prepare('SELECT 1 FROM meeting_slugs WHERE meeting_id = ?').get(m.id)) return null;
    const name = this.h.userById(m.hostId)?.displayName ?? '';
    const parts = normalizeSlug(name).split('-').filter((p) => /^[a-z][a-z0-9]*$/.test(p));
    const tries = parts.length ? [parts[0], parts.length > 1 ? `${parts[0]}-${parts[parts.length - 1]}` : '', ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${parts.length > 1 ? `${parts[0]}-${parts[parts.length - 1]}` : parts[0]}-${n}`)] : [];
    for (const t of tries) {
      if (!t || this.availability(t, m.id, m.hostId, now)) continue;
      try { return this.setSlug(m, t, m.hostId, now); } catch { /* taken meanwhile */ }
    }
    return null;
  }

  /** What a path names: a meeting, by its ID or its name (a released name only leads to its own meeting, for 30 days). */
  resolve(ref: unknown, now = Date.now()): Meeting | null {
    const r = parseMeetRef(typeof ref === 'string' ? ref : '');
    if (!r) return null;
    if (r.kind === 'id') return this.h.meetings.get(r.id);
    const row = this.slugRow(r.slug);
    if (!row) return null;
    if (row.released_at !== null && now - row.released_at >= SLUG_GRACE_MS) return null;
    return this.h.meetings.get(row.meeting_id);
  }

  /** The meeting ID a path names, for the webinar pages and sockets. */
  resolveId(ref: unknown): string | null { return this.resolve(ref)?.id ?? null; }

  // ---------------------------------------------------------------- settings
  private extra(m: Meeting): { showTitle: boolean; followUp: string | null } {
    const r = this.h.db.prepare('SELECT show_title, follow_up FROM meetings WHERE id = ?').get(m.id) as { show_title: number | null; follow_up: string | null } | undefined;
    // scheduled meetings show their title by default (invitations are sent to named people, and
    // the title is in their calendars already); instant meetings and personal rooms do not
    const def = m.kind === 'event' || m.kind === 'webinar';
    return { showTitle: r?.show_title === null || r?.show_title === undefined ? def : !!r.show_title, followUp: r?.follow_up ?? null };
  }

  view(m: Meeting): MeetPublicView {
    const site = this.h.site();
    const slug = m.kind === 'personal' ? this.ensurePersonalSlug(m) : this.slugOf(m.id);
    const allowed = this.h.allowed();
    const on = m.guest.enabled && allowed;
    const { showTitle, followUp } = this.extra(m);
    const problem = !allowed ? 'Your office has turned guest links off (Control room ▸ Meetings).'
      : !site || !this.h.gatewayOn() ? 'Guest links work through the internet gateway, which is not set up (Control room ▸ Outside the office).'
        : null;
    const ref = slug ?? m.id;
    return {
      meetingId: m.id, kind: m.kind, slug,
      url: site ? meetPageUrl(site, ref) : null,
      guestUrl: site && on && m.guest.passcode ? meetPageUrl(site, ref, m.guest.passcode) : null,
      idUrl: site ? meetPageUrl(site, m.id) : null,
      passcode: m.guest.passcode, enabled: on, showTitle, lobby: m.settings.lobby, followUp, site, problem,
    };
  }

  /** The address a calendar or an invitation shows for a meeting (no passcode), or null. */
  pageUrl(meetingId: string): string | null {
    const site = this.h.site();
    if (!site) return null;
    const m = this.h.meetings.get(meetingId);
    const slug = m?.kind === 'personal' ? this.ensurePersonalSlug(m) : this.slugOf(meetingId);
    return meetPageUrl(site, slug ?? meetingId);
  }

  set(m: Meeting, me: PublicUser, d: Record<string, unknown>): MeetPublicView {
    let next = m;
    if (d.slug !== undefined) {
      if (d.slug !== null && typeof d.slug !== 'string') throw new PublicPageError('A name is text.');
      this.setSlug(m, d.slug, me.id);
    }
    if (d.showTitle !== undefined) {
      if (typeof d.showTitle !== 'boolean') throw new PublicPageError('Show the title is on or off.');
      this.h.db.prepare('UPDATE meetings SET show_title = ? WHERE id = ?').run(d.showTitle ? 1 : 0, m.id);
    }
    if (d.followUp !== undefined) {
      const text = typeof d.followUp === 'string' ? d.followUp.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, FOLLOW_UP_MAX) : '';
      this.h.db.prepare('UPDATE meetings SET follow_up = ? WHERE id = ?').run(text || null, m.id);
    }
    if (d.lobby !== undefined) {
      if (!['off', 'outside', 'everyone'].includes(d.lobby as string)) throw new PublicPageError('Choose who waits in the lobby: nobody, people from outside, or everyone.');
      next = this.h.meetings.update(next, me, { lobby: d.lobby as LobbyRule });
    }
    if (d.enabled !== undefined || d.regenerate === true) {
      if (d.enabled === true && !this.h.allowed()) throw new PublicPageError('Your office has turned guest links off (Control room ▸ Meetings).');
      next = this.h.meetings.setGuest(next, typeof d.enabled === 'boolean' ? d.enabled : undefined, d.regenerate === true);
      this.h.audit(me.id, d.regenerate === true ? 'meeting.guestLinkRenewed' : next.guest.enabled ? 'meeting.guestLinkOn' : 'meeting.guestLinkOff', m.id, {});
    }
    if (d.showTitle !== undefined || d.followUp !== undefined) this.h.audit(me.id, 'meeting.pageSet', m.id, { showTitle: d.showTitle, followUp: d.followUp !== undefined });
    return this.view(this.h.meetings.get(m.id) ?? next);
  }

  // ---------------------------------------------------------------- the page's questions
  private event(eventId: string): EventRow | undefined {
    return this.h.db.prepare('SELECT id, start_at, end_at, recurrence, until_at, cancelled, time_zone, updated_at, all_day FROM events WHERE id = ?').get(eventId) as EventRow | undefined;
  }

  /** Where the meeting stands now, and the times to show. */
  private timing(m: Meeting, now: number): { state: MeetPageState; startAt: number | null; endAt: number | null; next: { startAt: number; endAt: number } | null; repeats: boolean; recurrence: Recurrence; zone: string; liveSince: number | null; opensAt: number | null } {
    const live = this.h.live(m.id);
    const zone = this.h.zone();
    const base = { startAt: null, endAt: null, next: null, repeats: false, recurrence: 'none' as Recurrence, zone, liveSince: live?.startedAt ?? null, opensAt: null };
    if (m.kind === 'personal') return { ...base, state: live ? 'live' : 'open' };
    // an instant meeting (or a conversation's Room) is open while its guest link is on: guests wait for the host
    if (!m.eventId) return { ...base, state: live ? 'live' : 'open' };
    const ev = this.event(m.eventId);
    if (!ev) return { ...base, state: 'ended' };
    const dur = Math.max(60_000, ev.end_at - ev.start_at);
    const occ = expand(ev, now - dur, now + 400 * DAY, 3);
    const cur = occ.find((o) => o.endAt > now) ?? null;
    const after = cur ? occ.find((o) => o.startAt > cur.startAt) ?? null : null;
    const shown = cur ?? (ev.recurrence === 'none' ? { startAt: ev.start_at, endAt: ev.end_at } : null);
    const t = { ...base, zone: ev.time_zone || zone, repeats: ev.recurrence !== 'none', recurrence: ev.recurrence, startAt: shown?.startAt ?? null, endAt: shown?.endAt ?? null, next: after };
    if (ev.cancelled) return { ...t, state: 'cancelled' };
    if (live) return { ...t, state: 'live' };
    if (!cur) return { ...t, state: 'ended' };
    const opens = cur.startAt - ROOM_OPENS_BEFORE_MS;
    return opens > now ? { ...t, state: 'upcoming', opensAt: opens } : { ...t, state: 'open' };
  }

  /** May this meeting have a public page now? (Guest link on, the office allows it, not a webinar.) */
  private published(m: Meeting | null): m is Meeting {
    return !!m && m.kind !== 'webinar' && m.guest.enabled && !!m.guest.passcode && this.h.allowed();
  }

  private firstName(userId: string): string {
    return this.h.userById(userId)?.displayName.trim().split(/\s+/)[0] || 'The host';
  }

  /** Before the passcode: only what the host allowed, for a meeting that is upcoming, open or live. */
  info(ref: unknown, now = Date.now()): { status: number; body: unknown } {
    const m = this.resolve(ref, now);
    if (!this.published(m)) return NONE;
    const t = this.timing(m, now);
    if (t.state === 'ended' || t.state === 'cancelled') return NONE;
    const { showTitle } = this.extra(m);
    const slug = this.slugOf(m.id);
    const body: MeetPagePublic = {
      found: true, id: m.id, ref: refSegment(slug ?? m.id),
      kind: m.kind === 'event' ? 'scheduled' : m.kind === 'personal' ? 'personal' : 'instant',
      org: this.h.org() || MEET_ORG_DEFAULT,
      title: showTitle ? m.title || null : null,
      host: showTitle ? this.firstName(m.hostId) : null,
      startAt: t.startAt, endAt: t.endAt, zone: t.zone, repeats: t.repeats,
      state: t.state, liveSince: t.state === 'live' ? t.liveSince : null, opensAt: t.opensAt,
    };
    return { status: 200, body };
  }

  /** Too many wrong passcodes for this meeting lately: its checks pause for a minute. */
  private meetingPaused(id: string, now: number): boolean {
    const until = this.paused.get(id) ?? 0;
    if (until > now) return true;
    if (until) this.paused.delete(id);
    return false;
  }

  /** A wrong passcode for a meeting (or a name that is not one): counted, and a flood pauses its checks. */
  private meetingFailed(id: string, ip: string, now: number): void {
    const list = (this.fails.get(id) ?? []).filter((t) => now - t < MEETING_FAIL_WINDOW);
    list.push(now);
    this.fails.set(id, list);
    if (this.fails.size > 5000) for (const [k, v] of this.fails) if (!v.some((t) => now - t < MEETING_FAIL_WINDOW)) this.fails.delete(k);
    if (list.length >= MEETING_FAILS && !this.meetingPaused(id, now)) {
      this.paused.set(id, now + MEETING_PAUSE);
      this.fails.set(id, []);
      this.h.audit(null, 'meeting.passcodeFlood', /^\d{9}$/.test(id) ? id : null, { wrong: MEETING_FAILS, minutes: MEETING_FAIL_WINDOW / 60_000, lastFrom: ip });
      this.h.log('warn', 'meeting page: many wrong passcodes, checks paused for a minute', { meeting: id });
    }
  }

  /** After the passcode: the meeting as its guests see it, whatever its state. Wrong passcode, unknown name, link off: one answer. */
  check(ref: unknown, passcode: unknown, ip: string, now = Date.now()): { status: number; body: unknown } {
    const m = this.resolve(ref, now);
    const key = m?.id ?? `ref:${String(ref).slice(0, 64)}`;
    if (this.meetingPaused(key, now)) return { status: 429, body: { error: 'Too many wrong passcodes were tried for this meeting. Wait a minute and try again.' } };
    if (!this.published(m) || !this.h.meetings.passcodeOk(m, passcode)) {
      this.meetingFailed(key, ip, now);
      this.h.log('info', 'meeting page: passcode refused', { ip, meeting: m ? formatMeetingId(m.id) : 'none' });
      return WRONG;
    }
    const t = this.timing(m, now);
    const { followUp } = this.extra(m);
    const slug = this.slugOf(m.id);
    const body: MeetPageDetails = {
      ok: true, id: m.id, ref: refSegment(slug ?? m.id),
      kind: m.kind === 'event' ? 'scheduled' : m.kind === 'personal' ? 'personal' : 'instant',
      org: this.h.org() || MEET_ORG_DEFAULT,
      title: m.title || (m.kind === 'personal' ? `${this.firstName(m.hostId)}'s room` : 'Meeting'),
      host: this.firstName(m.hostId),
      startAt: t.startAt, endAt: t.endAt, zone: t.zone, repeats: t.repeats, recurrence: t.recurrence,
      state: t.state, liveSince: t.state === 'live' ? t.liveSince : null, opensAt: t.opensAt, next: t.next,
      followUp,
    };
    return { status: 200, body };
  }

  /** Can a guest who gave the right passcode ask to join now? Null when yes, else why not (the guest page shows it). */
  joinProblem(m: Meeting, now = Date.now()): string | null {
    if (m.kind === 'webinar') return null;
    const t = this.timing(m, now);
    if (t.state === 'cancelled') return 'This meeting was cancelled.';
    if (t.state === 'ended') return 'This meeting has ended.';
    if (t.state === 'upcoming') return 'The room is not open yet: guests can ask to join from 10 minutes before the start.';
    return null;
  }

  /** A request from the meeting site, through the gateway. */
  request(op: string, ref: string, ip: string, body: Record<string, unknown>): { status: number; body: unknown } {
    if (op === 'page.info') return this.info(ref);
    if (op === 'page.check') return this.check(ref, body.passcode, ip);
    return { status: 404, body: { error: 'Not found' } };
  }
}
