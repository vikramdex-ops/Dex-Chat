// Scheduled bot jobs on the hub (docs/BOT-NETWORK.md §5): a bot's jobs run on their schedule in
// the office's time, on working days, never in the quiet hours; runs missed while the hub was off
// are skipped or caught up once; a job can be paused, have its next run skipped, a run moved once,
// be run now, or dry-run (what it would do, with nothing sent). Every run is stamped in its history
// (RAN, SKIPPED, FAILED, DRY), the maker hears once a day when one fails, and all of it is audited.
// The clock is injected (`now`), and the rules are pure functions in @dex/core/botjobs.
import type { DatabaseSync } from 'node:sqlite';
import { ulid } from '@dex/core';
import type { BotFlowAnswer, BotFlowDefinition, BotJob, BotJobLane, BotJobPeople, BotJobRun, BotJobSheet, PublicUser } from '@dex/core';
import { renderTemplate, testCondition } from '@dex/core/botflows';
import { describeRule, hm, inQuiet, isWorkingDay, nextRuns, officeParts, parseSchedule, planDue, runsBetween } from '@dex/core/botjobs';
import type { JobState, OfficeCalendar, ScheduleRule } from '@dex/core/botjobs';
import { HolidaysError } from './holidays.ts';
import type { Holidays } from './holidays.ts';
import type { BotItems } from './botitems.ts';
import type { BotNet, NetBot, NetHost } from './botnet.ts';
import type { Desk } from './desk.ts';
import type { Messaging } from './messaging.ts';
import type { Store } from './store.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bot_job_state (
  flow TEXT NOT NULL,
  job TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  skip_at INTEGER,
  moved TEXT NOT NULL DEFAULT '[]',
  alerted TEXT,
  PRIMARY KEY (flow, job)
);
CREATE TABLE IF NOT EXISTS bot_job_runs (
  id TEXT PRIMARY KEY,
  flow TEXT NOT NULL,
  job TEXT NOT NULL,
  at INTEGER NOT NULL,
  ran_at INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  note TEXT NOT NULL,
  lines TEXT NOT NULL DEFAULT '[]',
  by TEXT
);
CREATE INDEX IF NOT EXISTS idx_bot_job_runs ON bot_job_runs(flow, job, at);
`;

const DAY = 24 * 3600_000;
/** Runs one tick may make (the rest go on the next tick, a few seconds later), and per maker. */
export const JOB_TICK_MAX = 6;
export const JOB_OWNER_MAX = 3;
/** People one run may start a bot for or remind. */
const JOB_PEOPLE_MAX = 60;

export class BotJobsError extends Error { override name = 'BotJobsError'; }

export interface BotJobsDeps {
  db: DatabaseSync;
  store: Store;
  messaging: Messaging;
  desk: Desk;
  log: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
  now: () => number;
  calendar: () => OfficeCalendar;
  /** The office's days off, with their kinds and sources (holidays.ts). */
  days: Holidays;
  deliver: (userIds: string[], name: string, data: unknown) => void;
  host: NetHost;
  net: BotNet;
  items: BotItems;
  startFor: (person: PublicUser, name: string) => Promise<'started' | 'busy' | 'cannot'>;
  leadOf: (userId: string) => PublicUser | null;
}

interface StateRow { flow: string; job: string; checked_at: number; paused: number; skip_at: number | null; moved: string; alerted: string | null }
interface RunRow { id: string; flow: string; job: string; at: number; ran_at: number; outcome: BotJobRun['outcome']; note: string; lines: string; by: string | null }

const parse = <T>(raw: string | null | undefined, fallback: T): T => { if (!raw) return fallback; try { return JSON.parse(raw) as T; } catch { return fallback; } };
const toRun = (r: RunRow): BotJobRun => ({ id: r.id, flow: r.flow, job: r.job, at: r.at, ranAt: r.ran_at, outcome: r.outcome, note: r.note, lines: parse(r.lines, []), by: r.by });

export class BotJobs {
  private readonly db: DatabaseSync;
  private readonly d: BotJobsDeps;
  private readonly rules = new Map<string, ScheduleRule | null>();
  /** Jobs running now (one run of a job at a time). */
  private readonly running = new Set<string>();
  /** Leave from Nib (set by the hub): on leave that day. */
  away: ((userId: string, date: string) => boolean) | null = null;

  constructor(deps: BotJobsDeps) {
    this.d = deps;
    this.db = deps.db;
    this.db.exec(SCHEMA);
    // schedules read "every working day" against the calendar: read them again after it changes
    deps.days.changed.push(() => this.rules.clear());
  }

  // ------------------------------------------------------------ reading
  private rule(when: string): ScheduleRule | null {
    if (!this.rules.has(when)) {
      const p = parseSchedule(when, this.d.now(), this.d.calendar());
      this.rules.set(when, p.ok ? p.rule : null);
      if (this.rules.size > 500) this.rules.clear();
    }
    return this.rules.get(when) ?? null;
  }

  private state(flow: string, job: string, now: number): JobState & { alerted: string | null } {
    let r = this.db.prepare('SELECT * FROM bot_job_state WHERE flow = ? AND job = ?').get(flow, job) as StateRow | undefined;
    if (!r) {
      // a new job starts from now: nothing it would have done before it existed
      this.db.prepare('INSERT INTO bot_job_state (flow, job, checked_at) VALUES (?, ?, ?)').run(flow, job, now);
      r = { flow, job, checked_at: now, paused: 0, skip_at: null, moved: '[]', alerted: null };
    }
    return { checkedAt: r.checked_at, paused: !!r.paused, skipAt: r.skip_at, moved: parse(r.moved, []), alerted: r.alerted };
  }

  private saveState(flow: string, job: string, st: JobState & { alerted?: string | null }): void {
    this.db.prepare(`INSERT INTO bot_job_state (flow, job, checked_at, paused, skip_at, moved, alerted) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(flow, job) DO UPDATE SET checked_at = excluded.checked_at, paused = excluded.paused, skip_at = excluded.skip_at, moved = excluded.moved, alerted = COALESCE(excluded.alerted, bot_job_state.alerted)`)
      .run(flow, job, st.checkedAt, st.paused ? 1 : 0, st.skipAt, JSON.stringify(st.moved.slice(-20)), st.alerted ?? null);
  }

  private bots(): NetBot[] { return this.d.host.all().filter((b) => b.def.jobs?.length); }

  private ownerOf(b: NetBot): PublicUser | null {
    const id = b.ownerId ?? (this.db.prepare('SELECT updated_by FROM bot_flows WHERE name = ?').get(b.def.name) as { updated_by: string | null } | undefined)?.updated_by ?? null;
    const u = id ? this.d.store.userById(id) : null;
    return u && u.role !== 'bot' && this.d.store.activeUsers().some((a) => a.id === u.id) ? u : null;
  }

  private record(flow: string, job: string, at: number, outcome: BotJobRun['outcome'], note: string, lines: string[], by: string | null): BotJobRun {
    const r: RunRow = { id: ulid(), flow, job, at, ran_at: this.d.now(), outcome, note: note.slice(0, 500), lines: JSON.stringify(lines.slice(0, 60).map((l) => l.slice(0, 300))), by };
    this.db.prepare('INSERT INTO bot_job_runs (id, flow, job, at, ran_at, outcome, note, lines, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(r.id, r.flow, r.job, r.at, r.ran_at, r.outcome, r.note, r.lines, r.by);
    // half a year of history is plenty
    if (Math.random() < 0.02) this.db.prepare('DELETE FROM bot_job_runs WHERE ran_at < ?').run(this.d.now() - 180 * DAY);
    this.d.store.audit(by, `botjob.${outcome.toLowerCase()}`, flow, { job, at, note: r.note.slice(0, 200) });
    this.changed(flow, job);
    return toRun(r);
  }

  private changed(flow: string, job: string): void {
    const to = new Set<string>(this.d.store.activeUsers().filter((u) => u.role === 'owner' || u.role === 'admin').map((u) => u.id));
    const o = this.d.host.live(flow)?.ownerId;
    if (o) to.add(o);
    try { this.d.deliver([...to], 'botjob.changed', { flow, job }); } catch { /* nobody listening */ }
  }

  // ------------------------------------------------------------ the timer
  /** Called on the hub timer (every few seconds) and by the tests with their clock. */
  async tick(now = this.d.now()): Promise<void> {
    const cal = this.d.calendar();
    let runs = 0;
    const perOwner = new Map<string, number>();
    for (const b of this.bots()) {
      for (const job of b.def.jobs ?? []) {
        const key = `${b.def.name}/${job.id}`;
        if (this.running.has(key)) continue;
        const rule = this.rule(job.when);
        if (!rule) continue;
        const st = this.state(b.def.name, job.id, now);
        // a paused bot's jobs wait with it
        const paused = st.paused || b.status !== 'live';
        const plan = planDue(rule, cal, job, { ...st, paused }, now);
        let checked = now;
        let stopAt: number | null = null;
        let skipped = 0;
        for (const p of plan) {
          if (p.act === 'skip' && p.why === 'paused') continue;
          if (p.act === 'skip') { this.record(b.def.name, job.id, p.at, 'SKIPPED', 'Skipped once, as asked.', [], null); st.skipAt = null; continue; }
          if (p.act === 'missed') {
            if (++skipped <= 5) this.record(b.def.name, job.id, p.at, 'SKIPPED', `Missed at ${hm(officeParts(p.at, cal.tzOffset).minutes)}: the hub was off.`, [], null);
            continue;
          }
          if (p.act === 'wait') { stopAt = p.at - 1; break; }
          const owner = b.ownerId ?? '';
          if (runs >= JOB_TICK_MAX || (perOwner.get(owner) ?? 0) >= JOB_OWNER_MAX) { stopAt = p.at - 1; break; }
          if (this.db.prepare("SELECT 1 FROM bot_job_runs WHERE flow = ? AND job = ? AND at = ? AND outcome IN ('RAN', 'FAILED')").get(b.def.name, job.id, p.at)) continue;
          runs++;
          perOwner.set(owner, (perOwner.get(owner) ?? 0) + 1);
          await this.run(b, job, p.at, p.act === 'catchup' ? 'catchup' : 'run', null);
        }
        if (skipped > 5) this.record(b.def.name, job.id, now, 'SKIPPED', `And ${skipped - 5} more runs missed while the hub was off.`, [], null);
        if (stopAt !== null) checked = Math.max(st.checkedAt, stopAt);
        // (the failure alert's day is kept as it was saved during the run)
        this.saveState(b.def.name, job.id, { checkedAt: checked, paused: st.paused, skipAt: st.skipAt, moved: st.moved.filter((m) => m.to > checked) });
      }
    }
  }

  // ------------------------------------------------------------ one run
  private people(owner: PublicUser, p: BotJobPeople, date: string, leave: boolean): { people: PublicUser[]; away: PublicUser[] } {
    const active = this.d.store.activeUsers().filter((u) => u.role !== 'bot' && u.role !== 'guest');
    let list: PublicUser[] = [];
    if (p.from === 'space') {
      const id = this.d.messaging.spaceByName(p.space);
      if (!id) throw new BotJobsError(`There is no Space called ${p.space}.`);
      const members = new Set(this.d.messaging.members(id));
      list = active.filter((u) => members.has(u.id));
    } else if (p.from === 'department') {
      const dep = this.db.prepare('SELECT id FROM departments WHERE lower(name) = lower(?)').get(p.department) as { id: string } | undefined;
      if (!dep) throw new BotJobsError(`There is no department called ${p.department}.`);
      list = active.filter((u) => u.profile.departmentId === dep.id);
    } else if (p.from === 'team') list = active.filter((u) => u.profile.managerId === owner.id);
    else list = active.filter((u) => p.people.includes(u.id));
    list = list.slice(0, JOB_PEOPLE_MAX);
    if (!leave) return { people: list, away: [] };
    const away = list.filter((u) => this.away?.(u.id, date) || (u.ooo && u.ooo.until > this.d.now()));
    return { people: list.filter((u) => !away.includes(u)), away };
  }

  private tell(b: NetBot, owner: PublicUser, to: string, text: string, dry: boolean): string {
    if (to === 'owner') { if (!dry) this.d.host.say(b.bot, this.d.host.dm(b.bot, owner.id), text); return `Told ${owner.displayName}.`; }
    if (to === 'lead') {
      const lead = this.d.leadOf(owner.id);
      if (!lead) throw new BotJobsError(`${owner.displayName} has no lead in the Directory.`);
      if (!dry) this.d.host.say(b.bot, this.d.host.dm(b.bot, lead.id), text);
      return `Told ${lead.displayName}.`;
    }
    const name = to.slice(6);
    const id = this.d.messaging.spaceByName(name);
    if (!id) throw new BotJobsError(`There is no Space called ${name}.`);
    if (!this.d.messaging.members(id).includes(owner.id)) throw new BotJobsError(`${owner.displayName} is not in ${name} any more.`);
    if (!dry) { this.d.messaging.ensureMember(id, b.bot.id); this.d.host.say(b.bot, id, text); }
    return `Posted to ${name}.`;
  }

  /** Run a job (on its schedule, caught up, now, or dry). Never throws: a failure is a FAILED run. */
  async run(b: NetBot, job: BotJob, at: number, mode: 'run' | 'catchup' | 'now' | 'dry', by: string | null): Promise<BotJobRun> {
    const key = `${b.def.name}/${job.id}`;
    this.running.add(key);
    const dry = mode === 'dry';
    const cal = this.d.calendar();
    const date = officeParts(at, cal.tzOffset).date;
    const lines: string[] = [];
    try {
      const owner = this.ownerOf(b);
      if (!owner) throw new BotJobsError('Its maker is not in the office any more.');
      const a = job.do;
      let note = '';
      if (a.do === 'start' || a.do === 'remind') {
        const { people, away } = this.people(owner, a.people, date, job.leave !== false);
        let done = 0; let busy = 0; let cannot = 0;
        for (const p of people) {
          if (dry) { lines.push(a.do === 'start' ? `Would start ${b.def.title} for ${p.displayName}` : `Would remind ${p.displayName}: ${a.text}`); done++; continue; }
          if (a.do === 'start') {
            const r = await this.d.startFor(p, b.def.name);
            if (r === 'started') { done++; lines.push(`Started for ${p.displayName}`); } else if (r === 'busy') { busy++; lines.push(`${p.displayName} is already answering it`); } else { cannot++; lines.push(`${p.displayName} cannot use it`); }
          } else {
            try {
              this.d.desk.handle('remind.create', owner, { forUserId: p.id, text: renderTemplate(a.text, { user: { value: p.id, label: p.displayName } }).slice(0, 500), dueAt: this.d.now() + 60_000 });
              done++; lines.push(`Reminded ${p.displayName}`);
            } catch (err) { cannot++; lines.push(`${p.displayName}: ${(err as Error).message}`); }
          }
        }
        for (const p of away) lines.push(`${p.displayName} is on leave: left out`);
        if (!people.length && !away.length) throw new BotJobsError('There is no one to do it for.');
        note = a.do === 'start'
          ? (done === 1 ? 'Started for 1 person.' : `Started for ${done} people.`)
          : (done === 1 ? 'Reminded 1 person.' : `Reminded ${done} people.`);
        if (dry) note = a.do === 'start' ? (done === 1 ? 'Would start it for 1 person.' : `Would start it for ${done} people.`) : (done === 1 ? 'Would remind 1 person.' : `Would remind ${done} people.`);
        if (away.length) note += away.length === 1 ? ' 1 on leave was left out.' : ` ${away.length} on leave were left out.`;
        if (busy) note += busy === 1 ? ' 1 was already answering it.' : ` ${busy} were already answering it.`;
        if (cannot && !done) throw new BotJobsError(note);
      } else if (a.do === 'register') {
        const r = this.d.items.registerNow(b.def, b.bot, b.ownerId, dry);
        note = dry ? (r.posted ? `Would post: ${r.note}` : r.note) : r.note;
        lines.push(note);
      } else {
        const res = await this.d.net.ask({ from: b.def.name, person: owner, trail: [], group: `job:${b.def.name}:${job.id}`, dry, ownerOverride: b.ownerId ?? owner.id, key: dry || mode === 'now' ? undefined : `job:${b.def.name}:${job.id}:${at}` }, a.ask, {});
        if (!res.ok) throw new BotJobsError(res.reason ?? 'The other bot did not answer.');
        const vars: Record<string, BotFlowAnswer> = { result: res.answer ?? { value: '', label: res.words }, 'result.words': { value: res.words, label: res.words } };
        for (const [k, v] of Object.entries(res.values)) vars[`result.${k}`] = v;
        lines.push(`Asked: ${res.words}`);
        const holds = a.do === 'ask' || testCondition(a.if, vars[a.if.var ?? 'result']);
        if (!holds) note = `Checked: ${res.words}. Nothing to tell.`;
        else {
          const text = renderTemplate(a.text, vars).slice(0, 2000);
          const told = this.tell(b, owner, a.tell, text, dry);
          lines.push(`${dry ? 'Would say' : 'Said'}: ${text}`);
          note = dry ? `${res.words}. Would tell: ${told.replace(/^Told |^Posted to /, '')}` : `${res.words}. ${told}`;
        }
      }
      if (mode === 'catchup') note = `Caught up (due ${hm(officeParts(at, cal.tzOffset).minutes)}, the hub was off). ${note}`;
      return this.record(b.def.name, job.id, at, dry ? 'DRY' : 'RAN', note.trim(), lines, by);
    } catch (err) {
      const why = (err as Error).message;
      if (dry) return this.record(b.def.name, job.id, at, 'DRY', `It would fail: ${why}`, lines, by);
      const run = this.record(b.def.name, job.id, at, 'FAILED', why, lines, by);
      this.alert(b, job, at, why);
      return run;
    } finally { this.running.delete(key); }
  }

  /** A failed run: its maker hears, once a day per job. */
  private alert(b: NetBot, job: BotJob, at: number, why: string): void {
    const owner = this.ownerOf(b);
    if (!owner) return;
    const cal = this.d.calendar();
    const today = officeParts(this.d.now(), cal.tzOffset).date;
    const st = this.state(b.def.name, job.id, this.d.now());
    if (st.alerted === today) return;
    this.saveState(b.def.name, job.id, { ...st, alerted: today });
    try { this.d.host.say(b.bot, this.d.host.dm(b.bot, owner.id), `${job.title} could not run at ${hm(officeParts(at, cal.tzOffset).minutes)}: ${why} Its job sheet has the details.`); } catch { /* nobody to tell */ }
  }

  // ------------------------------------------------------------ the job sheet
  private canEdit(me: PublicUser, b: NetBot): boolean { return me.role === 'owner' || me.role === 'admin' || (!!b.ownerId && b.ownerId === me.id); }

  private lane(b: NetBot, job: BotJob, from: number, to: number, me: PublicUser): BotJobLane {
    const now = this.d.now();
    const cal = this.d.calendar();
    const rule = this.rule(job.when);
    const st = this.state(b.def.name, job.id, now);
    let next: number[] = [];
    if (rule) {
      const moved = new Map(st.moved.map((m) => [m.from, m.to]));
      next = runsBetween(rule, cal, Math.max(now, from - 1), to, 300).filter((t) => !moved.has(t));
      for (const m of st.moved) if (m.to > now && m.to >= from && m.to <= to) next.push(m.to);
      next.sort((x, y) => x - y);
    }
    const past = (this.db.prepare('SELECT * FROM bot_job_runs WHERE flow = ? AND job = ? AND at >= ? AND at <= ? ORDER BY at DESC, ran_at DESC LIMIT 120').all(b.def.name, job.id, from, Math.min(to, now + DAY)) as unknown as RunRow[]).map(toRun);
    const moved = new Map(st.moved.map((m) => [m.from, m.to]));
    const coming = rule ? [...nextRuns(rule, cal, now, 3).map((t) => moved.get(t) ?? t), ...st.moved.filter((m) => m.to > now).map((m) => m.to)].filter((t) => t > now && t !== st.skipAt).sort((x, y) => x - y) : [];
    const problem = !rule ? 'Its schedule does not read any more.' : b.status !== 'live' ? `Its bot is ${b.status}.` : !this.ownerOf(b) ? 'Its maker is not in the office any more.' : null;
    const p = b.def.persona;
    return {
      flow: b.def.name, job: job.id, title: job.title, botTitle: b.def.title, mark: p?.mark ?? null, colour: p?.colour ?? null, ownerId: b.ownerId, when: job.when,
      words: rule ? describeRule(rule, cal) : job.when, paused: st.paused, skipAt: st.skipAt, moved: st.moved, next, following: coming[0] ?? null, past, problem, canEdit: this.canEdit(me, b),
    };
  }

  sheet(me: PublicUser, scope: BotJobSheet['scope'], flow: string | null, from: number, to: number): BotJobSheet {
    const admin = me.role === 'owner' || me.role === 'admin';
    let bots = this.bots();
    if (scope === 'bot') {
      const b = flow ? this.d.host.live(flow) : null;
      if (!b || (!admin && b.ownerId !== me.id)) throw new BotJobsError('That bot was not found.');
      bots = b.def.jobs?.length ? [b] : [];
    } else if (scope === 'office') { if (!admin) throw new BotJobsError('Only administrators see the office’s job sheet.'); }
    else bots = bots.filter((b) => b.ownerId === me.id);
    const cal = this.d.calendar();
    const lanes = bots.flatMap((b) => (b.def.jobs ?? []).map((j) => this.lane(b, j, from, to, me)));
    const fromDate = officeParts(from, cal.tzOffset).date; const toDate = officeParts(to, cal.tzOffset).date;
    return { scope, from, to, lanes, holidays: cal.holidays.filter((h) => h.date >= fromDate && h.date <= toDate), extraWorkdays: (cal.extraWorkdays ?? []).filter((h) => h.date >= fromDate && h.date <= toDate), now: this.d.now(), tzOffset: cal.tzOffset };
  }

  private own(me: PublicUser, flow: string, job: string): { b: NetBot; j: BotJob } {
    const b = this.d.host.live(flow);
    const j = b?.def.jobs?.find((x) => x.id === job);
    if (!b || !j) throw new BotJobsError('That job was not found.');
    if (!this.canEdit(me, b)) throw new BotJobsError('Only the person who made this bot can change its jobs.');
    return { b, j };
  }

  /** Check a bot's jobs as its maker saves it: the people and places they name are theirs to use. */
  checkSave(me: PublicUser, def: BotFlowDefinition): void {
    const admin = me.role === 'owner' || me.role === 'admin';
    for (const j of def.jobs ?? []) {
      const a = j.do;
      const people = a.do === 'start' || a.do === 'remind' ? a.people : null;
      if (people?.from === 'space') {
        const id = this.d.messaging.spaceByName(people.space);
        if (!id) throw new BotJobsError(`${j.title}: there is no Space called ${people.space}.`);
        if (!admin && !this.d.messaging.members(id).includes(me.id)) throw new BotJobsError(`${j.title}: you can schedule it for ${people.space} only if you are in that Space.`);
      }
      if (people?.from === 'department' && !admin) {
        const dep = this.db.prepare('SELECT head_id FROM departments WHERE lower(name) = lower(?)').get(people.department) as { head_id: string | null } | undefined;
        if (!dep) throw new BotJobsError(`${j.title}: there is no department called ${people.department}.`);
        if (dep.head_id !== me.id) throw new BotJobsError(`${j.title}: only the head of ${people.department} or an administrator can schedule it for the whole department.`);
      }
      if ((a.do === 'check' || a.do === 'ask') && a.tell.startsWith('space:')) {
        const id = this.d.messaging.spaceByName(a.tell.slice(6));
        if (!id) throw new BotJobsError(`${j.title}: there is no Space called ${a.tell.slice(6)}.`);
        if (!admin && !this.d.messaging.members(id).includes(me.id)) throw new BotJobsError(`${j.title}: you can post to ${a.tell.slice(6)} only if you are in that Space.`);
      }
    }
  }

  async handle(op: string, me: PublicUser, d: Record<string, unknown>): Promise<unknown> {
    const now = this.d.now();
    const cal = this.d.calendar();
    const flow = String(d.flow ?? '');
    const jobId = String(d.job ?? '');
    switch (op) {
      case 'botjob.calendar':
        return { holidays: cal.holidays, workdays: cal.workdays, tzOffset: cal.tzOffset, hours: cal.hours, extraWorkdays: cal.extraWorkdays ?? [], days: this.d.days.list(), circulars: this.d.days.circulars() };
      case 'admin.botjob.holidays': {
        try { return { holidays: this.d.days.setByAdmin(me, d.holidays) }; } catch (err) { if (err instanceof HolidaysError) throw new BotJobsError(err.message); throw err; }
      }
      case 'botjob.sheet': {
        const scope = d.scope === 'office' || d.scope === 'bot' ? d.scope : 'mine';
        const from = typeof d.from === 'number' && Number.isFinite(d.from) ? d.from : now - DAY;
        const to = typeof d.to === 'number' && Number.isFinite(d.to) ? Math.min(d.to, from + 62 * DAY) : now + 7 * DAY;
        return this.sheet(me, scope, scope === 'bot' ? flow : null, from, to);
      }
      case 'botjob.history': {
        const { b, j } = this.own(me, flow, jobId);
        return (this.db.prepare('SELECT * FROM bot_job_runs WHERE flow = ? AND job = ? ORDER BY ran_at DESC LIMIT 100').all(b.def.name, j.id) as unknown as RunRow[]).map(toRun);
      }
      case 'botjob.run': {
        const { b, j } = this.own(me, flow, jobId);
        if (this.running.has(`${b.def.name}/${j.id}`)) throw new BotJobsError('It is running now.');
        if (d.dry !== true && inQuiet(officeParts(now, cal.tzOffset).minutes)) throw new BotJobsError(`It is the quiet hours (${hm(21 * 60)} to ${hm(8 * 60)}): bots send nothing now. Try a dry run.`);
        this.d.store.audit(me.id, d.dry === true ? 'botjob.dryrun' : 'botjob.runnow', b.def.name, { job: j.id });
        return await this.run(b, j, now, d.dry === true ? 'dry' : 'now', me.id);
      }
      case 'botjob.set': {
        const { b, j } = this.own(me, flow, jobId);
        const st = this.state(b.def.name, j.id, now);
        const rule = this.rule(j.when);
        if (typeof d.paused === 'boolean') { st.paused = d.paused; this.d.store.audit(me.id, d.paused ? 'botjob.paused' : 'botjob.resumed', b.def.name, { job: j.id }); }
        if (d.skipNext === true) {
          const next = rule ? nextRuns(rule, cal, now, 1)[0] ?? null : null;
          if (!next) throw new BotJobsError('It has no run coming to skip.');
          st.skipAt = next;
          this.d.store.audit(me.id, 'botjob.skipnext', b.def.name, { job: j.id, at: next });
        }
        if (d.unskip === true) st.skipAt = null;
        if (d.move !== undefined) {
          const m = d.move as { from?: unknown; to?: unknown } | null;
          if (m === null) st.moved = [];
          else {
            const fromT = Number(m.from); const toT = Number(m.to);
            const upcoming = rule ? nextRuns(rule, cal, now, 60) : [];
            if (!upcoming.includes(fromT)) throw new BotJobsError('That run is not one coming up.');
            if (!(toT > now + 60_000)) throw new BotJobsError('Move it to a time still to come.');
            if (toT > fromT + 14 * DAY || toT < fromT - 14 * DAY) throw new BotJobsError('A run moves by two weeks at most.');
            const p = officeParts(toT, cal.tzOffset);
            if (inQuiet(p.minutes)) throw new BotJobsError(`${hm(p.minutes)} is in the quiet hours. Choose a time between ${hm(8 * 60)} and ${hm(21 * 60)}.`);
            if (!isWorkingDay(cal, p.date)) throw new BotJobsError('That day is not a working day.');
            if (st.moved.some((x) => x.from === fromT)) throw new BotJobsError('That run was moved once already.');
            st.moved = [...st.moved, { from: fromT, to: toT }];
            this.d.store.audit(me.id, 'botjob.moved', b.def.name, { job: j.id, from: fromT, to: toT });
          }
        }
        this.saveState(b.def.name, j.id, st);
        this.changed(b.def.name, j.id);
        return this.lane(b, j, now - DAY, now + 7 * DAY, me);
      }
    }
    return undefined;
  }
}
