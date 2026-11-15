// Live pointers for people looking at the same file or whiteboard together. The hub keeps who is
// looking (by device), who presents (whoever opened it first) and whether pointers are on, and
// passes each pointer message to the other viewers. It never stores them. Rooms carry their own
// pointers over the data channel (rooms.ts `room.data` when there is none).
import type { PointSession, PublicUser } from '@dex/core';
import type { FileStore } from './files.ts';
import type { Messaging } from './messaging.ts';
import type { DatabaseSync } from 'node:sqlite';

export class PointerError extends Error {}

interface Surface { id: string; kind: 'file' | 'board'; target: string; convId: string | null; presenter: string; enabled: boolean; viewers: Map<string, string> }

export interface PointerHost {
  db: DatabaseSync;
  files: FileStore;
  messaging: Messaging;
  deliverToDevice(deviceId: string, name: string, data: unknown): void;
  deliver(userIds: string[], name: string, data: unknown): void;
}

const MAX_SURFACES = 500;
const MAX_VIEWERS = 50;
const MAX_MESSAGE = 8 * 1024;
const SURFACE_RE = /^(file|board):([0-9A-Za-z_-]{6,40})$/;

export class Pointers {
  private readonly host: PointerHost;
  private readonly surfaces = new Map<string, Surface>();
  private readonly rate = new Map<string, number[]>();

  constructor(host: PointerHost) { this.host = host; }

  private allowed(kind: 'file' | 'board', target: string, userId: string): string | null | false {
    if (kind === 'file') return this.host.files.canRead(userId, target) ? null : false;
    const b = this.host.db.prepare('SELECT conv_id FROM boards WHERE id = ?').get(target) as { conv_id: string } | undefined;
    return b && this.host.messaging.isMember(b.conv_id, userId) ? b.conv_id : false;
  }

  private view(s: Surface): PointSession {
    return { surface: s.id, presenter: s.presenter, enabled: s.enabled, viewers: [...s.viewers].map(([deviceId, userId]) => ({ userId, deviceId })) };
  }

  private announce(s: Surface): void {
    const v = this.view(s);
    for (const dev of s.viewers.keys()) this.host.deliverToDevice(dev, 'point.session', v);
  }

  private viewing(surface: unknown, deviceId: string): Surface {
    const s = typeof surface === 'string' ? this.surfaces.get(surface) : undefined;
    if (!s || !s.viewers.has(deviceId)) throw new PointerError('Open it first.');
    return s;
  }

  private limited(deviceId: string, max: number, now = Date.now()): boolean {
    const list = (this.rate.get(deviceId) ?? []).filter((t) => now - t < 1000);
    if (list.length >= max) { this.rate.set(deviceId, list); return true; }
    list.push(now);
    this.rate.set(deviceId, list);
    if (this.rate.size > 2000) for (const [k, v] of this.rate) if (!v.length || now - v[v.length - 1] > 1000) this.rate.delete(k);
    return false;
  }

  private readonly invited = new Map<string, number>();

  handle(op: string, me: PublicUser, deviceId: string, d: Record<string, unknown>): unknown {
    switch (op) {
      case 'point.join': {
        const m = typeof d.surface === 'string' ? d.surface.match(SURFACE_RE) : null;
        if (!m) throw new PointerError('Unknown surface.');
        const kind = m[1] as 'file' | 'board';
        const conv = this.allowed(kind, m[2], me.id);
        if (conv === false) throw new PointerError(kind === 'file' ? 'File not found.' : 'Whiteboard not found.');
        let s = this.surfaces.get(d.surface as string);
        if (!s) {
          if (this.surfaces.size >= MAX_SURFACES) throw new PointerError('Too many shared views are open on the hub. Try again soon.');
          s = { id: d.surface as string, kind, target: m[2], convId: conv, presenter: me.id, enabled: true, viewers: new Map() };
          this.surfaces.set(s.id, s);
        }
        if (!s.viewers.has(deviceId) && s.viewers.size >= MAX_VIEWERS) throw new PointerError(`Up to ${MAX_VIEWERS} people can look together.`);
        s.viewers.set(deviceId, me.id);
        // ask the conversation to look too (a file: only people who can open it hear about it)
        if (d.invite === true && typeof d.convId === 'string' && this.host.messaging.isMember(d.convId, me.id)) {
          const key = `${s.id}:${me.id}`;
          const last = this.invited.get(key) ?? 0;
          if (Date.now() - last > 30_000) {
            this.invited.set(key, Date.now());
            if (this.invited.size > 2000) this.invited.clear();
            const name = typeof d.name === 'string' ? d.name.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 120) : '';
            const to = this.host.messaging.members(d.convId).filter((u) => u !== me.id && this.allowed(kind, m[2], u) !== false);
            this.host.deliver(to, 'point.invite', { surface: s.id, convId: d.convId, name: name || (kind === 'file' ? 'a file' : 'a whiteboard'), by: me.id });
          }
        }
        this.announce(s);
        return this.view(s);
      }
      case 'point.leave': {
        this.dropDevice(deviceId, typeof d.surface === 'string' ? d.surface : undefined);
        return { ok: true };
      }
      case 'point.send': {
        const s = this.viewing(d.surface, deviceId);
        if (JSON.stringify(d.data ?? null).length > MAX_MESSAGE) throw new PointerError('That message is too large.');
        if (this.limited(deviceId, 40)) return { ok: true, limited: true };
        if (!s.enabled && s.presenter !== me.id) return { ok: true, off: true };
        const evt = { surface: s.id, fromDevice: deviceId, fromUser: me.id, data: d.data ?? null };
        for (const dev of s.viewers.keys()) if (dev !== deviceId) this.host.deliverToDevice(dev, 'point.data', evt);
        return { ok: true };
      }
      case 'point.set': {
        const s = this.viewing(d.surface, deviceId);
        if (s.presenter !== me.id) throw new PointerError('Only the person presenting can turn pointers on or off.');
        s.enabled = d.enabled === true;
        this.announce(s);
        return this.view(s);
      }
    }
    return undefined;
  }

  /** A device stopped looking (or disconnected): the next viewer presents if the presenter left. */
  dropDevice(deviceId: string, only?: string): void {
    for (const s of [...this.surfaces.values()]) {
      if (only && s.id !== only) continue;
      if (!s.viewers.delete(deviceId)) continue;
      if (!s.viewers.size) { this.surfaces.delete(s.id); continue; }
      if (![...s.viewers.values()].includes(s.presenter)) s.presenter = s.viewers.values().next().value as string;
      this.announce(s);
    }
    this.rate.delete(deviceId);
  }
}
