// Asking before something that cannot be undone (ending a meeting for everyone, removing someone,
// deleting a recording): a dialog in the app's own look and language, instead of the system's
// confirm box, which is drawn in English and outside the drafting sheet. The safe choice has the
// focus, so Enter never destroys anything by accident.
import { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Dialog } from './ui.tsx';
import './confirm.css';

export interface ConfirmOptions {
  /** The question, as the dialog's title ("End the meeting for everyone?"). */
  title: string;
  /** What happens next, in a sentence. */
  body?: string;
  /** The verb on the button that does it ("End for everyone"), never "OK". */
  confirm: string;
  /** The button that keeps things as they are. */
  cancel?: string;
  /** Red for actions that remove or end something. */
  danger?: boolean;
}

function Ask({ o, done }: { o: ConfirmOptions; done: (ok: boolean) => void }) {
  const safe = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    safe.current?.focus();
    // Escape answers this question only, not the sheet or Room underneath it
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); done(false); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [done]);
  return (
    <Dialog title={o.title} narrow onClose={() => done(false)}>
      {o.body && <p className="muted" style={{ margin: 0 }}>{o.body}</p>}
      <div className="dialog-actions confirm-actions">
        <span />
        <button ref={safe} className="btn ghost" onClick={() => done(false)}>{o.cancel ?? 'Keep it'}</button>
        <button className={`btn${o.danger ? ' danger solid-danger' : ' primary'}`} onClick={() => done(true)}>{o.confirm}</button>
      </div>
    </Dialog>
  );
}

/** Ask before an action; resolves true when the person chooses it. */
export function confirmAction(o: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const back = document.activeElement as HTMLElement | null;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      root.unmount();
      host.remove();
      // focus goes back where it was, so keyboard work carries on from the same place
      if (back?.isConnected) back.focus();
      resolve(ok);
    };
    root.render(<Ask o={o} done={done} />);
  });
}
