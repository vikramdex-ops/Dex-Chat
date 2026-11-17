// What a meeting's thread shows of its meetings: the divider when an occurrence starts, its recap
// card when it ends (a title block over a ruled line of counts), a cancellation; and the host that
// opens the recap sheet (loaded only when opened) from anywhere: the card, the Calendar, the Meet
// lens. Action points assigned to you arrive here as one quiet notice.
import { Suspense, lazy, useEffect, useState } from 'react';
import { apRef } from '@dex/core';
import type { ActionPoint, MeetCard, Message, PublicUser } from '@dex/core';
import { Icon, useToast } from '../ui.tsx';
import './threads.css';
import { formatTime, useTimeFormat } from '../time.ts';

const RecapSheet = lazy(() => import('./Recap.tsx'));

/** Open the recap of an occurrence (the sheet over everything). */
export function openRecap(occurrenceId: string): void { window.dispatchEvent(new CustomEvent('dex-recap', { detail: occurrenceId })); }

const two = (n: number) => String(n).padStart(2, '0');
/** The time of day as the person set it (Preferences ▸ Appearance: 12- or 24-hour). */
const hm = (t: number) => formatTime(t);
const dayCap = (t: number) => new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase();
export const minutesText = (min: number) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${two(min % 60)} min`);

/** A card the hub posted in the thread. */
export function MeetCardView({ m }: { m: Message }) {
  const c = m.meetCard as MeetCard;
  useTimeFormat(); // drawn again when 12/24-hour changes
  if (c.kind === 'started') {
    return (
      <div className="meet-divider" role="separator" aria-label={`Meeting started: ${c.title}, ${dayCap(c.startedAt)} ${hm(c.startedAt)}`}>
        <span className="mono">{dayCap(c.startedAt)}</span>
        <b translate="no">{c.title}</b>
        <span className="mono">{c.endedAt ? `${hm(c.startedAt)}–${hm(c.endedAt)}` : `STARTED ${hm(c.startedAt)}`}</span>
        {c.no && <span className="mono faint">{c.no}</span>}
      </div>
    );
  }
  if (c.kind === 'cancelled') {
    return (
      <div className="meet-divider cancelled" role="note">
        <span className="tag mono">CANCELLED</span>
        <b translate="no">{c.title}</b>
        <span className="faint">The thread stays: everything shared here is kept.</span>
      </div>
    );
  }
  const minutes = c.minutes ?? 0;
  return (
    <div className="recap-card">
      <div className="rc-head">
        <Icon name="recap" size={18} />
        <span className="mono rc-kind">MEETING RECAP</span>
        <span className="mono faint rc-no">{c.no}</span>
      </div>
      <div className="rc-title" translate="no">{c.title}</div>
      <div className="rc-when mono">{dayCap(c.startedAt)} · {hm(c.startedAt)}{c.endedAt ? `–${hm(c.endedAt)}` : ''} · {minutesText(minutes)}</div>
      <dl className="rc-counts">
        <div><dt className="mono">PEOPLE</dt><dd>{c.people ?? 0}</dd></div>
        <div><dt className="mono">FILES</dt><dd>{c.files ?? 0}</dd></div>
        <div><dt className="mono">ACTIONS OPEN</dt><dd className={c.actionsOpen ? 'open' : undefined}>{c.actionsOpen ?? 0}</dd></div>
        <div><dt className="mono">DONE</dt><dd>{c.actionsDone ?? 0}</dd></div>
        <div><dt className="mono">DECISIONS</dt><dd>{c.decisions ?? 0}</dd></div>
      </dl>
      {c.occurrenceId && <button className="btn primary sm" onClick={() => openRecap(c.occurrenceId!)}><Icon name="recap" size={14} />Open the recap</button>}
    </div>
  );
}

/** The recap sheet when it is opened, and the quiet notice for an action point given to you. */
export function RecapHost({ users, meId, jump }: { users: Map<string, PublicUser>; meId: string; jump: (convId: string, messageId?: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const toast = useToast();
  useEffect(() => {
    const on = (e: Event) => setOpen(String((e as CustomEvent).detail));
    window.addEventListener('dex-recap', on);
    const off = window.dex.onHubEvent((name, data) => {
      if (name !== 'ap.assigned') return;
      const d = data as { action: ActionPoint; by: string; title: string };
      const by = users.get(d.by)?.displayName ?? 'Someone';
      toast(`${apRef(d.action.n)} for you from ${d.title}: ${d.action.text || 'open it to read'} · from ${by}. It is on your Desk.`);
    });
    return () => { window.removeEventListener('dex-recap', on); off(); };
  }, [users, toast]);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <RecapSheet occurrenceId={open} users={users} meId={meId} onClose={() => setOpen(null)} jump={(c, mid) => { setOpen(null); jump(c, mid); }} />
    </Suspense>
  );
}
