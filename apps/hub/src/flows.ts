// Automations on the hub: rules people draw for a conversation (or administrators for every Space)
// that run when something happens there. Messaging tells this engine about new messages,
// reactions and confirmed responses; the engine finds the rules that apply, checks their
// conditions and runs their actions in order, each able to use what the earlier ones found.
// Every rule keeps a log of its last runs. A rule runs at most 30 times a minute, and nothing an
// action posts (or the system bot says) ever starts a rule again.
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ACTION_VARIABLES, FLOW_LIMITS, FlowError, cleanTag, fileTypeOf, inTimeWindow, matchText, messageLink, nameMatches, renderTemplate, ulid, validateGraph } from '@dex/core';
import type { ActionNode, ConditionNode, FileInfo, Flow, FlowDryRun, FlowEvent, FlowGraph, FlowRun, FlowSample, FlowStep, Message, Ops, PersonRef, PublicUser, TriggerNode } from '@dex/core';
import { isSealed } from '@dex/core/e2e';
import type { Desk } from './desk.ts';
import type { FileStore } from './files.ts';
import { MsgError } from './messaging.ts';
import type { Messaging } from './messaging.ts';
import { PdfError, readPdf } from './pdf.ts';
import { FetchBlocked, safeFetch } from './safe-fetch.ts';
import type { SafeFetchOptions, SafeReply } from './safe-fetch.ts';
import type { Store } from './store.ts';
import type { SystemBot } from './systembot.ts';

export { FlowError };

export const AUTOMATIONS_ACCOUNT = 'system\\automations';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS flows (
  id TEXT PRIMARY KEY,
  conv_id TEXT,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  graph TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flows_conv ON flows(conv_id);
CREATE TABLE IF NOT EXISTS flow_runs (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  error TEXT,
  event TEXT NOT NULL,
  message_id TEXT,
  conv_id TEXT,
  steps TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flow_runs ON flow_runs(flow_id, at);
CREATE TABLE IF NOT EXISTS flow_tags (
  message_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  flow_id TEXT NOT NULL,
  PRIMARY KEY (message_id, tag)
);
`;

interface FlowRow { id: string; conv_id: string | null; owner_id: string; name: string; enabled: number; version: number; graph: string; created_at: number; updated_at: number; updated_by: string }
interface RunRow { id: string; flow_id: string; at: number; outcome: FlowRun['outcome']; error: string | null; event: string; message_id: string | null; conv_id: string | null; steps: string }
interface ConvInfo { id: string; kind: 'space' | 'direct'; name: string | null; created_by: string; archived: number }

/** Everything an event offers the rule: who, where, which message and files, and the variables so far. */
interface Ctx {
  event: FlowEvent;
  conv: ConvInfo;
  message: Message | null;
  author: PublicUser | null;
  actor: PublicUser | null;
  /** The file the rule is about (the one that matched, or the first). */
  file: FileInfo | null;
  vars: Record<string, string>;
  /** A test run: describe instead of doing. */
  dry: boolean;
  /** Made-up event in a test run: there is no real message to act on. */
  synthetic: boolean;
}

export interface FlowsDeps {
  store: Store;
  messaging: Messaging;
  desk: Desk;
  files: FileStore;
  system: SystemBot;
  deliver: (userIds: string[], name: string, data: (userId: string) => unknown) => void;
  log: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
  /** Tell everyone about a new user (the Automations bot, the first time). */
  userAdded?: (u: PublicUser) => void;
  /** Outgoing calls (tests give their own). */
  fetch?: (url: string, opts: SafeFetchOptions) => Promise<SafeReply>;
  now?: () => number;
}

const MINUTE = 60_000;
const isAdminRole = (r: PublicUser['role']) => r === 'owner' || r === 'admin';
const plainEmoji = (e: string) => e.replace(/️/g, '').trim();
const human = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const pad = (n: number) => String(n).padStart(2, '0');

export class Flows {
  private readonly db: DatabaseSync;
  private readonly d: FlowsDeps;
  readonly botId: string;
  /** Runs in the last minute, per rule. */
  private readonly recent = new Map<string, number[]>();
  /** When a rule last logged that it was over its limit. */
  private readonly limitedAt = new Map<string, number>();
  /** Work queued per rule, so one rule's runs stay in order. */
  private readonly chains = new Map<string, Promise<void>>();
  private pending = 0;
  private waiters: Array<() => void> = [];
  /** Messages the actions posted: never a trigger, whoever the author. */
  private readonly ownMessages = new Set<string>();

  constructor(deps: FlowsDeps) {
    this.d = deps;
    this.db = deps.store.db;
    this.db.exec(SCHEMA);
    const existing = deps.store.userByAccount(AUTOMATIONS_ACCOUNT);
    const bot = existing ?? deps.store.createUser(AUTOMATIONS_ACCOUNT, 'Automations', 'bot');
    this.botId = bot.id;
    if (!existing) deps.userAdded?.(bot);
  }

  private now(): number { return this.d.now?.() ?? Date.now(); }
  private allowLan(): boolean { return this.d.store.meta('flows_allow_lan', () => '0') === '1'; }

  /** Tags Automations added to a message (kept when its text is indexed again after an edit). */
  tagsOf(messageId: string): string[] {
    return (this.db.prepare('SELECT tag FROM flow_tags WHERE message_id = ?').all(messageId) as Array<{ tag: string }>).map((r) => r.tag);
  }

  /** Resolves when every queued run has finished (tests, shutdown). */
  idle(): Promise<void> {
    return this.pending === 0 ? Promise.resolve() : new Promise((resolve) => this.waiters.push(resolve));
  }

  // ------------------------------------------------------------ lookups
  private conv(id: string): ConvInfo | null {
    return (this.db.prepare('SELECT id, kind, name, created_by, archived FROM conversations WHERE id = ?').get(id) as ConvInfo | undefined) ?? null;
  }

  private convName(c: ConvInfo): string { return c.kind === 'space' ? c.name ?? 'Space' : 'a Direct conversation'; }

  private user(id: string | null | undefined): PublicUser | null {
    if (!id) return null;
    return this.d.store.activeUsers().find((u) => u.id === id) ?? null;
  }

  private departments(): Array<{ id: string; name: string; parent_id: string | null }> {
    return this.db.prepare('SELECT id, name, parent_id FROM departments').all() as Array<{ id: string; name: string; parent_id: string | null }>;
  }

  /** People in a department and the departments under it (not integrations). */
  groupMembers(groupId: string): string[] {
    const depts = this.departments();
    const ids = new Set([groupId]);
    for (let grew = true, n = 0; grew && n < 50; n++) {
      grew = false;
      for (const d of depts) if (d.parent_id && ids.has(d.parent_id) && !ids.has(d.id)) { ids.add(d.id); grew = true; }
    }
    return this.d.store.activeUsers().filter((u) => u.role !== 'bot' && u.profile.departmentId && ids.has(u.profile.departmentId)).map((u) => u.id);
  }

  /** The people a list of references names, for this event. */
  private expand(refs: PersonRef[], ctx: Ctx | null, ownerId: string): string[] {
    const out = new Set<string>();
    for (const r of refs) {
      if (r.kind === 'user') { if (this.user(r.id)) out.add(r.id); }
      else if (r.kind === 'group') for (const u of this.groupMembers(r.id)) out.add(u);
      else if (r.id === 'owner') out.add(ownerId);
      else if (r.id === 'author' && ctx?.author) out.add(ctx.author.id);
      else if (r.id === 'actor' && ctx?.actor) out.add(ctx.actor.id);
      if (out.size > 500) break;
    }
    return [...out];
  }

  private isMember(convId: string, userId: string): boolean { return this.d.messaging.isMember(convId, userId); }

  private moderates(c: ConvInfo, me: PublicUser): boolean {
    if (!this.isMember(c.id, me.id)) return false;
    if (isAdminRole(me.role) || c.created_by === me.id) return true;
    return !!this.db.prepare('SELECT 1 FROM conv_members WHERE conv_id = ? AND user_id = ? AND moderator = 1').get(c.id, me.id);
  }

  private canManage(row: Pick<FlowRow, 'conv_id'>, me: PublicUser): boolean {
    if (me.role === 'guest' || me.role === 'bot') return false;
    if (row.conv_id === null) return isAdminRole(me.role);
    const c = this.conv(row.conv_id);
    return !!c && this.moderates(c, me);
  }

  private canView(row: Pick<FlowRow, 'conv_id'>, me: PublicUser): boolean {
    if (row.conv_id === null) return isAdminRole(me.role);
    return this.isMember(row.conv_id, me.id) || isAdminRole(me.role);
  }

  /** Who hears about changes to a rule: the conversation's members, or administrators. */
  private audience(convId: string | null): string[] {
    if (convId) return this.d.messaging.members(convId);
    return this.d.store.activeUsers().filter((u) => isAdminRole(u.role)).map((u) => u.id);
  }

  private row(id: unknown): FlowRow | null {
    return typeof id === 'string' ? (this.db.prepare('SELECT * FROM flows WHERE id = ?').get(id) as FlowRow | undefined) ?? null : null;
  }

  private parseGraph(raw: string): FlowGraph | null {
    try { return validateGraph(JSON.parse(raw)); } catch { return null; }
  }

  private runView(r: RunRow): FlowRun {
    let steps: FlowStep[] = [];
    try { steps = JSON.parse(r.steps) as FlowStep[]; } catch { /* corrupt row */ }
    return { id: r.id, flowId: r.flow_id, at: r.at, outcome: r.outcome, error: r.error, event: r.event, messageId: r.message_id, convId: r.conv_id, steps };
  }

  private view(r: FlowRow, viewer: PublicUser): Flow {
    const last = this.db.prepare('SELECT * FROM flow_runs WHERE flow_id = ? ORDER BY at DESC, id DESC LIMIT 1').get(r.id) as RunRow | undefined;
    const graph = this.parseGraph(r.graph) ?? { trigger: { id: 't1', kind: 'file.added' }, conditions: [], actions: [] };
    return {
      id: r.id, name: r.name, convId: r.conv_id, convName: r.conv_id ? ((c) => (c ? (c.kind === 'space' ? c.name ?? 'Space' : 'Direct conversation') : null))(this.conv(r.conv_id)) : null, ownerId: r.owner_id, enabled: !!r.enabled, version: r.version, graph,
      createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by, lastRun: last ? this.runView(last) : null,
      canManage: this.canManage(r, viewer),
    };
  }

  private push(r: FlowRow): void {
    this.d.deliver(this.audience(r.conv_id), 'flow.updated', (uid) => { const u = this.user(uid); return u ? this.view(r, u) : null; });
  }

  // ------------------------------------------------------------ events
  /** Messaging calls this for every new message, reaction and confirmed response. Never throws. */
  onEvent(e: FlowEvent): void {
    try {
      // the loop guard: what an action posted, or the system bot said, never starts a rule
      if (e.kind === 'message.new' && (e.authorId === this.botId || e.authorId === this.d.system.id || this.ownMessages.has(e.messageId))) return;
      const actorId = e.kind === 'message.new' ? e.authorId : e.userId;
      if (actorId === this.botId || actorId === this.d.system.id) return;
      const conv = this.conv(e.convId);
      if (!conv) return;
      const kinds = e.kind === 'message.new' ? ['file.added', 'message.matched', 'message.mentioned'] : [e.kind];
      // office-wide rules watch Spaces only: Direct conversations are private
      const rows = this.db.prepare(`SELECT * FROM flows WHERE enabled = 1 AND (conv_id = ? ${conv.kind === 'space' ? 'OR conv_id IS NULL' : ''})`).all(conv.id) as unknown as FlowRow[];
      for (const r of rows) {
        const graph = this.parseGraph(r.graph);
        if (!graph || !kinds.includes(graph.trigger.kind)) continue;
        this.enqueue(r.id, () => this.consider(r, graph, e, conv));
      }
    } catch (err) {
      this.d.log('error', 'automation event failed', { error: (err as Error).message });
    }
  }

  private enqueue(flowId: string, job: () => Promise<void>): void {
    this.pending++;
    const prev = this.chains.get(flowId) ?? Promise.resolve();
    const next = prev.then(job).catch((err) => this.d.log('error', 'automation run failed', { flowId, error: (err as Error).message })).finally(() => {
      if (this.chains.get(flowId) === next) this.chains.delete(flowId);
      if (--this.pending === 0) for (const w of this.waiters.splice(0)) w();
    });
    this.chains.set(flowId, next);
  }

  /** Build what the rule sees of an event. */
  private context(e: FlowEvent, conv: ConvInfo, dry: boolean): Ctx | null {
    const actorId = e.kind === 'message.new' ? e.authorId : e.userId;
    const message = this.d.messaging.messageFor(e.messageId, actorId);
    if (!message || message.deleted) return null;
    return this.makeContext(e, conv, message, this.user(message.authorId), this.user(actorId), dry, false);
  }

  private makeContext(e: FlowEvent, conv: ConvInfo, message: Message | null, author: PublicUser | null, actor: PublicUser | null, dry: boolean, synthetic: boolean): Ctx {
    const users = new Map(this.d.store.activeUsers().map((u) => [u.id, u.displayName] as const));
    const text = message && !isSealed(message.body)
      ? message.body.replace(/<@all>/g, '@everyone').replace(/<@([0-9A-Z]{26})>/g, (_m, id: string) => `@${users.get(id) ?? 'someone'}`)
      : '';
    const at = new Date(this.now());
    const vars: Record<string, string> = {
      'conversation.name': this.convName(conv),
      'conversation.link': `dexconnect://conversation/${conv.id}`,
      'message.text': text.slice(0, 1000),
      'message.link': message && !synthetic ? messageLink(conv.id, message.id) : '',
      'author.name': author?.displayName ?? '',
      'actor.name': actor?.displayName ?? '',
      'now.date': `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
      'now.time': `${pad(at.getHours())}:${pad(at.getMinutes())}`,
    };
    if (e.kind === 'reaction.added') vars['reaction.emoji'] = e.emoji;
    if (e.kind === 'response.confirmed') { vars['response.choice'] = e.choice; vars['response.source'] = e.source; }
    return { event: e, conv, message, author, actor, file: null, vars, dry, synthetic };
  }

  private setFile(ctx: Ctx, f: FileInfo): void {
    ctx.file = f;
    ctx.vars['file.name'] = f.name;
    ctx.vars['file.type'] = fileTypeOf(f.name);
    ctx.vars['file.size'] = human(f.size);
  }

  private fileOk(f: FileInfo, types: string[] | undefined, pattern: string | undefined): boolean {
    if (types?.length && !types.includes(fileTypeOf(f.name))) return false;
    return !pattern || nameMatches(pattern, f.name);
  }

  /** Does the trigger match? Returns why not, or null when it does. */
  private triggerMiss(t: TriggerNode, ctx: Ctx, ownerId: string): string | null {
    const e = ctx.event;
    switch (t.kind) {
      case 'reaction.added': {
        if (e.kind !== 'reaction.added') return 'It is not a reaction.';
        if (plainEmoji(e.emoji) !== plainEmoji(t.emoji)) return `The reaction is ${e.emoji}, not ${t.emoji}.`;
        if (t.by?.length && !(ctx.author && this.expand(t.by, ctx, ownerId).includes(ctx.author.id))) return 'The message was written by someone else.';
        return null;
      }
      case 'file.added': {
        if (e.kind !== 'message.new') return 'It is not a new message.';
        const files = ctx.message?.files ?? [];
        if (!files.length) return 'The message has no file attached.';
        const hit = files.find((f) => this.fileOk(f, t.types, t.namePattern));
        if (!hit) return `No attached file is ${t.types?.length ? t.types.map((x) => `.${x}`).join(', ') : 'a match'}${t.namePattern ? ` named like ${t.namePattern}` : ''}.`;
        this.setFile(ctx, hit);
        return null;
      }
      case 'response.confirmed': {
        if (e.kind !== 'response.confirmed') return 'It is not a poll vote or form answer.';
        if (t.source && t.source !== 'any' && t.source !== e.source) return `It is a ${e.source}, not a ${t.source}.`;
        if (t.choice && t.choice.trim().toLowerCase() !== e.choice.trim().toLowerCase()) return `The choice was “${e.choice}”, not “${t.choice}”.`;
        return null;
      }
      case 'message.matched': {
        if (e.kind !== 'message.new') return 'It is not a new message.';
        if (!ctx.vars['message.text']) return 'The message has no text the hub can read.';
        const m = matchText(t, ctx.vars['message.text']);
        if (!m) return 'The text does not match.';
        ctx.vars['match.text'] = m.text;
        m.groups.slice(0, 9).forEach((g, i) => { ctx.vars[`match.${i + 1}`] = g; });
        return null;
      }
      case 'message.mentioned': {
        if (e.kind !== 'message.new') return 'It is not a new message.';
        const mentioned = new Set(ctx.message?.mentions ?? []);
        const wanted = this.expand(t.targets, ctx, ownerId);
        const hits = wanted.filter((u) => mentioned.has(u));
        if (!hits.length) return 'Nobody the rule watches for is mentioned.';
        ctx.vars['mention.names'] = hits.map((u) => this.user(u)?.displayName ?? '').filter(Boolean).join(', ');
        return null;
      }
    }
  }

  private conditionMiss(c: ConditionNode, ctx: Ctx, ownerId: string): string | null {
    switch (c.kind) {
      case 'conversation':
        return c.convIds.includes(ctx.conv.id) ? null : `It happened in ${this.convName(ctx.conv)}, which the rule does not watch.`;
      case 'author': {
        const who = ctx.actor?.id ?? '';
        const listed = this.expand(c.people, ctx, ownerId).includes(who);
        if (c.exclude ? listed : !listed) return `${ctx.actor?.displayName ?? 'Someone'} is ${c.exclude ? '' : 'not '}one of the people the rule ${c.exclude ? 'leaves out' : 'watches'}.`;
        return null;
      }
      case 'time':
        return inTimeWindow(c, new Date(this.now())) ? null : `It is ${c.outside ? 'inside' : 'outside'} the hours the rule runs.`;
      case 'file': {
        const candidates = ctx.file ? [ctx.file] : ctx.message?.files ?? [];
        const hit = candidates.find((f) => this.fileOk(f, c.types, c.namePattern));
        if (!hit) return 'No attached file fits the file condition.';
        this.setFile(ctx, hit);
        return null;
      }
    }
  }

  /** Is the event's text, file or person what the rule is waiting for? */
  private match(graph: FlowGraph, ctx: Ctx, ownerId: string): string | null {
    const t = this.triggerMiss(graph.trigger, ctx, ownerId);
    if (t) return t;
    for (const c of graph.conditions) { const why = this.conditionMiss(c, ctx, ownerId); if (why) return why; }
    // a rule about files with no file trigger still knows the first attached file
    if (!ctx.file && ctx.message?.files.length) this.setFile(ctx, ctx.message.files[0]);
    return null;
  }

  private summary(ctx: Ctx): string {
    const who = ctx.actor?.displayName ?? 'Someone';
    const where = this.convName(ctx.conv);
    const e = ctx.event;
    if (e.kind === 'reaction.added') return `${who} reacted ${e.emoji} in ${where}`;
    if (e.kind === 'response.confirmed') return e.source === 'poll' ? `${who} voted “${e.choice}” in ${where}` : `${who} answered a form in ${where}`;
    if (ctx.file) return `${who} shared ${ctx.file.name} in ${where}`;
    return `${who} wrote in ${where}`;
  }

  /** A real event: check, rate-limit, run, log. */
  private async consider(r: FlowRow, graph: FlowGraph, e: FlowEvent, conv: ConvInfo): Promise<void> {
    const ctx = this.context(e, conv, false);
    if (!ctx) return;
    ctx.vars['rule.name'] = r.name;
    if (this.match(graph, ctx, r.owner_id)) return;
    // at most 30 runs a minute per rule; one log line says when it was held back
    const now = this.now();
    const times = (this.recent.get(r.id) ?? []).filter((t) => t > now - MINUTE);
    if (times.length >= FLOW_LIMITS.runsPerMinute) {
      this.recent.set(r.id, times);
      if (now - (this.limitedAt.get(r.id) ?? 0) >= MINUTE) {
        this.limitedAt.set(r.id, now);
        this.record(r, ctx, 'limited', `This rule ran ${FLOW_LIMITS.runsPerMinute} times in the last minute; it waits before running again.`, []);
      }
      return;
    }
    times.push(now);
    this.recent.set(r.id, times);
    const steps = await this.runActions(r, graph, ctx);
    const failed = steps.find((s) => s.status === 'failed');
    this.record(r, ctx, failed ? 'failed' : 'ok', failed?.note ?? null, steps);
  }

  private record(r: FlowRow, ctx: Ctx, outcome: FlowRun['outcome'], error: string | null, steps: FlowStep[]): void {
    const id = ulid();
    const run: RunRow = { id, flow_id: r.id, at: this.now(), outcome, error, event: this.summary(ctx), message_id: ctx.message?.id ?? null, conv_id: ctx.conv.id, steps: JSON.stringify(steps) };
    this.db.prepare('INSERT INTO flow_runs (id, flow_id, at, outcome, error, event, message_id, conv_id, steps) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(run.id, run.flow_id, run.at, run.outcome, run.error, run.event, run.message_id, run.conv_id, run.steps);
    // keep the last 50
    this.db.prepare(`DELETE FROM flow_runs WHERE flow_id = ? AND id NOT IN (SELECT id FROM flow_runs WHERE flow_id = ? ORDER BY at DESC, id DESC LIMIT ${FLOW_LIMITS.runsKept})`).run(r.id, r.id);
    const view = this.runView(run);
    this.d.deliver(this.audience(r.conv_id), 'flow.ran', () => ({ flowId: r.id, run: view }));
    if (outcome !== 'ok') this.d.log('warn', 'automation did not finish', { flow: r.id, outcome, error });
  }

  /** Run (or, in a test run, describe) the actions in order. A failed step stops the ones after it. */
  private async runActions(r: Pick<FlowRow, 'id' | 'owner_id' | 'conv_id' | 'name'>, graph: FlowGraph, ctx: Ctx): Promise<FlowStep[]> {
    const steps: FlowStep[] = [];
    let stopped = false;
    for (const a of graph.actions) {
      if (stopped) { steps.push({ nodeId: a.id, kind: a.kind, status: 'skipped', note: 'Not run: an earlier step failed.' }); continue; }
      try {
        const note = await this.act(a, r, ctx);
        steps.push({ nodeId: a.id, kind: a.kind, status: ctx.dry ? 'would' : 'done', note });
      } catch (err) {
        const note = err instanceof FlowError || err instanceof MsgError || err instanceof PdfError || err instanceof FetchBlocked ? err.message : 'Something went wrong on the hub.';
        if (!(err instanceof FlowError || err instanceof MsgError || err instanceof PdfError || err instanceof FetchBlocked)) this.d.log('error', 'automation step failed', { flow: r.id, step: a.id, error: (err as Error).message });
        steps.push({ nodeId: a.id, kind: a.kind, status: 'failed', note });
        stopped = true;
      }
    }
    return steps;
  }

  private names(ids: string[]): string {
    const n = ids.map((u) => this.user(u)?.displayName ?? '').filter(Boolean);
    return n.length <= 3 ? n.join(', ') : `${n.slice(0, 3).join(', ')} and ${n.length - 3} more`;
  }

  private async act(a: ActionNode, r: Pick<FlowRow, 'id' | 'owner_id' | 'conv_id' | 'name'>, ctx: Ctx): Promise<string> {
    const text = (t: string) => renderTemplate(t, ctx.vars).trim();
    const owner = this.user(r.owner_id);
    if (!owner) throw new FlowError('The person who owns this rule no longer has an account here.');
    switch (a.kind) {
      case 'notify': {
        const to = this.expand(a.to, ctx, r.owner_id).filter((u) => this.user(u)?.role !== 'bot').slice(0, 200);
        if (!to.length) throw new FlowError('There is no one to notify (the group may be empty).');
        let body = text(a.text);
        const link = ctx.vars['message.link'];
        if (link && !body.includes(link)) body = `${body}\n\n${link}`;
        if (!body) throw new FlowError('The notification would be empty.');
        if (ctx.dry) return `Would tell ${this.names(to)}: “${body.slice(0, 300)}”`;
        const key = `flow-${ulid()}`;
        for (const u of to) this.d.system.tell(u, body.slice(0, 8000), `${key}-${u}`);
        return `Told ${this.names(to)}.`;
      }
      case 'post': {
        const target = this.conv(a.convId ?? ctx.conv.id);
        if (!target) throw new FlowError('The conversation to post in no longer exists.');
        if (target.kind !== 'space') throw new FlowError('Automations post only in Spaces.');
        if (target.archived) throw new FlowError(`${target.name ?? 'That Space'} is archived.`);
        if (!this.isMember(target.id, r.owner_id)) throw new FlowError(`The rule's owner is not in ${target.name ?? 'that Space'} any more.`);
        const body = text(a.text);
        if (!body) throw new FlowError('The message would be empty.');
        if (ctx.dry) return `Would post in ${target.name}: “${body.slice(0, 300)}”`;
        const bot = this.d.store.userById(this.botId);
        if (!bot) throw new FlowError('The Automations account is missing.');
        this.d.messaging.ensureMember(target.id, bot.id);
        const sent = this.d.messaging.sendAs(bot, this.d.messaging.memberConv(target.id, bot.id), body.slice(0, 8000), undefined, [], `flow-${ulid()}`, {});
        this.ownMessages.add(sent.id);
        if (this.ownMessages.size > 5000) this.ownMessages.delete(this.ownMessages.values().next().value as string);
        return `Posted in ${target.name}.`;
      }
      case 'task': {
        const to = this.expand(a.to, ctx, r.owner_id).filter((u) => this.user(u)?.role !== 'bot').slice(0, 50);
        if (!to.length) throw new FlowError('There is no one to give the task to.');
        const msg = ctx.message && !ctx.synthetic ? ctx.message : null;
        if (a.mode === 'todo') {
          if (!msg && !ctx.dry) throw new FlowError('A To do needs a message to keep.');
          const can = to.filter((u) => !msg || this.isMember(msg.convId, u));
          if (!can.length) throw new FlowError(`${this.names(to)} cannot see the conversation, so it cannot go on their Desk.`);
          if (ctx.dry) return `Would keep the message as a To do on ${this.names(can)}'s Desk.`;
          for (const u of can) { const p = this.user(u); if (p) this.d.desk.handle('msg.star', p, { messageId: msg!.id, on: true, kind: 'todo' }); }
          return `Kept as a To do on ${this.names(can)}'s Desk${can.length < to.length ? ` (${this.names(to.filter((u) => !can.includes(u)))} cannot see the conversation)` : ''}.`;
        }
        const body = text(a.text) || 'Follow up';
        const dueAt = this.now() + a.dueInMinutes * MINUTE;
        const when = a.dueInMinutes ? `due in ${a.dueInMinutes >= 1440 && a.dueInMinutes % 1440 === 0 ? `${a.dueInMinutes / 1440} day${a.dueInMinutes === 1440 ? '' : 's'}` : a.dueInMinutes >= 60 && a.dueInMinutes % 60 === 0 ? `${a.dueInMinutes / 60} hour${a.dueInMinutes === 60 ? '' : 's'}` : `${a.dueInMinutes} minutes`}` : 'due now';
        if (ctx.dry) return `Would set a reminder for ${this.names(to)} (${when}): “${body.slice(0, 200)}”`;
        if (owner.role === 'guest' && to.some((u) => u !== owner.id)) throw new FlowError('The rule\'s owner is a guest and can only set reminders for themselves.');
        const done: string[] = [];
        for (const u of to) {
          const attach = msg && this.isMember(msg.convId, owner.id) && this.isMember(msg.convId, u);
          const forText = attach || !ctx.vars['message.link'] || body.includes(ctx.vars['message.link']) ? body : `${body} ${ctx.vars['message.link']}`;
          this.d.desk.handle('remind.create', owner, { forUserId: u, text: forText.slice(0, 500), dueAt, ...(attach ? { messageId: msg!.id } : {}) });
          done.push(u);
        }
        return `Reminder set for ${this.names(done)} (${when}).`;
      }
      case 'tag': {
        const msg = ctx.message && !ctx.synthetic ? ctx.message : null;
        if (!msg && !ctx.dry) throw new FlowError('There is no message to tag.');
        if (msg && isSealed(msg.body)) throw new FlowError('Encrypted messages cannot be tagged by the hub.');
        const tag = cleanTag(a.tag);
        if (!tag) throw new FlowError('That tag is not valid.');
        if (ctx.dry) return `Would tag the message #${tag}.`;
        this.db.prepare('INSERT OR IGNORE INTO flow_tags (message_id, tag, flow_id) VALUES (?, ?, ?)').run(msg!.id, tag, r.id);
        this.db.prepare('INSERT OR IGNORE INTO message_tags (message_id, conv_id, tag, created_at) VALUES (?, ?, ?, ?)').run(msg!.id, msg!.convId, tag, this.now());
        return `Tagged #${tag}.`;
      }
      case 'webhook': {
        const raw = a.body.trim();
        let body: string;
        let contentType = 'application/json';
        if (!raw) {
          body = JSON.stringify({
            rule: { id: r.id, name: r.name }, event: ctx.event.kind, summary: this.summary(ctx),
            conversation: { id: ctx.conv.id, name: this.convName(ctx.conv) },
            message: ctx.message && !ctx.synthetic ? { id: ctx.message.id, text: ctx.vars['message.text'], link: ctx.vars['message.link'] } : null,
            author: ctx.author ? { id: ctx.author.id, name: ctx.author.displayName, account: ctx.author.account } : null,
            actor: ctx.actor ? { id: ctx.actor.id, name: ctx.actor.displayName, account: ctx.actor.account } : null,
            variables: ctx.vars,
          });
        } else if (/^[[{]/.test(raw)) {
          // values go inside JSON strings: escape them so the body stays valid JSON
          body = renderTemplate(raw, Object.fromEntries(Object.entries(ctx.vars).map(([k, v]) => [k, JSON.stringify(v).slice(1, -1)])));
          try { JSON.parse(body); } catch { contentType = 'text/plain; charset=utf-8'; }
        } else { body = renderTemplate(raw, ctx.vars); contentType = 'text/plain; charset=utf-8'; }
        if (Buffer.byteLength(body) > FLOW_LIMITS.webhookBody) throw new FlowError('The webhook body is larger than 16 KB.');
        if (ctx.dry) {
          const u = new URL(a.url);
          return `Would send ${Buffer.byteLength(body)} bytes to ${u.host}${u.pathname}${this.allowLan() ? '' : ' (office-network addresses are refused)'}.`;
        }
        const reply = await (this.d.fetch ?? safeFetch)(a.url, { allowLan: this.allowLan(), method: 'POST', body, contentType, headers: { 'x-dex-rule': r.id }, timeoutMs: 8000, maxBody: FLOW_LIMITS.webhookBody, maxReply: 64 * 1024 });
        ctx.vars['webhook.status'] = String(reply.status);
        ctx.vars['webhook.reply'] = reply.text.slice(0, 1000);
        if (reply.status < 200 || reply.status >= 300) throw new FlowError(`The webhook answered ${reply.status}.`);
        return `Sent to ${new URL(a.url).host}: it answered ${reply.status}${reply.truncated ? ' (long reply cut at 64 KB)' : ''}.`;
      }
      case 'extract': {
        const files = ctx.file ? [ctx.file, ...(ctx.message?.files ?? [])] : ctx.message?.files ?? [];
        const pdf = files.find((f) => fileTypeOf(f.name) === 'pdf' || f.mime === 'application/pdf');
        if (!pdf) throw new FlowError('There is no PDF attached to read.');
        if (ctx.synthetic) {
          this.setFile(ctx, pdf);
          for (const k of ACTION_VARIABLES.extract ?? []) ctx.vars[k] = `(${k.split('.')[1]} from ${pdf.name})`;
          return `Would read the title block of ${pdf.name}. Test with a real message that has a PDF to see what it finds.`;
        }
        const blob = this.blobPath(pdf.id);
        if (!blob) throw new FlowError(`${pdf.name} is no longer on the hub.`);
        const st = await fs.promises.stat(blob).catch(() => null);
        if (!st) throw new FlowError(`${pdf.name} is no longer on the hub.`);
        if (st.size > 64 * 1024 * 1024) throw new FlowError(`${pdf.name} is too large to read (over 64 MB).`);
        const info = readPdf(await fs.promises.readFile(blob), pdf.name);
        this.setFile(ctx, pdf);
        ctx.vars['file.title'] = info.title ?? '';
        ctx.vars['file.revision'] = info.revision ?? '';
        ctx.vars['file.number'] = info.number ?? '';
        ctx.vars['file.pages'] = String(info.pages);
        const found = [info.title ? `title “${info.title}”` : 'no title', info.revision ? `revision ${info.revision}` : 'no revision', ...(info.number ? [`number ${info.number}`] : [])];
        return `Read ${pdf.name}: ${found.join(', ')}.`;
      }
    }
  }

  /** Where a stored file's bytes are (files are kept once, named by their SHA-256). */
  private blobPath(fileId: string): string | null {
    const r = this.db.prepare('SELECT sha256 FROM files WHERE id = ?').get(fileId) as { sha256: string } | undefined;
    return r && /^[0-9a-f]{64}$/.test(r.sha256) ? path.join(this.d.files.dir, r.sha256.slice(0, 2), r.sha256) : null;
  }

  // ------------------------------------------------------------ checks when saving
  /** People, groups and conversations a rule names must exist, and the editor must be able to use them. */
  private checkReferences(graph: FlowGraph, convId: string | null, me: PublicUser): void {
    const users = new Set(this.d.store.activeUsers().map((u) => u.id));
    const groups = new Set(this.departments().map((d) => d.id));
    const refs: PersonRef[] = [];
    if (graph.trigger.kind === 'reaction.added') refs.push(...(graph.trigger.by ?? []));
    if (graph.trigger.kind === 'message.mentioned') refs.push(...graph.trigger.targets);
    for (const c of graph.conditions) if (c.kind === 'author') refs.push(...c.people);
    for (const a of graph.actions) if (a.kind === 'notify' || a.kind === 'task') refs.push(...a.to);
    for (const r of refs) {
      if (r.kind === 'user' && !users.has(r.id)) throw new FlowError('One of the people in the rule is not in the Directory any more.');
      if (r.kind === 'group' && !groups.has(r.id)) throw new FlowError('One of the groups in the rule no longer exists.');
    }
    for (const c of graph.conditions) {
      if (c.kind !== 'conversation') continue;
      for (const id of c.convIds) if (!this.conv(id) || !this.isMember(id, me.id)) throw new FlowError('Choose conversations you are in for the conversation condition.');
    }
    const home = convId ? this.conv(convId) : null;
    for (const a of graph.actions) {
      if (a.kind !== 'post') continue;
      if (a.convId === null) {
        if (home && home.kind !== 'space') throw new FlowError('Automations post only in Spaces: choose a Space to post in.');
        continue;
      }
      const t = this.conv(a.convId);
      if (!t || t.kind !== 'space') throw new FlowError('Automations post only in Spaces.');
      if (!this.isMember(t.id, me.id)) throw new FlowError(`Choose a Space you are in to post in.`);
      if (t.archived) throw new FlowError(`${t.name ?? 'That Space'} is archived.`);
    }
    if (me.role === 'guest') throw new FlowError('Guests cannot create automations.');
  }

  // ------------------------------------------------------------ operations
  async handle(op: string, me: PublicUser, d: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.op(op, me, d);
    } catch (err) {
      if (err instanceof MsgError) throw new FlowError(err.message);
      throw err;
    }
  }

  private async op(op: string, me: PublicUser, d: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case 'flow.list': {
        let rows: FlowRow[];
        if (typeof d.convId === 'string') {
          const c = this.conv(d.convId);
          if (!c || (!this.isMember(c.id, me.id))) throw new FlowError('Conversation not found.');
          rows = this.db.prepare('SELECT * FROM flows WHERE conv_id = ? ORDER BY created_at').all(c.id) as unknown as FlowRow[];
        } else {
          if (!isAdminRole(me.role)) throw new FlowError('Only administrators can see office-wide automations.');
          rows = d.scope === 'all'
            ? this.db.prepare('SELECT * FROM flows ORDER BY conv_id IS NOT NULL, created_at').all() as unknown as FlowRow[]
            : this.db.prepare('SELECT * FROM flows WHERE conv_id IS NULL ORDER BY created_at').all() as unknown as FlowRow[];
        }
        return rows.map((r) => this.view(r, me)) satisfies Ops['flow.list']['res'];
      }

      case 'flow.save': {
        const name = typeof d.name === 'string' ? d.name.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, FLOW_LIMITS.name) : '';
        if (!name) throw new FlowError('Give the rule a name.');
        const graph = validateGraph(d.graph);
        const existing = d.id !== undefined ? this.row(d.id) : null;
        if (d.id !== undefined && !existing) throw new FlowError('That rule no longer exists.');
        const convId = existing ? existing.conv_id : typeof d.convId === 'string' ? d.convId : null;
        if (convId) {
          const c = this.conv(convId);
          if (!c || !this.isMember(c.id, me.id)) throw new FlowError('Conversation not found.');
          if (!this.moderates(c, me)) throw new FlowError('Only the person who started this conversation, its moderators or an administrator can change its automations.');
        } else if (!isAdminRole(me.role)) throw new FlowError('Only administrators can make office-wide automations.');
        if (existing && !this.canManage(existing, me)) throw new FlowError('You cannot change this rule.');
        this.checkReferences(graph, convId, me);
        const now = this.now();
        if (existing) {
          if (typeof d.version === 'number' && d.version !== existing.version) throw new FlowError('Someone changed this rule since you opened it. Open it again to see their changes.');
          const enabled = typeof d.enabled === 'boolean' ? d.enabled : !!existing.enabled;
          this.db.prepare('UPDATE flows SET name = ?, graph = ?, enabled = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?')
            .run(name, JSON.stringify(graph), enabled ? 1 : 0, now, me.id, existing.id);
          this.d.store.audit(me.id, 'flow.updated', existing.id, { name, convId, version: existing.version + 1, enabled });
        } else {
          const count = (this.db.prepare(`SELECT COUNT(*) AS n FROM flows WHERE ${convId ? 'conv_id = ?' : 'conv_id IS NULL'}`).get(...(convId ? [convId] : [])) as { n: number }).n;
          if (count >= (convId ? FLOW_LIMITS.rulesPerConversation : FLOW_LIMITS.rulesOffice)) throw new FlowError('There are too many automations here. Remove one you no longer need first.');
          const id = ulid();
          const enabled = d.enabled !== false;
          this.db.prepare('INSERT INTO flows (id, conv_id, owner_id, name, enabled, version, graph, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)')
            .run(id, convId, me.id, name, enabled ? 1 : 0, JSON.stringify(graph), now, now, me.id);
          this.d.store.audit(me.id, 'flow.created', id, { name, convId, enabled });
          d = { ...d, id };
        }
        const row = this.row(d.id)!;
        this.push(row);
        return this.view(row, me) satisfies Ops['flow.save']['res'];
      }

      case 'flow.enable': {
        const r = this.row(d.id);
        if (!r || !this.canView(r, me)) throw new FlowError('That rule no longer exists.');
        if (!this.canManage(r, me)) throw new FlowError('You cannot change this rule.');
        const enabled = d.enabled === true;
        this.db.prepare('UPDATE flows SET enabled = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(enabled ? 1 : 0, this.now(), me.id, r.id);
        this.d.store.audit(me.id, enabled ? 'flow.enabled' : 'flow.disabled', r.id, { name: r.name, convId: r.conv_id });
        const row = this.row(r.id)!;
        this.push(row);
        return this.view(row, me) satisfies Ops['flow.enable']['res'];
      }

      case 'flow.delete': {
        const r = this.row(d.id);
        if (!r || !this.canView(r, me)) throw new FlowError('That rule no longer exists.');
        if (!this.canManage(r, me)) throw new FlowError('You cannot remove this rule.');
        this.db.prepare('DELETE FROM flows WHERE id = ?').run(r.id);
        this.db.prepare('DELETE FROM flow_runs WHERE flow_id = ?').run(r.id);
        this.d.store.audit(me.id, 'flow.deleted', r.id, { name: r.name, convId: r.conv_id });
        this.d.deliver(this.audience(r.conv_id), 'flow.removed', () => ({ id: r.id, convId: r.conv_id }));
        return { ok: true } satisfies Ops['flow.delete']['res'];
      }

      case 'flow.runs': {
        const r = this.row(d.id);
        if (!r || !this.canView(r, me)) throw new FlowError('That rule no longer exists.');
        const rows = this.db.prepare('SELECT * FROM flow_runs WHERE flow_id = ? ORDER BY at DESC, id DESC LIMIT ?').all(r.id, FLOW_LIMITS.runsKept) as unknown as RunRow[];
        return rows.map((x) => this.runView(x)) satisfies Ops['flow.runs']['res'];
      }

      case 'flow.test':
        return this.dryRun(me, d) satisfies Promise<Ops['flow.test']['res']>;

      case 'admin.flows.settings': {
        if (!isAdminRole(me.role)) throw new FlowError('Only administrators can do that.');
        if (typeof d.allowLan === 'boolean') {
          this.d.store.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('flows_allow_lan', d.allowLan ? '1' : '0');
          this.d.store.audit(me.id, 'flow.settings', null, { allowLan: d.allowLan });
        }
        return { allowLan: this.allowLan() } satisfies Ops['admin.flows.settings']['res'];
      }
    }
    return undefined;
  }

  /** A test run: build the sample event, check the trigger and conditions, and describe each step. */
  private async dryRun(me: PublicUser, d: Record<string, unknown>): Promise<FlowDryRun> {
    const graph = validateGraph(d.graph);
    const convId = typeof d.convId === 'string' ? d.convId : null;
    const sample = (d.sample && typeof d.sample === 'object' ? d.sample : {}) as FlowSample;
    if (convId) {
      if (!this.conv(convId) || !this.isMember(convId, me.id)) throw new FlowError('Conversation not found.');
    } else if (!isAdminRole(me.role)) throw new FlowError('Only administrators can test office-wide automations.');
    const t = graph.trigger;
    let ctx: Ctx;
    if (typeof sample.messageId === 'string' && sample.messageId) {
      const m = this.d.messaging.messageFor(sample.messageId, me.id);
      if (!m || m.deleted) throw new FlowError('That sample message was not found.');
      if (convId && m.convId !== convId) throw new FlowError('Choose a message from this conversation.');
      const conv = this.conv(m.convId)!;
      const e: FlowEvent = t.kind === 'reaction.added'
        ? { kind: 'reaction.added', messageId: m.id, convId: m.convId, userId: me.id, emoji: typeof sample.emoji === 'string' && sample.emoji ? sample.emoji : t.emoji }
        : t.kind === 'response.confirmed'
          ? { kind: 'response.confirmed', messageId: m.id, convId: m.convId, userId: me.id, source: m.form ? 'form' : 'poll', choice: typeof sample.choice === 'string' && sample.choice ? sample.choice : t.choice ?? m.poll?.options[0]?.text ?? '' }
          : { kind: 'message.new', messageId: m.id, convId: m.convId, authorId: m.authorId };
      const actorId = e.kind === 'message.new' ? e.authorId : e.userId;
      ctx = this.makeContext(e, conv, m, this.user(m.authorId), this.user(actorId), true, false);
    } else {
      const conv = convId ? this.conv(convId)! : { id: '', kind: 'space' as const, name: 'a Space', created_by: me.id, archived: 0 };
      const author = (typeof sample.authorId === 'string' ? this.user(sample.authorId) : null) ?? me;
      const name = typeof sample.fileName === 'string' ? sample.fileName.trim().slice(0, 180) : '';
      const now = this.now();
      const files: FileInfo[] = name ? [{ id: 'sample', name, mime: fileTypeOf(name) === 'pdf' ? 'application/pdf' : 'application/octet-stream', size: 245_760, uploaderId: author.id, createdAt: now }] : [];
      const body = typeof sample.text === 'string' ? sample.text.slice(0, 4000) : '';
      const mentions = (body.match(/<@([0-9A-Z]{26}|all)>/g) ?? []).map((m) => m.slice(2, -1));
      const message: Message = {
        id: 'sample', convId: conv.id, authorId: author.id, body, parentId: null, createdAt: now, editedAt: null, deleted: false, pinned: false, pinnedUntil: null,
        reactions: {}, mentions, replyCount: 0, lastReplyAt: null, clientId: null, files, forwardedFrom: null, system: null, removed: null, inReplyTo: null, poll: null, form: null,
      };
      const e: FlowEvent = t.kind === 'reaction.added'
        ? { kind: 'reaction.added', messageId: 'sample', convId: conv.id, userId: me.id, emoji: typeof sample.emoji === 'string' && sample.emoji ? sample.emoji : t.emoji }
        : t.kind === 'response.confirmed'
          ? { kind: 'response.confirmed', messageId: 'sample', convId: conv.id, userId: me.id, source: t.source === 'form' ? 'form' : 'poll', choice: typeof sample.choice === 'string' ? sample.choice : t.choice ?? '' }
          : { kind: 'message.new', messageId: 'sample', convId: conv.id, authorId: author.id };
      ctx = this.makeContext(e, conv, message, author, e.kind === 'message.new' ? author : me, true, true);
    }
    ctx.vars['rule.name'] = typeof d.name === 'string' ? d.name.slice(0, FLOW_LIMITS.name) : '';
    const reason = this.match(graph, ctx, me.id);
    if (reason) return { matched: false, reason, event: this.summary(ctx), steps: [], variables: ctx.vars };
    const steps = await this.runActions({ id: 'test', owner_id: me.id, conv_id: convId, name: ctx.vars['rule.name'] }, graph, ctx);
    return { matched: true, reason: null, event: this.summary(ctx), steps, variables: ctx.vars };
  }
}
