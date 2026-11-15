// The Meet lens: start a meeting now, join one by its ID or link, schedule one on the Calendar,
// open your personal room, and see what is on now, what is coming up and the meetings you were in.
// Laid out as a drawing register: ruled title-block cards, mono reference numbers, no pictures.
// M2: the Recordings shelf and its viewer, a report for each past meeting, and the personal
// room's guest link. M3: webinars (planning one, its sheet, watching one) and the survey.
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { formatMeetingId, isWebGuest, meetingLink, parseMeetingId } from '@dex/core';
import type { LobbyRule, MeetingInfo, MeetingRecord, Occurrence, PublicUser, RecordingInfo, Session } from '@dex/core';
import { LOBBY_RULES } from './lobby.ts';
import { Avatar, Icon, presenceFor, useToast } from '../ui.tsx';
import { useCall } from '../rooms/engine.ts';
import { Glyph } from '../rooms/parts.tsx';
import { useChat } from '../chat/store.ts';
import { convTitle } from '../chat/Switchboard.tsx';
import { EventDialog } from '../calendar/CalendarView.tsx';
import { DAY, addDays, hm, startOfDay, useCal } from '../calendar/store.ts';
import { usePolicy } from '../policy.ts';
import { RecordingPlayer, RecordingShelf } from './Recordings.tsx';
import { MeetingReportSheet } from './Report.tsx';
import { GuestLinkControls, PageLink, SlugField } from './GuestLink.tsx';
import { clearMeetTarget, useMeetTarget } from './shelf.ts';
import { SurveySheet, WebinarSheet, WebinarsBlock } from './webinar/Lens.tsx';
import { clearOpenWebinar, joinAny, useWeb } from './webinar/store.ts';
import './meet.css';


function lengthOf(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'under a minute';
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

function dayWord(t: number): string {
  const d = startOfDay(t), today = startOfDay(Date.now());
  if (d === today) return 'Today';
  if (d === addDays(today, -1)) return 'Yesterday';
  if (d === addDays(today, 1)) return 'Tomorrow';
  return new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}

export default function MeetLens({ session, openConv }: { session: Session; openConv: (convId: string) => void }) {
  const toast = useToast();
  const meId = session.me.id;
  const users = useMemo(() => new Map(session.users.map((u) => [u.id, u] as const)), [session.users]);
  const canHost = session.me.role !== 'guest';
  const inRoom = useCall((s) => s.room);
  const joining = useCall((s) => s.joining);
  const [scheduling, setScheduling] = useState(false);
  const [playing, setPlaying] = useState<RecordingInfo | null>(null);
  const [report, setReport] = useState<string | null>(null);
  // a webinar's attendees watch it; everyone else joins as before
  const go = (id: string, video: boolean) => void joinAny(id, video).catch((e: Error) => toast(e.message, true));
  const [webinar, setWebinar] = useState<string | null>(null);
  const [survey, setSurvey] = useState<string | null>(null);
  const openWeb = useWeb((s) => s.open);
  useEffect(() => {
    if (!openWeb) return;
    clearOpenWebinar();
    if (openWeb.what === 'survey') setSurvey(openWeb.meetingId); else setWebinar(openWeb.meetingId);
  }, [openWeb]);
  // something asked for a recording (its link) or a report
  const target = useMeetTarget();
  useEffect(() => {
    if (!target) return;
    clearMeetTarget();
    if (target.kind === 'report') { setReport(target.roomId); return; }
    void window.dex.request('rec.get', target.token ? { token: target.token } : { id: target.id }).then(setPlaying).catch((e: Error) => toast(e.message, true));
  }, [target, toast]);

  return (
    <div className="view meet">
      <div className="view-head">
        <div>
          <h1>Meet</h1>
          <p className="label">Meetings · {new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        </div>
        <div className="row-actions">
          {canHost && <button className="btn" onClick={() => setScheduling(true)}><Icon name="calendar" size={15} />Schedule</button>}
        </div>
      </div>
      {inRoom && <div className="meet-inroom"><span className="room-chip-pip" aria-hidden="true" />You are in a Room now. Leave it to start or join another meeting.</div>}
      <div className="meet-sheet">
        <div className="meet-col">
          {canHost && <StartCard users={session.users} meId={meId} onStart={go} busy={!!joining || !!inRoom} />}
          <JoinCard onJoin={go} busy={!!joining || !!inRoom} users={users} />
          <WebinarsBlock session={session} busy={!!joining || !!inRoom} onOpen={setWebinar} onReport={setReport} />
          <OnNow users={users} meId={meId} onJoin={go} busy={!!inRoom} />
          <RecordingShelf onOpen={setPlaying} />
        </div>
        <div className="meet-col">
          {canHost && <PersonalRoom onJoin={go} busy={!!joining || !!inRoom} />}
          <ComingUp meId={meId} onJoin={go} busy={!!inRoom} />
          <Recent users={users} meId={meId} onJoin={go} openConv={openConv} busy={!!inRoom} onReport={setReport} />
        </div>
      </div>
      {scheduling && <EventDialog session={session} onClose={() => setScheduling(false)} />}
      {report && <MeetingReportSheet roomId={report} onClose={() => setReport(null)} onWatch={(r) => { setReport(null); setPlaying(r); }} />}
      {playing && <RecordingPlayer rec={playing} onClose={() => setPlaying(null)} />}
      {webinar && <WebinarSheet meetingId={webinar} session={session} onClose={() => setWebinar(null)} onReport={(roomId) => { setWebinar(null); setReport(roomId); }} />}
      {survey && <SurveySheet meetingId={survey} onClose={() => setSurvey(null)} />}
    </div>
  );
}

/** A ruled card with a title-block head: label left, a reference right. */
function Block({ label, refText, children, className }: { label: string; refText?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`meet-block${className ? ` ${className}` : ''}`} aria-label={label}>
      <div className="meet-block-head"><span className="label">{label}</span>{refText && <span className="mono">{refText}</span>}</div>
      {children}
    </section>
  );
}

function StartCard({ users, meId, onStart, busy }: { users: PublicUser[]; meId: string; onStart: (id: string, video: boolean) => void; busy: boolean }) {
  const toast = useToast();
  const policy = usePolicy();
  const [title, setTitle] = useState('');
  const [people, setPeople] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [lobby, setLobby] = useState<LobbyRule>('outside');
  const [video, setVideo] = useState(false);
  const [starting, setStarting] = useState(false);
  const byId = new Map(users.map((u) => [u.id, u] as const));
  const candidates = users.filter((u) => u.role !== 'bot' && u.id !== meId && !people.includes(u.id) && q && u.displayName.toLowerCase().includes(q.toLowerCase())).slice(0, 6);
  const start = async () => {
    setStarting(true);
    try {
      const m = await window.dex.request('meet.create', { title: title.trim() || undefined, invite: people, settings: { lobby } });
      onStart(m.id, video);
      setTitle(''); setPeople([]);
    } catch (e) { toast((e as Error).message, true); }
    setStarting(false);
  };
  return (
    <Block label="Start a meeting" refText="NOW" className="meet-start">
      <div className="meet-form">
        <input className="input" maxLength={80} placeholder="What is it about? (optional)" aria-label="Meeting title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <div className="meet-invite">
          {people.map((id) => <span key={id} className="chip accent">{byId.get(id)?.displayName ?? 'Someone'}<button aria-label={`Remove ${byId.get(id)?.displayName ?? ''}`} onClick={() => setPeople(people.filter((x) => x !== id))}><Icon name="x" size={11} /></button></span>)}
          <input className="input" placeholder={people.length ? 'Ring more people' : 'Ring people in (optional)'} aria-label="Ring people in" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && candidates[0]) { e.preventDefault(); setPeople([...people, candidates[0].id]); setQ(''); } }} />
        </div>
        {candidates.length > 0 && (
          <div className="meet-suggest" role="listbox" aria-label="People">
            {candidates.map((u) => <button key={u.id} role="option" aria-selected="false" onClick={() => { setPeople([...people, u.id]); setQ(''); }}><Avatar user={u} presence={presenceFor(u.id)} size="sm" />{u.displayName}<span className="faint">{u.title}</span></button>)}
          </div>
        )}
        <div className="meet-options">
          <label className="meet-opt"><span className="label">Lobby</span>
            <select className="input" value={lobby} onChange={(e) => setLobby(e.target.value as LobbyRule)}>{LOBBY_RULES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select>
          </label>
          <label className="meet-opt check"><input type="checkbox" checked={video && !policy.cameraConsent} disabled={policy.cameraConsent} onChange={(e) => setVideo(e.target.checked)} />
            {policy.cameraConsent ? 'Cameras start off in this office' : 'Start with my camera on'}</label>
        </div>
      </div>
      <div className="meet-block-foot">
        <span className="faint">It gets its own ID and a Space for its chat and files.</span>
        <button className="btn primary" disabled={busy || starting} onClick={() => void start()}>{starting ? <span className="spinner" /> : <Icon name="video" size={15} />}Start meeting</button>
      </div>
    </Block>
  );
}

function JoinCard({ onJoin, busy, users }: { onJoin: (id: string, video: boolean) => void; busy: boolean; users: Map<string, PublicUser> }) {
  const [text, setText] = useState('');
  const [found, setFound] = useState<MeetingInfo | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const id = parseMeetingId(text);
  // what the number is, once it is a whole ID (looked up once, not as you type each digit)
  useEffect(() => {
    setFound(null); setProblem(null);
    if (!id) return;
    let alive = true;
    const t = setTimeout(() => { void window.dex.request('meet.get', { id }).then((m) => { if (alive) setFound(m); }).catch((e: Error) => { if (alive) setProblem(e.message); }); }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [id]);
  const typed = text.trim().length > 0;
  return (
    <Block label="Join a meeting" refText="BY ID OR LINK" className="meet-join">
      <form onSubmit={(e) => { e.preventDefault(); if (id) onJoin(id, false); }}>
        <div className="meet-form">
        <input className="input meet-id-input mono" inputMode="numeric" placeholder="482-913-207" aria-label="Meeting ID or link" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="meet-found" role="status">
          {!typed && <span className="faint">Type the nine-digit ID, or paste a dexconnect://meet link.</span>}
          {typed && !id && <span className="faint">A meeting ID has nine digits.</span>}
          {found && <span><b>{found.title || 'Meeting'}</b><span className="faint"> · {found.kind === 'webinar' ? 'a webinar by ' : ''}{users.get(found.hostId)?.displayName ?? 'host'}{found.live ? (found.kind === 'webinar' ? ' · its stage is open' : ` · on now, ${found.live.participants} in it`) : ' · not started'}</span></span>}
          {problem && <span className="field-error">{problem}</span>}
        </div>
        </div>
        <div className="meet-block-foot">
          <span />
          <button type="submit" className="btn primary" disabled={!id || busy || !!problem}><Glyph name="door" size={15} />Join</button>
        </div>
      </form>
    </Block>
  );
}

function PersonalRoom({ onJoin, busy }: { onJoin: (id: string, video: boolean) => void; busy: boolean }) {
  const toast = useToast();
  const [m, setM] = useState<MeetingInfo | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setTry] = useState(0);
  useEffect(() => { setProblem(null); void window.dex.request('meet.personal').then(setM).catch((e: Error) => setProblem(e.message)); }, [attempt]);
  const save = (patch: { lobby?: LobbyRule; joinBeforeHost?: boolean }) => {
    if (!m) return;
    void window.dex.request('meet.settings', { id: m.id, ...patch }).then(setM).catch((e: Error) => toast(e.message, true));
  };
  const digits = m ? formatMeetingId(m.id).split('') : [];
  return (
    <Block label="Your personal room" refText="STANDING ID" className="meet-personal">
      <div className="meet-number" aria-label={m ? `Meeting ID ${formatMeetingId(m.id)}` : 'Loading'}>
        {m ? digits.map((d, i) => (d === '-' ? <i key={i} aria-hidden="true" /> : <span key={i}>{d}</span>)) : !problem && <span className="spinner" />}
      </div>
      {!m && problem && <p className="load-problem" role="alert"><Icon name="warning" size={15} /><span><b>Your room could not be loaded</b> · {problem}</span><button className="btn ghost sm" onClick={() => setTry((n) => n + 1)}>Try again</button></p>}
      {m && (m.page
        ? <div className="meet-page">
            <PageLink url={m.page} />
            <details className="meet-rename">
              <summary className="label">Change the name</summary>
              <SlugField meetingId={m.id} value={m.page.split('/').pop() ?? null} site={m.page.replace(/\/[^/]*$/, '')} onSave={(slug) => void window.dex.request('meet.personal.slug', { slug: slug ?? '' }).then(() => window.dex.request('meet.personal')).then((x) => { setM(x); toast(slug ? `Your room is now …/${slug}` : 'Your room is at its ID'); }).catch((e: Error) => toast(e.message, true))} />
            </details>
            <div className="meet-link mono faint" title={m.link}>{meetingLink(m.id)}</div>
          </div>
        : <div className="meet-link mono" title={m.link}>{meetingLink(m.id)}</div>)}
      {m && (
        <div className="meet-options">
          <label className="meet-opt"><span className="label">Lobby</span>
            <select className="input" value={m.settings.lobby} onChange={(e) => save({ lobby: e.target.value as LobbyRule })}>{LOBBY_RULES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select>
          </label>
          <label className="meet-opt check"><input type="checkbox" checked={m.settings.joinBeforeHost} onChange={(e) => save({ joinBeforeHost: e.target.checked })} />People can come in before you</label>
        </div>
      )}
      {m && (
        <details className="meet-guests">
          <summary className="label">Guests from outside</summary>
          <GuestLinkControls meetingId={m.id} compact />
        </details>
      )}
      <div className="meet-block-foot">
        <button className="btn ghost" disabled={!m} onClick={() => m && void navigator.clipboard.writeText(m.page ?? m.link).then(() => toast('Link to your room copied'))}><Glyph name="copy" size={15} />Copy link</button>
        <button className="btn" disabled={!m || busy} onClick={() => m && onJoin(m.id, false)}><Glyph name="door" size={15} />Open your room</button>
      </div>
    </Block>
  );
}

/** Rooms running in your conversations right now. */
function OnNow({ users, meId, onJoin, busy }: { users: Map<string, PublicUser>; meId: string; onJoin: (id: string, video: boolean) => void; busy: boolean }) {
  const active = useCall((s) => s.active);
  const conversations = useChat((s) => s.conversations);
  const live = [...active.values()].filter((r) => r.participants.length && r.meetingId && !r.participants.some((p) => p.userId === meId));
  if (!live.length) return null;
  return (
    <Block label="On now" refText={String(live.length)} className="meet-now">
      <ul className="meet-rows">
        {live.map((r) => {
          const c = conversations.get(r.convId);
          return (
            <li key={r.id}>
              <span className="room-chip-pip" aria-hidden="true" />
              <span className="meet-row-main"><b>{r.title || (c ? convTitle(c, users, meId) : 'Room')}</b><span className="faint mono">{formatMeetingId(r.meetingId!)} · {r.participants.length} in it</span></span>
              <span className="stack">{r.participants.slice(0, 4).map((p) => <Avatar key={p.deviceId} user={users.get(p.userId) ?? { id: p.userId, displayName: '?' }} size="sm" />)}</span>
              <button className="btn sm primary" disabled={busy} onClick={() => onJoin(r.meetingId!, false)}>Join</button>
            </li>
          );
        })}
      </ul>
    </Block>
  );
}

/** Calendar meetings held as calls: today and the rest of the week. */
function ComingUp({ meId, onJoin, busy }: { meId: string; onJoin: (id: string, video: boolean) => void; busy: boolean }) {
  const toast = useToast();
  const version = useCal((s) => s.version);
  const [list, setList] = useState<Occurrence[] | null>(null);
  useEffect(() => {
    const from = startOfDay(Date.now());
    let alive = true;
    void window.dex.request('cal.list', { from, to: addDays(from, 7) }).then((l) => { if (alive) setList(l); }).catch(() => { if (alive) setList([]); });
    return () => { alive = false; };
  }, [version]);
  const now = Date.now();
  const items = (list ?? []).filter((o) => o.event.online && !o.event.cancelled && o.endAt > now && o.event.attendees.find((a) => a.userId === meId)?.response !== 'no');
  const today = items.filter((o) => o.startAt < startOfDay(now) + DAY);
  const later = items.filter((o) => o.startAt >= startOfDay(now) + DAY);
  const join = (o: Occurrence) => void window.dex.request('meet.event', { eventId: o.event.id }).then((m) => onJoin(m.id, false)).catch((e: Error) => toast(e.message, true));
  // each meeting's page on the meeting site, to copy from its card
  const [pages, setPages] = useState<Record<string, string | null>>({});
  useEffect(() => {
    let alive = true;
    const want = [...new Set(items.map((o) => o.event.id))].filter((id) => !(id in pages)).slice(0, 20);
    for (const id of want) void window.dex.request('meet.event', { eventId: id }).then((m) => { if (alive) setPages((p) => ({ ...p, [id]: m.page ?? null })); }).catch(() => { if (alive) setPages((p) => ({ ...p, [id]: null })); });
    return () => { alive = false; };
  }, [items.map((o) => o.event.id).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const row = (o: Occurrence) => {
    const soon = o.startAt - now < 15 * 60_000;
    const page = pages[o.event.id];
    return (
      <li key={`${o.event.id}-${o.startAt}`} className={soon ? 'soon' : undefined}>
        <span className="mono meet-time">{o.startAt < startOfDay(now) + DAY ? hm(o.startAt) : new Date(o.startAt).toLocaleDateString([], { weekday: 'short' })}</span>
        <span className="meet-row-main"><b>{o.event.title}</b><span className="faint">{hm(o.startAt)} – {hm(o.endAt)} · {o.event.attendees.length} invited</span>{page && <PageLink url={page} />}</span>
        <button className={`btn sm${soon ? ' primary' : ''}`} disabled={busy} onClick={() => join(o)}>Join</button>
      </li>
    );
  };
  return (
    <Block label="Coming up" refText="CALENDAR" className="meet-upcoming">
      {list === null && <div className="tl-more"><span className="spinner" /></div>}
      {list !== null && !items.length && <p className="meet-empty">No meetings held as calls this week. Schedule one, and it gets its own ID.</p>}
      {today.length > 0 && <><div className="meet-sub label">Today</div><ul className="meet-rows">{today.map(row)}</ul></>}
      {later.length > 0 && <><div className="meet-sub label">This week</div><ul className="meet-rows">{later.map(row)}</ul></>}
    </Block>
  );
}

function Recent({ users, meId, onJoin, openConv, busy, onReport }: { users: Map<string, PublicUser>; meId: string; onJoin: (id: string, video: boolean) => void; openConv: (convId: string) => void; busy: boolean; onReport: (roomId: string) => void }) {
  const [list, setList] = useState<MeetingRecord[] | null>(null);
  const conversations = useChat((s) => s.conversations);
  const roomGone = useCall((s) => s.room === null);
  useEffect(() => { void window.dex.request('meet.recent', { limit: 12 }).then(setList).catch(() => setList([])); }, [roomGone]);
  return (
    <Block label="Recent meetings" refText="LOG" className="meet-recent">
      {list === null && <div className="tl-more"><span className="spinner" /></div>}
      {list?.length === 0 && <p className="meet-empty">Meetings and calls you were in show here: who came, when, and for how long.</p>}
      {list && list.length > 0 && (
        <table className="meet-log">
          <tbody>
            {list.map((r) => {
              const c = conversations.get(r.convId);
              const title = r.title || (c ? convTitle(c, users, meId) : 'Room');
              return (
                <tr key={r.roomId}>
                  <td className="mono meet-when">{dayWord(r.startedAt).toUpperCase()}<br /><span>{hm(r.startedAt)}</span></td>
                  <td className="meet-what"><b title={title}>{title}</b><span className="faint">{lengthOf(r.durationMs)} · {r.people.length === 1 ? '1 person' : `${r.people.length} people`}</span></td>
                  <td className="meet-who"><span className="stack">{r.people.filter((u) => !isWebGuest(u)).slice(0, 4).map((u) => <Avatar key={u} user={users.get(u) ?? { id: u, displayName: '?' }} size="sm" />)}</span></td>
                  <td className="meet-act">
                    <button className="btn sm ghost" onClick={() => onReport(r.roomId)} title="Who came, for how long, hands, reactions and polls">Report</button>
                    {r.meetingId && r.kind !== 'conversation'
                      ? <button className="btn sm ghost" disabled={busy} onClick={() => onJoin(r.meetingId!, false)}>Rejoin</button>
                      : c ? <button className="btn sm ghost" onClick={() => openConv(c.id)}>Open</button> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Block>
  );
}
