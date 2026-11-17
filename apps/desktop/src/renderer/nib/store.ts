// Nib on the client: your own day (nib.me, kept live), whether the tray and the callout are open,
// the cards Nib posted (fetched once, refreshed when the hub says they changed) and the words you
// write to Nib, read on this PC by the same rules the hub uses (and the on-device sentence model
// when it is already loaded for Automations or the bot maker).
import { useSyncExternalStore } from 'react';
import type { NibCard, NibCardKind, NibItemInput, NibLeaveInput, NibMe, NibParse, NibPerson, PublicUser } from '@dex/core';
import { NIB_ACCOUNT, NIB_INTENT_EXAMPLES, parseWork } from '@dex/core/nib';
import { modelRanker, modelState } from '../flows/model.ts';

export type TrayView =
  | { v: 'home' }
  | { v: 'start' }
  | { v: 'wrap' }
  | { v: 'leave'; from?: string }
  | { v: 'skill'; skill: SkillId; query: string }
  | { v: 'welcome' }
  | { v: 'brief' };
export type SkillId = 'brief' | 'who' | 'where' | 'meeting' | 'help' | 'remind';

interface NibState {
  me: NibMe | null;
  open: boolean;
  view: TrayView;
  /** Text to put in Nib's box when the tray opens (a slash command, the global shortcut). */
  seed: string;
  /** The callout under the tile: what it is for, and which ask it belongs to (dismissed per ask). */
  callout: 'start' | 'wrap' | null;
  dismissed: Set<string>;
}

let state: NibState = { me: null, open: false, view: { v: 'home' }, seed: '', callout: null, dismissed: new Set() };
const listeners = new Set<() => void>();
const set = (patch: Partial<NibState>) => { state = { ...state, ...patch }; for (const l of listeners) l(); };
export function useNib<T>(sel: (s: NibState) => T): T {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => sel(state));
}
export const nibNow = () => state;
/** Your own id (Nib's words address you by name). */
export const nibMeId = () => meId;

let wired = false;
let directory: () => PublicUser[] = () => [];
let meId = '';

/** The person-facing id of Nib, before nib.me answers (from the Directory). */
export function nibBotId(users: PublicUser[] = directory()): string | null {
  return state.me?.botId ?? users.find((u) => u.account === NIB_ACCOUNT)?.id ?? null;
}
export const isNibConv = (members: string[], users?: PublicUser[]): boolean => { const id = nibBotId(users); return !!id && members.length === 2 && members.includes(id); };

export async function startNib(me: string, users: () => PublicUser[]): Promise<void> {
  meId = me;
  directory = users;
  if (!wired) {
    wired = true;
    window.dex.onHubEvent((name, data) => {
      if (name === 'nib.me') { if (data) take(data as NibMe); }
      if (name === 'nib.changed') { const c = data as { date: string; kinds: NibCardKind[] }; for (const k of c.kinds) bump(k); }
    });
  }
  await refreshNib();
}
export async function refreshNib(): Promise<void> {
  try { take(await window.dex.request('nib.me')); } catch { /* offline, or an older hub */ }
}
function take(me: NibMe): void {
  const prev = state.me;
  // the callout shows for the start of the day and for a wrap-up ask from the second step
  let callout: NibState['callout'] = null;
  const n = me.nudge;
  if (me.enabled && !me.exempt && n && n.level >= 2 && !state.dismissed.has(askKey(me))) callout = n.kind === 'wrap' ? 'wrap' : 'start';
  set({ me, callout: state.open ? null : callout });
  void prev;
}
// a wrap-up ask that shows the callout again (4 or 5 asks a day) brings it back after a Not now
const askKey = (me: NibMe) => `${me.date}:${me.nudge?.kind}:${me.nudge?.level}${me.nudge?.kind === 'wrap' ? `:${me.nudge.asks}` : ''}`;

// ------------------------------------------------------------------ the tray and the callout
export function openTray(view: TrayView = { v: 'home' }, seed = ''): void {
  set({ open: true, view, seed, callout: null });
}
export function setView(view: TrayView): void { set({ view }); }
export function closeTray(): void { set({ open: false, view: { v: 'home' }, seed: '' }); }
export function toggleTray(): void { if (state.open) closeTray(); else openTray(state.callout === 'wrap' ? { v: 'wrap' } : state.callout === 'start' ? { v: 'start' } : { v: 'home' }); }
/** Close the callout for this ask (it comes back only at the next step). */
export function dismissCallout(): void {
  const me = state.me;
  const dismissed = new Set(state.dismissed);
  if (me) dismissed.add(askKey(me));
  set({ callout: null, dismissed });
}
/** Show the start card in the callout now (the day was just started). */
export function promptStart(): void {
  const me = state.me;
  if (!me || !me.enabled || me.exempt || !me.workday || me.day.started || me.day.state !== 'open' || state.open) return;
  if (state.dismissed.has(`${me.date}:start-now`)) return;
  const dismissed = new Set(state.dismissed);
  dismissed.add(`${me.date}:start-now`);
  set({ callout: 'start', dismissed });
}

// ------------------------------------------------------------------ actions
const req = window.dex?.request;
async function act<T extends keyof import('@dex/core').Ops>(op: T, data: import('@dex/core').Ops[T]['req']): Promise<NibMe> {
  const me = await req(op, data) as NibMe;
  take(me);
  return me;
}
export const nibStart = (givers: string[], items: NibItemInput[] = [], yesterday?: 'send' | 'skip') => act('nib.start', { givers, items, ...(yesterday ? { yesterday } : {}) });
export const nibSave = (input: NibItemInput & { date?: string }) => act('nib.item.save', input);
export const nibDelete = (id: string) => act('nib.item.delete', { id });
export const nibWrap = (payload: import('@dex/core').Ops['nib.wrap']['req']) => act('nib.wrap', payload);
export const nibDay = (payload: import('@dex/core').Ops['nib.day']['req']) => act('nib.day', payload);
export const nibLeave = async (input: NibLeaveInput) => { const r = await req('nib.leave', input); await refreshNib(); return r; };
export const nibWelcomeSeen = () => act('nib.welcome.seen', undefined as never);

// ------------------------------------------------------------------ cards in conversations
const cards = new Map<string, { at: number; card: NibCard | null; error: string | null; kind: NibCardKind }>();
const cardListeners = new Set<() => void>();
let cardVersion = 0;
function bump(kind: NibCardKind): void {
  let hit = false;
  for (const [k, v] of cards) if (v.kind === kind || (kind === 'lead' && v.kind === 'lead')) { cards.delete(k); hit = true; }
  if (hit) { cardVersion++; for (const l of cardListeners) l(); }
}
export function useCardVersion(): number {
  return useSyncExternalStore((cb) => { cardListeners.add(cb); return () => cardListeners.delete(cb); }, () => cardVersion);
}
const inflight = new Map<string, Promise<void>>();
/** A card's data, from the cache or the hub. */
export function cardFor(kind: NibCardKind, ref: string, messageId?: string): { card: NibCard | null; error: string | null; loading: boolean } {
  const key = `${kind}|${ref}|${kind === 'leaveSpace' ? messageId ?? '' : ''}`;
  const hit = cards.get(key);
  if (hit) return { card: hit.card, error: hit.error, loading: false };
  if (!inflight.has(key)) {
    inflight.set(key, req('nib.card', { kind, ref, ...(messageId ? { messageId } : {}) })
      .then((card) => { cards.set(key, { at: Date.now(), card, error: null, kind }); })
      .catch((e: Error) => { cards.set(key, { at: Date.now(), card: null, error: e.message, kind }); })
      .finally(() => { inflight.delete(key); cardVersion++; for (const l of cardListeners) l(); }));
  }
  return { card: null, error: null, loading: true };
}
export function setCard(kind: NibCardKind, ref: string, card: NibCard): void {
  cards.set(`${kind}|${ref}|`, { at: Date.now(), card, error: null, kind });
  cardVersion++;
  for (const l of cardListeners) l();
}
export function forgetCard(kind: NibCardKind): void { bump(kind); }

/** Givers in the order someone is most likely to pick them: their usual ones, their own manager,
 *  the leads of their department, area leads, then everyone else. */
export function rankGivers(me: NibMe, users: Map<string, PublicUser>, selfId: string): string[] {
  const self = users.get(selfId);
  const score = (id: string): number => {
    const u = users.get(id);
    const g = me.givers.find((x) => x.userId === id);
    let s = 0;
    const usual = me.usual.indexOf(id);
    if (usual >= 0) s += 100 - usual;
    if (self?.profile.managerId === id) s += 60;
    if (u && self?.profile.departmentId && u.profile.departmentId === self.profile.departmentId) s += 40;
    if (g?.kind === 'area') s += 20;
    if (g?.kind === 'team') s += 10;
    return s;
  };
  const ids = [...new Set([...me.usual, ...me.givers.map((g) => g.userId)])].filter((id) => id !== selfId && users.has(id));
  return ids.map((id, i) => ({ id, s: score(id), i })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.id);
}

// ------------------------------------------------------------------ reading words
export function nibPeople(me = state.me): NibPerson[] {
  const givers = new Set(me?.givers.map((g) => g.userId) ?? []);
  return directory().filter((u) => u.role !== 'bot' && u.role !== 'guest').map((u) => ({ id: u.id, name: u.displayName, giver: givers.has(u.id) }));
}
/** The rules, on this PC. */
export function readWords(text: string): NibParse {
  const me = state.me;
  const today = me?.date ?? new Date().toISOString().slice(0, 10);
  return parseWork(text, { people: nibPeople(me), projects: me?.projects ?? [], today, meId });
}
/** The rules, and the sentence model's view of what kind of line it is when the model is loaded. */
export async function readWordsSmart(text: string): Promise<NibParse & { method: 'rules' | 'model' }> {
  const p = readWords(text);
  if (p.intent !== 'unknown' && p.confidence >= 0.55) return { ...p, method: 'rules' };
  if (modelState().phase !== 'ready') return { ...p, method: 'rules' };
  try {
    const rank = await modelRanker();
    if (!rank) return { ...p, method: 'rules' };
    const kinds = Object.entries(NIB_INTENT_EXAMPLES);
    const sims = await rank(text, kinds.map(([kind, examples]) => ({ kind, examples })));
    let best = -1; let at = 0;
    sims.forEach((s, i) => { if (s > best) { best = s; at = i; } });
    if (best < 0.45) return { ...p, method: 'rules' };
    const intent = kinds[at][0] as NibParse['intent'];
    return { ...p, intent, confidence: Math.max(p.confidence, best), method: 'model' };
  } catch { return { ...p, method: 'rules' }; }
}
