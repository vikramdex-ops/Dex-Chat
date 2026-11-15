// Action points in the app: logging one (from a chat line, the capture strip, the register or a
// message's menu), the preview that reads owner and due date as you type, the register entry drawn
// on its message (AP-07 · owner · due · a tick box), and the dialog that promotes any message.
// The hub keeps the register (meet-threads.ts); the rules are shared (@dex/core meet-threads).
import { useEffect, useMemo, useRef, useState } from 'react';
import { actionTrigger, apRef, isOverdue, isWebGuest, parseAction } from '@dex/core';
import type { ActionPoint, ActionSource, Conversation, Message, PublicUser, RoomInfo } from '@dex/core';
import type { NibPerson } from '@dex/core/nib';
import { Dialog, Icon, Popover, useToast } from '../ui.tsx';
import './threads.css';

// ------------------------------------------------------------------ dates
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const todayYmd = () => ymd(new Date());
/** "Fri 20 Nov" (in the person's language). */
export function dueLabel(due: string): string {
  const [y, m, d] = due.split('-').map(Number);
  return new Date(y, m - 1, d, 12).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}

// ------------------------------------------------------------------ who can own one
/** The thread's members and the meeting's guests (by name), for the parser and the owner picker. */
export function ownerPool(conv: Conversation | undefined, users: Map<string, PublicUser>, room?: RoomInfo | null): NibPerson[] {
  const out: NibPerson[] = [];
  for (const id of conv?.members ?? []) {
    const u = users.get(id);
    if (u && u.role !== 'bot') out.push({ id, name: u.displayName });
  }
  for (const v of room?.visitors ?? []) out.push({ id: v.userId, name: v.name });
  // people in the Room who are not in the thread (let in from outside)
  for (const p of room?.participants ?? []) {
    if (out.some((x) => x.id === p.userId) || isWebGuest(p.userId)) continue;
    const u = users.get(p.userId);
    if (u) out.push({ id: u.id, name: u.displayName });
  }
  return out;
}

export interface ActionDraft { task: string; ownerId: string | null; ownerName: string | null; due: string | null }

/**
 * A draft read from words as they are typed: owner and due follow the words until the person
 * picks them by hand.
 */
export function useActionDraft(words: string, pool: NibPerson[], meId: string): [ActionDraft, (p: Partial<ActionDraft>) => void, () => void] {
  const [picked, setPicked] = useState<Partial<ActionDraft>>({});
  const parsed = useMemo(() => parseAction(words, { people: pool, today: todayYmd(), meId }), [words, pool, meId]);
  const fromWords: ActionDraft = {
    task: parsed.task,
    ownerId: parsed.owner?.id ?? null,
    ownerName: parsed.owner && !parsed.owner.id ? parsed.owner.name : null,
    due: parsed.due,
  };
  // a guest the parser found by name is owned by name
  if (fromWords.ownerId && isWebGuest(fromWords.ownerId)) { fromWords.ownerName = pool.find((p) => p.id === fromWords.ownerId)?.name ?? null; fromWords.ownerId = null; }
  const draft = { ...fromWords, ...picked, task: fromWords.task };
  return [draft, (p) => setPicked((x) => ({ ...x, ...p })), () => setPicked({})];
}

let seq = 0;
/**
 * Log an action point: its card is a message in the thread (sent through the app, so an encrypted
 * Direct thread seals it), then the register entry on it. From the Room's chat the line goes to
 * everyone there, guests too.
 */
export async function logAction(convId: string, a: ActionDraft & { source: ActionSource }, via?: { roomId: string; ownerLabel: string }): Promise<ActionPoint> {
  const task = a.task.trim();
  if (!task) throw new Error('Say what needs doing.');
  let messageId: string;
  if (via) {
    const line = await window.dex.request('room.chat', { roomId: via.roomId, text: `→ ${task}${via.ownerLabel ? ` · ${via.ownerLabel}` : ''}${a.due ? `, by ${dueLabel(a.due)}` : ''}` });
    if (!line.messageId) throw new Error('This meeting has no thread to keep it in.');
    messageId = line.messageId;
  } else {
    const msg = await window.dex.request('msg.send', { convId, body: task, clientId: `ap-${Date.now().toString(36)}-${++seq}` });
    messageId = msg.id;
  }
  return window.dex.request('ap.create', { messageId, text: task, ownerId: a.ownerId, ownerName: a.ownerName, due: a.due, source: a.source });
}

export const ownerText = (a: Pick<ActionDraft, 'ownerId' | 'ownerName'>, users: Map<string, PublicUser>, meId: string) =>
  a.ownerId ? (a.ownerId === meId ? 'You' : users.get(a.ownerId)?.displayName ?? 'Someone') : a.ownerName ? `${a.ownerName} (guest)` : 'No owner';

// ------------------------------------------------------------------ the owner and the date, as ruled cells
const OTHER = '__other';

export function OwnerSelect({ value, pool, meId, onChange, id }: { value: Pick<ActionDraft, 'ownerId' | 'ownerName'>; pool: NibPerson[]; meId: string; onChange: (v: Pick<ActionDraft, 'ownerId' | 'ownerName'>) => void; id?: string }) {
  const [typing, setTyping] = useState(!value.ownerId && !!value.ownerName && !pool.some((p) => p.name === value.ownerName));
  const colleagues = pool.filter((p) => !isWebGuest(p.id));
  const guests = pool.filter((p) => isWebGuest(p.id));
  const sel = value.ownerId ?? (value.ownerName ? (guests.find((g) => g.name === value.ownerName)?.id ?? OTHER) : '');
  if (typing) {
    return (
      <span className="ap-other">
        <input id={id} className="input sm" value={value.ownerName ?? ''} maxLength={60} placeholder="Their name" aria-label="Owner's name (someone from outside)" autoFocus
          onChange={(e) => onChange({ ownerId: null, ownerName: e.target.value })} />
        <button type="button" className="icon-btn" aria-label="Choose from the list" title="Choose from the list" onClick={() => { setTyping(false); onChange({ ownerId: null, ownerName: null }); }}><Icon name="x" size={13} /></button>
      </span>
    );
  }
  return (
    <select id={id} className="input sm ap-select" value={sel} aria-label="Owner"
      onChange={(e) => {
        const v = e.target.value;
        if (v === OTHER) { setTyping(true); onChange({ ownerId: null, ownerName: '' }); return; }
        const g = guests.find((x) => x.id === v);
        onChange(g ? { ownerId: null, ownerName: g.name } : { ownerId: v || null, ownerName: null });
      }}>
      <option value="">No owner</option>
      {colleagues.map((p) => <option key={p.id} value={p.id} translate="no">{p.id === meId ? `${p.name} (you)` : p.name}</option>)}
      {guests.map((p) => <option key={p.id} value={p.id} translate="no">{`${p.name} (guest)`}</option>)}
      <option value={OTHER}>Someone from outside…</option>
    </select>
  );
}

export function DueInput({ value, onChange, id }: { value: string | null; onChange: (v: string | null) => void; id?: string }) {
  return <input id={id} type="date" className="input sm ap-date" value={value ?? ''} aria-label="Due date" onChange={(e) => onChange(e.target.value || null)} />;
}

// ------------------------------------------------------------------ the preview above a composer
/** What a chat line starting /action, AP:, → … will log: shown as it is typed; Enter logs it. */
export function ActionPreview({ draft, pool, meId, next, onPick, busy }: { draft: ActionDraft; pool: NibPerson[]; meId: string; next?: number; onPick: (p: Partial<ActionDraft>) => void; busy?: boolean }) {
  return (
    <div className="ap-preview" role="group" aria-label="Action point to log">
      <span className="ap-ref mono">{next ? apRef(next) : 'AP-··'}</span>
      <span className={`ap-task${draft.task ? '' : ' faint'}`}>{draft.task || 'Say what needs doing'}</span>
      <label className="ap-cell"><span className="cap mono">OWNER</span><OwnerSelect value={draft} pool={pool} meId={meId} onChange={onPick} /></label>
      <label className="ap-cell"><span className="cap mono">DUE</span><DueInput value={draft.due} onChange={(due) => onPick({ due })} /></label>
      <span className="ap-hint mono faint">{busy ? 'LOGGING…' : 'ENTER LOGS IT'}</span>
    </div>
  );
}

/** Is this composer text an action point? The words after the trigger, or null. */
export const actionWords = (text: string): string | null => actionTrigger(text);

// ------------------------------------------------------------------ the register entry on a message
export function ApStrip({ ap, users, meId, compact }: { ap: ActionPoint; users: Map<string, PublicUser>; meId: string; compact?: boolean }) {
  const toast = useToast();
  const [edit, setEdit] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const done = ap.status === 'done';
  const late = isOverdue(ap, todayYmd());
  const tick = () => void window.dex.request('ap.update', { id: ap.id, status: done ? 'open' : 'done' })
    .then((a) => toast(a.status === 'done' ? `${apRef(a.n)} done` : `${apRef(a.n)} open again`)).catch((e: Error) => toast(e.message, true));
  const owner = ownerText(ap, users, meId);
  return (
    <div className={`ap-strip${done ? ' done' : ''}${late ? ' late' : ''}${compact ? ' compact' : ''}`} role="group" aria-label={`Action point ${apRef(ap.n)}`}>
      <button className="ap-box" role="checkbox" aria-checked={done} aria-label={done ? `${apRef(ap.n)} is done: open it again` : `Mark ${apRef(ap.n)} done`} title={done ? 'Done: open it again' : 'Mark it done'} onClick={tick}>
        {done && <Icon name="check" size={13} />}
      </button>
      <span className="ap-ref mono">{apRef(ap.n)}</span>
      {ap.carried && <span className="tag mono">BROUGHT FORWARD</span>}
      <span className="ap-cell"><span className="cap mono">OWNER</span><span className="ap-val" translate={ap.ownerId || ap.ownerName ? 'no' : undefined}>{owner}</span></span>
      <span className="ap-cell"><span className="cap mono">DUE</span><span className="ap-val">{ap.due ? dueLabel(ap.due) : '—'}</span></span>
      <span className={`ap-status mono${late ? ' late' : ''}`}>{done ? 'DONE' : late ? 'OVERDUE' : 'OPEN'}</span>
      <button ref={btn} className="icon-btn ap-edit" aria-label={`Change ${apRef(ap.n)}`} title="Change the owner or date" aria-haspopup="dialog" aria-expanded={edit} onClick={() => setEdit(!edit)}><Icon name="edit" size={13} /></button>
      {edit && <Popover anchor={btn.current} onClose={() => setEdit(false)} className="menu ap-pop" align="end"><ApEdit ap={ap} users={users} meId={meId} onDone={() => setEdit(false)} /></Popover>}
    </div>
  );
}

function ApEdit({ ap, users, meId, onDone }: { ap: ActionPoint; users: Map<string, PublicUser>; meId: string; onDone: () => void }) {
  const toast = useToast();
  const [owner, setOwner] = useState<Pick<ActionDraft, 'ownerId' | 'ownerName'>>({ ownerId: ap.ownerId, ownerName: ap.ownerName });
  const [due, setDue] = useState(ap.due);
  const pool = useMemo(() => [...users.values()].filter((u) => u.role !== 'bot' && u.role !== 'guest').map((u) => ({ id: u.id, name: u.displayName })), [users]);
  const save = (extra: Record<string, unknown> = {}) => void window.dex.request('ap.update', { id: ap.id, ownerId: owner.ownerId, ownerName: owner.ownerName, due, ...extra })
    .then(() => onDone()).catch((e: Error) => toast(e.message, true));
  return (
    <div className="ap-edit-form">
      <div className="menu-label label">{apRef(ap.n)}</div>
      <label className="field"><span className="label">Owner</span><OwnerSelect value={owner} pool={pool} meId={meId} onChange={setOwner} /></label>
      <label className="field"><span className="label">Due</span><DueInput value={due} onChange={setDue} /></label>
      <div className="row-actions">
        <button className="btn ghost sm danger" onClick={() => save({ status: 'dropped' })}>Drop it</button>
        <button className="btn primary sm" onClick={() => save()}>Save</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ promote a message
/** "Make an action point" on any message: its words become the task, read for an owner and date. */
export function ActionDialog({ m, conv, users, meId, room, onClose }: { m: Message; conv: Conversation | undefined; users: Map<string, PublicUser>; meId: string; room?: RoomInfo | null; onClose: () => void }) {
  const toast = useToast();
  const pool = useMemo(() => ownerPool(conv, users, room), [conv, users, room]);
  const plain = (actionTrigger(m.body) ?? m.body).replace(/<@([^>]+)>/g, (_, id: string) => users.get(id)?.displayName ?? '').replace(/[*_`~]/g, '').trim();
  const [words, setWords] = useState(plain || m.files[0]?.name || '');
  const [draft, pick] = useActionDraft(words, pool, meId);
  const [task, setTask] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setTask(null); }, [words]);
  const sealed = m.e2e === 'ok' || m.e2e === 'unverified';
  const go = async () => {
    setBusy(true);
    try {
      const a = await window.dex.request('ap.create', { messageId: m.id, text: sealed ? undefined : (task ?? draft.task) || words, ownerId: draft.ownerId, ownerName: draft.ownerName, due: draft.due, source: 'promote' });
      toast(`${apRef(a.n)} logged`);
      onClose();
    } catch (e) { toast((e as Error).message, true); setBusy(false); }
  };
  return (
    <Dialog title="Make an action point" onClose={onClose} narrow>
      <div className="stack-v ap-dialog">
        <label className="field"><span className="label">What needs doing</span>
          <textarea className="input" rows={2} maxLength={300} value={task ?? draft.task} onChange={(e) => { if (task === null) setWords(e.target.value); else setTask(e.target.value); }} onBlur={() => { if (task === null) setTask(draft.task); }} />
        </label>
        {sealed && <p className="faint small"><Icon name="lock" size={12} /> The words stay end-to-end encrypted in the message; the register keeps the owner and date.</p>}
        <div className="ap-dialog-row">
          <label className="field"><span className="label">Owner</span><OwnerSelect value={draft} pool={pool} meId={meId} onChange={pick} /></label>
          <label className="field"><span className="label">Due</span><DueInput value={draft.due} onChange={(due) => pick({ due })} /></label>
        </div>
        <div className="dialog-actions">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !(task ?? draft.task ?? words).trim()} onClick={() => void go()}><Icon name="action" size={15} />Log action point</button>
        </div>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ the register, live
/** A thread's register (for a running or past occurrence: what is brought forward first), kept up to date. */
export function useRegister(convId: string | null, occurrenceId?: string | null): { actions: ActionPoint[] | null; next: number; reload: () => void } {
  const [state, setState] = useState<{ actions: ActionPoint[] | null; next: number }>({ actions: null, next: 1 });
  const [n, bump] = useState(0);
  useEffect(() => {
    if (!convId) return;
    let live = true;
    void window.dex.request('ap.list', occurrenceId ? { occurrenceId } : { convId }).then((r) => { if (live) setState(r); }).catch(() => { if (live) setState({ actions: [], next: 1 }); });
    const off = window.dex.onHubEvent((name, data) => {
      if (name !== 'ap.updated') return;
      const a = data as ActionPoint;
      if (a.convId !== convId) return;
      setState((s) => {
        const list = s.actions ?? [];
        const has = list.some((x) => x.id === a.id);
        if (!has && occurrenceId && a.occurrenceId !== occurrenceId) return s;
        const next = has ? list.map((x) => (x.id === a.id ? { ...a, carried: x.carried } : x)) : [...list, a];
        return { actions: next.filter((x) => x.status !== 'dropped'), next: Math.max(s.next, a.n + 1) };
      });
    });
    return () => { live = false; off(); };
  }, [convId, occurrenceId, n]);
  return { ...state, reload: () => bump((x) => x + 1) };
}
