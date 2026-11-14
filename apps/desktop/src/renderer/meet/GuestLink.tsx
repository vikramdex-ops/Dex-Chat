// The guest link of a meeting, for its hosts: people without the app join from a browser through
// the office's gateway, wait in the lobby, and are let in by a host. The link's passcode lives in
// its #fragment. Hosts turn the link on or off and renew its passcode (the old link stops). The
// same block writes invitations: as text to paste into an email, or as an .ics file any calendar
// opens (one VEVENT, times in UTC, the organiser, the link and passcode).
import { useEffect, useState } from 'react';
import { formatMeetingId, meetingLink } from '@dex/core';
import type { CalEvent, GuestLinkView, MeetingInfo, PublicUser } from '@dex/core';
import { buildIcs, invitationText } from '@dex/core/ics';
import type { Invitation } from '@dex/core/ics';
import { Icon, Toggle, useToast } from '../ui.tsx';
import { Glyph } from '../rooms/parts.tsx';

/** "Wednesday 18 November 2026, 10:00 – 11:00 (Asia/Kolkata)": what an invitation says about when. */
export function whenText(startAt: number, endAt: number, zone?: string | null): string {
  const tz = zone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const day = new Date(startAt).toLocaleDateString('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const t = (x: number) => new Date(x).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  return `${day}, ${t(startAt)} – ${t(endAt)} (${tz})`;
}

export function invitationFor(m: MeetingInfo, link: GuestLinkView | null, opts: { title: string; startAt: number; endAt: number; description?: string | null; organizer: PublicUser | null; office: string; eventId?: string | null; location?: string | null }): Invitation {
  return {
    uid: `meeting-${m.id}${opts.eventId ? `-${opts.eventId}` : ''}@dexconnect`,
    title: opts.title || m.title || `Meeting ${formatMeetingId(m.id)}`,
    startAt: opts.startAt, endAt: opts.endAt,
    organizer: { name: opts.organizer?.displayName ?? 'Dexterity Connect', email: opts.organizer?.profile?.email ?? null, id: m.hostId },
    office: opts.office, meetingId: m.id,
    guestUrl: link?.url ?? null, passcode: link?.url ? link.passcode : null,
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

/** Turn the link on or off, renew it, copy it. `onChange` hears about the new state. */
export function GuestLinkControls({ meetingId, compact, onChange }: { meetingId: string; compact?: boolean; onChange?: (v: GuestLinkView) => void }) {
  const toast = useToast();
  const [v, setV] = useState<GuestLinkView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void window.dex.request('meet.guestLink', { id: meetingId }).then((x) => { if (alive) { setV(x); onChange?.(x); } }).catch((e: Error) => { if (alive) setProblem(e.message); });
    return () => { alive = false; };
  }, [meetingId]); // eslint-disable-line react-hooks/exhaustive-deps
  const change = (patch: { enabled?: boolean; regenerate?: boolean }) => void window.dex.request('meet.guestLink', { id: meetingId, ...patch })
    .then((x) => { setV(x); onChange?.(x); if (patch.regenerate) toast('New passcode: the old link no longer works'); })
    .catch((e: Error) => toast(e.message, true));
  if (problem) return <p className="faint guest-problem">{problem}</p>;
  if (!v) return <div className="tl-more"><span className="spinner" /></div>;
  return (
    <div className={`guest-link${compact ? ' compact' : ''}`}>
      <div className="guest-row">
        <div className="txt">
          <div>Guests can join from a browser</div>
          <div className="faint">No app needed. They wait in the lobby until a host lets them in.</div>
        </div>
        <Toggle label="Guests can join from a browser" checked={v.enabled} onChange={(on) => change({ enabled: on })} />
      </div>
      {v.problem && <p className="guest-problem"><Icon name="warning" size={14} />{v.problem}</p>}
      {v.enabled && v.passcode && (
        <table className="guest-cells">
          <tbody>
            <tr><th className="label">Passcode</th><td className="mono guest-pass">{v.passcode}</td>
              <td><button className="tb-link" onClick={() => { if (confirm('Give the guest link a new passcode? The link people have now stops working.')) change({ regenerate: true }); }}><Icon name="refresh" size={13} />Renew</button></td></tr>
            {v.url && (
              <tr><th className="label">Link</th><td className="mono guest-url" title={v.url}>{v.url}</td>
                <td><button className="tb-link" onClick={() => void navigator.clipboard.writeText(v.url!).then(() => toast('Guest link copied'))}><Glyph name="copy" size={13} />Copy</button></td></tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * Invitations for a meeting: the guest link (for hosts), "Copy invitation" and "Download .ics".
 * People who do not run the meeting get the invitation for colleagues (no guest link).
 */
export function MeetingInvite({ meeting, title, startAt, endAt, description, organizer, office, eventId, location, isHost, zone }: {
  meeting: MeetingInfo; title: string; startAt: number; endAt: number; description?: string | null; organizer: PublicUser | null; office: string;
  eventId?: string | null; location?: string | null; isHost: boolean; zone?: string | null;
}) {
  const toast = useToast();
  const [link, setLink] = useState<GuestLinkView | null>(null);
  const inv = invitationFor(meeting, link, { title, startAt, endAt, description, organizer, office, eventId, location });
  const when = whenText(startAt, endAt, zone);
  return (
    <section className="meet-invite-block" aria-label="Invitations">
      {isHost && <GuestLinkControls meetingId={meeting.id} onChange={setLink} />}
      <div className="invite-actions">
        <span className="mono faint">ID {formatMeetingId(meeting.id)}</span>
        <button className="btn sm" onClick={() => void navigator.clipboard.writeText(invitationText(inv, when)).then(() => toast(link?.url ? 'Invitation copied, with the guest link and passcode' : 'Invitation copied'))}>
          <Glyph name="copy" size={14} />Copy invitation
        </button>
        <button className="btn sm" onClick={() => { saveText(`${safeFile(inv.title)}.ics`, buildIcs(inv, when), 'text/calendar;charset=utf-8'); toast('Invitation saved as an .ics file'); }}>
          <Icon name="download" size={14} />Download .ics
        </button>
      </div>
    </section>
  );
}

/** In the Calendar's meeting dialog: a meeting held as a call gets its invitation tools. */
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
      <label>Invitations and guests</label>
      <MeetingInvite meeting={m} title={ev.title} startAt={ev.startAt} endAt={ev.endAt} description={ev.description} organizer={users.get(ev.organizerId) ?? null}
        office={office} eventId={ev.id} location={ev.location} isHost={m.hostId === meId || m.coHosts.includes(meId)} zone={ev.timeZone} />
    </div>
  );
}
