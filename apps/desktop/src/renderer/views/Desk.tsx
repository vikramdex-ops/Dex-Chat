// The Desk lens: your reminders, saved messages and scheduled messages in one place, and the
// card that appears when a reminder goes off.
import { useRef, useState } from 'react';
import type { Message, PublicUser, Reminder, ScheduledMessage, Session } from '@dex/core';
import { Avatar, Icon, Popover, Segmented, presenceFor, useToast } from '../ui.tsx';
import { RemindDialog, ScheduleDialog } from '../chat/extras.tsx';
import { plainPreview } from '../chat/format.tsx';
import { useChat } from '../chat/store.ts';
import { convTitle } from '../chat/Switchboard.tsx';
import { REPEAT_LABEL, describeWhen, dismissRinging, toggleSaved, useDesk } from '../desk/store.ts';

type Tab = 'reminders' | 'saved' | 'scheduled';
type Jump = (convId: string, messageId?: string, parentId?: string | null) => void;

const snooze = (r: Reminder, ms: number) => window.dex.request('remind.update', { id: r.id, dueAt: Date.now() + ms });
const tomorrowMorning = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 30, 0, 0); return d.getTime() - Date.now(); };

export function Desk({ session, jump }: { session: Session; jump: Jump }) {
  const [tab, setTab] = useState<Tab>('reminders');
  const [creating, setCreating] = useState(false);
  const users = new Map(session.users.map((u) => [u.id, u] as const));
  const meId = session.me.id;
  const reminders = useDesk((s) => s.reminders);
  const saved = useDesk((s) => s.saved);
  const scheduled = useDesk((s) => s.scheduled);
  const loaded = useDesk((s) => s.loaded);
  const openMine = [...reminders.values()].filter((r) => r.userId === meId && !r.done).length;

  return (
    <div className="view desk">
      <div className="view-head">
        <div>
          <h1>Desk</h1>
          <p className="muted">Your reminders, the messages you saved, and what is scheduled to send.</p>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}><Icon name="plus" size={15} />New reminder</button>
      </div>
      <Segmented<Tab> label="Desk section" value={tab} onChange={setTab} options={[
        { value: 'reminders', label: `Reminders${openMine ? ` · ${openMine}` : ''}` },
        { value: 'saved', label: `Saved${saved.size ? ` · ${saved.size}` : ''}` },
        { value: 'scheduled', label: `Scheduled${scheduled.size ? ` · ${scheduled.size}` : ''}` },
      ]} />
      <div className="desk-body">
        {!loaded && <div className="tl-more"><span className="spinner" /></div>}
        {loaded && tab === 'reminders' && <Reminders list={[...reminders.values()]} users={users} meId={meId} jump={jump} onNew={() => setCreating(true)} />}
        {loaded && tab === 'saved' && <Saved list={[...saved.values()].sort((a, b) => b.savedAt - a.savedAt)} users={users} meId={meId} jump={jump} />}
        {loaded && tab === 'scheduled' && <Scheduled list={[...scheduled.values()].sort((a, b) => a.sendAt - b.sendAt)} users={users} meId={meId} jump={jump} />}
      </div>
      {creating && <RemindDialog users={users} meId={meId} onClose={() => setCreating(false)} />}
    </div>
  );
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
          {g.items.map((r) => <ReminderRow key={r.id} r={r} users={users} meId={meId} jump={jump} />)}
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
  const act = (p: Promise<unknown>, ok?: string) => void p.then(() => ok && toast(ok)).catch((e: Error) => toast(e.message, true));
  const overdue = !r.done && r.dueAt <= Date.now();
  const forOther = r.userId !== meId;
  const by = r.createdBy !== meId ? users.get(r.createdBy)?.displayName : null;
  return (
    <div className={`desk-row${r.done ? ' done' : ''}${overdue ? ' overdue' : ''}`}>
      <button className={`check-ring${r.done ? ' on' : ''}`} aria-label={r.done ? 'Mark as not done' : 'Mark as done'} disabled={forOther}
        onClick={() => act(window.dex.request('remind.update', { id: r.id, done: !r.done }), r.done ? undefined : 'Done')}>
        {r.done && <Icon name="check" size={13} />}
      </button>
      <div className="desk-main">
        <div className="desk-text">{r.text}</div>
        {r.message && (
          <button className="desk-quote" onClick={() => jump(r.message!.convId, r.message!.id, r.message!.parentId)}>
            <QuoteLine m={r.message} users={users} meId={meId} />
          </button>
        )}
        <div className="desk-meta">
          <span className={`chip${overdue ? ' warn' : ''}`}><Icon name="alarm" size={12} />{describeWhen(r.dueAt)}</span>
          {r.repeat !== 'none' && <span className="chip"><Icon name="repeat" size={12} />{REPEAT_LABEL[r.repeat]}</span>}
          {forOther && <span className="faint">for {users.get(r.userId)?.displayName ?? 'someone'}</span>}
          {by && <span className="faint">from {by}</span>}
        </div>
      </div>
      {!r.done && (
        <div className="desk-actions">
          {!forOther && <button className="btn ghost sm" onClick={() => act(snooze(r, 3600_000), 'Snoozed for an hour')}>Snooze</button>}
          <button ref={menuBtn} className="icon-btn" aria-label="More" onClick={() => setMenu(!menu)}><Icon name="more" size={16} /></button>
          {menu && (
            <Popover anchor={menuBtn.current} onClose={() => setMenu(false)} className="menu desk-menu">
              {!forOther && <>
                <button role="menuitem" onClick={() => { setMenu(false); act(snooze(r, 20 * 60_000), 'Snoozed for 20 minutes'); }}><Icon name="clock" size={16} />In 20 minutes</button>
                <button role="menuitem" onClick={() => { setMenu(false); act(snooze(r, 3 * 3600_000), 'Snoozed for 3 hours'); }}><Icon name="clock" size={16} />In 3 hours</button>
                <button role="menuitem" onClick={() => { setMenu(false); act(snooze(r, tomorrowMorning()), 'Moved to tomorrow'); }}><Icon name="sun" size={16} />Tomorrow morning</button>
                <div className="menu-sep" />
              </>}
              <button role="menuitem" className="danger" onClick={() => { setMenu(false); act(window.dex.request('remind.delete', { id: r.id }), 'Reminder deleted'); }}><Icon name="trash" size={16} />Delete</button>
            </Popover>
          )}
        </div>
      )}
      {r.done && <button className="icon-btn" aria-label="Delete" onClick={() => act(window.dex.request('remind.delete', { id: r.id }))}><Icon name="trash" size={15} /></button>}
    </div>
  );
}

function QuoteLine({ m, users, meId }: { m: Message; users: Map<string, PublicUser>; meId: string }) {
  const conv = useChat((s) => s.conversations.get(m.convId));
  const who = m.authorId === meId ? 'You' : users.get(m.authorId)?.displayName ?? 'Someone';
  const where = conv ? convTitle(conv, users, meId) : '';
  const text = m.poll ? `📊 ${m.poll.question}` : plainPreview(m.body, users) || (m.files.length ? `📎 ${m.files.length === 1 ? m.files[0].name : `${m.files.length} files`}` : '');
  return <><span><b>{who}</b>{where && <span className="faint"> in {where}</span>}</span><span className="desk-quote-text">{text}</span></>;
}

// ------------------------------------------------------------------ saved
function Saved({ list, users, meId, jump }: { list: Array<{ message: Message; savedAt: number }>; users: Map<string, PublicUser>; meId: string; jump: Jump }) {
  const toast = useToast();
  if (!list.length) {
    return <div className="empty desk-empty"><Icon name="star" size={36} /><span>Save messages with <Icon name="star" size={13} /> to keep them here, for you only.</span></div>;
  }
  return (
    <section className="desk-group">
      {list.map(({ message: m, savedAt }) => {
        const u = users.get(m.authorId);
        return (
          <div key={m.id} className="desk-row saved">
            <Avatar user={{ id: m.authorId, displayName: u?.displayName ?? '?' }} presence={presenceFor(m.authorId)} size="sm" />
            <button className="desk-main desk-open" onClick={() => jump(m.convId, m.id, m.parentId)}>
              <QuoteLine m={m} users={users} meId={meId} />
              <div className="desk-meta"><span className="faint">{describeWhen(m.createdAt)} · saved {describeWhen(savedAt)}</span></div>
            </button>
            <button className="icon-btn on" aria-label="Remove from saved" title="Remove from saved"
              onClick={() => void toggleSaved(m).then(() => toast('Removed from your Desk')).catch((e: Error) => toast(e.message, true))}><Icon name="star" size={16} /></button>
          </div>
        );
      })}
    </section>
  );
}

// ------------------------------------------------------------------ scheduled
function Scheduled({ list, users, meId, jump }: { list: ScheduledMessage[]; users: Map<string, PublicUser>; meId: string; jump: Jump }) {
  if (!list.length) {
    return <div className="empty desk-empty"><Icon name="schedule" size={36} /><span>Nothing scheduled. Write a message and choose <Icon name="schedule" size={13} /> beside Send to send it later.</span></div>;
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
        ) : <div className="desk-text">{plainPreview(s.body, users) || <span className="faint">{s.files.length} {s.files.length === 1 ? 'file' : 'files'}</span>}</div>}
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
        <button className="icon-btn danger" title="Cancel" aria-label="Cancel scheduled message" onClick={() => void act(window.dex.request('sched.cancel', { id: s.id }), 'Cancelled')}><Icon name="trash" size={16} /></button>
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
              <div className="desk-text">{r.text}</div>
              {r.message && <button className="desk-quote" onClick={() => { dismissRinging(r.id); jump(r.message!.convId, r.message!.id, r.message!.parentId); }}><QuoteLine m={r.message} users={users} meId={meId} /></button>}
            </div>
            <button className="icon-btn" aria-label="Dismiss" onClick={() => dismissRinging(r.id)}><Icon name="x" size={15} /></button>
          </div>
          {r.repeat !== 'none' ? (
            <div className="reminder-actions">
              <span className="faint">{REPEAT_LABEL[r.repeat]} · next {describeWhen(r.dueAt)}</span>
              <button className="btn primary sm" onClick={() => dismissRinging(r.id)}><Icon name="check" size={14} />OK</button>
            </div>
          ) : (
          <div className="reminder-actions">
            <button className="btn sm" onClick={() => act(r, snooze(r, 10 * 60_000))}>10 min</button>
            <button className="btn sm" onClick={() => act(r, snooze(r, 3600_000))}>1 hour</button>
            <button className="btn sm" onClick={() => act(r, snooze(r, tomorrowMorning()))}>Tomorrow</button>
            <button className="btn primary sm" onClick={() => act(r, window.dex.request('remind.update', { id: r.id, done: true }))}><Icon name="check" size={14} />Done</button>
          </div>
          )}
        </div>
      ))}
    </div>
  );
}
