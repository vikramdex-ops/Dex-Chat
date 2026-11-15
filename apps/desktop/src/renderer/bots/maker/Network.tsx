// Other bots: what this bot answers for other bots (its skills, and whose bots may ask them),
// whether it takes requests other bots hand to it, what it listens for ("when a DC request is
// issued, tell me"; "when someone goes on leave, release their seats"), and, in words, every bot
// it asks or hands to. The same parts are in the JSON (network, steps' ask, a handoff at the end).
import { useId, useRef } from 'react';
import type { BotFlowDefinition, BotNetwork, BotSubscription } from '@dex/core';
import { declaredLinks, eventWords, skillsOf } from '@dex/core/botnet';
import { Icon, ToggleRow } from '../../ui.tsx';
import { openBotNetwork } from '../net/open.ts';
import { insertAt } from './Steps.tsx';
import { ChosenSkill, SkillBlocks, SkillFields } from './SkillBlocks.tsx';
import { botTitle, useNet } from './netdata.ts';

const pad = (n: number) => String(n).padStart(2, '0');
const KIND_WORDS = { query: 'Asks', handoff: 'Hands requests to', event: 'Listens to' } as const;

function SubEditor({ def, sub, onChange }: { def: BotFlowDefinition; sub: BotSubscription; onChange: (s: BotSubscription) => void }) {
  const id = useId();
  const net = useNet();
  const text = useRef<HTMLTextAreaElement>(null);
  const [source, what, stage] = sub.on === 'nib.away' ? ['nib', 'away', ''] : sub.on.split('.');
  const src = source !== 'nib' ? net.definition(source) : null;
  const stamps = [...new Set((src?.track?.stages ?? []).flatMap((s) => s.actions.filter((a) => a.to === 'end').map((a) => a.stamp ?? (a.outcome === 'stopped' ? 'STOPPED' : 'DONE'))))];
  const setOn = (on: string) => { const { stamp: _s, ...rest } = sub; onChange({ ...rest, on }); };
  return (
    <div className="bm-step-edit">
      <div className="field">
        <label htmlFor={`${id}-src`}>Listen to</label>
        <select id={`${id}-src`} className="input" value={source} onChange={(e) => setOn(e.target.value === 'nib' ? 'nib.away' : `${e.target.value}.closed`)}>
          <option value="nib">Nib: someone goes on leave</option>
          {net.bots.filter((b) => b.name !== def.name).map((b) => <option key={b.name} value={b.name}>{b.title}</option>)}
          {source !== 'nib' && !net.bots.some((b) => b.name === source) && <option value={source}>{botTitle(net, source)}</option>}
        </select>
      </div>
      {source !== 'nib' && (
        <div className="field">
          <label htmlFor={`${id}-what`}>When a request</label>
          <select id={`${id}-what`} className="input" value={what === 'stage' ? `stage.${stage}` : what} onChange={(e) => setOn(`${source}.${e.target.value}`)}>
            <option value="opened">is sent</option>
            <option value="closed">closes</option>
            {(src?.track?.stages ?? []).map((s) => <option key={s.id} value={`stage.${s.id}`}>{`reaches ${s.label}`}</option>)}
          </select>
        </div>
      )}
      {what === 'closed' && (
        <div className="field">
          <label htmlFor={`${id}-st`}>With the stamp</label>
          <select id={`${id}-st`} className="input" value={sub.stamp ?? ''} onChange={(e) => onChange({ ...sub, stamp: e.target.value || undefined })}>
            <option value="">Any stamp</option>
            {stamps.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </div>
      )}
      <div className="field">
        <label htmlFor={`${id}-do`}>Then</label>
        <select id={`${id}-do`} className="input" value={sub.do} onChange={(e) => { const d = e.target.value as BotSubscription['do']; onChange({ id: sub.id, on: sub.on, ...(sub.stamp ? { stamp: sub.stamp } : {}), do: d, ...(d === 'tell' ? { text: sub.text || '{{ref}} · {{title}}: {{stamp}}' } : {}), ...(d === 'ask' ? { ask: sub.ask ?? { skill: '' }, text: sub.text } : {}) }); }}>
          <option value="tell">Tell me</option>
          <option value="start">{`Start ${def.title || 'this bot'} for the person it is about`}</option>
          <option value="ask">Ask a bot to do something</option>
        </select>
      </div>
      {sub.do === 'ask' && (
        <div className="bm-wide bm-askbot">
          {sub.ask?.skill ? <ChosenSkill ask={sub.ask} onClear={() => onChange({ ...sub, ask: { skill: '' } })} /> : <SkillBlocks exclude={def.name} onPick={(sk) => onChange({ ...sub, ask: { skill: sk.id, with: Object.fromEntries(sk.inputs.filter((i) => i.kind === 'person').map((i) => [i.id, '{{user.value}}'])) } })} />}
          {sub.ask?.skill && <div className="bm-grid"><SkillFields def={{ ...def, steps: [] }} ask={sub.ask} onChange={(ask) => onChange({ ...sub, ask })} /></div>}
        </div>
      )}
      {(sub.do === 'tell' || sub.do === 'ask') && (
        <div className="field bm-wide">
          <label htmlFor={`${id}-t`}>{sub.do === 'tell' ? 'What it tells you' : 'Then it tells you (optional)'}</label>
          <textarea ref={text} id={`${id}-t`} className="input" rows={2} maxLength={1000} value={sub.text ?? ''} onChange={(e) => onChange({ ...sub, text: e.target.value || undefined })} />
          <div className="bm-insert" role="group" aria-label="Insert">
            <span className="bm-insert-label">Insert</span>
            {(source === 'nib' ? [['{{user}}', 'Who'], ['{{from}}', 'From'], ['{{to}}', 'To']] : [['{{ref}}', 'Number'], ['{{title}}', 'Name'], ['{{user}}', 'Who asked'], ['{{stamp}}', 'Stamp']]).concat(sub.do === 'ask' ? [['{{result}}', 'The answer']] : []).map(([t, l]) => (
              <button key={t} type="button" className="bm-token" onClick={() => onChange({ ...sub, text: insertAt(text.current, sub.text ?? '', t) })}>{l}</button>
            ))}
          </div>
        </div>
      )}
      {sub.do === 'start' && <p className="faint bm-wide" style={{ margin: 0 }}>Answers with the same names are carried across; the person answers the rest in their conversation with this bot.</p>}
    </div>
  );
}

export function NetworkSection({ def, setDef, scope }: { def: BotFlowDefinition; setDef: (d: BotFlowDefinition) => void; scope: string }) {
  const net = useNet();
  const nw: BotNetwork = def.network ?? {};
  const setNet = (n: BotNetwork) => { const clean = Object.fromEntries(Object.entries(n).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length))) as BotNetwork; const { network: _n, ...rest } = def; setDef(Object.keys(clean).length ? { ...rest, network: clean } : rest); };
  const skills = skillsOf(def, { public: scope === 'office' });
  const subs = nw.on ?? [];
  const links = declaredLinks(def);
  const setSub = (i: number, s: BotSubscription | null) => setNet({ ...nw, on: s ? subs.map((x, j) => (j === i ? s : x)) : subs.filter((_, j) => j !== i) });
  const fresh = () => { for (let i = 1; i < 99; i++) if (!subs.some((s) => s.id === `on${i}`)) return `on${i}`; return `on${Date.now().toString(36)}`; };
  return (
    <div className="bm-section">
      <fieldset className="bm-block">
        <legend className="bm-legend">01 What other bots may ask it</legend>
        <ul className="sk-blocks" aria-label="Its skills">
          {skills.map((s) => (
            <li key={s.id}><span className="sk-block static"><span className="sk-short mono">{s.short}</span><b>{s.title}</b><span className="sk-io mono"><span>{s.inputs.map((i) => i.label).join(' · ') || '—'}</span><span aria-hidden="true">{' → '}</span><span>{s.outputs.map((o) => o.label).join(' · ')}</span></span>{s.effect === 'act' && <span className="sk-chip warn">DOES IT</span>}</span></li>
          ))}
        </ul>
        <span className="bm-hint">{def.track ? 'From its requests: how many are open, where one is, and (with limited places) whether one is free.' : 'Without requests to track, it answers how many were sent.'} Answers never show a request to a bot whose person may not see it.</span>
        <div className="field">
          <label htmlFor="bm-share">Who may ask it</label>
          <select id="bm-share" className="input" value={nw.share ?? 'users'} onChange={(e) => setNet({ ...nw, share: e.target.value === 'owner' ? 'owner' : undefined })}>
            <option value="users">The bots of anyone who may use it</option>
            <option value="owner">Only my own bots</option>
          </select>
        </div>
        <ToggleRow checked={nw.accept !== false} onChange={(v) => setNet({ ...nw, accept: v ? undefined : false })} label="It takes requests other bots hand to it" />
      </fieldset>

      <fieldset className="bm-block">
        <legend className="bm-legend">02 What it listens for</legend>
        {!subs.length && <p className="faint" style={{ margin: 0 }}>Nothing yet. A bot can act when another bot’s request is sent, reaches a stage or closes, or when someone goes on leave.</p>}
        {subs.length > 0 && (
          <ol className="bm-ends" aria-label="What it listens for">
            {subs.map((s, i) => (
              <li key={s.id} className="bm-end">
                <div className="bm-end-head">
                  <span className="bm-step-no mono">{pad(i + 1)}</span>
                  <span className="bm-kind bot">LISTENS</span>
                  <span className="bm-end-name">{eventWords(s.on, (f) => botTitle(net, f), s.stamp)}</span>
                  <button type="button" className="icon-btn sm" aria-label={`Stop listening: ${eventWords(s.on, (f) => botTitle(net, f), s.stamp)}`} onClick={() => setSub(i, null)}><Icon name="trash" size={14} /></button>
                </div>
                <SubEditor def={def} sub={s} onChange={(x) => setSub(i, x)} />
              </li>
            ))}
          </ol>
        )}
        <div className="bm-add" role="group" aria-label="Listen for">
          <button type="button" className="bm-add-btn bot" disabled={subs.length >= 8} onClick={() => setNet({ ...nw, on: [...subs, { id: fresh(), on: 'nib.away', do: 'tell', text: '{{user}} is on leave from {{from}}.' }] })}><Icon name="plus" size={13} />Listen for something</button>
        </div>
      </fieldset>

      <fieldset className="bm-block">
        <legend className="bm-legend">03 The bots it works with</legend>
        {!links.length && <p className="faint" style={{ margin: 0 }}>It works on its own. A question can ask another bot (Questions → Ask a bot), the end can hand the request on (At the end), and a stage can wait on another bot (Afterwards).</p>}
        {links.length > 0 && (
          <ul className="bm-links">
            {links.map((l) => <li key={`${l.kind}:${l.to}`}><span className="bm-kind bot">{l.kind === 'query' ? 'ASKS' : l.kind === 'handoff' ? 'HANDS TO' : 'LISTENS'}</span><span>{KIND_WORDS[l.kind]} <b translate="no">{botTitle(net, l.to)}</b></span></li>)}
          </ul>
        )}
        <span className="bm-hint">Bots ask and hand only to bots you may use. A request passes through four bots at most and never loops back; each bot asks at most thirty times a minute. Everything is in the audit log. Bot conversations are not end-to-end encrypted.</span>
        <button type="button" className="btn ghost sm" style={{ justifySelf: 'start' }} onClick={() => openBotNetwork('mine')}><Icon name="branch" size={14} />See the bot network</button>
      </fieldset>
    </div>
  );
}
