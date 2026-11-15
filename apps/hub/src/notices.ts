// The notice board (docs/ANNOUNCEMENTS.md): official notices from the office's issuing desks, kept
// as a register. A notice is numbered when first issued (HR-POL-0012), revised by letter (Rev A,
// Rev B…), read by an audience resolved from the organisation each time (so a new joiner sees what
// is in force), optionally acknowledged ("Read and understood", with check questions), reminded
// about politely (one grouped line a day at most), withdrawn with a stamped record and archived
// when it expires. The clock is injected (now(), setClock) so schedules, expiry, reminders and the
// desk digest can be tested and walked through end to end.
import type { DatabaseSync } from 'node:sqlite';
import {
  NOTICE_LIMITS, NOTICE_LANGS, NOTICE_MAX_NUDGES, NOTICE_MAX_QUESTIONS, NOTICE_URGENT_DEFAULT_MS, NOTICE_URGENT_MAX_MS, NOTICE_URGENT_PER_DAY,
  categoryCode, changedParagraphs, emptyAudience, inAudience, isNoticeCategory, nextRev, noticeNumber, revOrder, toCsv, ulid,
} from '@dex/core';
import type {
  Department, FileInfo, NoticeAckChart, NoticeAsk, NoticeAudience, NoticeCategory, NoticeCheckDef, NoticeDesk, NoticeFaq, NoticeHit, NoticeLang,
  NoticeList, NoticeRevision, NoticeRevStatus, NoticeStatus, NoticeSummary, NoticeText, NoticeView, Ops, PublicUser,
} from '@dex/core';
import type { FileStore } from './files.ts';
import type { Store } from './store.ts';
import { localDate } from './work.ts';
import { PdfError, readPdf } from './pdf.ts';

export class NoticeError extends Error {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notice_desks (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  seq TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notice_issuers (
  desk_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (desk_id, user_id)
);
CREATE TABLE IF NOT EXISTS notices (
  id TEXT PRIMARY KEY,
  desk_id TEXT NOT NULL,
  category TEXT NOT NULL,
  number TEXT,
  status TEXT NOT NULL,
  rev TEXT,
  related TEXT NOT NULL DEFAULT '[]',
  source_message TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  withdrawn_at INTEGER,
  withdrawn_by TEXT,
  withdraw_reason TEXT,
  archived_at INTEGER
);
CREATE TABLE IF NOT EXISTS notice_revs (
  notice_id TEXT NOT NULL,
  rev TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  translations TEXT NOT NULL DEFAULT '{}',
  file_id TEXT,
  pdf_text TEXT,
  change_note TEXT,
  changed TEXT NOT NULL DEFAULT '[]',
  removed INTEGER NOT NULL DEFAULT 0,
  reack INTEGER NOT NULL DEFAULT 0,
  ack_required INTEGER NOT NULL DEFAULT 0,
  checks TEXT NOT NULL DEFAULT '[]',
  audience TEXT NOT NULL,
  issue_at INTEGER,
  issued_at INTEGER,
  effective_at INTEGER,
  expires_at INTEGER,
  standing INTEGER NOT NULL DEFAULT 0,
  urgent INTEGER NOT NULL DEFAULT 0,
  author_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (notice_id, rev)
);
CREATE INDEX IF NOT EXISTS idx_notice_revs_file ON notice_revs(file_id);
CREATE TABLE IF NOT EXISTS notice_acks (
  notice_id TEXT NOT NULL,
  rev TEXT NOT NULL,
  user_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (notice_id, rev, user_id)
);
CREATE TABLE IF NOT EXISTS notice_seen (
  notice_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  rev TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (notice_id, user_id)
);
CREATE TABLE IF NOT EXISTS notice_asks (
  id TEXT PRIMARY KEY,
  notice_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  at INTEGER NOT NULL,
  answer TEXT,
  answered_at INTEGER,
  answered_by TEXT,
  published INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notice_asks ON notice_asks(notice_id);
CREATE TABLE IF NOT EXISTS notice_dismissed (
  notice_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (notice_id, user_id)
);
CREATE TABLE IF NOT EXISTS notice_nudges (
  notice_id TEXT NOT NULL,
  rev TEXT NOT NULL,
  user_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (notice_id, rev, user_id)
);
CREATE TABLE IF NOT EXISTS notice_days (
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  day TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (kind, ref, day)
);
CREATE VIRTUAL TABLE IF NOT EXISTS notice_fts USING fts5(title, body, pdf, notice_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
`;

const DEFAULT_DESKS: Array<{ code: string; name: string }> = [
  { code: 'MGT', name: 'Management' }, { code: 'HR', name: 'HR' }, { code: 'IT', name: 'IT' }, { code: 'ADM', name: 'Admin' },
];
const DAY = 86400_000;
/** Readers are reminded from this hour (office time), the issuing desk gets its digest from this one. */
const NUDGE_HOUR = 10;
const DIGEST_HOUR = 16;
const MAX_PDF_BYTES = 32 * 1024 * 1024;
const MAX_PDF_TEXT = 200_000;

interface DeskRow { id: string; code: string; name: string; seq: string; created_at: number }
interface NoticeRow {
  id: string; desk_id: string; category: string; number: string | null; status: NoticeStatus; rev: string | null; related: string; source_message: string | null;
  created_by: string; created_at: number; updated_at: number; withdrawn_at: number | null; withdrawn_by: string | null; withdraw_reason: string | null; archived_at: number | null;
}
interface RevRow {
  notice_id: string; rev: string; status: NoticeRevStatus; title: string; body: string; translations: string; file_id: string | null; pdf_text: string | null;
  change_note: string | null; changed: string; removed: number; reack: number; ack_required: number; checks: string; audience: string;
  issue_at: number | null; issued_at: number | null; effective_at: number | null; expires_at: number | null; standing: number; urgent: number; author_id: string; created_at: number;
}

export interface NoticeDeps {
  db: DatabaseSync;
  store: Store;
  files: FileStore;
  departments: () => Department[];
  /** Events to some people, worked out per person. */
  deliver: (userIds: string[], name: string, data: (userId: string) => unknown) => void;
  /** One quiet line to a person (from Nib, in their conversation with Nib), once per key. */
  tell: (userId: string, key: string, text: string) => void;
  /** Uses the app (has an approved device): the others are who the email copy is for. */
  hasApp: (userId: string) => boolean;
  /** A legal hold covers this person (their notices are kept past retention). */
  held: (userId: string) => boolean;
  /** The Office space's pinned messages, and taking a pin off once a message moves onto the board. */
  officePins: () => Array<{ id: string; body: string; author_id: string; created_at: number; files: FileInfo[] }>;
  unpin: (messageId: string) => void;
  audit: (actor: string | null, action: string, target: string | null, detail?: Record<string, unknown>) => void;
  log: (level: 'info' | 'warn' | 'error' | 'debug', msg: string, extra?: Record<string, unknown>) => void;
}

const strip = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const long = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max) : '');
const json = <T>(s: string | null | undefined, d: T): T => { if (!s) return d; try { const v = JSON.parse(s) as T; return v ?? d; } catch { return d; } };
const ids = (v: unknown, max = 500): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length <= 40))].slice(0, max) : []);
const time = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const isAdmin = (u: PublicUser) => u.role === 'owner' || u.role === 'admin';
const dayStart = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const stamp = (t: number | null) => (t ? new Date(t).toISOString().slice(0, 10) : '');

export function cleanAudience(v: unknown): NoticeAudience {
  const a = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    everyone: a.everyone === true,
    departments: ids(a.departments, 200),
    roles: (Array.isArray(a.roles) ? a.roles : []).filter((r): r is 'admin' | 'member' => r === 'admin' || r === 'member').filter((r, i, all) => all.indexOf(r) === i),
    locations: (Array.isArray(a.locations) ? a.locations : []).map((l) => strip(l, 80)).filter(Boolean).slice(0, 40),
    people: ids(a.people, 2000),
  };
}

export class NoticeBoard {
  private readonly d: NoticeDeps;
  private readonly db: DatabaseSync;
  private offset = 0;
  private lastPurge = 0;

  constructor(d: NoticeDeps) {
    this.d = d;
    this.db = d.db;
    this.db.exec(SCHEMA);
    if (!(this.db.prepare('SELECT COUNT(*) AS n FROM notice_desks').get() as { n: number }).n) {
      for (const desk of DEFAULT_DESKS) this.db.prepare('INSERT INTO notice_desks (id, code, name, created_at) VALUES (?, ?, ?, ?)').run(ulid(), desk.code, desk.name, Date.now());
    }
    // files attached to notices stay while their notice does
    d.files.keep.push('NOT EXISTS (SELECT 1 FROM notice_revs nr WHERE nr.file_id = f.id)');
  }

  // ------------------------------------------------------------ the clock
  now(): number { return Date.now() + this.offset; }
  /** Tests and the end-to-end walk (the hub object in the same process): move the board's clock, or back to real time with null. */
  setClock(at: number | null): void { this.offset = at === null ? 0 : at - Date.now(); }

  // ------------------------------------------------------------ desks
  private deskRows(): DeskRow[] { return this.db.prepare('SELECT * FROM notice_desks ORDER BY name COLLATE NOCASE').all() as unknown as DeskRow[]; }
  private desk(id: string): DeskRow | undefined { return this.db.prepare('SELECT * FROM notice_desks WHERE id = ?').get(id) as DeskRow | undefined; }
  private issuersOf(deskId: string): string[] { return (this.db.prepare('SELECT user_id FROM notice_issuers WHERE desk_id = ?').all(deskId) as Array<{ user_id: string }>).map((r) => r.user_id); }
  desks(): NoticeDesk[] {
    return this.deskRows().map((r) => ({
      id: r.id, code: r.code, name: r.name, issuers: this.issuersOf(r.id), createdAt: r.created_at,
      issued: (this.db.prepare(`SELECT COUNT(*) AS n FROM notices WHERE desk_id = ? AND number IS NOT NULL`).get(r.id) as { n: number }).n,
    }));
  }
  /** May this person draft and issue for the desk? */
  canIssue(me: PublicUser, deskId: string): boolean {
    if (me.role === 'guest' || me.role === 'bot') return false;
    if (isAdmin(me)) return !!this.desk(deskId);
    return !!this.db.prepare('SELECT 1 FROM notice_issuers WHERE desk_id = ? AND user_id = ?').get(deskId, me.id);
  }
  private myDesks(me: PublicUser): string[] { return this.deskRows().filter((r) => this.canIssue(me, r.id)).map((r) => r.id); }

  // ------------------------------------------------------------ reading rows
  private notice(id: unknown): NoticeRow | undefined { return typeof id === 'string' ? this.db.prepare('SELECT * FROM notices WHERE id = ?').get(id) as NoticeRow | undefined : undefined; }
  private revs(noticeId: string): RevRow[] {
    return (this.db.prepare('SELECT * FROM notice_revs WHERE notice_id = ?').all(noticeId) as unknown as RevRow[]).sort((a, b) => revOrder(b.rev, a.rev));
  }
  private rev(noticeId: string, rev: string | null): RevRow | undefined { return rev ? this.db.prepare('SELECT * FROM notice_revs WHERE notice_id = ? AND rev = ?').get(noticeId, rev) as RevRow | undefined : undefined; }
  /** The revision being written or scheduled. */
  private pending(noticeId: string): RevRow | undefined { return this.db.prepare(`SELECT * FROM notice_revs WHERE notice_id = ? AND status IN ('draft', 'scheduled')`).get(noticeId) as RevRow | undefined; }
  /** The revision readers see: the one in force, or before the first issue the draft. */
  private shown(n: NoticeRow): RevRow | undefined { return this.rev(n.id, n.rev) ?? this.pending(n.id); }

  /** Department ids with every department under them. */
  private expand(list: string[]): Set<string> {
    const out = new Set(list);
    if (!list.length) return out;
    const all = this.d.departments();
    for (let changed = true, guard = 0; changed && guard < 50; guard++) {
      changed = false;
      for (const dep of all) if (dep.parentId && out.has(dep.parentId) && !out.has(dep.id)) { out.add(dep.id); changed = true; }
    }
    return out;
  }
  /** Everyone a revision is for, now (people join and move). */
  private audienceOf(r: RevRow, users = this.d.store.activeUsers()): PublicUser[] {
    const a = cleanAudience(json(r.audience, {}));
    const deps = this.expand(a.departments);
    return users.filter((u) => inAudience(u, a, deps));
  }
  private inAudienceOf(u: PublicUser, r: RevRow): boolean {
    const a = cleanAudience(json(r.audience, {}));
    return inAudience(u, a, this.expand(a.departments));
  }

  /** May this person see the notice at all? Issuers see their desk's drafts; readers what was issued for them. */
  canSee(me: PublicUser, n: NoticeRow): boolean {
    if (me.role === 'guest' || me.role === 'bot') return false;
    if (this.canIssue(me, n.desk_id)) return true;
    if (!n.rev) return false;
    const r = this.rev(n.id, n.rev);
    return !!r && this.inAudienceOf(me, r);
  }
  private visible(id: unknown, me: PublicUser): NoticeRow {
    const n = this.notice(id);
    if (!n || !this.canSee(me, n)) throw new NoticeError('Notice not found.');
    return n;
  }

  /** The revision from which acknowledgements count: the latest that asked again, else the first issued. */
  private ackBase(noticeId: string, upTo: string): string | null {
    const issued = this.revs(noticeId).filter((r) => r.issued_at !== null && revOrder(r.rev, upTo) <= 0).sort((a, b) => revOrder(a.rev, b.rev));
    if (!issued.length) return null;
    let base = issued[0].rev;
    for (const r of issued) if (r.reack) base = r.rev;
    return base;
  }
  private ackOf(noticeId: string, userId: string, base: string | null): { rev: string; at: number } | null {
    if (!base) return null;
    const rows = this.db.prepare('SELECT rev, at FROM notice_acks WHERE notice_id = ? AND user_id = ?').all(noticeId, userId) as Array<{ rev: string; at: number }>;
    const ok = rows.filter((r) => revOrder(r.rev, base) >= 0).sort((a, b) => revOrder(b.rev, a.rev));
    return ok[0] ?? null;
  }
  private ackedSet(noticeId: string, base: string | null): Map<string, number> {
    const out = new Map<string, number>();
    if (!base) return out;
    for (const r of this.db.prepare('SELECT rev, user_id, at FROM notice_acks WHERE notice_id = ?').all(noticeId) as Array<{ rev: string; user_id: string; at: number }>) {
      if (revOrder(r.rev, base) >= 0 && !out.has(r.user_id)) out.set(r.user_id, r.at);
    }
    return out;
  }

  private revView(r: RevRow, defs = false): NoticeRevision & { checkDefs?: NoticeCheckDef[] } {
    const checks = json<NoticeCheckDef[]>(r.checks, []);
    return {
      rev: r.rev, status: r.status, title: r.title, body: r.body, translations: json(r.translations, {}), file: r.file_id ? this.d.files.info(r.file_id) : null,
      changeNote: r.change_note, changed: json(r.changed, []), removed: r.removed, reack: !!r.reack, ackRequired: !!r.ack_required,
      checks: checks.map((c) => ({ id: c.id, prompt: c.prompt, options: c.options })), audience: cleanAudience(json(r.audience, {})),
      issueAt: r.issue_at, issuedAt: r.issued_at, effectiveAt: r.effective_at, expiresAt: r.expires_at, standing: !!r.standing, urgent: !!r.urgent,
      authorId: r.author_id, createdAt: r.created_at, ...(defs ? { checkDefs: checks } : {}),
    };
  }

  summary(n: NoticeRow, me: PublicUser, users?: PublicUser[]): NoticeSummary | null {
    const r = this.shown(n);
    const desk = this.desk(n.desk_id);
    if (!r || !desk) return null;
    const issuer = this.canIssue(me, n.desk_id);
    const base = n.rev ? this.ackBase(n.id, n.rev) : null;
    const mine = this.ackOf(n.id, me.id, base);
    const seen = this.db.prepare('SELECT rev FROM notice_seen WHERE notice_id = ? AND user_id = ?').get(n.id, me.id) as { rev: string } | undefined;
    const pend = issuer ? this.pending(n.id) : undefined;
    let acks: NoticeSummary['acks'] = null;
    if (issuer && n.rev && r.ack_required) {
      const aud = this.audienceOf(r, users);
      const done = this.ackedSet(n.id, base);
      acks = { done: aud.filter((u) => done.has(u.id)).length, total: aud.length };
    }
    const tr = json<Partial<Record<NoticeLang, NoticeText>>>(r.translations, {});
    const forMe = n.rev ? this.inAudienceOf(me, r) : false;
    return {
      id: n.id, number: n.number, rev: r.rev, deskId: desk.id, deskCode: desk.code, deskName: desk.name, category: n.category as NoticeCategory,
      title: r.title, status: n.status, urgent: !!r.urgent, standing: !!r.standing, issuedAt: r.issued_at, issueAt: r.status === 'scheduled' ? r.issue_at : null,
      effectiveAt: r.effective_at, expiresAt: r.expires_at, ackRequired: !!r.ack_required, acked: !!mine, ackedAt: mine?.at ?? null,
      needsAck: n.status === 'issued' && !!r.ack_required && forMe && !mine,
      seen: !!seen && !!n.rev && revOrder(seen.rev, n.rev) >= 0, file: r.file_id ? this.d.files.info(r.file_id) : null,
      langs: NOTICE_LANGS.filter((l) => tr[l]?.title || tr[l]?.body), titles: Object.fromEntries(NOTICE_LANGS.filter((l) => tr[l]?.title).map((l) => [l, tr[l]!.title])),
      audience: cleanAudience(json(r.audience, {})), authorId: r.author_id, updatedAt: n.updated_at, acks,
      pendingRev: pend && n.rev ? { rev: pend.rev, status: pend.status as 'draft' | 'scheduled', issueAt: pend.issue_at } : null,
    };
  }

  private nextNumber(n: NoticeRow): string {
    const desk = this.desk(n.desk_id);
    if (!desk) return '';
    const seq = json<Record<string, number>>(desk.seq, {});
    return noticeNumber(desk.code, n.category as NoticeCategory, (seq[categoryCode(n.category as NoticeCategory)] ?? 0) + 1);
  }

  view(n: NoticeRow, me: PublicUser): NoticeView {
    const s = this.summary(n, me);
    if (!s) throw new NoticeError('Notice not found.');
    const issuer = this.canIssue(me, n.desk_id);
    const all = this.revs(n.id);
    const pend = this.pending(n.id);
    const issued = all.filter((r) => r.issued_at !== null);
    const shown = this.shown(n)!;
    const asks = (this.db.prepare('SELECT * FROM notice_asks WHERE notice_id = ? ORDER BY at').all(n.id) as Array<{ id: string; user_id: string; text: string; at: number; answer: string | null; answered_at: number | null; published: number }>)
      .map((a): NoticeAsk => ({ id: a.id, userId: a.user_id, text: a.text, at: a.at, answer: a.answer, answeredAt: a.answered_at, published: !!a.published }));
    const faq: NoticeFaq[] = asks.filter((a) => a.published && a.answer).map((a) => ({ id: a.id, question: a.text, answer: a.answer!, at: a.answeredAt ?? a.at }));
    const base = n.rev ? this.ackBase(n.id, n.rev) : null;
    // related: what the author linked, then the desk's other notices of the same kind
    const linked = json<string[]>(n.related, []).map((id) => this.notice(id)).filter((x): x is NoticeRow => !!x && x.id !== n.id && !!x.rev && this.canSee(me, x));
    const same = (this.db.prepare(`SELECT * FROM notices WHERE desk_id = ? AND category = ? AND id != ? AND rev IS NOT NULL ORDER BY updated_at DESC LIMIT 12`).all(n.desk_id, n.category, n.id) as unknown as NoticeRow[]).filter((x) => this.canSee(me, x));
    const related = [...new Map([...linked, ...same].map((x) => [x.id, x] as const)).values()].slice(0, 5).map((x) => this.summary(x, me)).filter((x): x is NoticeSummary => !!x);
    return {
      ...s,
      revisions: [...(issuer && pend ? [pend] : []), ...issued].map((r) => this.revView(r)),
      current: this.revView(shown),
      draft: issuer && pend ? this.revView(pend, true) as NoticeView['draft'] : null,
      faq, related,
      asked: asks.filter((a) => a.userId === me.id),
      inbox: issuer ? asks : null,
      canIssue: issuer,
      withdrawn: n.withdrawn_at ? { at: n.withdrawn_at, by: n.withdrawn_by ?? '', reason: n.withdraw_reason ?? '' } : null,
      ackedRev: this.ackOf(n.id, me.id, base)?.rev ?? null,
      nextNumber: n.number ?? this.nextNumber(n),
    };
  }

  list(me: PublicUser): NoticeList {
    if (me.role === 'guest' || me.role === 'bot') return { notices: [], desks: [], canIssue: [], banner: null, canUrgent: false };
    const users = this.d.store.activeUsers();
    const rows = this.db.prepare('SELECT * FROM notices ORDER BY updated_at DESC LIMIT 2000').all() as unknown as NoticeRow[];
    const notices = rows.filter((n) => this.canSee(me, n)).map((n) => this.summary(n, me, users)).filter((x): x is NoticeSummary => !!x);
    const now = this.now();
    const dismissed = new Set((this.db.prepare('SELECT notice_id FROM notice_dismissed WHERE user_id = ?').all(me.id) as Array<{ notice_id: string }>).map((r) => r.notice_id));
    const banner = notices.filter((x) => x.urgent && x.status === 'issued' && !dismissed.has(x.id) && (x.expiresAt ?? Infinity) > now && x.issuedAt !== null)
      .filter((x) => this.inAudienceOf(me, this.rev(x.id, x.rev)!))
      .sort((a, b) => (b.issuedAt ?? 0) - (a.issuedAt ?? 0))[0] ?? null;
    return { notices, desks: this.desks(), canIssue: this.myDesks(me), banner, canUrgent: isAdmin(me) };
  }

  // ------------------------------------------------------------ search
  private index(n: NoticeRow): void {
    this.db.prepare('DELETE FROM notice_fts WHERE notice_id = ?').run(n.id);
    const r = n.rev ? this.rev(n.id, n.rev) : undefined;
    if (!r) return;
    const tr = json<Partial<Record<NoticeLang, NoticeText>>>(r.translations, {});
    const title = [n.number ?? '', r.title, ...NOTICE_LANGS.map((l) => tr[l]?.title ?? '')].join(' ');
    const body = [r.body, ...NOTICE_LANGS.map((l) => tr[l]?.body ?? '')].join('\n\n');
    this.db.prepare('INSERT INTO notice_fts (title, body, pdf, notice_id) VALUES (?, ?, ?, ?)').run(title, body, r.pdf_text ?? '', n.id);
  }

  search(me: PublicUser, rawQ: unknown, limit = 20): NoticeHit[] {
    if (me.role === 'guest' || me.role === 'bot') return [];
    const q = typeof rawQ === 'string' ? rawQ.slice(0, 200) : '';
    // a notice number matches as it is written (HR-POL-0012, or part of it)
    const num = q.match(/\b[A-Z]{2,4}-[A-Z]{3}-\d{1,4}\b/i)?.[0]?.toUpperCase();
    const terms = q.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_]*/gu)?.slice(0, 8) ?? [];
    if (!terms.length) return [];
    const match = terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(' ');
    let rows: Array<{ notice_id: string; t: string; b: string; p: string }> = [];
    try {
      rows = this.db.prepare(`SELECT notice_id, snippet(notice_fts, 0, '[[', ']]', '…', 10) AS t, snippet(notice_fts, 1, '[[', ']]', '…', 14) AS b, snippet(notice_fts, 2, '[[', ']]', '…', 14) AS p
        FROM notice_fts WHERE notice_fts MATCH ? ORDER BY rank LIMIT 200`).all(match) as typeof rows;
    } catch { rows = []; }
    const out: NoticeHit[] = [];
    const seen = new Set<string>();
    if (num) {
      const n = this.db.prepare('SELECT * FROM notices WHERE number = ?').get(num) as NoticeRow | undefined;
      if (n && this.canSee(me, n)) { const s = this.summary(n, me); if (s) { out.push({ notice: s, snippet: s.title, where: 'title' }); seen.add(n.id); } }
    }
    for (const r of rows) {
      if (out.length >= limit) break;
      if (seen.has(r.notice_id)) continue;
      const n = this.notice(r.notice_id);
      if (!n || !this.canSee(me, n)) continue;
      const s = this.summary(n, me);
      if (!s) continue;
      seen.add(n.id);
      const where: NoticeHit['where'] = r.t.includes('[[') ? 'title' : r.b.includes('[[') ? 'text' : r.p.includes('[[') ? 'pdf' : 'text';
      out.push({ notice: s, snippet: where === 'title' ? s.title : where === 'pdf' ? r.p : r.b, where });
    }
    return out;
  }

  /** May this person open the file (an attachment of a notice they can see)? */
  mayReadFile(userId: string, fileId: string): boolean {
    const rows = this.db.prepare('SELECT notice_id, issued_at FROM notice_revs WHERE file_id = ?').all(fileId) as Array<{ notice_id: string; issued_at: number | null }>;
    if (!rows.length) return false;
    const u = this.d.store.userById(userId);
    if (!u) return false;
    // readers open what was issued to them; a draft revision's new PDF is the desk's until it is issued
    return rows.some((r) => { const n = this.notice(r.notice_id); return !!n && this.canSee(u, n) && (r.issued_at !== null || this.canIssue(u, n.desk_id)); });
  }

  // ------------------------------------------------------------ writing
  private pdfText(fileId: string): string | null {
    const info = this.d.files.info(fileId);
    if (!info || !(info.mime === 'application/pdf' || /\.pdf$/i.test(info.name))) return null;
    const buf = this.d.files.read(fileId, MAX_PDF_BYTES);
    if (!buf) return null;
    try { return readPdf(buf, info.name).lines.join('\n').slice(0, MAX_PDF_TEXT) || null; } catch (err) {
      if (!(err instanceof PdfError)) this.d.log('warn', 'notice pdf text', { error: (err as Error).message });
      return null;
    }
  }

  private checksFrom(v: unknown): NoticeCheckDef[] {
    const list = Array.isArray(v) ? v : [];
    if (list.length > NOTICE_MAX_QUESTIONS) throw new NoticeError(`A notice can have up to ${NOTICE_MAX_QUESTIONS} check questions.`);
    return list.map((raw, i) => {
      const x = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const prompt = strip(x.prompt, NOTICE_LIMITS.prompt);
      if (!prompt) throw new NoticeError(`Check question ${i + 1} needs a question.`);
      const options = (Array.isArray(x.options) ? x.options : []).map((o) => strip(o, NOTICE_LIMITS.option)).filter(Boolean);
      if (options.length < 2 || options.length > 4) throw new NoticeError(`“${prompt.slice(0, 60)}” needs two to four answers.`);
      if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) throw new NoticeError(`“${prompt.slice(0, 60)}” has the same answer twice.`);
      const answer = typeof x.answer === 'number' && Number.isInteger(x.answer) ? x.answer : -1;
      if (answer < 0 || answer >= options.length) throw new NoticeError(`Mark the right answer to “${prompt.slice(0, 60)}”.`);
      return { id: `q${i + 1}`, prompt, options, answer };
    });
  }

  private translationsFrom(v: unknown): Partial<Record<NoticeLang, NoticeText>> {
    const t = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    const out: Partial<Record<NoticeLang, NoticeText>> = {};
    for (const l of NOTICE_LANGS) {
      const x = (t[l] && typeof t[l] === 'object' ? t[l] : {}) as Record<string, unknown>;
      const title = strip(x.title, NOTICE_LIMITS.title);
      const body = long(x.body, NOTICE_LIMITS.body);
      if (title || body) out[l] = { title, body };
    }
    return out;
  }

  private save(me: PublicUser, d: Record<string, unknown>): NoticeRow {
    const now = this.now();
    const existing = d.id !== undefined ? this.notice(d.id) : undefined;
    if (d.id !== undefined && !existing) throw new NoticeError('Notice not found.');
    const deskId = existing ? existing.desk_id : String(d.deskId ?? '');
    if (!this.desk(deskId)) throw new NoticeError('Choose the desk that issues it.');
    if (!this.canIssue(me, deskId)) throw new NoticeError('Only the desk’s issuers can write its notices.');
    if (existing && (existing.status === 'withdrawn' || existing.status === 'expired')) throw new NoticeError('This notice is no longer in force. Write a new one.');
    const category = existing && existing.number ? existing.category as NoticeCategory : isNoticeCategory(d.category) ? d.category : null;
    if (!category) throw new NoticeError('Choose what kind of notice it is.');
    const title = strip(d.title, NOTICE_LIMITS.title);
    if (!title) throw new NoticeError('Give the notice a title.');
    const body = long(d.body, NOTICE_LIMITS.body);
    const audience = cleanAudience(d.audience);
    if (emptyAudience(audience)) throw new NoticeError('Choose who the notice is for.');
    const ackRequired = d.ackRequired === true;
    const checks = ackRequired ? this.checksFrom(d.checks) : [];
    const urgent = d.urgent === true;
    if (urgent && !isAdmin(me)) throw new NoticeError('Only administrators can issue urgent notices.');
    const effectiveAt = time(d.effectiveAt);
    const expiresAt = time(d.expiresAt);
    if (expiresAt !== null && effectiveAt !== null && expiresAt <= effectiveAt) throw new NoticeError('It has to expire after it takes effect.');
    if (expiresAt !== null && expiresAt <= now) throw new NoticeError('Choose an expiry in the future.');
    let fileId: string | null = typeof d.fileId === 'string' && d.fileId ? d.fileId : null;
    if (fileId && !this.d.files.info(fileId)) throw new NoticeError('That file is no longer on the hub. Attach it again.');
    if (fileId && !this.d.files.canRead(me.id, fileId)) throw new NoticeError('That file cannot be attached.');
    const related = ids(d.related, 10).filter((id) => id !== existing?.id && !!this.notice(id));
    const standing = typeof d.standing === 'boolean' ? d.standing : category === 'policy';
    const translations = this.translationsFrom(d.translations);
    const changeNote = strip(d.changeNote, NOTICE_LIMITS.changeNote) || null;
    const reack = d.reack === true;
    if (!body && !fileId) throw new NoticeError('Write the notice, or attach its PDF.');

    let n = existing;
    if (!n) {
      const id = ulid();
      this.db.prepare(`INSERT INTO notices (id, desk_id, category, status, related, created_by, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)`)
        .run(id, deskId, category, JSON.stringify(related), me.id, now, now);
      n = this.notice(id)!;
      this.d.audit(me.id, 'notice.drafted', id, { desk: this.desk(deskId)?.code, category });
    } else {
      this.db.prepare('UPDATE notices SET category = ?, related = ?, updated_at = ? WHERE id = ?').run(category, JSON.stringify(related), now, n.id);
    }
    const pend = this.pending(n.id);
    if (pend?.status === 'scheduled') throw new NoticeError('It is scheduled. Take it back to a draft first.');
    const prior = pend ? (pend.file_id === fileId ? pend.pdf_text : undefined) : n.rev ? (this.rev(n.id, n.rev)?.file_id === fileId ? this.rev(n.id, n.rev)?.pdf_text : undefined) : undefined;
    const pdfText = fileId ? (prior !== undefined ? prior : this.pdfText(fileId)) : null;
    if (!fileId) fileId = null;
    const cols = [title, body, JSON.stringify(translations), fileId, pdfText, changeNote, reack ? 1 : 0, ackRequired ? 1 : 0, JSON.stringify(checks), JSON.stringify(audience), effectiveAt, expiresAt, standing ? 1 : 0, urgent ? 1 : 0] as const;
    if (pend) {
      this.db.prepare(`UPDATE notice_revs SET title = ?, body = ?, translations = ?, file_id = ?, pdf_text = ?, change_note = ?, reack = ?, ack_required = ?, checks = ?, audience = ?,
        effective_at = ?, expires_at = ?, standing = ?, urgent = ?, author_id = ? WHERE notice_id = ? AND rev = ?`).run(...cols, me.id, n.id, pend.rev);
    } else {
      const rev = nextRev(this.revs(n.id).filter((r) => r.issued_at !== null)[0]?.rev ?? null);
      this.db.prepare(`INSERT INTO notice_revs (title, body, translations, file_id, pdf_text, change_note, reack, ack_required, checks, audience, effective_at, expires_at, standing, urgent,
        author_id, notice_id, rev, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`).run(...cols, me.id, n.id, rev, now);
      if (n.rev) this.d.audit(me.id, 'notice.revising', n.id, { number: n.number, rev });
    }
    this.touch(n.id, false);
    return this.notice(n.id)!;
  }

  private urgentToday(now: number, except: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM notice_revs WHERE urgent = 1 AND issued_at >= ? AND notice_id != ?`).get(now - DAY, except) as { n: number }).n;
  }

  /** Issue a revision now: the one before is superseded, the notice is numbered if it is new. */
  private issueNow(n: NoticeRow, r: RevRow, actor: string | null, now = this.now()): void {
    if (r.urgent && this.urgentToday(now, n.id) >= NOTICE_URGENT_PER_DAY) throw new NoticeError(`The office can have ${NOTICE_URGENT_PER_DAY} urgent notices a day. Issue this one as an ordinary notice.`);
    const before = n.rev ? this.rev(n.id, n.rev) : undefined;
    const diff = before ? changedParagraphs(before.body, r.body) : { changed: [], removed: 0 };
    let number = n.number;
    if (!number) {
      const desk = this.desk(n.desk_id)!;
      const seq = json<Record<string, number>>(desk.seq, {});
      const code = categoryCode(n.category as NoticeCategory);
      // a number is given once: skip any already taken (an imported or restored register)
      let next = (seq[code] ?? 0) + 1;
      while (this.db.prepare('SELECT 1 FROM notices WHERE number = ?').get(noticeNumber(desk.code, n.category as NoticeCategory, next)) && next < 100_000) next++;
      seq[code] = next;
      number = noticeNumber(desk.code, n.category as NoticeCategory, next);
      this.db.prepare('UPDATE notice_desks SET seq = ? WHERE id = ?').run(JSON.stringify(seq), desk.id);
    }
    let expires = r.expires_at;
    if (r.urgent) expires = Math.min(expires ?? now + NOTICE_URGENT_DEFAULT_MS, now + NOTICE_URGENT_MAX_MS);
    if (before) this.db.prepare(`UPDATE notice_revs SET status = 'superseded' WHERE notice_id = ? AND rev = ?`).run(n.id, before.rev);
    this.db.prepare(`UPDATE notice_revs SET status = 'issued', issued_at = ?, issue_at = NULL, changed = ?, removed = ?, expires_at = ?, effective_at = COALESCE(effective_at, ?) WHERE notice_id = ? AND rev = ?`)
      .run(now, JSON.stringify(diff.changed), diff.removed, expires, now, n.id, r.rev);
    this.db.prepare(`UPDATE notices SET status = 'issued', rev = ?, number = ?, updated_at = ? WHERE id = ?`).run(r.rev, number, now, n.id);
    const fresh = this.notice(n.id)!;
    this.index(fresh);
    this.d.audit(actor, 'notice.issued', n.id, { number, rev: r.rev, reack: !!r.reack, urgent: !!r.urgent, scheduled: r.status === 'scheduled' });
    this.touch(n.id, true);
  }

  /** Tell everyone who can see it that it changed (with the line for those it was just issued to). */
  private touch(noticeId: string, issued: boolean): void {
    const n = this.notice(noticeId);
    if (!n) return;
    const users = this.d.store.activeUsers();
    const issuers = new Set([...this.issuersOf(n.desk_id), ...users.filter(isAdmin).map((u) => u.id)]);
    const r = n.rev ? this.rev(n.id, n.rev) : undefined;
    const aud = r ? this.audienceOf(r, users).map((u) => u.id) : [];
    const to = [...new Set([...aud, ...issuers])];
    const audSet = new Set(aud);
    this.d.deliver(to, 'notices.changed', (uid) => {
      if (!issued || !audSet.has(uid)) return { id: noticeId };
      const u = this.d.store.userById(uid);
      const s = u ? this.summary(n, u, users) : null;
      return s ? { id: noticeId, issued: s } : { id: noticeId };
    });
  }

  // ------------------------------------------------------------ the timer
  /** Scheduled issues, expiry, reminders to readers, the issuing desks' digest, retention. */
  tick(at?: number): void {
    const now = at ?? this.now();
    for (const r of this.db.prepare(`SELECT * FROM notice_revs WHERE status = 'scheduled' AND issue_at <= ?`).all(now) as unknown as RevRow[]) {
      const n = this.notice(r.notice_id);
      if (!n || n.status === 'withdrawn' || n.status === 'expired') continue;
      try { this.issueNow(n, r, r.author_id, now); } catch (err) {
        // it cannot go out as planned (the day's urgent notices): back to a draft, and the author is told
        this.db.prepare(`UPDATE notice_revs SET status = 'draft', issue_at = NULL WHERE notice_id = ? AND rev = ?`).run(r.notice_id, r.rev);
        this.d.tell(r.author_id, `notice-unscheduled-${r.notice_id}-${r.rev}`, `“${r.title}” was not issued at the scheduled time: ${(err as Error).message}`);
        this.touch(r.notice_id, false);
      }
    }
    for (const n of this.db.prepare(`SELECT n.* FROM notices n JOIN notice_revs r ON r.notice_id = n.id AND r.rev = n.rev WHERE n.status = 'issued' AND r.expires_at IS NOT NULL AND r.expires_at <= ?`).all(now) as unknown as NoticeRow[]) {
      this.db.prepare(`UPDATE notices SET status = 'expired', archived_at = ?, updated_at = ? WHERE id = ?`).run(now, now, n.id);
      this.d.audit(null, 'notice.expired', n.id, { number: n.number, rev: n.rev });
      this.touch(n.id, false);
    }
    const hour = new Date(now).getHours();
    if (hour >= NUDGE_HOUR) this.nudgeReaders(now);
    if (hour >= DIGEST_HOUR) this.digest(now);
    if (now - this.lastPurge > 3600_000 || now < this.lastPurge) { this.lastPurge = now; this.purge(now); }
  }

  /** Who has not acknowledged each notice in force that asks for it, issued before a moment. */
  private outstanding(before: number, users = this.d.store.activeUsers()): Array<{ n: NoticeRow; r: RevRow; waiting: PublicUser[]; total: number }> {
    const rows = this.db.prepare(`SELECT n.* FROM notices n JOIN notice_revs r ON r.notice_id = n.id AND r.rev = n.rev WHERE n.status = 'issued' AND r.ack_required = 1 AND r.issued_at < ?`).all(before) as unknown as NoticeRow[];
    return rows.map((n) => {
      const r = this.rev(n.id, n.rev)!;
      const aud = this.audienceOf(r, users);
      const done = this.ackedSet(n.id, this.ackBase(n.id, n.rev!));
      return { n, r, waiting: aud.filter((u) => !done.has(u.id)), total: aud.length };
    }).filter((x) => x.waiting.length);
  }

  private once(kind: string, ref: string, day: string, now: number): boolean {
    return Number(this.db.prepare('INSERT OR IGNORE INTO notice_days (kind, ref, day, at) VALUES (?, ?, ?, ?)').run(kind, ref, day, now).changes) > 0;
  }
  private doneToday(kind: string, ref: string, day: string): boolean { return !!this.db.prepare('SELECT 1 FROM notice_days WHERE kind = ? AND ref = ? AND day = ?').get(kind, ref, day); }

  private readerLine(items: Array<{ n: NoticeRow; r: RevRow }>): string {
    const one = (x: { n: NoticeRow; r: RevRow }) => `${x.n.number} Rev ${x.r.rev}, ${x.r.title}`;
    return items.length === 1
      ? `A notice is waiting for you to read and acknowledge: ${one(items[0])}. Open the notice board when you have a moment.`
      : `${items.length} notices are waiting for you to read and acknowledge: ${items.map(one).join('; ')}. Open the notice board when you have a moment.`;
  }

  /** Reminds each person once a day at most, with everything waiting for them in one line. */
  private remindPeople(people: Map<string, Array<{ n: NoticeRow; r: RevRow }>>, now: number): number {
    const day = localDate(now);
    let sent = 0;
    for (const [uid, all] of people) {
      if (this.doneToday('reader', uid, day)) continue;
      const items = all.filter((x) => ((this.db.prepare('SELECT n FROM notice_nudges WHERE notice_id = ? AND rev = ? AND user_id = ?').get(x.n.id, x.r.rev, uid) as { n: number } | undefined)?.n ?? 0) < NOTICE_MAX_NUDGES);
      if (!items.length) continue;
      if (!this.once('reader', uid, day, now)) continue;
      this.d.tell(uid, `notices-${day}-${uid}`, this.readerLine(items));
      for (const x of items) {
        this.db.prepare(`INSERT INTO notice_nudges (notice_id, rev, user_id, n, last_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT(notice_id, rev, user_id) DO UPDATE SET n = n + 1, last_at = excluded.last_at`).run(x.n.id, x.r.rev, uid, now);
      }
      sent++;
    }
    return sent;
  }

  private nudgeReaders(now: number): void {
    const day = localDate(now);
    if (this.doneToday('round', 'readers', day)) return;
    const people = new Map<string, Array<{ n: NoticeRow; r: RevRow }>>();
    // only what was issued before today: a notice is not chased on the day it comes out
    for (const x of this.outstanding(dayStart(now))) for (const u of x.waiting) people.set(u.id, [...(people.get(u.id) ?? []), { n: x.n, r: x.r }]);
    this.remindPeople(people, now);
    this.once('round', 'readers', day, now);
  }

  /** Each issuer gets one line a day: their desks' notices still waiting, by department. */
  private digest(now: number): void {
    const day = localDate(now);
    if (this.doneToday('round', 'digest', day)) return;
    const deps = new Map(this.d.departments().map((x) => [x.id, x.name] as const));
    const waiting = this.outstanding(dayStart(now));
    const byIssuer = new Map<string, string[]>();
    for (const x of waiting) {
      const counts = new Map<string, number>();
      for (const u of x.waiting) { const k = deps.get(u.profile.departmentId ?? '') ?? 'No department'; counts.set(k, (counts.get(k) ?? 0) + 1); }
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${v}`).join(', ');
      const line = `${x.n.number} Rev ${x.r.rev} ${x.r.title}: ${x.total - x.waiting.length} of ${x.total} (waiting: ${top})`;
      for (const uid of this.issuersOf(x.n.desk_id)) byIssuer.set(uid, [...(byIssuer.get(uid) ?? []), line]);
    }
    for (const [uid, lines] of byIssuer) {
      if (!this.once('digest', uid, day, now)) continue;
      this.d.tell(uid, `notices-digest-${day}-${uid}`, `Acknowledgements still outstanding on your desk’s notices. ${lines.join('. ')}. Reminders to readers go once a day at most.`);
    }
    this.once('round', 'digest', day, now);
  }

  retentionDays(): number | null {
    const v = this.d.store.meta('notice_retention_days', () => '');
    return v === '' ? null : Number(v);
  }

  /** Withdrawn and expired notices past the office's retention go, unless their author is on hold. */
  purge(now = this.now()): number {
    const days = this.retentionDays();
    if (days === null) return 0;
    const rows = this.db.prepare(`SELECT * FROM notices WHERE status IN ('withdrawn', 'expired') AND COALESCE(archived_at, withdrawn_at) < ? LIMIT 500`).all(now - days * DAY) as unknown as NoticeRow[];
    let gone = 0;
    for (const n of rows) {
      if (this.revs(n.id).some((r) => this.d.held(r.author_id)) || this.d.held(n.created_by)) continue;
      this.drop(n.id);
      gone++;
    }
    if (gone) this.d.audit(null, 'notice.purged', null, { notices: gone });
    return gone;
  }

  private drop(id: string): void {
    for (const t of ['notice_revs', 'notice_acks', 'notice_seen', 'notice_asks', 'notice_dismissed', 'notice_nudges', 'notice_fts']) this.db.prepare(`DELETE FROM ${t} WHERE notice_id = ?`).run(id);
    this.db.prepare('DELETE FROM notices WHERE id = ?').run(id);
  }

  // ------------------------------------------------------------ the email copy and the register export
  private audienceText(a: NoticeAudience): string {
    if (a.everyone) return 'Everyone';
    const deps = new Map(this.d.departments().map((x) => [x.id, x.name] as const));
    const names = new Map(this.d.store.activeUsers().map((u) => [u.id, u.displayName] as const));
    return [
      a.departments.length ? `Departments: ${a.departments.map((x) => deps.get(x) ?? 'a former department').join(', ')}` : '',
      a.roles.length ? `Roles: ${a.roles.map((x) => (x === 'admin' ? 'Administrators' : 'Members')).join(', ')}` : '',
      a.locations.length ? `Locations: ${a.locations.join(', ')}` : '',
      a.people.length ? `People: ${a.people.map((x) => names.get(x) ?? 'a former colleague').join(', ')}` : '',
    ].filter(Boolean).join('; ');
  }

  private emailCopy(n: NoticeRow, me: PublicUser): Ops['notices.emailCopy']['res'] {
    const r = this.rev(n.id, n.rev);
    if (!r) throw new NoticeError('Issue the notice first.');
    const desk = this.desk(n.desk_id)!;
    const without = this.audienceOf(r).filter((u) => !this.d.hasApp(u.id));
    const to = without.filter((u) => u.profile.email).map((u) => ({ name: u.displayName, email: u.profile.email! }));
    const meta: Array<[string, string]> = [
      ['Issued by', `${desk.name} (${me.displayName})`], ['Number', `${n.number} Rev ${r.rev}`], ['Issued', stamp(r.issued_at)],
      ['Effective', stamp(r.effective_at)], ...(r.expires_at ? [['Expires', stamp(r.expires_at)] as [string, string]] : []), ['For', this.audienceText(cleanAudience(json(r.audience, {})))],
    ];
    const ack = r.ack_required ? 'This notice asks you to acknowledge that you have read and understood it. Please reply to say so, or acknowledge it on the notice board.' : '';
    const change = r.change_note ? `What changed in Rev ${r.rev}: ${r.change_note}` : '';
    const text = [r.title, '', ...meta.map(([k, v]) => `${k}: ${v}`), '', r.body, ...(change ? ['', change] : []), ...(ack ? ['', ack] : []), '', 'The notice, with its attachment, is on the notice board in Dexterity Connect.'].join('\n');
    const html = `<div style="font:14px Segoe UI,system-ui,sans-serif;max-width:680px"><table style="border-collapse:collapse;width:100%;border:1px solid #9bb">`
      + `<tr><td colspan="2" style="padding:10px;border-bottom:1px solid #9bb;font-size:18px;font-weight:600">${esc(r.title)}</td></tr>`
      + meta.map(([k, v]) => `<tr><td style="padding:4px 10px;border-bottom:1px solid #cdd;color:#456;font:11px Consolas,monospace;text-transform:uppercase;width:120px">${esc(k)}</td><td style="padding:4px 10px;border-bottom:1px solid #cdd">${esc(v)}</td></tr>`).join('')
      + `</table>${r.body.split(/\n[ \t]*\n+/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}${change ? `<p style="border-left:3px solid #1c7680;padding-left:8px">${esc(change)}</p>` : ''}${ack ? `<p><b>${esc(ack)}</b></p>` : ''}`
      + '<p style="color:#567">The notice, with its attachment, is on the notice board in Dexterity Connect.</p></div>';
    this.d.audit(me.id, 'notice.emailCopy', n.id, { number: n.number, rev: r.rev, to: to.length });
    return { to, withoutEmail: without.length - to.length, subject: `${n.number} Rev ${r.rev}: ${r.title}`, text, html };
  }

  private exportRegister(me: PublicUser, format: 'json' | 'csv' | 'html'): Ops['admin.notices.export']['res'] {
    const users = new Map(this.d.store.activeUsers().map((u) => [u.id, u] as const));
    const who = (id: string | null) => (id ? users.get(id)?.displayName ?? this.d.store.userById(id)?.displayName ?? id : '');
    const rows = this.db.prepare('SELECT * FROM notices ORDER BY created_at').all() as unknown as NoticeRow[];
    const out = rows.map((n) => {
      const desk = this.desk(n.desk_id);
      return {
        id: n.id, number: n.number, desk: desk?.name ?? '', category: n.category, status: n.status, createdBy: who(n.created_by),
        withdrawn: n.withdrawn_at ? { at: new Date(n.withdrawn_at).toISOString(), by: who(n.withdrawn_by), reason: n.withdraw_reason } : null,
        archivedAt: n.archived_at ? new Date(n.archived_at).toISOString() : null,
        revisions: this.revs(n.id).map((r) => ({
          rev: r.rev, status: r.status, title: r.title, body: r.body, author: who(r.author_id), audience: this.audienceText(cleanAudience(json(r.audience, {}))),
          issuedAt: r.issued_at ? new Date(r.issued_at).toISOString() : null, effectiveAt: r.effective_at ? new Date(r.effective_at).toISOString() : null,
          expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null, changeNote: r.change_note, ackRequired: !!r.ack_required, reack: !!r.reack,
          file: r.file_id ? this.d.files.info(r.file_id)?.name ?? null : null,
          acknowledgements: (this.db.prepare('SELECT user_id, at FROM notice_acks WHERE notice_id = ? AND rev = ? ORDER BY at').all(n.id, r.rev) as Array<{ user_id: string; at: number }>)
            .map((a) => ({ person: who(a.user_id), account: users.get(a.user_id)?.account ?? '', at: new Date(a.at).toISOString() })),
        })),
      };
    });
    const day = new Date(this.now()).toISOString().slice(0, 10);
    let data: Buffer;
    let mime: string;
    if (format === 'csv') {
      mime = 'text/csv';
      data = Buffer.from(toCsv([
        ['Number', 'Rev', 'Status', 'Desk', 'Category', 'Title', 'Issued', 'Effective', 'Expires', 'Audience', 'Acknowledgement asked', 'Acknowledged', 'Change note', 'Attachment', 'Author'],
        ...out.flatMap((n) => n.revisions.map((r) => [n.number ?? '', r.rev, r.status === 'issued' ? n.status : r.status, n.desk, n.category, r.title, r.issuedAt ?? '', r.effectiveAt ?? '', r.expiresAt ?? '', r.audience,
          r.ackRequired ? 'yes' : '', String(r.acknowledgements.length), r.changeNote ?? '', r.file ?? '', r.author])),
      ]), 'utf8');
    } else if (format === 'html') {
      mime = 'text/html';
      const body = out.map((n) => n.revisions.map((r) => `<tr><td>${esc(n.number ?? '(draft)')}</td><td>${esc(r.rev)}</td><td>${esc(r.status === 'issued' ? n.status : r.status)}</td><td>${esc(n.desk)}</td><td>${esc(r.title)}</td><td>${esc((r.issuedAt ?? '').slice(0, 10))}</td><td>${esc(r.audience)}</td><td>${r.ackRequired ? `${r.acknowledgements.length}` : ''}</td><td>${esc(r.changeNote ?? '')}</td></tr>`).join('')).join('\n');
      data = Buffer.from(`<!doctype html><meta charset="utf-8"><title>Notice register ${day}</title><style>body{font:14px Segoe UI,system-ui,sans-serif;margin:24px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f2f6f6}</style><h1>Notice register</h1><p>${out.length} notices · exported by ${esc(me.displayName)} on ${esc(new Date(this.now()).toISOString())}</p><table><tr><th>Number</th><th>Rev</th><th>Status</th><th>Desk</th><th>Title</th><th>Issued</th><th>For</th><th>Acknowledged</th><th>Change note</th></tr>${body}</table>`, 'utf8');
    } else {
      mime = 'application/json';
      data = Buffer.from(JSON.stringify({ exportedAt: new Date(this.now()).toISOString(), exportedBy: me.account, notices: out }, null, 2), 'utf8');
    }
    const file = this.d.files.storeBuffer(me.id, `notice-register-${day}.${format}`, mime, data);
    this.d.audit(me.id, 'notice.exported', null, { notices: out.length, format });
    return { file, notices: out.length };
  }

  // ------------------------------------------------------------ operations
  private adminView(): Ops['admin.notices.get']['res'] { return { desks: this.desks(), retentionDays: this.retentionDays() }; }

  handle(op: string, me: PublicUser, d: Record<string, unknown>): unknown {
    if (me.role === 'guest' || me.role === 'bot') throw new NoticeError('The notice board is for the office’s own people.');
    if (op.startsWith('admin.notices.') && !isAdmin(me)) throw new NoticeError('Only administrators can do that.');
    const now = this.now();
    switch (op) {
      case 'notices.list': return this.list(me) satisfies Ops['notices.list']['res'];
      case 'notices.get': return this.view(this.visible(d.id, me), me) satisfies Ops['notices.get']['res'];
      case 'notices.search': return { hits: this.search(me, d.q, typeof d.limit === 'number' ? Math.max(1, Math.min(50, Math.floor(d.limit))) : 20) } satisfies Ops['notices.search']['res'];

      case 'notices.save': {
        const n = this.save(me, d);
        return this.view(n, me) satisfies Ops['notices.save']['res'];
      }

      case 'notices.issue': {
        const n = this.visible(d.id, me);
        if (!this.canIssue(me, n.desk_id)) throw new NoticeError('Only the desk’s issuers can issue its notices.');
        const r = this.pending(n.id);
        if (!r) throw new NoticeError('There is nothing waiting to be issued.');
        if (r.urgent && !isAdmin(me)) throw new NoticeError('Only administrators can issue urgent notices.');
        if (d.at === null) {
          if (r.status !== 'scheduled') throw new NoticeError('It is not scheduled.');
          this.db.prepare(`UPDATE notice_revs SET status = 'draft', issue_at = NULL WHERE notice_id = ? AND rev = ?`).run(n.id, r.rev);
          this.db.prepare(`UPDATE notices SET status = CASE WHEN rev IS NULL THEN 'draft' ELSE status END, updated_at = ? WHERE id = ?`).run(now, n.id);
          this.d.audit(me.id, 'notice.unscheduled', n.id, { rev: r.rev });
          this.touch(n.id, false);
          return this.view(this.notice(n.id)!, me);
        }
        if (r.expires_at !== null && r.expires_at <= (time(d.at) ?? now)) throw new NoticeError('It would have expired by then. Change the expiry first.');
        const at = time(d.at);
        if (at !== null && at > now + 60_000) {
          if (at > now + 366 * DAY) throw new NoticeError('Schedule it within a year.');
          if (r.urgent) throw new NoticeError('Urgent notices go out at once.');
          this.db.prepare(`UPDATE notice_revs SET status = 'scheduled', issue_at = ?, author_id = ? WHERE notice_id = ? AND rev = ?`).run(at, me.id, n.id, r.rev);
          this.db.prepare(`UPDATE notices SET status = CASE WHEN rev IS NULL THEN 'scheduled' ELSE status END, updated_at = ? WHERE id = ?`).run(now, n.id);
          this.d.audit(me.id, 'notice.scheduled', n.id, { rev: r.rev, at });
          this.touch(n.id, false);
        } else {
          this.db.prepare('UPDATE notice_revs SET author_id = ? WHERE notice_id = ? AND rev = ?').run(me.id, n.id, r.rev);
          this.issueNow(n, { ...r, author_id: me.id }, me.id, now);
        }
        return this.view(this.notice(n.id)!, me) satisfies Ops['notices.issue']['res'];
      }

      case 'notices.discard': {
        const n = this.visible(d.id, me);
        if (!this.canIssue(me, n.desk_id)) throw new NoticeError('Only the desk’s issuers can do that.');
        const r = this.pending(n.id);
        if (!r) throw new NoticeError('There is no draft to throw away.');
        if (!n.rev) { this.drop(n.id); this.d.audit(me.id, 'notice.discarded', n.id, {}); this.touch(n.id, false); return { ok: true, deleted: true }; }
        this.db.prepare('DELETE FROM notice_revs WHERE notice_id = ? AND rev = ?').run(n.id, r.rev);
        this.d.audit(me.id, 'notice.discarded', n.id, { rev: r.rev });
        this.touch(n.id, false);
        return { ok: true, deleted: false } satisfies Ops['notices.discard']['res'];
      }

      case 'notices.withdraw': {
        const n = this.visible(d.id, me);
        if (!this.canIssue(me, n.desk_id)) throw new NoticeError('Only the desk’s issuers can withdraw its notices.');
        if (n.status !== 'issued') throw new NoticeError('Only a notice in force can be withdrawn.');
        const reason = strip(d.reason, NOTICE_LIMITS.reason);
        if (!reason) throw new NoticeError('Say why it is withdrawn. Readers see the reason on its record.');
        this.db.prepare(`DELETE FROM notice_revs WHERE notice_id = ? AND status IN ('draft', 'scheduled')`).run(n.id);
        this.db.prepare(`UPDATE notice_revs SET status = 'withdrawn' WHERE notice_id = ? AND rev = ?`).run(n.id, n.rev);
        this.db.prepare(`UPDATE notices SET status = 'withdrawn', withdrawn_at = ?, withdrawn_by = ?, withdraw_reason = ?, updated_at = ? WHERE id = ?`).run(now, me.id, reason, now, n.id);
        this.d.audit(me.id, 'notice.withdrawn', n.id, { number: n.number, rev: n.rev, reason });
        this.touch(n.id, false);
        return this.view(this.notice(n.id)!, me) satisfies Ops['notices.withdraw']['res'];
      }

      case 'notices.ack': {
        const n = this.visible(d.id, me);
        const r = this.rev(n.id, n.rev);
        if (!r || n.status !== 'issued') throw new NoticeError('Only a notice in force can be acknowledged.');
        if (!r.ack_required) throw new NoticeError('This notice does not ask for acknowledgement.');
        if (!this.inAudienceOf(me, r)) throw new NoticeError('This notice is not addressed to you.');
        const checks = json<NoticeCheckDef[]>(r.checks, []);
        if (checks.length) {
          const answers = Array.isArray(d.answers) ? d.answers : [];
          if (answers.length !== checks.length || checks.some((c, i) => answers[i] !== c.answer)) throw new NoticeError('One of the answers does not match the notice. Read it again and try once more.');
        }
        this.db.prepare('INSERT OR IGNORE INTO notice_acks (notice_id, rev, user_id, at) VALUES (?, ?, ?, ?)').run(n.id, r.rev, me.id, now);
        this.db.prepare(`INSERT INTO notice_seen (notice_id, user_id, rev, at) VALUES (?, ?, ?, ?) ON CONFLICT(notice_id, user_id) DO UPDATE SET rev = excluded.rev, at = excluded.at`).run(n.id, me.id, r.rev, now);
        // the chart fills live for the desk and the administrators; the reader's own devices update too
        const users = this.d.store.activeUsers();
        this.d.deliver([...new Set([me.id, ...this.issuersOf(n.desk_id), ...users.filter(isAdmin).map((u) => u.id)])], 'notices.changed', () => ({ id: n.id }));
        return this.view(this.notice(n.id)!, me) satisfies Ops['notices.ack']['res'];
      }

      case 'notices.seen': {
        const n = this.visible(d.id, me);
        if (n.rev) this.db.prepare(`INSERT INTO notice_seen (notice_id, user_id, rev, at) VALUES (?, ?, ?, ?) ON CONFLICT(notice_id, user_id) DO UPDATE SET rev = excluded.rev, at = excluded.at`).run(n.id, me.id, n.rev, now);
        return { ok: true } satisfies Ops['notices.seen']['res'];
      }

      case 'notices.ask': {
        const n = this.visible(d.id, me);
        if (!n.rev) throw new NoticeError('It has not been issued yet.');
        const text = long(d.text, NOTICE_LIMITS.question);
        if (!text) throw new NoticeError('Write your question first.');
        const mine = (this.db.prepare('SELECT COUNT(*) AS n FROM notice_asks WHERE notice_id = ? AND user_id = ? AND at > ?').get(n.id, me.id, now - DAY) as { n: number }).n;
        if (mine >= 5) throw new NoticeError('You have asked five questions about this notice today. The desk will answer them first.');
        this.db.prepare('INSERT INTO notice_asks (id, notice_id, user_id, text, at) VALUES (?, ?, ?, ?, ?)').run(ulid(), n.id, me.id, text, now);
        this.d.audit(me.id, 'notice.asked', n.id, { number: n.number });
        const desk = this.desk(n.desk_id)!;
        for (const uid of this.issuersOf(n.desk_id)) if (uid !== me.id) this.d.tell(uid, `notice-ask-${n.id}-${uid}-${localDate(now)}`, `${me.displayName} asked the ${desk.name} desk about ${n.number}: “${text.slice(0, 200)}” Answer it from the notice’s Questions.`);
        this.touch(n.id, false);
        return this.view(this.notice(n.id)!, me) satisfies Ops['notices.ask']['res'];
      }

      case 'notices.answer': {
        const n = this.visible(d.id, me);
        if (!this.canIssue(me, n.desk_id)) throw new NoticeError('Only the desk’s issuers can answer.');
        const a = this.db.prepare('SELECT * FROM notice_asks WHERE id = ? AND notice_id = ?').get(String(d.askId ?? ''), n.id) as { id: string; user_id: string; text: string } | undefined;
        if (!a) throw new NoticeError('Question not found.');
        const answer = long(d.answer, NOTICE_LIMITS.answer);
        if (!answer) throw new NoticeError('Write the answer first.');
        const publish = d.publish === true;
        this.db.prepare('UPDATE notice_asks SET answer = ?, answered_at = ?, answered_by = ?, published = ? WHERE id = ?').run(answer, now, me.id, publish ? 1 : 0, a.id);
        this.d.audit(me.id, publish ? 'notice.faqAdded' : 'notice.answered', n.id, { number: n.number });
        this.d.tell(a.user_id, `notice-answer-${a.id}`, `${this.desk(n.desk_id)?.name ?? 'The desk'} answered your question about ${n.number}${publish ? ' and added it to the notice’s questions and answers' : ''}. Open the notice to read it.`);
        this.touch(n.id, false);
        return this.view(this.notice(n.id)!, me) satisfies Ops['notices.answer']['res'];
      }

      case 'notices.acks': {
        const n = this.visible(d.id, me);
        if (!this.canIssue(me, n.desk_id)) throw new NoticeError('Only the desk’s issuers and administrators see who has acknowledged.');
        const r = this.rev(n.id, n.rev);
        if (!r) throw new NoticeError('It has not been issued yet.');
        const done = this.ackedSet(n.id, this.ackBase(n.id, r.rev));
        const aud = this.audienceOf(r);
        const deps = new Map(this.d.departments().map((x) => [x.id, x.name] as const));
        const groups = new Map<string, NoticeAckChart['departments'][number]>();
        for (const u of aud.sort((a, b) => a.displayName.localeCompare(b.displayName))) {
          const key = u.profile.departmentId && deps.has(u.profile.departmentId) ? u.profile.departmentId : '';
          const g = groups.get(key) ?? { id: key || null, name: key ? deps.get(key)! : 'No department', people: [] };
          g.people.push({ userId: u.id, acked: done.has(u.id), at: done.get(u.id) ?? null });
          groups.set(key, g);
        }
        const last = (this.db.prepare(`SELECT at FROM notice_days WHERE kind = 'remind' AND ref = ? ORDER BY at DESC LIMIT 1`).get(n.id) as { at: number } | undefined)?.at ?? null;
        return {
          noticeId: n.id, number: n.number, rev: r.rev, done: aud.filter((u) => done.has(u.id)).length, total: aud.length,
          departments: [...groups.values()].sort((a, b) => (a.id ? 0 : 1) - (b.id ? 0 : 1) || a.name.localeCompare(b.name)),
          lastReminderAt: last, remindFrom: last && localDate(last) === localDate(now) ? dayStart(now) + DAY : null,
        } satisfies NoticeAckChart;
      }

      case 'notices.remind': {
        const n = this.visible(d.id, me);
        if (!this.canIssue(me, n.desk_id)) throw new NoticeError('Only the desk’s issuers can send reminders.');
        const x = this.outstanding(now + 1).find((o) => o.n.id === n.id);
        if (!x) throw new NoticeError('Everyone has acknowledged it.');
        if (!this.once('remind', n.id, localDate(now), now)) throw new NoticeError('A reminder about this notice already went today. The next one can go tomorrow.');
        const people = new Map<string, Array<{ n: NoticeRow; r: RevRow }>>(x.waiting.map((u) => [u.id, [{ n: x.n, r: x.r }]]));
        const sent = this.remindPeople(people, now);
        this.d.audit(me.id, 'notice.reminded', n.id, { number: n.number, rev: n.rev, sent });
        return { sent } satisfies Ops['notices.remind']['res'];
      }

      case 'notices.emailCopy': {
        const n = this.visible(d.id, me);
        if (!this.canIssue(me, n.desk_id)) throw new NoticeError('Only the desk’s issuers can send an email copy.');
        return this.emailCopy(n, me);
      }

      case 'notices.dismiss': {
        const n = this.visible(d.id, me);
        this.db.prepare('INSERT OR IGNORE INTO notice_dismissed (notice_id, user_id) VALUES (?, ?)').run(n.id, me.id);
        this.d.deliver([me.id], 'notices.changed', () => ({ id: n.id }));
        return { ok: true } satisfies Ops['notices.dismiss']['res'];
      }

      case 'admin.notices.get': return this.adminView();

      case 'admin.notices.setDesk': {
        const code = strip(d.code, 6).toUpperCase();
        const name = strip(d.name, 60);
        if (!/^[A-Z]{2,4}$/.test(code)) throw new NoticeError('A desk code is two to four letters, like HR or IT.');
        if (!name) throw new NoticeError('Give the desk a name.');
        const issuers = ids(d.issuers, 50).filter((uid) => { const u = this.d.store.userById(uid); return !!u && u.role !== 'guest' && u.role !== 'bot'; });
        const same = this.db.prepare('SELECT id FROM notice_desks WHERE code = ?').get(code) as { id: string } | undefined;
        let id = typeof d.id === 'string' ? d.id : '';
        if (id) {
          const desk = this.desk(id);
          if (!desk) throw new NoticeError('Desk not found.');
          if (same && same.id !== id) throw new NoticeError(`Another desk uses ${code}.`);
          if (desk.code !== code && this.db.prepare('SELECT 1 FROM notices WHERE desk_id = ? AND number IS NOT NULL LIMIT 1').get(id)) throw new NoticeError('The desk has issued notices under its code, so the code stays.');
          this.db.prepare('UPDATE notice_desks SET code = ?, name = ? WHERE id = ?').run(code, name, id);
        } else {
          if (same) throw new NoticeError(`Another desk uses ${code}.`);
          if ((this.db.prepare('SELECT COUNT(*) AS n FROM notice_desks').get() as { n: number }).n >= 30) throw new NoticeError('An office can have up to 30 issuing desks.');
          id = ulid();
          this.db.prepare('INSERT INTO notice_desks (id, code, name, created_at) VALUES (?, ?, ?, ?)').run(id, code, name, now);
        }
        this.db.prepare('DELETE FROM notice_issuers WHERE desk_id = ?').run(id);
        for (const uid of issuers) this.db.prepare('INSERT OR IGNORE INTO notice_issuers (desk_id, user_id) VALUES (?, ?)').run(id, uid);
        this.d.audit(me.id, 'notice.desk', id, { code, name, issuers: issuers.length });
        this.d.deliver(this.d.store.activeUsers().map((u) => u.id), 'notices.changed', () => ({ id: '' }));
        return this.adminView();
      }

      case 'admin.notices.removeDesk': {
        const desk = this.desk(String(d.id ?? ''));
        if (!desk) throw new NoticeError('Desk not found.');
        if (this.db.prepare('SELECT 1 FROM notices WHERE desk_id = ? LIMIT 1').get(desk.id)) throw new NoticeError('The desk has notices on the board, so it stays. Take its issuers off instead.');
        this.db.prepare('DELETE FROM notice_issuers WHERE desk_id = ?').run(desk.id);
        this.db.prepare('DELETE FROM notice_desks WHERE id = ?').run(desk.id);
        this.d.audit(me.id, 'notice.deskRemoved', desk.id, { code: desk.code });
        return this.adminView();
      }

      case 'admin.notices.setRetention': {
        const days = d.days === null || d.days === undefined ? null : d.days;
        if (days !== null && (typeof days !== 'number' || !Number.isInteger(days) || days < 365 || days > 36500)) throw new NoticeError('Keep withdrawn and expired notices at least a year, or for ever.');
        this.d.store.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('notice_retention_days', days === null ? '' : String(days));
        this.d.audit(me.id, 'notice.retention', null, { days });
        return this.adminView();
      }

      case 'admin.notices.pinned': return this.d.officePins().map((m) => ({ messageId: m.id, body: m.body, authorId: m.author_id, createdAt: m.created_at, files: m.files })) satisfies Ops['admin.notices.pinned']['res'];

      case 'admin.notices.import': {
        const desk = this.desk(String(d.deskId ?? ''));
        if (!desk) throw new NoticeError('Choose the desk the notices come from.');
        const category = isNoticeCategory(d.category) ? d.category : 'notice';
        const pins = new Map(this.d.officePins().map((m) => [m.id, m] as const));
        let created = 0;
        for (const mid of ids(d.messageIds, 50)) {
          const m = pins.get(mid);
          if (!m || this.db.prepare('SELECT 1 FROM notices WHERE source_message = ?').get(mid)) continue;
          const plain = m.body.replace(/[*_`~#>]/g, '').trim();
          const [first, ...rest] = plain.split('\n');
          const title = strip(first, NOTICE_LIMITS.title) || 'Notice';
          const body = long(rest.join('\n').trim() || (plain.length > title.length ? plain : ''), NOTICE_LIMITS.body);
          const pdf = m.files.find((f) => f.mime === 'application/pdf' || /\.pdf$/i.test(f.name)) ?? null;
          const id = ulid();
          this.db.prepare(`INSERT INTO notices (id, desk_id, category, status, related, source_message, created_by, created_at, updated_at) VALUES (?, ?, ?, 'draft', '[]', ?, ?, ?, ?)`)
            .run(id, desk.id, category, mid, me.id, now, now);
          this.db.prepare(`INSERT INTO notice_revs (notice_id, rev, status, title, body, file_id, pdf_text, audience, standing, author_id, created_at, effective_at) VALUES (?, 'A', 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, title, body || title, pdf?.id ?? null, pdf ? this.pdfText(pdf.id) : null, JSON.stringify({ everyone: true, departments: [], roles: [], locations: [], people: [] }), category === 'policy' ? 1 : 0, m.author_id, m.created_at, m.created_at);
          // it was already issued to everyone, when it was pinned: it goes on the board as issued then
          this.issueNow(this.notice(id)!, this.rev(id, 'A')!, me.id, now);
          this.db.prepare('UPDATE notice_revs SET issued_at = ? WHERE notice_id = ? AND rev = ?').run(m.created_at, id, 'A');
          this.d.unpin(mid);
          created++;
        }
        this.d.audit(me.id, 'notice.imported', null, { created, desk: desk.code });
        return { created } satisfies Ops['admin.notices.import']['res'];
      }

      case 'admin.notices.export': {
        const format = d.format === 'csv' || d.format === 'html' ? d.format : 'json';
        return this.exportRegister(me, format);
      }
    }
    return undefined;
  }
}
