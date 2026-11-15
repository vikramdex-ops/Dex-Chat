// The notice board: official notices from the office's issuing desks (HR, IT, Admin, the
// management), kept as a register rather than as messages in a Space. Each notice has a number
// (HR-POL-0012), revisions (A, B…), an audience, an optional acknowledgement and a lifecycle
// (draft, scheduled, issued, withdrawn, expired). These are the rules the hub and the apps share;
// the hub keeps the register (apps/hub/src/notices.ts). See docs/ANNOUNCEMENTS.md.
import type { FileInfo } from './protocol.ts';

export type NoticeCategory = 'policy' | 'notice' | 'circular' | 'holiday' | 'it' | 'safety' | 'event';
export const NOTICE_CATEGORIES: ReadonlyArray<{ id: NoticeCategory; code: string; label: string }> = [
  { id: 'policy', code: 'POL', label: 'Policy' },
  { id: 'notice', code: 'NTC', label: 'Notice' },
  { id: 'circular', code: 'CIR', label: 'Circular' },
  { id: 'holiday', code: 'HOL', label: 'Holiday' },
  { id: 'it', code: 'ITA', label: 'IT advisory' },
  { id: 'safety', code: 'SAF', label: 'Safety' },
  { id: 'event', code: 'EVT', label: 'Event' },
];
export const isNoticeCategory = (v: unknown): v is NoticeCategory => NOTICE_CATEGORIES.some((c) => c.id === v);
export const categoryCode = (c: NoticeCategory): string => NOTICE_CATEGORIES.find((x) => x.id === c)?.code ?? 'NTC';

/** Where a notice is in its life. Revisions add "superseded" (an earlier revision of an issued notice). */
export type NoticeStatus = 'draft' | 'scheduled' | 'issued' | 'withdrawn' | 'expired';
export type NoticeRevStatus = 'draft' | 'scheduled' | 'issued' | 'superseded' | 'withdrawn';
/** Languages a notice's own text can be written in, besides the original. */
export type NoticeLang = 'hi' | 'ta';
export const NOTICE_LANGS: NoticeLang[] = ['hi', 'ta'];

export const NOTICE_LIMITS = { title: 160, body: 20_000, changeNote: 600, question: 600, answer: 2000, reason: 300, prompt: 200, option: 120 } as const;
/** Check questions on an acknowledgement: at most this many, each with 2 to 4 options. */
export const NOTICE_MAX_QUESTIONS = 3;
/** Urgent notices across the office in 24 hours (each one interrupts everyone with a banner). */
export const NOTICE_URGENT_PER_DAY = 3;
/** How long an urgent notice's banner stays when no expiry is given, and at most. */
export const NOTICE_URGENT_DEFAULT_MS = 24 * 3600_000;
export const NOTICE_URGENT_MAX_MS = 7 * 24 * 3600_000;
/** A reader is reminded at most this many times about one revision. */
export const NOTICE_MAX_NUDGES = 3;

/**
 * Who a notice is for. Guests never see notices. Targeting a department includes the departments
 * under it. Roles are the app's roles (the owner counts as an admin).
 */
export interface NoticeAudience {
  everyone: boolean;
  departments: string[];
  roles: Array<'admin' | 'member'>;
  /** Work locations as written on profiles ("Mumbai office", "Site — Dahej"), matched without case. */
  locations: string[];
  people: string[];
}
export const EVERYONE: NoticeAudience = { everyone: true, departments: [], roles: [], locations: [], people: [] };

export interface NoticeText { title: string; body: string }

/** A check question as a reader sees it (the right answer stays on the hub). */
export interface NoticeCheck { id: string; prompt: string; options: string[] }
export interface NoticeCheckDef extends NoticeCheck { answer: number }

export interface NoticeDesk {
  id: string;
  /** The desk's part of a notice number: HR, IT, ADM, MGT. */
  code: string;
  name: string;
  /** People who may draft and issue the desk's notices (administrators may too). */
  issuers: string[];
  createdAt: number;
  /** Notices issued by the desk so far. */
  issued: number;
}

/** One line of the register. */
export interface NoticeSummary {
  id: string;
  /** HR-POL-0012; null until it is first issued (a draft has no number yet). */
  number: string | null;
  /** The revision shown: the one in force, or for a draft the one being written. */
  rev: string;
  deskId: string;
  deskCode: string;
  deskName: string;
  category: NoticeCategory;
  title: string;
  status: NoticeStatus;
  urgent: boolean;
  /** On the standing shelf while in force (policies by default). */
  standing: boolean;
  issuedAt: number | null;
  /** When the scheduled revision issues. */
  issueAt: number | null;
  effectiveAt: number | null;
  expiresAt: number | null;
  ackRequired: boolean;
  /** I have acknowledged it (an earlier revision counts unless a later one asked again). */
  acked: boolean;
  ackedAt: number | null;
  /** In force, asks for acknowledgement, and I have not given it. */
  needsAck: boolean;
  /** I have opened the revision in force. */
  seen: boolean;
  file: FileInfo | null;
  /** Translations of its own text the author added. */
  langs: NoticeLang[];
  /** Translated titles, for the register in the reader's language. */
  titles: Partial<Record<NoticeLang, string>>;
  audience: NoticeAudience;
  authorId: string;
  updatedAt: number;
  /** For its desk's issuers and administrators: acknowledgements given and asked for. */
  acks: { done: number; total: number } | null;
  /** For issuers: a next revision is being written (or is scheduled). */
  pendingRev: { rev: string; status: 'draft' | 'scheduled'; issueAt: number | null } | null;
}

export interface NoticeRevision {
  rev: string;
  status: NoticeRevStatus;
  title: string;
  body: string;
  translations: Partial<Record<NoticeLang, NoticeText>>;
  file: FileInfo | null;
  /** What changed since the revision before (written by the author). */
  changeNote: string | null;
  /** Paragraphs of the body (split on blank lines) that are new or changed since the revision before. */
  changed: number[];
  /** Paragraphs of the revision before that were taken out. */
  removed: number;
  /** Readers are asked to acknowledge this revision again. */
  reack: boolean;
  ackRequired: boolean;
  checks: NoticeCheck[];
  audience: NoticeAudience;
  issueAt: number | null;
  issuedAt: number | null;
  effectiveAt: number | null;
  expiresAt: number | null;
  standing: boolean;
  urgent: boolean;
  authorId: string;
  createdAt: number;
}

export interface NoticeFaq { id: string; question: string; answer: string; at: number }
export interface NoticeAsk { id: string; userId: string; text: string; at: number; answer: string | null; answeredAt: number | null; published: boolean }

export interface NoticeView extends NoticeSummary {
  /** Issued revisions, newest first (and for issuers the one being written, first). */
  revisions: NoticeRevision[];
  /** The revision in force (or the draft, before the first issue). */
  current: NoticeRevision;
  /** For issuers: the revision being written, with the check questions' answers. */
  draft: (NoticeRevision & { checkDefs: NoticeCheckDef[] }) | null;
  faq: NoticeFaq[];
  related: NoticeSummary[];
  /** My own questions to the issuer and their answers. */
  asked: NoticeAsk[];
  /** For issuers: everyone's questions. */
  inbox: NoticeAsk[] | null;
  canIssue: boolean;
  withdrawn: { at: number; by: string; reason: string } | null;
  /** The revision my acknowledgement was given on. */
  ackedRev: string | null;
  /** The next number this desk will give (for a draft's preview). */
  nextNumber: string;
}

export interface NoticeAckChart {
  noticeId: string;
  number: string | null;
  rev: string;
  done: number;
  total: number;
  departments: Array<{ id: string | null; name: string; people: Array<{ userId: string; acked: boolean; at: number | null }> }>;
  lastReminderAt: number | null;
  /** A reminder can go again from this time (once a day). */
  remindFrom: number | null;
}

export interface NoticeHit { notice: NoticeSummary; snippet: string; where: 'title' | 'text' | 'pdf' }

export interface NoticeList {
  notices: NoticeSummary[];
  desks: NoticeDesk[];
  /** Desks I may issue for. */
  canIssue: string[];
  /** An urgent notice whose banner I have not dismissed. */
  banner: NoticeSummary | null;
  /** May issue urgent notices (administrators). */
  canUrgent: boolean;
}

export interface NoticeDraftInput {
  id?: string;
  deskId: string;
  category: NoticeCategory;
  title: string;
  body: string;
  translations?: Partial<Record<NoticeLang, NoticeText>>;
  fileId?: string | null;
  audience: NoticeAudience;
  ackRequired: boolean;
  checks?: Array<{ prompt: string; options: string[]; answer: number }>;
  effectiveAt?: number | null;
  expiresAt?: number | null;
  standing?: boolean;
  urgent?: boolean;
  changeNote?: string | null;
  reack?: boolean;
  related?: string[];
}

// ---------------------------------------------------------------- rules
/** HR-POL-0012 */
export const noticeNumber = (deskCode: string, category: NoticeCategory, seq: number): string => `${deskCode}-${categoryCode(category)}-${String(Math.max(1, seq)).padStart(4, '0')}`;

/** A → B … Z → AA → AB, as revisions are lettered on drawings. */
export function nextRev(rev: string | null): string {
  if (!rev) return 'A';
  const s = rev.toUpperCase().replace(/[^A-Z]/g, '') || 'A';
  const chars = s.split('');
  let i = chars.length - 1;
  while (i >= 0) {
    if (chars[i] !== 'Z') { chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1); return chars.join(''); }
    chars[i] = 'A';
    i--;
  }
  return `A${chars.join('')}`;
}
/** Revisions in order: B after A, AA after Z. */
export const revOrder = (a: string, b: string): number => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0);

/** A body's paragraphs: blocks separated by a blank line. */
export const paragraphs = (body: string): string[] => body.replace(/\r\n/g, '\n').split(/\n[ \t]*\n+/).map((p) => p.trim()).filter(Boolean);
const norm = (p: string) => p.replace(/\s+/g, ' ').trim().toLowerCase();

/** Which paragraphs of a new revision are new or changed, and how many of the old ones went. */
export function changedParagraphs(before: string, after: string): { changed: number[]; removed: number } {
  const old = paragraphs(before).map(norm);
  const now = paragraphs(after).map(norm);
  const pool = new Map<string, number>();
  for (const p of old) pool.set(p, (pool.get(p) ?? 0) + 1);
  const changed: number[] = [];
  now.forEach((p, i) => {
    const n = pool.get(p) ?? 0;
    if (n > 0) pool.set(p, n - 1); else changed.push(i);
  });
  const unmatchedOld = [...pool.values()].reduce((a, b) => a + b, 0);
  return { changed, removed: Math.max(0, unmatchedOld - changed.length) };
}

export interface AudiencePerson { id: string; role: string; profile?: { departmentId: string | null; location: string | null } | null }
/**
 * Is this person in the audience? `departments` is the audience's departments with the ones under
 * them already added (the hub expands them from the organisation).
 */
export function inAudience(u: AudiencePerson, a: NoticeAudience, departments: ReadonlySet<string> = new Set(a.departments)): boolean {
  if (u.role === 'guest' || u.role === 'bot') return false;
  if (a.everyone) return true;
  if (a.people.includes(u.id)) return true;
  const dept = u.profile?.departmentId ?? null;
  if (dept && departments.has(dept)) return true;
  const role = u.role === 'owner' ? 'admin' : u.role;
  if ((role === 'admin' || role === 'member') && a.roles.includes(role)) return true;
  const loc = u.profile?.location?.trim().toLowerCase();
  if (loc && a.locations.some((l) => l.trim().toLowerCase() === loc)) return true;
  return false;
}

export const emptyAudience = (a: NoticeAudience): boolean => !a.everyone && !a.departments.length && !a.roles.length && !a.locations.length && !a.people.length;

declare module './protocol.ts' {
  interface Ops {
    /** The register as I may see it: issued notices for me, and my desks' drafts. */
    'notices.list': { req: void; res: NoticeList };
    'notices.get': { req: { id: string }; res: NoticeView };
    /** Titles, text, translations and the text of attached PDFs. */
    'notices.search': { req: { q: string; limit?: number }; res: { hits: NoticeHit[] } };
    /** Write a draft (a new notice, or the next revision of an issued one). */
    'notices.save': { req: NoticeDraftInput; res: NoticeView };
    /** Issue the draft now, or schedule it (at). `at: null` takes a scheduled one back to draft. */
    'notices.issue': { req: { id: string; at?: number | null }; res: NoticeView };
    /** Throw away the draft (a notice never issued goes altogether). */
    'notices.discard': { req: { id: string }; res: { ok: true; deleted: boolean } };
    'notices.withdraw': { req: { id: string; reason: string }; res: NoticeView };
    /** "Read and understood": with the answers to its check questions when it has them. */
    'notices.ack': { req: { id: string; answers?: number[] }; res: NoticeView };
    'notices.seen': { req: { id: string }; res: { ok: true } };
    /** A question to the issuing desk, privately. */
    'notices.ask': { req: { id: string; text: string }; res: NoticeView };
    /** The desk answers; `publish` adds it to the notice's questions and answers for everyone. */
    'notices.answer': { req: { id: string; askId: string; answer: string; publish?: boolean }; res: NoticeView };
    'notices.acks': { req: { id: string }; res: NoticeAckChart };
    /** One polite reminder to everyone who has not acknowledged (once a day per notice). */
    'notices.remind': { req: { id: string }; res: { sent: number } };
    /** An email copy for people in the audience who do not use the app. */
    'notices.emailCopy': { req: { id: string }; res: { to: Array<{ name: string; email: string }>; withoutEmail: number; subject: string; text: string; html: string } };
    /** Hide an urgent notice's banner on every device. */
    'notices.dismiss': { req: { id: string }; res: { ok: true } };
    'admin.notices.get': { req: void; res: { desks: NoticeDesk[]; retentionDays: number | null } };
    'admin.notices.setDesk': { req: { id?: string; code: string; name: string; issuers: string[] }; res: { desks: NoticeDesk[]; retentionDays: number | null } };
    'admin.notices.removeDesk': { req: { id: string }; res: { desks: NoticeDesk[]; retentionDays: number | null } };
    /** Keep withdrawn and expired notices this many days (null: for ever). */
    'admin.notices.setRetention': { req: { days: number | null }; res: { desks: NoticeDesk[]; retentionDays: number | null } };
    /** Messages pinned in the Office space, to move onto the board. */
    'admin.notices.pinned': { req: void; res: Array<{ messageId: string; body: string; authorId: string; createdAt: number; files: FileInfo[] }> };
    'admin.notices.import': { req: { messageIds: string[]; deskId: string; category: NoticeCategory }; res: { created: number } };
    /** The whole register for review: every revision, its audience and acknowledgements. */
    'admin.notices.export': { req: { format: 'json' | 'csv' | 'html' }; res: { file: FileInfo; notices: number } };
  }
  interface Events {
    /** Something about a notice I can see changed; `issued` when it was just issued for me. */
    'notices.changed': { id: string; issued?: NoticeSummary };
  }
}
