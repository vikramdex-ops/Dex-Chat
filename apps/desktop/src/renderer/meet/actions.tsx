// Action points in the app: logging one (from a chat line, the capture strip, the register or a
// message's menu), the preview that reads owner and due date as you type, the register entry drawn
// on its message (AP-07 · owner · due · a tick box), and the dialog that promotes any message.
// The hub keeps the register (meet-threads.ts); the rules are shared (@dex/core meet-threads).
import { useEffect, useMemo, useRef, useState } from 'react';
import { actionTrigger, apRef, isOverdue, isWebGuest, mayChangeAction, parseAction } from '@dex/core';
import type { ActionChange, ActionPoint, ActionSource, Conversation, Message, PublicUser, RoomInfo } from '@dex/core';
import type { NibPerson } from '@dex/core/nib';
import { Dialog, Icon, useToast } from '../ui.tsx';
import { confirmAction } from '../confirm.tsx';
import { useChat } from '../chat/store.ts';
import { formatTime } from '../time.ts';
import { useAutoGrow } from '../autogrow.ts';
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

export function OwnerSelect({ value, pool, meId, onChange, id, disabled }: { value: Pick<ActionDraft, 'ownerId' | 'ownerName'>; pool: NibPerson[]; meId: string; onChange: (v: Pick<ActionDraft, 'ownerId' | 'ownerName'>) => void; id?: string; disabled?: boolean }) {
  const [typing, setTyping] = useState(!value.ownerId && !!value.ownerName && !pool.some((p) => p.name === value.ownerName));
  const colleagues = pool.filter((p) => !isWebGuest(p.id));
  const guests = pool.filter((p) => isWebGuest(p.id));
  const sel = value.ownerId ?? (value.ownerName ? (guests.find((g) => g.name === value.ownerName)?.id ?? OTHER) : '');
  if (typing) {
    return (
      <span className="ap-other">
        <input id={id} className="input sm" value={value.ownerName ?? ''} maxLength={60} disabled={disabled} placeholder="Their name" aria-label="Owner's name (someone from outside)" autoFocus
          onChange={(e) => onChange({ ownerId: null, ownerName: e.target.value })} />
        <button type="button" className="icon-btn" aria-label="Choose from the list" title="Choose from the list" disabled={disabled} onClick={() => { setTyping(false); onChange({ ownerId: null, ownerName: null }); }}><Icon name="x" size={13} /></button>
      </span>
    );
  }
  return (
    <select id={id} className="input sm ap-select" value={sel} aria-label="Owner" disabled={disabled}
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

export function DueInput({ value, onChange, id, disabled }: { value: string | null; onChange: (v: string | null) => void; id?: string; disabled?: boolean }) {
  return <input id={id} type="date" className="input sm ap-date" value={value ?? ''} aria-label="Due date" disabled={disabled} onChange={(e) => onChange(e.target.value || null)} />;
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
const MAY_NOT = 'Only its owner, whoever logged it and the organiser can change it.';

/** May I change this point? (The hub decides; this greys out what it would refuse.) */
export function useMayChange(ap: Pick<ActionPoint, 'ownerId' | 'createdBy' | 'organiserId'>, users: Map<string, PublicUser>, meId: string): boolean {
  return mayChangeAction(ap, { id: meId, role: users.get(meId)?.role ?? 'member' });
}

export function ApStrip({ ap, users, meId, compact, title }: { ap: ActionPoint; users: Map<string, PublicUser>; meId: string; compact?: boolean; /** The point itself, drawn in the strip's top row (the recap). */ title?: React.ReactNode }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const may = useMayChange(ap, users, meId);
  const done = ap.status === 'done';
  const late = isOverdue(ap, todayYmd());
  const tick = () => {
    if (!may) { toast(MAY_NOT, true); return; }
    void window.dex.request('ap.update', { id: ap.id, status: done ? 'open' : 'done' })
      .then((a) => toast(a.status === 'done' ? `${apRef(a.n)} done` : `${apRef(a.n)} open again`)).catch((e: Error) => toast(e.message, true));
  };
  const owner = ownerText(ap, users, meId);
  const ref = apRef(ap.n);
  // in the thread the message is the task; words revised since show here (the recap always shows them)
  const shownTitle = title !== undefined ? title : ap.revisedAt && ap.text ? <span translate="no">{ap.text}</span> : undefined;
  return (
    <div className={`ap-strip${done ? ' done' : ''}${late ? ' late' : ''}${compact ? ' compact' : ''}`} role="group" aria-label={`Action point ${ref}`}>
      <button className="ap-box" role="checkbox" aria-checked={done} aria-disabled={!may || undefined}
        aria-label={done ? `${ref} is done: open it again` : `Mark ${ref} done`} title={!may ? MAY_NOT : done ? 'Done: open it again' : 'Mark it done'} onClick={tick}>
        {done && <Icon name="check" size={13} />}
      </button>
      <span className="ap-ref mono">{ref}</span>
      {shownTitle !== undefined && <button type="button" className="ap-title" onClick={() => setOpen(true)} title="Open it: the words, owner, date and its history">{shownTitle}{ap.revisedAt ? <span className="tag mono ap-revised">REVISED</span> : null}</button>}
      {ap.carried && <span className="tag mono">BROUGHT FORWARD</span>}
      <span className="ap-cell"><span className="cap mono">OWNER</span><span className="ap-val" translate={ap.ownerId || ap.ownerName ? 'no' : undefined}>{owner}</span></span>
      <span className="ap-cell"><span className="cap mono">DUE</span><span className="ap-val">{ap.due ? dueLabel(ap.due) : '—'}</span></span>
      <button type="button" className={`ap-status mono${late ? ' late' : ''}`} onClick={() => setOpen(true)} aria-label={done ? `${ref} is done. Open it` : late ? `${ref} is overdue. Open it` : `${ref} is open. Open it`} title="Open it: the words, owner, date and its history">{done ? 'DONE' : late ? 'OVERDUE' : 'OPEN'}</button>
      <button type="button" className="icon-btn ap-edit" aria-label={may ? `Change ${ref}` : `Open ${ref}`} title={may ? 'Change the words, owner or date' : 'Open it and see its history'} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><Icon name="edit" size={13} /></button>
      {open && <ApSheet ap={ap} users={users} meId={meId} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** Who can own it, as a colleague changing it later sees them: the thread's people; for the organiser, anyone in the office (the hub adds them to the thread). */
function editPool(ap: ActionPoint, conv: Conversation | undefined, users: Map<string, PublicUser>, meId: string): NibPerson[] {
  const pool = ownerPool(conv, users);
  const has = (id: string) => pool.some((p) => p.id === id);
  const add = (u: PublicUser | undefined) => { if (u && u.role !== 'bot' && u.role !== 'guest' && !has(u.id)) pool.push({ id: u.id, name: u.displayName }); };
  if (ap.ownerId) add(users.get(ap.ownerId));
  // no thread here (an outsider's recap) or the organiser: the office
  if (!conv || ap.organiserId === meId) for (const u of users.values()) add(u);
  return pool;
}

const sameOwner = (a: Pick<ActionDraft, 'ownerId' | 'ownerName'>, b: Pick<ActionDraft, 'ownerId' | 'ownerName'>) => (a.ownerId ?? null) === (b.ownerId ?? null) && (a.ownerName || null) === (b.ownerName || null);

/**
 * An action point opened: its words, owner, due date and state, changed by whoever may (the rest
 * read it), and its history underneath: who logged it and every change since. Saved to the hub,
 * which tells the thread; the recap and the register follow.
 */
export function ApSheet({ ap, users, meId, onClose }: { ap: ActionPoint; users: Map<string, PublicUser>; meId: string; onClose: () => void }) {
  const toast = useToast();
  const may = useMayChange(ap, users, meId);
  const conv = useChat((s) => s.conversations.get(ap.convId));
  const pool = useMemo(() => editPool(ap, conv, users, meId), [ap, conv, users, meId]);
  const [text, setText] = useState(ap.text);
  const [owner, setOwner] = useState<Pick<ActionDraft, 'ownerId' | 'ownerName'>>({ ownerId: ap.ownerId, ownerName: ap.ownerName });
  const [due, setDue] = useState(ap.due);
  const [status, setStatus] = useState<'open' | 'done'>(ap.status === 'done' ? 'done' : 'open');
  const [busy, setBusy] = useState(false);
  const words = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(words, text, 6);
  const ref = apRef(ap.n);
  const changes: Record<string, unknown> = {};
  if (!ap.sealed && text.trim() && text.trim() !== ap.text) changes.text = text.trim();
  if (!sameOwner(owner, ap)) { changes.ownerId = owner.ownerId; changes.ownerName = owner.ownerName || null; }
  if ((due ?? null) !== (ap.due ?? null)) changes.due = due;
  if (status !== (ap.status === 'done' ? 'done' : 'open')) changes.status = status;
  const dirty = Object.keys(changes).length > 0;
  const send = async (patch: Record<string, unknown>, said: string) => {
    setBusy(true);
    try {
      await window.dex.request('ap.update', { id: ap.id, ...patch });
      toast(said);
      onClose();
    } catch (e) { toast((e as Error).message, true); setBusy(false); }
  };
  const drop = async () => {
    if (!await confirmAction({ title: `Drop ${ref}?`, body: 'It leaves the register, the recap and its owner\'s Desk. Its message stays in the thread, and its history is kept.', confirm: 'Drop it', danger: true })) return;
    await send({ status: 'dropped' }, `${ref} dropped`);
  };
  return (
    <Dialog title={`${ref} · Action point`} onClose={onClose} narrow>
      <div className="stack-v ap-dialog ap-sheet">
        {!may && <p className="ap-note faint small"><Icon name="lock" size={12} />{MAY_NOT}</p>}
        <label className="field"><span className="label">What needs doing</span>
          {ap.sealed
            ? <span className="faint small"><Icon name="lock" size={12} /> End-to-end encrypted: change its words by editing its message in the thread.</span>
            : <textarea ref={words} className="input" rows={2} maxLength={300} value={text} disabled={!may || busy} onChange={(e) => setText(e.target.value)} />}
        </label>
        <div className="ap-dialog-row">
          <label className="field"><span className="label">Owner</span><OwnerSelect value={owner} pool={pool} meId={meId} onChange={setOwner} disabled={!may || busy} /></label>
          <label className="field"><span className="label">Due</span><DueInput value={due} onChange={setDue} disabled={!may || busy} /></label>
        </div>
        <div className="field"><span className="label">State</span>
          <div className="seg ap-state" role="group" aria-label="State">
            <button type="button" aria-pressed={status === 'open'} disabled={!may || busy} onClick={() => setStatus('open')}>Still to do</button>
            <button type="button" aria-pressed={status === 'done'} disabled={!may || busy} onClick={() => setStatus('done')}><Icon name="check" size={13} />Done</button>
          </div>
        </div>
        <ApHistory ap={ap} users={users} meId={meId} />
        <div className="dialog-actions">
          {may && <button className="btn ghost danger" disabled={busy} onClick={() => void drop()}>Drop it</button>}
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose}>{may ? 'Cancel' : 'Close'}</button>
          {may && <button className="btn primary" disabled={!dirty || busy || (!ap.sealed && !text.trim())} onClick={() => void send(changes, `${ref} saved`)}>Save changes</button>}
        </div>
      </div>
    </Dialog>
  );
}

const hmDay = (t: number) => `${new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' })} ${formatTime(t)}`;

/** One change as a sentence: "Priya gave it to Ravi Kumar". */
function changeLines(c: ActionChange, who: string, nameOf: (id: string) => string): string[] {
  if (c.kind === 'logged') return [`${who} logged it`];
  const out: string[] = [];
  for (const f of c.fields) {
    if (f.field === 'text') out.push(`${who} changed the words to “${f.to}”`);
    else if (f.field === 'owner') out.push(!f.to ? `${who} took the owner off` : f.to.startsWith('~') ? `${who} gave it to ${f.to.slice(1)}, a guest` : `${who} gave it to ${nameOf(f.to)}`);
    else if (f.field === 'due') out.push(f.to ? `${who} set the date to ${dueLabel(f.to)}` : `${who} took the date off`);
    else if (f.to === 'done') out.push(c.kind === 'ticked' ? `${who} marked it done on the day sheet` : `${who} marked it done`);
    else if (f.to === 'dropped') out.push(`${who} dropped it`);
    else out.push(c.kind === 'ticked' ? `${who} opened it again on the day sheet` : `${who} opened it again`);
  }
  return out;
}

/** Its history (the audit trail): newest last, read from the hub when opened and when it changes. */
function ApHistory({ ap, users, meId }: { ap: ActionPoint; users: Map<string, PublicUser>; meId: string }) {
  const [changes, setChanges] = useState<ActionChange[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void window.dex.request('ap.history', { id: ap.id }).then((h) => { if (live) { setChanges(h.changes); setProblem(null); } }).catch((e: Error) => { if (live) setProblem(e.message); });
    return () => { live = false; };
  }, [ap.id, ap.updatedAt]);
  // by name, yours too: a sentence reads the same in every language ("You" would sit untranslated in it)
  const person = (id: string) => users.get(id)?.displayName ?? 'Someone';
  return (
    <section className="ap-history" aria-label={`History of ${apRef(ap.n)}`}>
      <h3 className="label">History</h3>
      {problem && <p className="faint small">{problem}</p>}
      {!changes && !problem && <span className="spinner" />}
      {changes && !changes.length && <p className="faint small">Nothing recorded yet.</p>}
      {changes && changes.length > 0 && (
        <ol>
          {changes.flatMap((c, i) => changeLines(c, person(c.by), person).map((t, j) => (
            <li key={`${i}-${j}`}><span className="mono faint">{hmDay(c.at)}</span><span>{t}</span></li>
          )))}
        </ol>
      )}
    </section>
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
