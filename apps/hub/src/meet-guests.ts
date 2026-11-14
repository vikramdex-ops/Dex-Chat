// Guests who join a meeting from a browser, through the office's gateway. The gateway passes
// their frames to the hub inside its own connection ("guest" frames, remote.ts); this module
// gives each a small session of its own: a passcode check, the lobby, and then only the meeting:
// its Room (signalling, mic and camera, hands, reactions, screen sharing) and the meeting chat.
// A guest has no office account: no Directory, no conversations, no presence, and the names of
// the people in the meeting are all they learn about the office. Guests always wait in the lobby.
import crypto from 'node:crypto';
import { GUEST_NAME_MAX, MEETING_ID_RE, WEB_GUEST_DEVICE_PREFIX, WEB_GUEST_PREFIX, formatMeetingId, isWebGuest, isWebGuestDevice, ulid } from '@dex/core';
import type { GuestDown, GuestRoomView, IceServer, PublicUser, RoomChatLine, RoomInfo, RoomVisitor } from '@dex/core';
import type { Meetings } from './meetings.ts';
import type { Rooms } from './rooms.ts';
import { RoomError } from './rooms.ts';

/** Close codes the gateway understands: 4403 counts as a failed passcode for that address. */
export const GUEST_CLOSE = { badPasscode: 4403, tooMany: 4429, refused: 4409, done: 4000, full: 4503 } as const;

const MAX_SESSIONS = 200;
const FAILS_PER_10_MIN = 10;
const MAX_FRAME = 64 * 1024;

interface Session {
  gid: number;
  ip: string;
  meetingId: string;
  state: 'new' | 'waiting' | 'in';
  name: string;
  userId: string;
  deviceId: string;
  roomId: string | null;
}

export interface GuestHost {
  rooms: Rooms;
  meetings: Meetings;
  send(gid: number, frame: GuestDown): void;
  close(gid: number, code: number, reason: string): void;
  /** Guest links are allowed by the office policy. */
  allowed(): boolean;
  iceServers(): Promise<IceServer[]>;
  userById(id: string): PublicUser | null;
  audit(actorId: string | null, action: string, target: string | null, meta?: Record<string, unknown>): void;
  /** Tell a Room's hosts that a guest could not be let in. */
  tellHosts(room: RoomInfo, name: string, reason: string): void;
  log(level: 'info' | 'warn', msg: string, extra?: Record<string, unknown>): void;
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

  /** The gateway opened a guest connection for this meeting. */
  open(gid: number, ip: string, meetingId: string): void {
    if (this.sessions.has(gid)) return;
    if (this.sessions.size >= MAX_SESSIONS) { this.host.close(gid, GUEST_CLOSE.full, 'Too many guests are connected. Try again in a few minutes.'); return; }
    if (!MEETING_ID_RE.test(meetingId)) { this.host.close(gid, GUEST_CLOSE.badPasscode, 'That meeting link is not valid.'); return; }
    const id = ulid();
    this.sessions.set(gid, { gid, ip: ip.slice(0, 80), meetingId, state: 'new', name: '', userId: `${WEB_GUEST_PREFIX}${id}`, deviceId: `${WEB_GUEST_DEVICE_PREFIX}${id}`, roomId: null });
  }

  /** The guest's connection closed: they leave the lobby or the Room. */
  closed(gid: number): void {
    const s = this.sessions.get(gid);
    if (!s) return;
    this.forget(s);
    if (s.state !== 'new') this.host.rooms.leaveAll(s.deviceId);
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
    if (s.state !== 'new') this.host.rooms.leaveAll(s.deviceId);
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
    if (f.t === 'leave') { this.end(s, GUEST_CLOSE.done, 'You left the meeting.'); return; }
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
    if (!m || !this.host.meetings.passcodeOk(m, f.passcode)) {
      const blocked = this.failed(s.ip);
      this.host.log('info', 'guest passcode refused', { ip: s.ip, meeting: formatMeetingId(s.meetingId) });
      this.end(s, blocked ? GUEST_CLOSE.tooMany : GUEST_CLOSE.badPasscode, blocked ? 'Too many wrong passcodes from your network. Try again in 10 minutes.' : 'The passcode is wrong, or the host turned this link off. Check the invitation.');
      return;
    }
    const name = cleanName(f.name);
    if (!name) { this.host.send(s.gid, { t: 'error', message: 'Enter your name so the host knows who is asking.' }); return; }
    s.name = name;
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
    this.host.send(s.gid, { t: 'lobby', meetingId: formatMeetingId(m.id), title: m.title || 'Meeting', host: this.host.userById(m.hostId)?.displayName ?? 'The host' });
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
      default:
        // a guest session is the meeting and nothing else
        this.host.send(s.gid, { t: 'error', message: 'Not available to guests.' });
    }
  }

  /** The Room as a guest sees it: names and media of the people in it, nothing more. */
  private view(r: RoomInfo): GuestRoomView {
    const hands = new Map((r.hands ?? []).map((h, i) => [h.deviceId, i + 1] as const));
    const nameOf = (userId: string) => {
      if (isWebGuest(userId)) return this.sessions.get(this.byUser.get(userId) ?? -1)?.name ?? 'Guest';
      return this.host.userById(userId)?.displayName ?? 'Someone';
    };
    return {
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
    switch (name) {
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
    if (!s) return;
    if (name === 'room.updated') {
      const r = data as RoomInfo;
      if (s.state === 'in' && r.id === s.roomId) this.host.send(s.gid, { t: 'room', room: this.view(r) });
    } else this.toDevice(s.deviceId, name, data);
  }

  /** For tests and the Control room: how many guests are in meetings now. */
  summary(): { connected: number; waiting: number; inMeetings: number } {
    let waiting = 0, inMeetings = 0;
    for (const s of this.sessions.values()) { if (s.state === 'waiting') waiting++; else if (s.state === 'in') inMeetings++; }
    return { connected: this.sessions.size, waiting, inMeetings };
  }

  /** Random gateway ids are 32-bit; the hub's own test connections use this. */
  static newGid(): number { return crypto.randomInt(1, 0xffffffff); }
}
