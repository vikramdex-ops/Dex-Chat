// Automations: rules that run when something happens in a conversation. A rule is a small graph
// drawn as a schematic: one trigger, then conditions (all must hold), then actions run in order.
// The hub stores and runs rules; the app draws and edits them. Everything here is plain data and
// pure functions, so the hub, the app and the describe-to-rule drafter share one definition.

/** A person, a group (a department and the departments under it), or someone the event names. */
export type PersonRef =
  | { kind: 'user'; id: string }
  | { kind: 'group'; id: string }
  /** author: who wrote the message; actor: who reacted or responded; owner: who owns the rule. */
  | { kind: 'role'; id: 'author' | 'actor' | 'owner' };

export type FlowTrigger =
  /** A reaction added to a message, optionally only on messages written by some people. */
  | { kind: 'reaction.added'; emoji: string; by?: PersonRef[] }
  /** A file attached to a new message, optionally only some file types or names. */
  | { kind: 'file.added'; types?: string[]; namePattern?: string }
  /** Someone confirmed a response: a vote in a poll, an answer to a form, or the end of their path through a Decision. */
  | { kind: 'response.confirmed'; source?: 'poll' | 'form' | 'decision' | 'any'; choice?: string }
  /** A new message with any of the keywords (comma separated), or matching a regular expression. */
  | { kind: 'message.matched'; mode: 'keywords' | 'regex'; pattern: string; caseSensitive?: boolean }
  /** A new message that mentions one of these people, or anyone in these groups. */
  | { kind: 'message.mentioned'; targets: PersonRef[] };

export type FlowCondition =
  | { kind: 'conversation'; convIds: string[] }
  | { kind: 'author'; people: PersonRef[]; exclude?: boolean }
  /** Days 0 (Sunday) to 6; from/to as HH:MM on the hub's clock (the same time for both: all day). outside: only outside these hours. */
  | { kind: 'time'; days: number[]; from: string; to: string; outside?: boolean }
  | { kind: 'file'; types?: string[]; namePattern?: string };

export type FlowAction =
  /** A Direct message from the system bot, with a link to where it happened. */
  | { kind: 'notify'; to: PersonRef[]; text: string }
  /** A message from the Automations bot; convId null means the conversation where it happened. */
  | { kind: 'post'; convId: string | null; text: string }
  /** A reminder on someone's Desk, or the message kept on their Desk as a To do. */
  | { kind: 'task'; to: PersonRef[]; text: string; mode: 'reminder' | 'todo'; dueInMinutes: number }
  /** A #tag on the message (found by #tag search like one written in the text). */
  | { kind: 'tag'; tag: string }
  /** POST to a web address; the reply's status and text become {{webhook.status}} and {{webhook.reply}}. */
  | { kind: 'webhook'; url: string; body: string }
  /** Read the attached PDF's title block: {{file.title}}, {{file.revision}}, {{file.number}}, {{file.pages}}. */
  | { kind: 'extract' };

export type TriggerKind = FlowTrigger['kind'];
export type ConditionKind = FlowCondition['kind'];
export type ActionKind = FlowAction['kind'];

export type TriggerNode = FlowTrigger & { id: string };
export type ConditionNode = FlowCondition & { id: string };
export type ActionNode = FlowAction & { id: string };

export interface FlowGraph {
  trigger: TriggerNode;
  conditions: ConditionNode[];
  actions: ActionNode[];
}

export interface Flow {
  id: string;
  name: string;
  /** The conversation it watches; null for an office-wide rule (every Space). */
  convId: string | null;
  /** The Space's name ("Direct conversation" for a Direct one); null for an office-wide rule. */
  convName: string | null;
  ownerId: string;
  enabled: boolean;
  /** Goes up by one with every saved change. */
  version: number;
  graph: FlowGraph;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
  lastRun: FlowRun | null;
  /** May the viewer change it? */
  canManage: boolean;
}

export interface FlowStep {
  nodeId: string;
  kind: ActionKind;
  status: 'done' | 'failed' | 'skipped' | 'would';
  note: string;
}

export interface FlowRun {
  id: string;
  flowId: string;
  at: number;
  /** limited: more than the rule may run in a minute; the event was let go. */
  outcome: 'ok' | 'failed' | 'limited';
  error: string | null;
  /** What happened, in a few words ("Priya shared GA-101.pdf in Design"). */
  event: string;
  messageId: string | null;
  convId: string | null;
  steps: FlowStep[];
}

/** A pretend event for a test run: a real message from the conversation, or made-up details. */
export interface FlowSample {
  messageId?: string;
  text?: string;
  fileName?: string;
  emoji?: string;
  choice?: string;
  authorId?: string;
}

export interface FlowDryRun {
  matched: boolean;
  /** Why it would not run (the trigger or a condition did not match). */
  reason: string | null;
  event: string;
  steps: FlowStep[];
  variables: Record<string, string>;
}

/** What happened in a conversation, as the hub's messaging tells the rule engine. */
export type FlowEvent =
  | { kind: 'message.new'; messageId: string; convId: string; authorId: string }
  | { kind: 'reaction.added'; messageId: string; convId: string; userId: string; emoji: string }
  | { kind: 'response.confirmed'; messageId: string; convId: string; userId: string; source: 'poll' | 'form' | 'decision'; choice: string; answers?: Record<string, string | string[]> };

export interface FlowOps {
  /** Rules for one conversation (members), the office-wide rules, or every rule (administrators). */
  'flow.list': { req: { convId?: string; scope?: 'conversation' | 'office' | 'all' }; res: Flow[] };
  /** Create (no id) or change a rule; version must match the stored one when changing. */
  'flow.save': { req: { id?: string; convId: string | null; name: string; graph: FlowGraph; enabled?: boolean; version?: number }; res: Flow };
  'flow.enable': { req: { id: string; enabled: boolean }; res: Flow };
  'flow.delete': { req: { id: string }; res: { ok: true } };
  'flow.runs': { req: { id: string }; res: FlowRun[] };
  /** Show what a rule would do with a sample event, without doing it. */
  'flow.test': { req: { convId: string | null; graph: FlowGraph; sample: FlowSample }; res: FlowDryRun };
  /** Whether webhooks may call addresses on the office network (administrators change it). */
  'admin.flows.settings': { req: { allowLan?: boolean } | void; res: { allowLan: boolean } };
}

export interface FlowEvents {
  'flow.updated': Flow;
  'flow.removed': { id: string; convId: string | null };
  'flow.ran': { flowId: string; run: FlowRun };
}

// ------------------------------------------------------------------ limits

export const FLOW_LIMITS = {
  conditions: 6,
  actions: 8,
  people: 50,
  text: 2000,
  pattern: 200,
  /** Message text a pattern is tried against. */
  subject: 4000,
  name: 80,
  webhookBody: 16 * 1024,
  runsKept: 50,
  runsPerMinute: 30,
  rulesPerConversation: 50,
  rulesOffice: 100,
} as const;

export class FlowError extends Error {}

// ------------------------------------------------------------------ helpers

/** The extension of a file name, lower case, without the dot ('' when there is none). */
export function fileTypeOf(name: string): string {
  return name.toLowerCase().match(/\.([a-z0-9]{1,10})$/)?.[1] ?? '';
}

/** A file name pattern with * and ? (case-insensitive), or plain text found anywhere in the name. */
export function nameMatches(pattern: string, name: string): boolean {
  const p = pattern.trim();
  if (!p) return true;
  if (!/[*?]/.test(p)) return name.toLowerCase().includes(p.toLowerCase());
  const re = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return re.test(name);
}

/**
 * Is this regular expression safe to run on the hub? Long patterns, back-references, look-arounds
 * and repeated groups that themselves repeat or branch (the shapes that can take exponential time)
 * are refused. Returns the reason, or null when it is fine.
 */
export function unsafeRegex(pattern: string): string | null {
  if (!pattern) return 'Write a pattern.';
  if (pattern.length > FLOW_LIMITS.pattern) return `Keep the pattern under ${FLOW_LIMITS.pattern} characters.`;
  if (/\\[1-9]|\\k</.test(pattern)) return 'Back-references are not allowed in patterns.';
  if (/\(\?<?[=!]/.test(pattern)) return 'Look-ahead and look-behind are not allowed in patterns.';
  try { new RegExp(pattern); } catch { return 'That pattern is not a valid regular expression.'; }
  // walk the pattern: a group that repeats without limit may not hold an unlimited repeat or a choice
  const stack: Array<{ unbounded: boolean; branch: boolean }> = [];
  let quantifiers = 0;
  let lastGroup: { unbounded: boolean; branch: boolean } | null = null;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') { i++; lastGroup = null; continue; }
    if (ch === '[') {
      // skip a character class
      for (i++; i < pattern.length && pattern[i] !== ']'; i++) if (pattern[i] === '\\') i++;
      lastGroup = null;
      continue;
    }
    if (ch === '(') { stack.push({ unbounded: false, branch: false }); lastGroup = null; continue; }
    if (ch === ')') { lastGroup = stack.pop() ?? null; continue; }
    if (ch === '|') { if (stack.length) stack[stack.length - 1].branch = true; continue; }
    let unbounded = false;
    let quant = false;
    if (ch === '*' || ch === '+') { quant = true; unbounded = true; }
    else if (ch === '?') quant = !!pattern[i - 1] && !'(|'.includes(pattern[i - 1]);
    else if (ch === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
      if (m) {
        quant = true;
        if (Number(m[1]) > 1000 || (m[3] && Number(m[3]) > 1000)) return 'Repeat counts in patterns can be up to 1000.';
        unbounded = m[2] !== undefined && m[3] === '';
        i += m[0].length - 1;
      }
    }
    if (!quant) { lastGroup = null; continue; }
    if (++quantifiers > 20) return 'That pattern has too many repeats.';
    if (unbounded) {
      if (lastGroup && (lastGroup.unbounded || lastGroup.branch)) return 'A repeated group cannot contain another repeat or a choice (it can take too long to check).';
      for (const g of stack) g.unbounded = true;
    }
    lastGroup = null;
  }
  return null;
}

/** Keywords from a comma-separated list (quotes allowed around each). */
export function keywordList(pattern: string): string[] {
  return pattern.split(/[,\n]/).map((k) => k.trim().replace(/^["'“‘]|["'”’]$/g, '').trim()).filter(Boolean).slice(0, 30);
}

/**
 * Does the text match the trigger's keywords (as whole words) or regular expression? Returns
 * the matched text and its groups, or null.
 */
export function matchText(trigger: Extract<FlowTrigger, { kind: 'message.matched' }>, text: string): { text: string; groups: string[] } | null {
  const subject = text.slice(0, FLOW_LIMITS.subject);
  const flags = trigger.caseSensitive ? 'u' : 'iu';
  if (trigger.mode === 'regex') {
    if (unsafeRegex(trigger.pattern)) return null;
    let re: RegExp;
    try { re = new RegExp(trigger.pattern, trigger.caseSensitive ? '' : 'i'); } catch { return null; }
    const m = re.exec(subject);
    return m ? { text: m[0], groups: m.slice(1).map((g) => g ?? '') } : null;
  }
  for (const k of keywordList(trigger.pattern)) {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, flags).exec(subject);
    if (m) return { text: m[0], groups: [] };
  }
  return null;
}

/** Fill {{name}} placeholders; unknown names become empty. */
export function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-z][a-z0-9_.]*)\s*\}\}/gi, (_m, name: string) => vars[name.toLowerCase()] ?? '');
}

/** Placeholders a text uses. */
export function templateNames(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{\s*([a-z][a-z0-9_.]*)\s*\}\}/gi)].map((m) => m[1].toLowerCase()))];
}

/** Variables every event gives, and those each trigger and action adds. */
export const BASE_VARIABLES = ['conversation.name', 'conversation.link', 'message.text', 'message.link', 'author.name', 'actor.name', 'rule.name', 'now.date', 'now.time'];
export const TRIGGER_VARIABLES: Record<TriggerKind, string[]> = {
  'reaction.added': ['reaction.emoji'],
  'file.added': ['file.name', 'file.type', 'file.size'],
  'response.confirmed': ['response.choice', 'response.source'],
  'message.matched': ['match.text', 'match.1', 'match.2'],
  'message.mentioned': ['mention.names'],
};
export const ACTION_VARIABLES: Partial<Record<ActionKind, string[]>> = {
  extract: ['file.title', 'file.revision', 'file.number', 'file.pages'],
  webhook: ['webhook.status', 'webhook.reply'],
};

/** The variables an action can use: the event's, and those of the actions before it. */
export function variablesAt(graph: FlowGraph, actionIndex: number): string[] {
  const out = [...BASE_VARIABLES, ...TRIGGER_VARIABLES[graph.trigger.kind]];
  for (const a of graph.actions.slice(0, actionIndex)) out.push(...(ACTION_VARIABLES[a.kind] ?? []));
  if (graph.trigger.kind !== 'file.added' && graph.actions.slice(0, actionIndex).some((a) => a.kind === 'extract')) out.push('file.name', 'file.type', 'file.size');
  return [...new Set(out)];
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const isClock = (s: unknown): s is string => typeof s === 'string' && TIME_RE.test(s);
export const clockMinutes = (s: string): number => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

/** Is this moment inside the condition's days and hours (local time on the hub)? */
export function inTimeWindow(c: Extract<FlowCondition, { kind: 'time' }>, at: Date): boolean {
  const mins = at.getHours() * 60 + at.getMinutes();
  const from = clockMinutes(c.from);
  const to = clockMinutes(c.to);
  // a window past midnight (22:00–06:00) belongs to the day it started
  let day = at.getDay();
  let inside: boolean;
  if (from === to) inside = true;
  else if (from < to) inside = mins >= from && mins < to;
  else {
    inside = mins >= from || mins < to;
    if (mins < to) day = (day + 6) % 7;
  }
  inside = inside && c.days.includes(day);
  return c.outside ? !inside : inside;
}

/** A #tag as stored: letters first, then letters, digits, _ or -. */
export function cleanTag(raw: string): string | null {
  const t = raw.trim().replace(/^#/, '').toLowerCase();
  return /^[\p{L}][\p{L}\p{N}_-]{1,48}$/u.test(t) ? t : null;
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : '');
/** A node's id as given, or '' to have one assigned. */
const nodeId = (v: unknown, _fallback: string): string => (typeof v === 'string' && /^[a-z0-9_-]{1,24}$/i.test(v) ? v : '');

function people(v: unknown, label: string, required: boolean): PersonRef[] {
  const list = Array.isArray(v) ? v : [];
  const out: PersonRef[] = [];
  for (const raw of list.slice(0, FLOW_LIMITS.people)) {
    const r = raw as { kind?: unknown; id?: unknown };
    if (r?.kind === 'role' && (r.id === 'author' || r.id === 'actor' || r.id === 'owner')) out.push({ kind: 'role', id: r.id });
    else if ((r?.kind === 'user' || r?.kind === 'group') && typeof r.id === 'string' && /^[0-9A-Za-z_-]{1,40}$/.test(r.id)) out.push({ kind: r.kind, id: r.id });
  }
  const seen = new Set<string>();
  const unique = out.filter((p) => { const k = `${p.kind}:${p.id}`; if (seen.has(k)) return false; seen.add(k); return true; });
  if (required && !unique.length) throw new FlowError(`${label}: choose at least one person or group.`);
  return unique;
}

function types(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = [...new Set(v.map((t) => str(t, 12).toLowerCase().replace(/^\./, '')).filter((t) => /^[a-z0-9]{1,10}$/.test(t)))].slice(0, 20);
  return out.length ? out : undefined;
}

function trigger(raw: unknown): TriggerNode {
  const t = (raw ?? {}) as Record<string, unknown>;
  const id = nodeId(t.id, 't1');
  switch (t.kind) {
    case 'reaction.added': {
      const emoji = str(t.emoji, 40);
      if (!emoji) throw new FlowError('Reaction: choose the reaction to watch for.');
      const by = people(t.by, 'Reaction', false);
      return { id, kind: 'reaction.added', emoji, ...(by.length ? { by } : {}) };
    }
    case 'file.added': {
      const ty = types(t.types);
      const namePattern = str(t.namePattern, 120);
      return { id, kind: 'file.added', ...(ty ? { types: ty } : {}), ...(namePattern ? { namePattern } : {}) };
    }
    case 'response.confirmed': {
      const source = t.source === 'poll' || t.source === 'form' || t.source === 'decision' ? t.source : 'any';
      const choice = str(t.choice, 200);
      return { id, kind: 'response.confirmed', source, ...(choice ? { choice } : {}) };
    }
    case 'message.matched': {
      const mode = t.mode === 'regex' ? 'regex' : 'keywords';
      const pattern = str(t.pattern, FLOW_LIMITS.pattern + 1);
      if (!pattern) throw new FlowError(mode === 'regex' ? 'Message: write the pattern to look for.' : 'Message: write the words to look for.');
      if (pattern.length > FLOW_LIMITS.pattern) throw new FlowError(`Message: keep the pattern under ${FLOW_LIMITS.pattern} characters.`);
      if (mode === 'regex') { const why = unsafeRegex(pattern); if (why) throw new FlowError(`Message: ${why}`); }
      return { id, kind: 'message.matched', mode, pattern, ...(t.caseSensitive === true ? { caseSensitive: true } : {}) };
    }
    case 'message.mentioned':
      return { id, kind: 'message.mentioned', targets: people(t.targets, 'Mention', true) };
    default:
      throw new FlowError('Choose what starts the rule.');
  }
}

function condition(raw: unknown, i: number): ConditionNode {
  const c = (raw ?? {}) as Record<string, unknown>;
  const id = nodeId(c.id, `c${i + 1}`);
  switch (c.kind) {
    case 'conversation': {
      const ids = Array.isArray(c.convIds) ? [...new Set(c.convIds.filter((x): x is string => typeof x === 'string' && /^[0-9A-Z]{26}$/.test(x)))].slice(0, 50) : [];
      if (!ids.length) throw new FlowError('Conversation: choose at least one conversation.');
      return { id, kind: 'conversation', convIds: ids };
    }
    case 'author':
      return { id, kind: 'author', people: people(c.people, 'Author', true), ...(c.exclude === true ? { exclude: true } : {}) };
    case 'time': {
      const days = Array.isArray(c.days) ? [...new Set(c.days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [];
      if (!days.length) throw new FlowError('Time: choose at least one day.');
      if (!isClock(c.from) || !isClock(c.to)) throw new FlowError('Time: give the hours as HH:MM.');
      return { id, kind: 'time', days, from: c.from, to: c.to, ...(c.outside === true ? { outside: true } : {}) };
    }
    case 'file': {
      const ty = types(c.types);
      const namePattern = str(c.namePattern, 120);
      if (!ty && !namePattern) throw new FlowError('File: choose file types or a name pattern.');
      return { id, kind: 'file', ...(ty ? { types: ty } : {}), ...(namePattern ? { namePattern } : {}) };
    }
    default:
      throw new FlowError(`Condition ${i + 1}: choose what to check.`);
  }
}

function action(raw: unknown, i: number): ActionNode {
  const a = (raw ?? {}) as Record<string, unknown>;
  const id = nodeId(a.id, `a${i + 1}`);
  const text = (label: string, required = true) => {
    const t = typeof a.text === 'string' ? a.text.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim() : '';
    if (required && !t) throw new FlowError(`${label}: write the message.`);
    if (t.length > FLOW_LIMITS.text) throw new FlowError(`${label}: keep the message under ${FLOW_LIMITS.text} characters.`);
    return t;
  };
  switch (a.kind) {
    case 'notify':
      return { id, kind: 'notify', to: people(a.to, 'Notify', true), text: text('Notify') };
    case 'post': {
      const convId = typeof a.convId === 'string' && /^[0-9A-Z]{26}$/.test(a.convId) ? a.convId : null;
      return { id, kind: 'post', convId, text: text('Post') };
    }
    case 'task': {
      const mode = a.mode === 'todo' ? 'todo' : 'reminder';
      const due = typeof a.dueInMinutes === 'number' && Number.isFinite(a.dueInMinutes) ? Math.round(a.dueInMinutes) : 0;
      if (due < 0 || due > 60 * 24 * 365) throw new FlowError('Task: the reminder can be due from now up to a year later.');
      return { id, kind: 'task', to: people(a.to, 'Task', true), text: text('Task', mode === 'reminder'), mode, dueInMinutes: due };
    }
    case 'tag': {
      const tag = cleanTag(str(a.tag, 50));
      if (!tag) throw new FlowError('Tag: a tag starts with a letter and has letters, digits, _ or - (2 to 49 characters).');
      return { id, kind: 'tag', tag };
    }
    case 'webhook': {
      const url = str(a.url, 2000);
      let u: URL;
      try { u = new URL(url); } catch { throw new FlowError('Webhook: enter the full address, starting with https:// or http://'); }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new FlowError('Webhook: only http:// and https:// addresses can be called.');
      if (u.username || u.password) throw new FlowError('Webhook: put credentials in the body or the address\'s query, not before the host name.');
      const body = typeof a.body === 'string' ? a.body.slice(0, FLOW_LIMITS.webhookBody + 1) : '';
      if (body.length > FLOW_LIMITS.webhookBody) throw new FlowError('Webhook: the body can be up to 16 KB.');
      return { id, kind: 'webhook', url: u.href, body };
    }
    case 'extract':
      return { id, kind: 'extract' };
    default:
      throw new FlowError(`Step ${i + 1}: choose what to do.`);
  }
}

/** Check a rule graph from the app (or anywhere else) and return a clean copy, or throw FlowError. */
export function validateGraph(raw: unknown): FlowGraph {
  const g = (raw ?? {}) as Record<string, unknown>;
  const conditionsRaw = Array.isArray(g.conditions) ? g.conditions : [];
  const actionsRaw = Array.isArray(g.actions) ? g.actions : [];
  if (conditionsRaw.length > FLOW_LIMITS.conditions) throw new FlowError(`A rule can have up to ${FLOW_LIMITS.conditions} conditions.`);
  if (!actionsRaw.length) throw new FlowError('Add at least one step for the rule to do.');
  if (actionsRaw.length > FLOW_LIMITS.actions) throw new FlowError(`A rule can have up to ${FLOW_LIMITS.actions} steps.`);
  const graph: FlowGraph = { trigger: trigger(g.trigger), conditions: conditionsRaw.map(condition), actions: actionsRaw.map(action) };
  const ids = [graph.trigger.id, ...graph.conditions.map((c) => c.id), ...graph.actions.map((a) => a.id)].filter(Boolean);
  if (new Set(ids).size !== ids.length) throw new FlowError('Two parts of the rule have the same id.');
  // nodes without an id get the next free one
  if (!graph.trigger.id) graph.trigger.id = freshNodeId(graph, 't');
  for (const c of graph.conditions) if (!c.id) c.id = freshNodeId(graph, 'c');
  for (const a of graph.actions) if (!a.id) a.id = freshNodeId(graph, 'a');
  return graph;
}

/** A fresh id for a node that is not used in the graph yet. */
export function freshNodeId(graph: FlowGraph, prefix: 't' | 'c' | 'a'): string {
  const used = new Set([graph.trigger.id, ...graph.conditions.map((c) => c.id), ...graph.actions.map((a) => a.id)]);
  for (let i = 1; ; i++) if (!used.has(`${prefix}${i}`)) return `${prefix}${i}`;
}

/** Message link that opens in the app (and shows as a preview card in messages). */
export const messageLink = (convId: string, messageId: string) => `dexconnect://message/${convId}/${messageId}`;
