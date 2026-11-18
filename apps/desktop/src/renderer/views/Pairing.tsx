// Your own phones and laptops: Preferences ▸ Your devices makes a one-time pairing code (24 hours).
// A phone scans its QR code with the camera: the download page installs the app, copies the code,
// and the app pairs itself on first launch. A laptop gets the same code as text to paste. Either way
// the new device joins already approved, as you; no administrator is involved.
import { useEffect, useRef, useState } from 'react';
import jsQRModule from 'jsqr';
import type { Ops } from '@dex/core';
import { parsePairCode } from '@dex/core/remote';
import type { AppState } from '../../shared/bridge.ts';
import { Dialog, Icon, confirmAction, relativeTime, useToast } from '../ui.tsx';
import { Qr } from './Remote.tsx';
import { formatDateTime } from '../time.ts';

type MyDevice = Ops['me.devices']['res'][number];
// jsQR ships as a CommonJS bundle whose typings describe an ES default export
type Decode = (data: Uint8ClampedArray, w: number, h: number, o?: { inversionAttempts?: 'dontInvert' | 'attemptBoth' }) => { data: string } | null;
const jsQR: Decode = ((jsQRModule as unknown as { default?: Decode }).default ?? jsQRModule) as unknown as Decode;

const kindOf = (d: MyDevice): 'phone' | 'laptop' => (/phone|ipad|pixel|samsung|galaxy|xiaomi|redmi|oneplus|oppo|vivo|realme|motorola|nokia|android/i.test(d.hostname) ? 'phone' : 'laptop');

/** Preferences ▸ Your devices. */
export function YourDevices({ state }: { state: AppState }) {
  const toast = useToast();
  const live = state.phase === 'ready';
  const [list, setList] = useState<MyDevice[] | null>(null);
  const [adding, setAdding] = useState<'phone' | 'laptop' | null>(null);
  const load = () => { void window.dex.request('me.devices').then(setList).catch(() => {}); };
  useEffect(() => { if (live) load(); }, [live]);
  useEffect(() => window.dex.onHubEvent((name) => { if (name === 'me.devicePaired' || name === 'device.updated') load(); }), []);
  const remove = async (d: MyDevice) => {
    // it signs that device out at once, and only a new pairing code brings it back
    if (!await confirmAction({ title: `Remove ${d.hostname}?`, body: 'It is signed out at once. To use it again, add it with a new pairing code.', confirm: 'Remove', danger: true })) return;
    try { await window.dex.request('me.devices.remove', { deviceId: d.id }); toast(`${d.hostname} was signed out and removed`); load(); }
    catch (e) { toast((e as Error).message, true); }
  };
  return (
    <section>
      <h3>Your devices</h3>
      <div className="device-shelf">
        {(list ?? []).map((d) => (
          <div key={d.id} className={`device-tile${d.current ? ' current' : ''}`}>
            <Icon name={kindOf(d) === 'phone' ? 'mobile' : 'laptop'} size={22} />
            <div className="txt">
              <div className="name">{d.hostname}{d.current && <span className="chip">This one</span>}</div>
              <div className="faint">{d.paired ? 'Added with a pairing code' : 'Approved by an administrator'} · {d.current ? 'in use now' : d.lastSeen ? `seen ${relativeTime(d.lastSeen)}` : `added ${relativeTime(d.createdAt)}`}</div>
            </div>
            {!d.current && <button className="icon-btn" title={`Remove ${d.hostname}`} aria-label={`Remove ${d.hostname}`} onClick={() => void remove(d)}><Icon name="trash" size={16} /></button>}
          </div>
        ))}
      </div>
      <div className="row-actions">
        <button className="btn" disabled={!live} title={live ? undefined : 'Waiting for the office hub…'} onClick={() => setAdding('phone')}><Icon name="mobile" size={16} />Add my phone</button>
        <button className="btn" disabled={!live} title={live ? undefined : 'Waiting for the office hub…'} onClick={() => setAdding('laptop')}><Icon name="laptop" size={16} />Add my laptop</button>
      </div>
      <p className="faint" style={{ fontSize: 12.5, margin: 0 }}>Your phone or home laptop joins as you, with no approval needed. It works at home and on mobile data once your office has turned on access from outside.</p>
      {adding && <AddDevice kind={adding} onClose={() => setAdding(null)} />}
    </section>
  );
}

function AddDevice({ kind, onClose }: { kind: 'phone' | 'laptop'; onClose: () => void }) {
  const toast = useToast();
  const [made, setMade] = useState<Ops['pair.create']['res'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState<string | null>(null);
  useEffect(() => {
    window.dex.request('pair.create', { kind }).then(setMade).catch((e: Error) => setError(e.message));
  }, [kind]);
  useEffect(() => window.dex.onHubEvent((name, data) => { if (name === 'me.devicePaired') setJoined((data as { hostname: string }).hostname); }), []);
  const copy = (text: string, what: string) => { void navigator.clipboard.writeText(text).then(() => toast(`${what} copied`)); };
  const until = made ? formatDateTime(made.expiresAt, { weekday: 'short' }) : '';
  return (
    <Dialog title={kind === 'phone' ? 'Add your phone' : 'Add your laptop'} onClose={onClose}>
      {error && <div className="error-box">{error}</div>}
      {joined ? (
        <div className="pair-done">
          <Icon name="check" size={34} />
          <h3>{joined} is ready</h3>
          <p className="muted">It is signed in as you. You can remove it any time from Your devices.</p>
          <div className="dialog-actions"><button className="btn primary" onClick={onClose}>Done</button></div>
        </div>
      ) : made && (kind === 'phone' ? (
        <>
          <div className="setup-grid">
            <Qr text={made.link} />
            <ol className="setup-steps">
              <li>Point your phone's camera at this square and tap the link that appears.</li>
              <li>On the page that opens, tap <b>Download for Android</b> and install the app. (Already installed? Tap <b>Open the app</b>.)</li>
              <li>Open Dexterity Connect. It finds this code by itself and signs you in. If it asks, tap <b>Scan the code on your PC</b> and point it here.</li>
              <li>On an iPhone, the page opens Dexterity Connect for iPhone in Safari instead. Follow it to add the app to your Home Screen, then paste the code there.{!parsePairCode(made.code)?.url && <> <span className="danger-text">Your office has not turned on access from outside yet, which an iPhone needs.</span></>}</li>
            </ol>
          </div>
          <div className="dialog-actions">
            <span className="faint">Works once, until {until}. Keep it to yourself: it adds a device to your account.</span>
            <button className="btn" onClick={() => copy(made.link, 'Link')}><Icon name="copy" size={15} />Copy link</button>
          </div>
        </>
      ) : (
        <>
          <ol className="setup-steps">
            <li>Send yourself this code: copy it into an email or a chat to yourself.</li>
            <li>On the laptop, install Dexterity Connect from <span className="mono">{made.link.split('#')[0]}</span>.</li>
            <li>Open it and paste the code. The laptop is added to your account straight away.</li>
          </ol>
          <textarea className="input mono pair-code" rows={4} readOnly value={made.code} onFocus={(e) => e.currentTarget.select()} aria-label="Pairing code" />
          <div className="dialog-actions">
            <span className="faint">Works once, until {until}.</span>
            <a className="btn" href={`mailto:?subject=${encodeURIComponent('Dexterity Connect pairing code')}&body=${encodeURIComponent(`Paste this into Dexterity Connect on your laptop:\n\n${made.code}\n\nOr open: ${made.link}`)}`}><Icon name="send" size={15} />Email it to me</a>
            <button className="btn primary" onClick={() => copy(made.code, 'Pairing code')}><Icon name="copy" size={15} />Copy code</button>
          </div>
        </>
      ))}
      {!made && !error && <div className="center" style={{ padding: 30 }}><span className="spinner" /></div>}
    </Dialog>
  );
}

/** A camera viewfinder that reads a QR code (BarcodeDetector where available, else jsQR). */
/** Barcode kinds a form's Scan field reads (QR codes always; jsQR reads QR where the system cannot). */
export const BARCODE_FORMATS = ['qr_code', 'code_128', 'code_39', 'ean_13', 'data_matrix'];

export function QrScanner({ onCode, onClose, formats = ['qr_code'], hint }: {
  onCode: (text: string) => void; onClose: () => void;
  /** What BarcodeDetector looks for (default: QR codes only). */
  formats?: string[];
  /** The line under the camera (default: where the pairing code is on the PC). */
  hint?: string;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(onCode);
  done.current = onCode;
  const wanted = formats.join(',');
  const custom = !!hint;
  useEffect(() => {
    let stream: MediaStream | null = null;
    let stop = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    type Detector = { detect(v: HTMLVideoElement): Promise<Array<{ rawValue: string }>> };
    type DetectorClass = { new (o: { formats: string[] }): Detector; getSupportedFormats?: () => Promise<string[]> };
    const BD = (window as unknown as { BarcodeDetector?: DetectorClass }).BarcodeDetector;
    let detector: Detector | null = null;
    const qr = wanted.split(',').includes('qr_code');
    const ready = (async () => {
      if (!BD) return;
      try {
        // only the kinds this system reads, or the detector refuses to start
        const supported = BD.getSupportedFormats ? await BD.getSupportedFormats() : wanted.split(',');
        const use = wanted.split(',').filter((f) => supported.includes(f));
        detector = use.length ? new BD({ formats: use }) : null;
      } catch { detector = null; }
    })();
    const tick = async () => {
      if (stop) return;
      const v = video.current;
      if (v && v.readyState >= 2 && v.videoWidth) {
        let found: string | null = null;
        if (detector) {
          try { found = (await detector.detect(v))[0]?.rawValue ?? null; } catch { detector = null; }
        }
        if (!found && !detector && qr && ctx) {
          const w = Math.min(640, v.videoWidth);
          const h = Math.round((v.videoHeight / v.videoWidth) * w);
          canvas.width = w; canvas.height = h;
          ctx.drawImage(v, 0, 0, w, h);
          found = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' })?.data ?? null;
        }
        if (found && !stop) { stop = true; done.current(found); return; }
      }
      setTimeout(() => void tick(), 180);
    };
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false })
      .then(async (s) => {
        stream = s;
        if (stop) { s.getTracks().forEach((t) => t.stop()); return; }
        if (video.current) { video.current.srcObject = s; void video.current.play(); }
        await ready;
        void tick();
      })
      .catch(() => setError(custom ? 'The camera could not be opened. Allow camera access for Dexterity Connect, or type the code instead.' : 'The camera could not be opened. Allow camera access for Dexterity Connect, or paste the code instead.'));
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [wanted, custom]);
  return (
    <div className="scan-overlay" role="dialog" aria-label="Scan the code">
      <video ref={video} playsInline muted />
      <div className="scan-window" aria-hidden="true"><i /><i /><i /><i /></div>
      <div className="scan-foot">
        {error ? <div className="error-box">{error}</div> : hint ? <p>{hint}</p> : <p>Point at the square on your PC: <b>Preferences → Your devices → Add my phone</b></p>}
        <button className="btn" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
