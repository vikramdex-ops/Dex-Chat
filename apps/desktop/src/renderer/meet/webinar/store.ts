// Webinars in the app: what is always loaded. Watching one as an attendee (the stage, questions,
// the poll, handouts; the sheet itself loads when it opens, Watch.tsx), the live state of
// webinars this person is on the stage of (for the panelists' bar and tabs), the stream's health
// for the organiser, and the messages the PC composing the stage needs before its code loads.
// Joining by a meeting ID goes through joinAny: a webinar's attendees watch, its organiser and
// panelists go onto the stage (the Room).
import { useSyncExternalStore } from 'react';
import type { StageRoute, StreamStatus, WebinarLive, WebinarQuestion, WebinarUpdate } from '@dex/core';
import { callState, joinMeeting, leave, tell } from '../../rooms/engine.ts';

export interface Watching {
  meetingId: string;
  live: WebinarLive;
  questions: Map<string, WebinarQuestion>;
  route: StageRoute;
  hand: boolean;
  /** The organiser invites you to speak (their name). */
  invite: string | null;
  ended: boolean;
  /** Reactions to float up the stage: bumped with each batch. */
  reactions: { seq: number; r: Record<string, number> } | null;
  myVotes: Map<string, number[]>;
  /** Folded away to use the rest of the app (the stage keeps playing). */
  folded: boolean;
}

export interface OnStage {
  live: WebinarLive | null;
  questions: Map<string, WebinarQuestion>;
  stream: StreamStatus | null;
  reactions: { seq: number; r: Record<string, number> } | null;
  /** Bumped when the audience changes (the Audience tab reloads). */
  audience: number;
  /** Bumped when someone registers. */
  registrants: number;
}

export type ViewersMsg = { meetingId: string; viewers: Array<{ deviceId: string; name: string }>; relay: boolean; live: boolean; stream: boolean; epoch: number };

interface WebState {
  watching: Watching | null;
  stage: Map<string, OnStage>;
  /** For the PC composing a stage: the latest word from the hub on whom to send to. */
  viewers: Map<string, ViewersMsg>;
  /** A webinar's sheet or survey to open on the Meet lens (deep links). */
  open: { meetingId: string; what: 'sheet' | 'survey' } | null;
  /** Bumped when the webinar list should reload. */
  version: number;
}

let state: WebState = { watching: null, stage: new Map(), viewers: new Map(), open: null, version: 0 };
const subs = new Set<() => void>();
const set = (p: Partial<WebState>) => { state = { ...state, ...p }; for (const f of subs) f(); };
export const useWeb = <T,>(sel: (s: WebState) => T): T => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => sel(state));
export const webState = () => state;

const blank = (): OnStage => ({ live: null, questions: new Map(), stream: null, reactions: null, audience: 0, registrants: 0 });
function patchStage(id: string, f: (s: OnStage) => Partial<OnStage>): void {
  const cur = state.stage.get(id) ?? blank();
  set({ stage: new Map(state.stage).set(id, { ...cur, ...f(cur) }) });
}

/** Load a webinar's live view and questions for its stage (the panelists' bar). */
export async function loadStage(meetingId: string): Promise<void> {
  const [questions, info, live] = await Promise.all([window.dex.request('web.questions', { id: meetingId }), window.dex.request('web.get', { id: meetingId }), window.dex.request('web.live', { id: meetingId })]);
  const stream = info.role === 'organizer' ? await window.dex.request('web.stream.status', { id: meetingId }).catch(() => null) : null;
  patchStage(meetingId, (s) => ({ questions: new Map(questions.map((q) => [q.id, q])), live: s.live ?? live, ...(stream ? { stream } : {}) }));
}

let seq = 0;
function applyUpdate(u: WebinarUpdate): void {
  const w = state.watching;
  if (w && w.meetingId === u.meetingId) {
    const questions = new Map(w.questions);
    for (const q of u.questions ?? []) questions.set(q.id, { ...q, own: w.questions.get(q.id)?.own, voted: w.questions.get(q.id)?.voted });
    for (const id of u.removed ?? []) questions.delete(id);
    set({ watching: { ...w, live: u.live ?? w.live, questions, reactions: u.reactions ? { seq: ++seq, r: u.reactions } : w.reactions } });
  }
  const onStage = state.stage.has(u.meetingId) || callState().room?.meetingId === u.meetingId;
  if (onStage) {
    patchStage(u.meetingId, (s) => {
      const questions = new Map(s.questions);
      for (const q of u.questions ?? []) questions.set(q.id, { ...q, own: s.questions.get(q.id)?.own, voted: s.questions.get(q.id)?.voted });
      return {
        live: u.live ?? s.live, questions,
        reactions: u.reactions ? { seq: ++seq, r: u.reactions } : s.reactions,
        audience: u.audience !== undefined ? s.audience + 1 : s.audience,
      };
    });
  }
}

let wired = false;
export function startWebinars(): void {
  if (wired) return;
  wired = true;
  window.dex.onHubEvent((name, data) => {
    if (!name.startsWith('web.')) return;
    if (name === 'web.update') applyUpdate(data as WebinarUpdate);
    else if (name === 'web.route') {
      const d = data as { meetingId: string; route: StageRoute };
      if (state.watching?.meetingId === d.meetingId) set({ watching: { ...state.watching, route: d.route } });
    } else if (name === 'web.promote') {
      const d = data as { meetingId: string; by: string };
      if (state.watching?.meetingId === d.meetingId) set({ watching: { ...state.watching, invite: d.by, folded: false } });
    } else if (name === 'web.demoted') {
      // back to the audience: off the stage, and watching again
      const d = data as { meetingId: string };
      if (callState().room?.meetingId === d.meetingId) leave();
      tell('The organiser brought you back to the audience');
      void watchWebinar(d.meetingId).catch(() => {});
    } else if (name === 'web.ended') {
      const d = data as { meetingId: string };
      if (state.watching?.meetingId === d.meetingId) set({ watching: { ...state.watching, ended: true, route: 'none' } });
      set({ version: state.version + 1 });
    } else if (name === 'web.streamStatus') {
      const d = data as { meetingId: string; status: StreamStatus };
      patchStage(d.meetingId, () => ({ stream: d.status }));
    } else if (name === 'web.registered') {
      const d = data as { meetingId: string };
      patchStage(d.meetingId, (s) => ({ registrants: s.registrants + 1 }));
    } else if (name === 'web.viewers') {
      const d = data as ViewersMsg;
      set({ viewers: new Map(state.viewers).set(d.meetingId, d) });
    }
  });
}

// ------------------------------------------------------------------ watching
export async function watchWebinar(meetingId: string): Promise<void> {
  const res = await window.dex.request('web.watch', { id: meetingId });
  set({
    watching: {
      meetingId, live: res.live, questions: new Map(res.questions.map((q) => [q.id, q])), route: res.route, hand: res.hand, invite: null, ended: res.live.state === 'ended',
      reactions: null, myVotes: new Map(res.live.poll ? [[res.live.poll.id, res.live.poll.mine]] : []), folded: false,
    },
  });
}

export function stopWatching(): void {
  const w = state.watching;
  if (!w) return;
  set({ watching: null });
  void window.dex.request('web.leave', { id: w.meetingId }).catch(() => {});
}

export function patchWatching(p: Partial<Watching>): void {
  if (state.watching) set({ watching: { ...state.watching, ...p } });
}

/** Accept (or decline) the organiser's invitation to speak; accepting goes onto the stage. */
export async function answerInvite(accept: boolean, video: boolean): Promise<void> {
  const w = state.watching;
  if (!w) return;
  patchWatching({ invite: null });
  const res = await window.dex.request('web.promoteAnswer', { id: w.meetingId, accept });
  if (!accept || !res.meetingId) return;
  set({ watching: null });
  await joinMeeting(res.meetingId, video);
}

/**
 * Join by a meeting ID or link: a webinar's attendees watch it; its organiser and panelists (and
 * anyone invited to speak) go onto its stage. Every other meeting joins as before.
 */
export async function joinAny(meetingId: string, video: boolean): Promise<void> {
  const m = await window.dex.request('meet.get', { id: meetingId });
  if (m.kind !== 'webinar') { await joinMeeting(meetingId, video); return; }
  const onStage = await window.dex.request('web.get', { id: meetingId }).then(() => true, () => false);
  if (onStage) await joinMeeting(meetingId, video);
  else await watchWebinar(meetingId);
}

/** Open a webinar's sheet (or its survey) on the Meet lens. */
export function openWebinar(meetingId: string, what: 'sheet' | 'survey' = 'sheet'): void {
  set({ open: { meetingId, what } });
  window.dispatchEvent(new CustomEvent('dex-open-lens', { detail: 'meet' }));
}
export const clearOpenWebinar = () => set({ open: null });
export const bumpWebinars = () => set({ version: state.version + 1 });

export const sizeText = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
