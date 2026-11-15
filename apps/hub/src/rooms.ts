// Rooms: voice and video calls, and the meetings they are held under. The hub only does
// signalling (who is in the call, offers, answers and ICE candidates) and the meeting's rules
// (lobby, lock, host and co-hosts, hands, reactions, spotlight, mute requests). Audio and video
// travel directly between the PCs on the LAN, or through the hub's relay for large Rooms.
import { MEETING_REACTIONS, ROOM_CHAT_MAX, isWebGuest, ulid } from '@dex/core';
import type { LobbyEntry, MeetingInfo, PublicUser, RaisedHand, RoomChatLine, RoomInfo, RoomVisitor } from '@dex/core';
import { MeetingError, Meetings } from './meetings.ts';
import type { Meeting } from './meetings.ts';
import { Breakouts } from './breakouts.ts';
import type { RoomTracker } from './meet-reports.ts';

export class RoomError extends Error {}

const RING_TIMEOUT_MS = 45_000;
const MAX_PARTICIPANTS = 8; // a full mesh: beyond this, quality drops on ordinary PCs
const RELAY_CAPACITY = 50; // through the hub's relay
const MAX_LOBBY = 100;
const REACTION_GAP_MS = 250;
const REACTIONS_PER_10S = 12;

export interface Room extends RoomInfo {
  ringTimer: NodeJS.Timeout | null;
  everJoined: Set<string>;
  meeting: Meeting | null;
  /** Let in from the lobby (or by ID): may come and go without waiting again. */
  admittedUsers: Set<string>;
  /** Taken out by a host: they wait in the lobby to come back. */
  removedUsers: Set<string>;
  lobbyList: LobbyEntry[];
  handList: RaisedHand[];
  coHostSet: Set<string>;
  /** The meeting chat (shared by a meeting's breakouts: the same array). */
  chat: RoomChatLine[];
}

/** What breakout rooms (breakouts.ts) use of the Rooms. */
export interface RoomsCore {
  rooms: Map<string, Room>;
  host: RoomHost;
  publish(r: Room): void;
  view(r: Room, forHost?: boolean): RoomInfo;
  isHost(r: Room, userId: string): boolean;
  capacity(r: RoomInfo): number;
}

export interface RoomHost {
  members(convId: string): string[];
  deliverToUsers(userIds: string[], name: string, data: unknown): void;
  deliverToDevice(deviceId: string, name: string, data: unknown): void;
  broadcast(name: string, data: unknown): void;
  /** A call ended: e.g. record it in the conversation. */
  ended?(room: RoomInfo, missed: boolean, durationMs: number): void;
  /** The office policy lets people record calls. */
  allowRecording?(): boolean;
  /** The hub can relay large Rooms. */
  relayAvailable?(): boolean;
  /** A device left a Room, or a Room ended (the relay closes its tracks). */
  deviceLeft?(roomId: string, deviceId: string): void;
  roomClosed?(roomId: string): void;
  /** Meeting records (IDs, settings, the log); without it Rooms are plain calls. */
  meetings?: Meetings;
  /** Names of browser guests (they have no office account), for the apps to show. */
  visitorsOf?(userIds: string[]): RoomVisitor[];
  /** The office's audit log. */
  audit?(actorId: string | null, action: string, target: string | null, meta?: Record<string, unknown>): void;
  /** Attendance, hands and reactions, for the meeting's report. */
  track?: RoomTracker;
  /** Webinars (webinars.ts): who may be on the stage, and the stage's Room as it changes and ends. */
  webinar?: WebinarHooks;
}

/** What a webinar needs from its Room: attendees never enter it, they watch the stage. */
export interface WebinarHooks {
  /** The organiser, a co-host, a panelist, or someone the organiser invited to speak. */
  onStage(m: Meeting, userId: string): boolean;
  changed(r: RoomInfo): void;
  ended(r: RoomInfo): void;
}

/** A small sliding-window limiter: true when the key may act now. */
class Limiter {
  private readonly hits = new Map<string, number[]>();
  allow(key: string, max: number, windowMs: number, minGapMs = 0, now = Date.now()): boolean {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= max || (minGapMs && list.length && now - list[list.length - 1] < minGapMs)) { this.hits.set(key, list); return false; }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (!v.length || now - v[v.length - 1] > windowMs) this.hits.delete(k);
    return true;
  }
  forget(prefix: string): void { for (const k of [...this.hits.keys()]) if (k.startsWith(prefix)) this.hits.delete(k); }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

export class Rooms {
  readonly rooms = new Map<string, Room>();
  readonly host: RoomHost;
  /** People who came by a meeting's ID before it started, by meeting ID. */
  private readonly waiting = new Map<string, LobbyEntry[]>();
  private readonly limits = new Limiter();
  readonly breakouts: Breakouts;

  constructor(host: RoomHost) {
    this.host = host;
    this.breakouts = new Breakouts(this);
  }

  inRoomUsers(): string[] {
    return [...new Set([...this.rooms.values()].flatMap((r) => r.participants.map((p) => p.userId)))];
  }

  isHost(r: Room, userId: string): boolean { return r.hostId === userId || r.coHostSet.has(userId); }

  view(r: Room, forHost = false): RoomInfo {
    return {
      id: r.id, convId: r.convId, startedBy: r.startedBy, startedAt: r.startedAt, video: r.video, participants: r.participants.map((p) => ({ ...p })),
      ringing: [...r.ringing], mode: r.mode ?? 'mesh', capacity: this.capacity(r),
      ...(r.meeting ? { meetingId: r.meeting.id, meetingKind: r.meeting.kind, title: r.meeting.title || undefined, settings: { ...r.meeting.settings } } : {}),
      hostId: r.hostId, coHosts: [...r.coHostSet], locked: !!r.locked, hands: r.handList.map((h) => ({ ...h })), spotlight: r.spotlight ?? null,
      ...(forHost ? { lobby: r.lobbyList.map((l) => ({ ...l })) } : {}),
      ...this.extras(r),
    };
  }

  /** Browser guests' names, and the meeting's breakouts. */
  private extras(r: Room): Partial<RoomInfo> {
    const ids = [...r.participants.map((p) => p.userId), ...r.lobbyList.map((l) => l.userId)].filter(isWebGuest);
    const visitors = ids.length && this.host.visitorsOf ? this.host.visitorsOf([...new Set(ids)]) : [];
    const main = this.breakouts.main(r);
    const breakouts = main.breakouts ? this.breakouts.view(main) : null;
    return {
      ...(visitors.length ? { visitors } : {}),
      ...(breakouts ? { breakouts } : {}),
      ...(r.parentId ? { parentId: r.parentId, breakoutName: r.breakoutName } : {}),
    };
  }

  capacity(r: RoomInfo): number { return r.mode === 'relay' ? RELAY_CAPACITY : MAX_PARTICIPANTS; }

  /** The Room a device is in (for the relay). */
  roomOf(deviceId: string, roomId?: unknown): RoomInfo | null {
    const r = typeof roomId === 'string' ? this.rooms.get(roomId) : [...this.rooms.values()].find((x) => x.participants.some((p) => p.deviceId === deviceId));
    return r && r.participants.some((p) => p.deviceId === deviceId) ? r : null;
  }

  /** Who hears about a Room: its conversation, everyone in it, and people let in from outside. */
  private audience(r: Room): string[] {
    // a breakout is news only to the people in it and the meeting's hosts
    if (r.parentId) {
      const fam = this.breakouts.family(r);
      return [...new Set([...r.participants.map((p) => p.userId), ...fam.flatMap((x) => x.participants.map((p) => p.userId)).filter((u) => this.isHost(r, u))])];
    }
    return [...new Set([...this.host.members(r.convId), ...r.participants.map((p) => p.userId), ...r.admittedUsers])];
  }

  publish(r: Room): void {
    if (r.meeting?.kind === 'webinar' && !r.parentId) this.host.webinar?.changed(this.view(r));
    const all = this.audience(r);
    const hosts = all.filter((u) => this.isHost(r, u));
    if (hosts.length) this.host.deliverToUsers(hosts, 'room.updated', this.view(r, true));
    const rest = all.filter((u) => !this.isHost(r, u));
    if (rest.length) this.host.deliverToUsers(rest, 'room.updated', this.view(r));
  }

  private setBusy(userId: string): void {
    const inRoom = this.inRoomUsers().includes(userId);
    this.host.broadcast('room.busy', { userId, inRoom });
  }

  private canSee(r: Room, userId: string): boolean {
    return this.host.members(r.convId).includes(userId) || r.participants.some((p) => p.userId === userId) || r.admittedUsers.has(userId) || r.ringing.includes(userId);
  }

  private get(roomId: unknown, me: PublicUser): Room {
    const r = typeof roomId === 'string' ? this.rooms.get(roomId) : undefined;
    if (!r || !this.canSee(r, me.id)) throw new RoomError('That call has ended.');
    return r;
  }

  /** The Room and the participant asking (they must be in it). */
  private mine(roomId: unknown, me: PublicUser, deviceId: string): Room {
    const r = this.get(roomId, me);
    if (!r.participants.some((p) => p.deviceId === deviceId)) throw new RoomError('Not in this call.');
    return r;
  }

  private hosted(roomId: unknown, me: PublicUser, deviceId: string): Room {
    const r = this.mine(roomId, me, deviceId);
    if (!this.isHost(r, me.id)) throw new RoomError('Only the host and co-hosts can do that.');
    return r;
  }

  private end(r: Room, endedBy?: string): void {
    // a breakout ends with its meeting
    if (r.parentId) { const main = this.rooms.get(r.parentId); if (main) { this.end(main, endedBy); return; } }
    if (r.breakouts) this.breakouts.endedWith(r);
    if (r.ringTimer) clearTimeout(r.ringTimer);
    this.rooms.delete(r.id);
    this.host.track?.closed(r.id);
    if (r.meeting) this.host.audit?.(endedBy ?? null, 'meeting.ended', r.meeting.id, { roomId: r.id, durationMs: Date.now() - r.startedAt, people: r.everJoined.size, endedForEveryone: !!endedBy });
    this.limits.forget(`${r.id}:`);
    this.host.roomClosed?.(r.id);
    const missed = r.everJoined.size <= 1;
    const durationMs = Date.now() - r.startedAt;
    // people still waiting in the lobby are told it is over
    for (const l of r.lobbyList) this.host.deliverToDevice(l.deviceId, 'meet.lobby', { meetingId: r.meeting?.id ?? '', state: 'denied' });
    this.host.deliverToUsers(this.audience(r), 'room.ended', { roomId: r.id, convId: r.convId, missed, startedBy: r.startedBy, durationMs, ...(endedBy ? { endedBy } : {}) });
    const view = this.view(r);
    if (r.meeting?.kind === 'webinar') this.host.webinar?.ended(view);
    this.host.ended?.(view, missed, durationMs);
    // a missed call is not a meeting; anything else goes into "Recent meetings"
    if (this.host.meetings && (!missed || (r.meeting && r.meeting.kind !== 'conversation'))) {
      try { this.host.meetings.log(view, r.meeting, r.meeting?.title ?? '', [...r.everJoined], durationMs); } catch { /* the call still ended */ }
    }
  }

  /** Open a Room in a conversation (the caller is first in). */
  private open(convId: string, me: PublicUser, deviceId: string, video: boolean, meeting: Meeting | null, ring: boolean, fromOutside: boolean): Room {
    const members = this.host.members(convId);
    this.leaveAll(deviceId);
    const expected = Math.max(members.length, meeting && this.host.meetings ? this.host.meetings.expected(meeting) : 0);
    const hostId = meeting && meeting.kind !== 'conversation' ? meeting.hostId : me.id;
    const room: Room = {
      id: ulid(), convId, startedBy: me.id, startedAt: Date.now(), video,
      // a conversation bigger than a mesh can hold goes through the hub's relay; a webinar's stage
      // is always PC to PC (its attendees get the composed stage, webinars.ts)
      mode: meeting?.kind !== 'webinar' && expected > MAX_PARTICIPANTS && !fromOutside && this.host.relayAvailable?.() ? 'relay' : 'mesh',
      participants: [{ userId: me.id, deviceId, joinedAt: Date.now(), muted: false, camera: video, screen: false }],
      ringing: ring ? members.filter((m) => m !== me.id) : [], ringTimer: null, everJoined: new Set([me.id]),
      meeting, hostId, locked: false, spotlight: null,
      admittedUsers: new Set(), removedUsers: new Set(), lobbyList: [], handList: [],
      coHostSet: new Set(meeting && meeting.kind !== 'conversation' ? meeting.coHosts : []),
      chat: [],
    };
    // nobody runs it yet (the host is not here): the first member of the office in it does
    if (!this.isHost(room, me.id) && me.role !== 'guest') room.coHostSet.add(me.id);
    this.rooms.set(room.id, room);
    this.host.track?.opened(room);
    this.host.track?.joined(room.id, me.id, deviceId, me.displayName);
    if (meeting) this.host.audit?.(me.id, 'meeting.started', meeting.id, { roomId: room.id, title: meeting.title, mode: room.mode });
    if (room.ringing.length) {
      room.ringTimer = setTimeout(() => {
        room.ringTimer = null;
        room.ringing = [];
        if (room.participants.length <= 1 && room.everJoined.size <= 1 && (!room.meeting || room.meeting.kind === 'conversation')) this.end(room);
        else if (this.rooms.has(room.id)) this.publish(room);
      }, RING_TIMEOUT_MS);
      room.ringTimer.unref?.();
      this.host.deliverToUsers(room.ringing, 'room.ring', { room: this.view(room), from: me.id });
    }
    this.publish(room);
    this.setBusy(me.id);
    if (meeting) this.releaseWaiting(room);
    return room;
  }

  /** Put a device in a Room. */
  private enter(r: Room, me: PublicUser, deviceId: string, fromOutside: boolean): RoomInfo {
    if (r.participants.some((p) => p.deviceId === deviceId)) return this.view(r, this.isHost(r, me.id));
    if (r.participants.length >= this.capacity(r)) throw new RoomError(`This Room is full (${this.capacity(r)} people).`);
    if (r.mode === 'relay' && fromOutside) throw new RoomError('This Room is large, so it runs through the office hub: join it from the office network.');
    this.leaveAll(deviceId);
    r.participants.push({ userId: me.id, deviceId, joinedAt: Date.now(), muted: false, camera: false, screen: false });
    r.ringing = r.ringing.filter((u) => u !== me.id);
    r.everJoined.add(me.id);
    r.lobbyList = r.lobbyList.filter((l) => l.deviceId !== deviceId);
    this.host.track?.joined(this.breakouts.main(r).id, me.id, deviceId, me.displayName);
    const hostCame = this.isHost(r, me.id);
    this.publish(r);
    this.setBusy(me.id);
    if (hostCame) this.releaseWaiting(r);
    return this.view(r, this.isHost(r, me.id));
  }

  /** Must this person wait to be let in? */
  private mustWait(r: Room, me: PublicUser): boolean {
    if (this.isHost(r, me.id)) return false;
    if (r.removedUsers.has(me.id)) return true;
    if (r.admittedUsers.has(me.id)) return false;
    // someone the organiser of a webinar invited to speak comes straight onto the stage
    if (r.meeting?.kind === 'webinar' && this.host.webinar?.onStage(r.meeting, me.id)) return false;
    // guests from a browser are always let in by a host
    if (isWebGuest(me.id)) return true;
    const rule = r.meeting?.settings.lobby ?? 'off';
    if (rule === 'off') return false;
    if (rule === 'everyone') return true;
    // someone rung into the Room was called in by a person inside it
    if (r.ringing.includes(me.id)) return false;
    return me.role === 'guest' || !r.meeting || !this.host.meetings?.insider(r.meeting, me.id);
  }

  /** Someone waits in a Room's lobby; the hosts see them. */
  private knock(r: Room, me: PublicUser, deviceId: string): void {
    if (!r.lobbyList.some((l) => l.deviceId === deviceId)) {
      if (r.lobbyList.length >= MAX_LOBBY) throw new RoomError('The lobby is full. Try again in a moment.');
      r.lobbyList.push({ userId: me.id, deviceId, at: Date.now(), reason: 'admit' });
    }
    this.publish(r);
  }

  /** A Room started or its host arrived: people waiting by the meeting's ID come in, or move to its lobby. */
  private releaseWaiting(r: Room): void {
    const m = r.meeting;
    if (!m) return;
    const list = this.waiting.get(m.id);
    if (!list?.length) return;
    const hostHere = r.participants.some((p) => this.isHost(r, p.userId));
    const keep: LobbyEntry[] = [];
    for (const w of list) {
      if (w.reason === 'host' && !hostHere && !m.settings.joinBeforeHost) { keep.push(w); continue; }
      const needsHost = w.reason === 'admit';
      if (needsHost) {
        if (!r.lobbyList.some((l) => l.deviceId === w.deviceId) && r.lobbyList.length < MAX_LOBBY) r.lobbyList.push({ ...w, reason: 'admit' });
        this.host.deliverToDevice(w.deviceId, 'meet.lobby', { meetingId: m.id, state: 'waiting', reason: 'admit' });
      } else this.host.deliverToDevice(w.deviceId, 'meet.lobby', { meetingId: m.id, state: 'admitted' });
    }
    if (keep.length) this.waiting.set(m.id, keep); else this.waiting.delete(m.id);
    this.publish(r);
  }

  private runningFor(m: Meeting): Room | undefined {
    return [...this.rooms.values()].find((r) => !r.parentId && (r.meeting?.id === m.id || (!!m.convId && r.convId === m.convId)));
  }

  /** The meeting's main Room while it runs (for browser guests: is it on the relay?). */
  live(meetingId: string): RoomInfo | null {
    const m = this.host.meetings?.get(meetingId);
    const r = m ? this.runningFor(m) : undefined;
    return r ? this.view(r) : null;
  }

  private meetingInfo(m: Meeting): MeetingInfo {
    const live = this.runningFor(m);
    return this.host.meetings!.info(m, live ?? null);
  }

  private meetings(): Meetings {
    if (!this.host.meetings) throw new RoomError('Meetings are not available on this hub.');
    return this.host.meetings;
  }

  /** Join a meeting by its ID. */
  private joinMeeting(m: Meeting, me: PublicUser, deviceId: string, fromOutside: boolean): unknown {
    const store = this.meetings();
    // a webinar's attendees watch the stage; only its organiser, panelists and invited speakers (and
    // browser guests a host lets in through the guest link) come into its Room
    if (m.kind === 'webinar' && !isWebGuest(me.id) && !(this.host.webinar?.onStage(m, me.id) ?? store.insider(m, me.id))) {
      throw new RoomError('You watch this webinar as an attendee: open it from the Meet lens.');
    }
    const r = this.runningFor(m);
    if (r) {
      if (r.participants.some((p) => p.deviceId === deviceId)) return { room: this.view(r, this.isHost(r, me.id)) };
      if (r.locked && !this.isHost(r, me.id)) throw new RoomError('The host has locked this meeting. Ask them to unlock it.');
      if (this.mustWait(r, me)) { this.knock(r, me, deviceId); return { waiting: 'admit', meeting: this.meetingInfo(m) }; }
      if (!this.host.members(r.convId).includes(me.id)) { r.admittedUsers.add(me.id); store.admitted(m, me.id); }
      return { room: this.enter(r, me, deviceId, fromOutside) };
    }
    // not started yet
    const isHost = m.hostId === me.id || m.coHosts.includes(me.id);
    const outsider = me.role === 'guest' || !store.insider(m, me.id);
    const needsAdmit = !isHost && (isWebGuest(me.id) || m.settings.lobby === 'everyone' || (m.settings.lobby === 'outside' && outsider));
    if (!isHost && (!m.settings.joinBeforeHost || needsAdmit)) {
      const list = this.waiting.get(m.id) ?? [];
      if (!list.some((w) => w.deviceId === deviceId)) {
        if (list.length >= MAX_LOBBY) throw new RoomError('Too many people are waiting for this meeting. Try again in a moment.');
        this.leaveAll(deviceId);
        list.push({ userId: me.id, deviceId, at: Date.now(), reason: needsAdmit ? 'admit' : 'host' });
        this.waiting.set(m.id, list);
      }
      return { waiting: needsAdmit && m.settings.joinBeforeHost ? 'admit' : 'host', meeting: this.meetingInfo(m) };
    }
    const convId = store.ensureConv(m);
    if (!this.host.members(convId).includes(me.id)) store.admitted(m, me.id);
    const room = this.open(convId, me, deviceId, false, m, m.kind !== 'personal', fromOutside);
    if (!this.host.members(convId).includes(me.id)) room.admittedUsers.add(me.id);
    return { room: this.view(room, this.isHost(room, me.id)) };
  }

  handle(op: string, me: PublicUser, deviceId: string, d: Record<string, unknown>): unknown {
    try {
      return this.handleOp(op, me, deviceId, d);
    } catch (err) {
      if (err instanceof MeetingError) throw new RoomError(err.message);
      throw err;
    }
  }

  private handleOp(op: string, me: PublicUser, deviceId: string, d: Record<string, unknown>): unknown {
    const fromOutside = d.fromOutside === true;
    switch (op) {
      case 'room.list':
        return [...this.rooms.values()].filter((r) => this.canSee(r, me.id)).map((r) => this.view(r, this.isHost(r, me.id)));

      case 'room.start': {
        const convId = String(d.convId ?? '');
        const members = this.host.members(convId);
        if (!members.includes(me.id)) throw new RoomError('Conversation not found.');
        // one Room per conversation: starting again joins the running one
        const running = [...this.rooms.values()].find((r) => r.convId === convId && !r.parentId);
        if (running) return this.handleOp('room.join', me, deviceId, { roomId: running.id, fromOutside });
        const meeting = this.host.meetings ? this.host.meetings.forConv(convId, me.id) : null;
        const ownSpace = meeting && (meeting.kind === 'instant' || meeting.kind === 'personal');
        if (members.length < 2 && !ownSpace) throw new RoomError('There is no one else here to call.');
        if (meeting && !(meeting.hostId === me.id || meeting.coHosts.includes(me.id)) && meeting.kind !== 'conversation' && meeting.kind !== 'event' && !meeting.settings.joinBeforeHost) {
          throw new RoomError('This meeting starts when its host arrives.');
        }
        const room = this.open(convId, me, deviceId, d.video === true, meeting, meeting?.kind !== 'personal', fromOutside);
        return this.view(room, this.isHost(room, me.id));
      }

      case 'room.join': {
        const r = this.get(d.roomId, me);
        if (r.participants.some((p) => p.deviceId === deviceId)) return this.view(r, this.isHost(r, me.id));
        if (r.parentId) throw new RoomError('A host moves people into breakout rooms. Join the meeting itself.');
        if (r.locked && !this.isHost(r, me.id)) throw new RoomError('The host has locked this meeting. Ask them to unlock it.');
        if (this.mustWait(r, me)) throw new RoomError('This meeting has a lobby: join it with its meeting ID so the host can let you in.');
        return this.enter(r, me, deviceId, fromOutside);
      }

      case 'room.decline': {
        const r = this.get(d.roomId, me);
        r.ringing = r.ringing.filter((u) => u !== me.id);
        // the only person called said no: the call is over
        if (!r.ringing.length && r.participants.length <= 1 && r.everJoined.size <= 1 && (!r.meeting || r.meeting.kind === 'conversation')) this.end(r);
        else this.publish(r);
        return { ok: true };
      }

      case 'room.leave': {
        const r = this.get(d.roomId, me);
        this.removeDevice(r, deviceId);
        return { ok: true };
      }

      case 'room.signal': {
        const r = this.get(d.roomId, me);
        const to = String(d.toDevice ?? '');
        if (!r.participants.some((p) => p.deviceId === deviceId) || !r.participants.some((p) => p.deviceId === to)) throw new RoomError('Not in this call.');
        const size = JSON.stringify(d.data ?? null).length;
        if (size > 64 * 1024) throw new RoomError('Signal too large.');
        this.host.deliverToDevice(to, 'room.signal', { roomId: r.id, fromDevice: deviceId, fromUser: me.id, data: d.data });
        return { ok: true };
      }

      case 'room.invite': {
        const r = this.get(d.roomId, me);
        if (!r.participants.some((p) => p.userId === me.id)) throw new RoomError('Join the call first.');
        if (r.locked && !this.isHost(r, me.id)) throw new RoomError('The host has locked this meeting.');
        const members = this.host.members(r.convId);
        const ids = (Array.isArray(d.userIds) ? d.userIds.map(String) : [])
          .filter((u) => members.includes(u) && !r.participants.some((p) => p.userId === u) && !r.ringing.includes(u)).slice(0, this.capacity(r));
        if (!ids.length) throw new RoomError('Everyone you chose is already in the call or being rung.');
        if (r.participants.length + ids.length > this.capacity(r)) throw new RoomError(`A Room holds up to ${this.capacity(r)} people.`);
        r.ringing.push(...ids);
        // rung in by someone inside: they need not wait in the lobby
        for (const u of ids) r.admittedUsers.add(u);
        const stop = setTimeout(() => { r.ringing = r.ringing.filter((u) => !ids.includes(u)); if (this.rooms.has(r.id)) this.publish(r); }, RING_TIMEOUT_MS);
        stop.unref?.();
        this.host.deliverToUsers(ids, 'room.ring', { room: this.view(r), from: me.id });
        this.publish(r);
        return this.view(r, this.isHost(r, me.id));
      }
      case 'room.record': {
        const r = this.get(d.roomId, me);
        const p = r.participants.find((x) => x.deviceId === deviceId);
        if (!p) throw new RoomError('Not in this call.');
        if (d.on === true && this.host.allowRecording && !this.host.allowRecording()) throw new RoomError('Recording calls is turned off for this office.');
        p.recording = d.on === true;
        this.publish(r);
        return { ok: true };
      }
      case 'room.media': {
        const r = this.get(d.roomId, me);
        const p = r.participants.find((x) => x.deviceId === deviceId);
        if (!p) throw new RoomError('Not in this call.');
        p.muted = d.muted === true; p.camera = d.camera === true; p.screen = d.screen === true;
        this.publish(r);
        return { ok: true };
      }

      // ------------------------------------------------------------ meetings
      case 'meet.create': {
        const store = this.meetings();
        if (typeof d.convId === 'string') {
          if (!this.host.members(d.convId).includes(me.id)) throw new RoomError('Conversation not found.');
          return this.meetingInfo(store.forConv(d.convId, me.id));
        }
        if (!this.limits.allow(`create:${me.id}`, 10, 60_000)) throw new RoomError('You started several meetings just now. Wait a minute.');
        return this.meetingInfo(store.createInstant(me, d.title, d.invite, d.settings));
      }
      case 'meet.event':
        return this.meetingInfo(this.meetings().forEvent(me, d.eventId));
      case 'meet.personal':
        return this.meetingInfo(this.meetings().personal(me));
      case 'meet.get': {
        if (!this.limits.allow(`lookup:${me.id}`, 30, 60_000)) throw new RoomError('Too many meeting IDs tried. Wait a minute.');
        const m = this.meetings().get(d.id);
        if (!m) throw new RoomError('No meeting has that ID. Check the number.');
        return this.meetingInfo(m);
      }
      case 'meet.settings': {
        const store = this.meetings();
        const m = store.get(d.id);
        if (!m) throw new RoomError('No meeting has that ID.');
        const r = this.runningFor(m);
        const may = m.hostId === me.id || m.coHosts.includes(me.id) || (!!r && this.isHost(r, me.id) && r.participants.some((p) => p.userId === me.id));
        if (!may) throw new RoomError('Only the host and co-hosts can change the meeting.');
        const next = store.update(m, me, d);
        if (r?.meeting) { r.meeting.settings = next.settings; r.meeting.title = next.title; this.publish(r); }
        return this.meetingInfo(next);
      }
      case 'meet.join': {
        if (!this.limits.allow(`lookup:${me.id}`, 30, 60_000)) throw new RoomError('Too many meeting IDs tried. Wait a minute.');
        const m = this.meetings().get(d.id);
        if (!m) throw new RoomError('No meeting has that ID. Check the number.');
        return this.joinMeeting(m, me, deviceId, fromOutside);
      }
      case 'meet.leaveLobby': {
        this.dropWaiting(deviceId, typeof d.id === 'string' ? d.id : undefined);
        return { ok: true };
      }
      case 'meet.recent':
        return this.meetings().recent(me.id, d.limit);

      // ------------------------------------------------------------ host controls
      case 'room.admit': {
        const r = this.hosted(d.roomId, me, deviceId);
        const ids = Array.isArray(d.deviceIds) ? new Set(d.deviceIds.map(String).slice(0, MAX_LOBBY)) : null;
        const picked = r.lobbyList.filter((l) => d.all === true || ids?.has(l.deviceId));
        if (!picked.length) throw new RoomError('No one is waiting.');
        r.lobbyList = r.lobbyList.filter((l) => !picked.includes(l));
        for (const l of picked) {
          if (d.allow === true) {
            r.admittedUsers.add(l.userId);
            r.removedUsers.delete(l.userId);
            if (r.meeting) this.host.meetings?.admitted(r.meeting, l.userId);
          }
          this.host.deliverToDevice(l.deviceId, 'meet.lobby', { meetingId: r.meeting?.id ?? '', state: d.allow === true ? 'admitted' : 'denied' });
        }
        this.host.audit?.(me.id, d.allow === true ? 'meeting.admitted' : 'meeting.denied', r.meeting?.id ?? r.id, { roomId: r.id, people: picked.map((l) => l.userId), guests: picked.filter((l) => isWebGuest(l.userId)).length });
        this.publish(r);
        return { ok: true };
      }
      case 'room.lock': {
        const r = this.hosted(d.roomId, me, deviceId);
        r.locked = d.locked === true;
        this.host.audit?.(me.id, r.locked ? 'meeting.locked' : 'meeting.unlocked', r.meeting?.id ?? r.id, { roomId: r.id });
        this.publish(r);
        return { ok: true };
      }
      case 'room.cohost': {
        const r = this.mine(d.roomId, me, deviceId);
        if (r.hostId !== me.id) throw new RoomError('Only the host can choose co-hosts.');
        const uid = str(d.userId);
        if (!uid || uid === r.hostId) throw new RoomError('Choose someone in the meeting.');
        if (d.on === true) {
          if (!r.participants.some((p) => p.userId === uid)) throw new RoomError('Choose someone in the meeting.');
          r.coHostSet.add(uid);
        } else r.coHostSet.delete(uid);
        if (r.meeting && r.meeting.kind !== 'conversation') this.host.meetings?.setCoHosts(r.meeting, [...r.coHostSet].filter((u) => u !== r.hostId));
        this.publish(r);
        return { ok: true };
      }
      case 'room.mute': {
        const r = this.hosted(d.roomId, me, deviceId);
        const targets = d.all === true ? r.participants.filter((p) => p.deviceId !== deviceId) : r.participants.filter((p) => p.deviceId === str(d.deviceId));
        if (!targets.length) throw new RoomError(d.all === true ? 'There is no one else to mute.' : 'That person has left.');
        for (const p of targets) {
          p.muted = true;
          this.host.deliverToDevice(p.deviceId, 'room.muted', { roomId: r.id, by: me.id });
        }
        this.publish(r);
        return { ok: true };
      }
      case 'room.askUnmute': {
        const r = this.hosted(d.roomId, me, deviceId);
        const p = r.participants.find((x) => x.deviceId === str(d.deviceId));
        if (!p) throw new RoomError('That person has left.');
        if (!p.muted) throw new RoomError('Their microphone is already on.');
        if (!this.limits.allow(`${r.id}:ask:${p.deviceId}`, 1, 4000)) throw new RoomError('You asked a moment ago.');
        this.host.deliverToDevice(p.deviceId, 'room.unmuteAsk', { roomId: r.id, by: me.id });
        return { ok: true };
      }
      case 'room.remove': {
        const r = this.hosted(d.roomId, me, deviceId);
        const p = r.participants.find((x) => x.deviceId === str(d.deviceId));
        if (!p) throw new RoomError('That person has left.');
        if (p.userId === r.hostId || p.deviceId === deviceId) throw new RoomError('The host cannot be removed.');
        if (r.coHostSet.has(p.userId) && r.hostId !== me.id) throw new RoomError('Only the host can remove a co-host.');
        r.removedUsers.add(p.userId);
        r.admittedUsers.delete(p.userId);
        r.coHostSet.delete(p.userId);
        this.host.deliverToDevice(p.deviceId, 'room.removed', { roomId: r.id, by: me.id });
        this.host.audit?.(me.id, 'meeting.removed', r.meeting?.id ?? r.id, { roomId: r.id, userId: p.userId });
        this.removeDevice(r, p.deviceId);
        return { ok: true };
      }
      case 'room.spotlight': {
        const r = this.hosted(d.roomId, me, deviceId);
        const target = d.deviceId === null ? null : str(d.deviceId);
        if (target !== null && !r.participants.some((p) => p.deviceId === target)) throw new RoomError('That person has left.');
        r.spotlight = target;
        this.publish(r);
        return { ok: true };
      }
      case 'room.end': {
        const r = this.breakouts.main(this.hosted(d.roomId, me, deviceId));
        const fam = this.breakouts.family(r);
        for (const x of fam) for (const p of x.participants) this.host.deviceLeft?.(x.id, p.deviceId);
        const users = fam.flatMap((x) => x.participants.map((p) => p.userId));
        for (const x of fam.slice(1)) for (const p of x.participants) this.host.track?.left(r.id, p.userId, p.deviceId);
        for (const p of r.participants) this.host.track?.left(r.id, p.userId, p.deviceId);
        r.participants = [];
        this.end(r, me.id);
        for (const u of new Set(users)) this.setBusy(u);
        return { ok: true };
      }
      case 'room.hand': {
        const r = this.mine(d.roomId, me, deviceId);
        if (d.all === true || (typeof d.deviceId === 'string' && d.deviceId !== deviceId)) {
          if (!this.isHost(r, me.id)) throw new RoomError('Only the host and co-hosts can lower other hands.');
          if (d.up === true) throw new RoomError('People raise their own hands.');
          r.handList = d.all === true ? [] : r.handList.filter((h) => h.deviceId !== d.deviceId);
        } else if (d.up === true) {
          if (!this.limits.allow(`${r.id}:hand:${deviceId}`, 6, 10_000)) throw new RoomError('Slow down a little.');
          if (!r.handList.some((h) => h.deviceId === deviceId)) { r.handList.push({ userId: me.id, deviceId, at: Date.now() }); this.host.track?.hand(this.breakouts.main(r).id, me.id); }
        } else r.handList = r.handList.filter((h) => h.deviceId !== deviceId);
        this.publish(r);
        return { ok: true };
      }
      case 'room.react': {
        const r = this.mine(d.roomId, me, deviceId);
        const emoji = str(d.emoji);
        if (!(MEETING_REACTIONS as readonly string[]).includes(emoji)) throw new RoomError('Choose one of the reactions.');
        // a short burst is fine; a stream of them is not
        if (!this.limits.allow(`${r.id}:react:${deviceId}`, REACTIONS_PER_10S, 10_000, REACTION_GAP_MS)) return { ok: true, limited: true };
        const evt = { roomId: r.id, deviceId, userId: me.id, emoji, at: Date.now() };
        for (const p of r.participants) this.host.deliverToDevice(p.deviceId, 'room.reaction', evt);
        this.host.track?.reaction(this.breakouts.main(r).id, me.id, emoji);
        return { ok: true };
      }

      // ------------------------------------------------------------ the meeting chat
      case 'room.chat': {
        const r = this.mine(d.roomId, me, deviceId);
        const text = typeof d.text === 'string' ? d.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, ROOM_CHAT_MAX) : '';
        if (!text) throw new RoomError('Write something first.');
        if (!this.limits.allow(`${r.id}:chat:${deviceId}`, 10, 10_000)) throw new RoomError('Slow down a little.');
        const name = isWebGuest(me.id) ? this.host.visitorsOf?.([me.id])[0]?.name ?? me.displayName : me.displayName;
        const line: RoomChatLine = { id: ulid(), roomId: this.breakouts.main(r).id, userId: me.id, name, text, at: Date.now(), guest: isWebGuest(me.id) };
        r.chat.push(line);
        if (r.chat.length > 200) r.chat.splice(0, r.chat.length - 200);
        for (const x of this.breakouts.family(r)) for (const p of x.participants) this.host.deliverToDevice(p.deviceId, 'room.chat', line);
        return line;
      }
      case 'room.chatLog':
        return [...this.mine(d.roomId, me, deviceId).chat];

      // ------------------------------------------------------------ breakout rooms
      case 'room.breakout.open': case 'room.breakout.note': case 'room.breakout.visit': case 'room.breakout.move': case 'room.breakout.close':
        return this.breakouts.handle(op, me, deviceId, d, this.mine(d.roomId, me, deviceId));
    }
    return undefined;
  }

  private dropWaiting(deviceId: string, meetingId?: string): void {
    for (const [id, list] of [...this.waiting]) {
      if (meetingId && id !== meetingId) continue;
      const rest = list.filter((w) => w.deviceId !== deviceId);
      if (rest.length) this.waiting.set(id, rest); else this.waiting.delete(id);
    }
    for (const r of this.rooms.values()) {
      if (meetingId && r.meeting?.id !== meetingId) continue;
      if (!r.lobbyList.some((l) => l.deviceId === deviceId)) continue;
      r.lobbyList = r.lobbyList.filter((l) => l.deviceId !== deviceId);
      this.publish(r);
    }
  }

  private removeDevice(r: Room, deviceId: string): void {
    const p = r.participants.find((x) => x.deviceId === deviceId);
    if (!p) return;
    r.participants = r.participants.filter((x) => x.deviceId !== deviceId);
    r.handList = r.handList.filter((h) => h.deviceId !== deviceId);
    if (r.spotlight === deviceId) r.spotlight = null;
    this.host.deviceLeft?.(r.id, deviceId);
    const main = this.breakouts.main(r);
    this.host.track?.left(main.id, p.userId, deviceId);
    // while breakouts run, a room that empties stays open; the meeting ends when every room is empty
    if (r.parentId || main.breakouts) {
      if (this.breakouts.empty(main)) this.end(main);
      else { this.breakouts.left(r); this.publish(r); }
      this.setBusy(p.userId);
      return;
    }
    // a one-to-one call ends when either person hangs up; group Rooms and meetings run until the last leaves
    const plainCall = !r.meeting || r.meeting.kind === 'conversation';
    const oneToOne = plainCall && this.host.members(r.convId).length === 2 && r.everJoined.size > 1;
    if (!r.participants.length || (oneToOne && r.participants.length === 1)) this.end(r);
    else {
      // the host and every co-host left: the longest-present member of the office runs it now
      if (!r.participants.some((x) => this.isHost(r, x.userId))) {
        const next = r.participants.find((x) => x.userId !== p.userId && !r.removedUsers.has(x.userId) && this.notGuest(x.userId, r));
        if (next) r.coHostSet.add(next.userId);
      }
      this.publish(r);
    }
    this.setBusy(p.userId);
  }

  /** Guests never inherit host controls; anyone in the conversation or let in can. */
  private notGuest(userId: string, r: Room): boolean {
    if (isWebGuest(userId)) return false;
    return this.host.members(r.convId).includes(userId) || r.admittedUsers.has(userId);
  }

  /** Take someone off a Room (a webinar speaker going back to the audience): their devices leave, and they are no longer let in. */
  unseat(roomId: string, userId: string): void {
    const r = this.rooms.get(roomId);
    if (!r) return;
    r.admittedUsers.delete(userId);
    r.coHostSet.delete(userId);
    r.handList = r.handList.filter((h) => h.userId !== userId);
    for (const p of r.participants.filter((x) => x.userId === userId)) this.removeDevice(r, p.deviceId);
  }

  /** A device can only be in one Room; also called when a device disconnects. */
  leaveAll(deviceId: string): void {
    this.dropWaiting(deviceId);
    for (const r of [...this.rooms.values()]) this.removeDevice(r, deviceId);
  }
}
