// References: dragging a message or file into another conversation posts a pointer to it, not a
// copy. Like a forward, the reference is a message with a `ref` (stored in messages.ref); unlike a
// forward, what it points at is worked out for each person as they look: the excerpt, the file and
// where it came from only for people who may open the source, and otherwise just that it exists
// and who wrote it. Files are never copied or shared further: opening one is checked by the file
// store against the conversations it was really shared in.
import type { DatabaseSync } from 'node:sqlite';
import { REF_BODY } from '@dex/core';
import type { MessageRef, Ops, PublicUser, RefTarget } from '@dex/core';
import type { FileStore } from './files.ts';
import type { Messaging, MsgRow } from './messaging.ts';

export class RefError extends Error {}

/** What is stored with a reference message. */
interface StoredRef { kind: 'message' | 'file'; convId?: string; messageId?: string; fileId?: string; authorId: string }

const ID = /^[0-9A-Za-z_-]{1,64}$/;

export function parseRef(raw: string | null | undefined): StoredRef | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Partial<StoredRef>;
    if (typeof r.authorId !== 'string') return null;
    if (r.kind === 'message' && typeof r.convId === 'string' && typeof r.messageId === 'string') return { kind: 'message', convId: r.convId, messageId: r.messageId, authorId: r.authorId };
    if (r.kind === 'file' && typeof r.fileId === 'string') return { kind: 'file', fileId: r.fileId, authorId: r.authorId };
    return null;
  } catch { return null; }
}

export class Refs {
  private readonly db: DatabaseSync;
  private readonly messaging: Messaging;
  private readonly files: FileStore;

  constructor(db: DatabaseSync, messaging: Messaging, files: FileStore) {
    this.db = db;
    this.messaging = messaging;
    this.files = files;
    messaging.viewExtras.push((r, viewer) => (r.ref && !r.deleted ? { ref: this.resolve(r, viewer) } : {}));
  }

  /** May this person open what the reference points at? */
  private canOpen(ref: StoredRef, userId: string | null): boolean {
    if (!userId) return false;
    if (ref.kind === 'file') return !!ref.fileId && !!this.files.info(ref.fileId) && this.files.canRead(userId, ref.fileId);
    return !!ref.convId && this.messaging.isMember(ref.convId, userId);
  }

  /** A reference as one person sees it. */
  resolve(r: Pick<MsgRow, 'ref'>, viewer: string | null): MessageRef | null {
    const ref = parseRef(r.ref);
    if (!ref) return null;
    if (!this.canOpen(ref, viewer)) return { kind: ref.kind, authorId: ref.authorId, access: false };
    if (ref.kind === 'file') {
      const file = this.files.info(ref.fileId!);
      return file ? { kind: 'file', authorId: ref.authorId, access: true, file } : { kind: 'file', authorId: ref.authorId, access: true, gone: true };
    }
    const c = this.db.prepare('SELECT kind, name FROM conversations WHERE id = ?').get(ref.convId!) as { kind: 'space' | 'direct'; name: string | null } | undefined;
    const src = this.messaging.row(ref.messageId!);
    const base: MessageRef = { kind: 'message', authorId: ref.authorId, access: true, convId: ref.convId, messageId: ref.messageId, convName: c?.kind === 'space' ? c.name : null, convKind: c?.kind ?? 'space' };
    if (!src || src.deleted || src.conv_id !== ref.convId) return { ...base, gone: true };
    return {
      ...base,
      message: {
        id: src.id, convId: src.conv_id, authorId: src.author_id, body: src.body, createdAt: src.created_at, editedAt: src.edited_at,
        parentId: src.parent_id, files: this.files.forMessage(src.id),
      },
    };
  }

  /** What a reference will point at, checked for the person making it. */
  private target(raw: unknown, me: PublicUser): StoredRef {
    const t = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (typeof t.fileId === 'string') {
      if (!ID.test(t.fileId)) throw new RefError('File not found.');
      const f = this.files.info(t.fileId);
      if (!f || !this.files.canRead(me.id, t.fileId)) throw new RefError('File not found.');
      return { kind: 'file', fileId: f.id, authorId: f.uploaderId };
    }
    if (typeof t.messageId === 'string' && typeof t.convId === 'string') {
      const src = this.messaging.row(t.messageId);
      if (!src || src.deleted || src.system || src.conv_id !== t.convId || !this.messaging.isMember(src.conv_id, me.id)) throw new RefError('Message not found.');
      // a reference to a reference points at the original (and only for someone who may open it)
      const inner = parseRef(src.ref);
      if (inner) {
        if (!this.canOpen(inner, me.id)) throw new RefError('You cannot reference something you cannot open yourself.');
        return inner;
      }
      return { kind: 'message', convId: src.conv_id, messageId: src.id, authorId: src.author_id };
    }
    throw new RefError('Choose a message or a file to reference.');
  }

  handle(op: string, me: PublicUser, d: Record<string, unknown>): unknown {
    switch (op) {
      case 'refs.send': {
        let conv;
        try { conv = this.messaging.memberConv(String(d.convId ?? ''), me.id); } catch { throw new RefError('Conversation not found.'); }
        const ref = this.target(d.target, me);
        if (ref.kind === 'message' && ref.convId === conv.id) throw new RefError('That message is already in this conversation.');
        const msg = this.messaging.sendAs(me, conv, REF_BODY, d.parentId, [], d.clientId, { ref: JSON.stringify(ref), skipFileCheck: true });
        return msg satisfies Ops['refs.send']['res'];
      }
      case 'refs.check': {
        let conv;
        try { conv = this.messaging.memberConv(String(d.convId ?? ''), me.id); } catch { throw new RefError('Conversation not found.'); }
        const ref = this.target(d.target, me);
        const bots = new Set((this.db.prepare(`SELECT id FROM users WHERE role = 'bot'`).all() as Array<{ id: string }>).map((u) => u.id));
        const people = this.messaging.members(conv.id).filter((u) => u !== me.id && !bots.has(u));
        // only a count: who is in which other conversation is not this person's business
        const without = people.filter((u) => !this.canOpen(ref, u)).length;
        return { members: people.length, without } satisfies Ops['refs.check']['res'];
      }
      case 'refs.resolve': {
        const row = typeof d.messageId === 'string' ? this.messaging.row(d.messageId) : undefined;
        if (!row || row.deleted || !this.messaging.isMember(row.conv_id, me.id)) throw new RefError('Message not found.');
        const view = this.resolve(row, me.id);
        if (!view) throw new RefError('That message is not a reference.');
        return view satisfies Ops['refs.resolve']['res'];
      }
    }
    return undefined;
  }
}
