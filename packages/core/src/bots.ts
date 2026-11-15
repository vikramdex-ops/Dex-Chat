// Conversational workflows and the tools (mini-apps) that run inside conversations: the shapes
// shared by the hub, the apps and integrations. The rules that run a flow are in flow-engine.ts;
// the sandbox a tool runs in is described in miniapp.ts.
import type { FileInfo, Message } from './protocol.ts';

// ---------------------------------------------------------------- flows
/** How a step is answered. Free text can be checked as a number, a date, an email address or a pattern. */
export type BotFlowInputKind = 'choice' | 'text' | 'person' | 'file' | 'confirm';

export interface BotFlowOption { value: string; label: string }

export interface BotFlowValidate {
  type: 'number' | 'date' | 'email' | 'regex';
  /** number: the smallest and largest allowed. */
  min?: number;
  max?: number;
  /** number: whole numbers only. */
  integer?: boolean;
  /** date: "today" or YYYY-MM-DD; the answer may not be earlier. */
  notBefore?: string;
  /** regex: the pattern the whole answer must match (JavaScript syntax, up to 200 characters). */
  pattern?: string;
  /** Shown when the answer does not pass. */
  message?: string;
}

export interface BotFlowInput {
  kind: BotFlowInputKind;
  /** choice: the buttons. */
  options?: BotFlowOption[];
  /** text: how the answer is checked. */
  validate?: BotFlowValidate;
  /** text: a paragraph rather than a line. */
  multiline?: boolean;
  placeholder?: string;
  /** file: allowed extensions, e.g. [".pdf", ".dwg"]. */
  accept?: string[];
  /** confirm: the two buttons' words. */
  yes?: string;
  no?: string;
  /** May be skipped (the answer is then empty). */
  optional?: boolean;
  /** text: quick replies, answers people can give with one tap ("Tomorrow", "Same as the GA"). */
  suggestions?: string[];
  /**
   * A default from the office's own records, offered as one tap: person → "lead" (the person's
   * lead from the directory: their manager, else their department's head); text → "jobs" (job
   * numbers from the names of the Spaces they are in, added to the quick replies).
   */
  suggest?: 'lead' | 'jobs';
}

/** A test on an answer or a variable. Every given test must pass. */
export interface BotFlowCondition {
  /** The variable to test; the step's own answer when left out. */
  var?: string;
  equals?: string;
  notEquals?: string;
  in?: string[];
  matches?: string;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  empty?: boolean;
}

export interface BotFlowBranch {
  if: BotFlowCondition;
  /** A step id, or "end" to finish. */
  goto: string;
  /** Variables to set when this branch is taken. */
  set?: Record<string, string>;
}

export interface BotFlowStep {
  id: string;
  /** Short name used in summaries ("Sheet size"); the id when left out. */
  label?: string;
  /** What the bot asks. {{name}} inserts an answer or variable, {{summary}} all answers so far. */
  prompt: string;
  input: BotFlowInput;
  /** The variable the answer is kept in (the step id when left out). */
  save?: string;
  /** Checked in order; the first that passes decides the next step. */
  branches?: BotFlowBranch[];
  /** The next step when no branch applies: a step id or "end" (the following step when left out). */
  next?: string;
  /**
   * Ask another bot instead of the person (docs/BOT-NETWORK.md): the answer is kept under the
   * step's variable (`{{seat}}`, and each output as `{{seat.free}}`). The step's own prompt and
   * input are the fallback when the bot cannot answer (onFail "ask", the default).
   */
  ask?: BotAsk;
}

export type BotFlowAction =
  /** Post a message: into the conversation the flow was started from, a Space, or to a person (a person variable). */
  | { do: 'post'; to: 'origin' | `space:${string}` | `person:${string}`; text: string }
  /** Call the integration's webhook with every answer. */
  | { do: 'webhook' }
  /** A task on someone's Desk: the person in `assignee` (a person variable). `due` names a date variable, or `dueInDays` counts from today. */
  | { do: 'task'; assignee: string; text: string; due?: string; dueInDays?: number }
  /** A reminder on the Desk of the person who answered. `due` names a date variable, or `dueInDays` counts from today. */
  | { do: 'remind'; text: string; due?: string; dueInDays?: number }
  /**
   * Mark the person who answered away (Nib's leave note, docs/NIB.md §6): `from` and `to` name date variables (`to` is the
   * day they are back), `cover` and `lead` person variables, `kind` and `note` any answers.
   */
  | { do: 'away'; from: string; to?: string; cover?: string; lead?: string; kind?: string; note?: string }
  /** Hand the request on to another bot, with answers carried across (docs/BOT-NETWORK.md). */
  | ({ do: 'handoff' } & BotHandoff);

// ---------------------------------------------------------------- a bot's own identity
/** How a bot words the phrases it says itself (the steps' own questions are the author's). */
export type BotTone = 'plain' | 'warm' | 'brief' | 'formal';
export const BOT_TONES: BotTone[] = ['plain', 'warm', 'brief', 'formal'];
/** The palette a bot's mark is drawn in (the same family as people's tiles; each passes 4.5:1 with white). */
export type BotColour = 'teal' | 'petrol' | 'slate' | 'indigo' | 'plum' | 'rust' | 'olive' | 'ochre';
export const BOT_COLOURS: Record<BotColour, string> = {
  teal: '#1e6066', petrol: '#1c7680', slate: '#3d5a5e', indigo: '#2f5d8a', plum: '#6a4c93', rust: '#a0522d', olive: '#4d6b2f', ochre: '#7a5a14',
};
/** Symbols drawn for us on the 24 px grid (see bots/maker/BotMark.tsx), from the drawing office. */
export type BotGlyph = 'sheet' | 'plotter' | 'helmet' | 'level' | 'flange' | 'beam' | 'calendar' | 'stamp' | 'compass' | 'clipboard' | 'pin' | 'rfi' | 'key' | 'lamp';
export const BOT_GLYPHS: BotGlyph[] = ['sheet', 'plotter', 'helmet', 'level', 'flange', 'beam', 'calendar', 'stamp', 'compass', 'clipboard', 'pin', 'rfi', 'key', 'lamp'];

/** A bot's mark: two letters set in a title-block frame, or one of our drawn symbols. */
export interface BotMark { kind: 'monogram' | 'glyph'; letters?: string; glyph?: BotGlyph }

/** When a bot takes new requests, in the hub's local time. */
export interface BotHours {
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** HH:MM, 24-hour. */
  from: string;
  to: string;
}

export interface BotPersona {
  mark: BotMark;
  colour: BotColour;
  /** One or two lines: what it is for (shown on its card and page). */
  about?: string;
  /** The first thing it says ({{user.first}} and the other placeholders work). */
  greeting?: string;
  tone: BotTone;
  /** Only during these hours; always when left out. */
  hours?: BotHours | null;
  /** Offer each person's last answers as the default ("Same as last time: Refinery"). */
  remember?: boolean;
}

/** Who can start a bot a member made: only its maker, the people of one Space, or the whole office (approved by an administrator). */
export type BotScope = 'private' | 'space' | 'office';
/** live: people can start it; paused: no new runs for now; retired: put away (runs in progress may finish). */
export type BotStatus = 'live' | 'paused' | 'retired';

export interface BotFlowDefinition {
  /** Lower-case letters, digits and dashes; unique in the office. */
  name: string;
  title: string;
  description?: string;
  /** A slash command that starts it (e.g. "plot" for /plot). */
  command?: string;
  /** Words that start it when someone writes them to the integration. */
  keywords?: string[];
  /** Days an unfinished conversation is kept (default 7, at most 90). */
  expiresInDays?: number;
  /** Variables with starting values. */
  vars?: Record<string, string>;
  steps: BotFlowStep[];
  /** What happens when the last step is answered. */
  finish: BotFlowAction[];
  /** The closing line shown to the person ({{name}} works here too). */
  done?: string;
  /** Its own identity: a mark, a colour, a voice, its hours (member-made bots; optional for others). */
  persona?: BotPersona;
  /** After it is sent: each request is tracked through stages where other people act (see BotFlowTrack). */
  track?: BotFlowTrack;
  /** Talking to other bots: whose bots may ask it, whether it takes handoffs, what it listens for (docs/BOT-NETWORK.md). */
  network?: BotNetwork;
  /** Scheduled jobs, written in plain words ("every Monday at 10:00"). */
  jobs?: BotJob[];
}

// ---------------------------------------------------------------- after it is sent: tracked requests
/**
 * Who acts at a stage: "requester" (the person who asked), "lead" (their lead from the directory:
 * their manager, else their department's head, else the bot's maker), the variable of a step that
 * picked a person, or "role:<key>" (a person the bot's maker names once, like the plot room).
 * Someone out of office with a delegate is passed over to the delegate.
 */
export type BotWho = string;

/** A button for the person acting at a stage. */
export interface BotFlowStageAction {
  /** Short id (kept in the history). */
  id: string;
  /** The button's words ("Approve", "Return with comments"). */
  label: string;
  /** The next stage's id, the same stage (to start it again), or "end". */
  to: string;
  /** Ending here: the stamp drawn on every card ("APPROVED", "ISSUED", "TURNED DOWN"). */
  stamp?: string;
  /** Ending here: done (the default) or stopped (turned down, rejected). */
  outcome?: 'done' | 'stopped';
  /** A note with it: none (left out), optional or required; `ask` labels the box ("Comments"). */
  note?: 'optional' | 'required';
  ask?: string;
  /** Every line of the stage's checklist must be ticked first. */
  needsChecks?: boolean;
  /** How the button looks: go (the main way on), back (returns it), stop (ends it short). */
  tone?: 'go' | 'back' | 'stop';
  /** Pressing it also hands the request to another bot (a site visit running late → the late work bot). */
  handoff?: BotHandoff;
}

export interface BotFlowStage {
  id: string;
  /** Short name on the progress strip ("Check", "Approve", "Plot"). */
  label: string;
  who: BotWho;
  /** What the person acting is asked ({{placeholders}} work, {{note}} is the last note given). */
  prompt: string;
  actions: BotFlowStageAction[];
  /** Lines the person acting ticks ("Safety shoes", "Permit to work"). */
  checklist?: string[];
  /** When it is due: a date answer, or days after the stage is reached. */
  due?: string;
  dueInDays?: number;
  /**
   * A queue: at most this many requests at once in this stage, counted per answer of `by` (seats
   * of each software); the rest wait in order, see their place, and move up as one leaves.
   */
  limit?: { by?: string; seats: Record<string, number>; otherwise: number };
  /** A Desk task for the person acting (on unless they are the person who asked). */
  task?: boolean;
  /**
   * who "bot:<name>": the stage waits on another bot. The request is handed to it with `carry`;
   * when the other bot's request closes, `back.done` (or `back.stopped`) names the button of this
   * stage that is pressed for it, with the other bot's stamp and last note as {{note}}.
   */
  handoff?: BotHandoff;
}

/** A person the bot's maker names once (the plot room, document control); the maker until chosen. */
export interface BotFlowRole { label: string; person?: string }

export interface BotFlowTrack {
  /** Letters before each request's number: "DC" makes DC-0007. */
  ref: string;
  /** A request's one-line name in the register ("{{drawings}} rev {{rev}}"). */
  name?: string;
  stages: BotFlowStage[];
  roles?: Record<string, BotFlowRole>;
  /**
   * Gentle reminders, during the bot's hours (or office hours): after `afterHours` waiting, up to
   * `times`, gathered into one list per person; then once to `escalate` ("lead", "role:<key>" or
   * "none"). Left out: a day, twice, then their lead.
   */
  remind?: { afterHours: number; times: number; escalate?: string };
  /**
   * The register: one card with what is open, how old, and each request to open. It is posted
   * on `days` at `at` (HH:MM) to `to` ("space:<name>", "role:<key>" or "owner"), replacing the
   * one before; anyone involved asks for it by writing "register" to the bot.
   */
  register?: { to?: string; at?: string; days?: number[]; columns?: string[] };
}

/** One thing that happened to a tracked request. */
export interface BotItemEvent {
  at: number;
  /** Who did it (null: the bot itself, e.g. a reminder). */
  by: string | null;
  /** The stage it happened at. */
  stage: string | null;
  /** start, an action's id, withdraw, takeover, nudge, escalate, seat (moved up the queue). */
  action: string;
  /** The words for it ("Return with comments", "Reminder"). */
  label: string;
  note?: string;
  /** The stage it went to (or "end"). */
  to?: string | null;
}

export type BotItemStatus = 'open' | 'done' | 'stopped' | 'withdrawn';

/** A request being tracked, as the hub keeps it (the same state the bot maker's test run plays). */
export interface BotItem {
  id: string;
  flow: string;
  /** DC-0007 */
  ref: string;
  /** Its one-line name. */
  title: string;
  requesterId: string;
  stage: string | null;
  /** The person acting now. */
  actorId: string | null;
  /** Why the actor is who they are, when it is not the plain rule ("delegate of Ravi Kumar"). */
  actorNote?: string | null;
  status: BotItemStatus;
  stamp: string | null;
  /** The answers (and the person who asked), as the steps left them. */
  vars: Record<string, BotFlowAnswer>;
  lines: Array<{ label: string; value: string }>;
  /** When it reached the stage it is in. */
  since: number;
  due: number | null;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  history: BotItemEvent[];
  /** The checklist lines ticked at this stage (by position). */
  checks: number[];
  /** Reminders sent at this stage, and whether it was passed up. */
  nudges: number;
  escalated: boolean;
  /** Waiting for a place in a stage with a limit. */
  waiting: boolean;
  /** Times each stage was reached (round 2 of Check is the back-check). */
  rounds: Record<string, number>;
}

/** A bot as its conversation's header shows it. */
export interface BotAbout {
  botId: string;
  title: string;
  about: string | null;
  /** The member who made it; null for the office's own bots and integrations. */
  ownerId: string | null;
  source: BotFlowInfo['source'] | null;
  persona: BotPersona | null;
  hours: BotHours | null;
  openNow: boolean;
  /** What it can do here (its flows this person may start). */
  flows: Array<{ name: string; title: string }>;
  /** Tracked bots: requests open that this person may see, and those waiting for them. */
  tracked: boolean;
  open: number;
  yours: number;
}

/** A tracked request as one card shows it to one person. */
export interface BotTrackView {
  itemId: string;
  flow: string;
  ref: string;
  title: string;
  status: BotItemStatus;
  stamp: string | null;
  /** The strip across the card: each stage on the main way, and where it is. */
  stages: Array<{ id: string; label: string; state: 'done' | 'here' | 'todo' | 'returned'; round?: number; bot?: BotStageBot }>;
  stage: { id: string; label: string; round: number; prompt: string; who: string | null; whoNote: string | null; since: number; due: number | null; overdue: boolean; checklist: string[]; checks: number[] } | null;
  requesterId: string;
  lines: Array<{ label: string; value: string }>;
  history: BotItemEvent[];
  /** What this person may press now. */
  actions: BotFlowStageAction[];
  /** This person: the one who asked, the one acting, or someone shown it (a lead, the register). */
  role: 'requester' | 'actor' | 'watcher';
  canWithdraw: boolean;
  canTakeOver: boolean;
  /** Waiting for a place: their position (1 = next), and who holds the places now. */
  queue: { position: number; of: number; key: string; holders: Array<{ userId: string; since: number; ref: string }> } | null;
  /** A newer card for this request is further down this conversation. */
  moved?: boolean;
  /** It is this person's turn, on a newer card further down (their first card only follows it). */
  turnBelow?: boolean;
  /** The bot maker's test run: whose part the maker plays at this stage ("Their lead"). */
  actingAs?: string;
  createdAt: number;
  closedAt: number | null;
}

/** The register: one consolidated card of a bot's requests. */
export interface BotRegisterView {
  flow: string;
  title: string;
  /** all: everything open; mine: what waits for this person (a reminder); team: passed up to a lead. */
  mode: 'all' | 'mine' | 'team';
  counts: { open: number; overdue: number; waiting: number; closedWeek: number };
  /** The oldest open request, in days. */
  oldestDays: number;
  byStage: Array<{ id: string; label: string; open: number; overdue: number }>;
  /** Stages with a limit: each queue's places. */
  seats: Array<{ key: string; seats: number; used: Array<{ userId: string; since: number; ref: string; itemId: string }>; waiting: Array<{ userId: string; since: number; ref: string; itemId: string }> }>;
  rows: BotTrackView[];
  /** How many open requests there are beyond the rows shown. */
  more: number;
  /** Recently closed. */
  closed: Array<{ itemId: string; ref: string; title: string; stamp: string | null; status: BotItemStatus; closedAt: number }>;
  columns: string[];
  at: number;
  moved?: boolean;
}

export interface BotFlowInfo {
  name: string;
  title: string;
  description: string | null;
  command: string | null;
  botId: string;
  botName: string;
  enabled: boolean;
  /** Who keeps it: an integration through the Bot API, an administrator, or the hub itself. */
  source: 'api' | 'admin' | 'builtin' | 'member';
  steps: number;
  updatedAt: number;
  persona: BotPersona | null;
  /** The member who made it (member-made bots). */
  ownerId: string | null;
  scope: BotScope;
  /** scope "space": the Space whose people can start it. */
  spaceId: string | null;
  status: BotStatus;
  /** The revision new runs use (runs in progress keep the one they started on). */
  version: number;
  /** Waiting for an administrator: sharing it office-wide, or a newer revision of an office-wide bot. */
  requested: 'office' | null;
  /** The revision waiting for review, when there is one. */
  pendingVersion: number | null;
  /** Open for new requests now (its hours). */
  openNow: boolean;
}

/** A bot you made, with what you edit and the last review. */
export interface BotMakerBot extends BotFlowInfo {
  /** The newest revision (the one waiting for review, if any; otherwise the live one). */
  definition: BotFlowDefinition;
  runs: number;
  finished: number;
  review: { approved: boolean; note: string | null; by: string | null; at: number } | null;
}

/** How a bot is used: for its maker (and administrators). Answers are never shown here. */
export interface BotStats {
  runs: number;
  finished: number;
  cancelled: number;
  expired: number;
  active: number;
  /** For each step of the live revision: runs that reached it, and runs that stopped there (cancelled or expired). */
  steps: Array<{ id: string; label: string; reached: number; stopped: number; waiting: number }>;
  /** Newest first. Who ran it is shown only for finished runs (they sent it to you anyway). */
  recent: Array<{ at: number; status: BotSession['status']; reached: number; userId: string | null; version: number }>;
  versions: Array<{ version: number; at: number; by: string | null }>;
}

export interface BotFlowAnswer { value: string; label: string }

/** A conversation in progress with an integration, kept on the hub. */
export interface BotSession {
  id: string;
  botId: string;
  userId: string;
  /** The hub-run flow; null for an integration that keeps its own logic. */
  flow: string | null;
  convId: string;
  originConvId: string | null;
  step: string | null;
  /** Steps answered so far, oldest first (Back returns to the last one). */
  history: string[];
  answers: Record<string, BotFlowAnswer>;
  /** Variables (hub-run flows) or the integration's own data. */
  data: Record<string, unknown>;
  status: 'active' | 'done' | 'cancelled' | 'expired';
  startedAt: number;
  updatedAt: number;
  expiresAt: number;
}

/** What a message from an integration shows as an interactive card. */
export interface BotFlowCard {
  kind: 'step' | 'resume' | 'menu' | 'offer' | 'summary' | 'done' | 'track' | 'register' | 'relay';
  botId: string;
  sessionId: string | null;
  /** Whose conversation it is: only they can answer. */
  ownerId: string | null;
  title: string;
  /** step and resume: the position, e.g. step 3 of 5 (the total follows the answers so far). */
  stepId?: string;
  stepNo?: number;
  stepCount?: number;
  prompt?: string;
  input?: BotFlowInput;
  /** active: waiting for an answer here; moved: continued in a later card (Back or Resume). */
  state:'active' | 'answered' | 'moved' | 'done' | 'cancelled' | 'expired';
  answer?: BotFlowAnswer | null;
  /** The answer given earlier, after Back. */
  previous?: BotFlowAnswer | null;
  canBack?: boolean;
  /** menu and offer: flows that can be started from here. */
  flows?: Array<{ name: string; title: string; description: string | null }>;
  /** summary and done: the answers. */
  lines?: Array<{ label: string; value: string }>;
  /** done: what happened at the end (a task created, a message posted), and anything that failed. */
  notes?: string[];
  /** summary: who asked (a task handed to someone else). */
  requesterId?: string;
  /** A member-made bot's mark and colour, for the card's title strip. */
  persona?: Pick<BotPersona, 'mark' | 'colour'> | null;
  /** step: the bot's greeting, on the first step of a fresh start. */
  intro?: string;
  /** step: this person's answer last time, offered as a one-tap default. */
  lastTime?: BotFlowAnswer | null;
  /** step: the bot's own words for "Same as last time". */
  lastTimeWords?: string;
  /** step: a default from the office's records (the person's lead), offered as one tap. */
  suggested?: BotFlowAnswer | null;
  suggestedWhy?: 'lead';
  /** done (a tracked bot) and track: the request as it stands now (the card follows it live). */
  track?: BotTrackView | null;
  /** register: the bot's requests in one card. */
  register?: BotRegisterView | null;
  /** relay: bots asking and handing to each other for this person, as a loop diagram. */
  relay?: BotRelayView | null;
  /** resume: when the conversation was started and last touched. */
  startedAt?: number;
  updatedAt?: number;
  expiresAt?: number;
}

// ---------------------------------------------------------------- bots talking to bots (docs/BOT-NETWORK.md)
/** The kinds of value a skill takes and gives. */
export type BotSkillKind = 'text' | 'number' | 'person' | 'date' | 'yesno' | 'list';
export interface BotSkillField { id: string; label: string; kind: BotSkillKind; optional?: boolean; options?: string[] }

/**
 * A question (or, with effect "act", a small errand) a bot publishes for other bots: named inputs
 * and outputs. Tracked bots publish theirs from their own stages (how many are open, is a seat
 * free, release my seats); Nib, the Directory and the office calendar publish system skills.
 */
export interface BotSkill {
  /** "<bot>.<skill>": licence-seat.seats, nib.away, directory.lead */
  id: string;
  /** The bot that answers: a flow's name, or nib, directory, calendar. */
  bot: string;
  botTitle: string;
  /** The question as the maker reads it ("Is a seat free?"). */
  title: string;
  /** The caption on the relay line ("SEAT?"). */
  short: string;
  about: string;
  inputs: BotSkillField[];
  outputs: BotSkillField[];
  /** The output that answers it in a word (the step's own answer). */
  main: string;
  /** read: asks; act: changes something, only for the person the flow runs for. */
  effect: 'read' | 'act';
  /** Nib, the Directory and the calendar. */
  system?: boolean;
  /** Any bot in the office may ask it (an office-wide bot that shares its skills). */
  public?: boolean;
}

/** A step (or a job) asking a skill. `with` fills its inputs from {{placeholders}}. */
export interface BotAsk {
  skill: string;
  with?: Record<string, string>;
  /** When the other bot cannot answer: ask the person the step's own question (default), carry on without it, or stop. */
  onFail?: 'ask' | 'skip' | 'stop';
}

/** Handing a request to another bot: the answers it carries, where it starts there, and what happens when it comes back. */
export interface BotHandoff {
  /** The other bot's flow name. */
  to: string;
  /** Its answers, keyed by its step variables, from this bot's {{placeholders}}. Left out: answers with the same names. */
  carry?: Record<string, string>;
  /** A stage of the other bot's track to start at (its earlier stages already happened here). */
  start?: string;
  /** A stage waiting on the bot: the button pressed when it comes back done, or stopped. */
  back?: { done?: string; stopped?: string };
}

/** Listening to another bot ("when a DC request is issued", "when someone goes on leave"). */
export interface BotSubscription {
  id: string;
  /** "<flow>.opened", "<flow>.closed", "<flow>.stage.<stage id>", or "nib.away". */
  on: string;
  /** closed: only with this stamp ("ISSUED"). */
  stamp?: string;
  /** start: this bot's flow for the person it is about; tell: a line to this bot's maker; ask: a skill of another bot. */
  do: 'start' | 'tell' | 'ask';
  carry?: Record<string, string>;
  text?: string;
  ask?: BotAsk;
}

export interface BotNetwork {
  /**
   * Whose bots may ask its skills: the bots of anyone who may use it (users, the default; for an
   * office-wide bot that is every bot in the office), or only its maker's own bots (owner).
   */
  share?: 'owner' | 'users';
  /** Takes requests handed over by other bots (on unless set false). */
  accept?: boolean;
  on?: BotSubscription[];
}

/** One stage cell that waits on another bot: its mark and how its request stands now. */
export interface BotStageBot { flow: string; title: string; mark: BotMark | null; colour: BotColour | null; ref: string | null; label: string; status: 'pending' | 'open' | 'done' | 'stopped' | 'failed' }

export type BotLinkKind = 'query' | 'handoff' | 'event';
export type BotLinkStatus = 'pending' | 'ok' | 'returned' | 'refused' | 'failed' | 'timeout' | 'loop' | 'limited';

/** One hop between bots, as a relay card or the network sheet shows it. */
export interface BotHop {
  id: string;
  kind: BotLinkKind;
  from: string;
  to: string;
  /** What was asked or handed over ("SEAT? CAESAR II", "PLT · ISO-1001 rev C"). */
  ask: string;
  /** What came back ("1 free", "PLT-0004"), or null while it waits. */
  answer: string | null;
  status: BotLinkStatus;
  /** Why it was refused or failed, in plain words. */
  reason: string | null;
  at: number;
  ms: number | null;
  /** A handoff that came back: when, the stamp and the last note. */
  back: { at: number; stamp: string | null; words: string } | null;
  /** The other bot's request number, for a handoff. */
  ref: string | null;
  canRetry: boolean;
}

/** A bot as an instrument tag on a drawing. */
export interface BotTag { key: string; title: string; mark: BotMark | null; colour: BotColour | null; tag: string; system: boolean; /** Its identity in conversations (to open its conversation). */ botId: string | null }

export interface BotRelayView {
  group: string;
  tags: BotTag[];
  hops: BotHop[];
  /** A newer relay card for this run is further down this conversation. */
  moved?: boolean;
}

/** The bot network sheet: every bot as a tag, connections as routed lines weighted by traffic. */
export interface BotNetMap {
  scope: 'mine' | 'office';
  nodes: Array<BotTag & { ownerId: string | null; scopeOf: BotScope | 'system'; mine: boolean }>;
  edges: Array<{ from: string; to: string; kinds: BotLinkKind[]; declared: boolean; count: number; failures: number; lastAt: number | null }>;
  at: number;
}

export interface BotNetExchange { id: string; kind: BotLinkKind; at: number; ask: string; answer: string | null; status: BotLinkStatus; reason: string | null; ms: number | null; userId: string | null }

// ---------------------------------------------------------------- scheduled bot jobs
/** Who a job is for: the people of a Space, a department, named people, or the maker's own team. */
export type BotJobPeople =
  | { from: 'space'; space: string }
  | { from: 'department'; department: string }
  | { from: 'people'; people: string[] }
  | { from: 'team' };

export type BotJobAction =
  /** Start this bot's conversation for each person ("ask the Piping team for timesheet hours"). */
  | { do: 'start'; people: BotJobPeople }
  /** Post the bot's register (tracked bots), where its register goes. */
  | { do: 'register' }
  /** Ask a skill; act only when the condition holds ("if any TQ is older than 10 days, tell the lead"). */
  | { do: 'check'; ask: BotAsk; if: BotFlowCondition; tell: string; text: string }
  /** Ask a skill and post the answer. */
  | { do: 'ask'; ask: BotAsk; tell: string; text: string }
  /** A reminder on each person's Desk. */
  | { do: 'remind'; people: BotJobPeople; text: string };

export interface BotJob {
  id: string;
  title: string;
  /** The schedule in plain words ("every weekday at 9:15"); parsed the same way on every PC and the hub. */
  when: string;
  do: BotJobAction;
  /** When the hub was off at the time: skip the runs it missed, or catch up once. */
  missed?: 'skip' | 'once';
  /** Leave people who are on leave that day out (on unless set false). */
  leave?: boolean;
}

export type BotJobOutcome = 'RAN' | 'SKIPPED' | 'FAILED' | 'DRY';

export interface BotJobRun {
  id: string;
  flow: string;
  job: string;
  /** When it was due. */
  at: number;
  ranAt: number;
  outcome: BotJobOutcome;
  /** In plain words: "Started for 6 people; 1 on leave left out", "the hub was off". */
  note: string;
  /** What it did or would do (a dry run lists it). */
  lines: string[];
  by: string | null;
}

/** A job's lane on the job sheet. */
export interface BotJobLane {
  flow: string;
  job: string;
  title: string;
  botTitle: string;
  mark: BotMark | null;
  colour: BotColour | null;
  ownerId: string | null;
  when: string;
  /** What was understood, in words ("Every Monday at 10:00"). */
  words: string;
  paused: boolean;
  /** The next run that will be skipped (Skip next). */
  skipAt: number | null;
  /** Runs moved once: from → to. */
  moved: Array<{ from: number; to: number }>;
  next: number[];
  past: BotJobRun[];
  /** Why it cannot run (its bot is paused, a Space is gone). */
  problem: string | null;
  canEdit: boolean;
}

export interface BotJobSheet { scope: 'mine' | 'office' | 'bot'; from: number; to: number; lanes: BotJobLane[]; holidays: Array<{ date: string; name: string }>; now: number; tzOffset: number }

// ---------------------------------------------------------------- tools (mini-apps)
/** What a tool may do. Every use of `post` and `files` is confirmed by the person. */
export type MiniAppPermission = 'members' | 'post' | 'state' | 'files' | 'network';
export const MINIAPP_PERMISSIONS: MiniAppPermission[] = ['members', 'post', 'state', 'files', 'network'];

export interface MiniAppInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  permissions: MiniAppPermission[];
  /** Hosts the tool asked to reach (https://host[:port]); `hosts` are the ones the administrator granted. */
  requestedHosts: string[];
  hosts: string[];
  status: 'pending' | 'approved' | 'rejected';
  enabled: boolean;
  builtin: boolean;
  /** Height of its card in the timeline, in pixels. */
  height: number;
  size: number;
  sha256: string;
  uploadedBy: string | null;
  uploadedAt: number;
  reviewedBy: string | null;
  reviewedAt: number | null;
  note: string | null;
}

/** A tool added to a conversation: shown in its message as a sheet-framed card. */
export interface MiniAppView {
  instanceId: string;
  appId: string;
  name: string;
  version: string;
  description: string;
  height: number;
  permissions: MiniAppPermission[];
  hosts: string[];
  /** False when an administrator turned the tool off (the card then says so). */
  available: boolean;
  addedBy: string;
  stateVersion: number;
}

export interface MiniAppState {
  instanceId: string;
  convId: string;
  state: unknown;
  version: number;
  updatedBy: string | null;
  updatedAt: number | null;
}

/** The largest shared state of one tool in one conversation (JSON, UTF-8 bytes). */
export const MINIAPP_STATE_MAX = 64 * 1024;

// ---------------------------------------------------------------- operations and events
export interface BotOps {
  /** Flows people can start (enabled, from active integrations). */
  'botflow.list': { req: void; res: BotFlowInfo[] };
  /** Start a flow: its first card appears in your Direct conversation with the integration. */
  'botflow.start': { req: { flow: string; convId?: string }; res: { sessionId: string; convId: string; resumed: boolean } };
  'botflow.answer': { req: { sessionId: string; stepId: string; value: string }; res: { ok: true; done: boolean } };
  'botflow.back': { req: { sessionId: string }; res: { ok: true } };
  'botflow.cancel': { req: { sessionId: string }; res: { ok: true } };
  /** Bring the current step back to the bottom of the conversation, or begin again. */
  'botflow.resume': { req: { sessionId: string; over?: boolean }; res: { ok: true } };
  /** Your conversations in progress. */
  'botflow.sessions': { req: void; res: BotSession[] };
  'admin.botflows.list': { req: void; res: Array<BotFlowInfo & { definition: BotFlowDefinition; pending: BotFlowDefinition | null }> };
  /** Author a flow for an integration in the Control room. */
  'admin.botflows.save': { req: { botId: string; definition: BotFlowDefinition }; res: BotFlowInfo };
  'admin.botflows.enable': { req: { name: string; enabled: boolean }; res: BotFlowInfo };
  'admin.botflows.remove': { req: { name: string }; res: { ok: true } };
  /** Post a card with a Start button into a conversation you are in. */
  'botflow.offer': { req: { flow: string; convId: string }; res: Message };
  /** The bots you made (any member). */
  'botflow.mine': { req: void; res: BotMakerBot[] };
  /**
   * Make or change your own bot. "office" is asked of an administrator (the bot stays as it was
   * until then); `baseVersion` refuses the save when someone saved a newer revision meanwhile;
   * `newBot` gives a new bot the next free short name when its own is taken.
   */
  'botflow.make': { req: { definition: BotFlowDefinition; scope: BotScope; spaceId?: string | null; baseVersion?: number; newBot?: boolean }; res: BotMakerBot };
  'botflow.status': { req: { name: string; status: BotStatus }; res: BotFlowInfo };
  'botflow.delete': { req: { name: string }; res: { ok: true } };
  'botflow.stats': { req: { name: string }; res: BotStats };
  /** A bot you can start, to duplicate and change. */
  'botflow.definition': { req: { name: string }; res: { definition: BotFlowDefinition } };
  /** Act on a tracked request at the stage it is in: one of its buttons, with a note when asked. */
  'botflow.act': { req: { itemId: string; action: string; note?: string; checks?: number[] }; res: { ok: true; track: BotTrackView } };
  /** Tick or untick a line of the stage's checklist (the person acting). */
  'botflow.tick': { req: { itemId: string; index: number; on: boolean }; res: { ok: true; track: BotTrackView } };
  /** The person who asked takes it back while it is open. */
  'botflow.withdraw': { req: { itemId: string; note?: string }; res: { ok: true; track: BotTrackView } };
  /** A lead it was passed up to (or the bot's maker) takes over the stage it is waiting at. */
  'botflow.takeover': { req: { itemId: string }; res: { ok: true; track: BotTrackView } };
  /** A tracked bot's register as this person may see it; with `post`, also as a card in their conversation with the bot. */
  'botflow.register': { req: { flow: string; post?: boolean }; res: { register: BotRegisterView; convId?: string } };
  /** What a bot's conversation header shows: who made it, what it is for, its hours, and its requests. */
  'botflow.about': { req: { botId: string }; res: BotAbout };
  /** One request, as this person may see it. */
  'botflow.item': { req: { itemId: string }; res: { track: BotTrackView } };
  /** Forget the answers a bot remembers for you. */
  'botflow.forget': { req: { name: string }; res: { ok: true } };
  /** Marks and colours of member-made bots (for their tiles in conversations). */
  'botflow.marks': { req: void; res: Array<{ botId: string; name: string; mark: BotMark; colour: BotColour }> };
  /** Approve or turn down a member's bot for the whole office (or a newer revision of one). */
  'admin.botflows.review': { req: { name: string; approve: boolean; note?: string }; res: BotFlowInfo };

  /** Skills this person's bots may ask (the maker's blocks): the system's, their own bots', and office-wide ones. */
  'botnet.skills': { req: { flow?: string }; res: BotSkill[] };
  /** Ask a skill now as yourself (the bot maker's test run; an errand is described, not done). */
  'botnet.try': { req: { skill: string; with?: Record<string, string> }; res: { ok: boolean; answer: BotFlowAnswer | null; values: Record<string, BotFlowAnswer>; words: string; reason: string | null } };
  /** Ask a failed hop again (the person it was for). */
  'botnet.retry': { req: { hopId: string }; res: { ok: true; hop: BotHop } };
  /** The bot network sheet: your own bots, or (administrators) the whole office. */
  'botnet.map': { req: { scope?: 'mine' | 'office' }; res: BotNetMap };
  /** Recent exchanges along one line of the sheet. */
  'botnet.edge': { req: { from: string; to: string; scope?: 'mine' | 'office' }; res: { exchanges: BotNetExchange[] } };
  /** The job sheet: one bot's jobs, your bots' jobs, or (administrators) the office's. */
  'botjob.sheet': { req: { scope?: 'mine' | 'office' | 'bot'; flow?: string; from?: number; to?: number }; res: BotJobSheet };
  /** Pause or resume a job, skip its next run, or move one run once. */
  'botjob.set': { req: { flow: string; job: string; paused?: boolean; skipNext?: boolean; unskip?: boolean; move?: { from: number; to: number } | null }; res: BotJobLane };
  /** Run a job now, or a dry run that shows what it would do without sending anything. */
  'botjob.run': { req: { flow: string; job: string; dry?: boolean }; res: BotJobRun };
  /** A job's run history, newest first. */
  'botjob.history': { req: { flow: string; job: string }; res: BotJobRun[] };
  /** The office's holidays (jobs and reminders skip them) and its working days. */
  'botjob.calendar': { req: void; res: { holidays: Array<{ date: string; name: string }>; workdays: number[]; tzOffset: number; hours: { from: string; to: string } } };
  'admin.botjob.holidays': { req: { holidays: Array<{ date: string; name: string }> }; res: { holidays: Array<{ date: string; name: string }> } };

  /** Tools members may add (approved and switched on). */
  'miniapp.list': { req: void; res: MiniAppInfo[] };
  /** Add a tool to a conversation: a message with its card. */
  'miniapp.add': { req: { convId: string; appId: string; clientId: string }; res: Message };
  /** The tool's page and its sandbox policy (the app loads it into a sandboxed frame). */
  'miniapp.bundle': { req: { instanceId: string }; res: { html: string; csp: string; appId: string; version: string } };
  'miniapp.state.get': { req: { instanceId: string }; res: MiniAppState };
  /** Last writer wins; `version` grows by one each write. `conflict` is true when someone wrote since `baseVersion`. */
  'miniapp.state.set': { req: { instanceId: string; state: unknown; baseVersion?: number }; res: MiniAppState & { conflict: boolean } };
  'admin.miniapps.list': { req: void; res: MiniAppInfo[] };
  /** Upload a bundle (a .zip or a single .html file already sent to /files). */
  'admin.miniapps.upload': { req: { fileId: string }; res: MiniAppInfo };
  'admin.miniapps.review': { req: { id: string; approve: boolean; hosts?: string[]; note?: string }; res: MiniAppInfo };
  'admin.miniapps.enable': { req: { id: string; enabled: boolean }; res: MiniAppInfo };
  /** The bundle's page, for reading it before approving. */
  'admin.miniapps.source': { req: { id: string }; res: { html: string } };
}

export interface BotEvents {
  /** A tool's shared state changed (to everyone in its conversation). */
  'miniapp.state': MiniAppState;
  /** The tools on offer changed (approved, switched off). */
  'miniapp.catalog': { changed: true };
  'botflow.catalog': { changed: true };
  /** A message passed between bots (to administrators and the makers of both bots): the network sheet pulses. */
  'botnet.pulse': { from: string; to: string; kind: BotLinkKind; status: BotLinkStatus; at: number };
  /** A job ran, was skipped, failed or was changed (to its maker and administrators). */
  'botjob.changed': { flow: string; job: string };
}

/** Files a tool may be shown (a conversation's shared files). */
export type MiniAppFile = Pick<FileInfo, 'id' | 'name' | 'mime' | 'size' | 'createdAt'>;
