// Nib, the office's companion (docs/NIB.md): the shared, pure parts. The day-sheet parser that
// reads plain words ("got 12 isos from Meera for P-12 area 4"), the nudge policy that decides when
// Nib may ask someone to fill in their sheet, who may see whose sheet, and the cards built from
// day sheets: a lead's transmittal and the management's register. The hub and the app both use
// these, so the same words parse the same way on a PC and on the hub.

import type { HolidayOps, HolidayReadView } from './holidays.ts';
import type { KnockView } from './meet-lobby.ts';

// ---------------------------------------------------------------- identity and configuration
export const NIB_ACCOUNT = 'system\\nib';
export const NIB_NAME = 'Nib';

export type NibGiverKind = 'area' | 'discipline' | 'team';
export const NIB_GIVER_KINDS: NibGiverKind[] = ['area', 'discipline', 'team'];
/** Someone who hands out work: an area lead, a discipline lead or a team lead, with a scope ("Area 4", "Piping"). */
export interface NibGiver { userId: string; kind: NibGiverKind; scope: string }
export interface NibProject { code: string; name: string }

export interface NibConfig {
  enabled: boolean;
  givers: NibGiver[];
  /** The management: they receive the daily register, the follow-up and the weekly roll-up. */
  managers: string[];
  /** People who keep no day sheet; null means the management. */
  exempt: string[] | null;
  /** HH:MM, the hub's local time. */
  startPromptAt: string;
  wrapAt: string;
  digestAt: string;
  /** Before digestAt means the next workday morning. */
  followUpAt: string;
  /** Wrap-up asks a day (1 to 5). */
  nudgeLimit: number;
  /** 0 = Sunday … 6 = Saturday. */
  workdays: number[];
  projects: NibProject[];
  /** Every member may see every day sheet (off: private). */
  openSheets: boolean;
}

export const NIB_DEFAULTS: NibConfig = {
  enabled: true, givers: [], managers: [], exempt: null,
  startPromptAt: '09:45', wrapAt: '18:00', digestAt: '18:30', followUpAt: '19:00',
  nudgeLimit: 3, workdays: [1, 2, 3, 4, 5, 6], projects: [], openSheets: false,
};

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const minutesOf = (hhmm: string): number => { const m = HHMM.exec(hhmm); return m ? Number(m[1]) * 60 + Number(m[2]) : 0; };
export const hhmm = (min: number): string => { const m = Math.max(0, Math.min(23 * 60 + 59, Math.round(min))); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

const cleanLine = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Check and tidy a configuration from the Control room. Throws an Error worded for the person. */
export function checkNibConfig(raw: unknown, known: (id: string) => boolean): NibConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const ids = (v: unknown, max: number) => [...new Set((Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string' && known(x)))].slice(0, max);
  const time = (v: unknown, d: string, what: string) => {
    if (v === undefined) return d;
    if (typeof v !== 'string' || !HHMM.test(v)) throw new Error(`Write the ${what} as a time like 18:30.`);
    return v;
  };
  const givers: NibGiver[] = [];
  const seen = new Set<string>();
  for (const g of Array.isArray(r.givers) ? r.givers.slice(0, 300) : []) {
    const x = (g && typeof g === 'object' ? g : {}) as Record<string, unknown>;
    const userId = typeof x.userId === 'string' && known(x.userId) ? x.userId : null;
    const kind = NIB_GIVER_KINDS.includes(x.kind as NibGiverKind) ? x.kind as NibGiverKind : 'team';
    if (!userId || seen.has(`${userId}|${kind}`)) continue;
    seen.add(`${userId}|${kind}`);
    givers.push({ userId, kind, scope: cleanLine(x.scope, 40) });
  }
  const projects: NibProject[] = [];
  for (const p of Array.isArray(r.projects) ? r.projects.slice(0, 500) : []) {
    const x = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
    const code = cleanLine(x.code, 24).toUpperCase();
    if (!code || projects.some((q) => q.code === code)) continue;
    projects.push({ code, name: cleanLine(x.name, 80) });
  }
  const workdays = [...new Set((Array.isArray(r.workdays) ? r.workdays : NIB_DEFAULTS.workdays).filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  if (!workdays.length) throw new Error('Choose at least one workday.');
  const cfg: NibConfig = {
    enabled: r.enabled !== false,
    givers,
    managers: ids(r.managers, 50),
    exempt: r.exempt === null || r.exempt === undefined ? null : ids(r.exempt, 500),
    startPromptAt: time(r.startPromptAt, NIB_DEFAULTS.startPromptAt, 'start prompt time'),
    wrapAt: time(r.wrapAt, NIB_DEFAULTS.wrapAt, 'wrap-up time'),
    digestAt: time(r.digestAt, NIB_DEFAULTS.digestAt, 'register time'),
    followUpAt: time(r.followUpAt, NIB_DEFAULTS.followUpAt, 'follow-up time'),
    nudgeLimit: Math.max(1, Math.min(5, Math.round(Number(r.nudgeLimit ?? NIB_DEFAULTS.nudgeLimit)) || 3)),
    workdays,
    projects,
    openSheets: r.openSheets === true,
  };
  if (minutesOf(cfg.wrapAt) >= minutesOf(cfg.digestAt)) throw new Error('The wrap-up time comes before the register time.');
  if (minutesOf(cfg.followUpAt) === minutesOf(cfg.digestAt)) throw new Error('The follow-up goes at a different time from the register.');
  return cfg;
}

/** Projects from lines like "P-12 Refinery revamp" (the Control room's text box). */
export function projectsFromText(text: string): NibProject[] {
  const out: NibProject[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9][\w./-]{0,23})\s*[-–:,]?\s*(.*)$/.exec(line);
    if (!m) continue;
    const code = m[1].toUpperCase();
    if (out.some((p) => p.code === code)) continue;
    out.push({ code, name: m[2].trim().slice(0, 80) });
  }
  return out.slice(0, 500);
}

// ---------------------------------------------------------------- day sheets
export type NibStatus = 'going' | 'done' | 'blocked';
export interface NibQty {
  done: number | null;
  total: number | null;
  /** Normalised: "sheets", "isos", "drawings", "GAs", "MTOs", "lines", "spools", "supports", "models", "mark-ups", "hours", "%"; null for a bare count. */
  unit: string | null;
}
export type NibSource = 'start' | 'words' | 'offer' | 'slash' | 'wrap' | 'carried' | 'cover' | 'flow' | 'meeting';
export interface NibItem {
  id: string;
  userId: string;
  /** YYYY-MM-DD */
  date: string;
  giverId: string | null;
  /** A name typed for someone not in the Directory (a client, a site engineer). */
  giverName: string | null;
  project: string | null;
  activity: string;
  qty: NibQty | null;
  note: string | null;
  status: NibStatus;
  due: string | null;
  source: NibSource;
  carried: boolean;
  /** The message it came from (an offer in a conversation). */
  messageId: string | null;
  /** Someone this was taken over from (covering their leave). */
  coverFor: string | null;
  createdAt: number;
  updatedAt: number;
}
export type NibDayState = 'open' | 'sent' | 'nothing' | 'leave';
export interface NibAsk { at: number; level: 1 | 2 | 3; kind: 'start' | 'wrap' | 'yesterday' }
export interface NibDay {
  userId: string;
  date: string;
  /** Who they said gave them work (the start card, and every item since). */
  givers: string[];
  /** The start card was answered (or the day began with an item). */
  started: boolean;
  state: NibDayState;
  sentAt: number | null;
  /** Changed after it was sent. */
  changedAt: number | null;
  note: string | null;
  blockers: string | null;
  asks: NibAsk[];
  snoozeUntil: number | null;
}
export type NibLeaveKind = 'annual' | 'sick' | 'comp' | 'half';
export interface NibLeave {
  id: string;
  userId: string;
  kind: NibLeaveKind;
  /** YYYY-MM-DD, both inclusive. */
  from: string;
  to: string;
  half: 'am' | 'pm' | null;
  coverId: string | null;
  note: string | null;
  handover: string | null;
  leadIds: string[];
  spaceIds: string[];
  reminders: 'move' | 'cover' | 'keep';
  createdAt: number;
  cancelled: boolean;
}
export type NibNudgeKind = 'start' | 'wrap' | 'yesterday';
export interface NibNudgeView { kind: NibNudgeKind; level: 1 | 2 | 3; asks: number }

/** Someone's state for today, as their app shows it (nib.me). */
export interface NibMe {
  enabled: boolean;
  botId: string;
  convId: string | null;
  date: string;
  workday: boolean;
  /** Keeps no day sheet (the management, unless the office says otherwise). */
  exempt: boolean;
  isManager: boolean;
  isGiver: boolean;
  day: NibDay;
  items: NibItem[];
  nudge: NibNudgeView | null;
  /** When Nib offers the wrap-up today (HH:MM), and whether it is the person's own choice. */
  wrapAt: string;
  ownWrapAt: string | null;
  digestAt: string;
  givers: NibGiver[];
  projects: NibProject[];
  /** Givers of the last ten workdays, most often first. */
  usual: string[];
  recentProjects: string[];
  /** Giver id -> when they marked today's sheet seen. */
  seen: Record<string, number>;
  /** Leave that covers today or starts later. */
  leave: NibLeave | null;
  /** The first day back: a summary to show once. */
  welcome: NibWelcome | null;
  /** The last workday's sheet was never sent. */
  yesterday: { date: string; items: number } | null;
}
export interface NibWelcome {
  leave: NibLeave;
  /** Reminders moved to today, and work the cover logged against the person's items. */
  reminders: number;
  coverItems: Array<{ activity: string; project: string | null; qty: NibQty | null; note: string | null; status: NibStatus; by: string }>;
}

// ---------------------------------------------------------------- the parser
export type NibIntent = 'got' | 'done' | 'progress' | 'blocked' | 'leave' | 'nothing' | 'remind' | 'where' | 'who' | 'meeting' | 'brief' | 'help' | 'wrap' | 'unknown';
export const NIB_WORK_INTENTS: NibIntent[] = ['got', 'done', 'progress', 'blocked'];
export interface NibPerson { id: string; name: string; giver?: boolean }
export interface NibParseContext {
  people: NibPerson[];
  projects?: NibProject[];
  /** YYYY-MM-DD, the day the words are written. */
  today: string;
  meId?: string;
}
export type NibSpanKind = 'giver' | 'project' | 'qty' | 'due' | 'status';
export interface NibParse {
  intent: NibIntent;
  confidence: number;
  giver: { id: string | null; name: string } | null;
  project: string | null;
  activity: string;
  qty: NibQty | null;
  status: NibStatus | null;
  due: string | null;
  note: string | null;
  /** Where each part was found in the words, to light it up as you type. */
  spans: Array<{ from: number; to: number; kind: NibSpanKind }>;
}

const UNITS: Array<[string, RegExp]> = [
  ['isos', /^(isos?|isometrics?|isometric drawings?|iso drawings?)$/i],
  ['sheets', /^(sheets?|shts?|shits?)$/i],
  ['drawings', /^(drawings?|dwgs?|drgs?|drg)$/i],
  ['GAs', /^(gas?|g\.a\.?s?|general arrangements?)$/i],
  ['MTOs', /^(mtos?|m\.t\.o\.?s?)$/i],
  ['lines', /^(lines?|line lists?)$/i],
  ['spools', /^(spools?)$/i],
  ['supports', /^(supports?|pipe supports?)$/i],
  ['models', /^(models?|3d models?)$/i],
  ['mark-ups', /^(mark-?ups?|markups?|redlines?|comments?)$/i],
  ['nozzles', /^(nozzles?)$/i],
  ['hours', /^(h|hrs?|hours?|ghante?|ghanta)$/i],
  ['%', /^(%|percent|per cent|pc|pct)$/i],
];
const UNIT_WORD = String.raw`(?:%|per ?cent|pct|pc\b|isometric drawings?|isometrics?|iso drawings?|isos?|sheets?|shts?|drawings?|dwgs?|drgs?|general arrangements?|g\.a\.?s?|gas?|m\.t\.o\.?s?|mtos?|line lists?|lines?|spools?|pipe supports?|supports?|3d models?|models?|mark-?ups?|markups?|redlines?|comments?|nozzles?|hrs?|hours?|h\b|ghante?|ghanta)`;

/** A unit word in its office form ("isometrics" -> "isos", "hrs" -> "hours"), or null. */
export function unitOf(word: string): string | null {
  const w = word.trim().toLowerCase().replace(/\s+/g, ' ');
  for (const [u, re] of UNITS) if (re.test(w)) return u;
  return null;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100,
  dozen: 12, 'a dozen': 12, 'half a dozen': 6, ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, saat: 7, aath: 8, nau: 9, das: 10, a: 1, an: 1,
};
const NUM = String.raw`(\d+(?:\.\d+)?|half a dozen|a dozen|dozen|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|hundred|ek|teen|chaar|char|paanch|panch|chhe|saat|aath|das)`;
const num = (s: string): number => { const n = Number(s); return Number.isFinite(n) ? n : NUMBER_WORDS[s.toLowerCase()] ?? NaN; };

/** Prefixes that name a drawing, a document or a revision, not a job ("ISO-1001", "GA-200", "REV-2"). */
const NOT_A_JOB = new Set(['ISO', 'GA', 'DWG', 'DRG', 'MTO', 'LINE', 'REV', 'SHT', 'SP', 'PO', 'RFI', 'WP', 'TQ', 'NCR', 'BOM', 'AREA', 'NO', 'RV', 'R', 'A', 'B', 'C', 'D', 'E', 'H', 'HR', 'HRS', 'ID', 'OD']);

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dateOf = (s: string): Date => { const [y, m, d] = s.split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1, 12); };
export const addDays = (date: string, n: number): string => { const d = dateOf(date); d.setDate(d.getDate() + n); return ymd(d); };
export const weekdayOf = (date: string): number => dateOf(date).getDay();

/** Damerau-free edit distance, bounded (small names only). */
function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

/** The person a written name points at: full name, first name, or a small slip ("Meera", "meera iyer", "Mera"). */
export function findPerson(name: string, people: NibPerson[], meId?: string): NibPerson | null {
  const n = name.toLowerCase().replace(/^@/, '').replace(/[^\p{L}\p{N} .'-]/gu, '').trim();
  if (n.length < 2) return null;
  const pool = people.filter((p) => p.id !== meId);
  const score = (p: NibPerson): number => {
    const full = p.name.toLowerCase();
    const parts = full.split(/\s+/);
    if (full === n) return 100;
    if (parts[0] === n) return 90;
    if (full.startsWith(`${n} `) || parts.slice(1).includes(n)) return 70;
    if (n.length >= 4 && parts[0].length >= 4 && distance(parts[0], n) <= 1) return 50;
    if (n.length >= 3 && parts[0].startsWith(n)) return 40;
    return 0;
  };
  let best: NibPerson | null = null;
  let top = 0;
  for (const p of pool) {
    const s = score(p) + (p.giver ? 5 : 0);
    if (s > top) { top = s; best = p; }
  }
  return top >= 40 ? best : null;
}

/** Due dates in words: "by Friday", "kal tak", "EOD", "on 20 Nov", "20/11", "tomorrow". */
export function dueFrom(s: string, today: string): { due: string; from: number; to: number } | null {
  const lower = s.toLowerCase();
  const tests: Array<[RegExp, (m: RegExpExecArray) => string | null]> = [
    [/\b(?:by|till|until|before|on|due)\s+(today|tonight|eod|end of (?:the )?day)\b/, () => today],
    [/\b(eod|today eod|aaj tak|aaj hi)\b/, () => today],
    [/\b(?:by|till|until|before|on|due)?\s*(tomorrow|tmrw|tmr|kal tak|kal)\b/, () => addDays(today, 1)],
    [/\b(?:by|till|until|before|on|due)?\s*(day after tomorrow|parso|parson)\b/, () => addDays(today, 2)],
    [/\b(?:by|till|until|before|on|due)\s+(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday)?\b/, (m) => {
      const want = DAYS.findIndex((d) => d.startsWith(m[1].slice(0, 3)));
      const now = weekdayOf(today);
      return addDays(today, ((want - now + 7) % 7) || 7);
    }],
    [/\b(?:by|till|until|before|on|due)\s+(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/, (m) => monthDay(today, Number(m[1]), MONTHS.indexOf(m[2]))],
    [/\b(?:by|till|until|before|on|due)\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/, (m) => monthDay(today, Number(m[2]), MONTHS.indexOf(m[1]))],
    [/\b(?:by|till|until|before|on|due)\s+(\d{1,2})[/.](\d{1,2})\b/, (m) => monthDay(today, Number(m[1]), Number(m[2]) - 1)],
    [/\b(?:by|before)\s+(\d{1,2})(?::\d{2})?\s*(am|pm)\b/, () => today],
  ];
  for (const [re, f] of tests) {
    const m = re.exec(lower);
    if (!m) continue;
    const due = f(m);
    if (due) return { due, from: m.index + (m[0].length - m[0].trimStart().length), to: m.index + m[0].length };
  }
  return null;
}
function monthDay(today: string, day: number, month: number): string | null {
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  const t = dateOf(today);
  let d = new Date(t.getFullYear(), month, day, 12);
  if (d.getMonth() !== month) return null;
  // a date well in the past means next year's
  if (d.getTime() < t.getTime() - 60 * 86400_000) d = new Date(t.getFullYear() + 1, month, day, 12);
  return ymd(d);
}

const SKILLS: Array<[NibIntent, RegExp]> = [
  ['remind', /^(?:please\s+)?(?:remind me|set a reminder|reminder\b|yaad dila)/i],
  ['where', /^(?:where(?:'s| is| are)\b|find (?:me )?(?:the )?|look for |kahan (?:hai|h)\b|kaha (?:hai|h)\b|search (?:for )?)/i],
  ['who', /^(?:who(?:'s| is)? (?:in|here|around|off|on leave|at (?:the )?site)\b|who knows|who(?:'s| is)? working on|who can help|kaun (?:hai|aaya)|who all)/i],
  ['meeting', /\b(?:(?:my |the )?next meeting|meeting (?:kab|when)|when(?:'s| is) my meeting|join (?:my )?meeting)\b/i],
  ['brief', /^(?:morning brief|my brief|brief me|brief\b|what(?:'s| is) on today|what do i have today|aaj kya hai|my day\b)/i],
  ['help', /^(?:how (?:do|can|to|should) (?:i|we)\b|how to\b|help\b|kaise\b|where do i find the setting)/i],
  ['wrap', /^(?:wrap(?:[- ]?up)?(?: my day)?|send my (?:day )?sheet|pens down|end my day report|day ?sheet send)\b/i],
];
const LEAVE_RE = /\b(?:on leave|leave (?:today|tomorrow|from|on|for)|taking (?:the |a )?(?:day|days) off|day off|sick (?:today|leave)|i(?:'m| am) sick|chutti|chhutti|half[- ]day (?:leave|off)|leave half[- ]day|comp[- ]?off|aadha din (?:chutti|leave))\b/i;
const NOTHING_RE = /^(?:nothing(?: (?:today|new|much|to report))?|no work(?: today)?|kuch nahi(?: aaj)?|nil|none today|no activity|no tasks? today)\.?$/i;
const GOT_RE = /\b(?:got|received|recd|rcvd|assigned|allotted|alloted|given|new|mila|mili|mile|diya|diye|di|asked me|needs?|please|pls|plz|kindly|can you|could you|to do|todo|have to|need to|naya)\b/i;
const DONE_RE = /\b(?:done|finished|finish|completed?|kar diya|kar di|kar diye|kiya|ho gaya|ho gya|ho gaye|ho gayi|ho gyi|khatam|issued|submitted|sent|closed|over|wrapped)\b/i;
const BLOCKED_RE = /\b(?:waiting(?: for| on)?|awaited|awaiting|on hold|hold|stuck|blocked|blocker|depends on|not received|nahi mila|nahi aaya|rukha|ruka)\b/i;
const PENDING_RE = /\b(?:pending|baaki|baki|bacha|bache|remaining|left)\b/i;
// words that carry no activity once the rest is understood
const FILLER = /\b(?:i|i've|i have|have|has|got|received|recd|rcvd|assigned|allotted|given|new|mila|mili|mile|diya|diye|di|ne|se|ka|ki|ke|ko|hai|h|tha|the|aaj|today|please|pls|plz|kindly|for|from|of|by|side|ka kaam|work|task|just|also|and|to do|todo|done|finished|completed?|kar diya|kar di|kar diye|kiya|ho gaya|ho gya|ho gaye|ho gayi|ho gyi|khatam|me|my|in|on|a|an|so far|till now|abhi tak|naya)\b/gi;

/**
 * Read plain words about work. Never throws: words it cannot place stay in the activity, and the
 * intent says what kind of line it is ("unknown" when nothing suggests one).
 */
export function parseWork(input: string, ctx: NibParseContext): NibParse {
  const text = String(input ?? '').slice(0, 400);
  const out: NibParse = { intent: 'unknown', confidence: 0, giver: null, project: null, activity: '', qty: null, status: null, due: null, note: null, spans: [] };
  const trimmed = text.trim();
  if (!trimmed) return out;
  // ---- skills first: they are whole sentences of their own kind
  if (NOTHING_RE.test(trimmed)) return { ...out, intent: 'nothing', confidence: 0.9 };
  for (const [intent, re] of SKILLS) if (re.test(trimmed)) return { ...out, intent, confidence: 0.85, activity: trimmed };
  if (LEAVE_RE.test(trimmed) || /^half[- ]day(?: today| tomorrow)?\.?$/i.test(trimmed)) {
    const due = dueFrom(trimmed, ctx.today);
    return { ...out, intent: 'leave', confidence: 0.8, due: due?.due ?? null, activity: trimmed };
  }

  const taken: Array<[number, number]> = [];
  const take = (from: number, to: number, kind: NibSpanKind | null) => {
    if (to <= from) return;
    taken.push([from, to]);
    if (kind) out.spans.push({ from, to, kind });
  };
  const free = (from: number, to: number) => !taken.some(([a, b]) => from < b && to > a);

  // ---- a greeting to the person writing ("Karthik, please check…") is not part of the work
  const self = ctx.meId ? ctx.people.find((x) => x.id === ctx.meId) : undefined;
  if (self) {
    const first = self.name.split(/\s+/)[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const g = new RegExp(`^\\s*(?:hi |hey |dear )?${first}\\b\\s*[,:!]\\s*`, 'i').exec(text);
    if (g) take(0, g[0].length, null);
  }

  // ---- mentions inserted by the app (<@id>)
  for (const m of text.matchAll(/<@([\w-]{6,})>/g)) {
    const p = ctx.people.find((x) => x.id === m[1]);
    if (p && p.id !== ctx.meId && !out.giver) { out.giver = { id: p.id, name: p.name }; take(m.index!, m.index! + m[0].length, 'giver'); }
  }

  // ---- the job
  const projects = ctx.projects ?? [];
  if (projects.length) {
    for (const p of projects) {
      const code = p.code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '[- ]?');
      const m = new RegExp(`(?<![\\w-])${code}(?![\\w])`, 'i').exec(text);
      if (m && free(m.index, m.index + m[0].length)) { out.project = p.code; take(m.index, m.index + m[0].length, 'project'); break; }
    }
  }
  if (!out.project) {
    for (const m of text.matchAll(/(?<![\w-])([A-Za-z]{1,4})-?(\d{2,6})(?![\w])/g)) {
      const letters = m[1].toUpperCase();
      if (NOT_A_JOB.has(letters) || !free(m.index!, m.index! + m[0].length)) continue;
      // "12 isos" has no letters before the number; "area 4" is not a job either
      if (/^(?:area|zone|unit|block|rev|sheet|no|of|by|to|on|in|at|for|due|till|and|or)$/i.test(m[1])) continue;
      out.project = `${letters}-${m[2]}`;
      take(m.index!, m.index! + m[0].length, 'project');
      break;
    }
  }

  // ---- due
  const due = dueFrom(text, ctx.today);
  if (due && free(due.from, due.to)) { out.due = due.due; take(due.from, due.to, 'due'); }

  // ---- quantities
  const qtyPatterns: Array<[RegExp, (m: RegExpExecArray) => NibQty | null]> = [
    // 18 of 40 sheets, 18/40, 18 out of 40 isos
    [new RegExp(String.raw`(?<![\w.])${NUM}\s*(?:of|/|out of|outta)\s*${NUM}\s*(${UNIT_WORD})?(?![\w])`, 'i'), (m) => {
      const a = num(m[1]); const b = num(m[2]);
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
      return { done: a, total: b, unit: m[3] ? unitOf(m[3]) : null };
    }],
    // 12-15 drawings: a range, the larger planned
    [new RegExp(String.raw`(?<![\w.-])(\d+)\s*(?:-|–|to)\s*(\d+)\s*(${UNIT_WORD})(?![\w])`, 'i'), (m) => {
      const a = Number(m[1]); const b = Number(m[2]);
      if (!(b > a)) return null;
      return { done: null, total: b, unit: unitOf(m[3]) };
    }],
    // 40%, 40 percent
    [new RegExp(String.raw`(?<![\w.])(\d+(?:\.\d+)?)\s*(%|per ?cent|pct)(?![\w])`, 'i'), (m) => ({ done: Math.min(100, Number(m[1])), total: 100, unit: '%' })],
    // 12 isos, twelve sheets, 2.5 h
    [new RegExp(String.raw`(?<![\w.-])${NUM}\s*(${UNIT_WORD})(?![\w])`, 'i'), (m) => {
      const n = num(m[1]);
      return Number.isFinite(n) && n > 0 ? { done: null, total: n, unit: unitOf(m[2]) } : null;
    }],
    // half day, full day (as time)
    [/\b(half[- ]?(?:a )?day|aadha din|full[- ]?day|whole day|pura din)\b/i, (m) => ({ done: null, total: /half|aadha/i.test(m[1]) ? 4 : 8, unit: 'hours' })],
  ];
  for (const [re, f] of qtyPatterns) {
    const m = re.exec(text);
    if (!m || !free(m.index, m.index + m[0].length)) continue;
    const q = f(m);
    if (!q) continue;
    out.qty = q;
    take(m.index, m.index + m[0].length, 'qty');
    break;
  }
  // a bare number after "done": "done 12"
  if (!out.qty) {
    const m = /\b(?:done|finished|completed?|kiye?|issued)\s+(\d+)\b|\b(\d+)\s+(?:done|finished|completed|ho gaye|kar diye|issued)\b/i.exec(text);
    if (m && free(m.index, m.index + m[0].length)) { out.qty = { done: null, total: Number(m[1] ?? m[2]), unit: null }; take(m.index + m[0].indexOf(m[1] ?? m[2]), m.index + m[0].indexOf(m[1] ?? m[2]) + (m[1] ?? m[2]).length, 'qty'); }
  }

  // ---- who gave it
  if (!out.giver) {
    const tries: RegExp[] = [
      /^\s*@?([\p{L}][\p{L}.'-]{1,30}(?:\s[\p{L}][\p{L}.'-]{1,30})?)\s*[:–-]\s+/u,
      /\b(?:from|frm|by|via)\s+@?([\p{L}][\p{L}.'-]{1,30}(?:\s[\p{L}][\p{L}.'-]{1,30})?)/u,
      /@([\p{L}][\p{L}.'-]{1,30})/u,
      /\b([\p{L}][\p{L}.'-]{1,30})(?:'s)?\s+(?:side|ne diya|ne diye|ne di|ne bola|ne kaha|se mila|se mili|se mile|ka kaam|ki taraf se|sir|ma'am|madam)\b/u,
      /\b(?:for|to)\s+@?([\p{L}][\p{L}.'-]{1,30}(?:\s[\p{L}][\p{L}.'-]{1,30})?)/u,
      /^\s*([\p{L}][\p{L}.'-]{1,30})\s+(?:gave|asked|assigned|wants|needs|sent)\b/u,
    ];
    for (const re of tries) {
      const m = re.exec(text);
      if (!m) continue;
      // try the two-word name first, then its first word
      const words = m[1].split(/\s+/);
      let hit: NibPerson | null = null;
      let used = m[1];
      for (const cand of words.length > 1 ? [m[1], words[0]] : [m[1]]) {
        hit = findPerson(cand, ctx.people, ctx.meId);
        if (hit) { used = cand; break; }
      }
      if (!hit) continue;
      const at = m.index + m[0].indexOf(used);
      if (!free(at, at + used.length)) continue;
      out.giver = { id: hit.id, name: hit.name };
      // the whole cue ("from Meera", "Meera side", "Meera:") goes with the name
      take(m.index + (m[0].length - m[0].trimStart().length), m.index + m[0].length, null);
      out.spans.push({ from: at, to: at + used.length, kind: 'giver' });
      break;
    }
  }

  // ---- status and intent
  const lower = text.toLowerCase();
  const done = DONE_RE.test(lower);
  const blocked = BLOCKED_RE.exec(text);
  const pending = PENDING_RE.test(lower);
  const got = GOT_RE.test(lower.replace(DONE_RE, ' '));
  if (blocked) {
    out.status = 'blocked';
    out.intent = 'blocked';
    out.note = text.slice(blocked.index).replace(/^[\s,.;:-]+/, '').trim().slice(0, 200) || null;
    take(blocked.index, text.length, 'status');
  } else if (out.qty && out.qty.done !== null) {
    out.intent = 'progress';
    out.status = out.qty.done >= (out.qty.total ?? Infinity) ? 'done' : 'going';
  } else if (done && !got) {
    out.intent = 'done';
    out.status = 'done';
    if (out.qty) out.qty = { ...out.qty, done: out.qty.total };
  } else if (got || out.giver) {
    out.intent = 'got';
    out.status = 'going';
    if (out.qty && out.qty.unit !== 'hours') out.qty = { ...out.qty, done: 0 };
  } else if (out.qty || out.project) {
    out.intent = done ? 'done' : 'got';
    out.status = done ? 'done' : 'going';
    if (!done && out.qty && out.qty.unit !== 'hours' && out.qty.done === null) out.qty = { ...out.qty, done: 0 };
  }
  if (pending && out.status !== 'blocked') out.note = out.note ?? 'Pending';
  const statusWord = (done ? DONE_RE : pending ? PENDING_RE : null)?.exec(text);
  if (statusWord && free(statusWord.index, statusWord.index + statusWord[0].length)) out.spans.push({ from: statusWord.index, to: statusWord.index + statusWord[0].length, kind: 'status' });

  // ---- the activity: what is left
  let rest = '';
  for (let i = 0; i < text.length; i++) rest += taken.some(([a, b]) => i >= a && i < b) ? ' ' : text[i];
  rest = rest.replace(PENDING_RE, ' ').replace(FILLER, ' ').replace(/[\s,;:.!?()–-]+$/g, '').replace(/^[\s,;:.!?()–-]+/g, '').replace(/\s*,\s*,+/g, ',').replace(/\s+/g, ' ').trim();
  rest = rest.replace(/^(?:to|and|with|the)\s+/i, '').replace(/\s+(?:to|and|with|the)$/i, '').trim();
  if (!rest && out.qty?.unit && out.qty.unit !== 'hours' && out.qty.unit !== '%') rest = out.qty.unit === 'isos' ? 'Isometrics' : out.qty.unit[0].toUpperCase() + out.qty.unit.slice(1);
  out.activity = rest ? rest[0].toUpperCase() + rest.slice(1) : '';
  // keep a unit that names the work ("12 isos") as the activity's subject when the rest is only a place ("area 4")
  if (out.qty?.unit && /^(?:area|zone|unit|block)\s*\w+$/i.test(out.activity)) out.activity = `${out.qty.unit === 'isos' ? 'Isometrics' : out.qty.unit[0].toUpperCase() + out.qty.unit.slice(1)} · ${out.activity.toLowerCase()}`;

  let conf = 0.25;
  if (out.giver) conf += 0.2;
  if (out.qty) conf += 0.2;
  if (out.project) conf += 0.15;
  if (out.intent !== 'unknown') conf += 0.15;
  if (out.activity) conf += 0.05;
  out.confidence = Math.min(1, out.intent === 'unknown' ? Math.min(conf, 0.4) : conf);
  if (out.intent === 'unknown' && out.activity.length > 2) out.intent = 'got';
  out.spans.sort((a, b) => a.from - b.from);
  return out;
}

/** Example lines for the on-device sentence model (the rules decide alone without it). */
export const NIB_INTENT_EXAMPLES: Record<Exclude<NibIntent, 'unknown' | 'progress'>, string[]> = {
  got: ['got new work from my lead', 'Meera asked me to check the GA', 'received 12 isos to route', 'please prepare the MTO by Friday', 'naya kaam mila'],
  done: ['finished the isometrics', 'issued the drawings for review', 'completed the line list', 'kaam ho gaya'],
  blocked: ['waiting for vendor data', 'stuck on the clash with the platform', 'on hold until the client replies'],
  leave: ['I am on leave tomorrow', 'taking a day off on Friday', 'sick today', 'half day leave'],
  nothing: ['nothing to report today', 'no work today'],
  remind: ['remind me to call the client after lunch', 'set a reminder for the review'],
  where: ['where is the latest GA drawing', 'find the stress report for P-12'],
  who: ['who is in the office today', 'who knows about pipe stress'],
  meeting: ['when is my next meeting', 'join my meeting'],
  brief: ['what do I have today', 'give me my morning brief'],
  help: ['how do I share my screen', 'how to start a room'],
  wrap: ['send my day sheet', 'wrap up my day'],
};

// ---------------------------------------------------------------- reminders in plain words
/** "after lunch", "end of day", "this evening", "tomorrow morning", "kal", "in 20 min", "at 5pm": when, and the words left. */
export function whenFromWords(input: string, now: Date, wrapAt = '18:00'): { at: number; rest: string } | null {
  let s = input.trim().replace(/^(?:please\s+)?(?:remind me(?: to)?|set a reminder(?: to)?|reminder:?|yaad dila(?:na)?)\s*/i, '');
  const at = (d: Date, h: number, m: number) => { const x = new Date(d); x.setHours(h, m, 0, 0); return x.getTime(); };
  const day = (n: number) => { const d = new Date(now); d.setDate(d.getDate() + n); return d; };
  const later = (t: number) => (t > now.getTime() ? t : t + 86400_000);
  const rules: Array<[RegExp, (m: RegExpExecArray) => number]> = [
    [/\bin\s+(\d{1,3})\s*(m|min|mins|minutes?|h|hr|hrs|hours?)\b/i, (m) => now.getTime() + Number(m[1]) * (m[2][0].toLowerCase() === 'h' ? 3600_000 : 60_000)],
    [/\bin (?:an|one) hour\b/i, () => now.getTime() + 3600_000],
    [/\bin half an hour\b/i, () => now.getTime() + 1800_000],
    [/\b(?:after lunch|lunch ke baad)\b/i, () => later(at(now, 14, 0))],
    [/\b(?:before lunch|lunch se pehle)\b/i, () => later(at(now, 12, 30))],
    [/\b(?:end of (?:the )?day|eod|before i leave|before leaving|jaane se pehle)\b/i, () => later(at(now, Math.floor(minutesOf(wrapAt) / 60), minutesOf(wrapAt) % 60) - 15 * 60_000)],
    [/\b(?:this evening|tonight|shaam ko)\b/i, () => later(at(now, 17, 30))],
    [/\b(?:tomorrow morning|kal subah|first thing tomorrow)\b/i, () => at(day(1), 9, 30)],
    [/\b(?:tomorrow|tmrw|kal)(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?\b/i, (m) => m[1] ? at(day(1), h24(Number(m[1]), m[3]), Number(m[2] ?? 0)) : at(day(1), 9, 30)],
    [/\b(?:on\s+)?(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/i, (m) => {
      const want = DAYS.findIndex((d) => d.startsWith(m[1].toLowerCase()));
      return at(day(((want - now.getDay() + 7) % 7) || 7), 9, 30);
    }],
    [/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i, (m) => later(at(now, h24(Number(m[1]), m[3]), Number(m[2] ?? 0)))],
  ];
  for (const [re, f] of rules) {
    const m = re.exec(s);
    if (!m) continue;
    const t = f(m);
    if (!Number.isFinite(t)) continue;
    s = (s.slice(0, m.index) + s.slice(m.index + m[0].length)).replace(/\s+/g, ' ').replace(/^\s*(?:to|that)\s+/i, '').trim();
    return { at: t, rest: s };
  }
  return null;
}
const h24 = (h: number, ap?: string): number => {
  if (!ap) return h <= 7 ? h + 12 : h; // "at 5" in an office means 5 PM
  const pm = ap.toLowerCase() === 'pm';
  return h === 12 ? (pm ? 12 : 0) : pm ? h + 12 : h;
};

// ---------------------------------------------------------------- the nudge policy
export interface NudgeInput {
  now: number;
  workday: boolean;
  exempt: boolean;
  onLeave: boolean;
  day: Pick<NibDay, 'state' | 'started' | 'asks' | 'snoozeUntil'>;
  /** In a Room, a calendar meeting, Do not disturb or Heads-down. */
  busy: boolean;
  /** One of their devices is connected. */
  online: boolean;
  /** Times today, in ms. */
  startPromptAt: number;
  wrapAt: number;
  digestAt: number;
  limit: number;
}
export interface NudgeResult {
  kind: NibNudgeKind | null;
  /** What the app shows now: 0 nothing, 1 the ink drop, 2 the callout and a Pulse card, 3 a message was sent. */
  level: 0 | 1 | 2 | 3;
  /** Record a new ask at this level now. */
  ask: 1 | 2 | 3 | null;
  reason: string;
}

/** The ladder's natural spacing: the card 25 minutes after the drop, the next ask 25 after that. */
export const NUDGE_STEP_MIN = 25;
/** Never two asks closer than the gap: 20 minutes when there is room, never under 7 in a short window. */
export const NUDGE_GAP_MAX_MIN = 20;
export const NUDGE_GAP_MIN_MIN = 7;
/** Room a person's wrap-up keeps before the register: ten minutes for each ask a day (30 for 3). */
export const NUDGE_ROOM_PER_ASK_MIN = 10;
/** How long before the register the last planned ask goes: a quarter of the window, 5 to 15 minutes. */
export const nudgeMargin = (windowMin: number): number => Math.max(5, Math.min(15, Math.round(windowMin / 4)));
const askLimit = (n: number): number => Math.max(1, Math.min(5, Math.round(Number(n)) || 1));

export interface NudgePlan {
  /** Minutes after the wrap-up time of each ask that fits before the register, in order. */
  offsets: number[];
  /** What each of those asks shows: 1 the ink drop, 2 the callout, 3 the message. */
  levels: Array<1 | 2 | 3>;
  /** Never two asks closer than this many minutes. */
  gap: number;
  /** From this many minutes after the wrap-up, the last ask that still fits is the message. */
  messageAfter: number;
  /** The office's asks a day; more than offsets.length when the window is too short for them all. */
  limit: number;
}

function fitAsks(windowMin: number, n: number): { offsets: number[]; gap: number } {
  const usable = Math.max(0, windowMin - nudgeMargin(windowMin));
  let k = n;
  while (k > 1 && Math.floor(usable / (k - 1)) < NUDGE_GAP_MIN_MIN) k--;
  const gap = k > 1 ? Math.max(NUDGE_GAP_MIN_MIN, Math.min(NUDGE_GAP_MAX_MIN, Math.floor(usable / (k - 1)))) : NUDGE_GAP_MAX_MIN;
  // each ask at its natural step, pulled earlier only as far as the ones after it need
  const offsets = Array.from({ length: k }, (_, i) => Math.max(0, Math.min(NUDGE_STEP_MIN * i, usable - (k - 1 - i) * gap)));
  return { offsets, gap };
}

/**
 * When the wrap-up asks go, for a window of `windowMin` minutes from the wrap-up to the register
 * (docs/NIB.md §3.5). The asks keep the ladder's 25-minute steps where there is room and are spread
 * evenly across a short window, the last one a margin before the register; when even 7 minutes
 * apart they do not all fit, as many as fit are planned and the last of them is still the message.
 */
export function nudgePlan(windowMin: number, limit: number): NudgePlan {
  const n = askLimit(limit);
  const w = Math.max(0, Math.floor(windowMin));
  const { offsets, gap } = fitAsks(w, n);
  const ladder: Array<1 | 2 | 3> = n === 1 ? [1] : n === 2 ? [1, 2] : [1, ...Array<2>(n - 2).fill(2), 3];
  const levels = offsets.length === n ? ladder : [...ladder.slice(0, offsets.length - 1), ladder[n - 1]];
  const three = fitAsks(w, Math.max(n, 3)).offsets;
  return { offsets, levels, gap, messageAfter: three[three.length - 1], limit: n };
}

/** The asks' clock times for a wrap-up and a register time (HH:MM), for the Control room and the setup check. */
export function nudgeTimes(wrapAt: string, digestAt: string, limit: number): { times: string[]; fits: number; limit: number } {
  const wrap = minutesOf(wrapAt);
  const plan = nudgePlan(minutesOf(digestAt) - wrap, limit);
  return { times: plan.offsets.map((o) => hhmm(wrap + o)), fits: plan.offsets.length, limit: plan.limit };
}

/** When Nib may ask, and how loudly (docs/NIB.md §3.5). Pure: the hub calls it once a minute for each person. */
export function nudgePolicy(i: NudgeInput): NudgeResult {
  const none = (reason: string): NudgeResult => ({ kind: null, level: 0, ask: null, reason });
  if (!i.workday) return none('not a workday');
  if (i.exempt) return none('keeps no day sheet');
  if (i.onLeave || i.day.state === 'leave') return none('on leave');
  if (i.day.state === 'sent') return none('sent');
  if (i.day.state === 'nothing') return none('nothing today');
  const wrapAsks = i.day.asks.filter((a) => a.kind === 'wrap');
  const shownWrap = wrapAsks.reduce<number>((n, a) => Math.max(n, a.level), 0) as 0 | 1 | 2 | 3;
  const lastAt = i.day.asks.reduce((n, a) => Math.max(n, a.at), 0);
  const snoozed = i.day.snoozeUntil !== null && i.now < i.day.snoozeUntil;
  const quiet = i.busy || !i.online || snoozed;
  const why = i.busy ? 'busy' : !i.online ? 'offline' : 'snoozed';
  // the wrap-up ladder
  if (i.now >= i.wrapAt) {
    if (i.now >= i.digestAt) return { kind: 'wrap', level: shownWrap, ask: null, reason: 'after the register' };
    const plan = nudgePlan((i.digestAt - i.wrapAt) / 60_000, i.limit);
    const slot = (k: number) => i.wrapAt + plan.offsets[k] * 60_000;
    const k = wrapAsks.length;
    const wait = (reason: string): NudgeResult => ({ kind: 'wrap', level: shownWrap, ask: null, reason });
    if (shownWrap >= 3) return wait('message sent');
    if (k >= plan.offsets.length) return wait(k >= plan.limit ? 'limit reached' : 'no more room before the register');
    if (i.now < slot(k)) return wait('waiting for the next step');
    if (quiet) return { kind: 'wrap', level: Math.max(shownWrap, snoozed ? 1 : shownWrap) as 0 | 1 | 2 | 3, ask: null, reason: why };
    if (lastAt && i.now - lastAt < plan.gap * 60_000) return wait('too soon');
    // An ask that waited (busy, offline, snoozed) goes as soon as the person is free, if that is
    // still before the register. The steps it no longer has room for are missed and never counted;
    // when no further ask fits before the register, this one is the message. The last planned ask
    // is the message too once its time has come (with 1 or 2 asks a day, only when it is that late).
    const squeezed = k + 1 < plan.offsets.length && Math.max(slot(k + 1), i.now + plan.gap * 60_000) >= i.digestAt;
    const late = k + 1 >= plan.offsets.length && i.now >= i.wrapAt + plan.messageAfter * 60_000;
    const level = squeezed || late ? 3 : plan.levels[k];
    return { kind: 'wrap', level, ask: level, reason: 'ask' };
  }
  // the start of the day: one gentle card
  if (i.now >= i.startPromptAt && !i.day.started) {
    const asked = i.day.asks.some((a) => a.kind === 'start');
    if (asked) return { kind: 'start', level: 2, ask: null, reason: 'asked' };
    if (quiet) return { kind: 'start', level: 1, ask: null, reason: why };
    return { kind: 'start', level: 2, ask: 2, reason: 'ask' };
  }
  return none('not yet');
}

/**
 * The wrap-up time for one person: their own, or the office's moved towards their habit (median of
 * recent sends). Never more than an hour before the office's time, and never so late that the asks
 * lose their room: at least ten minutes for each ask a day before the register (30 for 3), unless
 * the office's own time is later than that, which is then the latest.
 */
export function effectiveWrapAt(office: string, own: string | null, recentSendMinutes: number[], digestAt: string, asks = 3): string {
  const base = minutesOf(office);
  const latest = Math.max(base, minutesOf(digestAt) - NUDGE_ROOM_PER_ASK_MIN * askLimit(asks));
  if (own) return hhmm(Math.min(minutesOf(own), latest));
  const list = recentSendMinutes.filter((m) => Number.isFinite(m)).sort((a, b) => a - b);
  if (list.length < 3) return hhmm(Math.min(base, latest));
  const median = list.length % 2 ? list[(list.length - 1) / 2] : (list[list.length / 2 - 1] + list[list.length / 2]) / 2;
  // ask a little before they usually send, in five-minute steps
  const habit = Math.round((median - 10) / 5) * 5;
  return hhmm(Math.max(base - 60, Math.min(habit, latest)));
}

// ---------------------------------------------------------------- permissions
export type SheetAccess = 'all' | 'given' | 'none';
/** Who may see whose day sheet (docs/NIB.md §9). "given": only the items the viewer gave. */
export function sheetAccess(viewer: { id: string; role: string }, ownerId: string, cfg: Pick<NibConfig, 'managers' | 'openSheets'>): SheetAccess {
  if (viewer.role === 'guest' || viewer.role === 'bot') return 'none';
  if (viewer.id === ownerId) return 'all';
  if (cfg.managers.includes(viewer.id)) return 'all';
  if (cfg.openSheets) return 'all';
  return 'given';
}
/** The items of a sheet a viewer may see. */
export function visibleItems<T extends Pick<NibItem, 'giverId'>>(viewer: { id: string; role: string }, ownerId: string, items: T[], cfg: Pick<NibConfig, 'managers' | 'openSheets'>): T[] {
  const a = sheetAccess(viewer, ownerId, cfg);
  return a === 'all' ? items : a === 'given' ? items.filter((x) => x.giverId === viewer.id) : [];
}

// ---------------------------------------------------------------- cards built from day sheets
export interface NibItemLite { id: string; activity: string; project: string | null; qty: NibQty | null; note: string | null; status: NibStatus; due: string | null; carried: boolean; giverId: string | null; giverName: string | null }
export const liteItem = (x: NibItem): NibItemLite => ({ id: x.id, activity: x.activity, project: x.project, qty: x.qty, note: x.note, status: x.status, due: x.due, carried: x.carried, giverId: x.giverId, giverName: x.giverName });

export interface UnitTotal { unit: string | null; done: number; total: number; count: number }
/** Totals by unit: numbers add up within a unit only ("54 of 90 sheets", "12 isos"). */
export function unitTotals(items: Array<Pick<NibItem, 'qty' | 'status'>>): UnitTotal[] {
  const by = new Map<string, UnitTotal>();
  for (const x of items) {
    if (!x.qty || x.qty.unit === '%') continue;
    const key = x.qty.unit ?? '';
    const t = by.get(key) ?? { unit: x.qty.unit, done: 0, total: 0, count: 0 };
    const total = x.qty.total ?? x.qty.done ?? 0;
    const done = x.qty.done ?? (x.status === 'done' ? total : 0);
    t.done += Math.max(0, done);
    t.total += Math.max(total, done);
    t.count++;
    by.set(key, t);
  }
  return [...by.values()].sort((a, b) => b.total - a.total);
}
/** How far along a set of items is, 0 to 1. Numbers where there are numbers, done items otherwise. */
export function progressOf(items: Array<Pick<NibItem, 'qty' | 'status'>>): number {
  if (!items.length) return 0;
  let sum = 0;
  for (const x of items) {
    if (x.status === 'done') { sum += 1; continue; }
    if (x.qty && (x.qty.total ?? 0) > 0) sum += Math.max(0, Math.min(1, (x.qty.done ?? 0) / (x.qty.total ?? 1)));
  }
  return Math.max(0, Math.min(1, sum / items.length));
}

export interface LeadRow {
  userId: string;
  sentAt: number | null;
  late: boolean;
  changed: boolean;
  seenAt: number | null;
  items: NibItemLite[];
  note: string | null;
  blockers: string | null;
}
export interface LeadCardView {
  date: string;
  giverId: string;
  rows: LeadRow[];
  /** Named this lead at the start of the day, not sent yet. */
  waiting: string[];
  totals: Array<{ project: string | null; units: UnitTotal[]; items: number }>;
}

export interface LeadCardInput {
  date: string;
  giverId: string;
  days: NibDay[];
  items: NibItem[];
  seen: Map<string, number>;
  /** Sheets sent after this are late (the register went out). */
  digestSentAt: number | null;
}
/** One lead's transmittal for a day: the people who sent work from them, and who they are waiting for. */
export function buildLeadCard(i: LeadCardInput): LeadCardView {
  const byUser = new Map(i.days.map((d) => [d.userId, d] as const));
  const mine = i.items.filter((x) => x.giverId === i.giverId && x.date === i.date);
  const people = [...new Set(mine.map((x) => x.userId))];
  const rows: LeadRow[] = [];
  for (const uid of people) {
    const d = byUser.get(uid);
    if (!d || d.state !== 'sent') continue;
    rows.push({
      userId: uid, sentAt: d.sentAt, late: !!(i.digestSentAt && d.sentAt && d.sentAt > i.digestSentAt), changed: !!d.changedAt,
      seenAt: i.seen.get(uid) ?? null, items: mine.filter((x) => x.userId === uid).map(liteItem), note: d.note, blockers: d.blockers,
    });
  }
  rows.sort((a, b) => (a.sentAt ?? 0) - (b.sentAt ?? 0));
  const waiting = i.days.filter((d) => d.date === i.date && d.state === 'open' && (d.givers.includes(i.giverId) || mine.some((x) => x.userId === d.userId))).map((d) => d.userId);
  const sentItems = mine.filter((x) => rows.some((r) => r.userId === x.userId));
  const projects = new Map<string, NibItem[]>();
  for (const x of sentItems) projects.set(x.project ?? '', [...(projects.get(x.project ?? '') ?? []), x]);
  const totals = [...projects].map(([p, list]) => ({ project: p || null, units: unitTotals(list), items: list.length })).sort((a, b) => b.items - a.items);
  return { date: i.date, giverId: i.giverId, rows, waiting: [...new Set(waiting)], totals };
}

// ---- the management's register
export type CellStatus = 'reported' | 'blocked' | 'nothing' | 'missing' | 'away' | 'leave';
export interface RegisterCell { userId: string; status: CellStatus; fill: number; items: number; late: boolean }
export interface RegisterGroup { id: string | null; name: string; cells: RegisterCell[]; reported: number; expected: number }
export interface RegisterProject { project: string | null; name: string | null; people: number; items: number; units: UnitTotal[]; progress: number }
export interface RegisterCallout { userId: string; project: string | null; text: string; kind: 'blocker' | 'stalled' | 'overdue' | 'givers' }
export interface NibRegister {
  kind: 'daily' | 'followup';
  date: string;
  generatedAt: number;
  headline: { roster: number; in: number; reported: number; nothing: number; missing: number; away: number; leave: number; blocked: number };
  groups: RegisterGroup[];
  units: UnitTotal[];
  projects: RegisterProject[];
  callouts: RegisterCallout[];
  leave: Array<{ userId: string; kind: NibLeaveKind; to: string; half: 'am' | 'pm' | null }>;
  missing: Array<{ userId: string; asks: number; busy: string | null; away: boolean }>;
  /** Follow-up: sheets sent after the register. */
  late: Array<{ userId: string; sentAt: number; items: NibItemLite[]; note: string | null; blockers: string | null }>;
}
export interface RegisterPerson { id: string; name: string; departmentId: string | null; departmentName: string | null }
export interface RegisterInput {
  kind: 'daily' | 'followup';
  date: string;
  now: number;
  /** Everyone who keeps a day sheet (exempt people left out). */
  people: RegisterPerson[];
  days: Map<string, NibDay>;
  items: NibItem[];
  leave: Map<string, Pick<NibLeave, 'kind' | 'to' | 'half'>>;
  /** Started their day log. */
  started: Set<string>;
  /** Asks per person today (shown to management). */
  asks: Map<string, number>;
  /** Why someone was not asked more ("in meetings all afternoon"). */
  busy?: Map<string, string>;
  projects: NibProject[];
  /** Daily: only sheets sent by now count. Follow-up: sheets sent after this are the late ones. */
  since?: number | null;
}

/** The register for a day: headline numbers, people by department, output, call-outs, leave and who is missing. */
export function buildRegister(i: RegisterInput): NibRegister {
  const itemsBy = new Map<string, NibItem[]>();
  for (const x of i.items) if (x.date === i.date) itemsBy.set(x.userId, [...(itemsBy.get(x.userId) ?? []), x]);
  const h = { roster: i.people.length, in: 0, reported: 0, nothing: 0, missing: 0, away: 0, leave: 0, blocked: 0 };
  const groups = new Map<string, RegisterGroup>();
  const missing: NibRegister['missing'] = [];
  const reportedItems: NibItem[] = [];
  const callouts: RegisterCallout[] = [];
  const late: NibRegister['late'] = [];
  const leave: NibRegister['leave'] = [];
  for (const p of i.people) {
    const d = i.days.get(p.id);
    const items = itemsBy.get(p.id) ?? [];
    const lv = i.leave.get(p.id);
    const started = i.started.has(p.id);
    if (started) h.in++;
    let status: CellStatus;
    const sent = d?.state === 'sent' && d.sentAt !== null && (i.kind === 'followup' || d.sentAt <= i.now);
    const isLate = i.kind === 'followup' && sent && i.since !== null && i.since !== undefined && (d?.sentAt ?? 0) > i.since;
    if (lv || d?.state === 'leave') {
      status = 'leave';
      h.leave++;
      leave.push({ userId: p.id, kind: lv?.kind ?? 'annual', to: lv?.to ?? i.date, half: lv?.half ?? null });
    } else if (sent) {
      const blocked = items.some((x) => x.status === 'blocked') || !!d?.blockers;
      status = blocked ? 'blocked' : 'reported';
      h.reported++;
      if (blocked) h.blocked++;
      reportedItems.push(...items);
      for (const x of items) {
        if (x.status === 'blocked') callouts.push({ userId: p.id, project: x.project, text: x.note ? `${x.activity}: ${x.note}` : x.activity, kind: 'blocker' });
        else if (x.due && x.due < i.date && x.status !== 'done') callouts.push({ userId: p.id, project: x.project, text: `${x.activity} was due ${x.due}`, kind: 'overdue' });
      }
      if (d?.blockers) callouts.push({ userId: p.id, project: null, text: d.blockers, kind: 'blocker' });
      const numbered = items.filter((x) => x.qty && (x.qty.total ?? 0) > 0 && x.qty.unit !== 'hours');
      if (numbered.length >= 2 && numbered.every((x) => (x.qty?.done ?? 0) === 0 && x.status !== 'done')) callouts.push({ userId: p.id, project: null, text: `No progress on ${numbered.length} numbered items`, kind: 'stalled' });
      const givers = new Set(items.map((x) => x.giverId ?? x.giverName).filter(Boolean));
      if (givers.size >= 4) callouts.push({ userId: p.id, project: null, text: `Work from ${givers.size} givers`, kind: 'givers' });
      if (isLate && d?.sentAt) late.push({ userId: p.id, sentAt: d.sentAt, items: items.map(liteItem), note: d.note, blockers: d.blockers });
    } else if (d?.state === 'nothing') {
      status = 'nothing';
      h.nothing++;
      h.reported++;
    } else if (started || d?.started || items.length) {
      status = 'missing';
      h.missing++;
      missing.push({ userId: p.id, asks: i.asks.get(p.id) ?? 0, busy: i.busy?.get(p.id) ?? null, away: false });
    } else {
      status = 'away';
      h.away++;
      missing.push({ userId: p.id, asks: i.asks.get(p.id) ?? 0, busy: i.busy?.get(p.id) ?? null, away: true });
    }
    const key = p.departmentId ?? '';
    const g = groups.get(key) ?? { id: p.departmentId, name: p.departmentName ?? 'Others', cells: [], reported: 0, expected: 0 };
    const fill = status === 'reported' || status === 'blocked' ? (items.length ? progressOf(items) : 1) : status === 'nothing' ? 1 : 0;
    g.cells.push({ userId: p.id, status, fill: Math.round(fill * 100) / 100, items: items.length, late: !!isLate });
    if (status !== 'leave') g.expected++;
    if (status === 'reported' || status === 'blocked' || status === 'nothing') g.reported++;
    groups.set(key, g);
  }
  const names = new Map(i.projects.map((p) => [p.code, p.name] as const));
  const byProject = new Map<string, NibItem[]>();
  for (const x of reportedItems) byProject.set(x.project ?? '', [...(byProject.get(x.project ?? '') ?? []), x]);
  const projects: RegisterProject[] = [...byProject].map(([code, list]) => ({
    project: code || null, name: code ? names.get(code) ?? null : null, people: new Set(list.map((x) => x.userId)).size, items: list.length,
    units: unitTotals(list), progress: Math.round(progressOf(list) * 100) / 100,
  })).sort((a, b) => (Number(!a.project) - Number(!b.project)) || b.items - a.items || b.people - a.people);
  const order: Record<RegisterCallout['kind'], number> = { blocker: 0, overdue: 1, stalled: 2, givers: 3 };
  callouts.sort((a, b) => order[a.kind] - order[b.kind]);
  missing.sort((a, b) => Number(a.away) - Number(b.away) || b.asks - a.asks);
  for (const g of groups.values()) g.cells.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  return {
    kind: i.kind, date: i.date, generatedAt: i.now, headline: h,
    groups: [...groups.values()].sort((a, b) => (a.id === null ? 1 : 0) - (b.id === null ? 1 : 0) || a.name.localeCompare(b.name)),
    units: unitTotals(reportedItems), projects, callouts, leave, missing, late: late.sort((a, b) => a.sentAt - b.sentAt),
  };
}
const STATUS_ORDER: Record<CellStatus, number> = { blocked: 0, reported: 1, nothing: 2, missing: 3, away: 4, leave: 5 };

// ---- the week
export interface NibWeek {
  from: string;
  to: string;
  dates: string[];
  /** Per date: reported against expected. */
  days: Array<{ date: string; reported: number; expected: number; leave: number }>;
  /** People by date: the cell status each day. */
  people: Array<{ userId: string; cells: Array<CellStatus | null> }>;
  /** Each job's week: units, and the main unit's done per day. */
  projects: Array<{ project: string | null; name: string | null; units: UnitTotal[]; perDay: number[]; unit: string | null }>;
}
/** A week from its daily registers (dates in order, missing days as null). */
export function buildWeek(dates: string[], registers: Array<NibRegister | null>, itemsByDate: Map<string, NibItem[]>, projects: NibProject[]): NibWeek {
  const people = new Map<string, Array<CellStatus | null>>();
  dates.forEach((_, di) => {
    const r = registers[di];
    if (!r) return;
    for (const g of r.groups) for (const c of g.cells) {
      const row = people.get(c.userId) ?? dates.map(() => null);
      row[di] = c.status;
      people.set(c.userId, row);
    }
  });
  const names = new Map(projects.map((p) => [p.code, p.name] as const));
  const all = new Map<string, Array<{ di: number; item: NibItem }>>();
  dates.forEach((d, di) => {
    const r = registers[di];
    const reported = new Set(r ? r.groups.flatMap((g) => g.cells.filter((c) => c.status === 'reported' || c.status === 'blocked').map((c) => c.userId)) : []);
    for (const x of itemsByDate.get(d) ?? []) if (reported.has(x.userId)) all.set(x.project ?? '', [...(all.get(x.project ?? '') ?? []), { di, item: x }]);
  });
  const proj = [...all].map(([code, list]) => {
    const units = unitTotals(list.map((l) => l.item));
    const unit = units[0]?.unit ?? null;
    const perDay = dates.map((_, di) => list.filter((l) => l.di === di && (l.item.qty?.unit ?? null) === unit).reduce((n, l) => n + (l.item.qty?.done ?? (l.item.status === 'done' ? l.item.qty?.total ?? 0 : 0)), 0));
    return { project: code || null, name: code ? names.get(code) ?? null : null, units, perDay, unit, n: list.length };
  }).sort((a, b) => (Number(!a.project) - Number(!b.project)) || b.n - a.n).map(({ n: _n, ...rest }) => rest);
  return {
    from: dates[0] ?? '', to: dates[dates.length - 1] ?? '', dates,
    days: dates.map((d, di) => {
      const r = registers[di];
      return { date: d, reported: r?.headline.reported ?? 0, expected: r ? r.headline.roster - r.headline.leave : 0, leave: r?.headline.leave ?? 0 };
    }),
    people: [...people].map(([userId, cells]) => ({ userId, cells })),
    projects: proj,
  };
}

/** "18 / 40 sheets", "12 isos", "40 %", "2.5 hours" (English; the app words it in the person's language). */
export function qtyText(q: NibQty | null): string {
  if (!q) return '';
  const n = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  const unit = q.unit === '%' ? '%' : q.unit ? ` ${q.unit}` : '';
  if (q.unit === '%') return `${n(q.done ?? 0)}%`;
  if (q.done !== null && q.total !== null) return `${n(q.done)} / ${n(q.total)}${unit}`;
  return `${n(q.total ?? q.done ?? 0)}${unit}`;
}

// ---------------------------------------------------------------- ops and events
export interface NibCardRef { kind: NibCardKind; ref: string }
export type NibCardKind = 'lead' | 'register' | 'followup' | 'week' | 'ask' | 'leave' | 'cover' | 'welcome' | 'joiner' | 'hello' | 'reply' | 'leaveSpace' | 'holidays' | 'holidaysDone' | 'knock';
export interface NibItemInput {
  id?: string;
  giverId?: string | null;
  giverName?: string | null;
  project?: string | null;
  activity?: string;
  qty?: NibQty | null;
  note?: string | null;
  status?: NibStatus;
  due?: string | null;
  source?: NibSource;
  messageId?: string | null;
  coverFor?: string | null;
}
export interface NibLeaveInput {
  kind: NibLeaveKind;
  from: string;
  to: string;
  half?: 'am' | 'pm' | null;
  coverId?: string | null;
  note?: string | null;
  handover?: string | null;
  leadIds?: string[];
  spaceIds?: string[];
  reminders?: 'move' | 'cover' | 'keep';
}
/** What the leave sheet shows before "Do it": suggested leads and Spaces, reminders due in the dates. */
export interface NibLeavePlan {
  leads: string[];
  spaces: Array<{ id: string; name: string }>;
  reminders: Array<{ id: string; text: string; dueAt: number }>;
}
export type NibCard =
  | { kind: 'lead'; lead: LeadCardView }
  | { kind: 'register' | 'followup'; register: NibRegister; sentAt: number }
  | { kind: 'week'; week: NibWeek }
  | { kind: 'ask'; date: string; userId: string; state: NibDayState; items: number }
  | { kind: 'leave' | 'leaveSpace'; leave: NibLeave }
  | { kind: 'cover'; leave: NibLeave; items: NibItemLite[]; taken: string[] }
  | { kind: 'welcome'; leave: NibLeave }
  | { kind: 'joiner'; userId: string; meet: string[] }
  | { kind: 'hello'; userId: string }
  | { kind: 'reply'; parse: NibParse; text: string; itemId: string | null; userId: string }
  /** A holiday circular Nib read (docs/HOLIDAYS.md), and the summary once it is registered. */
  | { kind: 'holidays' | 'holidaysDone'; view: HolidayReadView }
  /** Someone waiting in the lobby of a meeting you host (null: the hub no longer knows this knock, e.g. after a restart). */
  | { kind: 'knock'; knock: KnockView | null };
export interface NibSheetView { userId: string; date: string; day: NibDay | null; items: NibItem[]; access: SheetAccess }

export interface NibOps extends HolidayOps {
  'nib.me': { req: void; res: NibMe };
  /** The start card: who gave you work today (and optional first items). */
  'nib.start': { req: { givers: string[]; items?: NibItemInput[]; yesterday?: 'send' | 'skip' }; res: NibMe };
  'nib.item.save': { req: NibItemInput & { date?: string }; res: NibMe };
  'nib.item.delete': { req: { id: string }; res: NibMe };
  /** Send the day sheet to the leads (again after a change). */
  'nib.wrap': { req: { date?: string; note?: string | null; blockers?: string | null; items?: Array<{ id: string; done?: number | null; total?: number | null; status?: NibStatus; note?: string | null }> }; res: NibMe };
  /** Nothing today, a snooze, your own wrap-up time, or open the day again. */
  'nib.day': { req: { nothing?: boolean; reopen?: boolean; snoozeMinutes?: number; snoozeUntilFree?: boolean; wrapAt?: string | null; date?: string }; res: NibMe };
  'nib.card': { req: NibCardRef & { messageId?: string }; res: NibCard };
  /** A lead marks one person's sheet (or all of them) seen. */
  'nib.ack': { req: { date: string; userId?: string }; res: LeadCardView };
  'nib.sheet': { req: { userId: string; date: string }; res: NibSheetView };
  'nib.leave.plan': { req: { from: string; to: string }; res: NibLeavePlan };
  'nib.leave': { req: NibLeaveInput; res: { leave: NibLeave; done: string[] } };
  'nib.leave.cancel': { req: { id: string }; res: NibMe };
  /** Take an item of the person you cover onto your own sheet. */
  'nib.cover.take': { req: { leaveId: string; itemId: string }; res: NibMe };
  'nib.welcome.seen': { req: void; res: NibMe };
  'admin.nib.get': { req: void; res: NibConfig };
  'admin.nib.set': { req: Partial<NibConfig>; res: NibConfig };
  /** Post today's register to the administrator now, to check it. */
  'admin.nib.preview': { req: void; res: { ok: true } };
}
export interface NibEvents {
  'nib.me': NibMe;
  /** Cards about this date may have changed (lead cards fill in as sheets arrive). */
  'nib.changed': { date: string; kinds: NibCardKind[] };
}
