// Elevated control (docs/HELP-DESK.md, "Elevated control"): office PCs with the IT Support service,
// listed on the Help desk for IT staff when the office allows it, and the viewer IT works in: the
// PC's whole console as pictures from its service (the person's desktop, administrator windows,
// UAC prompts, the lock and sign-in screens), the same mouse-and-keyboard surface as a support
// session, and Ctrl+Alt+Del. The person at the PC sees a banner from the service and can stop it.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { ticketRef } from '@dex/core';
import type { ElevatedSession, MachineFrame, MachineInfo } from '@dex/core';
import { Icon, relativeTime, useToast } from '../ui.tsx';
import { usePolicy } from '../policy.ts';
import { ControlSurface } from './control.tsx';
import { ticketById, useHelp } from './store.ts';

// ------------------------------------------------------------------ the session IT is in
let current: ElevatedSession | null = null;
const subs = new Set<() => void>();
const setCurrent = (s: ElevatedSession | null) => { current = s; for (const f of subs) f(); };
const useElevated = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => current);
let listening = false;
const frameSubs = new Set<(f: MachineFrame) => void>();

function listen(): void {
  if (listening) return;
  listening = true;
  window.dex.onHubEvent((name, d) => {
    if (name === 'machine.frame') { for (const f of frameSubs) f(d as MachineFrame); return; }
    if (name === 'machine.session') {
      const s = d as ElevatedSession;
      if (current?.id === s.id) setCurrent(s.endedAt ? null : s);
      if (s.endedAt && s.why) window.dispatchEvent(new CustomEvent('dex-elevated-ended', { detail: s.why }));
    }
  });
}

export async function connectPc(machineId: string, privacy = false): Promise<void> {
  listen();
  setCurrent(await window.dex.request('machine.connect', { machineId, privacy }));
}

// ------------------------------------------------------------------ the Help desk's list of PCs
export function OfficePcs() {
  const toast = useToast();
  const on = usePolicy().assistElevated === true;
  const [pcs, setPcs] = useState<MachineInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [privacy, setPrivacy] = useState(false);
  const privacyOn = usePolicy().assistPrivacy === true;
  const live = useElevated();
  useEffect(() => {
    if (!on) return;
    let alive = true;
    void window.dex.request('machine.list').then((l) => { if (alive) setPcs(l); }).catch(() => {});
    const off = window.dex.onHubEvent((name, d) => { if (name === 'machine.list') setPcs(d as MachineInfo[]); });
    return () => { alive = false; off(); };
  }, [on]);
  if (!on) return null;
  const connect = (m: MachineInfo) => {
    // two PCs with one name: one may be pretending (names are what PCs say about themselves)
    if (m.sameName && !window.confirm(`Another PC is also called ${m.hostname}. This one is ID ${m.id.slice(1, 9).toUpperCase()}, first seen ${new Date(m.firstSeen).toLocaleDateString()}. Connect only if that is the PC you expect: never type a password into a PC you are not sure of.`)) return;
    setBusy(m.id);
    void connectPc(m.id, privacy && privacyOn).catch((e: Error) => toast(e.message, true)).finally(() => setBusy(null));
  };
  return (
    <section className="hd-pcs" aria-label="Office PCs">
      <div className="label hd-sec">Office PCs with the IT Support service · {pcs.filter((p) => p.online).length} online</div>
      {privacyOn && (
        <label className="hd-privacy" title="Their screen shows 'IT is working on this PC' instead of what you do. They can still stop it, and it is recorded.">
          <input type="checkbox" checked={privacy} onChange={(e) => setPrivacy(e.target.checked)} /> Connect with the privacy screen
        </label>
      )}
      {!pcs.length && <p className="faint">No PC has the IT Support service yet. An administrator installs it from Control room ▸ Policies ▸ Remote support, on each PC.</p>}
      <table className="hd-table"><tbody>
        {pcs.map((m) => (
          <tr key={m.id} className={m.online ? '' : 'faint'}>
            <td className="mono" translate="no" title={`ID ${m.id.slice(1, 9).toUpperCase()} · first seen ${new Date(m.firstSeen).toLocaleDateString()}`}>{m.hostname} <span className="faint">{m.id.slice(1, 9).toUpperCase()}</span>{m.sameName && <span className="role-tag" title="Another PC has the same name: check the ID before connecting">SAME NAME</span>}{!m.sameName && m.nameReused && <span className="faint" title="A PC removed from the office had this name"> · name used before</span>}</td>
            <td>{!m.online ? `Offline · seen ${relativeTime(m.lastSeen)}` : m.consoleUser ? `${m.consoleUser}${m.locked ? ' · locked' : ''}` : 'Sign-in screen'}</td>
            <td style={{ textAlign: 'right' }}>
              {m.session ? <span className="mono">IN USE BY IT</span>
                : <button className="btn sm" disabled={!m.online || !!busy || !!live} title="Connect with administrator rights. The person at the PC sees a banner and can stop it." onClick={() => connect(m)}><Icon name="monitor" size={14} />Connect</button>}
            </td>
          </tr>
        ))}
      </tbody></table>
    </section>
  );
}

// ------------------------------------------------------------------ the viewer
export function ElevatedHost() {
  const toast = useToast();
  useEffect(() => {
    listen();
    // the window reloaded (or crashed) mid-session: pick the viewer up again, so End is always there
    void window.dex.request('machine.mine').then((l) => { if (l.length && !current) setCurrent(l[0]); }).catch(() => {});
    const ended = (e: Event) => toast(`Elevated session ended: ${(e as CustomEvent).detail as string}`);
    window.addEventListener('dex-elevated-ended', ended);
    return () => window.removeEventListener('dex-elevated-ended', ended);
  }, [toast]);
  const s = useElevated();
  return s ? <Viewer s={s} /> : null;
}

function Viewer({ s }: { s: ElevatedSession }) {
  const toast = useToast();
  const img = useRef<HTMLImageElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [controlling, setControlling] = useState(true);
  const ticket = useHelp(() => ticketById(s.ticketId));
  useEffect(() => {
    // every picture is acknowledged as it arrives (the PC sends at most two ahead), whether it is
    // drawn, fails to decode, or is replaced by the next one before it is drawn; each picture's
    // URL is let go when the next one takes its place
    let shown: string | null = null;
    const on = (f: MachineFrame) => {
      if (f.s !== s.id) return;
      void window.dex.request('machine.ack', { s: s.id, seq: f.seq }).catch(() => {});
      const el = img.current;
      if (!el) return;
      const bytes = Uint8Array.from(atob(f.d), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
      el.src = url;
      if (shown) URL.revokeObjectURL(shown);
      shown = url;
      setSize((cur) => (cur?.w === f.w && cur.h === f.h ? cur : { w: f.w, h: f.h }));
    };
    frameSubs.add(on);
    return () => { frameSubs.delete(on); if (shown) URL.revokeObjectURL(shown); };
  }, [s.id]);
  const run = (p: Promise<unknown>, ok?: string) => void p.then(() => { if (ok) toast(ok); }).catch((e: Error) => toast(e.message, true));
  const end = () => run(window.dex.request('machine.end', { s: s.id }).then(() => setCurrent(null)));
  return createPortal(
    <div className="sup-stage elevated" role="dialog" aria-label={`Elevated control of ${s.hostname}`}>
      <section className={`sup-field${controlling ? ' controlling' : ''}`} aria-label={`${s.hostname}'s screen`}>
        <figure className="sup-screen">
          <img ref={img} className="sup-frame" alt={`${s.hostname}'s screen`} />
          {!size && <div className="sup-empty"><span className="spinner" /><p>{s.pausedAt ? `${s.hostname} is restarting or offline. The session waits for it.` : 'The picture is on its way…'}</p></div>}
          {controlling && size && !s.pausedAt && (
            <ControlSurface label={`Using ${s.hostname}`} tag={`YOU ARE USING ${s.hostname.toUpperCase()} WITH ADMINISTRATOR RIGHTS`} action="Let go" onAction={() => setControlling(false)}
              send={(msg) => void window.dex.request('machine.input', { s: s.id, msg }).catch(() => {})} />
          )}
          <figcaption className="room-cap"><b>PC</b><span translate="no">{s.hostname}{size ? ` · ${size.w}×${size.h}` : ''}{s.pausedAt ? ' · WAITING FOR THE PC' : ''}</span></figcaption>
        </figure>
      </section>
      <aside className="sup-side">
        <div className="sup-block">
          <span className="label">Elevated control</span>
          <h2 translate="no">{s.hostname}</h2>
          <p className="faint sup-reason">Administrator rights: UAC prompts, administrator windows and the sign-in screen work. The person at the PC sees a banner saying you are connected and can stop it.</p>
          <dl className="hd-facts">
            <div><dt>Ref</dt><dd className="mono">{ticket ? ticketRef(ticket.number) : '—'}</dd></div>
            <div><dt>Since</dt><dd className="mono">{new Date(s.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</dd></div>
          </dl>
        </div>
        <div className="sup-tools">
          <button className={controlling ? 'on' : ''} aria-pressed={controlling} onClick={() => setControlling(!controlling)}><Icon name="monitor" size={17} /><span>{controlling ? 'Let go' : 'Use mouse and keyboard'}</span></button>
          {usePolicy().assistPrivacy === true && (
            <button className={s.privacy ? 'on' : ''} aria-pressed={s.privacy} title={s.privacy ? 'They see "IT is working on this PC", not what you do' : 'Cover their screen while you work'}
              onClick={() => run(window.dex.request('machine.privacy', { s: s.id, on: !s.privacy }).then((x) => setCurrent(x)))}>
              <Icon name="lock" size={17} /><span>{s.privacy ? 'Privacy on' : 'Privacy screen'}</span>
            </button>
          )}
          <button onClick={() => run(window.dex.request('machine.sas', { s: s.id }), 'Sent Ctrl+Alt+Del')} disabled={!!s.pausedAt} title="The real Ctrl+Alt+Del (Windows security screen)"><Icon name="lock" size={17} /><span>Ctrl+Alt+Del</span></button>
          <button className="end" onClick={end}><Icon name="phone-off" size={17} /><span>End</span></button>
        </div>
      </aside>
    </div>,
    document.body,
  );
}
