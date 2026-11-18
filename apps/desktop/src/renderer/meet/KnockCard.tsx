// Nib's card for someone waiting in a lobby (docs/MEETINGS.md, "Who is waiting"): who (a guest's
// name marked as typed by them, not verified), which meeting, how long they have waited, and Admit
// and Decline that work from the card itself, on a PC or a phone. Once answered, by you or anyone
// else, or when they give up, the card says so in place: no stale buttons. Admitted before the
// room was open, it offers Join now (they wait there for you).
import { useEffect, useState } from 'react';
import { formatMeetingId } from '@dex/core';
import type { KnockView, PublicUser } from '@dex/core';
import { Avatar, Icon, useToast } from '../ui.tsx';
import { clock, joinMeeting, useCall } from '../rooms/engine.ts';
import { answerKnock, waitedText } from './knocks.ts';
import './knocks.css';

type FrameProps = { caption: string; title: string; no?: string; children: React.ReactNode; className?: string };

export function KnockCard({ knock: k, fallback, meId, users, onChange, frame: Frame }: {
  knock: KnockView | null; fallback: string; meId: string; users: Map<string, PublicUser>;
  onChange: (k: KnockView) => void; frame: (p: FrameProps) => React.ReactNode;
}) {
  const toast = useToast();
  const inThisRoom = useCall((s) => !!k && s.room?.meetingId === k.meetingId);
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => { if (k?.state !== 'waiting') return; const t = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(t); }, [k?.state]);
  if (!k) {
    return (
      <Frame caption="LOBBY" title="Request to join" className="k-knock">
        <p className="nib-line faint" translate="no">{fallback}</p>
        <p className="nib-line">This request to join is no longer open.</p>
      </Frame>
    );
  }
  const mine = k.by === meId;
  const by = k.by && !mine ? users.get(k.by)?.displayName ?? 'A host' : null;
  const at = clock(k.decidedAt ?? k.at);
  const where = k.kind === 'personal' ? 'Your personal room' : k.title;
  const answer = (allow: boolean) => {
    setBusy(true);
    void answerKnock(k.id, allow)
      .then((next) => { if (next) onChange(next); toast(allow ? (k.live ? `${k.name} is coming in` : `${k.name} is let in: the room opens for them and waits for you`) : `${k.name} was turned away`); })
      .catch((e: Error) => toast(e.message, true))
      .finally(() => setBusy(false));
  };
  const join = () => void joinMeeting(k.meetingId, false).catch((e: Error) => toast(e.message, true));
  return (
    <Frame caption="LOBBY" title={where} no={formatMeetingId(k.meetingId)} className={`k-knock ${k.state}`}>
      <div className="knock-card-who">
        <Avatar user={{ id: k.userId || k.id, displayName: k.name }} size="sm" />
        <span className="knock-who">
          <b translate="no">{k.name}</b>
          {k.guest && <span className="knock-tag" title="Typed by the guest in their browser: nobody has checked it">GUEST · NAME NOT VERIFIED</span>}
        </span>
      </div>
      {k.state === 'waiting' && (
        <>
          <p className="nib-line mono knock-since" role="status">{`WAITING SINCE ${clock(k.at)} · ${waitedText(k.at).toUpperCase()}`}</p>
          {!k.hostIn && <p className="nib-line">{k.live ? 'No host is in the room yet. Admit lets them in; they wait there for you.' : 'The room is not open. Admit opens it for them; they wait there for you.'}</p>}
          <div className="nib-card-actions">
            <button className="btn ghost sm" disabled={busy} onClick={() => answer(false)} aria-label={`Decline ${k.name}`}>Decline</button>
            <button className="btn primary sm" disabled={busy} onClick={() => answer(true)} aria-label={`Admit ${k.name}`}><Icon name="check" size={14} />Admit</button>
          </div>
        </>
      )}
      {k.state === 'admitted' && (
        <>
          <p className="nib-line"><Icon name="check" size={14} /><span>{mine ? `You let them in at ${at}.` : by ? `${by} let them in at ${at}.` : `Came in at ${at}.`}</span></p>
          {k.joinedAt && <p className="nib-line faint">{`In the meeting since ${clock(k.joinedAt)}.`}</p>}
          {k.live && !k.hostIn && !inThisRoom && (
            <div className="nib-card-actions"><span className="faint">{k.joinedAt ? 'They are waiting for you in the room.' : ''}</span><button className="btn primary sm" onClick={join}><Icon name="video" size={14} />Join now</button></div>
          )}
        </>
      )}
      {k.state === 'declined' && <p className="nib-line">{mine ? `You turned them away at ${at}.` : `${by ?? 'A host'} turned them away at ${at}.`}</p>}
      {k.state === 'left' && <p className="nib-line faint">{`Left the lobby at ${at}, before anyone answered.`}</p>}
      {k.state === 'ended' && <p className="nib-line faint">The meeting ended before anyone answered.</p>}
    </Frame>
  );
}
