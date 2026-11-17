// The office's days off (docs/HOLIDAYS.md): the one list scheduled bot jobs, Nib's workdays and
// hot-desk booking all go by, with a kind per day (holiday, Saturday off, compensatory day off,
// compensatory WORKING day) and where each came from. Kept as one JSON value in `meta`
// (`office_holidays`, which older hubs filled with { date, name } only).
//
// Holiday circulars: an administrator gives Nib the year's PDF, the hub reads its text with pdf.ts
// (a scan has none: the desktop can OCR it and send the text), @dex/core/holidays turns it into
// checked rows, and registering applies them. The same file twice changes nothing; a revised
// circular for the same year shows what it adds, changes and removes. A fresh hub registers the
// 2026 circular once, from seed/holidays-2026.json (made from the PDF by scripts/holiday-seed.ts).
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ulid } from '@dex/core';
import type { PublicUser } from '@dex/core';
import { applyCircular, isOffKind, kindCounts, officeDayIn, planCircular, readCircular } from '@dex/core/holidays';
import type { CircularRead, CircularRecord, HolidayReadState, HolidayReadView, OfficeDay, OfficeDayKind } from '@dex/core/holidays';
import type { FileStore } from './files.ts';
import type { Store } from './store.ts';
import { PdfError, readPdf } from './pdf.ts';
import seed2026 from '../seed/holidays-2026.json' with { type: 'json' };

export class HolidaysError extends Error {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS holiday_reads (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, file_id TEXT, file_name TEXT NOT NULL, hash TEXT NOT NULL,
  state TEXT NOT NULL, read TEXT, error TEXT, ocr INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, done TEXT
);
CREATE INDEX IF NOT EXISTS idx_holiday_reads_user ON holiday_reads(user_id, created_at);
`;
const MAX_PDF = 32 * 1024 * 1024;
const MAX_TEXT = 60_000;
/** Days kept: a few years of circulars and the odd typed-in day. */
const MAX_DAYS = 600;

interface ReadRow { id: string; user_id: string; file_id: string | null; file_name: string; hash: string; state: HolidayReadState; read: string | null; error: string | null; ocr: number; created_at: number; done: string | null }

/** Seed data as scripts/holiday-seed.ts writes it: the PDF's provenance and the rows read from it. */
export interface HolidaySeed { source: { file: string; hash: string; ref: string | null; refDate: string | null; pages: number }; read: CircularRead }

export interface HolidaysDeps {
  db: DatabaseSync;
  store: Store;
  files: FileStore;
  audit: (actor: string | null, action: string, target: string | null, detail?: unknown) => void;
  log: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
  now?: () => number;
  /** Register the built-in 2026 circular on first start (default on; tests turn it off). */
  seed?: boolean;
}

const isAdmin = (u: PublicUser) => u.role === 'owner' || u.role === 'admin';
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

export class Holidays {
  private readonly d: HolidaysDeps;
  private readonly db: DatabaseSync;
  private cache: { list: OfficeDay[]; off: Map<string, OfficeDay>; extra: Map<string, OfficeDay> } | null = null;
  /** Told after every change (the job scheduler forgets what it worked out). */
  readonly changed: Array<() => void> = [];

  constructor(d: HolidaysDeps) {
    this.d = d;
    this.db = d.db;
    this.db.exec(SCHEMA);
    if (d.seed !== false) this.seed(seed2026 as unknown as HolidaySeed);
  }
  private now(): number { return this.d.now?.() ?? Date.now(); }

  // ------------------------------------------------------------ the list
  list(): OfficeDay[] { return this.state().list; }
  private state() {
    if (this.cache) return this.cache;
    let raw: unknown = [];
    try { raw = JSON.parse(this.d.store.meta('office_holidays', () => '[]')); } catch { raw = []; }
    const list = (Array.isArray(raw) ? raw : []).map(officeDayIn).filter((x): x is OfficeDay => !!x).sort((a, b) => a.date.localeCompare(b.date));
    const off = new Map<string, OfficeDay>(); const extra = new Map<string, OfficeDay>();
    for (const x of list) (isOffKind(x.kind) ? off : extra).set(x.date, x);
    this.cache = { list, off, extra };
    return this.cache;
  }
  private save(list: OfficeDay[]): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('office_holidays', JSON.stringify(list.slice(0, MAX_DAYS)));
    this.cache = null;
    for (const f of this.changed) { try { f(); } catch { /* a listener's own problem */ } }
  }
  /** Nobody works this day (a holiday, a Saturday off, a compensatory day off). */
  isOff(date: string): boolean { return this.state().off.has(date); }
  /** A compensatory working day (a working day even when its weekday is not). */
  isExtra(date: string): boolean { return this.state().extra.has(date); }
  /** The parts of the office calendar (@dex/core/botjobs OfficeCalendar) that come from this list. */
  calendarPart(): { holidays: Array<{ date: string; name: string; kind: OfficeDayKind }>; extraWorkdays: Array<{ date: string; name: string }> } {
    const s = this.state();
    return { holidays: [...s.off.values()].map((x) => ({ date: x.date, name: x.name, kind: x.kind })), extraWorkdays: [...s.extra.values()].map((x) => ({ date: x.date, name: x.name })) };
  }
  circulars(): CircularRecord[] {
    let raw: unknown = [];
    try { raw = JSON.parse(this.d.store.meta('office_circulars', () => '[]')); } catch { raw = []; }
    return (Array.isArray(raw) ? raw as CircularRecord[] : []).filter((c) => c && typeof c.hash === 'string').sort((a, b) => b.at - a.at);
  }
  private record(c: CircularRecord): void {
    const list = [c, ...this.circulars().filter((x) => x.hash !== c.hash)].slice(0, 40);
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('office_circulars', JSON.stringify(list));
  }

  /** An administrator's edits in Office holidays: a day read from a circular keeps its source while it is unchanged. */
  setByAdmin(me: PublicUser, input: unknown): OfficeDay[] {
    if (!isAdmin(me)) throw new HolidaysError('Only administrators can change the office’s holidays.');
    const was = new Map(this.list().map((x) => [x.date, x] as const));
    const seen = new Set<string>();
    const list = (Array.isArray(input) ? input : []).slice(0, MAX_DAYS).map((h) => {
      const r = (h ?? {}) as Record<string, unknown>;
      const x = officeDayIn({ date: r.date, name: r.name, kind: r.kind, for: r.for });
      if (!x) throw new HolidaysError('Each holiday has a date (2026-11-08) and a name.');
      if (seen.has(x.date)) throw new HolidaysError(`${x.date} is in the list twice.`);
      seen.add(x.date);
      const old = was.get(x.date);
      return old?.source && old.name === x.name && old.kind === x.kind && (old.for ?? null) === (x.for ?? null) ? { ...x, source: old.source } : x;
    }).sort((a, b) => a.date.localeCompare(b.date));
    this.save(list);
    this.d.audit(me.id, 'botjob.holidays', null, { count: list.length });
    return list;
  }

  // ------------------------------------------------------------ circulars
  private row(id: string): ReadRow | undefined { return this.db.prepare('SELECT * FROM holiday_reads WHERE id = ?').get(id) as ReadRow | undefined; }

  /** Read a circular someone gave Nib (or picked in Office holidays). */
  read(me: PublicUser, fileId: string): HolidayReadView {
    const info = this.d.files.info(fileId);
    if (!info || !this.d.files.canRead(me.id, fileId)) throw new HolidaysError('That file was not found.');
    const id = ulid();
    const now = this.now();
    const insert = (state: HolidayReadState, hash: string, read: CircularRead | null, error: string | null = null) =>
      this.db.prepare('INSERT INTO holiday_reads (id, user_id, file_id, file_name, hash, state, read, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, me.id, fileId, info.name.slice(0, 200), hash, state, read ? JSON.stringify(read) : null, error, now);
    if (!isAdmin(me)) { insert('denied', '', null); return this.view(me, id); }
    const buf = this.d.files.read(fileId, MAX_PDF);
    if (!buf) { insert('unreadable', '', null, info.sealed ? 'That file is encrypted end to end, so the hub cannot read it.' : 'That PDF is too large to read (over 32 MB).'); return this.view(me, id); }
    const hash = sha(buf);
    let lines: string[] = [];
    try { lines = readPdf(buf, info.name).lines; } catch (err) {
      if (!(err instanceof PdfError)) this.d.log('warn', 'holiday circular not read', { error: (err as Error).message });
      insert('unreadable', hash, null, err instanceof PdfError ? err.message : 'The PDF could not be read.');
      return this.view(me, id);
    }
    const read = readCircular(lines);
    insert(read.textless ? 'textless' : read.rows.length ? 'open' : 'notCircular', hash, read);
    return this.view(me, id);
  }

  /** The text the desktop read from a scan (OCR), for a read that found none. */
  readText(me: PublicUser, id: string, text: string): HolidayReadView {
    const r = this.row(id);
    if (!r || r.user_id !== me.id) throw new HolidaysError('That circular was not found.');
    if (r.state !== 'textless' && !(r.state === 'notCircular' && r.ocr)) throw new HolidaysError('That circular has text already.');
    const read = readCircular(text.slice(0, MAX_TEXT).split(/\r?\n/));
    const state: HolidayReadState = read.rows.length ? 'open' : read.textless ? 'textless' : 'notCircular';
    this.db.prepare('UPDATE holiday_reads SET read = ?, state = ?, ocr = 1 WHERE id = ?').run(JSON.stringify(read), state, id);
    return this.view(me, id);
  }

  /** A read as its card shows it, with the plan worked out against the list as it is now. */
  view(me: PublicUser, id: string): HolidayReadView {
    const r = this.row(id);
    if (!r || (r.user_id !== me.id && !isAdmin(me))) throw new HolidaysError('This card is not for you.');
    const read = r.read ? JSON.parse(r.read) as CircularRead : null;
    const done = r.done ? JSON.parse(r.done) as HolidayReadView['done'] : null;
    const plan = read && read.rows.length ? planCircular(read, this.list(), r.hash, this.circulars()) : null;
    let state = r.state;
    if (state === 'open' && plan?.already) state = 'already';
    return {
      id: r.id, state, userId: r.user_id, fileId: r.file_id, file: r.file_name, hash: r.hash, ocr: !!r.ocr, error: r.error, read, plan,
      canRegister: isAdmin(me) && state === 'open' && !!plan && plan.rows.length > 0, done,
    };
  }

  /** Register a read: apply it to the list, remember the circular, audit it. */
  register(me: PublicUser, id: string): HolidayReadView {
    if (!isAdmin(me)) throw new HolidaysError('Only administrators can register office holidays.');
    const r = this.row(id);
    if (!r || !r.read) throw new HolidaysError('That circular was not found.');
    const v = this.view(me, id);
    if (v.state === 'registered') return v;
    if (v.state === 'already' && v.plan?.already?.ref) throw new HolidaysError(`This circular was registered already, from Ref ${v.plan.already.ref}.`);
    if (v.state === 'already') throw new HolidaysError('This circular was registered already.');
    if (!v.canRegister || !v.plan || !v.read) throw new HolidaysError('There is nothing in this circular to register.');
    const { read, plan } = v;
    const year = read.year ?? Number(plan.rows[0].date.slice(0, 4));
    this.save(applyCircular(this.list(), read, plan, { ref: read.ref, refDate: read.refDate, file: r.file_name, hash: r.hash }));
    const at = this.now();
    this.record({ hash: r.hash, ref: read.ref, refDate: read.refDate, year, file: r.file_name, at, by: me.id, counts: plan.counts });
    const done = { at, by: me.id, added: plan.added, updated: plan.updated, removed: plan.removed.length, counts: plan.counts, exceptions: plan.exceptions.length };
    this.db.prepare(`UPDATE holiday_reads SET state = 'registered', done = ? WHERE id = ?`).run(JSON.stringify(done), id);
    this.d.audit(me.id, 'holidays.circular', null, {
      ref: read.ref, refDate: read.refDate, file: r.file_name, hash: r.hash, year, ocr: !!r.ocr,
      added: plan.added, updated: plan.updated, removed: plan.removed.map((x) => x.date), counts: plan.counts, exceptions: plan.exceptions.map((x) => x.sl ?? x.dateText),
    });
    return this.view(me, id);
  }

  /**
   * The built-in circular, once: only days not in the list yet are added (an administrator's own
   * days are never touched), and the flag means it is never applied again, even after edits.
   */
  seed(s: HolidaySeed): void {
    const key = `holidays_seeded_${s.source.hash.slice(0, 16)}`;
    if (this.db.prepare('SELECT 1 FROM meta WHERE key = ?').get(key)) return;
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(key, String(this.now()));
    const circulars = this.circulars();
    if (circulars.some((c) => c.hash === s.source.hash)) return;
    const existing = this.list();
    const plan = planCircular(s.read, existing, s.source.hash, circulars);
    const fresh = { ...plan, rows: plan.rows.filter((x) => x.change === 'new'), removed: [] };
    this.save(applyCircular(existing, s.read, fresh, { ref: s.read.ref, refDate: s.read.refDate, file: s.source.file, hash: s.source.hash }));
    this.record({ hash: s.source.hash, ref: s.read.ref, refDate: s.read.refDate, year: s.read.year ?? 0, file: s.source.file, at: this.now(), by: null, counts: kindCounts(fresh.rows) });
    this.d.log('info', 'office holidays registered from the built-in circular', { ref: s.read.ref, days: fresh.rows.length });
  }
}

