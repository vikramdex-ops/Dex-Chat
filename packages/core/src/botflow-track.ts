// After a bot's questions are answered: the request lives on. Each one gets a number (DC-0007)
// and moves through stages where other people act (check, approve, plot, issue), with a button
// for each way on, a note when one is asked for, a checklist to tick, a queue where places are
// limited (software seats), gentle reminders and, once, a word to the lead. The rules are pure
// functions shared by the hub (which keeps the requests and posts the cards) and the bot maker's
// test run (which plays every part on one screen), so both say and do exactly the same.
import type { BotFlowAnswer, BotFlowDefinition, BotFlowRole, BotFlowStage, BotFlowStageAction, BotFlowStep, BotFlowTrack, BotItem, BotItemEvent, BotItemStatus, BotRegisterView, BotTrackView, BotWho } from './bots.ts';
import { BotFlowError, renderTemplate } from './botflow-engine.ts';

const ID_RE = /^[A-Za-z][\w-]{0,39}$/;
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const TRACK_MAX_STAGES = 12;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** Reminders when the maker says nothing: after a day, twice, then their lead. */
export const TRACK_REMIND_DEFAULT = { afterHours: 24, times: 2, escalate: 'lead' } as const;
/** When reminders go out when the bot keeps no hours of its own: the office's working week. */
export const OFFICE_WEEK = { days: [1, 2, 3, 4, 5, 6], from: '09:30', to: '18:30' };

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max) : '');

// ---------------------------------------------------------------- checking a definition
function checkWho(v: unknown, where: string, saves: Map<string, BotFlowStep>, roles: Record<string, BotFlowRole>): BotWho {
  const w = str(v, 50);
  if (w === 'requester' || w === 'lead') return w;
  if (w.startsWith('role:')) {
    if (!roles[w.slice(5)]) throw new BotFlowError(`${where}: "who" names the role "${w.slice(5)}", which is not in "roles".`);
    return w;
  }
  const step = saves.get(w);
  if (!step || step.input.kind !== 'person') throw new BotFlowError(`${where}: "who" is "requester", "lead", "role:<name>" or a step that picks a person.`);
  return w;
}

function checkAction(v: unknown, where: string): BotFlowStageAction {
  if (!v || typeof v !== 'object') throw new BotFlowError(`${where} must be an object.`);
  const r = v as Record<string, unknown>;
  const id = str(r.id, 40);
  if (!ID_RE.test(id)) throw new BotFlowError(`${where}: give it an "id" (letters, digits, _ and -).`);
  const label = str(r.label, 40);
  if (!label) throw new BotFlowError(`${where}: give the button its words ("label").`);
  const to = str(r.to, 40);
  if (!to) throw new BotFlowError(`${where}: say where it goes ("to": a stage or "end").`);
  const out: BotFlowStageAction = { id, label, to };
  const stamp = str(r.stamp, 24);
  if (stamp) out.stamp = stamp;
  if (r.outcome === 'stopped' || r.outcome === 'done') out.outcome = r.outcome;
  if (r.note === 'optional' || r.note === 'required') out.note = r.note;
  const ask = str(r.ask, 40);
  if (ask) out.ask = ask;
  if (r.needsChecks === true) out.needsChecks = true;
  if (r.tone === 'go' || r.tone === 'back' || r.tone === 'stop') out.tone = r.tone;
  return out;
}

/** Check and tidy the "track" part of a definition (called by validateFlow). */
export function checkTrack(raw: unknown, saves: Map<string, BotFlowStep>): BotFlowTrack {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BotFlowError('"track" is an object with a "ref" and "stages".');
  const r = raw as Record<string, unknown>;
  const ref = str(r.ref, 10).toUpperCase();
  if (!/^[A-Z]{1,4}$/.test(ref)) throw new BotFlowError('Track: "ref" is one to four letters, like DC.');
  const roles: Record<string, BotFlowRole> = {};
  if (r.roles !== undefined) {
    if (!r.roles || typeof r.roles !== 'object' || Array.isArray(r.roles)) throw new BotFlowError('Track: "roles" is an object such as {"plotroom": {"label": "Plot room"}}.');
    for (const [k, v] of Object.entries(r.roles as Record<string, unknown>).slice(0, 10)) {
      if (!ID_RE.test(k)) throw new BotFlowError(`Track: the role "${k}" needs a short name (letters, digits, _ and -).`);
      const x = (v ?? {}) as Record<string, unknown>;
      const label = str(x.label, 40);
      if (!label) throw new BotFlowError(`Role "${k}": give it a name people read, like "Plot room".`);
      const role: BotFlowRole = { label };
      const person = str(x.person, 40);
      if (person) role.person = person;
      roles[k] = role;
    }
  }
  if (!Array.isArray(r.stages) || !r.stages.length) throw new BotFlowError('Track: give it at least one stage.');
  if (r.stages.length > TRACK_MAX_STAGES) throw new BotFlowError(`Track: up to ${TRACK_MAX_STAGES} stages.`);
  const ids = new Set<string>();
  const stages: BotFlowStage[] = r.stages.map((s, i) => {
    const where0 = `Stage ${i + 1}`;
    if (!s || typeof s !== 'object') throw new BotFlowError(`${where0} must be an object.`);
    const x = s as Record<string, unknown>;
    const id = str(x.id, 40);
    if (!ID_RE.test(id)) throw new BotFlowError(`${where0}: give it an "id" (letters, digits, _ and -).`);
    if (ids.has(id) || id === 'end') throw new BotFlowError(`${where0}: the id "${id}" is used twice.`);
    ids.add(id);
    const where = `Stage "${id}"`;
    const label = str(x.label, 40);
    if (!label) throw new BotFlowError(`${where}: give it a short name ("label").`);
    const prompt = str(x.prompt, 1000);
    if (!prompt) throw new BotFlowError(`${where}: say what the person acting is asked ("prompt").`);
    if (!Array.isArray(x.actions) || !x.actions.length) throw new BotFlowError(`${where}: give it at least one button ("actions").`);
    const actions = x.actions.slice(0, 5).map((a, j) => checkAction(a, `${where}, button ${j + 1}`));
    if (new Set(actions.map((a) => a.id)).size !== actions.length) throw new BotFlowError(`${where}: each button needs its own id.`);
    const stage: BotFlowStage = { id, label, who: checkWho(x.who, where, saves, roles), prompt, actions };
    if (Array.isArray(x.checklist)) {
      const list = x.checklist.slice(0, 12).map((c) => str(String(c), 80)).filter(Boolean);
      if (list.length) stage.checklist = list;
    }
    if (actions.some((a) => a.needsChecks) && !stage.checklist) throw new BotFlowError(`${where}: a button needs the checklist ticked, but there is no checklist.`);
    if (x.due !== undefined) {
      const due = str(x.due, 40);
      const step = saves.get(due);
      if (!step || step.input.kind !== 'text' || step.input.validate?.type !== 'date') throw new BotFlowError(`${where}: "due" should name a step that asks for a date.`);
      stage.due = due;
    }
    if (typeof x.dueInDays === 'number' && Number.isFinite(x.dueInDays)) stage.dueInDays = Math.max(0, Math.min(365, Math.round(x.dueInDays)));
    if (x.limit !== undefined && x.limit !== null) {
      const l = x.limit as Record<string, unknown>;
      const by = l.by === undefined ? undefined : str(l.by, 40);
      if (by !== undefined && !saves.has(by)) throw new BotFlowError(`${where}: the queue is counted by "${by}", which is not an answer.`);
      const seats: Record<string, number> = {};
      if (l.seats && typeof l.seats === 'object' && !Array.isArray(l.seats)) {
        for (const [k, n] of Object.entries(l.seats as Record<string, unknown>).slice(0, 30)) {
          if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new BotFlowError(`${where}: the places for "${k}" must be a number.`);
          seats[str(k, 120)] = Math.min(999, Math.round(n));
        }
      }
      const otherwise = typeof l.otherwise === 'number' && Number.isFinite(l.otherwise) ? Math.max(1, Math.min(999, Math.round(l.otherwise))) : 1;
      stage.limit = { ...(by ? { by } : {}), seats, otherwise };
    }
    if (typeof x.task === 'boolean') stage.task = x.task;
    return stage;
  });
  for (const s of stages) for (const a of s.actions) {
    if (a.to !== 'end' && !ids.has(a.to)) throw new BotFlowError(`Stage "${s.id}": the button "${a.label}" goes to "${a.to}", which is not a stage.`);
  }
  // some way through must finish it
  const seen = new Set<string>();
  const walk = (id: string): boolean => {
    if (id === 'end') return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return (stages.find((s) => s.id === id)?.actions ?? []).some((a) => walk(a.to));
  };
  if (!walk(stages[0].id)) throw new BotFlowError('Track: no button finishes it. Give a stage a button that goes to the end.');
  const out: BotFlowTrack = { ref, stages };
  const name = str(r.name, 200);
  if (name) out.name = name;
  if (Object.keys(roles).length) out.roles = roles;
  if (r.remind !== undefined && r.remind !== null) {
    const m = r.remind as Record<string, unknown>;
    const afterHours = typeof m.afterHours === 'number' && Number.isFinite(m.afterHours) ? Math.max(1, Math.min(720, m.afterHours)) : TRACK_REMIND_DEFAULT.afterHours;
    const times = typeof m.times === 'number' && Number.isFinite(m.times) ? Math.max(0, Math.min(5, Math.round(m.times))) : TRACK_REMIND_DEFAULT.times;
    const esc = str(m.escalate, 50) || TRACK_REMIND_DEFAULT.escalate;
    if (esc !== 'lead' && esc !== 'none' && !(esc.startsWith('role:') && roles[esc.slice(5)])) throw new BotFlowError('Track: reminders are passed up to "lead", "role:<name>" or "none".');
    out.remind = { afterHours, times, escalate: esc };
  }
  if (r.register !== undefined && r.register !== null) {
    const g = r.register as Record<string, unknown>;
    const reg: NonNullable<BotFlowTrack['register']> = {};
    const to = str(g.to, 120);
    if (to) {
      if (to !== 'owner' && !/^space:.+/.test(to) && !(to.startsWith('role:') && roles[to.slice(5)])) throw new BotFlowError('Track: the register goes to "owner", "space:<name>" or "role:<name>".');
      reg.to = to;
    }
    const at = str(g.at, 5);
    if (at) {
      if (!HM_RE.test(at)) throw new BotFlowError('Track: the register\'s time is like 09:15.');
      reg.at = at;
    }
    if (Array.isArray(g.days)) reg.days = [...new Set(g.days.filter((d): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6))].sort();
    if (Array.isArray(g.columns)) reg.columns = g.columns.slice(0, 4).map((c) => str(String(c), 40)).filter((c) => saves.has(c));
    out.register = reg;
  }
  return out;
}

// ---------------------------------------------------------------- people
/** How the hub (or the test run) finds a person for a "who". */
export interface TrackPeople {
  resolve: (who: BotWho, item: BotItem) => { id: string; note?: string | null } | null;
}

/** The person a step picked, when `who` names such a step (a step called "lead" wins over the directory's lead). */
export function personAnswer(def: BotFlowDefinition, who: BotWho, item: Pick<BotItem, 'vars'>): string | null {
  const step = def.steps.find((s) => (s.save ?? s.id) === who && s.input.kind === 'person');
  return step ? item.vars[who]?.value || null : null;
}

export const stageOf = (def: BotFlowDefinition, id: string | null | undefined): BotFlowStage | undefined => def.track?.stages.find((s) => s.id === id);

/** A role's name for people ("Plot room"), or the plain words for the other kinds of "who". */
export function whoWords(def: BotFlowDefinition, who: BotWho): string {
  const step = def.steps.find((s) => (s.save ?? s.id) === who && s.input.kind === 'person');
  if (step) return step.label ?? who;
  if (who === 'requester') return 'The person who asked';
  if (who === 'lead') return 'Their lead';
  if (who.startsWith('role:')) return def.track?.roles?.[who.slice(5)]?.label ?? who.slice(5);
  return def.steps.find((s) => (s.save ?? s.id) === who)?.label ?? who;
}

// ---------------------------------------------------------------- a request's life
const ev = (e: BotItemEvent): BotItemEvent => e;

/** The due moment of a stage: the end of the working day on a date answer, or days from now. */
export function stageDue(stage: BotFlowStage, vars: Record<string, BotFlowAnswer>, now: number): number | null {
  if (stage.due) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(vars[stage.due]?.value ?? '');
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 18, 30, 0, 0).getTime();
  }
  if (stage.dueInDays !== undefined) return now + stage.dueInDays * DAY;
  return null;
}

/** Into a stage: the person acting is found, the clock and the checklist start again. */
export function enterStage(def: BotFlowDefinition, item: BotItem, stageId: string, now: number, people: TrackPeople): BotItem {
  const stage = stageOf(def, stageId);
  if (!stage) throw new BotFlowError('This bot changed: that stage is not in it any more.');
  const next: BotItem = { ...item, stage: stage.id, since: now, updatedAt: now, nudges: 0, escalated: false, checks: [], waiting: false, rounds: { ...item.rounds, [stage.id]: (item.rounds[stage.id] ?? 0) + 1 } };
  const who = people.resolve(stage.who, next);
  next.actorId = who?.id ?? null;
  next.actorNote = who?.note ?? null;
  next.due = stageDue(stage, item.vars, now);
  return next;
}

/** A new request at the first stage. */
export function trackOpen(def: BotFlowDefinition, o: { id: string; num: number; requesterId: string; vars: Record<string, BotFlowAnswer>; lines: Array<{ label: string; value: string }>; now: number; people: TrackPeople }): BotItem {
  const t = def.track;
  if (!t) throw new BotFlowError('This bot does not track requests.');
  const ref = `${t.ref}-${String(o.num).padStart(4, '0')}`;
  const named = t.name ? renderTemplate(t.name, o.vars, { title: def.title }).replace(/\s+/g, ' ').trim() : '';
  const title = (named || o.lines[0]?.value || def.title).split('\n')[0].slice(0, 120);
  const item: BotItem = {
    id: o.id, flow: def.name, ref, title, requesterId: o.requesterId, stage: null, actorId: null, actorNote: null, status: 'open', stamp: null,
    vars: o.vars, lines: o.lines, since: o.now, due: null, createdAt: o.now, updatedAt: o.now, closedAt: null,
    history: [ev({ at: o.now, by: o.requesterId, stage: null, action: 'start', label: 'Sent', to: t.stages[0].id })],
    checks: [], nudges: 0, escalated: false, waiting: false, rounds: {},
  };
  return enterStage(def, item, t.stages[0].id, o.now, o.people);
}

function close(item: BotItem, status: BotItemStatus, stamp: string, now: number): BotItem {
  return { ...item, status, stamp, stage: item.stage, actorId: null, actorNote: null, waiting: false, closedAt: now, updatedAt: now, due: null };
}

/** The person acting presses a button. Throws a BotFlowError worded for them. */
export function trackAct(def: BotFlowDefinition, item: BotItem, actionId: string, by: string, now: number, people: TrackPeople, note = ''): BotItem {
  if (item.status !== 'open') throw new BotFlowError(`${item.ref} is already closed.`);
  const stage = stageOf(def, item.stage);
  if (!stage) throw new BotFlowError('This bot changed: that stage is not in it any more.');
  if (item.waiting) throw new BotFlowError(`${item.ref} is waiting for a place in the queue.`);
  if (item.actorId !== by) throw new BotFlowError(`${item.ref} is not waiting for you.`);
  const a = stage.actions.find((x) => x.id === actionId);
  if (!a) throw new BotFlowError('That button is not on this stage any more.');
  const text = str(note, 2000);
  if (a.note === 'required' && !text) throw new BotFlowError(`Write ${a.ask ? `the ${a.ask.toLowerCase()}` : 'a note'} first.`);
  if (a.needsChecks && (stage.checklist ?? []).some((_c, i) => !item.checks.includes(i))) throw new BotFlowError('Tick every line of the checklist first.');
  const history = [...item.history, ev({ at: now, by, stage: stage.id, action: a.id, label: a.label, ...(text ? { note: text } : {}), to: a.to })];
  const after: BotItem = { ...item, history, updatedAt: now, vars: text ? { ...item.vars, note: { value: text, label: text } } : item.vars };
  if (a.to === 'end') {
    const outcome = a.outcome ?? (a.tone === 'stop' ? 'stopped' : 'done');
    return close(after, outcome, a.stamp ?? (outcome === 'stopped' ? 'STOPPED' : 'DONE'), now);
  }
  return enterStage(def, after, a.to, now, people);
}

/** The person who asked takes it back. */
export function trackWithdraw(item: BotItem, by: string, now: number, note = ''): BotItem {
  if (item.status !== 'open') throw new BotFlowError(`${item.ref} is already closed.`);
  if (item.requesterId !== by) throw new BotFlowError('Only the person who asked can withdraw it.');
  const text = str(note, 2000);
  const history = [...item.history, ev({ at: now, by, stage: item.stage, action: 'withdraw', label: 'Withdrawn', ...(text ? { note: text } : {}), to: 'end' })];
  return close({ ...item, history }, 'withdrawn', 'WITHDRAWN', now);
}

/** Tick a line of the checklist (the person acting). */
export function trackTick(def: BotFlowDefinition, item: BotItem, index: number, on: boolean, by: string): BotItem {
  if (item.status !== 'open' || item.actorId !== by) throw new BotFlowError(`${item.ref} is not waiting for you.`);
  const list = stageOf(def, item.stage)?.checklist ?? [];
  if (!Number.isInteger(index) || index < 0 || index >= list.length) throw new BotFlowError('That line is not on the checklist.');
  const checks = on ? [...new Set([...item.checks, index])].sort((x, y) => x - y) : item.checks.filter((i) => i !== index);
  return { ...item, checks };
}

/** Someone it was passed up to takes over the stage it is waiting at. */
export function trackTakeOver(item: BotItem, by: string, now: number): BotItem {
  if (item.status !== 'open') throw new BotFlowError(`${item.ref} is already closed.`);
  if (item.actorId === by) throw new BotFlowError(`${item.ref} is already with you.`);
  const history = [...item.history, ev({ at: now, by, stage: item.stage, action: 'takeover', label: 'Taken over', to: item.stage })];
  return { ...item, history, actorId: by, actorNote: null, since: now, nudges: 0, escalated: true, updatedAt: now };
}

/** Noted on the request: a reminder sent, or passed up to a lead. */
export function trackNoted(item: BotItem, action: 'nudge' | 'escalate', now: number, toId: string | null): BotItem {
  const history = [...item.history, ev({ at: now, by: null, stage: item.stage, action, label: action === 'nudge' ? 'Reminder' : 'Passed up', ...(toId ? { note: toId } : {}) })];
  return action === 'nudge' ? { ...item, history, nudges: item.nudges + 1 } : { ...item, history, escalated: true };
}

// ---------------------------------------------------------------- queues with limited places
/** Which queue a request is in at a stage with a limit (the answer it is counted by). */
export const seatKey = (stage: BotFlowStage, item: Pick<BotItem, 'vars'>): string => (stage.limit?.by ? item.vars[stage.limit.by]?.label || item.vars[stage.limit.by]?.value || '—' : 'all');
/** How many places that queue has. */
export function seatLimit(stage: BotFlowStage, key: string, item?: Pick<BotItem, 'vars'>): number {
  const l = stage.limit;
  if (!l) return Infinity;
  const value = item && l.by ? item.vars[l.by]?.value : undefined;
  return l.seats[key] ?? (value !== undefined ? l.seats[value] : undefined) ?? l.otherwise;
}

// ---------------------------------------------------------------- reminders
/** What is due for a request now: a reminder to the person acting, passing it up, or nothing. */
export function nudgeDue(def: BotFlowDefinition, item: BotItem, now: number): 'nudge' | 'escalate' | null {
  if (item.status !== 'open' || item.waiting || !item.actorId) return null;
  const r = def.track?.remind ?? TRACK_REMIND_DEFAULT;
  const step = r.afterHours * HOUR;
  // past its due date, the first reminder comes at once
  const overdue = item.due !== null && now > item.due;
  const waited = now - item.since;
  if (item.nudges < r.times && (waited >= (item.nudges + 1) * step || (overdue && item.nudges === 0))) return 'nudge';
  if (!item.escalated && (r.escalate ?? 'lead') !== 'none' && waited >= (r.times + 1) * step && item.actorId !== item.requesterId) return 'escalate';
  return null;
}

// ---------------------------------------------------------------- how a card shows it
/** The stages on the main way through: from the first, along the button that carries it on. */
export function mainWay(def: BotFlowDefinition): string[] {
  const t = def.track;
  if (!t) return [];
  const out: string[] = [];
  let cur: string | undefined = t.stages[0].id;
  while (cur && cur !== 'end' && !out.includes(cur) && out.length < TRACK_MAX_STAGES) {
    out.push(cur);
    const s = stageOf(def, cur);
    const on: BotFlowStageAction | undefined = s?.actions.find((a) => a.tone === 'go' && a.to !== cur) ?? s?.actions.find((a) => a.tone !== 'back' && a.tone !== 'stop' && a.to !== cur);
    cur = on?.to;
  }
  return out;
}

export function trackView(def: BotFlowDefinition, item: BotItem, viewerId: string, o: { now: number; canTakeOver?: boolean; queue?: BotTrackView['queue']; moved?: boolean; actingAs?: boolean } = { now: Date.now() }): BotTrackView {
  const stage = item.status === 'open' ? stageOf(def, item.stage) : undefined;
  const role: BotTrackView['role'] = item.status === 'open' && !item.waiting && (o.actingAs || item.actorId === viewerId) ? 'actor' : item.requesterId === viewerId ? 'requester' : 'watcher';
  const visited = new Set(item.history.map((e) => e.stage).filter((x): x is string => !!x));
  const way = mainWay(def);
  if (item.stage && !way.includes(item.stage)) way.push(item.stage);
  const lastAt = (id: string) => [...item.history].reverse().find((e) => e.stage === id);
  const stages = way.map((id) => {
    const s = stageOf(def, id)!;
    const here = item.status === 'open' && item.stage === id;
    const back = stageOf(def, id)?.actions.find((a) => a.id === lastAt(id)?.action)?.tone === 'back';
    const state: BotTrackView['stages'][number]['state'] = here ? 'here' : item.status === 'done' ? 'done' : visited.has(id) ? (back ? 'returned' : 'done') : 'todo';
    return { id, label: s.label, state, ...((item.rounds[id] ?? 0) > 1 ? { round: item.rounds[id] } : {}) };
  });
  const lastNote = [...item.history].reverse().find((e) => e.note && e.action !== 'nudge' && e.action !== 'escalate')?.note ?? '';
  const vars = { ...item.vars, note: { value: lastNote, label: lastNote || '—' }, ref: { value: item.ref, label: item.ref } };
  return {
    itemId: item.id, flow: item.flow, ref: item.ref, title: item.title, status: item.status, stamp: item.stamp, stages,
    stage: stage ? {
      id: stage.id, label: stage.label, round: item.rounds[stage.id] ?? 1, prompt: renderTemplate(stage.prompt, vars, { title: def.title }),
      who: item.actorId, whoNote: item.actorNote ?? null, since: item.since, due: item.due, overdue: item.due !== null && o.now > item.due,
      checklist: stage.checklist ?? [], checks: item.checks,
    } : null,
    requesterId: item.requesterId, lines: item.lines, history: item.history.slice(-12),
    actions: role === 'actor' && stage ? stage.actions : [],
    role, canWithdraw: item.status === 'open' && item.requesterId === viewerId, canTakeOver: !!o.canTakeOver && item.status === 'open' && item.actorId !== viewerId,
    queue: o.queue ?? null, ...(o.moved ? { moved: true } : {}), createdAt: item.createdAt, closedAt: item.closedAt,
    ...(o.actingAs && stage ? { actingAs: whoWords(def, stage.who) } : {}),
  };
}

/** The place of a waiting request in its queue, and who holds the places now. */
export function queueOf(def: BotFlowDefinition, item: BotItem, all: BotItem[]): BotTrackView['queue'] {
  const stage = stageOf(def, item.stage);
  if (!stage || item.status !== 'open') return null;
  if (!stage.limit) {
    // no places to count: its place among the requests waiting for the same person here (the plot room's queue)
    if (!item.actorId || item.actorId === item.requesterId) return null;
    const line = all.filter((x) => x.status === 'open' && x.stage === stage.id && x.actorId === item.actorId).sort((a, b) => a.since - b.since || a.createdAt - b.createdAt);
    return line.length > 1 ? { position: line.findIndex((x) => x.id === item.id) + 1, of: line.length, key: '', holders: [] } : null;
  }
  const key = seatKey(stage, item);
  const here = all.filter((x) => x.status === 'open' && x.stage === stage.id && seatKey(stage, x) === key);
  const holders = here.filter((x) => !x.waiting).sort((a, b) => a.since - b.since).map((x) => ({ userId: x.actorId ?? x.requesterId, since: x.since, ref: x.ref }));
  if (!item.waiting) return { position: 0, of: here.filter((x) => x.waiting).length, key, holders };
  const line = here.filter((x) => x.waiting).sort((a, b) => a.since - b.since || a.createdAt - b.createdAt);
  return { position: line.findIndex((x) => x.id === item.id) + 1, of: line.length, key, holders };
}

/** The register: counts, the oldest, each stage, the queues, and the requests themselves. */
export function registerView(def: BotFlowDefinition, open: BotItem[], closed: BotItem[], o: { mode: BotRegisterView['mode']; viewerId: string; now: number; canTakeOver?: (i: BotItem) => boolean; limit?: number }): BotRegisterView {
  const live = open.filter((i) => i.status === 'open');
  const overdue = (i: BotItem) => i.due !== null && o.now > i.due;
  const stages = def.track?.stages ?? [];
  const seats: BotRegisterView['seats'] = [];
  for (const s of stages.filter((x) => x.limit)) {
    const keys = new Set<string>([...Object.keys(s.limit!.seats), ...live.filter((i) => i.stage === s.id).map((i) => seatKey(s, i))]);
    for (const key of keys) {
      const here = live.filter((i) => i.stage === s.id && seatKey(s, i) === key);
      const sample = here[0];
      seats.push({
        key, seats: seatLimit(s, key, sample),
        used: here.filter((i) => !i.waiting).sort((a, b) => a.since - b.since).map((i) => ({ userId: i.actorId ?? i.requesterId, since: i.since, ref: i.ref, itemId: i.id })),
        waiting: here.filter((i) => i.waiting).sort((a, b) => a.since - b.since).map((i) => ({ userId: i.requesterId, since: i.since, ref: i.ref, itemId: i.id })),
      });
    }
  }
  const rows = [...live].sort((a, b) => Number(overdue(b)) - Number(overdue(a)) || a.createdAt - b.createdAt);
  const max = o.limit ?? 30;
  return {
    flow: def.name, title: def.title, mode: o.mode,
    counts: { open: live.length, overdue: live.filter(overdue).length, waiting: live.filter((i) => i.waiting).length, closedWeek: closed.filter((i) => (i.closedAt ?? 0) > o.now - 7 * DAY).length },
    oldestDays: live.length ? Math.floor((o.now - Math.min(...live.map((i) => i.createdAt))) / DAY) : 0,
    byStage: stages.map((s) => ({ id: s.id, label: s.label, open: live.filter((i) => i.stage === s.id).length, overdue: live.filter((i) => i.stage === s.id && overdue(i)).length })),
    seats,
    rows: rows.slice(0, max).map((i) => trackView(def, i, o.viewerId, { now: o.now, canTakeOver: o.canTakeOver?.(i), queue: queueOf(def, i, live) })),
    more: Math.max(0, rows.length - max),
    closed: [...closed].sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)).slice(0, 5).map((i) => ({ itemId: i.id, ref: i.ref, title: i.title, stamp: i.stamp, status: i.status, closedAt: i.closedAt ?? 0 })),
    columns: def.track?.register?.columns ?? [],
    at: o.now,
  };
}

/** One line for the maker: what happens to a request after it is sent. */
export function describeTrack(def: BotFlowDefinition): string[] {
  const t = def.track;
  if (!t) return [];
  return t.stages.map((s, i) => `${String(i + 1).padStart(2, '0')} ${s.label}: ${whoWords(def, s.who)} — ${s.actions.map((a) => a.label).join(' / ')}`);
}
