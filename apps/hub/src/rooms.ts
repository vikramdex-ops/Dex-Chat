// Rooms: voice and video calls, and the meetings they are held under. The hub only does
// signalling (who is in the call, offers, answers and ICE candidates) and the meeting's rules
// (lobby, lock, host and co-hosts, hands, reactions, spotlight, mute requests). Audio and video
// travel directly between the PCs on the LAN, or through the hub's relay for large Rooms.
import { MEETING_REACTIONS, ROOM_CHAT_MAX, isWebGuest, ulid } from '@dex/core';
import type { LobbyEntry, MeetingInfo, PublicUser, RaisedHand, RoomChatLine, RoomInfo, RoomPurpose, RoomVisitor } from '@dex/core';
import { MeetingError, Meetings } from './meetings.ts';
import type { Meeting } from './meetings.ts';
import { Breakouts } from './breakouts.ts';
import { ControlError, MeetControl } from './meet-control.ts';
import type { RoomTracker } from './meet-reports.ts';
import { MsgError } from './messaging.ts';

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
  /** A lounge or a support session (see openPurpose). */
  purpose?: RoomPurpose;
  /** Only these people may see or join it (a support session); otherwise the conversation's members. */
  only?: Set<string>;
  /** The meeting thread's occurrence this Room is part of, and its note-taker. */
  occurrenceId?: string | null;
  noteTaker?: string | null;
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
  /** A lounge's or support session's Room changed (people came or went) or ended. */
  purposeChanged?(room: RoomInfo, ended: boolean, durationMs: number): void;
  /** Webinars (webinars.ts): who may be on the stage, and the stage's Room as it changes and ends. */
  webinar?: WebinarHooks;
  /** Meeting threads (meet-threads.ts): occurrences, the meeting chat saved as it is said, the note-taker. */
  threads?: ThreadHooks;
  /** Knocks (meet-lobby.ts): who waits for each meeting, wherever its hosts are. */
  lobby?: LobbyHooks;
}

/** What the knocks module hears from the Rooms. */
export interface LobbyHooks {
  /** A meeting's waiting people, its Room, or who is in it changed. */
  changed(meetingId: string): void;
  /** People waiting were let in or turned away (by a person, or by the hub: the host came, the meeting ended). */
  decided(meetingId: string, deviceIds: string[], outcome: 'admitted' | 'declined' | 'ended', by: string | null): void;
  /** Someone came into a meeting's main Room. */
  entered(room: RoomInfo, m: Meeting, me: PublicUser, deviceId: string): void;
}

/** A meeting's lobby as the knocks module reads it: the people waiting (in its Room's lobby or for it to open). */
export interface LobbySnapshot { meeting: Meeting; room: RoomInfo | null; hostIn: boolean; waiting: LobbyEntry[] }

/** Let in before the Room was open: the person opens it when they come, if they come within this long. */
const PRE_ADMIT_MS = 15 * 60_000;

/** What meeting threads hear from the Rooms. */
export interface ThreadHooks {
  opened(r: RoomInfo, m: Meeting | null): { id: string; noteTakerId: string | null } | null;
  ended(r: RoomInfo): void;
  said(main: RoomInfo, me: PublicUser, text: string, opts: { breakout: string | null; fileId: string | null }): { messageId: string | null; name: string; text: string };
  log(main: RoomInfo): RoomChatLine[] | null;
  /** The messages said in the meeting before a moment (null: not a meeting thread). */
  missed(main: RoomInfo, me: PublicUser, before: number): number | null;
  noteTaker(mainRoomId: string, userId: string | null): void;
}

/** What a webinar needs from its Room: attendees never enter it, they watch the stage. */
export interface WebinarHooks {
  /** The organiser, a co-host, a panelist, or someone the organiser invited to speak. */
  onStage(m: Meeting, userId: string): boolean;
  /** The organiser, a co-host or a panelist (not someone invited from the audience): who may be given control of a screen. */
  staff?(m: Meeting, userId: string): boolean;
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
  /** People a host let in before the meeting's Room was open, by meeting ID: user ID to when. */
  private readonly preAdmitted = new Map<string, Map<string, number>>();
  private readonly limits = new Limiter();
  readonly breakouts: Breakouts;
  /** "Give control": who uses the presenter's mouse and keyboard in each Room (meet-control.ts). */
  readonly control: MeetControl;

  constructor(host: RoomHost) {
    this.host = host;
    this.breakouts = new Breakouts(this);
    this.control = new MeetControl({
      host,
      stageStaff: (r, userId) => (r.meeting?.kind === 'webinar' ? (this.host.webinar?.staff?.(r.meeting, userId) ?? false) : null),
      guestName: (userId) => this.host.visitorsOf?.([userId])[0]?.name ?? null,
    });
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
      ...(r.purpose ? { purpose: { ...r.purpose } } : {}),
      ...(r.share ? { share: true } : {}),
      ...(this.control.view(r.id) ? { control: this.control.view(r.id) } : {}),
      ...(this.breakouts.main(r).occurrenceId ? { occurrenceId: this.breakouts.main(r).occurrenceId, noteTakerId: this.breakouts.main(r).noteTaker ?? null } : {}),
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
    if (r.only) return [...r.only];
    // a breakout is news only to the people in it and the meeting's hosts
    if (r.parentId) {
      const fam = this.breakouts.family(r);
      return [...new Set([...r.participants.map((p) => p.userId), ...fam.flatMap((x) => x.participants.map((p) => p.userId)).filter((u) => this.isHost(r, u))])];
    }
    return [...new Set([...this.host.members(r.convId), ...r.participants.map((p) => p.userId), ...r.admittedUsers])];
  }

  publish(r: Room): void {
    // a grant of control that no longer holds (sharing stopped, someone left) ends before anyone sees the Room again
    this.control.check(r);
    if (r.purpose && this.rooms.has(r.id)) this.host.purposeChanged?.(this.view(r), false, 0);
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
    if (r.only) return r.only.has(userId);
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
    for (const x of this.breakouts.family(r)) this.control.closed(x);
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
    if (r.meeting && r.lobbyList.length) this.host.lobby?.decided(r.meeting.id, r.lobbyList.map((l) => l.deviceId), 'ended', endedBy ?? null);
    for (const l of r.lobbyList) this.host.deliverToDevice(l.deviceId, 'meet.lobby', { meetingId: r.meeting?.id ?? '', state: 'denied' });
    r.lobbyList = [];
    this.lobbyNote(r.meeting);
    this.host.deliverToUsers(this.audience(r), 'room.ended', { roomId: r.id, convId: r.convId, missed, startedBy: r.startedBy, durationMs, ...(endedBy ? { endedBy } : {}) });
    const view = this.view(r);
    if (r.meeting?.kind === 'webinar') this.host.webinar?.ended(view);
    // a lounge or support session is not a call or a meeting: its own module records it
    if (r.purpose) { this.host.purposeChanged?.(view, true, durationMs); return; }
    this.host.ended?.(view, missed, durationMs);
    if (r.occurrenceId) { try { this.host.threads?.ended(view); } catch (err) { this.host.audit?.(null, 'meeting.threadError', r.meeting?.id ?? null, { error: (err as Error).message }); } }
    // a missed call is not a meeting; anything else goes into "Recent meetings"
    if (this.host.meetings && (!missed || (r.meeting && r.meeting.kind !== 'conversation'))) {
      try { this.host.meetings.log(view, r.meeting, r.meeting?.title ?? '', [...r.everJoined], durationMs); } catch { /* the call still ended */ }
    }
  }

  /** Open a Room in a conversation (the caller is first in). */
  private open(convId: string, me: PublicUser, deviceId: string, video: boolean, meeting: Meeting | null, ring: boolean, fromOutside: boolean, special?: { purpose: RoomPurpose; only?: string[] }, share = false): Room {
    const members = this.host.members(convId);
    // a call this device has on hold keeps its seat; any other Room it is in, it leaves
    this.leaveAll(deviceId, true);
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
      ...(special ? { purpose: special.purpose, ...(special.only ? { only: new Set(special.only) } : {}) } : {}),
      ...(share ? { share: true } : {}),
    };
    // nobody runs it yet (the host is not here): the first member of the office in it does
    if (!this.isHost(room, me.id) && me.role !== 'guest') room.coHostSet.add(me.id);
    // people a host let in before the Room was open come straight in
    if (meeting) for (const u of this.preAdmittedFor(meeting.id)) room.admittedUsers.add(u);
    this.rooms.set(room.id, room);
    // a meeting's Room belongs to an occurrence of its thread (lounges and support sessions do not)
    if (!special && this.host.threads) {
      try {
        const occ = this.host.threads.opened(this.view(room), meeting);
        room.occurrenceId = occ?.id ?? null;
        room.noteTaker = occ?.noteTakerId ?? null;
      } catch (err) { this.host.audit?.(null, 'meeting.threadError', meeting?.id ?? null, { error: (err as Error).message }); }
    }
    this.host.track?.opened(room);
    this.host.track?.joined(room.id, me.id, deviceId, me.displayName);
    if (meeting) this.host.audit?.(me.id, 'meeting.started', meeting.id, { roomId: room.id, title: meeting.title, mode: room.mode });
    if (room.ringing.length) {
      room.ringTimer = setTimeout(() => {
        room.ringTimer = null;
        room.ringing = [];
        // a shared screen stays up for whoever comes to watch, until its presenter stops
        if (!room.share && room.participants.length <= 1 && room.everJoined.size <= 1 && (!room.meeting || room.meeting.kind === 'conversation')) this.end(room);
        else if (this.rooms.has(room.id)) this.publish(room);
      }, RING_TIMEOUT_MS);
      room.ringTimer.unref?.();
      this.host.deliverToUsers(room.ringing, 'room.ring', { room: this.view(room), from: me.id });
    }
    this.publish(room);
    this.setBusy(me.id);
    if (meeting) this.releaseWaiting(room);
    if (meeting && !special) {
      this.lobbyNote(meeting);
      this.entered(room, me, deviceId);
    }
    return room;
  }

  /** Tell the knocks module (meet-lobby.ts) that a meeting's lobby or Room changed; it never breaks a Room. */
  private lobbyNote(m: Meeting | null | undefined): void {
    if (!m || !this.host.lobby) return;
    try { this.host.lobby.changed(m.id); } catch (err) { this.host.audit?.(null, 'meeting.lobbyError', m.id, { error: (err as Error).message }); }
  }

  private entered(r: Room, me: PublicUser, deviceId: string): void {
    const main = this.breakouts.main(r);
    if (!main.meeting || !this.host.lobby || r.parentId) return;
    try { this.host.lobby.entered(this.view(main), main.meeting, me, deviceId); } catch (err) { this.host.audit?.(null, 'meeting.lobbyError', main.meeting.id, { error: (err as Error).message }); }
  }

  private preAdmittedFor(meetingId: string): string[] {
    const list = this.preAdmitted.get(meetingId);
    if (!list) return [];
    const now = Date.now();
    for (const [u, at] of list) if (now - at > PRE_ADMIT_MS) list.delete(u);
    if (!list.size) this.preAdmitted.delete(meetingId);
    return [...list.keys()];
  }

  /** A host let this person in before the Room was open (used once). */
  private takePreAdmit(meetingId: string, userId: string): boolean {
    if (!this.preAdmittedFor(meetingId).includes(userId)) return false;
    const list = this.preAdmitted.get(meetingId)!;
    list.delete(userId);
    if (!list.size) this.preAdmitted.delete(meetingId);
    return true;
  }

  private preAdmit(meetingId: string, userId: string): void {
    const list = this.preAdmitted.get(meetingId) ?? new Map<string, number>();
    list.set(userId, Date.now());
    // a meeting link shared widely: a bounded list
    if (list.size > MAX_LOBBY) list.delete(list.keys().next().value!);
    this.preAdmitted.set(meetingId, list);
  }

  /** May this person let people into the meeting: its host or a co-host, or a host of its running Room. */
  private mayAdmit(m: Meeting, r: Room | undefined, userId: string): boolean {
    return m.hostId === userId || m.coHosts.includes(userId) || (!!r && this.isHost(r, userId));
  }

  /** A meeting's lobby, for the knocks module: who waits in its Room's lobby or for it to open. */
  lobbyOf(meetingId: string): LobbySnapshot | null {
    const m = this.host.meetings?.get(meetingId);
    if (!m) return null;
    const r = this.runningFor(m);
    const inLobby = r?.lobbyList ?? [];
    const waiting = [...inLobby, ...(this.waiting.get(m.id) ?? []).filter((w) => !inLobby.some((l) => l.deviceId === w.deviceId))];
    const hostIn = !!r && r.participants.some((p) => this.isHost(r, p.userId) || p.userId === m.hostId || m.coHosts.includes(p.userId));
    return { meeting: m, room: r ? this.view(r, true) : null, hostIn, waiting: waiting.map((w) => ({ ...w })) };
  }

  /** Who may let people into a meeting: its host and co-hosts, and the hosts of its running Room (office members only). */
  admittersOf(meetingId: string): string[] {
    const m = this.host.meetings?.get(meetingId);
    if (!m) return [];
    const r = this.runningFor(m);
    return [...new Set([m.hostId, ...m.coHosts, ...(r ? [r.hostId, ...r.coHostSet].filter((u): u is string => !!u) : [])])].filter((u) => !isWebGuest(u));
  }

  /**
   * Let people waiting for a meeting in (or turn them away) from anywhere: the knock's card, the
   * indicator, a notification. Someone in the Room's lobby comes in as from the Room's own list;
   * someone waiting for the Room to open is let in now and opens it when they come (it waits for
   * the host there). `which`: their devices, or null for everyone waiting.
   */
  answer(me: PublicUser, meetingId: string, which: string[] | null, allow: boolean): number {
    const m = this.meetings().get(meetingId);
    if (!m) throw new RoomError('That meeting no longer exists.');
    const r = this.runningFor(m);
    if (!this.mayAdmit(m, r, me.id)) throw new RoomError('Only the host and co-hosts can let people in.');
    const want = (deviceId: string) => !which || which.includes(deviceId);
    let n = 0;
    if (r) {
      const picked = r.lobbyList.filter((l) => want(l.deviceId));
      if (picked.length) { this.decide(r, picked, allow, me); n += picked.length; }
    }
    const list = this.waiting.get(m.id) ?? [];
    const early = list.filter((w) => want(w.deviceId));
    if (early.length) {
      const rest = list.filter((w) => !early.includes(w));
      if (rest.length) this.waiting.set(m.id, rest); else this.waiting.delete(m.id);
      for (const w of early) {
        if (!allow) continue;
        this.preAdmit(m.id, w.userId);
        if (r) { r.admittedUsers.add(w.userId); r.removedUsers.delete(w.userId); }
        if (!isWebGuest(w.userId)) this.host.meetings?.admitted(m, w.userId);
      }
      // the knocks module hears first, so it can tell a let-in person's arrival apart
      this.host.lobby?.decided(m.id, early.map((w) => w.deviceId), allow ? 'admitted' : 'declined', me.id);
      this.host.audit?.(me.id, allow ? 'meeting.admitted' : 'meeting.denied', m.id, { people: early.map((w) => w.userId), guests: early.filter((w) => isWebGuest(w.userId)).length, beforeOpen: !r });
      for (const w of early) this.host.deliverToDevice(w.deviceId, 'meet.lobby', { meetingId: m.id, state: allow ? 'admitted' : 'denied' });
      n += early.length;
    }
    if (!n) throw new RoomError('They are no longer waiting.');
    this.lobbyNote(m);
    return n;
  }

  /** People in a running Room's lobby let in or turned away by a host. */
  private decide(r: Room, picked: LobbyEntry[], allow: boolean, me: PublicUser): void {
    r.lobbyList = r.lobbyList.filter((l) => !picked.includes(l));
    for (const l of picked) {
      if (!allow) continue;
      r.admittedUsers.add(l.userId);
      r.removedUsers.delete(l.userId);
      if (r.meeting) this.host.meetings?.admitted(r.meeting, l.userId);
    }
    if (r.meeting) this.host.lobby?.decided(r.meeting.id, picked.map((l) => l.deviceId), allow ? 'admitted' : 'declined', me.id);
    for (const l of picked) this.host.deliverToDevice(l.deviceId, 'meet.lobby', { meetingId: r.meeting?.id ?? '', state: allow ? 'admitted' : 'denied' });
    this.host.audit?.(me.id, allow ? 'meeting.admitted' : 'meeting.denied', r.meeting?.id ?? r.id, { roomId: r.id, people: picked.map((l) => l.userId), guests: picked.filter((l) => isWebGuest(l.userId)).length });
    this.publish(r);
    this.lobbyNote(r.meeting);
  }

  /** Put a device in a Room. */
  private enter(r: Room, me: PublicUser, deviceId: string, fromOutside: boolean): RoomInfo {
    if (r.participants.some((p) => p.deviceId === deviceId)) return this.view(r, this.isHost(r, me.id));
    if (r.participants.length >= this.capacity(r)) throw new RoomError(`This Room is full (${this.capacity(r)} people).`);
    if (r.mode === 'relay' && fromOutside) throw new RoomError('This Room is large, so it runs through the office hub: join it from the office network.');
    this.leaveAll(deviceId, true);
    r.participants.push({ userId: me.id, deviceId, joinedAt: Date.now(), muted: false, camera: false, screen: false });
    r.ringing = r.ringing.filter((u) => u !== me.id);
    r.everJoined.add(me.id);
    r.lobbyList = r.lobbyList.filter((l) => l.deviceId !== deviceId);
    this.host.track?.joined(this.breakouts.main(r).id, me.id, deviceId, me.displayName);
    const hostCame = this.isHost(r, me.id);
    this.publish(r);
    this.setBusy(me.id);
    if (hostCame) this.releaseWaiting(r);
    if (!r.purpose) {
      this.lobbyNote(this.breakouts.main(r).meeting);
      this.entered(r, me, deviceId);
    }
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
    this.lobbyNote(r.meeting);
  }

  /** A Room started or its host arrived: people waiting by the meeting's ID come in, or move to its lobby. */
  private releaseWaiting(r: Room): void {
    const m = r.meeting;
    if (!m) return;
    const list = this.waiting.get(m.id);
    if (!list?.length) return;
    const hostHere = r.participants.some((p) => this.isHost(r, p.userId));
    const keep: LobbyEntry[] = [];
    const released: string[] = [];
    for (const w of list) {
      if (w.reason === 'host' && !hostHere && !m.settings.joinBeforeHost) { keep.push(w); continue; }
      const needsHost = w.reason === 'admit';
      if (needsHost) {
        if (!r.lobbyList.some((l) => l.deviceId === w.deviceId) && r.lobbyList.length < MAX_LOBBY) r.lobbyList.push({ ...w, reason: 'admit' });
        this.host.deliverToDevice(w.deviceId, 'meet.lobby', { meetingId: m.id, state: 'waiting', reason: 'admit' });
      } else { released.push(w.deviceId); this.host.deliverToDevice(w.deviceId, 'meet.lobby', { meetingId: m.id, state: 'admitted' }); }
    }
    if (keep.length) this.waiting.set(m.id, keep); else this.waiting.delete(m.id);
    // people who waited only for the host to arrive come in by themselves
    if (released.length) this.host.lobby?.decided(m.id, released, 'admitted', null);
    this.publish(r);
    this.lobbyNote(m);
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
    // a host let them in from the lobby before the Room was open: they open it, and wait there for the host
    if (!isHost && this.takePreAdmit(m.id, me.id)) {
      const convId = store.ensureConv(m);
      if (!this.host.members(convId).includes(me.id)) store.admitted(m, me.id);
      // no ringing: the meeting has not started for its invitees
      const room = this.open(convId, me, deviceId, false, m, false, fromOutside);
      room.admittedUsers.add(me.id);
      this.publish(room);
      return { room: this.view(room, this.isHost(room, me.id)) };
    }
    const outsider = me.role === 'guest' || !store.insider(m, me.id);
    const needsAdmit = !isHost && (isWebGuest(me.id) || m.settings.lobby === 'everyone' || (m.settings.lobby === 'outside' && outsider));
    if (!isHost && (!m.settings.joinBeforeHost || needsAdmit)) {
      const list = this.waiting.get(m.id) ?? [];
      if (!list.some((w) => w.deviceId === deviceId)) {
        if (list.length >= MAX_LOBBY) throw new RoomError('Too many people are waiting for this meeting. Try again in a moment.');
        this.leaveAll(deviceId);
        list.push({ userId: me.id, deviceId, at: Date.now(), reason: needsAdmit ? 'admit' : 'host' });
        this.waiting.set(m.id, list);
        this.lobbyNote(m);
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
      if (err instanceof MeetingError || err instanceof ControlError) throw new RoomError(err.message);
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
        const running = [...this.rooms.values()].find((r) => r.convId === convId && !r.parentId && !r.purpose);
        if (running) return this.handleOp('room.join', me, deviceId, { roomId: running.id, fromOutside });
        const meeting = this.host.meetings ? this.host.meetings.forConv(convId, me.id) : null;
        const ownSpace = meeting && (meeting.kind === 'instant' || meeting.kind === 'personal');
        if (members.length < 2 && !ownSpace) throw new RoomError('There is no one else here to call.');
        if (meeting && !(meeting.hostId === me.id || meeting.coHosts.includes(me.id)) && meeting.kind !== 'conversation' && meeting.kind !== 'event' && !meeting.settings.joinBeforeHost) {
          throw new RoomError('This meeting starts when its host arrives.');
        }
        const room = this.open(convId, me, deviceId, d.video === true && d.share !== true, meeting, meeting?.kind !== 'personal', fromOutside, undefined, d.share === true);
        return this.view(room, this.isHost(room, me.id));
      }

      case 'room.hold': {
        const r = this.mine(d.roomId, me, deviceId);
        const p = r.participants.find((x) => x.deviceId === deviceId)!;
        const on = d.on === true;
        if (on && r.purpose?.kind === 'lounge') throw new RoomError('A lounge is not put on hold: leave it and drop in again later.');
        if (on && r.meeting?.kind === 'webinar') throw new RoomError('A webinar stage is not put on hold: leave the stage instead.');
        if (on === !!p.held) return this.view(r, this.isHost(r, me.id));
        if (on) {
          // on hold: the seat is kept, the screen stops, the hand stays where it is in the line
          p.held = true; p.heldAt = Date.now(); p.screen = false; p.speaking = false;
          this.host.deviceLeft?.(r.id, deviceId);
        } else {
          // back: whatever else this device is active in goes on hold (a lounge is left), so it is live in one Room at a time
          for (const other of [...this.rooms.values()]) {
            if (other === r) continue;
            const q = other.participants.find((x) => x.deviceId === deviceId && !x.held);
            if (!q) continue;
            if (other.purpose?.kind === 'lounge' || other.meeting?.kind === 'webinar') { this.removeDevice(other, deviceId); continue; }
            q.held = true; q.heldAt = Date.now(); q.screen = false; q.speaking = false;
            this.host.deviceLeft?.(other.id, deviceId);
            this.publish(other);
          }
          delete p.held; delete p.heldAt;
        }
        this.host.audit?.(me.id, on ? 'room.held' : 'room.resumed', r.meeting?.id ?? r.id, { roomId: r.id });
        this.publish(r);
        return this.view(r, this.isHost(r, me.id));
      }

      case 'room.join': {
        const r = this.get(d.roomId, me);
        if (r.participants.some((p) => p.deviceId === deviceId)) return this.view(r, this.isHost(r, me.id));
        if (r.parentId) throw new RoomError('A host moves people into breakout rooms. Join the meeting itself.');
        if (r.purpose) throw new RoomError(r.purpose.kind === 'lounge' ? 'Come into a lounge from its Space.' : 'Join a support session from its ticket.');
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
        // a seat on hold is not connected to: it reaches out again itself when it comes back
        if (r.participants.some((p) => (p.deviceId === to || p.deviceId === deviceId) && p.held)) return { ok: true };
        const size = JSON.stringify(d.data ?? null).length;
        if (size > 64 * 1024) throw new RoomError('Signal too large.');
        this.host.deliverToDevice(to, 'room.signal', { roomId: r.id, fromDevice: deviceId, fromUser: me.id, data: d.data });
        return { ok: true };
      }

      case 'room.invite': {
        const r = this.get(d.roomId, me);
        if (r.purpose) throw new RoomError(r.purpose.kind === 'lounge' ? 'Lounges never ring anyone: people drop in when they like.' : 'A support session is between you and IT.');
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
        p.muted = d.muted === true; p.camera = d.camera === true; p.screen = d.screen === true && !p.held;
        if (p.muted) p.speaking = false;
        // what this device can do about remote control: be controlled (Windows, Linux with xdotool), or control another's screen (the desktop app)
        p.controllable = d.controllable === true && !isWebGuest(me.id);
        if (d.controlOff === 'mac' || d.controlOff === 'window' || d.controlOff === 'unavailable') p.controlOff = d.controlOff; else delete p.controlOff;
        p.desktop = MeetControl.desktopClaim(me.id, d.desktop);
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
        this.decide(r, picked, d.allow === true, me);
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
      case 'room.data': {
        // small messages to everyone else in the Room (live pointers when there is no data channel)
        const r = this.mine(d.roomId, me, deviceId);
        if (JSON.stringify(d.data ?? null).length > 8 * 1024) throw new RoomError('That message is too large.');
        // remote control's input: only from the person the presenter granted, and only to the presenter
        const input = this.control.inputRoute(r, deviceId, d.data);
        if (input.input) {
          if (input.to) this.host.deliverToDevice(input.to, 'room.data', { roomId: r.id, fromDevice: deviceId, fromUser: me.id, data: d.data });
          return input.to ? { ok: true } : { ok: true, dropped: true };
        }
        if (!this.limits.allow(`${r.id}:data:${deviceId}`, 60, 1000)) return { ok: true, limited: true };
        const evt = { roomId: r.id, fromDevice: deviceId, fromUser: me.id, data: d.data ?? null };
        for (const p of r.participants) if (p.deviceId !== deviceId) this.host.deliverToDevice(p.deviceId, 'room.data', evt);
        return { ok: true };
      }
      case 'room.speaking': {
        const r = this.mine(d.roomId, me, deviceId);
        if (r.purpose?.kind !== 'lounge') return { ok: true };
        const p = r.participants.find((x) => x.deviceId === deviceId)!;
        const on = d.speaking === true && !p.muted;
        if (!!p.speaking === on) return { ok: true };
        // a stop always goes through; starts at most four a second
        if (on && !this.limits.allow(`${r.id}:speak:${deviceId}`, 4, 1000)) return { ok: true, limited: true };
        p.speaking = on;
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

      // ------------------------------------------------------------ give control (meet-control.ts)
      case 'room.control.ask': case 'room.control.refuse': case 'room.control.grant': case 'room.control.stop': {
        const r = this.mine(d.roomId, me, deviceId);
        if (r.purpose) throw new RoomError(r.purpose.kind === 'support' ? 'In a support session, the person being helped allows control from their dock.' : 'A lounge has no screen to control.');
        const res = this.control.handle(op, me, deviceId, r, d);
        if (op === 'room.control.grant' || op === 'room.control.stop') this.publish(r);
        return res;
      }

      // ------------------------------------------------------------ the meeting chat
      case 'room.chat': {
        const r = this.mine(d.roomId, me, deviceId);
        const text = typeof d.text === 'string' ? d.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, ROOM_CHAT_MAX) : '';
        if (!text) throw new RoomError('Write something first.');
        return this.say(r, me, deviceId, text, null);
      }
      case 'room.chatLog': {
        const r = this.mine(d.roomId, me, deviceId);
        const main = this.breakouts.main(r);
        let saved: RoomChatLine[] | null = null;
        try { saved = this.host.threads?.log(this.view(main)) ?? null; } catch { saved = null; }
        return saved ?? [...r.chat];
      }
      case 'room.missed': {
        const r = this.mine(d.roomId, me, deviceId);
        const main = this.breakouts.main(r);
        const before = typeof d.before === 'number' && Number.isFinite(d.before) ? d.before : Date.now();
        let n: number | null = null;
        try { n = this.host.threads?.missed(this.view(main), me, before) ?? null; } catch { n = null; }
        return { messages: n ?? new Set(r.chat.filter((l) => l.at < before).map((l) => l.messageId ?? l.id)).size };
      }
      case 'meet.noteTaker': {
        const r = this.hosted(d.roomId, me, deviceId);
        const main = this.breakouts.main(r);
        const who = typeof d.userId === 'string' && d.userId ? d.userId : null;
        if (who && (isWebGuest(who) || !main.participants.some((p) => p.userId === who) && !this.host.members(main.convId).includes(who))) throw new RoomError('Choose someone in the meeting.');
        main.noteTaker = who;
        this.host.threads?.noteTaker(main.id, who);
        this.publish(main);
        return { ok: true };
      }

      // ------------------------------------------------------------ breakout rooms
      case 'room.breakout.open': case 'room.breakout.note': case 'room.breakout.visit': case 'room.breakout.move': case 'room.breakout.close':
        return this.breakouts.handle(op, me, deviceId, d, this.mine(d.roomId, me, deviceId));
    }
    return undefined;
  }

  /**
   * A line in the meeting chat: saved in the meeting's thread first (as it is said, with the
   * office's data-loss rules), then sent to everyone in the meeting and its breakouts.
   */
  private say(r: Room, me: PublicUser, deviceId: string, text: string, file: { id: string; name: string; size: number } | null): RoomChatLine {
    if (!this.limits.allow(`${r.id}:chat:${deviceId}`, 10, 10_000)) throw new RoomError('Slow down a little.');
    const main = this.breakouts.main(r);
    let name = isWebGuest(me.id) ? this.host.visitorsOf?.([me.id])[0]?.name ?? me.displayName : me.displayName;
    let messageId: string | null = null;
    if (this.host.threads && main.occurrenceId) {
      try {
        const s = this.host.threads.said(this.view(main), { ...me, displayName: name }, text, { breakout: r.parentId ? r.breakoutName ?? null : null, fileId: file?.id ?? null });
        name = s.name; text = s.text; messageId = s.messageId;
      } catch (err) {
        if (err instanceof MsgError) throw new RoomError(err.message);
        this.host.audit?.(null, 'meeting.chatNotSaved', main.meeting?.id ?? null, { error: (err as Error).message });
      }
    }
    const line: RoomChatLine = { id: messageId ?? ulid(), roomId: main.id, userId: me.id, name, text, at: Date.now(), guest: isWebGuest(me.id), messageId, breakout: r.parentId ? r.breakoutName ?? null : null, file };
    r.chat.push(line);
    if (r.chat.length > 200) r.chat.splice(0, r.chat.length - 200);
    for (const x of this.breakouts.family(r)) for (const p of x.participants) this.host.deliverToDevice(p.deviceId, 'room.chat', line);
    return line;
  }

  /** A browser guest's file, already stored and checked, said in the meeting chat. */
  sayFile(roomId: string, me: PublicUser, deviceId: string, file: { id: string; name: string; size: number }): RoomChatLine {
    const r = this.rooms.get(roomId);
    if (!r || !r.participants.some((p) => p.deviceId === deviceId)) throw new RoomError('Not in this call.');
    return this.say(r, me, deviceId, '', file);
  }

  private dropWaiting(deviceId: string, meetingId?: string): void {
    const touched = new Set<string>();
    for (const [id, list] of [...this.waiting]) {
      if (meetingId && id !== meetingId) continue;
      const rest = list.filter((w) => w.deviceId !== deviceId);
      if (rest.length === list.length) continue;
      touched.add(id);
      if (rest.length) this.waiting.set(id, rest); else this.waiting.delete(id);
    }
    for (const r of this.rooms.values()) {
      if (meetingId && r.meeting?.id !== meetingId) continue;
      if (!r.lobbyList.some((l) => l.deviceId === deviceId)) continue;
      r.lobbyList = r.lobbyList.filter((l) => l.deviceId !== deviceId);
      if (r.meeting) touched.add(r.meeting.id);
      this.publish(r);
    }
    for (const id of touched) this.lobbyNote(this.host.meetings?.get(id));
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
    const plainCall = (!r.meeting || r.meeting.kind === 'conversation') && !r.purpose;
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
    if (!r.purpose && this.rooms.has(r.id)) this.lobbyNote(main.meeting);
  }

  /** Guests never inherit host controls; anyone in the conversation or let in can. */
  private notGuest(userId: string, r: Room): boolean {
    if (isWebGuest(userId)) return false;
    return this.host.members(r.convId).includes(userId) || r.admittedUsers.has(userId);
  }

  // ------------------------------------------------------------ lounges and support sessions
  private findPurpose(p: RoomPurpose): Room | undefined {
    return [...this.rooms.values()].find((r) => r.purpose?.kind === p.kind
      && (p.kind === 'lounge' ? (r.purpose as { loungeId: string }).loungeId === p.loungeId : (r.purpose as { ticketId: string }).ticketId === p.ticketId));
  }

  /** The running Room of a lounge or support session, if anyone is in it. */
  purposeRoom(p: RoomPurpose): RoomInfo | null {
    const r = this.findPurpose(p);
    return r ? this.view(r) : null;
  }

  /**
   * Come into a lounge's or support session's Room, opening it when nobody is there. No ringing,
   * no lobby, no meeting ID. `only` limits who may see and join it (a support session).
   */
  enterPurpose(spec: { convId: string; purpose: RoomPurpose; only?: string[] }, me: PublicUser, deviceId: string, fromOutside: boolean): RoomInfo {
    if (spec.only && !spec.only.includes(me.id)) throw new RoomError('This session is not yours to join.');
    const running = this.findPurpose(spec.purpose);
    if (running) {
      if (running.purpose?.kind === 'lounge' && spec.purpose.kind === 'lounge' && running.purpose.name !== spec.purpose.name) running.purpose = { ...spec.purpose };
      return this.enter(running, me, deviceId, fromOutside);
    }
    const room = this.open(spec.convId, me, deviceId, false, null, false, fromOutside, { purpose: spec.purpose, only: spec.only });
    return this.view(room, this.isHost(room, me.id));
  }

  /** Rename a running lounge's Room (its people see the new name at once). */
  renamePurpose(p: RoomPurpose & { kind: 'lounge' }): void {
    const r = this.findPurpose(p);
    if (r) { r.purpose = { ...p }; this.publish(r); }
  }

  /** End a lounge's or support session's Room for everyone in it. */
  endPurpose(p: RoomPurpose, by?: string): void {
    const r = this.findPurpose(p);
    if (!r) return;
    for (const x of r.participants) this.host.deviceLeft?.(r.id, x.deviceId);
    const users = r.participants.map((x) => x.userId);
    r.participants = [];
    this.end(r, by);
    for (const u of new Set(users)) this.setBusy(u);
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

  /**
   * A device is live in one Room at a time; also called when a device disconnects. `keepHeld`: a seat
   * the device put on hold stays (it is answering another call), any other seat is left.
   */
  leaveAll(deviceId: string, keepHeld = false): void {
    this.dropWaiting(deviceId);
    for (const r of [...this.rooms.values()]) {
      if (keepHeld && r.participants.some((p) => p.deviceId === deviceId && p.held)) continue;
      this.removeDevice(r, deviceId);
    }
  }
}
