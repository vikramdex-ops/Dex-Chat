// Lounges where people see them: a section of the Switchboard (every lounge in your Spaces, who
// is in each, a live pip while someone speaks, Join) and the Space header (its lounges, a new one,
// rename and archive for administrators and the Space's managers).
import { useMemo, useRef, useState } from 'react';
import type { Conversation, Lounge, PublicUser } from '@dex/core';
import { Avatar, Dialog, Icon, Popover, useToast } from '../ui.tsx';
import { useChat } from '../chat/store.ts';
import { useCall } from '../rooms/engine.ts';
import { usePeople } from '../people.ts';
import { archiveLounge, createLounge, joinLounge, leaveLounge, renameLounge, useLounges } from './store.ts';
import './lounges.css';

/** The lounge glyph: a doorway with sound coming out of it, on the shared 24 px grid. */
export function LoungeGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20.5V4.5h8.5v16M4 20.5h10M9.5 12.5h.01M15.5 9c1.4.8 2.2 1.9 2.2 3.2s-.8 2.4-2.2 3.2M18 6.5c2.3 1.4 3.5 3.4 3.5 5.7s-1.2 4.3-3.5 5.7" />
    </svg>
  );
}

const canManage = (c: Conversation | undefined, me: PublicUser | undefined) =>
  !!c && !!me && (me.role === 'owner' || me.role === 'admin' || c.createdBy === me.id || c.moderators.includes(me.id));

/** Small tiles for the people in a lounge, with a ring while they speak. */
function People({ lounge, users, max = 4 }: { lounge: Lounge; users: Map<string, PublicUser>; max?: number }) {
  const ids = [...new Map(lounge.people.map((p) => [p.userId, p] as const)).values()];
  return (
    <span className="lg-people" aria-label={`${ids.length} in ${lounge.name}`}>
      {ids.slice(0, max).map((p) => (
        <span key={p.userId} className={`lg-tile${p.speaking ? ' speaking' : ''}${p.muted ? ' muted' : ''}`}>
          <Avatar user={{ id: p.userId, displayName: users.get(p.userId)?.displayName ?? 'Someone' }} size="sm" />
        </span>
      ))}
      {ids.length > max && <span className="lg-more mono">+{ids.length - max}</span>}
    </span>
  );
}

function useJoin(): (id: string) => void {
  const toast = useToast();
  return (id: string) => void joinLounge(id).catch((e: Error) => toast(e.message, true));
}

function LoungeRow({ l, space, users, here, folded }: { l: Lounge; space: string; users: Map<string, PublicUser>; here: boolean; folded: boolean }) {
  const join = useJoin();
  const live = l.people.length > 0;
  const speaking = l.people.some((p) => p.speaking);
  if (folded) {
    return (
      <button className={`lg-fold${live ? ' live' : ''}${here ? ' here' : ''}`} title={`${l.name} · ${space}${live ? ` · ${l.people.length} in it` : ''}`} onClick={() => (here ? undefined : join(l.id))}>
        <LoungeGlyph size={18} />{live && <i className={`lg-pip${speaking ? ' speaking' : ''}`} />}
      </button>
    );
  }
  return (
    <div className={`lg-row${live ? ' live' : ''}${here ? ' here' : ''}`} role="listitem">
      <span className="lg-ico"><LoungeGlyph /></span>
      <span className="lg-main">
        <span className="lg-name">{l.name}{live && <i className={`lg-pip${speaking ? ' speaking' : ''}`} title={speaking ? 'Someone is speaking' : 'People are in it'} />}</span>
        <span className="lg-sub mono" translate="no">{space.toUpperCase()}{live ? ` · ${l.people.length} IN` : ' · QUIET'}</span>
      </span>
      {live && <People lounge={l} users={users} max={3} />}
      {here
        ? <button className="lg-join here" onClick={leaveLounge} title="Leave the lounge">Leave</button>
        : <button className="lg-join" onClick={() => join(l.id)} title={`Drop into ${l.name} (audio only)`}>Join</button>}
    </div>
  );
}

/** The Switchboard's lounges: every lounge in your Spaces, the busy ones first. */
export function LoungeSection({ folded }: { folded: boolean }) {
  const lounges = useLounges((s) => s.lounges);
  const conversations = useChat((s) => s.conversations);
  const here = useCall((s) => (s.room?.purpose?.kind === 'lounge' ? s.room.purpose.loungeId : null));
  const { users } = usePeople();
  const [all, setAll] = useState(false);
  const list = useMemo(() => [...lounges.values()]
    .filter((l) => !l.archived && conversations.get(l.convId)?.joined && !conversations.get(l.convId)?.archived)
    .sort((a, b) => Number(b.id === here) - Number(a.id === here) || b.people.length - a.people.length || a.name.localeCompare(b.name)), [lounges, conversations, here]);
  if (!list.length) return null;
  const live = list.filter((l) => l.people.length).length;
  const shown = all || folded ? list : list.slice(0, Math.max(4, live));
  return (
    <div className="sb-group lg-section" role="list" aria-label="Lounges">
      {!folded && <div className="sb-group-title label">Lounges <span className="mono">· {live ? `${live} live` : list.length}</span></div>}
      {shown.map((l) => <LoungeRow key={l.id} l={l} space={conversations.get(l.convId)?.name ?? 'Space'} users={users} here={l.id === here} folded={folded} />)}
      {!folded && shown.length < list.length && <button className="sb-group-title label link" onClick={() => setAll(true)}>Show all {list.length}</button>}
    </div>
  );
}

/** The Space header's lounges: live ones as chips, all of them (and a new one) in a menu. */
export function LoungeStrip({ convId, live: online }: { convId: string; live: boolean }) {
  const lounges = useLounges((s) => s.lounges);
  const conv = useChat((s) => s.conversations.get(convId));
  const here = useCall((s) => (s.room?.purpose?.kind === 'lounge' ? s.room.purpose.loungeId : null));
  const { users, meId } = usePeople();
  const me = users.get(meId);
  const manage = canManage(conv, me);
  const join = useJoin();
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState<{ kind: 'new' } | { kind: 'rename'; lounge: Lounge } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const toast = useToast();
  const mine = [...lounges.values()].filter((l) => l.convId === convId);
  const open = mine.filter((l) => !l.archived);
  const archived = mine.filter((l) => l.archived);
  const busy = open.filter((l) => l.people.length);
  if (!conv || conv.kind !== 'space' || (!open.length && (!online || conv.archived || me?.role === 'guest'))) return null;
  return (
    <span className="lg-strip">
      {busy.slice(0, 1).map((l) => (
        <button key={l.id} className={`lg-chip${l.id === here ? ' here' : ''}`} disabled={!online} onClick={() => (l.id === here ? leaveLounge() : join(l.id))}
          title={l.id === here ? `Leave ${l.name}` : `Drop into ${l.name}`}>
          <i className={`lg-pip${l.people.some((p) => p.speaking) ? ' speaking' : ''}`} />
          <span className="lg-chip-name">{l.name}</span>
          <People lounge={l} users={users} max={3} />
          <span className="lg-chip-go">{l.id === here ? 'Leave' : 'Join'}</span>
        </button>
      ))}
      <button ref={btn} className="lg-menu-btn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)} title="This Space's lounges: drop-in audio">
        <LoungeGlyph size={15} /><span>Lounges</span>{open.length > 0 && <span className="mono">{open.length}</span>}
      </button>
      {menu && (
        <Popover anchor={btn.current} onClose={() => setMenu(false)} className="menu lg-pop">
          <div className="menu-label label">Lounges in {conv.name}</div>
          {!open.length && <p className="lg-empty">A lounge is a standing audio space: people drop in and out, nobody is rung. Open one for a desk or a team.</p>}
          {open.map((l) => (
            <div key={l.id} className="lg-pop-row">
              <span className="lg-ico"><LoungeGlyph /></span>
              <span className="lg-main">
                <span className="lg-name">{l.name}{l.people.length > 0 && <i className={`lg-pip${l.people.some((p) => p.speaking) ? ' speaking' : ''}`} />}</span>
                <span className="lg-sub mono">{l.people.length ? `${l.people.length} IN` : 'QUIET'}</span>
              </span>
              {l.people.length > 0 && <People lounge={l} users={users} />}
              {manage && <button className="icon-btn" title="Rename" aria-label={`Rename ${l.name}`} onClick={() => { setMenu(false); setDialog({ kind: 'rename', lounge: l }); }}><Icon name="edit" size={14} /></button>}
              {manage && <button className="icon-btn" title="Archive (everyone in it leaves)" aria-label={`Archive ${l.name}`}
                onClick={() => { if (!l.people.length || confirm(`Archive ${l.name}? The ${l.people.length} people in it leave.`)) void archiveLounge(l.id, true).then(() => toast(`${l.name} archived`)).catch((e: Error) => toast(e.message, true)); }}><Icon name="archive" size={14} /></button>}
              {l.id === here
                ? <button className="lg-join here" onClick={() => { setMenu(false); leaveLounge(); }}>Leave</button>
                : <button className="lg-join" disabled={!online} onClick={() => { setMenu(false); join(l.id); }}>Join</button>}
            </div>
          ))}
          {manage && archived.length > 0 && (
            <>
              <div className="menu-label label">Archived</div>
              {archived.map((l) => (
                <button key={l.id} role="menuitem" onClick={() => void archiveLounge(l.id, false).then(() => toast(`${l.name} is back`)).catch((e: Error) => toast(e.message, true))}>
                  <Icon name="history" size={15} />Bring back {l.name}
                </button>
              ))}
            </>
          )}
          {online && !conv.archived && me?.role !== 'guest' && (
            <>
              <div className="menu-sep" />
              <button role="menuitem" onClick={() => { setMenu(false); setDialog({ kind: 'new' }); }}><Icon name="plus" size={15} />New lounge…</button>
            </>
          )}
        </Popover>
      )}
      {dialog && <NameDialog title={dialog.kind === 'new' ? `New lounge in ${conv.name}` : `Rename ${dialog.lounge.name}`} initial={dialog.kind === 'rename' ? dialog.lounge.name : ''}
        action={dialog.kind === 'new' ? 'Open lounge' : 'Rename'} onClose={() => setDialog(null)}
        onSave={async (name) => {
          if (dialog.kind === 'new') { const l = await createLounge(convId, name); toast(`${l.name} is open: people can drop in`); }
          else { await renameLounge(dialog.lounge.id, name); toast('Renamed'); }
          setDialog(null);
        }} />}
    </span>
  );
}

function NameDialog({ title, initial, action, onClose, onSave }: { title: string; initial: string; action: string; onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <Dialog title={title} onClose={onClose} narrow>
      <form className="lg-form" onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void onSave(name.trim()).catch((err: Error) => { toast(err.message, true); setBusy(false); });
      }}>
        <div className="field"><label htmlFor="lg-name">Name</label>
          <input id="lg-name" className="input" autoFocus maxLength={40} placeholder="Piping desk" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <p className="muted" style={{ margin: 0 }}>Everyone in the Space sees it and can drop in with audio. Nobody is rung and nobody outside the lounge is notified.</p>
        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || name.trim().length < 2}>{busy ? <span className="spinner" /> : <LoungeGlyph size={15} />}{action}</button>
        </div>
      </form>
    </Dialog>
  );
}
