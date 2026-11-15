// The bot maker: a drawing sheet with the bot's title block across the top, the editor on the
// left (01 Identity · 02 Questions · 03 At the end · 04 Sharing · 05 Advanced) and the bot's own
// conversation on the right, played with the real cards as it is built. Any member makes bots for
// themselves, a Space or (after review) the office; administrators also write integrations' flows
// here. Opened with a dex-botmaker event: { name? } to change a bot, { admin: { name? } } for the
// Control room. On a phone the editor and the test run are two sheets with a switch between them.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BotFlowDefinition, BotMakerBot, BotScope, Ops, PublicUser, Session } from '@dex/core';
import { validateFlow } from '@dex/core/botflows';
import { problemsOf } from '@dex/core/botmaker';
import { Icon, Segmented, trapTab, useDialogFocus, useToast } from '../../ui.tsx';
import { confirmAction } from '../../confirm.tsx';
import { chatState } from '../../chat/store.ts';
import { BotMarkTile } from '../BotMark.tsx';
import { DEFAULT_PERSONA, IdentitySection } from './Identity.tsx';
import { StepsSection } from './Steps.tsx';
import { EndingSection } from './Ending.tsx';
import { Preview } from './Preview.tsx';
import { StartPanel } from './Start.tsx';
import '../bots.css';
import './maker.css';

import type { MakerRequest, MakerSection as Section } from './open.ts';
const SECTIONS: Array<{ value: Section; label: string }> = [
  { value: 'identity', label: 'Identity' }, { value: 'steps', label: 'Questions' }, { value: 'end', label: 'At the end' },
  { value: 'share', label: 'Sharing' }, { value: 'json', label: 'Advanced' },
];


const SCOPES: Array<{ value: BotScope; label: string; hint: string }> = [
  { value: 'private', label: 'Only me', hint: 'Only you can start it. Good for your own checklists and notes.' },
  { value: 'space', label: 'A Space', hint: 'Everyone in one Space can start it. It posts a Start card there.' },
  { value: 'office', label: 'The whole office', hint: 'An administrator approves it first. Until then it stays as it is now.' },
];

function Sharing({ def, setDef, scope, setScope, spaceId, setSpaceId, spaces, saved, admin, bots, botId, setBotId }: {
  def: BotFlowDefinition; setDef: (d: BotFlowDefinition) => void; scope: BotScope; setScope: (s: BotScope) => void; spaceId: string; setSpaceId: (s: string) => void;
  spaces: Array<{ id: string; name: string }>; saved: BotMakerBot | null; admin: boolean; bots: Ops['admin.bots']['res']; botId: string; setBotId: (s: string) => void;
}) {
  return (
    <div className="bm-section">
      {admin ? (
        <div className="field">
          <label htmlFor="bm-bot">Integration that asks</label>
          <select id="bm-bot" className="input" value={botId} onChange={(e) => setBotId(e.target.value)}>
            {bots.filter((b) => b.active).map((b) => <option key={b.bot.id} value={b.bot.id}>{b.bot.displayName}</option>)}
          </select>
          <span className="bm-hint">Flows written here are office-wide and go live when saved.</span>
        </div>
      ) : (
        <>
          <div className="bm-scopes" role="radiogroup" aria-label="Who can use it">
            {SCOPES.map((s) => (
              <button key={s.value} type="button" role="radio" aria-checked={scope === s.value} className="bm-scope" onClick={() => setScope(s.value)}>
                <b>{s.label}</b><span>{s.hint}</span>
              </button>
            ))}
          </div>
          {scope === 'space' && (
            <div className="field">
              <label htmlFor="bm-space">Which Space</label>
              <select id="bm-space" className="input" value={spaceId} onChange={(e) => setSpaceId(e.target.value)}>
                <option value="">Choose a Space…</option>
                {spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
          {saved?.requested === 'office' && <div className="bm-review warn" role="status"><span className="chip warn">Waiting</span>An administrator has the office-wide request{saved.pendingVersion ? ` for revision ${saved.pendingVersion}` : ''}.</div>}
          {saved?.review && !saved.requested && (
            <div className={`bm-review${saved.review.approved ? '' : ' bad'}`} role="status">
              <span className={`chip ${saved.review.approved ? 'ok' : 'bad'}`}>{saved.review.approved ? 'Approved' : 'Not approved'}</span>
              <span>{saved.review.note ? `“${saved.review.note}”` : saved.review.approved ? 'Approved for the whole office.' : 'It was not approved for the whole office.'}</span>
            </div>
          )}
        </>
      )}
      <div className="field">
        <label htmlFor="bm-words">Words that start it, in its conversation (separate with commas)</label>
        <input id="bm-words" className="input" value={(def.keywords ?? []).join(', ')} placeholder="plot, plots, print drawings"
          onChange={(e) => { const k = e.target.value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean); setDef({ ...def, keywords: k.length ? k : undefined }); }} />
      </div>
      <div className="field">
        <label htmlFor="bm-cmd">Slash command{admin || scope === 'office' ? '' : ' (office-wide bots only)'}</label>
        <span className="bm-cmd"><span className="mono" aria-hidden="true">/</span>
          <input id="bm-cmd" className="input mono" maxLength={24} value={def.command ?? ''} disabled={!admin && scope !== 'office'} placeholder="plot"
            onChange={(e) => setDef({ ...def, command: e.target.value.replace(/^\//, '').toLowerCase() || undefined })} /></span>
      </div>
      <div className="field">
        <label htmlFor="bm-days">Keep an unfinished conversation for</label>
        <select id="bm-days" className="input" value={def.expiresInDays ?? 7} onChange={(e) => setDef({ ...def, expiresInDays: Number(e.target.value) === 7 ? undefined : Number(e.target.value) })}>
          {[1, 3, 7, 14, 30, 90].map((n) => <option key={n} value={n}>{n === 1 ? '1 day' : `${n} days`}</option>)}
        </select>
      </div>
    </div>
  );
}

/** The definition as JSON, in step with the editor both ways: a valid edit here changes the draft. */
function Advanced({ def, setDef }: { def: BotFlowDefinition; setDef: (d: BotFlowDefinition) => void }) {
  const [text, setText] = useState(() => JSON.stringify(def, null, 2));
  const [error, setError] = useState<string | null>(null);
  const mine = useRef(false);
  useEffect(() => { if (mine.current) { mine.current = false; return; } setText(JSON.stringify(def, null, 2)); setError(null); }, [def]);
  return (
    <div className="bm-section">
      <p className="faint" style={{ margin: 0 }}>The same bot as JSON, as the Bot API takes it. Changes here show in the other sections as soon as they are valid.</p>
      <label className="sr-only" htmlFor="bm-json">Definition as JSON</label>
      <textarea id="bm-json" className="input mono flow-json" rows={22} spellCheck={false} value={text} onChange={(e) => {
        setText(e.target.value);
        let v: unknown;
        try { v = JSON.parse(e.target.value); } catch (x) { setError(`Not valid JSON yet: ${(x as Error).message}`); return; }
        if (!v || typeof v !== 'object' || Array.isArray(v)) { setError('The definition is one JSON object.'); return; }
        setError(null);
        mine.current = true;
        setDef(v as BotFlowDefinition);
      }} />
      {error && <div className="flow-err" role="alert">{error}</div>}
    </div>
  );
}

export default function BotMaker({ req, session, onClose }: { req: MakerRequest; session: Session; onClose: () => void }) {
  const toast = useToast();
  const box = useRef<HTMLElement>(null);
  useDialogFocus(box, false);
  const adminMode = !!req.admin;
  const isAdmin = session.me.role === 'owner' || session.me.role === 'admin';
  const users = useMemo(() => new Map<string, PublicUser>(session.users.map((u) => [u.id, u] as const)), [session.users]);
  const spaces = useMemo(() => [...chatState().conversations.values()].filter((c) => c.kind === 'space' && c.members.includes(session.me.id)).map((c) => ({ id: c.id, name: c.name ?? 'Space' })).sort((a, b) => a.name.localeCompare(b.name)), [session.me.id]);
  const [def, setDefRaw] = useState<BotFlowDefinition | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [saved, setSaved] = useState<BotMakerBot | null>(null);
  const [savedJson, setSavedJson] = useState<string>('');
  const [scope, setScope] = useState<BotScope>('private');
  const [spaceId, setSpaceId] = useState('');
  const [section, setSection] = useState<Section>(req.section ?? 'steps');
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phone, setPhone] = useState<'build' | 'try'>('build');
  const [restart, setRestart] = useState(0);
  const [peek, setPeek] = useState<BotFlowDefinition | null>(null);
  const [bots, setBots] = useState<Ops['admin.bots']['res']>([]);
  const [botId, setBotId] = useState('');
  const [nameLocked, setNameLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setDef = useCallback((d: BotFlowDefinition) => setDefRaw(d), []);

  useEffect(() => {
    if (adminMode) {
      void window.dex.request('admin.bots').then((b) => { setBots(b); setBotId((cur) => cur || b.find((x) => x.active)?.bot.id || ''); }).catch(() => {});
      if (req.admin?.name) {
        void window.dex.request('admin.botflows.list').then((list) => {
          const f = list.find((x) => x.name === req.admin!.name);
          if (!f) return;
          setDefRaw(f.definition); setSavedJson(JSON.stringify(f.definition)); setBotId(f.botId); setNameLocked(true);
        }).catch((e: Error) => toast(e.message, true));
      }
      return;
    }
    if (req.name) {
      void window.dex.request('botflow.mine').then((list) => {
        const b = list.find((x) => x.name === req.name);
        if (!b) { toast('That bot was not found.', true); onClose(); return; }
        setSaved(b); setDefRaw(b.definition); setSavedJson(JSON.stringify(b.definition)); setNameLocked(true);
        setScope(b.requested === 'office' ? 'office' : b.scope); setSpaceId(b.spaceId ?? '');
      }).catch((e: Error) => toast(e.message, true));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const problems = useMemo(() => (def ? problemsOf(def) : null), [def]);
  const dirty = !!def && JSON.stringify(def) !== savedJson;
  const close = useCallback(async () => {
    if (dirty && !(await confirmAction({ title: 'Leave without saving?', body: 'Your changes to this bot are not saved.', confirm: 'Leave', danger: true }))) return;
    onClose();
  }, [dirty, onClose]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.scrim, .popover')) { e.preventDefault(); void close(); }
      if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void save(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  const save = async () => {
    if (!def || busy) return;
    setError(null);
    if (problems?.count) { setError(problems.count === 1 ? 'Fix the problem marked first.' : `Fix the ${problems.count} problems marked first.`); return; }
    if (!adminMode && scope === 'space' && !spaceId) { setSection('share'); setError('Choose the Space to share it with.'); return; }
    setBusy(true);
    try {
      const clean = validateFlow({ ...def, persona: def.persona ?? DEFAULT_PERSONA(def.title) });
      if (adminMode) {
        await window.dex.request('admin.botflows.save', { botId, definition: clean });
        toast(`${clean.title} saved`);
        setSavedJson(JSON.stringify(def)); setNameLocked(true);
        return;
      }
      const r = await window.dex.request('botflow.make', { definition: clean, scope, spaceId: scope === 'space' ? spaceId : null, ...(saved ? { baseVersion: saved.pendingVersion ?? saved.version } : { newBot: true }) });
      setSaved(r); setDefRaw(r.definition); setSavedJson(JSON.stringify(r.definition)); setNameLocked(true);
      toast(r.requested === 'office' ? `${r.title} saved. An administrator will look at sharing it with the office.` : r.scope === 'space' ? `${r.title} saved and shared with ${spaces.find((s) => s.id === r.spaceId)?.name ?? 'the Space'}` : `${r.title} saved`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const pick = (d: BotFlowDefinition, n: string[] = []) => { setDefRaw(d); setNotes(n); setSection('steps'); setOpen(null); setPeek(null); setRestart((x) => x + 1); };
  const p = def?.persona ?? (def ? DEFAULT_PERSONA(def.title) : null);
  const stepProblems = problems ? Object.keys(problems.steps).length : 0;
  const endProblems = problems ? Object.keys(problems.finish).length : 0;
  const scopeWords = adminMode ? 'OFFICE · INTEGRATION' : scope === 'office' ? (saved?.scope === 'office' ? 'OFFICE' : 'OFFICE · ASKED') : scope === 'space' ? `SPACE · ${(spaces.find((s) => s.id === spaceId)?.name ?? '—').toUpperCase()}` : 'ONLY ME';
  const loading = (req.name || req.admin?.name) && !def;

  return createPortal(
    <div className="sheet-scrim bm-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) void close(); }}>
      <aside ref={box} tabIndex={-1} className="bm-sheet" role="dialog" aria-modal="true" aria-label={adminMode ? 'Flow maker' : 'Bot maker'} onKeyDown={trapTab} data-phone={phone}>
        <header className="bm-tb">
          <div className="bm-tb-mark">{p ? <BotMarkTile mark={p.mark} colour={p.colour} size={44} /> : <span className="bot-tile bm-blank-tile" style={{ width: 44, height: 44 }}><Icon name="plus" size={20} /></span>}</div>
          <div className="bm-tb-name">
            <span className="bm-tb-cap">{adminMode ? 'Flow' : 'Bot'}</span>
            <h2 translate={def?.title ? 'no' : undefined}>{def?.title || (loading ? '…' : 'New bot')}</h2>
          </div>
          {def && (
            <dl className="bm-tb-cells">
              <div><dt>Rev</dt><dd className="mono">{saved ? String(saved.pendingVersion ?? saved.version).padStart(2, '0') : '—'}{dirty ? '*' : ''}</dd></div>
              <div><dt>Shared</dt><dd className="mono">{scopeWords}</dd></div>
              <div><dt>Status</dt><dd className="mono">{saved ? saved.status.toUpperCase() : 'DRAFT'}</dd></div>
            </dl>
          )}
          <div className="bm-tb-actions">
            {def && <button type="button" className="btn" onClick={() => { setRestart((x) => x + 1); setPhone('try'); }}><Icon name="play" size={15} />Test run</button>}
            {def && <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? <span className="spinner" /> : <Icon name="check" size={15} />}{saved || nameLocked ? 'Save changes' : 'Save bot'}</button>}
            <button type="button" className="icon-btn" onClick={() => void close()} aria-label="Close" title="Close (Esc)"><Icon name="x" size={18} /></button>
          </div>
        </header>
        {def && (
          <div className="bm-phone-switch only-narrow">
            <Segmented<'build' | 'try'> label="Show" value={phone} onChange={setPhone} options={[{ value: 'build', label: 'Build' }, { value: 'try', label: 'Try it' }]} />
          </div>
        )}
        <div className="bm-body">
          <div className="bm-editor">
            {loading && <div className="tl-more"><span className="spinner" /></div>}
            {!def && !loading && <StartPanel spaces={spaces} onPick={pick} onPreview={setPeek} />}
            {def && (
              <>
                <nav className="bm-nav">
                  <div className="seg seg-register bm-register" role="tablist" aria-label="Parts of the bot">
                    {SECTIONS.map((s) => {
                      const n = s.value === 'steps' ? stepProblems : s.value === 'end' ? endProblems : s.value === 'identity' ? problems?.general.length ?? 0 : 0;
                      return (
                        <button key={s.value} type="button" role="tab" aria-selected={section === s.value} aria-pressed={section === s.value} aria-controls="bm-panel" onClick={() => setSection(s.value)}>
                          {s.label}{s.value === 'steps' && <span className="bm-count mono">{def.steps.length}</span>}
                          {n > 0 && <span className="bm-bad mono" aria-label={`${n} to fix`}>{n}</span>}
                        </button>
                      );
                    })}
                  </div>
                </nav>
                {notes.length > 0 && (
                  <div className="bm-notes" role="status">
                    <ul>{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
                    <button type="button" className="icon-btn sm" aria-label="Dismiss these notes" onClick={() => setNotes([])}><Icon name="x" size={14} /></button>
                  </div>
                )}
                {problems && problems.general.length > 0 && <div className="bm-problem" role="note"><Icon name="warning" size={14} /><span>{problems.general.join(' ')}</span></div>}
                <div id="bm-panel" role="tabpanel">
                  {section === 'identity' && <IdentitySection def={def} setDef={setDef} nameLocked={nameLocked} me={session.me.displayName} />}
                  {section === 'steps' && <StepsSection def={def} setDef={setDef} problems={problems?.steps ?? {}} open={open} setOpen={setOpen} />}
                  {section === 'end' && <EndingSection def={def} setDef={setDef} problems={problems?.finish ?? {}} admin={adminMode && isAdmin} spaces={spaces.map((s) => s.name)} />}
                  {section === 'share' && <Sharing def={def} setDef={setDef} scope={scope} setScope={setScope} spaceId={spaceId} setSpaceId={setSpaceId} spaces={spaces} saved={saved} admin={adminMode} bots={bots} botId={botId} setBotId={setBotId} />}
                  {section === 'json' && <Advanced def={def} setDef={setDef} />}
                </div>
                {error && <div className="flow-err bm-save-err" role="alert">{error}</div>}
              </>
            )}
          </div>
          <div className="bm-side">
            {(def ?? peek)
              ? <Preview def={(def ?? peek)!} me={session.me} users={users} restartKey={restart + (def ? 0 : 1000)} />
              : <div className="bm-preview bm-pv-blank"><div className="empty"><Icon name="chat" size={20} /><span>Choose how to start; its conversation appears here.</span></div></div>}
          </div>
        </div>
      </aside>
    </div>,
    document.body,
  );
}
