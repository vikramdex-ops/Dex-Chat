// Editing one part of a rule: its kind and its details, with the {{variables}} a step can use.
import { useRef, useState } from 'react';
import type { ActionKind, ActionNode, ConditionKind, ConditionNode, FlowGraph, PersonRef, TriggerKind, TriggerNode } from '@dex/core';
import { unsafeRegex, variablesAt } from '@dex/core';
import { Icon, Segmented } from '../ui.tsx';
import { ACTION_LABEL, CONDITION_LABEL, ROLE_LABEL, TRIGGER_LABEL, blankAction, blankCondition, blankTrigger } from './labels.ts';

export interface PickLists {
  people: Array<{ id: string; name: string }>;
  groups: Array<{ id: string; name: string }>;
  spaces: Array<{ id: string; name: string }>;
}

const FILE_TYPES = ['pdf', 'dwg', 'dxf', 'xlsx', 'docx', 'ifc', 'png', 'jpg', 'zip'];
const QUICK_EMOJI = ['✅', '👍', '👀', '❗', '🚩', '⭐', '📌', '🔥'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DUE = [0, 30, 60, 120, 240, 1440, 2880, 10080];
const dueLabel = (m: number) => (m === 0 ? 'At once' : m < 60 ? `In ${m} minutes` : m < 1440 ? `In ${m / 60} hour${m === 60 ? '' : 's'}` : m < 10080 ? `In ${m / 1440} day${m === 1440 ? '' : 's'}` : 'In a week');

function PeoplePicker({ value, onChange, lists, roles, label }: {
  value: PersonRef[]; onChange: (v: PersonRef[]) => void; lists: PickLists; roles: Array<'author' | 'actor' | 'owner'>; label: string;
}) {
  const [q, setQ] = useState('');
  const name = (r: PersonRef) => (r.kind === 'user' ? lists.people.find((p) => p.id === r.id)?.name ?? 'Someone who left'
    : r.kind === 'group' ? `${lists.groups.find((g) => g.id === r.id)?.name ?? 'A removed group'}` : ROLE_LABEL[r.id]);
  const has = (r: PersonRef) => value.some((v) => v.kind === r.kind && v.id === r.id);
  const needle = q.trim().toLowerCase();
  const options: Array<{ ref: PersonRef; text: string; hint: string }> = needle ? [
    ...lists.groups.filter((g) => g.name.toLowerCase().includes(needle)).map((g) => ({ ref: { kind: 'group', id: g.id } as PersonRef, text: g.name, hint: 'Group' })),
    ...lists.people.filter((p) => p.name.toLowerCase().includes(needle)).map((p) => ({ ref: { kind: 'user', id: p.id } as PersonRef, text: p.name, hint: 'Person' })),
  ].filter((o) => !has(o.ref)).slice(0, 8) : [];
  const add = (r: PersonRef) => { onChange([...value, r]); setQ(''); };
  return (
    <div className="field fl-people">
      <label>{label}</label>
      <div className="fl-chips">
        {value.map((r) => (
          <span key={`${r.kind}:${r.id}`} className={`fl-chip ${r.kind}`}>
            <span translate={r.kind === 'role' ? undefined : 'no'}>{name(r)}</span>
            <button type="button" aria-label={`Remove ${name(r)}`} onClick={() => onChange(value.filter((v) => !(v.kind === r.kind && v.id === r.id)))}><Icon name="x" size={12} /></button>
          </span>
        ))}
        {roles.filter((r) => !has({ kind: 'role', id: r })).map((r) => (
          <button key={r} type="button" className="fl-chip add" onClick={() => add({ kind: 'role', id: r })}><Icon name="plus" size={12} />{ROLE_LABEL[r]}</button>
        ))}
      </div>
      <input className="input" placeholder="Add a person or group" aria-label={`${label}: add a person or group`} value={q} onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && options[0]) { e.preventDefault(); add(options[0].ref); } }} />
      {options.length > 0 && (
        <div className="fl-options" role="listbox" aria-label="Matches">
          {options.map((o) => (
            <button key={`${o.ref.kind}:${o.ref.id}`} type="button" role="option" aria-selected="false" onClick={() => add(o.ref)}>
              <span translate="no">{o.text}</span><span className="fl-hint">{o.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TypesField({ value, onChange }: { value: string[] | undefined; onChange: (v: string[] | undefined) => void }) {
  const [extra, setExtra] = useState('');
  const set = new Set(value ?? []);
  const toggle = (t: string) => { const n = new Set(set); if (n.has(t)) n.delete(t); else n.add(t); onChange(n.size ? [...n] : undefined); };
  return (
    <div className="field">
      <label>File types</label>
      <div className="fl-chips">
        {[...new Set([...FILE_TYPES, ...set])].map((t) => (
          <button key={t} type="button" className={`fl-type${set.has(t) ? ' on' : ''}`} aria-pressed={set.has(t)} onClick={() => toggle(t)}>.{t}</button>
        ))}
        <input className="input fl-type-extra" placeholder="other, e.g. rvt" aria-label="Another file type" value={extra} onChange={(e) => setExtra(e.target.value.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 10))}
          onKeyDown={(e) => { if (e.key === 'Enter' && extra) { e.preventDefault(); toggle(extra); setExtra(''); } }} />
      </div>
      <span className="faint fl-help">{set.size ? `Only ${[...set].map((t) => `.${t}`).join(', ')} files.` : 'Any file type.'}</span>
    </div>
  );
}

/** A text box for a message with the variables it may use, inserted where the cursor is. */
function TemplateField({ label, value, onChange, vars, rows = 4, placeholder }: { label: string; value: string; onChange: (v: string) => void; vars: string[]; rows?: number; placeholder?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const insert = (v: string) => {
    const el = ref.current;
    const token = `{{${v}}}`;
    if (!el) { onChange(value + token); return; }
    const s = el.selectionStart ?? value.length;
    const e = el.selectionEnd ?? value.length;
    onChange(value.slice(0, s) + token + value.slice(e));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + token.length, s + token.length); });
  };
  return (
    <div className="field">
      <label>{label}</label>
      <textarea ref={ref} className="input fl-text" rows={rows} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} aria-label={label} />
      <div className="fl-vars" aria-label="Insert a value">
        {vars.map((v) => <button key={v} type="button" className="fl-var" onClick={() => insert(v)} translate="no">{`{{${v}}}`}</button>)}
      </div>
    </div>
  );
}

export function NodeEditor({ graph, nodeId, onChange, lists, readOnly, onRemove, onMove, allowLan }: {
  graph: FlowGraph;
  nodeId: string;
  onChange: (g: FlowGraph) => void;
  lists: PickLists;
  readOnly: boolean;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
  allowLan: boolean | null;
}) {
  const isTrigger = graph.trigger.id === nodeId;
  const ci = graph.conditions.findIndex((c) => c.id === nodeId);
  const ai = graph.actions.findIndex((a) => a.id === nodeId);
  if (!isTrigger && ci < 0 && ai < 0) return null;

  const setTrigger = (t: TriggerNode) => onChange({ ...graph, trigger: t });
  const setCond = (c: ConditionNode) => onChange({ ...graph, conditions: graph.conditions.map((x, i) => (i === ci ? c : x)) });
  const setAction = (a: ActionNode) => onChange({ ...graph, actions: graph.actions.map((x, i) => (i === ai ? a : x)) });

  let body: React.ReactNode = null;
  let kindSelect: React.ReactNode = null;
  let heading = '';

  if (isTrigger) {
    const t = graph.trigger;
    heading = `${t.id.toUpperCase()} · When`;
    kindSelect = (
      <select className="input" aria-label="What starts the rule" value={t.kind} onChange={(e) => setTrigger({ ...blankTrigger(e.target.value as TriggerKind), id: t.id })}>
        {(Object.keys(TRIGGER_LABEL) as TriggerKind[]).map((k) => <option key={k} value={k}>{TRIGGER_LABEL[k]}</option>)}
      </select>
    );
    if (t.kind === 'file.added') body = (<>
      <TypesField value={t.types} onChange={(types) => setTrigger({ ...t, types })} />
      <div className="field"><label>Name pattern</label><input className="input" aria-label="Name pattern" placeholder="e.g. GA-*.pdf, or a word in the name" value={t.namePattern ?? ''} onChange={(e) => setTrigger({ ...t, namePattern: e.target.value || undefined })} /></div>
    </>);
    if (t.kind === 'reaction.added') body = (<>
      <div className="field">
        <label>Reaction</label>
        <div className="fl-chips">
          {QUICK_EMOJI.map((e) => <button key={e} type="button" className={`fl-emoji${t.emoji === e ? ' on' : ''}`} aria-pressed={t.emoji === e} onClick={() => setTrigger({ ...t, emoji: e })}>{e}</button>)}
          <input className="input fl-emoji-in" aria-label="Reaction" placeholder=":office-emoji:" value={QUICK_EMOJI.includes(t.emoji) ? '' : t.emoji} onChange={(e) => setTrigger({ ...t, emoji: e.target.value.trim() })} />
        </div>
      </div>
      <PeoplePicker label="Only on messages written by (leave empty for anyone)" value={t.by ?? []} onChange={(by) => setTrigger({ ...t, ...(by.length ? { by } : { by: undefined }) })} lists={lists} roles={['owner']} />
    </>);
    if (t.kind === 'response.confirmed') body = (<>
      <div className="field"><label>Responses to</label>
        <Segmented<'any' | 'poll' | 'form'> label="Responses to" value={t.source ?? 'any'} onChange={(source) => setTrigger({ ...t, source })} options={[{ value: 'any', label: 'Polls and forms' }, { value: 'poll', label: 'Polls' }, { value: 'form', label: 'Forms' }]} />
      </div>
      <div className="field"><label>Only this choice (leave empty for any)</label><input className="input" aria-label="Only this choice" placeholder="e.g. Yes" value={t.choice ?? ''} onChange={(e) => setTrigger({ ...t, choice: e.target.value || undefined })} />
        <span className="faint fl-help">For a form, the choice is the answer to its first multiple-choice question.</span></div>
    </>);
    if (t.kind === 'message.matched') {
      const why = t.mode === 'regex' && t.pattern ? unsafeRegex(t.pattern) : null;
      body = (<>
        <div className="field"><label>Look for</label>
          <Segmented<'keywords' | 'regex'> label="Look for" value={t.mode} onChange={(mode) => setTrigger({ ...t, mode })} options={[{ value: 'keywords', label: 'Words' }, { value: 'regex', label: 'A pattern' }]} />
        </div>
        <div className="field"><label>{t.mode === 'regex' ? 'Regular expression' : 'Words or phrases, separated by commas'}</label>
          <input className={`input mono${why ? ' fl-invalid' : ''}`} aria-label={t.mode === 'regex' ? 'Regular expression' : 'Words to look for'} placeholder={t.mode === 'regex' ? 'e.g. RFI-\\d{3,5}' : 'e.g. urgent, stop work'} value={t.pattern} maxLength={200} onChange={(e) => setTrigger({ ...t, pattern: e.target.value })} />
          <span className={`fl-help ${why ? 'fl-warn' : 'faint'}`}>{why ?? (t.mode === 'regex' ? 'Groups become {{match.1}}, {{match.2}}…' : 'Whole words, any capitals.')}</span>
        </div>
        <label className="fl-check"><input type="checkbox" checked={t.caseSensitive === true} onChange={(e) => setTrigger({ ...t, caseSensitive: e.target.checked || undefined })} /> Capitals must match</label>
      </>);
    }
    if (t.kind === 'message.mentioned') body = <PeoplePicker label="Mentioning any of" value={t.targets} onChange={(targets) => setTrigger({ ...t, targets })} lists={lists} roles={['owner']} />;
  } else if (ci >= 0) {
    const c = graph.conditions[ci];
    heading = `${c.id.toUpperCase()} · Only if`;
    kindSelect = (
      <select className="input" aria-label="What to check" value={c.kind} onChange={(e) => setCond(blankCondition(e.target.value as ConditionKind, c.id))}>
        {(Object.keys(CONDITION_LABEL) as ConditionKind[]).map((k) => <option key={k} value={k}>{CONDITION_LABEL[k]}</option>)}
      </select>
    );
    if (c.kind === 'conversation') body = (
      <div className="field"><label>Spaces</label>
        <div className="fl-chips">
          {lists.spaces.map((s) => { const on = c.convIds.includes(s.id); return <button key={s.id} type="button" className={`fl-type${on ? ' on' : ''}`} aria-pressed={on} onClick={() => setCond({ ...c, convIds: on ? c.convIds.filter((x) => x !== s.id) : [...c.convIds, s.id] })} translate="no"># {s.name}</button>; })}
        </div>
      </div>
    );
    if (c.kind === 'author') body = (<>
      <PeoplePicker label={c.exclude ? 'Not when it is' : 'Only when it is'} value={c.people} onChange={(people) => setCond({ ...c, people })} lists={lists} roles={['owner']} />
      <label className="fl-check"><input type="checkbox" checked={c.exclude === true} onChange={(e) => setCond({ ...c, exclude: e.target.checked || undefined })} /> Leave these people out instead</label>
      <span className="faint fl-help">The person who wrote, reacted or answered.</span>
    </>);
    if (c.kind === 'time') body = (<>
      <div className="field"><label>Days</label>
        <div className="fl-chips">{DAYS.map((d, i) => { const on = c.days.includes(i); return <button key={d} type="button" className={`fl-type${on ? ' on' : ''}`} aria-pressed={on} onClick={() => setCond({ ...c, days: on ? c.days.filter((x) => x !== i) : [...c.days, i].sort() })}>{d}</button>; })}</div>
      </div>
      <div className="fl-row">
        <div className="field"><label>From</label><input className="input mono" type="time" aria-label="From" value={c.from} onChange={(e) => setCond({ ...c, from: e.target.value || '00:00' })} /></div>
        <div className="field"><label>To</label><input className="input mono" type="time" aria-label="To" value={c.to} onChange={(e) => setCond({ ...c, to: e.target.value || '00:00' })} /></div>
      </div>
      <label className="fl-check"><input type="checkbox" checked={c.outside === true} onChange={(e) => setCond({ ...c, outside: e.target.checked || undefined })} /> Only outside these hours</label>
      <span className="faint fl-help">Times are the hub’s clock. The same time for From and To means all day.</span>
    </>);
    if (c.kind === 'file') body = (<>
      <TypesField value={c.types} onChange={(types) => setCond({ ...c, types })} />
      <div className="field"><label>Name pattern</label><input className="input" aria-label="Name pattern" placeholder="e.g. *-IFC-*" value={c.namePattern ?? ''} onChange={(e) => setCond({ ...c, namePattern: e.target.value || undefined })} /></div>
    </>);
  } else {
    const a = graph.actions[ai];
    const vars = variablesAt(graph, ai);
    heading = `${a.id.toUpperCase()} · Then · ${ai + 1}`;
    kindSelect = (
      <select className="input" aria-label="What to do" value={a.kind} onChange={(e) => setAction(blankAction(e.target.value as ActionKind, a.id, { ...graph, actions: graph.actions.slice(0, ai) }))}>
        {(Object.keys(ACTION_LABEL) as ActionKind[]).map((k) => <option key={k} value={k}>{ACTION_LABEL[k]}</option>)}
      </select>
    );
    if (a.kind === 'extract') body = (
      <p className="fl-explain">Reads the attached PDF on the hub and finds its title block: the drawing title, the revision (“Rev”, “Revision”, “REV. A”, or the latest row of a revision schedule) and the drawing number. Later steps can use <span className="mono" translate="no">{'{{file.title}}'}</span>, <span className="mono" translate="no">{'{{file.revision}}'}</span>, <span className="mono" translate="no">{'{{file.number}}'}</span> and <span className="mono" translate="no">{'{{file.pages}}'}</span>.</p>
    );
    if (a.kind === 'notify') body = (<>
      <PeoplePicker label="Tell" value={a.to} onChange={(to) => setAction({ ...a, to })} lists={lists} roles={['author', 'actor', 'owner']} />
      <TemplateField label="Message (a link to where it happened is added)" value={a.text} onChange={(text) => setAction({ ...a, text })} vars={vars} />
    </>);
    if (a.kind === 'post') body = (<>
      <div className="field"><label>Post in</label>
        <select className="input" aria-label="Post in" value={a.convId ?? ''} onChange={(e) => setAction({ ...a, convId: e.target.value || null })}>
          <option value="">The Space where it happened</option>
          {lists.spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      <TemplateField label="Message (posted by Automations)" value={a.text} onChange={(text) => setAction({ ...a, text })} vars={vars} />
    </>);
    if (a.kind === 'task') body = (<>
      <div className="field"><label>Make</label>
        <Segmented<'reminder' | 'todo'> label="Make" value={a.mode} onChange={(mode) => setAction({ ...a, mode })} options={[{ value: 'reminder', label: 'A reminder' }, { value: 'todo', label: 'A To do on the Desk' }]} />
      </div>
      <PeoplePicker label="For" value={a.to} onChange={(to) => setAction({ ...a, to })} lists={lists} roles={['author', 'actor', 'owner']} />
      {a.mode === 'reminder' && (<>
        <TemplateField label="Reminder" value={a.text} onChange={(text) => setAction({ ...a, text })} vars={vars} rows={2} />
        <div className="field"><label>Due</label>
          <select className="input" aria-label="Due" value={a.dueInMinutes} onChange={(e) => setAction({ ...a, dueInMinutes: Number(e.target.value) })}>
            {[...new Set([...DUE, a.dueInMinutes])].sort((x, y) => x - y).map((m) => <option key={m} value={m}>{dueLabel(m)}</option>)}
          </select>
        </div>
      </>)}
      {a.mode === 'todo' && <span className="faint fl-help">The message is kept on their Desk under To do. People who cannot see the conversation are skipped.</span>}
    </>);
    if (a.kind === 'tag') body = (
      <div className="field"><label>Tag</label><input className="input mono" aria-label="Tag" placeholder="#review" value={a.tag ? `#${a.tag}` : ''} onChange={(e) => setAction({ ...a, tag: e.target.value.replace(/^#+/, '').replace(/\s+/g, '-').toLowerCase() })} />
        <span className="faint fl-help">Found by searching #{a.tag || 'tag'}, like a tag written in the message.</span></div>
    );
    if (a.kind === 'webhook') body = (<>
      <div className="field"><label>Address</label><input className="input mono" aria-label="Webhook address" placeholder="https://tools.example.com/hooks/drawings" value={a.url} onChange={(e) => setAction({ ...a, url: e.target.value.trim() })} />
        <span className={`fl-help ${allowLan === false ? 'fl-warn' : 'faint'}`}>{allowLan === false ? 'Addresses on the office network are refused until an administrator allows them in the Control room.' : 'Called with POST; the reply’s status and text become {{webhook.status}} and {{webhook.reply}}.'}</span>
      </div>
      <TemplateField label="Body (empty sends everything as JSON)" value={a.body} onChange={(body) => setAction({ ...a, body })} vars={vars} rows={3} placeholder={'{"drawing": "{{file.name}}", "rev": "{{file.revision}}"}'} />
    </>);
  }

  const canMove = ci >= 0 ? graph.conditions.length > 1 : ai >= 0 ? graph.actions.length > 1 : false;
  const first = ci === 0 || ai === 0;
  const last = (ci >= 0 && ci === graph.conditions.length - 1) || (ai >= 0 && ai === graph.actions.length - 1);
  return (
    <section className="fl-inspector" aria-label="Edit this part">
      <div className="fl-inspector-head">
        <span className="fl-k mono">{heading}</span>
        {!readOnly && !isTrigger && (
          <span className="row-actions">
            {canMove && <button type="button" className="btn ghost" disabled={first} onClick={() => onMove(-1)}>Earlier</button>}
            {canMove && <button type="button" className="btn ghost" disabled={last} onClick={() => onMove(1)}>Later</button>}
            <button type="button" className="btn ghost danger" onClick={onRemove}><Icon name="trash" size={14} />Remove</button>
          </span>
        )}
      </div>
      <fieldset disabled={readOnly} className="fl-fields">
        <div className="field"><label>Kind</label>{kindSelect}</div>
        {body}
      </fieldset>
    </section>
  );
}
