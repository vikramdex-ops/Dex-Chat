// What happens live in a meeting besides media, for the Room sheet and the Meet lens: the meeting
// chat (everyone in the Room reads it, browser guests and people let in from outside too, and it
// is shared by a meeting's breakout rooms), notes a host sends to every breakout room, guests a
// meeting could not take, and changes to recordings on the shelf. Always loaded; small.
import { useEffect, useSyncExternalStore } from 'react';
import type { RoomChatLine } from '@dex/core';
import { callState, tell } from '../rooms/engine.ts';
import { alertUser } from '../alerts.ts';
import { tr } from '../i18n/index.ts';

interface LiveState {
  /** Meeting chat by main Room. */
  chat: Map<string, RoomChatLine[]>;
  /** Lines from others not seen yet (the panel shows a count on its Chat tab, the folded Room's chip too). */
  unread: number;
  /** The latest line from someone else while the chat is closed: a brief preview on the Room (meet/ChatPeek.tsx). */
  peek: RoomChatLine | null;
  /** Bumped when a recording changes (the shelf reloads). */
  recordings: number;
}
let state: LiveState = { chat: new Map(), unread: 0, peek: null, recordings: 0 };
const subs = new Set<() => void>();
const set = (p: Partial<LiveState>) => { state = { ...state, ...p }; for (const f of subs) f(); };
export const useLive = <T,>(sel: (s: LiveState) => T): T => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => sel(state));

/** The meeting chat's lines for a Room (its main Room's, for a breakout). */
const mainOf = (roomId: string) => { const r = callState().room; return r && r.id === roomId && r.parentId ? r.parentId : roomId; };

function add(line: RoomChatLine): void {
  const key = line.roomId;
  const list = [...(state.chat.get(key) ?? [])];
  if (list.some((l) => l.id === line.id)) return;
  list.push(line);
  if (list.length > 300) list.splice(0, list.length - 300);
  // your own lines are never unread news
  const theirs = !!selfId() && line.userId !== selfId();
  set({ chat: new Map(state.chat).set(key, list), unread: chatOpen || !theirs ? state.unread : state.unread + 1, peek: theirs && !chatOpen ? line : state.peek });
  if (theirs) notifyLine(line);
}

/**
 * A line from someone else while the app is in the background (minimised, behind other windows):
 * a system notification by the person's notification settings and quiet hours; clicking it opens
 * the meeting's chat. In front, the Room shows the count and a preview instead.
 */
function notifyLine(line: RoomChatLine): void {
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  const room = callState().room;
  if (!room) return;
  const title = room.breakoutName ?? room.title ?? '';
  const text = line.text || (line.file ? tr(`Shared a file: ${line.file.name}`) : '');
  // the title is the app's words and the meeting's name; the line is theirs, kept as written
  alertUser('personal', title ? `${tr('Meeting chat')} · ${title}` : tr('Meeting chat'), `${line.name}${line.guest ? ` (${tr('guest')})` : ''}: ${text}`.slice(0, 200), 'dexconnect://meetchat');
}

let selfId: () => string = () => '';
/** The preview was shown (or the chat opened). */
export function clearPeek(): void { if (state.peek) set({ peek: null }); }

let chatOpen = false;
/** The panel's Chat tab is open (lines are read as they come). */
export function setChatOpen(open: boolean): void { chatOpen = open; if (open && (state.unread || state.peek)) set({ unread: 0, peek: null }); }

/** The meeting chat of the Room this PC is in, loaded the first time it is shown. */
export function useRoomChat(roomId: string | null): RoomChatLine[] {
  const key = roomId ? mainOf(roomId) : '';
  const lines = useLive((s) => s.chat.get(key));
  useEffect(() => {
    if (!roomId || state.chat.has(key)) return;
    void window.dex.request('room.chatLog', { roomId }).then((log) => {
      const known = state.chat.get(key) ?? [];
      const merged = [...log, ...known.filter((l) => !log.some((x) => x.id === l.id))].sort((a, b) => a.at - b.at);
      set({ chat: new Map(state.chat).set(key, merged) });
    }).catch(() => {});
  }, [roomId, key]);
  return lines ?? [];
}

export async function sendRoomChat(roomId: string, text: string): Promise<void> {
  const line = await window.dex.request('room.chat', { roomId, text });
  add(line);
}

let wired = false;
export function startMeetLive(nameOf: (userId: string) => string, me?: () => string): void {
  if (me) selfId = me;
  if (wired) return;
  wired = true;
  window.dex.onHubEvent((name, data) => {
    if (name === 'room.chat') add(data as RoomChatLine);
    else if (name === 'room.breakoutNote') {
      const d = data as { text: string; by: string };
      tell(`Note from ${nameOf(d.by)} to every room: ${d.text}`);
    } else if (name === 'meet.guestRefused') {
      const d = data as { name: string; reason: string };
      tell(`${d.name} could not join from a browser. ${d.reason}`);
    } else if (name === 'rec.updated' || name === 'rec.removed') set({ recordings: state.recordings + 1 });
    else if (name === 'room.ended') {
      // the meeting chat is gone with the meeting
      const d = data as { roomId: string };
      if (state.chat.has(d.roomId)) { const chat = new Map(state.chat); chat.delete(d.roomId); set({ chat, unread: 0, peek: null }); }
    }
  });
}

