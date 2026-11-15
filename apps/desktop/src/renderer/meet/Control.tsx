// "Give control" on the Room sheet (meetings and a webinar's stage): the item in a person's menu,
// offered only to the person sharing a whole screen; "Ask for control" on the shared screen for
// people in the desktop app; the presenter's request and consent sheets and the amber banner with
// a big Stop while control is on; and the controller's surface over the shared picture, which
// says whose screen they control and has a Release button. The rules are in meet/control-store.ts, the
// hub's in apps/hub/src/meet-control.ts.
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { controllerRefusal, presenterRefusal } from '@dex/core';
import type { PublicUser, RoomInfo, RoomParticipant } from '@dex/core';
import { Avatar, Dialog, Icon, useToast } from '../ui.tsx';
import { controlCapsNow, setLayout, setMinimized, sharedSource, useCall } from '../rooms/engine.ts';
import { chatState } from '../chat/store.ts';
import { ControlBanner, ControlConsentSheet, ControlSurface } from '../help/control.tsx';
import { askControl, closeConsent, giveControl, offerControl, refuseAsk, releaseControl, sendInput, setControlNames, startMeetControl, stopControl, useMeetControl } from './control-store.ts';
import './control.css';

/** On a webinar's stage only its organiser, co-hosts and panelists (the backstage Space) may be given control. */
function stageStaff(room: RoomInfo, userId: string): boolean | null {
  if (room.meetingKind !== 'webinar') return null;
  if (userId === room.hostId || (room.coHosts ?? []).includes(userId)) return true;
  return (chatState().conversations.get(room.convId)?.members ?? []).includes(userId);
}

/** Whether this person could be given control in this Room (null), or why not. */
export function controlRefusalFor(room: RoomInfo, p: RoomParticipant | undefined): string | null {
  return controllerRefusal(p, p ? stageStaff(room, p.userId) : null);
}

/** In a person's menu, for the person sharing their screen: give them control, take it back, or why not. */
export function ControlMenuItems({ room, deviceId, meDevice, nameOf, onDone }: { room: RoomInfo; deviceId: string; meDevice: string; nameOf: (id: string) => string; onDone: () => void }) {
  const screen = useCall((s) => s.screen);
  const local = useMeetControl((s) => s.local);
  const me = room.participants.find((p) => p.deviceId === meDevice);
  const p = room.participants.find((x) => x.deviceId === deviceId);
  if (!screen || !p || deviceId === meDevice || room.purpose || !window.dex.assist) return null;
  // not offered to browser guests, phones, or webinar attendees invited to speak
  if (controlRefusalFor(room, p)) return null;
  const first = nameOf(p.userId).split(' ')[0];
  const c = room.control;
  if (c && c.controllerDevice === deviceId) {
    return <button role="menuitem" className="ctl-item on" onClick={() => { onDone(); void stopControl(); }}><Icon name="screen" size={16} />Take back control<span className="kbd">{first} HAS IT</span></button>;
  }
  // a Mac is view only; one window cannot be controlled (the Room may not have heard yet: this PC knows)
  const off = controlCapsNow().off ?? me?.controlOff;
  const why = off === 'mac' ? 'View only on a Mac: others see your screen but cannot use it.' : presenterRefusal(me);
  if (why) {
    return (
      <div className="ctl-note" role="note">
        <Icon name="info" size={15} />
        <span><b>Give control</b>{why}</span>
      </div>
    );
  }
  const busy = !!c || (!!local && local.controllerDevice !== deviceId);
  return (
    <button role="menuitem" className="ctl-item" disabled={busy} title={busy ? `${nameOf(c?.controllerId ?? local?.controllerId ?? '')} has control now: one person at a time` : `Let ${first} use your mouse and keyboard on the screen you share`}
      onClick={() => { onDone(); offerControl(deviceId, p.userId); }}>
      <Icon name="screen" size={16} />Give control…
    </button>
  );
}

/**
 * Over the shared screen: the controller's surface ("You are controlling Priya's screen", Release),
 * "Ask for control" for people in the desktop app, or a note when the screen is view only.
 */
export function ShareControl({ room, presenter, meDevice, nameOf }: { room: RoomInfo; presenter: RoomParticipant; meDevice: string; nameOf: (id: string) => string }) {
  const toast = useToast();
  const asked = useMeetControl((s) => s.asked === room.id);
  const c = room.control;
  const me = room.participants.find((p) => p.deviceId === meDevice);
  const name = nameOf(presenter.userId);
  if (room.purpose || presenter.deviceId === meDevice) return null;
  if (c && c.controllerDevice === meDevice && c.presenterDevice === presenter.deviceId) {
    return (
      <ControlSurface label={`Controlling ${name}'s screen`} tag={<span>You are controlling <b translate="no">{name}</b>'s screen</span>} action="Release"
        onAction={() => void releaseControl().catch((e: Error) => toast(e.message, true))} send={(m) => sendInput(presenter.deviceId, m)} />
    );
  }
  if (c) return <span className="ctl-flag mono" role="status">{nameOf(c.controllerId).toUpperCase()} IS CONTROLLING</span>;
  const why = presenterRefusal(presenter);
  if (why) return presenter.controlOff === 'mac' ? <span className="ctl-flag mono quiet" title={why}>VIEW ONLY · MAC</span> : null;
  // only people in the desktop app (not phones or browsers), and on a webinar's stage only its staff
  if (!window.dex.assist || controlRefusalFor(room, me)) return null;
  return (
    <button className="ctl-ask" disabled={asked} onClick={() => void askControl().then(() => toast(`Asked ${name.split(' ')[0]} for control`)).catch((e: Error) => toast(e.message, true))}
      title={`Ask ${name} to let you use their mouse and keyboard`}>
      <Icon name="screen" size={14} />{asked ? 'Asked for control…' : 'Ask for control'}
    </button>
  );
}

/** Mounted once on the Room sheet: the presenter's request and consent sheets, and the banner while control is on. */
export function ControlLayer({ room, users, meDevice, nameOf }: { room: RoomInfo; users: Map<string, PublicUser>; meDevice: string; nameOf: (id: string) => string }) {
  const ask = useMeetControl((s) => (s.ask?.roomId === room.id ? s.ask : null));
  const consent = useMeetControl((s) => (s.consent?.roomId === room.id ? s.consent : null));
  const local = useMeetControl((s) => (s.local?.roomId === room.id ? s.local : null));
  const toast = useToast();
  useEffect(() => { startMeetControl(); }, []);
  useEffect(() => { setControlNames(nameOf); });
  // given control: the shared screen comes forward, large
  const mine = room.control?.controllerDevice === meDevice ? room.control : null;
  const was = useRef(false);
  useEffect(() => {
    if (mine && !was.current) { setMinimized(false); setLayout('presentation'); toast(`${nameOf(mine.presenterId)} gave you control of their screen`); }
    was.current = !!mine;
  }, [mine]); // eslint-disable-line react-hooks/exhaustive-deps
  const caps = controlCapsNow();
  // control works on a whole screen, not one window
  const whole = useCall((s) => !!s.screen) && (sharedSource() ?? '').startsWith('screen:');
  return (
    <>
      {/* on the page itself, so it stays while the Room is folded into the title bar */}
      {local && createPortal(<ControlBanner who={nameOf(local.controllerId)} onStop={() => void stopControl().catch((e: Error) => toast(e.message, true))} />, document.body)}
      {ask && !consent && (
        <Dialog title={`${nameOf(ask.fromUser)} asks for control`} narrow onClose={refuseAsk}>
          <div className="cs-sheet ctl-request">
            <div className="ctl-request-who">
              <Avatar user={users.get(ask.fromUser) ?? { id: ask.fromUser, displayName: nameOf(ask.fromUser) }} />
              <div>
                <strong translate="no">{nameOf(ask.fromUser)}</strong>
                <span className="mono faint">ASKS TO USE YOUR MOUSE AND KEYBOARD</span>
              </div>
            </div>
            <p className="cs-lead">They would click and type on the screen you are sharing in this meeting. If you accept, you choose on the next sheet, and you can stop it at any moment.</p>
            <div className="dialog-actions">
              <button className="btn ghost" onClick={refuseAsk}>Refuse</button>
              <button className="btn primary" autoFocus onClick={() => offerControl(ask.fromDevice, ask.fromUser)}><Icon name="check" size={15} />Accept…</button>
            </div>
          </div>
        </Dialog>
      )}
      {consent && (
        <ControlConsentSheet who={nameOf(consent.userId)} onClose={closeConsent} onAllow={() => giveControl(consent.deviceId, consent.userId)}
          available={caps.controllable} reason={caps.off === 'mac' ? 'On a Mac your shared screen is view only: remote control needs Accessibility permission, which the app does not ask for.' : 'This PC cannot be controlled remotely (on Linux it needs xdotool on an X11 desktop).'}
          whole={whole} wholeNote="Share your whole screen first (not one window): control works on a whole screen."
          lead={`${nameOf(consent.userId)} can click, type and open things on the screen you are sharing, as if they sat at your PC. Everyone in the meeting sees what they do.`}
          ends="Control ends when you stop sharing, when either of you leaves, or when the meeting ends. One person at a time." />
      )}
    </>
  );
}
