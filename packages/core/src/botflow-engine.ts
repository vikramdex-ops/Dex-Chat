// The rules of a conversational flow: checking a definition, checking an answer, choosing the
// next step, and filling {{placeholders}}. Pure functions: the hub stores sessions and posts the
// cards; the same rules can be read here by anyone writing a flow.
import type { BotFlowAction, BotFlowAnswer, BotFlowBranch, BotFlowCondition, BotFlowDefinition, BotFlowInput, BotFlowOption, BotFlowStep, BotFlowValidate, BotHours, BotPersona, BotTone } from './bots.ts';
import { BOT_COLOURS, BOT_GLYPHS, BOT_TONES } from './bots.ts';
import { checkTrack } from './botflow-track.ts';

export class BotFlowError extends Error {}

export const BOTFLOW_NAME_RE = /^[a-z][a-z0-9-]{1,39}$/;
const STEP_ID_RE = /^[A-Za-z][\w-]{0,39}$/;
const MAX_STEPS = 50;
export const BOTFLOW_DEFAULT_DAYS = 7;
/** Words that answer a confirm step from the keyboard. */
const YES = /^(y|yes|ok|okay|confirm|send|go|sure)$/i;
const NO = /^(n|no|nope|not yet|change)$/i;

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max) : '');

function option(o: unknown, i: number, where: string): BotFlowOption {
  if (typeof o === 'string' && o.trim()) return { value: str(o, 120), label: str(o, 120) };
  if (o && typeof o === 'object') {
    const r = o as Record<string, unknown>;
    const value = str(r.value ?? r.label, 120);
    const label = str(r.label ?? r.value, 120);
    if (value && label) return { value, label };
  }
  throw new BotFlowError(`${where}: choice ${i + 1} needs a label.`);
}

function condition(c: unknown, where: string): BotFlowCondition {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new BotFlowError(`${where}: "if" must be an object such as {"equals": "A1"}.`);
  const r = c as Record<string, unknown>;
  const out: BotFlowCondition = {};
  if (r.var !== undefined) { out.var = str(r.var, 40); if (!STEP_ID_RE.test(out.var)) throw new BotFlowError(`${where}: "var" should name a variable.`); }
  for (const k of ['equals', 'notEquals', 'matches'] as const) if (r[k] !== undefined) out[k] = str(String(r[k]), 200);
  if (out.matches !== undefined) safeRegex(out.matches, where);
  if (r.in !== undefined) {
    if (!Array.isArray(r.in)) throw new BotFlowError(`${where}: "in" must be a list.`);
    out.in = r.in.slice(0, 50).map((x) => str(String(x), 120));
  }
  for (const k of ['gt', 'gte', 'lt', 'lte'] as const) {
    if (r[k] === undefined) continue;
    if (typeof r[k] !== 'number' || !Number.isFinite(r[k])) throw new BotFlowError(`${where}: "${k}" must be a number.`);
    out[k] = r[k] as number;
  }
  if (r.empty !== undefined) out.empty = r.empty === true;
  return out;
}

function safeRegex(pattern: string, where: string): RegExp {
  if (pattern.length > 200) throw new BotFlowError(`${where}: the pattern is longer than 200 characters.`);
  try { return new RegExp(`^(?:${pattern})$`, 'u'); } catch { throw new BotFlowError(`${where}: the pattern is not a valid regular expression.`); }
}

function validation(v: unknown, where: string): BotFlowValidate | undefined {
  if (v === undefined || v === null) return undefined;
  const r = (typeof v === 'string' ? { type: v } : v) as Record<string, unknown>;
  const type = r.type;
  if (type !== 'number' && type !== 'date' && type !== 'email' && type !== 'regex') throw new BotFlowError(`${where}: "validate" is number, date, email or regex.`);
  const out: BotFlowValidate = { type };
  for (const k of ['min', 'max'] as const) if (typeof r[k] === 'number' && Number.isFinite(r[k])) out[k] = r[k] as number;
  if (r.integer === true) out.integer = true;
  if (typeof r.notBefore === 'string') {
    out.notBefore = str(r.notBefore, 10);
    if (out.notBefore !== 'today' && !/^\d{4}-\d{2}-\d{2}$/.test(out.notBefore)) throw new BotFlowError(`${where}: "notBefore" is "today" or a date like 2026-11-30.`);
  }
  if (type === 'regex') {
    out.pattern = str(r.pattern, 200);
    if (!out.pattern) throw new BotFlowError(`${where}: a regex check needs a "pattern".`);
    safeRegex(out.pattern, where);
  }
  if (typeof r.message === 'string' && r.message.trim()) out.message = str(r.message, 200);
  return out;
}

/** Check an input description (also used for the cards integrations post with the session API). */
export function checkInput(v: unknown, where: string): BotFlowInput {
  if (!v || typeof v !== 'object') throw new BotFlowError(`${where}: give an "input" such as {"kind": "text"}.`);
  const r = v as Record<string, unknown>;
  const kinds = ['choice', 'text', 'person', 'file', 'confirm'];
  // shorthand: {"kind": "number"} means text checked as a number
  let kind = String(r.kind ?? '');
  let validate = r.validate;
  if (['number', 'date', 'email', 'regex'].includes(kind)) {
    const top = Object.fromEntries(['min', 'max', 'integer', 'notBefore', 'pattern', 'message'].filter((k) => r[k] !== undefined).map((k) => [k, r[k]]));
    validate = { ...top, ...(typeof validate === 'object' && validate ? validate : {}), type: kind };
    kind = 'text';
  }
  if (!kinds.includes(kind)) throw new BotFlowError(`${where}: the input kind is choice, text, number, date, email, regex, person, file or confirm.`);
  const out: BotFlowInput = { kind: kind as BotFlowInput['kind'] };
  if (kind === 'choice') {
    const opts = Array.isArray(r.options) ? r.options.slice(0, 20).map((o, i) => option(o, i, where)) : [];
    if (opts.length < 2) throw new BotFlowError(`${where}: a choice needs at least two options.`);
    if (new Set(opts.map((o) => o.value.toLowerCase())).size !== opts.length) throw new BotFlowError(`${where}: each option must be different.`);
    out.options = opts;
  }
  if (kind === 'text') {
    const val = validation(validate, where);
    if (val) out.validate = val;
    if (r.multiline === true) out.multiline = true;
  }
  if (kind === 'file' && Array.isArray(r.accept)) {
    out.accept = r.accept.slice(0, 20).map((x) => str(String(x), 12).toLowerCase()).filter((x) => /^\.[a-z0-9]{1,10}$/.test(x));
  }
  if (kind === 'confirm') {
    // left out: the bot's tone words them (Yes / No, Confirm / Amend…)
    const yes = str(r.yes, 40);
    const no = str(r.no, 40);
    if (yes) out.yes = yes;
    if (no) out.no = no;
  }
  if (typeof r.placeholder === 'string' && r.placeholder.trim()) out.placeholder = str(r.placeholder, 120);
  if (r.optional === true && kind !== 'confirm') out.optional = true;
  if ((kind === 'person' && r.suggest === 'lead') || (kind === 'text' && r.suggest === 'jobs')) out.suggest = r.suggest;
  if (kind === 'text' && Array.isArray(r.suggestions)) {
    const sug = [...new Set(r.suggestions.slice(0, 6).map((x) => str(String(x), 60)).filter(Boolean))];
    if (sug.length) out.suggestions = sug;
  }
  return out;
}

function action(a: unknown, i: number, saves: Map<string, BotFlowStep>): BotFlowAction {
  const where = `Finish action ${i + 1}`;
  if (!a || typeof a !== 'object') throw new BotFlowError(`${where} must be an object.`);
  const r = a as Record<string, unknown>;
  const personVar = (name: unknown, what: string): string => {
    const v = str(name, 40);
    const step = saves.get(v);
    if (!step || step.input.kind !== 'person') throw new BotFlowError(`${where}: "${what}" should name a step that picks a person.`);
    return v;
  };
  if (r.do === 'webhook') return { do: 'webhook' };
  if (r.do === 'post') {
    const to = str(r.to, 120);
    if (to !== 'origin' && !/^space:.+/.test(to) && !/^person:.+/.test(to)) throw new BotFlowError(`${where}: "to" is "origin", "space:<name>" or "person:<variable>".`);
    if (to.startsWith('person:')) personVar(to.slice(7), 'to');
    const text = str(r.text, 4000);
    if (!text) throw new BotFlowError(`${where}: give the "text" to post.`);
    return { do: 'post', to: to as 'origin', text };
  }
  if (r.do === 'task') {
    const assignee = personVar(r.assignee, 'assignee');
    const text = str(r.text, 500);
    if (!text) throw new BotFlowError(`${where}: give the task's "text".`);
    const out: BotFlowAction = { do: 'task', assignee, text };
    if (r.due !== undefined) {
      const due = str(r.due, 40);
      const step = saves.get(due);
      if (!step || step.input.kind !== 'text' || step.input.validate?.type !== 'date') throw new BotFlowError(`${where}: "due" should name a step that asks for a date.`);
      out.due = due;
    }
    if (typeof r.dueInDays === 'number' && Number.isFinite(r.dueInDays)) out.dueInDays = Math.max(0, Math.min(365, Math.round(r.dueInDays)));
    return out;
  }
  if (r.do === 'remind') {
    const text = str(r.text, 500);
    if (!text) throw new BotFlowError(`${where}: give the reminder's "text".`);
    const out: BotFlowAction = { do: 'remind', text };
    if (r.due !== undefined) {
      const due = str(r.due, 40);
      const step = saves.get(due);
      if (!step || step.input.kind !== 'text' || step.input.validate?.type !== 'date') throw new BotFlowError(`${where}: "due" should name a step that asks for a date.`);
      out.due = due;
    }
    if (typeof r.dueInDays === 'number' && Number.isFinite(r.dueInDays)) out.dueInDays = Math.max(0, Math.min(365, Math.round(r.dueInDays)));
    return out;
  }
  if (r.do === 'away') {
    const dateVar = (v: unknown, what: string): string => {
      const name = str(v, 40);
      const step = saves.get(name);
      if (!step || step.input.kind !== 'text' || step.input.validate?.type !== 'date') throw new BotFlowError(`${where}: "${what}" should name a step that asks for a date.`);
      return name;
    };
    const out: BotFlowAction = { do: 'away', from: dateVar(r.from, 'from') };
    if (r.to !== undefined) out.to = dateVar(r.to, 'to');
    if (r.cover !== undefined) out.cover = personVar(r.cover, 'cover');
    if (r.lead !== undefined) out.lead = personVar(r.lead, 'lead');
    for (const k of ['kind', 'note'] as const) {
      if (r[k] === undefined) continue;
      const name = str(r[k], 40);
      if (!saves.has(name)) throw new BotFlowError(`${where}: "${k}" should name a step.`);
      out[k] = name;
    }
    return out;
  }
  throw new BotFlowError(`${where}: "do" is post, task, remind, away or webhook.`);
}

/** Check and tidy a flow definition (from the Bot API or the Control room). */
export function validateFlow(raw: unknown, name?: string): BotFlowDefinition {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BotFlowError('A flow is a JSON object with a title and steps.');
  const r = raw as Record<string, unknown>;
  const n = str(name ?? r.name, 40).toLowerCase();
  if (!BOTFLOW_NAME_RE.test(n)) throw new BotFlowError('The flow name uses lower-case letters, digits and dashes (2 to 40), starting with a letter.');
  const title = str(r.title, 80);
  if (!title) throw new BotFlowError('Give the flow a "title".');
  if (!Array.isArray(r.steps) || !r.steps.length) throw new BotFlowError('Give the flow at least one step.');
  if (r.steps.length > MAX_STEPS) throw new BotFlowError(`A flow can have up to ${MAX_STEPS} steps.`);
  const ids = new Set<string>();
  const saves = new Map<string, BotFlowStep>();
  const steps: BotFlowStep[] = r.steps.map((s, i) => {
    const where = `Step ${i + 1}`;
    if (!s || typeof s !== 'object') throw new BotFlowError(`${where} must be an object.`);
    const x = s as Record<string, unknown>;
    const id = str(x.id, 40);
    if (!STEP_ID_RE.test(id)) throw new BotFlowError(`${where}: give it an "id" (letters, digits, _ and -).`);
    if (ids.has(id) || id === 'end') throw new BotFlowError(`${where}: the id "${id}" is used twice.`);
    ids.add(id);
    const prompt = str(x.prompt, 2000);
    if (!prompt) throw new BotFlowError(`Step "${id}": give it a "prompt".`);
    const step: BotFlowStep = { id, prompt, input: checkInput(x.input, `Step "${id}"`) };
    if (typeof x.label === 'string' && x.label.trim()) step.label = str(x.label, 60);
    if (x.save !== undefined) {
      const save = str(x.save, 40);
      if (!STEP_ID_RE.test(save)) throw new BotFlowError(`Step "${id}": "save" should be a variable name.`);
      step.save = save;
    }
    const key = step.save ?? id;
    if (saves.has(key)) throw new BotFlowError(`Step "${id}": the answer is saved as "${key}", which another step uses.`);
    saves.set(key, step);
    if (Array.isArray(x.branches)) {
      step.branches = x.branches.slice(0, 20).map((b, j): BotFlowBranch => {
        const br = (b ?? {}) as Record<string, unknown>;
        const out: BotFlowBranch = { if: condition(br.if, `Step "${id}", branch ${j + 1}`), goto: str(br.goto, 40) };
        if (br.set && typeof br.set === 'object') out.set = Object.fromEntries(Object.entries(br.set as Record<string, unknown>).slice(0, 20).map(([k, v]) => [str(k, 40), str(String(v), 200)]).filter(([k]) => STEP_ID_RE.test(k)));
        return out;
      });
    } else if (x.branches !== undefined) throw new BotFlowError(`Step "${id}": "branches" must be a list.`);
    if (x.next !== undefined) step.next = str(x.next, 40);
    return step;
  });
  for (const s of steps) {
    for (const t of [...(s.branches ?? []).map((b) => b.goto), ...(s.next !== undefined ? [s.next] : [])]) {
      if (t !== 'end' && !ids.has(t)) throw new BotFlowError(`Step "${s.id}" goes to "${t}", which is not a step.`);
    }
  }
  if (!Array.isArray(r.finish)) throw new BotFlowError('Say what happens at the end in "finish" (post, webhook or task).');
  const finish = r.finish.slice(0, 10).map((a, i) => action(a, i, saves));
  const def: BotFlowDefinition = { name: n, title, steps, finish };
  if (typeof r.description === 'string' && r.description.trim()) def.description = str(r.description, 300);
  if (r.command !== undefined && r.command !== null && r.command !== '') {
    const c = str(r.command, 24).replace(/^\//, '').toLowerCase();
    if (!/^[a-z][a-z0-9-]{1,23}$/.test(c)) throw new BotFlowError('The command uses letters, digits and dashes, e.g. "plot".');
    def.command = c;
  }
  if (Array.isArray(r.keywords)) def.keywords = r.keywords.slice(0, 20).map((k) => str(String(k), 40).toLowerCase()).filter(Boolean);
  if (r.expiresInDays !== undefined) {
    if (typeof r.expiresInDays !== 'number' || !(r.expiresInDays > 0)) throw new BotFlowError('"expiresInDays" is a number of days.');
    def.expiresInDays = Math.min(90, r.expiresInDays);
  }
  if (r.vars && typeof r.vars === 'object') def.vars = Object.fromEntries(Object.entries(r.vars as Record<string, unknown>).slice(0, 40).map(([k, v]) => [str(k, 40), str(String(v), 500)]).filter(([k]) => STEP_ID_RE.test(k)));
  if (typeof r.done === 'string' && r.done.trim()) def.done = str(r.done, 2000);
  if (r.persona !== undefined && r.persona !== null) def.persona = checkPersona(r.persona);
  if (r.track !== undefined && r.track !== null) def.track = checkTrack(r.track, saves);
  return def;
}

const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Check a bot's identity: its mark, colour, voice, hours and greeting. */
export function checkPersona(v: unknown): BotPersona {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new BotFlowError('"persona" is an object with a mark, a colour and a tone.');
  const r = v as Record<string, unknown>;
  const m = (r.mark ?? {}) as Record<string, unknown>;
  const kind = m.kind === 'glyph' ? 'glyph' : 'monogram';
  const mark: BotPersona['mark'] = { kind };
  if (kind === 'glyph') {
    if (!BOT_GLYPHS.includes(m.glyph as never)) throw new BotFlowError(`The mark's symbol is one of: ${BOT_GLYPHS.join(', ')}.`);
    mark.glyph = m.glyph as BotPersona['mark']['glyph'];
  } else {
    const letters = str(m.letters, 4).replace(/\s+/g, '').toUpperCase().slice(0, 2);
    if (!letters) throw new BotFlowError('Give the monogram one or two letters.');
    mark.letters = letters;
  }
  const colour = typeof r.colour === 'string' && r.colour in BOT_COLOURS ? r.colour as BotPersona['colour'] : 'teal';
  const tone: BotTone = BOT_TONES.includes(r.tone as BotTone) ? r.tone as BotTone : 'plain';
  const out: BotPersona = { mark, colour, tone };
  if (typeof r.about === 'string' && r.about.trim()) out.about = str(r.about, 200);
  if (typeof r.greeting === 'string' && r.greeting.trim()) out.greeting = str(r.greeting, 400);
  if (r.remember === true) out.remember = true;
  if (r.hours !== undefined && r.hours !== null) {
    const h = r.hours as Record<string, unknown>;
    const days = Array.isArray(h.days) ? [...new Set(h.days.filter((d): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6))].sort() : [];
    const from = str(h.from, 5);
    const to = str(h.to, 5);
    if (!days.length) throw new BotFlowError('Choose at least one day it is open.');
    if (!HM_RE.test(from) || !HM_RE.test(to)) throw new BotFlowError('Opening hours are times like 09:00 and 18:00.');
    if (to <= from) throw new BotFlowError('It must close after it opens.');
    out.hours = { days, from, to };
  }
  return out;
}

// ---------------------------------------------------------------- opening hours
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hmOf = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** Is the bot open at this moment (the hub's local time)? Always, without hours. */
export function withinHours(hours: BotHours | null | undefined, ts: number): boolean {
  if (!hours) return true;
  const d = new Date(ts);
  const t = hmOf(d);
  return hours.days.includes(d.getDay()) && t >= hours.from && t < hours.to;
}

/** "Mon–Fri 09:00–18:00", or the days listed. */
export function hoursText(hours: BotHours): string {
  const ds = [...hours.days].sort();
  const run = ds.length > 2 && ds.every((d, i) => i === 0 || d === ds[i - 1] + 1);
  const days = ds.length === 7 ? 'Every day' : run ? `${DAY_SHORT[ds[0]]}–${DAY_SHORT[ds[ds.length - 1]]}` : ds.map((d) => DAY_SHORT[d]).join(', ');
  return `${days} ${hours.from}–${hours.to}`;
}

/** When it next opens: "09:00 today", "09:00 Mon". */
export function nextOpening(hours: BotHours, ts: number): string {
  for (let i = 0; i < 8; i++) {
    const d = new Date(ts);
    d.setDate(d.getDate() + i);
    if (!hours.days.includes(d.getDay())) continue;
    if (i === 0 && hmOf(new Date(ts)) >= hours.from) continue;
    return `${hours.from} ${i === 0 ? 'today' : i === 1 ? 'tomorrow' : DAY_SHORT[d.getDay()]}`;
  }
  return hours.from;
}

// ---------------------------------------------------------------- voice
/** The phrases a bot says itself, in each tone. The author's own questions are never changed. */
export interface Voice {
  greeting: (first: string, title: string) => string;
  done: string;
  cancelled: string;
  sameAsLast: (label: string) => string;
  closed: (title: string, hours: string, next: string) => string;
  menu: (name: string) => string;
  writeFirst: string;
  chooseOne: string;
  choosePerson: string;
  attach: string;
  oneOf: (list: string) => string;
  yesNo: (yes: string, no: string) => string;
  yes: string;
  no: string;
  typedHint: string;
}

const VOICES: Record<BotTone, Voice> = {
  plain: {
    greeting: (first, title) => `Hello ${first}. This is ${title}.`,
    done: 'Done. Thank you.',
    cancelled: 'Cancelled. Nothing was sent.',
    sameAsLast: (l) => `Same as last time: ${l}`,
    closed: (t, h, n) => `${t} takes requests ${h}. It opens again at ${n}.`,
    menu: (n) => `Here is what ${n} can do. Choose one, or write its name.`,
    writeFirst: 'Write an answer first.', chooseOne: 'Choose one of the options.', choosePerson: 'Choose a person.', attach: 'Attach a file.',
    oneOf: (l) => `Choose one of: ${l}.`, yesNo: (y, n) => `Answer ${y} or ${n}.`, yes: 'Yes', no: 'No',
    typedHint: '(Write "cancel" to stop, or "back" for the step before.)',
  },
  warm: {
    greeting: (first, title) => `Hi ${first}! ${title} here. This only takes a minute.`,
    done: 'All done. Thanks, that really helps.',
    cancelled: 'No problem, I have stopped. Nothing was sent.',
    sameAsLast: (l) => `Same as last time? ${l}`,
    closed: (t, h, n) => `Sorry, ${t} is closed just now. I am here ${h}, back at ${n}.`,
    menu: (n) => `Hi! ${n} can help with these. Pick one, or just write its name.`,
    writeFirst: 'Could you write an answer first?', chooseOne: 'Pick one of the options, please.', choosePerson: 'Who should it be? Pick a person.', attach: 'Could you attach the file?',
    oneOf: (l) => `Could you pick one of these: ${l}?`, yesNo: (y, n) => `Just answer ${y} or ${n}.`, yes: 'Yes, please', no: 'Not yet',
    typedHint: '(Write "cancel" to stop, or "back" to go back a step.)',
  },
  brief: {
    greeting: (first) => `${first}: quick questions.`,
    done: 'Done.',
    cancelled: 'Cancelled.',
    sameAsLast: (l) => `Again: ${l}`,
    closed: (_t, h, n) => `Closed. Open ${h}; next ${n}.`,
    menu: () => 'Choose one.',
    writeFirst: 'Answer needed.', chooseOne: 'Choose one.', choosePerson: 'Choose a person.', attach: 'Attach a file.',
    oneOf: (l) => `One of: ${l}.`, yesNo: (y, n) => `${y} or ${n}.`, yes: 'Yes', no: 'No',
    typedHint: '("cancel" stops, "back" goes back.)',
  },
  formal: {
    greeting: (first, title) => `Good day, ${first}. ${title} will take your request.`,
    done: 'Your request has been received. Thank you.',
    cancelled: 'The request has been withdrawn. Nothing was sent.',
    sameAsLast: (l) => `As on your last request: ${l}`,
    closed: (t, h, n) => `${t} accepts requests ${h}. Please return at ${n}.`,
    menu: (n) => `${n} can assist with the following. Please choose one, or write its name.`,
    writeFirst: 'Please provide an answer.', chooseOne: 'Please select one of the options.', choosePerson: 'Please select a person.', attach: 'Please attach the file.',
    oneOf: (l) => `Please select one of: ${l}.`, yesNo: (y, n) => `Please answer ${y} or ${n}.`, yes: 'Confirm', no: 'Amend',
    typedHint: '(Write "cancel" to withdraw, or "back" for the previous step.)',
  },
};

/** The phrasebook for a tone (plain when left out). */
export const voiceOf = (tone: BotTone | undefined | null): Voice => VOICES[tone ?? 'plain'] ?? VOICES.plain;

/** The first name people go by ("Priya" from "Priya Raman"). */
export const firstName = (name: string): string => name.trim().split(/\s+/)[0] || name;

// ---------------------------------------------------------------- answers
export interface AnswerContext {
  now: number;
  /** A person by id, account or unique name (for typed answers); null when no one matches. */
  person: (v: string) => { id: string; name: string } | null;
  /** A file the person may give (uploaded by them); null otherwise. */
  file: (id: string) => { id: string; name: string } | null;
  /** The bot's tone, for its own refusals. */
  tone?: BotTone;
}

/** YYYY-MM-DD for a moment, in the hub's local time. */
export function localDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function realDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]);
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[A-Za-z]{2,24}$/;

/** Check one answer to a step; returns what is kept, or throws a BotFlowError worded for the person. */
export function checkAnswer(step: BotFlowStep, raw: string, ctx: AnswerContext): BotFlowAnswer {
  const inp = step.input;
  const voice = voiceOf(ctx.tone);
  const v = str(raw, inp.multiline ? 4000 : 500);
  if (!v) {
    if (inp.optional) return { value: '', label: 'None' };
    throw new BotFlowError(inp.kind === 'choice' ? voice.chooseOne : inp.kind === 'person' ? voice.choosePerson : inp.kind === 'file' ? voice.attach : voice.writeFirst);
  }
  switch (inp.kind) {
    case 'choice': {
      const o = (inp.options ?? []).find((x) => x.value === v) ?? (inp.options ?? []).find((x) => x.value.toLowerCase() === v.toLowerCase() || x.label.toLowerCase() === v.toLowerCase());
      if (!o) throw new BotFlowError(voice.oneOf((inp.options ?? []).map((x) => x.label).join(', ')));
      return { value: o.value, label: o.label };
    }
    case 'confirm': {
      const yes = inp.yes ?? voice.yes;
      const no = inp.no ?? voice.no;
      if (v === 'yes' || YES.test(v) || v === yes) return { value: 'yes', label: yes };
      if (v === 'no' || NO.test(v) || v === no) return { value: 'no', label: no };
      throw new BotFlowError(voice.yesNo(yes, no));
    }
    case 'person': {
      const p = ctx.person(v);
      if (!p) throw new BotFlowError('No one in the office matches that. Choose a person from the list.');
      return { value: p.id, label: p.name };
    }
    case 'file': {
      const f = ctx.file(v);
      if (!f) throw new BotFlowError('Attach the file again: it was not found.');
      if (inp.accept?.length && !inp.accept.some((ext) => f.name.toLowerCase().endsWith(ext))) throw new BotFlowError(`Attach a ${inp.accept.join(', ')} file.`);
      return { value: f.id, label: f.name };
    }
    case 'text': {
      const val = inp.validate;
      if (!val) return { value: v, label: v };
      const fail = (fallback: string): never => { throw new BotFlowError(val.message ?? fallback); };
      if (val.type === 'number') {
        const t = v.replace(/,/g, '');
        if (!/^-?\d+(\.\d+)?$/.test(t)) fail('Write a number, for example 12 or 2.5.');
        const n = Number(t);
        if (val.integer && !Number.isInteger(n)) fail('Write a whole number.');
        if (val.min !== undefined && n < val.min) fail(`Write a number of at least ${val.min}.`);
        if (val.max !== undefined && n > val.max) fail(`Write a number of at most ${val.max}.`);
        return { value: String(n), label: String(n) };
      }
      if (val.type === 'date') {
        if (!realDate(v)) fail('Choose a date (YYYY-MM-DD).');
        const floor = val.notBefore === 'today' ? localDate(ctx.now) : val.notBefore;
        if (floor && v < floor) fail(val.notBefore === 'today' ? 'Choose today or a later date.' : `Choose ${floor} or later.`);
        const [y, m, d] = v.split('-').map(Number);
        return { value: v, label: new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) };
      }
      if (val.type === 'email') {
        if (!EMAIL_RE.test(v)) fail('Write an email address, like name@example.com.');
        return { value: v.toLowerCase(), label: v.toLowerCase() };
      }
      if (!safeRegex(val.pattern ?? '', 'pattern').test(v)) fail('That answer is not in the expected form.');
      return { value: v, label: v };
    }
  }
}

// ---------------------------------------------------------------- moving through a flow
export type BotFlowVars = Record<string, BotFlowAnswer>;

/** Starting variables: the flow's own, then who is answering. */
export function startVars(def: BotFlowDefinition, user: { id: string; name: string; account: string }): BotFlowVars {
  const vars: BotFlowVars = {};
  for (const [k, v] of Object.entries(def.vars ?? {})) vars[k] = { value: v, label: v };
  vars['user'] = { value: user.id, label: user.name };
  vars['user.first'] = { value: firstName(user.name), label: firstName(user.name) };
  vars['user.account'] = { value: user.account, label: user.account };
  return vars;
}

export function testCondition(c: BotFlowCondition, answer: BotFlowAnswer | undefined): boolean {
  const v = answer?.value ?? '';
  const lower = v.toLowerCase();
  if (c.equals !== undefined && lower !== c.equals.toLowerCase() && (answer?.label ?? '').toLowerCase() !== c.equals.toLowerCase()) return false;
  if (c.notEquals !== undefined && (lower === c.notEquals.toLowerCase() || (answer?.label ?? '').toLowerCase() === c.notEquals.toLowerCase())) return false;
  if (c.in !== undefined && !c.in.some((x) => x.toLowerCase() === lower)) return false;
  if (c.matches !== undefined && !new RegExp(`^(?:${c.matches})$`, 'iu').test(v)) return false;
  const n = Number(v);
  const numeric = v !== '' && Number.isFinite(n);
  if (c.gt !== undefined && !(numeric && n > c.gt)) return false;
  if (c.gte !== undefined && !(numeric && n >= c.gte)) return false;
  if (c.lt !== undefined && !(numeric && n < c.lt)) return false;
  if (c.lte !== undefined && !(numeric && n <= c.lte)) return false;
  if (c.empty !== undefined && (v === '') !== c.empty) return false;
  return true;
}

export const stepById = (def: BotFlowDefinition, id: string | null | undefined): BotFlowStep | undefined => def.steps.find((s) => s.id === id);
export const saveKey = (s: BotFlowStep): string => s.save ?? s.id;

/** Where to go after a step, given the variables (with its answer already in them). */
export function nextAfter(def: BotFlowDefinition, step: BotFlowStep, vars: BotFlowVars): { goto: string; set: Record<string, string> } {
  for (const b of step.branches ?? []) {
    if (testCondition(b.if, vars[b.if.var ?? saveKey(step)])) return { goto: b.goto, set: b.set ?? {} };
  }
  if (step.next !== undefined) return { goto: step.next, set: {} };
  const i = def.steps.indexOf(step);
  return { goto: def.steps[i + 1]?.id ?? 'end', set: {} };
}

/**
 * The steps still ahead, from (and including) `from`, following the answers already known (a
 * step answered earlier, then left with Back, still counts). Unknown answers follow the default
 * route. Used for "step 3 of 5".
 */
export function remainingPath(def: BotFlowDefinition, from: string, vars: BotFlowVars): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = from;
  while (cur && cur !== 'end' && !seen.has(cur) && out.length < MAX_STEPS) {
    seen.add(cur);
    out.push(cur);
    const step = stepById(def, cur);
    if (!step) break;
    const known = vars[saveKey(step)];
    if (known) cur = nextAfter(def, step, vars).goto;
    else cur = step.next ?? def.steps[def.steps.indexOf(step) + 1]?.id;
  }
  return out;
}

/** Where a run stands: "step 3 of 5" (the total follows the answers given so far). */
export function flowPosition(def: BotFlowDefinition, step: string | null, history: string[], known: BotFlowVars): { stepNo: number; stepCount: number } {
  const all = remainingPath(def, def.steps[0].id, known);
  const at = step ? all.indexOf(step) : -1;
  if (at >= 0) return { stepNo: at + 1, stepCount: all.length };
  const ahead = step ? remainingPath(def, step, known).length : 0;
  const done = new Set(history).size;
  return { stepNo: done + 1, stepCount: done + Math.max(1, ahead) };
}

/** Variables that hold who is answering, not an answer (left out of webhooks and memory). */
export const isUserVar = (k: string): boolean => k === 'user' || k.startsWith('user.');

// ---------------------------------------------------------------- text
/** The answers in the order they were given, as label lines. */
export function summaryLines(def: BotFlowDefinition, history: string[], vars: BotFlowVars): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  // a step answered twice (Change something, then round again) shows once, where it was last answered
  const order = history.filter((id, i) => history.lastIndexOf(id) === i);
  for (const id of order) {
    const s = stepById(def, id);
    if (!s || s.input.kind === 'confirm') continue;
    const a = vars[saveKey(s)];
    if (a) out.push({ label: s.label ?? s.id, value: a.label || '—' });
  }
  return out;
}

/** Fill {{name}}, {{name.value}}, {{summary}} and {{flow.title}} in a prompt or message. */
export function renderTemplate(text: string, vars: BotFlowVars, extra: { summary?: string; title?: string } = {}): string {
  return text.replace(/\{\{\s*([A-Za-z][\w.-]{0,60})\s*\}\}/g, (_m, key: string) => {
    if (key === 'summary') return extra.summary ?? '';
    if (key === 'botflow.title') return extra.title ?? '';
    if (vars[key]) return vars[key].label;
    if (key.endsWith('.value') && vars[key.slice(0, -6)]) return vars[key.slice(0, -6)].value;
    if (key.endsWith('.label') && vars[key.slice(0, -6)]) return vars[key.slice(0, -6)].label;
    return '';
  });
}


// ---------------------------------------------------------------- one step as a card
/** A run as the card rules need it (the hub's session, or the bot maker's test run). */
export interface RunLike {
  step: string | null;
  history: string[];
  answers: Record<string, BotFlowAnswer>;
  /** Starting variables and those set by branches. */
  vars: BotFlowVars;
}

/** Starting variables plus the answers on the route actually taken (Back leaves answers that no longer count). */
export function effectiveVars(def: BotFlowDefinition, run: RunLike): BotFlowVars {
  const vars = { ...run.vars };
  for (const id of run.history) {
    const step = stepById(def, id);
    const key = step ? saveKey(step) : id;
    if (run.answers[key]) vars[key] = run.answers[key];
  }
  return vars;
}

export const summaryText = (lines: Array<{ label: string; value: string }>): string => lines.map((l) => `- **${l.label}:** ${l.value.replace(/\n+/g, '; ')}`).join('\n');

export interface StepCardData {
  title: string;
  stepNo: number;
  stepCount: number;
  prompt: string;
  input: BotFlowInput;
  previous: BotFlowAnswer | null;
  canBack: boolean;
  persona?: Pick<BotPersona, 'mark' | 'colour'>;
  intro?: string;
  lastTime?: BotFlowAnswer;
  lastTimeWords?: string;
  suggested?: BotFlowAnswer;
  suggestedWhy?: 'lead';
}

/**
 * What the card for the current step shows, the same for a real run and a test run: the
 * question with its placeholders filled, the position, the earlier answer after Back, the
 * greeting on a fresh start, and last time's answer when the bot remembers.
 */
export function stepCard(def: BotFlowDefinition, run: RunLike, opts: { fresh?: boolean; lastTime?: BotFlowAnswer | null; suggested?: BotFlowAnswer | null; jobs?: string[] } = {}): StepCardData {
  const step = stepById(def, run.step);
  if (!step) throw new BotFlowError('This flow changed while you were in it. Start it again.');
  const vars = effectiveVars(def, run);
  const lines = summaryLines(def, run.history, vars);
  const { stepNo, stepCount } = flowPosition(def, step.id, run.history, { ...run.vars, ...run.answers });
  const voice = voiceOf(def.persona?.tone);
  const prompt = renderTemplate(step.prompt, vars, { summary: summaryText(lines), title: def.title });
  let input: BotFlowInput = step.input.kind === 'confirm' ? { ...step.input, yes: step.input.yes ?? voice.yes, no: step.input.no ?? voice.no } : step.input;
  // job numbers from the person's own Spaces, ahead of the author's quick replies
  if (step.input.suggest === 'jobs' && opts.jobs?.length) input = { ...input, suggestions: [...new Set([...opts.jobs, ...(input.suggestions ?? [])])].slice(0, 6) };
  const previous = step.input.kind !== 'confirm' ? run.answers[saveKey(step)] ?? null : null;
  const out: StepCardData = { title: def.title, stepNo, stepCount, prompt, input, previous, canBack: run.history.length > 0 };
  if (def.persona) out.persona = { mark: def.persona.mark, colour: def.persona.colour };
  if (opts.fresh && !run.history.length && def.persona) {
    out.intro = renderTemplate(def.persona.greeting ?? voice.greeting('{{user.first}}', def.title), vars, { title: def.title });
  }
  if (opts.lastTime && !previous && step.input.kind !== 'confirm' && step.input.kind !== 'file') {
    out.lastTime = opts.lastTime;
    out.lastTimeWords = voice.sameAsLast(opts.lastTime.label);
  }
  // the lead from the directory, unless last time's answer already offers the same person
  if (opts.suggested && step.input.suggest === 'lead' && !previous && out.lastTime?.value !== opts.suggested.value) {
    out.suggested = opts.suggested;
    out.suggestedWhy = 'lead';
  }
  return out;
}

/** The closing line, in the bot's words when the author left it out. */
export const doneLine = (def: BotFlowDefinition, vars: BotFlowVars, summary: string): string =>
  renderTemplate(def.done ?? voiceOf(def.persona?.tone).done, vars, { summary, title: def.title });

/** Steps whose answers a bot may remember for next time (not confirmations, files or long text). */
export const rememberable = (s: BotFlowStep): boolean => s.input.kind === 'choice' || s.input.kind === 'person' || (s.input.kind === 'text' && !s.input.multiline && s.input.validate?.type !== 'date');
