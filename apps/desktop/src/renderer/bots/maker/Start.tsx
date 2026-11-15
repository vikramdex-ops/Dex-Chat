// A new bot starts from something: a template that suits a design office, a few words describing
// it (drafted on this PC by the small sentence model, or from keywords when it cannot load), a
// copy of a bot you can already use, or a blank sheet.
import { useEffect, useId, useState } from 'react';
import type { BotFlowDefinition, BotFlowInfo } from '@dex/core';
import { BOT_TEMPLATES, blankBot, duplicateBot } from '@dex/core/botmaker';
import { draftBot } from '@dex/core/bot-describe';
import { Icon, useToast } from '../../ui.tsx';
import { loadModel, modelRanker, modelState, onModelState } from '../../flows/model.ts';
import type { ModelState } from '../../flows/model.ts';
import { BotMarkTile } from '../BotMark.tsx';

type Way = 'template' | 'words' | 'copy';

export function StartPanel({ spaces, onPick, onPreview }: {
  spaces: Array<{ id: string; name: string }>;
  onPick: (def: BotFlowDefinition, notes?: string[]) => void;
  /** Show a template in the test run while it is looked at. */
  onPreview: (def: BotFlowDefinition) => void;
}) {
  const toast = useToast();
  const id = useId();
  const [way, setWay] = useState<Way>('template');
  const [words, setWords] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [model, setModel] = useState<ModelState>(modelState());
  const [usable, setUsable] = useState<BotFlowInfo[] | null>(null);
  useEffect(() => onModelState(setModel), []);
  useEffect(() => { if (way === 'words') void loadModel(); }, [way]);
  useEffect(() => {
    if (way !== 'copy' || usable) return;
    void Promise.all([window.dex.request('botflow.list'), window.dex.request('botflow.mine')])
      .then(([list, mine]) => { const seen = new Set<string>(); setUsable([...mine, ...list].filter((f) => !seen.has(f.name) && seen.add(f.name))); })
      .catch(() => setUsable([]));
  }, [way, usable]);
  const draft = async () => {
    if (!words.trim()) return;
    setDrafting(true);
    try {
      const rank = await modelRanker().catch(() => null);
      const d = await draftBot(words, { spaces }, rank);
      const notes = [...d.notes];
      if (!rank) notes.unshift('Drafted from keywords: the on-device model is not available on this PC. Check each question.');
      onPick(d.definition, notes);
    } catch (e) { toast((e as Error).message, true); } finally { setDrafting(false); }
  };
  const copy = async (f: BotFlowInfo) => {
    try {
      const { definition } = await window.dex.request('botflow.definition', { name: f.name });
      onPick(duplicateBot(definition), [`A copy of ${f.title}. Give it its own name, then change what you need.`]);
    } catch (e) { toast((e as Error).message, true); }
  };
  const modelLine = model.phase === 'ready' ? 'On-device model ready · nothing leaves this PC'
    : model.phase === 'loading' ? 'Loading the on-device model…'
      : model.phase === 'failed' ? 'The on-device model is not available; it drafts from keywords' : 'Drafted on this PC · nothing leaves it';
  return (
    <div className="bm-start">
      <h2 className="bm-start-title">Make a bot</h2>
      <p className="muted bm-start-lead">A bot asks people one question at a time in their own conversation with it, keeps their place, and at the end puts a task on someone’s Desk, posts in a Space or sets a reminder.</p>
      <div className="seg seg-register bm-ways" role="group" aria-label="Start from">
        <button type="button" aria-pressed={way === 'template'} onClick={() => setWay('template')}><Icon name="sheet" size={15} />A template</button>
        <button type="button" aria-pressed={way === 'words'} onClick={() => setWay('words')}><Icon name="edit" size={15} />Describe it in words</button>
        <button type="button" aria-pressed={way === 'copy'} onClick={() => setWay('copy')}><Icon name="copy" size={15} />Copy a bot</button>
      </div>

      {way === 'template' && (
        <ul className="bm-templates" aria-label="Templates">
          {BOT_TEMPLATES.map((t) => (
            <li key={t.id} className="bm-template" onMouseEnter={() => onPreview(t.definition)} onFocus={() => onPreview(t.definition)}>
              <BotMarkTile mark={t.definition.persona!.mark} colour={t.definition.persona!.colour} size={36} />
              <span className="bm-template-text">
                <b>{t.title}</b>
                <span className="faint">{t.about}</span>
                <span className="mono bm-template-steps">{t.definition.steps.filter((s) => s.input.kind !== 'confirm').map((s) => s.label ?? s.id).join(' · ')}</span>
              </span>
              <button type="button" className="btn sm" aria-label={`Start from ${t.title}`} onClick={() => onPick(JSON.parse(JSON.stringify(t.definition)) as BotFlowDefinition)}>Use this</button>
            </li>
          ))}
          <li className="bm-template blank">
            <span className="bot-tile bm-blank-tile" style={{ width: 36, height: 36 }} aria-hidden="true"><Icon name="plus" size={18} /></span>
            <span className="bm-template-text"><b>Blank</b><span className="faint">One question and a reminder; build it up yourself.</span></span>
            <button type="button" className="btn sm" aria-label="Start from a blank bot" onClick={() => onPick(blankBot('My bot'))}>Start blank</button>
          </li>
        </ul>
      )}

      {way === 'words' && (
        <div className="bm-words">
          <div className="field">
            <label htmlFor={`${id}-words`}>What should it do? Say what it asks, in order, and what happens at the end.</label>
            <textarea id={`${id}-words`} className="input" rows={6} maxLength={2000} value={words} onChange={(e) => setWords(e.target.value)}
              placeholder="A friendly bot for plot requests. Ask for the job number, which drawings, the sheet size (A0, A1 or A3), how many sets and when they are needed. Then ask who approves it, confirm, and put a task on their Desk."
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void draft(); }} />
          </div>
          <div className="bm-words-foot">
            <span className={`mono bm-model ${model.phase}`} role="status">{modelLine}</span>
            <span className="grow" />
            <button type="button" className="btn primary" disabled={!words.trim() || drafting} onClick={() => void draft()}>{drafting ? <span className="spinner" /> : <Icon name="edit" size={15} />}Draft my bot</button>
          </div>
          <p className="faint bm-hint">It drafts; you check. Every question can be changed before anyone sees it.</p>
        </div>
      )}

      {way === 'copy' && (
        <ul className="bm-templates" aria-label="Bots you can copy">
          {usable === null && <li className="bm-template"><span className="spinner" /></li>}
          {usable?.length === 0 && <li className="bm-template faint">No bots to copy yet.</li>}
          {usable?.map((f) => (
            <li key={f.name} className="bm-template">
              {f.persona ? <BotMarkTile mark={f.persona.mark} colour={f.persona.colour} size={36} /> : <span className="bot-tile bm-blank-tile" style={{ width: 36, height: 36 }} aria-hidden="true"><Icon name="branch" size={18} /></span>}
              <span className="bm-template-text"><b translate="no">{f.title}</b><span className="faint" translate="no">{f.description ?? f.botName}</span><span className="mono bm-template-steps">{f.steps} questions</span></span>
              <button type="button" className="btn sm" aria-label={`Copy ${f.title}`} onClick={() => void copy(f)}>Copy and change</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
