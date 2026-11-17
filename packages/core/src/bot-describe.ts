// "Describe your bot in words": plain words in, a draft bot out. The words are split into the
// bot's purpose ("a bot for plot requests"), the questions it asks, in order, and what happens at
// the end. What kind of question each clause is (a choice, a date, a number, a person, a file…)
// comes from keyword cues, blended with the on-device sentence model when the app has it loaded
// (the same Ranker as Describe-to-Automation). Lists in brackets or "A, B or C" become choices;
// Spaces are matched against the office's own. Nothing here saves anything: the result is a draft
// for a person to read, change and test-run, with notes on what it guessed.
import type { BotFlowAction, BotFlowDefinition, BotFlowInput, BotFlowStep, BotGlyph, BotPersona, BotTone } from './bots.ts';
import type { Ranker } from './flow-describe.ts';
import { validateFlow } from './botflow-engine.ts';
import { monogram, slugify } from './botmaker.ts';

export type StepKind = 'choice' | 'text' | 'long' | 'number' | 'date' | 'email' | 'person' | 'file' | 'confirm';
export type EndKind = 'task' | 'post' | 'remind';

export interface BotDraft {
  definition: BotFlowDefinition;
  /** For each step id: how sure the drafter is (0 to 1) and the words it came from. */
  steps: Record<string, { confidence: number; source: string }>;
  notes: string[];
  method: 'model' | 'keywords';
}

export interface BotDescribeContext {
  /** Spaces the person is in (a post can go there). */
  spaces: Array<{ id: string; name: string }>;
}

// ------------------------------------------------------------------ examples for the sentence model
export const STEP_EXAMPLES: Record<StepKind | `end:${EndKind}`, string[]> = {
  choice: ['which one of these options', 'pick the sheet size A0, A1 or A3', 'choose the discipline', 'what type of leave'],
  text: ['the job number', 'the drawing reference', 'the purpose of the visit', 'a short title'],
  long: ['describe the problem', 'the question in detail', 'any notes or comments', 'which drawings, one per line'],
  number: ['how many copies', 'the number of sets', 'how many people are going', 'quantity needed'],
  date: ['when do you need it', 'which day', 'the deadline', 'the date of the visit', 'from which date'],
  email: ['their email address', 'the client contact email'],
  person: ['who approves it', 'who is the checker', 'which colleague hosts the visit', 'their lead', 'who covers the work'],
  file: ['attach the drawing', 'upload a mark-up', 'add the PDF', 'attach the plot set'],
  confirm: ['confirm before sending', 'check the summary', 'ask if it is right before it goes'],
  'end:task': ['put a task on their desk', 'assign it to the approver', 'give them a task to do'],
  'end:post': ['post it in the space', 'announce it to the team', 'share it in the channel'],
  'end:remind': ['remind me later', 'set a reminder for me', 'remind me the day before'],
};

const CUES: Array<[StepKind | `end:${EndKind}`, RegExp]> = [
  ['end:remind', /\bremind(?:er)?\b/i],
  ['end:task', /\b(task|on (?:their|his|her|my|the|your) desk|assign(?: it)?|to-?do|for approval)\b/i],
  ['end:post', /\b(post|announce|share it|publish|let the .* know|tell the .* space)\b/i],
  ['confirm', /\b(confirm|double-?check|check (?:it|the summary)|before (?:it is )?sen[dt]|is (?:that|it) right)\b/i],
  ['file', /\b(attach|upload|file|pdf|mark-?up|photo|screenshot|scan)\b/i],
  ['person', /\b(who|whom|approver|checker|lead|manager|host|colleague|person|reviewer|engineer|cover)\b/i],
  ['email', /\b(e-?mail)\b/i],
  ['date', /\b(when|date|day|deadline|due|by when|from which|until|back on|needed by)\b/i],
  ['number', /\b(how many|number of|quantity|count|copies|sets|qty)\b/i],
  ['long', /\b(describe|details?|explain|question|notes?|comments?|one per line|problem|description)\b/i],
  ['choice', /\b(which (?:type|kind|size|discipline|site|media|option)|choose|pick|either|type of|kind of)\b/i],
];

const ENDS = new Set(['end:task', 'end:post', 'end:remind']);

// ------------------------------------------------------------------ small text tools
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const clean = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/[.;:!?]+$/, '');

/** "A0, A1 or A3" or "(Annual, Sick, Comp-off)": the options of a choice. */
export function listIn(clause: string): string[] {
  const br = /\(([^)]+)\)/.exec(clause);
  const raw = br ? br[1] : /:\s*([^:]+)$/.exec(clause)?.[1] ?? /\b(?:either|between|from)\s+(.+?(?:,| or ).+)$/i.exec(clause)?.[1] ?? /([\w&-]+(?:\s[\w&-]+)?(?:,\s*[\w&-]+(?:\s[\w&-]+)?)+,?\s+(?:or|and)\s+[\w&-]+(?:\s[\w&-]+)?)/.exec(clause)?.[1] ?? '';
  const parts = raw.split(/,|\bor\b|\band\b|\//i).map((x) => clean(x).replace(/^(the|a|an)\s+/i, '')).filter((x) => x && x.length <= 40);
  return [...new Set(parts)].length >= 2 ? [...new Set(parts)].slice(0, 12) : [];
}

/** Split the words into clauses, keeping bracketed lists whole. */
export function clausesOf(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  const flush = () => { const c = clean(cur); if (c) out.push(c); cur = ''; };
  const t = text.replace(/\r/g, '').replace(/\n+/g, '. ');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === '.' || ch === ';' || ch === '\n') && !/\d/.test(t[i + 1] ?? '')) { flush(); continue; }
    cur += ch;
  }
  flush();
  // "ask for X, Y and Z" and "then …" become separate clauses (lists that are options stay whole)
  const parts: string[] = [];
  for (const c of out) {
    const pieces = c.split(/\s*,?\s*\bthen\b\s*/i).flatMap((p) => {
      // an unbracketed list of options ("type of leave: annual, sick or comp-off") stays with its question
      if (/:\s*[^:]+,[^:]+$|\b(?:either|between)\b.+,/i.test(p) && listIn(p.replace(/\([^)]*\)/g, '')).length) return [p];
      const segs: string[] = [];
      let d = 0; let s = '';
      for (let i = 0; i < p.length; i++) {
        const ch = p[i];
        if (ch === '(') d++;
        if (ch === ')') d = Math.max(0, d - 1);
        if (d === 0 && ch === ',') { segs.push(s); s = ''; continue; }
        s += ch;
      }
      segs.push(s);
      return segs.flatMap((x) => x.split(/\s+\band\b\s+(?=(?:ask|then|put|post|remind|confirm|attach|who|when|which|how|what|the|a|an|their|its|send)\b)/i));
    });
    parts.push(...pieces.map(clean).filter(Boolean));
  }
  return parts;
}

/** The thing a clause asks about: "ask for the job number" → "job number". */
function subject(clause: string): string {
  return clean(clause)
    .replace(/\([^)]*\)/g, '')
    .replace(/^(?:and\s+|also\s+|then\s+|finally\s+|first\s+|next\s+)/i, '')
    .replace(/^(?:it\s+)?(?:should\s+|must\s+|will\s+|needs? to\s+|has to\s+)?(?:ask(?:s)?(?:\s+(?:for|about|me|them|people|the person))*|get|collect|find out|want(?:s)?(?:\s+to know)?|need(?:s)?|take|record|log|note)\s+/i, '')
    .replace(/^(?:for|about)\s+/i, '')
    .replace(/^(?:the|a|an|their|your|its)\s+/i, '')
    .replace(/:.*$/, '')
    .trim();
}

/** A label for summaries: two or three words, capitalised. */
function labelOf(sub: string, kind: StepKind): string {
  if (kind === 'person') {
    const roles: Array<[RegExp, string]> = [[/approv/i, 'Approver'], [/check/i, 'Checker'], [/host/i, 'Host'], [/cover/i, 'Cover'], [/chair/i, 'Chair'], [/review/i, 'Reviewer'], [/lead|manager/i, 'Lead']];
    const hit = roles.find(([re]) => re.test(sub));
    if (hit) return hit[1];
  }
  if (kind === 'date' && /^(when|which|what)\b/i.test(sub)) return /need|due|\bby\b/i.test(sub) ? 'Needed by' : /\bfrom\b|start/i.test(sub) ? 'From' : /back|until|end/i.test(sub) ? 'Until' : 'Date';
  const s = sub.replace(/^(?:which|what|who|when|how many|how much|whom)\s+(?:is|are|the|of)?\s*/i, '').replace(/\b(?:it is|they are|is|are|do you need|you need|they need|needed)\b.*$/i, '').trim();
  const w = s.split(/\s+/).filter((x) => !/^(the|a|an|of|for|to|it|them|their)$/i.test(x)).slice(0, 3).join(' ');
  if (w) return cap(w);
  return { choice: 'Choice', text: 'Answer', long: 'Details', number: 'Number', date: 'Date', email: 'Email', person: 'Person', file: 'File', confirm: 'Confirm' }[kind];
}

/** A question for the card, from what the clause asks about. */
function promptOf(clause: string, sub: string, kind: StepKind): string {
  const q = clean(clause).replace(/^(?:and\s+|then\s+|also\s+)/i, '').replace(/^(?:ask(?:s)?\s+(?:for\s+|about\s+)?)/i, '').replace(/\s*\([^)]*\)/g, '');
  // "when they are needed" → "When are they needed?"
  const inv = /^(when|where|how|what|which)\s+(they|it|you|we|he|she|this|that)\s+(are|is|do|does|will|can|should)\b\s*(.*)$/i.exec(q);
  if (inv) return `${cap(inv[1].toLowerCase())} ${inv[3].toLowerCase()} ${inv[2].toLowerCase()}${inv[4] ? ` ${inv[4]}` : ''}?`;
  if (/^(which|what|who|when|how|where|is|are|do|does|can)\b/i.test(q)) return cap(q).replace(/[.?]*$/, '?');
  const s = sub.replace(/\s*\([^)]*\)/g, '');
  switch (kind) {
    case 'number': return `How many ${s.replace(/^(?:number of|count of|quantity of)\s+/i, '')}?`;
    case 'date': return `${cap(s)}: which date?`;
    case 'person': return `Who is the ${s.replace(/^(?:who|the)\s+/i, '')}?`;
    case 'file': return `Attach the ${s.replace(/^(?:attach|upload|add)\s+(?:the\s+)?/i, '')}.`;
    case 'choice': return `Which ${s.replace(/^(?:which|choose|pick)\s+(?:the\s+)?/i, '')}?`;
    case 'email': return `What is the ${s}?`;
    default: return `What is the ${s}?`;
  }
}

function glyphFor(text: string): BotGlyph {
  const t = text.toLowerCase();
  const table: Array<[BotGlyph, RegExp]> = [
    ['plotter', /\bplot/], ['helmet', /\bsite\b|visit|ppe/], ['calendar', /leave|holiday|absence|book/], ['rfi', /\brfi\b|request for information|query/],
    ['stamp', /issue|transmittal|approve|approval/], ['flange', /piping|pipe|flange|valve/], ['beam', /structur|steel|beam/], ['level', /survey|level|setting out/],
    ['compass', /review|design|model/], ['clipboard', /check|punch|inspection|snag/], ['sheet', /drawing|sheet|revision/],
  ];
  return table.find(([, re]) => re.test(t))?.[0] ?? 'pin';
}

function toneFor(text: string): BotTone {
  if (/\b(friendly|warm|kind|cheerful|chatty)\b/i.test(text)) return 'warm';
  if (/\b(formal|polite|official|client)\b/i.test(text)) return 'formal';
  if (/\b(short|brief|quick|terse|to the point)\b/i.test(text)) return 'brief';
  return 'plain';
}

/** The bot's title, from "a bot for plot requests" / "a plot request bot" / the first words. */
function titleOf(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const m = /\b(?:a|an|my|our)?\s*bot\s+(?:for|to|that|which)\s+(?:handles?\s+|takes?\s+|logs?\s+|books?\s+|asks? for\s+)?([^.,;:]{3,50}?)(?=[.,;:]|\s+(?:it|that|which|ask|then)\b|$)/i.exec(t)
    ?? /\b(?:a|an|my|our)\s+([^.,;:]{3,40}?)\s+bot\b/i.exec(t);
  const raw = m ? m[1] : t.split(/[.,;:]/)[0].split(/\s+/).slice(0, 4).join(' ');
  const words = raw.replace(/^(?:the|a|an|people'?s?|members'?)\s+/i, '').split(/\s+/).slice(0, 5).join(' ');
  return cap(words.replace(/\b(requests)\b/i, 'request').replace(/\bbookings\b/i, 'booking')).slice(0, 60) || 'My bot';
}

// ------------------------------------------------------------------ the drafter
/** Rank one clause: keyword cues, blended with the sentence model when given. */
async function classify(clause: string, rank?: Ranker | null): Promise<{ kind: StepKind | `end:${EndKind}`; confidence: number } | null> {
  const kinds = Object.keys(STEP_EXAMPLES) as Array<StepKind | `end:${EndKind}`>;
  const kw = new Map<string, number>(kinds.map((k) => [k, 0]));
  CUES.forEach(([k, re], i) => { if (re.test(clause)) kw.set(k, Math.max(kw.get(k) ?? 0, 1 - i * 0.02)); });
  if (listIn(clause).length >= 2) kw.set('choice', Math.max(kw.get('choice') ?? 0, 0.97));
  // "attach" wins over "who"; "who" over "when"
  let sims: number[] | null = null;
  if (rank) { try { sims = await rank(clause, kinds.map((k) => ({ kind: k, examples: STEP_EXAMPLES[k] }))); } catch { sims = null; } }
  let best = 'text' as StepKind | `end:${EndKind}`;
  let score = -1;
  kinds.forEach((k, i) => {
    const s = (kw.get(k) ?? 0) * (sims ? 0.65 : 1) + (sims ? Math.max(0, sims[i]) * 0.35 : 0);
    if (s > score) { score = s; best = k; }
  });
  // nothing in the words points anywhere: a question only if it is worded as one
  if (score <= 0.05 || (![...kw.values()].some((v) => v > 0) && Math.max(...(sims ?? [0])) < 0.5)) {
    return /^(?:and\s+|then\s+)?(?:ask|which|what|who|when|how|where|the|a|an|their|its)\b/i.test(clause) ? { kind: 'text', confidence: 0.35 } : null;
  }
  return { kind: best, confidence: Math.max(0.3, Math.min(0.98, score)) };
}

function inputFor(kind: StepKind, clause: string): BotFlowInput {
  switch (kind) {
    case 'choice': {
      const opts = listIn(clause);
      return { kind: 'choice', options: (opts.length >= 2 ? opts : ['Option 1', 'Option 2']).map((o) => ({ value: o, label: cap(o) })) };
    }
    case 'long': return { kind: 'text', multiline: true };
    case 'number': return { kind: 'text', validate: { type: 'number', integer: true, min: 1 } };
    case 'date': return { kind: 'text', validate: { type: 'date', ...(/\b(need|due|by|deadline|visit|issue)/i.test(clause) ? { notBefore: 'today' } : {}) } };
    case 'email': return { kind: 'text', validate: { type: 'email' } };
    case 'person': return { kind: 'person' };
    case 'file': return { kind: 'file', ...(/\bif\b|optional|maybe/i.test(clause) ? { optional: true } : {}) };
    case 'confirm': return { kind: 'confirm' };
    default: return /job (?:number|no)/i.test(clause)
      ? { kind: 'text', placeholder: 'P-12513', validate: { type: 'regex', pattern: '[A-Za-z]{1,4}-?\\d{3,6}', message: 'Write the job number: letters then digits, like P-12513.' } }
      : { kind: 'text' };
  }
}

/** Plain words in, a draft bot out (valid as it stands; the notes say what was guessed). */
export async function draftBot(text: string, ctx: BotDescribeContext, rank?: Ranker | null): Promise<BotDraft> {
  const notes: string[] = [];
  const title = titleOf(text);
  const steps: BotFlowStep[] = [];
  const meta: BotDraft['steps'] = {};
  const ends: Array<{ kind: EndKind; clause: string }> = [];
  let ids = 0;
  const purpose = /\b(?:bot|assistant)\b/i;
  for (const clause of clausesOf(text)) {
    // the sentence that names the bot is not a question, nor are words about its voice or hours
    if (purpose.test(clause) && !/\bask|\?/.test(clause)) continue;
    if (/\b(friendly|formal|brief|tone|voice|office hours|working hours|remember)\b/i.test(clause) && !/\bask\b/i.test(clause)) continue;
    const hit = await classify(clause, rank);
    if (!hit) continue;
    const { kind, confidence } = hit;
    if (ENDS.has(kind)) { ends.push({ kind: kind.slice(4) as EndKind, clause }); continue; }
    const k = kind as StepKind;
    if (k === 'confirm' && steps.some((s) => s.input.kind === 'confirm')) continue;
    const sub = subject(clause);
    const id = k === 'confirm' ? 'confirm' : `q${++ids}`;
    const step: BotFlowStep = { id, prompt: k === 'confirm' ? 'Is this right?\n\n{{summary}}' : promptOf(clause, sub, k), input: inputFor(k, clause) };
    if (k !== 'confirm') step.label = labelOf(sub, k);
    steps.push(step);
    meta[id] = { confidence, source: clause };
    if (steps.length >= 20) break;
  }
  if (!steps.length) {
    steps.push({ id: 'q1', label: 'Request', prompt: 'What do you need?', input: { kind: 'text', multiline: true } });
    meta.q1 = { confidence: 0.2, source: text.slice(0, 80) };
    notes.push('No questions were found in the words, so it starts with one open question. Add the steps it should ask.');
  }
  // the confirmation goes last, and goes back to the start on "No"
  const ci = steps.findIndex((s) => s.input.kind === 'confirm');
  if (ci >= 0) {
    const [c] = steps.splice(ci, 1);
    c.input = { kind: 'confirm', yes: 'Send', no: 'Change something' };
    c.branches = [{ if: { equals: 'no' }, goto: steps[0].id }];
    steps.push(c);
  } else if (steps.length >= 3) {
    steps.push({ id: 'confirm', prompt: 'Is this right?\n\n{{summary}}', input: { kind: 'confirm', yes: 'Send', no: 'Change something' }, branches: [{ if: { equals: 'no' }, goto: steps[0].id }] });
    meta.confirm = { confidence: 0.5, source: '' };
    notes.push('A confirmation was added at the end, so people can check their answers before anything is sent.');
  }
  // labels must differ
  const seen = new Set<string>();
  for (const s of steps) { if (!s.label) continue; let l = s.label; let n = 2; while (seen.has(l.toLowerCase())) l = `${s.label} ${n++}`; s.label = l; seen.add(l.toLowerCase()); }

  const person = [...steps].reverse().find((s) => s.input.kind === 'person');
  const date = [...steps].reverse().find((s) => s.input.kind === 'text' && s.input.validate?.type === 'date');
  const summaryLine = `${title} from {{user}}: ${steps.filter((s) => s.input.kind !== 'confirm' && s.input.kind !== 'file').slice(0, 3).map((s) => `{{${s.id}}}`).join(', ')}`;
  const finish: BotFlowAction[] = [];
  for (const e of ends) {
    if (e.kind === 'task') {
      let who = person;
      if (!who) {
        who = { id: `q${++ids}`, label: 'Assignee', prompt: 'Who should do it?', input: { kind: 'person' } };
        steps.splice(steps[steps.length - 1]?.input.kind === 'confirm' ? steps.length - 1 : steps.length, 0, who);
        meta[who.id] = { confidence: 0.4, source: e.clause };
        notes.push('A task needs someone to do it, so it asks who.');
      }
      finish.push({ do: 'task', assignee: who.id, text: summaryLine, ...(date ? { due: date.id } : { dueInDays: 1 }) });
    } else if (e.kind === 'remind') {
      const days = /day before/i.test(e.clause) ? undefined : /\bweek\b/i.test(e.clause) ? 7 : /(\d+)\s*days?/i.exec(e.clause)?.[1];
      finish.push({ do: 'remind', text: `Follow up: ${title}`, ...(date && days === undefined ? { due: date.id } : { dueInDays: Number(days ?? 1) }) });
    } else {
      const sp = ctx.spaces.find((s) => new RegExp(`\\b${s.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(e.clause));
      finish.push({ do: 'post', to: sp ? `space:${sp.name}` : 'origin', text: `**${title}** from {{user}}\n\n{{summary}}` });
      if (!sp) notes.push('The post goes to the Space it is started from. Choose a Space at the end if it should always go to one.');
    }
  }
  if (!finish.length) {
    if (person) finish.push({ do: 'task', assignee: person.id, text: summaryLine, ...(date ? { due: date.id } : { dueInDays: 1 }) });
    else finish.push({ do: 'remind', text: `Follow up: ${title}`, ...(date ? { due: date.id } : { dueInDays: 1 }) });
    notes.push(person ? `At the end it puts a task on the Desk of the person chosen at “${person.label}”.` : 'At the end it puts a reminder on your Desk. Change this under “At the end”.');
  }

  const p: BotPersona = { mark: { kind: 'glyph', glyph: glyphFor(text) }, colour: 'teal', tone: toneFor(text), about: clean(text.split(/[.\n]/)[0]).slice(0, 200), remember: /\b(remember|same as last time|last time)\b/i.test(text) };
  if (/\b(office|working) hours\b/i.test(text)) p.hours = { days: [1, 2, 3, 4, 5], from: '09:00', to: '18:30' };
  if (p.mark.glyph === 'pin') p.mark = { kind: 'monogram', letters: monogram(title) };
  const definition = validateFlow({ name: slugify(title), title, persona: p, steps, finish, done: 'Thank you, {{user.first}}. It is on its way.' });
  const low = Object.entries(meta).filter(([, m]) => m.confidence < 0.5).map(([id]) => steps.find((s) => s.id === id)?.label ?? id);
  if (low.length) notes.push(`Check ${low.join(', ')}: the words did not say clearly what kind of answer it needs.`);
  return { definition, steps: meta, notes, method: rank ? 'model' : 'keywords' };
}
