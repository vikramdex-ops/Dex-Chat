// Decisions: an interactive message holding a small tree. The author asks a question with options;
// each option either closes ("Approved", with an optional note) or reveals a follow-up step (another
// question, or a written answer), up to four steps deep. Everyone in the conversation walks their
// own path; the hub keeps each person's path, tells Automations when someone reaches an end
// (response.confirmed, like polls and forms), and gives the author a results sheet.
import type { DatabaseSync } from 'node:sqlite';
import { DECISION_LIMITS, DECISION_MAX_DEPTH, DECISION_MAX_OPTIONS, DECISION_MAX_STEPS } from '@dex/core';
import type { DecisionOption, DecisionPath, DecisionResults, DecisionStep, DecisionStepView, DecisionView, Message, Ops, PublicUser } from '@dex/core';
import type { Messaging, MsgRow } from './messaging.ts';

export class DecisionError extends Error {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS decisions (
  message_id TEXT PRIMARY KEY,
  tree TEXT NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS decision_paths (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  steps TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  outcome TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
`;

const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const cleanLong = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max) : '');

/**
 * Check what the author sent and give every step and option an id. Throws a DecisionError in plain
 * words for anything a person can fix in the builder.
 */
export function buildDecisionTree(input: unknown): DecisionStep {
  let steps = 0;
  const step = (raw: unknown, depth: number, where: string): DecisionStep => {
    if (depth > DECISION_MAX_DEPTH) throw new DecisionError(`A decision can go ${DECISION_MAX_DEPTH} steps deep. Close an option sooner.`);
    if (!raw || typeof raw !== 'object') throw new DecisionError(`${where} is missing.`);
    if (++steps > DECISION_MAX_STEPS) throw new DecisionError(`A decision can have up to ${DECISION_MAX_STEPS} steps.`);
    const r = raw as Record<string, unknown>;
    const prompt = clean(r.prompt, DECISION_LIMITS.prompt);
    const kind = r.kind === 'text' ? 'text' : 'choice';
    const id = `s${steps}`;
    if (!prompt) throw new DecisionError(depth === 1 ? 'Ask a question.' : `${where} needs a question.`);
    if (kind === 'text') {
      if (depth === 1) throw new DecisionError('Start with a question that has options.');
      return { id, prompt, kind, depth, options: [] };
    }
    const list = Array.isArray(r.options) ? r.options : [];
    if (list.length < 2) throw new DecisionError(`“${prompt.slice(0, 60)}” needs at least two options.`);
    if (list.length > DECISION_MAX_OPTIONS) throw new DecisionError(`“${prompt.slice(0, 60)}” can have up to ${DECISION_MAX_OPTIONS} options.`);
    const seen = new Set<string>();
    const options: DecisionOption[] = list.map((o, i) => {
      const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
      const label = clean(x.label, DECISION_LIMITS.label);
      if (!label) throw new DecisionError(`Option ${i + 1} of “${prompt.slice(0, 60)}” needs a label.`);
      if (seen.has(label.toLowerCase())) throw new DecisionError(`“${prompt.slice(0, 60)}” has the option “${label}” twice.`);
      seen.add(label.toLowerCase());
      const next = x.next ? step(x.next, depth + 1, `The step after “${label}”`) : null;
      const note = next ? null : cleanLong(x.note, DECISION_LIMITS.note) || null;
      return { id: `${id}.${i + 1}`, label, closes: !next, note, next };
    });
    return { id, prompt, kind, depth, options };
  };
  return step(input, 1, 'The first question');
}

const stepView = (s: DecisionStep): DecisionStepView => ({ id: s.id, prompt: s.prompt, kind: s.kind, depth: s.depth, options: s.options.map((o) => ({ id: o.id, label: o.label, closes: o.closes })) });

function treeDepth(s: DecisionStep): number {
  return Math.max(s.depth, ...s.options.map((o) => (o.next ? treeDepth(o.next) : s.depth)));
}

function* allSteps(s: DecisionStep): Generator<DecisionStep> {
  yield s;
  for (const o of s.options) if (o.next) yield* allSteps(o.next);
}

interface Stored { stepId: string; optionId: string | null; text: string | null }
interface PathRow { user_id: string; steps: string; done: number; outcome: string | null; updated_at: number }

/** Follow a stored path through the tree: the steps answered, and what comes next. */
function walk(tree: DecisionStep, stored: Stored[]): { trail: Array<{ step: DecisionStep; option: DecisionOption | null; text: string | null }>; next: DecisionStep | null; end: DecisionOption | null } {
  const trail: Array<{ step: DecisionStep; option: DecisionOption | null; text: string | null }> = [];
  let at: DecisionStep | null = tree;
  let end: DecisionOption | null = null;
  for (const s of stored) {
    if (!at || s.stepId !== at.id) break;
    if (at.kind === 'text') { trail.push({ step: at, option: null, text: s.text ?? '' }); at = null; break; }
    const option: DecisionOption | undefined = at.options.find((o) => o.id === s.optionId);
    if (!option) break;
    trail.push({ step: at, option, text: null });
    if (option.closes) { end = option; at = null; break; }
    at = option.next;
  }
  return { trail, next: at, end };
}

export class Decisions {
  private readonly db: DatabaseSync;
  private readonly messaging: Messaging;
  private readonly trees = new Map<string, DecisionStep | null>();

  constructor(db: DatabaseSync, messaging: Messaging) {
    this.db = db;
    this.messaging = messaging;
    db.exec(SCHEMA);
    messaging.viewExtras.push((r, viewer) => (r.deleted ? {} : this.has(r.id) ? { decision: this.view(r, viewer) } : {}));
    messaging.purgeExtras.push((id) => {
      this.db.prepare('DELETE FROM decision_paths WHERE message_id = ?').run(id);
      this.db.prepare('DELETE FROM decisions WHERE message_id = ?').run(id);
      this.trees.delete(id);
    });
  }

  private has(messageId: string): boolean {
    return this.tree(messageId) !== null;
  }

  private tree(messageId: string): DecisionStep | null {
    if (this.trees.has(messageId)) return this.trees.get(messageId)!;
    const r = this.db.prepare('SELECT tree FROM decisions WHERE message_id = ?').get(messageId) as { tree: string } | undefined;
    let t: DecisionStep | null = null;
    if (r) { try { t = JSON.parse(r.tree) as DecisionStep; } catch { t = null; } }
    if (this.trees.size > 2000) this.trees.clear();
    this.trees.set(messageId, t);
    return t;
  }

  private closed(messageId: string): boolean {
    return !!(this.db.prepare('SELECT closed FROM decisions WHERE message_id = ?').get(messageId) as { closed: number } | undefined)?.closed;
  }

  private stored(raw: string): Stored[] {
    try {
      const v = JSON.parse(raw) as unknown;
      return Array.isArray(v) ? v.slice(0, DECISION_MAX_DEPTH).map((x) => ({ stepId: String((x as Stored).stepId ?? ''), optionId: typeof (x as Stored).optionId === 'string' ? (x as Stored).optionId : null, text: typeof (x as Stored).text === 'string' ? (x as Stored).text : null })) : [];
    } catch { return []; }
  }

  private path(messageId: string, userId: string): PathRow | undefined {
    return this.db.prepare('SELECT user_id, steps, done, outcome, updated_at FROM decision_paths WHERE message_id = ? AND user_id = ?').get(messageId, userId) as PathRow | undefined;
  }

  /** The Decision as one person sees it. */
  view(r: MsgRow, viewer: string | null): DecisionView | null {
    const tree = this.tree(r.id);
    if (!tree) return null;
    const counts = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(done), 0) AS d FROM decision_paths WHERE message_id = ?').get(r.id) as { n: number; d: number };
    const closed = this.closed(r.id);
    const mine = viewer ? this.path(r.id, viewer) : undefined;
    const w = walk(tree, mine ? this.stored(mine.steps) : []);
    const done = !!mine?.done;
    return {
      question: tree.prompt, closed, started: counts.n, finished: counts.d, depth: treeDepth(tree),
      trail: w.trail.map((t) => ({ step: stepView(t.step), optionId: t.option?.id ?? null, text: t.text })),
      current: done || closed || !w.next ? null : stepView(w.next),
      done, outcome: done ? mine?.outcome ?? null : null, note: done ? w.end?.note ?? null : null, finishedAt: done ? mine?.updated_at ?? null : null,
      tree: viewer && viewer === r.author_id ? tree : null,
    };
  }

  handle(op: string, me: PublicUser, d: Record<string, unknown>): unknown {
    const isAdmin = me.role === 'owner' || me.role === 'admin';
    switch (op) {
      case 'decision.create': {
        let c;
        try { c = this.messaging.memberConv(String(d.convId ?? ''), me.id); } catch { throw new DecisionError('Conversation not found.'); }
        if (me.role === 'guest') throw new DecisionError('Guests cannot start Decisions.');
        if (c.kind === 'direct' && this.messaging.members(c.id).length < 2) throw new DecisionError('There is no one here to decide with.');
        const tree = buildDecisionTree(d.root);
        const msg = this.messaging.sendAs(me, c, `Decision: ${tree.prompt}`, d.parentId, [], d.clientId, {});
        if (!this.has(msg.id)) {
          this.db.prepare('INSERT INTO decisions (message_id, tree) VALUES (?, ?)').run(msg.id, JSON.stringify(tree));
          this.trees.delete(msg.id);
          this.messaging.pushUpdate(msg.id);
        }
        return this.messaging.messageFor(msg.id, me.id) satisfies Ops['decision.create']['res'] | null;
      }

      case 'decision.answer': {
        const { row, tree } = this.visible(d.messageId, me);
        if (this.closed(row.id)) throw new DecisionError('This Decision is closed.');
        const mine = this.path(row.id, me.id);
        if (mine?.done) throw new DecisionError('You reached the end of this Decision. Start again to change your answers.');
        const stored = mine ? this.stored(mine.steps) : [];
        const w = walk(tree, stored);
        const step = w.next;
        if (!step || d.stepId !== step.id) throw new DecisionError('That step is no longer the one in front of you.');
        let entry: Stored;
        let end: { choice: string; text: string | null } | null = null;
        if (step.kind === 'text') {
          const text = cleanLong(d.text, DECISION_LIMITS.answer);
          if (!text) throw new DecisionError('Write an answer first.');
          entry = { stepId: step.id, optionId: null, text };
          end = { choice: w.trail.at(-1)?.option?.label ?? step.prompt, text };
        } else {
          const option = step.options.find((o) => o.id === d.optionId);
          if (!option) throw new DecisionError('Choose one of the options.');
          entry = { stepId: step.id, optionId: option.id, text: null };
          if (option.closes) end = { choice: option.label, text: null };
        }
        const steps = [...w.trail.map((t) => ({ stepId: t.step.id, optionId: t.option?.id ?? null, text: t.text })), entry];
        this.db.prepare(`INSERT INTO decision_paths (message_id, user_id, steps, done, outcome, updated_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(message_id, user_id) DO UPDATE SET steps = excluded.steps, done = excluded.done, outcome = excluded.outcome, updated_at = excluded.updated_at`)
          .run(row.id, me.id, JSON.stringify(steps), end ? 1 : 0, end?.choice ?? null, Date.now());
        this.messaging.pushUpdate(row.id);
        if (end) {
          const labels = walk(tree, steps).trail.map((t) => t.option?.label ?? t.text ?? '');
          this.messaging.observe?.({
            kind: 'response.confirmed', messageId: row.id, convId: row.conv_id, userId: me.id, source: 'decision', choice: end.choice,
            answers: { path: labels.join(' › '), ...(end.text ? { answer: end.text } : {}) },
          });
        }
        return this.messaging.messageFor(row.id, me.id) satisfies Message | null;
      }

      case 'decision.reset': {
        const { row } = this.visible(d.messageId, me);
        if (this.closed(row.id)) throw new DecisionError('This Decision is closed.');
        this.db.prepare('DELETE FROM decision_paths WHERE message_id = ? AND user_id = ?').run(row.id, me.id);
        this.messaging.pushUpdate(row.id);
        return this.messaging.messageFor(row.id, me.id);
      }

      case 'decision.close': {
        const { row } = this.visible(d.messageId, me);
        if (row.author_id !== me.id && !isAdmin) throw new DecisionError('Only the person who started this Decision can close it.');
        this.db.prepare('UPDATE decisions SET closed = 1 WHERE message_id = ?').run(row.id);
        this.messaging.pushUpdate(row.id);
        return this.messaging.messageFor(row.id, me.id);
      }

      case 'decision.results': {
        const { row, tree } = this.visible(d.messageId, me);
        if (row.author_id !== me.id && !isAdmin) throw new DecisionError('Only the person who started this Decision can see everyone’s answers.');
        const rows = this.db.prepare('SELECT user_id, steps, done, outcome, updated_at FROM decision_paths WHERE message_id = ? ORDER BY updated_at').all(row.id) as unknown as PathRow[];
        const counts: Record<string, number> = {};
        for (const s of allSteps(tree)) for (const o of s.options) counts[o.id] = 0;
        const people: DecisionPath[] = rows.map((p) => {
          const w = walk(tree, this.stored(p.steps));
          for (const t of w.trail) if (t.option) counts[t.option.id] = (counts[t.option.id] ?? 0) + 1;
          return {
            userId: p.user_id, done: !!p.done, outcome: p.done ? p.outcome : null, at: p.updated_at,
            steps: w.trail.map((t) => ({ stepId: t.step.id, prompt: t.step.prompt, optionId: t.option?.id ?? null, answer: t.option?.label ?? t.text ?? '', text: t.text })),
          };
        });
        const answered = new Set(rows.map((p) => p.user_id));
        const bots = new Set((this.db.prepare(`SELECT id FROM users WHERE role = 'bot'`).all() as Array<{ id: string }>).map((u) => u.id));
        const notStarted = this.messaging.members(row.conv_id).filter((u) => u !== row.author_id && !answered.has(u) && !bots.has(u));
        return { messageId: row.id, question: tree.prompt, closed: this.closed(row.id), tree, people, notStarted, counts } satisfies DecisionResults;
      }
    }
    return undefined;
  }

  /** A Decision message the person may see. */
  private visible(messageId: unknown, me: PublicUser): { row: MsgRow; tree: DecisionStep } {
    const row = typeof messageId === 'string' ? this.messaging.row(messageId) : undefined;
    const tree = row ? this.tree(row.id) : null;
    if (!row || row.deleted || !tree || !this.messaging.isMember(row.conv_id, me.id)) throw new DecisionError('Decision not found.');
    return { row, tree };
  }
}
