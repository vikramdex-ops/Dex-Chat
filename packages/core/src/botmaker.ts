// The bot maker's own rules, shared by the app (the editor and its test run) and the hub's tests:
// templates that suit a design office, a fresh blank bot, short names, and a test run that walks
// through a bot exactly as a colleague would (the same cards, checks and wording as the hub), with
// nothing sent at the end.
import type { BotFlowAction, BotFlowAnswer, BotFlowCard, BotFlowDefinition, BotFlowStep, BotGlyph, BotItem, BotPersona } from './bots.ts';
import { BotFlowError, checkAnswer, checkInput, doneLine, validateFlow, effectiveVars, nextAfter, renderTemplate, saveKey, startVars, stepById, stepCard, summaryLines, summaryText, voiceOf } from './botflow-engine.ts';
import type { AnswerContext, BotFlowVars, RunLike } from './botflow-engine.ts';
import { mainWay, personAnswer, stageOf, trackAct, trackOpen, trackTick, trackView, trackWithdraw } from './botflow-track.ts';
import type { TrackPeople } from './botflow-track.ts';
import { DRAWING_CHECK, FRIDAY_TIMESHEET, LATE_WORK, PLOT_REQUEST, SITE_VISIT, SOFTWARE_SEAT, TECHNICAL_QUERY, TQ_CHASER } from './bot-templates.ts';

// ---------------------------------------------------------------- names
/** A short name from a title: "Plot request" → "plot-request" (2 to 40 characters, a letter first). */
export function slugify(title: string): string {
  const s = title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  if (!s) return 'my-bot';
  const t = /^[a-z]/.test(s) ? s : `bot-${s}`.replace(/-+$/, '');
  return t.length >= 2 ? t : 'my-bot';
}

/** Two letters for a monogram: "Plot request" → "PR", "RFI log" → "RL". */
export function monogram(title: string): string {
  const w = title.trim().split(/\s+/).filter((x) => /[\p{L}\p{N}]/u.test(x));
  if (!w.length) return 'B';
  return ((w[0][0] ?? '') + (w.length > 1 ? w[1][0] : (w[0][1] ?? ''))).toUpperCase();
}

/** A step id not used yet ("q1", "q2"…). */
export function freshStepId(def: Pick<BotFlowDefinition, 'steps'>, base = 'q'): string {
  const used = new Set(def.steps.map((s) => s.id));
  for (let i = 1; i < 99; i++) if (!used.has(`${base}${i}`)) return `${base}${i}`;
  return `${base}${Date.now().toString(36)}`;
}

// ---------------------------------------------------------------- templates
export interface BotTemplate { id: string; title: string; about: string; definition: BotFlowDefinition }

const persona = (glyph: BotGlyph, colour: BotPersona['colour'], about: string, tone: BotPersona['tone'] = 'plain', extra: Partial<BotPersona> = {}): BotPersona =>
  ({ mark: { kind: 'glyph', glyph }, colour, about, tone, remember: true, ...extra });

const OFFICE_HOURS = { days: [1, 2, 3, 4, 5], from: '09:00', to: '18:30' };

/** Starting points that suit a design office. Each one is a working bot as it stands. */
export const BOT_TEMPLATES: BotTemplate[] = [
  PLOT_REQUEST,
  {
    id: 'leave-note', title: 'Leave note', about: 'Tell your lead you are away, and who covers for you.',
    definition: {
      name: 'leave-note', title: 'Leave note', description: 'Days away, who covers, and a note for your lead.',
      persona: persona('calendar', 'plum', 'Tell your lead you are away, and who covers for you.', 'warm'),
      steps: [
        { id: 'kind', label: 'Leave', prompt: 'What kind of leave?', input: { kind: 'choice', options: [{ value: 'annual', label: 'Annual leave' }, { value: 'sick', label: 'Sick leave' }, { value: 'comp', label: 'Comp-off' }, { value: 'half', label: 'Half day' }] } },
        { id: 'from', label: 'From', prompt: 'From which day?', input: { kind: 'text', validate: { type: 'date' } } },
        { id: 'to', label: 'Back on', prompt: 'Which day are you back?', input: { kind: 'text', validate: { type: 'date' } } },
        { id: 'cover', label: 'Cover', prompt: 'Who covers your work?', input: { kind: 'person', optional: true } },
        { id: 'lead', label: 'Lead', prompt: 'Who should know? Usually your lead.', input: { kind: 'person' } },
        { id: 'note', label: 'Note', prompt: 'Anything they should know? (optional)', input: { kind: 'text', multiline: true, optional: true } },
      ],
      finish: [{ do: 'task', assignee: 'lead', text: '{{user}}: {{kind}} from {{from}}, back {{to}}. Cover: {{cover}}', due: 'from' }, { do: 'away', from: 'from', to: 'to', cover: 'cover', lead: 'lead', kind: 'kind', note: 'note' }],
      done: 'Noted. {{lead}} has it on their Desk, and Nib has marked you away.',
    },
  },
  SITE_VISIT,
  TECHNICAL_QUERY,
  SOFTWARE_SEAT,
  LATE_WORK,
  DRAWING_CHECK,
  TQ_CHASER,
  FRIDAY_TIMESHEET,
];

/** A blank bot to build up from nothing: one question and a reminder at the end. */
export function blankBot(title = 'My bot'): BotFlowDefinition {
  return {
    name: slugify(title), title,
    persona: { mark: { kind: 'monogram', letters: monogram(title) }, colour: 'teal', tone: 'plain', remember: false },
    steps: [{ id: 'q1', label: 'Answer', prompt: 'What would you like?', input: { kind: 'text' } }],
    finish: [{ do: 'remind', text: 'Follow up: {{q1}}', dueInDays: 1 }],
  };
}

/** A copy to change: a new name and title, the same steps. */
export function duplicateBot(def: BotFlowDefinition, title?: string): BotFlowDefinition {
  const t = (title ?? `${def.title} (copy)`).slice(0, 80);
  const copy = JSON.parse(JSON.stringify(def)) as BotFlowDefinition;
  copy.title = t;
  copy.name = slugify(t);
  delete copy.command;
  if (copy.persona?.mark.kind === 'monogram') copy.persona.mark.letters = monogram(t);
  // a webhook belongs to an integration, not to a copy
  copy.finish = copy.finish.filter((a) => a.do !== 'webhook');
  if (!copy.finish.length) copy.finish = [{ do: 'remind', text: `${t}: done`, dueInDays: 1 }];
  return copy;
}

// ---------------------------------------------------------------- what the end does, in words
/** One line for each action at the end, as the maker reads it ("A task on {{lead}}'s Desk"). */
export function describeAction(a: BotFlowAction, def: BotFlowDefinition): string {
  const label = (v: string) => def.steps.find((s) => saveKey(s) === v)?.label ?? v;
  if (a.do === 'task') return `A task on the Desk of the person chosen at “${label(a.assignee)}”${a.due ? `, due on “${label(a.due)}”` : a.dueInDays !== undefined ? `, due in ${a.dueInDays} days` : ''}`;
  if (a.do === 'remind') return `A reminder on your Desk${a.due ? ` on “${label(a.due)}”` : a.dueInDays !== undefined ? ` in ${a.dueInDays} days` : ''}`;
  if (a.do === 'post') return a.to === 'origin' ? 'A post in the Space it was started from' : a.to.startsWith('space:') ? `A post in ${a.to.slice(6)}` : `A message to the person chosen at “${label(a.to.slice(7))}”`;
  if (a.do === 'away') return `Nib marks you away from “${label(a.from)}”${a.to ? ` until “${label(a.to)}”` : ''}: out of office, calendar, leads${a.cover ? ' and the cover' : ''} told`;
  return 'The integration’s webhook is called with every answer';
}

// ---------------------------------------------------------------- the test run
/** A message in the test run: a card, or (card null) a plain line from the bot. */
export interface TestCard { id: string; body: string; card: BotFlowCard | null }
export interface TestRun extends RunLike {
  def: BotFlowDefinition;
  status: 'active' | 'done' | 'cancelled';
  cards: TestCard[];
  /** What the bot remembers for this person (from earlier test runs). */
  memory: Record<string, BotFlowAnswer>;
  seq: number;
  /** A tracked bot, once sent: the request, which the maker then plays through every part. */
  item?: BotItem | null;
  /** Who "their lead" is in the test run (the maker's own lead from the directory, else the maker). */
  lead?: string | null;
}

const TEST_ID = 'test-run';

function push(t: TestRun, body: string, card: Omit<BotFlowCard, 'botId' | 'sessionId' | 'ownerId'>): TestRun {
  const seq = t.seq + 1;
  // the card it replaces is shown again as moved on
  const cards = t.cards.map((c) => (c.card?.state === 'active' && (c.card.kind === 'step' || c.card.kind === 'resume') ? { ...c, card: { ...c.card, state: 'moved' as const } } : c));
  return { ...t, seq, cards: [...cards, { id: `t${seq}`, body, card: { ...card, botId: TEST_ID, sessionId: TEST_ID, ownerId: 'me' } as BotFlowCard }] };
}

function stepCardOf(t: TestRun, fresh: boolean): TestRun {
  const step = stepById(t.def, t.step);
  const remembered = step && t.def.persona?.remember ? t.memory[saveKey(step)] ?? null : null;
  const data = stepCard(t.def, t, { fresh, lastTime: remembered });
  return push(t, data.prompt, { kind: 'step', state: 'active', stepId: t.step ?? undefined, ...data });
}

/** Start a test run as `user` (the person making the bot sees it as a colleague would). */
export function testStart(def: BotFlowDefinition, user: { id: string; name: string; account: string }, memory: Record<string, BotFlowAnswer> = {}, lead: string | null = null): TestRun {
  if (!def.steps.length) throw new BotFlowError('Add a step first.');
  const t: TestRun = { def, step: def.steps[0].id, history: [], answers: {}, vars: startVars(def, user), status: 'active', cards: [], memory, seq: 0, item: null, lead };
  return stepCardOf(t, true);
}

/** What the end would do, without doing it. */
function wouldDo(def: BotFlowDefinition, vars: BotFlowVars, summary: string): string[] {
  const fill = (s: string) => renderTemplate(s, vars, { summary, title: def.title });
  return def.finish.map((a) => {
    if (a.do === 'task') return `Would put a task on ${vars[a.assignee]?.label || 'no one'}'s Desk: ${fill(a.text)}`;
    if (a.do === 'remind') return `Would put a reminder on your Desk: ${fill(a.text)}`;
    if (a.do === 'post') return `Would post ${a.to === 'origin' ? 'in the Space it was started from' : a.to.startsWith('space:') ? `in ${a.to.slice(6)}` : `to ${vars[a.to.slice(7)]?.label || 'no one'}`}`;
    if (a.do === 'away') return `Would mark you away from ${vars[a.from]?.label || 'that day'}${a.to ? ` until ${vars[a.to]?.label || 'you are back'}` : ''}${a.cover ? `, with ${vars[a.cover]?.label || 'no one'} covering` : ''}`;
    return 'Would call the webhook with the answers';
  });
}

/** In a test run every part is played by the maker: their lead, a role nobody holds yet, the person who asked. */
function testPeople(t: Pick<TestRun, 'def' | 'vars' | 'lead'>): TrackPeople {
  const me = t.vars.user?.value ?? 'me';
  return {
    resolve: (who, item) => {
      if (who === 'requester') return { id: item.requesterId };
      const picked = personAnswer(t.def, who, item);
      if (picked) return { id: picked };
      if (who === 'lead') return { id: t.lead || me };
      if (who.startsWith('role:')) return { id: t.def.track?.roles?.[who.slice(5)]?.person || me };
      return { id: me };
    },
  };
}

/** The done card of a test run follows the request, as the real one does. */
function withTrack(t: TestRun, now: number): TestRun {
  if (!t.item) return t;
  const view = trackView(t.def, t.item, t.item.actorId ?? t.item.requesterId, { now, actingAs: true });
  const cards = t.cards.map((c) => (c.card?.kind === 'done' ? { ...c, card: { ...c.card, track: view } } : c));
  return { ...t, cards };
}

/** The maker presses a button on the request, playing whoever acts at this stage. */
export function testAct(t: TestRun, action: string, note = '', now = Date.now()): TestRun {
  if (!t.item) throw new BotFlowError('Send it first.');
  const item = trackAct(t.def, t.item, action, t.item.actorId ?? '', now, testPeople(t), note);
  return withTrack({ ...t, item }, now);
}
export function testTick(t: TestRun, index: number, on: boolean, now = Date.now()): TestRun {
  if (!t.item) throw new BotFlowError('Send it first.');
  return withTrack({ ...t, item: trackTick(t.def, t.item, index, on, t.item.actorId ?? '') }, now);
}
export function testWithdraw(t: TestRun, now = Date.now()): TestRun {
  if (!t.item) throw new BotFlowError('Send it first.');
  return withTrack({ ...t, item: trackWithdraw(t.item, t.item.requesterId, now) }, now);
}

/** One answer in a test run: checked exactly as the hub checks it. Throws a BotFlowError worded for the person. */
export function testAnswer(t: TestRun, stepId: string, raw: string, ctx: Omit<AnswerContext, 'tone'>): TestRun {
  if (t.status !== 'active' || t.step !== stepId) throw new BotFlowError('That step was already answered. Answer the newest card.');
  const step = stepById(t.def, stepId) as BotFlowStep;
  const answer = checkAnswer(step, raw, { ...ctx, tone: t.def.persona?.tone });
  const cards = t.cards.map((c) => (c.card?.state === 'active' && c.card.stepId === stepId ? { ...c, card: { ...c.card, state: 'answered' as const, answer } } : c));
  let next: TestRun = { ...t, cards, answers: { ...t.answers, [saveKey(step)]: answer }, history: [...t.history, stepId], vars: { ...t.vars } };
  const go = nextAfter(next.def, step, effectiveVars(next.def, next));
  for (const [k, v] of Object.entries(go.set)) next.vars[k] = { value: v, label: v };
  if (go.goto === 'end') {
    const vars = effectiveVars(next.def, next);
    const lines = summaryLines(next.def, next.history, vars);
    const summary = summaryText(lines);
    const remember = next.def.persona?.remember
      ? Object.fromEntries(next.def.steps.filter((s) => next.history.includes(s.id) && vars[saveKey(s)]?.value && s.input.kind !== 'confirm' && s.input.kind !== 'file').map((s) => [saveKey(s), vars[saveKey(s)]]))
      : {};
    next = { ...next, step: null, status: 'done', memory: { ...next.memory, ...remember } };
    const done = doneLine(next.def, vars, summary);
    const notes = wouldDo(next.def, vars, summary);
    if (next.def.track) {
      const now = ctx.now;
      next.item = trackOpen(next.def, { id: 'test-item', num: 1, requesterId: vars.user?.value ?? 'me', vars, lines, now, people: testPeople(next) });
      notes.push(`Then tracked as ${next.item.ref}: ${mainWay(next.def).map((id) => stageOf(next.def, id)?.label ?? id).join(' → ')}. Try each part on the card.`);
    }
    return withTrack(push(next, done, { kind: 'done', title: next.def.title, state: 'done', prompt: done, lines, notes, ...(next.def.persona ? { persona: { mark: next.def.persona.mark, colour: next.def.persona.colour } } : {}) }), ctx.now);
  }
  next.step = go.goto;
  return stepCardOf(next, false);
}

export function testBack(t: TestRun): TestRun {
  const prev = t.history[t.history.length - 1];
  if (!prev || t.status !== 'active') throw new BotFlowError('This is the first step.');
  return stepCardOf({ ...t, history: t.history.slice(0, -1), step: prev }, false);
}

export function testCancel(t: TestRun): TestRun {
  const cards = t.cards.map((c) => (c.card?.state === 'active' ? { ...c, card: { ...c.card, state: 'cancelled' as const } } : c));
  const seq = t.seq + 1;
  return { ...t, status: 'cancelled', step: null, seq, cards: [...cards, { id: `t${seq}`, body: voiceOf(t.def.persona?.tone).cancelled, card: null }] };
}

// ---------------------------------------------------------------- problems, beside what causes them
export interface BotProblems {
  /** By step id: what is wrong with that step, in plain words. */
  steps: Record<string, string[]>;
  /** By position in `finish`. */
  finish: Record<number, string[]>;
  /** What happens after it is sent (the stages, roles, reminders and register). */
  track: string[];
  /** Anything else (the name, the title, no steps…). */
  general: string[];
  count: number;
}

/** Words for the editor, not for JSON: "give it a "prompt"" reads "Write the question". */
function plainWords(msg: string): string {
  return msg
    .replace(/^Step "[^"]+":\s*/, '').replace(/^Step \d+:\s*/, '').replace(/^Finish action \d+:\s*/, '')
    .replace(/give it a "prompt"\./, 'Write the question.')
    .replace(/give it an "id" \(letters, digits, _ and -\)\./, 'It needs a short id (letters, digits, _ and -).')
    .replace(/"assignee" should name a step that picks a person\./, 'Choose which answer names the person who gets the task.')
    .replace(/"to" should name a step that picks a person\./, 'Choose which answer names the person to message.')
    .replace(/"due" should name a step that asks for a date\./, 'Choose a date question for the due date, or a number of days.')
    .replace(/give the "text" to post\./, 'Write what it posts.')
    .replace(/give the task's "text"\./, 'Write what the task says.')
    .replace(/give the reminder's "text"\./, 'Write what the reminder says.')
    .replace(/"to" is "origin", "space:<name>" or "person:<variable>"\./, 'Choose where it posts.')
    .replace(/Give the flow a "title"\./, 'Give the bot a name.')
    .replace(/The flow name uses lower-case letters, digits and dashes \(2 to 40\), starting with a letter\./, 'The short name uses lower-case letters, digits and dashes (2 to 40), starting with a letter.')
    .replace(/Give the flow at least one step\./, 'Add at least one question.')
    .replace(/Say what happens at the end in "finish" \(post, webhook or task\)\./, 'Say what happens at the end.')
    .replace(/, which is not a step\./, ', which is not a step any more.');
}

/**
 * Every problem in a draft, each placed beside the step or end action that causes it: the
 * definition is checked as the hub checks it, and each part found wrong is set aside so the
 * next problem can be found too.
 */
export function problemsOf(def: BotFlowDefinition): BotProblems {
  const out: BotProblems = { steps: {}, finish: {}, track: [], general: [], count: 0 };
  let d: BotFlowDefinition = JSON.parse(JSON.stringify(def ?? {})) as BotFlowDefinition;
  if (!Array.isArray(d.steps)) d.steps = [];
  if (!Array.isArray(d.finish)) d.finish = [];
  const add = (where: 'steps' | 'finish', key: string | number, msg: string) => {
    const box = out[where] as Record<string | number, string[]>;
    (box[key] ??= []).push(plainWords(msg));
    out.count++;
  };
  for (let guard = 0; guard < 60; guard++) {
    try { validateFlowSafe(d); return out; } catch (err) {
      const msg = (err as Error).message;
      // the track is checked last: one problem in it is shown there, and it is set aside
      if (/^(Stage |Track:|Role ")/.test(msg)) {
        out.track.push(msg.replace(/^Track:\s*/, ''));
        out.count++;
        delete d.track;
        continue;
      }
      const byId = /^Step "([^"]+)"/.exec(msg);
      const byNo = /^Step (\d+)/.exec(msg);
      const act = /^Finish action (\d+)/.exec(msg);
      if (byId || byNo) {
        const i = byId ? d.steps.findIndex((s) => s.id === byId[1]) : Number(byNo![1]) - 1;
        const s = d.steps[i];
        if (!s) { out.general.push(plainWords(msg)); out.count++; return out; }
        add('steps', s.id || `#${i + 1}`, msg);
        // set it aside: a plain question with the same id keeps the routes to it valid
        const keepId = /^[A-Za-z][\w-]{0,39}$/.test(String(s.id)) && d.steps.findIndex((y) => y.id === s.id) === i && s.id !== 'end';
        let input: BotFlowStep['input'] = { kind: 'text' };
        try { input = checkInput(s.input, 'x'); } catch { /* the input was the problem */ }
        d = { ...d, steps: d.steps.map((x, j) => (j === i ? { id: keepId ? x.id : `x${j}`, prompt: 'x', input } : x)) };
      } else if (act) {
        const i = Number(act[1]) - 1;
        add('finish', i, msg);
        d = { ...d, finish: d.finish.map((a, j) => (j === i ? { do: 'webhook' } as BotFlowAction : a)) };
      } else {
        out.general.push(plainWords(msg));
        out.count++;
        if (/title/.test(msg)) d = { ...d, title: 'x' };
        else if (/name/.test(msg)) d = { ...d, name: 'x-x' };
        else if (/finish/.test(msg)) d = { ...d, finish: [] };
        else return out;
      }
    }
  }
  return out;
}

const validateFlowSafe = (d: BotFlowDefinition): BotFlowDefinition => validateFlow(d);
