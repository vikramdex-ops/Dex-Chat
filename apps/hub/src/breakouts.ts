// Breakout rooms: a host splits the people in a meeting into smaller Rooms for a while, then calls
// everyone back. Each breakout is a Room of its own (its own media: PC to PC, or the relay when it
// is large), held under the same meeting and conversation, so the conversation's chat and the
// meeting chat stay shared. People are moved between Rooms without leaving the meeting, so the
// meeting's attendance counts the whole time. Hosts can send a note to every room, visit any
// room, move someone, and call everyone back: a 60-second countdown is shown to everyone first.
import { BREAKOUT_MAX_ROOMS, BREAKOUT_RETURN_MS, ulid } from '@dex/core';
import type { BreakoutView, PublicUser } from '@dex/core';
import type { Room, RoomsCore } from './rooms.ts';
import { RoomError } from './rooms.ts';

const MAX_NOTE = 500;
const MAX_MINUTES = 240;
const MESH = 8;

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

export class Breakouts {
  private readonly core: RoomsCore;
  /** Timers by main Room: the breakout timer and the return countdown. */
  private readonly timers = new Map<string, { ends: NodeJS.Timeout | null; back: NodeJS.Timeout | null }>();

  constructor(core: RoomsCore) { this.core = core; }

  /** The main Room of a Room (itself, or the Room a breakout belongs to). */
  main(r: Room): Room {
    return r.parentId ? this.core.rooms.get(r.parentId) ?? r : r;
  }

  /** The breakouts of a main Room that are still open. */
  subs(main: Room): Room[] {
    return (main.breakouts?.rooms ?? []).map((b) => (b.roomId ? this.core.rooms.get(b.roomId) : undefined)).filter((x): x is Room => !!x);
  }

  /** Every Room of a meeting: the main Room and its breakouts. */
  family(r: Room): Room[] {
    const m = this.main(r);
    return [m, ...this.subs(m)];
  }

  private publishAll(main: Room): void {
    for (const r of this.family(main)) this.core.publish(r);
  }

  /** Move one device from one Room of the meeting to another, keeping it in the meeting. */
  move(from: Room, to: Room, deviceId: string): void {
    const p = from.participants.find((x) => x.deviceId === deviceId);
    // a seat on hold stays where it is: its device is in another call and comes back to this room
    if (!p || from === to || p.held) return;
    if (to.participants.length >= this.core.capacity(to)) throw new RoomError(`${to.breakoutName ?? 'The main Room'} is full (${this.core.capacity(to)} people).`);
    from.participants = from.participants.filter((x) => x.deviceId !== deviceId);
    from.handList = from.handList.filter((h) => h.deviceId !== deviceId);
    if (from.spotlight === deviceId) from.spotlight = null;
    this.core.host.deviceLeft?.(from.id, deviceId);
    // a shared screen does not follow its owner into another room
    to.participants.push({ ...p, screen: false });
    to.everJoined.add(p.userId);
    if (!this.core.host.members(to.convId).includes(p.userId)) to.admittedUsers.add(p.userId);
    this.core.host.deliverToDevice(deviceId, 'room.moved', { from: from.id, room: this.core.view(to, this.core.isHost(to, p.userId)) });
  }

  private sub(main: Room, index: number, name: string, size: number): Room {
    const relay = size > MESH;
    if (relay && (main.mode !== 'relay' || !this.core.host.relayAvailable?.())) throw new RoomError(`A breakout room holds up to ${MESH} people in this meeting.`);
    const r: Room = {
      id: ulid(), convId: main.convId, startedBy: main.startedBy, startedAt: Date.now(), video: main.video,
      participants: [], ringing: [], ringTimer: null, everJoined: new Set(), mode: relay ? 'relay' : 'mesh',
      meeting: main.meeting, hostId: main.hostId, locked: false, spotlight: null,
      admittedUsers: new Set(main.admittedUsers), removedUsers: new Set(main.removedUsers), lobbyList: [], handList: [],
      coHostSet: new Set(main.coHostSet), chat: main.chat, parentId: main.id, breakoutName: `B${index + 1} · ${name}`,
    };
    this.core.rooms.set(r.id, r);
    return r;
  }

  /** Close a breakout without ending the meeting (its people were moved out first). */
  private closeSub(r: Room): void {
    for (const p of r.participants) this.core.host.deviceLeft?.(r.id, p.deviceId);
    this.core.rooms.delete(r.id);
    this.core.host.roomClosed?.(r.id);
  }

  private clearTimers(mainId: string): void {
    const t = this.timers.get(mainId);
    if (t?.ends) clearTimeout(t.ends);
    if (t?.back) clearTimeout(t.back);
    this.timers.delete(mainId);
  }

  /** Everyone back in the main Room, the breakouts closed. */
  returnAll(main: Room): void {
    if (!this.core.rooms.has(main.id) || !main.breakouts) return;
    this.clearTimers(main.id);
    for (const s of this.subs(main)) {
      for (const p of [...s.participants]) {
        // the main Room has room for everyone who was in the meeting
        try { this.move(s, main, p.deviceId); } catch { this.core.host.deliverToDevice(p.deviceId, 'room.ended', { roomId: s.id, convId: s.convId, missed: false, startedBy: s.startedBy, durationMs: Date.now() - s.startedAt }); }
      }
      this.closeSub(s);
    }
    main.breakouts = null;
    this.core.host.audit?.(null, 'meeting.breakouts.closed', main.meeting?.id ?? main.id, { roomId: main.id });
    this.core.host.track?.breakoutsClosed(main.id);
    this.core.publish(main);
  }

  /** The meeting ends: breakouts close with it (their people are told the Room ended). */
  endedWith(main: Room): void {
    this.clearTimers(main.id);
    for (const s of this.subs(main)) {
      const users = [...new Set(s.participants.map((p) => p.userId))];
      for (const p of s.participants) this.core.host.deviceLeft?.(s.id, p.deviceId);
      this.core.rooms.delete(s.id);
      this.core.host.roomClosed?.(s.id);
      if (users.length) this.core.host.deliverToUsers(users, 'room.ended', { roomId: s.id, convId: s.convId, missed: false, startedBy: s.startedBy, durationMs: Date.now() - s.startedAt });
    }
    main.breakouts = null;
  }

  /** Start the countdown back to the main Room (a host called everyone back, or the timer ran out). */
  private callBack(main: Room, now = false): void {
    const b = main.breakouts;
    if (!b) return;
    if (now) { this.returnAll(main); return; }
    if (b.returningAt) return;
    b.returningAt = Date.now() + BREAKOUT_RETURN_MS;
    const t = this.timers.get(main.id) ?? { ends: null, back: null };
    if (t.ends) { clearTimeout(t.ends); t.ends = null; }
    t.back = setTimeout(() => this.returnAll(main), BREAKOUT_RETURN_MS);
    t.back.unref?.();
    this.timers.set(main.id, t);
    this.publishAll(main);
  }

  /** Who is in a breakout now (kept in step with moves). */
  private sync(main: Room): void {
    if (!main.breakouts) return;
    for (const b of main.breakouts.rooms) {
      const r = b.roomId ? this.core.rooms.get(b.roomId) : undefined;
      if (r) b.devices = r.participants.map((p) => p.deviceId);
    }
  }

  view(main: Room): BreakoutView | null {
    this.sync(main);
    return main.breakouts ? { ...main.breakouts, rooms: main.breakouts.rooms.map((x) => ({ ...x, devices: [...x.devices] })) } : null;
  }

  handle(op: string, me: PublicUser, deviceId: string, d: Record<string, unknown>, here: Room): unknown {
    const main = this.main(here);
    if (!this.core.isHost(here, me.id)) throw new RoomError('Only the host and co-hosts can run breakout rooms.');
    switch (op) {
      case 'room.breakout.open': {
        if (here.parentId) throw new RoomError('Open breakout rooms from the main Room.');
        if (main.breakouts) throw new RoomError('Breakout rooms are already open. Call everyone back first.');
        if (!main.meeting) throw new RoomError('Breakout rooms are for meetings.');
        const list = Array.isArray(d.rooms) ? d.rooms.slice(0, BREAKOUT_MAX_ROOMS + 1) : [];
        if (list.length < 1) throw new RoomError('Make at least one breakout room.');
        if (list.length > BREAKOUT_MAX_ROOMS) throw new RoomError(`Make up to ${BREAKOUT_MAX_ROOMS} breakout rooms.`);
        const minutes = d.minutes === null || d.minutes === undefined ? null : Number(d.minutes);
        if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES)) throw new RoomError(`Set the timer between 1 and ${MAX_MINUTES} minutes, or none.`);
        const present = new Set(main.participants.map((p) => p.deviceId));
        const taken = new Set<string>();
        const specs = list.map((x, i) => {
          const o = (x && typeof x === 'object' ? x : {}) as { name?: unknown; devices?: unknown };
          const devices = (Array.isArray(o.devices) ? o.devices : []).map(String).filter((dv) => present.has(dv) && !taken.has(dv));
          for (const dv of devices) taken.add(dv);
          return { name: clean(o.name, 40) || `Room ${i + 1}`, devices };
        });
        if (!taken.size) throw new RoomError('Put someone in a breakout room first.');
        const subs = specs.map((s, i) => this.sub(main, i, s.name, s.devices.length));
        main.breakouts = {
          mainRoomId: main.id, openedAt: Date.now(), endsAt: minutes ? Date.now() + minutes * 60_000 : null, returningAt: null, note: null,
          rooms: specs.map((s, i) => ({ index: i, name: s.name, roomId: subs[i].id, devices: s.devices })),
        };
        for (const [i, s] of specs.entries()) for (const dv of s.devices) this.move(main, subs[i], dv);
        if (minutes) {
          const t = setTimeout(() => this.callBack(main), minutes * 60_000);
          t.unref?.();
          this.timers.set(main.id, { ends: t, back: null });
        }
        this.core.host.audit?.(me.id, 'meeting.breakouts.opened', main.meeting.id, { roomId: main.id, rooms: specs.length, people: taken.size, minutes });
        this.core.host.track?.breakoutsOpened(main.id, specs.length);
        this.publishAll(main);
        return this.view(main);
      }
      case 'room.breakout.note': {
        if (!main.breakouts) throw new RoomError('No breakout rooms are open.');
        const text = clean(d.text, MAX_NOTE);
        if (!text) throw new RoomError('Write the note first.');
        main.breakouts.note = { text, by: me.id, at: Date.now() };
        const evt = { mainRoomId: main.id, text, by: me.id, at: main.breakouts.note.at };
        for (const r of this.family(main)) for (const p of r.participants) this.core.host.deliverToDevice(p.deviceId, 'room.breakoutNote', evt);
        this.publishAll(main);
        return { ok: true };
      }
      case 'room.breakout.visit': {
        if (!main.breakouts) throw new RoomError('No breakout rooms are open.');
        const target = d.to === 'main' ? main : this.subs(main).find((s) => main.breakouts!.rooms.find((b) => b.roomId === s.id)?.index === Number(d.to));
        if (!target) throw new RoomError('That breakout room has closed.');
        if (target === here) return this.core.view(here, true);
        this.move(here, target, deviceId);
        this.publishAll(main);
        return this.core.view(target, true);
      }
      case 'room.breakout.move': {
        if (!main.breakouts) throw new RoomError('No breakout rooms are open.');
        const dv = String(d.deviceId ?? '');
        const from = this.family(main).find((r) => r.participants.some((p) => p.deviceId === dv));
        const to = this.subs(main).find((s) => main.breakouts!.rooms.find((b) => b.roomId === s.id)?.index === Number(d.to));
        if (!from) throw new RoomError('That person has left the meeting.');
        if (!to) throw new RoomError('That breakout room has closed.');
        this.move(from, to, dv);
        this.publishAll(main);
        return this.view(main);
      }
      case 'room.breakout.close': {
        if (!main.breakouts) return null;
        this.callBack(main, d.now === true);
        return this.view(main);
      }
    }
    return undefined;
  }

  /** Someone left a breakout (closed the app): it stays open for the rest; empty ones too, until the return. */
  left(r: Room): void {
    const main = this.main(r);
    if (main !== r) this.publishAll(main);
  }

  /** The main Room and every breakout are empty: the meeting is over. */
  empty(main: Room): boolean {
    return this.family(main).every((x) => !x.participants.length);
  }
}

