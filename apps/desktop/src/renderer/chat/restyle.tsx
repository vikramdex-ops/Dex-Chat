// Restyle: rewrite a draft in one of five communication styles on this PC (no model, no network)
// and go through the changes like a marked-up drawing: each one is a revision mark (Δ1, Δ2…) that
// can be accepted or rejected on its own, then "Use this" or "Keep mine". The same sheet restyles a
// copy of someone else's message for yourself (read-only, to copy). On phones it is a bottom sheet.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { PublicUser } from '@dex/core';
import type { RestyleResult, RestyleStyle } from '@dex/core/restyle';
import { Icon, Popover, useToast } from '../ui.tsx';
import './messages.css';

export const STYLES: Array<{ id: RestyleStyle; label: string; hint: string }> = [
  { id: 'concise', label: 'Concise', hint: 'Fewer words, same facts' },
  { id: 'formal', label: 'Formal', hint: 'For clients and letters' },
  { id: 'diplomatic', label: 'Diplomatic', hint: 'Softer, without blame' },
  { id: 'explanatory', label: 'Explanatory', hint: 'Spells out terms and steps' },
  { id: 'technical', label: 'Technical', hint: 'Units, terms and lists' },
];

/** What each kind of revision did, in a few words (shown on the mark and in the schedule). */
const RULES: Record<string, string> = {
  'concise.filler': 'Filler dropped', 'concise.greeting': 'Greeting trimmed', 'concise.phrase': 'Shorter phrase', 'concise.repeat': 'Repeat removed',
  'diplomatic.absolute': 'Absolute softened', 'diplomatic.blame': 'Blame taken out', 'diplomatic.courtesy': 'Courtesy added', 'diplomatic.harsh': 'Harsh word softened', 'diplomatic.request': 'Asked, not told',
  'explanatory.glossary': 'Term spelled out', 'explanatory.structure': 'Steps laid out', 'explanatory.time': 'Time made clear',
  'formal.capital': 'Capital letter', 'formal.casual': 'Formal wording', 'formal.contraction': 'Contraction expanded', 'formal.emoji': 'Emoji removed', 'formal.exclaim': 'Exclamation calmed', 'formal.punctuation': 'Punctuation',
  'technical.abbreviation': 'Standard abbreviation', 'technical.approx': 'Approximation marked', 'technical.list': 'Made a list', 'technical.term': 'Technical term', 'technical.unit': 'SI unit',
};
const ruleLabel = (rule: string) => rule.split('+').map((r) => RULES[r] ?? 'Reworded').filter((x, i, a) => a.indexOf(x) === i).join(' · ');

type Engine = typeof import('@dex/core/restyle');
let engine: Promise<Engine> | null = null;
/** The rewriter is loaded the first time someone restyles (it is not needed to start the app). */
const loadEngine = () => (engine ??= import('@dex/core/restyle'));

/** Names to keep exactly as written: everyone in the directory, whole and by each part of the name. */
export function directoryNames(users: Iterable<PublicUser>): string[] {
  const out = new Set<string>();
  for (const u of users) {
    if (!u.displayName) continue;
    out.add(u.displayName);
    for (const part of u.displayName.split(/\s+/)) if (part.length >= 3 && /^\p{Lu}/u.test(part)) out.add(part);
  }
  return [...out];
}

/** Stored bodies hold <@id>; restyling works on the text as people read it. */
export function readable(body: string, users: Map<string, PublicUser>): string {
  return body.replace(/<@all>/g, '@everyone').replace(/<@([0-9A-Z]{26})>/g, (_, id: string) => `@${users.get(id)?.displayName ?? 'someone'}`);
}

// ------------------------------------------------------------------ the Dock's stamp picker
/** The Restyle control in the Dock: the five styles as stamps. */
export function RestyleControl({ text, disabled, onPick }: { text: string; disabled: boolean; onPick: (s: RestyleStyle) => void }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const empty = !text.trim() || text.trim().startsWith('/');
  return (
    <>
      <button ref={btn} className="icon-btn restyle-btn" title={empty ? 'Restyle: write something first' : 'Restyle this draft'} aria-label="Restyle"
        aria-haspopup="menu" aria-expanded={open} disabled={disabled || empty} onClick={() => { void loadEngine(); setOpen(!open); }}>
        <Icon name="restyle" size={18} />
      </button>
      {open && (
        <Popover anchor={btn.current} onClose={() => setOpen(false)} className="menu restyle-pick" align="start">
          <div className="menu-label label">Restyle as</div>
          <div className="style-stamps" role="group" aria-label="Styles">
            {STYLES.map((s) => (
              <button key={s.id} role="menuitem" className="style-stamp" onClick={() => { setOpen(false); onPick(s.id); }}>
                <span className="stamp-word">{s.label}</span><span className="stamp-hint">{s.hint}</span>
              </button>
            ))}
          </div>
          <div className="restyle-fine faint">Rewritten on this PC. Numbers, names, dates, drawing and line numbers, links and quotes stay as written.</div>
        </Popover>
      )}
    </>
  );
}

// ------------------------------------------------------------------ the marked-up sheet
interface Pieces { result: ReactNode[]; source: ReactNode[] }

/** Both columns: the original with what changes struck, and the new text with a mark at each change. */
function pieces(src: string, r: RestyleResult, rejected: Set<number>, toggle: (id: number) => void, readOnlyMarks: boolean): Pieces {
  const result: ReactNode[] = [];
  let pos = 0;
  const byAt = [...r.changes].sort((a, b) => a.at - b.at);
  for (const c of byAt) {
    if (c.at > pos) result.push(<span key={`t${pos}`}>{r.text.slice(pos, c.at)}</span>);
    const no = rejected.has(c.id);
    const shown = no ? c.from : c.to;
    // the mark sits on the words; a line break or space the change ends with stays outside it
    const tail = /\s*$/.exec(shown)?.[0] ?? '';
    const core = shown.slice(0, shown.length - tail.length);
    result.push(
      <button key={`c${c.id}`} type="button" className={`rev-mark${no ? ' rejected' : ' accepted'}${!core ? ' empty' : ''}`} disabled={readOnlyMarks}
        onClick={() => toggle(c.id)} aria-pressed={!no} title={`${ruleLabel(c.rule)}: ${no ? 'rejected, click to accept' : 'accepted, click to reject'}`}
        aria-label={`Revision ${c.id + 1}, ${ruleLabel(c.rule)}, ${no ? 'rejected' : 'accepted'}`}>
        <span className="rev-text">{core || (no ? '' : '⁁')}</span><sup className="rev-delta" aria-hidden="true">{c.id + 1}</sup>
      </button>,
    );
    if (tail) result.push(<span key={`w${c.id}`}>{tail}</span>);
    pos = c.at + c.to.length;
  }
  if (pos < r.text.length) result.push(<span key={`t${pos}`}>{r.text.slice(pos)}</span>);
  const source: ReactNode[] = [];
  let sp = 0;
  for (const c of [...r.changes].sort((a, b) => a.sourceAt - b.sourceAt)) {
    if (c.sourceAt > sp) source.push(<span key={`s${sp}`}>{src.slice(sp, c.sourceAt)}</span>);
    const no = rejected.has(c.id);
    source.push(<span key={`o${c.id}`} className={`src-mark${no ? ' kept' : ''}${c.from ? '' : ' insert'}`}>{c.from || '‸'}<sup className="rev-delta" aria-hidden="true">{c.id + 1}</sup></span>);
    sp = c.sourceAt + c.from.length;
  }
  if (sp < src.length) source.push(<span key={`s${sp}`}>{src.slice(sp)}</span>);
  return { result, source };
}

function useNarrow(): boolean {
  const [n, setN] = useState(() => window.matchMedia('(max-width: 720px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 720px)');
    const on = () => setN(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return n;
}

/**
 * The restyle sheet. mode 'draft': for the Dock, ending with Use this / Keep mine.
 * mode 'copy': someone else's message, rephrased for yourself, ending with Copy.
 */
export function RestyleSheet({ text, style: initial, users, mode, onUse, onClose }: {
  text: string; style: RestyleStyle; users: Map<string, PublicUser>; mode: 'draft' | 'copy';
  onUse?: (text: string) => void; onClose: () => void;
}) {
  const toast = useToast();
  const narrow = useNarrow();
  const [style, setStyle] = useState<RestyleStyle>(initial);
  const [eng, setEng] = useState<Engine | null>(null);
  const [rejected, setRejected] = useState<Set<number>>(new Set());
  const [showSource, setShowSource] = useState(false);
  // the directory's names are kept exactly as written
  const names = useMemo(() => directoryNames(users.values()), [users]);
  useEffect(() => { let live = true; void loadEngine().then((e) => { if (live) setEng(e); }); return () => { live = false; }; }, []);
  useEffect(() => { setRejected(new Set()); }, [style]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);
  const result = useMemo(() => (eng ? eng.restyle(text, style, { names }) : null), [eng, text, style, names]);
  const final = result && eng ? eng.applyChoices(result, rejected) : text;
  const toggle = (id: number) => setRejected((cur) => { const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const p = result ? pieces(text, result, rejected, toggle, false) : null;
  const n = result?.changes.length ?? 0;
  const kept = n - rejected.size;
  const label = STYLES.find((s) => s.id === style)!.label;
  const sheet = (
    <div className={`scrim restyle-scrim${narrow ? ' bottom' : ''}`} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className={`restyle-sheet${narrow ? ' bottom' : ''}`} role="dialog" aria-modal="true" aria-label={mode === 'copy' ? 'Restyle a copy' : 'Restyle'}>
        <header className="rs-head">
          <div className="rs-title">
            <span className="label">{mode === 'copy' ? 'Restyle a copy · for you only' : 'Restyle · your draft'}</span>
            <h2>{label}</h2>
          </div>
          <dl className="title-block rs-block" aria-label="About these revisions">
            <div><dt>Revisions</dt><dd>{n}</dd></div>
            <div><dt>Kept</dt><dd>{kept}</dd></div>
          </dl>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </header>
        <div className="style-stamps inline" role="radiogroup" aria-label="Style">
          {STYLES.map((s) => (
            <button key={s.id} role="radio" aria-checked={style === s.id} className={`style-stamp${style === s.id ? ' on' : ''}`} onClick={() => setStyle(s.id)}>
              <span className="stamp-word">{s.label}</span>
            </button>
          ))}
        </div>
        {!result || !p ? <div className="tl-more"><span className="spinner" /></div> : n === 0 ? (
          <div className="rs-none"><Icon name="check" size={18} /><span>Nothing to change for {label.toLowerCase()}: it already reads that way.</span></div>
        ) : (
          <>
            <div className={`rs-cols${narrow && !showSource ? ' one' : ''}`}>
              {(!narrow || showSource) && (
                <div className="rs-col source">
                  <div className="rs-col-head label">As written</div>
                  <div className="rs-text selectable" translate="no">{p.source}</div>
                </div>
              )}
              <div className="rs-col result">
                <div className="rs-col-head label">{label}{narrow && <button className="link rs-toggle" onClick={() => setShowSource(!showSource)}>{showSource ? 'Hide what you wrote' : 'Show what you wrote'}</button>}</div>
                <div className="rs-text selectable" translate="no">{p.result}</div>
              </div>
            </div>
            <table className="rev-schedule" aria-label="Revisions">
              <thead><tr><th scope="col">Δ</th><th scope="col">Revision</th><th scope="col">Was</th><th scope="col">Becomes</th><th scope="col"><span className="sr-only">Keep it</span></th></tr></thead>
              <tbody>
                {result.changes.map((c) => {
                  const no = rejected.has(c.id);
                  return (
                    <tr key={c.id} className={no ? 'rejected' : undefined}>
                      <td className="mono">{c.id + 1}</td>
                      <td>{ruleLabel(c.rule)}</td>
                      <td className="was" translate="no">{c.from || <span className="faint">—</span>}</td>
                      <td className="becomes" translate="no">{c.to || <span className="faint">(removed)</span>}</td>
                      <td className="rev-choice">
                        <button className={`lbtn${no ? '' : ' on'}`} aria-pressed={!no} onClick={() => no && toggle(c.id)}>Accept</button>
                        <button className={`lbtn${no ? ' on' : ''}`} aria-pressed={no} onClick={() => !no && toggle(c.id)}>Reject</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
        <footer className="rs-foot">
          <span className="faint rs-note">{mode === 'copy' ? 'Only you see this version. The message itself does not change.' : 'Rewritten on this PC: nothing is sent until you press Send.'}</span>
          {mode === 'draft' ? (
            <>
              <button className="btn ghost" onClick={onClose}>Keep mine</button>
              <button className="btn primary" disabled={!result || n === 0 || kept === 0} onClick={() => { onUse?.(final); onClose(); }}><Icon name="check" size={15} />Use this{n > 0 && kept < n ? ` (${kept} of ${n})` : ''}</button>
            </>
          ) : (
            <>
              <button className="btn ghost" onClick={onClose}>Done</button>
              <button className="btn primary" disabled={!result} onClick={() => { void navigator.clipboard.writeText(final).then(() => toast('Copied')); }}><Icon name="copy" size={15} />Copy</button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
  return createPortal(sheet, document.body);
}
