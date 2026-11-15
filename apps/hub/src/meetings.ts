// Meetings: every Room is held under a meeting with a short ID (482-913-207) and a link
// (dexconnect://meet/482-913-207). A meeting is an instant meeting with a Space of its own, a
// person's standing personal room, a conversation's Room, or a Calendar event held as a call.
// This module keeps the records (IDs, settings, co-hosts) and the log of meetings that ended;
// the live Room (lobby, hands, host controls) is in rooms.ts.
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { PASSCODE_RE, formatMeetingId, guestUrl, isWebGuest, meetingLink, passcodeFrom } from '@dex/core';
import type { GuestLinkView, LobbyRule, MeetingInfo, MeetingKind, MeetingRecord, MeetingSettings, PublicUser, RoomInfo } from '@dex/core';
import type { Messaging } from './messaging.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  host_id TEXT NOT NULL,
  conv_id TEXT,
  event_id TEXT,
  co_hosts TEXT NOT NULL DEFAULT '[]',
  lobby TEXT NOT NULL DEFAULT 'outside',
  join_before_host INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meetings_conv ON meetings(conv_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_meetings_personal ON meetings(host_id) WHERE kind = 'personal';
CREATE UNIQUE INDEX IF NOT EXISTS idx_meetings_event ON meetings(event_id) WHERE event_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS meeting_log (
  room_id TEXT PRIMARY KEY,
  meeting_id TEXT,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  conv_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meeting_log_ended ON meeting_log(ended_at);
CREATE TABLE IF NOT EXISTS meeting_log_people (
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_meeting_log_people_user ON meeting_log_people(user_id);
`;

export class MeetingError extends Error {}

/** A meeting as the hub keeps it. */
export interface Meeting {
  id: string;
  kind: MeetingKind;
  title: string;
  hostId: string;
  convId: string | null;
  eventId: string | null;
  coHosts: string[];
  settings: MeetingSettings;
  /** The browser link for guests: on or off, and its passcode. */
  guest: { enabled: boolean; passcode: string | null };
}

interface Row { id: string; kind: MeetingKind; title: string; host_id: string; conv_id: string | null; event_id: string | null; co_hosts: string; lobby: LobbyRule; join_before_host: number; guest_on: number; guest_code: string | null }

/** Defaults the office sets for new meetings (Control room ▸ Policies ▸ Meetings). */
export interface MeetingDefaults { lobby: LobbyRule; joinBeforeHost: boolean }

const KINDS: MeetingKind[] = ['instant', 'personal', 'conversation', 'event', 'webinar'];
const LOBBY: LobbyRule[] = ['off', 'outside', 'everyone'];
const MAX_TITLE = 80;
const MAX_INVITE = 49;

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

export class Meetings {
  private readonly db: DatabaseSync;
  private readonly messaging: Messaging;
  private readonly userById: (id: string) => PublicUser | null;
  /** The office's defaults for new meetings. */
  defaults: () => MeetingDefaults = () => ({ lobby: 'outside', joinBeforeHost: true });
  /** A meeting's page on the meeting site (meet-public.ts), shown with it everywhere. */
  pageUrl: (meetingId: string) => string | null = () => null;

  constructor(db: DatabaseSync, messaging: Messaging, userById: (id: string) => PublicUser | null) {
    this.db = db;
    this.messaging = messaging;
    this.userById = userById;
    db.exec(SCHEMA);
    // M2: guest links for browsers
    try { db.exec('ALTER TABLE meetings ADD COLUMN guest_on INTEGER NOT NULL DEFAULT 0'); } catch { /* already there */ }
    try { db.exec('ALTER TABLE meetings ADD COLUMN guest_code TEXT'); } catch { /* already there */ }
  }

  private parse(r: Row | undefined): Meeting | null {
    if (!r || !KINDS.includes(r.kind)) return null;
    let coHosts: string[] = [];
    try { const v = JSON.parse(r.co_hosts) as unknown; if (Array.isArray(v)) coHosts = v.filter((x): x is string => typeof x === 'string').slice(0, 50); } catch { /* none */ }
    return {
      id: r.id, kind: r.kind, title: r.title, hostId: r.host_id, convId: r.conv_id, eventId: r.event_id, coHosts,
      settings: { lobby: LOBBY.includes(r.lobby) ? r.lobby : 'outside', joinBeforeHost: !!r.join_before_host },
      guest: { enabled: !!r.guest_on && !!r.guest_code, passcode: r.guest_code && PASSCODE_RE.test(r.guest_code) ? r.guest_code : null },
    };
  }

  get(id: unknown): Meeting | null {
    if (typeof id !== 'string' || !/^\d{9}$/.test(id)) return null;
    return this.parse(this.db.prepare('SELECT * FROM meetings WHERE id = ?').get(id) as Row | undefined);
  }

  /** A fresh nine-digit ID that is not in use (never starting with 0, so it reads the same everywhere). */
  private newId(): string {
    for (let i = 0; i < 50; i++) {
      const id = String(crypto.randomInt(100_000_000, 1_000_000_000));
      if (!this.db.prepare('SELECT 1 FROM meetings WHERE id = ?').get(id)) return id;
    }
    throw new MeetingError('No meeting ID is free. Try again.');
  }

  private insert(kind: MeetingKind, title: string, hostId: string, convId: string | null, eventId: string | null, settings: MeetingSettings): Meeting {
    const id = this.newId();
    this.db.prepare(`INSERT INTO meetings (id, kind, title, host_id, conv_id, event_id, lobby, join_before_host, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, kind, title, hostId, convId, eventId, settings.lobby, settings.joinBeforeHost ? 1 : 0, Date.now());
    return this.get(id)!;
  }

  info(m: Meeting, live: RoomInfo | null): MeetingInfo {
    return {
      id: m.id, kind: m.kind, title: m.title, hostId: m.hostId, convId: m.convId, eventId: m.eventId, coHosts: [...m.coHosts],
      settings: { ...m.settings }, link: meetingLink(m.id),
      live: live ? { roomId: live.id, participants: live.participants.length, startedAt: live.startedAt } : null,
      page: this.pageUrl(m.id),
    };
  }

  /** Settings from a request, on top of what a meeting has now. */
  static settings(input: unknown, base: MeetingSettings): MeetingSettings {
    const d = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    if (d.lobby !== undefined && !LOBBY.includes(d.lobby as LobbyRule)) throw new MeetingError('Choose who waits in the lobby: guests and people from outside, everyone, or only guests from a browser.');
    if (d.joinBeforeHost !== undefined && typeof d.joinBeforeHost !== 'boolean') throw new MeetingError('Join before the host is on or off.');
    return { lobby: (d.lobby as LobbyRule | undefined) ?? base.lobby, joinBeforeHost: (d.joinBeforeHost as boolean | undefined) ?? base.joinBeforeHost };
  }

  /** The meeting a conversation's Room is held under: its instant or personal meeting, or one made for it. */
  forConv(convId: string, starterId: string): Meeting {
    const rows = this.db.prepare('SELECT * FROM meetings WHERE conv_id = ? ORDER BY created_at').all(convId) as unknown as Row[];
    const own = rows.map((r) => this.parse(r)).filter((m): m is Meeting => !!m);
    const found = own.find((m) => m.kind === 'instant' || m.kind === 'personal' || m.kind === 'webinar') ?? own.find((m) => m.kind === 'conversation');
    if (found) return found;
    return this.insert('conversation', '', starterId, convId, null, this.defaults());
  }

  /** An instant meeting: a private Space of its own, with the people invited in it. */
  createInstant(me: PublicUser, titleIn: unknown, invite: unknown, settingsIn: unknown): Meeting {
    if (me.role === 'guest' || me.role === 'bot') throw new MeetingError('Only members of the office can start meetings.');
    const title = clean(titleIn, MAX_TITLE);
    const known = new Set((Array.isArray(invite) ? invite : []).filter((x): x is string => typeof x === 'string' && x !== me.id));
    if (known.size > MAX_INVITE) throw new MeetingError(`Invite up to ${MAX_INVITE} people; share the meeting's link with more.`);
    const members = [...known].filter((u) => { const p = this.userById(u); return !!p && p.role !== 'bot'; });
    const settings = Meetings.settings(settingsIn, this.defaults());
    const id = this.newId();
    const name = this.freeSpaceName(title ? `${title.slice(0, 44)} · ${formatMeetingId(id)}` : `Meeting ${formatMeetingId(id)}`, id);
    const conv = this.messaging.handle('conv.create', me, { kind: 'space', name, topic: `Meeting ${formatMeetingId(id)}, started by ${me.displayName}`, private: true, members }) as { id: string };
    this.db.prepare(`INSERT INTO meetings (id, kind, title, host_id, conv_id, event_id, lobby, join_before_host, created_at) VALUES (?, 'instant', ?, ?, ?, NULL, ?, ?, ?)`)
      .run(id, title || `${me.displayName.split(' ')[0]}'s meeting`, me.id, conv.id, settings.lobby, settings.joinBeforeHost ? 1 : 0, Date.now());
    return this.get(id)!;
  }

  /**
   * A webinar (M3): the organiser runs it, the panelists are on the stage, and a private Space of
   * the organiser and panelists is their backstage (its chat, files, and the practice session).
   * Attendees are never members: they watch (webinars.ts).
   */
  createWebinar(me: PublicUser, titleIn: unknown, panelists: string[]): Meeting {
    if (me.role === 'guest' || me.role === 'bot') throw new MeetingError('Only members of the office can run webinars.');
    const title = clean(titleIn, MAX_TITLE);
    if (!title) throw new MeetingError('Give the webinar a title.');
    const id = this.newId();
    const name = this.freeSpaceName(`${title.slice(0, 40)} · backstage`, id);
    const conv = this.messaging.handle('conv.create', me, { kind: 'space', name, topic: `Webinar ${formatMeetingId(id)}: the organiser and panelists`, private: true, members: panelists }) as { id: string };
    this.db.prepare(`INSERT INTO meetings (id, kind, title, host_id, conv_id, event_id, lobby, join_before_host, created_at) VALUES (?, 'webinar', ?, ?, ?, NULL, 'off', 1, ?)`)
      .run(id, title, me.id, conv.id, Date.now());
    return this.get(id)!;
  }

  private freeSpaceName(want: string, id: string): string {
    const taken = (n: string) => !!this.messaging.spaceByName(n);
    if (!taken(want)) return want;
    const alt = `${want.slice(0, 46)} ${formatMeetingId(id)}`;
    return taken(alt) ? `Meeting ${id}` : alt;
  }

  /** A person's standing room (its Space is made the first time it is used). */
  personal(me: PublicUser): Meeting {
    const row = this.db.prepare(`SELECT * FROM meetings WHERE kind = 'personal' AND host_id = ?`).get(me.id) as Row | undefined;
    if (row) return this.parse(row)!;
    if (me.role === 'guest' || me.role === 'bot') throw new MeetingError('Only members of the office have a personal room.');
    return this.insert('personal', `${me.displayName}'s room`, me.id, null, null, { lobby: this.defaults().lobby, joinBeforeHost: false });
  }

  /** The meeting a Calendar event held as a call takes place in. */
  forEvent(me: PublicUser, eventId: unknown): Meeting {
    if (typeof eventId !== 'string') throw new MeetingError('Meeting not found.');
    const ev = this.db.prepare('SELECT id, title, organizer_id, conv_id, online, cancelled FROM events WHERE id = ?').get(eventId) as { id: string; title: string; organizer_id: string; conv_id: string | null; online: number; cancelled: number } | undefined;
    if (!ev || !this.seesEvent(ev, me.id)) throw new MeetingError('Meeting not found.');
    if (ev.cancelled) throw new MeetingError('This meeting was cancelled.');
    if (!ev.online) throw new MeetingError('This meeting is not held as a call.');
    const row = this.db.prepare('SELECT * FROM meetings WHERE event_id = ?').get(ev.id) as Row | undefined;
    if (row) {
      // keep the title and conversation in step with the Calendar
      if (row.title !== ev.title || (ev.conv_id && row.conv_id !== ev.conv_id)) {
        this.db.prepare('UPDATE meetings SET title = ?, conv_id = COALESCE(?, conv_id) WHERE id = ?').run(ev.title, ev.conv_id, row.id);
        return this.get(row.id)!;
      }
      return this.parse(row)!;
    }
    return this.insert('event', ev.title, ev.organizer_id, ev.conv_id, ev.id, this.defaults());
  }

  private seesEvent(ev: { id: string; organizer_id: string; conv_id: string | null }, userId: string): boolean {
    return ev.organizer_id === userId || this.attends(ev.id, userId) || (!!ev.conv_id && this.messaging.isMember(ev.conv_id, userId));
  }

  private attends(eventId: string, userId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM event_attendees WHERE event_id = ? AND user_id = ?').get(eventId, userId);
  }

  /** How many people a meeting expects (a Calendar meeting's invitations), to choose PC-to-PC or the relay. */
  expected(m: Meeting): number {
    if (!m.eventId) return 0;
    return (this.db.prepare('SELECT COUNT(*) AS n FROM event_attendees WHERE event_id = ?').get(m.eventId) as { n: number }).n;
  }

  /** Inside the meeting: its host, a member of its conversation, or invited to its Calendar event. */
  insider(m: Meeting, userId: string): boolean {
    if (m.hostId === userId) return true;
    if (m.convId && this.messaging.isMember(m.convId, userId)) return true;
    return !!m.eventId && this.attends(m.eventId, userId);
  }

  /** The meeting's conversation, made the first time it is needed (a personal room, a Calendar meeting without one). */
  ensureConv(m: Meeting): string {
    if (m.convId) return m.convId;
    const host = this.userById(m.hostId);
    if (!host) throw new MeetingError('The person who runs this meeting has left the office.');
    let convId: string;
    const invited = m.eventId ? (this.db.prepare('SELECT user_id FROM event_attendees WHERE event_id = ? AND user_id != ?').all(m.eventId, m.hostId) as Array<{ user_id: string }>).map((r) => r.user_id).filter((u) => !!this.userById(u)) : [];
    if (m.kind === 'event' && invited.length && invited.length < 50) {
      convId = (this.messaging.handle('conv.create', host, { kind: 'direct', members: invited }) as { id: string }).id;
    } else {
      const name = this.freeSpaceName(m.kind === 'personal' ? `${host.displayName}'s room` : `${m.title.slice(0, 44)} · ${formatMeetingId(m.id)}`, m.id);
      convId = (this.messaging.handle('conv.create', host, { kind: 'space', name, topic: `Meeting ${formatMeetingId(m.id)}`, private: true, members: invited }) as { id: string }).id;
    }
    this.db.prepare('UPDATE meetings SET conv_id = ? WHERE id = ?').run(convId, m.id);
    m.convId = convId;
    return convId;
  }

  /** Someone came in by the meeting's ID: an instant meeting or personal room adds them to its Space (its chat, polls, board and files). */
  admitted(m: Meeting, userId: string): void {
    // guests from a browser have no account: they never join a conversation
    if (isWebGuest(userId)) return;
    if ((m.kind === 'instant' || m.kind === 'personal') && m.convId) this.messaging.ensureMember(m.convId, userId);
  }

  update(m: Meeting, me: PublicUser, d: Record<string, unknown>): Meeting {
    const settings = Meetings.settings(d, m.settings);
    const title = d.title === undefined ? m.title : clean(d.title, MAX_TITLE);
    if (!title && m.kind !== 'conversation') throw new MeetingError('Give the meeting a title.');
    void me;
    this.db.prepare('UPDATE meetings SET title = ?, lobby = ?, join_before_host = ? WHERE id = ?').run(title, settings.lobby, settings.joinBeforeHost ? 1 : 0, m.id);
    return this.get(m.id)!;
  }

  // ---------------------------------------------------------------- guest links (M2)
  /** Turn the browser link on or off, or give it a new passcode (the old link stops working). */
  setGuest(m: Meeting, enabled: boolean | undefined, regenerate: boolean): Meeting {
    let code = m.guest.passcode;
    if (regenerate || (enabled && !code)) code = passcodeFrom(crypto.randomBytes(48), 8);
    const on = enabled === undefined ? m.guest.enabled : enabled;
    this.db.prepare('UPDATE meetings SET guest_on = ?, guest_code = ? WHERE id = ?').run(on ? 1 : 0, code, m.id);
    return this.get(m.id)!;
  }

  /** Does this passcode open the meeting's guest link? (Compared in constant time.) */
  passcodeOk(m: Meeting, code: unknown): boolean {
    if (!m.guest.enabled || !m.guest.passcode || typeof code !== 'string' || !PASSCODE_RE.test(code)) return false;
    const a = crypto.createHash('sha256').update(m.guest.passcode).digest();
    const b = crypto.createHash('sha256').update(code).digest();
    return crypto.timingSafeEqual(a, b);
  }

  /** What a host sees about the guest link. */
  guestView(m: Meeting, opts: { gateway: string | null; allowed: boolean; relayOnly: boolean }): GuestLinkView {
    const problem = !opts.allowed ? 'Your office has turned guest links off (Control room ▸ Policies ▸ Meetings).'
      : !opts.gateway ? 'Guest links work through the internet gateway, which is not set up (Control room ▸ Outside the office).'
        : opts.relayOnly ? 'This meeting runs on the office relay (more than 8 people), which browsers outside the office cannot reach. Guests can join meetings of up to 8.'
          : null;
    const on = m.guest.enabled && opts.allowed;
    return {
      meetingId: m.id, enabled: on, passcode: m.guest.passcode, allowed: opts.allowed, problem, relayOnly: opts.relayOnly,
      url: on && opts.gateway && m.guest.passcode ? guestUrl(opts.gateway, m.id, m.guest.passcode) : null,
    };
  }

  setCoHosts(m: Meeting, ids: string[]): void {
    m.coHosts = [...new Set(ids)].slice(0, 50);
    this.db.prepare('UPDATE meetings SET co_hosts = ? WHERE id = ?').run(JSON.stringify(m.coHosts), m.id);
  }

  /** A Room ended: remember who was in it and for how long. */
  log(room: RoomInfo, m: Meeting | null, title: string, people: string[], durationMs: number, endedAt = Date.now()): void {
    this.db.prepare(`INSERT OR IGNORE INTO meeting_log (room_id, meeting_id, title, kind, conv_id, host_id, started_at, ended_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(room.id, m?.id ?? null, title, m?.kind ?? 'conversation', room.convId, room.hostId ?? room.startedBy, room.startedAt, endedAt, Math.max(0, Math.round(durationMs)));
    const ins = this.db.prepare('INSERT OR IGNORE INTO meeting_log_people (room_id, user_id) VALUES (?, ?)');
    for (const u of new Set(people)) ins.run(room.id, u);
  }

  /** Meetings someone was in, newest first. */
  recent(userId: string, limit: unknown): MeetingRecord[] {
    const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 30;
    const rows = this.db.prepare(`SELECT l.* FROM meeting_log l JOIN meeting_log_people p ON p.room_id = l.room_id
      WHERE p.user_id = ? ORDER BY l.ended_at DESC LIMIT ?`).all(userId, n) as Array<{ room_id: string; meeting_id: string | null; title: string; kind: MeetingKind; conv_id: string; host_id: string; started_at: number; ended_at: number; duration_ms: number }>;
    const who = this.db.prepare('SELECT user_id FROM meeting_log_people WHERE room_id = ? ORDER BY rowid');
    return rows.map((r) => ({
      roomId: r.room_id, meetingId: r.meeting_id, title: r.title, kind: r.kind, convId: r.conv_id, hostId: r.host_id,
      startedAt: r.started_at, endedAt: r.ended_at, durationMs: r.duration_ms,
      people: (who.all(r.room_id) as Array<{ user_id: string }>).map((p) => p.user_id),
    }));
  }
}
