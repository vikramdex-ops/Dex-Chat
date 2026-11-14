// Client-side messaging state: conversations, message timelines, side-tracks, typing and
// drafts. Sends are optimistic (shown instantly, confirmed by the hub, retried with the same
// clientId so they never duplicate). Components subscribe with useChat(selector).
import { useSyncExternalStore } from 'react';
import type { Conversation, Message, PublicUser } from '@dex/core';
import { plainPreview } from './format.tsx';

export interface PendingMessage extends Message {
  pending: true;
  failed?: string;
}
export type AnyMessage = Message | PendingMessage;

interface Timeline {
  messages: AnyMessage[];
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
}

interface ChatState {
  ready: boolean;
  meId: string;
  conversations: Map<string, Conversation>;
  timelines: Map<string, Timeline>;     // key: convId or convId/parentId for side-tracks
  typing: Map<string, Map<string, number>>; // key -> userId -> expiry
  drafts: Map<string, string>;
  version: number;
}

const state: ChatState = {
  ready: false, meId: '', conversations: new Map(), timelines: new Map(), typing: new Map(), drafts: new Map(), version: 0,
};
const listeners = new Set<() => void>();
/** The conversation currently on screen (no notification for it while the window is focused). */
let activeConv: string | null = null;
let directory: () => PublicUser[] = () => [];
export function setActiveConversation(id: string | null): void { activeConv = id; }
let snapshot = { ...state };

let lastBadge = -1;
function changed(): void {
  state.version++;
  snapshot = { ...state };
  for (const l of listeners) l();
  const badge = attentionCount();
  if (badge !== lastBadge) { lastBadge = badge; window.dex.setBadge?.(badge); }
}

export function useChat<T>(select: (s: ChatState) => T): T {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => select(snapshot),
  );
}

export const chatState = () => snapshot;
export const tlKey = (convId: string, parentId?: string | null) => (parentId ? `${convId}/${parentId}` : convId);

// ------------------------------------------------------------------ sync with the hub
let wired = false;
let typingTimer: ReturnType<typeof setInterval> | null = null;

export async function startChat(meId: string, users: () => PublicUser[]): Promise<void> {
  state.meId = meId;
  directory = users;
  if (!wired) {
    wired = true;
    window.dex.onHubEvent((name, data) => onEvent(name, data));
    typingTimer = setInterval(() => {
      const now = Date.now();
      let dirty = false;
      for (const m of state.typing.values()) for (const [u, exp] of m) if (exp < now) { m.delete(u); dirty = true; }
      if (dirty) changed();
    }, 1500);
  }
  await refreshConversations();
}

export function stopChat(): void {
  if (typingTimer) clearInterval(typingTimer);
}

export async function refreshConversations(): Promise<void> {
  try {
    const list = await window.dex.request('conv.list');
    state.conversations = new Map(list.map((c) => [c.id, c]));
    state.ready = true;
    // conversations we had open may have missed messages while offline: reload them
    for (const [key, tl] of state.timelines) if (tl.loaded && !key.includes('/')) void loadLatest(key);
    changed();
  } catch { /* offline: keep what we have */ }
}

function onEvent(name: string, data: unknown): void {
  switch (name) {
    case 'conv.updated': {
      const c = data as Conversation;
      state.conversations.set(c.id, c);
      changed();
      break;
    }
    case 'conv.removed': {
      const { convId } = data as { convId: string };
      state.conversations.delete(convId);
      changed();
      break;
    }
    case 'read': {
      const r = data as { convId: string; userId: string; messageId: string };
      const c = state.conversations.get(r.convId);
      if (c) { state.conversations.set(r.convId, { ...c, reads: { ...c.reads, [r.userId]: r.messageId } }); changed(); }
      break;
    }
    case 'msg.new':
    case 'msg.updated': {
      const m = data as Message;
      upsertMessage(m);
      if (name === 'msg.new') notifyIncoming(m);
      // a message from someone clears their typing indicator
      state.typing.get(tlKey(m.convId, m.parentId))?.delete(m.authorId);
      changed();
      break;
    }
    case 'typing': {
      const t = data as { convId: string; userId: string; parentId: string | null };
      const key = tlKey(t.convId, t.parentId);
      if (!state.typing.has(key)) state.typing.set(key, new Map());
      state.typing.get(key)!.set(t.userId, Date.now() + 5000);
      changed();
      break;
    }
    case 'user.added':
      void refreshConversations();
      break;
  }
}

function upsertMessage(m: AnyMessage): void {
  const tl = state.timelines.get(tlKey(m.convId, m.parentId));
  if (!tl) return;
  const msgs = tl.messages.slice();
  // replace an optimistic copy (same clientId) or an older version of the same message
  let i = msgs.findIndex((x) => x.id === m.id || (!!m.clientId && x.clientId === m.clientId));
  if (i >= 0) msgs[i] = m;
  else {
    i = msgs.length;
    while (i > 0 && msgs[i - 1].id > m.id && !('pending' in msgs[i - 1])) i--;
    msgs.splice(i, 0, m);
  }
  state.timelines.set(tlKey(m.convId, m.parentId), { ...tl, messages: msgs });
}

// ------------------------------------------------------------------ loading
export async function loadLatest(convId: string, parentId?: string): Promise<void> {
  const key = tlKey(convId, parentId);
  const cur = state.timelines.get(key);
  state.timelines.set(key, { messages: cur?.messages ?? [], hasMore: cur?.hasMore ?? false, loaded: cur?.loaded ?? false, loading: true });
  changed();
  try {
    const res = await window.dex.request('msg.list', { convId, parentId, limit: 60 });
    const pending = (state.timelines.get(key)?.messages ?? []).filter((m) => 'pending' in m);
    state.timelines.set(key, { messages: [...res.messages, ...pending], hasMore: res.hasMore, loaded: true, loading: false });
  } catch {
    const tl = state.timelines.get(key)!;
    state.timelines.set(key, { ...tl, loading: false });
  }
  changed();
}

export async function loadOlder(convId: string): Promise<void> {
  const tl = state.timelines.get(convId);
  if (!tl || tl.loading || !tl.hasMore) return;
  const oldest = tl.messages.find((m) => !('pending' in m));
  state.timelines.set(convId, { ...tl, loading: true });
  changed();
  try {
    const res = await window.dex.request('msg.list', { convId, before: oldest?.id, limit: 60 });
    const now = state.timelines.get(convId)!;
    state.timelines.set(convId, { ...now, messages: [...res.messages, ...now.messages], hasMore: res.hasMore, loading: false });
  } catch {
    state.timelines.set(convId, { ...state.timelines.get(convId)!, loading: false });
  }
  changed();
}

// ------------------------------------------------------------------ actions
const newClientId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export async function sendMessage(convId: string, body: string, parentId?: string | null): Promise<void> {
  const clientId = newClientId();
  const optimistic: PendingMessage = {
    id: `~${clientId}`, convId, authorId: state.meId, body, parentId: parentId ?? null, createdAt: Date.now(),
    editedAt: null, deleted: false, pinned: false, reactions: {}, mentions: [], replyCount: 0, lastReplyAt: null,
    clientId, pending: true,
  };
  const key = tlKey(convId, parentId);
  const tl = state.timelines.get(key) ?? { messages: [], hasMore: false, loaded: true, loading: false };
  state.timelines.set(key, { ...tl, messages: [...tl.messages, optimistic] });
  changed();
  await deliver(optimistic);
}

async function deliver(m: PendingMessage): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const saved = await window.dex.request('msg.send', { convId: m.convId, body: m.body, parentId: m.parentId ?? undefined, clientId: m.clientId! });
      upsertMessage(saved);
      changed();
      return;
    } catch (err) {
      const msg = (err as Error).message;
      if (!/not connected|timed out|closed/i.test(msg)) { markFailed(m, msg); return; }
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  markFailed(m, 'Not sent. The hub is unreachable.');
}

function markFailed(m: PendingMessage, failed: string): void {
  const key = tlKey(m.convId, m.parentId);
  const tl = state.timelines.get(key);
  if (!tl) return;
  state.timelines.set(key, { ...tl, messages: tl.messages.map((x) => (x.clientId === m.clientId ? { ...m, failed } : x)) });
  changed();
}

export function retrySend(m: PendingMessage): void {
  const fresh = { ...m, failed: undefined };
  const key = tlKey(m.convId, m.parentId);
  const tl = state.timelines.get(key);
  if (tl) state.timelines.set(key, { ...tl, messages: tl.messages.map((x) => (x.clientId === m.clientId ? fresh : x)) });
  changed();
  void deliver(fresh);
}

export function discardFailed(m: PendingMessage): void {
  const key = tlKey(m.convId, m.parentId);
  const tl = state.timelines.get(key);
  if (tl) state.timelines.set(key, { ...tl, messages: tl.messages.filter((x) => x.clientId !== m.clientId) });
  changed();
}

let lastTypingSent = 0;
export function notifyTyping(convId: string, parentId?: string | null): void {
  const now = Date.now();
  if (now - lastTypingSent < 3000) return;
  lastTypingSent = now;
  void window.dex.request('typing', { convId, parentId: parentId ?? undefined }).catch(() => {});
}

export function markRead(convId: string): void {
  const c = state.conversations.get(convId);
  const tl = state.timelines.get(convId);
  const last = tl?.messages.filter((m) => !('pending' in m)).at(-1);
  if (!c || !last || (c.unread === 0 && c.lastReadId && c.lastReadId >= last.id)) return;
  state.conversations.set(convId, { ...c, unread: 0, mentions: 0, lastReadId: last.id });
  changed();
  void window.dex.request('conv.read', { convId, messageId: last.id }).catch(() => {});
}

export function setDraft(key: string, text: string): void {
  if (text) state.drafts.set(key, text); else state.drafts.delete(key);
  // drafts survive restarts
  try { localStorage.setItem('dex-drafts', JSON.stringify([...state.drafts])); } catch { /* storage full */ }
}

export function loadDrafts(): void {
  try { state.drafts = new Map(JSON.parse(localStorage.getItem('dex-drafts') ?? '[]')); } catch { /* ignore */ }
}

/** Add a conversation we just created or joined, without overwriting a newer live copy. */
export function addConversation(c: Conversation): void {
  const cur = state.conversations.get(c.id);
  if (cur && (cur.lastMessage?.id ?? '') >= (c.lastMessage?.id ?? '') && cur.joined === c.joined) return;
  state.conversations.set(c.id, c);
  changed();
}

/** Total that should show on the taskbar: mentions everywhere plus unread Direct messages. */
export function attentionCount(): number {
  let n = 0;
  for (const c of state.conversations.values()) n += c.kind === 'direct' && !c.muted ? c.unread : c.mentions;
  return n;
}

function notifyIncoming(m: Message): void {
  if (m.authorId === state.meId) return;
  const c = state.conversations.get(m.convId);
  const mentioned = m.mentions.includes(state.meId) || m.mentions.includes('all');
  if (c?.muted && !mentioned) return;
  if (activeConv === m.convId && document.hasFocus()) return;
  const users = new Map(directory().map((u) => [u.id, u] as const));
  const who = users.get(m.authorId)?.displayName ?? 'Someone';
  const where = c?.kind === 'space' ? ` in ${c.name}` : c && c.members.length > 2 ? ' in a group' : '';
  const title = mentioned ? `${who} mentioned you${where}` : m.parentId ? `${who} replied${where}` : `${who}${where}`;
  window.dex.notify(title, plainPreview(m.body, users).slice(0, 200), `dexconnect://conversation/${m.convId}`);
}
