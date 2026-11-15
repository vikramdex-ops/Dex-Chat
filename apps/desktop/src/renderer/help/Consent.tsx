// The requester's own sheets in a support session. Each asks one thing in plain words and does
// nothing until they press the button that says what will happen: sharing a screen or a window,
// letting the technician use the mouse and keyboard, sending diagnostics (shown in full first),
// and saying how it went when the session ends.
import { useEffect, useState } from 'react';
import { ticketRef } from '@dex/core';
import type { HelpTicket } from '@dex/core';
import type { DiagnosticsReport } from '../../shared/bridge.ts';
import { Dialog, Icon, useToast } from '../ui.tsx';
import { allowControl, recentErrors, sendDiagnostics, shareScreen, useHelp } from './store.ts';
import { ControlConsentSheet } from './control.tsx';

/** "Share your screen with Ravi Kumar?": a whole screen or one window, chosen from pictures of them. */
export function ScreenConsent({ tech, onClose }: { tech: string; onClose: () => void }) {
  const toast = useToast();
  const [sources, setSources] = useState<Array<{ id: string; name: string; thumbnail: string }> | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void window.dex.listScreens?.().then((s) => { setSources(s); setPick((p) => p ?? s.find((x) => x.id.startsWith('screen:'))?.id ?? null); }).catch(() => setSources([]));
  }, []);
  const screens = (sources ?? []).filter((s) => s.id.startsWith('screen:'));
  const windows = (sources ?? []).filter((s) => !s.id.startsWith('screen:'));
  const share = async () => {
    if (!pick) return;
    setBusy(true);
    try { await shareScreen(pick, pick.startsWith('screen:') ? 'screen' : 'window'); onClose(); } catch (e) { toast((e as Error).message, true); setBusy(false); }
  };
  const option = (s: { id: string; name: string; thumbnail: string }, i: number) => (
    <button key={s.id} type="button" role="radio" aria-checked={pick === s.id} className={`cs-source${pick === s.id ? ' on' : ''}`} onClick={() => setPick(s.id)}>
      <img src={s.thumbnail} alt="" /><span><b className="mono">{String(i + 1).padStart(2, '0')}</b><span translate="no">{s.name}</span></span>
    </button>
  );
  return (
    <Dialog title={`Share your screen with ${tech}?`} onClose={onClose}>
      <div className="cs-sheet">
        <p className="cs-lead">{tech} sees what you choose until you stop. Nothing is recorded. While it is shared, an amber frame and a bar with <b>Stop sharing</b> stay on your screen.</p>
        {!window.dex.listScreens && <p className="hm-warn"><Icon name="info" size={15} />Sharing a screen works from the desktop app. Talk {tech} through it on the call instead.</p>}
        {sources === null && window.dex.listScreens && <div className="tl-more"><span className="spinner" /></div>}
        {screens.length > 0 && <><div className="label">The whole screen</div><div className="cs-grid" role="radiogroup" aria-label="Screens">{screens.map(option)}</div></>}
        {windows.length > 0 && <><div className="label">One window</div><div className="cs-grid" role="radiogroup" aria-label="Windows">{windows.map((s, i) => option(s, i + screens.length))}</div></>}
        {pick && !pick.startsWith('screen:') && <p className="faint cs-note">With one window, {tech} can see it but cannot be given the mouse and keyboard.</p>}
        <div className="dialog-actions">
          <button className="btn ghost" onClick={onClose}>Not now</button>
          <button className="btn primary" disabled={!pick || busy} onClick={() => void share()}>{busy ? <span className="spinner" /> : <Icon name="screen" size={15} />}{pick && !pick.startsWith('screen:') ? 'Share this window' : 'Share this screen'}</button>
        </div>
      </div>
    </Dialog>
  );
}

/** "Let Ravi Kumar use your mouse and keyboard": the second, separate consent. */
export function ControlConsent({ tech, onClose }: { tech: string; onClose: () => void }) {
  const session = useHelp((s) => s.session);
  const control = useHelp((s) => s.control);
  const whole = !!session?.consent.screen && session.consent.scope === 'screen';
  return (
    <ControlConsentSheet who={tech} onClose={onClose} onAllow={allowControl} available={control.available} reason={control.reason} whole={whole}
      lead={`${tech} can click, type and open things on your shared screen as if they sat at your PC. You see everything they do.`}
      ends="Control ends when the screen stops being shared or the session ends."
      wholeNote="Share your whole screen first: control works on a whole screen." />
  );
}

const mb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${n} MB`);

/** Diagnostics: gathered on this PC, shown in full, sent only when the requester says so. */
export function DiagnosticsSheet({ ticket, onClose }: { ticket: HelpTicket; onClose: () => void }) {
  const toast = useToast();
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [raw, setRaw] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!window.dex.assist) return;
    void window.dex.assist.diagnostics(recentErrors()).then(setReport).catch((e: Error) => toast(e.message, true));
  }, [toast]);
  const send = async () => {
    if (!report) return;
    setBusy(true);
    try { await sendDiagnostics(ticket.id, ticketRef(ticket.number), report); toast(`Diagnostics added to ${ticketRef(ticket.number)}`); onClose(); } catch (e) { toast((e as Error).message, true); setBusy(false); }
  };
  const r = report;
  return (
    <Dialog title="Send diagnostics to IT" onClose={onClose}>
      <div className="cs-sheet dg">
        <p className="cs-lead">This is everything that will be added to {ticketRef(ticket.number)}. Messages, files you shared, passwords and keys are never part of it.</p>
        {!window.dex.assist && <p className="hm-warn"><Icon name="info" size={15} />Diagnostics are gathered by the desktop app.</p>}
        {window.dex.assist && !r && <div className="tl-more"><span className="spinner" /><span className="faint">Checking this PC and its connection…</span></div>}
        {r && !raw && (
          <div className="dg-grid">
            <section><div className="label">App</div><dl>
              <div><dt>Version</dt><dd className="mono">{r.app.version} · {r.app.channel.toUpperCase()}</dd></div>
              <div><dt>Built on</dt><dd className="mono">ELECTRON {r.app.electron} · CHROME {r.app.chrome.split('.')[0]}</dd></div>
            </dl></section>
            <section><div className="label">This PC</div><dl>
              <div><dt>System</dt><dd>{r.os.name} {r.os.release} <span className="mono faint">{r.os.arch}</span></dd></div>
              <div><dt>Processor</dt><dd>{r.cpu.model} <span className="mono faint">· {r.cpu.cores} CORES</span></dd></div>
              <div><dt>Memory</dt><dd className="mono">{mb(r.memory.freeMb)} FREE OF {mb(r.memory.totalMb)}</dd></div>
              <div><dt>Disk</dt><dd className="mono">{r.disk.freeGb === null ? '—' : `${r.disk.freeGb} GB FREE OF ${r.disk.totalGb} GB`}</dd></div>
            </dl></section>
            <section><div className="label">Displays · {r.displays.length}</div><dl>
              {r.displays.map((d, i) => <div key={d.id}><dt>{String(i + 1).padStart(2, '0')}{d.primary ? ' · main' : ''}</dt><dd className="mono">{d.width}×{d.height} @ {Math.round(d.scale * 100)}%</dd></div>)}
            </dl></section>
            <section><div className="label">Network</div><dl>
              <div><dt>Route</dt><dd>{r.network.route}{r.network.gateway ? <span className="mono faint"> · {r.network.gateway}</span> : null}</dd></div>
              <div><dt>Hub</dt><dd className={r.network.hub.reachable ? '' : 'dg-bad'}>{r.network.hub.reachable ? `Answers in ${r.network.hub.medianMs} ms` : 'Does not answer'}<span className="mono faint"> {r.network.hub.address ?? ''}</span></dd></div>
              {r.network.turn.length === 0 && <div><dt>Calls</dt><dd>Office network only (no TURN servers set)</dd></div>}
              {r.network.turn.map((t) => <div key={t.url}><dt>{t.url.split(':')[0].toUpperCase()}</dt><dd className={t.reachable ? '' : 'dg-bad'}><span className="mono">{t.url.split(':').slice(1).join(':')}</span> · {t.reachable ? `${t.ms} ms` : t.note ?? 'No answer'}</dd></div>)}
            </dl></section>
            <section className="wide"><div className="label">Recent app log · {r.log.length} lines · errors in the window · {r.rendererErrors.length}</div>
              <pre className="dg-log mono">{r.log.slice(-12).map((l) => `${new Date(l.at).toLocaleTimeString()} ${l.level.toUpperCase()} [${l.source}] ${l.msg}`).join('\n') || 'Nothing logged yet.'}</pre>
            </section>
          </div>
        )}
        {r && raw && <pre className="dg-raw mono" aria-label="The file as it will be sent">{JSON.stringify(r, null, 2)}</pre>}
        <div className="dialog-actions">
          {r && <button className="btn ghost" onClick={() => setRaw(!raw)}>{raw ? 'Show the summary' : 'Show the file as it will be sent'}</button>}
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose}>Don't send</button>
          <button className="btn primary" disabled={!r || busy} onClick={() => void send()}>{busy ? <span className="spinner" /> : <Icon name="send" size={15} />}Send to {ticketRef(ticket.number)}</button>
        </div>
      </div>
    </Dialog>
  );
}

/** After a session: how did it go, and is the problem solved? */
export function RateSheet({ ticket, tech, onClose }: { ticket: HelpTicket; tech: string; onClose: () => void }) {
  const toast = useToast();
  const [rating, setRating] = useState(0);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const finish = async (close: boolean) => {
    setBusy(true);
    try {
      if (rating) await window.dex.request('help.rate', { id: ticket.id, rating, note });
      if (close && ticket.status !== 'closed') await window.dex.request('help.close', { id: ticket.id });
      if (!close && ticket.status === 'closed') await window.dex.request('help.reopen', { id: ticket.id, note });
      toast(close ? `${ticketRef(ticket.number)} closed. Thank you.` : `${ticketRef(ticket.number)} stays open`);
      onClose();
    } catch (e) { toast((e as Error).message, true); setBusy(false); }
  };
  const WORDS = ['', 'It did not help', 'A little', 'It helped', 'Good', 'Excellent'];
  return (
    <Dialog title="How did it go?" onClose={onClose} narrow>
      <div className="cs-sheet">
        <p className="cs-lead">The session with {tech} on {ticketRef(ticket.number)} has ended.</p>
        <div className="rt-marks" role="radiogroup" aria-label="Rating">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} role="radio" aria-checked={rating === n} className={`rt-mark${n <= rating ? ' on' : ''}`} onClick={() => setRating(n)} title={WORDS[n]}><span className="mono">{n}</span></button>
          ))}
          <span className="rt-word">{WORDS[rating]}</span>
        </div>
        <input className="input" placeholder="A word for IT (optional)" aria-label="A word for IT" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="dialog-actions">
          <button className="btn ghost" disabled={busy} onClick={() => void finish(false)}>{ticket.status === 'closed' ? 'Reopen it' : 'It still needs work'}</button>
          <button className="btn primary" disabled={busy} onClick={() => void finish(true)}><Icon name="check" size={15} />{ticket.status === 'closed' ? 'Done' : 'Solved: close it'}</button>
        </div>
      </div>
    </Dialog>
  );
}
