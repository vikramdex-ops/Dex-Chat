// M2 additions to the Room sheet, kept out of Stage.tsx: names for guests who joined from a
// browser, the host's guest link and invitations, breakout rooms, and the sound menu with strong
// noise suppression.
import { useEffect, useMemo, useState } from 'react';
import type { MeetingInfo, PublicUser, RoomInfo } from '@dex/core';
import { Popover, Toggle, useToast } from '../ui.tsx';
import { setNoiseSuppression } from '../rooms/engine.ts';
import { noiseAvailable, useNoise } from '../rooms/noise.ts';
import { GuestLinkControls, MeetingInvite } from './GuestLink.tsx';
import { BreakoutHostBox, BreakoutSetup } from './Breakouts.tsx';
import { Glyph } from '../rooms/parts.tsx';

const emptyProfile = { departmentId: null, managerId: null, phone: null, extension: null, location: null, email: null, employeeId: null, joinedOn: null, birthday: null, fields: {} };

/** The office's people plus the Room's browser guests (by name, as guests), for tiles and lists. */
export function useRoomUsers(users: Map<string, PublicUser>, room: RoomInfo): Map<string, PublicUser> {
  const visitors = room.visitors;
  return useMemo(() => {
    if (!visitors?.length) return users;
    const m = new Map(users);
    for (const v of visitors) {
      m.set(v.userId, { id: v.userId, account: '', displayName: v.name, role: 'guest', title: 'Guest from a browser', statusText: null, availability: 'available', createdAt: 0, profile: emptyProfile, availabilityUntil: null, ooo: null });
    }
    return m;
  }, [users, visitors]);
}

/** In the People tab's host controls: guests from outside (the link and invitations) and breakout rooms. */
export function HostExtras({ room, users, meDevice }: { room: RoomInfo; users: Map<string, PublicUser>; meDevice: string }) {
  const [setup, setSetup] = useState(false);
  const [meeting, setMeeting] = useState<MeetingInfo | null>(null);
  const [office, setOffice] = useState('Dexterity Connect');
  const meetingId = room.meetingId;
  useEffect(() => {
    if (!meetingId) return;
    let alive = true;
    void window.dex.request('meet.get', { id: meetingId }).then((m) => { if (alive) setMeeting(m); }).catch(() => {});
    void window.dex.request('remote.info').then((r) => { if (alive) setOffice(r.name); }).catch(() => {});
    return () => { alive = false; };
  }, [meetingId]);
  const others = room.participants.filter((p) => p.deviceId !== meDevice).length;
  const isMeeting = !!meetingId && room.meetingKind !== undefined;
  return (
    <>
      {room.breakouts ? <BreakoutHostBox room={room} />
        : isMeeting && !room.parentId && (
          <button className="btn sm bo-open" disabled={others < 2} title={others < 2 ? 'Breakout rooms need at least two other people in the Room' : 'Split the meeting into smaller rooms for a while'} onClick={() => setSetup(true)}>
            <Glyph name="gallery" size={15} />Breakout rooms…
          </button>
        )}
      {meetingId && (
        <details className="room-host-settings guest-settings">
          <summary className="label">Guests from outside</summary>
          {meeting
            ? <MeetingInvite meeting={meeting} title={room.title || meeting.title} startAt={room.startedAt} endAt={room.startedAt + 3600_000} organizer={users.get(meeting.hostId) ?? null}
                office={office} isHost location={null} />
            : <GuestLinkControls meetingId={meetingId} compact />}
        </details>
      )}
      {setup && <BreakoutSetup room={room} users={users} meDevice={meDevice} onClose={() => setSetup(false)} />}
    </>
  );
}

/** The Room's sound menu: strong noise suppression (RNNoise on this PC), on by default. */
export function SoundMenu({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
  const toast = useToast();
  const noise = useNoise();
  const [here, setHere] = useState(true);
  useEffect(() => { void noiseAvailable().then(setHere); }, []);
  if (!here) {
    return (
      <Popover anchor={anchor} onClose={onClose} className="menu room-sound-menu" align="start">
        <div className="menu-label label">Sound · on this device</div>
        <p className="faint" style={{ margin: '0 12px', fontSize: 12.5 }}>Strong noise suppression runs in the desktop app. Here, the browser's own filters clean your mic.</p>
      </Popover>
    );
  }
  return (
    <Popover anchor={anchor} onClose={onClose} className="menu room-sound-menu" align="start">
      <div className="menu-label label">Sound · on this PC</div>
      <div className="sound-row">
        <div className="txt">
          <div>Strong noise suppression</div>
          <div className="faint">Removes fans, keyboards and site noise from your mic before it is sent. Your voice stays.</div>
        </div>
        <Toggle label="Strong noise suppression" checked={noise.on} onChange={(on) => void setNoiseSuppression(on).catch((e: Error) => toast(e.message, true))} />
      </div>
      <div className="mono faint sound-state">{noise.on ? (noise.active ? 'RNNOISE · RUNNING' : 'RNNOISE · STARTS WITH YOUR MIC') : 'OFF · BROWSER FILTERS ONLY'}</div>
      {noise.problem && <p className="field-error">{noise.problem}</p>}
    </Popover>
  );
}
