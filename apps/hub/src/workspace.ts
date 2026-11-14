// Shared work beside the conversation: notes (personal, or shared in a conversation, saved
// with a version so a colleague's newer edit is never overwritten) and whiteboards (an
// append-only log of drawing operations, relayed live to everyone in the conversation).
import type { DatabaseSync } from 'node:sqlite';
import { ulid } from '@dex/core';
import type { Board, BoardOp, Note, NoteSummary, Ops, PublicUser } from '@dex/core';
import type { Messaging } from './messaging.ts';

export class WorkspaceError extends Error {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  conv_id TEXT,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_conv ON notes(conv_id);
CREATE INDEX IF NOT EXISTS idx_notes_owner ON notes(owner_id);
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  conv_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS board_ops (
  board_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  op TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (board_id, seq)
);
`;

interface NoteRow { id: string; conv_id: string | null; owner_id: string; title: string; body: string; version: number; updated_by: string; updated_at: number; created_at: number }
interface BoardRow { id: string; conv_id: string; title: string; created_by: string; created_at: number; updated_at: number }

const MAX_NOTE = 200_000;
const MAX_OPS = 20_000;
const MAX_POINTS = 4000;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

const preview = (body: string) => body.replace(/[#*_`>~\-[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);
const finite = (v: unknown, lo = -100_000, hi = 100_000): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new WorkspaceError('Bad drawing.');
  return Math.max(lo, Math.min(hi, Math.round(v * 10) / 10));
};

/** Check and normalise one drawing operation from a client. */
export function cleanOp(raw: unknown): BoardOp {
  const o = (raw ?? {}) as Record<string, unknown>;
  const id = typeof o.id === 'string' && /^[\w-]{1,40}$/.test(o.id) ? o.id : '';
  const color = typeof o.color === 'string' && COLOR_RE.test(o.color) ? o.color.toLowerCase() : '#1c7680';
  const width = typeof o.width === 'number' ? Math.max(1, Math.min(40, Math.round(o.width))) : 3;
  switch (o.t) {
    case 'stroke': {
      if (!id) throw new WorkspaceError('Bad drawing.');
      const pts = Array.isArray(o.points) ? o.points : [];
      if (pts.length < 2 || pts.length % 2 || pts.length > MAX_POINTS * 2) throw new WorkspaceError('Bad drawing.');
      return { t: 'stroke', id, color, width, points: pts.map((p) => finite(p)) };
    }
    case 'shape': {
      if (!id) throw new WorkspaceError('Bad drawing.');
      const shape = ['rect', 'ellipse', 'line', 'arrow'].includes(String(o.shape)) ? o.shape as 'rect' : 'rect';
      return { t: 'shape', id, shape, color, width, x1: finite(o.x1), y1: finite(o.y1), x2: finite(o.x2), y2: finite(o.y2) };
    }
    case 'text': {
      const text = typeof o.text === 'string' ? o.text.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').slice(0, 500) : '';
      if (!id || !text.trim()) throw new WorkspaceError('Bad drawing.');
      return { t: 'text', id, color, x: finite(o.x), y: finite(o.y), size: typeof o.size === 'number' ? Math.max(10, Math.min(96, Math.round(o.size))) : 18, text };
    }
    case 'erase': {
      const ids = Array.isArray(o.ids) ? o.ids.filter((x): x is string => typeof x === 'string' && /^[\w-]{1,40}$/.test(x)).slice(0, 500) : [];
      if (!ids.length) throw new WorkspaceError('Bad drawing.');
      return { t: 'erase', ids };
    }
    case 'clear':
      return { t: 'clear' };
  }
  throw new WorkspaceError('Bad drawing.');
}

export class Workspace {
  private readonly db: DatabaseSync;
  private readonly messaging: Messaging;
  private readonly deliver: (userIds: string[], name: string, data: (userId: string) => unknown) => void;

  constructor(db: DatabaseSync, messaging: Messaging, deliver: Workspace['deliver']) {
    this.db = db;
    this.messaging = messaging;
    this.deliver = deliver;
    db.exec(SCHEMA);
  }

  private summary(r: NoteRow): NoteSummary {
    return { id: r.id, convId: r.conv_id, ownerId: r.owner_id, title: r.title, preview: preview(r.body), version: r.version, updatedBy: r.updated_by, updatedAt: r.updated_at };
  }

  private note(id: unknown, me: PublicUser): NoteRow {
    const r = typeof id === 'string' ? this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined : undefined;
    if (!r || (r.conv_id ? !this.messaging.isMember(r.conv_id, me.id) : r.owner_id !== me.id)) throw new WorkspaceError('Note not found.');
    return r;
  }

  private audience(r: { conv_id: string | null; owner_id: string }): string[] {
    return r.conv_id ? this.messaging.members(r.conv_id) : [r.owner_id];
  }

  private boardView(r: BoardRow): Board {
    return { id: r.id, convId: r.conv_id, title: r.title, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at };
  }

  private board(id: unknown, me: PublicUser): BoardRow {
    const r = typeof id === 'string' ? this.db.prepare('SELECT * FROM boards WHERE id = ?').get(id) as BoardRow | undefined : undefined;
    if (!r || !this.messaging.isMember(r.conv_id, me.id)) throw new WorkspaceError('Whiteboard not found.');
    return r;
  }

  handle(op: string, me: PublicUser, d: Record<string, unknown>): unknown {
    const title = (v: unknown, fallback: string) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 120) : '') || fallback;
    if (me.role === 'bot') throw new WorkspaceError('Integrations cannot use notes or whiteboards.');

    switch (op) {
      case 'note.list': {
        const convId = typeof d.convId === 'string' ? d.convId : null;
        if (convId && !this.messaging.isMember(convId, me.id)) throw new WorkspaceError('Conversation not found.');
        const rows = (convId
          ? this.db.prepare('SELECT * FROM notes WHERE conv_id = ? ORDER BY updated_at DESC LIMIT 500').all(convId)
          : this.db.prepare('SELECT * FROM notes WHERE conv_id IS NULL AND owner_id = ? ORDER BY updated_at DESC LIMIT 500').all(me.id)) as unknown as NoteRow[];
        return rows.map((r) => this.summary(r)) satisfies Ops['note.list']['res'];
      }

      case 'note.get': {
        const r = this.note(d.id, me);
        return { ...this.summary(r), body: r.body } satisfies Note;
      }

      case 'note.save': {
        const body = typeof d.body === 'string' ? d.body.replace(/\r\n/g, '\n') : '';
        if (body.length > MAX_NOTE) throw new WorkspaceError('A note can be up to 200,000 characters.');
        const now = Date.now();
        let r: NoteRow;
        if (typeof d.id === 'string') {
          const cur = this.note(d.id, me);
          if (typeof d.baseVersion === 'number' && d.baseVersion !== cur.version) {
            throw new WorkspaceError(`CONFLICT: changed meanwhile (version ${cur.version}).`);
          }
          this.db.prepare('UPDATE notes SET title = ?, body = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?').run(title(d.title, cur.title), body, me.id, now, cur.id);
          r = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(cur.id) as unknown as NoteRow;
        } else {
          const convId = typeof d.convId === 'string' ? d.convId : null;
          if (convId && !this.messaging.isMember(convId, me.id)) throw new WorkspaceError('Conversation not found.');
          const n = (this.db.prepare('SELECT COUNT(*) AS n FROM notes WHERE owner_id = ?').get(me.id) as { n: number }).n;
          if (n >= 2000) throw new WorkspaceError('You have too many notes. Delete some first.');
          const id = ulid();
          this.db.prepare('INSERT INTO notes (id, conv_id, owner_id, title, body, version, updated_by, updated_at, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)')
            .run(id, convId, me.id, title(d.title, 'Untitled note'), body, me.id, now, now);
          r = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as unknown as NoteRow;
        }
        const full: Note = { ...this.summary(r), body: r.body };
        this.deliver(this.audience(r), 'note.updated', () => full);
        return full;
      }

      case 'note.delete': {
        const r = this.note(d.id, me);
        if (r.conv_id && r.owner_id !== me.id && me.role !== 'owner' && me.role !== 'admin') throw new WorkspaceError('Only the person who started this note can delete it.');
        this.db.prepare('DELETE FROM notes WHERE id = ?').run(r.id);
        this.deliver(this.audience(r), 'note.removed', () => ({ id: r.id }));
        return { ok: true };
      }

      case 'board.list': {
        const convId = String(d.convId);
        if (!this.messaging.isMember(convId, me.id)) throw new WorkspaceError('Conversation not found.');
        return (this.db.prepare('SELECT * FROM boards WHERE conv_id = ? ORDER BY updated_at DESC').all(convId) as unknown as BoardRow[]).map((r) => this.boardView(r)) satisfies Ops['board.list']['res'];
      }

      case 'board.create': {
        const convId = String(d.convId);
        if (!this.messaging.isMember(convId, me.id)) throw new WorkspaceError('Conversation not found.');
        const n = (this.db.prepare('SELECT COUNT(*) AS n FROM boards WHERE conv_id = ?').get(convId) as { n: number }).n;
        if (n >= 100) throw new WorkspaceError('This conversation already has 100 whiteboards.');
        const id = ulid();
        const now = Date.now();
        this.db.prepare('INSERT INTO boards (id, conv_id, title, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, convId, title(d.title, 'Whiteboard'), me.id, now, now);
        const b = this.boardView(this.db.prepare('SELECT * FROM boards WHERE id = ?').get(id) as unknown as BoardRow);
        this.deliver(this.messaging.members(convId), 'board.updated', () => b);
        return b;
      }

      case 'board.rename': {
        const r = this.board(d.boardId, me);
        this.db.prepare('UPDATE boards SET title = ? WHERE id = ?').run(title(d.title, r.title), r.id);
        const b = this.boardView(this.db.prepare('SELECT * FROM boards WHERE id = ?').get(r.id) as unknown as BoardRow);
        this.deliver(this.messaging.members(r.conv_id), 'board.updated', () => b);
        return b;
      }

      case 'board.delete': {
        const r = this.board(d.boardId, me);
        if (r.created_by !== me.id && me.role !== 'owner' && me.role !== 'admin') throw new WorkspaceError('Only the person who started this whiteboard can delete it.');
        this.db.prepare('DELETE FROM board_ops WHERE board_id = ?').run(r.id);
        this.db.prepare('DELETE FROM boards WHERE id = ?').run(r.id);
        this.deliver(this.messaging.members(r.conv_id), 'board.removed', () => ({ boardId: r.id }));
        return { ok: true };
      }

      case 'board.open': {
        const r = this.board(d.boardId, me);
        // everything since the last "clear"
        const lastClear = (this.db.prepare(`SELECT MAX(seq) AS s FROM board_ops WHERE board_id = ? AND op = '{"t":"clear"}'`).get(r.id) as { s: number | null }).s ?? 0;
        const ops = (this.db.prepare('SELECT seq, user_id, op FROM board_ops WHERE board_id = ? AND seq > ? ORDER BY seq').all(r.id, lastClear) as Array<{ seq: number; user_id: string; op: string }>)
          .map((o) => ({ seq: o.seq, userId: o.user_id, op: JSON.parse(o.op) as BoardOp }));
        return { board: this.boardView(r), ops } satisfies Ops['board.open']['res'];
      }

      case 'board.draw': {
        const r = this.board(d.boardId, me);
        const op = cleanOp(d.op);
        const last = (this.db.prepare('SELECT MAX(seq) AS s FROM board_ops WHERE board_id = ?').get(r.id) as { s: number | null }).s ?? 0;
        if (last >= MAX_OPS && op.t !== 'clear') throw new WorkspaceError('This whiteboard is full. Clear it or start a new one.');
        const seq = last + 1;
        const now = Date.now();
        this.db.prepare('INSERT INTO board_ops (board_id, seq, user_id, op, at) VALUES (?, ?, ?, ?, ?)').run(r.id, seq, me.id, JSON.stringify(op), now);
        // a clear lets the hub forget what came before
        if (op.t === 'clear') this.db.prepare('DELETE FROM board_ops WHERE board_id = ? AND seq < ?').run(r.id, seq);
        this.db.prepare('UPDATE boards SET updated_at = ? WHERE id = ?').run(now, r.id);
        this.deliver(this.messaging.members(r.conv_id).filter((u) => u !== me.id), 'board.op', () => ({ boardId: r.id, seq, userId: me.id, op }));
        return { seq };
      }
    }
    return undefined;
  }
}
