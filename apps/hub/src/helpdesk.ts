// The help desk (docs/HELP-DESK.md): anyone asks IT for help; IT (people an administrator gave
// the `it` capability in the Control room) works a queue of tickets; the technician who took a
// ticket may open a support session, a two-person Room where the requester decides, step by step,
// what to share. The hub keeps the tickets, their timelines and the requester's consent, and
// audits every grant with who, when, what and for how long. The screen, sound and control events
// travel PC to PC in the session's Room; the requester's own PC enforces consent before it
// injects any input (apps/desktop/src/main/assist).
import type { DatabaseSync } from 'node:sqlite';
import { HELP_CATEGORIES, ticketRef, ulid } from '@dex/core';
import { DROP_MAX_FILES, safeRelativePath } from '@dex/core/assist';
import type { HelpCategory, HelpEntry, HelpEntryKind, HelpFile, HelpFileKind, HelpTicket, OfficePolicy, PublicUser, RoomInfo, SupportConsent, SupportSession, TicketStatus } from '@dex/core';
import type { Store } from './store.ts';
import type { Messaging } from './messaging.ts';
import type { FileStore } from './files.ts';
import type { Rooms } from './rooms.ts';

export class HelpError extends Error {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS help_staff (
  user_id TEXT PRIMARY KEY,
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS help_tickets (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  requester_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL,
  tech_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  taken_at INTEGER,
  closed_at INTEGER,
  rating INTEGER,
  rating_note TEXT,
  platform TEXT
);
CREATE INDEX IF NOT EXISTS idx_help_status ON help_tickets(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_help_requester ON help_tickets(requester_id, created_at);
CREATE TABLE IF NOT EXISTS help_files (
  ticket_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  by_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (ticket_id, file_id)
);
CREATE INDEX IF NOT EXISTS idx_help_files_file ON help_files(file_id);
CREATE TABLE IF NOT EXISTS help_timeline (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  actor TEXT,
  kind TEXT NOT NULL,
  text TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_help_timeline ON help_timeline(ticket_id, at);
CREATE TABLE IF NOT EXISTS help_sessions (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  tech_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  grants TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_help_sessions_ticket ON help_sessions(ticket_id);
`;

interface TicketRow {
  id: string; number: number; requester_id: string; summary: string; detail: string; category: HelpCategory; status: TicketStatus;
  tech_id: string | null; created_at: number; updated_at: number; taken_at: number | null; closed_at: number | null;
  rating: number | null; rating_note: string | null; platform: string | null;
}

/** One grant in a session: what, when it began and ended (for the audit and the timeline). */
interface Grant { kind: 'screen' | 'control'; scope: 'screen' | 'window' | null; from: number; to: number | null }

interface LiveSession extends SupportSession {
  convId: string;
  grants: Grant[];
  /** Both people have been in the Room together: from then on one of them missing pauses the session. */
  together: boolean;
  /** Ends a paused session when the connection does not come back in time. */
  timer: ReturnType<typeof setTimeout> | null;
}

const CATEGORY_IDS = HELP_CATEGORIES.map((c) => c.id);
const MAX_SUMMARY = 140;
const MAX_DETAIL = 4000;
const MAX_NOTE = 2000;
const MAX_FILES = 40;
/** Files dropped into one ticket's sessions, at most (policy assistFiles). */
const MAX_DROPPED = 2000;
/** Open requests one person may have at once (a stuck button pressed many times is still one problem). */
const MAX_OPEN_PER_PERSON = 10;

const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
const oneLine = (v: unknown, max: number): string => clean(v, max).replace(/\s+/g, ' ');

export interface HelpHost {
  store: Store;
  messaging: Messaging;
  files: FileStore;
  rooms: Rooms;
  /** Send an event to every connected device of these people. */
  deliver(userIds: string[], name: string, data: unknown): void;
  /** Send an event to everyone connected. */
  broadcast(name: string, data: unknown): void;
  /** The office's policies now (remote support is off unless an administrator turns it on). */
  policy(): OfficePolicy;
  /** A person's devices connected now, most recently connected last (to choose the PC unattended access reaches). */
  devicesOf(userId: string): Array<{ deviceId: string; idle: boolean; remote: boolean }>;
}

export class HelpDesk {
  private readonly db: DatabaseSync;
  private readonly host: HelpHost;
  /** Support sessions running now, by ticket id. */
  private readonly live = new Map<string, LiveSession>();
  /** Devices that said they can be controlled (desktop apps on Windows or Linux), for unattended access. */
  private readonly controllable = new Set<string>();
  /** How long a session whose connection dropped waits for it to come back (policy assistReconnect). */
  reconnectGraceMs = 10 * 60_000;

  constructor(host: HelpHost) {
    this.host = host;
    this.db = host.store.db;
    this.db.exec(SCHEMA);
    try { this.db.exec('ALTER TABLE help_sessions ADD COLUMN unattended INTEGER NOT NULL DEFAULT 0'); } catch { /* already there */ }
    // sessions cut short by a hub restart end where they were
    const open = this.db.prepare('SELECT id, ticket_id, started_at, grants FROM help_sessions WHERE ended_at IS NULL').all() as Array<{ id: string; ticket_id: string; started_at: number; grants: string }>;
    for (const s of open) {
      const grants = this.parseGrants(s.grants);
      const last = Math.max(s.started_at, ...grants.map((g) => g.to ?? g.from));
      for (const g of grants) if (g.to === null) g.to = last;
      this.db.prepare('UPDATE help_sessions SET ended_at = ?, grants = ? WHERE id = ?').run(last, JSON.stringify(grants), s.id);
      this.entry(s.ticket_id, null, 'session.ended', 'The session ended when the office hub restarted.', { sessionId: s.id, durationMs: last - s.started_at });
    }
  }

  private parseGrants(raw: string): Grant[] {
    try { const v = JSON.parse(raw) as unknown; return Array.isArray(v) ? (v as Grant[]).filter((g) => g && (g.kind === 'screen' || g.kind === 'control') && typeof g.from === 'number') : []; } catch { return []; }
  }

  // ------------------------------------------------------------ the it capability
  staff(): string[] {
    return (this.db.prepare('SELECT user_id FROM help_staff ORDER BY granted_at').all() as Array<{ user_id: string }>).map((r) => r.user_id)
      .filter((id) => { const u = this.host.store.userById(id); return !!u && u.role !== 'bot' && u.role !== 'guest'; });
  }

  isIt(userId: string): boolean {
    return this.staff().includes(userId);
  }

  private setStaff(admin: PublicUser, userId: unknown, on: unknown): string[] {
    if (admin.role !== 'owner' && admin.role !== 'admin') throw new HelpError('Only administrators can do that.');
    const u = typeof userId === 'string' ? this.host.store.userById(userId) : null;
    if (!u || u.role === 'bot') throw new HelpError('Person not found.');
    if (u.role === 'guest' && on === true) throw new HelpError('Guests cannot work the IT desk.');
    if (on === true) this.db.prepare('INSERT OR IGNORE INTO help_staff (user_id, granted_by, granted_at) VALUES (?, ?, ?)').run(u.id, admin.id, Date.now());
    else this.db.prepare('DELETE FROM help_staff WHERE user_id = ?').run(u.id);
    this.host.store.audit(admin.id, on === true ? 'help.staff.granted' : 'help.staff.removed', u.id, { account: u.account });
    const list = this.staff();
    this.host.broadcast('help.staff', list);
    return list;
  }

  // ------------------------------------------------------------ tickets
  private row(id: unknown): TicketRow | undefined {
    return typeof id === 'string' ? this.db.prepare('SELECT * FROM help_tickets WHERE id = ?').get(id) as TicketRow | undefined : undefined;
  }

  private filesOf(ticketId: string): HelpFile[] {
    const rows = this.db.prepare(`SELECT hf.file_id, hf.kind, hf.by_id, hf.at, f.name, f.size, f.mime FROM help_files hf JOIN files f ON f.id = hf.file_id
      WHERE hf.ticket_id = ? AND hf.kind != 'dropped' ORDER BY hf.at`).all(ticketId) as Array<{ file_id: string; kind: HelpFileKind; by_id: string; at: number; name: string; size: number; mime: string }>;
    return rows.map((r) => ({ fileId: r.file_id, name: r.name, size: r.size, mime: r.mime, kind: r.kind, by: r.by_id, at: r.at }));
  }

  private publicSession(s: LiveSession): SupportSession {
    return { id: s.id, ticketId: s.ticketId, roomId: s.roomId, requesterId: s.requesterId, techId: s.techId, startedAt: s.startedAt, endedAt: s.endedAt, consent: { ...s.consent }, controlAvailable: s.controlAvailable, unattended: s.unattended, pausedAt: s.pausedAt,
      requesterDevice: s.requesterDevice, techDevice: s.techDevice, stopped: s.stopped };
  }

  private view(r: TicketRow): HelpTicket {
    const live = this.live.get(r.id);
    return {
      id: r.id, number: r.number, requesterId: r.requester_id, summary: r.summary, detail: r.detail, category: r.category, status: r.status,
      techId: r.tech_id, createdAt: r.created_at, updatedAt: r.updated_at, takenAt: r.taken_at, closedAt: r.closed_at,
      rating: r.rating, ratingNote: r.rating_note, platform: r.platform, files: this.filesOf(r.id), session: live ? this.publicSession(live) : null,
    };
  }

  /** Who hears about a ticket: its requester, its technician and everyone on the IT desk. */
  private audience(r: TicketRow): string[] {
    return [...new Set([r.requester_id, ...(r.tech_id ? [r.tech_id] : []), ...this.staff()])];
  }

  private publish(id: string): HelpTicket {
    const r = this.row(id)!;
    const t = this.view(r);
    this.host.deliver(this.audience(r), 'help.updated', t);
    return t;
  }

  private entry(ticketId: string, actor: string | null, kind: HelpEntryKind, text: string | null, detail: Record<string, unknown> | null = null): HelpEntry {
    const e: HelpEntry = { id: ulid(), ticketId, at: Date.now(), actor, kind, text, detail };
    this.db.prepare('INSERT INTO help_timeline (id, ticket_id, at, actor, kind, text, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(e.id, ticketId, e.at, actor, kind, text, detail ? JSON.stringify(detail) : null);
    this.db.prepare('UPDATE help_tickets SET updated_at = ? WHERE id = ?').run(e.at, ticketId);
    const r = this.row(ticketId);
    if (r) this.host.deliver(this.audience(r), 'help.entry', e);
    return e;
  }

  private timeline(ticketId: string): HelpEntry[] {
    return (this.db.prepare('SELECT * FROM help_timeline WHERE ticket_id = ? ORDER BY at, id').all(ticketId) as Array<{ id: string; ticket_id: string; at: number; actor: string | null; kind: HelpEntryKind; text: string | null; detail: string | null }>)
      .map((x) => { let detail: Record<string, unknown> | null = null; try { detail = x.detail ? JSON.parse(x.detail) as Record<string, unknown> : null; } catch { /* kept as text */ } return { id: x.id, ticketId: x.ticket_id, at: x.at, actor: x.actor, kind: x.kind, text: x.text, detail }; });
  }

  /** May this person see the ticket? Its requester, and the IT desk. */
  private visible(me: PublicUser, id: unknown): TicketRow {
    const r = this.row(id);
    if (!r || (r.requester_id !== me.id && r.tech_id !== me.id && !this.isIt(me.id))) throw new HelpError('Ticket not found.');
    return r;
  }

  private requireIt(me: PublicUser): void {
    if (!this.isIt(me.id)) throw new HelpError('Only people on the IT desk can do that.');
  }

  /** Files attached to a ticket can be opened by whoever can see the ticket. */
  canRead(userId: string, fileId: string): boolean {
    const rows = this.db.prepare('SELECT t.requester_id, t.tech_id FROM help_files hf JOIN help_tickets t ON t.id = hf.ticket_id WHERE hf.file_id = ?').all(fileId) as Array<{ requester_id: string; tech_id: string | null }>;
    if (!rows.length) return false;
    return rows.some((r) => r.requester_id === userId || r.tech_id === userId) || this.isIt(userId);
  }

  /** A file the caller may attach (uploaded by them, or one they can already read), or an error. */
  private fileFor(me: PublicUser, fileId: unknown): { id: string; name: string; size: number; mime: string } {
    const info = typeof fileId === 'string' ? this.host.files.info(fileId) : null;
    if (!info || (info.uploaderId !== me.id && !this.host.files.canRead(me.id, info.id))) throw new HelpError('File not found.');
    return info;
  }

  /** Attach a file from the client: a screenshot, diagnostics or a file ('dropped' only comes from help.drop). */
  private attachFile(r: TicketRow, me: PublicUser, fileId: unknown, kindIn: unknown): HelpFile {
    const kind: HelpFileKind = kindIn === 'screenshot' || kindIn === 'diagnostics' ? kindIn : 'file';
    const info = this.fileFor(me, fileId);
    if ((this.db.prepare(`SELECT COUNT(*) AS n FROM help_files WHERE ticket_id = ? AND kind != 'dropped'`).get(r.id) as { n: number }).n >= MAX_FILES) throw new HelpError(`A ticket holds up to ${MAX_FILES} files. Close this one and open another.`);
    const at = Date.now();
    // a file dropped into the session earlier becomes an ordinary attachment (it shows on the ticket)
    this.db.prepare(`INSERT INTO help_files (ticket_id, file_id, kind, by_id, at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(ticket_id, file_id) DO UPDATE SET kind = excluded.kind WHERE help_files.kind = 'dropped'`).run(r.id, info.id, kind, me.id, at);
    return { fileId: info.id, name: info.name, size: info.size, mime: info.mime, kind, by: me.id, at };
  }

  /**
   * Someone left the office (offboarding): tickets they were working on go to the colleague taking
   * over (or back to the queue when that colleague is not on the IT desk), tickets they asked for
   * are closed, and they leave the IT desk.
   */
  handOver(fromId: string, toId: string, actorId: string, why: string): { moved: string[]; released: string[]; closed: string[] } {
    const out = { moved: [] as string[], released: [] as string[], closed: [] as string[] };
    const now = Date.now();
    const toIt = this.isIt(toId) && toId !== fromId;
    for (const r of this.db.prepare(`SELECT * FROM help_tickets WHERE tech_id = ? AND status != 'closed'`).all(fromId) as unknown as TicketRow[]) {
      if (this.live.has(r.id)) this.endSession(r.id, actorId, why);
      if (toIt && r.requester_id !== toId) {
        this.db.prepare(`UPDATE help_tickets SET status = 'taken', tech_id = ?, taken_at = ?, updated_at = ? WHERE id = ?`).run(toId, now, now, r.id);
        this.entry(r.id, actorId, 'taken', why, { from: fromId, to: toId });
        out.moved.push(r.id);
      } else {
        this.db.prepare(`UPDATE help_tickets SET status = 'open', tech_id = NULL, updated_at = ? WHERE id = ?`).run(now, r.id);
        this.entry(r.id, actorId, 'released', why);
        out.released.push(r.id);
      }
      this.publish(r.id);
    }
    for (const r of this.db.prepare(`SELECT * FROM help_tickets WHERE requester_id = ? AND status != 'closed'`).all(fromId) as unknown as TicketRow[]) {
      if (this.live.has(r.id)) this.endSession(r.id, actorId, why);
      this.db.prepare(`UPDATE help_tickets SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?`).run(now, now, r.id);
      this.entry(r.id, actorId, 'note', `${why} The ticket was closed.`);
      this.publish(r.id);
      out.closed.push(r.id);
    }
    if (this.db.prepare('DELETE FROM help_staff WHERE user_id = ?').run(fromId).changes) this.host.broadcast('help.staff', this.staff());
    return out;
  }

  handle(op: string, me: PublicUser, deviceId: string, d: Record<string, unknown>, fromOutside: boolean): unknown {
    switch (op) {
      case 'help.staff':
        return this.staff();
      case 'admin.help.staff':
        return this.setStaff(me, d.userId, d.on);

      case 'help.create': {
        if (me.role === 'guest' || me.role === 'bot') throw new HelpError('Ask the person who invited you for help.');
        const summary = oneLine(d.summary, MAX_SUMMARY);
        if (summary.length < 3) throw new HelpError('Say in a few words what is wrong.');
        const category = CATEGORY_IDS.includes(d.category as HelpCategory) ? d.category as HelpCategory : null;
        if (!category) throw new HelpError('Choose what the problem is about.');
        const open = (this.db.prepare(`SELECT COUNT(*) AS n FROM help_tickets WHERE requester_id = ? AND status != 'closed'`).get(me.id) as { n: number }).n;
        if (open >= MAX_OPEN_PER_PERSON) throw new HelpError('You already have several requests open. Add to one of those instead.');
        const id = ulid();
        const now = Date.now();
        const number = ((this.db.prepare('SELECT MAX(number) AS n FROM help_tickets').get() as { n: number | null }).n ?? 0) + 1;
        const platform = typeof d.platform === 'string' && /^[a-z0-9]{2,16}$/.test(d.platform) ? d.platform : null;
        this.db.prepare(`INSERT INTO help_tickets (id, number, requester_id, summary, detail, category, status, tech_id, created_at, updated_at, platform)
          VALUES (?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?, ?)`).run(id, number, me.id, summary, clean(d.detail, MAX_DETAIL), category, now, now, platform);
        const r = this.row(id)!;
        if (typeof d.screenshot === 'string' && d.screenshot) this.attachFile(r, me, d.screenshot, 'screenshot');
        this.entry(id, me.id, 'opened', null, { category });
        this.host.store.audit(me.id, 'help.opened', id, { number: ticketRef(number), category });
        return this.publish(id);
      }

      case 'help.mine':
        return (this.db.prepare('SELECT * FROM help_tickets WHERE requester_id = ? ORDER BY created_at DESC LIMIT 100').all(me.id) as unknown as TicketRow[]).map((r) => this.view(r));

      case 'help.queue': {
        this.requireIt(me);
        const status = d.status === 'closed' || d.status === 'all' ? d.status : 'active';
        const rows = status === 'active'
          ? this.db.prepare(`SELECT * FROM help_tickets WHERE status != 'closed' ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, created_at`).all()
          : status === 'closed'
            ? this.db.prepare(`SELECT * FROM help_tickets WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 200`).all()
            : this.db.prepare(`SELECT * FROM help_tickets ORDER BY updated_at DESC LIMIT 300`).all();
        return (rows as unknown as TicketRow[]).map((r) => this.view(r));
      }

      case 'help.get': {
        const r = this.visible(me, d.id);
        return { ticket: this.view(r), timeline: this.timeline(r.id) };
      }

      case 'help.take': {
        this.requireIt(me);
        const r = this.visible(me, d.id);
        if (r.requester_id === me.id) throw new HelpError('Someone else on the IT desk takes your own request.');
        if (r.status === 'closed') throw new HelpError('This ticket is closed. The requester can reopen it.');
        if (r.status === 'taken' && r.tech_id && r.tech_id !== me.id) {
          // taking over from a colleague: their live session ends first
          if (this.live.has(r.id)) throw new HelpError('A colleague is in a session on this ticket. Wait until it ends.');
        }
        const before = r.tech_id;
        const now = Date.now();
        this.db.prepare(`UPDATE help_tickets SET status = 'taken', tech_id = ?, taken_at = ?, updated_at = ? WHERE id = ?`).run(me.id, now, now, r.id);
        this.entry(r.id, me.id, 'taken', null, before && before !== me.id ? { from: before } : null);
        this.host.store.audit(me.id, 'help.taken', r.id, { number: ticketRef(r.number), from: before });
        // the technician may have been the only one to hear about it before; tell the previous one too
        const t = this.publish(r.id);
        if (before && before !== me.id) this.host.deliver([before], 'help.updated', t);
        return t;
      }

      case 'help.release': {
        const r = this.visible(me, d.id);
        if (r.tech_id !== me.id) throw new HelpError('Only the technician on this ticket can hand it back.');
        if (this.live.has(r.id)) this.endSession(r.id, me.id, 'The technician handed the ticket back.');
        this.db.prepare(`UPDATE help_tickets SET status = 'open', tech_id = NULL, updated_at = ? WHERE id = ?`).run(Date.now(), r.id);
        this.entry(r.id, me.id, 'released', clean(d.note, MAX_NOTE) || null);
        const t = this.publish(r.id);
        this.host.deliver([me.id], 'help.updated', t);
        return t;
      }

      case 'help.note': {
        const r = this.visible(me, d.id);
        const text = clean(d.text, MAX_NOTE);
        if (!text) throw new HelpError('Write something first.');
        return this.entry(r.id, me.id, 'note', text);
      }

      case 'help.attach': {
        const r = this.visible(me, d.id);
        if (r.status === 'closed') throw new HelpError('This ticket is closed.');
        const f = this.attachFile(r, me, d.fileId, d.kind);
        this.entry(r.id, me.id, f.kind === 'diagnostics' ? 'diagnostics' : 'file', f.name, { fileId: f.fileId, size: f.size, kind: f.kind });
        if (f.kind === 'diagnostics') this.host.store.audit(me.id, 'help.diagnostics', r.id, { fileId: f.fileId, size: f.size });
        return this.publish(r.id);
      }

      case 'help.close': {
        const r = this.visible(me, d.id);
        if (r.requester_id !== me.id && r.tech_id !== me.id) throw new HelpError('The requester or the technician on the ticket closes it.');
        if (r.status === 'closed') return this.view(r);
        if (this.live.has(r.id)) this.endSession(r.id, me.id, null);
        const now = Date.now();
        this.db.prepare(`UPDATE help_tickets SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?`).run(now, now, r.id);
        this.entry(r.id, me.id, 'closed', clean(d.note, MAX_NOTE) || null);
        this.host.store.audit(me.id, 'help.closed', r.id, { number: ticketRef(r.number) });
        return this.publish(r.id);
      }

      case 'help.reopen': {
        const r = this.visible(me, d.id);
        if (r.requester_id !== me.id) throw new HelpError('Only the person who asked can reopen it.');
        if (r.status !== 'closed') return this.view(r);
        const now = Date.now();
        // back to the same technician if they are still on the desk; otherwise to the queue
        const tech = r.tech_id && this.isIt(r.tech_id) ? r.tech_id : null;
        this.db.prepare(`UPDATE help_tickets SET status = ?, tech_id = ?, closed_at = NULL, updated_at = ? WHERE id = ?`).run(tech ? 'taken' : 'open', tech, now, r.id);
        this.entry(r.id, me.id, 'reopened', clean(d.note, MAX_NOTE) || null);
        return this.publish(r.id);
      }

      case 'help.rate': {
        const r = this.visible(me, d.id);
        if (r.requester_id !== me.id) throw new HelpError('Only the person who asked rates the help.');
        const rating = typeof d.rating === 'number' && Number.isInteger(d.rating) && d.rating >= 1 && d.rating <= 5 ? d.rating : null;
        if (!rating) throw new HelpError('Choose from one to five.');
        const note = clean(d.note, 500) || null;
        this.db.prepare('UPDATE help_tickets SET rating = ?, rating_note = ?, updated_at = ? WHERE id = ?').run(rating, note, Date.now(), r.id);
        this.entry(r.id, me.id, 'rated', note, { rating });
        return this.publish(r.id);
      }

      // ---------------------------------------------------------- the support session
      case 'help.session.start': {
        const r = this.visible(me, d.id);
        if (r.tech_id !== me.id || r.status !== 'taken') throw new HelpError('Take the ticket first: only its technician starts a session.');
        const requester = this.host.store.userById(r.requester_id);
        if (!requester) throw new HelpError('The person who asked has left the office.');
        const s = this.live.get(r.id) ?? this.openSession(r, me, requester, false);
        this.lockDevice(s, me, deviceId);
        const room = this.enter(s, me, deviceId, fromOutside);
        this.pushSession(s);
        this.publish(r.id);
        return { session: this.publicSession(s), room };
      }

      case 'help.connect': {
        this.requireIt(me);
        if (this.host.policy().assistUnattended !== true) throw new HelpError('Unattended access is off for this office. An administrator turns it on in Control room ▸ Policies ▸ Remote support.');
        // first everything that can fail: the ticket or the person, and the PC IT will reach; only then any write
        let r: TicketRow | null = null;
        let requester: PublicUser | null;
        if (typeof d.id === 'string' && d.id) {
          r = this.visible(me, d.id);
          if (r.status === 'closed') throw new HelpError('This ticket is closed. Connect from a new one.');
          if (r.requester_id === me.id) throw new HelpError('Someone else on the IT desk connects to your own PC.');
          if (r.tech_id !== me.id && this.live.has(r.id)) throw new HelpError('A colleague is in a session on this ticket. Wait until it ends.');
          requester = this.host.store.userById(r.requester_id);
          if (!requester) throw new HelpError('The person who asked has left the office.');
        } else {
          requester = typeof d.userId === 'string' ? this.host.store.userById(d.userId) : null;
          if (!requester || requester.role === 'bot' || requester.role === 'guest') throw new HelpError('Choose someone in the office.');
          if (requester.id === me.id) throw new HelpError('Someone else on the IT desk connects to your own PC.');
        }
        const existing = r ? this.live.get(r.id) : undefined;
        const target = this.unattendedTarget(requester, existing);
        if (!target) throw new HelpError(`${requester.displayName}'s PC is not online. Unattended access needs Dexterity Connect running on their Windows or Linux PC, on the office network.`);
        if (r && r.tech_id !== me.id) {
          const now = Date.now();
          this.db.prepare(`UPDATE help_tickets SET status = 'taken', tech_id = ?, taken_at = ?, updated_at = ? WHERE id = ?`).run(me.id, now, now, r.id);
          this.entry(r.id, me.id, 'taken', null, r.tech_id ? { from: r.tech_id } : null);
          this.host.store.audit(me.id, 'help.taken', r.id, { number: ticketRef(r.number), from: r.tech_id });
          r = this.row(r.id)!;
        }
        r ??= this.row(this.openForIt(me, requester.id, `Remote support from ${me.displayName}`, { unattended: true }))!;
        let s = this.live.get(r.id);
        if (s && !s.unattended) {
          // an attended session already running becomes unattended from here on
          s.unattended = true;
          this.db.prepare('UPDATE help_sessions SET unattended = 1 WHERE id = ?').run(s.id);
          this.entry(r.id, me.id, 'session.started', 'IT connected without asking (unattended access).', { sessionId: s.id, unattended: true });
          this.host.store.audit(me.id, 'help.unattended.started', r.id, { session: s.id, requester: requester.account });
        }
        s ??= this.openSession(r, me, requester, true);
        s.requesterDevice = target;
        // IT connecting again is a new request: what the person stopped before may be given again
        s.stopped = false;
        this.lockDevice(s, me, deviceId);
        const room = this.enter(s, me, deviceId, fromOutside);
        this.pushSession(s);
        this.publish(r.id);
        return { session: this.publicSession(s), room };
      }

      // a desktop app says whether it can be controlled (what unattended access may choose)
      case 'help.device':
        if (d.control === true) this.controllable.add(deviceId); else this.controllable.delete(deviceId);
        return { ok: true };

      case 'help.drop': {
        const r = this.visible(me, d.id);
        const s = this.live.get(r.id);
        if (!s || (me.id !== s.requesterId && me.id !== s.techId)) throw new HelpError('Drop files from inside the session.');
        if (this.host.policy().assistFiles !== true) throw new HelpError('Dropping files into a session is off for this office. Use Send a file.');
        const myDevice = me.id === s.requesterId ? s.requesterDevice : s.techDevice;
        if (myDevice && myDevice !== deviceId) throw new HelpError('Drop files from the device that is in the session.');
        const list = Array.isArray(d.files) ? d.files.slice(0, DROP_MAX_FILES) : [];
        if (!list.length) throw new HelpError('Nothing to send.');
        // every file checked before any is attached: all of them or none, and always audited
        const files = list.map((x) => {
          const v = (x ?? {}) as { fileId?: unknown; path?: unknown };
          const info = this.fileFor(me, v.fileId);
          const segs = typeof v.path === 'string' ? safeRelativePath(v.path) : null;
          if (!segs) throw new HelpError(`A file has a name that cannot be saved: ${info.name}`);
          return { info, path: segs.join('/') };
        });
        const already = (this.db.prepare(`SELECT COUNT(*) AS n FROM help_files WHERE ticket_id = ? AND kind = 'dropped'`).get(r.id) as { n: number }).n;
        if (already + files.length > MAX_DROPPED) throw new HelpError(`A ticket takes up to ${MAX_DROPPED} dropped files. Send the rest as a zip, or open another ticket.`);
        const at = Date.now();
        const insert = this.db.prepare('INSERT OR IGNORE INTO help_files (ticket_id, file_id, kind, by_id, at) VALUES (?, ?, ?, ?, ?)');
        this.db.exec('BEGIN');
        try { for (const f of files) insert.run(r.id, f.info.id, 'dropped', me.id, at); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; }
        const size = files.reduce((n, f) => n + f.info.size, 0);
        const folder = oneLine(d.folder, 120) || null;
        const what = folder ? `${files.length} file${files.length === 1 ? '' : 's'} from the folder ${folder}` : files.length === 1 ? files[0].info.name : `${files.length} files`;
        const to = me.id === s.techId ? s.requesterId : s.techId;
        this.entry(r.id, me.id, 'file', what, { dropped: files.length, size, folder, names: files.slice(0, 5).map((f) => f.info.name) });
        this.host.store.audit(me.id, 'help.files.dropped', r.id, { session: s.id, count: files.length, size, folder, to });
        // the other side hears through the hub (not the data channel: nothing is lost to its limits)
        this.host.deliver([to], 'help.dropped', { ticketId: r.id, sessionId: s.id, files: files.map((f) => ({ fileId: f.info.id, path: f.path, size: f.info.size })) });
        return { ok: true, count: files.length };
      }

      case 'help.live':
        return [...this.live.values()].filter((s) => s.requesterId === me.id || s.techId === me.id).map((s) => this.publicSession(s));

      case 'help.session.join': {
        const r = this.visible(me, d.id);
        const s = this.live.get(r.id);
        if (!s) throw new HelpError('There is no session on this ticket now.');
        // only the requester and the assigned technician, never another colleague
        if (me.id !== s.requesterId && me.id !== s.techId) throw new HelpError('Only the person who asked and their technician are in a support session.');
        this.lockDevice(s, me, deviceId);
        if (me.id === s.requesterId) s.controlAvailable = d.controlAvailable === true;
        const room = this.enter(s, me, deviceId, fromOutside);
        if (me.id === s.requesterId) this.entry(r.id, me.id, 'session.joined', null, { sessionId: s.id });
        this.pushSession(s);
        return { session: this.publicSession(s), room };
      }

      case 'help.session.end': {
        const r = this.visible(me, d.id);
        const s = this.live.get(r.id);
        if (!s) return { ok: true };
        if (me.id !== s.requesterId && me.id !== s.techId) throw new HelpError('Only the people in the session can end it.');
        this.endSession(r.id, me.id, null);
        return { ok: true };
      }

      case 'help.consent': {
        const r = this.visible(me, d.id);
        const s = this.live.get(r.id);
        if (!s) throw new HelpError('There is no session on this ticket now.');
        if (me.id !== s.requesterId) throw new HelpError('Only the person being helped can allow or stop this.');
        const kind = d.kind === 'control' ? 'control' : d.kind === 'screen' ? 'screen' : null;
        if (!kind) throw new HelpError('Unknown permission.');
        const on = d.on === true;
        if (on && s.pausedAt !== null) throw new HelpError('IT is not connected right now. The session goes on when both of you are back.');
        this.setConsent(s, kind, on, d.scope === 'window' ? 'window' : 'screen', me.id);
        return this.publicSession(s);
      }

      case 'help.ask': {
        const r = this.visible(me, d.id);
        const s = this.live.get(r.id);
        if (!s || me.id !== s.techId) throw new HelpError('Ask from inside the session.');
        const kind = d.kind === 'control' || d.kind === 'diagnostics' ? d.kind : 'screen';
        if (kind === 'control' && !s.controlAvailable) throw new HelpError('Their PC cannot be controlled from here (macOS needs Accessibility permission, phones cannot). Guide them over the call instead.');
        if (kind === 'control' && (!s.consent.screen || s.consent.scope !== 'screen')) throw new HelpError('Ask them to share their whole screen first.');
        this.entry(r.id, me.id, 'asked', null, { kind });
        this.host.deliver([s.requesterId], 'help.ask', { ticketId: r.id, kind, by: me.id });
        return { ok: true };
      }
    }
    return undefined;
  }

  /** A ticket IT opens itself for work it starts (unattended or elevated access), held by the technician. Returns its id. */
  openForIt(me: PublicUser, requesterId: string, summary: string, detail: Record<string, unknown>): string {
    const id = ulid();
    const now = Date.now();
    const number = ((this.db.prepare('SELECT MAX(number) AS n FROM help_tickets').get() as { n: number | null }).n ?? 0) + 1;
    this.db.prepare(`INSERT INTO help_tickets (id, number, requester_id, summary, detail, category, status, tech_id, created_at, updated_at, taken_at)
      VALUES (?, ?, ?, ?, '', 'other', 'taken', ?, ?, ?, ?)`).run(id, number, requesterId, oneLine(summary, MAX_SUMMARY), me.id, now, now, now);
    this.entry(id, me.id, 'opened', 'Opened by IT to connect to this PC.', { category: 'other', byIt: true });
    this.host.store.audit(me.id, 'help.opened', id, { number: ticketRef(number), category: 'other', for: requesterId, ...detail });
    this.publish(id);
    return id;
  }

  /** A line on a ticket's timeline from elsewhere in the hub (elevated sessions), told to its audience. */
  record(ticketId: string, actor: string | null, kind: HelpEntryKind, text: string | null, detail: Record<string, unknown>): void {
    if (!this.row(ticketId)) return;
    this.entry(ticketId, actor, kind, text, detail);
    this.publish(ticketId);
  }

  /** A new session on a ticket the technician holds; unattended when IT connected without asking. */
  private openSession(r: TicketRow, me: PublicUser, requester: PublicUser, unattended: boolean): LiveSession {
    const conv = this.host.messaging.handle('conv.create', me, { kind: 'direct', members: [requester.id] }) as { id: string };
    const s: LiveSession = {
      id: ulid(), ticketId: r.id, roomId: null, requesterId: requester.id, techId: me.id, startedAt: Date.now(), endedAt: null,
      consent: { screen: false, scope: null, control: false, screenSince: null, controlSince: null }, controlAvailable: false,
      unattended, pausedAt: null, requesterDevice: null, techDevice: null, stopped: false, together: false, convId: conv.id, grants: [], timer: null,
    };
    this.live.set(r.id, s);
    this.db.prepare('INSERT INTO help_sessions (id, ticket_id, requester_id, tech_id, started_at, unattended) VALUES (?, ?, ?, ?, ?, ?)').run(s.id, r.id, s.requesterId, s.techId, s.startedAt, unattended ? 1 : 0);
    this.entry(r.id, me.id, 'session.started', unattended ? 'IT connected without asking (unattended access).' : null, { sessionId: s.id, ...(unattended ? { unattended: true } : {}) });
    this.host.store.audit(me.id, 'help.session.started', r.id, { session: s.id, requester: requester.account, ...(unattended ? { unattended: true } : {}) });
    if (unattended) this.host.store.audit(me.id, 'help.unattended.started', r.id, { session: s.id, requester: requester.account });
    return s;
  }

  /** Each person is in a session from one device: the first they join from (unattended: the one the hub chose). */
  private lockDevice(s: LiveSession, me: PublicUser, deviceId: string): void {
    if (me.id === s.requesterId) {
      if (s.requesterDevice && s.requesterDevice !== deviceId) throw new HelpError(s.unattended ? 'IT is connected to another of your devices.' : 'You are in this session on another of your devices.');
      s.requesterDevice = deviceId;
    } else if (me.id === s.techId) {
      if (s.techDevice && s.techDevice !== deviceId) throw new HelpError('You are in this session on another of your devices.');
      s.techDevice = deviceId;
    }
  }

  /**
   * An administrator changed the policies: unattended access turned off takes control back at once
   * in sessions IT connected to without asking (they go on as ordinary sessions the person decides
   * in); reconnect turned off ends sessions waiting for a dropped connection.
   */
  policyChanged(p: OfficePolicy): void {
    for (const s of [...this.live.values()]) {
      if (s.unattended && p.assistUnattended !== true) {
        s.unattended = false;
        // the screen was shared and control given by the app, not by the person: both stop
        if (s.consent.control) this.setConsent(s, 'control', false, 'screen', null);
        if (s.consent.screen) this.setConsent(s, 'screen', false, 'screen', null);
        this.entry(s.ticketId, null, 'note', 'An administrator turned unattended access off: sharing and control stopped. The person decides from here.', { sessionId: s.id });
        this.host.store.audit(null, 'help.unattended.ended', s.ticketId, { session: s.id, why: 'policy turned off' });
        this.pushSession(s);
      }
      if (s.pausedAt !== null && p.assistReconnect !== true) this.endSession(s.ticketId, null, 'Reconnecting was turned off by an administrator.');
    }
  }

  /** Someone came back to a session that was waiting for its connection. */
  private resumed(s: LiveSession, actor: string | null): void {
    if (s.pausedAt === null) return;
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    const pausedMs = Date.now() - s.pausedAt;
    s.pausedAt = null;
    this.entry(s.ticketId, actor, 'session.resumed', null, { sessionId: s.id, pausedMs });
    this.host.store.audit(actor, 'help.session.resumed', s.ticketId, { session: s.id, pausedMs, unattended: s.unattended });
  }

  private enter(s: LiveSession, me: PublicUser, deviceId: string, fromOutside: boolean): RoomInfo {
    const room = this.host.rooms.enterPurpose({ convId: s.convId, purpose: { kind: 'support', ticketId: s.ticketId }, only: [s.requesterId, s.techId] }, me, deviceId, fromOutside);
    s.roomId = room.id;
    return room;
  }

  private pushSession(s: LiveSession): void {
    this.host.deliver([s.requesterId, s.techId], 'help.session', this.publicSession(s));
  }

  private saveGrants(s: LiveSession): void {
    this.db.prepare('UPDATE help_sessions SET grants = ? WHERE id = ?').run(JSON.stringify(s.grants), s.id);
  }

  /** Grant or take back screen or control; every change is on the timeline and in the audit log. */
  private setConsent(s: LiveSession, kind: 'screen' | 'control', on: boolean, scope: 'screen' | 'window', actor: string | null): void {
    const c: SupportConsent = s.consent;
    // the person stopping something in an unattended session: it is not given again by itself
    if (!on && actor === s.requesterId && s.unattended && (kind === 'control' ? c.control : c.screen)) s.stopped = true;
    const now = Date.now();
    if (kind === 'control' && on) {
      if (!c.screen || c.scope !== 'screen') throw new HelpError('Share your whole screen first: control works on a whole screen.');
      if (!s.controlAvailable) throw new HelpError('This PC cannot be controlled remotely.');
    }
    const close = (k: 'screen' | 'control') => {
      const g = [...s.grants].reverse().find((x) => x.kind === k && x.to === null);
      if (!g) return;
      g.to = now;
      const durationMs = g.to - g.from;
      this.entry(s.ticketId, actor, 'consent.revoked', null, { kind: k, scope: g.scope, durationMs });
      this.host.store.audit(actor, 'help.consent.revoked', s.ticketId, { session: s.id, kind: k, scope: g.scope, from: g.from, to: g.to, durationMs, technician: s.techId });
    };
    if (kind === 'screen') {
      if (on) {
        if (c.screen && c.scope === scope) return;
        if (c.control) { close('control'); c.control = false; c.controlSince = null; }
        if (c.screen) close('screen');
        c.screen = true; c.scope = scope; c.screenSince = now;
        s.grants.push({ kind: 'screen', scope, from: now, to: null });
        this.entry(s.ticketId, actor, 'consent.granted', null, { kind: 'screen', scope });
        this.host.store.audit(actor, 'help.consent.granted', s.ticketId, { session: s.id, kind: 'screen', scope, technician: s.techId, ...(s.unattended ? { unattended: true } : {}) });
      } else {
        if (!c.screen) return;
        // control needs the screen: it stops with it
        if (c.control) { close('control'); c.control = false; c.controlSince = null; }
        close('screen');
        c.screen = false; c.scope = null; c.screenSince = null;
      }
    } else if (on) {
      if (c.control) return;
      c.control = true; c.controlSince = now;
      s.grants.push({ kind: 'control', scope: 'screen', from: now, to: null });
      this.entry(s.ticketId, actor, 'consent.granted', null, { kind: 'control' });
      this.host.store.audit(actor, 'help.consent.granted', s.ticketId, { session: s.id, kind: 'control', technician: s.techId, ...(s.unattended ? { unattended: true } : {}) });
    } else {
      if (!c.control) return;
      close('control');
      c.control = false; c.controlSince = null;
    }
    this.saveGrants(s);
    this.pushSession(s);
    this.publish(s.ticketId);
  }

  /** End a ticket's session: consent goes, the Room closes for both, the duration is recorded. */
  private endSession(ticketId: string, actor: string | null, why: string | null): void {
    const s = this.live.get(ticketId);
    if (!s) return;
    if (s.consent.control) this.setConsent(s, 'control', false, 'screen', actor);
    if (s.consent.screen) this.setConsent(s, 'screen', false, 'screen', actor);
    this.live.delete(ticketId);
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    s.endedAt = Date.now();
    this.db.prepare('UPDATE help_sessions SET ended_at = ?, grants = ? WHERE id = ?').run(s.endedAt, JSON.stringify(s.grants), s.id);
    const durationMs = s.endedAt - s.startedAt;
    this.entry(ticketId, actor, 'session.ended', why, { sessionId: s.id, durationMs });
    this.host.store.audit(actor, 'help.session.ended', ticketId, { session: s.id, durationMs, grants: s.grants, ...(s.unattended ? { unattended: true } : {}) });
    if (s.unattended) this.host.store.audit(actor, 'help.unattended.ended', ticketId, { session: s.id, durationMs });
    this.host.rooms.endPurpose({ kind: 'support', ticketId }, actor ?? undefined);
    this.host.deliver([s.requesterId, s.techId], 'help.session', this.publicSession(s));
    this.publish(ticketId);
  }

  /** The session's Room ended (both left, or a PC dropped off): the session ends with it. */
  roomEnded(room: RoomInfo): void {
    if (room.purpose?.kind !== 'support') return;
    const s = this.live.get(room.purpose.ticketId);
    if (!s || s.roomId !== room.id) return;
    if (this.host.policy().assistReconnect !== true) { this.endSession(s.ticketId, null, null); return; }
    s.roomId = null;
    this.pause(s);
  }

  /**
   * The session waits for both people (policy assistReconnect): what was shared stops at once, and
   * nothing is shared again until both are back in the Room; it ends if they are not back in time.
   */
  private pause(s: LiveSession): void {
    if (s.consent.control) this.setConsent(s, 'control', false, 'screen', null);
    if (s.consent.screen) this.setConsent(s, 'screen', false, 'screen', null);
    if (s.pausedAt !== null) return;
    s.pausedAt = Date.now();
    const minutes = Math.round(this.reconnectGraceMs / 60_000);
    this.entry(s.ticketId, null, 'session.paused', `The connection dropped. The session waits ${minutes} minute${minutes === 1 ? '' : 's'} for it to come back.`, { sessionId: s.id });
    this.host.store.audit(null, 'help.session.paused', s.ticketId, { session: s.id, unattended: s.unattended });
    s.timer = setTimeout(() => {
      if (this.live.get(s.ticketId) === s && s.pausedAt !== null) this.endSession(s.ticketId, null, 'The connection did not come back in time.');
    }, this.reconnectGraceMs);
    s.timer.unref?.();
    this.pushSession(s);
    this.publish(s.ticketId);
  }

  /**
   * The Room changed. Either person missing: anything shared stops being shared (nobody shares into
   * an empty Room), and once they had been in together, the session waits for them (policy
   * assistReconnect). Both in again: the session goes on.
   */
  roomChanged(room: RoomInfo): void {
    if (room.purpose?.kind !== 'support') return;
    const s = this.live.get(room.purpose.ticketId);
    if (!s || s.roomId !== room.id) return;
    const requesterIn = room.participants.some((p) => p.userId === s.requesterId);
    const techIn = room.participants.some((p) => p.userId === s.techId);
    if (requesterIn && techIn) {
      s.together = true;
      if (s.pausedAt !== null) { this.resumed(s, null); this.pushSession(s); this.publish(s.ticketId); }
      return;
    }
    if (s.together && this.host.policy().assistReconnect === true) { this.pause(s); return; }
    if (s.consent.screen || s.consent.control) this.setConsent(s, 'screen', false, 'screen', null);
  }

  /** The PC unattended access reaches: the one already in the session, or the person's controllable desktop in use. */
  private unattendedTarget(requester: PublicUser, s: LiveSession | undefined): string | null {
    const online = this.host.devicesOf(requester.id).filter((x) => !x.remote && this.controllable.has(x.deviceId));
    // a device chosen before that never came (or went away) may be chosen again
    if (s?.requesterDevice && online.some((x) => x.deviceId === s.requesterDevice)) return s.requesterDevice;
    return (online.filter((x) => !x.idle).at(-1) ?? online.at(-1))?.deviceId ?? null;
  }
}
