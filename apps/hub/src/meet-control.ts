// "Give control" in meetings (docs/MEETINGS.md): the presenter (the device sharing its screen) may
// let one other person in the Room use their mouse and keyboard: someone in the desktop app, or a
// guest in a browser whom the presenter picked on purpose (the guest's input then comes through the
// gateway, meet-guests.ts, and takes the same path from here). The hub keeps that grant per
// Room, passes input on the relay (room.data) only from the person granted and only to the
// presenter, and ends the grant when sharing stops, either person leaves or the meeting ends.
// Every grant and its end are audited with how long it lasted. The presenter's own PC checks
// every event again (apps/desktop/src/main/assist) before anything reaches its input, and the
// events travel PC to PC over the data channel whenever there is one.
import { CONTROL_ASKS_PER_MIN, askerRefusal, controllerRefusal, isWebGuest, presenterRefusal } from '@dex/core';
import type { ControlEndReason, PublicUser, RoomControl, RoomParticipant } from '@dex/core';
import type { Room, RoomHost } from './rooms.ts';

export class ControlError extends Error {}

/** What the grant needs from the Rooms. */
export interface ControlCore {
  host: RoomHost;
  /** Whether this person is on a webinar stage's staff (organiser, co-host, panelist); null outside webinars. */
  stageStaff(r: Room, userId: string): boolean | null;
  /** A browser guest's name, for the audit log. */
  guestName?(userId: string): string | null;
}

interface Live extends RoomControl { grantedBy: string }

/** Input messages on the relay a second from the controller (each holds up to 32 events; the presenter's PC allows 120 events a second). */
const INPUT_MSGS_PER_S = 125;

export class MeetControl {
  private readonly core: ControlCore;
  private readonly grants = new Map<string, Live>();
  private readonly asks = new Map<string, number[]>();
  private readonly inputHits = new Map<string, number[]>();

  constructor(core: ControlCore) { this.core = core; }

  /** The grant in a Room, as the Room's view shows it. */
  view(roomId: string): RoomControl | null {
    const g = this.grants.get(roomId);
    return g ? { presenterId: g.presenterId, presenterDevice: g.presenterDevice, controllerId: g.controllerId, controllerDevice: g.controllerDevice, since: g.since, ...(g.guest ? { guest: true } : {}) } : null;
  }

  private presenter(r: Room, deviceId: string): RoomParticipant {
    const p = r.participants.find((x) => x.deviceId === deviceId);
    const why = presenterRefusal(p);
    if (why) throw new ControlError(p?.screen === false ? 'Only the person sharing their screen can give control of it.' : why);
    return p!;
  }

  /** Who may be given control: a guest in a browser only when the presenter picked them on purpose. */
  private controller(r: Room, deviceId: string, guestPicked = false): RoomParticipant {
    const p = r.participants.find((x) => x.deviceId === deviceId);
    const why = controllerRefusal(p, p ? this.core.stageStaff(r, p.userId) : null, { guestPicked });
    if (why) throw new ControlError(why);
    return p!;
  }

  private asker(r: Room, deviceId: string): RoomParticipant {
    const p = r.participants.find((x) => x.deviceId === deviceId);
    const why = askerRefusal(p, p ? this.core.stageStaff(r, p.userId) : null);
    if (why) throw new ControlError(why);
    return p!;
  }

  handle(op: string, me: PublicUser, deviceId: string, r: Room, d: Record<string, unknown>): unknown {
    switch (op) {
      case 'room.control.ask': {
        const asker = this.asker(r, deviceId);
        const presenter = r.participants.find((p) => p.screen && p.deviceId !== deviceId);
        if (!presenter) throw new ControlError('Nobody is sharing a screen.');
        const why = presenterRefusal(presenter);
        if (why) throw new ControlError(why.startsWith('On a Mac') ? 'Their screen is view only: it is shared from a Mac.' : why);
        if (presenter.userId === asker.userId) throw new ControlError('That is your own screen.');
        const g = this.grants.get(r.id);
        if (g) throw new ControlError(g.controllerDevice === deviceId ? 'You have control already.' : 'Someone else has control now: one person at a time.');
        const now = Date.now();
        const key = `${r.id}:${deviceId}`;
        const hits = (this.asks.get(key) ?? []).filter((t) => now - t < 60_000);
        if (hits.length >= CONTROL_ASKS_PER_MIN) throw new ControlError('You asked a moment ago. Wait for an answer.');
        hits.push(now);
        this.asks.set(key, hits);
        this.core.host.deliverToDevice(presenter.deviceId, 'room.controlAsk', { roomId: r.id, fromDevice: deviceId, fromUser: me.id, at: now });
        return { ok: true };
      }
      case 'room.control.refuse': {
        this.presenter(r, deviceId);
        const to = typeof d.deviceId === 'string' ? d.deviceId : '';
        if (r.participants.some((p) => p.deviceId === to)) this.core.host.deliverToDevice(to, 'room.controlRefused', { roomId: r.id, by: me.id });
        return { ok: true };
      }
      case 'room.control.grant': {
        const presenter = this.presenter(r, deviceId);
        const to = typeof d.deviceId === 'string' ? d.deviceId : '';
        // a guest only when the presenter picked them on purpose (their app says so with guest: true)
        const target = this.controller(r, to, d.guest === true);
        if (target.userId === presenter.userId) throw new ControlError('Give control to someone else in the Room.');
        const cur = this.grants.get(r.id);
        if (cur && cur.controllerDevice === to && cur.presenterDevice === deviceId) return this.view(r.id);
        if (cur) throw new ControlError('Someone else has control now. Take it back first: one person at a time.');
        const guest = isWebGuest(target.userId);
        const g: Live = { presenterId: presenter.userId, presenterDevice: deviceId, controllerId: target.userId, controllerDevice: to, since: Date.now(), grantedBy: me.id, ...(guest ? { guest: true } : {}) };
        this.grants.set(r.id, g);
        this.asks.delete(`${r.id}:${to}`);
        this.core.host.audit?.(me.id, 'meeting.control.granted', r.meeting?.id ?? r.id, {
          roomId: r.id, presenter: g.presenterId, controller: g.controllerId, controllerDevice: to, webinar: r.meeting?.kind === 'webinar',
          ...(guest ? { guest: true, controllerName: this.core.guestName?.(target.userId) ?? 'Guest' } : {}),
        });
        return this.view(r.id);
      }
      case 'room.control.stop': {
        const g = this.grants.get(r.id);
        if (!g) return { ok: true };
        if (deviceId === g.presenterDevice) this.end(r, 'stopped', me.id);
        else if (deviceId === g.controllerDevice) this.end(r, 'released', me.id);
        else throw new ControlError('Only the presenter or the person in control can stop it.');
        return { ok: true };
      }
    }
    return undefined;
  }

  /**
   * A message on the relay: input events pass only from the device granted control, and only to
   * the presenter (false: drop it). Anything else is not input and goes its usual way.
   */
  inputRoute(r: Room, fromDevice: string, data: unknown, now = Date.now()): { input: boolean; to: string | null } {
    if (!data || typeof data !== 'object' || (data as { k?: unknown }).k !== 'in') return { input: false, to: null };
    const g = this.grants.get(r.id);
    if (!g || g.controllerDevice !== fromDevice || !r.participants.some((p) => p.deviceId === g.presenterDevice)) return { input: true, to: null };
    const key = `${r.id}:${fromDevice}`;
    const hits = (this.inputHits.get(key) ?? []).filter((t) => now - t < 1000);
    if (hits.length >= INPUT_MSGS_PER_S) { this.inputHits.set(key, hits); return { input: true, to: null }; }
    hits.push(now);
    this.inputHits.set(key, hits);
    return { input: true, to: g.presenterDevice };
  }

  /** The Room changed (someone left, stopped sharing, moved to a breakout): end a grant that no longer holds. */
  check(r: Room): void {
    const g = this.grants.get(r.id);
    if (!g) return;
    const presenter = r.participants.find((p) => p.deviceId === g.presenterDevice);
    const controller = r.participants.find((p) => p.deviceId === g.controllerDevice);
    if (!presenter) this.end(r, 'presenter left', null);
    else if (!presenter.screen || !presenter.controllable) this.end(r, 'sharing stopped', null);
    else if (!controller) this.end(r, 'controller left', null);
  }

  /** The Room ended. */
  closed(r: Room): void {
    if (this.grants.has(r.id)) this.end(r, 'meeting ended', null);
    for (const k of [...this.asks.keys()]) if (k.startsWith(`${r.id}:`)) this.asks.delete(k);
    for (const k of [...this.inputHits.keys()]) if (k.startsWith(`${r.id}:`)) this.inputHits.delete(k);
  }

  private end(r: Room, why: ControlEndReason, by: string | null): void {
    const g = this.grants.get(r.id);
    if (!g) return;
    this.grants.delete(r.id);
    this.inputHits.delete(`${r.id}:${g.controllerDevice}`);
    const to = Date.now();
    const durationMs = to - g.since;
    this.core.host.audit?.(by, 'meeting.control.revoked', r.meeting?.id ?? r.id, { roomId: r.id, presenter: g.presenterId, controller: g.controllerId, from: g.since, to, durationMs, why, ...(g.guest ? { guest: true } : {}) });
    const evt = { roomId: r.id, why, by, durationMs, presenterId: g.presenterId, controllerId: g.controllerId };
    for (const dev of new Set([g.presenterDevice, g.controllerDevice])) this.core.host.deliverToDevice(dev, 'room.controlEnded', evt);
  }

  /** Never give control to a browser guest, whatever they claim. */
  static desktopClaim(userId: string, claim: unknown): boolean { return claim === true && !isWebGuest(userId); }
}
