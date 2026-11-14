// The Calendar lens: a week on a drafting grid (or an agenda list), meetings you can open,
// answer and join, and the dialog to plan one with people, a conference room and a call.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CalEvent, Conversation, Occurrence, PublicUser, Recurrence, Rsvp, Session } from '@dex/core';
import { Avatar, Dialog, Icon, Segmented, ToggleRow, presenceFor, useToast } from '../ui.tsx';
import { useChat } from '../chat/store.ts';
import { convTitle } from '../chat/Switchboard.tsx';
import { renderBody } from '../chat/format.tsx';
import { toLocalInput } from '../desk/store.ts';
import { DAY, addDays, describeSpan, dismissSoon, hm, joinMeeting, startOfDay, startOfWeek, useCal } from './store.ts';
import { timeOpts } from '../time.ts';

const HOUR_PX = 48;
const H = 3600_000;
type Mode = 'week' | 'agenda';
type Open = (convId: string) => void;

function useRange(from: number, to: number): Occurrence[] | null {
  const version = useCal((s) => s.version);
  const [list, setList] = useState<Occurrence[] | null>(null);
  useEffect(() => {
    let alive = true;
    window.dex.request('cal.list', { from, to }).then((l) => { if (alive) setList(l); }).catch(() => { if (alive) setList((x) => x ?? []); });
    return () => { alive = false; };
  }, [from, to, version]);
  return list;
}

const myResponse = (ev: CalEvent, meId: string): Rsvp | null => ev.attendees.find((a) => a.userId === meId)?.response ?? null;

export function CalendarView({ session, openConv }: { session: Session; openConv: Open }) {
  const [mode, setMode] = useState<Mode>(() => (window.matchMedia('(max-width: 720px)').matches ? 'agenda' : 'week'));
  const [anchor, setAnchor] = useState(() => startOfWeek(Date.now()));
  const [editing, setEditing] = useState<{ ev?: CalEvent; startAt?: number; allDay?: boolean } | null>(null);
  const [viewing, setViewing] = useState<Occurrence | null>(null);
  const users = useMemo(() => new Map(session.users.map((u) => [u.id, u] as const)), [session.users]);
  const from = mode === 'week' ? anchor : startOfDay(Date.now());
  const to = mode === 'week' ? addDays(anchor, 7) : addDays(from, 60);
  const list = useRange(from, to);
  const meId = session.me.id;
  const canCreate = session.me.role !== 'guest';
  const label = mode === 'week'
    ? `${new Date(anchor).toLocaleDateString([], { day: 'numeric', month: 'short' })} – ${new Date(addDays(anchor, 6)).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}`
    : 'Next 60 days';

  return (
    <div className="view calendar">
      <div className="view-head">
        <div>
          <h1>Calendar</h1>
          <p className="label">{label}</p>
        </div>
        <div className="row-actions">
          {mode === 'week' && (
            <div className="cal-nav">
              <button className="icon-btn" aria-label="Previous week" onClick={() => setAnchor(addDays(anchor, -7))}><Icon name="back" size={16} /></button>
              <button className="btn ghost sm" onClick={() => setAnchor(startOfWeek(Date.now()))}>Today</button>
              <button className="icon-btn flip" aria-label="Next week" onClick={() => setAnchor(addDays(anchor, 7))}><Icon name="back" size={16} /></button>
            </div>
          )}
          <Segmented<Mode> label="Calendar view" value={mode} onChange={setMode} options={[{ value: 'week', label: 'Week', icon: 'calendar' }, { value: 'agenda', label: 'Agenda', icon: 'list' }]} />
          {canCreate && <button className="btn primary" onClick={() => setEditing({})}><Icon name="plus" size={15} />New meeting</button>}
        </div>
      </div>
      {mode === 'week'
        ? <Week from={anchor} list={list ?? []} meId={meId} onSlot={(t, allDay) => canCreate && setEditing({ startAt: t, allDay })} onOpen={setViewing} />
        : <Agenda list={list} meId={meId} users={users} onOpen={setViewing} />}
      {viewing && <EventDetails occ={viewing} session={session} users={users} onClose={() => setViewing(null)} onEdit={(ev) => { setViewing(null); setEditing({ ev }); }} openConv={openConv} />}
      {editing && <EventDialog session={session} ev={editing.ev} startAt={editing.startAt} allDay={editing.allDay} onClose={() => setEditing(null)} />}
    </div>
  );
}

// ------------------------------------------------------------------ week grid
function layoutDay(items: Occurrence[]): Array<{ o: Occurrence; col: number; cols: number }> {
  const sorted = [...items].sort((a, b) => a.startAt - b.startAt || b.endAt - a.endAt);
  const out: Array<{ o: Occurrence; col: number; cols: number }> = [];
  let cluster: typeof out = [];
  let clusterEnd = 0;
  const flush = () => { const cols = Math.max(1, ...cluster.map((c) => c.col + 1)); for (const c of cluster) c.cols = cols; out.push(...cluster); cluster = []; };
  for (const o of sorted) {
    if (cluster.length && o.startAt >= clusterEnd) flush();
    const used = new Set(cluster.filter((c) => c.o.endAt > o.startAt).map((c) => c.col));
    let col = 0;
    while (used.has(col)) col++;
    cluster.push({ o, col, cols: 1 });
    clusterEnd = Math.max(clusterEnd, o.endAt);
  }
  flush();
  return out;
}

function Week({ from, list, meId, onSlot, onOpen }: { from: number; list: Occurrence[]; meId: string; onSlot: (t: number, allDay?: boolean) => void; onOpen: (o: Occurrence) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);
  useLayoutEffect(() => { if (scroller.current) scroller.current.scrollTop = HOUR_PX * 8 - 8; }, []);
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  const allDay = list.filter((o) => o.event.allDay || o.endAt - o.startAt >= DAY);
  const timed = list.filter((o) => !allDay.includes(o));
  return (
    <div className="week">
      <div className="week-head">
        <span />
        {days.map((d) => {
          const today = startOfDay(now) === d;
          const dt = new Date(d);
          return <span key={d} className={`week-day${today ? ' today' : ''}`}><b>{dt.toLocaleDateString([], { weekday: 'short' })}</b><i>{dt.getDate()}</i></span>;
        })}
      </div>
      <div className="week-allday">
        <span className="label">All day</span>
        {days.map((d) => (
          <div key={d} className="week-allday-cell" onDoubleClick={() => onSlot(d, true)}>
            {allDay.filter((o) => o.startAt < addDays(d, 1) && o.endAt > d).map((o) => (
              <button key={`${o.event.id}-${o.startAt}`} className={`cal-chip r-${myResponse(o.event, meId) ?? 'none'}`} onClick={() => onOpen(o)}>{o.event.title}</button>
            ))}
          </div>
        ))}
      </div>
      <div className="week-body" ref={scroller}>
        <div className="week-hours">{Array.from({ length: 24 }, (_, h) => <span key={h} style={{ top: h * HOUR_PX }}>{h === 0 ? '' : new Date(2000, 0, 1, h).toLocaleTimeString([], { ...timeOpts(), hour: 'numeric' })}</span>)}</div>
        {days.map((d) => {
          const items = layoutDay(timed.filter((o) => o.startAt < addDays(d, 1) && o.endAt > d));
          return (
            <div key={d} className="week-col" style={{ height: 24 * HOUR_PX }}
              onClick={(e) => {
                if (e.target !== e.currentTarget) return;
                const y = e.nativeEvent.offsetY;
                onSlot(d + Math.floor((y / HOUR_PX) * 2) * 30 * 60_000);
              }}>
              {items.map(({ o, col, cols }) => {
                const top = Math.max(0, (o.startAt - d) / H) * HOUR_PX;
                const bottom = Math.min(24, (o.endAt - d) / H) * HOUR_PX;
                const r = myResponse(o.event, meId);
                return (
                  <button key={`${o.event.id}-${o.startAt}`} className={`cal-block r-${r ?? 'none'}${o.endAt < now ? ' past' : ''}`} onClick={() => onOpen(o)}
                    style={{ top, height: Math.max(20, bottom - top - 2), left: `calc(${(col / cols) * 100}% + 2px)`, width: `calc(${100 / cols}% - 4px)` }}
                    title={`${o.event.title}\n${hm(o.startAt)} – ${hm(o.endAt)}`}>
                    <b>{o.event.title}</b>
                    {bottom - top > 34 && <span>{hm(o.startAt)} – {hm(o.endAt)}{o.event.online ? ' · call' : ''}</span>}
                  </button>
                );
              })}
              {startOfDay(now) === d && <div className="now-line" style={{ top: ((now - d) / H) * HOUR_PX }} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ agenda
function Agenda({ list, meId, users, onOpen }: { list: Occurrence[] | null; meId: string; users: Map<string, PublicUser>; onOpen: (o: Occurrence) => void }) {
  if (!list) return <div className="tl-more"><span className="spinner" /></div>;
  if (!list.length) return <div className="empty"><Icon name="calendar" size={36} /><span>Nothing in the next 60 days.</span></div>;
  const groups = new Map<number, Occurrence[]>();
  for (const o of list) { const k = startOfDay(Math.max(o.startAt, startOfDay(Date.now()))); groups.set(k, [...(groups.get(k) ?? []), o]); }
  return (
    <div className="agenda">
      {[...groups].map(([day, items]) => (
        <section key={day} className="agenda-day">
          <h3 className="label">{new Date(day).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</h3>
          {items.map((o) => {
            const r = myResponse(o.event, meId);
            const org = users.get(o.event.organizerId);
            return (
              <button key={`${o.event.id}-${o.startAt}`} className={`agenda-row r-${r ?? 'none'}`} onClick={() => onOpen(o)}>
                <span className="agenda-time mono">{o.event.allDay ? 'All day' : `${hm(o.startAt)}`}<i>{o.event.allDay ? '' : hm(o.endAt)}</i></span>
                <span className="agenda-main">
                  <b>{o.event.title}</b>
                  <span className="faint">{[org && `by ${o.event.organizerId === meId ? 'you' : org.displayName}`, o.event.online && 'call', `${o.event.attendees.length} invited`].filter(Boolean).join(' · ')}</span>
                </span>
                {r === 'pending' && <span className="chip warn">Reply</span>}
                {r === 'maybe' && <span className="chip">Maybe</span>}
              </button>
            );
          })}
        </section>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ details
const RSVP_LABEL: Record<Rsvp, string> = { yes: 'Going', no: 'Not going', maybe: 'Maybe', pending: 'No reply yet' };

export function EventDetails({ occ, session, users, onClose, onEdit, openConv }: {
  occ: Occurrence; session: Session; users: Map<string, PublicUser>; onClose: () => void; onEdit: (ev: CalEvent) => void; openConv: Open;
}) {
  const toast = useToast();
  const venues = useCal((s) => s.venues);
  const conv = useChat((s) => (occ.event.convId ? s.conversations.get(occ.event.convId) : undefined));
  const [ev, setEv] = useState(occ.event);
  const version = useCal((s) => s.version);
  useEffect(() => { void window.dex.request('cal.get', { eventId: occ.event.id }).then(setEv).catch(() => {}); }, [occ.event.id, version]);
  const meId = session.me.id;
  const mine = myResponse(ev, meId);
  const isOrganiser = ev.organizerId === meId || session.me.role === 'owner' || session.me.role === 'admin';
  const venue = ev.venueId ? venues.find((v) => v.id === ev.venueId) : undefined;
  const live = Date.now() > occ.startAt - 15 * 60_000 && Date.now() < occ.endAt;
  const respond = (response: Exclude<Rsvp, 'pending'>) => void window.dex.request('cal.respond', { eventId: ev.id, response }).then(setEv).catch((e: Error) => toast(e.message, true));
  const counts = { yes: 0, no: 0, maybe: 0, pending: 0 } as Record<Rsvp, number>;
  for (const a of ev.attendees) counts[a.response]++;
  return (
    <Dialog title={ev.title} onClose={onClose}>
      {ev.cancelled && <div className="error-box">This meeting was cancelled.</div>}
      <div className="ev-facts">
        <div><Icon name="clock" size={16} /><span>{describeSpan(occ.startAt, occ.endAt, ev.allDay)}{ev.recurrence !== 'none' && <span className="faint"> · repeats {ev.recurrence === 'weekdays' ? 'every weekday' : ev.recurrence}</span>}</span></div>
        {(venue || ev.location) && <div><Icon name="home" size={16} /><span>{venue ? `${venue.name}${venue.capacity ? ` · seats ${venue.capacity}` : ''}` : ev.location}</span></div>}
        {ev.online && <div><Icon name="video" size={16} /><span>Call in Dexterity Connect</span></div>}
        {conv && <div><Icon name={conv.kind === 'space' ? 'grid' : 'chat'} size={16} /><button className="link" onClick={() => { onClose(); openConv(conv.id); }}>{convTitle(conv, users, meId)}</button></div>}
        <div><Icon name="user" size={16} /><span>Organised by {ev.organizerId === meId ? 'you' : users.get(ev.organizerId)?.displayName ?? 'a former member'}</span></div>
      </div>
      {ev.description && <div className="quote selectable">{renderBody(ev.description, users, meId)}</div>}
      <div className="ev-people">
        <div className="label">{ev.attendees.length} invited · {counts.yes} going{counts.maybe ? ` · ${counts.maybe} maybe` : ''}{counts.no ? ` · ${counts.no} not going` : ''}</div>
        <div className="ev-people-list">
          {ev.attendees.map((a) => {
            const u = users.get(a.userId);
            return u ? <span key={a.userId} className={`ev-person r-${a.response}`} title={`${u.displayName}: ${RSVP_LABEL[a.response]}`}><Avatar user={u} presence={presenceFor(u.id)} size="sm" /><span>{u.id === meId ? 'You' : u.displayName.split(' ')[0]}</span></span> : null;
          })}
        </div>
      </div>
      {!ev.cancelled && (
        <div className="dialog-actions ev-actions">
          {ev.organizerId !== meId ? (
            <div className="seg" role="group" aria-label="Your reply">
              {(['yes', 'maybe', 'no'] as const).map((r) => <button key={r} type="button" aria-pressed={mine === r} onClick={() => respond(r)}>{RSVP_LABEL[r]}</button>)}
            </div>
          ) : <span />}
          {isOrganiser && <button className="btn ghost" onClick={() => onEdit(ev)}><Icon name="edit" size={15} />Edit</button>}
          {isOrganiser && <button className="btn ghost danger" onClick={() => { if (confirm(`Cancel "${ev.title}" for everyone${ev.recurrence !== 'none' ? ', including every repeat' : ''}?`)) void window.dex.request('cal.cancel', { eventId: ev.id }).then(() => { toast('Meeting cancelled'); onClose(); }).catch((e: Error) => toast(e.message, true)); }}>Cancel meeting</button>}
          {ev.online && <button className={`btn${live ? ' primary' : ''}`} onClick={() => void joinMeeting(ev).then(onClose).catch((e: Error) => toast(e.message, true))}><Icon name="video" size={15} />Join call</button>}
        </div>
      )}
    </Dialog>
  );
}

// ------------------------------------------------------------------ create / edit
const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];
const REMINDERS: Array<[number | null, string]> = [[null, 'No reminder'], [0, 'At the start'], [5, '5 minutes before'], [10, '10 minutes before'], [15, '15 minutes before'], [30, '30 minutes before'], [60, '1 hour before'], [1440, '1 day before']];

export function EventDialog({ session, ev, startAt, allDay: initialAllDay, conv, onClose }: {
  session: Session; ev?: CalEvent; startAt?: number; allDay?: boolean; conv?: Conversation; onClose: () => void;
}) {
  const toast = useToast();
  const venues = useCal((s) => s.venues);
  const conversations = useChat((s) => s.conversations);
  const meId = session.me.id;
  const users = useMemo(() => new Map(session.users.map((u) => [u.id, u] as const)), [session.users]);
  const defaultStart = startAt ?? (() => { const d = new Date(Date.now() + H); d.setMinutes(0, 0, 0); return d.getTime(); })();
  const [title, setTitle] = useState(ev?.title ?? '');
  const [start, setStart] = useState(ev?.startAt ?? defaultStart);
  const [minutes, setMinutes] = useState(ev ? Math.round((ev.endAt - ev.startAt) / 60_000) : 60);
  const [allDay, setAllDay] = useState(ev?.allDay ?? initialAllDay ?? false);
  const [recurrence, setRecurrence] = useState<Recurrence>(ev?.recurrence ?? 'none');
  const [until, setUntil] = useState<string>(ev?.until ? new Date(ev.until).toISOString().slice(0, 10) : '');
  const [convId, setConvId] = useState<string>(ev?.convId ?? conv?.id ?? '');
  const [people, setPeople] = useState<string[]>(ev ? ev.attendees.map((a) => a.userId).filter((u) => u !== meId) : (conv ? conv.members.filter((u) => u !== meId) : []));
  const [venueId, setVenueId] = useState(ev?.venueId ?? '');
  const [location, setLocation] = useState(ev?.location ?? '');
  const [online, setOnline] = useState(ev?.online ?? true);
  const [reminder, setReminder] = useState<number | null>(ev ? ev.reminderMin : 10);
  const [description, setDescription] = useState(ev?.description ?? '');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<Array<{ id: string; startAt: number; endAt: number }>>([]);
  const [saving, setSaving] = useState(false);
  const end = allDay ? addDays(startOfDay(start), Math.max(1, Math.round(minutes / 1440))) : start + minutes * 60_000;

  // free/busy for the people and room chosen, on the meeting's day
  useEffect(() => {
    const t = setTimeout(() => {
      const ids = [meId, ...people];
      void window.dex.request('cal.busy', { userIds: ids, venueId: venueId || undefined, from: startOfDay(start), to: addDays(startOfDay(start), 1) })
        .then((b) => setBusy(b.filter((x) => !ev || !(x.startAt === ev.startAt && x.endAt === ev.endAt)))).catch(() => setBusy([]));
    }, 250);
    return () => clearTimeout(t);
  }, [people, venueId, start, meId, ev]);
  const clashes = busy.filter((b) => b.startAt < end && start < b.endAt);
  const clashNames = [...new Set(clashes.map((c) => (c.id.startsWith('venue:') ? venues.find((v) => `venue:${v.id}` === c.id)?.name : c.id === meId ? 'You' : users.get(c.id)?.displayName.split(' ')[0])).filter(Boolean))];

  const candidates = session.users.filter((u) => u.role !== 'bot' && u.id !== meId && !people.includes(u.id) && (!q || u.displayName.toLowerCase().includes(q.toLowerCase()))).slice(0, 6);
  const save = async () => {
    setSaving(true);
    const body = {
      title, startAt: allDay ? startOfDay(start) : start, endAt: end, allDay, attendees: people, convId: convId || null, online, recurrence,
      until: recurrence !== 'none' && until ? new Date(`${until}T23:59:59`).getTime() : null, reminderMin: reminder,
      venueId: venueId || null, location: venueId ? null : location || null, description: description || null,
    };
    try {
      if (ev) await window.dex.request('cal.update', { eventId: ev.id, ...body });
      else await window.dex.request('cal.create', body);
      toast(ev ? 'Meeting updated' : people.length ? `Invitations sent to ${people.length} ${people.length === 1 ? 'person' : 'people'}` : 'Added to your calendar');
      onClose();
    } catch (e) { toast((e as Error).message, true); setSaving(false); }
  };

  return (
    <Dialog title={ev ? 'Edit meeting' : 'New meeting'} onClose={onClose}>
      <div className="field">
        <label htmlFor="ev-title">Title</label>
        <input id="ev-title" className="input" autoFocus maxLength={140} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Design review: P-12 isometrics" />
      </div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="ev-start">{allDay ? 'Day' : 'Starts'}</label>
          {allDay
            ? <input id="ev-start" className="input" type="date" value={toLocalInput(start).slice(0, 10)} onChange={(e) => { const t = new Date(`${e.target.value}T00:00:00`).getTime(); if (Number.isFinite(t)) setStart(t); }} />
            : <input id="ev-start" className="input" type="datetime-local" step={300} value={toLocalInput(start)} onChange={(e) => { const t = new Date(e.target.value).getTime(); if (Number.isFinite(t)) setStart(t); }} />}
        </div>
        <div className="field">
          <label htmlFor="ev-len">{allDay ? 'Days' : 'Length'}</label>
          {allDay
            ? <select id="ev-len" className="input" value={Math.max(1, Math.round(minutes / 1440))} onChange={(e) => setMinutes(Number(e.target.value) * 1440)}>{[1, 2, 3, 4, 5, 7, 10, 14].map((n) => <option key={n} value={n}>{n} {n === 1 ? 'day' : 'days'}</option>)}</select>
            : <select id="ev-len" className="input" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                {[...new Set([...DURATIONS, minutes])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} ${m === 60 ? 'hour' : 'hours'}`} · until {hm(start + m * 60_000)}</option>)}
              </select>}
        </div>
      </div>
      <div className="form-row">
        <ToggleRow checked={allDay} onChange={(v) => { setAllDay(v); if (v) setMinutes(1440); else setMinutes(60); }} label="All day" />
        <ToggleRow checked={online} onChange={setOnline} label="Hold it as a call in Dexterity Connect" />
      </div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="ev-rep">Repeat</label>
          <select id="ev-rep" className="input" value={recurrence} onChange={(e) => setRecurrence(e.target.value as Recurrence)}>
            <option value="none">Does not repeat</option><option value="daily">Every day</option><option value="weekdays">Every weekday</option><option value="weekly">Every week</option><option value="monthly">Every month</option>
          </select>
        </div>
        {recurrence !== 'none'
          ? <div className="field"><label htmlFor="ev-until">Until (optional)</label><input id="ev-until" className="input" type="date" value={until} onChange={(e) => setUntil(e.target.value)} /></div>
          : <div className="field"><label htmlFor="ev-rem">Reminder</label>
              <select id="ev-rem" className="input" value={reminder ?? ''} onChange={(e) => setReminder(e.target.value === '' ? null : Number(e.target.value))}>{REMINDERS.map(([v, l]) => <option key={String(v)} value={v ?? ''}>{l}</option>)}</select></div>}
      </div>
      {recurrence !== 'none' && (
        <div className="field"><label htmlFor="ev-rem2">Reminder</label>
          <select id="ev-rem2" className="input" value={reminder ?? ''} onChange={(e) => setReminder(e.target.value === '' ? null : Number(e.target.value))}>{REMINDERS.map(([v, l]) => <option key={String(v)} value={v ?? ''}>{l}</option>)}</select></div>
      )}
      <div className="field">
        <label>People</label>
        <div className="ev-invitees">
          {people.map((id) => { const u = users.get(id); return u ? <span key={id} className="chip accent">{u.displayName}<button aria-label={`Remove ${u.displayName}`} onClick={() => setPeople(people.filter((x) => x !== id))}><Icon name="x" size={11} /></button></span> : null; })}
          <input className="input ev-add" placeholder={people.length ? 'Add more people' : 'Invite people'} value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && candidates[0]) { e.preventDefault(); setPeople([...people, candidates[0].id]); setQ(''); } }} />
        </div>
        {q && candidates.length > 0 && (
          <div className="ev-suggest">{candidates.map((u) => <button key={u.id} onClick={() => { setPeople([...people, u.id]); setQ(''); }}><Avatar user={u} presence={presenceFor(u.id)} size="sm" />{u.displayName}<span className="faint">{u.title}</span></button>)}</div>
        )}
      </div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="ev-venue">Conference room</label>
          <select id="ev-venue" className="input" value={venueId} onChange={(e) => setVenueId(e.target.value)}>
            <option value="">{venues.length ? 'No room' : 'No rooms set up yet'}</option>
            {venues.map((v) => <option key={v.id} value={v.id}>{v.name}{v.capacity ? ` · seats ${v.capacity}` : ''}</option>)}
          </select>
        </div>
        {venueId ? <div className="field"><label>&nbsp;</label><span className="faint" style={{ fontSize: 12.5, paddingTop: 8 }}>{(venues.find((v) => v.id === venueId)?.capacity ?? 999) < people.length + 1 ? 'More people than seats' : 'Booked when you save'}</span></div>
          : <div className="field"><label htmlFor="ev-loc">Or a place</label><input id="ev-loc" className="input" maxLength={140} value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Client office, site…" /></div>}
      </div>
      <div className="field">
        <label htmlFor="ev-conv">Conversation</label>
        <select id="ev-conv" className="input" value={convId} onChange={(e) => { setConvId(e.target.value); const c = conversations.get(e.target.value); if (c && !ev) setPeople([...new Set([...people, ...c.members.filter((u) => u !== meId)])]); }}>
          <option value="">None</option>
          {[...conversations.values()].filter((c) => c.joined).map((c) => <option key={c.id} value={c.id}>{convTitle(c, users, meId)}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="ev-desc">Agenda (optional)</label>
        <textarea id="ev-desc" className="input" rows={3} maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      {clashNames.length > 0 && <div className="ev-clash"><Icon name="warning" size={15} />Busy then: {clashNames.join(', ')}</div>}
      <div className="dialog-actions">
        <span className="faint">{describeSpan(allDay ? startOfDay(start) : start, end, allDay)}</span>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!title.trim() || saving} onClick={() => void save()}><Icon name="calendar" size={15} />{ev ? 'Save' : people.length ? 'Send invitations' : 'Save'}</button>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ "starting soon" cards and Pulse
export function MeetingCards({ users, meId }: { users: Map<string, PublicUser>; meId: string }) {
  const toast = useToast();
  const soon = useCal((s) => s.soon);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(t); }, []);
  const live = soon.filter((o) => o.endAt > Date.now());
  if (!live.length) return null;
  return (
    <div className="reminder-cards meeting-cards" role="region" aria-label="Meetings starting">
      {live.slice(-2).map((o) => {
        const mins = Math.round((o.startAt - Date.now()) / 60_000);
        return (
          <div key={`${o.event.id}-${o.startAt}`} className="reminder-card meeting-card" role="alert">
            <div className="reminder-top">
              <span className="reminder-icon"><Icon name="calendar" size={18} /></span>
              <div className="desk-main">
                <span className="label">{mins > 0 ? `Starts in ${mins} min` : 'Starting now'}</span>
                <div className="desk-text">{o.event.title}</div>
                <span className="faint" style={{ fontSize: 12.5 }}>{hm(o.startAt)} – {hm(o.endAt)} · {o.event.attendees.length} invited{o.event.organizerId !== meId ? ` · by ${users.get(o.event.organizerId)?.displayName ?? 'someone'}` : ''}</span>
              </div>
              <button className="icon-btn" aria-label="Dismiss" onClick={() => dismissSoon(o)}><Icon name="x" size={15} /></button>
            </div>
            <div className="reminder-actions">
              <button className="btn sm" onClick={() => dismissSoon(o)}>Dismiss</button>
              {o.event.online && <button className="btn primary sm" onClick={() => { dismissSoon(o); void joinMeeting(o.event).catch((e: Error) => toast(e.message, true)); }}><Icon name="video" size={14} />Join call</button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function NextMeeting({ meId, onOpen }: { meId: string; onOpen: () => void }) {
  const from = useMemo(() => Date.now(), []);
  const list = useRange(from - H, startOfDay(from) + 2 * DAY);
  const next = (list ?? []).filter((o) => o.endAt > Date.now() && myResponse(o.event, meId) !== 'no').slice(0, 3);
  return (
    <div className="card interactive" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <div className="eyebrow">Coming up</div>
      {next.length === 0 && <p className="faint" style={{ margin: 0 }}>No meetings today or tomorrow.</p>}
      <div className="next-list">
        {next.map((o) => (
          <div key={`${o.event.id}-${o.startAt}`} className="next-row">
            <span className="mono next-time">{startOfDay(o.startAt) === startOfDay(Date.now()) ? hm(o.startAt) : new Date(o.startAt).toLocaleDateString([], { weekday: 'short' })}</span>
            <span className="next-title">{o.event.title}</span>
            {o.event.online && <Icon name="video" size={14} />}
          </div>
        ))}
      </div>
    </div>
  );
}
