// Spaces, Direct conversations, messages, side-tracks, reactions, pins, read state and
// typing, stored on the hub (SQLite). Every operation is authorised by membership.
import type { DatabaseSync } from 'node:sqlite';
import { MENTION_RE, ulid } from '@dex/core';
import type { Conversation, FormField, FormView, Message, MessagePreview, Ops, PollView, PublicUser } from '@dex/core';
import type { FileStore } from './files.ts';

export class MsgError extends Error {}

const cleanBody = (v: unknown) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim() : '');

function parseForward(raw: string): Message['forwardedFrom'] {
  try {
    const f = JSON.parse(raw) as NonNullable<Message['forwardedFrom']>;
    return typeof f.authorId === 'string' ? f : null;
  } catch { return null; }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT,
  topic TEXT,
  private INTEGER NOT NULL DEFAULT 0,
  everyone INTEGER NOT NULL DEFAULT 0,
  direct_key TEXT UNIQUE,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conv_members (
  conv_id TEXT NOT NULL REFERENCES conversations(id),
  user_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  last_read_id TEXT,
  muted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conv_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_conv_members_user ON conv_members(user_id);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conv_id TEXT NOT NULL REFERENCES conversations(id),
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  parent_id TEXT,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  client_id TEXT,
  UNIQUE (author_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, parent_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id, id);
CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE TABLE IF NOT EXISTS mentions (
  message_id TEXT NOT NULL,
  conv_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_mentions_user ON mentions(user_id, conv_id, message_id);
CREATE TABLE IF NOT EXISTS polls (
  message_id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  options TEXT NOT NULL,
  multi INTEGER NOT NULL DEFAULT 0,
  anonymous INTEGER NOT NULL DEFAULT 0,
  closes_at INTEGER,
  closed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS poll_votes (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  option INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, option)
);
CREATE TABLE IF NOT EXISTS forms (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  fields TEXT NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS form_responses (
  form_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  answers TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (form_id, user_id)
);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(body, message_id UNINDEXED, conv_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
`;

interface ConvRow { id: string; kind: 'space' | 'direct'; name: string | null; topic: string | null; private: number; everyone: number; created_by: string; created_at: number }
export interface MsgRow { id: string; conv_id: string; author_id: string; body: string; parent_id: string | null; created_at: number; edited_at: number | null; deleted: number; pinned: number; client_id: string | null; forwarded: string | null }

const MAX_BODY = 8000;
const EMOJI_RE = /^[\p{Extended_Pictographic}\p{Emoji_Component}‍️]{1,16}$/u;

export class Messaging {
  private readonly db: DatabaseSync;
  /** Delivers an event to a set of users (all their connected devices). */
  private readonly deliver: (userIds: string[], name: string, data: (userId: string) => unknown) => void;
  private readonly users: () => PublicUser[];
  private readonly files: FileStore;
  /** Called before a message is edited or deleted (compliance keeps earlier versions). */
  beforeChange: ((msg: MsgRow, change: 'edit' | 'delete', actorId: string) => void) | null = null;

  constructor(db: DatabaseSync, deliver: Messaging['deliver'], users: () => PublicUser[], files: FileStore) {
    this.db = db;
    this.deliver = deliver;
    this.users = users;
    this.files = files;
    db.exec(SCHEMA);
    // hubs from before forwarding existed
    const cols = (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes('forwarded')) db.exec('ALTER TABLE messages ADD COLUMN forwarded TEXT');
    // hubs upgraded from a version without search: index what is already there
    const indexed = (db.prepare('SELECT COUNT(*) AS n FROM messages_fts').get() as { n: number }).n;
    if (!indexed) {
      for (const r of db.prepare('SELECT id, conv_id, body FROM messages WHERE deleted = 0').all() as Array<{ id: string; conv_id: string; body: string }>) this.index(r.id, r.conv_id, r.body);
    }
  }

  /** Searchable text: mentions become names so "@priya" and "priya" both find the message. */
  private index(messageId: string, convId: string, body: string): void {
    this.db.prepare('DELETE FROM messages_fts WHERE message_id = ?').run(messageId);
    if (!body) return;
    const names = new Map(this.users().map((u) => [u.id, u.displayName] as const));
    const text = body.replace(/<@all>/g, '@everyone').replace(/<@([0-9A-Z]{26})>/g, (_, id: string) => `@${names.get(id) ?? ''}`);
    this.db.prepare('INSERT INTO messages_fts (body, message_id, conv_id) VALUES (?, ?, ?)').run(text, messageId, convId);
  }

  // ------------------------------------------------------------ helpers
  private conv(id: string): ConvRow | undefined {
    return this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConvRow | undefined;
  }

  members(convId: string): string[] {
    return (this.db.prepare('SELECT user_id FROM conv_members WHERE conv_id = ? ORDER BY joined_at').all(convId) as Array<{ user_id: string }>).map((r) => r.user_id);
  }

  isMember(convId: string, userId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM conv_members WHERE conv_id = ? AND user_id = ?').get(convId, userId);
  }

  private requireMember(convId: string, userId: string): ConvRow {
    const c = this.conv(convId);
    if (!c || !this.isMember(convId, userId)) throw new MsgError('Conversation not found.');
    return c;
  }

  private addMember(convId: string, userId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO conv_members (conv_id, user_id, joined_at) VALUES (?, ?, ?)').run(convId, userId, Date.now());
  }

  private preview(convId: string): MessagePreview | null {
    const r = this.db.prepare('SELECT id, author_id, body, created_at, deleted FROM messages WHERE conv_id = ? AND parent_id IS NULL ORDER BY id DESC LIMIT 1')
      .get(convId) as { id: string; author_id: string; body: string; created_at: number; deleted: number } | undefined;
    if (!r) return null;
    let body = r.deleted ? '' : r.body.slice(0, 280);
    if (!r.deleted && this.db.prepare('SELECT 1 FROM polls WHERE message_id = ?').get(r.id)) body = `📊 ${body}`;
    if (!r.deleted && !body) {
      const names = this.files.forMessage(r.id).map((f) => f.name);
      body = names.length ? `📎 ${names.length === 1 ? names[0] : `${names.length} files`}` : '';
    }
    return { id: r.id, authorId: r.author_id, body, createdAt: r.created_at };
  }

  view(c: ConvRow, viewer: string): Conversation {
    const m = this.db.prepare('SELECT last_read_id, muted FROM conv_members WHERE conv_id = ? AND user_id = ?').get(c.id, viewer) as { last_read_id: string | null; muted: number } | undefined;
    const lastRead = m?.last_read_id ?? '';
    const unread = m ? (this.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE conv_id = ? AND parent_id IS NULL AND deleted = 0 AND author_id != ? AND id > ?`)
      .get(c.id, viewer, lastRead) as { n: number }).n : 0;
    const mentions = m ? (this.db.prepare(`SELECT COUNT(*) AS n FROM mentions mn JOIN messages ms ON ms.id = mn.message_id
      WHERE mn.conv_id = ? AND mn.user_id = ? AND ms.deleted = 0 AND ms.author_id != ? AND mn.message_id > ?`).get(c.id, viewer, viewer, lastRead) as { n: number }).n : 0;
    return {
      id: c.id, kind: c.kind, name: c.name, topic: c.topic, private: !!c.private, everyone: !!c.everyone,
      createdBy: c.created_by, createdAt: c.created_at, members: this.members(c.id), lastMessage: this.preview(c.id),
      joined: !!m, unread, mentions, lastReadId: m?.last_read_id ?? null, muted: !!m?.muted,
      reads: Object.fromEntries((this.db.prepare('SELECT user_id, last_read_id FROM conv_members WHERE conv_id = ?').all(c.id) as Array<{ user_id: string; last_read_id: string | null }>).map((r) => [r.user_id, r.last_read_id])),
    };
  }

  private pollView(messageId: string, viewer: string | null): PollView | null {
    const p = this.db.prepare('SELECT * FROM polls WHERE message_id = ?').get(messageId) as { question: string; options: string; multi: number; anonymous: number; closes_at: number | null; closed: number } | undefined;
    if (!p) return null;
    let texts: string[] = [];
    try { texts = JSON.parse(p.options) as string[]; } catch { /* corrupt row: show no options */ }
    const votes = this.db.prepare('SELECT user_id, option FROM poll_votes WHERE message_id = ? ORDER BY rowid').all(messageId) as Array<{ user_id: string; option: number }>;
    const options = texts.map((text) => ({ text, votes: 0, voters: [] as string[] }));
    const people = new Set<string>();
    const mine: number[] = [];
    for (const v of votes) {
      const o = options[v.option];
      if (!o) continue;
      o.votes++;
      people.add(v.user_id);
      if (!p.anonymous) o.voters.push(v.user_id);
      if (v.user_id === viewer) mine.push(v.option);
    }
    const closed = !!p.closed || (p.closes_at !== null && p.closes_at <= Date.now());
    return { question: p.question, options, multi: !!p.multi, anonymous: !!p.anonymous, closed, closesAt: p.closes_at, voterCount: people.size, mine };
  }

  private formView(messageId: string, viewer: string | null): FormView | null {
    const f = this.db.prepare('SELECT * FROM forms WHERE message_id = ?').get(messageId) as { id: string; title: string; description: string | null; fields: string; closed: number } | undefined;
    if (!f) return null;
    let fields: FormField[] = [];
    try { fields = JSON.parse(f.fields) as FormField[]; } catch { /* corrupt row */ }
    const n = (this.db.prepare('SELECT COUNT(*) AS n FROM form_responses WHERE form_id = ?').get(f.id) as { n: number }).n;
    const mine = viewer ? this.db.prepare('SELECT answers FROM form_responses WHERE form_id = ? AND user_id = ?').get(f.id, viewer) as { answers: string } | undefined : undefined;
    let answers: Record<string, string | string[]> | null = null;
    if (mine) { try { answers = JSON.parse(mine.answers) as Record<string, string | string[]>; } catch { answers = {}; } }
    return { id: f.id, title: f.title, description: f.description, fields, closed: !!f.closed, responses: n, mine: answers };
  }

  /** A message as a given person sees it (null when they cannot). */
  messageFor(id: string, viewer: string): Message | null {
    const r = this.message(id);
    if (!r || !this.isMember(r.conv_id, viewer)) return null;
    return this.messageView(r, viewer);
  }

  private messageView(r: MsgRow, viewer: string | null = null): Message {
    const reactions: Record<string, string[]> = {};
    for (const x of this.db.prepare('SELECT emoji, user_id FROM reactions WHERE message_id = ? ORDER BY created_at').all(r.id) as Array<{ emoji: string; user_id: string }>) {
      (reactions[x.emoji] ??= []).push(x.user_id);
    }
    const replies = r.parent_id ? null : this.db.prepare('SELECT COUNT(*) AS n, MAX(created_at) AS last FROM messages WHERE parent_id = ? AND deleted = 0').get(r.id) as { n: number; last: number | null };
    const mentions = (this.db.prepare('SELECT user_id FROM mentions WHERE message_id = ?').all(r.id) as Array<{ user_id: string }>).map((x) => x.user_id);
    return {
      id: r.id, convId: r.conv_id, authorId: r.author_id, body: r.deleted ? '' : r.body, parentId: r.parent_id,
      createdAt: r.created_at, editedAt: r.edited_at, deleted: !!r.deleted, pinned: !!r.pinned, reactions,
      mentions: r.body.includes('<@all>') && !r.deleted ? ['all', ...mentions] : mentions,
      replyCount: replies?.n ?? 0, lastReplyAt: replies?.last ?? null, clientId: r.client_id,
      files: r.deleted ? [] : this.files.forMessage(r.id),
      forwardedFrom: r.forwarded && !r.deleted ? parseForward(r.forwarded) : null,
      poll: r.deleted ? null : this.pollView(r.id, viewer),
      form: r.deleted ? null : this.formView(r.id, viewer),
    };
  }

  /** Find the conversation for a message the viewer can see. */
  private visibleMessage(id: unknown, viewer: string): MsgRow {
    const msg = typeof id === 'string' ? this.message(id) : undefined;
    if (!msg || msg.deleted || !this.isMember(msg.conv_id, viewer)) throw new MsgError('Message not found.');
    return msg;
  }

  private message(id: string): MsgRow | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MsgRow | undefined;
  }

  /** Push every member their own copy of the conversation (unread counts differ per person). */
  private pushConv(convId: string, to?: string[]): void {
    const c = this.conv(convId);
    if (!c) return;
    this.deliver(to ?? this.members(convId), 'conv.updated', (uid) => this.view(c, uid));
  }

  private pushMessage(name: 'msg.new' | 'msg.updated', msg: MsgRow): void {
    const view = this.messageView(msg);
    const members = this.members(msg.conv_id);
    // polls carry each person's own vote
    this.deliver(members, name, view.poll || view.form ? (uid) => this.messageView(msg, uid) : () => view);
    // a reply also changes the parent's reply count
    if (msg.parent_id) {
      const parent = this.message(msg.parent_id);
      if (parent) { const pv = this.messageView(parent); this.deliver(members, 'msg.updated', () => pv); }
    }
  }

  /** For integrations: an open or private Space by name. */
  spaceByName(name: string): string | null {
    const r = this.db.prepare(`SELECT id FROM conversations WHERE kind = 'space' AND name = ? COLLATE NOCASE`).get(name) as { id: string } | undefined;
    return r?.id ?? null;
  }

  ensureMember(convId: string, userId: string): void {
    if (!this.isMember(convId, userId)) { this.addMember(convId, userId); this.pushConv(convId); }
  }

  // ------------------------------------------------------------ lifecycle
  /** The office-wide space: created once, everyone approved is a member. */
  ensureEveryoneSpace(ownerId: string): string {
    const row = this.db.prepare('SELECT id FROM conversations WHERE everyone = 1').get() as { id: string } | undefined;
    if (row) return row.id;
    const id = ulid();
    this.db.prepare(`INSERT INTO conversations (id, kind, name, topic, private, everyone, created_by, created_at)
      VALUES (?, 'space', 'Office', 'Everyone at Dexterity. Announcements and office-wide news.', 0, 1, ?, ?)`).run(id, ownerId, Date.now());
    return id;
  }

  /** Called when a person's first device is approved. */
  welcome(userId: string): void {
    // guests never join the office-wide space
    if (this.users().find((u) => u.id === userId)?.role === 'guest') return;
    const everyone = this.db.prepare('SELECT id FROM conversations WHERE everyone = 1').get() as { id: string } | undefined;
    if (!everyone) return;
    this.addMember(everyone.id, userId);
    this.pushConv(everyone.id);
  }

  // ------------------------------------------------------------ operations
  handle(op: string, me: PublicUser, d: Record<string, unknown>): unknown {
    const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : '');
    const isAdmin = me.role === 'owner' || me.role === 'admin';
    const knownUser = (id: unknown) => typeof id === 'string' && this.users().some((u) => u.id === id);

    switch (op) {
      case 'conv.list': {
        const rows = this.db.prepare(`SELECT c.* FROM conversations c JOIN conv_members m ON m.conv_id = c.id WHERE m.user_id = ?`).all(me.id) as unknown as ConvRow[];
        return rows.map((c) => this.view(c, me.id)) satisfies Ops['conv.list']['res'];
      }

      case 'conv.browse': {
        if (me.role === 'guest') return [];
        const rows = this.db.prepare(`SELECT * FROM conversations c WHERE c.kind = 'space' AND c.private = 0
          AND NOT EXISTS (SELECT 1 FROM conv_members m WHERE m.conv_id = c.id AND m.user_id = ?) ORDER BY c.name COLLATE NOCASE`).all(me.id) as unknown as ConvRow[];
        return rows.map((c) => this.view(c, me.id));
      }

      case 'conv.create': {
        const others = Array.isArray(d.members) ? [...new Set(d.members.filter(knownUser) as string[])].filter((x) => x !== me.id) : [];
        if (me.role === 'guest') {
          // guests can message people they already share a Space with, but not create Spaces
          if (d.kind !== 'direct') throw new MsgError('Guests cannot create Spaces.');
          const shared = new Set((this.db.prepare('SELECT DISTINCT b.user_id FROM conv_members a JOIN conv_members b ON a.conv_id = b.conv_id WHERE a.user_id = ?').all(me.id) as Array<{ user_id: string }>).map((r) => r.user_id));
          if (others.some((u) => !shared.has(u))) throw new MsgError('Guests can message people from their Spaces only.');
        }
        if (d.kind === 'direct') {
          if (!others.length) throw new MsgError('Choose at least one person.');
          if (others.length > 49) throw new MsgError('A Direct conversation can have up to 50 people. Create a Space instead.');
          const key = [me.id, ...others].sort().join(',');
          const existing = this.db.prepare('SELECT * FROM conversations WHERE direct_key = ?').get(key) as ConvRow | undefined;
          if (existing) return this.view(existing, me.id);
          const id = ulid();
          this.db.prepare(`INSERT INTO conversations (id, kind, private, direct_key, created_by, created_at) VALUES (?, 'direct', 1, ?, ?, ?)`).run(id, key, me.id, Date.now());
          for (const u of [me.id, ...others]) this.addMember(id, u);
          this.pushConv(id);
          return this.view(this.conv(id)!, me.id);
        }
        const name = str(d.name, 60);
        if (!name) throw new MsgError('Give the Space a name.');
        const taken = this.db.prepare(`SELECT 1 FROM conversations WHERE kind = 'space' AND name = ? COLLATE NOCASE`).get(name);
        if (taken) throw new MsgError('A Space with that name already exists.');
        const id = ulid();
        this.db.prepare(`INSERT INTO conversations (id, kind, name, topic, private, created_by, created_at) VALUES (?, 'space', ?, ?, ?, ?, ?)`)
          .run(id, name, str(d.topic, 240) || null, d.private === true ? 1 : 0, me.id, Date.now());
        for (const u of [me.id, ...others]) this.addMember(id, u);
        this.pushConv(id);
        return this.view(this.conv(id)!, me.id);
      }

      case 'conv.join': {
        if (me.role === 'guest') throw new MsgError('Guests can only use the Spaces they were invited to.');
        const c = typeof d.convId === 'string' ? this.conv(d.convId) : undefined;
        if (!c || c.kind !== 'space' || (c.private && !this.isMember(c.id, me.id))) throw new MsgError('Space not found.');
        this.addMember(c.id, me.id);
        this.pushConv(c.id);
        return this.view(c, me.id);
      }

      case 'conv.leave': {
        const c = this.requireMember(String(d.convId), me.id);
        if (c.everyone) throw new MsgError('Everyone stays in the Office space.');
        if (c.kind === 'direct' && this.members(c.id).length <= 2) throw new MsgError('You can mute a Direct conversation, but not leave it.');
        const before = this.members(c.id);
        this.db.prepare('DELETE FROM conv_members WHERE conv_id = ? AND user_id = ?').run(c.id, me.id);
        this.deliver([me.id], 'conv.removed', () => ({ convId: c.id }));
        this.pushConv(c.id, before.filter((u) => u !== me.id));
        return { ok: true };
      }

      case 'conv.addMembers': {
        const c = this.requireMember(String(d.convId), me.id);
        if (c.everyone) throw new MsgError('Everyone is already in the Office space.');
        if (me.role === 'guest') throw new MsgError('Guests cannot add people.');
        if (c.kind === 'direct') throw new MsgError('Start a new Direct conversation or a Space to include more people.');
        const ids = Array.isArray(d.userIds) ? (d.userIds.filter(knownUser) as string[]) : [];
        for (const u of ids) this.addMember(c.id, u);
        this.pushConv(c.id);
        return this.view(c, me.id);
      }

      case 'conv.update': {
        const c = this.requireMember(String(d.convId), me.id);
        if (c.kind !== 'space') throw new MsgError('Only Spaces have a name and topic.');
        if (c.created_by !== me.id && !isAdmin) throw new MsgError('Only the person who created this Space or an administrator can change it.');
        const name = d.name !== undefined ? str(d.name, 60) : c.name;
        if (!name) throw new MsgError('A Space needs a name.');
        const topic = d.topic === undefined ? c.topic : d.topic === null ? null : str(d.topic, 240) || null;
        this.db.prepare('UPDATE conversations SET name = ?, topic = ? WHERE id = ?').run(name, topic, c.id);
        this.pushConv(c.id);
        return this.view(this.conv(c.id)!, me.id);
      }

      case 'conv.read': {
        const c = this.requireMember(String(d.convId), me.id);
        const msg = typeof d.messageId === 'string' ? this.message(d.messageId) : undefined;
        if (!msg || msg.conv_id !== c.id) throw new MsgError('Message not found.');
        const cur = (this.db.prepare('SELECT last_read_id FROM conv_members WHERE conv_id = ? AND user_id = ?').get(c.id, me.id) as { last_read_id: string | null }).last_read_id;
        if (!cur || msg.id > cur) {
          this.db.prepare('UPDATE conv_members SET last_read_id = ? WHERE conv_id = ? AND user_id = ?').run(msg.id, c.id, me.id);
          // read receipts for everyone, refreshed unread counts for the reader's other devices
          this.deliver(this.members(c.id), 'read', () => ({ convId: c.id, userId: me.id, messageId: msg.id }));
          this.pushConv(c.id, [me.id]);
        }
        return this.view(c, me.id);
      }

      case 'conv.mute': {
        const c = this.requireMember(String(d.convId), me.id);
        this.db.prepare('UPDATE conv_members SET muted = ? WHERE conv_id = ? AND user_id = ?').run(d.muted === true ? 1 : 0, c.id, me.id);
        this.pushConv(c.id, [me.id]);
        return this.view(c, me.id);
      }

      case 'msg.list': {
        const c = this.requireMember(String(d.convId), me.id);
        const limit = typeof d.limit === 'number' ? Math.max(1, Math.min(200, Math.floor(d.limit))) : 60;
        const before = typeof d.before === 'string' ? d.before : '~';
        const parent = typeof d.parentId === 'string' ? d.parentId : null;
        const rows = (parent
          ? this.db.prepare('SELECT * FROM messages WHERE conv_id = ? AND parent_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(c.id, parent, before, limit + 1)
          : this.db.prepare('SELECT * FROM messages WHERE conv_id = ? AND parent_id IS NULL AND id < ? ORDER BY id DESC LIMIT ?').all(c.id, before, limit + 1)) as unknown as MsgRow[];
        const hasMore = rows.length > limit;
        return { messages: rows.slice(0, limit).reverse().map((r) => this.messageView(r, me.id)), hasMore } satisfies Ops['msg.list']['res'];
      }

      case 'file.list': {
        const c = this.requireMember(String(d.convId), me.id);
        const limit = typeof d.limit === 'number' ? Math.max(1, Math.min(200, Math.floor(d.limit))) : 100;
        return this.files.inConversation(c.id, typeof d.before === 'string' ? d.before : '~', limit);
      }

      case 'msg.pins': {
        const c = this.requireMember(String(d.convId), me.id);
        return (this.db.prepare('SELECT * FROM messages WHERE conv_id = ? AND pinned = 1 AND deleted = 0 ORDER BY id DESC LIMIT 50').all(c.id) as unknown as MsgRow[]).map((r) => this.messageView(r, me.id));
      }

      case 'msg.send': {
        const c = this.requireMember(String(d.convId), me.id);
        const fileIds = Array.isArray(d.files) ? [...new Set(d.files.filter((f): f is string => typeof f === 'string'))].slice(0, 21) : [];
        return this.sendAs(me, c, cleanBody(d.body), d.parentId, fileIds, d.clientId, {});
      }

      case 'msg.forward': {
        const src = this.visibleMessage(d.messageId, me.id);
        const targets = Array.isArray(d.convIds) ? [...new Set(d.convIds.filter((x): x is string => typeof x === 'string'))] : [];
        if (!targets.length) throw new MsgError('Choose where to forward it.');
        if (targets.length > 10) throw new MsgError('Forward to up to 10 conversations at a time.');
        const convs = targets.map((id) => this.requireMember(id, me.id));
        const note = cleanBody(d.note);
        const files = this.files.forMessage(src.id).map((f) => f.id);
        const forwarded = JSON.stringify({ authorId: src.forwarded ? (parseForward(src.forwarded)?.authorId ?? src.author_id) : src.author_id, convId: src.conv_id, messageId: src.id, createdAt: src.created_at });
        const stamp = `${Date.now().toString(36)}-${src.id}`;
        const out: Message[] = [];
        for (const c of convs) {
          if (note) this.sendAs(me, c, note, undefined, [], `fwdnote-${stamp}-${c.id}`, {});
          const poll = this.db.prepare('SELECT 1 FROM polls WHERE message_id = ?').get(src.id);
          out.push(this.sendAs(me, c, poll ? `📊 ${src.body}` : src.body, undefined, files, `fwd-${stamp}-${c.id}`, { forwarded, skipFileCheck: true }));
        }
        return out satisfies Ops['msg.forward']['res'];
      }

      case 'poll.create': {
        const c = this.requireMember(String(d.convId), me.id);
        const question = str(d.question, 300);
        if (!question) throw new MsgError('Ask a question.');
        const options = Array.isArray(d.options) ? d.options.map((o) => str(o, 120)).filter(Boolean) : [];
        if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) throw new MsgError('Each choice must be different.');
        if (options.length < 2) throw new MsgError('A poll needs at least two choices.');
        if (options.length > 10) throw new MsgError('A poll can have up to 10 choices.');
        const closesAt = typeof d.closesAt === 'number' && Number.isFinite(d.closesAt) ? Math.floor(d.closesAt) : null;
        if (closesAt !== null && closesAt <= Date.now()) throw new MsgError('The closing time has already passed.');
        return this.sendAs(me, c, question, d.parentId, [], d.clientId, { poll: { options, multi: d.multi === true, anonymous: d.anonymous === true, closesAt } });
      }

      case 'poll.vote': {
        const msg = this.visibleMessage(d.messageId, me.id);
        const poll = this.pollView(msg.id, me.id);
        if (!poll) throw new MsgError('That message is not a poll.');
        if (poll.closed) throw new MsgError('This poll has closed.');
        const picks = Array.isArray(d.options) ? [...new Set(d.options.filter((o): o is number => Number.isInteger(o) && o >= 0 && o < poll.options.length))] : [];
        if (!poll.multi && picks.length > 1) throw new MsgError('Choose one option.');
        this.db.prepare('DELETE FROM poll_votes WHERE message_id = ? AND user_id = ?').run(msg.id, me.id);
        const ins = this.db.prepare('INSERT INTO poll_votes (message_id, user_id, option) VALUES (?, ?, ?)');
        for (const o of picks) ins.run(msg.id, me.id, o);
        this.pushMessage('msg.updated', msg);
        return this.messageView(msg, me.id);
      }

      case 'poll.close': {
        const msg = this.visibleMessage(d.messageId, me.id);
        if (!this.db.prepare('SELECT 1 FROM polls WHERE message_id = ?').get(msg.id)) throw new MsgError('That message is not a poll.');
        if (msg.author_id !== me.id && !isAdmin) throw new MsgError('Only the person who asked can close this poll.');
        this.db.prepare('UPDATE polls SET closed = 1 WHERE message_id = ?').run(msg.id);
        this.pushMessage('msg.updated', msg);
        return this.messageView(msg, me.id);
      }

      case 'form.create': {
        const c = this.requireMember(String(d.convId), me.id);
        if (me.role === 'guest') throw new MsgError('Guests cannot create forms.');
        const title = str(d.title, 140);
        if (!title) throw new MsgError('Give the form a title.');
        const raw = Array.isArray(d.fields) ? d.fields as Array<Record<string, unknown>> : [];
        if (!raw.length) throw new MsgError('Add at least one question.');
        if (raw.length > 30) throw new MsgError('A form can have up to 30 questions.');
        const types = ['text', 'long', 'choice', 'multi', 'number', 'date'];
        const fields: FormField[] = raw.map((f, i) => {
          const label = str(f.label, 200);
          if (!label) throw new MsgError(`Question ${i + 1} needs a label.`);
          const type = types.includes(String(f.type)) ? f.type as FormField['type'] : 'text';
          const options = type === 'choice' || type === 'multi' ? (Array.isArray(f.options) ? f.options.map((o) => str(o, 120)).filter(Boolean) : []) : undefined;
          if (options && options.length < 2) throw new MsgError(`"${label}" needs at least two choices.`);
          return { id: `q${i + 1}`, label, type, ...(options ? { options: options.slice(0, 20) } : {}), required: f.required === true };
        });
        const description = str(d.description, 1000) || null;
        const msg = this.sendAs(me, c, `📝 ${title}`, undefined, [], d.clientId, {});
        const formId = ulid();
        this.db.prepare('INSERT INTO forms (id, message_id, title, description, fields) VALUES (?, ?, ?, ?, ?)').run(formId, msg.id, title, description, JSON.stringify(fields));
        const row = this.message(msg.id)!;
        this.pushMessage('msg.updated', row);
        return this.messageView(row, me.id);
      }

      case 'form.respond': {
        const f = typeof d.formId === 'string' ? this.db.prepare('SELECT * FROM forms WHERE id = ?').get(d.formId) as { id: string; message_id: string; closed: number; fields: string } | undefined : undefined;
        const msg = f ? this.visibleMessage(f.message_id, me.id) : null;
        if (!f || !msg) throw new MsgError('Form not found.');
        if (f.closed) throw new MsgError('This form is closed.');
        const fields = JSON.parse(f.fields) as FormField[];
        const given = d.answers && typeof d.answers === 'object' ? d.answers as Record<string, unknown> : {};
        const answers: Record<string, string | string[]> = {};
        for (const q of fields) {
          const v = given[q.id];
          if (q.type === 'multi') {
            const picks = Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && (q.options ?? []).includes(x)))] : [];
            if (picks.length) answers[q.id] = picks;
          } else {
            let t = typeof v === 'string' ? v.trim().slice(0, q.type === 'long' ? 4000 : 500) : '';
            if (t && q.type === 'choice' && !(q.options ?? []).includes(t)) throw new MsgError(`Choose one of the options for "${q.label}".`);
            if (t && q.type === 'number' && !/^-?\d+(\.\d+)?$/.test(t)) throw new MsgError(`"${q.label}" needs a number.`);
            if (t && q.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new MsgError(`"${q.label}" needs a date.`);
            if (q.type === 'number' && t) t = String(Number(t));
            if (t) answers[q.id] = t;
          }
          if (q.required && answers[q.id] === undefined) throw new MsgError(`"${q.label}" is required.`);
        }
        this.db.prepare('INSERT INTO form_responses (form_id, user_id, answers, at) VALUES (?, ?, ?, ?) ON CONFLICT(form_id, user_id) DO UPDATE SET answers = excluded.answers, at = excluded.at')
          .run(f.id, me.id, JSON.stringify(answers), Date.now());
        this.pushMessage('msg.updated', msg);
        return this.messageView(msg, me.id);
      }

      case 'form.responses':
      case 'form.close': {
        const f = typeof d.formId === 'string' ? this.db.prepare('SELECT * FROM forms WHERE id = ?').get(d.formId) as { id: string; message_id: string } | undefined : undefined;
        const msg = f ? this.visibleMessage(f.message_id, me.id) : null;
        if (!f || !msg) throw new MsgError('Form not found.');
        if (msg.author_id !== me.id && !isAdmin) throw new MsgError('Only the person who created the form can see the answers.');
        if (op === 'form.close') {
          this.db.prepare('UPDATE forms SET closed = 1 WHERE id = ?').run(f.id);
          this.pushMessage('msg.updated', msg);
          return this.messageView(msg, me.id);
        }
        const responses = (this.db.prepare('SELECT user_id, answers, at FROM form_responses WHERE form_id = ? ORDER BY at').all(f.id) as Array<{ user_id: string; answers: string; at: number }>)
          .map((r) => { let answers: Record<string, string | string[]> = {}; try { answers = JSON.parse(r.answers); } catch { /* skip */ } return { userId: r.user_id, answers, at: r.at }; });
        return { form: this.formView(msg.id, me.id)!, responses } satisfies Ops['form.responses']['res'];
      }

      case 'conv.markUnread': {
        const c = this.requireMember(String(d.convId), me.id);
        const msg = typeof d.messageId === 'string' ? this.message(d.messageId) : undefined;
        if (!msg || msg.conv_id !== c.id || msg.parent_id) throw new MsgError('Message not found.');
        const prev = this.db.prepare('SELECT id FROM messages WHERE conv_id = ? AND parent_id IS NULL AND id < ? ORDER BY id DESC LIMIT 1').get(c.id, msg.id) as { id: string } | undefined;
        this.db.prepare('UPDATE conv_members SET last_read_id = ? WHERE conv_id = ? AND user_id = ?').run(prev?.id ?? null, c.id, me.id);
        this.pushConv(c.id, [me.id]);
        return this.view(c, me.id);
      }

      case 'msg.edit': {
        const msg = typeof d.messageId === 'string' ? this.message(d.messageId) : undefined;
        if (!msg || msg.deleted) throw new MsgError('Message not found.');
        this.requireMember(msg.conv_id, me.id);
        if (msg.author_id !== me.id) throw new MsgError('You can only edit your own messages.');
        const body = typeof d.body === 'string' ? d.body.replace(/\r\n/g, '\n').trim() : '';
        if (!body) throw new MsgError('A message cannot be empty. Delete it instead.');
        if (body.length > MAX_BODY) throw new MsgError(`Messages can be up to ${MAX_BODY} characters.`);
        this.beforeChange?.(msg, 'edit', me.id);
        this.db.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?').run(body, Date.now(), msg.id);
        this.db.prepare('DELETE FROM mentions WHERE message_id = ?').run(msg.id);
        this.recordMentions(msg.id, msg.conv_id, body);
        this.index(msg.id, msg.conv_id, body);
        const row = this.message(msg.id)!;
        this.pushMessage('msg.updated', row);
        if (!row.parent_id) this.pushConv(row.conv_id);
        return this.messageView(row);
      }

      case 'msg.delete': {
        const msg = typeof d.messageId === 'string' ? this.message(d.messageId) : undefined;
        if (!msg || msg.deleted) throw new MsgError('Message not found.');
        const c = this.requireMember(msg.conv_id, me.id);
        if (msg.author_id !== me.id && !(isAdmin && c.kind === 'space')) throw new MsgError('You can only delete your own messages.');
        this.beforeChange?.(msg, 'delete', me.id);
        this.db.prepare('UPDATE messages SET deleted = 1, pinned = 0, edited_at = ? WHERE id = ?').run(Date.now(), msg.id);
        this.db.prepare('DELETE FROM reactions WHERE message_id = ?').run(msg.id);
        this.db.prepare('DELETE FROM mentions WHERE message_id = ?').run(msg.id);
        this.db.prepare('DELETE FROM messages_fts WHERE message_id = ?').run(msg.id);
        const row = this.message(msg.id)!;
        this.pushMessage('msg.updated', row);
        if (!row.parent_id) this.pushConv(row.conv_id);
        return this.messageView(row);
      }

      case 'msg.react': {
        const msg = typeof d.messageId === 'string' ? this.message(d.messageId) : undefined;
        if (!msg || msg.deleted) throw new MsgError('Message not found.');
        this.requireMember(msg.conv_id, me.id);
        const emoji = typeof d.emoji === 'string' ? d.emoji : '';
        if (!EMOJI_RE.test(emoji)) throw new MsgError('That reaction is not supported.');
        if (d.on === true) {
          const count = (this.db.prepare('SELECT COUNT(DISTINCT emoji) AS n FROM reactions WHERE message_id = ?').get(msg.id) as { n: number }).n;
          if (count >= 20) throw new MsgError('This message already has 20 different reactions.');
          this.db.prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)').run(msg.id, me.id, emoji, Date.now());
        } else {
          this.db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(msg.id, me.id, emoji);
        }
        const row = this.message(msg.id)!;
        this.pushMessage('msg.updated', row);
        return this.messageView(row);
      }

      case 'msg.pin': {
        const msg = typeof d.messageId === 'string' ? this.message(d.messageId) : undefined;
        if (!msg || msg.deleted) throw new MsgError('Message not found.');
        this.requireMember(msg.conv_id, me.id);
        if (d.pinned === true) {
          const n = (this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conv_id = ? AND pinned = 1 AND deleted = 0').get(msg.conv_id) as { n: number }).n;
          if (n >= 50) throw new MsgError('A conversation can have up to 50 pinned messages.');
        }
        this.db.prepare('UPDATE messages SET pinned = ? WHERE id = ?').run(d.pinned === true ? 1 : 0, msg.id);
        const row = this.message(msg.id)!;
        this.pushMessage('msg.updated', row);
        return this.messageView(row);
      }

      case 'search': {
        const q = typeof d.q === 'string' ? d.q.slice(0, 200) : '';
        const terms = q.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_.\-]*/gu)?.slice(0, 8) ?? [];
        if (!terms.length) return { messages: [], files: [] } satisfies Ops['search']['res'];
        const match = terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(' ');
        const limit = typeof d.limit === 'number' ? Math.max(1, Math.min(50, Math.floor(d.limit))) : 20;
        const scope = typeof d.convId === 'string' ? d.convId : null;
        const rows = this.db.prepare(`SELECT f.message_id, snippet(messages_fts, 0, '[[', ']]', '…', 12) AS snip
          FROM messages_fts f JOIN conv_members cm ON cm.conv_id = f.conv_id AND cm.user_id = ?
          WHERE messages_fts MATCH ? ${scope ? 'AND f.conv_id = ?' : ''} ORDER BY f.message_id DESC LIMIT ?`)
          .all(...(scope ? [me.id, match, scope, limit] : [me.id, match, limit])) as Array<{ message_id: string; snip: string }>;
        const messages = rows.map((r) => ({ message: this.messageView(this.message(r.message_id)!, me.id), snippet: r.snip })).filter((x) => !x.message.deleted);
        const like = `%${terms.join('%')}%`;
        const files = this.db.prepare(`SELECT f.*, mf.message_id, mf.conv_id FROM files f JOIN message_files mf ON mf.file_id = f.id
          JOIN conv_members cm ON cm.conv_id = mf.conv_id AND cm.user_id = ? JOIN messages m ON m.id = mf.message_id
          WHERE m.deleted = 0 AND lower(f.name) LIKE ? ${scope ? 'AND mf.conv_id = ?' : ''} ORDER BY mf.message_id DESC LIMIT 10`)
          .all(...(scope ? [me.id, like, scope] : [me.id, like])) as Array<{ id: string; name: string; mime: string; size: number; uploader_id: string; created_at: number; message_id: string; conv_id: string }>;
        return {
          messages,
          files: files.map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: f.size, uploaderId: f.uploader_id, createdAt: f.created_at, messageId: f.message_id, convId: f.conv_id })),
        } satisfies Ops['search']['res'];
      }

      case 'typing': {
        const c = this.requireMember(String(d.convId), me.id);
        const parentId = typeof d.parentId === 'string' ? d.parentId : null;
        this.deliver(this.members(c.id).filter((u) => u !== me.id), 'typing', () => ({ convId: c.id, userId: me.id, parentId }));
        return { ok: true };
      }
    }
    return undefined;
  }

  /** Post a message as someone (the person, a scheduled send, a bot or a forward). */
  sendAs(me: PublicUser, c: ConvRow, body: string, rawParent: unknown, fileIds: string[], rawClientId: unknown,
    extra: { forwarded?: string; skipFileCheck?: boolean; poll?: { options: string[]; multi: boolean; anonymous: boolean; closesAt: number | null } }): Message {
    if (fileIds.length > 20) throw new MsgError('Attach up to 20 files at a time.');
    if (!extra.skipFileCheck) for (const f of fileIds) if (!this.files.info(f) || !this.files.canRead(me.id, f)) throw new MsgError('One of the files is no longer available.');
    if (!body && !fileIds.length) throw new MsgError('Write something first.');
    if (body.length > MAX_BODY) throw new MsgError(`Messages can be up to ${MAX_BODY} characters.`);
    if (c.everyone && me.role === 'guest') throw new MsgError('Guests cannot post in the Office space.');
    const clientId = typeof rawClientId === 'string' ? rawClientId.slice(0, 96) : null;
    if (clientId) {
      const dup = this.db.prepare('SELECT * FROM messages WHERE author_id = ? AND client_id = ?').get(me.id, clientId) as MsgRow | undefined;
      if (dup) return this.messageView(dup, me.id); // a retry after a dropped connection
    }
    let parentId: string | null = null;
    if (typeof rawParent === 'string') {
      const parent = this.message(rawParent);
      if (!parent || parent.conv_id !== c.id || parent.parent_id) throw new MsgError('That message cannot be replied to.');
      parentId = parent.id;
    }
    const id = ulid();
    this.db.prepare('INSERT INTO messages (id, conv_id, author_id, body, parent_id, created_at, client_id, forwarded) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, c.id, me.id, body, parentId, Date.now(), clientId, extra.forwarded ?? null);
    if (extra.poll) {
      this.db.prepare('INSERT INTO polls (message_id, question, options, multi, anonymous, closes_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, body, JSON.stringify(extra.poll.options), extra.poll.multi ? 1 : 0, extra.poll.anonymous ? 1 : 0, extra.poll.closesAt);
    }
    this.recordMentions(id, c.id, body);
    this.index(id, c.id, extra.poll ? `${body} ${extra.poll.options.join(' ')}` : body);
    if (fileIds.length) this.files.link(id, c.id, fileIds);
    // sending implies you have read up to here
    if (!parentId) this.db.prepare('UPDATE conv_members SET last_read_id = ? WHERE conv_id = ? AND user_id = ?').run(id, c.id, me.id);
    const row = this.message(id)!;
    this.pushMessage('msg.new', row);
    if (!parentId) this.pushConv(c.id);
    return this.messageView(row, me.id);
  }

  /** Remove a message and its side-track for good (retention). Returns how many messages went. */
  purge(messageId: string): number {
    const msg = this.message(messageId);
    if (!msg) return 0;
    const ids = [msg.id, ...(this.db.prepare('SELECT id FROM messages WHERE parent_id = ?').all(msg.id) as Array<{ id: string }>).map((r) => r.id)];
    for (const id of ids) {
      for (const t of ['reactions', 'mentions', 'polls', 'poll_votes', 'message_files', 'stars']) this.db.prepare(`DELETE FROM ${t} WHERE message_id = ?`).run(id);
      const form = this.db.prepare('SELECT id FROM forms WHERE message_id = ?').get(id) as { id: string } | undefined;
      if (form) { this.db.prepare('DELETE FROM form_responses WHERE form_id = ?').run(form.id); this.db.prepare('DELETE FROM forms WHERE id = ?').run(form.id); }
      this.db.prepare('DELETE FROM messages_fts WHERE message_id = ?').run(id);
      this.db.prepare('DELETE FROM messages WHERE id = ?').run(id);
    }
    this.deliver(this.members(msg.conv_id), 'msg.removed', () => ({ convId: msg.conv_id, messageIds: ids }));
    this.pushConv(msg.conv_id);
    return ids.length;
  }

  /** The conversation row for a member (throws otherwise). */
  memberConv(convId: string, userId: string): ConvRow {
    return this.requireMember(convId, userId);
  }

  private recordMentions(messageId: string, convId: string, body: string): void {
    const members = new Set(this.members(convId));
    const ids = new Set<string>();
    for (const m of body.matchAll(MENTION_RE)) {
      if (m[1] === 'all') for (const u of members) ids.add(u);
      else if (members.has(m[1])) ids.add(m[1]);
    }
    const ins = this.db.prepare('INSERT OR IGNORE INTO mentions (message_id, conv_id, user_id) VALUES (?, ?, ?)');
    for (const u of ids) ins.run(messageId, convId, u);
  }
}
