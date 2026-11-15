// The Desk lens: callouts (@ you and side-track replies), side-tracks you follow, reminders,
// what you kept, what waits to send, notes and your timesheet; and the card that appears when a
// reminder goes off.
import { useEffect, useRef, useState } from 'react';
import type { KeepKind, Message, Ops, PublicUser, Reminder, SavedMessage, ScheduledMessage, Session } from '@dex/core';
import { KEEP_KINDS } from '@dex/core';
import { Avatar, Icon, Popover, Segmented, presenceFor, useToast } from '../ui.tsx';
import { RemindDialog, ScheduleDialog } from '../chat/extras.tsx';
import { plainPreview } from '../chat/format.tsx';
import { useChat } from '../chat/store.ts';
import { convTitle } from '../chat/Switchboard.tsx';
import { Timesheet } from '../work/WorkUi.tsx';
import { NoteEditor, NotesList } from '../chat/notes.tsx';
import { KEEP_LABEL, REPEAT_LABEL, describeWhen, dismissRinging, setKeepKind, snoozePresets, toggleSaved, useDesk } from '../desk/store.ts';
import type { WhenPreset } from '../desk/store.ts';
import { SheetTabs } from './People.tsx';
import { onOpenRequest } from '../chat/deeplinks.ts';
import { MyBots } from '../bots/maker/MyBots.tsx';
import { useProgressive } from '../progressive.ts';

type Tab = 'callouts' | 'tracks' | 'reminders' | 'kept' | 'scheduled' | 'notes' | 'bots' | 'timesheet';
const TABS: Tab[] = ['callouts', 'tracks', 'reminders', 'kept', 'scheduled', 'notes', 'bots', 'timesheet'];
type Jump = (convId: string, messageId?: string, parentId?: string | null) => void;

const snooze = (r: Reminder, p: WhenPreset) => window.dex.request('remind.update', { id: r.id, dueAt: p.at() });
/** Put a deleted reminder back as it was (a new one, the same text, time, repeat and message). */
const restore = (r: Reminder) => window.dex.request('remind.create', { text: r.text, messageId: r.message?.id, dueAt: r.dueAt, repeat: r.repeat, forUserId: r.userId !== r.createdBy ? r.userId : undefined });
const snoozedLine = (p: WhenPreset) => (p.id === '15m' ? 'Snoozed for 15 min' : `Snoozed until ${describeWhen(p.at())}`);

export function Desk({ session, jump }: { session: Session; jump: Jump }) {
  const [tab, setTab] = useState<Tab>(() => {
    try { const t = sessionStorage.getItem('dex-desk-tab') as Tab | null; if (t && TABS.includes(t)) return t; } catch { /* storage off */ }
    return 'reminders';
  });
  useEffect(() => { try { sessionStorage.setItem('dex-desk-tab', tab); } catch { /* storage off */ } }, [tab]);
  // dexconnect://desk/task/<id>: the Reminders sheet, with the task picked out
  useEffect(() => onOpenRequest('task', ({ id }) => {
    setTab('reminders');
    let tries = 0;
    const find = () => {
      const el = document.querySelector<HTMLElement>(`.desk-row[data-rid="${CSS.escape(id)}"]`);
      if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1800); }
      else if (++tries < 20) setTimeout(find, 100);
      else window.dispatchEvent(new CustomEvent('dex-toast', { detail: 'That task is not on your Desk.' }));
    };
    setTimeout(find, 50);
  }), []);
  const [creating, setCreating] = useState(false);
  const [note, setNote] = useState<string | null | 'new'>(null);
  const users = new Map(session.users.map((u) => [u.id, u] as const));
  const meId = session.me.id;
  const reminders = useDesk((s) => s.reminders);
  const saved = useDesk((s) => s.saved);
  const scheduled = useDesk((s) => s.scheduled);
  const loaded = useDesk((s) => s.loaded);
  const ringing = useDesk((s) => s.ringing.length);
  const openMine = [...reminders.values()].filter((r) => r.userId === meId && !r.done).length;

  return (
    <div className="view desk">
      <div className="view-head">
        <div>
          <h1>Desk</h1>
          <p className="muted">Callouts, side-tracks you follow, reminders, what you kept, what waits to send, and your timesheet.</p>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}><Icon name="plus" size={15} />New reminder</button>
      </div>
      <SheetTabs<Tab> label="Desk section" value={tab} onChange={setTab} tabs={[
        { value: 'callouts', label: 'Callouts' },
        { value: 'tracks', label: 'Side-tracks' },
        { value: 'reminders', label: 'Reminders', count: openMine, attention: ringing > 0 },
        { value: 'kept', label: 'Kept', count: saved.size },
        { value: 'scheduled', label: 'Waiting to send', count: scheduled.size },
        { value: 'notes', label: 'Notes' },
        { value: 'bots', label: 'Bots' },
        ...(session.me.role === 'guest' ? [] : [{ value: 'timesheet' as Tab, label: 'Timesheet' }]),
      ]} />
      <div className="desk-body">
        {!loaded && <div className="tl-more"><span className="spinner" /></div>}
        {loaded && tab === 'reminders' && <Reminders list={[...reminders.values()]} users={users} meId={meId} jump={jump} onNew={() => setCreating(true)} />}
        {loaded && tab === 'kept' && <Kept list={[...saved.values()].sort((a, b) => b.savedAt - a.savedAt)} users={users} meId={meId} jump={jump} />}
        {tab === 'timesheet' && <Timesheet me={session.me} />}
        {tab === 'bots' && <MyBots session={session} />}
        {tab === 'callouts' && <Callouts users={users} meId={meId} jump={jump} />}
        {tab === 'tracks' && <Tracks users={users} meId={meId} jump={jump} />}
        {tab === 'notes' && (
          <div className="desk-notes card">
            {note === null
              ? <NotesList convId={null} users={users} onOpen={setNote} onNew={() => setNote('new')} />
              : <NoteEditor key={note} id={note === 'new' ? null : note} convId={null} users={users} meId={meId} onClose={() => setNote(null)} />}
          </div>
        )}
        {loaded && tab === 'scheduled' && <Scheduled list={[...scheduled.values()].sort((a, b) => a.sendAt - b.sendAt)} users={users} meId={meId} jump={jump} />}
      </div>
      {creating && <RemindDialog users={users} meId={meId} onClose={() => setCreating(false)} />}
    </div>
  );
}

/** A long list drawn a screenful first, the rest over the next frames (see progressive.ts). */
function Progressive<T>({ items, render }: { items: readonly T[]; render: (item: T) => React.ReactNode }) {
  return <>{useProgressive(items).map(render)}</>;
}

// ------------------------------------------------------------------ reminders
function Reminders({ list, users, meId, jump, onNew }: { list: Reminder[]; users: Map<string, PublicUser>; meId: string; jump: Jump; onNew: () => void }) {
  const [showDone, setShowDone] = useState(false);
  const now = Date.now();
  const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999);
  const mine = list.filter((r) => r.userId === meId);
  const open = mine.filter((r) => !r.done).sort((a, b) => a.dueAt - b.dueAt);
  const groups: Array<{ id: string; label: string; items: Reminder[] }> = [
    { id: 'due', label: 'Due', items: open.filter((r) => r.dueAt <= now || (r.firedAt !== null && r.repeat === 'none')) },
    { id: 'today', label: 'Later today', items: open.filter((r) => r.dueAt > now && r.dueAt <= endOfToday.getTime() && !(r.firedAt !== null && r.repeat === 'none')) },
    { id: 'upcoming', label: 'Upcoming', items: open.filter((r) => r.dueAt > endOfToday.getTime() && !(r.firedAt !== null && r.repeat === 'none')) },
    { id: 'others', label: 'Set for others', items: list.filter((r) => r.createdBy === meId && r.userId !== meId && !r.done).sort((a, b) => a.dueAt - b.dueAt) },
  ];
  const done = list.filter((r) => r.done && (r.userId === meId || r.createdBy === meId)).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
  if (!groups.some((g) => g.items.length) && !done.length) {
    return (
      <div className="empty desk-empty">
        <Icon name="alarm" size={36} />
        <span>No reminders. Set one from any message with <Icon name="alarm" size={13} />, or add your own.</span>
        <button className="btn" onClick={onNew}><Icon name="plus" size={15} />New reminder</button>
      </div>
    );
  }
  return (
    <>
      {groups.filter((g) => g.items.length).map((g) => (
        <section key={g.id} className="desk-group">
          <h3 className={`label${g.id === 'due' ? ' due' : ''}`}>{g.label} · {g.items.length}</h3>
          <Progressive items={g.items} render={(r) => <ReminderRow key={r.id} r={r} users={users} meId={meId} jump={jump} />} />
        </section>
      ))}
      {done.length > 0 && (
        <section className="desk-group">
          <button className="link label" onClick={() => setShowDone(!showDone)}>{showDone ? 'Hide' : 'Show'} done · {done.length}</button>
          {showDone && done.slice(0, 100).map((r) => <ReminderRow key={r.id} r={r} users={users} meId={meId} jump={jump} />)}
        </section>
      )}
    </>
  );
}

function ReminderRow({ r, users, meId, jump }: { r: Reminder; users: Map<string, PublicUser>; meId: string; jump: Jump }) {
  const toast = useToast();
  const [menu, setMenu] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const act = (p: Promise<unknown>, ok?: string, undo?: () => Promise<unknown>) => void p.then(() => ok && toast(ok, false, undo && { label: 'Undo', run: () => void undo().catch((e: Error) => toast(e.message, true)) })).catch((e: Error) => toast(e.message, true));
  const overdue = !r.done && r.dueAt <= Date.now();
  const forOther = r.userId !== meId;
  const by = r.createdBy !== meId ? users.get(r.createdBy)?.displayName : null;
  return (
    <div className={`desk-row${r.done ? ' done' : ''}${overdue ? ' overdue' : ''}`} data-rid={r.id}>
      <button className={`check-ring${r.done ? ' on' : ''}`} aria-label={r.done ? 'Mark as not done' : 'Mark as done'} disabled={forOther}
        onClick={() => act(window.dex.request('remind.update', { id: r.id, done: !r.done }), r.done ? undefined : 'Done', r.done ? undefined : () => window.dex.request('remind.update', { id: r.id, done: false }))}>
        {r.done && <Icon name="check" size={13} />}
      </button>
      <div className="desk-main">
        <div className="desk-text" translate="no">{r.text}</div>
        {r.message && (
          <button className="desk-quote" onClick={() => jump(r.message!.convId, r.message!.id, r.message!.parentId)}>
            <QuoteLine m={r.message} users={users} meId={meId} />
          </button>
        )}
        <div className="desk-meta">
          <span className={`desk-when${overdue ? ' due' : ''}`}><Icon name="alarm" size={12} />{describeWhen(r.dueAt)}</span>
          {r.repeat !== 'none' && <span className="chip"><Icon name="repeat" size={12} />{REPEAT_LABEL[r.repeat]}</span>}
          {forOther && <span className="faint">for {users.get(r.userId)?.displayName ?? 'someone'}</span>}
          {by && <span className="faint">from {by}</span>}
        </div>
      </div>
      {!r.done && (
        <div className="desk-actions">
          {!forOther && <button className="btn ghost sm" onClick={() => { const p = snoozePresets()[0]; act(snooze(r, p), snoozedLine(p)); }}>Snooze 15 min</button>}
          <button ref={menuBtn} className="icon-btn" aria-label="More for this reminder" title="Snooze until… or delete" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><Icon name="more" size={16} /></button>
          {menu && (
            <Popover anchor={menuBtn.current} onClose={() => setMenu(false)} className="menu desk-menu">
              {!forOther && <>
                <div className="menu-label label">Snooze until</div>
                {snoozePresets().slice(1).map((p) => (
                  <button key={p.id} role="menuitem" onClick={() => { setMenu(false); act(snooze(r, p), snoozedLine(p)); }}>
                    <Icon name={p.id === 'tomorrow' ? 'sun' : 'clock'} size={16} />{p.label}{p.id !== 'tomorrow' && <span className="menu-at mono">{describeWhen(p.at()).split(', ').pop()}</span>}
                  </button>
                ))}
                <div className="menu-sep" />
              </>}
              <button role="menuitem" className="danger" onClick={() => { setMenu(false); act(window.dex.request('remind.delete', { id: r.id }), 'Reminder deleted', () => restore(r)); }}><Icon name="trash" size={16} />Delete</button>
            </Popover>
          )}
        </div>
      )}
      {r.done && <button className="icon-btn" aria-label="Delete" title="Delete" onClick={() => act(window.dex.request('remind.delete', { id: r.id }), 'Reminder deleted', () => restore(r).then((n) => window.dex.request('remind.update', { id: n.id, done: true })))}><Icon name="trash" size={15} /></button>}
    </div>
  );
}

function QuoteLine({ m, users, meId }: { m: Message; users: Map<string, PublicUser>; meId: string }) {
  const conv = useChat((s) => s.conversations.get(m.convId));
  const who = m.authorId === meId ? 'You' : users.get(m.authorId)?.displayName ?? 'Someone';
  const where = conv ? convTitle(conv, users, meId) : '';
  const text = m.poll ? `📊 ${m.poll.question}` : plainPreview(m.body, users) || (m.files.length ? `📎 ${m.files.length === 1 ? m.files[0].name : `${m.files.length} files`}` : '');
  return <><span><b translate={m.authorId === meId ? undefined : 'no'}>{who}</b>{where && <span className="faint"> in <span translate="no">{where}</span></span>}</span><span className="desk-quote-text" translate="no">{text}</span></>;
}

// ------------------------------------------------------------------ kept on my Desk
function Kept({ list: all, users, meId, jump }: { list: SavedMessage[]; users: Map<string, PublicUser>; meId: string; jump: Jump }) {
  const toast = useToast();
  const [kind, setKind] = useState<KeepKind | 'all'>('all');
  const list = kind === 'all' ? all : all.filter((s) => (s.kind ?? 'keep') === kind);
  const counts = new Map<KeepKind, number>();
  for (const s of all) counts.set(s.kind ?? 'keep', (counts.get(s.kind ?? 'keep') ?? 0) + 1);
  if (!all.length) {
    return <div className="empty desk-empty"><Icon name="tray" size={36} /><span>Choose <b>Keep on my Desk</b> <Icon name="tray" size={13} /> on any message to file it here. Only you see what you keep.</span></div>;
  }
  return (
    <section className="desk-group">
      <div className="keep-kinds" role="tablist" aria-label="Kinds of kept messages">
        <button role="tab" aria-selected={kind === 'all'} className={kind === 'all' ? 'on' : ''} onClick={() => setKind('all')}>All <i>{all.length}</i></button>
        {KEEP_KINDS.filter((k) => counts.get(k)).map((k) => (
          <button key={k} role="tab" aria-selected={kind === k} className={`k-${k}${kind === k ? ' on' : ''}`} onClick={() => setKind(k)}>{KEEP_LABEL[k]} <i>{counts.get(k)}</i></button>
        ))}
      </div>
      <Progressive items={list} render={({ message: m, savedAt, kind: k }) => {
        const u = users.get(m.authorId);
        return (
          <div key={m.id} className="desk-row saved">
            <Avatar user={{ id: m.authorId, displayName: u?.displayName ?? '?' }} presence={presenceFor(m.authorId)} size="sm" />
            <button className="desk-main desk-open" onClick={() => jump(m.convId, m.id, m.parentId)}>
              <QuoteLine m={m} users={users} meId={meId} />
              <div className="desk-meta"><span className="faint">{describeWhen(m.createdAt)}</span><span className={`desk-tag mono k-${k ?? 'keep'}`}>{KEEP_LABEL[k ?? 'keep'].toUpperCase()} · {describeWhen(savedAt).toUpperCase()}</span></div>
            </button>
            <select className="input keep-kind" aria-label="File it as" value={k ?? 'keep'} onChange={(e) => void setKeepKind(m, e.target.value as KeepKind).catch((err: Error) => toast(err.message, true))}>
              {KEEP_KINDS.map((x) => <option key={x} value={x}>{KEEP_LABEL[x]}</option>)}
            </select>
            <button className="btn ghost sm" title="Take it off your Desk"
              onClick={() => void toggleSaved(m).then(() => toast('Taken off your Desk', false, { label: 'Undo', run: () => void toggleSaved(m).then(() => (k && k !== 'keep' ? setKeepKind(m, k) : undefined)).catch((e: Error) => toast(e.message, true)) })).catch((e: Error) => toast(e.message, true))}><Icon name="tray" size={15} />Take off Desk</button>
          </div>
        );
      }} />
    </section>
  );
}

// ------------------------------------------------------------------ scheduled
function Scheduled({ list, users, meId, jump }: { list: ScheduledMessage[]; users: Map<string, PublicUser>; meId: string; jump: Jump }) {
  if (!list.length) {
    return <div className="empty desk-empty"><Icon name="schedule" size={36} /><span>Nothing scheduled. Write a message and choose <b>Send later</b> beside Send.</span></div>;
  }
  return <section className="desk-group">{list.map((s) => <ScheduledRow key={s.id} s={s} users={users} meId={meId} jump={jump} />)}</section>;
}

function ScheduledRow({ s, users, meId, jump }: { s: ScheduledMessage; users: Map<string, PublicUser>; meId: string; jump: Jump }) {
  const toast = useToast();
  const conv = useChat((st) => st.conversations.get(s.convId));
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(s.body);
  const [moving, setMoving] = useState(false);
  const act = (p: Promise<unknown>, ok?: string) => p.then(() => { if (ok) toast(ok); }).catch((e: Error) => toast(e.message, true));
  return (
    <div className={`desk-row${s.status === 'failed' ? ' overdue' : ''}`}>
      <span className="pal-icon"><Icon name="schedule" size={16} /></span>
      <div className="desk-main">
        <button className="link desk-where" onClick={() => jump(s.convId)}>To {conv ? convTitle(conv, users, meId) : 'a conversation you left'}{s.parentId ? ' · side-track' : ''}</button>
        {editing ? (
          <div className="edit-box">
            <textarea className="input" autoFocus value={text} maxLength={8000} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setEditing(false); setText(s.body); }
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void act(window.dex.request('sched.update', { id: s.id, body: text }), 'Saved').then(() => setEditing(false)); }
              }} />
            <div className="edit-hint faint">Enter to save · Esc to cancel</div>
          </div>
        ) : <div className="desk-text" translate={s.body ? 'no' : undefined}>{plainPreview(s.body, users) || <span className="faint">{s.files.length} {s.files.length === 1 ? 'file' : 'files'}</span>}</div>}
        <div className="desk-meta">
          <span className={`chip${s.status === 'failed' ? ' bad' : ' accent'}`}><Icon name="schedule" size={12} />{s.status === 'failed' ? 'Not sent' : describeWhen(s.sendAt)}</span>
          {s.files.length > 0 && s.body && <span className="faint">+ {s.files.length} {s.files.length === 1 ? 'file' : 'files'}</span>}
          {s.error && <span className="faint">{s.error}</span>}
        </div>
      </div>
      <div className="desk-actions">
        <button className="btn ghost sm" onClick={() => void act(window.dex.request('sched.sendNow', { id: s.id }), 'Sent')}>Send now</button>
        <button className="icon-btn" title="Change time" aria-label="Change time" onClick={() => setMoving(true)}><Icon name="clock" size={16} /></button>
        <button className="icon-btn" title="Edit text" aria-label="Edit text" onClick={() => setEditing(true)}><Icon name="edit" size={16} /></button>
        <button className="icon-btn danger" title="Cancel this send" aria-label="Cancel scheduled message" onClick={() => void window.dex.request('sched.cancel', { id: s.id })
          .then(() => toast('Cancelled', false, s.sendAt > Date.now() + 60_000 ? { label: 'Undo', run: () => void window.dex.request('sched.create', { convId: s.convId, body: s.body, parentId: s.parentId ?? undefined, files: s.files.map((f) => f.id), sendAt: s.sendAt }).catch((e: Error) => toast(e.message, true)) } : undefined))
          .catch((e: Error) => toast(e.message, true))}><Icon name="trash" size={16} /></button>
      </div>
      {moving && <ScheduleDialog preview={s.body} users={users} meId={meId} onClose={() => setMoving(false)}
        onPick={(at) => act(window.dex.request('sched.update', { id: s.id, sendAt: at }), `Moved to ${describeWhen(at)}`).then(() => setMoving(false))} />}
    </div>
  );
}

// ------------------------------------------------------------------ the card when one goes off
export function ReminderCards({ users, meId, jump }: { users: Map<string, PublicUser>; meId: string; jump: Jump }) {
  const toast = useToast();
  const ringingIds = useDesk((s) => s.ringing);
  const reminders = useDesk((s) => s.reminders);
  const ringing = ringingIds.map((id) => reminders.get(id)).filter((r): r is Reminder => !!r && !r.done);
  if (!ringing.length) return null;
  const act = (r: Reminder, p: Promise<unknown>) => { dismissRinging(r.id); void p.catch((e: Error) => toast(e.message, true)); };
  return (
    <div className="reminder-cards" role="region" aria-label="Reminders">
      {ringing.slice(-3).map((r) => (
        <div key={r.id} className="reminder-card" role="alert">
          <div className="reminder-top">
            <span className="reminder-icon"><Icon name="alarm" size={18} /></span>
            <div className="desk-main">
              <span className="label">Reminder{r.createdBy !== meId ? ` from ${users.get(r.createdBy)?.displayName ?? 'a colleague'}` : ''}</span>
              <div className="desk-text" translate="no">{r.text}</div>
              {r.message && <button className="desk-quote" onClick={() => { dismissRinging(r.id); jump(r.message!.convId, r.message!.id, r.message!.parentId); }}><QuoteLine m={r.message} users={users} meId={meId} /></button>}
            </div>
            <button className="icon-btn" aria-label="Dismiss" onClick={() => dismissRinging(r.id)}><Icon name="x" size={15} /></button>
          </div>
          {r.repeat !== 'none' ? (
            <div className="reminder-actions">
              <span className="faint">{REPEAT_LABEL[r.repeat]} · next {describeWhen(r.dueAt)}</span>
              <button className="btn primary sm" onClick={() => dismissRinging(r.id)}><Icon name="check" size={14} />Dismiss</button>
            </div>
          ) : (
          <div className="reminder-actions">
            <span className="reminder-snooze label">Snooze</span>
            {snoozePresets().map((p) => <button key={p.id} className="btn sm" title={describeWhen(p.at())} onClick={() => act(r, snooze(r, p))}>{p.label}</button>)}
            <button className="btn primary sm" onClick={() => act(r, window.dex.request('remind.update', { id: r.id, done: true }))}><Icon name="check" size={14} />Done</button>
          </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ callouts: @ you, and replies in your side-tracks
function Callouts({ users, meId, jump }: { users: Map<string, PublicUser>; meId: string; jump: Jump }) {
  const [kind, setKind] = useState<'all' | 'mentions' | 'replies'>('all');
  const [items, setItems] = useState<Ops['activity.list']['res']['items'] | null>(null);
  const [more, setMore] = useState(false);
  const load = (before?: string) => void window.dex.request('activity.list', { kind, before }).then((r) => {
    setItems((cur) => (before && cur ? [...cur, ...r.items] : r.items));
    setMore(r.hasMore);
  }).catch(() => setItems([]));
  useEffect(() => { setItems(null); load(); }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="desk-group">
      <Segmented<'all' | 'mentions' | 'replies'> label="Show" value={kind} onChange={setKind} options={[
        { value: 'all', label: 'All' }, { value: 'mentions', label: '@ you' }, { value: 'replies', label: 'Side-track replies' },
      ]} />
      {items === null && <div className="tl-more"><span className="spinner" /></div>}
      {items?.length === 0 && <div className="empty desk-empty"><Icon name="at" size={36} /><span>When someone writes @ your name, or answers in a side-track you are part of, it lands here.</span></div>}
      {items?.map(({ kind: k, message: m }) => {
        const u = users.get(m.authorId);
        return (
          <div key={m.id} className="desk-row">
            <Avatar user={{ id: m.authorId, displayName: u?.displayName ?? '?' }} presence={presenceFor(m.authorId)} size="sm" />
            <button className="desk-main desk-open" onClick={() => jump(m.convId, m.id, m.parentId)}>
              <QuoteLine m={m} users={users} meId={meId} />
              <div className="desk-meta"><span className={`desk-tag mono${k === 'mention' ? ' callout' : ''}`}>{k === 'mention' ? 'CALLOUT' : 'SIDE-TRACK REPLY'}</span><span className="faint">{describeWhen(m.createdAt)}</span></div>
            </button>
          </div>
        );
      })}
      {more && <div className="tl-more"><button className="btn sm" onClick={() => load(items?.at(-1)?.message.id)}>Show older</button></div>}
    </section>
  );
}

// ------------------------------------------------------------------ side-tracks I follow
function Tracks({ users, meId, jump }: { users: Map<string, PublicUser>; meId: string; jump: Jump }) {
  const [list, setList] = useState<Ops['activity.tracks']['res'] | null>(null);
  useEffect(() => { void window.dex.request('activity.tracks').then(setList).catch(() => setList([])); }, []);
  if (list === null) return <div className="tl-more"><span className="spinner" /></div>;
  if (!list.length) return <div className="empty desk-empty"><Icon name="reply" size={36} /><span>Side-tracks you start or reply in show here, newest first.</span></div>;
  return (
    <section className="desk-group">
      {list.map(({ parent: m, lastReplyAt, replyCount }) => {
        const u = users.get(m.authorId);
        return (
          <div key={m.id} className="desk-row">
            <Avatar user={{ id: m.authorId, displayName: u?.displayName ?? '?' }} presence={presenceFor(m.authorId)} size="sm" />
            <button className="desk-main desk-open" onClick={() => jump(m.convId, m.id, m.id)}>
              <QuoteLine m={m} users={users} meId={meId} />
              <div className="desk-meta"><span className="faint">{replyCount} {replyCount === 1 ? 'reply' : 'replies'} · last {describeWhen(lastReplyAt)}</span></div>
            </button>
          </div>
        );
      })}
    </section>
  );
}
