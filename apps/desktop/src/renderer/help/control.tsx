// Remote control's screens, shared by support sessions (IT and the person they help) and meetings
// ("Give control", meet/Control.tsx): the consent sheet that lets someone use this PC's mouse and
// keyboard, the amber banner with a big Stop while they do, and the surface over the shared
// picture that turns the controller's pointer and keys into input events.
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { InputBatcher, KEYS, STOP_HOTKEY, domButton, fromPicture, wheelNotches } from '@dex/core/assist';
import type { InputEvent, MouseButton } from '@dex/core/assist';
import { Dialog, Icon, useToast } from '../ui.tsx';
import './help.css';

/**
 * "Let Ravi Kumar use your mouse and keyboard?": the second, separate consent. Nothing happens
 * until the button that says what will happen is pressed.
 */
export function ControlConsentSheet({ who, lead, ends, available, reason, whole, wholeNote, onAllow, onClose }: {
  who: string; lead: ReactNode; ends: string; available: boolean; reason: string | null; whole: boolean; wholeNote: string;
  onAllow: () => Promise<void>; onClose: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const allow = async () => {
    setBusy(true);
    try { await onAllow(); toast(`${who} can use your mouse and keyboard. Stop it any time with ${STOP_HOTKEY}.`); onClose(); } catch (e) { toast((e as Error).message, true); setBusy(false); }
  };
  return (
    <Dialog title={`Let ${who} use your mouse and keyboard?`} onClose={onClose} narrow>
      <div className="cs-sheet">
        <p className="cs-lead">{lead}</p>
        <ul className="cs-points">
          <li><b>Stop at any moment:</b> the big <b>Stop control</b> button on the bar at the top of your screen, or press <kbd className="mono">{STOP_HOTKEY}</kbd>, even while they are typing.</li>
          <li>System keys such as Ctrl+Alt+Del and Win+L are never passed on.</li>
          <li>{ends}</li>
        </ul>
        {!available && <p className="hm-warn"><Icon name="info" size={15} />{reason ?? 'This PC cannot be controlled remotely.'}</p>}
        {available && !whole && <p className="hm-warn"><Icon name="info" size={15} />{wholeNote}</p>}
        <div className="dialog-actions">
          <button className="btn ghost" onClick={onClose}>Don't allow</button>
          <button className="btn primary amber" disabled={busy || !available || !whole} onClick={() => void allow()}>{busy ? <span className="spinner" /> : <Icon name="check" size={15} />}Allow control</button>
        </div>
      </div>
    </Dialog>
  );
}

/** Across the top of the controlled PC's app while someone uses its mouse and keyboard. */
export function ControlBanner({ who, onStop }: { who: string; onStop: () => void }) {
  return (
    <div className="sup-banner" role="alert">
      <span className="sup-banner-pip" aria-hidden="true" />
      <span><b>{who}</b> is using your mouse and keyboard</span>
      <button className="sup-stop" onClick={onStop}>Stop control</button>
      <span className="mono sup-banner-keys">{STOP_HOTKEY}</span>
    </div>
  );
}

/**
 * The controller's hands on the other PC: pointer and keys over the shared picture (the <video>
 * beside this surface in its parent), sent as input events with positions relative to the picture,
 * in batches with moves coalesced. Keys and buttons held here are let go when the surface loses
 * focus or goes away, so nothing stays pressed on the other side.
 */
export function ControlSurface({ label, tag, action, onAction, send }: {
  label: string; tag: ReactNode; action: string; onAction: () => void; send: (msg: { k: 'in'; e: InputEvent[] }) => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const batch = useRef(new InputBatcher());
  const held = useRef({ keys: new Set<string>(), buttons: new Set<MouseButton>() });
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    surface.current?.focus();
    const t = setInterval(() => { const m = batch.current.take(); if (m) sendRef.current(m); }, 16);
    return () => { clearInterval(t); letGo(); const m = batch.current.take(); if (m) sendRef.current(m); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const at = (e: { clientX: number; clientY: number }) => {
    const v = surface.current?.parentElement?.querySelector('video');
    if (!v) return null;
    const r = v.getBoundingClientRect();
    return fromPicture(e.clientX, e.clientY, { x: r.left, y: r.top, width: r.width, height: r.height }, v.videoWidth, v.videoHeight);
  };
  const push = (ev: InputEvent) => batch.current.push(ev);
  const letGo = () => {
    for (const code of held.current.keys) push({ t: 'key', code, down: false });
    for (const b of held.current.buttons) push({ t: 'button', b, down: false, x: -1, y: -1 });
    held.current.keys.clear();
    held.current.buttons.clear();
  };
  return (
    <div ref={surface} className="sup-control" tabIndex={0} aria-label={label}
      onPointerMove={(e) => { const p = at(e); if (p) push({ t: 'move', ...p }); }}
      onPointerDown={(e) => {
        surface.current?.focus();
        const b = domButton(e.button); const p = at(e);
        if (!b || !p) return;
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        held.current.buttons.add(b);
        push({ t: 'button', b, down: true, ...p });
      }}
      onPointerUp={(e) => {
        const b = domButton(e.button);
        if (!b || !held.current.buttons.has(b)) return;
        held.current.buttons.delete(b);
        const p = at(e) ?? { x: -1, y: -1 };
        push({ t: 'button', b, down: false, ...p });
      }}
      onWheel={(e) => { const p = at(e); if (!p) return; const dy = wheelNotches(e.deltaY, e.deltaMode); const dx = wheelNotches(e.deltaX, e.deltaMode); if (dx || dy) push({ t: 'wheel', dx, dy, ...p }); }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => { if (!(e.code in KEYS)) return; e.preventDefault(); e.stopPropagation(); held.current.keys.add(e.code); push({ t: 'key', code: e.code, down: true }); }}
      onKeyUp={(e) => { if (!(e.code in KEYS)) return; e.preventDefault(); e.stopPropagation(); if (!held.current.keys.delete(e.code)) return; push({ t: 'key', code: e.code, down: false }); }}
      onBlur={letGo}>
      <span className="sup-control-tag mono">{tag}<button className="btn sm" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onAction(); }}>{action}</button></span>
    </div>
  );
}
