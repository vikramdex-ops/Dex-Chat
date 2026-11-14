// Lounges: standing audio spaces inside a Space ("Piping desk", "Site coordination"). A lounge
// exists while it is empty; people drop in and out without ringing or scheduling. Its live part is
// an ordinary Room (PC to PC up to 8, the hub's relay above that) marked as the lounge's; the
// lounge itself, its name and whether it is archived, is kept here and survives hub restarts.
import type { DatabaseSync } from 'node:sqlite';
import { ulid } from '@dex/core';
import type { Lounge, PublicUser, RoomInfo } from '@dex/core';
import type { Messaging } from './messaging.ts';
import type { Rooms } from './rooms.ts';

export class LoungeError extends Error {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lounges (
  id TEXT PRIMARY KEY,
  conv TEXT NOT NULL,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_lounges_conv ON lounges(conv);
`;

interface Row { id: string; conv: string; name: string; created_by: string; created_at: number; archived: number }

const MAX_PER_SPACE = 12;
const name = (v: unknown): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) : '');

export interface LoungeHost {
  db: DatabaseSync;
  messaging: Messaging;
  rooms: Rooms;
  /** Send an event to every connected device of these people. */
  deliver(userIds: string[], name: string, data: unknown): void;
  /** Tell colleagues where someone is: Space members get the lounge's name, everyone else only that they are in one. */
  where(userId: string, lounge: { id: string; convId: string; name: string } | null): void;
}

export class Lounges {
  private readonly db: DatabaseSync;
  private readonly host: LoungeHost;
  /** Who is in which lounge now (user -> lounge id), to tell colleagues when it changes. */
  private readonly present = new Map<string, string>();

  constructor(host: LoungeHost) {
    this.host = host;
    this.db = host.db;
    this.db.exec(SCHEMA);
  }

  private row(id: unknown): Row | undefined {
    return typeof id === 'string' ? this.db.prepare('SELECT * FROM lounges WHERE id = ?').get(id) as Row | undefined : undefined;
  }

  private view(r: Row): Lounge {
    const room = r.archived ? null : this.host.rooms.purposeRoom({ kind: 'lounge', loungeId: r.id, name: r.name });
    return {
      id: r.id, convId: r.conv, name: r.name, createdBy: r.created_by, createdAt: r.created_at, archived: !!r.archived,
      roomId: room?.id ?? null, people: room ? room.participants.map((p) => ({ userId: p.userId, deviceId: p.deviceId, muted: p.muted })) : [],
    };
  }

  private publish(r: Row): Lounge {
    const v = this.view(r);
    this.host.deliver(this.host.messaging.members(r.conv), 'lounge.updated', v);
    return v;
  }

  private space(convId: unknown, me: PublicUser): string {
    const c = typeof convId === 'string' ? this.db.prepare('SELECT id, kind, archived FROM conversations WHERE id = ?').get(convId) as { id: string; kind: string; archived: number } | undefined : undefined;
    if (!c || !this.host.messaging.isMember(c.id, me.id)) throw new LoungeError('Space not found.');
    if (c.kind !== 'space') throw new LoungeError('Lounges belong to Spaces.');
    return c.id;
  }

  /** Administrators and the Space's managers (its creator and moderators) rename and archive lounges. */
  private manages(convId: string, me: PublicUser): boolean {
    if (me.role === 'owner' || me.role === 'admin') return true;
    const c = this.db.prepare('SELECT created_by FROM conversations WHERE id = ?').get(convId) as { created_by: string } | undefined;
    if (c?.created_by === me.id) return true;
    return !!this.db.prepare('SELECT 1 FROM conv_members WHERE conv_id = ? AND user_id = ? AND moderator = 1').get(convId, me.id);
  }

  private nameFree(convId: string, n: string, except?: string): boolean {
    return !this.db.prepare('SELECT 1 FROM lounges WHERE conv = ? AND archived = 0 AND name = ? COLLATE NOCASE AND id != ?').get(convId, n, except ?? '');
  }

  handle(op: string, me: PublicUser, deviceId: string, d: Record<string, unknown>, fromOutside: boolean): unknown {
    switch (op) {
      case 'lounge.list': {
        const rows = (typeof d.convId === 'string'
          ? this.db.prepare('SELECT * FROM lounges WHERE conv = ? ORDER BY created_at').all(this.space(d.convId, me))
          : this.db.prepare(`SELECT l.* FROM lounges l JOIN conv_members m ON m.conv_id = l.conv AND m.user_id = ? ORDER BY l.created_at`).all(me.id)) as unknown as Row[];
        // archived lounges only for the people who can bring them back
        return rows.filter((r) => !r.archived || this.manages(r.conv, me)).map((r) => this.view(r));
      }
      case 'lounge.create': {
        if (me.role === 'guest' || me.role === 'bot') throw new LoungeError('Members of the office open lounges.');
        const convId = this.space(d.convId, me);
        if ((this.db.prepare('SELECT archived FROM conversations WHERE id = ?').get(convId) as { archived: number }).archived) throw new LoungeError('This Space is archived.');
        const n = name(d.name);
        if (n.length < 2) throw new LoungeError('Give the lounge a name, such as "Piping desk".');
        if ((this.db.prepare('SELECT COUNT(*) AS c FROM lounges WHERE conv = ? AND archived = 0').get(convId) as { c: number }).c >= MAX_PER_SPACE) throw new LoungeError(`A Space holds up to ${MAX_PER_SPACE} lounges. Archive one first.`);
        if (!this.nameFree(convId, n)) throw new LoungeError('This Space already has a lounge by that name.');
        const id = ulid();
        this.db.prepare('INSERT INTO lounges (id, conv, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(id, convId, n, me.id, Date.now());
        return this.publish(this.row(id)!);
      }
      case 'lounge.rename': {
        const r = this.row(d.id);
        if (!r || !this.host.messaging.isMember(r.conv, me.id)) throw new LoungeError('Lounge not found.');
        if (!this.manages(r.conv, me)) throw new LoungeError('Administrators and the Space\'s managers rename lounges.');
        const n = name(d.name);
        if (n.length < 2) throw new LoungeError('Give the lounge a name.');
        if (!this.nameFree(r.conv, n, r.id)) throw new LoungeError('This Space already has a lounge by that name.');
        this.db.prepare('UPDATE lounges SET name = ? WHERE id = ?').run(n, r.id);
        if (!r.archived) this.host.rooms.renamePurpose({ kind: 'lounge', loungeId: r.id, name: n });
        // people in it are now "In <new name>"
        for (const [u, l] of this.present) if (l === r.id) this.host.where(u, { id: r.id, convId: r.conv, name: n });
        return this.publish(this.row(r.id)!);
      }
      case 'lounge.archive': {
        const r = this.row(d.id);
        if (!r || !this.host.messaging.isMember(r.conv, me.id)) throw new LoungeError('Lounge not found.');
        if (!this.manages(r.conv, me)) throw new LoungeError('Administrators and the Space\'s managers archive lounges.');
        const archived = d.archived === true;
        if (!archived && !this.nameFree(r.conv, r.name, r.id)) throw new LoungeError('Another lounge has that name now. Rename one of them first.');
        this.db.prepare('UPDATE lounges SET archived = ? WHERE id = ?').run(archived ? 1 : 0, r.id);
        // everyone in it leaves when it is archived
        if (archived) this.host.rooms.endPurpose({ kind: 'lounge', loungeId: r.id, name: r.name }, me.id);
        return this.publish(this.row(r.id)!);
      }
      case 'lounge.join': {
        const r = this.row(d.id);
        if (!r || !this.host.messaging.isMember(r.conv, me.id)) throw new LoungeError('Lounge not found.');
        if (r.archived) throw new LoungeError('This lounge was archived.');
        return this.host.rooms.enterPurpose({ convId: r.conv, purpose: { kind: 'lounge', loungeId: r.id, name: r.name } }, me, deviceId, fromOutside);
      }
      case 'lounge.presence': {
        const out: Array<{ userId: string; loungeId: string; name: string | null }> = [];
        for (const [userId, loungeId] of this.present) {
          const r = this.row(loungeId);
          if (!r) continue;
          out.push({ userId, loungeId, name: this.host.messaging.isMember(r.conv, me.id) ? r.name : null });
        }
        return out;
      }
    }
    return undefined;
  }

  /** A lounge's Room changed or ended: tell its Space, and tell colleagues who came or went. */
  roomChanged(room: RoomInfo, ended: boolean): void {
    if (room.purpose?.kind !== 'lounge') return;
    const loungeId = room.purpose.loungeId;
    const r = this.row(loungeId);
    const here = new Set(ended ? [] : room.participants.map((p) => p.userId));
    for (const [u, l] of [...this.present]) {
      if (l === loungeId && !here.has(u)) { this.present.delete(u); this.host.where(u, null); }
    }
    for (const u of here) {
      if (this.present.get(u) === loungeId) continue;
      this.present.set(u, loungeId);
      this.host.where(u, r ? { id: r.id, convId: r.conv, name: r.name } : null);
    }
    if (!r) return;
    const v = this.view(r);
    // the Room is gone when it ended: nobody is in the lounge any more
    this.host.deliver(this.host.messaging.members(r.conv), 'lounge.updated', ended ? { ...v, roomId: null, people: [] } : v);
  }
}
