// Skills as blocks to pick: every question (or errand) another bot answers that this maker's bots
// may ask, grouped by the bot that answers, each drawn as a small instrument block (the bot's tag,
// the question, what it takes and what it gives). Picked, a skill's inputs are filled in place,
// from fixed words or from earlier answers ({{placeholders}}).
import { useId, useMemo, useState } from 'react';
import type { BotAsk, BotFlowDefinition, BotSkill } from '@dex/core';
import { tagLetters } from '@dex/core/botnet';
import { Icon } from '../../ui.tsx';
import { InsertChips } from './Steps.tsx';
import { useNet } from './netdata.ts';

export function SkillBlocks({ onPick, picked, exclude }: { onPick: (s: BotSkill) => void; picked?: string | null; exclude?: string }) {
  const net = useNet();
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const t = q.trim().toLowerCase();
    const list = net.skills.filter((s) => s.bot !== exclude && (!t || `${s.title} ${s.botTitle} ${s.about}`.toLowerCase().includes(t)));
    const by = new Map<string, BotSkill[]>();
    for (const s of list) by.set(s.bot, [...(by.get(s.bot) ?? []), s]);
    return [...by.entries()];
  }, [net.skills, q, exclude]);
  if (!net.loaded) return <div className="tl-more"><span className="spinner" /></div>;
  return (
    <div className="sk-palette">
      <input className="input sk-find" type="search" value={q} placeholder="Find a skill: seat, leave, lead…" aria-label="Find a skill" onChange={(e) => setQ(e.target.value)} />
      {!groups.length && <p className="faint" style={{ margin: 0 }}>No bot you can use answers that.</p>}
      {groups.map(([bot, skills]) => (
        <section key={bot} className="sk-group" aria-label={skills[0].botTitle}>
          <h4 className="sk-bot"><span className={`sk-tag mono${skills[0].system ? ' sys' : ''}`} aria-hidden="true">{tagLetters(skills[0].botTitle)}</span><span translate="no">{skills[0].botTitle}</span>{skills[0].system ? <span className="sk-chip">SYSTEM</span> : skills[0].public ? <span className="sk-chip">OFFICE</span> : <span className="sk-chip">YOURS</span>}</h4>
          <ul className="sk-blocks">
            {skills.map((s) => (
              <li key={s.id}>
                <button type="button" className={`sk-block${picked === s.id ? ' on' : ''}${s.effect === 'act' ? ' act' : ''}`} aria-pressed={picked === s.id} onClick={() => onPick(s)}>
                  <span className="sk-short mono">{s.short}</span>
                  <b>{s.title}</b>
                  <span className="sk-about">{s.about}</span>
                  <span className="sk-io mono"><span>{s.inputs.length ? s.inputs.map((i) => i.label).join(' · ') : '—'}</span><span aria-hidden="true">{' → '}</span><span>{s.outputs.map((o) => o.label).join(' · ')}</span></span>
                  {s.effect === 'act' && <span className="sk-chip warn">DOES IT</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** The inputs of a picked skill, filled from words or earlier answers. */
export function SkillFields({ def, ask, onChange, upTo }: { def: BotFlowDefinition; ask: BotAsk; onChange: (a: BotAsk) => void; upTo?: number }) {
  const id = useId();
  const net = useNet();
  const skill = net.skills.find((s) => s.id === ask.skill);
  if (!skill) return <p className="faint bm-wide" style={{ margin: 0 }}>{net.loaded ? `“${ask.skill}” is not a skill your bots can ask. Pick another.` : '…'}</p>;
  const set = (k: string, v: string) => { const w = { ...(ask.with ?? {}) }; if (v) w[k] = v; else delete w[k]; onChange({ ...ask, with: Object.keys(w).length ? w : undefined }); };
  return (
    <>
      {skill.inputs.map((i) => (
        <div key={i.id} className="field">
          <label htmlFor={`${id}-${i.id}`}>{i.label}{i.optional ? <span className="faint"> (optional)</span> : null}</label>
          {i.options?.length ? (
            <select id={`${id}-${i.id}`} className="input" value={ask.with?.[i.id] ?? ''} onChange={(e) => set(i.id, e.target.value)}>
              <option value="">{i.optional ? 'Any' : 'Choose…'}</option>
              {i.options.map((o) => <option key={o} value={o}>{o}</option>)}
              {def.steps.slice(0, upTo ?? def.steps.length).map((s) => <option key={s.id} value={`{{${s.save ?? s.id}}}`}>{`The answer to “${s.label || s.id}”`}</option>)}
            </select>
          ) : (
            <input id={`${id}-${i.id}`} className="input" value={ask.with?.[i.id] ?? ''} placeholder={i.kind === 'person' ? '{{user.value}}' : i.kind === 'date' ? 'today, tomorrow or 2026-11-20' : ''} onChange={(e) => set(i.id, e.target.value)} />
          )}
          {!i.options?.length && <InsertChips def={def} upTo={upTo} summary={false} onInsert={(t) => set(i.id, `${ask.with?.[i.id] ?? ''}${i.kind === 'person' ? t.replace('}}', '.value}}') : t}`)} />}
          {i.kind === 'person' && !ask.with?.[i.id] && <span className="bm-hint">Left empty: the person answering.</span>}
        </div>
      ))}
      <div className="field">
        <label htmlFor={`${id}-fail`}>If it cannot answer</label>
        <select id={`${id}-fail`} className="input" value={ask.onFail ?? 'ask'} onChange={(e) => onChange({ ...ask, onFail: e.target.value === 'ask' ? undefined : e.target.value as 'skip' })}>
          <option value="ask">Ask the person instead</option>
          <option value="skip">Carry on without it</option>
          <option value="stop">Stop, and say why</option>
        </select>
      </div>
    </>
  );
}

/** The block for a skill already chosen, with a way to choose again. */
export function ChosenSkill({ ask, onClear }: { ask: BotAsk; onClear: () => void }) {
  const net = useNet();
  const s = net.skills.find((x) => x.id === ask.skill);
  return (
    <div className="sk-chosen bm-wide">
      <span className={`sk-tag mono${s?.system ? ' sys' : ''}`} aria-hidden="true">{tagLetters(s?.botTitle ?? ask.skill)}</span>
      <span className="sk-chosen-words"><span className="mono faint">{s?.short ?? ''}</span><b>{s?.title ?? ask.skill}</b><span className="faint" translate="no">{s?.botTitle ?? ''}</span></span>
      <button type="button" className="btn ghost sm" onClick={onClear}><Icon name="refresh" size={13} />Ask something else</button>
    </div>
  );
}
