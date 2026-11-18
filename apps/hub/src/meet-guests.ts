// Guests who join a meeting from a browser, through the office's gateway. The gateway passes
// their frames to the hub inside its own connection ("guest" frames, remote.ts); this module
// gives each a small session of its own: a passcode check, the lobby, and then only the meeting:
// its Room (signalling, mic and camera, hands, reactions, screen sharing) and the meeting chat.
// A guest has no office account: no Directory, no conversations, no presence, and the names of
// the people in the meeting are all they learn about the office. Guests always wait in the lobby.
import crypto from 'node:crypto';
import { GUEST_FILE_CHUNK, GUEST_FILE_MAX, GUEST_NAME_MAX, MEETING_ID_RE, WEB_GUEST_DEVICE_PREFIX, WEB_GUEST_PREFIX, formatMeetingId, isWebGuest, isWebGuestDevice, ulid } from '@dex/core';
import type { GuestDown, GuestRoomView, IceServer, PublicUser, RoomChatLine, RoomInfo, RoomVisitor, WebinarDown } from '@dex/core';
import type { Meeting, Meetings } from './meetings.ts';
import type { Rooms } from './rooms.ts';
import { RoomError } from './rooms.ts';
import type { Webinars } from './webinars.ts';
import { WebinarError } from './webinars.ts';

/** Close codes the gateway understands: 4403 counts as a failed passcode for that address. */
export const GUEST_CLOSE = { badPasscode: 4403, tooMany: 4429, refused: 4409, done: 4000, full: 4503 } as const;

const MAX_SESSIONS = 200;
const FAILS_PER_10_MIN = 10;
const MAX_FRAME = 64 * 1024;

interface Session {
  gid: number;
  ip: string;
  meetingId: string;
  /** A meeting guest (/m/, the passcode), or a webinar attendee (/w/…/watch, their personal link). */
  kind: 'meeting' | 'webinar';
  state: 'new' | 'waiting' | 'in';
  name: string;
  userId: string;
  deviceId: string;
  roomId: string | null;
  /** A file the guest is sending for the meeting chat, chunk by chunk. */
  upload?: { id: string; name: string; mime: string; size: number; parts: Buffer[]; got: number; next: number } | null;
}

export interface GuestHost {
  rooms: Rooms;
  meetings: Meetings;
  /** Webinars: attendees watching with their personal link, and speakers' one-time passes. */
  webinars?: () => Webinars;
  send(gid: number, frame: GuestDown | WebinarDown): void;
  close(gid: number, code: number, reason: string): void;
  /** Guest links are allowed by the office policy. */
  allowed(): boolean;
  iceServers(): Promise<IceServer[]>;
  userById(id: string): PublicUser | null;
  audit(actorId: string | null, action: string, target: string | null, meta?: Record<string, unknown>): void;
  /** Tell a Room's hosts that a guest could not be let in. */
  tellHosts(room: RoomInfo, name: string, reason: string): void;
  log(level: 'info' | 'warn', msg: string, extra?: Record<string, unknown>): void;
  /** A meeting's name on the meeting site (a webinar's watch page may use it) to its ID. */
  resolve?(ref: string): string | null;
  /** Why a guest with the right passcode cannot ask to join now (cancelled, ended, not open yet), or null. */
  joinProblem?(m: Meeting): string | null;
  /** Why a file from a guest cannot be shared (the office's blocked types, its upload limit), or null. */
  fileProblem?(name: string, size: number): string | null;
  /** Store a guest's file (it is then said in the meeting chat, and saved in the meeting's thread). */
  storeFile?(guestId: string, name: string, mime: string, data: Buffer): { id: string; name: string; size: number };
}

const cleanName = (v: unknown) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, GUEST_NAME_MAX) : '');

/** A chat line as a guest receives it: names only, never an office account's id. */
const forGuest = (l: RoomChatLine): RoomChatLine => ({ ...l, userId: l.guest ? l.userId : '' });

const emptyProfile = { departmentId: null, managerId: null, phone: null, extension: null, location: null, email: null, employeeId: null, joinedOn: null, birthday: null, fields: {} };

export class MeetGuests {
  private readonly host: GuestHost;
  private readonly sessions = new Map<number, Session>();
  private readonly byDevice = new Map<string, number>();
  private readonly byUser = new Map<string, number>();
  private readonly fails = new Map<string, number[]>();

  constructor(host: GuestHost) { this.host = host; }

  get count(): number { return this.sessions.size; }

  /** The gateway opened a guest connection for this meeting (kind 'w': a webinar's watch page). */
  open(gid: number, ip: string, meetingId: string, kind?: string): void {
    if (this.sessions.has(gid)) return;
    const webinar = kind === 'w';
    // a webinar's audience is larger than a meeting's guests
    if (this.sessions.size >= (webinar ? MAX_SESSIONS + 400 : MAX_SESSIONS)) { this.host.close(gid, GUEST_CLOSE.full, 'Too many guests are connected. Try again in a few minutes.'); return; }
    if (!MEETING_ID_RE.test(meetingId)) meetingId = this.host.resolve?.(meetingId) ?? '';
    if (!MEETING_ID_RE.test(meetingId)) { this.host.close(gid, GUEST_CLOSE.badPasscode, 'That meeting link is not valid.'); return; }
    const id = ulid();
    this.sessions.set(gid, { gid, ip: ip.slice(0, 80), meetingId, kind: webinar ? 'webinar' : 'meeting', state: 'new', name: '', userId: `${WEB_GUEST_PREFIX}${id}`, deviceId: `${WEB_GUEST_DEVICE_PREFIX}${id}`, roomId: null });
  }

  /** The guest's connection closed: they leave the lobby or the Room. */
  closed(gid: number): void {
    const s = this.sessions.get(gid);
    if (!s) return;
    this.forget(s);
    if (s.kind === 'webinar') this.host.webinars?.().leaveDevice(s.deviceId);
    else if (s.state !== 'new') this.host.rooms.leaveAll(s.deviceId);
  }

  /** The gateway went away: every guest is gone. */
  dropAll(): void { for (const gid of [...this.sessions.keys()]) this.closed(gid); }

  private forget(s: Session): void {
    this.sessions.delete(s.gid);
    this.byDevice.delete(s.deviceId);
    this.byUser.delete(s.userId);
  }

  /** End the guest's session; the full reason goes as a frame (a close reason is cut at 123 bytes). */
  private end(s: Session, code: number, reason: string): void {
    this.forget(s);
    if (s.kind === 'webinar') this.host.webinars?.().leaveDevice(s.deviceId);
    else if (s.state !== 'new') this.host.rooms.leaveAll(s.deviceId);
    this.host.send(s.gid, { t: 'denied', reason });
    this.host.close(s.gid, code, reason.length > 120 ? `${reason.slice(0, 117)}...` : reason);
  }

  private user(s: Session): PublicUser {
    return { id: s.userId, account: `web\\guest-${s.userId.slice(WEB_GUEST_PREFIX.length).toLowerCase()}`, displayName: s.name, role: 'guest', title: null, statusText: null, availability: 'available', createdAt: 0, profile: emptyProfile, availabilityUntil: null, ooo: null };
  }

  /** Names for the apps (only guests the hub knows now). */
  visitors(userIds: string[]): RoomVisitor[] {
    const out: RoomVisitor[] = [];
    for (const u of userIds) {
      const s = this.sessions.get(this.byUser.get(u) ?? -1);
      if (s) out.push({ userId: s.userId, deviceId: s.deviceId, name: s.name });
    }
    return out;
  }

  private failed(ip: string): boolean {
    const now = Date.now();
    const list = (this.fails.get(ip) ?? []).filter((t) => now - t < 600_000);
    list.push(now);
    this.fails.set(ip, list);
    if (this.fails.size > 5000) for (const [k, v] of this.fails) if (!v.some((t) => now - t < 600_000)) this.fails.delete(k);
    return list.length >= FAILS_PER_10_MIN;
  }

  private blocked(ip: string): boolean {
    const now = Date.now();
    return (this.fails.get(ip) ?? []).filter((t) => now - t < 600_000).length >= FAILS_PER_10_MIN;
  }

  /** A frame from the guest's browser. */
  frame(gid: number, raw: string): void {
    const s = this.sessions.get(gid);
    if (!s) return;
    if (raw.length > MAX_FRAME) { this.end(s, 1009, 'Message too big'); return; }
    let f: { t?: unknown; [k: string]: unknown };
    try { f = JSON.parse(raw); } catch { return; }
    if (!f || typeof f !== 'object') return;
    if (f.t === 'ping') { this.host.send(gid, { t: 'pong' }); return; }
    if (f.t === 'leave') { this.end(s, GUEST_CLOSE.done, s.kind === 'webinar' ? 'You left the webinar.' : 'You left the meeting.'); return; }
    if (s.kind === 'webinar') { this.webinarFrame(s, f); return; }
    if (s.state === 'new') { if (f.t === 'join') void this.join(s, f); else this.host.send(gid, { t: 'error', message: 'Join the meeting first.' }); return; }
    if (s.state !== 'in' || !s.roomId) { this.host.send(gid, { t: 'error', message: 'Wait until the host lets you in.' }); return; }
    try { this.inRoom(s, f); } catch (err) {
      this.host.send(gid, { t: 'error', message: err instanceof RoomError ? err.message : 'That did not work.' });
      if (!(err instanceof RoomError)) this.host.log('warn', 'guest frame failed', { error: (err as Error).message });
    }
  }

  private async join(s: Session, f: Record<string, unknown>): Promise<void> {
    if (this.blocked(s.ip)) { this.end(s, GUEST_CLOSE.tooMany, 'Too many wrong passcodes from your network. Try again in 10 minutes.'); return; }
    if (!this.host.allowed()) { this.end(s, GUEST_CLOSE.refused, 'This office does not let guests join meetings from a browser.'); return; }
    const m = this.host.meetings.get(s.meetingId);
    // someone a webinar's organiser invited to speak comes with a one-time pass instead of the passcode
    const pass = m?.kind === 'webinar' ? this.host.webinars?.().takePass(m.id, f.passcode) ?? null : null;
    if (!m || (!pass && !this.host.meetings.passcodeOk(m, f.passcode))) {
      const blocked = this.failed(s.ip);
      this.host.log('info', 'guest passcode refused', { ip: s.ip, meeting: formatMeetingId(s.meetingId) });
      this.end(s, blocked ? GUEST_CLOSE.tooMany : GUEST_CLOSE.badPasscode, blocked ? 'Too many wrong passcodes from your network. Try again in 10 minutes.' : 'The passcode is wrong, or the host turned this link off. Check the invitation.');
      return;
    }
    // the right passcode: now the guest may hear that it was cancelled, ended or is not open yet
    const problem = pass ? null : this.host.joinProblem?.(m) ?? null;
    if (problem) { this.end(s, GUEST_CLOSE.refused, problem); return; }
    const name = pass ? pass.name : cleanName(f.name);
    if (!name) { this.host.send(s.gid, { t: 'error', message: 'Enter your name so the host knows who is asking.' }); return; }
    s.name = name;
    if (pass) this.host.webinars?.().speakerJoined(m.id, s.userId, pass);
    const live = this.host.rooms.live(m.id);
    if (live?.mode === 'relay') {
      this.host.tellHosts(live, name, 'The meeting runs on the office relay, which browsers cannot reach.');
      this.end(s, GUEST_CLOSE.refused, 'This meeting is held on the office network only (it has more than 8 people), so it cannot be joined from a browser. Ask the host.');
      return;
    }
    if (live?.locked) { this.end(s, GUEST_CLOSE.refused, 'The host has locked this meeting.'); return; }
    this.byDevice.set(s.deviceId, s.gid);
    this.byUser.set(s.userId, s.gid);
    s.state = 'waiting';
    try {
      const res = this.host.rooms.handle('meet.join', this.user(s), s.deviceId, { id: m.id, fromOutside: true }) as { room?: RoomInfo; waiting?: string };
      if (res.room) { await this.admitted(s); return; }
    } catch (err) {
      this.end(s, GUEST_CLOSE.refused, err instanceof RoomError ? err.message : 'The meeting could not be joined.');
      return;
    }
    this.host.audit(null, 'meeting.guestKnocked', m.id, { name, ip: s.ip });
    // still waiting (the hub may have let them in while this ran): the lobby, saying honestly whether a host is in
    if (s.state === 'waiting' && this.sessions.has(s.gid)) this.sendLobby(s, m);
  }

  /** The lobby frame: the meeting, its host, and whether a host is in the Room now (otherwise they have been told). */
  private sendLobby(s: Session, m: Meeting): void {
    const hostIn = this.host.rooms.lobbyOf(m.id)?.hostIn ?? false;
    this.host.send(s.gid, { t: 'lobby', meetingId: formatMeetingId(m.id), title: m.title || 'Meeting', host: this.host.userById(m.hostId)?.displayName ?? 'The host', hostIn });
  }

  /** A meeting's lobby changed (a host came in or left, the Room opened): its waiting guests hear it. */
  lobbyChanged(meetingId: string): void {
    const m = this.host.meetings.get(meetingId);
    if (!m) return;
    for (const s of this.sessions.values()) if (s.kind === 'meeting' && s.state === 'waiting' && s.meetingId === meetingId && s.name) this.sendLobby(s, m);
  }

  /** A webinar attendee's page: their link first, then questions, votes, polls, hands, reactions, signalling and handouts. */
  private webinarFrame(s: Session, f: Record<string, unknown>): void {
    const web = this.host.webinars?.();
    if (!web) { this.end(s, GUEST_CLOSE.refused, 'Webinars are not available on this hub.'); return; }
    if (f.t === 'watch') {
      if (s.state === 'in') return;
      if (this.blocked(s.ip)) { this.end(s, GUEST_CLOSE.tooMany, 'Too many links that did not work from your network. Try again in 10 minutes.'); return; }
      void web.webWatch(s.meetingId, f.token, { userId: s.userId, deviceId: s.deviceId }).then((down) => {
        if (!this.sessions.has(s.gid)) { if (down.t === 'webinar') web.leaveDevice(s.deviceId); return; }
        if (down.t === 'webinar') {
          s.state = 'in';
          s.name = down.self.name;
          this.byDevice.set(s.deviceId, s.gid);
          this.byUser.set(s.userId, s.gid);
          this.host.audit(null, 'webinar.attendeeJoined', s.meetingId, { name: s.name, ip: s.ip });
        }
        this.host.send(s.gid, down);
      }, (err: Error) => {
        if (err instanceof WebinarError && err.status === 403) {
          const blocked = this.failed(s.ip);
          this.end(s, blocked ? GUEST_CLOSE.tooMany : GUEST_CLOSE.badPasscode, blocked ? 'Too many links that did not work from your network. Try again in 10 minutes.' : err.message);
        } else this.end(s, GUEST_CLOSE.refused, err instanceof WebinarError ? err.message : 'The webinar could not be opened.');
      });
      return;
    }
    if (s.state !== 'in') { this.host.send(s.gid, { t: 'error', message: 'Open your link first.' }); return; }
    try {
      if (f.t === 'handout') {
        const h = web.webHandout(s.deviceId, f.id);
        const size = 192 * 1024;
        const chunks = Math.max(1, Math.ceil(h.data.length / size));
        this.host.send(s.gid, { t: 'file', id: h.id, name: h.name, mime: h.mime, size: h.data.length, chunks });
        for (let i = 0; i < chunks; i++) this.host.send(s.gid, { t: 'fileChunk', id: h.id, i, data: h.data.subarray(i * size, (i + 1) * size).toString('base64') });
        return;
      }
      const reply = web.webFrame(s.deviceId, f);
      if (reply) {
        this.host.send(s.gid, reply);
        // invited to speak and accepted: this page opens the meeting page; the attendee session ends
        if (reply.t === 'speak') { this.forget(s); this.host.close(s.gid, GUEST_CLOSE.done, 'Going on stage'); }
      }
    } catch (err) {
      this.host.send(s.gid, { t: 'error', message: err instanceof WebinarError ? err.message : 'That did not work.' });
      if (!(err instanceof WebinarError)) this.host.log('warn', 'webinar frame failed', { error: (err as Error).message });
    }
  }

  /** A host let the guest in: into the Room, with the call's ICE servers and the meeting chat so far. */
  private async admitted(s: Session): Promise<void> {
    let room: RoomInfo | undefined;
    try {
      const res = this.host.rooms.handle('meet.join', this.user(s), s.deviceId, { id: s.meetingId, fromOutside: true }) as { room?: RoomInfo };
      room = res.room;
    } catch (err) {
      this.end(s, GUEST_CLOSE.refused, err instanceof RoomError ? err.message : 'The meeting could not be joined.');
      return;
    }
    if (!room) { this.host.send(s.gid, { t: 'error', message: 'Still waiting for the host.' }); return; }
    s.state = 'in';
    s.roomId = room.id;
    const [iceServers, chat] = await Promise.all([
      this.host.iceServers().catch(() => []),
      Promise.resolve().then(() => this.host.rooms.handle('room.chatLog', this.user(s), s.deviceId, { roomId: room!.id }) as RoomChatLine[]).catch(() => []),
    ]);
    if (!this.sessions.has(s.gid)) return;
    this.host.audit(null, 'meeting.guestJoined', s.meetingId, { name: s.name, ip: s.ip });
    this.host.send(s.gid, { t: 'admitted', self: { deviceId: s.deviceId, name: s.name }, room: this.view(room), iceServers, chat: chat.map(forGuest) });
  }

  private inRoom(s: Session, f: Record<string, unknown>): void {
    const rooms = this.host.rooms;
    const me = this.user(s);
    const roomId = s.roomId!;
    switch (f.t) {
      case 'signal':
        rooms.handle('room.signal', me, s.deviceId, { roomId, toDevice: String(f.to ?? ''), data: f.data });
        return;
      case 'media':
        rooms.handle('room.media', me, s.deviceId, { roomId, muted: f.muted === true, camera: f.camera === true, screen: f.screen === true });
        return;
      case 'hand':
        rooms.handle('room.hand', me, s.deviceId, { roomId, up: f.up === true });
        return;
      case 'react':
        rooms.handle('room.react', me, s.deviceId, { roomId, emoji: String(f.emoji ?? '') });
        return;
      case 'chat':
        rooms.handle('room.chat', me, s.deviceId, { roomId, text: f.text });
        return;
      case 'file':
        this.fileStart(s, f);
        return;
      case 'fileChunk':
        this.fileChunk(s, me, f);
        return;
      default:
        // a guest session is the meeting and nothing else
        this.host.send(s.gid, { t: 'error', message: 'Not available to guests.' });
    }
  }

  /** A guest starts sending a file: its name, type and size are checked against the office's rules first. */
  private fileStart(s: Session, f: Record<string, unknown>): void {
    const id = typeof f.id === 'string' ? f.id.slice(0, 40) : '';
    const name = typeof f.name === 'string' ? f.name.replace(/[\u0000-\u001f\u007f/\\<>:"|?*]/g, '_').trim().slice(0, 160) : '';
    const size = typeof f.size === 'number' && Number.isFinite(f.size) ? Math.floor(f.size) : -1;
    const mime = typeof f.mime === 'string' ? f.mime.slice(0, 100) : 'application/octet-stream';
    if (!id) return;
    const refuse = (reason: string) => this.host.send(s.gid, { t: 'fileDone', id, ok: false, reason });
    if (s.upload) { refuse('Wait until your other file has gone.'); return; }
    if (!name || size <= 0) { refuse('That file is empty.'); return; }
    if (size > GUEST_FILE_MAX) { refuse(`Files from a browser can be up to ${GUEST_FILE_MAX / 1024 / 1024} MB.`); return; }
    const problem = this.host.fileProblem?.(name, size) ?? (this.host.storeFile ? null : 'Files cannot be shared in this meeting.');
    if (problem) { refuse(problem); return; }
    s.upload = { id, name, mime, size, parts: [], got: 0, next: 0 };
  }

  private fileChunk(s: Session, me: PublicUser, f: Record<string, unknown>): void {
    const u = s.upload;
    if (!u || f.id !== u.id) return;
    const fail = (reason: string) => { s.upload = null; this.host.send(s.gid, { t: 'fileDone', id: u.id, ok: false, reason }); };
    if (f.i !== u.next || typeof f.data !== 'string') { fail('The file arrived out of order. Send it again.'); return; }
    const part = Buffer.from(f.data, 'base64');
    if (part.length > GUEST_FILE_CHUNK || u.got + part.length > u.size) { fail('The file is larger than it said. Send it again.'); return; }
    u.parts.push(part);
    u.got += part.length;
    u.next++;
    if (u.got < u.size) return;
    s.upload = null;
    try {
      const stored = this.host.storeFile!(s.userId, u.name, u.mime, Buffer.concat(u.parts));
      this.host.rooms.sayFile(s.roomId!, me, s.deviceId, stored);
      this.host.audit(null, 'meeting.guestFile', s.meetingId, { name: s.name, file: u.name, size: u.size });
      this.host.send(s.gid, { t: 'fileDone', id: u.id, ok: true });
    } catch (err) {
      this.host.send(s.gid, { t: 'fileDone', id: u.id, ok: false, reason: err instanceof RoomError ? err.message : 'The file could not be shared.' });
      if (!(err instanceof RoomError)) this.host.log('warn', 'guest file failed', { error: (err as Error).message });
    }
  }

  /** The Room as a guest sees it: names and media of the people in it, nothing more. */
  private view(r: RoomInfo): GuestRoomView {
    const hands = new Map((r.hands ?? []).map((h, i) => [h.deviceId, i + 1] as const));
    const nameOf = (userId: string) => {
      if (isWebGuest(userId)) return this.sessions.get(this.byUser.get(userId) ?? -1)?.name ?? 'Guest';
      return this.host.userById(userId)?.displayName ?? 'Someone';
    };
    // let in before the host came: the page says who has been told and will join
    const hostHere = r.participants.some((p) => p.userId === r.hostId || (r.coHosts ?? []).includes(p.userId));
    const hostAway = !hostHere && r.hostId && !r.parentId ? this.host.userById(r.hostId)?.displayName ?? 'The host' : null;
    return {
      ...(hostAway ? { hostAway } : {}),
      roomId: r.id, meetingId: r.meetingId ? formatMeetingId(r.meetingId) : '', title: r.title || 'Meeting', startedAt: r.startedAt, locked: !!r.locked,
      seats: r.participants.map((p) => ({
        deviceId: p.deviceId, name: nameOf(p.userId), muted: p.muted, camera: p.camera, screen: p.screen,
        host: p.userId === r.hostId || (r.coHosts ?? []).includes(p.userId), guest: isWebGuest(p.userId), hand: hands.get(p.deviceId) ?? 0,
      })),
      breakout: r.breakoutName ?? null,
      returningAt: r.breakouts?.returningAt ?? null,
      note: r.breakouts?.note ? { text: r.breakouts.note.text, at: r.breakouts.note.at } : null,
    };
  }

  isGuestDevice(deviceId: string): boolean { return isWebGuestDevice(deviceId) && this.byDevice.has(deviceId); }

  /** An event the Rooms sent to a guest's device. */
  toDevice(deviceId: string, name: string, data: unknown): void {
    const s = this.sessions.get(this.byDevice.get(deviceId) ?? -1);
    if (!s) return;
    const d = data as Record<string, unknown>;
    if (s.kind === 'webinar') {
      if (name.startsWith('web.')) this.host.send(s.gid, { t: 'w', name, data });
      return;
    }
    switch (name) {
      case 'web.demoted':
        // a webinar speaker goes back to watching with their personal link (kept by the watch page)
        this.forget(s);
        this.host.rooms.leaveAll(s.deviceId);
        this.host.send(s.gid, { t: 'demoted', to: `/w/${s.meetingId}/watch` });
        this.host.close(s.gid, GUEST_CLOSE.done, 'Back to the audience');
        return;
      case 'meet.lobby':
        if (d.state === 'admitted') void this.admitted(s);
        else if (d.state === 'denied') this.end(s, GUEST_CLOSE.done, s.state === 'waiting' ? 'The host did not let you in.' : 'The meeting has ended.');
        return;
      case 'room.signal':
        this.host.send(s.gid, { t: 'signal', from: String(d.fromDevice), data: d.data });
        return;
      case 'room.muted':
        this.host.send(s.gid, { t: 'muted', by: this.host.userById(String(d.by))?.displayName ?? 'The host' });
        return;
      case 'room.unmuteAsk':
        this.host.send(s.gid, { t: 'unmuteAsk', by: this.host.userById(String(d.by))?.displayName ?? 'The host' });
        return;
      case 'room.removed':
        this.host.audit(String(d.by ?? '') || null, 'meeting.guestRemoved', s.meetingId, { name: s.name });
        this.end(s, GUEST_CLOSE.done, 'A host took you out of the meeting.');
        return;
      case 'room.reaction':
        this.host.send(s.gid, { t: 'reaction', deviceId: String(d.deviceId), emoji: String(d.emoji) });
        return;
      case 'room.chat':
        this.host.send(s.gid, { t: 'chat', line: forGuest(d as unknown as RoomChatLine) });
        return;
      case 'room.moved': {
        const room = d.room as RoomInfo;
        s.roomId = room.id;
        this.host.send(s.gid, { t: 'moved', room: this.view(room) });
        return;
      }
      case 'room.breakoutNote': {
        const room = s.roomId ? this.host.rooms.roomOf(s.deviceId, s.roomId) : null;
        if (room) this.host.send(s.gid, { t: 'room', room: this.view(room) });
        return;
      }
      case 'room.ended':
        if (d.roomId === s.roomId) this.end(s, GUEST_CLOSE.done, d.endedBy ? 'The host ended the meeting.' : 'The meeting has ended.');
        return;
    }
  }

  /** Events the Rooms sent to people: the Room's changes reach a guest in it. */
  toUser(userId: string, name: string, data: unknown): void {
    const s = this.sessions.get(this.byUser.get(userId) ?? -1);
    if (!s || s.kind === 'webinar') return;
    if (name === 'room.updated') {
      const r = data as RoomInfo;
      if (s.state === 'in' && r.id === s.roomId) this.host.send(s.gid, { t: 'room', room: this.view(r) });
    } else this.toDevice(s.deviceId, name, data);
  }

  /** For tests and the Control room: how many guests are in meetings now. */
  summary(): { connected: number; waiting: number; inMeetings: number } {
    let waiting = 0, inMeetings = 0;
    for (const s of this.sessions.values()) { if (s.kind === 'webinar') continue; if (s.state === 'waiting') waiting++; else if (s.state === 'in') inMeetings++; }
    return { connected: this.sessions.size, waiting, inMeetings };
  }

  /** Random gateway ids are 32-bit; the hub's own test connections use this. */
  static newGid(): number { return crypto.randomInt(1, 0xffffffff); }
}
