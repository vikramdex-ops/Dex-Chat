// Webinars (meetings, phase M3). A webinar is a meeting of kind 'webinar': its organiser (the
// meeting's host, with co-hosts) and panelists meet in a PC-to-PC Room, the stage; attendees
// never enter that Room. One PC on the stage, the broadcaster (an organiser's, on the office
// network when one is), composes the stage into a single picture and sound, and that one stream
// goes out three ways:
//   - to attendees on the office network through the hub's relay (mediasoup): two tracks each,
//     so hundreds of attendees cost the office little;
//   - straight from the broadcaster to viewers the relay cannot reach (browsers through the
//     gateway, the app outside the office), through TURN, at most 25 of them; past that,
//     viewers are told plainly that the webinar is full outside the office (they still ask
//     questions and answer polls, and see the live stream's page when there is one);
//   - to a live-streaming service: the broadcaster records the stage in one-second pieces, and
//     the hub hands them to ffmpeg, which sends RTMP (webinar-stream.ts).
// This module keeps the webinar's records (registration, registrants, questions, polls,
// handouts, the follow-up and its survey, attendance) and its live state (the audience, routes,
// hands, reactions, who was invited to speak). People outside the office register through the
// gateway (webRequest) and watch with a personal link (webWatch, through meet-guests.ts).
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  EMAIL_RE, HANDOUTS_MAX, MEETING_REACTIONS, REG_TOKEN_RE, WEBINAR_ANSWER_MAX, WEBINAR_AUDIENCE_MAX, WEBINAR_DIRECT_VIEWERS, WEBINAR_MAX_PANELISTS,
  WEBINAR_QUESTION_MAX, WEBINAR_REGISTRATION_MAX, checkAnswers, cleanEmail, cleanFields, cleanName, isWebGuest, passcodeFrom, ulid,
  webinarFollowUp, webinarFollowUpMessage, webinarInvitation, webinarRegisterUrl, webinarSurveyUrl, webinarWatchUrl,
} from '@dex/core';
import type {
  AudienceMember, FieldAnswers, Handout, IceServer, PublicUser, Registrant, RoomInfo, StageRoute, StreamStatus, WebinarCard, WebinarDown, WebinarField,
  WebinarInfo, WebinarLive, WebinarMail, WebinarMailInput, WebinarPoll, WebinarPublic, WebinarQuestion, WebinarReport, WebinarRole, WebinarSettings,
  WebinarState, WebinarUpdate,
} from '@dex/core';
import type { Meeting, Meetings } from './meetings.ts';
import { MeetingError } from './meetings.ts';
import type { Rooms } from './rooms.ts';
import { RoomError } from './rooms.ts';
import type { Messaging } from './messaging.ts';
import type { FileStore } from './files.ts';
import { sumIntervals } from './meet-reports.ts';
import { LiveStream, OFF_STATUS, RTMP_RE, STREAM_KEY_RE, findFfmpeg, forgetFfmpeg, streamTarget } from './webinar-stream.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS webinars (
  meeting_id TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  starts_at INTEGER NOT NULL,
  duration_min INTEGER NOT NULL,
  settings TEXT NOT NULL,
  fields TEXT NOT NULL DEFAULT '[]',
  survey TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'scheduled',
  went_live_at INTEGER,
  ended_at INTEGER,
  room_id TEXT,
  stream_url TEXT,
  stream_key TEXT,
  watch_url TEXT,
  followup_at INTEGER,
  peak INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS webinar_registrants (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  answers TEXT NOT NULL,
  status TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  ip TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_webinar_reg_email ON webinar_registrants(meeting_id, email);
CREATE TABLE IF NOT EXISTS webinar_attendance (
  meeting_id TEXT NOT NULL,
  voter TEXT NOT NULL,
  registrant_id TEXT,
  name TEXT NOT NULL,
  office INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  left_at INTEGER,
  hands INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_webinar_att ON webinar_attendance(meeting_id);
CREATE TABLE IF NOT EXISTS webinar_questions (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  author TEXT NOT NULL,
  author_name TEXT NOT NULL,
  anonymous INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  answer TEXT,
  answered_by TEXT,
  answered_at INTEGER,
  pinned INTEGER NOT NULL DEFAULT 0,
  on_stage INTEGER NOT NULL DEFAULT 0,
  votes INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_webinar_q ON webinar_questions(meeting_id);
CREATE TABLE IF NOT EXISTS webinar_votes (question_id TEXT NOT NULL, voter TEXT NOT NULL, PRIMARY KEY (question_id, voter));
CREATE TABLE IF NOT EXISTS webinar_polls (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  question TEXT NOT NULL,
  options TEXT NOT NULL,
  multi INTEGER NOT NULL,
  show_results INTEGER NOT NULL,
  open INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webinar_polls ON webinar_polls(meeting_id);
CREATE TABLE IF NOT EXISTS webinar_poll_answers (poll_id TEXT NOT NULL, voter TEXT NOT NULL, name TEXT NOT NULL, choices TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (poll_id, voter));
CREATE TABLE IF NOT EXISTS webinar_handouts (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, file_id TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL, added_by TEXT NOT NULL, added_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_webinar_handouts ON webinar_handouts(meeting_id);
CREATE TABLE IF NOT EXISTS webinar_downloads (handout_id TEXT NOT NULL, voter TEXT NOT NULL, name TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS webinar_survey_answers (meeting_id TEXT NOT NULL, voter TEXT NOT NULL, name TEXT NOT NULL, answers TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (meeting_id, voter));
`;

export class WebinarError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export interface WebinarHost {
  db: DatabaseSync;
  meetings: Meetings;
  rooms: Rooms;
  messaging: Messaging;
  files: FileStore;
  userById(id: string): PublicUser | null;
  deliverToUsers(userIds: string[], name: string, data: unknown): void;
  /** To one device: an app's connection, or a browser attendee through the gateway. */
  deliverToDevice(deviceId: string, name: string, data: unknown): void;
  /** The device is connected through the internet gateway (it cannot reach the relay). */
  isRemote(deviceId: string): boolean;
  relayAvailable(): boolean;
  relayLeave(deviceId: string): void;
  relayClose(roomId: string): void;
  /** The gateway's address when outside access is on. */
  gateway(): string | null;
  office(): string;
  /** A Direct message from the system bot. */
  tell(userId: string, text: string, key: string): void;
  /** Turn a recording's office link on and return it (the person must be allowed to share it). */
  recordingLink(me: PublicUser, recordingId: string): string;
  iceServers(): Promise<IceServer[]>;
  audit(actorId: string | null, action: string, target: string | null, meta?: Record<string, unknown>): void;
  ffmpegPath(): string | null;
  setFfmpegPath(path: string | null): void;
  log(level: 'info' | 'warn', msg: string, extra?: Record<string, unknown>): void;
}

interface Row {
  meeting_id: string; description: string; starts_at: number; duration_min: number; settings: string; fields: string; survey: string; state: WebinarState;
  went_live_at: number | null; ended_at: number | null; room_id: string | null; stream_url: string | null; stream_key: string | null; watch_url: string | null;
  followup_at: number | null; peak: number; created_at: number;
}
interface RegRow { id: string; meeting_id: string; name: string; email: string; answers: string; status: Registrant['status']; token: string; ip: string | null; created_at: number; decided_at: number | null; decided_by: string | null }
interface QRow { id: string; meeting_id: string; author: string; author_name: string; anonymous: number; text: string; created_at: number; status: WebinarQuestion['status']; answer: string | null; answered_by: string | null; answered_at: number | null; pinned: number; on_stage: number; votes: number }
interface PollRow { id: string; meeting_id: string; question: string; options: string; multi: number; show_results: number; open: number; created_at: number }

/** Someone watching: an office device, or a browser attendee with their personal link. */
interface Viewer {
  deviceId: string;
  userId: string;
  /** Who votes and answers: an office person's id, or reg:<registrant> (stable across reconnects). */
  voter: string;
  name: string;
  registrantId: string | null;
  web: boolean;
  remote: boolean;
  route: StageRoute;
  since: number;
  /** When their hand went up, or 0. */
  hand: number;
  invited: boolean;
  attendance: number | bigint;
}

interface Pass { name: string; registrantId: string | null; voter: string; expires: number }

interface Live {
  id: string;
  viewers: Map<string, Viewer>;
  /** People the organiser invited to speak who accepted (they may enter the stage's Room). */
  speakers: Set<string>;
  /** Browser speakers: their session's user id, back to the registrant. */
  speakerOf: Map<string, Pass>;
  broadcaster: string | null;
  roomId: string | null;
  reactions: Record<string, number>;
  dirty: boolean;
  audienceDirty: boolean;
  changed: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  lastFlush: number;
  stream: LiveStream | null;
  streamOn: boolean;
  /** Bumped to have the broadcaster record afresh (ffmpeg needs a WebM stream from its start). */
  streamEpoch: number;
  retries: number;
  streamStatus: StreamStatus;
  passes: Map<string, Pass>;
  lastViewers: string;
}

const DEFAULT_SETTINGS: WebinarSettings = { approval: 'auto', cap: 500, registrationOpen: true, anonymousQuestions: true, listed: false };
const parse = <T>(s: string | null, fallback: T): T => { try { return s ? JSON.parse(s) as T : fallback; } catch { return fallback; } };
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max) : '');

/** A small sliding-window limiter: true when the key may act now. */
class Limiter {
  private readonly hits = new Map<string, number[]>();
  allow(key: string, max: number, windowMs: number, now = Date.now()): boolean {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= max) { this.hits.set(key, list); return false; }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (!v.length || now - v[v.length - 1] > windowMs) this.hits.delete(k);
    return true;
  }
}

export class Webinars {
  private readonly host: WebinarHost;
  private readonly db: DatabaseSync;
  private readonly lives = new Map<string, Live>();
  private readonly byDevice = new Map<string, string>();
  private readonly limits = new Limiter();

  constructor(host: WebinarHost) {
    this.host = host;
    this.db = host.db;
    this.db.exec(SCHEMA);
    // webinars that were on when the hub stopped: their stage is gone
    const now = Date.now();
    this.db.prepare(`UPDATE webinars SET state = 'ended', ended_at = ? WHERE state = 'live'`).run(now);
    this.db.prepare(`UPDATE webinars SET state = 'scheduled' WHERE state = 'practice'`).run();
    this.db.prepare('UPDATE webinar_attendance SET left_at = joined_at WHERE left_at IS NULL').run();
    // handouts are kept while their webinar is
    host.files.keep.push('NOT EXISTS (SELECT 1 FROM webinar_handouts h WHERE h.file_id = f.id)');
  }

  // ---------------------------------------------------------------- records and roles
  private row(id: string): Row | null {
    return (this.db.prepare('SELECT * FROM webinars WHERE meeting_id = ?').get(id) as Row | undefined) ?? null;
  }

  private need(id: unknown): { m: Meeting; row: Row } {
    const m = typeof id === 'string' ? this.host.meetings.get(id.replace(/\D/g, '')) : null;
    const row = m?.kind === 'webinar' ? this.row(m.id) : null;
    if (!m || !row) throw new WebinarError('No webinar has that ID.', 404);
    return { m, row };
  }

  isHost(m: Meeting, userId: string): boolean { return m.hostId === userId || m.coHosts.includes(userId); }
  isPanelist(m: Meeting, userId: string): boolean { return !!m.convId && this.host.messaging.isMember(m.convId, userId); }
  private staff(m: Meeting, userId: string): boolean { return this.isHost(m, userId) || this.isPanelist(m, userId); }

  /** May this person be in the stage's Room (rooms.ts asks)? */
  onStage(m: Meeting, userId: string): boolean {
    return this.staff(m, userId) || !!this.lives.get(m.id)?.speakers.has(userId);
  }

  private role(m: Meeting, userId: string): WebinarRole {
    return this.isHost(m, userId) ? 'organizer' : this.isPanelist(m, userId) ? 'panelist' : 'attendee';
  }

  private hostOnly(id: unknown, me: PublicUser): { m: Meeting; row: Row } {
    const r = this.need(id);
    if (!this.isHost(r.m, me.id)) throw new WebinarError('Only the organiser can do that.', 403);
    return r;
  }

  private staffOnly(id: unknown, me: PublicUser): { m: Meeting; row: Row } {
    const r = this.need(id);
    if (!this.staff(r.m, me.id)) throw new WebinarError('Only the organiser and panelists can do that.', 403);
    return r;
  }

  private settings(row: Row): WebinarSettings { return { ...DEFAULT_SETTINGS, ...parse<Partial<WebinarSettings>>(row.settings, {}) }; }
  private fields(row: Row): WebinarField[] { return parse<WebinarField[]>(row.fields, []); }
  private survey(row: Row): WebinarField[] { return parse<WebinarField[]>(row.survey, []); }
  private panelists(m: Meeting): string[] { return m.convId ? this.host.messaging.members(m.convId).filter((u) => u !== m.hostId) : []; }
  private nameOf(userId: string): string { return this.host.userById(userId)?.displayName ?? 'Someone'; }

  private live(id: string): Live {
    let w = this.lives.get(id);
    if (!w) {
      w = {
        id, viewers: new Map(), speakers: new Set(), speakerOf: new Map(), broadcaster: null, roomId: null, reactions: {}, dirty: false, audienceDirty: false,
        changed: new Set(), timer: null, lastFlush: 0, stream: null, streamOn: false, streamEpoch: 0, retries: 0, streamStatus: { ...OFF_STATUS }, passes: new Map(), lastViewers: '',
      };
      this.lives.set(id, w);
    }
    return w;
  }

  private counts(id: string): WebinarInfo['registrants'] {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM webinar_registrants WHERE meeting_id = ? GROUP BY status').all(id) as Array<{ status: string; n: number }>;
    const get = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
    return { total: rows.reduce((a, r) => a + r.n, 0), approved: get('approved'), pending: get('pending'), rejected: get('rejected') };
  }

  info(m: Meeting, row: Row, me: PublicUser): WebinarInfo {
    const gw = this.host.gateway();
    const s = this.settings(row);
    return {
      meetingId: m.id, title: m.title, description: row.description, startsAt: row.starts_at, durationMin: row.duration_min, hostId: m.hostId, coHosts: [...m.coHosts],
      panelists: this.panelists(m), convId: m.convId, settings: s, fields: this.fields(row), survey: this.survey(row), state: row.state,
      wentLiveAt: row.went_live_at, endedAt: row.ended_at, roomId: row.room_id, registrants: this.counts(m.id),
      registerUrl: gw ? webinarRegisterUrl(gw, m.id) : null,
      problem: !gw ? 'People outside the office register through the internet gateway, which is not on (Control room ▸ Outside the office).' : !s.registrationOpen ? 'Registration is closed.' : null,
      stream: { url: row.stream_url, keyHint: row.stream_key ? `••••${row.stream_key.slice(-4)}` : null, watchUrl: row.watch_url },
      followUpAt: row.followup_at, role: this.role(m, me.id),
    };
  }

  // ---------------------------------------------------------------- the ops
  async handle(op: string, me: PublicUser, deviceId: string, d: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.handleOp(op, me, deviceId, d);
    } catch (err) {
      if (err instanceof MeetingError || err instanceof RoomError) throw new WebinarError(err.message);
      throw err;
    }
  }

  private async handleOp(op: string, me: PublicUser, deviceId: string, d: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case 'web.create': return this.create(me, d);
      case 'web.update': return this.update(me, d);
      case 'web.get': { const { m, row } = this.staffOnly(d.id, me); return this.info(m, row, me); }
      case 'web.list': return this.list(me);
      case 'web.state': return this.setState(me, deviceId, d);
      case 'web.registrants': { const { m } = this.hostOnly(d.id, me); return this.registrants(m.id); }
      case 'web.decide': return this.decide(me, d);
      case 'web.mail': return this.mail(me, d);
      case 'web.watch': return this.watch(me, deviceId, d);
      case 'web.leave': { this.leaveDevice(deviceId); return { ok: true }; }
      case 'web.hand': return this.hand(me, deviceId, d);
      case 'web.react': return this.react(me, deviceId, d);
      case 'web.questions': {
        const { m } = this.need(d.id);
        const staff = this.staff(m, me.id);
        if (!staff && !this.viewerOf(deviceId, m.id)) throw new WebinarError('Join the webinar first.');
        return this.questions(m.id, staff ? me.id : this.viewerOf(deviceId, m.id)!.voter, staff);
      }
      case 'web.ask': return this.ask(me, deviceId, d);
      case 'web.vote': return this.vote(me, deviceId, d);
      case 'web.answer': return this.answer(me, d);
      case 'web.moderate': return this.moderate(me, d);
      case 'web.poll.launch': return this.launchPoll(me, d);
      case 'web.poll.vote': return this.pollVote(me, deviceId, d);
      case 'web.poll.close': return this.closePoll(me, d);
      case 'web.polls': { const { m } = this.staffOnly(d.id, me); return this.polls(m.id, me.id, true); }
      case 'web.handout.add': return this.addHandout(me, d);
      case 'web.handout.remove': return this.removeHandout(me, d);
      case 'web.handout.open': return this.openHandout(me, deviceId, d);
      case 'web.audience': { const { m } = this.staffOnly(d.id, me); return this.audience(m.id); }
      case 'web.promote': return this.promote(me, d);
      case 'web.promoteAnswer': return this.promoteAnswer(me, deviceId, d);
      case 'web.demote': return this.demote(me, d);
      case 'web.signal': return this.signal(deviceId, d);
      case 'web.stream.set': return this.setStream(me, d);
      case 'web.stream.start': return this.startStream(me, d);
      case 'web.stream.stop': { const { m } = this.hostOnly(d.id, me); return this.stopStream(m.id, me.id); }
      case 'web.stream.status': { const { m } = this.staffOnly(d.id, me); return this.lives.get(m.id)?.streamStatus ?? { ...OFF_STATUS }; }
      case 'web.stream.chunk': return this.chunk(deviceId, d);
      case 'web.ffmpeg': return this.ffmpeg(me, d);
      case 'web.followup': return this.followUp(me, d);
      case 'web.survey': return this.surveyFor(me, d);
      case 'web.survey.answer': return this.answerSurvey(me, d);
      case 'web.report': {
        const { m } = this.need(d.id);
        if (!this.staff(m, me.id) && me.role !== 'owner' && me.role !== 'admin') throw new WebinarError('Only the organiser, panelists and administrators see the report.', 403);
        return this.report(m.id);
      }
    }
    return undefined;
  }

  // ---------------------------------------------------------------- planning
  private time(v: unknown, label: string): number {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < Date.now() - 86_400_000 || v > Date.now() + 2 * 365 * 86_400_000) throw new WebinarError(`Choose ${label}.`);
    return Math.round(v);
  }
  private duration(v: unknown): number {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 15 || v > 600) throw new WebinarError('A webinar runs from 15 minutes to 10 hours.');
    return Math.round(v);
  }
  private settingsFrom(input: unknown, base: WebinarSettings): WebinarSettings {
    const d = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const cap = d.cap === undefined ? base.cap : Number(d.cap);
    if (!Number.isInteger(cap) || cap < 1 || cap > WEBINAR_REGISTRATION_MAX) throw new WebinarError(`Take between 1 and ${WEBINAR_REGISTRATION_MAX} registrations.`);
    return {
      approval: d.approval === 'manual' ? 'manual' : d.approval === 'auto' ? 'auto' : base.approval,
      cap,
      registrationOpen: typeof d.registrationOpen === 'boolean' ? d.registrationOpen : base.registrationOpen,
      anonymousQuestions: typeof d.anonymousQuestions === 'boolean' ? d.anonymousQuestions : base.anonymousQuestions,
      listed: typeof d.listed === 'boolean' ? d.listed : base.listed,
    };
  }
  private panelistList(v: unknown, organizer: string): string[] {
    const ids = [...new Set((Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string' && x !== organizer))];
    const ok = ids.filter((u) => { const p = this.host.userById(u); return !!p && p.role !== 'bot'; });
    if (ok.length > WEBINAR_MAX_PANELISTS) throw new WebinarError(`A webinar has up to ${WEBINAR_MAX_PANELISTS} panelists besides you: the stage holds 8.`);
    return ok;
  }
  private fieldsFrom(v: unknown): WebinarField[] {
    try { return cleanFields(v); } catch (e) { throw new WebinarError((e as Error).message); }
  }

  private create(me: PublicUser, d: Record<string, unknown>): WebinarInfo {
    if (!this.limits.allow(`create:${me.id}`, 10, 3600_000)) throw new WebinarError('You planned several webinars just now. Wait a while.');
    const startsAt = this.time(d.startsAt, 'when it starts');
    const durationMin = this.duration(d.durationMin);
    const settings = this.settingsFrom(d.settings, DEFAULT_SETTINGS);
    const fields = this.fieldsFrom(d.fields);
    const panelists = this.panelistList(d.panelists, me.id);
    const m = this.host.meetings.createWebinar(me, d.title, panelists);
    this.db.prepare('INSERT INTO webinars (meeting_id, description, starts_at, duration_min, settings, fields, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(m.id, text(d.description, 2000), startsAt, durationMin, JSON.stringify(settings), JSON.stringify(fields), Date.now());
    this.host.audit(me.id, 'webinar.created', m.id, { title: m.title, panelists: panelists.length });
    return this.info(m, this.row(m.id)!, me);
  }

  private update(me: PublicUser, d: Record<string, unknown>): WebinarInfo {
    const { m, row } = this.hostOnly(d.id, me);
    const sets: string[] = [];
    const vals: Array<string | number> = [];
    const put = (col: string, v: string | number) => { sets.push(`${col} = ?`); vals.push(v); };
    if (d.description !== undefined) put('description', text(d.description, 2000));
    if (d.startsAt !== undefined) put('starts_at', this.time(d.startsAt, 'when it starts'));
    if (d.durationMin !== undefined) put('duration_min', this.duration(d.durationMin));
    if (d.settings !== undefined) put('settings', JSON.stringify(this.settingsFrom(d.settings, this.settings(row))));
    if (d.fields !== undefined) {
      if (this.counts(m.id).total > 0) throw new WebinarError('People have registered already: the registration questions can no longer change.');
      put('fields', JSON.stringify(this.fieldsFrom(d.fields)));
    }
    if (d.survey !== undefined) put('survey', JSON.stringify(this.fieldsFrom(d.survey)));
    if (sets.length) this.db.prepare(`UPDATE webinars SET ${sets.join(', ')} WHERE meeting_id = ?`).run(...vals, m.id);
    if (d.title !== undefined) this.host.meetings.update(m, me, { title: d.title });
    if (d.panelists !== undefined && m.convId) {
      const want = this.panelistList(d.panelists, m.hostId);
      const now = this.panelists(m);
      const add = want.filter((u) => !now.includes(u));
      const host = this.host.userById(m.hostId) ?? me;
      if (add.length) this.host.messaging.handle('conv.addMembers', host, { convId: m.convId, userIds: add });
      for (const u of now.filter((x) => !want.includes(x))) this.host.messaging.handle('conv.removeMember', host, { convId: m.convId, userId: u });
    }
    const next = this.need(m.id);
    this.touch(m.id);
    return this.info(next.m, next.row, me);
  }

  private list(me: PublicUser): WebinarCard[] {
    const rows = this.db.prepare(`SELECT w.*, m.title, m.host_id, m.co_hosts, m.conv_id FROM webinars w JOIN meetings m ON m.id = w.meeting_id
      WHERE w.state != 'ended' OR w.ended_at > ? ORDER BY w.starts_at`).all(Date.now() - 60 * 86_400_000) as unknown as Array<Row & { title: string; host_id: string; co_hosts: string; conv_id: string | null }>;
    const out: WebinarCard[] = [];
    for (const r of rows) {
      const m = this.host.meetings.get(r.meeting_id);
      if (!m) continue;
      const role = this.role(m, me.id);
      // attendees in the office see listed webinars that have not ended
      if (role === 'attendee' && (!this.settings(r).listed || r.state === 'ended' || me.role === 'bot')) continue;
      out.push({ meetingId: m.id, title: m.title, startsAt: r.starts_at, durationMin: r.duration_min, hostId: m.hostId, state: r.state, role, audience: this.lives.get(m.id)?.viewers.size ?? 0, roomId: r.room_id });
    }
    return out.slice(0, 100);
  }

  // ---------------------------------------------------------------- practice, go live, end
  private setState(me: PublicUser, deviceId: string, d: Record<string, unknown>): WebinarInfo {
    const { m, row } = this.hostOnly(d.id, me);
    const room = this.host.rooms.live(m.id);
    if (d.state === 'live') {
      if (row.state === 'ended') throw new WebinarError('This webinar has ended.');
      if (!room) throw new WebinarError('Open the stage first: the practice session starts when you join the webinar.');
      if (row.state !== 'live') {
        this.db.prepare(`UPDATE webinars SET state = 'live', went_live_at = COALESCE(went_live_at, ?), room_id = ? WHERE meeting_id = ?`).run(Date.now(), room.id, m.id);
        this.host.audit(me.id, 'webinar.live', m.id, { roomId: room.id, audience: this.lives.get(m.id)?.viewers.size ?? 0 });
        const w = this.live(m.id);
        // everyone watching now is there when it goes live
        this.reroute(w);
        this.peak(m.id, w);
        this.touch(m.id);
      }
    } else if (d.state === 'ended') {
      if (room) {
        if (!room.participants.some((p) => p.deviceId === deviceId)) throw new WebinarError('End the webinar from its stage.');
        this.host.rooms.handle('room.end', me, deviceId, { roomId: room.id });
      }
      this.finish(m.id);
    } else throw new WebinarError('Go live or end the webinar.');
    const next = this.need(m.id);
    return this.info(next.m, next.row, me);
  }

  /** The webinar ended: its viewers are told, its stream stops. */
  private finish(id: string): void {
    const row = this.row(id);
    if (!row || row.state === 'ended') return;
    const wasLive = row.state === 'live' || !!row.went_live_at;
    this.db.prepare(`UPDATE webinars SET state = ?, ended_at = CASE WHEN ? THEN ? ELSE ended_at END WHERE meeting_id = ?`).run(wasLive ? 'ended' : 'scheduled', wasLive ? 1 : 0, Date.now(), id);
    const w = this.lives.get(id);
    if (!w) return;
    if (w.streamOn || w.stream) this.stopStream(id, null);
    if (wasLive) this.host.audit(null, 'webinar.ended', id, { peak: this.row(id)?.peak ?? 0 });
    this.reroute(w);
    this.touch(id);
    this.flush(w);
    if (wasLive) for (const v of w.viewers.values()) this.host.deliverToDevice(v.deviceId, 'web.ended', { meetingId: id });
  }

  /** The stage's Room changed (rooms.ts): practice begins, and the broadcaster is chosen. */
  roomChanged(r: RoomInfo): void {
    if (!r.meetingId) return;
    const row = this.row(r.meetingId);
    const m = this.host.meetings.get(r.meetingId);
    if (!row || !m) return;
    const w = this.live(m.id);
    if (w.roomId !== r.id) {
      w.roomId = r.id;
      if (row.state === 'scheduled' || row.state === 'ended') {
        // a webinar that ended can be opened again for practice; going live again carries on its report
        this.db.prepare(`UPDATE webinars SET state = 'practice', room_id = ? WHERE meeting_id = ?`).run(r.id, m.id);
        this.host.audit(null, 'webinar.practice', m.id, { roomId: r.id });
        w.dirty = true;
      } else this.db.prepare('UPDATE webinars SET room_id = ? WHERE meeting_id = ?').run(r.id, m.id);
    }
    // speakers who left the stage are no longer speakers (the organiser invites them again)
    for (const u of [...w.speakers]) if (!r.participants.some((p) => p.userId === u) && !this.recentSpeaker(w, u)) w.speakers.delete(u);
    const next = this.chooseBroadcaster(m, r, w.broadcaster);
    if (next !== w.broadcaster) {
      const old = w.broadcaster;
      w.broadcaster = next;
      if (old) { this.host.relayLeave(old); this.host.deliverToDevice(old, 'web.viewers', { meetingId: m.id, viewers: [], relay: false, live: false, stream: false }); }
      w.lastViewers = '';
      if (w.streamOn) w.streamEpoch++;
      this.reroute(w);
      w.dirty = true;
    }
    this.schedule(w);
  }

  /** Accepted invitations are kept for a minute while the speaker's device comes onto the stage. */
  private readonly accepted = new Map<string, number>();
  private recentSpeaker(w: Live, userId: string): boolean {
    const t = this.accepted.get(`${w.id}:${userId}`);
    return !!t && Date.now() - t < 60_000;
  }

  /** An organiser's PC on the office network composes the stage; else a panelist's there; else any on the stage. */
  private chooseBroadcaster(m: Meeting, r: RoomInfo, current: string | null): string | null {
    const people = r.participants.filter((p) => !isWebGuest(p.userId));
    const lan = (p: { deviceId: string }) => !this.host.isRemote(p.deviceId);
    const cur = people.find((p) => p.deviceId === current);
    const order = [
      ...people.filter((p) => this.isHost(m, p.userId) && lan(p)),
      ...people.filter((p) => this.isPanelist(m, p.userId) && lan(p)),
      ...people.filter((p) => this.isHost(m, p.userId)),
      ...people.filter((p) => this.isPanelist(m, p.userId)),
      ...people,
    ];
    // keep the one composing now, unless it is outside the office and one inside could take over
    if (cur && (lan(cur) || !order.some(lan))) return cur.deviceId;
    return order[0]?.deviceId ?? null;
  }

  /** The stage's Room ended: a practice goes back to waiting; a live webinar ends. */
  roomEnded(r: RoomInfo): void {
    if (!r.meetingId) return;
    const w = this.lives.get(r.meetingId);
    const row = this.row(r.meetingId);
    if (w) {
      if (w.broadcaster) this.host.relayLeave(w.broadcaster);
      w.broadcaster = null;
      w.roomId = null;
      w.speakers.clear();
      w.speakerOf.clear();
      w.lastViewers = '';
    }
    this.host.relayClose(`stage:${r.id}`);
    if (row?.state === 'live') this.finish(r.meetingId);
    else if (row?.state === 'practice') {
      this.db.prepare(`UPDATE webinars SET state = CASE WHEN went_live_at IS NULL THEN 'scheduled' ELSE 'ended' END WHERE meeting_id = ?`).run(r.meetingId);
      if (w) { if (w.streamOn || w.stream) this.stopStream(r.meetingId, null); this.reroute(w); this.touch(r.meetingId); }
    }
  }

  // ---------------------------------------------------------------- the live view and its updates
  private liveView(id: string): WebinarLive {
    const { m, row } = this.need(id);
    const w = this.live(id);
    const stage = this.db.prepare('SELECT * FROM webinar_questions WHERE meeting_id = ? AND on_stage = 1 LIMIT 1').get(id) as QRow | undefined;
    const s = this.settings(row);
    return {
      meetingId: id, title: m.title, description: row.description, startsAt: row.starts_at, state: row.state, wentLiveAt: row.went_live_at,
      host: this.nameOf(m.hostId), panelists: this.panelists(m).map((u) => this.nameOf(u)),
      audience: w.viewers.size, hands: [...w.viewers.values()].filter((v) => v.hand).length, broadcaster: w.broadcaster,
      onStage: stage ? this.qView(stage, '') : null, poll: this.currentPoll(id), handouts: this.handouts(id),
      anonymousQuestions: s.anonymousQuestions, watchUrl: row.watch_url, roomId: w.roomId,
    };
  }

  /** Something everyone sees changed: send it within a second (coalesced, so hundreds of attendees cost little). */
  private touch(id: string): void { const w = this.live(id); w.dirty = true; this.schedule(w); }

  private schedule(w: Live): void {
    if (w.timer || (!w.dirty && !w.changed.size && !w.audienceDirty && !Object.keys(w.reactions).length)) return;
    const wait = Math.max(60, 1000 - (Date.now() - w.lastFlush));
    w.timer = setTimeout(() => { w.timer = null; this.flush(w); }, wait);
    w.timer.unref?.();
  }

  private staffUsers(id: string): string[] {
    const m = this.host.meetings.get(id);
    if (!m) return [];
    const w = this.lives.get(id);
    return [...new Set([m.hostId, ...m.coHosts, ...this.panelists(m), ...(w ? [...w.speakers].filter((u) => !isWebGuest(u)) : [])])];
  }

  private flush(w: Live): void {
    if (w.timer) { clearTimeout(w.timer); w.timer = null; }
    w.lastFlush = Date.now();
    if (!this.row(w.id)) return;
    const live = w.dirty || w.audienceDirty ? this.liveView(w.id) : undefined;
    const rows = w.changed.size ? (this.db.prepare(`SELECT * FROM webinar_questions WHERE id IN (${[...w.changed].map(() => '?').join(',')})`).all(...w.changed) as unknown as QRow[]) : [];
    const reactions = Object.keys(w.reactions).length ? w.reactions : undefined;
    const staffQ = rows.map((r) => this.qView(r, ''));
    const forAudience: WebinarUpdate = {
      meetingId: w.id,
      ...(live ? { live } : {}),
      ...(rows.length ? { questions: rows.filter((r) => r.status !== 'dismissed').map((r) => this.qView(r, '')), removed: rows.filter((r) => r.status === 'dismissed').map((r) => r.id) } : {}),
      ...(reactions ? { reactions } : {}),
    };
    const forStaff: WebinarUpdate = { meetingId: w.id, ...(live ? { live } : {}), ...(rows.length ? { questions: staffQ } : {}), ...(reactions ? { reactions } : {}), ...(w.audienceDirty || w.dirty ? { audience: w.viewers.size } : {}) };
    w.dirty = false; w.audienceDirty = false; w.changed.clear(); w.reactions = {};
    if (forAudience.live || forAudience.questions || forAudience.reactions) for (const v of w.viewers.values()) this.host.deliverToDevice(v.deviceId, 'web.update', forAudience);
    const staff = this.staffUsers(w.id);
    if (staff.length && (forStaff.live || forStaff.questions || forStaff.reactions || forStaff.audience !== undefined)) this.host.deliverToUsers(staff, 'web.update', forStaff);
  }

  // ---------------------------------------------------------------- the audience
  private viewerOf(deviceId: string, id?: string): Viewer | null {
    const mid = this.byDevice.get(deviceId);
    if (!mid || (id && mid !== id)) return null;
    return this.lives.get(mid)?.viewers.get(deviceId) ?? null;
  }

  private addViewer(m: Meeting, row: Row, v: Omit<Viewer, 'route' | 'since' | 'hand' | 'invited' | 'attendance'>): Viewer {
    const w = this.live(m.id);
    if (!w.viewers.has(v.deviceId) && w.viewers.size >= WEBINAR_AUDIENCE_MAX) throw new WebinarError(`This webinar is full (${WEBINAR_AUDIENCE_MAX} watching).`, 403);
    this.leaveDevice(v.deviceId);
    const att = this.db.prepare('INSERT INTO webinar_attendance (meeting_id, voter, registrant_id, name, office, device_id, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(m.id, v.voter, v.registrantId, v.name.slice(0, 80), v.web ? 0 : 1, v.deviceId, Date.now()).lastInsertRowid;
    const viewer: Viewer = { ...v, route: 'none', since: Date.now(), hand: 0, invited: false, attendance: att };
    w.viewers.set(v.deviceId, viewer);
    this.byDevice.set(v.deviceId, m.id);
    viewer.route = this.routeFor(w, row, viewer, this.directCount(w, viewer));
    if (viewer.route === 'direct') this.sendViewers(w);
    if (row.state === 'live') this.peak(m.id, w);
    w.audienceDirty = true;
    this.schedule(w);
    return viewer;
  }

  /** A device stops watching (it left, or disconnected). */
  leaveDevice(deviceId: string): void {
    const id = this.byDevice.get(deviceId);
    if (!id) return;
    this.byDevice.delete(deviceId);
    const w = this.lives.get(id);
    const v = w?.viewers.get(deviceId);
    if (!w || !v) return;
    w.viewers.delete(deviceId);
    this.db.prepare('UPDATE webinar_attendance SET left_at = ? WHERE rowid = ?').run(Date.now(), v.attendance);
    this.host.relayLeave(deviceId);
    if (v.route === 'direct' || v.route === 'full') this.reroute(w);
    w.audienceDirty = true;
    this.schedule(w);
  }

  private peak(id: string, w: Live): void {
    this.db.prepare('UPDATE webinars SET peak = MAX(peak, ?) WHERE meeting_id = ?').run(w.viewers.size, id);
  }

  private directCount(w: Live, except?: Viewer): number {
    let n = 0;
    for (const v of w.viewers.values()) if (v !== except && v.route === 'direct') n++;
    return n;
  }

  private routeFor(w: Live, row: Row, v: Viewer, direct: number): StageRoute {
    if (row.state !== 'live' || !w.broadcaster) return 'none';
    if (!v.web && !v.remote && this.host.relayAvailable() && !this.host.isRemote(w.broadcaster)) return 'relay';
    return direct < WEBINAR_DIRECT_VIEWERS ? 'direct' : 'full';
  }

  /** Work out every viewer's route again (went live, the broadcaster changed, a direct seat came free). Earlier viewers keep their seats. */
  private reroute(w: Live): void {
    const row = this.row(w.id);
    if (!row) return;
    let direct = 0;
    for (const v of w.viewers.values()) {
      const next = this.routeFor(w, row, v, direct);
      if (next === 'direct') direct++;
      if (next !== v.route) {
        v.route = next;
        if (next !== 'relay') this.host.relayLeave(v.deviceId);
        this.host.deliverToDevice(v.deviceId, 'web.route', { meetingId: w.id, route: next, broadcaster: w.broadcaster });
      }
    }
    this.sendViewers(w);
  }

  /** Tell the broadcaster whom it sends to directly, whether the relay and the live stream want the stage. */
  private sendViewers(w: Live): void {
    if (!w.broadcaster) return;
    const row = this.row(w.id);
    const live = row?.state === 'live';
    const viewers = [...w.viewers.values()].filter((v) => v.route === 'direct').map((v) => ({ deviceId: v.deviceId, name: v.name }));
    const relay = live && this.host.relayAvailable() && !this.host.isRemote(w.broadcaster) && [...w.viewers.values()].some((v) => v.route === 'relay');
    const msg = { meetingId: w.id, viewers, relay, live, stream: w.streamOn, epoch: w.streamEpoch };
    const key = JSON.stringify(msg);
    if (key === w.lastViewers) return;
    w.lastViewers = key;
    this.host.deliverToDevice(w.broadcaster, 'web.viewers', msg);
  }

  /** For the relay (hub.ts): the stage's relay room, for the broadcaster and the viewers on the relay. */
  stageRoom(deviceId: string, meetingId: unknown): { id: string; participants: Array<{ deviceId: string; userId: string }> } | null {
    const w = typeof meetingId === 'string' ? this.lives.get(meetingId) : undefined;
    if (!w || !w.roomId || !w.broadcaster || this.row(w.id)?.state !== 'live') return null;
    const relayViewers = [...w.viewers.values()].filter((v) => v.route === 'relay');
    if (deviceId !== w.broadcaster && !relayViewers.some((v) => v.deviceId === deviceId)) return null;
    return { id: `stage:${w.roomId}`, participants: [{ deviceId: w.broadcaster, userId: '' }, ...relayViewers.map((v) => ({ deviceId: v.deviceId, userId: v.userId }))] };
  }

  /** Only the broadcaster sends tracks to the stage's relay room. */
  isBroadcaster(deviceId: string, meetingId: unknown): boolean {
    return typeof meetingId === 'string' && this.lives.get(meetingId)?.broadcaster === deviceId;
  }

  private watch(me: PublicUser, deviceId: string, d: Record<string, unknown>): { live: WebinarLive; questions: WebinarQuestion[]; route: StageRoute; hand: boolean } {
    const { m, row } = this.need(d.id);
    if (me.role === 'bot') throw new WebinarError('Integrations do not watch webinars.');
    if (this.onStage(m, me.id)) throw new WebinarError('You are on this webinar\'s stage: join it as a panelist.');
    if (!this.limits.allow(`watch:${me.id}`, 20, 60_000)) throw new WebinarError('Slow down a little.');
    const v = this.addViewer(m, row, { deviceId, userId: me.id, voter: me.id, name: me.displayName, registrantId: null, web: false, remote: this.host.isRemote(deviceId) });
    this.host.audit(me.id, 'webinar.watching', m.id, {});
    return { live: this.liveView(m.id), questions: this.questions(m.id, v.voter, false), route: v.route, hand: false };
  }

  private audience(id: string): AudienceMember[] {
    const w = this.lives.get(id);
    if (!w) return [];
    const hands = [...w.viewers.values()].filter((v) => v.hand).sort((a, b) => a.hand - b.hand);
    const order = new Map(hands.map((v, i) => [v.deviceId, i + 1] as const));
    return [...w.viewers.values()]
      .sort((a, b) => (order.get(a.deviceId) ?? 1e9) - (order.get(b.deviceId) ?? 1e9) || a.name.localeCompare(b.name))
      .slice(0, 1000)
      .map((v) => ({ deviceId: v.deviceId, userId: v.web ? '' : v.userId, name: v.name, web: v.web, route: v.route, hand: order.get(v.deviceId) ?? 0, since: v.since, invited: v.invited }));
  }

  private hand(me: PublicUser, deviceId: string, d: Record<string, unknown>): { ok: true } {
    const { m } = this.need(d.id);
    const w = this.live(m.id);
    if (typeof d.deviceId === 'string' || d.all === true) {
      if (!this.isHost(m, me.id)) throw new WebinarError('Only the organiser lowers other hands.');
      for (const v of w.viewers.values()) if (d.all === true || v.deviceId === d.deviceId) v.hand = 0;
    } else {
      const v = this.viewerOf(deviceId, m.id);
      if (!v) throw new WebinarError('Join the webinar first.');
      this.raise(v, d.up === true, m.id);
    }
    w.audienceDirty = true;
    this.schedule(w);
    return { ok: true };
  }

  private raise(v: Viewer, up: boolean, id: string): void {
    if (up && !v.hand) {
      if (!this.limits.allow(`hand:${v.deviceId}`, 6, 10_000)) throw new WebinarError('Slow down a little.');
      v.hand = Date.now();
      this.db.prepare('UPDATE webinar_attendance SET hands = hands + 1 WHERE rowid = ?').run(v.attendance);
    } else if (!up) v.hand = 0;
    const w = this.live(id);
    w.audienceDirty = true;
    this.schedule(w);
  }

  private react(me: PublicUser, deviceId: string, d: Record<string, unknown>): { ok: true } {
    const { m } = this.need(d.id);
    if (!this.viewerOf(deviceId, m.id) && !this.staff(m, me.id)) throw new WebinarError('Join the webinar first.');
    this.addReaction(m.id, deviceId, d.emoji);
    return { ok: true };
  }

  private addReaction(id: string, deviceId: string, emoji: unknown): void {
    if (typeof emoji !== 'string' || !(MEETING_REACTIONS as readonly string[]).includes(emoji)) throw new WebinarError('Choose one of the reactions.');
    // a short burst is fine; a stream of them is not (and is dropped quietly)
    if (!this.limits.allow(`react:${deviceId}`, 12, 10_000)) return;
    const w = this.live(id);
    w.reactions[emoji] = (w.reactions[emoji] ?? 0) + 1;
    this.schedule(w);
  }

  // ---------------------------------------------------------------- invited to speak
  private promote(me: PublicUser, d: Record<string, unknown>): { ok: true } {
    const { m } = this.hostOnly(d.id, me);
    const w = this.live(m.id);
    const v = w.viewers.get(String(d.deviceId ?? ''));
    if (!v) throw new WebinarError('That attendee has left.');
    const room = this.host.rooms.live(m.id);
    if (!room) throw new WebinarError('Open the stage first.');
    if (room.participants.length >= 8) throw new WebinarError('The stage is full (8 people). Bring a speaker back to the audience first.');
    v.invited = true;
    this.host.deliverToDevice(v.deviceId, 'web.promote', { meetingId: m.id, by: me.displayName });
    this.host.audit(me.id, 'webinar.invitedToSpeak', m.id, { name: v.name });
    w.audienceDirty = true;
    this.schedule(w);
    return { ok: true };
  }

  private promoteAnswer(me: PublicUser, deviceId: string, d: Record<string, unknown>): { ok: true; meetingId?: string } {
    const { m } = this.need(d.id);
    const v = this.viewerOf(deviceId, m.id);
    if (!v || !v.invited) throw new WebinarError('The organiser has not invited you to speak.');
    const w = this.live(m.id);
    v.invited = false;
    if (d.accept !== true) { w.audienceDirty = true; this.schedule(w); return { ok: true }; }
    w.speakers.add(me.id);
    this.accepted.set(`${m.id}:${me.id}`, Date.now());
    this.leaveDevice(deviceId);
    this.host.audit(me.id, 'webinar.speaking', m.id, {});
    return { ok: true, meetingId: m.id };
  }

  /** A browser attendee accepted: a one-time pass for the meeting page (it opens the stage, no lobby). */
  private webSpeak(v: Viewer, id: string, accept: boolean): WebinarDown | null {
    if (!v.invited) throw new WebinarError('The organiser has not invited you to speak.');
    const w = this.live(id);
    v.invited = false;
    if (!accept) { w.audienceDirty = true; this.schedule(w); return null; }
    const code = passcodeFrom(crypto.randomBytes(48), 10);
    w.passes.set(code, { name: v.name, registrantId: v.registrantId, voter: v.voter, expires: Date.now() + 120_000 });
    this.leaveDevice(v.deviceId);
    return { t: 'speak', url: `/m/${id}#${code}` };
  }

  /** meet-guests.ts: a meeting-page join with a speaker's pass (used once, within two minutes). */
  takePass(meetingId: string, code: unknown): Pass | null {
    const w = this.lives.get(meetingId);
    if (!w || typeof code !== 'string') return null;
    for (const [k, p] of w.passes) if (p.expires < Date.now()) w.passes.delete(k);
    const p = w.passes.get(code);
    if (!p) return null;
    w.passes.delete(code);
    return p;
  }

  /** meet-guests.ts: the browser speaker's session is about to join the stage. */
  speakerJoined(meetingId: string, userId: string, pass: Pass): void {
    const w = this.live(meetingId);
    w.speakers.add(userId);
    w.speakerOf.set(userId, pass);
    this.accepted.set(`${meetingId}:${userId}`, Date.now());
  }

  private demote(me: PublicUser, d: Record<string, unknown>): { ok: true } {
    const { m } = this.hostOnly(d.id, me);
    const w = this.live(m.id);
    const uid = String(d.userId ?? '');
    if (!w.speakers.has(uid)) throw new WebinarError('Only people invited from the audience go back to it.');
    const room = this.host.rooms.live(m.id);
    for (const p of room?.participants.filter((x) => x.userId === uid) ?? []) this.host.deliverToDevice(p.deviceId, 'web.demoted', { meetingId: m.id });
    w.speakers.delete(uid);
    w.speakerOf.delete(uid);
    this.accepted.delete(`${m.id}:${uid}`);
    if (room) this.host.rooms.unseat(room.id, uid);
    this.host.audit(me.id, 'webinar.backToAudience', m.id, {});
    return { ok: true };
  }

  // ---------------------------------------------------------------- signalling for direct viewers
  private signal(deviceId: string, d: Record<string, unknown>): { ok: true } {
    const id = typeof d.id === 'string' ? d.id : '';
    const w = this.lives.get(id);
    const to = String(d.toDevice ?? '');
    if (!w || !w.broadcaster) throw new WebinarError('The stage is not on.');
    const fromBroadcaster = deviceId === w.broadcaster && w.viewers.get(to)?.route === 'direct';
    const toBroadcaster = to === w.broadcaster && w.viewers.get(deviceId)?.route === 'direct';
    if (!fromBroadcaster && !toBroadcaster) throw new WebinarError('Not connected to the stage.');
    if (JSON.stringify(d.data ?? null).length > 64 * 1024) throw new WebinarError('Signal too large.');
    this.host.deliverToDevice(to, 'web.signal', { meetingId: id, fromDevice: deviceId, data: d.data });
    return { ok: true };
  }

  // ---------------------------------------------------------------- questions
  private qView(r: QRow, voter: string): WebinarQuestion {
    return {
      id: r.id, text: r.text, author: r.anonymous ? '' : r.author_name, anonymous: !!r.anonymous, votes: r.votes, at: r.created_at,
      status: r.status, answer: r.answer ? { text: r.answer, by: r.answered_by ?? '', at: r.answered_at ?? r.created_at } : r.status === 'live' ? { text: '', by: r.answered_by ?? '', at: r.answered_at ?? r.created_at } : null,
      pinned: !!r.pinned, onStage: !!r.on_stage,
      ...(voter ? { own: r.author === voter, voted: !!this.db.prepare('SELECT 1 FROM webinar_votes WHERE question_id = ? AND voter = ?').get(r.id, voter) } : {}),
    };
  }

  /** Pinned first, then most votes, then oldest. Attendees do not see dismissed questions. */
  questions(id: string, voter: string, staff: boolean): WebinarQuestion[] {
    const rows = this.db.prepare(`SELECT * FROM webinar_questions WHERE meeting_id = ? ${staff ? '' : "AND status != 'dismissed'"} ORDER BY pinned DESC, votes DESC, created_at LIMIT 1000`).all(id) as unknown as QRow[];
    const mine = new Set((this.db.prepare('SELECT v.question_id FROM webinar_votes v JOIN webinar_questions q ON q.id = v.question_id WHERE q.meeting_id = ? AND v.voter = ?').all(id, voter) as Array<{ question_id: string }>).map((x) => x.question_id));
    return rows.map((r) => ({ ...this.qView(r, ''), own: r.author === voter, voted: mine.has(r.id) }));
  }

  private q(id: string, qid: unknown): QRow {
    const r = typeof qid === 'string' ? this.db.prepare('SELECT * FROM webinar_questions WHERE id = ? AND meeting_id = ?').get(qid, id) as QRow | undefined : undefined;
    if (!r) throw new WebinarError('That question is gone.');
    return r;
  }

  private changedQ(id: string, qid: string): void { const w = this.live(id); w.changed.add(qid); this.schedule(w); }

  /** Who is asking or voting: a viewer, or someone on the stage. */
  private asker(m: Meeting, me: PublicUser, deviceId: string): { voter: string; name: string } {
    const v = this.viewerOf(deviceId, m.id);
    if (v) return { voter: v.voter, name: v.name };
    if (this.staff(m, me.id)) return { voter: me.id, name: me.displayName };
    throw new WebinarError('Join the webinar first.');
  }

  private ask(me: PublicUser, deviceId: string, d: Record<string, unknown>): WebinarQuestion {
    const { m } = this.need(d.id);
    return this.askAs(m, this.asker(m, me, deviceId), d.text, d.anonymous === true);
  }

  private askAs(m: Meeting, who: { voter: string; name: string }, body: unknown, anonymous: boolean): WebinarQuestion {
    const row = this.row(m.id)!;
    if (row.state === 'ended') throw new WebinarError('This webinar has ended.');
    const t = text(body, WEBINAR_QUESTION_MAX);
    if (!t) throw new WebinarError('Write your question first.');
    if (anonymous && !this.settings(row).anonymousQuestions) throw new WebinarError('The organiser asks for names with questions.');
    if (!this.limits.allow(`ask:${m.id}:${who.voter}`, 5, 60_000)) throw new WebinarError('You asked several questions just now. Wait a minute.');
    if ((this.db.prepare('SELECT COUNT(*) AS n FROM webinar_questions WHERE meeting_id = ?').get(m.id) as { n: number }).n >= 2000) throw new WebinarError('This webinar has taken as many questions as it can.');
    const id = ulid();
    this.db.prepare('INSERT INTO webinar_questions (id, meeting_id, author, author_name, anonymous, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, m.id, who.voter, who.name.slice(0, 80), anonymous ? 1 : 0, t, Date.now());
    this.changedQ(m.id, id);
    return this.qView(this.q(m.id, id), who.voter);
  }

  private vote(me: PublicUser, deviceId: string, d: Record<string, unknown>): WebinarQuestion {
    const { m } = this.need(d.id);
    return this.voteAs(m, this.asker(m, me, deviceId).voter, d.questionId, d.up === true);
  }

  private voteAs(m: Meeting, voter: string, qid: unknown, up: boolean): WebinarQuestion {
    const r = this.q(m.id, qid);
    if (r.status === 'dismissed') throw new WebinarError('That question is gone.');
    if (!this.limits.allow(`vote:${voter}`, 30, 10_000)) throw new WebinarError('Slow down a little.');
    const had = !!this.db.prepare('SELECT 1 FROM webinar_votes WHERE question_id = ? AND voter = ?').get(r.id, voter);
    if (up && !had) { this.db.prepare('INSERT INTO webinar_votes (question_id, voter) VALUES (?, ?)').run(r.id, voter); this.db.prepare('UPDATE webinar_questions SET votes = votes + 1 WHERE id = ?').run(r.id); }
    if (!up && had) { this.db.prepare('DELETE FROM webinar_votes WHERE question_id = ? AND voter = ?').run(r.id, voter); this.db.prepare('UPDATE webinar_questions SET votes = MAX(0, votes - 1) WHERE id = ?').run(r.id); }
    if (up !== had) this.changedQ(m.id, r.id);
    return this.qView(this.q(m.id, r.id), voter);
  }

  private answer(me: PublicUser, d: Record<string, unknown>): WebinarQuestion {
    const { m } = this.staffOnly(d.id, me);
    const r = this.q(m.id, d.questionId);
    if (d.live === true) {
      this.db.prepare(`UPDATE webinar_questions SET status = 'live', answered_by = ?, answered_at = ? WHERE id = ?`).run(me.displayName, Date.now(), r.id);
    } else {
      const t = text(d.text, WEBINAR_ANSWER_MAX);
      if (!t) throw new WebinarError('Write the answer first.');
      this.db.prepare(`UPDATE webinar_questions SET status = 'answered', answer = ?, answered_by = ?, answered_at = ? WHERE id = ?`).run(t, me.displayName, Date.now(), r.id);
    }
    this.changedQ(m.id, r.id);
    return this.qView(this.q(m.id, r.id), me.id);
  }

  private moderate(me: PublicUser, d: Record<string, unknown>): WebinarQuestion {
    const { m } = this.hostOnly(d.id, me);
    const r = this.q(m.id, d.questionId);
    switch (d.action) {
      case 'dismiss': this.db.prepare(`UPDATE webinar_questions SET status = 'dismissed', pinned = 0, on_stage = 0 WHERE id = ?`).run(r.id); break;
      case 'reopen': this.db.prepare(`UPDATE webinar_questions SET status = 'open', answer = NULL, answered_by = NULL, answered_at = NULL WHERE id = ?`).run(r.id); break;
      case 'pin': this.db.prepare('UPDATE webinar_questions SET pinned = 1 WHERE id = ?').run(r.id); break;
      case 'unpin': this.db.prepare('UPDATE webinar_questions SET pinned = 0 WHERE id = ?').run(r.id); break;
      case 'stage': {
        if (r.status === 'dismissed') throw new WebinarError('Reopen it first.');
        // one question on the stage at a time
        const prev = this.db.prepare('SELECT id FROM webinar_questions WHERE meeting_id = ? AND on_stage = 1').all(m.id) as Array<{ id: string }>;
        this.db.prepare('UPDATE webinar_questions SET on_stage = 0 WHERE meeting_id = ?').run(m.id);
        for (const p of prev) this.changedQ(m.id, p.id);
        this.db.prepare('UPDATE webinar_questions SET on_stage = 1 WHERE id = ?').run(r.id);
        break;
      }
      case 'unstage': this.db.prepare('UPDATE webinar_questions SET on_stage = 0 WHERE id = ?').run(r.id); break;
      default: throw new WebinarError('Dismiss, reopen, pin or show a question on the stage.');
    }
    this.changedQ(m.id, r.id);
    if (d.action === 'stage' || d.action === 'unstage' || (d.action === 'dismiss' && r.on_stage)) this.touch(m.id);
    return this.qView(this.q(m.id, r.id), me.id);
  }

  // ---------------------------------------------------------------- polls
  private pollView(r: PollRow, voter: string, staff: boolean): WebinarPoll {
    const options = parse<string[]>(r.options, []);
    const answers = this.db.prepare('SELECT voter, choices FROM webinar_poll_answers WHERE poll_id = ?').all(r.id) as Array<{ voter: string; choices: string }>;
    const counts = options.map(() => 0);
    let mine: number[] = [];
    for (const a of answers) {
      const c = parse<number[]>(a.choices, []);
      for (const i of c) if (i >= 0 && i < counts.length) counts[i]++;
      if (a.voter === voter) mine = c;
    }
    const show = staff || !!r.show_results;
    return { id: r.id, question: r.question, options, multi: !!r.multi, open: !!r.open, showResults: !!r.show_results, results: show ? counts : null, voters: answers.length, mine, at: r.created_at };
  }

  private polls(id: string, voter: string, staff: boolean): WebinarPoll[] {
    return (this.db.prepare('SELECT * FROM webinar_polls WHERE meeting_id = ? ORDER BY created_at DESC LIMIT 50').all(id) as unknown as PollRow[]).map((r) => this.pollView(r, voter, staff));
  }

  /** The poll attendees see: the one open now, or the last one when its results are shown. */
  private currentPoll(id: string): WebinarPoll | null {
    const r = this.db.prepare('SELECT * FROM webinar_polls WHERE meeting_id = ? ORDER BY created_at DESC LIMIT 1').get(id) as PollRow | undefined;
    if (!r || (!r.open && !r.show_results)) return null;
    return this.pollView(r, '', false);
  }

  private launchPoll(me: PublicUser, d: Record<string, unknown>): WebinarPoll {
    const { m } = this.hostOnly(d.id, me);
    const question = text(d.question, 300);
    const options = (Array.isArray(d.options) ? d.options : []).map((o) => text(o, 120)).filter(Boolean).slice(0, 10);
    if (!question) throw new WebinarError('Write the poll\'s question.');
    if (options.length < 2) throw new WebinarError('A poll needs at least two answers.');
    this.db.prepare('UPDATE webinar_polls SET open = 0 WHERE meeting_id = ? AND open = 1').run(m.id);
    const id = ulid();
    this.db.prepare('INSERT INTO webinar_polls (id, meeting_id, question, options, multi, show_results, open, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
      .run(id, m.id, question, JSON.stringify(options), d.multi === true ? 1 : 0, d.showResults === true ? 1 : 0, Date.now());
    this.touch(m.id);
    return this.pollView(this.db.prepare('SELECT * FROM webinar_polls WHERE id = ?').get(id) as unknown as PollRow, me.id, true);
  }

  private pollVote(me: PublicUser, deviceId: string, d: Record<string, unknown>): WebinarPoll {
    const { m } = this.need(d.id);
    const who = this.asker(m, me, deviceId);
    return this.pollVoteAs(m, who, d.pollId, d.choices, this.staff(m, me.id));
  }

  private pollVoteAs(m: Meeting, who: { voter: string; name: string }, pollId: unknown, choicesIn: unknown, staff: boolean): WebinarPoll {
    const r = typeof pollId === 'string' ? this.db.prepare('SELECT * FROM webinar_polls WHERE id = ? AND meeting_id = ?').get(pollId, m.id) as PollRow | undefined : undefined;
    if (!r) throw new WebinarError('That poll is gone.');
    if (!r.open) throw new WebinarError('This poll has closed.');
    const n = parse<string[]>(r.options, []).length;
    const choices = [...new Set((Array.isArray(choicesIn) ? choicesIn : []).filter((x): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) < n))].sort((a, b) => a - b);
    if (!choices.length) throw new WebinarError('Choose an answer.');
    if (!r.multi && choices.length > 1) throw new WebinarError('Choose one answer.');
    if (!this.limits.allow(`poll:${who.voter}`, 20, 10_000)) throw new WebinarError('Slow down a little.');
    this.db.prepare('INSERT INTO webinar_poll_answers (poll_id, voter, name, choices, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(poll_id, voter) DO UPDATE SET choices = excluded.choices, at = excluded.at')
      .run(r.id, who.voter, who.name.slice(0, 80), JSON.stringify(choices), Date.now());
    // results that attendees see move as people vote
    if (r.show_results) this.touch(m.id);
    else { const w = this.live(m.id); w.audienceDirty = true; this.schedule(w); }
    return this.pollView(r, who.voter, staff);
  }

  private closePoll(me: PublicUser, d: Record<string, unknown>): WebinarPoll {
    const { m } = this.hostOnly(d.id, me);
    const r = typeof d.pollId === 'string' ? this.db.prepare('SELECT * FROM webinar_polls WHERE id = ? AND meeting_id = ?').get(d.pollId, m.id) as PollRow | undefined : undefined;
    if (!r) throw new WebinarError('That poll is gone.');
    const show = typeof d.showResults === 'boolean' ? (d.showResults ? 1 : 0) : r.show_results;
    this.db.prepare('UPDATE webinar_polls SET open = 0, show_results = ? WHERE id = ?').run(show, r.id);
    this.touch(m.id);
    return this.pollView(this.db.prepare('SELECT * FROM webinar_polls WHERE id = ?').get(r.id) as unknown as PollRow, me.id, true);
  }

  // ---------------------------------------------------------------- handouts
  handouts(id: string): Handout[] {
    return (this.db.prepare('SELECT * FROM webinar_handouts WHERE meeting_id = ? ORDER BY added_at').all(id) as Array<{ id: string; name: string; size: number; mime: string; added_at: number }>)
      .map((h) => ({ id: h.id, name: h.name, size: h.size, mime: h.mime, at: h.added_at }));
  }

  private addHandout(me: PublicUser, d: Record<string, unknown>): Handout[] {
    const { m } = this.hostOnly(d.id, me);
    const fileId = String(d.fileId ?? '');
    const f = this.host.files.info(fileId);
    if (!f || !this.host.files.canRead(me.id, fileId)) throw new WebinarError('That file is not available.');
    if (this.handouts(m.id).length >= HANDOUTS_MAX) throw new WebinarError(`A webinar has up to ${HANDOUTS_MAX} handouts.`);
    if (f.size > 50 * 1024 * 1024) throw new WebinarError('Handouts can be up to 50 MB.');
    this.db.prepare('INSERT INTO webinar_handouts (id, meeting_id, file_id, name, size, mime, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(ulid(), m.id, f.id, f.name, f.size, f.mime, me.id, Date.now());
    this.host.audit(me.id, 'webinar.handoutAdded', m.id, { name: f.name });
    this.touch(m.id);
    return this.handouts(m.id);
  }

  private removeHandout(me: PublicUser, d: Record<string, unknown>): Handout[] {
    const { m } = this.hostOnly(d.id, me);
    this.db.prepare('DELETE FROM webinar_handouts WHERE id = ? AND meeting_id = ?').run(String(d.handoutId ?? ''), m.id);
    this.touch(m.id);
    return this.handouts(m.id);
  }

  private handoutRow(id: string, hid: unknown): { id: string; file_id: string; name: string; mime: string; size: number } {
    const h = typeof hid === 'string' ? this.db.prepare('SELECT id, file_id, name, mime, size FROM webinar_handouts WHERE id = ? AND meeting_id = ?').get(hid, id) as { id: string; file_id: string; name: string; mime: string; size: number } | undefined : undefined;
    if (!h) throw new WebinarError('That handout was taken away.');
    return h;
  }

  private downloaded(handoutId: string, voter: string, name: string): void {
    this.db.prepare('INSERT INTO webinar_downloads (handout_id, voter, name, at) VALUES (?, ?, ?, ?)').run(handoutId, voter, name.slice(0, 80), Date.now());
  }

  /** An attendee in the app downloads a handout: the hub's file route serves it (files.extraRead lets them). */
  private openHandout(me: PublicUser, deviceId: string, d: Record<string, unknown>): { fileId: string; name: string } {
    const { m } = this.need(d.id);
    const who = this.asker(m, me, deviceId);
    const h = this.handoutRow(m.id, d.handoutId);
    if (!this.limits.allow(`dl:${who.voter}`, 30, 60_000)) throw new WebinarError('Slow down a little.');
    this.downloaded(h.id, who.voter, who.name);
    this.grants.set(`${me.id}:${h.file_id}`, Date.now());
    return { fileId: h.file_id, name: h.name };
  }

  /** Office people who asked for a handout may read its file for a while (files.ts extraRead). */
  private readonly grants = new Map<string, number>();
  mayReadHandout(userId: string, fileId: string): boolean {
    const t = this.grants.get(`${userId}:${fileId}`);
    if (t && Date.now() - t < 3600_000) return true;
    // the organiser and panelists always may
    const rows = this.db.prepare('SELECT meeting_id FROM webinar_handouts WHERE file_id = ?').all(fileId) as Array<{ meeting_id: string }>;
    return rows.some((r) => { const m = this.host.meetings.get(r.meeting_id); return !!m && this.staff(m, userId); });
  }

  // ---------------------------------------------------------------- registration
  registrants(id: string): Registrant[] {
    const gw = this.host.gateway();
    const row = this.row(id);
    const att = this.attendanceByRegistrant(id, row);
    return (this.db.prepare('SELECT * FROM webinar_registrants WHERE meeting_id = ? ORDER BY created_at').all(id) as unknown as RegRow[]).map((r) => this.regView(r, gw, row, att));
  }

  private regView(r: RegRow, gw: string | null, row: Row | null, att: Map<string, number>): Registrant {
    const done = !!row && (row.state === 'ended' || (row.state !== 'live' && !!row.went_live_at));
    const minutes = att.get(r.id) ?? 0;
    return {
      id: r.id, name: r.name, email: r.email, answers: parse<FieldAnswers>(r.answers, {}), status: r.status, createdAt: r.created_at, decidedAt: r.decided_at,
      joinUrl: gw && r.status !== 'rejected' ? webinarWatchUrl(gw, r.meeting_id, r.token) : null,
      attended: r.status === 'approved' && (done || minutes > 0) ? minutes > 0 : null,
      minutes,
    };
  }

  /** Minutes each registrant watched while the webinar was live. */
  private attendanceByRegistrant(id: string, row: Row | null): Map<string, number> {
    const out = new Map<string, number>();
    if (!row?.went_live_at) return out;
    const from = row.went_live_at;
    const to = row.ended_at && row.state === 'ended' ? row.ended_at : Date.now();
    const segs = this.db.prepare('SELECT registrant_id, joined_at, left_at FROM webinar_attendance WHERE meeting_id = ? AND registrant_id IS NOT NULL').all(id) as Array<{ registrant_id: string; joined_at: number; left_at: number | null }>;
    const by = new Map<string, Array<[number, number]>>();
    for (const s of segs) {
      const a = Math.max(from, s.joined_at), b = Math.min(to, s.left_at ?? to);
      if (b > a) (by.get(s.registrant_id) ?? by.set(s.registrant_id, []).get(s.registrant_id)!).push([a, b]);
    }
    for (const [k, list] of by) out.set(k, Math.max(1, Math.round(sumIntervals(list).total / 60_000)));
    return out;
  }

  private decide(me: PublicUser, d: Record<string, unknown>): Registrant[] {
    const { m } = this.hostOnly(d.id, me);
    const ids = (Array.isArray(d.registrantIds) ? d.registrantIds : []).filter((x): x is string => typeof x === 'string').slice(0, 2000);
    if (!ids.length) throw new WebinarError('Choose who to approve or turn away.');
    const status = d.approve === true ? 'approved' : 'rejected';
    const upd = this.db.prepare('UPDATE webinar_registrants SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND meeting_id = ?');
    for (const r of ids) upd.run(status, Date.now(), me.id, r, m.id);
    this.host.audit(me.id, status === 'approved' ? 'webinar.registrantsApproved' : 'webinar.registrantsRejected', m.id, { count: ids.length });
    // someone turned away stops watching at once
    if (status === 'rejected') {
      const w = this.lives.get(m.id);
      for (const v of [...(w?.viewers.values() ?? [])]) if (v.registrantId && ids.includes(v.registrantId)) this.host.deliverToDevice(v.deviceId, 'web.ended', { meetingId: m.id });
    }
    return this.registrants(m.id);
  }

  private mailInput(m: Meeting, row: Row, when: unknown): WebinarMailInput {
    const org = this.host.userById(m.hostId);
    return {
      meetingId: m.id, title: m.title, description: row.description, startsAt: row.starts_at, durationMin: row.duration_min,
      organizer: { id: m.hostId, name: org?.displayName ?? 'The organiser', email: org?.profile.email ?? null }, office: this.host.office(),
      when: text(when, 120) || new Date(row.starts_at).toUTCString(), registerUrl: this.host.gateway() ? webinarRegisterUrl(this.host.gateway()!, m.id) : null,
    };
  }

  private mail(me: PublicUser, d: Record<string, unknown>): WebinarMail[] {
    const { m, row } = this.hostOnly(d.id, me);
    const gw = this.host.gateway();
    if (!gw) throw new WebinarError('Personal links work through the internet gateway, which is not on (Control room ▸ Outside the office).');
    const only = Array.isArray(d.registrantIds) ? new Set(d.registrantIds.filter((x): x is string => typeof x === 'string')) : null;
    const input = this.mailInput(m, row, d.when);
    const kind = d.kind === 'reminder' ? 'reminder' : 'invite';
    return (this.db.prepare(`SELECT * FROM webinar_registrants WHERE meeting_id = ? AND status = 'approved' ORDER BY created_at`).all(m.id) as unknown as RegRow[])
      .filter((r) => !only || only.has(r.id))
      .map((r) => webinarInvitation(input, { id: r.id, name: r.name, email: r.email, joinUrl: webinarWatchUrl(gw, m.id, r.token) }, kind));
  }

  /** The public page: what it shows before registering. */
  private publicView(m: Meeting, row: Row): WebinarPublic {
    const s = this.settings(row);
    const full = this.counts(m.id).total >= s.cap;
    const closed = row.state === 'ended' ? 'This webinar has ended.' : !s.registrationOpen ? 'Registration is closed.' : full ? 'Registration is full.' : null;
    return {
      meetingId: m.id, title: m.title, description: row.description, startsAt: row.starts_at, durationMin: row.duration_min,
      organizer: this.nameOf(m.hostId), office: this.host.office(), fields: this.fields(row), approval: s.approval, open: !closed, closed, state: row.state,
    };
  }

  private register(m: Meeting, row: Row, d: Record<string, unknown>, ip: string): { status: 'approved' | 'pending'; token: string; name: string } {
    const pub = this.publicView(m, row);
    if (!pub.open) throw new WebinarError(pub.closed ?? 'Registration is closed.', 403);
    const name = cleanName(d.name);
    const email = cleanEmail(d.email);
    if (name.length < 2) throw new WebinarError('Enter your name.');
    if (!EMAIL_RE.test(email)) throw new WebinarError('Enter your email address.');
    let answers: FieldAnswers;
    try { answers = checkAnswers(pub.fields, d.answers); } catch (e) { throw new WebinarError((e as Error).message); }
    if (this.db.prepare('SELECT 1 FROM webinar_registrants WHERE meeting_id = ? AND email = ?').get(m.id, email)) {
      throw new WebinarError('This email address is registered already. Use the link from your registration, or ask the organiser for it again.', 409);
    }
    const status = this.settings(row).approval === 'auto' ? 'approved' : 'pending';
    const token = crypto.randomBytes(16).toString('base64url');
    const id = ulid();
    this.db.prepare('INSERT INTO webinar_registrants (id, meeting_id, name, email, answers, status, token, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, m.id, name, email, JSON.stringify(answers), status, token, ip.slice(0, 80), Date.now());
    this.host.audit(null, 'webinar.registered', m.id, { name, ip, status });
    const reg = this.regView(this.db.prepare('SELECT * FROM webinar_registrants WHERE id = ?').get(id) as unknown as RegRow, this.host.gateway(), row, new Map());
    const hosts = [m.hostId, ...m.coHosts];
    this.host.deliverToUsers(hosts, 'web.registered', { meetingId: m.id, registrant: reg });
    return { status, token, name };
  }

  private byToken(meetingId: string, token: unknown): RegRow | null {
    if (typeof token !== 'string' || !REG_TOKEN_RE.test(token)) return null;
    const r = this.db.prepare('SELECT * FROM webinar_registrants WHERE token = ?').get(token) as RegRow | undefined;
    if (!r || r.meeting_id !== meetingId) return null;
    // compare in constant time all the same
    return crypto.timingSafeEqual(Buffer.from(r.token), Buffer.from(token)) ? r : null;
  }

  /**
   * Requests from the gateway's webinar pages (GET /w/<ID>/info, POST /w/<ID>/register and the
   * survey). The gateway limits them per address and drops the honeypot first; the hub checks
   * everything again.
   */
  webRequest(op: string, meetingId: string, ip: string, d: Record<string, unknown>): { status: number; body: unknown } {
    try {
      const { m, row } = this.need(meetingId);
      switch (op) {
        case 'info':
          if (!this.limits.allow(`info:${ip}`, 120, 60_000)) throw new WebinarError('Too many requests. Wait a minute.', 429);
          return { status: 200, body: this.publicView(m, row) };
        case 'register': {
          if (typeof d.website === 'string' && d.website) return { status: 200, body: { status: 'pending', name: '' } };
          if (!this.limits.allow(`reg:${ip}`, 10, 3600_000)) throw new WebinarError('Too many registrations from your network. Try again later.', 429);
          return { status: 200, body: this.register(m, row, d, ip) };
        }
        case 'surveyInfo': {
          const r = this.byToken(m.id, d.token);
          if (!r || r.status !== 'approved') throw new WebinarError('This survey link is not valid.', 403);
          const fields = this.survey(row);
          if (!fields.length) throw new WebinarError('This webinar has no survey.', 404);
          const answered = !!this.db.prepare('SELECT 1 FROM webinar_survey_answers WHERE meeting_id = ? AND voter = ?').get(m.id, `reg:${r.id}`);
          return { status: 200, body: { title: m.title, name: r.name, fields, answered } };
        }
        case 'survey': {
          const r = this.byToken(m.id, d.token);
          if (!r || r.status !== 'approved') throw new WebinarError('This survey link is not valid.', 403);
          if (!this.limits.allow(`survey:${ip}`, 20, 3600_000)) throw new WebinarError('Too many answers from your network. Try again later.', 429);
          this.saveSurvey(m, row, `reg:${r.id}`, r.name, d.answers);
          return { status: 200, body: { ok: true } };
        }
      }
      return { status: 404, body: { error: 'Not found' } };
    } catch (err) {
      if (err instanceof WebinarError) return { status: err.status, body: { error: err.message } };
      this.host.log('warn', 'webinar page request failed', { op, error: (err as Error).message });
      return { status: 500, body: { error: 'That did not work. Try again.' } };
    }
  }

  // ---------------------------------------------------------------- browser attendees (through meet-guests.ts)
  /** A browser attendee opened their personal link. Throws WebinarError(403) for a link that is not valid. */
  async webWatch(meetingId: string, token: unknown, session: { userId: string; deviceId: string }): Promise<WebinarDown> {
    const { m, row } = this.need(meetingId);
    const r = this.byToken(m.id, token);
    if (!r) throw new WebinarError('This link is not valid. Check the email from the organiser.', 403);
    if (r.status !== 'approved') return { t: 'registration', status: r.status === 'rejected' ? 'rejected' : 'pending', name: r.name, title: m.title, startsAt: row.starts_at };
    const v = this.addViewer(m, row, { deviceId: session.deviceId, userId: session.userId, voter: `reg:${r.id}`, name: r.name, registrantId: r.id, web: true, remote: true });
    const iceServers = await this.host.iceServers().catch(() => []);
    return { t: 'webinar', self: { deviceId: session.deviceId, name: r.name }, live: this.liveView(m.id), questions: this.questions(m.id, v.voter, false), route: v.route, iceServers, hand: false };
  }

  /** A frame from a browser attendee who is watching. Returns a frame to send back, or null. */
  webFrame(deviceId: string, f: Record<string, unknown>): WebinarDown | null {
    const v = this.viewerOf(deviceId);
    const id = this.byDevice.get(deviceId);
    if (!v || !id) throw new WebinarError('You are no longer watching. Open your link again.');
    const m = this.host.meetings.get(id)!;
    const who = { voter: v.voter, name: v.name };
    switch (f.t) {
      case 'ask': this.askAs(m, who, f.text, f.anonymous === true); return null;
      case 'vote': this.voteAs(m, who.voter, f.questionId, f.up === true); return null;
      case 'pollVote': this.pollVoteAs(m, who, f.pollId, f.choices, false); return null;
      case 'hand': this.raise(v, f.up === true, id); return null;
      case 'react': this.addReaction(id, deviceId, f.emoji); return null;
      case 'signal': this.signal(deviceId, { id, toDevice: f.to, data: f.data }); return null;
      case 'speak': return this.webSpeak(v, id, f.accept === true);
    }
    throw new WebinarError('Not available here.');
  }

  /** A browser attendee downloads a handout: its bytes, sent over their connection in pieces. */
  webHandout(deviceId: string, handoutId: unknown): { id: string; name: string; mime: string; data: Buffer } {
    const v = this.viewerOf(deviceId);
    const id = this.byDevice.get(deviceId);
    if (!v || !id) throw new WebinarError('You are no longer watching. Open your link again.');
    const h = this.handoutRow(id, handoutId);
    if (!this.limits.allow(`dl:${v.voter}`, 10, 60_000)) throw new WebinarError('Slow down a little.');
    const data = this.host.files.read(h.file_id, 50 * 1024 * 1024);
    if (!data) throw new WebinarError('That handout could not be read.');
    this.downloaded(h.id, v.voter, v.name);
    return { id: h.id, name: h.name, mime: h.mime, data };
  }

  // ---------------------------------------------------------------- live stream
  private async ffmpeg(me: PublicUser, d: Record<string, unknown>): Promise<unknown> {
    if (d && 'path' in d && d.path !== undefined) {
      if (me.role !== 'owner' && me.role !== 'admin') throw new WebinarError('Only administrators choose where ffmpeg is.', 403);
      const p = d.path === null ? null : text(d.path, 400) || null;
      this.host.setFfmpegPath(p);
      forgetFfmpeg();
    }
    const f = await findFfmpeg(this.host.ffmpegPath());
    return { found: !!f, path: f?.path ?? null, version: f?.version ?? null, encoder: f?.h264 ?? null, configured: this.host.ffmpegPath() };
  }

  private setStream(me: PublicUser, d: Record<string, unknown>): WebinarInfo {
    const { m, row } = this.hostOnly(d.id, me);
    let url = row.stream_url, key = row.stream_key, watch = row.watch_url;
    if (d.url !== undefined) {
      const u = text(d.url, 400);
      if (u && !RTMP_RE.test(u)) throw new WebinarError('The stream address starts with rtmp:// or rtmps:// (the service shows it as "Stream URL" or "Server").');
      url = u || null;
    }
    if (d.key !== undefined) {
      const k = typeof d.key === 'string' ? d.key.trim() : '';
      if (k && !STREAM_KEY_RE.test(k)) throw new WebinarError('That stream key has characters a key does not have.');
      key = k || null;
    }
    if (d.watchUrl !== undefined) {
      const w = text(d.watchUrl, 400);
      if (w && !/^https:\/\/[^\s]+$/.test(w)) throw new WebinarError('The watch page is an https:// address.');
      watch = w || null;
    }
    this.db.prepare('UPDATE webinars SET stream_url = ?, stream_key = ?, watch_url = ? WHERE meeting_id = ?').run(url, key, watch, m.id);
    this.host.audit(me.id, 'webinar.streamSet', m.id, { url: url ?? '' });
    this.touch(m.id);
    const next = this.need(m.id);
    return this.info(next.m, next.row, me);
  }

  private statusTo(id: string, status: StreamStatus): void {
    const w = this.live(id);
    w.streamStatus = status;
    if (status.state === 'live') w.retries = 0;
    // ffmpeg stopped while the stream should run (the service dropped it, a network blip): try
    // again a few times, with the broadcaster recording afresh
    if (status.state === 'failed' && w.streamOn && w.retries < 5) {
      w.retries++;
      const t = setTimeout(() => { if (w.streamOn && w.stream && !w.stream.running) { w.streamEpoch++; this.sendViewers(w); } }, 3000 * w.retries);
      t.unref?.();
    }
    const m = this.host.meetings.get(id);
    if (m) this.host.deliverToUsers([m.hostId, ...m.coHosts], 'web.streamStatus', { meetingId: id, status });
  }

  private async startStream(me: PublicUser, d: Record<string, unknown>): Promise<StreamStatus> {
    const { m, row } = this.hostOnly(d.id, me);
    if (!row.stream_url) throw new WebinarError('Enter the stream address and key first.');
    if (!this.host.rooms.live(m.id)) throw new WebinarError('Open the stage first.');
    const f = await findFfmpeg(this.host.ffmpegPath());
    const w = this.live(m.id);
    if (!f) {
      const st: StreamStatus = { ...OFF_STATUS, state: 'unavailable', message: 'ffmpeg is not installed on the hub PC. Install it (see the Live stream help), or set its path in the Control room.' };
      this.statusTo(m.id, st);
      return st;
    }
    w.stream?.stop();
    w.stream = new LiveStream(f, streamTarget(row.stream_url, row.stream_key ?? ''), row.stream_key ?? '', (s) => this.statusTo(m.id, s));
    w.streamOn = true;
    w.streamEpoch++;
    w.retries = 0;
    // ffmpeg starts with the stage's first piece (seq 0) from the broadcaster
    this.statusTo(m.id, w.stream.status);
    this.sendViewers(w);
    this.host.audit(me.id, 'webinar.streamStarted', m.id, { url: row.stream_url });
    return w.stream.status;
  }

  private stopStream(id: string, by: string | null): StreamStatus {
    const w = this.live(id);
    w.streamOn = false;
    const s = w.stream;
    w.stream = null;
    if (s) s.stop(); else this.statusTo(id, { ...OFF_STATUS });
    this.sendViewers(w);
    if (by) this.host.audit(by, 'webinar.streamStopped', id, {});
    return w.streamStatus;
  }

  private chunk(deviceId: string, d: Record<string, unknown>): { ok: true } {
    const w = typeof d.id === 'string' ? this.lives.get(d.id) : undefined;
    if (!w || w.broadcaster !== deviceId) throw new WebinarError('Only the PC composing the stage sends the live stream.');
    if (!w.streamOn || !w.stream) return { ok: true };
    const data = typeof d.data === 'string' && d.data.length <= 4 * 1024 * 1024 ? Buffer.from(d.data, 'base64') : null;
    if (!data?.length) return { ok: true };
    // a new recording (seq 0) cannot continue the last one: ffmpeg starts again; pieces of a
    // recording ffmpeg is not reading are dropped (the broadcaster is asked to record afresh)
    if (d.seq === 0) w.stream.start();
    else if (!w.stream.running) return { ok: true };
    w.stream.write(data);
    return { ok: true };
  }

  // ---------------------------------------------------------------- follow-up and survey
  private officeAttendees(id: string, row: Row): string[] {
    if (!row.went_live_at) return [];
    const to = row.ended_at ?? Date.now();
    const rows = this.db.prepare(`SELECT DISTINCT voter FROM webinar_attendance WHERE meeting_id = ? AND office = 1 AND joined_at < ? AND COALESCE(left_at, ?) > ?`).all(id, to, to, row.went_live_at) as Array<{ voter: string }>;
    return rows.map((r) => r.voter).filter((u) => !!this.host.userById(u));
  }

  private followUp(me: PublicUser, d: Record<string, unknown>): { sentInApp: number; mails: WebinarMail[] } {
    const { m, row } = this.hostOnly(d.id, me);
    if (!row.went_live_at) throw new WebinarError('Send the follow-up after the webinar has been live.');
    if (row.state === 'live') throw new WebinarError('End the webinar first.');
    const note = text(d.note, 3000);
    const outside = text(d.outsideLink, 400);
    if (outside && !/^https?:\/\/\S+$/.test(outside)) throw new WebinarError('The recording link for people outside is a web address (https://…).');
    const survey = d.survey !== undefined ? this.fieldsFrom(d.survey) : this.survey(row);
    this.db.prepare('UPDATE webinars SET survey = ?, followup_at = ? WHERE meeting_id = ?').run(JSON.stringify(survey), Date.now(), m.id);
    const recording = typeof d.recordingId === 'string' && d.recordingId ? this.host.recordingLink(me, d.recordingId) : null;
    // colleagues: a message from the system bot in the app
    const staff = new Set(this.staffUsers(m.id));
    const office = this.officeAttendees(m.id, row).filter((u) => !staff.has(u));
    const msg = webinarFollowUpMessage(m.title, me.displayName, note, recording, survey.length > 0, m.id);
    for (const u of office) this.host.tell(u, msg, `webinar-followup-${m.id}-${u}`);
    // people outside: text to send from the organiser's own email
    const gw = this.host.gateway();
    const input = this.mailInput(m, this.row(m.id)!, d.when);
    const att = this.attendanceByRegistrant(m.id, this.row(m.id));
    const mails = (this.db.prepare(`SELECT * FROM webinar_registrants WHERE meeting_id = ? AND status = 'approved' ORDER BY created_at`).all(m.id) as unknown as RegRow[])
      .map((r) => webinarFollowUp(input, { id: r.id, name: r.name, email: r.email, attended: (att.get(r.id) ?? 0) > 0, surveyUrl: survey.length && gw ? webinarSurveyUrl(gw, m.id, r.token) : null }, note, outside || null));
    this.host.audit(me.id, 'webinar.followUp', m.id, { inApp: office.length, outside: mails.length, survey: survey.length > 0 });
    return { sentInApp: office.length, mails };
  }

  private surveyFor(me: PublicUser, d: Record<string, unknown>): { title: string; fields: WebinarField[]; answered: boolean } {
    const { m, row } = this.need(d.id);
    const fields = this.survey(row);
    if (!fields.length) throw new WebinarError('This webinar has no survey.');
    const was = !!this.db.prepare('SELECT 1 FROM webinar_attendance WHERE meeting_id = ? AND voter = ? LIMIT 1').get(m.id, me.id);
    if (!was && !this.staff(m, me.id)) throw new WebinarError('The survey is for the people who attended.');
    return { title: m.title, fields, answered: !!this.db.prepare('SELECT 1 FROM webinar_survey_answers WHERE meeting_id = ? AND voter = ?').get(m.id, me.id) };
  }

  private answerSurvey(me: PublicUser, d: Record<string, unknown>): { ok: true } {
    const { m, row } = this.need(d.id);
    this.surveyFor(me, d);
    this.saveSurvey(m, row, me.id, me.displayName, d.answers);
    return { ok: true };
  }

  private saveSurvey(m: Meeting, row: Row, voter: string, name: string, input: unknown): void {
    const fields = this.survey(row);
    if (!fields.length) throw new WebinarError('This webinar has no survey.');
    let answers: FieldAnswers;
    try { answers = checkAnswers(fields, input); } catch (e) { throw new WebinarError((e as Error).message); }
    if (this.db.prepare('SELECT 1 FROM webinar_survey_answers WHERE meeting_id = ? AND voter = ?').get(m.id, voter)) throw new WebinarError('You answered the survey already. Thank you.', 409);
    this.db.prepare('INSERT INTO webinar_survey_answers (meeting_id, voter, name, answers, at) VALUES (?, ?, ?, ?, ?)').run(m.id, voter, name.slice(0, 80), JSON.stringify(answers), Date.now());
  }

  // ---------------------------------------------------------------- the report
  report(id: string): WebinarReport {
    const { m, row } = this.need(id);
    const from = row.went_live_at;
    const to = row.state === 'ended' && row.ended_at ? row.ended_at : Date.now();
    const segs = this.db.prepare('SELECT * FROM webinar_attendance WHERE meeting_id = ? ORDER BY joined_at').all(id) as Array<{ voter: string; registrant_id: string | null; name: string; office: number; joined_at: number; left_at: number | null; hands: number }>;
    const regs = new Map((this.db.prepare('SELECT id, email FROM webinar_registrants WHERE meeting_id = ?').all(id) as Array<{ id: string; email: string }>).map((r) => [r.id, r.email] as const));
    const people = new Map<string, { voter: string; name: string; office: boolean; registrantId: string | null; spans: Array<[number, number]>; first: number; hands: number }>();
    for (const s of segs) {
      const p = people.get(s.voter) ?? { voter: s.voter, name: s.name, office: !!s.office, registrantId: s.registrant_id, spans: [], first: s.joined_at, hands: 0 };
      p.hands += s.hands;
      if (from) { const a = Math.max(from, s.joined_at), b = Math.min(to, s.left_at ?? to); if (b > a) p.spans.push([a, b]); }
      people.set(s.voter, p);
    }
    const attendees = [...people.values()].map((p) => ({
      name: p.name, email: p.registrantId ? regs.get(p.registrantId) ?? null : this.host.userById(p.voter)?.profile.email ?? null,
      office: p.office, registrantId: p.registrantId, minutes: p.spans.length ? Math.max(1, Math.round(sumIntervals(p.spans).total / 60_000)) : 0, firstSeen: p.first, hands: p.hands,
    }));
    const polls = (this.db.prepare('SELECT * FROM webinar_polls WHERE meeting_id = ? ORDER BY created_at').all(id) as unknown as PollRow[]).map((r) => {
      const v = this.pollView(r, '', true);
      const answers = (this.db.prepare('SELECT name, choices FROM webinar_poll_answers WHERE poll_id = ? ORDER BY at').all(r.id) as Array<{ name: string; choices: string }>)
        .map((a) => ({ name: a.name, choices: parse<number[]>(a.choices, []).map((i) => v.options[i] ?? '') }));
      return { question: v.question, options: v.options.map((t, i) => ({ text: t, votes: v.results?.[i] ?? 0 })), voters: v.voters, answers };
    });
    const handouts = (this.db.prepare('SELECT id, name FROM webinar_handouts WHERE meeting_id = ? ORDER BY added_at').all(id) as Array<{ id: string; name: string }>).map((h) => ({
      name: h.name, downloads: (this.db.prepare('SELECT name, at FROM webinar_downloads WHERE handout_id = ? ORDER BY at').all(h.id) as Array<{ name: string; at: number }>),
    }));
    const survey = {
      fields: this.survey(row),
      answers: (this.db.prepare('SELECT name, answers, at FROM webinar_survey_answers WHERE meeting_id = ? ORDER BY at').all(id) as Array<{ name: string; answers: string; at: number }>).map((a) => ({ name: a.name, at: a.at, answers: parse<FieldAnswers>(a.answers, {}) })),
    };
    const gw = this.host.gateway();
    const att = this.attendanceByRegistrant(id, row);
    return {
      meetingId: id, title: m.title, startsAt: row.starts_at, wentLiveAt: row.went_live_at, endedAt: row.ended_at, peakAudience: row.peak,
      registrants: (this.db.prepare('SELECT * FROM webinar_registrants WHERE meeting_id = ? ORDER BY created_at').all(id) as unknown as RegRow[]).map((r) => ({ ...this.regView(r, gw, row, att), registeredAt: r.created_at })),
      attendees, questions: this.questions(id, '', true).map(({ own: _o, voted: _v, ...q }) => q), polls, handouts, survey,
    };
  }

  /** For meet-reports.ts: the webinar part of a meeting report. */
  reportFor(meetingId: string | null): WebinarReport | null {
    if (!meetingId || !this.row(meetingId)) return null;
    return this.report(meetingId);
  }

  /** Viewers by device (for meet-guests: a browser attendee's session). */
  watching(deviceId: string): boolean { return this.byDevice.has(deviceId); }

  /** The hub is stopping: streams end. */
  stop(): void {
    for (const w of this.lives.values()) { w.stream?.stop(); w.stream = null; if (w.timer) clearTimeout(w.timer); }
  }

  /** For tests: the audience of a webinar now. */
  snapshot(id: string): { viewers: Array<{ name: string; route: StageRoute; web: boolean }>; broadcaster: string | null; speakers: string[] } {
    const w = this.lives.get(id);
    return { viewers: [...(w?.viewers.values() ?? [])].map((v) => ({ name: v.name, route: v.route, web: v.web })), broadcaster: w?.broadcaster ?? null, speakers: [...(w?.speakers ?? [])] };
  }
}
