// The Help desk: IT's queue of requests (open, taken, closed) as a ruled schedule, and a ticket
// sheet with its title block, the requester's words, files, the timeline and what can be done next.
// Requesters see the same ticket sheet for their own requests.
import { useEffect, useMemo, useState } from 'react';
import { ticketRef } from '@dex/core';
import type { HelpEntry, HelpTicket, PublicUser } from '@dex/core';
import { Avatar, Icon, Segmented, relativeTime, useToast } from '../ui.tsx';
import { clock, useCall } from '../rooms/engine.ts';
import { Files, StatusStamp, Timeline, categoryLabel, platformLabel } from './parts.tsx';
import { joinSession, startSession, useHelp } from './store.ts';

export function TicketView({ id, users, meId, onBack }: { id: string; users: Map<string, PublicUser>; meId: string; onBack?: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<{ ticket: HelpTicket; timeline: HelpEntry[] } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const staff = useHelp((s) => s.staff);
  const fresh = useHelp((s) => s.queue.find((t) => t.id === id) ?? s.mine.find((t) => t.id === id) ?? null);
  const inRoom = useCall((s) => s.room);
  useEffect(() => {
    let alive = true;
    void window.dex.request('help.get', { id }).then((d) => { if (alive) setData(d); }).catch((e: Error) => toast(e.message, true));
    const off = window.dex.onHubEvent((name, d) => {
      if (name === 'help.entry' && (d as HelpEntry).ticketId === id) setData((cur) => (cur && !cur.timeline.some((e) => e.id === (d as HelpEntry).id) ? { ...cur, timeline: [...cur.timeline, d as HelpEntry] } : cur));
      if (name === 'help.updated' && (d as HelpTicket).id === id) setData((cur) => (cur ? { ...cur, ticket: d as HelpTicket } : cur));
    });
    return () => { alive = false; off(); };
  }, [id, toast]);
  const t = fresh && data && fresh.updatedAt >= data.ticket.updatedAt ? fresh : data?.ticket;
  if (!data || !t) return <div className="tl-more"><span className="spinner" /></div>;
  const nameOf = (u: string | null) => (u ? users.get(u)?.displayName ?? 'Someone' : '—');
  const it = staff.includes(meId);
  const mineToFix = t.techId === meId;
  const requester = t.requesterId === meId;
  const run = async (f: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try { await f(); if (ok) toast(ok); } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const inThisSession = inRoom?.purpose?.kind === 'support' && inRoom.purpose.ticketId === t.id;
  return (
    <div className="hd-ticket">
      <header className="hd-tblock">
        {onBack && <button className="icon-btn only-narrow" onClick={onBack} aria-label="Back to the queue"><Icon name="back" size={18} /></button>}
        <div className="hd-tblock-main">
          <span className="label">Help request</span>
          <h2 translate="no">{t.summary}</h2>
        </div>
        <dl className="hd-facts">
          <div><dt>Ref</dt><dd className="mono">{ticketRef(t.number)}</dd></div>
          <div><dt>Status</dt><dd><StatusStamp t={t} /></dd></div>
          <div><dt>Asked by</dt><dd>{nameOf(t.requesterId)}</dd></div>
          <div><dt>About</dt><dd>{categoryLabel(t.category)}</dd></div>
          <div><dt>PC</dt><dd className="mono">{platformLabel(t.platform).toUpperCase()}</dd></div>
          <div><dt>Opened</dt><dd className="mono" title={new Date(t.createdAt).toLocaleString()}>{relativeTime(t.createdAt).toUpperCase()}</dd></div>
          <div><dt>Technician</dt><dd>{t.techId ? nameOf(t.techId) : '—'}</dd></div>
          {t.rating && <div><dt>Rating</dt><dd className="mono">{'■'.repeat(t.rating)}{'□'.repeat(5 - t.rating)}</dd></div>}
        </dl>
      </header>
      <div className="hd-actions">
        {it && !requester && t.status !== 'closed' && !mineToFix && (
          <button className="btn primary" disabled={busy} onClick={() => void run(() => window.dex.request('help.take', { id: t.id }), `${ticketRef(t.number)} is yours`)}>
            <Icon name="check" size={15} />{t.techId ? 'Take it over' : 'Take it'}
          </button>
        )}
        {mineToFix && t.status === 'taken' && !inThisSession && (
          <button className="btn primary" disabled={busy || (!!inRoom && !inThisSession)} title={inRoom && !inThisSession ? 'Leave the Room you are in first' : 'Open a support session with them'}
            onClick={() => void run(() => (t.session ? joinSession(t.id) : startSession(t.id)))}>
            <Icon name="screen" size={15} />{t.session ? 'Back to the session' : 'Start a support session'}
          </button>
        )}
        {requester && t.session && !inThisSession && (
          <button className="btn primary" disabled={busy} onClick={() => void run(() => joinSession(t.id))}><Icon name="screen" size={15} />Join the session</button>
        )}
        {mineToFix && t.status === 'taken' && (
          <button className="btn ghost" disabled={busy} onClick={() => void run(() => window.dex.request('help.release', { id: t.id }), 'Back in the queue')}>Hand back</button>
        )}
        {(requester || mineToFix) && t.status !== 'closed' && (
          <button className="btn ghost" disabled={busy} onClick={() => void run(() => window.dex.request('help.close', { id: t.id }), `${ticketRef(t.number)} closed`)}>Close</button>
        )}
        {requester && t.status === 'closed' && (
          <button className="btn" disabled={busy} onClick={() => void run(() => window.dex.request('help.reopen', { id: t.id }), 'Reopened')}><Icon name="refresh" size={15} />Reopen</button>
        )}
      </div>
      {t.detail && <p className="hd-detail" translate="no">{t.detail}</p>}
      {t.files.length > 0 && (
        <section>
          <div className="label hd-sec">Files · {t.files.length}</div>
          <Files files={t.files} users={users} meId={meId} />
          {t.files.filter((f) => f.kind === 'screenshot' && f.mime.startsWith('image/')).slice(-1).map((f) => <ScreenshotPreview key={f.fileId} fileId={f.fileId} name={f.name} />)}
        </section>
      )}
      <section>
        <div className="label hd-sec">Timeline</div>
        <Timeline entries={data.timeline} users={users} />
        {t.status !== 'closed' && (
          <form className="hd-note" onSubmit={(e) => { e.preventDefault(); if (note.trim()) void run(async () => { await window.dex.request('help.note', { id: t.id, text: note }); setNote(''); }); }}>
            <input className="input" placeholder={requester ? 'Add something for IT' : 'Add a note to the ticket'} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
            <button className="btn" disabled={busy || !note.trim()}><Icon name="send" size={14} />Add</button>
          </form>
        )}
      </section>
    </div>
  );
}

/** The screenshot the requester attached, drawn small. */
function ScreenshotPreview({ fileId, name }: { fileId: string; name: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (window.dex.fileUrl) void window.dex.fileUrl(fileId, name).then((u) => { if (alive) setSrc(u); }).catch(() => {});
    else setSrc(`dexfile://f/${fileId}`);
    return () => { alive = false; };
  }, [fileId, name]);
  return src ? <img className="hd-shot" src={src} alt={`Picture of the screen: ${name}`} /> : null;
}

/** IT's queue: open requests first, then those being worked on; closed ones on their own tab. */
export function HelpDesk({ users, meId, focus }: { users: Map<string, PublicUser>; meId: string; focus?: string | null }) {
  const queue = useHelp((s) => s.queue);
  const [tab, setTab] = useState<'active' | 'closed'>('active');
  const [open, setOpen] = useState<string | null>(focus ?? null);
  useEffect(() => { if (focus) setOpen(focus); }, [focus]);
  const list = useMemo(() => {
    const l = queue.filter((t) => (tab === 'closed' ? t.status === 'closed' : t.status !== 'closed'));
    return tab === 'closed' ? l.sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
      : l.sort((a, b) => Number(!!b.session) - Number(!!a.session) || (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || a.createdAt - b.createdAt);
  }, [queue, tab]);
  const counts = { open: queue.filter((t) => t.status === 'open').length, taken: queue.filter((t) => t.status === 'taken').length, mine: queue.filter((t) => t.status === 'taken' && t.techId === meId).length };
  const nameOf = (u: string | null) => (u ? users.get(u)?.displayName ?? 'Someone' : '—');
  return (
    <div className="view hd-view">
      <div className="view-head">
        <div>
          <h1>Help desk</h1>
          <p className="muted">Requests from the office. Take one, then open a support session from it: they decide what you see and touch.</p>
        </div>
        <dl className="hd-counts">
          <div><dt>In the queue</dt><dd className="mono">{counts.open}</dd></div>
          <div><dt>With IT</dt><dd className="mono">{counts.taken}</dd></div>
          <div><dt>Yours</dt><dd className="mono">{counts.mine}</dd></div>
        </dl>
      </div>
      <div className="hd-split">
        <div className={`hd-queue${open ? ' has-open' : ''}`}>
          <div className="toolbar">
            <Segmented<'active' | 'closed'> label="Show" value={tab} onChange={setTab} options={[{ value: 'active', label: 'Active' }, { value: 'closed', label: 'Closed' }]} />
          </div>
          {!list.length && <div className="card empty hd-empty"><Icon name="check" size={30} /><span>{tab === 'closed' ? 'Nothing closed yet.' : 'Nobody is waiting for IT.'}</span></div>}
          <table className="hd-table" aria-label="Help requests">
            <tbody>
              {list.map((t) => (
                <tr key={t.id} className={`${open === t.id ? 'on' : ''}${t.status === 'open' ? ' hd-waiting' : ''}`} onClick={() => setOpen(t.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(t.id); }}>
                  <td className="ref mono">{ticketRef(t.number)}</td>
                  <td className="who"><Avatar user={{ id: t.requesterId, displayName: nameOf(t.requesterId) }} size="sm" /></td>
                  <td className="what">
                    <span className="hd-what">
                      <span className="hd-sum" translate="no">{t.summary}</span>
                      <span className="mono faint">{nameOf(t.requesterId).toUpperCase()} · {categoryLabel(t.category).toUpperCase()}{t.files.some((f) => f.kind === 'screenshot') ? ' · PICTURE' : ''}</span>
                    </span>
                  </td>
                  <td className="age mono" title={new Date(t.createdAt).toLocaleString()}>{tab === 'closed' && t.closedAt ? clock(t.closedAt) : relativeTime(t.createdAt).toUpperCase()}</td>
                  <td className="st"><StatusStamp t={t} />{t.techId && t.status !== 'open' && <span className="mono faint hd-tech">{t.techId === meId ? 'YOU' : nameOf(t.techId).split(' ')[0].toUpperCase()}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="hd-pane">
          {open ? <TicketView key={open} id={open} users={users} meId={meId} onBack={() => setOpen(null)} />
            : <div className="hd-blank"><span>Choose a request to see it.</span></div>}
        </div>
      </div>
    </div>
  );
}
