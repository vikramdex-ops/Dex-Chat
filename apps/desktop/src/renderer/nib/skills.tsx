// Nib's everyday skills (docs/NIB.md §7). Each runs with the person's own access: their search,
// their calendar, their Directory and the day log everyone already sees. Day sheets are never used
// to answer "who knows about…".
import { useEffect, useMemo, useState } from 'react';
import type { CalEvent, Conversation, FileInfo, Message, Occurrence, PublicUser, Session } from '@dex/core';
import { whenFromWords } from '@dex/core/nib';
import { Avatar, Icon, useToast } from '../ui.tsx';
import { useDesk } from '../desk/store.ts';
import { joinMeeting } from '../calendar/store.ts';
import { useWork } from '../work/store.ts';
import { useChat } from '../chat/store.ts';
import { dayNumber, lineForDay } from '../pulse/lines.ts';
import { formatDateTime, formatTime } from '../time.ts';
import { setView, useNib } from './store.ts';
import type { SkillId } from './store.ts';
import { dayLabel, firstName } from './words.ts';

const go = (url: string) => window.dispatchEvent(new CustomEvent('dex-deeplink', { detail: url }));

export default function Skill({ skill, query, session, users }: { skill: SkillId; query: string; session: Session; users: Map<string, PublicUser> }) {
  if (skill === 'brief') return <Brief session={session} users={users} />;
  if (skill === 'who') return <Who query={query} users={users} meId={session.me.id} />;
  if (skill === 'where') return <Where query={query} users={users} />;
  if (skill === 'meeting') return <NextMeeting meId={session.me.id} />;
  if (skill === 'remind') return <Remind query={query} />;
  return <Help query={query} />;
}

/** A question box for a skill opened from a chip. */
function Ask({ value, onAsk, placeholder, label }: { value: string; onAsk: (q: string) => void; placeholder: string; label: string }) {
  const [q, setQ] = useState(value);
  return (
    <form className="nib-box-row" onSubmit={(e) => { e.preventDefault(); onAsk(q.trim()); }}>
      <input data-autofocus className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} aria-label={label} maxLength={200} />
      <button className="icon-btn accent" aria-label={label} disabled={!q.trim()}><Icon name="dimsend" size={16} /></button>
    </form>
  );
}

async function todaysMeetings(meId: string, days = 1): Promise<Occurrence[]> {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + days);
  try {
    const list = await window.dex.request('cal.list', { from: start.getTime(), to: end.getTime() });
    return list.filter((o) => !o.event.cancelled && !o.event.allDay && o.event.attendees.find((a) => a.userId === meId)?.response !== 'no').sort((a, b) => a.startAt - b.startAt);
  } catch { return []; }
}

// ------------------------------------------------------------------ the morning brief
function Brief({ session, users }: { session: Session; users: Map<string, PublicUser> }) {
  const me = useNib((s) => s.me)!;
  const [meetings, setMeetings] = useState<Occurrence[] | null>(null);
  const reminders = useDesk((s) => s.reminders);
  const conversations = useChat((s) => s.conversations);
  useEffect(() => { void todaysMeetings(session.me.id).then(setMeetings); }, [session.me.id]);
  const end = new Date(); end.setHours(23, 59, 59, 999);
  const due = [...reminders.values()].filter((r) => r.userId === session.me.id && !r.done && r.dueAt <= end.getTime()).sort((a, b) => a.dueAt - b.dueAt);
  const later = (meetings ?? []).filter((o) => o.endAt > Date.now());
  const open = me.items.filter((x) => x.status !== 'done');
  const carried = me.items.filter((x) => x.carried).length;
  // birthdays and work anniversaries among your department and the people you write to
  const near = useMemo(() => {
    const talk = new Set([...conversations.values()].filter((c) => c.kind === 'direct').flatMap((c) => c.members));
    const md = (() => { const d = new Date(); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
    const year = new Date().getFullYear();
    const out: Array<{ u: PublicUser; text: string }> = [];
    for (const u of users.values()) {
      if (u.id === session.me.id || u.role === 'bot' || u.role === 'guest') continue;
      if (!(talk.has(u.id) || (u.profile.departmentId && u.profile.departmentId === session.me.profile.departmentId))) continue;
      if (u.profile.birthday === md) out.push({ u, text: `${firstName(u.displayName)}’s birthday` });
      const j = u.profile.joinedOn;
      if (j && j.slice(5) === md && Number(j.slice(0, 4)) < year) { const n = year - Number(j.slice(0, 4)); out.push({ u, text: n === 1 ? `${firstName(u.displayName)}: one year here` : `${firstName(u.displayName)}: ${n} years here` }); }
    }
    return out.slice(0, 3);
  }, [users, conversations, session.me.id, session.me.profile.departmentId]);
  const line = lineForDay(dayNumber()).line;
  return (
    <div className="nib-brief">
      <p className="nib-brief-date">{dayLabel(me.date, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
      <ol className="nib-brief-lines">
        <li>
          <Icon name="calendar" size={16} />
          {meetings === null ? <span className="faint">Looking at your calendar…</span>
            : later.length === 0 ? <span>No more meetings today.</span>
              : <span>{later.length === 1 ? `One meeting: ${later[0].event.title} at ${formatTime(later[0].startAt)}.` : `${later.length} meetings; next ${later[0].event.title} at ${formatTime(later[0].startAt)}.`}</span>}
        </li>
        <li><Icon name="alarm" size={16} /><span>{due.length === 0 ? 'No reminders due today.' : due.length === 1 ? `One reminder: ${due[0].text}.` : `${due.length} reminders due; first: ${due[0].text}.`}</span></li>
        {!me.exempt && me.workday && <li><Icon name="daysheet" size={16} /><span>{open.length === 0 ? 'Nothing open on your day sheet.' : carried ? (open.length === 1 ? `One item on your sheet, carried from your last day.` : `${open.length} items on your sheet, ${carried} carried from your last day.`) : open.length === 1 ? 'One item on your sheet.' : `${open.length} items on your sheet.`}</span></li>}
        {near.map((x) => (
          <li key={x.u.id + x.text}><Icon name="star" size={16} /><span translate="no">{x.text}</span><button className="link" onClick={() => void window.dex.request('conv.create', { kind: 'direct', members: [x.u.id] }).then((c) => go(`dexconnect://conversation/${c.id}`))}>Write to them</button></li>
        ))}
        <li className="nib-brief-quote"><Icon name="pulse" size={16} /><span translate="no">{`“${line.text}” · ${line.by}`}</span></li>
      </ol>
      <div className="nib-callout-actions">
        {!me.exempt && me.workday && !me.day.started && <button className="btn primary" onClick={() => setView({ v: 'start' })}>Who gave me work today</button>}
        {later[0] && <button className="btn" onClick={() => setView({ v: 'skill', skill: 'meeting', query: '' })}>My next meeting</button>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ who's in, who knows
const EXPERT = /\b(?:knows?|knowledge|expert|works? on|working on|about|handles?|good at|help with)\b/i;
function terms(q: string): string {
  return q.replace(/^(?:who(?:'s| is)?|who all|kaun)\s+/i, '').replace(/\b(?:knows?|knowledge|expert|works? on|working on|about|handles?|good at|help with|can help|in|on|the|a|an|for|today|here|around|office|is|are)\b/gi, ' ').replace(/[?.!]/g, ' ').replace(/\s+/g, ' ').trim();
}
function Who({ query, users, meId }: { query: string; users: Map<string, PublicUser>; meId: string }) {
  const [q, setQ] = useState(query);
  const expert = EXPERT.test(q) && terms(q).length > 1;
  return (
    <div className="nib-skill-view">
      <Ask value={q} onAsk={setQ} placeholder="who’s in today · who knows about P-12 stress" label="Ask who" />
      {expert ? <WhoKnows q={terms(q)} users={users} meId={meId} /> : <WhosIn users={users} meId={meId} />}
    </div>
  );
}
const MODE_LABEL: Record<string, string> = { office: 'In the office', home: 'At home', site: 'On site', client: 'At a client', break: 'Stepped out' };
function WhosIn({ users, meId }: { users: Map<string, PublicUser>; meId: string }) {
  const team = useWork();
  const groups = new Map<string, PublicUser[]>();
  const away: PublicUser[] = [];
  for (const u of users.values()) {
    if (u.role === 'bot' || u.role === 'guest' || u.id === meId) continue;
    if (u.ooo && u.ooo.until > Date.now()) { away.push(u); continue; }
    const s = team.get(u.id);
    if (!s || s.status === 'out' || !s.mode) continue;
    const k = s.status === 'break' ? 'break' : s.mode;
    groups.set(k, [...(groups.get(k) ?? []), u]);
  }
  const total = [...groups.values()].reduce((n, l) => n + l.length, 0);
  return (
    <>
      <p className="nib-line">{total === 0 ? 'Nobody has started their day yet.' : total === 1 ? 'One person has started their day.' : `${total} people have started their day.`}</p>
      {(['office', 'home', 'site', 'client', 'break'] as const).filter((k) => groups.get(k)?.length).map((k) => (
        <section key={k} className="nib-sec">
          <div className="nib-sec-head"><span className="label">{`${MODE_LABEL[k]} · ${groups.get(k)!.length}`}</span></div>
          <div className="nib-people">{groups.get(k)!.map((u) => <Person key={u.id} u={u} />)}</div>
        </section>
      ))}
      {away.length > 0 && (
        <section className="nib-sec">
          <div className="nib-sec-head"><span className="label">{`Away · ${away.length}`}</span></div>
          <div className="nib-people">{away.map((u) => <Person key={u.id} u={u} note={u.ooo?.delegateId ? `Ask ${firstName(users.get(u.ooo.delegateId)?.displayName ?? '')}` : undefined} />)}</div>
        </section>
      )}
    </>
  );
}
function Person({ u, note }: { u: PublicUser; note?: string }) {
  return (
    <button className="nib-person-chip" onClick={() => go(`dexconnect://people/${u.id}`)}>
      <Avatar user={u} size="sm" /><span translate="no">{u.displayName}</span>{note && <span className="faint" translate="no">{note}</span>}
    </button>
  );
}
function WhoKnows({ q, users, meId }: { q: string; users: Map<string, PublicUser>; meId: string }) {
  const [res, setRes] = useState<{ people: Array<{ u: PublicUser; n: number; where: string[] }>; spaces: Conversation[] } | null>(null);
  const conversations = useChat((s) => s.conversations);
  useEffect(() => {
    let alive = true;
    setRes(null);
    void (async () => {
      const found = await window.dex.request('search', { q, kind: 'space', limit: 50 }).catch(() => ({ messages: [], files: [] }));
      const by = new Map<string, { n: number; where: Set<string> }>();
      for (const { message } of found.messages) {
        if (message.authorId === meId) continue;
        const e = by.get(message.authorId) ?? { n: 0, where: new Set<string>() };
        e.n++;
        const c = conversations.get(message.convId);
        if (c?.name) e.where.add(c.name);
        by.set(message.authorId, e);
      }
      const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
      const spaces = [...conversations.values()].filter((c) => c.kind === 'space' && words.some((w) => (c.name ?? '').toLowerCase().includes(w) || (c.topic ?? '').toLowerCase().includes(w))).slice(0, 4);
      const people = [...by].map(([id, e]) => ({ u: users.get(id)!, n: e.n, where: [...e.where].slice(0, 2) })).filter((x) => x.u && x.u.role !== 'bot').sort((a, b) => b.n - a.n).slice(0, 6);
      if (alive) setRes({ people, spaces });
    })();
    return () => { alive = false; };
  }, [q, meId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!res) return <div className="tl-more"><span className="spinner" /></div>;
  if (!res.people.length && !res.spaces.length) return <p className="nib-line">{`I can’t see anyone writing about “${q}” in the Spaces you’re in.`}</p>;
  return (
    <>
      <p className="nib-line">{`From what’s written in Spaces you can see, about “${q}”:`}</p>
      <div className="nib-people">{res.people.map((x) => <Person key={x.u.id} u={x.u} note={x.n === 1 ? (x.where[0] ? `1 message in ${x.where[0]}` : '1 message') : x.where[0] ? `${x.n} messages, in ${x.where[0]}` : `${x.n} messages`} />)}</div>
      {res.spaces.length > 0 && (
        <ul className="nib-list">{res.spaces.map((c) => <li key={c.id}><button className="nib-list-row" onClick={() => go(`dexconnect://conversation/${c.id}`)}><Icon name="grid" size={14} /><span translate="no">{c.name}</span></button></li>)}</ul>
      )}
    </>
  );
}

// ------------------------------------------------------------------ where is…
function Where({ query, users }: { query: string; users: Map<string, PublicUser> }) {
  const [q, setQ] = useState(query.replace(/^(?:where(?:'s| is| are)|find(?: me)?|look for|search(?: for)?|kahan? (?:hai|h))\s+/i, '').replace(/^(?:the|my|latest)\s+/i, '').replace(/\?$/, ''));
  const [res, setRes] = useState<{ messages: Array<{ message: Message; snippet: string }>; files: Array<FileInfo & { messageId: string; convId: string }> } | null>(null);
  const conversations = useChat((s) => s.conversations);
  useEffect(() => {
    if (!q) { setRes(null); return; }
    let alive = true;
    setRes(null);
    void window.dex.request('search', { q, limit: 20 }).then((r) => { if (alive) setRes(r); }).catch(() => { if (alive) setRes({ messages: [], files: [] }); });
    return () => { alive = false; };
  }, [q]);
  return (
    <div className="nib-skill-view">
      <Ask value={q} onAsk={setQ} placeholder="GA for P-12 area 4" label="Find" />
      {!q ? <p className="nib-line">Tell me what to look for: a drawing number, a job, a file name.</p> : !res ? <div className="tl-more"><span className="spinner" /></div> : (
        res.files.length + res.messages.length === 0 ? <p className="nib-line">{`Nothing about “${q}” that you can see.`}</p> : (
          <>
            {res.files.length > 0 && <section className="nib-sec"><div className="nib-sec-head"><span className="label">{res.files.length === 1 ? 'Files · 1' : `Files · ${res.files.length}`}</span></div>
              <ul className="nib-list">{res.files.slice(0, 5).map((f) => <li key={f.id}><button className="nib-list-row" onClick={() => go(`dexconnect://message/${f.convId}/${f.messageId}`)}><Icon name="doc" size={14} /><span translate="no">{f.name}</span><span className="mono faint" translate="no">{conversations.get(f.convId)?.name ?? ''}</span></button></li>)}</ul></section>}
            {res.messages.length > 0 && <section className="nib-sec"><div className="nib-sec-head"><span className="label">{res.messages.length === 1 ? 'Messages · 1' : `Messages · ${res.messages.length}`}</span></div>
              <ul className="nib-list">{res.messages.slice(0, 5).map(({ message, snippet }) => <li key={message.id}><button className="nib-list-row" onClick={() => go(`dexconnect://message/${message.convId}/${message.id}`)}><Icon name="chat" size={14} /><span className="nib-snip" translate="no">{`${firstName(users.get(message.authorId)?.displayName ?? '')}: ${snippet.replace(/<\/?mark>/g, '')}`}</span><span className="mono faint">{formatDateTime(message.createdAt, { day: 'numeric', month: 'short' })}</span></button></li>)}</ul></section>}
          </>
        )
      )}
    </div>
  );
}

// ------------------------------------------------------------------ my next meeting
function NextMeeting({ meId }: { meId: string }) {
  const toast = useToast();
  const [next, setNext] = useState<Occurrence | null | undefined>(undefined);
  useEffect(() => { void todaysMeetings(meId, 7).then((l) => setNext(l.find((o) => o.endAt > Date.now()) ?? null)); }, [meId]);
  if (next === undefined) return <div className="tl-more"><span className="spinner" /></div>;
  if (!next) return <p className="nib-line">Nothing in your calendar this week.</p>;
  const ev: CalEvent = next.event;
  const now = next.startAt <= Date.now();
  const mins = Math.round((next.startAt - Date.now()) / 60_000);
  return (
    <div className="nib-meeting">
      <p className="nib-line">{now ? 'It has started.' : mins < 60 ? (mins <= 1 ? 'It starts in a minute.' : `It starts in ${mins} minutes.`) : `${dayLabel(new Date(next.startAt).toISOString().slice(0, 10))}, ${formatTime(next.startAt)}.`}</p>
      <div className="nib-meet-card">
        <span className="nib-meet-time mono">{`${formatTime(next.startAt)} – ${formatTime(next.endAt)}`}</span>
        <span className="nib-meet-title" translate="no">{ev.title}</span>
        {ev.location && <span className="faint" translate="no">{ev.location}</span>}
        <span className="faint">{ev.attendees.length === 1 ? 'Just you' : `${ev.attendees.length} people`}</span>
      </div>
      <div className="nib-callout-actions">
        {ev.online && <button className="btn primary" onClick={() => void joinMeeting(ev).catch((e: Error) => toast(e.message, true))}><Icon name="video" size={16} />Join</button>}
        <button className="btn" onClick={() => go(`dexconnect://calendar/event/${ev.id}`)}>Open in the calendar</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ reminders in plain words
function Remind({ query }: { query: string }) {
  const toast = useToast();
  const me = useNib((s) => s.me);
  const [q, setQ] = useState(query);
  const [done, setDone] = useState<string | null>(null);
  const when = q ? whenFromWords(q, new Date(), me?.wrapAt) : null;
  const text = when ? when.rest.replace(/^to\s+/i, '') : '';
  const set = () => void window.dex.request('remind.create', { text: text.slice(0, 500), dueAt: when!.at })
    .then(() => { setDone(`Reminder set: ${text} · ${formatDateTime(when!.at, { weekday: 'short' })}`); toast('Reminder set'); }).catch((e: Error) => toast(e.message, true));
  useEffect(() => { if (query && when && text && !done) set(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="nib-skill-view">
      <Ask value={q} onAsk={(v) => { setDone(null); setQ(v); }} placeholder="remind me to send the GA to Ravi after lunch" label="Remind me" />
      {done ? <p className="nib-line"><Icon name="check" size={14} />{done}</p>
        : !q ? <p className="nib-line">Say what and when: after lunch, end of day, tomorrow morning, kal, in 20 min, at 5.</p>
          : !when || !text ? <p className="nib-line">I couldn’t tell when. Try “after lunch”, “tomorrow morning” or “at 4:30”.</p>
            : <div className="nib-callout-actions"><span className="nib-line" translate="no">{`${text} · ${formatDateTime(when.at, { weekday: 'short' })}`}</span><button className="btn primary" onClick={set}>Set reminder</button></div>}
    </div>
  );
}

// ------------------------------------------------------------------ help with the app
interface Topic { keys: RegExp; title: string; steps: string[]; go?: string; goLabel?: string }
const TOPICS: Topic[] = [
  { keys: /share (?:my )?screen|present|screen ?share/i, title: 'Share your screen', steps: ['Open a Room in the conversation (the Room button in its title block).', 'In the Room, choose Share screen.', 'Pick a window or the whole screen, then Share.'] },
  { keys: /\b(?:call|room|video|voice|ring)\b/i, title: 'Start a Room (a call)', steps: ['Open the conversation.', 'Choose the Room button in its title block, with voice or video.', 'Or type /call or /video in the Dock.'] },
  { keys: /meeting|schedule a meet|invite/i, title: 'Plan a meeting', steps: ['Go to Calendar and choose New meeting, or type /meet in a conversation.', 'Add people, a time and a room.', 'Everyone gets an invitation with a Join button.'], go: 'dexconnect://calendar', goLabel: 'Open the Calendar' },
  { keys: /remind/i, title: 'Set a reminder', steps: ['Tell Nib: “remind me to … after lunch”.', 'Or type /remind in 30m Call the client.', 'Reminders live on your Desk.'], go: 'dexconnect://desk', goLabel: 'Open the Desk' },
  { keys: /send later|schedule (?:a )?message/i, title: 'Send a message later', steps: ['Write the message in the Dock.', 'Type /schedule, or open the send menu and choose Send later.', 'Pick when it goes.'] },
  { keys: /keep|save|bookmark|star/i, title: 'Keep a message on your Desk', steps: ['Hover the message (long-press on a phone).', 'Choose Keep on my Desk.', 'Find it under Desk → Kept.'] },
  { keys: /leave|out of office|away|ooo|holiday/i, title: 'Go on leave', steps: ['Tell Nib: “on leave tomorrow”, or choose Going on leave in Nib’s tray.', 'Choose the days, who covers and who to tell.', 'Nib sets your away status, blocks your calendar and tells everyone.'] },
  { keys: /start (?:my )?day|check ?in|day log|attendance/i, title: 'Start or close your day', steps: ['Open your own tile in the title bar.', 'Choose where you are working and Start my day.', 'Or type /startday site in any conversation.'] },
  { keys: /bot|automat|flow/i, title: 'Make a bot', steps: ['Go to Desk → Bots → Make a bot.', 'Start from a template, a few words or a blank bot.', 'Test it on the right, then share it.'], go: 'dexconnect://desk', goLabel: 'Open the Desk' },
  { keys: /find|search|file|drawing/i, title: 'Find a message or a file', steps: ['Press Ctrl+K, or tell Nib “where is …”.', 'Filter by person, Direct or Spaces, dates or files.', 'Open a result to jump to it.'] },
  { keys: /language|hindi|tamil/i, title: 'Change the language', steps: ['Open your tile → Preferences.', 'Under Language, choose English, हिन्दी or தமிழ்.'], go: 'dexconnect://settings', goLabel: 'Open Preferences' },
  { keys: /mute|quiet|notification|sound|disturb/i, title: 'Quieten notifications', steps: ['Mute one conversation from its menu.', 'Or set your status to No interruptions from your tile.', 'Sounds and notifications are in Preferences.'] },
  { keys: /phone|mobile|pair/i, title: 'Add your phone', steps: ['Open Preferences → Your devices → Add a phone.', 'Scan the code with the Dexterity Connect app on the phone.'], go: 'dexconnect://settings', goLabel: 'Open Preferences' },
  { keys: /poll|vote/i, title: 'Ask a quick poll', steps: ['Type /poll Lunch? | Dosa | Biryani in the Dock.', 'Or choose Poll from the Dock’s insert menu.'] },
  { keys: /side-?track|thread|reply/i, title: 'Reply in a side-track', steps: ['Hover the message and choose Reply in a side-track.', 'The side-track opens beside the conversation, linked to the message.'] },
];
function Help({ query }: { query: string }) {
  const [q, setQ] = useState(query);
  const hits = q ? TOPICS.filter((t) => t.keys.test(q)).slice(0, 2) : [];
  return (
    <div className="nib-skill-view">
      <Ask value={q} onAsk={setQ} placeholder="how do I share my screen" label="How do I" />
      {!q ? (
        <div className="nib-skills">{TOPICS.slice(0, 8).map((t) => <button key={t.title} className="nib-skill" onClick={() => setQ(t.title)}><Icon name="info" size={14} /><span>{t.title}</span></button>)}</div>
      ) : !hits.length ? <p className="nib-line">I don’t know that one yet. Try Help me… in your tile’s menu, and IT will answer.</p> : hits.map((t) => (
        <section key={t.title} className="nib-sec">
          <div className="nib-sec-head"><span className="label">{t.title}</span></div>
          <ol className="nib-steps">{t.steps.map((s) => <li key={s}>{s}</li>)}</ol>
          {t.go && <button className="btn sm" onClick={() => go(t.go!)}>{t.goLabel}</button>}
        </section>
      ))}
    </div>
  );
}
