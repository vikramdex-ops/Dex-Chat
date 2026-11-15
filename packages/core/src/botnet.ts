// Bots talking to bots: the skills contract (named questions with inputs and outputs that a bot
// publishes), handoffs (a request carried on by another bot, with the answers it needs, and handed
// back with a result), events another bot listens for, and the rules that keep it safe: who may ask
// whom, loops and depth, rate limits, and plain words for every refusal. Pure functions shared by
// the hub, the bot maker and the tests. See docs/BOT-NETWORK.md.
import type { BotAsk, BotFlowAnswer, BotFlowDefinition, BotFlowInfo, BotHandoff, BotNetwork, BotScope, BotSkill, BotSkillField, BotSubscription } from './bots.ts';
import { BotFlowError, renderTemplate, saveKey } from './botflow-engine.ts';
import type { BotFlowVars } from './botflow-engine.ts';
import { checkAskShape } from './botjobs.ts';

/** Hops one request may make from bot to bot (a hands to b hands to c…). */
export const NET_MAX_DEPTH = 4;
/** How long a bot waits for another's answer. */
export const NET_TIMEOUT_MS = 3000;
/** Questions one bot may ask a minute, and handoffs one bot may make a minute. */
export const NET_RATE = { asks: 30, handoffs: 10, perPerson: 4, events: 40, windowMs: 60_000 };
/** People one event may start a bot for, and subscriptions one bot may have. */
export const NET_MAX_SUBS = 8;

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max) : '');
const ID_RE = /^[A-Za-z][\w-]{0,39}$/;
const FLOW_RE = /^[a-z][a-z0-9-]{1,39}$/;

// ---------------------------------------------------------------- the skills bots publish
const f = (id: string, label: string, kind: BotSkillField['kind'], extra: Partial<BotSkillField> = {}): BotSkillField => ({ id, label, kind, ...extra });

/** Skills of the office itself: the Directory, Nib (leave) and the office calendar. */
export const SYSTEM_SKILLS: BotSkill[] = [
  {
    id: 'directory.lead', bot: 'directory', botTitle: 'Directory', title: 'Who is their lead?', short: 'LEAD?', about: 'Their manager in the Directory, else their department’s head.',
    inputs: [f('person', 'Person', 'person')], outputs: [f('lead', 'Lead', 'person'), f('department', 'Department', 'text')], main: 'lead', effect: 'read', system: true, public: true,
  },
  {
    id: 'nib.away', bot: 'nib', botTitle: 'Nib', title: 'Are they on leave?', short: 'AWAY?', about: 'From the leave notes Nib keeps: away on a day, back when, who covers.',
    inputs: [f('person', 'Person', 'person'), f('date', 'On', 'date', { optional: true })], outputs: [f('away', 'On leave', 'yesno'), f('back', 'Back on', 'date'), f('cover', 'Cover', 'person')], main: 'away', effect: 'read', system: true, public: true,
  },
  {
    id: 'nib.awayList', bot: 'nib', botTitle: 'Nib', title: 'Who is on leave?', short: 'WHO IS AWAY?', about: 'Everyone on leave on a day.',
    inputs: [f('date', 'On', 'date', { optional: true })], outputs: [f('count', 'How many', 'number'), f('people', 'Who', 'list')], main: 'count', effect: 'read', system: true, public: true,
  },
  {
    id: 'calendar.workday', bot: 'calendar', botTitle: 'Office calendar', title: 'Is it a working day?', short: 'WORKDAY?', about: 'The office’s working days and holidays.',
    inputs: [f('date', 'Day', 'date', { optional: true })], outputs: [f('working', 'Working day', 'yesno'), f('why', 'Why not', 'text')], main: 'working', effect: 'read', system: true, public: true,
  },
];
export const SYSTEM_BOTS = ['directory', 'nib', 'calendar'];

/**
 * The skills a bot publishes, from what it is: a tracked bot answers how many are open and where
 * a request is; one with limited places (seats) answers whether one is free, and releases a
 * person's places as an errand. A bot that tracks nothing answers how many were sent.
 */
export function skillsOf(def: BotFlowDefinition, o: { public: boolean; title?: string }): BotSkill[] {
  const bot = def.name;
  const botTitle = o.title ?? def.title;
  const base = { bot, botTitle, public: o.public } as const;
  const t = def.track;
  if (!t) {
    return [{ ...base, id: `${bot}.sent`, title: 'How many were sent?', short: 'SENT?', about: `Requests sent with ${botTitle} lately.`, inputs: [f('days', 'In the last (days)', 'number', { optional: true })], outputs: [f('count', 'How many', 'number')], main: 'count', effect: 'read' }];
  }
  const out: BotSkill[] = [
    {
      ...base, id: `${bot}.open`, title: 'How many are open?', short: 'OPEN?', about: `Open ${t.ref} requests, at a stage or older than some days.`,
      inputs: [f('stage', 'At the stage', 'text', { optional: true, options: t.stages.map((s) => s.label) }), f('older', 'Older than (days)', 'number', { optional: true }), f('person', 'Asked by', 'person', { optional: true })],
      outputs: [f('count', 'How many', 'number'), f('oldest', 'Oldest (days)', 'number'), f('refs', 'Requests', 'list')], main: 'count', effect: 'read',
    },
    {
      ...base, id: `${bot}.status`, title: 'Where is a request?', short: 'WHERE?', about: `The stage of one ${t.ref} request and who has it.`,
      inputs: [f('ref', 'Request number', 'text')], outputs: [f('stage', 'Stage', 'text'), f('who', 'With', 'person'), f('stamp', 'Stamp', 'text')], main: 'stage', effect: 'read',
    },
  ];
  const limited = t.stages.find((s) => s.limit);
  if (limited?.limit) {
    const keys = Object.keys(limited.limit.seats);
    out.push({
      ...base, id: `${bot}.seats`, title: 'Is a place free?', short: 'SEAT?', about: `Free places at ${limited.label}${keys.length ? ` (${keys.slice(0, 4).join(', ')}…)` : ''}.`,
      inputs: [f('key', 'Which', 'text', { options: keys })], outputs: [f('free', 'Free', 'number'), f('of', 'Of', 'number'), f('waiting', 'Waiting', 'number')], main: 'free', effect: 'read',
    });
    out.push({
      ...base, id: `${bot}.release`, title: 'Release their places', short: 'RELEASE', about: `Ends the person’s own requests at ${limited.label}, so the next in line moves up.`,
      inputs: [f('person', 'Person', 'person', { optional: true })], outputs: [f('released', 'Released', 'number'), f('refs', 'Requests', 'list')], main: 'released', effect: 'act',
    });
  }
  return out;
}

export const skillBot = (id: string): string => id.slice(0, id.indexOf('.'));

/** The caption and the data of a question on the relay line ("SEAT? · CAESAR II"). */
export function askWords(skill: BotSkill, inputs: Record<string, BotFlowAnswer>): string {
  const data = skill.inputs.map((i) => inputs[i.id]?.label).filter((x): x is string => !!x && x !== '—').map((x) => x.split('\n')[0].slice(0, 40));
  return data.length ? `${skill.short} · ${data.slice(0, 2).join(' · ')}` : skill.short;
}

/** The answer in a word or two ("1 free", "on leave, back Tue 18 Nov", "Ravi Kumar"). */
export function answerWords(skill: BotSkill, values: Record<string, BotFlowAnswer>): string {
  const v = (k: string) => values[k]?.label ?? '';
  const kind = skill.id.slice(skill.id.indexOf('.') + 1);
  switch (kind) {
    case 'seats': return `${v('free')} free`;
    case 'open': return `${v('count')} open`;
    case 'release': return `${v('released')} released`;
    case 'sent': return `${v('count')} sent`;
    case 'away': return values.away?.value === 'yes' ? (v('back') ? `on leave, back ${v('back')}` : 'on leave') : 'in the office';
    case 'awayList': return `${v('count')} away`;
    case 'workday': return values.working?.value === 'yes' ? 'working day' : `day off: ${v('why')}`;
    default: return values[skill.main]?.label || '—';
  }
}

// ---------------------------------------------------------------- checking a definition's network parts
export function checkAsk(v: unknown, where: string): BotAsk {
  try { return checkAskShape(v, where); } catch (err) { throw new BotFlowError((err as Error).message); }
}

export function checkHandoff(v: unknown, where: string, o: { stage?: boolean } = {}): BotHandoff {
  const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const to = str(r.to, 40);
  if (!FLOW_RE.test(to)) throw new BotFlowError(`${where}: say which bot it is handed to ("to": its short name).`);
  const out: BotHandoff = { to };
  if (r.carry && typeof r.carry === 'object' && !Array.isArray(r.carry)) {
    const c = Object.entries(r.carry as Record<string, unknown>).slice(0, 30).map(([k, x]) => [str(k, 40), str(String(x ?? ''), 500)] as const).filter(([k]) => ID_RE.test(k));
    if (c.length) out.carry = Object.fromEntries(c);
  }
  const start = str(r.start, 40);
  if (start) { if (!ID_RE.test(start)) throw new BotFlowError(`${where}: "start" names a stage of the other bot.`); out.start = start; }
  if (o.stage && r.back && typeof r.back === 'object') {
    const b = r.back as Record<string, unknown>;
    const back: BotHandoff['back'] = {};
    for (const k of ['done', 'stopped'] as const) { const x = str(b[k], 40); if (x) back[k] = x; }
    out.back = back;
  }
  return out;
}

const EVENT_RE = /^(nib\.away|[a-z][a-z0-9-]{1,39}\.(opened|closed|stage\.[A-Za-z][\w-]{0,39}))$/;

export function checkNetwork(v: unknown, own: string): BotNetwork {
  const r = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const out: BotNetwork = {};
  if (r.share === 'owner' || r.share === 'users') out.share = r.share;
  if (r.accept === false) out.accept = false;
  if (r.on !== undefined) {
    if (!Array.isArray(r.on)) throw new BotFlowError('"network.on" is a list of things it listens for.');
    if (r.on.length > NET_MAX_SUBS) throw new BotFlowError(`A bot listens for up to ${NET_MAX_SUBS} things.`);
    const ids = new Set<string>();
    out.on = r.on.map((x, i): BotSubscription => {
      const s = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
      const where = `Listening ${i + 1}`;
      const id = str(s.id, 40) || `on${i + 1}`;
      if (!ID_RE.test(id) || ids.has(id)) throw new BotFlowError(`${where}: give it its own short id.`);
      ids.add(id);
      const on = str(s.on, 90);
      if (!EVENT_RE.test(on)) throw new BotFlowError(`${where}: "on" is <bot>.opened, <bot>.closed, <bot>.stage.<stage> or nib.away.`);
      if (on.startsWith(`${own}.`)) throw new BotFlowError(`${where}: a bot does not listen to itself.`);
      const sub: BotSubscription = { id, on, do: s.do === 'tell' ? 'tell' : s.do === 'ask' ? 'ask' : 'start' };
      const stamp = str(s.stamp, 24).toUpperCase();
      if (stamp) sub.stamp = stamp;
      if (sub.do === 'tell') { const text = str(s.text, 1000); if (!text) throw new BotFlowError(`${where}: write what it tells you.`); sub.text = text; }
      if (sub.do === 'ask') { sub.ask = checkAsk(s.ask, where); const text = str(s.text, 1000); if (text) sub.text = text; }
      if (s.carry && typeof s.carry === 'object' && !Array.isArray(s.carry)) {
        const c = Object.entries(s.carry as Record<string, unknown>).slice(0, 30).map(([k, y]) => [str(k, 40), str(String(y ?? ''), 500)] as const).filter(([k]) => ID_RE.test(k));
        if (c.length) sub.carry = Object.fromEntries(c);
      }
      return sub;
    });
  }
  return out;
}

/** Plain words for what it listens to ("When Drawing check closes with ISSUED"). */
export function eventWords(on: string, title: (flow: string) => string, stamp?: string): string {
  if (on === 'nib.away') return 'When someone goes on leave';
  const [flow, what, stage] = on.split('.');
  if (what === 'opened') return `When a ${title(flow)} request is sent`;
  if (what === 'closed') return stamp ? `When a ${title(flow)} request is ${stamp}` : `When a ${title(flow)} request closes`;
  return `When a ${title(flow)} request reaches ${stage}`;
}

// ---------------------------------------------------------------- carrying answers across
/**
 * The raw answers a handoff gives the other bot, by its step variables: those named in `carry`
 * (from this bot's {{placeholders}}), then any answer with the same name. The other bot checks
 * each one again as if the person had written it.
 */
export function carryFor(h: Pick<BotHandoff, 'carry'>, vars: BotFlowVars, target: BotFlowDefinition, extra: { summary?: string; title?: string } = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of target.steps) {
    const key = saveKey(s);
    if (s.ask) continue;
    if (h.carry && key in h.carry) {
      const v = renderTemplate(h.carry[key], vars, extra).trim();
      if (v) out[key] = v.slice(0, 2000);
    } else if (vars[key] && key !== 'user' && !key.startsWith('user.')) out[key] = (vars[key].value || vars[key].label).slice(0, 2000);
  }
  return out;
}

/** The inputs for a skill, filled from the run's {{placeholders}}. */
export function inputsFor(ask: BotAsk, vars: BotFlowVars): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, t] of Object.entries(ask.with ?? {})) {
    const v = renderTemplate(t, vars).trim();
    if (v) out[k] = v.slice(0, 500);
  }
  return out;
}

// ---------------------------------------------------------------- who may ask whom
/** A bot as the rules see it. */
export interface NetParty {
  flow: string;
  ownerId: string | null;
  source: BotFlowInfo['source'];
  scope: BotScope;
  network?: BotNetwork | null;
}

/** An office-wide bot (or the office's own, or an integration's): its skills are public. */
export const isPublic = (p: NetParty): boolean => p.scope === 'office' && (p.network?.share ?? 'users') === 'users';

/**
 * Why a bot may not ask another's skill, or null when it may. A bot asks what its maker may use
 * (their own bots, a Space's they are in, office-wide ones), unless the other bot answers only its
 * own maker's bots; errands (effect "act") are only for the person the flow runs for, unless the
 * caller's maker made the other bot too, or is an administrator.
 */
export function askRefusal(o: { caller: NetParty | null; target: NetParty | 'system'; ownerMayUse: boolean; effect: 'read' | 'act'; forSelf: boolean; ownerIsAdmin: boolean; targetTitle: string }): string | null {
  if (o.target === 'system') return null;
  const t = o.target;
  const same = !!o.caller?.ownerId && o.caller.ownerId === t.ownerId;
  if (!same) {
    if (t.source === 'member' && t.scope === 'private') return `${o.targetTitle} is private to the person who made it.`;
    if ((t.network?.share ?? 'users') === 'owner') return `${o.targetTitle} answers only its own maker’s bots.`;
    if (!o.ownerMayUse && !isPublic(t)) return `${o.targetTitle} is not shared with this bot’s maker.`;
  }
  if (o.effect === 'act' && !o.forSelf && !same && !o.ownerIsAdmin) return `${o.targetTitle} does that only for the person it is for.`;
  return null;
}

/** Why a bot may not hand a request to another, or null when it may. */
export function handoffRefusal(o: { caller: NetParty | null; target: NetParty; targetDef: BotFlowDefinition; ownerMayUse: boolean; personMayUse: boolean; targetTitle: string; start?: string }): string | null {
  const t = o.target;
  const same = !!o.caller?.ownerId && o.caller.ownerId === t.ownerId;
  if (!same && t.source === 'member' && t.scope === 'private') return `${o.targetTitle} is private to the person who made it.`;
  if (t.network?.accept === false) return `${o.targetTitle} does not take requests from other bots.`;
  if (!same && !o.ownerMayUse) return `${o.targetTitle} is not shared with this bot’s maker.`;
  if (!o.personMayUse) return `${o.targetTitle} is not one this person can use.`;
  if (o.start && !o.targetDef.track?.stages.some((s) => s.id === o.start)) return `${o.targetTitle} has no stage “${o.start}” to start at.`;
  return null;
}

// ---------------------------------------------------------------- loops and depth
/** The bots a request has already been through ("drawing-issue>plot-request"), oldest first. */
export const trailOf = (v: string | null | undefined): string[] => (v ? v.split('>').filter((x) => FLOW_RE.test(x) || SYSTEM_BOTS.includes(x)).slice(0, 20) : []);

/** Why going on to `next` would loop or go too deep, or null. */
export function loopRefusal(trail: string[], from: string, next: string, nextTitle: string): string | null {
  const path = trail.length && trail[trail.length - 1] === from ? trail : [...trail, from];
  if (next === from || path.includes(next)) return `Stopped a loop: ${nextTitle} already had this request (${[...path, next].join(' → ')}).`;
  if (path.length >= NET_MAX_DEPTH) return `Stopped: a request may pass through ${NET_MAX_DEPTH} bots at most.`;
  return null;
}

export const extendTrail = (trail: string[], from: string): string => {
  const path = trail.length && trail[trail.length - 1] === from ? trail : [...trail, from];
  return path.slice(-NET_MAX_DEPTH - 1).join('>');
};

// ---------------------------------------------------------------- rate limits
/** A sliding window of counts per key, with the clock passed in (the tests move it). */
export class RateWindow {
  private readonly hits = new Map<string, number[]>();
  /** Counts one more for `key` if under `limit` in the window; false when the limit is reached. */
  take(key: string, limit: number, now: number, windowMs = NET_RATE.windowMs): boolean {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= limit) { this.hits.set(key, list); return false; }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (!v.some((t) => now - t < windowMs)) this.hits.delete(k);
    return true;
  }
}

/** Waits at most `ms` for an answer; a slow bot is a failure, never a hang. */
export async function withTimeout<T>(p: Promise<T>, ms = NET_TIMEOUT_MS): Promise<{ ok: true; value: T } | { ok: false; timeout: boolean; error: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([p, new Promise<never>((_r, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('timeout'), { timeout: true })), ms); })]);
    return { ok: true, value };
  } catch (err) {
    return { ok: false, timeout: !!(err as { timeout?: boolean }).timeout, error: (err as Error).message };
  } finally { if (timer) clearTimeout(timer); }
}

// ---------------------------------------------------------------- tags on the drawings
/** Two or three letters for a bot's instrument tag: its monogram, or the initials of its title. */
export function tagLetters(title: string, letters?: string | null): string {
  if (letters) return letters.slice(0, 3).toUpperCase();
  const w = title.replace(/\(.*?\)/g, ' ').trim().split(/\s+/).filter((x) => /[\p{L}\p{N}]/u.test(x) && !/^(and|of|the|a|for)$/i.test(x));
  if (!w.length) return 'B';
  return (w.length === 1 ? w[0].slice(0, 2) : w.slice(0, 3).map((x) => x[0]).join('')).toUpperCase();
}

/** Every skill a definition asks, every bot it hands to, and every bot it listens to (the network sheet's declared lines). */
export function declaredLinks(def: BotFlowDefinition): Array<{ to: string; kind: 'query' | 'handoff' | 'event' }> {
  const out: Array<{ to: string; kind: 'query' | 'handoff' | 'event' }> = [];
  const add = (to: string, kind: 'query' | 'handoff' | 'event') => { if (to && to !== def.name && !out.some((x) => x.to === to && x.kind === kind)) out.push({ to, kind }); };
  for (const s of def.steps) if (s.ask) add(skillBot(s.ask.skill), 'query');
  for (const a of def.finish) if (a.do === 'handoff') add(a.to, 'handoff');
  for (const st of def.track?.stages ?? []) {
    if (st.who.startsWith('bot:')) add(st.who.slice(4), 'handoff');
    for (const a of st.actions) if (a.handoff) add(a.handoff.to, 'handoff');
  }
  for (const s of def.network?.on ?? []) { add(s.on === 'nib.away' ? 'nib' : s.on.split('.')[0], 'event'); if (s.ask) add(skillBot(s.ask.skill), 'query'); }
  for (const j of def.jobs ?? []) if (j.do.do === 'check' || j.do.do === 'ask') add(skillBot(j.do.ask.skill), 'query');
  return out;
}
