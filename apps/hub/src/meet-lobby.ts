// Knocks (docs/MEETINGS.md, "Who is waiting"): someone waiting in the lobby of a meeting is news
// to everyone who may let them in, wherever they are: not only to a host who happens to be in the
// Room. Each waiting device is one knock. When it appears, its hosts get an event (the app's
// indicator and its notification) and a card in their conversation with Nib with Admit and
// Decline; when it is answered (from the card, the indicator, the Room's own lobby list), when
// the person gives up or the meeting ends, every copy changes in place. The Rooms keep the lobby
// itself (rooms.ts); this module only watches it and tells people.
//
// Also the lighter "joined" notice: someone came into a meeting you organise while you are not in it.
import { formatMeetingId, isWebGuest, knockWho, ulid } from '@dex/core';
import type { HostedLive, JoinedNotice, KnockState, KnockView, LobbyBoard, PublicUser, RoomInfo } from '@dex/core';
import type { Meeting } from './meetings.ts';
import type { LobbySnapshot } from './rooms.ts';

export class KnockError extends Error {}

/** Knocks kept after they are answered (their cards still show who answered). */
const KEEP_DONE = 500;
/** Nib cards about one meeting's knocks, at most this many in ten minutes (a link shared too widely). */
const CARDS_PER_10_MIN = 20;

interface Knock {
  id: string;
  meetingId: string;
  deviceId: string;
  userId: string;
  name: string;
  guest: boolean;
  at: number;
  state: KnockState;
  by: string | null;
  decidedAt: number | null;
  joinedAt: number | null;
  /** Who was told (they may answer it, and see its card). */
  told: Set<string>;
}

export interface LobbyDeps {
  /** The Rooms' view of a meeting's lobby, and who may let people in. */
  lobbyOf(meetingId: string): LobbySnapshot | null;
  admittersOf(meetingId: string): string[];
  /** The running main Rooms (for "your meetings running without you"). */
  liveRooms(): RoomInfo[];
  meeting(meetingId: string): Meeting | null;
  answer(me: PublicUser, meetingId: string, deviceIds: string[] | null, allow: boolean): number;
  userById(id: string): PublicUser | null;
  /** A browser guest's name as they typed it. */
  guestName(userId: string): string | null;
  deliver(userIds: string[], name: string, data: unknown): void;
  /** A card in someone's conversation with Nib (once per knock and person); false when Nib cannot reach them. */
  card(userId: string, ref: string, body: string): boolean;
  /** The cards changed (the apps fetch them again). */
  cardsChanged(userIds: string[]): void;
  /** Browser guests waiting for this meeting hear the lobby's news (the host is in, or told). */
  guestsChanged?(meetingId: string, hostIn: boolean): void;
  log(level: 'info' | 'warn', msg: string, extra?: Record<string, unknown>): void;
  now?: () => number;
}

export class MeetLobby {
  private readonly d: LobbyDeps;
  /** Knocks by id; the open ones also by meeting and device. */
  private readonly knocks = new Map<string, Knock>();
  private readonly open = new Map<string, Map<string, Knock>>();
  /** What each person was last sent (so an unchanged board is not sent again). */
  private readonly sent = new Map<string, string>();
  private readonly cardTimes = new Map<string, number[]>();
  /** Whether a host was in each meeting's Room when last looked at (browser guests are told when it changes). */
  private readonly hostWas = new Map<string, boolean>();

  constructor(d: LobbyDeps) { this.d = d; }

  private now(): number { return this.d.now?.() ?? Date.now(); }

  private nameOf(userId: string): { name: string; guest: boolean } {
    if (isWebGuest(userId)) return { name: this.d.guestName(userId) ?? 'Guest', guest: true };
    return { name: this.d.userById(userId)?.displayName ?? 'Someone', guest: false };
  }

  private viewOf(k: Knock, snap?: LobbySnapshot | null): KnockView {
    const m = snap?.meeting ?? this.d.meeting(k.meetingId);
    const s = snap === undefined ? this.d.lobbyOf(k.meetingId) : snap;
    return {
      id: k.id, meetingId: k.meetingId, title: m?.title || 'Meeting', kind: m?.kind ?? 'instant', name: k.name, userId: k.guest ? '' : k.userId, guest: k.guest,
      at: k.at, state: k.state, by: k.by, decidedAt: k.decidedAt, joinedAt: k.joinedAt, live: !!s?.room, hostIn: !!s?.hostIn,
    };
  }

  /** The Rooms say a meeting's lobby (or its Room) changed: new knocks are told, gone ones closed. */
  changed(meetingId: string): void {
    const snap = this.d.lobbyOf(meetingId);
    const openNow = this.open.get(meetingId) ?? new Map<string, Knock>();
    const waiting = snap?.waiting ?? [];
    const admitters = snap ? this.d.admittersOf(meetingId).filter((u) => { const p = this.d.userById(u); return !!p && p.role !== 'bot' && p.role !== 'guest'; }) : [];
    const fresh: Knock[] = [];
    for (const w of waiting) {
      if (openNow.has(w.deviceId)) continue;
      const { name, guest } = this.nameOf(w.userId);
      const k: Knock = { id: ulid(), meetingId, deviceId: w.deviceId, userId: w.userId, name, guest, at: w.at, state: 'waiting', by: null, decidedAt: null, joinedAt: null, told: new Set() };
      openNow.set(w.deviceId, k);
      this.knocks.set(k.id, k);
      fresh.push(k);
    }
    // gone from the lobby without an answer: they left (an answer is recorded by decided() first)
    const changedCards = new Set<string>();
    for (const [dev, k] of openNow) {
      if (waiting.some((w) => w.deviceId === dev)) continue;
      openNow.delete(dev);
      if (k.state === 'waiting') { k.state = snap ? 'left' : 'ended'; k.decidedAt = this.now(); }
      for (const u of k.told) changedCards.add(u);
    }
    if (openNow.size) this.open.set(meetingId, openNow); else this.open.delete(meetingId);
    // people who may answer now (a co-host made in the Room) hear about everyone still waiting
    for (const k of openNow.values()) {
      const newcomers = admitters.filter((u) => !k.told.has(u) && u !== k.userId);
      if (!newcomers.length) continue;
      this.tell(k, newcomers, snap);
    }
    void fresh;
    // the lobby's people see their open knocks with the Room's state (live, a host in it)
    const hostIn = !!snap?.hostIn;
    if (this.hostWas.get(meetingId) !== hostIn || fresh.length) this.d.guestsChanged?.(meetingId, hostIn);
    if (snap?.room || openNow.size) this.hostWas.set(meetingId, hostIn); else this.hostWas.delete(meetingId);
    for (const k of openNow.values()) for (const u of k.told) changedCards.add(u);
    const organiser = snap?.meeting.hostId;
    this.push([...new Set([...admitters, ...changedCards, ...(organiser ? [organiser] : [])])]);
    if (changedCards.size) this.d.cardsChanged([...changedCards]);
    this.trim();
  }

  /** Tell people about a knock: the event for the app (indicator and notification), and Nib's card. */
  private tell(k: Knock, userIds: string[], snap: LobbySnapshot | null): void {
    for (const u of userIds) k.told.add(u);
    const view = this.viewOf(k, snap);
    this.d.deliver(userIds, 'meet.knocked', view);
    if (!this.cardAllowed(k.meetingId)) { this.d.log('warn', 'knock cards limited', { meeting: k.meetingId }); return; }
    const where = view.kind === 'personal' ? `your personal room (${formatMeetingId(k.meetingId)})` : `${view.title} (${formatMeetingId(k.meetingId)})`;
    const body = `${knockWho(k)} is waiting in the lobby of ${where}.`;
    for (const u of userIds) if (!this.d.card(u, k.id, body)) this.d.log('info', 'knock card not posted', { meeting: k.meetingId });
  }

  private cardAllowed(meetingId: string): boolean {
    const now = this.now();
    const list = (this.cardTimes.get(meetingId) ?? []).filter((t) => now - t < 600_000);
    if (list.length >= CARDS_PER_10_MIN) { this.cardTimes.set(meetingId, list); return false; }
    list.push(now);
    this.cardTimes.set(meetingId, list);
    if (this.cardTimes.size > 1000) for (const [id, v] of this.cardTimes) if (!v.some((t) => now - t < 600_000)) this.cardTimes.delete(id);
    return true;
  }

  /** The Rooms let people in or turned them away (before the lobby list changes). */
  decided(meetingId: string, deviceIds: string[], outcome: 'admitted' | 'declined' | 'ended', by: string | null): void {
    const openNow = this.open.get(meetingId);
    if (!openNow) return;
    const touched = new Set<string>();
    for (const dev of deviceIds) {
      const k = openNow.get(dev);
      if (!k || k.state !== 'waiting') continue;
      k.state = outcome === 'declined' ? 'declined' : outcome === 'ended' ? 'ended' : 'admitted';
      k.by = by;
      k.decidedAt = this.now();
      openNow.delete(dev);
      for (const u of k.told) touched.add(u);
    }
    if (!openNow.size) this.open.delete(meetingId);
    if (touched.size) { this.d.cardsChanged([...touched]); this.push([...touched]); }
  }

  /** Someone came into a meeting's Room: a let-in person's knock shows it, and an organiser who is not there is told. */
  entered(room: RoomInfo, m: Meeting, me: PublicUser, deviceId: string): void {
    const k = [...this.knocks.values()].reverse().find((x) => x.meetingId === m.id && x.deviceId === deviceId && x.state === 'admitted' && !x.joinedAt);
    if (k) {
      k.joinedAt = this.now();
      this.d.cardsChanged([...k.told]);
    }
    if (m.kind === 'conversation' || m.kind === 'webinar') return;
    if (me.id === m.hostId || room.participants.some((p) => p.userId === m.hostId)) return;
    const organiser = this.d.userById(m.hostId);
    if (!organiser || organiser.role === 'bot') return;
    const { name, guest } = isWebGuest(me.id) ? this.nameOf(me.id) : { name: me.displayName, guest: false };
    const notice: JoinedNotice = { meetingId: m.id, title: m.title || 'Meeting', kind: m.kind, name, guest, at: this.now(), admitted: !!k };
    this.d.deliver([m.hostId], 'meet.joined', notice);
    this.push([m.hostId]);
  }

  // ------------------------------------------------------------ what each person sees
  /** Open knocks this person may answer, and the meetings they organise that run without them. */
  board(userId: string): LobbyBoard {
    const knocks: KnockView[] = [];
    const snaps = new Map<string, LobbySnapshot | null>();
    for (const [meetingId, list] of this.open) {
      const mine = [...list.values()].filter((k) => k.told.has(userId));
      if (!mine.length) continue;
      const snap = snaps.get(meetingId) ?? this.d.lobbyOf(meetingId);
      snaps.set(meetingId, snap);
      for (const k of mine) knocks.push(this.viewOf(k, snap));
    }
    knocks.sort((a, b) => a.at - b.at);
    const rooms: HostedLive[] = [];
    for (const r of this.d.liveRooms()) {
      if (!r.meetingId || r.parentId || r.purpose) continue;
      const m = this.d.meeting(r.meetingId);
      if (!m || m.hostId !== userId || m.kind === 'conversation' || m.kind === 'webinar') continue;
      if (!r.participants.length || r.participants.some((p) => p.userId === userId)) continue;
      rooms.push({
        meetingId: m.id, title: m.title || 'Meeting', kind: m.kind, since: r.startedAt,
        people: r.participants.map((p) => ({ ...this.nameOf(p.userId), since: p.joinedAt })).slice(0, 20),
      });
    }
    return { knocks, rooms };
  }

  private push(userIds: string[]): void {
    for (const u of userIds) {
      if (!u || isWebGuest(u)) continue;
      const b = this.board(u);
      const json = JSON.stringify(b);
      if (this.sent.get(u) === json) continue;
      this.sent.set(u, json);
      this.d.deliver([u], 'meet.knocks', b);
    }
  }

  /** A knock's card in someone's conversation with Nib (they were told about it). */
  card(me: PublicUser, ref: string): KnockView | null {
    const k = this.knocks.get(ref);
    if (!k) return null;
    if (!k.told.has(me.id)) throw new KnockError('This card is not for you.');
    return this.viewOf(k);
  }

  /** Admit or Decline from the card, the indicator or a notification. */
  answer(me: PublicUser, d: { id?: unknown; meetingId?: unknown; all?: unknown; allow?: unknown }): { knocks: KnockView[] } {
    const allow = d.allow === true;
    if (typeof d.id === 'string') {
      const k = this.knocks.get(d.id);
      if (!k) throw new KnockError('That request to join is no longer open.');
      if (!k.told.has(me.id) && !this.d.admittersOf(k.meetingId).includes(me.id)) throw new KnockError('Only the host and co-hosts can let people in.');
      if (k.state !== 'waiting') throw new KnockError(this.doneText(k));
      this.d.answer(me, k.meetingId, [k.deviceId], allow);
      return { knocks: [this.viewOf(k)] };
    }
    if (typeof d.meetingId === 'string' && d.all === true) {
      const list = [...(this.open.get(d.meetingId)?.values() ?? [])];
      if (!list.length) throw new KnockError('No one is waiting.');
      this.d.answer(me, d.meetingId, list.map((k) => k.deviceId), allow);
      return { knocks: list.map((k) => this.viewOf(k)) };
    }
    throw new KnockError('Choose who to let in.');
  }

  private doneText(k: Knock): string {
    const who = k.by ? (this.d.userById(k.by)?.displayName ?? 'A host') : null;
    switch (k.state) {
      case 'admitted': return who ? `${who} already let ${k.name} in.` : `${k.name} is already in.`;
      case 'declined': return who ? `${who} already turned ${k.name} away.` : `${k.name} was turned away.`;
      case 'left': return `${k.name} left the lobby.`;
      default: return 'The meeting has ended.';
    }
  }

  /** Answered knocks are kept a while for their cards; the oldest go first. */
  private trim(): void {
    if (this.knocks.size <= KEEP_DONE) return;
    for (const [id, k] of this.knocks) {
      if (this.knocks.size <= KEEP_DONE) break;
      if (k.state !== 'waiting') this.knocks.delete(id);
    }
  }

  /** For tests and the Control room: open knocks. */
  get waiting(): number { let n = 0; for (const l of this.open.values()) n += l.size; return n; }
}
