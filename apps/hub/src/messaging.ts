// Spaces, Direct conversations, messages, side-tracks, reactions, pins, read state and
// typing, stored on the hub (SQLite). Every operation is authorised by membership.
import type { DatabaseSync } from 'node:sqlite';
import { MENTION_RE, ulid } from '@dex/core';
import { addWraps, isSealed } from '@dex/core/e2e';
import type { Conversation, FormField, FormView, Message, MessagePreview, Ops, PollView, PublicUser, ReportItem } from '@dex/core';
import type { FileStore } from './files.ts';

export class MsgError extends Error {}

const cleanBody = (v: unknown) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim() : '');

interface ReportRow { id: string; message_id: string; conv_id: string; conv_name: string | null; conv_kind: string; author_id: string; reporter_id: string; reason: string; text: string; quoted: number; created_at: number; status: string; resolved_by: string | null; resolved_at: number | null }
const toReport = (r: ReportRow): ReportItem => ({
  id: r.id, messageId: r.message_id, convId: r.conv_id, convName: r.conv_kind === 'space' ? r.conv_name ?? 'Space' : 'Direct conversation',
  authorId: r.author_id, reporterId: r.reporter_id, reason: r.reason, text: r.text, quoted: !!r.quoted, createdAt: r.created_at,
  status: r.status === 'removed' || r.status === 'dismissed' ? r.status : 'open', resolvedBy: r.resolved_by, resolvedAt: r.resolved_at,
});

function parseSystem(raw: string): Message['system'] {
  try {
    const s = JSON.parse(raw) as { kind?: string; users?: unknown; name?: unknown };
    if (!['joined', 'left', 'added', 'removed', 'renamed', 'away'].includes(String(s.kind))) return null;
    return { kind: s.kind as NonNullable<Message['system']>['kind'], users: Array.isArray(s.users) ? s.users.map(String).slice(0, 50) : [], ...(typeof s.name === 'string' ? { name: s.name } : {}), ...(typeof (s as { until?: unknown }).until === 'number' ? { until: (s as { until: number }).until } : {}) };
  } catch { return null; }
}

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

interface ConvRow { id: string; kind: 'space' | 'direct'; name: string | null; topic: string | null; private: number; everyone: number; created_by: string; created_at: number; archived: number; post_policy: 'everyone' | 'moderators' }
export interface MsgRow { id: string; conv_id: string; author_id: string; body: string; parent_id: string | null; created_at: number; edited_at: number | null; deleted: number; pinned: number; client_id: string | null; forwarded: string | null; system?: string | null; reply_to?: string | null; removed_by?: string | null; removed_reason?: string | null }

const MAX_BODY = 8000;
/** An end-to-end encrypted message is larger than its text (base64 and a key per device). */
const MAX_SEALED = 96_000;
const EMOJI_RE = /^[\p{Extended_Pictographic}\p{Emoji_Component}‍️]{1,16}$/u;

export class Messaging {
  private readonly db: DatabaseSync;
  /** Delivers an event to a set of users (all their connected devices). */
  private readonly deliver: (userIds: string[], name: string, data: (userId: string) => unknown) => void;
  private readonly users: () => PublicUser[];
  private readonly files: FileStore;
  /** Called before a message is edited or deleted (compliance keeps earlier versions). */
  beforeChange: ((msg: MsgRow, change: 'edit' | 'delete', actorId: string) => void) | null = null;
  /** The office policy: how long after sending an author may edit or delete (null: any time). */
  editWindowMs: () => number | null = () => null;
  /** Does this office emoji exist (for :name: reactions)? */
  customEmoji: (name: string) => boolean = () => false;
  private checkWindow(msg: MsgRow, what: 'edited' | 'deleted'): void {
    const w = this.editWindowMs();
    if (w !== null && Date.now() - msg.created_at > w) {
      const mins = Math.round(w / 60_000);
      throw new MsgError(`Messages can be ${what} for ${mins >= 120 && mins % 60 === 0 ? `${mins / 60} hours` : `${mins} minute${mins === 1 ? '' : 's'}`} after sending.`);
    }
  }

  constructor(db: DatabaseSync, deliver: Messaging['deliver'], users: () => PublicUser[], files: FileStore) {
    this.db = db;
    this.deliver = deliver;
    this.users = users;
    this.files = files;
    db.exec(SCHEMA);
    // hubs from before forwarding existed
    const cols = (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes('forwarded')) db.exec('ALTER TABLE messages ADD COLUMN forwarded TEXT');
    // join/leave/rename notices are messages with a system field
    if (!cols.includes('system')) db.exec('ALTER TABLE messages ADD COLUMN system TEXT');
    if (!cols.includes('reply_to')) db.exec('ALTER TABLE messages ADD COLUMN reply_to TEXT');
    if (!cols.includes('removed_by')) { db.exec('ALTER TABLE messages ADD COLUMN removed_by TEXT'); db.exec('ALTER TABLE messages ADD COLUMN removed_reason TEXT'); }
    db.exec(`CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, conv_id TEXT NOT NULL, author_id TEXT NOT NULL, reporter_id TEXT NOT NULL,
      reason TEXT NOT NULL, text TEXT NOT NULL, quoted INTEGER NOT NULL, created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', resolved_by TEXT, resolved_at INTEGER, UNIQUE (message_id, reporter_id))`);
    // sidebar organisation, timed mute, archive, moderation (hubs from before these existed)
    const add = (table: string, col: string, def: string) => {
      const have = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === col);
      if (!have) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    };
    add('conv_members', 'pinned_at', 'INTEGER');
    add('conv_members', 'section', 'TEXT');
    add('conv_members', 'muted_until', 'INTEGER');
    add('conv_members', 'moderator', 'INTEGER NOT NULL DEFAULT 0');
    add('conversations', 'archived', 'INTEGER NOT NULL DEFAULT 0');
    add('conversations', 'post_policy', "TEXT NOT NULL DEFAULT 'everyone'");
    // hubs upgraded from a version without search: index what is already there
    const indexed = (db.prepare('SELECT COUNT(*) AS n FROM messages_fts').get() as { n: number }).n;
    if (!indexed) {
      for (const r of db.prepare('SELECT id, conv_id, body FROM messages WHERE deleted = 0').all() as Array<{ id: string; conv_id: string; body: string }>) this.index(r.id, r.conv_id, r.body);
    }
  }

  /** Searchable text: mentions become names so "@priya" and "priya" both find the message. */
  private index(messageId: string, convId: string, body: string): void {
    this.db.prepare('DELETE FROM messages_fts WHERE message_id = ?').run(messageId);
    // end-to-end encrypted text cannot be (and must not be) searched on the hub
    if (!body || isSealed(body)) return;
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

  private isModerator(c: ConvRow, user: PublicUser): boolean {
    if (user.role === 'owner' || user.role === 'admin' || c.created_by === user.id) return true;
    return !!this.db.prepare('SELECT 1 FROM conv_members WHERE conv_id = ? AND user_id = ? AND moderator = 1').get(c.id, user.id);
  }

  /** Called on the hub timer: timed mutes end. */
  tick(now = Date.now()): void {
    const due = this.db.prepare('SELECT conv_id, user_id FROM conv_members WHERE muted_until IS NOT NULL AND muted_until <= ?').all(now) as Array<{ conv_id: string; user_id: string }>;
    for (const r of due) {
      this.db.prepare('UPDATE conv_members SET muted = 0, muted_until = NULL WHERE conv_id = ? AND user_id = ?').run(r.conv_id, r.user_id);
      this.pushConv(r.conv_id, [r.user_id]);
    }
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
    const r = this.db.prepare('SELECT id, author_id, body, created_at, deleted FROM messages WHERE conv_id = ? AND parent_id IS NULL AND system IS NULL ORDER BY id DESC LIMIT 1')
      .get(convId) as { id: string; author_id: string; body: string; created_at: number; deleted: number } | undefined;
    if (!r) return null;
    let body = r.deleted ? '' : isSealed(r.body) ? '🔒 Encrypted message' : r.body.slice(0, 280);
    if (!r.deleted && this.db.prepare('SELECT 1 FROM polls WHERE message_id = ?').get(r.id)) body = `📊 ${body}`;
    if (!r.deleted && !body) {
      const names = this.files.forMessage(r.id).map((f) => f.name);
      body = names.length ? `📎 ${names.length === 1 ? names[0] : `${names.length} files`}` : '';
    }
    return { id: r.id, authorId: r.author_id, body, createdAt: r.created_at };
  }

  view(c: ConvRow, viewer: string): Conversation {
    const m = this.db.prepare('SELECT last_read_id, muted, pinned_at, section, muted_until FROM conv_members WHERE conv_id = ? AND user_id = ?').get(c.id, viewer) as { last_read_id: string | null; muted: number; pinned_at: number | null; section: string | null; muted_until: number | null } | undefined;
    const lastRead = m?.last_read_id ?? '';
    const unread = m ? (this.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE conv_id = ? AND parent_id IS NULL AND deleted = 0 AND system IS NULL AND author_id != ? AND id > ?`)
      .get(c.id, viewer, lastRead) as { n: number }).n : 0;
    const mentions = m ? (this.db.prepare(`SELECT COUNT(*) AS n FROM mentions mn JOIN messages ms ON ms.id = mn.message_id
      WHERE mn.conv_id = ? AND mn.user_id = ? AND ms.deleted = 0 AND ms.author_id != ? AND mn.message_id > ?`).get(c.id, viewer, viewer, lastRead) as { n: number }).n : 0;
    return {
      id: c.id, kind: c.kind, name: c.name, topic: c.topic, private: !!c.private, everyone: !!c.everyone,
      createdBy: c.created_by, createdAt: c.created_at, members: this.members(c.id), lastMessage: this.preview(c.id),
      joined: !!m, unread, mentions, lastReadId: m?.last_read_id ?? null, muted: !!m?.muted,
      reads: this.readsFor(c.id, viewer),
      pinnedAt: m?.pinned_at ?? null, section: m?.section ?? null, mutedUntil: m?.muted_until ?? null,
      archived: !!c.archived, postPolicy: c.post_policy ?? 'everyone',
      moderators: (this.db.prepare('SELECT user_id FROM conv_members WHERE conv_id = ? AND moderator = 1').all(c.id) as Array<{ user_id: string }>).map((r) => r.user_id),
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
      system: r.system ? parseSystem(r.system) : null,
      removed: r.deleted && r.removed_by && r.removed_by !== r.author_id ? { by: r.removed_by, reason: r.removed_reason ?? null } : null,
      inReplyTo: r.reply_to ? (() => { const p = this.message(r.reply_to!); return p ? { messageId: p.id, authorId: p.author_id } : null; })() : null,
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

  /** Who has read up to where, as this viewer may see it: people who switched read receipts off
   *  are left out, and someone who switched theirs off sees only their own. */
  private readsFor(convId: string, viewer: string): Record<string, string | null> {
    const rows = this.db.prepare(`SELECT cm.user_id, cm.last_read_id, COALESCE(u.receipts, 1) AS receipts FROM conv_members cm
      LEFT JOIN users u ON u.id = cm.user_id WHERE cm.conv_id = ?`).all(convId) as Array<{ user_id: string; last_read_id: string | null; receipts: number }>;
    const mine = rows.find((r) => r.user_id === viewer);
    const share = mine?.receipts !== 0;
    return Object.fromEntries(rows.filter((r) => r.user_id === viewer || (share && r.receipts !== 0)).map((r) => [r.user_id, r.last_read_id]));
  }

  private receiptsOn(userId: string): boolean {
    return (this.db.prepare('SELECT COALESCE(receipts, 1) AS r FROM users WHERE id = ?').get(userId) as { r: number } | undefined)?.r !== 0;
  }

  /** Conversations someone is in (to refresh read receipts when they change the setting). */
  convIdsOf(userId: string): string[] {
    return (this.db.prepare('SELECT conv_id FROM conv_members WHERE user_id = ?').all(userId) as Array<{ conv_id: string }>).map((r) => r.conv_id);
  }
  pushConvTo(convId: string): void { this.pushConv(convId); }

  /** A notice in the conversation: someone joined, left, was added or removed, or it was renamed. */
  private notice(convId: string, actorId: string, kind: NonNullable<Message['system']>['kind'], users: string[], name?: string, until?: number): void {
    const id = ulid();
    this.db.prepare('INSERT INTO messages (id, conv_id, author_id, body, parent_id, created_at, system) VALUES (?, ?, ?, ?, NULL, ?, ?)')
      .run(id, convId, actorId, '', Date.now(), JSON.stringify({ kind, users, ...(name ? { name } : {}), ...(until ? { until } : {}) }));
    const row = this.message(id);
    if (row) this.pushMessage('msg.new', row);
  }

  /** Out of office: tell whoever writes to (or mentions) someone away, once every 12 hours per conversation. */
  private readonly awayNoticed = new Map<string, number>();
  private outOfOffice(c: ConvRow, authorId: string, mentioned: string[]): void {
    const now = Date.now();
    const targets = c.kind === 'direct' ? this.members(c.id).filter((u) => u !== authorId) : mentioned.filter((u) => u !== authorId);
    if (!targets.length) return;
    const people = new Map(this.users().map((u) => [u.id, u] as const));
    for (const uid of targets) {
      const u = people.get(uid);
      if (!u?.ooo || u.ooo.until <= now) continue;
      const key = `${c.id}:${uid}`;
      if (now - (this.awayNoticed.get(key) ?? 0) < 12 * 3600_000) continue;
      this.awayNoticed.set(key, now);
      this.notice(c.id, uid, 'away', u.ooo.delegateId ? [uid, u.ooo.delegateId] : [uid], u.ooo.message ?? undefined, u.ooo.until);
    }
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
  /** Called when a report is made or settled (the hub tells administrators). */
  onReport: (() => void) | null = null;
  openReports(): number { return (this.db.prepare("SELECT COUNT(DISTINCT message_id) AS n FROM reports WHERE status = 'open'").get() as { n: number }).n; }

  /** A newly approved person joins the office's default Spaces. */
  joinDefaults(userId: string, spaceIds: string[]): void {
    if (this.users().find((u) => u.id === userId)?.role === 'guest') return;
    for (const id of spaceIds) {
      const c = this.conv(id);
      if (!c || c.kind !== 'space' || c.archived || this.isMember(id, userId)) continue;
      this.addMember(id, userId);
      this.pushConv(id);
    }
  }

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
        const was = this.isMember(c.id, me.id);
        this.addMember(c.id, me.id);
        this.pushConv(c.id);
        if (!was && !c.everyone) this.notice(c.id, me.id, 'joined', [me.id]);
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
        this.notice(c.id, me.id, 'left', [me.id]);
        return { ok: true };
      }

      case 'msg.report': {
        const msg = typeof d.messageId === 'string' ? this.message(d.messageId) : undefined;
        if (!msg || msg.deleted) throw new MsgError('Message not found.');
        this.requireMember(msg.conv_id, me.id);
        if (msg.author_id === me.id) throw new MsgError('You cannot report your own message.');
        const reason = str(d.reason, 300);
        if (!reason) throw new MsgError('Say what is wrong with it.');
        const sealed = isSealed(msg.body);
        const quote = typeof d.quote === 'string' ? d.quote.slice(0, 4000) : '';
        const text = sealed ? quote : msg.body.slice(0, 4000);
        try {
          this.db.prepare('INSERT INTO reports (id, message_id, conv_id, author_id, reporter_id, reason, text, quoted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(ulid(), msg.id, msg.conv_id, msg.author_id, me.id, reason, text, sealed ? 1 : 0, Date.now());
        } catch { throw new MsgError('You have already reported this message.'); }
        this.onReport?.();
        return { ok: true } satisfies Ops['msg.report']['res'];
      }

      case 'admin.reports.list': {
        if (!isAdmin) throw new MsgError('Only administrators can do that.');
        const rows = this.db.prepare(`SELECT r.*, c.name AS conv_name, c.kind AS conv_kind FROM reports r JOIN conversations c ON c.id = r.conv_id ${d.status === 'all' ? '' : "WHERE r.status = 'open'"} ORDER BY r.created_at DESC LIMIT 200`).all() as unknown as ReportRow[];
        return rows.map(toReport) satisfies Ops['admin.reports.list']['res'];
      }

      case 'admin.reports.resolve': {
        if (!isAdmin) throw new MsgError('Only administrators can do that.');
        const r = this.db.prepare(`SELECT r.*, c.name AS conv_name, c.kind AS conv_kind FROM reports r JOIN conversations c ON c.id = r.conv_id WHERE r.id = ?`).get(String(d.id ?? '')) as ReportRow | undefined;
        if (!r) throw new MsgError('Report not found.');
        const status = d.action === 'remove' ? 'removed' : 'dismissed';
        if (status === 'removed') {
          const msg = this.message(r.message_id);
          if (msg && !msg.deleted) {
            this.beforeChange?.(msg, 'delete', me.id);
            this.db.prepare('UPDATE messages SET deleted = 1, pinned = 0, edited_at = ?, removed_by = ?, removed_reason = ? WHERE id = ?').run(Date.now(), me.id, str(d.reason, 200) || r.reason, msg.id);
            for (const t of ['reactions', 'mentions', 'messages_fts']) this.db.prepare(`DELETE FROM ${t} WHERE message_id = ?`).run(msg.id);
            const row = this.message(msg.id)!;
            this.pushMessage('msg.updated', row);
            if (!row.parent_id) this.pushConv(row.conv_id);
          }
        }
        // every report of the same message is settled together
        this.db.prepare(`UPDATE reports SET status = ?, resolved_by = ?, resolved_at = ? WHERE message_id = ? AND status = 'open'`).run(status, me.id, Date.now(), r.message_id);
        this.onReport?.();
        return toReport({ ...r, status, resolved_by: me.id, resolved_at: Date.now() }) satisfies Ops['admin.reports.resolve']['res'];
      }

      case 'conv.toSpace': {
        const c = this.requireMember(String(d.convId), me.id);
        if (c.kind !== 'direct' || this.members(c.id).length < 3) throw new MsgError('Only group conversations can become a Space.');
        if (me.role === 'guest') throw new MsgError('Guests cannot create Spaces.');
        const name = str(d.name, 60);
        if (!name) throw new MsgError('Give the Space a name.');
        this.db.prepare("UPDATE conversations SET kind = 'space', private = 1, name = ?, created_by = ? WHERE id = ?").run(name, me.id, c.id);
        this.pushConv(c.id);
        this.notice(c.id, me.id, 'renamed', [], name);
        return this.view(this.conv(c.id)!, me.id);
      }

      case 'conv.removeMember': {
        const c = this.requireMember(String(d.convId), me.id);
        if (c.kind !== 'space' || c.everyone) throw new MsgError('People can only be removed from Spaces.');
        if (!this.isModerator(c, me)) throw new MsgError('Only the Space\'s moderators can remove people.');
        const uid = String(d.userId ?? '');
        if (uid === me.id) throw new MsgError('Leave the Space instead.');
        if (!this.isMember(c.id, uid)) throw new MsgError('They are not in this Space.');
        const before = this.members(c.id);
        this.db.prepare('DELETE FROM conv_members WHERE conv_id = ? AND user_id = ?').run(c.id, uid);
        this.deliver([uid], 'conv.removed', () => ({ convId: c.id }));
        this.pushConv(c.id, before.filter((u) => u !== uid));
        this.notice(c.id, me.id, 'removed', [uid]);
        return this.view(c, me.id);
      }

      case 'conv.addMembers': {
        const c = this.requireMember(String(d.convId), me.id);
        if (c.everyone) throw new MsgError('Everyone is already in the Office space.');
        if (me.role === 'guest') throw new MsgError('Guests cannot add people.');
        if (c.kind === 'direct') throw new MsgError('Start a new Direct conversation or a Space to include more people.');
        const ids = Array.isArray(d.userIds) ? (d.userIds.filter(knownUser) as string[]) : [];
        const fresh = ids.filter((u) => !this.isMember(c.id, u));
        for (const u of ids) this.addMember(c.id, u);
        this.pushConv(c.id);
        if (fresh.length) this.notice(c.id, me.id, 'added', fresh);
        return this.view(c, me.id);
      }

      case 'conv.update': {
        const c = this.requireMember(String(d.convId), me.id);
        if (c.kind !== 'space') throw new MsgError('Only Spaces have a name and topic.');
        if (!this.isModerator(c, me)) throw new MsgError('Only the person who created this Space, a moderator or an administrator can change it.');
        const name = d.name !== undefined ? str(d.name, 60) : c.name;
        if (!name) throw new MsgError('A Space needs a name.');
        const topic = d.topic === undefined ? c.topic : d.topic === null ? null : str(d.topic, 240) || null;
        this.db.prepare('UPDATE conversations SET name = ?, topic = ? WHERE id = ?').run(name, topic, c.id);
        this.pushConv(c.id);
        if (name !== c.name) this.notice(c.id, me.id, 'renamed', [], name);
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
          const share = this.receiptsOn(me.id);
          this.deliver(this.members(c.id).filter((u) => u === me.id || (share && this.receiptsOn(u))), 'read', () => ({ convId: c.id, userId: me.id, messageId: msg.id }));
          this.pushConv(c.id, [me.id]);
        }
        return this.view(c, me.id);
      }

      case 'conv.mute': {
        const c = this.requireMember(String(d.convId), me.id);
        const until = d.muted === true && typeof d.until === 'number' && d.until > Date.now() ? Math.floor(d.until) : null;
        this.db.prepare('UPDATE conv_members SET muted = ?, muted_until = ? WHERE conv_id = ? AND user_id = ?').run(d.muted === true ? 1 : 0, until, c.id, me.id);
        this.pushConv(c.id, [me.id]);
        return this.view(c, me.id);
      }

      case 'conv.organise': {
        const c = this.requireMember(String(d.convId), me.id);
        if (d.pinned !== undefined) {
          if (d.pinned === true) {
            const n = (this.db.prepare('SELECT COUNT(*) AS n FROM conv_members WHERE user_id = ? AND pinned_at IS NOT NULL').get(me.id) as { n: number }).n;
            if (n >= 100) throw new MsgError('You can pin up to 100 conversations.');
          }
          this.db.prepare('UPDATE conv_members SET pinned_at = ? WHERE conv_id = ? AND user_id = ?').run(d.pinned === true ? Date.now() : null, c.id, me.id);
        }
        if (d.section !== undefined) this.db.prepare('UPDATE conv_members SET section = ? WHERE conv_id = ? AND user_id = ?').run(str(d.section, 40) || null, c.id, me.id);
        this.pushConv(c.id, [me.id]);
        return this.view(c, me.id);
      }

      case 'conv.archive': {
        const c = this.requireMember(String(d.convId), me.id);
        if (c.kind !== 'space' || c.everyone) throw new MsgError('Only Spaces can be archived.');
        if (!this.isModerator(c, me)) throw new MsgError('Only the person who created this Space, a moderator or an administrator can archive it.');
        this.db.prepare('UPDATE conversations SET archived = ? WHERE id = ?').run(d.archived === true ? 1 : 0, c.id);
        this.pushConv(c.id);
        return this.view(this.conv(c.id)!, me.id);
      }

      case 'conv.settings': {
        const c = this.requireMember(String(d.convId), me.id);
        if (c.kind !== 'space') throw new MsgError('Only Spaces have these settings.');
        if (!this.isModerator(c, me)) throw new MsgError('Only the person who created this Space, a moderator or an administrator can change it.');
        if (d.postPolicy === 'everyone' || d.postPolicy === 'moderators') this.db.prepare('UPDATE conversations SET post_policy = ? WHERE id = ?').run(d.postPolicy, c.id);
        if (Array.isArray(d.moderators)) {
          const want = new Set(d.moderators.filter((x): x is string => typeof x === 'string'));
          this.db.prepare('UPDATE conv_members SET moderator = 0 WHERE conv_id = ?').run(c.id);
          for (const u of want) this.db.prepare('UPDATE conv_members SET moderator = 1 WHERE conv_id = ? AND user_id = ?').run(c.id, u);
        }
        this.pushConv(c.id);
        return this.view(this.conv(c.id)!, me.id);
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

      case 'activity.list': {
        const kind = d.kind === 'mentions' || d.kind === 'replies' ? d.kind : 'all';
        const before = typeof d.before === 'string' ? d.before.slice(0, 40) : null;
        const since = Date.now() - 60 * 86400_000;
        const mentionCond = `(mn.user_id IS NOT NULL OR m.body LIKE '%<@all>%')`;
        const replyCond = `(m.parent_id IS NOT NULL AND (EXISTS (SELECT 1 FROM messages p WHERE p.id = m.parent_id AND p.author_id = ?)
          OR EXISTS (SELECT 1 FROM messages r WHERE r.parent_id = m.parent_id AND r.author_id = ? AND r.id < m.id)))`;
        const cond = kind === 'mentions' ? mentionCond : kind === 'replies' ? replyCond : `(${mentionCond} OR ${replyCond})`;
        const replyArgs = kind === 'mentions' ? [] : [me.id, me.id];
        const rows = this.db.prepare(`SELECT m.id, mn.user_id AS mentioned FROM messages m
          JOIN conv_members cm ON cm.conv_id = m.conv_id AND cm.user_id = ?
          LEFT JOIN mentions mn ON mn.message_id = m.id AND mn.user_id = ?
          WHERE m.deleted = 0 AND m.system IS NULL AND m.author_id != ? AND m.created_at > ? AND ${cond} ${before ? 'AND m.id < ?' : ''}
          ORDER BY m.id DESC LIMIT 41`).all(me.id, me.id, me.id, since, ...replyArgs, ...(before ? [before] : [])) as Array<{ id: string; mentioned: string | null }>;
        const items = rows.slice(0, 40).map((r) => {
          const row = this.message(r.id)!;
          const mention = !!r.mentioned || row.body.includes('<@all>');
          return { kind: (mention ? 'mention' : 'reply') as 'mention' | 'reply', message: this.messageView(row, me.id) };
        });
        return { items, hasMore: rows.length > 40 } satisfies Ops['activity.list']['res'];
      }

      case 'activity.tracks': {
        const rows = this.db.prepare(`SELECT p.id, MAX(r.created_at) AS last, COUNT(r.id) AS n FROM messages p
          JOIN messages r ON r.parent_id = p.id AND r.deleted = 0
          JOIN conv_members cm ON cm.conv_id = p.conv_id AND cm.user_id = ?
          WHERE p.deleted = 0 AND (p.author_id = ? OR EXISTS (SELECT 1 FROM messages x WHERE x.parent_id = p.id AND x.author_id = ?))
          GROUP BY p.id ORDER BY last DESC LIMIT 40`).all(me.id, me.id, me.id) as Array<{ id: string; last: number; n: number }>;
        return rows.map((r) => ({ parent: this.messageView(this.message(r.id)!, me.id), lastReplyAt: r.last, replyCount: r.n })) satisfies Ops['activity.tracks']['res'];
      }

      case 'msg.get': {
        const v = typeof d.messageId === 'string' ? this.messageFor(d.messageId, me.id) : null;
        if (!v || v.deleted) throw new MsgError('Message not found.');
        return v satisfies Ops['msg.get']['res'];
      }

      case 'people.common': {
        const other = String(d.userId ?? '');
        const spaces = this.db.prepare(`SELECT c.id, c.name FROM conversations c JOIN conv_members a ON a.conv_id = c.id AND a.user_id = ?
          JOIN conv_members b ON b.conv_id = c.id AND b.user_id = ? WHERE c.kind = 'space' AND c.everyone = 0 AND c.archived = 0 ORDER BY c.name COLLATE NOCASE LIMIT 50`).all(me.id, other) as Array<{ id: string; name: string }>;
        let calls: Ops['people.common']['res']['calls'] = [];
        try {
          calls = (this.db.prepare(`SELECT l.conv_id, l.ended_at, l.duration_ms, l.missed, l.video FROM call_log l
            JOIN conv_members a ON a.conv_id = l.conv_id AND a.user_id = ? JOIN conv_members b ON b.conv_id = l.conv_id AND b.user_id = ?
            JOIN conversations c ON c.id = l.conv_id WHERE c.kind = 'direct' ORDER BY l.ended_at DESC LIMIT 20`).all(me.id, other) as Array<{ conv_id: string; ended_at: number; duration_ms: number; missed: number; video: number }>)
            .map((r) => ({ at: r.ended_at, durationMs: r.duration_ms, missed: !!r.missed, video: !!r.video, convId: r.conv_id }));
        } catch { /* hubs without the call log yet */ }
        return { spaces, calls } satisfies Ops['people.common']['res'];
      }

      case 'msg.at': {
        const c = this.requireMember(String(d.convId), me.id);
        const at = typeof d.at === 'number' && Number.isFinite(d.at) ? d.at : Date.now();
        const r = this.db.prepare('SELECT id FROM messages WHERE conv_id = ? AND parent_id IS NULL AND deleted = 0 AND created_at >= ? ORDER BY created_at, id LIMIT 1').get(c.id, at) as { id: string } | undefined
          ?? this.db.prepare('SELECT id FROM messages WHERE conv_id = ? AND parent_id IS NULL AND deleted = 0 ORDER BY id DESC LIMIT 1').get(c.id) as { id: string } | undefined;
        return { messageId: r?.id ?? null } satisfies Ops['msg.at']['res'];
      }

      case 'msg.send': {
        const c = this.requireMember(String(d.convId), me.id);
        const fileIds = Array.isArray(d.files) ? [...new Set(d.files.filter((f): f is string => typeof f === 'string'))].slice(0, 21) : [];
        const reply = this.sendAs(me, c, cleanBody(d.body), d.parentId, fileIds, d.clientId, {});
        // "also send to the conversation": a copy in the main timeline that points back to the side-track
        if (d.alsoToConv === true && reply.parentId && !this.db.prepare('SELECT 1 FROM messages WHERE reply_to = ? AND author_id = ? AND client_id = ?').get(reply.parentId, me.id, `${d.clientId}:conv`)) {
          const copy = this.sendAs(me, c, cleanBody(d.body), null, fileIds, typeof d.clientId === 'string' ? `${d.clientId}:conv` : undefined, { skipFileCheck: true });
          this.db.prepare('UPDATE messages SET reply_to = ? WHERE id = ?').run(reply.parentId, copy.id);
          const row = this.message(copy.id);
          if (row) this.pushMessage('msg.updated', row);
        }
        return reply;
      }

      case 'msg.forward': {
        const src = this.visibleMessage(d.messageId, me.id);
        const targets = Array.isArray(d.convIds) ? [...new Set(d.convIds.filter((x): x is string => typeof x === 'string'))] : [];
        if (!targets.length) throw new MsgError('Choose where to forward it.');
        if (targets.length > 25) throw new MsgError('Forward to up to 25 conversations at a time.');
        const convs = targets.map((id) => this.requireMember(id, me.id));
        const bodies = d.bodies && typeof d.bodies === 'object' ? d.bodies as Record<string, unknown> : {};
        // a sealed message cannot be copied as it is: the app must re-seal it (or give the text) for each target
        if (isSealed(src.body) && targets.some((t) => typeof bodies[t] !== 'string')) throw new MsgError('This encrypted message can only be forwarded from the app.');
        const note = cleanBody(d.note);
        const files = this.files.forMessage(src.id).map((f) => f.id);
        const forwarded = JSON.stringify({ authorId: src.forwarded ? (parseForward(src.forwarded)?.authorId ?? src.author_id) : src.author_id, convId: src.conv_id, messageId: src.id, createdAt: src.created_at });
        const stamp = `${Date.now().toString(36)}-${src.id}`;
        const out: Message[] = [];
        for (const c of convs) {
          if (note) this.sendAs(me, c, note, undefined, [], `fwdnote-${stamp}-${c.id}`, {});
          const poll = this.db.prepare('SELECT 1 FROM polls WHERE message_id = ?').get(src.id);
          const text = typeof bodies[c.id] === 'string' ? cleanBody(bodies[c.id]) : poll ? `📊 ${src.body}` : src.body;
          out.push(this.sendAs(me, c, text, undefined, files, `fwd-${stamp}-${c.id}`, { forwarded, skipFileCheck: true }));
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
        this.checkWindow(msg, 'edited');
        const body = typeof d.body === 'string' ? d.body.replace(/\r\n/g, '\n').trim() : '';
        if (!body) throw new MsgError('A message cannot be empty. Delete it instead.');
        if (body.length > (isSealed(body) ? MAX_SEALED : MAX_BODY)) throw new MsgError(`Messages can be up to ${MAX_BODY} characters.`);
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
        const moderating = c.kind === 'space' && this.isModerator(c, me);
        if (msg.author_id !== me.id && !moderating) throw new MsgError('You can only delete your own messages.');
        if (!moderating) this.checkWindow(msg, 'deleted');
        this.beforeChange?.(msg, 'delete', me.id);
        const why = typeof d.reason === 'string' ? d.reason.replace(/\s+/g, ' ').trim().slice(0, 200) || null : null;
        this.db.prepare('UPDATE messages SET deleted = 1, pinned = 0, edited_at = ?, removed_by = ?, removed_reason = ? WHERE id = ?').run(Date.now(), me.id, msg.author_id === me.id ? null : why, msg.id);
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
        const custom = /^:([a-z0-9][a-z0-9_-]{1,31}):$/.exec(emoji);
        if (!EMOJI_RE.test(emoji) && !(custom && this.customEmoji(custom[1]))) throw new MsgError('That reaction is not supported.');
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
        const from = typeof d.from === 'string' ? d.from : null;
        const kind = d.kind === 'direct' || d.kind === 'space' ? d.kind : null;
        const after = typeof d.after === 'number' && Number.isFinite(d.after) ? d.after : null;
        const before = typeof d.before === 'number' && Number.isFinite(d.before) ? d.before : null;
        const hasFile = d.hasFile === true;
        const olderThan = typeof d.olderThan === 'string' ? d.olderThan.slice(0, 40) : null;
        const scope = typeof d.convId === 'string' ? d.convId : null;
        const filtered = !!(from || kind || after !== null || before !== null || hasFile || scope);
        // with no words, filters alone can list messages ("everything Priya sent last week")
        if (!terms.length && !(filtered && (from || hasFile || scope || after !== null))) return { messages: [], files: [] } satisfies Ops['search']['res'];
        const limit = typeof d.limit === 'number' ? Math.max(1, Math.min(50, Math.floor(d.limit))) : 20;
        const where: string[] = ['m.deleted = 0', 'm.system IS NULL'];
        const args: Array<string | number> = [me.id];
        if (terms.length) { where.push('messages_fts MATCH ?'); args.push(terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(' ')); }
        if (scope) { where.push('m.conv_id = ?'); args.push(scope); }
        if (from) { where.push('m.author_id = ?'); args.push(from); }
        if (kind) { where.push('c.kind = ?'); args.push(kind); }
        if (after !== null) { where.push('m.created_at >= ?'); args.push(after); }
        if (before !== null) { where.push('m.created_at < ?'); args.push(before); }
        if (hasFile) where.push('EXISTS (SELECT 1 FROM message_files x WHERE x.message_id = m.id)');
        if (olderThan) { where.push('m.id < ?'); args.push(olderThan); }
        const rows = this.db.prepare(`SELECT m.id AS message_id, ${terms.length ? "snippet(messages_fts, 0, '[[', ']]', '…', 12)" : "''"} AS snip
          FROM ${terms.length ? 'messages_fts f JOIN messages m ON m.id = f.message_id' : 'messages m'}
          JOIN conv_members cm ON cm.conv_id = m.conv_id AND cm.user_id = ?
          JOIN conversations c ON c.id = m.conv_id
          WHERE ${where.join(' AND ')} ORDER BY m.id DESC LIMIT ?`)
          .all(...args, limit) as Array<{ message_id: string; snip: string }>;
        const messages = rows.map((r) => ({ message: this.messageView(this.message(r.message_id)!, me.id), snippet: r.snip })).filter((x) => !x.message.deleted);
        const fWhere: string[] = ['m.deleted = 0'];
        const fArgs: Array<string | number> = [me.id];
        if (terms.length) {
          // the name, or the text read from an image
          fWhere.push(`(lower(f.name) LIKE ? OR (${terms.map(() => "lower(COALESCE(f.ocr_text, '')) LIKE ?").join(' AND ')}))`);
          fArgs.push(`%${terms.join('%')}%`, ...terms.map((t) => `%${t}%`));
        }
        if (scope) { fWhere.push('mf.conv_id = ?'); fArgs.push(scope); }
        if (from) { fWhere.push('m.author_id = ?'); fArgs.push(from); }
        if (kind) { fWhere.push('c.kind = ?'); fArgs.push(kind); }
        if (after !== null) { fWhere.push('m.created_at >= ?'); fArgs.push(after); }
        if (before !== null) { fWhere.push('m.created_at < ?'); fArgs.push(before); }
        if (olderThan) { fWhere.push('mf.message_id < ?'); fArgs.push(olderThan); }
        const files = this.db.prepare(`SELECT f.*, mf.message_id, mf.conv_id FROM files f JOIN message_files mf ON mf.file_id = f.id
          JOIN conv_members cm ON cm.conv_id = mf.conv_id AND cm.user_id = ? JOIN messages m ON m.id = mf.message_id
          JOIN conversations c ON c.id = mf.conv_id
          WHERE ${fWhere.join(' AND ')} ORDER BY mf.message_id DESC LIMIT ?`)
          .all(...fArgs, terms.length ? 20 : limit) as Array<{ id: string; name: string; mime: string; size: number; uploader_id: string; created_at: number; message_id: string; conv_id: string; ocr_text: string | null }>;
        /** A few words around the first match in an image's text. */
        const textMatch = (t: string | null): string | undefined => {
          if (!t || !terms.length) return undefined;
          const at = t.toLowerCase().indexOf(terms[0]);
          if (at < 0) return undefined;
          const from = Math.max(0, at - 40);
          return `${from ? '…' : ''}${t.slice(from, at)}[[${t.slice(at, at + terms[0].length)}]]${t.slice(at + terms[0].length, at + terms[0].length + 60)}…`;
        };
        return {
          messages,
          files: files.map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: f.size, uploaderId: f.uploader_id, createdAt: f.created_at, messageId: f.message_id, convId: f.conv_id, textMatch: textMatch(f.ocr_text) })),
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
    if (body.length > (isSealed(body) ? MAX_SEALED : MAX_BODY)) throw new MsgError(`Messages can be up to ${MAX_BODY} characters.`);
    if (c.everyone && me.role === 'guest') throw new MsgError('Guests cannot post in the Office space.');
    if (c.archived) throw new MsgError('This Space is archived. Restore it to post again.');
    // announcement Spaces: only moderators start new messages (everyone can still reply in side-tracks)
    if (c.post_policy === 'moderators' && typeof rawParent !== 'string' && me.role !== 'bot' && !this.isModerator(c, me)) throw new MsgError('Only moderators post in this Space. You can reply in a side-track.');
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
    if (!extra.forwarded) this.outOfOffice(c, me.id, (this.db.prepare('SELECT user_id FROM mentions WHERE message_id = ?').all(id) as Array<{ user_id: string }>).map((r) => r.user_id));
    return this.messageView(row, me.id);
  }

  /** Add wrapped keys to sealed messages the caller can read (history for their new devices). */
  addKeys(me: PublicUser, items: unknown, deviceOwner: (deviceId: string) => string | null): number {
    const list = Array.isArray(items) ? items.slice(0, 500) as Array<{ messageId?: unknown; wraps?: unknown }> : [];
    let n = 0;
    for (const it of list) {
      const msg = typeof it.messageId === 'string' ? this.message(it.messageId) : undefined;
      if (!msg || msg.deleted || !isSealed(msg.body) || !this.isMember(msg.conv_id, me.id) || !it.wraps || typeof it.wraps !== 'object') continue;
      const members = new Set(this.members(msg.conv_id));
      // only for devices of people in the conversation
      const wraps = Object.fromEntries(Object.entries(it.wraps as Record<string, unknown>).filter(([dev, w]) => typeof w === 'string' && members.has(deviceOwner(dev) ?? '')).map(([dev, w]) => [dev, w as string]));
      if (!Object.keys(wraps).length) continue;
      const next = addWraps(msg.body, wraps);
      if (next && next !== msg.body) { this.db.prepare('UPDATE messages SET body = ? WHERE id = ?').run(next, msg.id); n++; }
    }
    return n;
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
