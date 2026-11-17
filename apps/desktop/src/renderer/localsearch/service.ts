// Searching end-to-end encrypted Direct messages on this device. The hub only ever holds them
// sealed, so this device keeps its own index of the text it decrypted: every sealed message it
// receives or sends (chat/store.ts hands them over as they arrive or load), plus the history it
// fetches in the background, a page at a time when the window is idle. The index and the text of
// each message are kept in IndexedDB, encrypted with a key from the system's secure storage
// (vault.ts); signing out of the office or the device being removed deletes both. The Search view
// merges these results with the hub's, marked "from this device".
import type { Message } from '@dex/core';
import type { AppState } from '../../shared/bridge.ts';
import { isPopout } from '../alerts.ts';
import { chatState } from '../chat/store.ts';
import { LocalIndex } from './invindex.ts';
import type { Filters } from './invindex.ts';
import { plainSnippet, snippet, terms } from './tokenize.ts';
import { deleteVaults, openVault } from './vault.ts';
import type { Vault } from './vault.ts';
import './search.css';

const PREFIX = 'dex-search:';
/** History fetched per conversation, newest first. */
const BACKFILL_PER_CONV = 5000;
const PAGE = 40;
const MAX_DOCS = 150_000;
const SAVE_AFTER_MS = 2500;
const enc = new TextEncoder();
const dec = new TextDecoder();

type Indexable = Pick<Message, 'id' | 'convId' | 'authorId' | 'parentId' | 'createdAt' | 'editedAt' | 'body' | 'deleted' | 'replyCount'> & { e2e?: Message['e2e']; pending?: true };
interface ConvProgress { before?: string; seen: number; done: boolean; threads: string[] }
interface Running {
  scope: string;
  meId: string;
  vault: Vault;
  index: LocalIndex;
  progress: Record<string, ConvProgress>;
  stopped: boolean;
  /** Conversations brought up to date since this start (what arrived while the app was closed). */
  caught: Map<string, string | undefined | null>;
}

let cur: Running | null = null;
let starting: Promise<Running | null> | null = null;
let startingKey = '';
const early: Indexable[] = [];
const writes: { put: Map<string, Uint8Array>; del: Set<string> } = { put: new Map(), del: new Set() };
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let stateWired = false;
let knownOffices: string[] = [];

const idle = (fn: (deadline: { timeRemaining(): number }) => void, timeout = 3000) => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout });
  else setTimeout(() => fn({ timeRemaining: () => 8 }), 50);
};
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const vaultName = (scope: string, meId: string) => `${PREFIX}${scope}:${meId}`;

/** Sealed Direct text this device could read. */
const readable = (m: Indexable) => !m.pending && (m.e2e === 'ok' || m.e2e === 'unverified');

// ------------------------------------------------------------------ start and stop
/** Start (or keep) the index for this person in the office the app is signed in to. */
export function startLocalSearch(meId: string): void {
  if (isPopout || !meId) return;
  wireState();
  void window.dex.getState().then((s) => {
    const scope = s.session?.hub.id;
    if (!scope) return;
    knownOffices = (s.offices ?? []).map((o) => o.id);
    const key = vaultName(scope, meId);
    if (cur && !cur.stopped && vaultName(cur.scope, cur.meId) === key) { scheduleBackfill(1000); return; }
    if (starting && startingKey === key) return;
    startingKey = key;
    starting = open(scope, meId).finally(() => { starting = null; });
  }).catch(() => {});
}

async function open(scope: string, meId: string): Promise<Running | null> {
  if (cur) await stop(cur);
  let raw: Uint8Array | null = null;
  try { const k = await window.dex.searchIndexKey?.(scope); raw = k ? b64(k) : null; } catch { raw = null; }
  const vault = await openVault(vaultName(scope, meId), raw);
  let index = new LocalIndex();
  let progress: Record<string, ConvProgress> = {};
  try {
    const [ix, pr] = await vault.getMany(['index', 'progress']);
    if (ix) index = LocalIndex.deserialize(ix);
    if (pr) progress = JSON.parse(dec.decode(pr)) as Record<string, ConvProgress>;
  } catch { index = new LocalIndex(); progress = {}; }
  const r: Running = { scope, meId, vault, index, progress, stopped: false, caught: new Map() };
  cur = r;
  if (early.length) observeMessages(early.splice(0));
  scheduleBackfill(2500);
  return r;
}

async function stop(r: Running): Promise<void> {
  if (r.stopped) return;
  await flush(r).catch(() => {});
  r.stopped = true;
  r.vault.close();
  if (cur === r) cur = null;
}

/** Delete this office's index from the device: the records, and the key that sealed them. */
async function wipe(scope: string): Promise<void> {
  const r = cur;
  if (r && r.scope === scope) {
    r.stopped = true;
    if (cur === r) cur = null;
    writes.put.clear();
    writes.del.clear();
    r.vault.close();
  }
  await deleteVaults(`${PREFIX}${scope}:`);
  await window.dex.dropSearchIndexKey?.(scope).catch(() => {});
}

/** Signing out of an office, or this device being removed from it, deletes its index. */
function wireState(): void {
  if (stateWired) return;
  stateWired = true;
  window.dex.onState((s: AppState) => {
    const r = cur;
    const scope = r?.scope ?? s.session?.hub.id;
    if (s.offices) knownOffices = s.offices.map((o) => o.id);
    if (!scope) return;
    const removed = s.phase === 'rejected';
    // no office now, and this one not kept among the others: signed out ("Add office" keeps it)
    const signedOut = !s.hub && !knownOffices.includes(scope);
    if (removed || signedOut) void wipe(scope);
  });
}

// ------------------------------------------------------------------ indexing
/** Messages arrived or loaded (chat/store.ts): index the sealed Direct ones this device opened. */
export function observeMessages(list: ReadonlyArray<Indexable>): void {
  if (isPopout) return;
  const r = cur;
  if (!r) {
    for (const m of list) if (readable(m) && early.length < 2000) early.push(m);
    return;
  }
  let changed = false;
  for (const m of list) {
    if (!m || typeof m.id !== 'string' || m.pending) continue;
    if (m.deleted || (r.index.has(m.id) && !readable(m) && m.e2e !== 'locked')) {
      if (r.index.remove(m.id)) { writes.del.add(`doc:${m.id}`); writes.put.delete(`doc:${m.id}`); changed = true; }
      continue;
    }
    if (!readable(m) || !m.body.trim()) continue;
    const rev = m.editedAt ?? 0;
    if (r.index.revOf(m.id) === rev) continue;
    if (r.index.size >= MAX_DOCS && !r.index.has(m.id)) continue;
    r.index.add({ id: m.id, convId: m.convId, authorId: m.authorId, parentId: m.parentId, createdAt: m.createdAt, rev }, m.body);
    if (r.index.has(m.id)) { writes.put.set(`doc:${m.id}`, enc.encode(m.body)); writes.del.delete(`doc:${m.id}`); changed = true; }
  }
  if (changed) scheduleSave();
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; idle(() => { const r = cur; if (r) void flush(r).catch(() => {}); }, 5000); }, SAVE_AFTER_MS);
}

async function flush(r: Running): Promise<void> {
  if (r.stopped) return;
  const puts = [...writes.put];
  const dels = [...writes.del];
  writes.put.clear();
  writes.del.clear();
  if (r.index.stale > 500 && r.index.stale > r.index.size / 4) r.index.compact();
  // in memory (no secure storage), the live index is all there is: nothing to write out
  if (r.vault.persistent) puts.push(['index', r.index.serialize()], ['progress', enc.encode(JSON.stringify(r.progress))]);
  await r.vault.del(dels);
  await r.vault.put(puts);
}

// ------------------------------------------------------------------ backfill
let backfillTimer: ReturnType<typeof setTimeout> | null = null;
let backfilling = false;

function scheduleBackfill(ms: number): void {
  if (backfillTimer) clearTimeout(backfillTimer);
  backfillTimer = setTimeout(() => { backfillTimer = null; idle(() => void backfillStep()); }, ms);
}

/** One small batch: the next page of history of one Direct conversation (or one side-track). */
async function backfillStep(): Promise<void> {
  const r = cur;
  if (!r || r.stopped || backfilling) return;
  backfilling = true;
  try {
    const convs = [...chatState().conversations.values()]
      .filter((c) => c.kind === 'direct' && c.joined !== false)
      .sort((a, b) => ((b.lastMessage?.id ?? '') > (a.lastMessage?.id ?? '') ? 1 : -1));
    // first, what arrived while the app was closed: newest pages until something already indexed
    const behind = convs.find((c) => r.caught.get(c.id) !== null && r.progress[c.id]);
    if (behind) {
      const last = behind.lastMessage?.id;
      if (!r.caught.has(behind.id) && last && r.index.has(last)) { r.caught.set(behind.id, null); scheduleBackfill(50); return; }
      const page = await window.dex.request('msg.list', { convId: behind.id, before: r.caught.get(behind.id) ?? undefined, limit: PAGE });
      if (r.stopped) return;
      const known = page.messages.some((m) => r.index.has(m.id));
      observeMessages(page.messages);
      const p = r.progress[behind.id];
      for (const m of page.messages) if (m.replyCount > 0 && p.threads.length < 200 && !p.threads.includes(m.id)) p.threads.push(m.id);
      r.caught.set(behind.id, known || !page.hasMore || !page.messages.length ? null : page.messages[0].id);
      scheduleSave();
      scheduleBackfill(250);
      return;
    }
    // then further back in history
    const next = convs.find((c) => { const p = r.progress[c.id]; return !p || !p.done || p.threads.length > 0; });
    if (!next) { scheduleBackfill(10 * 60_000); return; }
    if (!r.progress[next.id]) r.caught.set(next.id, null);
    const p = r.progress[next.id] ??= { seen: 0, done: false, threads: [] };
    if (p.threads.length) {
      const parentId = p.threads.shift()!;
      const page = await window.dex.request('msg.list', { convId: next.id, parentId, limit: 100 });
      if (r.stopped) return;
      observeMessages(page.messages);
    } else {
      const page = await window.dex.request('msg.list', { convId: next.id, before: p.before, limit: PAGE });
      if (r.stopped) return;
      observeMessages(page.messages);
      for (const m of page.messages) if (m.replyCount > 0 && p.threads.length < 200) p.threads.push(m.id);
      p.seen += page.messages.length;
      if (page.messages.length) p.before = page.messages[0].id;
      p.done = !page.hasMore || !page.messages.length || p.seen >= BACKFILL_PER_CONV;
    }
    scheduleSave();
    scheduleBackfill(250);
  } catch {
    // offline or the hub is busy: try again later
    scheduleBackfill(30_000);
  } finally {
    backfilling = false;
  }
}

// ------------------------------------------------------------------ searching
export interface LocalHit { message: Message; snippet: string; local: true }

async function ready(): Promise<Running | null> {
  if (cur && !cur.stopped) return cur;
  if (starting) {
    const r = await Promise.race([starting, new Promise<null>((res) => setTimeout(() => res(null), 3000))]);
    return r && !r.stopped ? r : null;
  }
  return null;
}

/** Search the on-device index. */
export async function searchLocal(q: string, filters: Filters, limit = 30): Promise<LocalHit[]> {
  const r = await ready();
  if (!r) return [];
  const hits = r.index.search(q, filters, limit);
  if (!hits.length) return [];
  const words = terms(q);
  const texts = await Promise.all(hits.map(async (h) => writes.put.get(`doc:${h.meta.id}`) ?? (await r.vault.get(`doc:${h.meta.id}`))));
  const out: LocalHit[] = [];
  hits.forEach((h, i) => {
    const t = texts[i];
    if (!t) return;
    const body = dec.decode(t);
    out.push({
      local: true,
      // cut from the words people read, not from the formatting marks
      snippet: snippet(plainSnippet(body), words),
      message: {
        id: h.meta.id, convId: h.meta.convId, authorId: h.meta.authorId, body, parentId: h.meta.parentId, createdAt: h.meta.createdAt,
        editedAt: h.meta.rev || null, deleted: false, pinned: false, reactions: {}, mentions: [], replyCount: 0, lastReplyAt: null,
        clientId: null, files: [], forwardedFrom: null, poll: null, form: null, e2e: 'ok',
      },
    });
  });
  return out;
}

/** For the Search view's note and tests: how much this device has indexed. */
export function localSearchStatus(): { ready: boolean; messages: number; persistent: boolean } {
  const r = cur;
  return { ready: !!r && !r.stopped, messages: r?.index.size ?? 0, persistent: !!r?.vault.persistent };
}
