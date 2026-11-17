// 04 Afterwards: what happens to a request once it is sent. Each request gets a number and moves
// through stages; at each, one person acts (the person who asked, their lead from the directory,
// someone chosen in a question, or a person the bot names once, like the plot room) with the
// buttons drawn here: where each goes, a note when one is wanted, a stamp when it finishes it.
// Below: gentle reminders and who they are passed up to, and the register (where, and when).
import { useId, useRef, useState } from 'react';
import type { BotFlowDefinition, BotFlowStage, BotFlowStageAction, BotFlowTrack, PublicUser } from '@dex/core';
import { Icon } from '../../ui.tsx';
import { InsertChips, insertAt } from './Steps.tsx';
import { dateSteps, kindOf, personSteps, saveKeyOf } from './model.ts';
import { HandoffEditor } from './Ending.tsx';
import { botTitle, useNet } from './netdata.ts';

const pad = (n: number) => String(n).padStart(2, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TONES: Array<{ value: NonNullable<BotFlowStageAction['tone']> | ''; label: string }> = [
  { value: 'go', label: 'The main way on' }, { value: 'back', label: 'Sends it back' }, { value: 'stop', label: 'Ends it short' }, { value: '', label: 'Another way' },
];

/** A first stage that makes sense for most requests: their lead approves or turns it down. */
export function startTrack(def: BotFlowDefinition): BotFlowTrack {
  const letters = def.title.replace(/[^A-Za-z ]/g, '').split(/\s+/).filter(Boolean).map((w) => w[0]).join('').toUpperCase().slice(0, 3) || 'REQ';
  return {
    ref: letters,
    stages: [{
      id: 'approve', label: 'Approve', who: 'lead', prompt: `${def.title} from {{user}}:\n\n{{summary}}`,
      actions: [
        { id: 'ok', label: 'Approve', to: 'end', stamp: 'APPROVED', tone: 'go' },
        { id: 'no', label: 'Turn down', to: 'end', stamp: 'TURNED DOWN', outcome: 'stopped', note: 'required', ask: 'Reason', tone: 'stop' },
      ],
    }],
    remind: { afterHours: 24, times: 2, escalate: 'lead' },
  };
}

function freshId(used: string[], base: string): string {
  for (let i = 1; i < 99; i++) if (!used.includes(`${base}${i}`)) return `${base}${i}`;
  return `${base}${Date.now().toString(36)}`;
}

function WhoSelect({ def, value, onChange, id }: { def: BotFlowDefinition; value: string; onChange: (v: string) => void; id: string }) {
  const roles = Object.entries(def.track?.roles ?? {});
  const net = useNet();
  return (
    <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="requester">The person who asked</option>
      {!personSteps(def).some((s) => saveKeyOf(s) === 'lead') && <option value="lead">Their lead (from the directory)</option>}
      {personSteps(def).map((s) => <option key={s.id} value={saveKeyOf(s)}>{`The person chosen at “${s.label || s.id}”`}</option>)}
      {roles.map(([k, r]) => <option key={k} value={`role:${k}`}>{r.label}</option>)}
      <optgroup label="Another bot carries it on">
        {net.bots.filter((b) => b.name !== def.name).map((b) => <option key={b.name} value={`bot:${b.name}`}>{`The bot ${b.title}`}</option>)}
        {value.startsWith('bot:') && !net.bots.some((b) => `bot:${b.name}` === value) && <option value={value}>{`The bot ${botTitle(net, value.slice(4))}`}</option>}
      </optgroup>
    </select>
  );
}

function ActionRow({ def, stage, a, onChange, onRemove }: { def: BotFlowDefinition; stage: BotFlowStage; a: BotFlowStageAction; onChange: (a: BotFlowStageAction) => void; onRemove: (() => void) | null }) {
  const id = useId();
  const stages = def.track?.stages ?? [];
  const ends = a.to === 'end';
  return (
    <div className="bm-act">
      <div className="field"><label htmlFor={`${id}-l`}>Button</label><input id={`${id}-l`} className="input" maxLength={40} value={a.label} onChange={(e) => onChange({ ...a, label: e.target.value })} /></div>
      <div className="field">
        <label htmlFor={`${id}-to`}>Then</label>
        <select id={`${id}-to`} className="input" value={a.to} onChange={(e) => onChange({ ...a, to: e.target.value })}>
          {stages.map((s, i) => <option key={s.id} value={s.id}>{s.id === stage.id ? `This stage again (${pad(i + 1)})` : `${pad(i + 1)} ${s.label}`}</option>)}
          <option value="end">It is finished</option>
        </select>
      </div>
      {ends && <div className="field"><label htmlFor={`${id}-s`}>Stamp</label><input id={`${id}-s`} className="input mono" maxLength={24} value={a.stamp ?? ''} placeholder="DONE" onChange={(e) => onChange({ ...a, stamp: e.target.value.toUpperCase() || undefined })} /></div>}
      {ends && (
        <div className="field"><label htmlFor={`${id}-o`}>It counts as</label>
          <select id={`${id}-o`} className="input" value={a.outcome ?? (a.tone === 'stop' ? 'stopped' : 'done')} onChange={(e) => onChange({ ...a, outcome: e.target.value as 'done' })}>
            <option value="done">Done</option><option value="stopped">Stopped (turned down)</option>
          </select></div>
      )}
      <div className="field"><label htmlFor={`${id}-n`}>A note with it</label>
        <select id={`${id}-n`} className="input" value={a.note ?? ''} onChange={(e) => { const { note: _n, ...rest } = a; onChange(e.target.value ? { ...rest, note: e.target.value as 'required', ask: a.ask ?? 'Note' } : rest); }}>
          <option value="">No note</option><option value="optional">A note if they like</option><option value="required">A note is needed</option>
        </select></div>
      {a.note && <div className="field"><label htmlFor={`${id}-a`}>The note box is called</label><input id={`${id}-a`} className="input" maxLength={40} value={a.ask ?? ''} placeholder="Comments" onChange={(e) => onChange({ ...a, ask: e.target.value || undefined })} /></div>}
      <div className="field"><label htmlFor={`${id}-t`}>It is</label>
        <select id={`${id}-t`} className="input" value={a.tone ?? ''} onChange={(e) => { const { tone: _t, ...rest } = a; onChange(e.target.value ? { ...rest, tone: e.target.value as 'go' } : rest); }}>
          {TONES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select></div>
      {!!stage.checklist?.length && <label className="check-line"><input type="checkbox" checked={!!a.needsChecks} onChange={(e) => onChange({ ...a, needsChecks: e.target.checked || undefined })} />Only once the checklist is ticked</label>}
      {onRemove && <button type="button" className="icon-btn sm bm-act-x" aria-label={`Remove the button ${a.label}`} onClick={onRemove}><Icon name="trash" size={14} /></button>}
    </div>
  );
}

function StageEditor({ def, stage, onChange }: { def: BotFlowDefinition; stage: BotFlowStage; onChange: (s: BotFlowStage) => void }) {
  const id = useId();
  const prompt = useRef<HTMLTextAreaElement>(null);
  const dates = dateSteps(def);
  const choices = def.steps.filter((s) => kindOf(s.input) === 'choice');
  const by = stage.limit?.by ? def.steps.find((s) => saveKeyOf(s) === stage.limit!.by) : undefined;
  const dueValue = stage.due ? `step:${stage.due}` : stage.dueInDays !== undefined ? `days:${stage.dueInDays}` : '';
  const setAction = (i: number, a: BotFlowStageAction | null) => onChange({ ...stage, actions: a ? stage.actions.map((x, j) => (j === i ? a : x)) : stage.actions.filter((_, j) => j !== i) });
  return (
    <div className="bm-step-edit">
      <div className="field"><label htmlFor={`${id}-l`}>Stage name</label><input id={`${id}-l`} className="input" maxLength={40} value={stage.label} onChange={(e) => onChange({ ...stage, label: e.target.value })} /></div>
      <div className="field"><label htmlFor={`${id}-w`}>Who acts</label><WhoSelect id={`${id}-w`} def={def} value={stage.who} onChange={(who) => {
        const { handoff: _h, ...rest } = stage;
        onChange(who.startsWith('bot:') ? { ...rest, who, handoff: { to: who.slice(4) }, task: false } : { ...rest, who });
      }} /></div>
      {stage.who.startsWith('bot:') && (
        <fieldset className="bm-wide bm-askbot">
          <legend>Waits on another bot</legend>
          <div className="bm-grid"><HandoffEditor def={def} h={stage.handoff ?? { to: stage.who.slice(4) }} stages onChange={(h) => onChange({ ...stage, who: `bot:${h.to}`, handoff: { ...h, ...(stage.handoff?.back ? { back: stage.handoff.back } : {}) } })} /></div>
          <span className="bm-hint">The request is handed to that bot when it reaches this stage, and no one has it here meanwhile. When the other bot’s request closes, the main button of this stage is pressed for it (or the one that ends it short, when it was turned down), with the other bot’s stamp as the note.</span>
        </fieldset>
      )}
      <div className="field bm-wide">
        <label htmlFor={`${id}-p`}>What they are asked</label>
        <textarea ref={prompt} id={`${id}-p`} className="input" rows={3} maxLength={1000} value={stage.prompt} onChange={(e) => onChange({ ...stage, prompt: e.target.value })} />
        <div className="bm-insert-row">
          <InsertChips def={def} onInsert={(t) => onChange({ ...stage, prompt: insertAt(prompt.current, stage.prompt, t) })} />
          <button type="button" className="bm-token" onClick={() => onChange({ ...stage, prompt: insertAt(prompt.current, stage.prompt, '{{note}}') })}>The last note</button>
        </div>
      </div>
      <div className="field">
        <label htmlFor={`${id}-d`}>Due</label>
        <select id={`${id}-d`} className="input" value={dueValue} onChange={(e) => {
          const v = e.target.value;
          const { due: _d, dueInDays: _n, ...rest } = stage;
          onChange(v.startsWith('step:') ? { ...rest, due: v.slice(5) } : v.startsWith('days:') ? { ...rest, dueInDays: Number(v.slice(5)) } : rest);
        }}>
          <option value="">No due date</option>
          {dates.map((s) => <option key={s.id} value={`step:${saveKeyOf(s)}`}>{`On the day answered at “${s.label || s.id}”`}</option>)}
          {[1, 2, 3, 5, 7, 14].map((n) => <option key={n} value={`days:${n}`}>{n === 1 ? 'A day after it arrives' : `${n} days after it arrives`}</option>)}
        </select>
      </div>
      <label className="check-line"><input type="checkbox" checked={stage.task ?? stage.who !== 'requester'} onChange={(e) => onChange({ ...stage, task: e.target.checked })} />A task on their Desk</label>
      <div className="field bm-wide">
        <label htmlFor={`${id}-c`}>Checklist they tick (one line each; leave empty for none)</label>
        <textarea id={`${id}-c`} className="input" rows={3} value={(stage.checklist ?? []).join('\n')} placeholder={'Safety shoes and helmet\nGate pass'}
          onChange={(e) => { const list = e.target.value.split('\n').map((x) => x.trimStart()).slice(0, 12); const { checklist: _c, ...rest } = stage; onChange(list.some((x) => x.trim()) ? { ...rest, checklist: list } : { ...rest, actions: rest.actions.map(({ needsChecks: _n, ...a }) => a) }); }} />
      </div>
      <fieldset className="bm-wide">
        <legend>Places at once</legend>
        <label className="check-line"><input type="checkbox" checked={!!stage.limit} onChange={(e) => { const { limit: _l, ...rest } = stage; onChange(e.target.checked ? { ...rest, limit: { seats: {}, otherwise: 1 } } : rest); }} />Only so many at once; the rest wait in line and see their place</label>
        {stage.limit && (
          <>
            <div className="field"><label htmlFor={`${id}-by`}>Counted for each answer to</label>
              <select id={`${id}-by`} className="input" value={stage.limit.by ?? ''} onChange={(e) => onChange({ ...stage, limit: { ...stage.limit!, by: e.target.value || undefined, seats: {} } })}>
                <option value="">All together</option>
                {choices.map((s) => <option key={s.id} value={saveKeyOf(s)}>{`“${s.label || s.id}”`}</option>)}
              </select></div>
            {by?.input.options?.map((o) => (
              <div key={o.value} className="field bm-seat"><label htmlFor={`${id}-seat-${o.value}`} translate="no">{o.label}</label>
                <input id={`${id}-seat-${o.value}`} className="input" type="number" min={0} max={999} value={stage.limit!.seats[o.label] ?? stage.limit!.otherwise}
                  onChange={(e) => onChange({ ...stage, limit: { ...stage.limit!, seats: { ...stage.limit!.seats, [o.label]: Math.max(0, Number(e.target.value) || 0) } } })} /></div>
            ))}
            {!by && <div className="field bm-seat"><label htmlFor={`${id}-all`}>Places</label><input id={`${id}-all`} className="input" type="number" min={1} max={999} value={stage.limit.otherwise} onChange={(e) => onChange({ ...stage, limit: { ...stage.limit!, otherwise: Math.max(1, Number(e.target.value) || 1) } })} /></div>}
          </>
        )}
      </fieldset>
      <fieldset className="bm-wide">
        <legend>Buttons</legend>
        {stage.actions.map((a, i) => <ActionRow key={i} def={def} stage={stage} a={a} onChange={(x) => setAction(i, x)} onRemove={stage.actions.length > 1 ? () => setAction(i, null) : null} />)}
        {stage.actions.length < 5 && (
          <button type="button" className="btn ghost sm" onClick={() => onChange({ ...stage, actions: [...stage.actions, { id: freshId(stage.actions.map((x) => x.id), 'b'), label: 'Done', to: 'end', stamp: 'DONE' }] })}><Icon name="plus" size={14} />Add a button</button>
        )}
      </fieldset>
    </div>
  );
}

function People({ def, setTrack, users, meName }: { def: BotFlowDefinition; setTrack: (t: BotFlowTrack) => void; users: PublicUser[]; meName: string }) {
  const t = def.track!;
  const roles = Object.entries(t.roles ?? {});
  const set = (roles: NonNullable<BotFlowTrack['roles']>) => setTrack({ ...t, roles: Object.keys(roles).length ? roles : undefined });
  return (
    <fieldset className="bm-block">
      <legend className="bm-legend">People it names</legend>
      <p className="bm-hint" style={{ margin: 0 }}>{`Named once here, like the plot room or document control. Until you choose someone, it comes to you (${meName}).`}</p>
      {roles.map(([k, r]) => (
        <div key={k} className="bm-role">
          <input className="input" aria-label="Role name" maxLength={40} value={r.label} onChange={(e) => set({ ...t.roles, [k]: { ...r, label: e.target.value } })} />
          <select className="input" aria-label={`Who is ${r.label}`} value={r.person ?? ''} onChange={(e) => set({ ...t.roles, [k]: e.target.value ? { ...r, person: e.target.value } : { label: r.label } })}>
            <option value="">{`Not chosen: comes to you`}</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
          </select>
          <button type="button" className="icon-btn sm" aria-label={`Remove ${r.label}`} disabled={t.stages.some((s) => s.who === `role:${k}`) || t.remind?.escalate === `role:${k}` || t.register?.to === `role:${k}`}
            onClick={() => { const { [k]: _gone, ...rest } = t.roles ?? {}; set(rest); }}><Icon name="trash" size={14} /></button>
        </div>
      ))}
      <button type="button" className="btn ghost sm" style={{ justifySelf: 'start' }} onClick={() => set({ ...t.roles, [freshId(roles.map(([k]) => k), 'role')]: { label: 'Reviewer' } })}><Icon name="plus" size={14} />Add a person it names</button>
    </fieldset>
  );
}

export function LifecycleSection({ def, setDef, problems, users, me }: { def: BotFlowDefinition; setDef: (d: BotFlowDefinition) => void; problems: string[]; users: PublicUser[]; me: PublicUser }) {
  const id = useId();
  const [open, setOpen] = useState<string | null>(null);
  const name = useRef<HTMLInputElement>(null);
  const t = def.track;
  const people = users.filter((u) => u.role !== 'bot');
  if (!t) {
    return (
      <div className="bm-section">
        <div className="bm-block bm-track-off">
          <p style={{ margin: 0 }}><b>Carry each request on after it is sent.</b> It gets a number, goes to the people who act on it (approve, check, plot, issue), and the person who asked sees it move on the card they already have.</p>
          <p className="bm-hint" style={{ margin: 0 }}>Reminders are few and polite, and a register card shows what is open. Without this, the bot ends with what is set under At the end.</p>
          <button type="button" className="btn primary" style={{ justifySelf: 'start' }} onClick={() => { setDef({ ...def, track: startTrack(def) }); setOpen('approve'); }}><Icon name="plus" size={15} />Track each request</button>
        </div>
      </div>
    );
  }
  const setTrack = (x: BotFlowTrack | undefined) => { const { track: _t, ...rest } = def; setDef(x ? { ...rest, track: x } : rest); };
  const setStage = (i: number, s: BotFlowStage | null) => setTrack({ ...t, stages: s ? t.stages.map((x, j) => (j === i ? s : x)) : t.stages.filter((_, j) => j !== i).map((x) => ({ ...x, actions: x.actions.map((a) => (a.to === t.stages[i].id ? { ...a, to: 'end' } : a)) })) });
  const move = (i: number, by: number) => { const list = [...t.stages]; const [x] = list.splice(i, 1); list.splice(i + by, 0, x); setTrack({ ...t, stages: list }); };
  const remind = t.remind ?? { afterHours: 24, times: 2, escalate: 'lead' };
  const reg = t.register ?? {};
  const roles = Object.entries(t.roles ?? {});
  const net = useNet();
  const whoWords = (who: string) => (who === 'requester' ? 'The person who asked' : who.startsWith('bot:') ? `The bot ${botTitle(net, who.slice(4))}` : who.startsWith('role:') ? t.roles?.[who.slice(5)]?.label ?? who : personSteps(def).find((s) => saveKeyOf(s) === who)?.label ?? (who === 'lead' ? 'Their lead' : who));
  return (
    <div className="bm-section">
      {problems.length > 0 && <div className="bm-problem" role="note"><Icon name="warning" size={14} /><span>{problems.join(' ')}</span></div>}
      <div className="bm-grid">
        <div className="field">
          <label htmlFor={`${id}-ref`}>Each request is numbered</label>
          <span className="bm-ref"><input id={`${id}-ref`} className="input mono" maxLength={4} value={t.ref} onChange={(e) => setTrack({ ...t, ref: e.target.value.replace(/[^A-Za-z]/g, '').toUpperCase() })} /><span className="mono faint" aria-hidden="true">-0001</span></span>
        </div>
        <div className="field">
          <label htmlFor={`${id}-name`}>Its name in the register</label>
          <input ref={name} id={`${id}-name`} className="input" maxLength={200} value={t.name ?? ''} placeholder="{{job}} · {{drawings}}" onChange={(e) => setTrack({ ...t, name: e.target.value || undefined })} />
        </div>
        <div className="bm-wide"><InsertChips def={def} summary={false} onInsert={(x) => setTrack({ ...t, name: insertAt(name.current, t.name ?? '', x) })} /></div>
      </div>

      <People def={def} setTrack={setTrack} users={people} meName={me.displayName} />

      <ol className="bm-steps bm-stages" aria-label="Stages">
        {t.stages.map((s, i) => (
          <li key={s.id} id={`bm-stage-${s.id}`} className={`bm-step${open === s.id ? ' open' : ''}`}>
            <div className="bm-step-row">
              <button type="button" className="bm-step-head" aria-expanded={open === s.id} aria-controls={`bm-stage-${s.id}-edit`} onClick={() => setOpen(open === s.id ? null : s.id)}>
                <span className="bm-step-no mono">{pad(i + 1)}</span>
                <span className="bm-kind">STAGE</span>
                <span className="bm-step-q">{s.label || '—'}<span className="faint bm-stage-who">{` · ${whoWords(s.who)}`}</span></span>
                <span className="bm-step-route mono">{s.actions.map((a) => a.label).join(' / ')}</span>
              </button>
              <span className="bm-step-tools">
                <button type="button" className="icon-btn sm" aria-label={`Move ${s.label} up`} disabled={i === 0} onClick={() => move(i, -1)}><Icon name="chevron" size={14} className="flip" /></button>
                <button type="button" className="icon-btn sm" aria-label={`Move ${s.label} down`} disabled={i === t.stages.length - 1} onClick={() => move(i, 1)}><Icon name="chevron" size={14} /></button>
                <button type="button" className="icon-btn sm" aria-label={`Remove ${s.label}`} disabled={t.stages.length === 1} onClick={() => setStage(i, null)}><Icon name="trash" size={14} /></button>
              </span>
            </div>
            {open === s.id && <div id={`bm-stage-${s.id}-edit`}><StageEditor def={def} stage={s} onChange={(x) => setStage(i, x)} /></div>}
          </li>
        ))}
      </ol>
      <div className="bm-add" role="group" aria-label="Add a stage">
        <span className="bm-add-label">Add</span>
        <button type="button" className="bm-add-btn" onClick={() => { const sid = freshId(t.stages.map((x) => x.id), 's'); setTrack({ ...t, stages: [...t.stages, { id: sid, label: 'Check', who: 'requester', prompt: 'Have a look: {{summary}}', actions: [{ id: 'ok', label: 'Done', to: 'end', stamp: 'DONE', tone: 'go' }] }] }); setOpen(sid); }}><Icon name="plus" size={13} />Stage</button>
      </div>

      <fieldset className="bm-block">
        <legend className="bm-legend">Reminders</legend>
        <div className="bm-grid">
          <div className="field"><label htmlFor={`${id}-ah`}>When it waits this long</label>
            <select id={`${id}-ah`} className="input" value={remind.afterHours} onChange={(e) => setTrack({ ...t, remind: { ...remind, afterHours: Number(e.target.value) } })}>
              {[2, 4, 8, 24, 48, 72].map((h) => <option key={h} value={h}>{h < 24 ? `${h} hours` : h === 24 ? '1 day' : `${h / 24} days`}</option>)}
            </select></div>
          <div className="field"><label htmlFor={`${id}-ti`}>Remind them</label>
            <select id={`${id}-ti`} className="input" value={remind.times} onChange={(e) => setTrack({ ...t, remind: { ...remind, times: Number(e.target.value) } })}>
              {[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n === 0 ? 'Never' : n === 1 ? 'Once' : n === 2 ? 'Twice' : 'Three times'}</option>)}
            </select></div>
          <div className="field bm-wide"><label htmlFor={`${id}-es`}>After that, tell (once)</label>
            <select id={`${id}-es`} className="input" value={remind.escalate ?? 'lead'} onChange={(e) => setTrack({ ...t, remind: { ...remind, escalate: e.target.value } })}>
              <option value="lead">The lead of the person it waits for</option>
              {roles.map(([k, r]) => <option key={k} value={`role:${k}`}>{r.label}</option>)}
              <option value="none">No one</option>
            </select></div>
        </div>
        <p className="bm-hint" style={{ margin: 0 }}>Reminders come in working hours only, gathered into one list for each person. Someone out of office is not reminded.</p>
      </fieldset>

      <fieldset className="bm-block">
        <legend className="bm-legend">Register</legend>
        <div className="bm-grid">
          <div className="field"><label htmlFor={`${id}-rt`}>Post it to</label>
            <select id={`${id}-rt`} className="input" value={reg.at ? reg.to ?? 'owner' : ''} onChange={(e) => {
              const v = e.target.value;
              if (!v) { const { at: _a, to: _t, ...rest } = reg; setTrack({ ...t, register: Object.keys(rest).length ? rest : undefined }); return; }
              setTrack({ ...t, register: { ...reg, to: v, at: reg.at ?? '09:15', days: reg.days ?? [1, 2, 3, 4, 5] } });
            }}>
              <option value="">Only when someone asks for it</option>
              <option value="owner">You</option>
              {roles.map(([k, r]) => <option key={k} value={`role:${k}`}>{r.label}</option>)}
              {reg.to?.startsWith('space:') && <option value={reg.to}>{`The Space ${reg.to.slice(6)}`}</option>}
            </select></div>
          {reg.at && <div className="field"><label htmlFor={`${id}-ra`}>At</label><input id={`${id}-ra`} className="input mono" type="time" value={reg.at} onChange={(e) => setTrack({ ...t, register: { ...reg, at: e.target.value || '09:15' } })} /></div>}
          {reg.at && (
            <div className="bm-wide bm-days" role="group" aria-label="On these days">
              {DAYS.map((d, i) => <button key={d} type="button" className="bm-day" aria-pressed={(reg.days ?? []).includes(i)} onClick={() => { const days = reg.days ?? []; setTrack({ ...t, register: { ...reg, days: days.includes(i) ? days.filter((x) => x !== i) : [...days, i].sort() } }); }}>{d}</button>)}
            </div>
          )}
        </div>
        <p className="bm-hint" style={{ margin: 0 }}>One card that replaces the one before, posted only when something is open. Anyone involved can ask for it by writing “register” to the bot.</p>
      </fieldset>
      <button type="button" className="btn ghost danger" style={{ justifySelf: 'start' }} onClick={() => setTrack(undefined)}>Stop tracking requests</button>
    </div>
  );
}
