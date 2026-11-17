// The leave note, as one short sheet in Nib's tray (docs/NIB.md §6): when, what kind, who covers,
// who to tell and what happens to your Desk reminders, then a plain list of exactly what Nib will
// do. "Do it" does all of it at once.
import { useEffect, useMemo, useState } from 'react';
import type { NibLeaveKind, NibLeavePlan, PublicUser, Session } from '@dex/core';
import { addDays } from '@dex/core/nib';
import { Avatar, Icon, useToast } from '../ui.tsx';
import { PersonPick } from './parts.tsx';
import { nibLeave, refreshNib, setView, useNib } from './store.ts';
import { LEAVE_WORD, dayLabel, firstName } from './words.ts';
import { formatTime } from '../time.ts';

type When = 'today' | 'tomorrow' | 'dates' | 'half';

export default function LeaveView({ session, users, from: seedFrom }: { session: Session; users: Map<string, PublicUser>; from?: string }) {
  const me = useNib((s) => s.me)!;
  const toast = useToast();
  const today = me.date;
  const [when, setWhen] = useState<When>(seedFrom && seedFrom !== today ? (seedFrom === addDays(today, 1) ? 'tomorrow' : 'dates') : 'today');
  const [from, setFrom] = useState(seedFrom ?? today);
  const [to, setTo] = useState(seedFrom ?? today);
  const [half, setHalf] = useState<'am' | 'pm'>('pm');
  const [kind, setKind] = useState<NibLeaveKind>('annual');
  const [cover, setCover] = useState<string | null>(null);
  const [handover, setHandover] = useState('');
  const [note, setNote] = useState('');
  const [plan, setPlan] = useState<NibLeavePlan | null>(null);
  const [leads, setLeads] = useState<string[]>([]);
  const [spaces, setSpaces] = useState<string[]>([]);
  const [reminders, setReminders] = useState<'move' | 'cover' | 'keep'>('move');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string[] | null>(null);
  const span = when === 'today' ? { from: today, to: today } : when === 'tomorrow' ? { from: addDays(today, 1), to: addDays(today, 1) } : when === 'half' ? { from, to: from } : { from, to: to < from ? from : to };
  useEffect(() => {
    let alive = true;
    void window.dex.request('nib.leave.plan', span).then((p) => {
      if (!alive) return;
      setPlan(p);
      setLeads((cur) => (cur.length ? cur : p.leads));
    }).catch(() => {});
    return () => { alive = false; };
  }, [span.from, span.to]); // eslint-disable-line react-hooks/exhaustive-deps
  const all = useMemo(() => [...users.values()], [users]);
  const name = (id: string) => users.get(id)?.displayName ?? '';
  const existing = me.leave;

  if (existing && !done) {
    return (
      <div className="nib-leave">
        <p className="nib-line">{existing.from === existing.to ? `You have leave noted for ${dayLabel(existing.from)}.` : `You have leave noted from ${dayLabel(existing.from)} to ${dayLabel(existing.to)}.`}</p>
        <div className="nib-callout-actions">
          <button className="btn danger" disabled={busy} onClick={() => { setBusy(true); void window.dex.request('nib.leave.cancel', { id: existing.id }).then(() => refreshNib()).then(() => toast('Leave cancelled. Your status and calendar are back.')).catch((e: Error) => toast(e.message, true)).finally(() => setBusy(false)); }}>Cancel this leave</button>
          <button className="btn ghost" onClick={() => setView({ v: 'home' })}>Keep it</button>
        </div>
      </div>
    );
  }
  if (done) {
    const words: Record<string, string> = { away: 'You are shown as away, with your cover as the contact.', 'away-later': 'You will be shown as away from the first day.', calendar: 'Your calendar is blocked.', cover: `${firstName(name(cover ?? ''))} has the handover.` };
    return (
      <div className="nib-leave">
        <p className="nib-line">Done. Enjoy the time off. I’ll keep your desk.</p>
        <ul className="nib-did">
          {done.map((d) => {
            const [k, n] = d.split(':');
            const text = words[k] ?? (k === 'leads' ? (n === '1' ? 'Your lead is told.' : `${n} leads are told.`) : k === 'spaces' ? (n === '1' ? 'One Space is told.' : `${n} Spaces are told.`) : k === 'reminders' ? (n === '1' ? 'One reminder is moved.' : `${n} reminders are moved.`) : d);
            return <li key={d}><Icon name="check" size={14} /><span>{text}</span></li>;
          })}
          <li><Icon name="check" size={14} /><span>Anyone who writes to you hears you are away.</span></li>
          <li><Icon name="check" size={14} /><span>No day-sheet asks while you are away.</span></li>
        </ul>
        <button className="btn primary" onClick={() => setView({ v: 'home' })}>Back to Nib</button>
      </div>
    );
  }

  const go = () => {
    setBusy(true);
    void nibLeave({ kind: when === 'half' ? 'half' : kind, from: span.from, to: span.to, half: when === 'half' ? half : null, coverId: cover, note: note || null, handover: handover || null, leadIds: leads, spaceIds: spaces, reminders })
      .then((r) => setDone(r.done)).catch((e: Error) => toast(e.message, true)).finally(() => setBusy(false));
  };
  const back = addDays(span.to, 1);
  const count = plan?.reminders.length ?? 0;
  return (
    <div className="nib-leave">
      <p className="nib-line">Tell me when, and I’ll sort the rest.</p>
      <div className="nib-q">
        <span className="label">When</span>
        <div className="seg" role="group" aria-label="When">
          {([['today', 'Today'], ['tomorrow', 'Tomorrow'], ['dates', 'Pick dates'], ['half', 'Half day']] as Array<[When, string]>).map(([v, l]) => <button key={v} type="button" aria-pressed={when === v} onClick={() => setWhen(v)}>{l}</button>)}
        </div>
        {when === 'dates' && (
          <div className="nib-edit-grid">
            <label className="field"><span>First day</span><input type="date" className="input" min={today} value={from} onChange={(e) => { setFrom(e.target.value); if (to < e.target.value) setTo(e.target.value); }} /></label>
            <label className="field"><span>Last day</span><input type="date" className="input" min={from} value={to} onChange={(e) => setTo(e.target.value)} /></label>
          </div>
        )}
        {when === 'half' && (
          <div className="nib-edit-grid">
            <label className="field"><span>Day</span><input type="date" className="input" min={today} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <div className="seg" role="group" aria-label="Which half">
              <button type="button" aria-pressed={half === 'am'} onClick={() => setHalf('am')}>Morning</button>
              <button type="button" aria-pressed={half === 'pm'} onClick={() => setHalf('pm')}>Afternoon</button>
            </div>
          </div>
        )}
      </div>
      {when !== 'half' && (
        <div className="nib-q">
          <span className="label">Kind</span>
          <div className="seg" role="group" aria-label="Kind of leave">
            {(['annual', 'sick', 'comp'] as NibLeaveKind[]).map((k) => <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>{LEAVE_WORD[k]}</button>)}
          </div>
        </div>
      )}
      <div className="nib-q">
        <span className="label">Who covers</span>
        {cover ? (
          <div className="nib-pick"><button type="button" className="nib-giver on" aria-pressed onClick={() => setCover(null)} title="Choose someone else"><Avatar user={users.get(cover)!} size="sm" /><span className="nib-giver-name" translate="no">{name(cover)}</span><Icon name="x" size={12} /></button></div>
        ) : <PersonPick users={all} exclude={[session.me.id]} onPick={(u) => { setCover(u.id); setLeads((l) => l.filter((x) => x !== u.id)); }} placeholder="Type a name" label="Who covers your work" />}
        {cover && <textarea className="input" rows={2} maxLength={1200} value={handover} placeholder="Handover: Area 4 routing, sheets 4–10 left; vendor data due Friday" aria-label="Handover note" onChange={(e) => setHandover(e.target.value)} />}
      </div>
      <div className="nib-q">
        <span className="label">Who to tell</span>
        <div className="nib-pick">
          {[...new Set([...(plan?.leads ?? []), ...leads])].filter((id) => id !== cover && users.has(id)).map((id) => {
            const on = leads.includes(id);
            return <button key={id} type="button" className={`nib-giver${on ? ' on' : ''}`} aria-pressed={on} onClick={() => setLeads(on ? leads.filter((x) => x !== id) : [...leads, id])}><Avatar user={users.get(id)!} size="sm" /><span className="nib-giver-name" translate="no">{firstName(name(id))}</span></button>;
          })}
        </div>
        <PersonPick users={all} exclude={[session.me.id, ...leads, ...(cover ? [cover] : [])]} onPick={(u) => setLeads([...leads, u.id])} placeholder="Someone else to tell" label="Someone else to tell" />
        {(plan?.spaces.length ?? 0) > 0 && (
          <div className="nib-spaces" role="group" aria-label="Spaces you are most active in">
            {plan!.spaces.map((s) => {
              const on = spaces.includes(s.id);
              return <button key={s.id} type="button" className={`when-chip${on ? ' on' : ''}`} aria-pressed={on} onClick={() => setSpaces(on ? spaces.filter((x) => x !== s.id) : [...spaces, s.id])}><Icon name="grid" size={12} /><span translate="no">{s.name}</span></button>;
            })}
          </div>
        )}
        <input className="input" maxLength={300} value={note} placeholder="A note for people who write to you (optional)" aria-label="A note for people who write to you" onChange={(e) => setNote(e.target.value)} />
      </div>
      {count > 0 && (
        <div className="nib-q">
          <span className="label">{count === 1 ? 'One Desk reminder falls in those days' : `${count} Desk reminders fall in those days`}</span>
          <div className="seg" role="group" aria-label="Desk reminders">
            <button type="button" aria-pressed={reminders === 'move'} onClick={() => setReminders('move')}>Move to the day I’m back</button>
            <button type="button" aria-pressed={reminders === 'cover'} disabled={!cover} onClick={() => setReminders('cover')}>Hand to my cover</button>
            <button type="button" aria-pressed={reminders === 'keep'} onClick={() => setReminders('keep')}>Leave them</button>
          </div>
          <ul className="nib-fine-list">{plan!.reminders.slice(0, 3).map((r) => <li key={r.id} translate="no">{`${r.text} · ${formatTime(r.dueAt)}`}</li>)}</ul>
        </div>
      )}
      <div className="nib-will" aria-label="What Nib will do">
        <span className="label">What I’ll do</span>
        <ul>
          <li>{when === 'half' ? `Show you away for the ${half === 'am' ? 'morning' : 'afternoon'} of ${dayLabel(span.from)}.` : span.from === span.to ? `Show you away on ${dayLabel(span.from)}, back ${dayLabel(back)}.` : `Show you away ${dayLabel(span.from)} to ${dayLabel(span.to)}, back ${dayLabel(back)}.`}</li>
          <li>Block your calendar for those days.</li>
          {leads.length > 0 && <li>{leads.length === 1 ? `Tell ${firstName(name(leads[0]))}.` : `Tell ${leads.slice(0, -1).map((x) => firstName(name(x))).join(', ')} and ${firstName(name(leads[leads.length - 1]))}.`}</li>}
          {cover && <li>{`Give ${firstName(name(cover))} the handover and your open items.`}</li>}
          <li>{cover ? `Answer anyone who writes to you, naming ${firstName(name(cover))}.` : 'Answer anyone who writes to you.'}</li>
          {count > 0 && reminders !== 'keep' && <li>{reminders === 'move' ? 'Move your Desk reminders to the day you’re back.' : 'Hand your Desk reminders to your cover.'}</li>}
          <li>Keep the management informed in one line, not a message.</li>
        </ul>
      </div>
      <div className="nib-callout-actions">
        <button className="btn primary" disabled={busy} onClick={go}>Do it</button>
        <button className="btn ghost" onClick={() => setView({ v: 'home' })}>Not now</button>
      </div>
    </div>
  );
}
