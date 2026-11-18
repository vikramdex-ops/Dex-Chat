// Knocks on the client (docs/MEETINGS.md, "Who is waiting"): everyone waiting in the lobbies of
// meetings you may let people into, and your meetings running without you, as the hub keeps them
// (meet.knocks). A new knock notifies (a system notification when the app is in the background,
// by your notification settings) and drops a card in the corner; the title bar's indicator keeps
// them until they are answered. Always loaded; small.
import { useSyncExternalStore } from 'react';
import { formatMeetingId } from '@dex/core';
import type { JoinedNotice, KnockView, LobbyBoard } from '@dex/core';
import { alertUser } from '../alerts.ts';
import { tr } from '../i18n/index.ts';
import { callState } from '../rooms/engine.ts';

interface KnockState {
  board: LobbyBoard;
  /** The indicator's list is open. */
  open: boolean;
  /** Knocks whose corner card was put away with Later (they stay in the indicator). */
  later: Set<string>;
  /** The last news, for screen readers (the indicator's live region). */
  said: string;
}

let state: KnockState = { board: { knocks: [], rooms: [] }, open: false, later: new Set(), said: '' };
const subs = new Set<() => void>();
const set = (p: Partial<KnockState>) => { state = { ...state, ...p }; for (const f of subs) f(); };
export const useKnocks = <T,>(sel: (s: KnockState) => T): T => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => sel(state));
export const knocksNow = () => state;

export function openKnocks(open = true): void { set({ open }); }
export function laterKnock(id: string): void { set({ later: new Set(state.later).add(id) }); }

/** "Dana Wright (guest, name not verified)" in the person's language: guests type their own names. */
export const knockName = (k: Pick<KnockView, 'name' | 'guest'>): string => (k.guest ? tr(`${k.name} (guest, name not verified)`) : k.name);

/** You are looking at that meeting's Room now: its own lobby strip shows the knock. */
function watchingRoom(meetingId: string): boolean {
  const c = callState();
  return c.room?.meetingId === meetingId && !c.minimized && document.visibilityState === 'visible' && document.hasFocus();
}

function knocked(k: KnockView): void {
  const who = knockName(k);
  const where = k.kind === 'personal' ? tr('your personal room') : k.title;
  set({ said: tr(`${who} is waiting to join ${where}`), later: state.later });
  if (watchingRoom(k.meetingId)) return;
  // the title is the app's words; the guest's name is theirs (kept as typed)
  alertUser('personal', `${tr('Waiting in the lobby')} · ${where}`, k.guest ? tr(`${k.name} (guest, name not verified) asks to join`) : tr(`${k.name} asks to join`), `dexconnect://lobby/${k.id}`);
}

function joined(n: JoinedNotice): void {
  const where = n.kind === 'personal' ? tr('your personal room') : n.title;
  const who = n.guest ? tr(`${n.name} (guest)`) : n.name;
  set({ said: tr(`${who} joined ${where}`) });
  // lighter than a knock: a notification only when the app is not in front (the indicator shows it either way)
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  alertUser('personal', `${tr('Joined your meeting')} · ${where}`, tr(`${who} is in the meeting without you`), `dexconnect://meet/${formatMeetingId(n.meetingId)}`);
}

let wired = false;
/** Listen for knocks (once) and load the board (again after every reconnect). */
export function startKnocks(): void {
  if (!wired) {
    wired = true;
    window.dex.onHubEvent((name, data) => {
      if (name === 'meet.knocks') {
        const board = data as LobbyBoard;
        const open = new Set(board.knocks.map((k) => k.id));
        set({ board, later: new Set([...state.later].filter((id) => open.has(id))), open: state.open && (board.knocks.length > 0 || board.rooms.length > 0) });
      } else if (name === 'meet.knocked') knocked(data as KnockView);
      else if (name === 'meet.joined') joined(data as JoinedNotice);
    });
  }
  void window.dex.request('meet.knocks').then((board) => set({ board })).catch(() => { /* an older hub */ });
}

/** Admit or Decline one knock, or everyone waiting for a meeting; the board and every card follow from the hub. */
export async function answerKnock(id: string, allow: boolean): Promise<KnockView | null> {
  const r = await window.dex.request('meet.knock.answer', { id, allow });
  return r.knocks[0] ?? null;
}
export async function answerAll(meetingId: string, allow: boolean): Promise<void> {
  await window.dex.request('meet.knock.answer', { meetingId, all: true, allow });
}

/** "3 min", "1 h 05 min": how long someone has waited. */
export function waitedText(since: number, now = Date.now()): string {
  const m = Math.max(0, Math.floor((now - since) / 60_000));
  if (m < 1) return tr('just now');
  if (m < 60) return m === 1 ? tr('1 min') : tr(`${m} min`);
  const h = Math.floor(m / 60);
  return tr(`${h} h ${String(m % 60).padStart(2, '0')} min`);
}
