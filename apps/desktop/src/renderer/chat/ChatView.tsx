// The Direct and Spaces lenses: Switchboard on the left, the open conversation beside it.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Conversation, PublicUser, Session } from '@dex/core';
import type { AppState } from '../../shared/bridge.ts';
import { Icon, Segmented, Toggle, useToast } from '../ui.tsx';
import { Pane, PeoplePicker } from './Pane.tsx';
import { Switchboard } from './Switchboard.tsx';
import { addConversation, useChat } from './store.ts';

export function ChatView({ kind, state, session, openId, setOpenId }: {
  kind: 'direct' | 'space';
  state: AppState;
  session: Session;
  openId: string | null;
  setOpenId: (id: string | null) => void;
}) {
  const users = new Map(session.users.map((u) => [u.id, u] as const));
  const online = new Set(session.online);
  const meId = session.me.id;
  const isAdmin = session.me.role === 'owner' || session.me.role === 'admin';
  const conversations = useChat((s) => s.conversations);
  const [dialog, setDialog] = useState<'new' | 'browse' | null>(null);

  // open the most recent conversation of this kind when nothing is selected
  useEffect(() => {
    const cur = openId ? conversations.get(openId) : undefined;
    if (cur && cur.kind === kind && cur.joined) return;
    // on phones the Switchboard is the starting screen
    if (!window.matchMedia('(min-width: 721px)').matches) { if (openId) setOpenId(null); return; }
    const first = [...conversations.values()].filter((c) => c.kind === kind && c.joined)
      .sort((a, b) => (b.lastMessage?.createdAt ?? b.createdAt) - (a.lastMessage?.createdAt ?? a.createdAt))[0];
    setOpenId(first?.id ?? null);
  }, [kind, conversations, openId, setOpenId]);

  return (
    <div className="chat-view">
      <Switchboard kind={kind} users={users} meId={meId} online={online} activeId={openId} onOpen={setOpenId}
        onNew={() => setDialog('new')} onBrowse={kind === 'space' ? () => setDialog('browse') : undefined} />
      {openId && conversations.get(openId)?.kind === kind
        ? <Pane key={openId} convId={openId} users={users} meId={meId} isAdmin={isAdmin} online={online} live={state.phase === 'ready'} onBack={() => setOpenId(null)} />
        : (
          <div className="pane empty">
            <div className="empty">
              <Icon name={kind === 'space' ? 'grid' : 'chat'} size={36} />
              <span>{kind === 'space' ? 'Spaces are where teams and projects talk.' : 'Start a conversation with anyone in the office.'}</span>
              <button className="btn primary" onClick={() => setDialog('new')}><Icon name="plus" size={15} />{kind === 'space' ? 'Create a Space' : 'New Direct conversation'}</button>
            </div>
          </div>
        )}
      {dialog === 'new' && <NewConversation kind={kind} users={session.users.filter((u) => u.id !== meId && u.role !== 'bot')} online={online}
        onClose={() => setDialog(null)} onCreated={(c) => { addConversation(c); setOpenId(c.id); setDialog(null); }} />}
      {dialog === 'browse' && <BrowseSpaces onClose={() => setDialog(null)} onJoined={(c) => { addConversation(c); setOpenId(c.id); setDialog(null); }} />}
    </div>
  );
}

function Dialog({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return createPortal(
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog wide" role="dialog" aria-modal="true" aria-label={title}>
        <div style={{ display: 'flex', width: '100%', alignItems: 'center' }}>
          <h2 style={{ flex: 1 }}>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
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
        { value: 'direct', label: 'Direct', icon: 'chat' },
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
