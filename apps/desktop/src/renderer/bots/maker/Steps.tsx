// 02 Questions: the bot's steps as a numbered schedule. Each row shows its number, what kind of
// answer it takes, the question and where it goes next; the open row is edited in place. Problems
// are written beside the step that causes them.
import { useEffect, useId, useRef, useState } from 'react';
import type { BotFlowBranch, BotFlowDefinition, BotFlowInput, BotFlowStep, BotSkill } from '@dex/core';
import { Icon } from '../../ui.tsx';
import { ANSWER_KINDS, KIND_TAG, KIND_WORDS, ROUTE_WORDS, conditionOf, inputOf, kindOf, newStep, routeOf, saveKeyOf } from './model.ts';
import type { AnswerKind, RouteOp } from './model.ts';
import { ChosenSkill, SkillBlocks, SkillFields } from './SkillBlocks.tsx';

/** A step that asks another bot: its answer kind follows what the skill gives (the fallback asks the person the same). */
export function newAskStep(def: BotFlowDefinition, skill: BotSkill): BotFlowStep {
  const main = skill.outputs.find((o) => o.id === skill.main);
  const kind: AnswerKind = main?.kind === 'number' ? 'number' : main?.kind === 'person' ? 'person' : main?.kind === 'date' ? 'date' : 'text';
  let input = inputOf(kind);
  if (kind === 'number') input = { kind: 'text', validate: { type: 'number', integer: true, min: 0 } };
  if (main?.kind === 'yesno') input = { kind: 'choice', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] };
  const w: Record<string, string> = {};
  for (const i of skill.inputs) {
    if (i.kind === 'person' && !i.optional) w[i.id] = '{{user.value}}';
    else if (i.options?.length && !i.optional) w[i.id] = i.options[0];
  }
  const base = newStep(def, 'text');
  return { id: base.id, label: skill.title.replace(/\?$/, ''), prompt: skill.title, input, ask: { skill: skill.id, ...(Object.keys(w).length ? { with: w } : {}) } };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Buttons that put {{placeholders}} into a text: earlier answers, the summary, the person's first name. */
export function InsertChips({ def, upTo, onInsert, summary = true }: { def: BotFlowDefinition; upTo?: number; onInsert: (token: string) => void; summary?: boolean }) {
  const earlier = def.steps.slice(0, upTo ?? def.steps.length).filter((s) => s.input?.kind !== 'confirm');
  return (
    <div className="bm-insert" role="group" aria-label="Insert an answer">
      <span className="bm-insert-label">Insert</span>
      {earlier.map((s) => <button key={s.id} type="button" className="bm-token" onClick={() => onInsert(`{{${saveKeyOf(s)}}}`)}>{s.label || s.id}</button>)}
      {summary && <button type="button" className="bm-token" onClick={() => onInsert('{{summary}}')}>All answers</button>}
      <button type="button" className="bm-token" onClick={() => onInsert('{{user.first}}')}>Their first name</button>
    </div>
  );
}

/** Put text at the caret of a field (or at its end). */
export function insertAt(el: HTMLInputElement | HTMLTextAreaElement | null, value: string, token: string): string {
  if (!el) return value + token;
  const a = el.selectionStart ?? value.length;
  const b = el.selectionEnd ?? value.length;
  const next = value.slice(0, a) + token + value.slice(b);
  requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + token.length, a + token.length); });
  return next;
}

function KindFields({ step, onInput }: { step: BotFlowStep; onInput: (i: BotFlowInput) => void }) {
  const input = step.input;
  const kind = kindOf(input);
  const id = useId();
  const v = input.validate;
  // a default from the office's records, offered as one tap
  const jobs = (
    <label className="check-line bm-wide"><input type="checkbox" checked={input.suggest === 'jobs'} onChange={(e) => { const { suggest: _s, ...rest } = input; onInput(e.target.checked ? { ...rest, suggest: 'jobs' } : rest); }} />Offer job numbers from the Spaces they are in</label>
  );
  const quick = (
    <div className="field bm-wide">
      <label htmlFor={`${id}-q`}>Quick replies (one tap instead of typing; separate with commas)</label>
      <input id={`${id}-q`} className="input" value={(input.suggestions ?? []).join(', ')} placeholder="Tomorrow, Next Monday"
        onChange={(e) => { const list = e.target.value.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 6); onInput({ ...input, suggestions: list.length ? list : undefined }); }} />
    </div>
  );
  switch (kind) {
    case 'choice': {
      const opts = input.options ?? [];
      return (
        <fieldset className="bm-choices bm-wide">
          <legend>Choices</legend>
          {opts.map((o, i) => (
            <div key={i} className="bm-choice">
              <span className="bm-choice-no mono" aria-hidden="true">{String.fromCharCode(65 + (i % 26))}</span>
              <input className="input" aria-label={`Choice ${i + 1}`} value={o.label} maxLength={120}
                onChange={(e) => onInput({ ...input, options: opts.map((x, j) => (j === i ? { value: e.target.value, label: e.target.value } : x)) })} />
              <button type="button" className="icon-btn sm" aria-label={`Remove choice ${i + 1}`} disabled={opts.length <= 2} onClick={() => onInput({ ...input, options: opts.filter((_, j) => j !== i) })}><Icon name="x" size={14} /></button>
            </div>
          ))}
          {opts.length < 20 && <button type="button" className="btn ghost sm" onClick={() => onInput({ ...input, options: [...opts, { value: `Option ${opts.length + 1}`, label: `Option ${opts.length + 1}` }] })}><Icon name="plus" size={14} />Add a choice</button>}
        </fieldset>
      );
    }
    case 'number':
      return (
        <>
          <div className="field"><label htmlFor={`${id}-min`}>Smallest</label><input id={`${id}-min`} className="input" type="number" value={v?.min ?? ''} onChange={(e) => onInput({ ...input, validate: { ...v!, type: 'number', min: e.target.value === '' ? undefined : Number(e.target.value) } })} /></div>
          <div className="field"><label htmlFor={`${id}-max`}>Largest</label><input id={`${id}-max`} className="input" type="number" value={v?.max ?? ''} onChange={(e) => onInput({ ...input, validate: { ...v!, type: 'number', max: e.target.value === '' ? undefined : Number(e.target.value) } })} /></div>
          <label className="check-line bm-wide"><input type="checkbox" checked={!!v?.integer} onChange={(e) => onInput({ ...input, validate: { ...v!, type: 'number', integer: e.target.checked || undefined } })} />Whole numbers only</label>
          {quick}
        </>
      );
    case 'date':
      return <label className="check-line bm-wide"><input type="checkbox" checked={v?.notBefore === 'today'} onChange={(e) => onInput({ ...input, validate: { type: 'date', ...(e.target.checked ? { notBefore: 'today' } : {}) } })} />Not before today</label>;
    case 'pattern':
      return (
        <>
          <div className="field"><label htmlFor={`${id}-p`}>The answer must look like (a pattern)</label><input id={`${id}-p`} className="input mono" value={v?.pattern ?? ''} spellCheck={false} onChange={(e) => onInput({ ...input, validate: { ...v!, type: 'regex', pattern: e.target.value } })} /></div>
          <div className="field"><label htmlFor={`${id}-m`}>What to say when it does not</label><input id={`${id}-m`} className="input" value={v?.message ?? ''} onChange={(e) => onInput({ ...input, validate: { ...v!, type: 'regex', message: e.target.value || undefined } })} /></div>
          <div className="field bm-wide"><label htmlFor={`${id}-ph`}>Example shown in the box</label><input id={`${id}-ph`} className="input" value={input.placeholder ?? ''} onChange={(e) => onInput({ ...input, placeholder: e.target.value || undefined })} /></div>
          {jobs}
        </>
      );
    case 'person':
      return <label className="check-line bm-wide"><input type="checkbox" checked={input.suggest === 'lead'} onChange={(e) => { const { suggest: _s, ...rest } = input; onInput(e.target.checked ? { ...rest, suggest: 'lead' } : rest); }} />Offer their lead from the directory as one tap</label>;
    case 'file':
      return (
        <div className="field bm-wide"><label htmlFor={`${id}-f`}>File types allowed (leave empty for any)</label>
          <input id={`${id}-f`} className="input mono" value={(input.accept ?? []).join(' ')} placeholder=".pdf .dwg .zip"
            onChange={(e) => { const list = e.target.value.split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean).map((x) => (x.startsWith('.') ? x : `.${x}`)); onInput({ ...input, accept: list.length ? list : undefined }); }} /></div>
      );
    case 'confirm':
      return (
        <>
          <div className="field"><label htmlFor={`${id}-y`}>Yes button</label><input id={`${id}-y`} className="input" maxLength={40} value={input.yes ?? ''} placeholder="Worded by its voice" onChange={(e) => onInput({ ...input, yes: e.target.value || undefined })} /></div>
          <div className="field"><label htmlFor={`${id}-n`}>No button</label><input id={`${id}-n`} className="input" maxLength={40} value={input.no ?? ''} placeholder="Worded by its voice" onChange={(e) => onInput({ ...input, no: e.target.value || undefined })} /></div>
        </>
      );
    case 'text': case 'email':
      return (
        <>
          <div className="field bm-wide"><label htmlFor={`${id}-ph`}>Example shown in the box</label><input id={`${id}-ph`} className="input" value={input.placeholder ?? ''} onChange={(e) => onInput({ ...input, placeholder: e.target.value || undefined })} /></div>
          {kind === 'text' && quick}
          {kind === 'text' && jobs}
        </>
      );
    default:
      return null;
  }
}

function Routes({ def, step, index, onChange }: { def: BotFlowDefinition; step: BotFlowStep; index: number; onChange: (s: BotFlowStep) => void }) {
  const kind = kindOf(step.input);
  const branches = step.branches ?? [];
  const targets = def.steps.filter((s) => s.id !== step.id);
  const id = useId();
  const nextLabel = def.steps[index + 1] ? `The next question (${pad(index + 2)})` : 'The end';
  const ops: RouteOp[] = kind === 'number' ? ['is', 'isnt', 'more', 'less'] : step.input.optional ? ['is', 'isnt', 'empty'] : ['is', 'isnt'];
  const setBranch = (j: number, b: BotFlowBranch | null) => onChange({ ...step, branches: (b ? branches.map((x, k) => (k === j ? b : x)) : branches.filter((_, k) => k !== j)) });
  return (
    <fieldset className="bm-routes bm-wide">
      <legend>Then</legend>
      {branches.map((b, j) => {
        const r = routeOf(b.if);
        return (
          <div key={j} className="bm-route">
            <span className="bm-route-if">If the answer</span>
            <select className="input" aria-label="Test" value={r.op} onChange={(e) => setBranch(j, { ...b, if: conditionOf(e.target.value as RouteOp, r.value) })}>
              {ops.map((o) => <option key={o} value={o}>{ROUTE_WORDS[o]}</option>)}
            </select>
            {r.op !== 'empty' && (kind === 'choice' || kind === 'confirm'
              ? (
                <select className="input" aria-label="Answer" value={r.value} onChange={(e) => setBranch(j, { ...b, if: conditionOf(r.op, e.target.value) })}>
                  <option value="">Choose…</option>
                  {kind === 'confirm'
                    ? [<option key="yes" value="yes">{step.input.yes || 'Yes'}</option>, <option key="no" value="no">{step.input.no || 'No'}</option>]
                    : (step.input.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              )
              : <input className="input" aria-label="Answer" value={r.value} inputMode={kind === 'number' ? 'decimal' : undefined} onChange={(e) => setBranch(j, { ...b, if: conditionOf(r.op, e.target.value) })} />)}
            <span className="bm-route-if">go to</span>
            <select className="input" aria-label="Go to" value={b.goto} onChange={(e) => setBranch(j, { ...b, goto: e.target.value })}>
              {targets.map((s) => <option key={s.id} value={s.id}>{pad(def.steps.indexOf(s) + 1)} {s.label || s.prompt.slice(0, 30)}</option>)}
              <option value="end">The end</option>
            </select>
            <button type="button" className="icon-btn sm" aria-label="Remove this route" onClick={() => setBranch(j, null)}><Icon name="x" size={14} /></button>
          </div>
        );
      })}
      <div className="bm-route bm-route-else">
        <span className="bm-route-if">{branches.length ? 'Otherwise go to' : 'Go to'}</span>
        <select id={`${id}-next`} className="input" aria-label={branches.length ? 'Otherwise go to' : 'Go to'} value={step.next ?? ''} onChange={(e) => onChange({ ...step, next: e.target.value || undefined })}>
          <option value="">{nextLabel}</option>
          {targets.map((s) => <option key={s.id} value={s.id}>{pad(def.steps.indexOf(s) + 1)} {s.label || s.prompt.slice(0, 30)}</option>)}
          <option value="end">The end</option>
        </select>
        {branches.length < 20 && (
          <button type="button" className="btn ghost sm" onClick={() => onChange({ ...step, branches: [...branches, { if: { equals: kind === 'confirm' ? 'no' : step.input.options?.[0]?.value ?? '' }, goto: targets[0]?.id ?? 'end' }] })}>
            <Icon name="branch" size={14} />Add a route
          </button>
        )}
      </div>
    </fieldset>
  );
}

function StepEditor({ def, step, index, onChange }: { def: BotFlowDefinition; step: BotFlowStep; index: number; onChange: (s: BotFlowStep) => void }) {
  const id = useId();
  const prompt = useRef<HTMLTextAreaElement>(null);
  const kind = kindOf(step.input);
  const [rechoose, setRechoose] = useState(false);
  return (
    <div className="bm-step-edit" id={`bm-step-${step.id}-edit`}>
      {step.ask && (
        <fieldset className="bm-wide bm-askbot">
          <legend>Asks another bot</legend>
          {rechoose
            ? <SkillBlocks exclude={def.name} picked={step.ask.skill} onPick={(sk) => { const n = newAskStep(def, sk); onChange({ ...step, ask: n.ask, input: n.input }); setRechoose(false); }} />
            : <ChosenSkill ask={step.ask} onClear={() => setRechoose(true)} />}
          <div className="bm-grid"><SkillFields def={def} ask={step.ask} upTo={index} onChange={(ask) => onChange({ ...step, ask })} /></div>
          <span className="bm-hint">The bot’s answer is used like any answer: in later questions, routes and messages.</span>
          <button type="button" className="btn ghost sm" style={{ justifySelf: 'start' }} onClick={() => { const { ask: _a, ...rest } = step; onChange(rest); }}>Ask the person instead</button>
        </fieldset>
      )}
      <div className="field bm-wide">
        <label htmlFor={`${id}-prompt`}>{step.ask ? 'When the bot cannot answer, the person is asked' : 'What the bot asks'}</label>
        <textarea ref={prompt} id={`${id}-prompt`} className="input bm-prompt" rows={2} maxLength={2000} value={step.prompt} onChange={(e) => onChange({ ...step, prompt: e.target.value })} />
        <InsertChips def={def} upTo={index} summary={index > 0} onInsert={(t) => onChange({ ...step, prompt: insertAt(prompt.current, step.prompt, t) })} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-kind`}>The answer is</label>
        <select id={`${id}-kind`} className="input" value={kind} onChange={(e) => onChange({ ...step, input: inputOf(e.target.value as AnswerKind, step.input), ...(e.target.value === 'confirm' ? { label: undefined } : {}) })}>
          {ANSWER_KINDS.map((k) => <option key={k} value={k}>{KIND_WORDS[k]}</option>)}
        </select>
      </div>
      {kind !== 'confirm' && (
        <div className="field">
          <label htmlFor={`${id}-label`}>Name in the summary</label>
          <input id={`${id}-label`} className="input" maxLength={60} value={step.label ?? ''} placeholder={step.id} onChange={(e) => onChange({ ...step, label: e.target.value || undefined })} />
        </div>
      )}
      <KindFields step={step} onInput={(input) => onChange({ ...step, input })} />
      {kind !== 'confirm' && <label className="check-line bm-wide"><input type="checkbox" checked={!!step.input.optional} onChange={(e) => onChange({ ...step, input: { ...step.input, optional: e.target.checked || undefined } })} />People may skip it</label>}
      <Routes def={def} step={step} index={index} onChange={onChange} />
    </div>
  );
}

/** Where a step goes, in a few words for its row ("→ 03", "→ END", "2 routes"). */
function routeTag(def: BotFlowDefinition, s: BotFlowStep, i: number): string {
  const n = (sid: string) => (sid === 'end' ? 'END' : pad(def.steps.findIndex((x) => x.id === sid) + 1));
  const b = s.branches?.length ?? 0;
  const next = s.next ? n(s.next) : def.steps[i + 1] ? null : 'END';
  if (b === 1) return next ? `1 ROUTE · → ${next}` : '1 ROUTE';
  if (b) return next ? `${b} ROUTES · → ${next}` : `${b} ROUTES`;
  return next ? `→ ${next}` : '';
}

export function StepsSection({ def, setDef, problems, open, setOpen }: {
  def: BotFlowDefinition; setDef: (d: BotFlowDefinition) => void; problems: Record<string, string[]>;
  open: string | null; setOpen: (id: string | null) => void;
}) {
  const [focusId, setFocusId] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!focusId) return;
    const el = document.querySelector<HTMLElement>(`#bm-step-${CSS.escape(focusId)}-edit textarea, #bm-step-${CSS.escape(focusId)} .bm-step-head`);
    el?.focus();
    el?.scrollIntoView({ block: 'nearest' });
    setFocusId(null);
  }, [focusId, open]);
  const update = (i: number, s: BotFlowStep) => setDef({ ...def, steps: def.steps.map((x, j) => (j === i ? s : x)) });
  const move = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= def.steps.length) return;
    const steps = [...def.steps];
    [steps[i], steps[j]] = [steps[j], steps[i]];
    setDef({ ...def, steps });
    setFocusId(steps[j].id);
  };
  const remove = (i: number) => {
    const gone = def.steps[i];
    // routes to it go to where it would have gone
    const after = gone.next ?? def.steps[i + 1]?.id ?? 'end';
    const steps = def.steps.filter((_, j) => j !== i).map((s) => ({
      ...s,
      ...(s.next === gone.id ? { next: after } : {}),
      ...(s.branches ? { branches: s.branches.map((b) => (b.goto === gone.id ? { ...b, goto: after } : b)) } : {}),
    }));
    setDef({ ...def, steps });
    const near = steps[Math.max(0, i - 1)];
    setOpen(null);
    if (near) setFocusId(near.id);
  };
  const add = (kind: AnswerKind) => {
    const s = newStep(def, kind);
    // a confirmation goes last; anything else before a closing confirmation
    const last = def.steps[def.steps.length - 1];
    const at = kind !== 'confirm' && last && kindOf(last.input) === 'confirm' ? def.steps.length - 1 : def.steps.length;
    const steps = [...def.steps];
    steps.splice(at, 0, s);
    setDef({ ...def, steps });
    setOpen(s.id);
    setFocusId(s.id);
  };
  const copy = (i: number) => {
    const src = def.steps[i];
    const s: BotFlowStep = { ...JSON.parse(JSON.stringify(src)) as BotFlowStep, id: newStep(def, 'text').id, ...(src.label ? { label: `${src.label} (copy)` } : {}) };
    delete s.save;
    const steps = [...def.steps];
    steps.splice(i + 1, 0, s);
    setDef({ ...def, steps });
    setOpen(s.id);
    setFocusId(s.id);
  };
  return (
    <div className="bm-section">
      <ol className="bm-steps" aria-label="Questions, in order">
        {def.steps.map((s, i) => {
          const kind = kindOf(s.input);
          const isOpen = open === s.id;
          const errs = problems[s.id] ?? problems[`#${i + 1}`];
          return (
            <li key={s.id + i} id={`bm-step-${s.id}`} className={`bm-step${isOpen ? ' open' : ''}${errs ? ' bad' : ''}`}>
              <div className="bm-step-row">
                <button type="button" className="bm-step-head" aria-expanded={isOpen} aria-controls={`bm-step-${s.id}-edit`} onClick={() => setOpen(isOpen ? null : s.id)}>
                  <span className="bm-step-no mono">{pad(i + 1)}</span>
                  <span className={`bm-kind${s.ask ? ' bot' : ''}`}>{s.ask ? 'ASKS BOT' : KIND_TAG[kind]}</span>
                  <span className="bm-step-q" translate="no">{s.prompt.split('\n')[0] || '…'}</span>
                  <span className="bm-step-route mono">{routeTag(def, s, i)}</span>
                </button>
                <span className="bm-step-tools">
                  <button type="button" className="icon-btn sm" aria-label={`Move question ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}><Icon name="back" size={14} className="rot90" /></button>
                  <button type="button" className="icon-btn sm" aria-label={`Move question ${i + 1} down`} disabled={i === def.steps.length - 1} onClick={() => move(i, 1)}><Icon name="back" size={14} className="rot270" /></button>
                  <button type="button" className="icon-btn sm" aria-label={`Copy question ${i + 1}`} onClick={() => copy(i)}><Icon name="copy" size={14} /></button>
                  <button type="button" className="icon-btn sm" aria-label={`Remove question ${i + 1}`} disabled={def.steps.length <= 1} onClick={() => remove(i)}><Icon name="trash" size={14} /></button>
                </span>
              </div>
              {errs && <div className="bm-problem" role="note"><Icon name="warning" size={14} /><span>{errs.join(' ')}</span></div>}
              {isOpen && <StepEditor def={def} step={s} index={i} onChange={(x) => update(i, x)} />}
            </li>
          );
        })}
      </ol>
      <div className="bm-add" role="group" aria-label="Add a question">
        <span className="bm-add-label">Add</span>
        {(['choice', 'text', 'long', 'number', 'date', 'person', 'file', 'confirm'] as AnswerKind[]).map((k) => (
          <button key={k} type="button" className="bm-add-btn" disabled={def.steps.length >= 50} onClick={() => add(k)}><Icon name="plus" size={13} />{KIND_WORDS[k]}</button>
        ))}
        <button type="button" className="bm-add-btn bot" aria-expanded={asking} disabled={def.steps.length >= 50} onClick={() => setAsking(!asking)}><Icon name="branch" size={13} />Ask a bot</button>
      </div>
      {asking && (
        <div className="bm-block" role="region" aria-label="Skills other bots answer">
          <span className="bm-legend">Ask another bot · pick what to ask</span>
          <SkillBlocks exclude={def.name} onPick={(sk) => {
            const st = newAskStep(def, sk);
            const last = def.steps[def.steps.length - 1];
            const at = last && kindOf(last.input) === 'confirm' ? def.steps.length - 1 : def.steps.length;
            const steps = [...def.steps];
            steps.splice(at, 0, st);
            setDef({ ...def, steps });
            setAsking(false);
            setOpen(st.id);
            setFocusId(st.id);
          }} />
        </div>
      )}
    </div>
  );
}
