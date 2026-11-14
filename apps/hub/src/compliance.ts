// Compliance: how long messages are kept, legal holds (nothing held is purged, and every
// version of an edited or deleted message is kept), and exports of Spaces for review.
// Direct conversations are private between their members (and end-to-end encrypted once
// both sides support it), so exports include their existence and timing but never their text.
import type { DatabaseSync } from 'node:sqlite';
import { toCsv, ulid } from '@dex/core';
import type { CompliancePolicy, LegalHold, Ops, PublicUser } from '@dex/core';
import type { FileStore } from './files.ts';
import type { Messaging } from './messaging.ts';
import type { Store } from './store.ts';

export class ComplianceError extends Error {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS legal_holds (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (kind, target_id)
);
CREATE TABLE IF NOT EXISTS message_history (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  conv_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  change TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_msg ON message_history(message_id);
`;

const DAY = 86400_000;
const MAX_EXPORT = 200_000;

interface MsgRow { id: string; conv_id: string; author_id: string; body: string; parent_id: string | null; created_at: number; edited_at: number | null; deleted: number }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export class Compliance {
  private readonly db: DatabaseSync;
  private readonly store: Store;
  private readonly messaging: Messaging;
  private readonly files: FileStore;

  constructor(store: Store, messaging: Messaging, files: FileStore) {
    this.store = store;
    this.db = store.db;
    this.messaging = messaging;
    this.files = files;
    this.db.exec(SCHEMA);
    // keep earlier versions of held messages before an edit or delete changes them
    messaging.beforeChange = (msg, change, actorId) => {
      if (!this.isHeld(msg.conv_id, msg.author_id)) return;
      this.db.prepare('INSERT INTO message_history (id, message_id, conv_id, author_id, body, change, actor_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(ulid(), msg.id, msg.conv_id, msg.author_id, msg.body, change, actorId, Date.now());
    };
  }

  private num(key: string): number | null {
    const v = this.store.meta(key, () => '');
    return v === '' ? null : Number(v);
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  policy(): CompliancePolicy {
    return {
      spaceRetentionDays: this.num('retention_space_days'),
      directRetentionDays: this.num('retention_direct_days'),
      lastPurgeAt: this.num('retention_last_at'),
      lastPurged: this.num('retention_last_count') ?? 0,
    };
  }

  holds(): LegalHold[] {
    return (this.db.prepare('SELECT * FROM legal_holds ORDER BY created_at DESC').all() as Array<{ id: string; kind: 'user' | 'conv'; target_id: string; note: string | null; created_by: string; created_at: number }>)
      .map((h) => ({ id: h.id, kind: h.kind, targetId: h.target_id, note: h.note, createdBy: h.created_by, createdAt: h.created_at }));
  }

  isHeld(convId: string, authorId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM legal_holds WHERE (kind = 'conv' AND target_id = ?) OR (kind = 'user' AND target_id = ?) LIMIT 1`).get(convId, authorId);
  }

  /** Delete messages past their retention period, except anything on hold. Runs on the hub timer. */
  purge(now = Date.now()): number {
    const p = this.policy();
    let total = 0;
    for (const [kind, days] of [['space', p.spaceRetentionDays], ['direct', p.directRetentionDays]] as const) {
      if (days === null) continue;
      const cutoff = now - days * DAY;
      const rows = this.db.prepare(`SELECT m.id, m.conv_id FROM messages m JOIN conversations c ON c.id = m.conv_id
        WHERE c.kind = ? AND m.created_at < ? AND m.parent_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM legal_holds h WHERE (h.kind = 'conv' AND h.target_id = m.conv_id) OR (h.kind = 'user' AND h.target_id = m.author_id))
        LIMIT 2000`).all(kind, cutoff) as Array<{ id: string; conv_id: string }>;
      for (const r of rows) total += this.messaging.purge(r.id);
    }
    if (total) this.files.gc(now - DAY);
    else this.files.gc(now - 2 * DAY);
    this.setMeta('retention_last_at', String(now));
    this.setMeta('retention_last_count', String(total));
    if (total) this.store.audit(null, 'compliance.purged', null, { messages: total });
    return total;
  }

  handle(op: string, me: PublicUser, d: Record<string, unknown>): unknown {
    if (me.role !== 'owner' && me.role !== 'admin') throw new ComplianceError('Only administrators can do that.');
    switch (op) {
      case 'admin.compliance.get':
        return { policy: this.policy(), holds: this.holds() } satisfies Ops['admin.compliance.get']['res'];

      case 'admin.compliance.setPolicy': {
        const days = (v: unknown, label: string) => {
          if (v === null || v === undefined) return null;
          if (typeof v !== 'number' || !Number.isInteger(v) || v < 30 || v > 36500) throw new ComplianceError(`${label} must be at least 30 days, or kept forever.`);
          return v;
        };
        const space = days(d.spaceRetentionDays, 'Space messages');
        const direct = days(d.directRetentionDays, 'Direct messages');
        this.setMeta('retention_space_days', space === null ? '' : String(space));
        this.setMeta('retention_direct_days', direct === null ? '' : String(direct));
        this.store.audit(me.id, 'compliance.policy', null, { spaceRetentionDays: space, directRetentionDays: direct });
        return this.policy();
      }

      case 'admin.compliance.hold': {
        const kind = d.kind === 'user' || d.kind === 'conv' ? d.kind : null;
        const target = typeof d.targetId === 'string' ? d.targetId : '';
        if (!kind) throw new ComplianceError('Choose a person or a conversation.');
        if (kind === 'user' ? !this.store.userById(target) : !this.db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(target)) throw new ComplianceError('Not found.');
        if (this.db.prepare('SELECT 1 FROM legal_holds WHERE kind = ? AND target_id = ?').get(kind, target)) throw new ComplianceError('That is already on hold.');
        const id = ulid();
        const note = typeof d.note === 'string' ? d.note.trim().slice(0, 200) || null : null;
        this.db.prepare('INSERT INTO legal_holds (id, kind, target_id, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, kind, target, note, me.id, Date.now());
        this.store.audit(me.id, 'compliance.hold', target, { kind, note });
        return this.holds().find((h) => h.id === id)!;
      }

      case 'admin.compliance.release': {
        const h = this.holds().find((x) => x.id === d.id);
        if (!h) throw new ComplianceError('Hold not found.');
        this.db.prepare('DELETE FROM legal_holds WHERE id = ?').run(h.id);
        this.store.audit(me.id, 'compliance.release', h.targetId, { kind: h.kind });
        return { ok: true };
      }

      case 'admin.compliance.conversations': {
        const users = new Map(this.store.activeUsers().map((u) => [u.id, u.displayName] as const));
        const rows = this.db.prepare(`SELECT c.id, c.kind, c.name, (SELECT COUNT(*) FROM messages m WHERE m.conv_id = c.id AND m.deleted = 0) AS n FROM conversations c ORDER BY c.kind DESC, c.name COLLATE NOCASE`).all() as Array<{ id: string; kind: 'space' | 'direct'; name: string | null; n: number }>;
        return rows.map((r) => {
          const members = this.messaging.members(r.id);
          return { id: r.id, kind: r.kind, name: r.name ?? members.map((m) => users.get(m) ?? 'former member').join(', '), members, messages: r.n };
        }) satisfies Ops['admin.compliance.conversations']['res'];
      }

      case 'admin.compliance.export': {
        const from = typeof d.from === 'number' ? d.from : NaN;
        const to = typeof d.to === 'number' ? d.to : NaN;
        if (Number.isNaN(from) || Number.isNaN(to) || to <= from) throw new ComplianceError('Choose a valid period.');
        const format = d.format === 'csv' || d.format === 'html' ? d.format : 'json';
        const convIds = Array.isArray(d.convIds) ? d.convIds.filter((x): x is string => typeof x === 'string') : [];
        const userIds = Array.isArray(d.userIds) ? d.userIds.filter((x): x is string => typeof x === 'string') : [];
        if (!convIds.length && !userIds.length) throw new ComplianceError('Choose conversations or people to export.');
        const where: string[] = ['m.created_at >= ?', 'm.created_at < ?'];
        const args: Array<string | number> = [from, to];
        const or: string[] = [];
        if (convIds.length) { or.push(`m.conv_id IN (${convIds.map(() => '?').join(',')})`); args.push(...convIds); }
        if (userIds.length) { or.push(`m.author_id IN (${userIds.map(() => '?').join(',')})`); args.push(...userIds); }
        where.push(`(${or.join(' OR ')})`);
        const rows = this.db.prepare(`SELECT m.*, c.kind AS conv_kind, c.name AS conv_name FROM messages m JOIN conversations c ON c.id = m.conv_id WHERE ${where.join(' AND ')} ORDER BY m.id LIMIT ${MAX_EXPORT + 1}`)
          .all(...args) as unknown as Array<MsgRow & { conv_kind: 'space' | 'direct'; conv_name: string | null }>;
        if (rows.length > MAX_EXPORT) throw new ComplianceError('More than 200,000 messages. Choose a shorter period.');
        const names = new Map(this.store.activeUsers().map((u) => [u.id, u] as const));
        const who = (id: string) => names.get(id)?.displayName ?? id;
        const account = (id: string) => names.get(id)?.account ?? '';
        const history = d.includeHistory === true;
        const out = rows.map((r) => {
          const direct = r.conv_kind === 'direct';
          const files = direct ? [] : this.files.forMessage(r.id).map((f) => f.name);
          return {
            id: r.id, conversation: direct ? `Direct: ${this.messaging.members(r.conv_id).map(who).join(', ')}` : r.conv_name ?? '', conversationId: r.conv_id,
            kind: r.conv_kind, author: who(r.author_id), account: account(r.author_id), sentAt: new Date(r.created_at).toISOString(),
            editedAt: r.edited_at ? new Date(r.edited_at).toISOString() : null, deleted: !!r.deleted, replyTo: r.parent_id,
            text: direct ? '(private Direct message: content not exported)' : r.deleted ? '' : r.body, files,
            history: history && !direct ? (this.db.prepare('SELECT body, change, actor_id, at FROM message_history WHERE message_id = ? ORDER BY at').all(r.id) as Array<{ body: string; change: string; actor_id: string; at: number }>)
              .map((h) => ({ text: h.body, change: h.change, by: who(h.actor_id), at: new Date(h.at).toISOString() })) : undefined,
          };
        });
        const stamp = new Date().toISOString().slice(0, 10);
        let data: Buffer;
        let mime: string;
        if (format === 'csv') {
          mime = 'text/csv';
          data = Buffer.from(toCsv([
            ['Sent at', 'Conversation', 'Author', 'Account', 'Text', 'Files', 'Edited at', 'Deleted', 'Reply to', 'Message id', ...(history ? ['Earlier versions'] : [])],
            ...out.map((m) => [m.sentAt, m.conversation, m.author, m.account, m.text, m.files.join('; '), m.editedAt, m.deleted ? 'yes' : '', m.replyTo, m.id,
              ...(history ? [(m.history ?? []).map((h) => `[${h.at} ${h.change} by ${h.by}] ${h.text}`).join(' | ')] : [])]),
          ]), 'utf8');
        } else if (format === 'html') {
          mime = 'text/html';
          const body = out.map((m) => `<tr><td>${esc(m.sentAt.replace('T', ' ').slice(0, 19))}</td><td>${esc(m.conversation)}</td><td>${esc(m.author)}</td><td>${m.deleted ? '<i>deleted</i>' : esc(m.text).replace(/\n/g, '<br>')}${m.files.length ? `<div class="f">📎 ${esc(m.files.join(', '))}</div>` : ''}${(m.history ?? []).map((h) => `<div class="h">${esc(h.change)} by ${esc(h.by)} at ${esc(h.at)}: ${esc(h.text)}</div>`).join('')}</td></tr>`).join('\n');
          data = Buffer.from(`<!doctype html><meta charset="utf-8"><title>Dexterity Connect export ${stamp}</title><style>body{font:14px Segoe UI,system-ui,sans-serif;margin:24px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f2f6f6}.f,.h{color:#666;font-size:12px;margin-top:4px}</style><h1>Dexterity Connect export</h1><p>${out.length} messages · ${esc(new Date(from).toISOString().slice(0, 10))} to ${esc(new Date(to).toISOString().slice(0, 10))} · exported by ${esc(me.displayName)} on ${esc(new Date().toISOString())}</p><table><tr><th>Sent</th><th>Conversation</th><th>Author</th><th>Message</th></tr>${body}</table>`, 'utf8');
        } else {
          mime = 'application/json';
          data = Buffer.from(JSON.stringify({ exportedAt: new Date().toISOString(), exportedBy: me.account, from: new Date(from).toISOString(), to: new Date(to).toISOString(), messages: out }, null, 2), 'utf8');
        }
        const file = this.files.storeBuffer(me.id, `dexterity-connect-export-${stamp}.${format}`, mime, data);
        this.store.audit(me.id, 'compliance.export', null, { conversations: convIds.length, people: userIds.length, messages: out.length, format });
        return { file, messages: out.length } satisfies Ops['admin.compliance.export']['res'];
      }
    }
    return undefined;
  }
}
