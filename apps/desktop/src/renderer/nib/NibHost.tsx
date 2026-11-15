// Nib in the app frame: the tile in the title bar (beside your own), the callout that opens under it
// at the start of the day and at wrap-up, and Nib's tray (loaded when first opened). Always mounted.
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import type { PublicUser, Session, WorkState } from '@dex/core';
import { Avatar, Icon, useToast } from '../ui.tsx';
import { NibTile } from './NibMark.tsx';
import type { Ink } from './NibMark.tsx';
import { closeTray, dismissCallout, nibDay, nibMeId, nibStart, openTray, promptStart, rankGivers, refreshNib, startNib, toggleTray, useNib } from './store.ts';
import type { TrayView } from './store.ts';
import { firstName, wrapTimeText } from './words.ts';
import './nib.css';

const Tray = lazy(() => import('./Tray.tsx'));

/** Open Nib's tray from anywhere (a slash command, the tray menu, a card). */
export function openNib(view: TrayView = { v: 'home' }, seed = ''): void {
  window.dispatchEvent(new CustomEvent('dex-nib', { detail: { view, seed } }));
}

/** The tile in the title bar. */
export function NibButton() {
  const me = useNib((s) => s.me);
  const open = useNib((s) => s.open);
  const callout = useNib((s) => s.callout);
  if (!me || !me.enabled) return null;
  const n = me.nudge;
  const ink: Ink = callout || (n && n.level >= 2) ? 'needs' : (n && n.level >= 1) || me.welcome ? 'quiet' : 'none';
  const label = ink === 'needs' ? 'Nib: your day sheet is waiting' : ink === 'quiet' ? 'Nib: something to look at' : 'Nib';
  return (
    <div className="nib-wrap">
      <button className={`nib-btn${open ? ' open' : ''}`} aria-haspopup="dialog" aria-expanded={open} aria-label={label} title={`${label} (Ctrl+Alt+N)`} onClick={() => toggleTray()}>
        <NibTile size={28} ink={ink} />
      </button>
      {callout && !open && <Callout kind={callout} />}
    </div>
  );
}

/** The small card under the tile: never a modal, never takes focus, Escape closes it. */
function Callout({ kind }: { kind: 'start' | 'wrap' }) {
  const me = useNib((s) => s.me)!;
  const toast = useToast();
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const users = useUsers();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.scrim, .sheet-scrim')) dismissCallout(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const run = (p: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    void p().then(() => { if (ok) toast(ok); }).catch((e: Error) => toast(e.message, true)).finally(() => setBusy(false));
  };
  const name = firstName(users.get(nibMeId())?.displayName ?? '');
  if (kind === 'start') {
    const order = rankGivers(me, users, nibMeId()).slice(0, 6);
    return (
      <section className="nib-callout" aria-label="Nib: who gave you work today">
        <div className="nib-callout-head">
          <span className="mono">NIB · START OF THE DAY</span>
          <button className="icon-btn sm" aria-label="Not now" title="Not now (Esc)" onClick={() => dismissCallout()}><Icon name="x" size={14} /></button>
        </div>
        <p className="nib-line" role="status">{name ? `Morning, ${name}. Who’s given you work today?` : 'Who’s given you work today?'}</p>
        {me.yesterday && (
          <p className="nib-yesterday">
            <span>{me.yesterday.items === 1 ? 'Your last day sheet was not sent. It has 1 item.' : `Your last day sheet was not sent. It has ${me.yesterday.items} items.`}</span>
            <button className="link" disabled={busy} onClick={() => run(() => nibStart([], [], 'send'), 'Sent your last day sheet')}>Send it now</button>
          </p>
        )}
        {order.length > 0 && (
          <div className="nib-pick" role="group" aria-label="People who give you work">
            {order.map((id) => {
              const u = users.get(id);
              if (!u) return null;
              const g = me.givers.find((x) => x.userId === id);
              const on = picked.includes(id);
              return (
                <button key={id} type="button" className={`nib-giver${on ? ' on' : ''}`} aria-pressed={on} onClick={() => setPicked(on ? picked.filter((x) => x !== id) : [...picked, id])}>
                  <Avatar user={u} size="sm" />
                  <span className="nib-giver-name" translate="no">{firstName(u.displayName)}</span>
                  {g?.scope ? <span className="nib-giver-scope mono" translate="no">{g.scope}</span> : me.usual.includes(id) ? <span className="nib-giver-scope mono">USUAL</span> : null}
                </button>
              );
            })}
          </div>
        )}
        <div className="nib-callout-actions">
          <button className="btn primary sm" disabled={busy || !picked.length} onClick={() => run(async () => { await nibStart(picked); dismissCallout(); }, 'Noted. Tell me as more comes in.')}>Log these</button>
          <button className="btn sm" onClick={() => { openTray({ v: 'start' }); }}>Someone else…</button>
          <button className="btn ghost sm" disabled={busy} onClick={() => run(async () => { await nibStart([]); dismissCallout(); }, 'I’ll ask again at wrap-up.')}>Nothing yet</button>
          <button className="btn ghost sm" onClick={() => openTray({ v: 'leave' })}>On leave today</button>
        </div>
      </section>
    );
  }
  const items = me.items.length;
  return (
    <section className="nib-callout" aria-label="Nib: wrap-up">
      <div className="nib-callout-head">
        <span className="mono">NIB · WRAP-UP</span>
        <button className="icon-btn sm" aria-label="Not now" title="Not now (Esc)" onClick={() => dismissCallout()}><Icon name="x" size={14} /></button>
      </div>
      <p className="nib-line" role="status">{items ? (items === 1 ? `Pens down at ${wrapTimeText(me)}. Your sheet has 1 item to check.` : `Pens down at ${wrapTimeText(me)}. Your sheet has ${items} items to check.`) : 'Pens down soon. Your sheet is empty: tell me what you did, or say nothing today.'}</p>
      <div className="nib-callout-actions">
        <button className="btn primary sm" onClick={() => openTray({ v: 'wrap' })}>Check and send</button>
        <button className="btn sm" disabled={busy} onClick={() => run(async () => { await nibDay({ snoozeMinutes: 30 }); dismissCallout(); }, 'I’ll ask again in 30 minutes.')}>In 30 min</button>
        <button className="btn sm" disabled={busy} onClick={() => run(async () => { await nibDay({ snoozeUntilFree: true }); dismissCallout(); }, 'I’ll wait until your meeting ends.')}>After my meeting</button>
        {!me.items.some((x) => !x.carried) && <button className="btn ghost sm" disabled={busy} onClick={() => run(async () => { await nibDay({ nothing: true }); dismissCallout(); }, 'Nothing today. Fair enough.')}>Nothing today</button>}
      </div>
    </section>
  );
}

let usersNow: Map<string, PublicUser> = new Map();
const userListeners = new Set<() => void>();
function useUsers(): Map<string, PublicUser> {
  const [, force] = useState(0);
  useEffect(() => { const f = () => force((n) => n + 1); userListeners.add(f); return () => { userListeners.delete(f); }; }, []);
  return usersNow;
}
export const nibUsers = () => usersNow;

/** The tray and the wiring: mounted once in the app frame. */
export function NibHost({ session, users, live }: { session: Session; users: Map<string, PublicUser>; live: boolean }) {
  const open = useNib((s) => s.open);
  const me = useNib((s) => s.me);
  const welcomed = useRef(false);
  if (usersNow !== users) { usersNow = users; for (const l of userListeners) l(); }
  const member = session.me.role !== 'guest' && session.me.role !== 'bot';
  useEffect(() => { if (live && member) void startNib(session.me.id, () => [...usersNow.values()]); }, [live, member, session.me.id]);
  // from anywhere: a slash command, a card, the tray menu (dexconnect://nib), Ctrl+Alt+N
  useEffect(() => {
    const on = (e: Event) => { const d = (e as CustomEvent).detail as { view?: TrayView; seed?: string } | undefined; openTray(d?.view ?? { v: 'home' }, d?.seed ?? ''); };
    window.addEventListener('dex-nib', on);
    return () => window.removeEventListener('dex-nib', on);
  }, []);
  // starting the day asks who gave you work
  useEffect(() => window.dex.onHubEvent((name, data) => {
    const s = data as WorkState;
    if (name !== 'work.updated' || s.userId !== session.me.id || s.status !== 'in' || !s.checkedInAt || Date.now() - s.checkedInAt > 60_000) return;
    void refreshNib().then(() => promptStart());
  }), [session.me.id]);
  // the first day back: the welcome back, once
  useEffect(() => {
    if (!me?.welcome || welcomed.current) return;
    welcomed.current = true;
    openTray({ v: 'welcome' });
  }, [me?.welcome]);
  if (!member || !open) return null;
  return (
    <Suspense fallback={null}>
      <Tray session={session} users={users} onClose={closeTray} />
    </Suspense>
  );
}
