// The notice board's pieces that live outside its lens: the host that opens a notice or the
// composer from anywhere (Pulse, search, a link, a notification), the urgent banner under the title
// bar, and Pulse's "Needs you" rows and "This week at the office" strip.
import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import type { NoticeSummary, Session } from '@dex/core';
import { Icon, useToast } from '../ui.tsx';
import { CAT_LABEL, dateText, refText, titleOf } from './parts.tsx';
import type { NoticeOpen } from './store.ts';
import { openNotice, reloadNotices, useNotices, waitingForMe } from './store.ts';
import './notices.css';

const NoticeSheet = lazy(() => import('./Sheet.tsx'));
const NoticeComposer = lazy(() => import('./Composer.tsx'));

export function NoticeHost({ session }: { session: Session }) {
  const [open, setOpen] = useState<NoticeOpen | null>(null);
  useEffect(() => {
    const on = (e: Event) => setOpen((e as CustomEvent<NoticeOpen>).detail);
    window.addEventListener('dex-notice', on);
    return () => window.removeEventListener('dex-notice', on);
  }, []);
  if (!open || session.me.role === 'guest' || session.me.role === 'bot') return null;
  return (
    <Suspense fallback={<div className="sheet-scrim nb-scrim"><div className="tl-more"><span className="spinner" /></div></div>}>
      {open.kind === 'read'
        ? <NoticeSheet key={open.id} id={open.id} session={session} onClose={() => setOpen(null)} />
        : <NoticeComposer key={open.id ?? 'new'} id={open.id} deskId={open.deskId} session={session} onClose={() => setOpen(null)} />}
    </Suspense>
  );
}

/** One urgent notice at a time, full width under the title bar, until it is dismissed (on every device). */
export function NoticeBanner() {
  const toast = useToast();
  const b = useNotices((s) => s.list?.banner ?? null);
  if (!b) return null;
  const dismiss = () => void window.dex.request('notices.dismiss', { id: b.id }).then(() => reloadNotices()).catch((e: Error) => toast(e.message, true));
  return (
    <div className="nb-banner" role="alert">
      <span className="nb-banner-tag mono">Urgent</span>
      <span className="nb-banner-text"><span className="mono" translate="no">{b.number}</span> <span translate="no">{titleOf(b)}</span><span className="nb-banner-from"> · <span translate="no">{b.deskName}</span></span></span>
      <button className="btn sm" onClick={() => { openNotice(b.id); dismiss(); }}>Read</button>
      <button className="icon-btn" onClick={dismiss} aria-label="Dismiss" title="Dismiss"><Icon name="x" size={16} /></button>
    </div>
  );
}

/** Pulse's rows for notices waiting for my acknowledgement. */
export function NoticeNeedsRows() {
  const list = useNotices((s) => s.list);
  const waiting = waitingForMe(list);
  if (!waiting.length) return null;
  return (
    <div className="list nb-pulse-rows" style={{ marginBottom: 10 }}>
      {waiting.slice(0, 5).map((n) => (
        <button key={n.id} className="list-row pulse-row" onClick={() => openNotice(n.id)}>
          <span className="pal-icon nb-pulse-ico"><Icon name="stamp" size={16} /></span>
          <span className="sb-main">
            <span className="sb-title"><span className="sb-name" translate="no" title={titleOf(n)}>{titleOf(n)}</span></span>
            <span className="sb-preview"><span className="mono" translate="no">{refText(n)}</span> · <span translate="no">{n.deskName}</span> · {CAT_LABEL[n.category]}</span>
          </span>
          <span className="sb-meta"><span className="chip warn">Acknowledge</span></span>
        </button>
      ))}
    </div>
  );
}
export const useNoticesWaiting = () => waitingForMe(useNotices((s) => s.list)).length;

const startOfWeek = (t = Date.now()) => { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
const DAY = 86400_000;

/**
 * "This week at the office": seven day cells as a scale, holidays and events on their day, and
 * the policies and notices issued this week; the board's front page (the way in on a phone).
 */
export function WeekStrip({ onOpenBoard }: { onOpenBoard: () => void }) {
  const list = useNotices((s) => s.list);
  const from = startOfWeek();
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => from + i * DAY), [from]);
  const live = (list?.notices ?? []).filter((n) => n.number && (n.status === 'issued' || n.status === 'expired'));
  const onDay = (n: NoticeSummary) => (n.category === 'holiday' || n.category === 'event') && n.effectiveAt !== null && n.effectiveAt >= from && n.effectiveAt < from + 7 * DAY;
  const dated = live.filter(onDay);
  const issued = live.filter((n) => !onDay(n) && n.status === 'issued' && (n.issuedAt ?? 0) >= from && (n.issuedAt ?? 0) < from + 7 * DAY).sort((a, b) => (b.issuedAt ?? 0) - (a.issuedAt ?? 0)).slice(0, 4);
  const today = new Date().toDateString();
  const inForce = live.filter((n) => n.status === 'issued').length;
  if (!list) return null;
  return (
    <section className="nb-week" aria-label="This week at the office">
      <div className="nb-week-head">
        <span className="label">This week at the office</span>
        <button className="link nb-week-open" onClick={onOpenBoard}>{inForce === 1 ? 'Notice board · 1 in force' : `Notice board · ${inForce} in force`}<span aria-hidden="true"> ▸</span></button>
      </div>
      <ol className="nb-week-scale">
        {days.map((d) => {
          const items = dated.filter((n) => n.effectiveAt! >= d && n.effectiveAt! < d + DAY);
          const dt = new Date(d);
          return (
            <li key={d} className={`nb-day${dt.toDateString() === today ? ' today' : ''}${items.length ? ' has' : ''}`}>
              <span className="nb-day-name">{dt.toLocaleDateString([], { weekday: 'short' })}</span>
              <span className="nb-day-no mono">{dt.getDate()}</span>
              {items.map((n) => (
                <button key={n.id} className={`nb-day-item ${n.category}`} onClick={() => openNotice(n.id)}>
                  <span className="nb-day-cat">{CAT_LABEL[n.category]}</span><span translate="no">{titleOf(n)}</span>
                </button>
              ))}
            </li>
          );
        })}
      </ol>
      {issued.length > 0 && (
        <ul className="nb-week-new" aria-label="Issued this week">
          {issued.map((n) => (
            <li key={n.id}><button className="nb-week-line" onClick={() => openNotice(n.id)}>
              <span className="mono" translate="no">{refText(n)}</span><span className="nb-week-title" translate="no">{titleOf(n)}</span><span className="faint">{dateText(n.issuedAt)}</span>
              {n.needsAck && <span className="chip warn">Acknowledge</span>}
            </button></li>
          ))}
        </ul>
      )}
      {!dated.length && !issued.length && <p className="faint nb-week-none">Nothing new on the notice board this week.</p>}
    </section>
  );
}
