// Schedule: the bot's scheduled jobs, each written in plain words ("every weekday at 9:15",
// "last working day of the month at 16:00"). The words are read here as they are typed, the same
// way the hub reads them: what mattered is marked on them like dimensions, what was understood is
// said in words, and the next five runs are listed in the office's time with its working days and
// holidays. Then what the job does: start this bot for people, post its register, check another
// bot and tell someone only when it holds, ask a bot and post the answer, or remind people.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { BotFlowCondition, BotFlowDefinition, BotJob, BotJobAction, BotJobPeople, PublicUser } from '@dex/core';
import { DEFAULT_CALENDAR, nextRuns, parseSchedule } from '@dex/core/botjobs';
import type { OfficeCalendar } from '@dex/core/botjobs';
import { Icon } from '../../ui.tsx';
import { openJobSheet } from '../net/open.ts';
import { officeWhen } from '../net/JobSheet.tsx';
import { scheduleWords, trLine } from '../net/words.ts';
import { insertAt } from './Steps.tsx';
import { ChosenSkill, SkillBlocks, SkillFields } from './SkillBlocks.tsx';
import { useNet } from './netdata.ts';

const pad = (n: number) => String(n).padStart(2, '0');
const DO_WORDS: Record<BotJobAction['do'], string> = { start: 'Start this bot for people', register: 'Post its register', check: 'Check a bot, and tell someone when it holds', ask: 'Ask a bot, and post the answer', remind: 'Remind people' };
const EXAMPLES = ['every weekday at 9:15', 'every Monday 10:00', 'last working day of the month at 16:00', '1st and 15th', 'every 2 hours during office hours', 'every Friday 17:00'];

/** The words as typed, with what was read marked on them (an underline with a mono caption above). */
function Marked({ text, marks }: { text: string; marks: Array<{ start: number; end: number; cap: string }> }) {
  const out: React.ReactNode[] = [];
  let at = 0;
  marks.forEach((m, i) => {
    if (m.start > at) out.push(<span key={`t${i}`}>{text.slice(at, m.start)}</span>);
    out.push(<span key={`m${i}`} className="js-mark"><span className="js-mark-cap mono" aria-hidden="true">{m.cap}</span><span>{text.slice(m.start, m.end)}</span></span>);
    at = m.end;
  });
  if (at < text.length) out.push(<span key="rest">{text.slice(at)}</span>);
  return <span className="js-marked" translate="no" aria-hidden="true">{out}</span>;
}

function PeoplePick({ value, onChange, spaces, users, me }: { value: BotJobPeople; onChange: (p: BotJobPeople) => void; spaces: Array<{ id: string; name: string }>; users: PublicUser[]; me: PublicUser }) {
  const id = useId();
  const team = users.filter((u) => u.profile?.managerId === me.id);
  return (
    <>
      <div className="field">
        <label htmlFor={`${id}-from`}>For</label>
        <select id={`${id}-from`} className="input" value={value.from} onChange={(e) => {
          const f = e.target.value as BotJobPeople['from'];
          onChange(f === 'space' ? { from: 'space', space: spaces[0]?.name ?? '' } : f === 'department' ? { from: 'department', department: '' } : f === 'people' ? { from: 'people', people: [] } : { from: 'team' });
        }}>
          <option value="team">{team.length === 1 ? 'My team (1 person)' : `My team (${team.length} people)`}</option>
          <option value="space">The people of a Space</option>
          <option value="department">A department</option>
          <option value="people">People I choose</option>
        </select>
      </div>
      {value.from === 'space' && (
        <div className="field"><label htmlFor={`${id}-sp`}>Space</label>
          <select id={`${id}-sp`} className="input" value={value.space} onChange={(e) => onChange({ from: 'space', space: e.target.value })}>
            {spaces.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
            {value.space && !spaces.some((s) => s.name === value.space) && <option value={value.space}>{value.space}</option>}
          </select></div>
      )}
      {value.from === 'department' && <div className="field"><label htmlFor={`${id}-dp`}>Department</label><input id={`${id}-dp`} className="input" value={value.department} placeholder="Piping" onChange={(e) => onChange({ from: 'department', department: e.target.value })} /></div>}
      {value.from === 'people' && (
        <fieldset className="bm-wide bm-carry">
          <legend>People</legend>
          <div className="js-people">
            {value.people.map((p) => <span key={p} className="chip">{users.find((u) => u.id === p)?.displayName ?? p}<button type="button" className="icon-btn sm" aria-label={`Remove ${users.find((u) => u.id === p)?.displayName ?? ''}`} onClick={() => onChange({ from: 'people', people: value.people.filter((x) => x !== p) })}><Icon name="x" size={12} /></button></span>)}
          </div>
          <select className="input" aria-label="Add a person" value="" onChange={(e) => e.target.value && onChange({ from: 'people', people: [...value.people, e.target.value].slice(0, 40) })}>
            <option value="">Add a person…</option>
            {users.filter((u) => u.role !== 'bot' && u.role !== 'guest' && !value.people.includes(u.id)).map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
          </select>
        </fieldset>
      )}
    </>
  );
}

function JobEditor({ def, job, onChange, spaces, users, me, cal }: { def: BotFlowDefinition; job: BotJob; onChange: (j: BotJob) => void; spaces: Array<{ id: string; name: string }>; users: PublicUser[]; me: PublicUser; cal: OfficeCalendar }) {
  const id = useId();
  const net = useNet();
  const text = useRef<HTMLTextAreaElement>(null);
  const parsed = useMemo(() => parseSchedule(job.when, Date.now(), cal), [job.when, cal]);
  const runs = useMemo(() => (parsed.ok ? nextRuns(parsed.rule, cal, Date.now(), 5) : []), [parsed, cal]);
  const a = job.do;
  const setDo = (d: BotJobAction) => onChange({ ...job, do: d });
  const skill = a.do === 'check' || a.do === 'ask' ? net.skills.find((s) => s.id === a.ask.skill) : undefined;
  const outputs = skill?.outputs ?? [];
  const cond = a.do === 'check' ? a.if : null;
  const op = cond ? (cond.gt !== undefined ? 'gt' : cond.lt !== undefined ? 'lt' : cond.notEquals !== undefined ? 'ne' : 'eq') : 'gt';
  const condValue = cond ? String(cond.gt ?? cond.lt ?? cond.notEquals ?? cond.equals ?? '') : '';
  const setCond = (o: string, v: string, variable?: string) => {
    if (a.do !== 'check') return;
    const n = Number(v);
    const c: BotFlowCondition = { var: variable ?? a.if.var ?? 'result' };
    if (o === 'gt') c.gt = Number.isFinite(n) ? n : 0; else if (o === 'lt') c.lt = Number.isFinite(n) ? n : 0; else if (o === 'ne') c.notEquals = v; else c.equals = v;
    setDo({ ...a, if: c });
  };
  return (
    <div className="bm-step-edit">
      <div className="field"><label htmlFor={`${id}-n`}>Name</label><input id={`${id}-n`} className="input" maxLength={80} value={job.title} onChange={(e) => onChange({ ...job, title: e.target.value })} /></div>
      <div className="field bm-wide js-when">
        <label htmlFor={`${id}-w`}>When it runs, in plain words</label>
        <input id={`${id}-w`} className="input" maxLength={200} value={job.when} placeholder="every Monday at 10:00" translate="no" aria-describedby={`${id}-wd`} onChange={(e) => onChange({ ...job, when: e.target.value })} />
        {job.when && <Marked text={job.when} marks={parsed.marks} />}
        <div id={`${id}-wd`} className={`js-understood${parsed.ok ? '' : ' bad'}`} role="status">
          {parsed.ok ? <><span className="net-cap">Understood</span><b>{scheduleWords(parsed.rule)}</b>{parsed.notes.map((n, i) => <span key={i} className="faint">{trLine(n)}</span>)}</> : <><Icon name="warning" size={14} /><span>{trLine(parsed.error)}</span></>}
        </div>
        {!job.when && <div className="bm-insert" role="group" aria-label="Examples"><span className="bm-insert-label">Like</span>{EXAMPLES.map((x) => <button key={x} type="button" className="bm-token" translate="no" onClick={() => onChange({ ...job, when: x })}>{x}</button>)}</div>}
        {runs.length > 0 && (
          <ol className="js-next" aria-label="The next runs, office time">
            {runs.map((t, i) => <li key={t}><span className="mono faint">{pad(i + 1)}</span><span className="mono">{officeWhen(t, cal.tzOffset)}</span></li>)}
          </ol>
        )}
      </div>
      <div className="field bm-wide">
        <label htmlFor={`${id}-do`}>What it does</label>
        <select id={`${id}-do`} className="input" value={a.do} onChange={(e) => {
          const d = e.target.value as BotJobAction['do'];
          setDo(d === 'start' ? { do: 'start', people: { from: 'team' } } : d === 'register' ? { do: 'register' } : d === 'remind' ? { do: 'remind', people: { from: 'team' }, text: `${def.title}: a reminder` }
            : d === 'ask' ? { do: 'ask', ask: { skill: '' }, tell: 'owner', text: '{{result}}' } : { do: 'check', ask: { skill: '' }, if: { var: 'result', gt: 0 }, tell: 'owner', text: '{{result}}' });
        }}>
          {(Object.keys(DO_WORDS) as Array<BotJobAction['do']>).filter((k) => k !== 'register' || def.track).map((k) => <option key={k} value={k}>{DO_WORDS[k]}</option>)}
        </select>
      </div>
      {(a.do === 'start' || a.do === 'remind') && <PeoplePick value={a.people} onChange={(people) => setDo({ ...a, people })} spaces={spaces} users={users} me={me} />}
      {a.do === 'remind' && <div className="field bm-wide"><label htmlFor={`${id}-rt`}>What the reminder says</label><input id={`${id}-rt`} className="input" maxLength={400} value={a.text} onChange={(e) => setDo({ ...a, text: e.target.value })} /></div>}
      {(a.do === 'check' || a.do === 'ask') && (
        <div className="bm-wide bm-askbot">
          {a.ask.skill ? <ChosenSkill ask={a.ask} onClear={() => setDo({ ...a, ask: { skill: '' } })} /> : <SkillBlocks exclude={def.name} onPick={(sk) => setDo({ ...a, ask: { skill: sk.id }, ...(a.do === 'check' ? { if: { var: 'result', gt: 0 } } : {}) } as BotJobAction)} />}
          {a.ask.skill && <div className="bm-grid"><SkillFields def={{ ...def, steps: [] }} ask={a.ask} onChange={(ask) => setDo({ ...a, ask })} /></div>}
        </div>
      )}
      {a.do === 'check' && a.ask.skill && (
        <fieldset className="bm-wide bm-routes">
          <legend>Only when</legend>
          <div className="bm-route">
            <select className="input" aria-label="What it gives" value={a.if.var ?? 'result'} onChange={(e) => setCond(op, condValue, e.target.value)}>
              <option value="result">The answer</option>
              {outputs.map((o) => <option key={o.id} value={`result.${o.id}`}>{o.label}</option>)}
            </select>
            <select className="input" aria-label="Test" value={op} onChange={(e) => setCond(e.target.value, condValue)}>
              <option value="gt">is more than</option><option value="lt">is less than</option><option value="eq">is</option><option value="ne">is not</option>
            </select>
            <input className="input" aria-label="Value" value={condValue} onChange={(e) => setCond(op, e.target.value)} />
          </div>
        </fieldset>
      )}
      {(a.do === 'check' || a.do === 'ask') && (
        <>
          <div className="field">
            <label htmlFor={`${id}-tell`}>Tell</label>
            <select id={`${id}-tell`} className="input" value={a.tell} onChange={(e) => setDo({ ...a, tell: e.target.value })}>
              <option value="owner">Me</option>
              <option value="lead">My lead</option>
              {spaces.map((s) => <option key={s.id} value={`space:${s.name}`}>{`The Space ${s.name}`}</option>)}
            </select>
          </div>
          <div className="field bm-wide">
            <label htmlFor={`${id}-t`}>What it says</label>
            <textarea ref={text} id={`${id}-t`} className="input" rows={2} maxLength={1000} value={a.text} onChange={(e) => setDo({ ...a, text: e.target.value })} />
            <div className="bm-insert" role="group" aria-label="Insert">
              <span className="bm-insert-label">Insert</span>
              <button type="button" className="bm-token" onClick={() => setDo({ ...a, text: insertAt(text.current, a.text, '{{result}}') })}>The answer</button>
              {outputs.map((o) => <button key={o.id} type="button" className="bm-token" onClick={() => setDo({ ...a, text: insertAt(text.current, a.text, `{{result.${o.id}}}`) })}>{o.label}</button>)}
            </div>
          </div>
        </>
      )}
      <div className="field">
        <label htmlFor={`${id}-m`}>If the hub was off at the time</label>
        <select id={`${id}-m`} className="input" value={job.missed ?? 'skip'} onChange={(e) => onChange({ ...job, missed: e.target.value === 'once' ? 'once' : undefined })}>
          <option value="skip">Skip the runs it missed</option>
          <option value="once">Catch up once when it is back</option>
        </select>
      </div>
      {(a.do === 'start' || a.do === 'remind') && <label className="check-line"><input type="checkbox" checked={job.leave !== false} onChange={(e) => onChange({ ...job, leave: e.target.checked ? undefined : false })} />Leave out people on leave that day</label>}
      <p className="faint bm-wide" style={{ margin: 0, fontSize: 12 }}>Runs on the office’s working days, never on its holidays or between 21:00 and 08:00, in office time (IST).</p>
    </div>
  );
}

export function ScheduleSection({ def, setDef, spaces, users, me, saved }: { def: BotFlowDefinition; setDef: (d: BotFlowDefinition) => void; spaces: Array<{ id: string; name: string }>; users: PublicUser[]; me: PublicUser; saved: boolean }) {
  const [open, setOpen] = useState<string | null>(def.jobs?.[0]?.id ?? null);
  const [cal, setCal] = useState<OfficeCalendar>(DEFAULT_CALENDAR);
  useEffect(() => { void window.dex.request('botjob.calendar').then((c) => setCal({ workdays: c.workdays, holidays: c.holidays, tzOffset: c.tzOffset, hours: c.hours })).catch(() => {}); }, []);
  const jobs = def.jobs ?? [];
  const set = (i: number, j: BotJob | null) => { const next = j ? jobs.map((x, k) => (k === i ? j : x)) : jobs.filter((_, k) => k !== i); const { jobs: _j, ...rest } = def; setDef(next.length ? { ...rest, jobs: next } : rest); };
  const add = () => {
    let n = 1;
    while (jobs.some((j) => j.id === `job${n}`)) n++;
    const j: BotJob = { id: `job${n}`, title: jobs.length ? `Job ${n}` : 'Weekly', when: 'every Monday at 10:00', do: { do: 'start', people: { from: 'team' } } };
    setDef({ ...def, jobs: [...jobs, j] });
    setOpen(j.id);
  };
  return (
    <div className="bm-section">
      {!jobs.length && (
        <div className="bm-block">
          <p style={{ margin: 0 }}><b>Let the bot do things on a schedule.</b> Ask your team for their hours every Friday, chase old queries every Monday, post the register on the last working day of the month.</p>
          <p className="faint" style={{ margin: 0 }}>Write when in plain words; the next runs show at once.</p>
        </div>
      )}
      {jobs.length > 0 && (
        <ol className="bm-ends" aria-label="Scheduled jobs">
          {jobs.map((j, i) => {
            const p = parseSchedule(j.when, Date.now(), cal);
            return (
              <li key={j.id} className={`bm-end${p.ok ? '' : ' bad'}`}>
                <div className="bm-end-head">
                  <span className="bm-step-no mono">{pad(i + 1)}</span>
                  <span className="bm-kind bot">JOB</span>
                  <button type="button" className="bm-end-name bm-job-toggle" aria-expanded={open === j.id} onClick={() => setOpen(open === j.id ? null : j.id)}><b translate="no">{j.title}</b><span className="faint">{` · ${p.ok ? scheduleWords(p.rule) : j.when}`}</span></button>
                  <button type="button" className="icon-btn sm" aria-label={`Remove the job ${j.title}`} onClick={() => set(i, null)}><Icon name="trash" size={14} /></button>
                </div>
                {open === j.id && <JobEditor def={def} job={j} onChange={(x) => set(i, x)} spaces={spaces} users={users} me={me} cal={cal} />}
              </li>
            );
          })}
        </ol>
      )}
      <div className="bm-add" role="group" aria-label="Scheduled jobs">
        <button type="button" className="bm-add-btn bot" disabled={jobs.length >= 8} onClick={add}><Icon name="plus" size={13} />Add a scheduled job</button>
        {saved && jobs.length > 0 && <button type="button" className="bm-add-btn" onClick={() => openJobSheet('bot', def.name)}><Icon name="schedule" size={13} />Open its job sheet</button>}
      </div>
    </div>
  );
}
