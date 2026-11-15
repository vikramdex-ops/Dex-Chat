// References across conversations: drag a message (by its grip on the spine tool column, or by
// pressing and holding the message) or a file onto a conversation in the Switchboard, an open Pane
// or the Dock, and a reference is posted: a pointer, not a copy. People who cannot open the source
// see only that it exists and who wrote it; before posting, a sheet says how many that is.
// "Reference in…" in a message's More menu does the same from the keyboard.
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Conversation, FileInfo, Message, PublicUser, RefTarget } from '@dex/core';
import { Dialog, Icon, useToast } from '../ui.tsx';
import { ConvTile, convTitle } from './Switchboard.tsx';
import { chatState, useChat } from './store.ts';
import { plainPreview } from './format.tsx';
import { MessageFiles } from './files.tsx';
import './messages.css';

/** The drag type a message or file carries while it is dragged to be referenced. */
export const REF_DRAG = 'application/x-dex-reference';

export type RefPayload =
  | { kind: 'message'; convId: string; messageId: string; authorId: string; excerpt: string }
  | { kind: 'file'; convId: string; fileId: string; name: string };

export const targetOf = (p: RefPayload): RefTarget => (p.kind === 'file' ? { fileId: p.fileId } : { convId: p.convId, messageId: p.messageId });

// ------------------------------------------------------------------ the drag in progress
interface DragState { payload: RefPayload; over: string | null }
let drag: DragState | null = null;
const subs = new Set<() => void>();
const setDrag = (d: DragState | null) => { drag = d; for (const f of subs) f(); };
export const useRefDrag = (): DragState | null => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => drag);

/** Drop targets on screen, by key, so a press-and-hold drag can find what is under the pointer. */
type Target = { kind: 'conv'; convId: string } | { kind: 'dock'; convId: string; key: string };
const targets = new Map<string, Target>();
const targetKey = (t: Target) => (t.kind === 'conv' ? `conv:${t.convId}` : `dock:${t.key}`);
const valid = (t: Target, p: RefPayload) => t.convId !== p.convId && !!chatState().conversations.get(t.convId)?.joined;

function ghost(p: RefPayload, users: Map<string, PublicUser>): HTMLElement {
  const el = document.createElement('div');
  el.className = 'ref-ghost';
  const who = p.kind === 'message' ? users.get(p.authorId)?.displayName ?? 'Someone' : p.name;
  el.textContent = p.kind === 'message' ? `↗ ${who}: ${p.excerpt.slice(0, 60)}` : `↗ ${who}`;
  document.body.appendChild(el);
  return el;
}

/** What makes a message's grip, or a file, draggable as a reference. */
export function refDragProps(p: RefPayload, users: Map<string, PublicUser>) {
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.stopPropagation();
      e.dataTransfer.setData(REF_DRAG, JSON.stringify(p));
      e.dataTransfer.setData('text/plain', p.kind === 'message' ? `dexconnect://message/${p.convId}/${p.messageId}` : `dexconnect://file/${p.fileId}`);
      e.dataTransfer.effectAllowed = 'copyLink';
      const g = ghost(p, users);
      e.dataTransfer.setDragImage(g, 12, 12);
      setTimeout(() => g.remove(), 0);
      setDrag({ payload: p, over: null });
    },
    onDragEnd: () => setDrag(null),
  };
}

/** Press and hold a message, then move: the same drag, for pointers and touch. */
export function startHoldDrag(e: React.PointerEvent, p: RefPayload, users: Map<string, PublicUser>): void {
  if (e.button !== 0 || !e.isPrimary) return;
  const el = e.target as HTMLElement;
  if (el.closest('button, a, input, textarea, select, [contenteditable], .spine-tools, .lcards, .poll, video, audio')) return;
  const x0 = e.clientX;
  const y0 = e.clientY;
  const host = e.currentTarget as HTMLElement;
  let lifted = false;
  let g: HTMLElement | null = null;
  const timer = setTimeout(() => {
    lifted = true;
    window.getSelection()?.removeAllRanges();
    document.body.classList.add('ref-dragging');
    host.classList.add('lifted');
    g = ghost(p, users);
    g.style.left = `${x0 + 14}px`;
    g.style.top = `${y0 + 10}px`;
    navigator.vibrate?.(15);
    setDrag({ payload: p, over: null });
  }, 450);
  const under = (x: number, y: number): string | null => {
    const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-ref-drop]');
    const key = hit?.dataset.refDrop ?? null;
    const t = key ? targets.get(key) : undefined;
    return t && valid(t, p) ? key : null;
  };
  const move = (ev: PointerEvent) => {
    if (!lifted) { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 6) done(); return; }
    ev.preventDefault();
    window.getSelection()?.removeAllRanges();
    if (g) { g.style.left = `${ev.clientX + 14}px`; g.style.top = `${ev.clientY + 10}px`; }
    const over = under(ev.clientX, ev.clientY);
    if (drag && drag.over !== over) setDrag({ ...drag, over });
  };
  const up = (ev: PointerEvent) => {
    const over = lifted ? under(ev.clientX, ev.clientY) : null;
    done();
    const t = over ? targets.get(over) : undefined;
    if (t) void dropOn(t, p);
  };
  const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') done(); };
  const noSelect = (ev: Event) => { if (lifted) ev.preventDefault(); };
  function done() {
    clearTimeout(timer);
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', done, true);
    window.removeEventListener('keydown', key, true);
    document.removeEventListener('selectstart', noSelect, true);
    document.body.classList.remove('ref-dragging');
    host.classList.remove('lifted');
    g?.remove();
    if (lifted) setDrag(null);
  }
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', done, true);
  window.addEventListener('keydown', key, true);
  document.addEventListener('selectstart', noSelect, true);
}

/** A place a reference can be dropped: its event handlers, and whether a drag is over it. */
export function useRefTarget(t: Target): { props: Record<string, unknown>; valid: boolean; over: boolean } {
  const d = useRefDrag();
  const key = targetKey(t);
  useEffect(() => { targets.set(key, t); return () => { if (targets.get(key) === t) targets.delete(key); }; });
  const ok = !!d && valid(t, d.payload);
  const props = {
    'data-ref-drop': key,
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(REF_DRAG) || !drag || !valid(t, drag.payload)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'link';
      if (drag.over !== key) setDrag({ ...drag, over: key });
    },
    onDragLeave: (e: React.DragEvent) => {
      if (drag?.over === key && !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDrag({ ...drag, over: null });
    },
    onDrop: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(REF_DRAG)) return;
      e.preventDefault();
      e.stopPropagation();
      let p = drag?.payload ?? null;
      if (!p) { try { p = JSON.parse(e.dataTransfer.getData(REF_DRAG)) as RefPayload; } catch { p = null; } }
      setDrag(null);
      if (p && valid(t, p)) void dropOn(t, p);
    },
  };
  return { props, valid: ok, over: ok && d?.over === key };
}

async function dropOn(t: Target, p: RefPayload): Promise<void> {
  if (t.kind === 'dock') { window.dispatchEvent(new CustomEvent('dex-ref-attach', { detail: { key: t.key, payload: p } })); return; }
  await shareRef(t.convId, p, null);
}

// ------------------------------------------------------------------ posting, with the check
type Ask = { convId: string; without: number; members: number; resolve: (go: boolean) => void };
let asking: Ask | null = null;
const askSubs = new Set<() => void>();
const setAsk = (a: Ask | null) => { asking = a; for (const f of askSubs) f(); };

/** Post a reference into a conversation; first a sheet when some people there cannot open the source. */
export async function shareRef(convId: string, p: RefPayload, parentId: string | null): Promise<boolean> {
  const toast = (detail: string) => window.dispatchEvent(new CustomEvent('dex-toast', { detail }));
  try {
    const target = targetOf(p);
    const check = await window.dex.request('refs.check', { convId, target });
    if (check.without > 0) {
      const go = await new Promise<boolean>((resolve) => setAsk({ convId, without: check.without, members: check.members, resolve }));
      if (!go) return false;
    }
    await window.dex.request('refs.send', { convId, target, parentId: parentId ?? undefined, clientId: `ref-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}` });
    const c = chatState().conversations.get(convId);
    window.dispatchEvent(new CustomEvent('dex-toast', { detail: { ok: true, text: c ? `Referenced in ${c.kind === 'space' ? c.name : 'the Direct conversation'}` : 'Referenced' } }));
    return true;
  } catch (e) { toast((e as Error).message); return false; }
}

/** The confirmation sheet and the drag highlight, drawn once for the whole chat view. */
export function RefHost({ users, meId }: { users: Map<string, PublicUser>; meId: string }) {
  const a = useSyncExternalStore((f) => { askSubs.add(f); return () => askSubs.delete(f); }, () => asking);
  const d = useRefDrag();
  useEffect(() => { document.body.classList.toggle('ref-drag-on', !!d); }, [d]);
  if (!a) return null;
  const c = chatState().conversations.get(a.convId);
  const title = c ? convTitle(c, users, meId) : 'this conversation';
  const answer = (go: boolean) => { a.resolve(go); setAsk(null); };
  return (
    <Dialog title="Reference it here?" onClose={() => answer(false)} narrow>
      <div className="ref-ask">
        <span className="ref-ask-count mono" aria-hidden="true">{a.without}/{a.members}</span>
        <p style={{ margin: 0 }}>{a.without === 1 ? '1 person' : `${a.without} people`} in <b translate="no">{title}</b> can't open the source; they'll see only that it exists.</p>
      </div>
      <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>A reference never copies the message or file, and never gives anyone access to it. People who can open the source see it as usual.</p>
      <div className="dialog-actions">
        <span />
        <button className="btn ghost" onClick={() => answer(false)}>Cancel</button>
        <button className="btn primary" autoFocus onClick={() => answer(true)}><Icon name="reference" size={15} />Reference it</button>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ Reference in… (keyboard)
export function ReferenceDialog({ payload, users, meId, onClose }: { payload: RefPayload; users: Map<string, PublicUser>; meId: string; onClose: () => void }) {
  const conversations = useChat((s) => s.conversations);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const list = [...conversations.values()].filter((c) => c.joined && !c.archived && c.id !== payload.convId)
    .map((c) => ({ c, title: convTitle(c, users, meId) }))
    .filter((x) => !q || x.title.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (b.c.lastMessage?.createdAt ?? b.c.createdAt) - (a.c.lastMessage?.createdAt ?? a.c.createdAt));
  const pick = async (c: Conversation) => {
    setBusy(true);
    const ok = await shareRef(c.id, payload, null);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Dialog title="Reference in…" onClose={onClose}>
      <p className="muted" style={{ margin: 0 }}>Points to the {payload.kind === 'file' ? 'file' : 'message'} where it is. Nothing is copied, and nobody gets access they did not have.</p>
      <input className="input" autoFocus placeholder="Search conversations" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search conversations" />
      <div className="picker-list" role="listbox" aria-label="Conversations">
        {list.length === 0 && <div className="faint" style={{ padding: 12 }}>No conversations match.</div>}
        {list.slice(0, 60).map(({ c, title }) => (
          <button key={c.id} role="option" aria-selected="false" className="picker-row ref-pick" disabled={busy} onClick={() => void pick(c)}>
            <ConvTile c={c} users={users} meId={meId} size="sm" />
            <span className="sb-main"><span className="sb-name" translate="no">{title}</span><span className="sb-preview">{c.kind === 'space' ? 'Space' : 'Direct'}</span></span>
            <Icon name="reference" size={15} />
          </button>
        ))}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ a reference in the timeline
export function RefCard({ m, users, meId, onView }: { m: Message; users: Map<string, PublicUser>; meId: string; onView: (f: FileInfo, all: FileInfo[]) => void }) {
  const r = m.ref!;
  const who = r.authorId === meId ? 'you' : users.get(r.authorId)?.displayName ?? 'a former member';
  if (!r.access) {
    return (
      <div className="ref-card none" role="group" aria-label="Reference">
        <span className="ref-mark" aria-hidden="true"><Icon name="lock" size={15} /></span>
        <div className="ref-main">
          <span className="ref-quiet">From a conversation you're not in</span>
          <span className="faint ref-by">{r.kind === 'file' ? 'A file shared by ' : 'Written by '}<b translate="no">{who}</b></span>
        </div>
      </div>
    );
  }
  const where = r.kind === 'file' ? null : r.convKind === 'space' ? r.convName ?? 'a Space' : (() => {
    const c = r.convId ? chatState().conversations.get(r.convId) : undefined;
    return c ? convTitle(c, users, meId) : 'a Direct conversation';
  })();
  const open = () => {
    if (!r.convId || !r.messageId) return;
    window.dispatchEvent(new CustomEvent('dex-open-message', { detail: { convId: r.convId, messageId: r.message?.parentId ?? r.messageId, parentId: r.message?.parentId ?? null } }));
  };
  const src = r.message;
  const locked = (src as { e2e?: string } | undefined)?.e2e === 'locked';
  return (
    <div className="ref-card" role="group" aria-label="Reference">
      <span className="ref-mark" aria-hidden="true"><Icon name="reference" size={15} /></span>
      <div className="ref-main">
        <div className="ref-head">
          <span className="label">Reference{where ? ' · from ' : ''}</span>{where && <span className="ref-where" translate="no">{where}</span>}
        </div>
        {r.gone ? <span className="faint ref-quiet">{r.kind === 'file' ? 'The file is no longer there.' : 'The message was deleted.'}</span> : r.kind === 'file' && r.file ? (
          <>
            <span className="faint ref-by">Shared by <b translate="no">{who}</b></span>
            <MessageFiles files={[r.file]} onView={onView} />
          </>
        ) : src ? (
          <>
            <span className="ref-by"><b translate="no">{users.get(src.authorId)?.displayName ?? 'Someone'}</b><span className="mono faint"> · {new Date(src.createdAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}{src.editedAt ? ' · edited' : ''}</span></span>
            <span className="ref-excerpt" translate="no">{locked ? 'Encrypted message: open it to read' : plainPreview(src.body, users) || (src.files.length ? `📎 ${src.files.map((f) => f.name).join(', ')}` : '')}</span>
            {src.files.length > 0 && !locked && <span className="mono faint ref-files">{src.files.length} {src.files.length === 1 ? 'file' : 'files'}</span>}
            <span className="ref-actions"><button className="lbtn" onClick={open}><Icon name="open" size={13} />Open the source</button></span>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** References waiting in the Dock, sent after the text. */
export function RefChips({ items, users, onRemove }: { items: RefPayload[]; users: Map<string, PublicUser>; onRemove: (i: number) => void }) {
  if (!items.length) return null;
  return (
    <div className="ref-chips" aria-label="References to send">
      {items.map((p, i) => (
        <span key={`${p.kind}-${p.kind === 'file' ? p.fileId : p.messageId}`} className="ref-chip">
          <Icon name="reference" size={13} />
          <span className="sb-name" translate="no">{p.kind === 'file' ? p.name : `${users.get(p.authorId)?.displayName ?? 'Someone'}: ${p.excerpt.slice(0, 40)}`}</span>
          <button className="icon-btn" aria-label="Remove this reference" onClick={() => onRemove(i)}><Icon name="x" size={12} /></button>
        </span>
      ))}
    </div>
  );
}

/** The excerpt a message is dragged with (for the drag ghost and the Dock chip). */
export function payloadFor(m: Message, users: Map<string, PublicUser>): RefPayload | null {
  if (m.deleted || m.system || m.e2e === 'locked') return null;
  // a reference dragged on points at its original
  if (m.ref?.access && m.ref.kind === 'message' && m.ref.convId && m.ref.messageId) {
    return { kind: 'message', convId: m.convId, messageId: m.id, authorId: m.ref.authorId, excerpt: m.ref.message ? plainPreview(m.ref.message.body, users) : '' };
  }
  if (m.ref && !m.ref.access) return null;
  const text = m.poll ? m.poll.question : m.decision ? m.decision.question : plainPreview(m.body, users) || (m.files[0]?.name ?? '');
  return { kind: 'message', convId: m.convId, messageId: m.id, authorId: m.authorId, excerpt: text };
}

/** A Switchboard row that takes a dropped reference for its conversation. */
export function RefDropRow({ convId, className, children }: { convId: string; className: string; children: React.ReactNode }) {
  const t = useRefTarget({ kind: 'conv', convId });
  return (
    <div className={`${className}${t.valid ? ' ref-valid' : ''}${t.over ? ' ref-over' : ''}`} role="listitem" {...t.props}>
      {children}
      {t.over && <span className="ref-drop-label row-label">Drop to reference here</span>}
    </div>
  );
}
