// A meeting's public face, for its hosts (Dexterity Meet): its page on the office's meeting site
// (https://dexterity-meet.pages.dev/482-913-207, or a name the host gives it such as
// …/p12-design-review), whether guests can join from a browser, the passcode (in the link's
// #fragment, renewable: the old link stops), whether the page shows the title before the passcode,
// and the lobby. Guests open the page, wait in the lobby and are let in by a host. The same block
// writes invitations: as text to paste into an email, or as an .ics file any calendar opens (one
// VEVENT with a UID that stays the same, so a new copy updates the old one).
import { useEffect, useRef, useState } from 'react';
import { formatMeetingId, meetingLink, normalizeSlug } from '@dex/core';
import type { CalEvent, LobbyRule, MeetPublicView, MeetingInfo, Ops, PublicUser } from '@dex/core';
import { buildIcs, invitationText } from '@dex/core/ics';
import type { Invitation } from '@dex/core/ics';
import { Icon, Toggle, useToast } from '../ui.tsx';
import { confirmAction } from '../confirm.tsx';
import { Glyph } from '../rooms/parts.tsx';
import './page.css';

/** "Wednesday 18 November 2026, 10:00 – 11:00 (Asia/Kolkata)": what an invitation says about when. */
export function whenText(startAt: number, endAt: number, zone?: string | null): string {
  const tz = zone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const day = new Date(startAt).toLocaleDateString('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const t = (x: number) => new Date(x).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  return `${day}, ${t(startAt)} – ${t(endAt)} (${tz})`;
}

/** One UID per meeting: the invitation, the meeting page's "Add to calendar" and a later copy all update the same entry. */
export const invitationUid = (meetingId: string) => `meeting-${meetingId}@dexconnect`;

export function invitationFor(m: MeetingInfo, page: MeetPublicView | null, opts: { title: string; startAt: number; endAt: number; description?: string | null; organizer: PublicUser | null; office: string; eventId?: string | null; location?: string | null }): Invitation {
  return {
    uid: invitationUid(m.id),
    title: opts.title || m.title || `Meeting ${formatMeetingId(m.id)}`,
    startAt: opts.startAt, endAt: opts.endAt,
    organizer: { name: opts.organizer?.displayName ?? 'Dexterity Connect', email: opts.organizer?.profile?.email ?? null, id: m.hostId },
    office: opts.office, meetingId: m.id,
    guestUrl: page?.guestUrl ?? null, pageUrl: page?.guestUrl ? page.url : null, passcode: page?.guestUrl ? page.passcode : null,
    appLink: meetingLink(m.id), description: opts.description ?? null, location: opts.location ?? null,
  };
}

/** Save text as a file on this PC (the .ics invitation, a report's CSV). */
export function saveText(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const safeFile = (s: string) => s.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Meeting';

const LOBBY_RULES: Array<{ value: LobbyRule; label: string }> = [
  { value: 'outside', label: 'Guests and people from outside wait' }, { value: 'everyone', label: 'Everyone waits to be let in' }, { value: 'off', label: 'Only guests from a browser wait' },
];

/** The meeting's name on the site: typed, checked as you type (taken, kept, look-alike letters), saved on Enter or Save. */
export function SlugField({ meetingId, value, site, onSave, compact }: { meetingId: string | null; value: string | null; site: string | null; onSave: (slug: string | null) => void | Promise<void>; compact?: boolean }) {
  const [text, setText] = useState(value ?? '');
  const [check, setCheck] = useState<{ slug: string; ok: boolean; problem: string | null } | null>(null);
  useEffect(() => { setText(value ?? ''); }, [value]);
  const slug = normalizeSlug(text);
  useEffect(() => {
    setCheck(null);
    if (!slug || slug === value) return;
    let alive = true;
    const t = setTimeout(() => { void window.dex.request('meet.slug.check', { slug, ...(meetingId ? { id: meetingId } : {}) }).then((c) => { if (alive) setCheck(c); }).catch(() => {}); }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [slug, value, meetingId]);
  const dirty = slug !== (value ?? '');
  const save = () => { if (dirty && (!slug || check?.ok)) void onSave(slug || null); };
  return (
    <div className={`slug-field${compact ? ' compact' : ''}`}>
      <div className="slug-row">
        <span className="mono slug-base" title={site ?? undefined}>{site ? `${site.replace(/^https?:\/\//, '')}/` : '…/'}</span>
        <input className="input mono" aria-label="The meeting's name on the meeting site" placeholder={meetingId ? formatMeetingId(meetingId) : 'p12-design-review'} maxLength={48} value={text}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }} onBlur={() => { if (!meetingId) save(); }} />
        {meetingId && <button className="btn sm" disabled={!dirty || (!!slug && !check?.ok)} onClick={save}>Save name</button>}
      </div>
      <span className={`slug-note${check && !check.ok ? ' bad' : ''}`} role="status">
        {!slug ? 'No name: the page is at the meeting ID.' : !dirty ? 'Guests can type this name or click the link.' : !check ? 'Checking…' : check.ok ? `Free: …/${check.slug}` : check.problem}
      </span>
    </div>
  );
}

/** Turn the browser link on or off, renew it, name the page, show its title or not. `onChange` hears about the new state. */
export function GuestLinkControls({ meetingId, compact, onChange }: { meetingId: string; compact?: boolean; onChange?: (v: MeetPublicView) => void }) {
  const toast = useToast();
  const [v, setV] = useState<MeetPublicView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const changed = useRef(onChange);
  changed.current = onChange;
  useEffect(() => {
    let alive = true;
    void window.dex.request('meet.public.get', { id: meetingId }).then((x) => { if (alive) { setV(x); changed.current?.(x); } }).catch((e: Error) => { if (alive) setProblem(e.message); });
    return () => { alive = false; };
  }, [meetingId]);
  const change = (patch: Omit<Ops['meet.public.set']['req'], 'id'>, done?: string) => window.dex.request('meet.public.set', { id: meetingId, ...patch })
    .then((x) => { setV(x); changed.current?.(x); if (done) toast(done); })
    .catch((e: Error) => { toast(e.message, true); });
  if (problem) return <p className="faint guest-problem">{problem}</p>;
  if (!v) return <div className="tl-more"><span className="spinner" /></div>;
  return (
    <div className={`guest-link${compact ? ' compact' : ''}`}>
      <div className="guest-row">
        <div className="txt">
          <div>Guests can join from a browser</div>
          <div className="faint">No app needed. They open the meeting's page and wait in the lobby until a host lets them in.</div>
        </div>
        <Toggle label="Guests can join from a browser" checked={v.enabled} onChange={(on) => void change({ enabled: on })} />
      </div>
      {v.problem && <p className="guest-problem"><Icon name="warning" size={14} />{v.problem}</p>}
      {v.enabled && v.passcode && (
        <table className="guest-cells">
          <tbody>
            {v.guestUrl && (
              <tr><th className="label">Link</th><td className="mono guest-url" title={v.guestUrl}>{v.guestUrl}</td>
                <td><button className="tb-link" onClick={() => void navigator.clipboard.writeText(v.guestUrl!).then(() => toast('Meeting link copied, with the passcode'))}><Glyph name="copy" size={13} />Copy</button></td></tr>
            )}
            <tr><th className="label">Passcode</th><td className="mono guest-pass">{v.passcode}</td>
              <td><button className="tb-link" onClick={() => void confirmAction({ title: 'Give the meeting link a new passcode?', body: 'The link people have now stops working. Send the new one to the guests who still need it.', confirm: 'Renew the link' }).then((ok) => { if (ok) void change({ regenerate: true }, 'New passcode: the old link no longer works'); })}><Icon name="refresh" size={13} />Renew</button></td></tr>
            <tr><th className="label">Name</th><td colSpan={2}><SlugField meetingId={meetingId} value={v.slug} site={v.site} compact onSave={(slug) => change({ slug }, slug ? `The page is now …/${slug}` : 'The page is at the meeting ID again')} /></td></tr>
            <tr><th className="label">Page</th><td colSpan={2}>
              <label className="guest-check"><input type="checkbox" checked={v.showTitle} onChange={(e) => void change({ showTitle: e.target.checked })} />Show the title on the invitation page</label>
              <span className="faint guest-hint">{v.showTitle ? 'Anyone with the address sees the title and your first name before the passcode.' : 'Before the passcode, the page shows only the date, the time and the office.'}</span>
            </td></tr>
            {!compact && (
              <tr><th className="label">Lobby</th><td colSpan={2}>
                <select className="input" aria-label="Who waits in the lobby" value={v.lobby} onChange={(e) => void change({ lobby: e.target.value as LobbyRule })}>{LOBBY_RULES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select>
              </td></tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * Invitations for a meeting: the meeting's page (for hosts), "Copy invitation" and "Download
 * invitation (.ics)". People who do not run the meeting get the invitation for colleagues.
 */
export function MeetingInvite({ meeting, title, startAt, endAt, description, organizer, office, eventId, location, isHost, zone }: {
  meeting: MeetingInfo; title: string; startAt: number; endAt: number; description?: string | null; organizer: PublicUser | null; office: string;
  eventId?: string | null; location?: string | null; isHost: boolean; zone?: string | null;
}) {
  const toast = useToast();
  const [page, setPage] = useState<MeetPublicView | null>(null);
  const inv = invitationFor(meeting, page, { title, startAt, endAt, description, organizer, office, eventId, location });
  const when = whenText(startAt, endAt, zone);
  const pageUrl = page?.url ?? meeting.page ?? null;
  return (
    <section className="meet-invite-block" aria-label="Invitations">
      {isHost && <GuestLinkControls meetingId={meeting.id} onChange={setPage} />}
      <div className="invite-actions">
        <span className="mono faint">ID {formatMeetingId(meeting.id)}</span>
        {pageUrl && !page?.guestUrl && <button className="btn sm ghost" onClick={() => void navigator.clipboard.writeText(pageUrl).then(() => toast('Meeting page copied'))}><Glyph name="copy" size={14} />Copy page link</button>}
        <button className="btn sm" onClick={() => void navigator.clipboard.writeText(invitationText(inv, when)).then(() => toast(page?.guestUrl ? 'Invitation copied, with the meeting link and passcode' : 'Invitation copied'))}>
          <Glyph name="copy" size={14} />Copy invitation
        </button>
        <button className="btn sm" onClick={() => { saveText(`${safeFile(inv.title)}.ics`, buildIcs(inv, when), 'text/calendar;charset=utf-8'); toast('Invitation saved as an .ics file'); }}>
          <Icon name="download" size={14} />Download invitation (.ics)
        </button>
      </div>
    </section>
  );
}

/** In the Calendar's meeting dialog: a meeting held as a call gets its page and invitation tools. */
export function EventInvite({ ev, users, meId, office }: { ev: CalEvent; users: Map<string, PublicUser>; meId: string; office: string }) {
  const [m, setM] = useState<MeetingInfo | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void window.dex.request('meet.event', { eventId: ev.id }).then((x) => { if (alive) setM(x); }).catch((e: Error) => { if (alive) setProblem(e.message); });
    return () => { alive = false; };
  }, [ev.id]);
  if (problem) return null;
  if (!m) return <div className="tl-more"><span className="spinner" /></div>;
  return (
    <div className="field">
      <label>Meeting page, invitations and guests</label>
      <MeetingInvite meeting={m} title={ev.title} startAt={ev.startAt} endAt={ev.endAt} description={ev.description} organizer={users.get(ev.organizerId) ?? null}
        office={office} eventId={ev.id} location={ev.location} isHost={m.hostId === meId || m.coHosts.includes(meId)} zone={ev.timeZone} />
    </div>
  );
}

/** The meeting's page address with a copy button: on meeting cards (the Meet lens, the Calendar). */
export function PageLink({ url, label = 'Copy link' }: { url: string; label?: string }) {
  const toast = useToast();
  return (
    <span className="page-link">
      <span className="mono page-url" title={url}>{url.replace(/^https?:\/\//, '')}</span>
      <button className="tb-link" aria-label={`${label}: ${url}`} onClick={(e) => { e.stopPropagation(); void navigator.clipboard.writeText(url).then(() => toast('Meeting page copied')); }}><Glyph name="copy" size={12} />{label}</button>
    </span>
  );
}
