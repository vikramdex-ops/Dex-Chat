// Nib's tray: a panel that drops from the title bar (a sheet along the bottom on a phone). Its home
// is Nib's box (write in plain words; the words Nib understood light up as annotations), today's
// day sheet with numbers and words, and Nib's skills. Other views replace the body: who gave you
// work, the wrap-up, the leave note, welcome back, the morning brief and the skills' answers.
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import type { NibItem, NibMe, NibParse, NibStatus, PublicUser, Session } from '@dex/core';
import { useChat } from '../chat/store.ts';
import { Avatar, Icon, trapTab, useToast } from '../ui.tsx';
import { NibTile } from './NibMark.tsx';
import { DimBar, GiverTile, ItemQty, PersonPick, ProjectTag, Stepper } from './parts.tsx';
import { nibDay, nibDelete, nibMeId, nibNow, nibSave, nibStart, nibWelcomeSeen, nibWrap, openTray, rankGivers, readWords, readWordsSmart, setView, useNib } from './store.ts';
import type { SkillId, TrayView } from './store.ts';
import { STATUS_WORD, clockOf, dayLabel, digestTimeText, firstName, greetingLine, qtyWords, wrapTimeText } from './words.ts';
import { formatTime } from '../time.ts';

const Leave = lazy(() => import('./leave.tsx'));
const Skill = lazy(() => import('./skills.tsx'));

export default function Tray({ session, users, onClose }: { session: Session; users: Map<string, PublicUser>; onClose: () => void }) {
  const me = useNib((s) => s.me);
  const view = useNib((s) => s.view);
  const seed = useNib((s) => s.seed);
  const ref = useRef<HTMLElement>(null);
  // the tray takes the keyboard when opened, and gives it back to Nib's tile when it closes
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => (ref.current?.querySelector<HTMLElement>('[data-autofocus]') ?? ref.current)?.focus(), 30);
    return () => { clearTimeout(t); (document.querySelector<HTMLElement>('.nib-btn') ?? before)?.focus?.(); };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); if (view.v === 'home') onClose(); else setView({ v: 'home' }); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view.v, onClose]);
  useEffect(() => {
    const out = (e: MouseEvent) => { const t = e.target as Node; if (ref.current && !ref.current.contains(t) && !(t as Element).closest?.('.nib-btn, .toast, .scrim, .sheet-scrim')) onClose(); };
    window.addEventListener('mousedown', out);
    return () => window.removeEventListener('mousedown', out);
  }, [onClose]);
  const name = firstName(session.me.displayName);
  const title = view.v === 'start' ? 'Who gave you work today' : view.v === 'wrap' ? 'Wrap-up' : view.v === 'leave' ? 'Leave note' : view.v === 'welcome' ? 'Welcome back' : view.v === 'brief' ? 'Morning brief' : view.v === 'skill' ? SKILL_TITLE[view.skill] : null;
  return (
    <aside ref={ref} className="nib-tray" role="dialog" aria-modal="false" aria-label={title ? `Nib: ${title}` : 'Nib'} tabIndex={-1} onKeyDown={trapTab}>
      <header className="nib-tray-head">
        {view.v !== 'home'
          ? <button className="icon-btn sm" aria-label="Back to Nib" title="Back (Esc)" onClick={() => setView({ v: 'home' })}><Icon name="back" size={16} /></button>
          : <NibTile size={30} />}
        <div className="nib-tray-title">
          <span className="mono nib-tray-caption">{title ? `NIB · ${title}` : 'NIB'}</span>
          {me && <span className="nib-tray-date mono">{dayLabel(me.date, { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase()}</span>}
        </div>
        <button className="icon-btn sm" aria-label="Close Nib" title="Close (Esc)" onClick={onClose}><Icon name="x" size={16} /></button>
      </header>
      {!me ? <div className="nib-tray-body"><div className="tl-more"><span className="spinner" /></div></div> : (
        <div className="nib-tray-body">
          {view.v === 'home' && <Home me={me} name={name} users={users} seed={seed} />}
          {view.v === 'start' && <StartView users={users} />}
          {view.v === 'wrap' && <WrapView users={users} />}
          {view.v === 'welcome' && <WelcomeView users={users} />}
          {(view.v === 'leave' || view.v === 'skill' || view.v === 'brief') && (
            <Suspense fallback={<div className="tl-more"><span className="spinner" /></div>}>
              {view.v === 'leave' && <Leave session={session} users={users} from={view.from} />}
              {view.v === 'skill' && <Skill skill={view.skill} query={view.query} session={session} users={users} />}
              {view.v === 'brief' && <Skill skill="brief" query="" session={session} users={users} />}
            </Suspense>
          )}
        </div>
      )}
    </aside>
  );
}

export const SKILL_TITLE: Record<SkillId, string> = { brief: 'Morning brief', who: 'Who’s in', where: 'Where is…', meeting: 'Next meeting', help: 'How do I…', remind: 'Reminder' };
const SKILLS: Array<{ id: SkillId | 'leave' | 'wrap'; label: string; icon: import('../ui.tsx').IconName }> = [
  { id: 'wrap', label: 'Wrap up my day', icon: 'daysheet' },
  { id: 'brief', label: 'Morning brief', icon: 'sun' },
  { id: 'leave', label: 'Going on leave', icon: 'calendar' },
  { id: 'who', label: 'Who’s in', icon: 'people' },
  { id: 'meeting', label: 'Next meeting', icon: 'video' },
  { id: 'where', label: 'Find a drawing', icon: 'search' },
  { id: 'remind', label: 'Remind me', icon: 'alarm' },
  { id: 'help', label: 'How do I…', icon: 'info' },
];

// ------------------------------------------------------------------ home
function Home({ me, name, users, seed }: { me: NibMe; name: string; users: Map<string, PublicUser>; seed: string }) {
  const sheet = me.enabled && !me.exempt && me.workday;
  const onLeave = !!me.leave && me.leave.from <= me.date && me.leave.to >= me.date;
  return (
    <>
      <p className="nib-line nib-tray-line">{greetingLine(me, name)}</p>
      <NibBox seed={seed} />
      {sheet && !onLeave && (
        <section className="nib-sec" aria-label="Today’s day sheet">
          <div className="nib-sec-head">
            <span className="label">{me.items.length === 1 ? '01 Today’s sheet · 1 item' : `01 Today’s sheet · ${me.items.length} items`}</span>
            <span className="mono faint">{me.day.state === 'sent' ? `SENT ${formatTime(me.day.sentAt ?? 0).toUpperCase()}` : `WRAP-UP ${wrapTimeText(me).toUpperCase()}`}</span>
          </div>
          {!me.day.started && !me.items.length && (
            <button className="nib-prompt" onClick={() => setView({ v: 'start' })}>
              <Icon name="people" size={16} /><span>Who’s given you work today?</span><Icon name="chevron" size={14} />
            </button>
          )}
          <SheetList items={me.items} users={users} />
          <div className="nib-sheet-actions">
            <button className="btn primary sm" onClick={() => setView({ v: 'wrap' })}>{me.day.state === 'sent' ? 'Change what I sent' : 'Wrap up and send'}</button>
            {me.day.started && <button className="btn ghost sm" onClick={() => setView({ v: 'start' })}>Add who gave me work</button>}
            <SeenBy me={me} users={users} />
          </div>
        </section>
      )}
      <section className="nib-sec" aria-label="Ask Nib">
        <div className="nib-sec-head"><span className="label">{sheet && !onLeave ? '02 Ask Nib' : '01 Ask Nib'}</span></div>
        <div className="nib-skills">
          {SKILLS.filter((s) => s.id !== 'wrap' || (sheet && !onLeave)).map((s) => (
            <button key={s.id} className="nib-skill" onClick={() => setView(s.id === 'leave' ? { v: 'leave' } : s.id === 'wrap' ? { v: 'wrap' } : s.id === 'brief' ? { v: 'brief' } : { v: 'skill', skill: s.id, query: '' })}>
              <Icon name={s.icon} size={16} /><span>{s.label}</span>
            </button>
          ))}
        </div>
      </section>
      <footer className="nib-tray-foot">
        <span className="mono faint">{me.nudge?.asks ? (me.nudge.asks === 1 ? 'ASKED ONCE TODAY' : `ASKED ${me.nudge.asks} TIMES TODAY`) : me.leave && me.leave.from > me.date ? `LEAVE FROM ${dayLabel(me.leave.from).toUpperCase()}` : 'CTRL+ALT+N FROM ANYWHERE'}</span>
        {me.convId && <button className="link" onClick={() => window.dispatchEvent(new CustomEvent('dex-deeplink', { detail: `dexconnect://conversation/${me.convId}` }))}>Our conversation</button>}
      </footer>
    </>
  );
}

function SeenBy({ me, users }: { me: NibMe; users: Map<string, PublicUser> }) {
  const seen = Object.keys(me.seen);
  if (!seen.length) return null;
  const names = seen.map((id) => firstName(users.get(id)?.displayName ?? '')).filter(Boolean);
  return <span className="nib-seen mono" title={names.join(', ')}><Icon name="check" size={12} />{names.length === 1 ? `${names[0].toUpperCase()} SAW IT` : `${names.length} LEADS SAW IT`}</span>;
}

// ------------------------------------------------------------------ Nib's box: plain words, read as you type
const ANN: Record<string, string> = { giver: 'FROM', project: 'JOB', qty: 'QTY', due: 'DUE', status: 'STATE' };
function NibBox({ seed }: { seed: string }) {
  const toast = useToast();
  const [text, setText] = useState(seed);
  const [busy, setBusy] = useState(false);
  const p = useMemo(() => (text.trim() ? readWords(text) : null), [text]);
  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      const r = await readWordsSmart(t);
      const done = await act(r, t, toast);
      if (done) setText('');
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  return (
    <div className="nib-box">
      <div className="nib-box-row">
        <input data-autofocus className="input nib-input" value={text} onChange={(e) => setText(e.target.value)} maxLength={400} aria-label="Tell Nib" aria-describedby="nib-box-read"
          placeholder="Tell Nib: got 12 isos from Meera for P-12" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }} />
        <button className="icon-btn accent" aria-label="Tell Nib" disabled={!text.trim() || busy} onClick={() => void submit()}><Icon name="dimsend" size={16} /></button>
      </div>
      <div id="nib-box-read" className="nib-read" aria-live="polite">{p && <Annotated text={text} p={p} />}</div>
    </div>
  );
}

/** The sentence with what Nib understood marked on it, like dimensions on a drawing. */
function Annotated({ text, p }: { text: string; p: NibParse }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const s of p.spans) {
    if (s.from < at) continue;
    if (s.from > at) parts.push(<span key={`t${at}`}>{text.slice(at, s.from)}</span>);
    parts.push(<mark key={`m${s.from}`} className={`nib-ann ${s.kind}`} data-cap={ANN[s.kind]}>{text.slice(s.from, s.to)}</mark>);
    at = s.to;
  }
  if (at < text.length) parts.push(<span key={`t${at}`}>{text.slice(at)}</span>);
  const kind = INTENT_WORD[p.intent];
  return (
    <>
      <span className="nib-read-text" translate="no">{parts}</span>
      <span className="nib-read-kind mono">{kind}</span>
    </>
  );
}
const INTENT_WORD: Record<string, string> = {
  got: 'NEW WORK', done: 'DONE', progress: 'PROGRESS', blocked: 'BLOCKED', leave: 'LEAVE', nothing: 'NOTHING TODAY', remind: 'REMINDER',
  where: 'FIND', who: 'WHO', meeting: 'MEETING', brief: 'BRIEF', help: 'HOW TO', wrap: 'WRAP-UP', sheets: 'SHEETS', unknown: 'NOTE',
};

/** What Enter in Nib's box does, by the kind of line. Returns true when the words were used up. */
export async function act(p: NibParse, text: string, toast: (t: string, bad?: boolean) => void, source: 'words' | 'slash' = 'words'): Promise<boolean> {
  switch (p.intent) {
    case 'leave': openTray({ v: 'leave', from: p.due ?? undefined }); return true;
    case 'wrap': openTray({ v: 'wrap' }); return true;
    case 'brief': openTray({ v: 'brief' }); return true;
    case 'nothing': await nibDay({ nothing: true }); toast('Nothing today. Fair enough.'); return true;
    case 'remind': case 'where': case 'who': case 'meeting': case 'help': openTray({ v: 'skill', skill: p.intent, query: text }); return true;
    case 'sheets': {
      // answered from Dexterity Sheets in the conversation with Nib, where its workbook links open at the cell
      const r = await window.dex.request('nib.sheets.ask', { text });
      if (r.convId && r.messageId) window.dispatchEvent(new CustomEvent('dex-open-message', { detail: { convId: r.convId, messageId: r.messageId } }));
      else toast(r.text.split('\n')[0]);
      return true;
    }
  }
  if (!p.activity && !p.project && !p.giver) { toast('Say what the work is, and who it’s from.', true); return false; }
  // progress on something already on the sheet updates it rather than adding a second line
  if (p.intent === 'done' || p.intent === 'progress') {
    const first = p.activity.toLowerCase().split(/\s+/)[0] ?? '';
    const match = nibNow().me?.items.find((x) => x.status !== 'done' && (!p.project || x.project === p.project)
      && ((!!p.qty?.unit && x.qty?.unit === p.qty.unit) || (first.length > 2 && x.activity.toLowerCase().includes(first))));
    if (match) {
      const total = p.qty?.total ?? match.qty?.total ?? null;
      const done = p.intent === 'done' ? (p.qty?.done ?? total) : p.qty?.done ?? null;
      await nibSave({ id: match.id, qty: total !== null || done !== null ? { done, total, unit: match.qty?.unit ?? p.qty?.unit ?? null } : match.qty, status: p.status ?? (p.intent === 'done' ? 'done' : match.status), ...(p.note ? { note: p.note } : {}) });
      toast(total ? `Updated: ${match.activity} · ${qtyWords({ done, total, unit: match.qty?.unit ?? p.qty?.unit ?? null })}` : `Updated: ${match.activity}`);
      return true;
    }
  }
  await nibSave({ giverId: p.giver?.id ?? null, project: p.project, activity: p.activity, qty: p.qty, note: p.note, status: p.status ?? 'going', due: p.due, source });
  const what = [p.activity, p.project, qtyWords(p.qty)].filter(Boolean).join(' · ');
  toast(p.giver ? `Noted for ${firstName(p.giver.name)}: ${what}` : `Noted: ${what}`);
  return true;
}

// ------------------------------------------------------------------ the day sheet
export function SheetList({ items, users, compact }: { items: NibItem[]; users: Map<string, PublicUser>; compact?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!items.length) return <p className="nib-empty faint">Nothing on your sheet yet. Tell Nib above, or use /got in any conversation.</p>;
  return (
    <ul className={`nib-sheet${compact ? ' compact' : ''}`}>
      {items.map((x) => (
        <li key={x.id} className={`nib-item s-${x.status}${open === x.id ? ' open' : ''}`}>
          <button className="nib-item-row" aria-expanded={open === x.id} onClick={() => setOpen(open === x.id ? null : x.id)}>
            <GiverTile id={x.giverId} name={x.giverName} users={users} />
            <span className="nib-item-main">
              <span className="nib-item-title"><span translate="no">{x.activity}</span><ProjectTag code={x.project} />{x.carried && <span className="nib-carried mono">CARRIED</span>}{x.coverFor && <span className="nib-carried mono">COVER</span>}</span>
              {x.note && <span className="nib-item-note" translate="no">{x.note}</span>}
            </span>
            <ItemQty x={x} />
            <span className={`nib-state mono s-${x.status}`}>{STATUS_WORD[x.status]}</span>
          </button>
          {open === x.id && <ItemEditor x={x} users={users} onDone={() => setOpen(null)} />}
        </li>
      ))}
    </ul>
  );
}

function ItemEditor({ x, users, onDone }: { x: NibItem; users: Map<string, PublicUser>; onDone: () => void }) {
  const toast = useToast();
  const [done, setDone] = useState(x.qty?.done ?? 0);
  const [total, setTotal] = useState<number | null>(x.qty?.total ?? null);
  const [note, setNote] = useState(x.note ?? '');
  const [status, setStatus] = useState<NibStatus>(x.status);
  const [activity, setActivity] = useState(x.activity);
  const [project, setProject] = useState(x.project ?? '');
  const pct = x.qty?.unit === '%';
  const save = () => void nibSave({ id: x.id, activity, project: project || null, note: note || null, status, qty: x.qty || total ? { done, total: pct ? 100 : total, unit: x.qty?.unit ?? null } : null })
    .then(() => { toast('Saved'); onDone(); }).catch((e: Error) => toast(e.message, true));
  return (
    <div className="nib-edit">
      <div className="nib-edit-grid">
        <label className="field"><span>Activity</span><input className="input" value={activity} maxLength={160} onChange={(e) => setActivity(e.target.value)} /></label>
        <label className="field"><span>Job</span><input className="input mono" value={project} maxLength={24} onChange={(e) => setProject(e.target.value.toUpperCase())} /></label>
      </div>
      {pct ? (
        <label className="field"><span>{`Done · ${done}%`}</span><input type="range" min={0} max={100} step={5} value={done} onChange={(e) => setDone(Number(e.target.value))} /></label>
      ) : (
        <div className="nib-edit-qty">
          <span className="label">Done</span>
          <Stepper value={done} max={total} onChange={setDone} label="How many are done" />
          <span className="faint">of</span>
          <input className="input mono nib-total" inputMode="decimal" aria-label="How many in all" placeholder="–" value={total ?? ''} onChange={(e) => { const v = Number(e.target.value); setTotal(e.target.value === '' ? null : Number.isFinite(v) ? v : total); }} />
          <span className="faint" translate="no">{x.qty?.unit ?? ''}</span>
          {total ? <DimBar value={done / total} /> : null}
        </div>
      )}
      <label className="field"><span>In words</span><textarea className="input" rows={2} maxLength={400} value={note} placeholder="Area 4 routing nearly done, waiting for vendor data" onChange={(e) => setNote(e.target.value)} /></label>
      <div className="seg nib-status" role="group" aria-label="State">
        {(['going', 'done', 'blocked'] as NibStatus[]).map((s) => <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}>{STATUS_WORD[s]}</button>)}
      </div>
      <div className="nib-edit-actions">
        <button className="btn primary sm" onClick={save}>Save</button>
        <button className="btn ghost sm" onClick={onDone}>Cancel</button>
        <button className="btn ghost danger sm" onClick={() => void nibDelete(x.id).then(() => toast('Taken off your sheet')).catch((e: Error) => toast(e.message, true))}>Remove</button>
        {x.giverId && <span className="faint nib-edit-from">{`From ${users.get(x.giverId)?.displayName ?? 'a colleague'}`}</span>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ who gave you work today
const KIND_LABEL: Record<string, string> = { area: 'Area leads', discipline: 'Discipline leads', team: 'Team leads' };
function StartView({ users }: { users: Map<string, PublicUser> }) {
  const me = useNib((s) => s.me)!;
  const toast = useToast();
  const [picked, setPicked] = useState<string[]>(() => me.day.givers);
  const [jobs, setJobs] = useState<Record<string, string>>({});
  const [what, setWhat] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const all = useMemo(() => [...users.values()], [users]);
  const rank = rankGivers(me, users, nibMeId());
  const kinds = (['area', 'discipline', 'team'] as const).map((k) => ({ k, list: me.givers.filter((g) => g.kind === k && users.has(g.userId)).sort((a, b) => rank.indexOf(a.userId) - rank.indexOf(b.userId)) })).filter((x) => x.list.length);
  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  const jobChoices = [...new Set([...me.recentProjects, ...me.projects.map((p) => p.code)])].slice(0, 6);
  const others = picked.filter((id) => !me.givers.some((g) => g.userId === id));
  const send = (nothing = false) => {
    setBusy(true);
    const items = nothing ? [] : picked.filter((id) => jobs[id] || what[id]).map((id) => ({ giverId: id, project: jobs[id] || null, activity: what[id] || jobs[id] || 'Work' }));
    void nibStart(nothing ? [] : picked, items).then(() => { toast(nothing ? 'I’ll ask again at wrap-up.' : 'Noted. Tell me as more comes in.'); setView({ v: 'home' }); })
      .catch((e: Error) => toast(e.message, true)).finally(() => setBusy(false));
  };
  return (
    <div className="nib-start">
      <p className="nib-line">Pick everyone who gave you work. You can add more later: just tell me.</p>
      {me.yesterday && (
        <p className="nib-yesterday">
          <span>{me.yesterday.items === 1 ? `Your sheet for ${dayLabel(me.yesterday.date)} was not sent. It has 1 item.` : `Your sheet for ${dayLabel(me.yesterday.date)} was not sent. It has ${me.yesterday.items} items.`}</span>
          <button className="link" onClick={() => void nibStart([], [], 'send').then(() => toast('Sent')).catch((e: Error) => toast(e.message, true))}>Send it now</button>
        </p>
      )}
      {kinds.map(({ k, list }) => (
        <div key={k} className="nib-start-group">
          <span className="label">{KIND_LABEL[k]}</span>
          <div className="nib-pick">
            {list.map((g) => {
              const u = users.get(g.userId)!;
              const on = picked.includes(g.userId);
              return (
                <button key={g.userId} type="button" className={`nib-giver${on ? ' on' : ''}`} aria-pressed={on} onClick={() => toggle(g.userId)}>
                  <Avatar user={u} size="sm" />
                  <span className="nib-giver-name" translate="no">{firstName(u.displayName)}</span>
                  <span className="nib-giver-scope mono" translate="no">{g.scope || (me.usual.includes(g.userId) ? 'USUAL' : '')}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div className="nib-start-group">
        <span className="label">Anyone else</span>
        <PersonPick users={all} exclude={[...picked, nibMeId()]} onPick={(u) => setPicked([...picked, u.id])} placeholder="Type a name" label="Someone else who gave you work" />
        {others.length > 0 && <div className="nib-pick">{others.map((id) => { const u = users.get(id); return u ? <button key={id} type="button" className="nib-giver on" aria-pressed onClick={() => toggle(id)}><Avatar user={u} size="sm" /><span className="nib-giver-name" translate="no">{firstName(u.displayName)}</span></button> : null; })}</div>}
      </div>
      {picked.length > 0 && (
        <div className="nib-start-jobs">
          <span className="label">For which job? (optional)</span>
          {picked.map((id) => (
            <div key={id} className="nib-start-job">
              <span className="nib-start-who" translate="no">{firstName(users.get(id)?.displayName ?? '')}</span>
              <div className="nib-jobs" role="group" aria-label={`Job for ${users.get(id)?.displayName ?? ''}`}>
                {jobChoices.map((j) => <button key={j} type="button" className={`when-chip mono${jobs[id] === j ? ' on' : ''}`} aria-pressed={jobs[id] === j} onClick={() => setJobs({ ...jobs, [id]: jobs[id] === j ? '' : j })} translate="no">{j}</button>)}
              </div>
              <input className="input" placeholder="What, in a few words" aria-label={`What ${users.get(id)?.displayName ?? ''} gave you`} value={what[id] ?? ''} maxLength={160} onChange={(e) => setWhat({ ...what, [id]: e.target.value })} />
            </div>
          ))}
        </div>
      )}
      <div className="nib-callout-actions">
        <button className="btn primary" disabled={busy || !picked.length} onClick={() => send()}>Log these</button>
        <button className="btn ghost" disabled={busy} onClick={() => send(true)}>Nothing yet</button>
        <button className="btn ghost" onClick={() => setView({ v: 'leave' })}>On leave today</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the wrap-up
const wrapRow = (x: NibItem) => ({ id: x.id, done: x.qty?.done ?? (x.status === 'done' ? x.qty?.total ?? 0 : 0), total: x.qty?.total ?? null, status: x.status, note: x.note ?? '' });
function WrapView({ users }: { users: Map<string, PublicUser> }) {
  const me = useNib((s) => s.me)!;
  const toast = useToast();
  const [rows, setRows] = useState(() => me.items.map(wrapRow));
  // an item saved elsewhere (another PC, the phone, Nib's conversation) joins the open wrap-up, and
  // one taken off leaves it; what was already changed here stays as it is
  useEffect(() => {
    setRows((rs) => {
      const ids = new Set(me.items.map((x) => x.id));
      const have = new Set(rs.map((r) => r.id));
      const added = me.items.filter((x) => !have.has(x.id));
      return added.length || rs.some((r) => !ids.has(r.id)) ? [...rs.filter((r) => ids.has(r.id)), ...added.map(wrapRow)] : rs;
    });
  }, [me.items]);
  const [extra, setExtra] = useState('');
  const [note, setNote] = useState(me.day.note ?? '');
  const [blockers, setBlockers] = useState(me.day.blockers ?? '');
  const [busy, setBusy] = useState(false);
  const leads = [...new Set(me.items.map((x) => x.giverId).filter((g): g is string => !!g))].map((id) => firstName(users.get(id)?.displayName ?? '')).filter(Boolean);
  const set = (id: string, patch: Partial<(typeof rows)[number]>) => setRows(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const send = async () => {
    setBusy(true);
    try {
      // anything else, one line each, read like Nib's box
      for (const lineText of extra.split('\n').map((l) => l.trim()).filter(Boolean)) {
        const p = readWords(lineText);
        await nibSave({ giverId: p.giver?.id ?? null, project: p.project, activity: p.activity || lineText.slice(0, 160), qty: p.qty, note: p.note, status: p.status ?? 'done', due: p.due, source: 'wrap' });
      }
      await nibWrap({ note: note || null, blockers: blockers || null, items: rows.map((r) => ({ id: r.id, done: r.total !== null || r.done ? r.done : null, total: r.total, status: r.status, note: r.note || null })) });
      toast(leads.length ? (leads.length === 1 ? `Sent to ${leads[0]}` : `Sent to ${leads.length} leads`) : 'Sent');
      setView({ v: 'home' });
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const byId = new Map(me.items.map((x) => [x.id, x] as const));
  return (
    <div className="nib-wrapup">
      <p className="nib-line">{me.items.length ? 'Here’s your sheet as I have it. Fix anything that’s off, then send.' : 'Nothing on your sheet yet. Add what you did below, or say nothing today.'}</p>
      {rows.length > 0 && (
        <ul className="nib-sheet wrap">
          {rows.map((r) => {
            const x = byId.get(r.id);
            if (!x) return null;
            const pct = x.qty?.unit === '%';
            const f = r.status === 'done' ? 1 : r.total ? r.done / r.total : null;
            return (
              <li key={r.id} className={`nib-item s-${r.status}`}>
                <div className="nib-wrap-row">
                  <GiverTile id={x.giverId} name={x.giverName} users={users} />
                  <span className="nib-item-main">
                    <span className="nib-item-title"><span translate="no">{x.activity}</span><ProjectTag code={x.project} /></span>
                    {x.giverId && <span className="nib-item-note faint" translate="no">{users.get(x.giverId)?.displayName}</span>}
                  </span>
                  <div className="seg nib-status sm" role="group" aria-label={`State of ${x.activity}`}>
                    {(['going', 'done', 'blocked'] as NibStatus[]).map((s) => <button key={s} type="button" aria-pressed={r.status === s} onClick={() => set(r.id, { status: s, ...(s === 'done' && r.total ? { done: r.total } : {}) })}>{STATUS_WORD[s]}</button>)}
                  </div>
                </div>
                <div className="nib-wrap-qty">
                  {pct ? <input type="range" min={0} max={100} step={5} value={r.done} aria-label={`Percent done of ${x.activity}`} onChange={(e) => set(r.id, { done: Number(e.target.value) })} />
                    : (r.total !== null || x.qty) ? <><Stepper value={r.done} max={r.total} onChange={(v) => set(r.id, { done: v })} label={`How many of ${x.activity} are done`} /><span className="faint">{r.total ? `of ${r.total}` : ''}</span><span className="faint" translate="no">{x.qty?.unit && x.qty.unit !== 'hours' ? x.qty.unit : ''}</span></> : null}
                  {f !== null && <DimBar value={f} blocked={r.status === 'blocked'} />}
                  <input className="input nib-wrap-note" aria-label={`Words about ${x.activity}`} placeholder={r.status === 'blocked' ? 'What is it waiting for?' : 'In words (optional)'} value={r.note} maxLength={400} onChange={(e) => set(r.id, { note: e.target.value })} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <label className="field"><span>Anything else? One per line</span><textarea className="input" rows={2} value={extra} maxLength={1200} placeholder="6 GAs issued for P-14 from Ravi" onChange={(e) => setExtra(e.target.value)} /></label>
      <div className="nib-edit-grid">
        <label className="field"><span>A note for your leads</span><input className="input" value={note} maxLength={600} onChange={(e) => setNote(e.target.value)} /></label>
        <label className="field"><span>Blockers</span><input className="input" value={blockers} maxLength={400} placeholder="Vendor data for the pumps" onChange={(e) => setBlockers(e.target.value)} /></label>
      </div>
      <div className="nib-callout-actions">
        <button className="btn primary" disabled={busy || (!rows.length && !extra.trim())} onClick={() => void send()}>
          {leads.length === 0 ? 'Send my sheet' : leads.length === 1 ? `Send to ${leads[0]}` : leads.length === 2 ? `Send to ${leads[0]} and ${leads[1]}` : `Send to ${leads.length} leads`}
        </button>
        {!me.items.some((x) => !x.carried) && !extra.trim() && <button className="btn ghost" disabled={busy} onClick={() => void nibDay({ nothing: true }).then(() => { toast('Nothing today. Fair enough.'); setView({ v: 'home' }); })}>Nothing today</button>}
        <WrapTime />
      </div>
      <p className="faint nib-fine">{me.exempt ? '' : `The management sees it in the register at ${digestTimeText(me)}.`}</p>
    </div>
  );
}

/** Your own wrap-up time. */
function WrapTime() {
  const me = useNib((s) => s.me)!;
  const toast = useToast();
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState(me.ownWrapAt ?? me.wrapAt);
  if (!edit) return <button className="link nib-wraptime" onClick={() => setEdit(true)}>{me.ownWrapAt ? `My wrap-up time: ${wrapTimeText(me)}` : `Ask me at ${wrapTimeText(me)}: change`}</button>;
  return (
    <span className="nib-wraptime-edit">
      <input type="time" className="input" aria-label="My wrap-up time" value={v} onChange={(e) => setV(e.target.value)} />
      <button className="btn sm" onClick={() => void nibDay({ wrapAt: v }).then(() => { toast(`I’ll ask at ${clockOf(me.date, v)}`); setEdit(false); }).catch((e: Error) => toast(e.message, true))}>Set</button>
      {me.ownWrapAt && <button className="btn ghost sm" onClick={() => void nibDay({ wrapAt: null }).then(() => { toast('Back to the office’s time'); setEdit(false); })}>Office time</button>}
    </span>
  );
}

// ------------------------------------------------------------------ welcome back
function WelcomeView({ users }: { users: Map<string, PublicUser> }) {
  const me = useNib((s) => s.me)!;
  const conversations = useChatConvs();
  const w = me.welcome;
  const moved = [...conversations.values()].filter((c) => c.joined && (c.unread > 0 || c.mentions > 0)).sort((a, b) => b.mentions - a.mentions || b.unread - a.unread);
  const mentions = moved.reduce((n, c) => n + c.mentions, 0);
  useEffect(() => () => { if (w) void nibWelcomeSeen(); }, [w]);
  if (!w) return <p className="nib-line">Nothing waiting. Carry on.</p>;
  const cover = w.leave.coverId ? users.get(w.leave.coverId) : undefined;
  return (
    <div className="nib-welcome">
      <p className="nib-line">{`Welcome back. Here’s what moved since ${dayLabel(w.leave.from)}.`}</p>
      <div className="nib-cells">
        <div className="nib-cell"><span className="stat">{moved.length}</span><span className="label">Conversations moved</span></div>
        <div className="nib-cell"><span className={`stat${mentions ? ' amber' : ''}`}>{mentions}</span><span className="label">Mentions of you</span></div>
        <div className="nib-cell"><span className="stat">{w.reminders}</span><span className="label">Reminders moved to today</span></div>
      </div>
      {moved.length > 0 && (
        <ul className="nib-list">
          {moved.slice(0, 5).map((c) => (
            <li key={c.id}><button className="nib-list-row" onClick={() => window.dispatchEvent(new CustomEvent('dex-deeplink', { detail: `dexconnect://conversation/${c.id}` }))}>
              <span translate="no">{c.name ?? c.members.filter((m) => m !== nibMeId()).map((m) => users.get(m)?.displayName ?? '').join(', ')}</span>
              <span className="mono faint">{c.mentions ? (c.mentions === 1 ? '1 MENTION' : `${c.mentions} MENTIONS`) : `${c.unread} NEW`}</span>
            </button></li>
          ))}
        </ul>
      )}
      {w.coverItems.length > 0 && (
        <section className="nib-sec">
          <div className="nib-sec-head"><span className="label">{cover ? `Handed back by ${firstName(cover.displayName)}` : 'Handed back'}</span></div>
          <ul className="nib-sheet compact">
            {w.coverItems.map((x, i) => (
              <li key={i} className={`nib-item s-${x.status}`}><div className="nib-item-row static">
                <GiverTile id={x.by} name={null} users={users} />
                <span className="nib-item-main"><span className="nib-item-title"><span translate="no">{x.activity}</span><ProjectTag code={x.project} /></span>{x.note && <span className="nib-item-note" translate="no">{x.note}</span>}</span>
                <ItemQty x={x} />
              </div></li>
            ))}
          </ul>
        </section>
      )}
      <div className="nib-callout-actions">
        <button className="btn primary" onClick={() => setView({ v: 'brief' })}>Today’s brief</button>
        <button className="btn ghost" onClick={() => setView({ v: 'home' })}>My day sheet</button>
      </div>
    </div>
  );
}
const useChatConvs = () => useChat((s) => s.conversations);
export type { TrayView };
