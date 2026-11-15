// 01 Identity: what the bot is called, its mark and colour, its voice, when it is open and whether
// it remembers. The voice is shown as the bot would say things, so the choice is heard, not read.
import { useId, useRef } from 'react';
import type { BotColour, BotFlowDefinition, BotGlyph, BotPersona, BotTone } from '@dex/core';
import { BOT_COLOURS, BOT_GLYPHS, BOT_TONES } from '@dex/core';
import { hoursText, voiceOf } from '@dex/core/botflows';
import { monogram, slugify } from '@dex/core/botmaker';
import { ToggleRow } from '../../ui.tsx';
import { BotMarkTile, COLOUR_WORDS, GLYPH_WORDS, GlyphSvg } from '../BotMark.tsx';
import { InsertChips, insertAt } from './Steps.tsx';

export const TONE_WORDS: Record<BotTone, { name: string; hint: string }> = {
  plain: { name: 'Plain', hint: 'Says what it needs, nothing more.' },
  warm: { name: 'Warm', hint: 'Friendly, thanks people, uses their name.' },
  brief: { name: 'Brief', hint: 'As few words as possible.' },
  formal: { name: 'Formal', hint: 'For clients and office-wide notices.' },
};
const DAYS = [{ d: 1, s: 'Mon' }, { d: 2, s: 'Tue' }, { d: 3, s: 'Wed' }, { d: 4, s: 'Thu' }, { d: 5, s: 'Fri' }, { d: 6, s: 'Sat' }, { d: 0, s: 'Sun' }];
export const DEFAULT_PERSONA = (title: string): BotPersona => ({ mark: { kind: 'monogram', letters: monogram(title) }, colour: 'teal', tone: 'plain' });

export function IdentitySection({ def, setDef, nameLocked, me }: { def: BotFlowDefinition; setDef: (d: BotFlowDefinition) => void; nameLocked: boolean; me: string }) {
  const id = useId();
  const greet = useRef<HTMLTextAreaElement>(null);
  const p = def.persona ?? DEFAULT_PERSONA(def.title);
  const setP = (patch: Partial<BotPersona>) => setDef({ ...def, persona: { ...p, ...patch } });
  const voice = voiceOf(p.tone);
  const first = me.split(/\s+/)[0] || me;
  const sample = [
    (p.greeting || voice.greeting('{{user.first}}', def.title || 'Your bot')).replace(/\{\{\s*user\.first\s*\}\}/g, first).replace(/\{\{[^}]+\}\}/g, '…'),
    voice.sameAsLast('A1'),
    voice.chooseOne,
    def.done ? def.done.replace(/\{\{[^}]+\}\}/g, '…') : voice.done,
  ];
  return (
    <div className="bm-section bm-identity">
      <div className="bm-grid">
        <div className="field">
          <label htmlFor={`${id}-title`}>Name</label>
          <input id={`${id}-title`} className="input bm-title-input" maxLength={80} value={def.title} placeholder="Plot request"
            onChange={(e) => {
              const title = e.target.value;
              const autoLetters = p.mark.kind === 'monogram' && (!p.mark.letters || p.mark.letters === monogram(def.title));
              setDef({ ...def, title, ...(nameLocked ? {} : { name: slugify(title || 'my-bot') }), persona: { ...p, ...(autoLetters ? { mark: { kind: 'monogram', letters: monogram(title || 'B') } } : {}) } });
            }} />
          <span className="bm-hint mono"><span translate="no">/{def.name}</span>{nameLocked && <span> · short name kept once saved</span>}</span>
        </div>
        <div className="field">
          <label htmlFor={`${id}-about`}>What it is for (one line)</label>
          <input id={`${id}-about`} className="input" maxLength={200} value={p.about ?? ''} placeholder="Plots go to your lead, then to the plot room."
            onChange={(e) => setDef({ ...def, persona: { ...p, about: e.target.value || undefined }, description: e.target.value || undefined })} />
        </div>
      </div>

      <fieldset className="bm-block">
        <legend className="bm-legend">Mark</legend>
        <div className="bm-mark-row">
          <BotMarkTile mark={p.mark} colour={p.colour} size={56} />
          <div className="bm-mark-pick">
            <div className="seg" role="group" aria-label="Kind of mark">
              <button type="button" aria-pressed={p.mark.kind === 'glyph'} onClick={() => setP({ mark: { kind: 'glyph', glyph: p.mark.glyph ?? 'sheet' } })}>Symbol</button>
              <button type="button" aria-pressed={p.mark.kind === 'monogram'} onClick={() => setP({ mark: { kind: 'monogram', letters: p.mark.letters || monogram(def.title || 'B') } })}>Letters</button>
            </div>
            {p.mark.kind === 'monogram' ? (
              <div className="field bm-letters"><label htmlFor={`${id}-letters`}>Letters</label>
                <input id={`${id}-letters`} className="input mono" maxLength={2} value={p.mark.letters ?? ''} onChange={(e) => setP({ mark: { kind: 'monogram', letters: e.target.value.toUpperCase().replace(/\s/g, '') } })} /></div>
            ) : (
              <div className="bm-glyphs" role="group" aria-label="Symbol">
                {BOT_GLYPHS.map((g: BotGlyph) => (
                  <button key={g} type="button" className="bm-glyph" aria-pressed={p.mark.glyph === g} aria-label={GLYPH_WORDS[g]} title={GLYPH_WORDS[g]} onClick={() => setP({ mark: { kind: 'glyph', glyph: g } })}>
                    <GlyphSvg glyph={g} size={20} />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="bm-colours" role="group" aria-label="Colour">
          {(Object.keys(BOT_COLOURS) as BotColour[]).map((c) => (
            <button key={c} type="button" className="bm-colour" aria-pressed={p.colour === c} aria-label={COLOUR_WORDS[c]} title={COLOUR_WORDS[c]} onClick={() => setP({ colour: c })}>
              <span style={{ background: BOT_COLOURS[c] }} /><i>{COLOUR_WORDS[c]}</i>
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="bm-block">
        <legend className="bm-legend">Voice</legend>
        <div className="bm-tones" role="group" aria-label="Voice">
          {BOT_TONES.map((t) => (
            <button key={t} type="button" className="bm-tone" aria-pressed={p.tone === t} onClick={() => setP({ tone: t })}>
              <b>{TONE_WORDS[t].name}</b><span>{TONE_WORDS[t].hint}</span>
            </button>
          ))}
        </div>
        <figure className="bm-sample" aria-label="How it sounds">
          <figcaption className="bm-legend">How it sounds</figcaption>
          <ul>{sample.map((line, i) => <li key={i} translate="no">{line}</li>)}</ul>
        </figure>
        <div className="field">
          <label htmlFor={`${id}-greet`}>Greeting (the first thing it says)</label>
          <textarea ref={greet} id={`${id}-greet`} className="input" rows={2} maxLength={400} value={p.greeting ?? ''} placeholder={voice.greeting('{{user.first}}', def.title || 'Your bot')}
            onChange={(e) => setP({ greeting: e.target.value || undefined })} />
          <InsertChips def={{ ...def, steps: [] }} summary={false} onInsert={(t) => setP({ greeting: insertAt(greet.current, p.greeting ?? '', t) })} />
        </div>
      </fieldset>

      <fieldset className="bm-block">
        <legend className="bm-legend">When and how</legend>
        <ToggleRow checked={!!p.hours} label="Only during office hours" onChange={(on) => setP({ hours: on ? { days: [1, 2, 3, 4, 5], from: '09:00', to: '18:30' } : null })} />
        {p.hours && (
          <div className="bm-hours">
            <div className="bm-days" role="group" aria-label="Days it is open">
              {DAYS.map(({ d, s }) => (
                <button key={d} type="button" aria-pressed={p.hours!.days.includes(d)} onClick={() => {
                  const days = p.hours!.days.includes(d) ? p.hours!.days.filter((x) => x !== d) : [...p.hours!.days, d];
                  setP({ hours: { ...p.hours!, days } });
                }}>{s}</button>
              ))}
            </div>
            <label className="bm-time">From<input className="input mono" type="time" value={p.hours.from} onChange={(e) => setP({ hours: { ...p.hours!, from: e.target.value } })} /></label>
            <label className="bm-time">to<input className="input mono" type="time" value={p.hours.to} onChange={(e) => setP({ hours: { ...p.hours!, to: e.target.value } })} /></label>
            {p.hours.days.length > 0 && <span className="bm-hint mono">{hoursText(p.hours)}</span>}
          </div>
        )}
        <ToggleRow checked={!!p.remember} label="Remember each person's last answers and offer them next time" onChange={(on) => setP({ remember: on || undefined })} />
      </fieldset>
    </div>
  );
}
