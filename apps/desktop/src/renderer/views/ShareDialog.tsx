// "Share to Dexterity Connect": other office tools (Project Opener, Sleuth, Datum, Dexterity
// Sheets, Slate, Hopper) open dexconnect://share?text=…&file=…&to=… and the person picks where
// it goes and confirms. Nothing is sent without that confirmation.
import { useEffect, useMemo, useState } from 'react';
import type { Conversation, PublicUser, Session } from '@dex/core';
import { Dialog, Icon, useToast } from '../ui.tsx';
import { addConversation, sendMessage, useChat } from '../chat/store.ts';
import { ConvTile, convTitle } from '../chat/Switchboard.tsx';
import { formatSize } from '../chat/files.tsx';

export interface ShareRequest {
  text: string;
  files: string[];
  /** Preselect: a Windows account ("DOMAIN\\name" or "name") or "space:Name". */
  to: string | null;
  /** Which tool asked, shown to the person. */
  from: string | null;
}

/** Read a dexconnect://share link. Returns null for anything else. */
export function parseShare(url: string): ShareRequest | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'dexconnect:' || !/^\/*share\/?$/.test(`${u.hostname}${u.pathname}`)) return null;
  const p = u.searchParams;
  const parts = [p.get('text') ?? '', p.get('link') ? `${p.get('title') ? `${p.get('title')}: ` : ''}${p.get('link')}` : ''].filter(Boolean);
  return {
    text: parts.join('\n').slice(0, 8000),
    files: p.getAll('file').filter((f) => f.trim()).slice(0, 20),
    to: p.get('to'),
    from: p.get('from')?.slice(0, 40) ?? null,
  };
}

export function ShareDialog({ req, session, onDone }: { req: ShareRequest; session: Session; onDone: (convId: string | null) => void }) {
  const toast = useToast();
  const conversations = useChat((s) => s.conversations);
  const users = useMemo(() => new Map(session.users.map((u) => [u.id, u] as const)), [session.users]);
  const [q, setQ] = useState('');
  const [target, setTarget] = useState<string | null>(null);
  const [person, setPerson] = useState<PublicUser | null>(null);
  const [text, setText] = useState(req.text);
  const [files, setFiles] = useState<Array<{ path: string; name: string; size: number; ok: boolean }>>([]);
  const [busy, setBusy] = useState(false);
  const meId = session.me.id;

  useEffect(() => {
    void Promise.all(req.files.map(async (p) => {
      const info = await window.dex.statFile?.(p).catch(() => null);
      return { path: p, name: info?.name ?? p.split(/[\\/]/).pop() ?? p, size: info?.size ?? 0, ok: !!info?.isFile };
    })).then(setFiles);
  }, [req.files]);

  // preselect who it is for
  useEffect(() => {
    if (!req.to) return;
    const to = req.to.trim().toLowerCase();
    if (to.startsWith('space:')) {
      const name = to.slice(6);
      const c = [...conversations.values()].find((x) => x.kind === 'space' && x.joined && x.name?.toLowerCase() === name);
      if (c) setTarget(c.id);
      return;
    }
    const u = session.users.find((x) => x.role !== 'bot' && (x.account.toLowerCase() === to || x.account.toLowerCase().endsWith(`\\${to}`)));
    if (u && u.id !== meId) setPerson(u);
  }, [req.to, conversations, session.users, meId]);

  const list = [...conversations.values()].filter((c) => c.joined)
    .map((c) => ({ c, title: convTitle(c, users, meId) }))
    .filter((x) => !q || x.title.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (b.c.lastMessage?.createdAt ?? b.c.createdAt) - (a.c.lastMessage?.createdAt ?? a.c.createdAt))
    .slice(0, 30);
  const people = q ? session.users.filter((u) => u.role !== 'bot' && u.id !== meId && u.displayName.toLowerCase().includes(q.toLowerCase())).slice(0, 5) : [];
  const usable = files.filter((f) => f.ok);

  const share = async () => {
    setBusy(true);
    try {
      let convId = target;
      if (!convId && person) {
        const c: Conversation = await window.dex.request('conv.create', { kind: 'direct', members: [person.id] });
        addConversation(c);
        convId = c.id;
      }
      if (!convId) return;
      const infos = [];
      for (const f of usable) infos.push(await window.dex.uploadFile!(`share-${Date.now().toString(36)}`, { path: f.path, name: f.name, convId }));
      await sendMessage(convId, text.trim(), null, infos);
      toast('Shared');
      onDone(convId);
    } catch (e) { toast((e as Error).message, true); setBusy(false); }
  };

  const chosen = target ? conversations.get(target) : null;
  return (
    <Dialog title="Share to Dexterity Connect" onClose={() => onDone(null)}>
      {req.from && <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>From {req.from}. Check what is being shared before you send it.</p>}
      {files.length > 0 && (
        <div className="share-files">
          {files.map((f) => (
            <div key={f.path} className={`file-card${f.ok ? '' : ' missing'}`}>
              <span className="file-ico"><Icon name={f.ok ? 'paperclip' : 'warning'} size={18} /></span>
              <span className="sb-main"><span className="sb-name">{f.name}</span><span className="sb-preview mono">{f.ok ? `${formatSize(f.size)} · ${f.path}` : `Not found: ${f.path}`}</span></span>
            </div>
          ))}
        </div>
      )}
      <textarea className="input" rows={3} maxLength={8000} value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a message" />
      {chosen || person ? (
        <div className="share-to">
          <span className="label">To</span>
          {chosen ? <><ConvTile c={chosen} users={users} meId={meId} online={new Set(session.online)} size="sm" /><b>{convTitle(chosen, users, meId)}</b></> : <b>{person!.displayName}</b>}
          <button className="link" onClick={() => { setTarget(null); setPerson(null); }}>Change</button>
        </div>
      ) : (
        <>
          <input className="input" autoFocus placeholder="Search people and conversations" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="picker-list">
            {people.map((u) => (
              <button key={u.id} className="picker-row" onClick={() => setPerson(u)}>
                <span className="sb-main"><span className="sb-name">{u.displayName}</span><span className="sb-preview">{u.title ?? u.account}</span></span>
              </button>
            ))}
            {list.map(({ c, title }) => (
              <button key={c.id} className="picker-row" onClick={() => setTarget(c.id)}>
                <ConvTile c={c} users={users} meId={meId} online={new Set(session.online)} size="sm" />
                <span className="sb-main"><span className="sb-name">{title}</span><span className="sb-preview">{c.kind === 'space' ? 'Space' : 'Direct'}</span></span>
              </button>
            ))}
          </div>
        </>
      )}
      <div className="dialog-actions">
        <span className="faint">{usable.length ? `${usable.length} ${usable.length === 1 ? 'file' : 'files'}` : ''}</span>
        <button className="btn ghost" onClick={() => onDone(null)}>Cancel</button>
        <button className="btn primary" disabled={busy || (!target && !person) || (!text.trim() && !usable.length)} onClick={() => void share()}><Icon name="send" size={15} />Share</button>
      </div>
    </Dialog>
  );
}
