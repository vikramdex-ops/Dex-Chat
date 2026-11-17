// Control room, top: the setup check. Everything the hub can check about itself (the service, the
// database, storage, backups, the office's set-up, outside access, calls), live, each with the one
// thing to do when it is not right; and the checks only a person can make, listed "by hand" and
// never shown as passed. Copy report / Download give the owner the same as text.
// See apps/hub/src/setupcheck.ts and docs/GO-LIVE.md.
import { useCallback, useEffect, useState } from 'react';
import { SETUP_STATE_ORDER, setupReportText, uptimeText } from '@dex/core';
import type { SetupCheck as Check, SetupReport, SetupState } from '@dex/core';
import { Icon, useToast } from '../ui.tsx';
import { saveText } from '../meet/GuestLink.tsx';
import './setupcheck.css';

const STAMP: Record<SetupState, string> = { pass: 'Pass', fail: 'Failed', action: 'To do', manual: 'By hand', info: 'Note' };
const OPEN_KEY = 'dex.setupcheck.open';

function headline(r: SetupReport): string {
  const { fail, action } = r.summary;
  if (fail) return fail === 1 ? '1 check failed' : `${fail} checks failed`;
  if (action) return action === 1 ? '1 thing needs doing' : `${action} things need doing`;
  return 'Everything the hub can check passes';
}

function Row({ c }: { c: Check }) {
  return (
    <li className={`sc-row ${c.state}`} data-check={c.id}>
      <span className="sc-stamp">{STAMP[c.state]}</span>
      <div className="sc-body">
        <div className="sc-title"><span className="sc-area">{c.area}</span><span>{c.title}</span></div>
        {c.detail && <div className="sc-detail">{c.detail}</div>}
        {c.fix && <div className="sc-fix"><Icon name="forward" size={13} /><span>{c.fix}</span></div>}
      </div>
    </li>
  );
}

export function SetupCheck({ live }: { live: boolean }) {
  const toast = useToast();
  const [r, setR] = useState<SetupReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; } });
  const load = useCallback(async () => {
    setBusy(true);
    try { setR(await window.dex.request('admin.setup.report')); setErr(null); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }, []);
  useEffect(() => {
    if (!live) return;
    void load();
    // backups, Nib, desks and outside access change from other sections: look again then, and every minute
    let t: ReturnType<typeof setTimeout> | null = null;
    const soon = () => { if (t) clearTimeout(t); t = setTimeout(() => void load(), 800); };
    const off = window.dex.onHubEvent((n) => { if (n === 'admin.backup' || n === 'notices.changed' || n === 'policy.updated') soon(); });
    const every = setInterval(() => void load(), 60_000);
    return () => { off(); clearInterval(every); if (t) clearTimeout(t); };
  }, [live, load]);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try { localStorage.setItem(OPEN_KEY, next ? '1' : '0'); } catch { /* private mode */ }
  };

  if (!r) {
    return (
      <section className="card sc-sheet" aria-label="Setup check">
        <div className="eyebrow">Setup check</div>
        {err ? <p className="sc-detail">{err}</p> : <div className="sc-state"><span className="spinner" />Checking the hub</div>}
      </section>
    );
  }

  const sorted = [...r.checks].sort((a, b) => SETUP_STATE_ORDER.indexOf(a.state) - SETUP_STATE_ORDER.indexOf(b.state));
  const needs = sorted.filter((c) => c.state === 'fail' || c.state === 'action');
  const shown = open ? sorted : needs;
  const state = r.summary.fail ? 'bad' : r.summary.action ? 'warn' : 'ok';
  const day = new Date(r.at);
  const stamp = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  const copy = () => { void navigator.clipboard.writeText(setupReportText(r)).then(() => toast('Setup report copied')).catch(() => toast('Could not copy. Use Download instead.', true)); };

  return (
    <section className={`card sc-sheet ${state}`} aria-labelledby="sc-title">
      <div className="sc-head">
        <div className="sc-headline">
          <div className="eyebrow" id="sc-title">Setup check</div>
          <div className="sc-state" role="status">
            <Icon name={state === 'ok' ? 'check' : 'warning'} size={18} />{headline(r)}
          </div>
        </div>
        <div className="sc-actions">
          <button className="btn sm" disabled={!live || busy} onClick={() => void load()}>{busy ? <span className="spinner" /> : <Icon name="refresh" size={14} />}Check again</button>
          <button className="btn sm" onClick={copy}><Icon name="copy" size={14} />Copy report</button>
          <button className="btn sm" onClick={() => saveText(`Dexterity Connect setup check ${stamp}.txt`, setupReportText(r), 'text/plain;charset=utf-8')}><Icon name="download" size={14} />Download</button>
        </div>
      </div>
      <div className="sc-block" role="list" aria-label="Setup check summary">
        <div className="sc-cell" role="listitem"><span className="label">Passed</span><span className="v">{r.summary.pass}</span></div>
        <div className={`sc-cell${r.summary.fail ? ' bad' : ''}`} role="listitem"><span className="label">Failed</span><span className="v">{r.summary.fail}</span></div>
        <div className={`sc-cell${r.summary.action ? ' warn' : ''}`} role="listitem"><span className="label">To do</span><span className="v">{r.summary.action}</span></div>
        <div className="sc-cell" role="listitem"><span className="label">By hand</span><span className="v">{r.summary.manual}</span></div>
        <div className="sc-cell" role="listitem"><span className="label">Hub running</span><span className="v">{uptimeText(r.hub.uptimeSec)}</span><span className="sub mono">{r.hub.version}</span></div>
      </div>
      {shown.length > 0 && <ol className="sc-list" id="sc-list" aria-label={open ? 'Every check' : 'What needs doing'}>{shown.map((c) => <Row key={c.id} c={c} />)}</ol>}
      <button type="button" className="sc-toggle" aria-expanded={open} aria-controls="sc-list" onClick={toggle}>
        <Icon name="chevron" size={14} />
        {open ? (needs.length ? 'Show only what needs doing' : 'Hide the checks') : r.checks.length === 1 ? 'Show the check' : `Show all ${r.checks.length} checks, and what to check by hand`}
      </button>
    </section>
  );
}
