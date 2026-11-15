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
}

export type BotFlowAction =
  /** Post a message: into the conversation the flow was started from, a Space, or to a person (a person variable). */
  | { do: 'post'; to: 'origin' | `space:${string}` | `person:${string}`; text: string }
  /** Call the integration's webhook with every answer. */
  | { do: 'webhook' }
  /** A task on someone's Desk: the person in `assignee` (a person variable). `due` names a date variable, or `dueInDays` counts from today. */
  | { do: 'task'; assignee: string; text: string; due?: string; dueInDays?: number }
  /** A reminder on the Desk of the person who answered. `due` names a date variable, or `dueInDays` counts from today. */
  | { do: 'remind'; text: string; due?: string; dueInDays?: number };

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
export type BotGlyph = 'sheet' | 'plotter' | 'helmet' | 'level' | 'flange' | 'beam' | 'calendar' | 'stamp' | 'compass' | 'clipboard' | 'pin' | 'rfi';
export const BOT_GLYPHS: BotGlyph[] = ['sheet', 'plotter', 'helmet', 'level', 'flange', 'beam', 'calendar', 'stamp', 'compass', 'clipboard', 'pin', 'rfi'];

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
  kind: 'step' | 'resume' | 'menu' | 'offer' | 'summary' | 'done';
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
  /** resume: when the conversation was started and last touched. */
  startedAt?: number;
  updatedAt?: number;
  expiresAt?: number;
}

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
   * until then); `baseVersion` refuses the save when someone saved a newer revision meanwhile.
   */
  'botflow.make': { req: { definition: BotFlowDefinition; scope: BotScope; spaceId?: string | null; baseVersion?: number }; res: BotMakerBot };
  'botflow.status': { req: { name: string; status: BotStatus }; res: BotFlowInfo };
  'botflow.delete': { req: { name: string }; res: { ok: true } };
  'botflow.stats': { req: { name: string }; res: BotStats };
  /** A bot you can start, to duplicate and change. */
  'botflow.definition': { req: { name: string }; res: { definition: BotFlowDefinition } };
  /** Forget the answers a bot remembers for you. */
  'botflow.forget': { req: { name: string }; res: { ok: true } };
  /** Marks and colours of member-made bots (for their tiles in conversations). */
  'botflow.marks': { req: void; res: Array<{ botId: string; name: string; mark: BotMark; colour: BotColour }> };
  /** Approve or turn down a member's bot for the whole office (or a newer revision of one). */
  'admin.botflows.review': { req: { name: string; approve: boolean; note?: string }; res: BotFlowInfo };

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
}

/** Files a tool may be shown (a conversation's shared files). */
export type MiniAppFile = Pick<FileInfo, 'id' | 'name' | 'mime' | 'size' | 'createdAt'>;
