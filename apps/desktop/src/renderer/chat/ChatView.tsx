// The Direct and Spaces lenses share one view: the Switchboard (narrowed by lens chips) and up to
// three Panes side by side. With a Pane open the Switchboard folds to a strip of tiles.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Conversation, PublicUser, Session } from '@dex/core';
import type { AppState } from '../../shared/bridge.ts';
import { Dialog, Icon, Segmented, Toggle, useToast } from '../ui.tsx';
import { Pane, PeoplePicker } from './Pane.tsx';
import { Switchboard } from './Switchboard.tsx';
import type { Chip } from './Switchboard.tsx';
import { addConversation, useChat } from './store.ts';
import { CONV_DRAG, closePane, focusPane, openBeside, openInPane, prunePanes, usePanes } from './panes.ts';
import { RefHost } from './refs.tsx';

const FOLD_KEY = 'dex-sb-open';

export function ChatView({ chip, setChip, state, session }: {
  chip: Chip;
  setChip: (c: Chip) => void;
  state: AppState;
  session: Session;
}) {
  const users = useMemo(() => new Map(session.users.map((u) => [u.id, u] as const)), [session.users]);
  const online = useMemo(() => new Set(session.online), [session.online]);
  const meId = session.me.id;
  const isAdmin = session.me.role === 'owner' || session.me.role === 'admin';
  const guest = session.me.role === 'guest';
  const conversations = useChat((s) => s.conversations);
  const ready = useChat((s) => s.ready);
  const panes = usePanes();
  const [dialog, setDialog] = useState<'new' | 'browse' | null>(null);
  // the Switchboard stays open by hand (kept on this device), otherwise it folds while a Pane is open
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(FOLD_KEY) === '1'; } catch { return false; } });
  const setFolded = (folded: boolean) => { setOpen(!folded); try { localStorage.setItem(FOLD_KEY, folded ? '0' : '1'); } catch { /* storage off */ } };
  const [drop, setDrop] = useState<{ index: number; x: number } | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const narrow = () => !window.matchMedia('(min-width: 721px)').matches;

  // Panes whose conversation went away (left, removed) close
  useEffect(() => { if (ready) prunePanes((id) => !!conversations.get(id)?.joined); }, [ready, conversations]);
  // on a PC, open the latest conversation when nothing is open; on phones the Switchboard is the starting screen
  useEffect(() => {
    if (!ready || panes.ids.length || narrow()) return;
    const first = [...conversations.values()].filter((c) => c.joined && (chip === 'people' ? c.kind === 'direct' : chip === 'all' ? true : c.kind === 'space'))
      .sort((a, b) => (b.lastMessage?.createdAt ?? b.createdAt) - (a.lastMessage?.createdAt ?? a.createdAt))[0];
    if (first) openInPane(first.id);
  }, [ready, conversations, chip, panes.ids.length]);

  const p2p = !!state.p2p?.active;
  const where = (e: React.DragEvent): { index: number; x: number } => {
    const box = area.current!.getBoundingClientRect();
    const slots = [...area.current!.querySelectorAll<HTMLElement>(':scope > .pane-wrap')].map((el) => el.getBoundingClientRect());
    let index = slots.findIndex((r) => e.clientX < r.left + r.width / 2);
    if (index < 0) index = slots.length;
    const x = index === 0 ? 0 : index >= slots.length ? box.width : slots[index].left - box.left;
    return { index, x };
  };
  const folded = panes.ids.length > 0 && !open;

  return (
    <div className={`chat-view${folded ? ' sb-folded' : ''}${panes.ids.length ? ' has-pane' : ''}`}>
      <Switchboard chip={chip} setChip={setChip} users={users} meId={meId} folded={folded}
        setFolded={panes.ids.length ? setFolded : null}
        onNew={guest && chip === 'spaces' ? undefined : () => setDialog('new')}
        onBrowse={!guest ? () => setDialog('browse') : undefined} />
      <div ref={area} className={`panes n${panes.ids.length}`}
        onDragOver={(e) => { if (!e.dataTransfer.types.includes(CONV_DRAG) || narrow()) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDrop(where(e)); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(null); }}
        onDrop={(e) => { const id = e.dataTransfer.getData(CONV_DRAG); if (!id) return; e.preventDefault(); const at = where(e).index; setDrop(null); openBeside(id, at); }}>
        {panes.ids.map((id, i) => {
          const c = conversations.get(id);
          const isDirect = c?.kind === 'direct';
          return (
            <Pane key={id} convId={id} users={users} meId={meId} isAdmin={isAdmin} online={online}
              live={state.phase === 'ready' || (isDirect && p2p)} direct={state.phase !== 'ready' && p2p && isDirect} reachable={state.p2p?.reachable ?? []}
              onBack={() => closePane(i)} session={session}
              focused={panes.ids.length < 2 || i === panes.focus} onFocus={() => focusPane(i)}
              onClose={panes.ids.length > 1 ? () => closePane(i) : undefined}
              sheetNo={{ n: i + 1, of: panes.ids.length }} />
          );
        })}
        {panes.ids.length === 0 && (
          <div className="pane empty">
            <div className="empty">
              <Icon name={chip === 'people' ? 'direct' : 'grid'} size={36} />
              <span>{chip === 'people' ? 'Write to anyone in the office.' : 'Spaces are where teams and projects talk.'}</span>
              <span className="faint" style={{ fontSize: 12.5 }}>Ctrl+click or drag conversations from the Switchboard to lay up to three side by side.</span>
              {!(guest && chip !== 'people') && <button className="btn primary" onClick={() => setDialog('new')}><Icon name="plus" size={15} />{chip === 'people' ? 'New Direct conversation' : 'Create a Space'}</button>}
            </div>
          </div>
        )}
        {drop && <div className="pane-drop" style={{ left: drop.x }}><span className="mono">Lay beside</span></div>}
      </div>
      {dialog === 'new' && <NewConversation kind={chip === 'people' || guest ? 'direct' : 'space'} users={session.users.filter((u) => u.id !== meId && u.role !== 'bot')} online={online}
        onClose={() => setDialog(null)} onCreated={(c) => { addConversation(c); openInPane(c.id); setDialog(null); }} />}
      <RefHost users={users} meId={meId} />
      {dialog === 'browse' && <BrowseSpaces onClose={() => setDialog(null)} onJoined={(c) => { addConversation(c); openInPane(c.id); setDialog(null); }} />}
    </div>
  );
}

function NewConversation({ kind, users, online, onClose, onCreated }: {
  kind: 'direct' | 'space'; users: PublicUser[]; online: Set<string>; onClose: () => void; onCreated: (c: Conversation) => void;
}) {
  const toast = useToast();
  const [mode, setMode] = useState<'direct' | 'space'>(kind);
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [priv, setPriv] = useState(false);
  const [step, setStep] = useState<'details' | 'people'>('details');

  const create = async (members: string[]) => {
    try {
      const c = mode === 'direct'
        ? await window.dex.request('conv.create', { kind: 'direct', members })
        : await window.dex.request('conv.create', { kind: 'space', name, topic: topic || undefined, private: priv, members });
      onCreated(c);
    } catch (e) { toast((e as Error).message, true); }
  };

  return (
    <Dialog title={mode === 'direct' ? 'New Direct conversation' : 'New Space'} onClose={onClose}>
      <Segmented<'direct' | 'space'> label="Kind" value={mode} onChange={(m) => { setMode(m); setStep('details'); }} options={[
        { value: 'direct', label: 'Direct', icon: 'direct' },
        { value: 'space', label: 'Space', icon: 'grid' },
      ]} />
      {mode === 'direct' && (
        <>
          <p className="muted">Pick one person for a one-to-one conversation, or several for a small group.</p>
          <PeoplePicker users={users} online={online} cta="Start" onDone={(ids) => (ids.length ? void create(ids) : onClose())} />
        </>
      )}
      {mode === 'space' && step === 'details' && (
        <form style={{ display: 'grid', gap: 14, width: '100%' }} onSubmit={(e) => { e.preventDefault(); if (name.trim()) setStep('people'); }}>
          <div className="field"><label htmlFor="sp-name">Name</label>
            <input id="sp-name" className="input" autoFocus maxLength={60} placeholder="e.g. Piping P-12513" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="field"><label htmlFor="sp-topic">What is it for? (optional)</label>
            <input id="sp-topic" className="input" maxLength={240} placeholder="Isometrics, MTOs and site queries" value={topic} onChange={(e) => setTopic(e.target.value)} /></div>
          <div className="setting" style={{ padding: '10px 12px' }}>
            <Icon name="lock" className="lead" />
            <div className="txt"><div>Private</div><div className="faint">Only people you add can find or read it.</div></div>
            <Toggle label="Private" checked={priv} onChange={setPriv} />
          </div>
          <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={!name.trim()}>Next: add people</button>
          </div>
        </form>
      )}
      {mode === 'space' && step === 'people' && (
        <>
          <p className="muted">Add people now, or skip and share the Space later.</p>
          <PeoplePicker users={users} online={online} cta="Create Space" onDone={(ids) => void create(ids)} />
          <button className="link" onClick={() => void create([])}>Create without adding anyone</button>
        </>
      )}
    </Dialog>
  );
}

function BrowseSpaces({ onClose, onJoined }: { onClose: () => void; onJoined: (c: Conversation) => void }) {
  const toast = useToast();
  const [list, setList] = useState<Conversation[] | null>(null);
  useEffect(() => { void window.dex.request('conv.browse').then(setList).catch(() => setList([])); }, []);
  return (
    <Dialog title="Find Spaces" onClose={onClose}>
      <div className="browse-list">
        {list === null && <div className="tl-more"><span className="spinner" /></div>}
        {list?.length === 0 && <div className="empty"><Icon name="grid" size={28} /><span>You are already in every open Space.</span></div>}
        {list?.map((c) => (
          <div key={c.id} className="setting">
            <div className="txt"><div style={{ fontWeight: 600 }}>{c.name}</div><div className="faint">{c.topic ?? `${c.members.length} members`}</div></div>
            <button className="btn primary" onClick={() => void window.dex.request('conv.join', { convId: c.id }).then(onJoined).catch((e: Error) => toast(e.message, true))}>Join</button>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
