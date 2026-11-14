// A tool in the timeline: a sheet-framed card with a title block, the tool in its sandboxed
// frame, and a way to lay it out larger. Each frame is answered by host.ts.
import { useEffect, useRef, useState } from 'react';
import type { Conversation, Message, MiniAppView, PublicUser } from '@dex/core';
import { miniAppFrame } from '@dex/core/miniapp';
import { Dialog, Icon } from '../ui.tsx';
import { convTitle } from '../chat/Switchboard.tsx';
import { formatSize } from '../chat/files.tsx';
import { hostTool } from './host.ts';
import type { Consent } from './host.ts';

const PERMISSION_WORDS: Record<string, string> = {
  members: 'Sees who is here',
  post: 'Posts with your OK',
  state: 'Shared with everyone here',
  files: 'Opens files with your OK',
  network: 'Reaches office hosts',
};
export const permissionWords = (p: string) => PERMISSION_WORDS[p] ?? p;

/** One frame, answered while it is on screen. */
function ToolFrame({ view, conv, me, users, height, onAsk }: { view: MiniAppView; conv: Conversation; me: PublicUser; users: Map<string, PublicUser>; height: number; onAsk: (c: Consent) => Promise<boolean> }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [h, setH] = useState(height);
  const latest = useRef({ view, conv, me, users, onAsk });
  latest.current = { view, conv, me, users, onAsk };
  useEffect(() => setH(height), [height]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return hostTool(el, () => ({
      view: latest.current.view, conv: latest.current.conv, me: latest.current.me, users: latest.current.users,
      convName: convTitle(latest.current.conv, latest.current.users, latest.current.me.id),
      ask: (c) => latest.current.onAsk(c), resize: (n) => setH(n),
    }));
  }, []);
  const f = miniAppFrame(view.instanceId, view.name, view.version);
  return <iframe ref={ref} className="mapp-frame" src={f.src} sandbox={f.sandbox} allow={f.allow} referrerPolicy={f.referrerPolicy} title={f.title} loading={f.loading} style={{ height: h }} />;
}

export function MiniAppCard({ m, conv, me, users }: { m: Message; conv: Conversation; me: PublicUser; users: Map<string, PublicUser> }) {
  const view = m.miniapp!;
  const [big, setBig] = useState(false);
  const [asking, setAsking] = useState<{ c: Consent; done: (yes: boolean) => void } | null>(null);
  const ask = (c: Consent) => new Promise<boolean>((resolve) => setAsking({ c, done: (yes) => { setAsking(null); resolve(yes); } }));
  const adder = users.get(view.addedBy);
  const where = convTitle(conv, users, me.id);
  const frameProps = { view, conv, me, users, onAsk: ask };
  // tools need the desktop app's sealed dexapp: address; the phone app has no such address
  const here = !window.dex.fileUrl;
  return (
    <div className={`mapp-card${view.available ? '' : ' off'}`} aria-label={`${view.name} tool`}>
      <div className="mapp-tb">
        <span className="mapp-mark" aria-hidden="true"><Icon name="grid" size={13} /></span>
        <span className="mapp-name">{view.name}</span>
        <span className="mapp-cells mono"><span>Tool</span><span>v{view.version || '—'}</span><span>T-{view.instanceId.slice(-4)}</span></span>
      </div>
      {!here ? <div className="mapp-away"><Icon name="laptop" size={14} />{view.name} runs in Dexterity Connect on a PC.</div> : view.available
        ? (big ? <div className="mapp-away faint">Laid out larger. <button className="btn ghost sm" onClick={() => setBig(false)}>Put it back</button></div> : <ToolFrame {...frameProps} height={view.height} />)
        : <div className="mapp-away"><Icon name="lock" size={14} />This tool is not available: an administrator switched it off, or it is waiting for review.</div>}
      <div className="mapp-foot">
        <span className="faint">{adder ? `Added by ${adder.id === me.id ? 'you' : adder.displayName}` : 'Added'} · {view.permissions.map(permissionWords).join(' · ') || 'Runs on its own'}</span>
        {here && view.available && !big && <button className="btn ghost sm" onClick={() => setBig(true)} title="Lay it out larger"><Icon name="expand" size={14} />Pop out</button>}
      </div>
      {big && (
        <Dialog title={`${view.name} · ${where}`} onClose={() => setBig(false)}>
          <div className="mapp-big"><ToolFrame {...frameProps} height={Math.max(view.height, Math.round(window.innerHeight * 0.7))} /></div>
        </Dialog>
      )}
      {asking && (
        <Dialog title={asking.c.kind === 'post' ? `${view.name} wants to post in ${where}` : `${view.name} wants to open a file`} onClose={() => asking.done(false)} narrow>
          {asking.c.kind === 'post'
            ? <><p className="muted" style={{ margin: 0 }}>It will be posted as you:</p><pre className="md-pre selectable tool-preview">{asking.c.text}</pre></>
            : <p className="muted" style={{ margin: 0 }}><b>{asking.c.name}</b> ({formatSize(asking.c.size)}) is shared in this conversation. {view.name} reads it on this PC only; nothing is sent anywhere.</p>}
          <div className="dialog-actions">
            <span />
            <button className="btn ghost" onClick={() => asking.done(false)}>{asking.c.kind === 'post' ? "Don't post" : "Don't open"}</button>
            <button className="btn primary" autoFocus onClick={() => asking.done(true)}>{asking.c.kind === 'post' ? 'Post it' : 'Open it'}</button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
