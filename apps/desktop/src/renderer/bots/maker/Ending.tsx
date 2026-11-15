// 03 At the end: what happens once the last question is answered — a task on someone's Desk, a post
// in a Space, a reminder for the person who answered (and, for administrators, the integration's
// webhook) — and the bot's closing line.
import { useId, useRef } from 'react';
import type { BotFlowAction, BotFlowDefinition } from '@dex/core';
import { voiceOf } from '@dex/core/botflows';
import { Icon } from '../../ui.tsx';
import { dateSteps, personSteps, saveKeyOf } from './model.ts';
import { InsertChips, insertAt } from './Steps.tsx';

const WORDS: Record<BotFlowAction['do'], { tag: string; name: string }> = {
  task: { tag: 'TASK', name: 'A task on someone’s Desk' },
  post: { tag: 'POST', name: 'A post in a Space' },
  remind: { tag: 'REMIND', name: 'A reminder for the person who answered' },
  webhook: { tag: 'WEBHOOK', name: 'Call the integration’s webhook' },
};

function Due({ def, a, onChange }: { def: BotFlowDefinition; a: Extract<BotFlowAction, { do: 'task' | 'remind' }>; onChange: (a: BotFlowAction) => void }) {
  const id = useId();
  const dates = dateSteps(def);
  const value = a.due ? `step:${a.due}` : `days:${a.dueInDays ?? 1}`;
  return (
    <div className="field">
      <label htmlFor={`${id}-due`}>Due</label>
      <select id={`${id}-due`} className="input" value={value} onChange={(e) => {
        const v = e.target.value;
        const { due: _d, dueInDays: _n, ...rest } = a;
        onChange(v.startsWith('step:') ? { ...rest, due: v.slice(5) } : { ...rest, dueInDays: Number(v.slice(5)) });
      }}>
        {dates.map((s) => <option key={s.id} value={`step:${saveKeyOf(s)}`}>On the day answered at “{s.label || s.id}”</option>)}
        {[0, 1, 2, 3, 5, 7, 14].map((n) => <option key={n} value={`days:${n}`}>{n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : `In ${n} days`}</option>)}
      </select>
    </div>
  );
}

function ActionEditor({ def, a, onChange, spaces }: { def: BotFlowDefinition; a: BotFlowAction; onChange: (a: BotFlowAction) => void; spaces: string[] }) {
  const id = useId();
  const text = useRef<HTMLTextAreaElement>(null);
  const people = personSteps(def);
  if (a.do === 'webhook') return <p className="faint bm-wide" style={{ margin: 0 }}>Every answer is sent, signed, to the integration’s webhook (Control room → Integrations).</p>;
  const textField = (
    <div className="field bm-wide">
      <label htmlFor={`${id}-text`}>{a.do === 'post' ? 'What it posts' : a.do === 'task' ? 'What the task says' : 'What the reminder says'}</label>
      <textarea ref={text} id={`${id}-text`} className="input" rows={a.do === 'post' ? 3 : 2} maxLength={a.do === 'post' ? 4000 : 500} value={a.text} onChange={(e) => onChange({ ...a, text: e.target.value })} />
      <InsertChips def={def} onInsert={(t) => onChange({ ...a, text: insertAt(text.current, a.text, t) })} />
    </div>
  );
  if (a.do === 'task') {
    return (
      <>
        <div className="field">
          <label htmlFor={`${id}-who`}>For the person chosen at</label>
          <select id={`${id}-who`} className="input" value={a.assignee} onChange={(e) => onChange({ ...a, assignee: e.target.value })}>
            {!people.some((s) => saveKeyOf(s) === a.assignee) && <option value={a.assignee}>Choose a question…</option>}
            {people.map((s) => <option key={s.id} value={saveKeyOf(s)}>“{s.label || s.id}”</option>)}
          </select>
          {!people.length && <span className="bm-hint">Add a question whose answer is a person first.</span>}
        </div>
        <Due def={def} a={a} onChange={onChange} />
        {textField}
      </>
    );
  }
  if (a.do === 'remind') return <><Due def={def} a={a} onChange={onChange} />{textField}</>;
  return (
    <>
      <div className="field bm-wide">
        <label htmlFor={`${id}-to`}>Where</label>
        <select id={`${id}-to`} className="input" value={a.to} onChange={(e) => onChange({ ...a, to: e.target.value as 'origin' })}>
          <option value="origin">The Space it was started from (if any)</option>
          {spaces.map((n) => <option key={n} value={`space:${n}`}>The Space {n}</option>)}
          {a.to.startsWith('space:') && !spaces.includes(a.to.slice(6)) && <option value={a.to}>The Space {a.to.slice(6)}</option>}
          {people.map((s) => <option key={s.id} value={`person:${saveKeyOf(s)}`}>A message to the person chosen at “{s.label || s.id}”</option>)}
        </select>
      </div>
      {textField}
    </>
  );
}

export function EndingSection({ def, setDef, problems, admin, spaces }: { def: BotFlowDefinition; setDef: (d: BotFlowDefinition) => void; problems: Record<number, string[]>; admin: boolean; spaces: string[] }) {
  const id = useId();
  const done = useRef<HTMLTextAreaElement>(null);
  const set = (i: number, a: BotFlowAction | null) => setDef({ ...def, finish: a ? def.finish.map((x, j) => (j === i ? a : x)) : def.finish.filter((_, j) => j !== i) });
  const people = personSteps(def);
  const add = (kind: BotFlowAction['do']) => {
    const a: BotFlowAction = kind === 'task' ? { do: 'task', assignee: people[0] ? saveKeyOf(people[0]) : '', text: `${def.title} from {{user}}`, dueInDays: 1 }
      : kind === 'post' ? { do: 'post', to: 'origin', text: `**${def.title}** from {{user}}\n\n{{summary}}` }
        : kind === 'remind' ? { do: 'remind', text: `Follow up: ${def.title}`, dueInDays: 1 } : { do: 'webhook' };
    setDef({ ...def, finish: [...def.finish, a] });
  };
  return (
    <div className="bm-section">
      <ol className="bm-ends" aria-label="What happens at the end">
        {def.finish.map((a, i) => (
          <li key={i} className={`bm-end${problems[i] ? ' bad' : ''}`}>
            <div className="bm-end-head">
              <span className="bm-step-no mono">{String(i + 1).padStart(2, '0')}</span>
              <span className="bm-kind">{WORDS[a.do].tag}</span>
              <span className="bm-end-name">{WORDS[a.do].name}</span>
              <button type="button" className="icon-btn sm" aria-label={`Remove: ${WORDS[a.do].name}`} onClick={() => set(i, null)}><Icon name="trash" size={14} /></button>
            </div>
            {problems[i] && <div className="bm-problem" role="note"><Icon name="warning" size={14} /><span>{problems[i].join(' ')}</span></div>}
            <div className="bm-step-edit"><ActionEditor def={def} a={a} onChange={(x) => set(i, x)} spaces={spaces} /></div>
          </li>
        ))}
        {!def.finish.length && <li className="bm-end empty faint">Nothing happens yet. Add what it should do.</li>}
      </ol>
      <div className="bm-add" role="group" aria-label="Add what happens at the end">
        <span className="bm-add-label">Add</span>
        <button type="button" className="bm-add-btn" onClick={() => add('task')}><Icon name="plus" size={13} />Desk task</button>
        <button type="button" className="bm-add-btn" onClick={() => add('post')}><Icon name="plus" size={13} />Post</button>
        <button type="button" className="bm-add-btn" onClick={() => add('remind')}><Icon name="plus" size={13} />Reminder</button>
        {admin && <button type="button" className="bm-add-btn" onClick={() => add('webhook')}><Icon name="plus" size={13} />Webhook</button>}
      </div>
      <div className="field bm-closing">
        <label htmlFor={`${id}-done`}>Closing line</label>
        <textarea ref={done} id={`${id}-done`} className="input" rows={2} maxLength={2000} value={def.done ?? ''} placeholder={voiceOf(def.persona?.tone).done}
          onChange={(e) => setDef({ ...def, done: e.target.value || undefined })} />
        <InsertChips def={def} onInsert={(t) => setDef({ ...def, done: insertAt(done.current, def.done ?? '', t) })} />
      </div>
    </div>
  );
}
