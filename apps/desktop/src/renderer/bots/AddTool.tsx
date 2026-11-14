// "Add a tool…" from a conversation's menu: the approved tools, what each may do, and Add.
// Mounted once by the app frame; the menu item asks for it with a dex-add-tool event.
import { useEffect, useState } from 'react';
import type { MiniAppInfo } from '@dex/core';
import { Dialog, Icon, useToast } from '../ui.tsx';
import { chatState } from '../chat/store.ts';
import { permissionWords } from './MiniAppCard.tsx';
import './bots.css';

export function AddToolHost() {
  const toast = useToast();
  const [convId, setConvId] = useState<string | null>(null);
  const [tools, setTools] = useState<MiniAppInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    const on = (e: Event) => { setConvId(String((e as CustomEvent).detail)); setTools(null); };
    window.addEventListener('dex-add-tool', on);
    return () => window.removeEventListener('dex-add-tool', on);
  }, []);
  useEffect(() => {
    if (!convId) return;
    void window.dex.request('miniapp.list').then(setTools).catch((e: Error) => { toast(e.message, true); setTools([]); });
  }, [convId, toast]);
  if (!convId) return null;
  const conv = chatState().conversations.get(convId);
  const add = async (t: MiniAppInfo) => {
    setBusy(t.id);
    try {
      await window.dex.request('miniapp.add', { convId, appId: t.id, clientId: `tool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` });
      setConvId(null);
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(null); }
  };
  return (
    <Dialog title={`Add a tool to ${conv?.kind === 'space' ? conv.name ?? 'this Space' : 'this conversation'}`} onClose={() => setConvId(null)}>
      <p className="muted" style={{ margin: 0 }}>Tools run inside the conversation for everyone in it. Each one added keeps its own sheet: what one person changes, the others see.</p>
      <div className="mapp-pick">
        {tools === null && <div className="tl-more"><span className="spinner" /></div>}
        {tools?.length === 0 && <p className="faint">No tools are approved yet. An administrator adds them in Control room → Bots &amp; tools.</p>}
        {tools?.map((t) => (
          <div key={t.id} className="mapp-pick-row">
            <span className="mapp-mark" aria-hidden="true"><Icon name="grid" size={15} /></span>
            <span className="grow">
              <b>{t.name}</b> <span className="mono faint">v{t.version}</span>
              <span className="mapp-pick-desc">{t.description}</span>
              <span className="mapp-perms">{t.permissions.map((p) => <span key={p} className="chip">{permissionWords(p)}{p === 'network' && t.hosts.length ? `: ${t.hosts.join(', ')}` : ''}</span>)}</span>
            </span>
            <button className="btn primary" disabled={!!busy} onClick={() => void add(t)} aria-label={`Add ${t.name}`}>{busy === t.id ? <span className="spinner" /> : 'Add'}</button>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
