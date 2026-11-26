// Always mounted in the app frame: starts the help desk and lounges, opens "Help me…", the Help
// desk and ticket sheets (from the tile menu, the command palette, the tray and links), shows the
// "IT is ready to help" card and, after a session, "How did it go?". Also hosts "Look together".
import { useEffect, useMemo, useRef, useState } from 'react';
import { tr } from '../i18n/index.ts';
import { ticketRef } from '@dex/core';
import type { HelpTicket, PublicUser, Session } from '@dex/core';
import { Avatar, Icon, useToast } from '../ui.tsx';
import type { IconName } from '../ui.tsx';
import { useCall } from '../rooms/engine.ts';
import { setPeople } from '../people.ts';
import { startLounges } from '../lounges/store.ts';
import { LookHost } from '../pointers/surfaces.tsx';
import { HelpMe } from './HelpMe.tsx';
import { HelpDesk, TicketView } from './HelpDesk.tsx';
import { RateSheet } from './Consent.tsx';
import { clearRate, declineInvite, helpNow, isIt, joinSession, setNames, startHelp, ticketById, useHelp } from './store.ts';
import './help.css';

type View = { view: 'me' } | { view: 'desk'; id?: string } | { view: 'ticket'; id: string };

/** Open a help-desk screen from anywhere ("me": the request form; "desk": the queue). */
export function openHelp(v: View): void { window.dispatchEvent(new CustomEvent('dex-help', { detail: v })); }

/** Entries for the command palette. */
export function helpCommands(): Array<{ id: string; label: string; icon: IconName; hint?: string; run: () => void }> {
  return [
    { id: 'help-me', label: 'Help me: ask IT for help', icon: 'info', run: () => openHelp({ view: 'me' }) },
    ...(isIt() ? [{ id: 'help-desk', label: 'Open the Help desk: requests for IT', icon: 'monitor' as IconName, run: () => openHelp({ view: 'desk' }) }] : []),
  ];
}

/** Entries for your tile's menu. */
export function HelpMenuItems({ onDone }: { onDone: () => void }) {
  const staff = useHelp((s) => s.staff);
  const queue = useHelp((s) => s.queue.filter((t) => t.status === 'open').length);
  // your own request still open (the newest), so the entry says where it stands and opens it
  const mine = useHelp((s) => s.mine);
  const open = useMemo(() => mine.filter((t) => t.status !== 'closed').sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null, [mine]);
  const it = isIt({ ...helpNow(), staff });
  return (
    <>
      {/* Help is a service, not a setting: a framed cell of its own with the ring-buoy mark and a line
          saying who answers, so it is found at a glance among the menu's plain rows */}
      <button role="menuitem" className="help-entry" onClick={() => { onDone(); openHelp(open ? { view: 'ticket', id: open.id } : { view: 'me' }); }}
        aria-label={open ? `Help me: your request ${ticketRef(open.number)} is ${open.session ? 'in session' : open.status === 'taken' ? 'with IT' : 'in the queue'}` : 'Help me: ask IT for help'}>
        <span className="help-mark" aria-hidden="true"><Icon name="lifebuoy" size={18} /></span>
        <span className="help-words">
          <span className="help-title">Help me…</span>
          <span className="help-sub">{open ? `${ticketRef(open.number)} · ${open.session ? 'In session' : open.status === 'taken' ? 'With IT' : 'In the queue'}` : 'Ask IT · a person answers'}</span>
        </span>
        <span className={`help-tag mono${open?.session ? ' live' : ''}`} aria-hidden="true">IT</span>
      </button>
      {open && <button role="menuitem" className="help-new" onClick={() => { onDone(); openHelp({ view: 'me' }); }}><Icon name="plus" size={14} />Ask about something else</button>}
      {it && <button role="menuitem" onClick={() => { onDone(); openHelp({ view: 'desk' }); }}><Icon name="monitor" size={16} />Help desk{queue > 0 && <span className="badge">{queue}</span>}</button>}
    </>
  );
}

export function AssistHost({ session, users, live }: { session: Session; users: Map<string, PublicUser>; live: boolean }) {
  const toast = useToast();
  const meId = session.me.id;
  const [view, setView] = useState<View | null>(null);
  const invite = useHelp((s) => s.invite);
  const rate = useHelp((s) => s.rate);
  const inRoom = useCall((s) => s.room);
  setPeople(users, meId);
  useEffect(() => { setNames((id) => users.get(id)?.displayName ?? 'IT'); }, [users]);
  useEffect(() => { if (live) { void startHelp(meId); void startLounges(meId); } }, [live, meId]);
  useEffect(() => {
    const on = (e: Event) => setView((e as CustomEvent).detail as View);
    window.addEventListener('dex-help', on);
    return () => window.removeEventListener('dex-help', on);
  }, []);
  // IT hears about new requests; requesters hear when theirs is taken or answered
  useEffect(() => window.dex.onHubEvent((name, d) => {
    if (name !== 'help.updated') return;
    const t = d as HelpTicket;
    const before = ticketById(t.id);
    const nameOf = (id: string | null) => (id ? users.get(id)?.displayName ?? 'Someone' : 'Someone');
    if (!before && t.status === 'open' && t.requesterId !== meId && helpNow().staff.includes(meId)) {
      toast(`${nameOf(t.requesterId)} asks IT: ${t.summary}`);
      if (!document.hasFocus()) window.dex.notify(tr(`Help request ${ticketRef(t.number)}`), `${nameOf(t.requesterId)}: ${t.summary}`, 'dexconnect://help/desk');
    } else if (before && t.requesterId === meId && t.status === 'taken' && before.techId !== t.techId && t.techId) {
      toast(`${nameOf(t.techId)} took ${ticketRef(t.number)}`);
      if (!document.hasFocus()) window.dex.notify(tr(`${nameOf(t.techId)} is on ${ticketRef(t.number)}`), t.summary, 'dexconnect://help');
    }
  }), [users, meId, toast]);
  // a technician started a session: the requester decides whether to join
  useEffect(() => {
    if (invite && !document.hasFocus()) window.dex.notify(tr(`${users.get(invite.techId)?.displayName ?? 'IT'} is ready to help`), tr('Join the support session in Dexterity Connect'), 'dexconnect://help');
  }, [invite?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const rated = useMemo(() => (rate ? ticketById(rate) : null), [rate]);
  const close = () => setView(null);
  // the sheet takes the keyboard when it opens, and Escape closes it wherever the focus is
  // (unless a dialog over it, a field being typed in, or a menu has it)
  const sheetRef = useRef<HTMLElement>(null);
  const sheetOpen = view?.view === 'desk' || view?.view === 'ticket';
  useEffect(() => {
    if (!sheetOpen) return;
    const back = document.activeElement as HTMLElement | null;
    sheetRef.current?.focus({ preventScroll: true });
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select') || document.querySelector('.scrim, .popover')) return;
      setView(null);
    };
    window.addEventListener('keydown', k);
    return () => { window.removeEventListener('keydown', k); if (back?.isConnected) back.focus({ preventScroll: true }); };
  }, [sheetOpen]);
  const invited = invite ? ticketById(invite.ticketId) : null;
  const techName = (id: string) => users.get(id)?.displayName ?? 'IT';
  return (
    <>
      {view?.view === 'me' && <HelpMe users={users} onClose={close} onOpenTicket={(id) => setView({ view: 'ticket', id })} />}
      {(view?.view === 'desk' || view?.view === 'ticket') && (
        <div className="sheet-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
          <aside ref={sheetRef} tabIndex={-1} className="sheet wide hd-sheet" role="dialog" aria-modal="true" aria-label={view.view === 'desk' ? 'Help desk' : 'Help request'}>
            <button className="sheet-close" onClick={close} aria-label="Close" title="Close (Esc)"><Icon name="x" size={18} /></button>
            <div className="sheet-body">
              {view.view === 'desk' && isIt() ? <HelpDesk users={users} meId={meId} focus={view.id ?? null} />
                : view.view === 'ticket' ? <div className="view"><TicketView id={view.id} users={users} meId={meId} /></div>
                  : <div className="view"><div className="card empty"><Icon name="lock" size={30} /><span>The Help desk is for people on the IT desk.</span></div></div>}
            </div>
          </aside>
        </div>
      )}
      {invite && inRoom?.purpose?.kind !== 'support' && (
        <div className="hd-invite" role="alertdialog" aria-label="IT is ready to help">
          <Avatar user={{ id: invite.techId, displayName: techName(invite.techId) }} />
          <div className="hd-invite-text">
            <strong>{techName(invite.techId)} from IT is ready to help</strong>
            <span className="mono">{invited ? `${ticketRef(invited.number)} · ${invited.summary}` : 'SUPPORT SESSION'}</span>
            <span className="faint">You hear each other. You choose what they see, and nothing more.</span>
          </div>
          <div className="hd-invite-actions">
            <button className="btn primary" disabled={!!inRoom} title={inRoom ? 'Leave the Room you are in first' : ''} onClick={() => void joinSession(invite.ticketId).catch((e: Error) => toast(e.message, true))}><Icon name="phone" size={15} />Join the session</button>
            <button className="btn ghost" onClick={declineInvite}>Not now</button>
          </div>
        </div>
      )}
      {rated && rate && <RateSheet ticket={rated} tech={rated.techId ? techName(rated.techId) : 'IT'} onClose={clearRate} />}
      <LookHost users={users} meId={meId} />
    </>
  );
}
