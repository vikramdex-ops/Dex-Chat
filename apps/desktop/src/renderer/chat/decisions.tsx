// Decisions: the builder (a decision tree drawn on a ruled sheet), the card in the timeline that
// walks each person through their own path, and the author's results sheet with a CSV export.
import { useEffect, useState } from 'react';
import { DECISION_LIMITS, DECISION_MAX_DEPTH, DECISION_MAX_OPTIONS, DECISION_MAX_STEPS, toCsv } from '@dex/core';
import type { Conversation, DecisionResults, DecisionStep, DecisionStepInput, DecisionStepView, Message, PublicUser } from '@dex/core';
import { Avatar, Dialog, Icon, useToast } from '../ui.tsx';
import { downloadText } from '../work/store.ts';
import './messages.css';

// ------------------------------------------------------------------ the builder
interface DraftOption { key: number; label: string; then: 'close' | 'step'; note: string; next: DraftStep }
interface DraftStep { key: number; prompt: string; kind: 'choice' | 'text'; options: DraftOption[] }

let seq = 0;
const blankStep = (kind: 'choice' | 'text' = 'choice'): DraftStep => ({ key: ++seq, prompt: '', kind, options: kind === 'choice' ? [blankOption(), blankOption()] : [] });
function blankOption(label = '', then: 'close' | 'step' = 'close', next?: DraftStep): DraftOption {
  return { key: ++seq, label, then, note: '', next: next ?? { key: ++seq, prompt: '', kind: 'text', options: [] } };
}
/** A common start: approve, or say what to change, or say why not. */
function approvalTemplate(prompt: string): DraftStep {
  const why = (p: string): DraftStep => ({ key: ++seq, prompt: p, kind: 'text', options: [] });
  return {
    key: ++seq, prompt, kind: 'choice', options: [
      blankOption('Approved'),
      blankOption('Needs changes', 'step', why('What should change?')),
      blankOption('Rejected', 'step', why('Why?')),
    ],
  };
}

function toInput(s: DraftStep): DecisionStepInput {
  return s.kind === 'text'
    ? { prompt: s.prompt.trim(), kind: 'text' }
    : { prompt: s.prompt.trim(), kind: 'choice', options: s.options.map((o) => ({ label: o.label.trim(), ...(o.then === 'step' ? { next: toInput(o.next) } : o.note.trim() ? { note: o.note.trim() } : {}) })) };
}

/** What is still missing, in the builder's words (the hub checks again). */
function problems(root: DraftStep): string[] {
  const out: string[] = [];
  let steps = 0;
  const walk = (s: DraftStep, depth: number) => {
    steps++;
    if (depth > DECISION_MAX_DEPTH) { out.push(`Steps go ${DECISION_MAX_DEPTH} deep at most.`); return; }
    if (!s.prompt.trim()) out.push(depth === 1 ? 'Ask the question.' : `A step ${depth} needs its question.`);
    if (s.kind === 'text') return;
    const labels = s.options.map((o) => o.label.trim().toLowerCase());
    if (labels.some((l) => !l)) out.push('Every option needs a label.');
    if (new Set(labels).size !== labels.length) out.push('Two options have the same label.');
    for (const o of s.options) if (o.then === 'step') walk(o.next, depth + 1);
  };
  walk(root, 1);
  if (steps > DECISION_MAX_STEPS) out.push(`A Decision can have up to ${DECISION_MAX_STEPS} steps.`);
  return [...new Set(out)];
}

function StepEditor({ step, depth, onChange, index }: { step: DraftStep; depth: number; onChange: (s: DraftStep) => void; index: string }) {
  const set = (patch: Partial<DraftStep>) => onChange({ ...step, ...patch });
  const setOpt = (i: number, patch: Partial<DraftOption>) => set({ options: step.options.map((o, j) => (j === i ? { ...o, ...patch } : o)) });
  const canDeeper = depth < DECISION_MAX_DEPTH;
  return (
    <div className={`dt-step depth-${depth}`}>
      <div className="dt-node">
        <span className="dt-tag mono" aria-hidden="true">{index}</span>
        <input className="input dt-prompt" maxLength={DECISION_LIMITS.prompt} value={step.prompt} onChange={(e) => set({ prompt: e.target.value })}
          placeholder={depth === 1 ? 'Issue the pump skid GA for construction?' : step.kind === 'text' ? 'What should they write? e.g. Why?' : 'Follow-up question'}
          aria-label={depth === 1 ? 'The question' : `Question at step ${depth}`} autoFocus={depth === 1} />
        {depth > 1 && (
          <select className="input dt-kind" value={step.kind} aria-label={`Kind of step ${depth}`}
            onChange={(e) => { const kind = e.target.value as 'choice' | 'text'; set({ kind, options: kind === 'choice' && step.options.length < 2 ? [blankOption(), blankOption()] : step.options }); }}>
            <option value="choice">Options</option>
            <option value="text">Written answer</option>
          </select>
        )}
      </div>
      {step.kind === 'text' ? (
        <div className="dt-leaf faint"><Icon name="edit" size={13} />They write an answer, and their path ends there.</div>
      ) : (
        <ol className="dt-options">
          {step.options.map((o, i) => (
            <li key={o.key} className={`dt-option${o.then === 'close' ? ' closes' : ' goes'}`}>
              <div className="dt-option-row">
                <input className="input dt-label" maxLength={DECISION_LIMITS.label} value={o.label} onChange={(e) => setOpt(i, { label: e.target.value })}
                  placeholder={['Approved', 'Needs changes', 'Rejected', 'Not sure', 'Later', 'Other'][i] ?? 'Option'} aria-label={`Option ${i + 1} of ${index}`} />
                <div className="dt-then" role="radiogroup" aria-label={`After “${o.label || `option ${i + 1}`}”`}>
                  <button type="button" role="radio" aria-checked={o.then === 'close'} className={o.then === 'close' ? 'on' : ''} onClick={() => setOpt(i, { then: 'close' })}>Ends here</button>
                  <button type="button" role="radio" aria-checked={o.then === 'step'} className={o.then === 'step' ? 'on' : ''} disabled={!canDeeper && o.then !== 'step'}
                    title={canDeeper ? 'Ask a follow-up' : `Steps go ${DECISION_MAX_DEPTH} deep at most`} onClick={() => setOpt(i, { then: 'step' })}>Asks more</button>
                </div>
                {step.options.length > 2 && <button type="button" className="icon-btn" aria-label={`Remove option ${i + 1}`} onClick={() => set({ options: step.options.filter((_, j) => j !== i) })}><Icon name="x" size={13} /></button>}
              </div>
              {o.then === 'close'
                ? <input className="input dt-note" maxLength={DECISION_LIMITS.note} value={o.note} onChange={(e) => setOpt(i, { note: e.target.value })} placeholder="Closing note (optional): what happens next" aria-label={`Closing note for ${o.label || `option ${i + 1}`}`} />
                : <StepEditor step={o.next} depth={depth + 1} index={`${index}.${i + 1}`} onChange={(next) => setOpt(i, { next })} />}
            </li>
          ))}
          {step.options.length < DECISION_MAX_OPTIONS && <li className="dt-add"><button type="button" className="link" onClick={() => set({ options: [...step.options, blankOption()] })}><Icon name="plus" size={13} />Add an option</button></li>}
        </ol>
      )}
    </div>
  );
}

export function DecisionBuilder({ conv, parentId, onClose }: { conv: Conversation; parentId: string | null; onClose: () => void }) {
  const toast = useToast();
  const [root, setRoot] = useState<DraftStep>(() => blankStep());
  const [busy, setBusy] = useState(false);
  const issues = problems(root);
  const post = async () => {
    setBusy(true);
    try {
      await window.dex.request('decision.create', { convId: conv.id, parentId: parentId ?? undefined, root: toInput(root), clientId: `dec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}` });
      onClose();
    } catch (e) { toast((e as Error).message, true); setBusy(false); }
  };
  return (
    <Dialog title="New Decision" onClose={onClose}>
      <p className="muted" style={{ margin: 0 }}>Each person answers on their own. An option either ends their path or asks a follow-up, up to {DECISION_MAX_DEPTH} steps deep. You see where everyone got to.</p>
      <div className="dt-tools">
        <button type="button" className="btn ghost sm" onClick={() => setRoot(approvalTemplate(root.prompt))}><Icon name="decision" size={14} />Start from: approve, change or reject</button>
      </div>
      <div className="dt-sheet" aria-label="Decision tree">
        <StepEditor step={root} depth={1} index="Q1" onChange={setRoot} />
      </div>
      <div className="dialog-actions">
        <span className="faint">{issues[0] ?? 'Everyone here can answer. Only you see the answers.'}</span>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || issues.length > 0} onClick={() => void post()}><Icon name="decision" size={15} />Post Decision</button>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ the card in the timeline
function StepAnswer({ m, step, closed }: { m: Message; step: DecisionStepView; closed: boolean }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const answer = (patch: { optionId?: string; text?: string }, key: string) => {
    setBusy(key);
    void window.dex.request('decision.answer', { messageId: m.id, stepId: step.id, ...patch }).catch((e: Error) => toast(e.message, true)).finally(() => setBusy(null));
  };
  return (
    <div className="dc-step" aria-label={`Step ${step.depth}`}>
      {step.depth > 1 && <div className="dc-prompt" translate="no">{step.prompt}</div>}
      {step.kind === 'text' ? (
        <form className="dc-write" onSubmit={(e) => { e.preventDefault(); if (text.trim()) answer({ text: text.trim() }, 'text'); }}>
          <textarea className="input" rows={2} maxLength={DECISION_LIMITS.answer} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write your answer" aria-label={step.prompt} disabled={closed} />
          <button className="btn primary sm" disabled={!text.trim() || !!busy || closed}>{busy ? <span className="spinner" /> : <Icon name="dimsend" size={14} />}Send answer</button>
        </form>
      ) : (
        <div className="dc-options">
          {step.options.map((o) => (
            <button key={o.id} className={`dc-option${o.closes ? ' closes' : ''}`} disabled={!!busy || closed} onClick={() => answer({ optionId: o.id }, o.id)}>
              {busy === o.id ? <span className="spinner" /> : <span className="dc-mark" aria-hidden="true">{o.closes ? '■' : '▸'}</span>}
              <span translate="no">{o.label}</span>
              <span className="dc-hint mono">{o.closes ? 'ends' : 'more'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function DecisionCard({ m, meId, users }: { m: Message; meId: string; users: Map<string, PublicUser> }) {
  const toast = useToast();
  const d = m.decision!;
  const [results, setResults] = useState(false);
  const mine = m.authorId === meId;
  const isAuthorTree = !!d.tree;
  const act = (op: 'decision.reset' | 'decision.close', ok?: string) => void window.dex.request(op, { messageId: m.id }).then(() => ok && toast(ok)).catch((e: Error) => toast(e.message, true));
  return (
    <div className={`poll decision-card${d.closed ? ' closed' : ''}${d.done ? ' done' : ''}`}>
      <div className="poll-head"><Icon name="decision" size={16} /><span className="label">Decision{d.closed ? ' · closed' : ''} · {d.depth} {d.depth === 1 ? 'step' : 'steps deep'} · {d.finished} reached an end</span></div>
      <div className="poll-q" translate="no">{d.question}</div>
      {d.trail.length > 0 && (
        <ol className="dc-trail" aria-label="Your path">
          {d.trail.map((t) => {
            const label = t.text ?? t.step.options.find((o) => o.id === t.optionId)?.label ?? '';
            return (
              <li key={t.step.id}>
                <span className="dc-trail-q" translate="no">{t.step.depth > 1 ? t.step.prompt : 'You chose'}</span>
                <span className={`dc-trail-a${t.text ? ' written' : ''}`} translate="no">{label}</span>
              </li>
            );
          })}
        </ol>
      )}
      {d.done ? (
        <div className="dc-end">
          <span className="dc-stamp" translate="no">{d.outcome}</span>
          <div className="dc-end-text">
            {d.note ? <span translate="no">{d.note}</span> : <span className="faint">You reached the end of this Decision.</span>}
            {d.finishedAt && <span className="mono faint">{new Date(d.finishedAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>}
          </div>
        </div>
      ) : d.current ? <StepAnswer m={m} step={d.current} closed={d.closed} /> : d.closed ? <p className="faint" style={{ margin: '4px 0' }}>Closed before you reached an end.</p> : null}
      <div className="row-actions dc-foot">
        {!d.closed && (d.done || d.trail.length > 0) && <button className="btn ghost sm" onClick={() => act('decision.reset')}><Icon name="history" size={13} />Start again</button>}
        {isAuthorTree && <button className="btn ghost sm" onClick={() => setResults(true)}><Icon name="list" size={13} />Results · {d.finished}/{d.started}</button>}
        {mine && !d.closed && <button className="btn ghost sm" onClick={() => { if (confirm('Close this Decision? Nobody can answer after that.')) act('decision.close', 'Decision closed'); }}>Close</button>}
      </div>
      {results && <DecisionResultsSheet messageId={m.id} users={users} onClose={() => setResults(false)} />}
    </div>
  );
}

// ------------------------------------------------------------------ the results sheet
function TreeCounts({ step, counts, total }: { step: DecisionStep; counts: Record<string, number>; total: number }) {
  return (
    <div className={`rt-step depth-${step.depth}`}>
      <div className="rt-q"><span className="dt-tag mono">{step.depth === 1 ? 'Q1' : `Step ${step.depth}`}</span><span translate="no">{step.prompt}</span>{step.kind === 'text' && <span className="faint"> · written answer</span>}</div>
      {step.options.length > 0 && (
        <ul className="rt-options">
          {step.options.map((o) => {
            const n = counts[o.id] ?? 0;
            return (
              <li key={o.id}>
                <div className="rt-row">
                  <span className="dc-mark" aria-hidden="true">{o.closes ? '■' : '▸'}</span>
                  <span className="rt-label" translate="no">{o.label}</span>
                  <span className="rt-bar" aria-hidden="true"><i style={{ width: `${total ? (n / total) * 100 : 0}%` }} /></span>
                  <span className="rt-n mono">{n}</span>
                </div>
                {o.next && <TreeCounts step={o.next} counts={counts} total={total} />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function DecisionResultsSheet({ messageId, users, onClose }: { messageId: string; users: Map<string, PublicUser>; onClose: () => void }) {
  const toast = useToast();
  const [r, setR] = useState<DecisionResults | null>(null);
  useEffect(() => { void window.dex.request('decision.results', { messageId }).then(setR).catch((e: Error) => { toast(e.message, true); onClose(); }); }, [messageId]); // eslint-disable-line react-hooks/exhaustive-deps
  const name = (id: string) => users.get(id)?.displayName ?? 'Former member';
  const exportCsv = () => {
    if (!r) return;
    const rows: Array<Array<string | number>> = [['Person', 'Account', 'Status', 'Outcome', ...Array.from({ length: DECISION_MAX_DEPTH }, (_, i) => [`Step ${i + 1}`, `Answer ${i + 1}`]).flat(), 'Last answered']];
    for (const p of r.people) {
      const steps = Array.from({ length: DECISION_MAX_DEPTH }, (_, i) => [p.steps[i]?.prompt ?? '', p.steps[i]?.answer ?? '']).flat();
      rows.push([name(p.userId), users.get(p.userId)?.account ?? '', p.done ? 'Reached an end' : 'On the way', p.outcome ?? '', ...steps, new Date(p.at).toISOString()]);
    }
    for (const id of r.notStarted) rows.push([name(id), users.get(id)?.account ?? '', 'Not started', '', ...Array<string>(DECISION_MAX_DEPTH * 2).fill(''), '']);
    downloadText(`Decision - ${r.question.replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 60).trim()}.csv`, toCsv(rows));
  };
  const total = r ? r.people.length : 0;
  return (
    <Dialog title="Decision results" onClose={onClose}>
      {!r ? <div className="tl-more"><span className="spinner" /></div> : (
        <>
          <div className="rs-head-row">
            <div className="poll-q" translate="no" style={{ margin: 0, flex: 1 }}>{r.question}</div>
            <dl className="title-block" aria-label="Where everyone is">
              <div><dt>Answering</dt><dd>{r.people.filter((p) => !p.done).length}</dd></div>
              <div><dt>Reached an end</dt><dd>{r.people.filter((p) => p.done).length}</dd></div>
              <div><dt>Not started</dt><dd>{r.notStarted.length}</dd></div>
            </dl>
          </div>
          <div className="rt-tree"><TreeCounts step={r.tree} counts={r.counts} total={total} /></div>
          <table className="dr-table">
            <thead><tr><th scope="col">Person</th><th scope="col">Path</th><th scope="col">Outcome</th><th scope="col">When</th></tr></thead>
            <tbody>
              {r.people.map((p) => (
                <tr key={p.userId}>
                  <td><span className="dr-person"><Avatar user={{ id: p.userId, displayName: name(p.userId) }} size="sm" /><span translate="no">{name(p.userId)}</span></span></td>
                  <td translate="no">{p.steps.map((s, i) => <span key={s.stepId} className={s.text ? 'dr-written' : undefined}>{i ? ' › ' : ''}{s.answer}</span>)}</td>
                  <td>{p.done ? <span className="dc-stamp sm" translate="no">{p.outcome}</span> : <span className="faint">On the way</span>}</td>
                  <td className="mono faint">{new Date(p.at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                </tr>
              ))}
              {r.people.length === 0 && <tr><td colSpan={4} className="faint">Nobody has answered yet.</td></tr>}
            </tbody>
          </table>
          {r.notStarted.length > 0 && <p className="faint" style={{ margin: 0, fontSize: 12.5 }}><b>Not started:</b> <span translate="no">{r.notStarted.map(name).join(', ')}</span></p>}
          <div className="dialog-actions">
            <span className="faint">Only you see who answered what.</span>
            <button className="btn" onClick={exportCsv}><Icon name="download" size={15} />Export CSV</button>
            <button className="btn primary" onClick={onClose}>Done</button>
          </div>
        </>
      )}
    </Dialog>
  );
}
