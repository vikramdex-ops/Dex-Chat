// Rooms: voice and video calls. The hub only does signalling (who is in the call, offers,
// answers and ICE candidates). Audio and video travel directly between the PCs on the LAN.
import { ulid } from '@dex/core';
import type { PublicUser, RoomInfo, RoomParticipant } from '@dex/core';

export class RoomError extends Error {}

const RING_TIMEOUT_MS = 45_000;
const MAX_PARTICIPANTS = 8; // a full mesh: beyond this, quality drops on ordinary PCs

interface Room extends RoomInfo { ringTimer: NodeJS.Timeout | null; everJoined: Set<string> }

export interface RoomHost {
  members(convId: string): string[];
  deliverToUsers(userIds: string[], name: string, data: unknown): void;
  deliverToDevice(deviceId: string, name: string, data: unknown): void;
  broadcast(name: string, data: unknown): void;
  /** A call ended: e.g. record it in the conversation. */
  ended?(room: RoomInfo, missed: boolean, durationMs: number): void;
  /** The office policy lets people record calls. */
  allowRecording?(): boolean;
}

export class Rooms {
  private readonly rooms = new Map<string, Room>();
  private readonly host: RoomHost;

  constructor(host: RoomHost) { this.host = host; }

  inRoomUsers(): string[] {
    return [...new Set([...this.rooms.values()].flatMap((r) => r.participants.map((p) => p.userId)))];
  }

  private view(r: Room): RoomInfo {
    return { id: r.id, convId: r.convId, startedBy: r.startedBy, startedAt: r.startedAt, video: r.video, participants: r.participants.map((p) => ({ ...p })), ringing: [...r.ringing] };
  }

  private publish(r: Room): void {
    this.host.deliverToUsers(this.host.members(r.convId), 'room.updated', this.view(r));
  }

  private setBusy(userId: string): void {
    const inRoom = this.inRoomUsers().includes(userId);
    this.host.broadcast('room.busy', { userId, inRoom });
  }

  private get(roomId: unknown, me: PublicUser): Room {
    const r = typeof roomId === 'string' ? this.rooms.get(roomId) : undefined;
    if (!r || !this.host.members(r.convId).includes(me.id)) throw new RoomError('That call has ended.');
    return r;
  }

  private end(r: Room): void {
    if (r.ringTimer) clearTimeout(r.ringTimer);
    this.rooms.delete(r.id);
    const missed = r.everJoined.size <= 1;
    const durationMs = Date.now() - r.startedAt;
    this.host.deliverToUsers(this.host.members(r.convId), 'room.ended', { roomId: r.id, convId: r.convId, missed, startedBy: r.startedBy, durationMs });
    this.host.ended?.(this.view(r), missed, durationMs);
  }

  handle(op: string, me: PublicUser, deviceId: string, d: Record<string, unknown>): unknown {
    switch (op) {
      case 'room.list':
        return [...this.rooms.values()].filter((r) => this.host.members(r.convId).includes(me.id)).map((r) => this.view(r));

      case 'room.start': {
        const convId = String(d.convId ?? '');
        const members = this.host.members(convId);
        if (!members.includes(me.id)) throw new RoomError('Conversation not found.');
        if (members.length < 2) throw new RoomError('There is no one else here to call.');
        // one Room per conversation: starting again joins the running one
        const running = [...this.rooms.values()].find((r) => r.convId === convId);
        if (running) return this.handle('room.join', me, deviceId, { roomId: running.id });
        this.leaveAll(deviceId);
        const room: Room = {
          id: ulid(), convId, startedBy: me.id, startedAt: Date.now(), video: d.video === true,
          participants: [{ userId: me.id, deviceId, joinedAt: Date.now(), muted: false, camera: d.video === true, screen: false }],
          ringing: members.filter((m) => m !== me.id), ringTimer: null, everJoined: new Set([me.id]),
        };
        this.rooms.set(room.id, room);
        room.ringTimer = setTimeout(() => {
          room.ringTimer = null;
          room.ringing = [];
          if (room.participants.length <= 1 && room.everJoined.size <= 1) this.end(room);
          else this.publish(room);
        }, RING_TIMEOUT_MS);
        room.ringTimer.unref?.();
        this.host.deliverToUsers(room.ringing, 'room.ring', { room: this.view(room), from: me.id });
        this.publish(room);
        this.setBusy(me.id);
        return this.view(room);
      }

      case 'room.join': {
        const r = this.get(d.roomId, me);
        if (r.participants.some((p) => p.deviceId === deviceId)) return this.view(r);
        if (r.participants.length >= MAX_PARTICIPANTS) throw new RoomError(`This Room is full (${MAX_PARTICIPANTS} people).`);
        this.leaveAll(deviceId);
        r.participants.push({ userId: me.id, deviceId, joinedAt: Date.now(), muted: false, camera: false, screen: false });
        r.ringing = r.ringing.filter((u) => u !== me.id);
        r.everJoined.add(me.id);
        this.publish(r);
        this.setBusy(me.id);
        return this.view(r);
      }

      case 'room.decline': {
        const r = this.get(d.roomId, me);
        r.ringing = r.ringing.filter((u) => u !== me.id);
        // the only person called said no: the call is over
        if (!r.ringing.length && r.participants.length <= 1 && r.everJoined.size <= 1) this.end(r);
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
        const members = this.host.members(r.convId);
        const ids = (Array.isArray(d.userIds) ? d.userIds.map(String) : [])
          .filter((u) => members.includes(u) && !r.participants.some((p) => p.userId === u) && !r.ringing.includes(u)).slice(0, MAX_PARTICIPANTS);
        if (!ids.length) throw new RoomError('Everyone you chose is already in the call or being rung.');
        if (r.participants.length + ids.length > MAX_PARTICIPANTS) throw new RoomError(`A Room holds up to ${MAX_PARTICIPANTS} people.`);
        r.ringing.push(...ids);
        const stop = setTimeout(() => { r.ringing = r.ringing.filter((u) => !ids.includes(u)); if (this.rooms.has(r.id)) this.publish(r); }, RING_TIMEOUT_MS);
        stop.unref?.();
        this.host.deliverToUsers(ids, 'room.ring', { room: this.view(r), from: me.id });
        this.publish(r);
        return this.view(r);
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
    }
    return undefined;
  }

  private removeDevice(r: Room, deviceId: string): void {
    const p = r.participants.find((x) => x.deviceId === deviceId);
    if (!p) return;
    r.participants = r.participants.filter((x) => x.deviceId !== deviceId);
    // a one-to-one call ends when either person hangs up; group Rooms run until the last leaves
    const oneToOne = this.host.members(r.convId).length === 2 && r.everJoined.size > 1;
    if (!r.participants.length || (oneToOne && r.participants.length === 1)) this.end(r);
    else this.publish(r);
    this.setBusy(p.userId);
  }

  /** A device can only be in one Room; also called when a device disconnects. */
  leaveAll(deviceId: string): void {
    for (const r of [...this.rooms.values()]) this.removeDevice(r, deviceId);
  }
}
