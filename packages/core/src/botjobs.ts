// Scheduled bot jobs: a schedule written in plain words ("every weekday at 9:15", "last working day
// of the month at 16:00", "every 2 hours during office hours"), read the same way on every PC and
// on the hub, the next runs in the office's time (IST), and the rules for runs the hub missed while
// it was off. Pure functions with the clock passed in: the hub's scheduler and the bot maker's
// preview use the same ones, and the tests move the clock. See docs/BOT-NETWORK.md §5.
import type { BotAsk, BotFlowCondition, BotJob, BotJobAction, BotJobPeople } from './bots.ts';

export class BotJobError extends Error {}

/** India Standard Time: UTC+05:30, no daylight saving. */
export const OFFICE_TZ_OFFSET = 330;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** Before this and after QUIET_TO nothing is sent: catch-up runs wait for the morning. */
export const QUIET_FROM = 21 * 60;
export const QUIET_TO = 8 * 60;
/** A run this late is a missed run (the hub was off), not a run a little behind. */
export const MISSED_AFTER = 5 * MIN;
export const MAX_JOBS = 8;
const MAX_TIMES = 6;

/** The office's working week, holidays and hours (Nib's working days; the holidays an administrator keeps). */
export interface OfficeCalendar {
  /** 0 = Sunday … 6 = Saturday. */
  workdays: number[];
  /** Days nobody works: holidays, the Saturdays off and compensatory days off (`kind` from the circular). */
  holidays: Array<{ date: string; name: string; kind?: string }>;
  /**
   * Compensatory working days on a day the office does not normally work (a Saturday worked to
   * make up for a day off when the week is Monday to Friday): working days after all.
   */
  extraWorkdays?: Array<{ date: string; name: string }>;
  /** Minutes east of UTC (330 for IST). */
  tzOffset: number;
  /** "During office hours". */
  hours: { from: string; to: string };
}

export const DEFAULT_CALENDAR: OfficeCalendar = { workdays: [1, 2, 3, 4, 5, 6], holidays: [], tzOffset: OFFICE_TZ_OFFSET, hours: { from: '09:30', to: '18:30' } };

export type ScheduleRule =
  /** On some days of the week (`workdays`: the office's working days), at one or more times. */
  | { kind: 'weekly'; days: number[]; workdays: boolean; times: number[] }
  /** On dates of the month (31 means the last day); a date that is not a working day moves to the next one. */
  | { kind: 'monthly'; dates: number[]; time: number }
  /** The first or last (working) day of each month. */
  | { kind: 'edge'; edge: 'first' | 'last'; working: boolean; time: number }
  /** Every so many minutes in a window of the day (office hours by default), on working days or named days. */
  | { kind: 'interval'; every: number; from: number; to: number; office: boolean; days: number[] | null }
  /** Once. */
  | { kind: 'once'; date: string; time: number };

/** A piece of the words that was understood, marked on them like a dimension (the app underlines it). */
export interface ScheduleMark { start: number; end: number; cap: 'EVERY' | 'DAY' | 'TIME' | 'DATE' | 'WINDOW' }

export type ParsedSchedule =
  | { ok: true; rule: ScheduleRule; words: string; marks: ScheduleMark[]; notes: string[] }
  | { ok: false; error: string; marks: ScheduleMark[] };

// ---------------------------------------------------------------- office time
const pad = (n: number) => String(n).padStart(2, '0');
export const hm = (m: number): string => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const minutesOfHm = (s: string): number => { const m = /^(\d{1,2}):(\d{2})$/.exec(s); return m ? Number(m[1]) * 60 + Number(m[2]) : 0; };

/** A moment as the office's clock reads it. */
export function officeParts(ts: number, tz = OFFICE_TZ_OFFSET): { date: string; dow: number; minutes: number; y: number; m: number; d: number } {
  const t = new Date(ts + tz * MIN);
  const y = t.getUTCFullYear(); const m = t.getUTCMonth() + 1; const d = t.getUTCDate();
  return { date: `${y}-${pad(m)}-${pad(d)}`, dow: t.getUTCDay(), minutes: t.getUTCHours() * 60 + t.getUTCMinutes(), y, m, d };
}

/** The moment a date and a time of day on the office's clock happen. */
export function officeTime(date: string, minutes: number, tz = OFFICE_TZ_OFFSET): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d) + minutes * MIN - tz * MIN;
}

export const addDays = (date: string, n: number): string => {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};
const dowOf = (date: string): number => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

export const holidayOn = (cal: OfficeCalendar, date: string): { date: string; name: string } | undefined => cal.holidays.find((h) => h.date === date);
/** A working day: one of the office's working days (or a compensatory working day) and not a day off. */
export const isWorkingDay = (cal: OfficeCalendar, date: string): boolean => (cal.workdays.includes(dowOf(date)) || !!cal.extraWorkdays?.some((d) => d.date === date)) && !holidayOn(cal, date);
export const inQuiet = (minutes: number): boolean => minutes >= QUIET_FROM || minutes < QUIET_TO;

// ---------------------------------------------------------------- reading the words
const DAY_NAMES: Array<[RegExp, number]> = [
  [/^sun/, 0], [/^mon/, 1], [/^tue/, 2], [/^wed/, 3], [/^thu/, 4], [/^fri/, 5], [/^sat/, 6],
];
const DAY_WORD = /\b(sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)(?:days?|s)?\b|\b(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/g;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const NUM_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, eight: 8, ten: 10, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, 'forty-five': 45 };
const TIME_RE = /\b(noon|midday|midnight)\b|\b(\d{1,2})(?:[:.](\d{2}))\s*(am|pm|a\.m\.|p\.m\.)?|\b(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.)|\bat\s+(\d{1,2})\b(?![:.\d]|\s*(?:st|nd|rd|th)\b)|\b(\d{1,2})\s*(?:o'?clock|hrs|h)\b/g;
export const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Times written in the words, in minutes after midnight (with where each one is). */
function timesIn(t: string): Array<{ m: number; start: number; end: number; guessed: boolean }> {
  const out: Array<{ m: number; start: number; end: number; guessed: boolean }> = [];
  for (const x of t.matchAll(TIME_RE)) {
    let h: number; let mi = 0; let ap: string | undefined; let guessed = false;
    if (x[1]) { h = x[1] === 'midnight' ? 0 : 12; }
    else if (x[2]) { h = Number(x[2]); mi = Number(x[3]); ap = x[4]; }
    else if (x[5]) { h = Number(x[5]); ap = x[6]; }
    else { h = Number(x[7] ?? x[8]); guessed = !ap; }
    if (ap) { const pm = ap.startsWith('p'); if (h < 1 || h > 12) continue; h = (h % 12) + (pm ? 12 : 0); }
    else if (guessed && h >= 1 && h <= 7) h += 12; // "at 5" in an office is five in the evening
    else guessed = false;
    if (h > 23 || mi > 59) continue;
    const start = (x.index ?? 0) + (x[0].startsWith('at ') ? 3 : 0);
    out.push({ m: h * 60 + mi, start, end: (x.index ?? 0) + x[0].length, guessed });
  }
  return out;
}

const spanOf = (t: string, re: RegExp): { start: number; end: number; m: RegExpExecArray } | null => {
  const m = re.exec(t);
  return m ? { start: m.index, end: m.index + m[0].length, m } : null;
};
const blank = (t: string, start: number, end: number) => t.slice(0, start) + ' '.repeat(end - start) + t.slice(end);
const listWords = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const ordinal = (n: number): string => (n === 31 ? 'last day' : `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`);

/**
 * Read a schedule written in plain words. `now` and the calendar are only for "today" and
 * "tomorrow". The result says what was understood in words (shown to the person before they
 * save), with the words that mattered marked.
 */
export function parseSchedule(text: string, now = Date.now(), cal: OfficeCalendar = DEFAULT_CALENDAR): ParsedSchedule {
  const raw = String(text ?? '').slice(0, 200);
  let t = raw.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ');
  const marks: ScheduleMark[] = [];
  const mark = (start: number, end: number, cap: ScheduleMark['cap']) => { marks.push({ start, end, cap }); t = blank(t, start, end); };
  const notes: string[] = [];
  const fail = (error: string): ParsedSchedule => ({ ok: false, error, marks: marks.sort((a, b) => a.start - b.start) });
  if (!t.trim()) return fail('Write when it runs, like "every Monday at 10:00".');
  const take = (re: RegExp, cap: ScheduleMark['cap']) => { const s = spanOf(t, re); if (s) mark(s.start, s.end, cap); return s?.m ?? null; };

  // the window of the day for "every 2 hours": office hours, or between two times
  let window: { from: number; to: number; office: boolean } | null = null;
  const office = take(/\b(?:during|in|within)\s+(?:the\s+)?office\s+hours\b|\bin\s+working\s+hours\b/, 'WINDOW');
  if (office) window = { from: minutesOfHm(cal.hours.from), to: minutesOfHm(cal.hours.to), office: true };
  const between = spanOf(t, /\b(?:between|from)\s+(.{1,12}?)\s+(?:and|to|till|until|-)\s+(.{1,12}?)(?=$|\s|,)/);
  if (between) {
    const a = timesIn(between.m[1]); const b = timesIn(` ${between.m[2]}`);
    if (a.length && b.length) { window = { from: a[0].m, to: b[0].m, office: false }; mark(between.start, between.end, 'WINDOW'); }
  }

  // every N hours / minutes
  const iv = take(/\bevery\s+(?:(\d{1,3}|a|an|one|two|three|four|five|six|eight|ten|twelve|fifteen|twenty|thirty|forty-five|half\s+an?)\s*)?(hours?|hrs?|minutes?|mins?)\b|\b(hourly)\b/, 'EVERY');

  // whole-month patterns
  const edge = take(/\b(?:on\s+)?(?:the\s+)?(first|1st|last)\s+(working\s+|work\s+|business\s+)?day\s+of\s+(?:the|each|every|a)?\s*month\b/, 'DATE');
  // once: today, tomorrow, a date
  let once: string | null = null;
  const rel = take(/\b(today|tomorrow)\b/, 'DATE');
  if (rel) once = rel[1] === 'today' ? officeParts(now, cal.tzOffset).date : addDays(officeParts(now, cal.tzOffset).date, 1);
  const iso = once ? null : take(/\b(\d{4})-(\d{2})-(\d{2})\b/, 'DATE');
  if (iso) once = `${iso[1]}-${iso[2]}-${iso[3]}`;
  const named = once ? null : take(/\b(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:\s+(\d{4}))?\b/, 'DATE');
  if (named) {
    const p = officeParts(now, cal.tzOffset);
    const mo = MONTHS.indexOf(named[2].slice(0, 3)) + 1;
    let y = named[3] ? Number(named[3]) : p.y;
    const d = Number(named[1]);
    if (!named[3] && `${y}-${pad(mo)}-${pad(d)}` < p.date) y += 1;
    if (d < 1 || d > daysInMonth(y, mo)) return fail(`There is no ${d} ${named[2]} that year.`);
    once = `${y}-${pad(mo)}-${pad(d)}`;
  }
  // dates of each month: "1st and 15th", "on the 5th"
  const dates: number[] = [];
  if (!once && !edge) {
    const ordRe = /\b(\d{1,2})(?:st|nd|rd|th)\b/g;
    for (const x of [...t.matchAll(ordRe)]) {
      const n = Number(x[1]);
      if (n < 1 || n > 31) return fail('A date of the month is between 1st and 31st.');
      dates.push(n);
      mark(x.index!, x.index! + x[0].length, 'DATE');
    }
    if (dates.length) take(/\b(?:of\s+)?(?:each|every|the)\s+month\b|\bmonthly\b/, 'EVERY');
    const lastDay = take(/\blast\s+day\s+of\s+(?:the|each|every)?\s*month\b/, 'DATE');
    if (lastDay) dates.push(31);
  }

  // days of the week
  let days: number[] = [];
  let workdays = false;
  const wd = take(/\b(?:every\s+)?(?:week\s*days?|working\s+days?|work\s*days?|business\s+days?)\b/, 'DAY');
  if (wd) workdays = true;
  const daily = !wd && take(/\b(?:every\s*day|each\s+day|daily)\b/, 'DAY');
  if (daily) workdays = true;
  const weekend = take(/\b(?:at\s+)?week\s*ends?\b/, 'DAY');
  if (weekend) days.push(6, 0);
  for (const x of [...t.matchAll(DAY_WORD)]) {
    const w = x[0];
    const hit = DAY_NAMES.find(([re]) => re.test(w));
    if (hit && !days.includes(hit[1])) days.push(hit[1]);
    mark(x.index!, x.index! + x[0].length, 'DAY');
  }
  take(/\b(?:every|each)\b/, 'EVERY');

  const times = timesIn(t);
  for (const x of times) mark(x.start, x.end, 'TIME');
  for (const x of times) if (x.guessed) notes.push(`${hm(x.m)} is taken as ${x.m >= 12 * 60 ? 'evening' : 'morning'}: write ${hm(x.m)} to be sure.`);
  const timeList = [...new Set(times.map((x) => x.m))].sort((a, b) => a - b);
  if (timeList.length > MAX_TIMES) return fail(`Up to ${MAX_TIMES} times a day.`);
  const left = t.replace(/\b(on|at|and|the|of|in|by|every|each|run|it|from|to|until|till|also|then|please|,|\.|-)\b/g, ' ').replace(/[,.;&+]/g, ' ').trim();
  const opening = minutesOfHm(cal.hours.from);
  const defaultTime = () => { notes.push(`No time given: it runs at ${hm(opening)}, when the office opens.`); return opening; };
  const done = (rule: ScheduleRule): ParsedSchedule => {
    if (left) notes.push(`Not understood: “${left.replace(/\s+/g, ' ')}”.`);
    const times = rule.kind === 'weekly' ? rule.times : rule.kind === 'interval' ? [rule.from, Math.max(rule.from, rule.to - 1)] : [rule.time];
    const quiet = times.find(inQuiet);
    if (quiet !== undefined) return fail(`${hm(quiet)} is in the quiet hours (${hm(QUIET_FROM)} to ${hm(QUIET_TO)}), when bots send nothing. Choose a time between ${hm(QUIET_TO)} and ${hm(QUIET_FROM)}.`);
    return { ok: true, rule, words: describeRule(rule, cal), marks: marks.sort((a, b) => a.start - b.start), notes };
  };

  if (iv) {
    let every = 60;
    if (iv[3]) every = 60;
    else {
      const w = iv[1] ?? 'one';
      const n = /^\d+$/.test(w) ? Number(w) : w.startsWith('half') ? 0.5 : NUM_WORDS[w] ?? 1;
      every = /^h/.test(iv[2]) ? Math.round(n * 60) : Math.round(n);
    }
    if (every < 15) return fail('Every 15 minutes is the most often a job can run.');
    if (every > 12 * 60) return fail('For less often than every 12 hours, name the days and a time.');
    const w = window ?? { from: opening, to: minutesOfHm(cal.hours.to), office: true };
    if (w.to <= w.from) return fail('The end of the window comes after its start.');
    if (!window) notes.push('No hours given: during office hours.');
    return done({ kind: 'interval', every, from: w.from, to: w.to, office: w.office, days: days.length ? days.sort() : null });
  }
  if (once) {
    if (timeList.length > 1) return fail('A job that runs once has one time.');
    return done({ kind: 'once', date: once, time: timeList[0] ?? defaultTime() });
  }
  if (edge) {
    if (timeList.length > 1) return fail('Give one time for a monthly job.');
    return done({ kind: 'edge', edge: edge[1] === 'last' ? 'last' : 'first', working: !!edge[2], time: timeList[0] ?? defaultTime() });
  }
  if (dates.length) {
    if (timeList.length > 1) return fail('Give one time for a monthly job.');
    return done({ kind: 'monthly', dates: [...new Set(dates)].sort((a, b) => a - b), time: timeList[0] ?? defaultTime() });
  }
  if (workdays || days.length) {
    if (!timeList.length) return fail('Say what time, like "at 9:15".');
    return done({ kind: 'weekly', days: workdays ? [] : [...new Set(days)].sort(), workdays: workdays && !days.length, times: timeList });
  }
  if (timeList.length) return fail('Say which days, like "every weekday" or "every Monday".');
  return fail('Write when it runs, like "every Monday at 10:00", "every weekday at 9:15" or "1st and 15th".');
}

/** What a rule means, in plain English (the app words it in the person's language itself). */
export function describeRule(rule: ScheduleRule, cal: OfficeCalendar = DEFAULT_CALENDAR): string {
  const at = (ts: number[]) => listWords(ts.map(hm));
  switch (rule.kind) {
    case 'weekly':
      if (rule.workdays) return `Every working day at ${at(rule.times)}`;
      return `Every ${listWords(rule.days.map((d) => DAY_LONG[d]))} at ${at(rule.times)}`;
    case 'monthly': return `On the ${listWords(rule.dates.map(ordinal))} of each month at ${hm(rule.time)} (the next working day when it is not one)`;
    case 'edge': return `On the ${rule.edge} ${rule.working ? 'working ' : ''}day of each month at ${hm(rule.time)}`;
    case 'interval': {
      const each = rule.every % 60 === 0 ? (rule.every === 60 ? 'Every hour' : `Every ${rule.every / 60} hours`) : `Every ${rule.every} minutes`;
      const win = rule.office ? `during office hours (${cal.hours.from} to ${cal.hours.to})` : `from ${hm(rule.from)} to ${hm(rule.to)}`;
      return `${each} ${win}, ${rule.days ? `on ${listWords(rule.days.map((d) => DAY_LONG[d]))}` : 'on working days'}`;
    }
    case 'once': return `Once, on ${rule.date} at ${hm(rule.time)}`;
  }
}

// ---------------------------------------------------------------- the runs
/** The times a rule gives on one office date (before holidays and working days are applied). */
function timesOn(rule: ScheduleRule, date: string, cal: OfficeCalendar): number[] {
  const dow = dowOf(date);
  const [y, m, d] = date.split('-').map(Number);
  switch (rule.kind) {
    case 'weekly':
      if (rule.workdays ? !isWorkingDay(cal, date) : !rule.days.includes(dow) || !!holidayOn(cal, date)) return [];
      return rule.times;
    case 'interval': {
      if (rule.days ? !rule.days.includes(dow) || !!holidayOn(cal, date) : !isWorkingDay(cal, date)) return [];
      const out: number[] = [];
      for (let t = rule.from; t < rule.to && out.length < 96; t += rule.every) out.push(t);
      return out;
    }
    case 'once': return rule.date === date ? [rule.time] : [];
    case 'edge': {
      const last = daysInMonth(y, m);
      if (!rule.working) return (rule.edge === 'first' ? d === 1 : d === last) ? [rule.time] : [];
      // the first (last) working day: this date is one, and none before (after) it in the month is
      if (!isWorkingDay(cal, date)) return [];
      if (rule.edge === 'first') { for (let i = 1; i < d; i++) if (isWorkingDay(cal, `${y}-${pad(m)}-${pad(i)}`)) return []; }
      else { for (let i = d + 1; i <= last; i++) if (isWorkingDay(cal, `${y}-${pad(m)}-${pad(i)}`)) return []; }
      return [rule.time];
    }
    case 'monthly': {
      // a date that falls on a day off moves to the next working day (into the next month if need be)
      const runDate = (yy: number, mm: number, want: number): string | null => {
        let dt = `${yy}-${pad(mm)}-${pad(Math.min(want, daysInMonth(yy, mm)))}`;
        for (let i = 0; i < 12 && !isWorkingDay(cal, dt); i++) dt = addDays(dt, 1);
        return isWorkingDay(cal, dt) ? dt : null;
      };
      const [py, pm] = addDays(`${y}-${pad(m)}-01`, -1).split('-').map(Number);
      for (const want of rule.dates) if (runDate(y, m, want) === date || runDate(py, pm, want) === date) return [rule.time];
      return [];
    }
  }
}

/** Runs strictly after `after`, up to `until` (or `n` of them), in order. */
export function runsBetween(rule: ScheduleRule, cal: OfficeCalendar, after: number, until: number, n = 500): number[] {
  const out: number[] = [];
  let date = officeParts(after, cal.tzOffset).date;
  const lastDate = officeParts(until, cal.tzOffset).date;
  for (let i = 0; i < 800 && date <= lastDate && out.length < n; i++, date = addDays(date, 1)) {
    for (const m of [...timesOn(rule, date, cal)].sort((a, b) => a - b)) {
      const ts = officeTime(date, m, cal.tzOffset);
      if (ts > after && ts <= until) { out.push(ts); if (out.length >= n) break; }
    }
  }
  return out;
}

/** The next `n` runs after a moment (a year ahead at most). */
export const nextRuns = (rule: ScheduleRule, cal: OfficeCalendar, after: number, n = 5): number[] => runsBetween(rule, cal, after, after + 400 * DAY, n);

/** Runs in a stretch that a holiday or a day off took away (for the job sheet: "Diwali: no run"). */
export function holidaySkips(rule: ScheduleRule, cal: OfficeCalendar, from: number, to: number): Array<{ date: string; name: string }> {
  const plain = { ...cal, holidays: [] };
  const out: Array<{ date: string; name: string }> = [];
  for (const ts of runsBetween(rule, plain, from, to, 60)) {
    const date = officeParts(ts, cal.tzOffset).date;
    const h = holidayOn(cal, date);
    if (h && !out.some((x) => x.date === date)) out.push(h);
  }
  return out;
}

// ---------------------------------------------------------------- what is due at a tick
export interface JobState {
  /** Runs up to here are dealt with. */
  checkedAt: number;
  paused: boolean;
  /** Skip the run at this time. */
  skipAt: number | null;
  /** Runs moved once: the run at `from` happens at `to` instead. */
  moved: Array<{ from: number; to: number }>;
}

export type DuePlan = Array<{ at: number; act: 'run' | 'skip' | 'missed' | 'catchup' | 'wait'; why: string }>;

/**
 * What to do with a job at a tick: runs due since it was last checked run; a run that was due
 * more than five minutes ago was missed (the hub was off) and is skipped, or, with "catch up
 * once", the latest one runs now (in the morning when it is quiet hours). The skipped next run
 * and runs moved once are taken into account. Pure: the scheduler applies the plan.
 */
export function planDue(rule: ScheduleRule, cal: OfficeCalendar, job: Pick<BotJob, 'missed'>, st: JobState, now: number): DuePlan {
  if (now <= st.checkedAt) return [];
  const moved = new Map(st.moved.map((x) => [x.from, x.to]));
  const due = runsBetween(rule, cal, st.checkedAt, now, 200).filter((t) => !moved.has(t));
  for (const x of st.moved) if (x.to > st.checkedAt && x.to <= now) due.push(x.to);
  due.sort((a, b) => a - b);
  const plan: DuePlan = [];
  if (st.paused) return due.map((at) => ({ at, act: 'skip', why: 'paused' }));
  const missed = due.filter((t) => now - t > MISSED_AFTER);
  const fresh = due.filter((t) => now - t <= MISSED_AFTER);
  const quiet = inQuiet(officeParts(now, cal.tzOffset).minutes);
  missed.forEach((at, i) => {
    if (at === st.skipAt) { plan.push({ at, act: 'skip', why: 'skipped' }); return; }
    const last = i === missed.length - 1 && !fresh.length;
    if (job.missed === 'once' && last) plan.push({ at, act: quiet ? 'wait' : 'catchup', why: 'the hub was off' });
    else plan.push({ at, act: 'missed', why: 'the hub was off' });
  });
  for (const at of fresh) plan.push(at === st.skipAt ? { at, act: 'skip', why: 'skipped' } : { at, act: 'run', why: '' });
  return plan;
}

// ---------------------------------------------------------------- checking jobs in a definition
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
const ID_RE = /^[A-Za-z][\w-]{0,39}$/;

function checkPeople(v: unknown, where: string): BotJobPeople {
  const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  if (r.from === 'space') { const space = str(r.space, 80); if (!space) throw new BotJobError(`${where}: name the Space.`); return { from: 'space', space }; }
  if (r.from === 'department') { const department = str(r.department, 80); if (!department) throw new BotJobError(`${where}: name the department.`); return { from: 'department', department }; }
  if (r.from === 'people') {
    const people = [...new Set((Array.isArray(r.people) ? r.people : []).filter((x): x is string => typeof x === 'string' && /^[0-9A-Z]{26}$/.test(x)))].slice(0, 40);
    if (!people.length) throw new BotJobError(`${where}: choose the people.`);
    return { from: 'people', people };
  }
  if (r.from === 'team') return { from: 'team' };
  throw new BotJobError(`${where}: "people" comes from a Space, a department, named people or your team.`);
}

export function checkAskShape(v: unknown, where: string): BotAsk {
  const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const skill = str(r.skill, 80);
  if (!/^[a-z][a-z0-9-]{1,39}\.[a-z][A-Za-z0-9-]{1,30}$/.test(skill)) throw new BotJobError(`${where}: choose which bot to ask and what ("skill").`);
  const out: BotAsk = { skill };
  if (r.with && typeof r.with === 'object' && !Array.isArray(r.with)) {
    const w = Object.entries(r.with as Record<string, unknown>).slice(0, 10).map(([k, x]) => [str(k, 30), str(String(x ?? ''), 300)] as const).filter(([k]) => ID_RE.test(k));
    if (w.length) out.with = Object.fromEntries(w);
  }
  if (r.onFail === 'skip' || r.onFail === 'stop' || r.onFail === 'ask') out.onFail = r.onFail;
  return out;
}

const TELL_RE = /^(owner|lead|space:.{1,80})$/;

function checkAction(v: unknown, where: string, tracked: boolean): BotJobAction {
  const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  switch (r.do) {
    case 'start': return { do: 'start', people: checkPeople(r.people, where) };
    case 'register':
      if (!tracked) throw new BotJobError(`${where}: only a bot that tracks requests has a register to post.`);
      return { do: 'register' };
    case 'remind': {
      const text = str(r.text, 400);
      if (!text) throw new BotJobError(`${where}: write the reminder.`);
      return { do: 'remind', people: checkPeople(r.people, where), text };
    }
    case 'check': case 'ask': {
      const tell = str(r.tell, 90) || 'owner';
      if (!TELL_RE.test(tell)) throw new BotJobError(`${where}: "tell" is owner, lead or space:<name>.`);
      const text = str(r.text, 1000);
      if (!text) throw new BotJobError(`${where}: write what it says.`);
      const ask = checkAskShape(r.ask, where);
      if (r.do === 'ask') return { do: 'ask', ask, tell, text };
      const c = (r.if && typeof r.if === 'object' ? r.if : {}) as Record<string, unknown>;
      const cond: BotFlowCondition = {};
      if (typeof c.var === 'string' && /^[A-Za-z][\w.-]{0,60}$/.test(c.var)) cond.var = c.var;
      for (const k of ['gt', 'gte', 'lt', 'lte'] as const) if (typeof c[k] === 'number' && Number.isFinite(c[k])) cond[k] = c[k] as number;
      for (const k of ['equals', 'notEquals'] as const) if (typeof c[k] === 'string') cond[k] = str(c[k], 100);
      if (typeof c.empty === 'boolean') cond.empty = c.empty;
      if (Object.keys(cond).filter((k) => k !== 'var').length === 0) throw new BotJobError(`${where}: say when it acts, like "if the count is more than 0".`);
      return { do: 'check', ask, if: cond, tell, text };
    }
  }
  throw new BotJobError(`${where}: a job starts the bot for people, posts its register, checks something, asks a bot or reminds people.`);
}

/** Check and tidy a bot's jobs (validateFlow calls it). Each schedule must read. */
export function checkJobs(raw: unknown, o: { tracked: boolean; now?: number } = { tracked: false }): BotJob[] {
  if (!Array.isArray(raw)) throw new BotJobError('"jobs" is a list.');
  if (raw.length > MAX_JOBS) throw new BotJobError(`A bot can have up to ${MAX_JOBS} scheduled jobs.`);
  const ids = new Set<string>();
  return raw.map((j, i) => {
    const r = (j && typeof j === 'object' ? j : {}) as Record<string, unknown>;
    const where = `Job ${i + 1}`;
    const id = str(r.id, 40) || `job${i + 1}`;
    if (!ID_RE.test(id) || ids.has(id)) throw new BotJobError(`${where}: give it its own short id.`);
    ids.add(id);
    const title = str(r.title, 80);
    if (!title) throw new BotJobError(`${where}: give it a name.`);
    const when = str(r.when, 200);
    const p = parseSchedule(when, o.now ?? Date.now());
    if (!p.ok) throw new BotJobError(`${where} (${title}): ${p.error}`);
    // "tomorrow at 10" is kept as the date it meant, so it does not move on by a day each day
    const fixed = p.rule.kind === 'once' && /\b(today|tomorrow)\b/i.test(when) ? `on ${p.rule.date} at ${hm(p.rule.time)}` : when;
    const out: BotJob = { id, title, when: fixed, do: checkAction(r.do, `${where} (${title})`, o.tracked) };
    if (r.missed === 'once' || r.missed === 'skip') out.missed = r.missed;
    if (r.leave === false) out.leave = false;
    return out;
  });
}

/** One line for a job, as the maker reads it. */
export function describeJob(j: BotJob, skillTitle: (id: string) => string = (id) => id): string {
  const people = (p: BotJobPeople) => (p.from === 'space' ? `the people of ${p.space}` : p.from === 'department' ? `the ${p.department} department` : p.from === 'team' ? 'your team' : p.people.length === 1 ? '1 person' : `${p.people.length} people`);
  const tell = (t: string) => (t === 'owner' ? 'you' : t === 'lead' ? 'your lead' : t.slice(6));
  const a = j.do;
  if (a.do === 'start') return `Starts it for ${people(a.people)}`;
  if (a.do === 'register') return 'Posts its register';
  if (a.do === 'remind') return `Reminds ${people(a.people)}`;
  if (a.do === 'ask') return `Asks “${skillTitle(a.ask.skill)}” and tells ${tell(a.tell)}`;
  return `Checks “${skillTitle(a.ask.skill)}” and tells ${tell(a.tell)} when it holds`;
}
