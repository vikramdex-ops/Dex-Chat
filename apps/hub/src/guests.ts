// Guests: people from outside the company (consultants, client engineers) who join with an
// invite code. They are approved at once, see only the Spaces the invite names and the people
// in their conversations, and lose access automatically when their time is up.
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ulid } from '@dex/core';
import type { GuestInvite, Ops, PublicUser } from '@dex/core';
import type { Store } from './store.ts';
import type { Messaging } from './messaging.ts';

export class GuestError extends Error {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS guest_invites (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  hint TEXT NOT NULL,
  space_ids TEXT NOT NULL,
  access_days INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER NOT NULL,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS guest_access (
  user_id TEXT PRIMARY KEY,
  until INTEGER,
  invite_id TEXT
);
`;

interface InviteRow { id: string; code_hash: string; hint: string; space_ids: string; access_days: number; expires_at: number; uses: number; max_uses: number; note: string | null; created_by: string; created_at: number; revoked: number }

const DAY = 86400_000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const hash = (code: string) => crypto.createHash('sha256').update(code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');

function newCode(): string {
  const bytes = crypto.randomBytes(10);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return `DEX-${s.slice(0, 5)}-${s.slice(5)}`;
}

export class Guests {
  private readonly db: DatabaseSync;
  private readonly store: Store;
  private readonly messaging: Messaging;
  /** Disconnect and forget a user's devices (expiry or ending access). */
  private readonly cutOff: (userId: string) => void;

  constructor(store: Store, messaging: Messaging, cutOff: Guests['cutOff']) {
    this.store = store;
    this.db = store.db;
    this.messaging = messaging;
    this.cutOff = cutOff;
    this.db.exec(SCHEMA);
  }

  private view(r: InviteRow): GuestInvite {
    let spaceIds: string[] = [];
    try { spaceIds = JSON.parse(r.space_ids) as string[]; } catch { /* none */ }
    return { id: r.id, hint: r.hint, spaceIds, accessDays: r.access_days, expiresAt: r.expires_at, uses: r.uses, maxUses: r.max_uses, note: r.note, createdBy: r.created_by, createdAt: r.created_at, revoked: !!r.revoked };
  }

  /** A usable invite for this code, or a reason it cannot be used. */
  check(code: string): { invite: GuestInvite } | { error: string } {
    const r = this.db.prepare('SELECT * FROM guest_invites WHERE code_hash = ?').get(hash(code)) as InviteRow | undefined;
    if (!r) return { error: 'That invite code is not valid. Check it with the person who sent it.' };
    if (r.revoked) return { error: 'That invite was withdrawn.' };
    if (r.expires_at < Date.now()) return { error: 'That invite has expired. Ask for a new one.' };
    if (r.uses >= r.max_uses) return { error: 'That invite has already been used.' };
    return { invite: this.view(r) };
  }

  /** Called when a new guest registers with a valid invite. */
  admit(userId: string, invite: GuestInvite): void {
    this.db.prepare('UPDATE guest_invites SET uses = uses + 1 WHERE id = ?').run(invite.id);
    const until = Date.now() + invite.accessDays * DAY;
    this.db.prepare('INSERT INTO guest_access (user_id, until, invite_id) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET until = excluded.until, invite_id = excluded.invite_id').run(userId, until, invite.id);
    for (const sid of invite.spaceIds) {
      try { this.messaging.ensureMember(sid, userId); } catch { /* Space was deleted */ }
    }
    this.store.audit(null, 'guest.joined', userId, { invite: invite.hint, until });
  }

  until(userId: string): number | null {
    return (this.db.prepare('SELECT until FROM guest_access WHERE user_id = ?').get(userId) as { until: number | null } | undefined)?.until ?? null;
  }

  /** Who a guest may see: people they share a conversation with. */
  visibleTo(viewer: PublicUser, all: PublicUser[]): PublicUser[] {
    if (viewer.role !== 'guest') return all;
    const ids = new Set((this.db.prepare(`SELECT DISTINCT b.user_id FROM conv_members a JOIN conv_members b ON a.conv_id = b.conv_id WHERE a.user_id = ?`).all(viewer.id) as Array<{ user_id: string }>).map((r) => r.user_id));
    ids.add(viewer.id);
    return all.filter((u) => ids.has(u.id));
  }

  /** End access for guests whose time is up. */
  tick(now = Date.now()): void {
    const due = this.db.prepare('SELECT user_id FROM guest_access WHERE until IS NOT NULL AND until < ?').all(now) as Array<{ user_id: string }>;
    for (const g of due) {
      this.db.prepare('UPDATE guest_access SET until = NULL WHERE user_id = ?').run(g.user_id);
      this.end(g.user_id, null, 'guest.expired');
    }
  }

  private end(userId: string, actor: string | null, action: string): void {
    for (const d of this.store.devices().filter((x) => x.userId === userId && x.status === 'approved')) this.store.setDeviceStatus(d.id, 'revoked', actor);
    this.store.audit(actor, action, userId, null);
    this.cutOff(userId);
  }

  handle(op: string, me: PublicUser, d: Record<string, unknown>): unknown {
    if (me.role !== 'owner' && me.role !== 'admin') throw new GuestError('Only administrators can do that.');
    switch (op) {
      case 'admin.guests.invites':
        return (this.db.prepare('SELECT * FROM guest_invites ORDER BY created_at DESC LIMIT 200').all() as unknown as InviteRow[]).map((r) => this.view(r)) satisfies Ops['admin.guests.invites']['res'];

      case 'admin.guests.invite': {
        const spaceIds = Array.isArray(d.spaceIds) ? [...new Set(d.spaceIds.filter((x): x is string => typeof x === 'string'))] : [];
        if (!spaceIds.length) throw new GuestError('Choose at least one Space the guest can use.');
        for (const sid of spaceIds) {
          const c = this.messaging.memberConv(sid, me.id) as { kind: string; everyone: number };
          if (c.kind !== 'space' || c.everyone) throw new GuestError('Guests can be invited to Spaces other than Office.');
        }
        const int = (v: unknown, lo: number, hi: number, label: string) => {
          if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw new GuestError(`${label} must be between ${lo} and ${hi}.`);
          return v;
        };
        const accessDays = int(d.accessDays, 1, 365, 'Access');
        const validDays = int(d.validDays, 1, 30, 'The code');
        const uses = int(d.uses, 1, 50, 'Number of guests');
        const code = newCode();
        const id = ulid();
        const note = typeof d.note === 'string' ? d.note.trim().slice(0, 120) || null : null;
        this.db.prepare(`INSERT INTO guest_invites (id, code_hash, hint, space_ids, access_days, expires_at, max_uses, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, hash(code), code.slice(-4), JSON.stringify(spaceIds), accessDays, Date.now() + validDays * DAY, uses, note, me.id, Date.now());
        this.store.audit(me.id, 'guest.invite', null, { hint: code.slice(-4), spaces: spaceIds.length, accessDays, uses });
        const r = this.db.prepare('SELECT * FROM guest_invites WHERE id = ?').get(id) as unknown as InviteRow;
        return { ...this.view(r), code } satisfies Ops['admin.guests.invite']['res'];
      }

      case 'admin.guests.revokeInvite': {
        if (!this.db.prepare('UPDATE guest_invites SET revoked = 1 WHERE id = ?').run(String(d.id)).changes) throw new GuestError('Invite not found.');
        this.store.audit(me.id, 'guest.inviteRevoked', String(d.id), null);
        return { ok: true };
      }

      case 'admin.guests.list': {
        const guests = this.store.activeUsers().filter((u) => u.role === 'guest');
        return guests.map((user) => ({ user, until: this.until(user.id) })) satisfies Ops['admin.guests.list']['res'];
      }

      case 'admin.guests.extend': {
        const u = typeof d.userId === 'string' ? this.store.userById(d.userId) : null;
        if (!u || u.role !== 'guest') throw new GuestError('Guest not found.');
        const days = typeof d.days === 'number' && Number.isInteger(d.days) && d.days >= 1 && d.days <= 365 ? d.days : 0;
        if (!days) throw new GuestError('Extend by 1 to 365 days.');
        const until = Math.max(Date.now(), this.until(u.id) ?? Date.now()) + days * DAY;
        this.db.prepare('INSERT INTO guest_access (user_id, until) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET until = excluded.until').run(u.id, until);
        this.store.audit(me.id, 'guest.extended', u.id, { days });
        return { until };
      }

      case 'admin.guests.end': {
        const u = typeof d.userId === 'string' ? this.store.userById(d.userId) : null;
        if (!u || u.role !== 'guest') throw new GuestError('Guest not found.');
        this.db.prepare('UPDATE guest_access SET until = NULL WHERE user_id = ?').run(u.id);
        this.end(u.id, me.id, 'guest.ended');
        return { ok: true };
      }
    }
    return undefined;
  }
}
