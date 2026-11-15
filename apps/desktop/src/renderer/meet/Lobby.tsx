// Waiting to be let into a meeting: your own preview on the left, the meeting's title block on the
// right (title, ID, who runs it, what happens next), on the same drafting sheet as the Room.
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { formatMeetingId } from '@dex/core';
import type { PublicUser } from '@dex/core';
import { Avatar, Icon } from '../ui.tsx';
import { leaveLobby, toggleCamera, toggleMute, useCall } from '../rooms/engine.ts';
import { Clock, Video } from '../rooms/parts.tsx';
import { usePolicy } from '../policy.ts';

export function LobbySheet({ users, meId }: { users: Map<string, PublicUser>; meId: string }) {
  const lobby = useCall((s) => s.lobby);
  const local = useCall((s) => s.local);
  const muted = useCall((s) => s.muted);
  const camera = useCall((s) => s.camera);
  const policy = usePolicy();
  // how long you have waited: the sheet opens when the wait starts
  const [since] = useState(() => Date.now());
  if (!lobby) return null;
  const { meeting, reason } = lobby;
  const host = users.get(meeting.hostId)?.displayName ?? 'the host';
  const me = users.get(meId);
  const status = reason === 'host' ? `Waiting for ${host} to start the meeting` : `${host.split(' ')[0]} or a co-host will let you in`;
  const kind = meeting.kind === 'personal' ? 'PERSONAL ROOM' : meeting.kind === 'event' ? 'SCHEDULED' : meeting.kind === 'instant' ? 'INSTANT' : 'ROOM';
  return createPortal(
    <div className="room-stage lobby-stage" role="dialog" aria-label={`Lobby: ${meeting.title || 'meeting'}`}>
      <div className="lobby-sheet">
        <div className="lobby-preview">
          <div className={`room-tile${camera ? ' has-video' : ''}`}>
            <div className="room-face">
              {camera && local?.getVideoTracks().length ? <Video stream={local} muted mirror /> : <Avatar user={{ id: meId, displayName: me?.displayName ?? 'You' }} size="lg" />}
            </div>
            <span className="room-cap"><b>A1</b><span>YOU · PREVIEW</span>{muted && <Icon name="mic-off" size={12} />}</span>
          </div>
          <div className="tb-controls lobby-controls">
            <button className={muted ? 'off' : 'on'} aria-pressed={!muted} onClick={toggleMute} title={muted ? 'Turn your mic on' : 'Turn your mic off'}>
              <Icon name={muted ? 'mic-off' : 'mic'} size={18} /><span>{muted ? 'Mic off' : 'Mic on'}</span>
            </button>
            <button className={camera ? 'on' : 'off'} aria-pressed={camera} onClick={() => void toggleCamera()} title={camera ? 'Turn your camera off' : 'Turn your camera on'}>
              <Icon name={camera ? 'video' : 'video-off'} size={18} /><span>{camera ? 'Camera on' : 'Camera off'}</span>
            </button>
          </div>
        </div>
        <div className="lobby-block">
          <div className="tb-name">
            <span className="label">Lobby</span>
            <h2 title={meeting.title}>{meeting.title || 'Meeting'}</h2>
            <span className="tb-kind mono">{kind}</span>
          </div>
          <dl className="lobby-facts">
            <div><dt className="label">Meeting ID</dt><dd className="mono">{formatMeetingId(meeting.id)}</dd></div>
            <div><dt className="label">Host</dt><dd>{host}</dd></div>
            <div><dt className="label">In it now</dt><dd className="mono">{meeting.live ? meeting.live.participants : '—'}</dd></div>
          </dl>
          <div className="lobby-status" role="status">
            <span className="open-seat-line" aria-hidden="true" />
            <strong>{status}</strong>
            <span className="faint">{reason === 'host' ? 'You come in as soon as the meeting starts.' : 'Stay on this sheet; you are let in without doing anything.'}</span>
            {policy.cameraConsent && <span className="faint">Your office starts meetings with cameras off.</span>}
          </div>
          <div className="tb-foot">
            <span className="mono faint lobby-since" title="How long you have been waiting">WAITING<Clock since={since} className="lobby-clock" /></span>
            <button className="room-leave" onClick={() => leaveLobby()}>Leave the lobby</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
