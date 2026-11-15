// The bot maker's own rules, shared by the app (the editor and its test run) and the hub's tests:
// templates that suit a design office, a fresh blank bot, short names, and a test run that walks
// through a bot exactly as a colleague would (the same cards, checks and wording as the hub), with
// nothing sent at the end.
import type { BotFlowAction, BotFlowAnswer, BotFlowCard, BotFlowDefinition, BotFlowStep, BotGlyph, BotPersona } from './bots.ts';
import { BotFlowError, checkAnswer, checkInput, doneLine, validateFlow, effectiveVars, nextAfter, renderTemplate, saveKey, startVars, stepById, stepCard, summaryLines, summaryText, voiceOf } from './botflow-engine.ts';
import type { AnswerContext, BotFlowVars, RunLike } from './botflow-engine.ts';

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
  {
    id: 'plot-request', title: 'Plot request', about: 'Plots go to your lead for approval, then to the plot room.',
    definition: {
      name: 'plot-request', title: 'Plot request', description: 'Ask for a plot set; your lead approves it from their Desk.',
      persona: persona('plotter', 'rust', 'Plots go to your lead for approval, then to the plot room.', 'warm'),
      steps: [
        { id: 'job', label: 'Job', prompt: 'Which job is it for?', input: { kind: 'text', placeholder: 'P-12513', validate: { type: 'regex', pattern: '[A-Za-z]{1,4}-?\\d{3,6}', message: 'Write the job number: letters then digits, like P-12513.' } } },
        { id: 'drawings', label: 'Drawings', prompt: 'Which drawings, at which revision? One per line.', input: { kind: 'text', multiline: true, placeholder: 'ISO-1001-01 rev C' } },
        { id: 'size', label: 'Sheet size', prompt: 'Which sheet size?', input: { kind: 'choice', options: [{ value: 'A0', label: 'A0' }, { value: 'A1', label: 'A1' }, { value: 'A3', label: 'A3' }] } },
        { id: 'sets', label: 'Sets', prompt: 'How many sets?', input: { kind: 'text', validate: { type: 'number', integer: true, min: 1, max: 50 }, suggestions: ['1', '2', '3'] } },
        { id: 'due', label: 'Needed by', prompt: 'When do you need them?', input: { kind: 'text', validate: { type: 'date', notBefore: 'today' } } },
        { id: 'lead', label: 'Approver', prompt: 'Who approves it? Usually your discipline lead.', input: { kind: 'person' } },
        { id: 'ok', prompt: 'Send this to {{lead}}?\n\n{{summary}}', input: { kind: 'confirm', yes: 'Send for approval', no: 'Change something' }, branches: [{ if: { equals: 'no' }, goto: 'job' }] },
      ],
      finish: [{ do: 'task', assignee: 'lead', text: 'Approve plot for {{job}}: {{sets}} × {{size}} for {{user}}, needed {{due}}', due: 'due' }],
      done: 'Sent to {{lead}}. The plot room starts once it is approved.',
    },
  },
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
  {
    id: 'site-visit', title: 'Site visit', about: 'Book a visit; the host on site gets it on their Desk.',
    definition: {
      name: 'site-visit', title: 'Site visit', description: 'Book a site visit with a host on site.',
      persona: persona('helmet', 'olive', 'Book a visit; the host on site gets it on their Desk.', 'plain', { hours: OFFICE_HOURS }),
      steps: [
        { id: 'site', label: 'Site', prompt: 'Which site?', input: { kind: 'choice', options: [{ value: 'refinery', label: 'Refinery' }, { value: 'pump-house', label: 'Pump house' }, { value: 'depot', label: 'Depot' }] } },
        { id: 'day', label: 'Day', prompt: 'Which day?', input: { kind: 'text', validate: { type: 'date', notBefore: 'today' } } },
        { id: 'people', label: 'People', prompt: 'How many people are going?', input: { kind: 'text', validate: { type: 'number', integer: true, min: 1, max: 12 }, suggestions: ['1', '2', '4'] } },
        { id: 'why', label: 'Purpose', prompt: 'What is the visit for?', input: { kind: 'text', placeholder: 'Walk-down of the pipe rack' } },
        { id: 'host', label: 'Host', prompt: 'Who hosts you on site?', input: { kind: 'person' } },
        { id: 'ok', prompt: 'Book it with {{host}}?\n\n{{summary}}', input: { kind: 'confirm', yes: 'Book', no: 'Change something' }, branches: [{ if: { equals: 'no' }, goto: 'site' }] },
      ],
      finish: [{ do: 'task', assignee: 'host', text: 'Host {{people}} from {{user}} at {{site}}: {{why}}', due: 'day' }, { do: 'remind', text: 'Site visit to {{site}}: PPE and permit', due: 'day' }],
      done: 'Booked with {{host}}. A reminder is on your Desk for the day.',
    },
  },
  {
    id: 'rfi-log', title: 'RFI log', about: 'Log a request for information against a drawing, and chase it.',
    definition: {
      name: 'rfi-log', title: 'RFI log', description: 'Log an RFI against a drawing; it reminds you to chase it.',
      persona: persona('rfi', 'indigo', 'Log a request for information against a drawing, and chase it.', 'formal'),
      steps: [
        { id: 'job', label: 'Job', prompt: 'Which job?', input: { kind: 'text', placeholder: 'P-12513' } },
        { id: 'discipline', label: 'Discipline', prompt: 'Which discipline?', input: { kind: 'choice', options: [{ value: 'piping', label: 'Piping' }, { value: 'structural', label: 'Structural' }, { value: 'civil', label: 'Civil' }, { value: 'mech', label: 'Mechanical' }, { value: 'ei', label: 'E&I' }] } },
        { id: 'ref', label: 'Drawing', prompt: 'Which drawing does it concern?', input: { kind: 'text', placeholder: 'GA-200 rev B' } },
        { id: 'question', label: 'Question', prompt: 'What do you need to know?', input: { kind: 'text', multiline: true } },
        { id: 'markup', label: 'Mark-up', prompt: 'Attach a mark-up if you have one.', input: { kind: 'file', accept: ['.pdf', '.png', '.jpg'], optional: true } },
        { id: 'due', label: 'Answer by', prompt: 'When do you need the answer?', input: { kind: 'text', validate: { type: 'date', notBefore: 'today' } } },
      ],
      finish: [{ do: 'post', to: 'origin', text: '**RFI for {{job}}** ({{discipline}}, {{ref}})\n\n{{question}}\n\nAnswer needed by {{due}}.' }, { do: 'remind', text: 'Chase the RFI on {{ref}} ({{job}})', due: 'due' }],
      done: 'The RFI is logged. You will be reminded to chase it on {{due}}.',
    },
  },
  {
    id: 'drawing-issue', title: 'Drawing issue request', about: 'Ask for drawings to be checked and issued at a revision.',
    definition: {
      name: 'drawing-issue', title: 'Drawing issue request', description: 'Drawings to check and issue, at a revision, for a purpose.',
      persona: persona('stamp', 'teal', 'Ask for drawings to be checked and issued at a revision.', 'brief'),
      steps: [
        { id: 'drawings', label: 'Drawings', prompt: 'Which drawings? One per line.', input: { kind: 'text', multiline: true, placeholder: 'ISO-1001-01\nISO-1001-02' } },
        { id: 'rev', label: 'Revision', prompt: 'At which revision?', input: { kind: 'text', placeholder: 'C', validate: { type: 'regex', pattern: '[A-Z]{1,2}|\\d{1,2}|[A-Z]\\d', message: 'Write the revision: a letter like C, or a number like 2.' }, suggestions: ['A', 'B', 'C', '0'] } },
        { id: 'purpose', label: 'Issued for', prompt: 'Issued for what?', input: { kind: 'choice', options: [{ value: 'IFR', label: 'Review (IFR)' }, { value: 'IFA', label: 'Approval (IFA)' }, { value: 'IFC', label: 'Construction (IFC)' }, { value: 'AB', label: 'As-built' }] } },
        { id: 'checker', label: 'Checker', prompt: 'Who checks them?', input: { kind: 'person' } },
        { id: 'due', label: 'Issue by', prompt: 'Issue by when?', input: { kind: 'text', validate: { type: 'date', notBefore: 'today' } } },
      ],
      finish: [{ do: 'task', assignee: 'checker', text: 'Check and issue rev {{rev}} for {{purpose}} ({{user}})', due: 'due' }],
      done: 'With {{checker}} to check.',
    },
  },
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
export function testStart(def: BotFlowDefinition, user: { id: string; name: string; account: string }, memory: Record<string, BotFlowAnswer> = {}): TestRun {
  if (!def.steps.length) throw new BotFlowError('Add a step first.');
  const t: TestRun = { def, step: def.steps[0].id, history: [], answers: {}, vars: startVars(def, user), status: 'active', cards: [], memory, seq: 0 };
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
    return push(next, done, { kind: 'done', title: next.def.title, state: 'done', prompt: done, lines, notes: wouldDo(next.def, vars, summary), ...(next.def.persona ? { persona: { mark: next.def.persona.mark, colour: next.def.persona.colour } } : {}) });
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
  const out: BotProblems = { steps: {}, finish: {}, general: [], count: 0 };
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
