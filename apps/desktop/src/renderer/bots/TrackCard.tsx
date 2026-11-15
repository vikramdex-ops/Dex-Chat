// A tracked request as a card, and a bot's register. Laid out like a drawing's title block: the
// bot and the request's number across the top, the request's name, a strip of ruled cells for its
// stages (done, here, returned, still to come), the cells that say who has it and since when, the
// buttons for whoever acts now (a note box opens when one is asked for, the checklist above it),
// and the stamp once it closes. The register is one card: the counts in ruled cells, the stages
// as one bar, places in queues, and each request, opened in place to read or act on.
import { useEffect, useId, useState } from 'react';
import type { BotFlowStageAction, BotRegisterView, BotTrackView, PublicUser } from '@dex/core';
import { Icon } from '../ui.tsx';
import { renderBody } from '../chat/format.tsx';
import { formatDateTime, formatTime } from '../time.ts';

/** What a request's buttons do: ask the hub, or (in the bot maker's test run) move the test request. */
export interface TrackDriver {
  act: (itemId: string, action: string, note: string) => Promise<unknown>;
  tick: (itemId: string, index: number, on: boolean) => Promise<unknown>;
  withdraw: (itemId: string) => Promise<unknown>;
  takeover: (itemId: string) => Promise<unknown>;
}

const DAY = 86400_000;
const nameOf = (users: Map<string, PublicUser>, id: string | null | undefined) => (id ? users.get(id)?.displayName ?? '' : '');
const shortWhen = (t: number) => (Math.abs(Date.now() - t) < DAY && new Date(t).getDate() === new Date().getDate() ? formatTime(t) : formatDateTime(t, { weekday: 'short', day: 'numeric', month: 'short' }));
const dayWhen = (t: number) => new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const ageDays = (t: number) => Math.max(0, Math.floor((Date.now() - t) / DAY));

/** The stamp, drawn as an issue stamp: a ruled box, mono capitals, a slight turn. */
export function Stamp({ text, status, at }: { text: string; status: BotTrackView['status']; at?: number | null }) {
  return (
    <span className={`trk-stamp ${status}`} role="img" aria-label={text}>
      <b>{text}</b>
      {at ? <i className="mono">{dayWhen(at)}</i> : null}
    </span>
  );
}

/** The stages as a strip of ruled cells. */
function Strip({ v }: { v: BotTrackView }) {
  return (
    <ol className="trk-strip" aria-label="Stages">
      {v.stages.map((s, i) => (
        <li key={s.id} className={`trk-cell ${s.state}`} aria-current={s.state === 'here' ? 'step' : undefined}>
          <span className="trk-no mono" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
          <span className="trk-label">{s.label}</span>
          <span className="trk-state" aria-hidden="true">{s.state === 'done' ? <Icon name="check" size={11} /> : s.state === 'returned' ? <Icon name="back" size={11} /> : s.state === 'here' ? <i className="trk-dot" /> : null}</span>
          <span className="sr-only">{s.state === 'done' ? 'Done' : s.state === 'here' ? 'Here now' : s.state === 'returned' ? 'Returned' : 'To come'}</span>
          {s.round ? <span className="trk-round mono">{`Round ${s.round}`}</span> : null}
        </li>
      ))}
    </ol>
  );
}

function ActionBar({ v, driver, busy, run }: { v: BotTrackView; driver: TrackDriver; busy: boolean; run: (p: () => Promise<unknown>) => void }) {
  const id = useId();
  const [open, setOpen] = useState<BotFlowStageAction | null>(null);
  const [note, setNote] = useState('');
  useEffect(() => { setOpen(null); setNote(''); }, [v.stage?.id, v.stage?.round, v.status]);
  const checks = v.stage?.checklist ?? [];
  const missing = checks.some((_c, i) => !v.stage?.checks.includes(i));
  const press = (a: BotFlowStageAction) => {
    if (a.note) { setOpen(a); setNote(''); return; }
    run(() => driver.act(v.itemId, a.id, ''));
  };
  return (
    <>
      {checks.length > 0 && (
        <fieldset className="trk-checks">
          <legend className="trk-cap">Checklist</legend>
          {checks.map((c, i) => (
            <label key={i} className="trk-check">
              <input type="checkbox" checked={v.stage?.checks.includes(i) ?? false} disabled={busy} onChange={(e) => run(() => driver.tick(v.itemId, i, e.target.checked))} />
              <span>{c}</span>
            </label>
          ))}
        </fieldset>
      )}
      {open ? (
        <form className="trk-note" onSubmit={(e) => { e.preventDefault(); if (open.note === 'required' && !note.trim()) return; run(() => driver.act(v.itemId, open.id, note)); }}>
          <label htmlFor={`${id}-note`} className="trk-cap">{open.ask ?? 'Note'}{open.note === 'optional' ? <span className="faint"> (optional)</span> : null}</label>
          <textarea id={`${id}-note`} className="input" rows={3} maxLength={2000} value={note} autoFocus onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); (e.currentTarget.form as HTMLFormElement).requestSubmit(); } if (e.key === 'Escape') { e.stopPropagation(); setOpen(null); } }} />
          <div className="trk-btns">
            <button className={`btn ${open.tone === 'stop' ? 'danger' : 'primary'}`} disabled={busy || (open.note === 'required' && !note.trim())}>{open.label}</button>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setOpen(null)}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="trk-btns" role="group" aria-label="What to do">
          {v.actions.map((a) => {
            const blocked = !!a.needsChecks && missing;
            return (
              <button key={a.id} type="button" className={`btn ${a.tone === 'go' ? 'primary' : a.tone === 'stop' ? 'ghost danger' : ''}`} disabled={busy || blocked} title={blocked ? 'Tick every line of the checklist first.' : undefined} onClick={() => press(a)}>
                {a.tone === 'go' && <Icon name="check" size={15} />}{a.tone === 'back' && <Icon name="back" size={15} />}{a.label}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

/** The person acting now, in words: "Waiting for you", "With Ravi Kumar", "Covering for …". */
function Holder({ v, users }: { v: BotTrackView; users: Map<string, PublicUser> }) {
  const s = v.stage;
  if (!s) return null;
  if (v.queue && v.queue.position > 0) return <span className="chip warn">{v.queue.key ? `In line for ${v.queue.key}: place ${v.queue.position} of ${v.queue.of}` : `Place ${v.queue.position} of ${v.queue.of}`}</span>;
  if (v.role === 'actor') return <span className="chip warn">{v.actingAs ? `Trying it as: ${v.actingAs}` : 'Waiting for you'}</span>;
  const who = nameOf(users, s.who);
  const cover = s.whoNote?.startsWith('ooo:') ? nameOf(users, s.whoNote.slice(4)) : '';
  return (
    <span className="trk-holder">
      {who ? <span>{`With ${who}`}</span> : <span>Waiting</span>}
      {cover && <span className="faint">{` · Covering for ${cover}`}</span>}
    </span>
  );
}

export function TrackBody({ v, users, meId, driver, compact }: { v: BotTrackView; users: Map<string, PublicUser>; meId: string; driver: TrackDriver; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState<'none' | 'details' | 'history'>('none');
  useEffect(() => { setError(null); }, [v.stage?.id, v.status]);
  const run = (p: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    void p().catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  const s = v.stage;
  const open = v.status === 'open';
  return (
    <div className={`trk ${v.status}${v.role === 'actor' ? ' acting' : ''}`}>
      <div className="trk-name">
        <span className="trk-ref mono" translate="no">{v.ref}</span>
        <b className="trk-title selectable" translate="no">{v.title}</b>
        {!open && v.stamp && <Stamp text={v.stamp} status={v.status} at={v.closedAt} />}
      </div>
      <Strip v={v} />
      {open && s && (
        <dl className="trk-cells">
          <div><dt>Stage</dt><dd>{s.label}{s.round > 1 ? <span className="faint mono">{` · Round ${s.round}`}</span> : null}</dd></div>
          <div className="wide"><dt>Who</dt><dd><Holder v={v} users={users} /></dd></div>
          <div><dt>Since</dt><dd className="mono">{shortWhen(s.since)}</dd></div>
          {s.due && <div className={s.overdue ? 'late' : ''}><dt>Due</dt><dd className="mono">{s.overdue ? <><Icon name="alarm" size={12} />Overdue</> : dayWhen(s.due)}</dd></div>}
        </dl>
      )}
      {open && v.queue && v.queue.position > 0 && v.queue.holders.length > 0 && (
        <div className="trk-queue faint">
          <span>{`Held by ${v.queue.holders.map((h) => `${nameOf(users, h.userId) || h.ref} (${shortWhen(h.since)})`).join(', ')}`}</span>
        </div>
      )}
      {open && s && v.role === 'actor' && !compact && <div className="trk-ask selectable" translate="no">{renderBody(s.prompt, users, meId)}</div>}
      {open && v.role === 'actor' && <ActionBar v={v} driver={driver} busy={busy} run={run} />}
      {open && v.role !== 'actor' && s && s.checklist.length > 0 && s.checks.length > 0 && (
        <div className="trk-queue faint mono">{`Checklist: ${s.checks.length} of ${s.checklist.length} ticked`}</div>
      )}
      {error && <div className="flow-err" role="alert">{error}</div>}
      {!compact && (
        <div className="trk-tabs">
          <button type="button" className="trk-tab" aria-expanded={more === 'details'} onClick={() => setMore(more === 'details' ? 'none' : 'details')}><Icon name="list" size={13} />Details</button>
          <button type="button" className="trk-tab" aria-expanded={more === 'history'} onClick={() => setMore(more === 'history' ? 'none' : 'history')}><Icon name="history" size={13} />History<span className="mono faint">{v.history.length}</span></button>
          <span className="grow" />
          {v.canTakeOver && <button type="button" className="btn ghost sm" disabled={busy} onClick={() => run(() => driver.takeover(v.itemId))}>Take it over</button>}
          {v.canWithdraw && v.role !== 'actor' && <button type="button" className="btn ghost sm" disabled={busy} onClick={() => run(() => driver.withdraw(v.itemId))}>Withdraw</button>}
        </div>
      )}
      {more === 'details' && (
        <dl className="flow-lines trk-lines">{v.lines.map((l, i) => <div key={i}><dt>{l.label}</dt><dd className="selectable" translate="no">{l.value}</dd></div>)}</dl>
      )}
      {more === 'history' && (
        <ol className="trk-log">
          {v.history.map((e, i) => (
            <li key={i}>
              <span className="mono faint">{shortWhen(e.at)}</span>
              <span><b translate="no">{e.by ? nameOf(users, e.by) || '—' : ''}</b>{e.by ? ' ' : ''}<span>{e.label}</span>{e.note && e.action !== 'nudge' && e.action !== 'escalate' ? <span className="trk-log-note selectable" translate="no">{e.note}</span> : null}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ the register
function Counts({ r }: { r: BotRegisterView }) {
  return (
    <dl className="reg-counts">
      <div><dt>Open</dt><dd>{r.counts.open}</dd></div>
      <div className={r.counts.overdue ? 'late' : ''}><dt>Overdue</dt><dd>{r.counts.overdue}</dd></div>
      <div><dt>Waiting</dt><dd>{r.counts.waiting}</dd></div>
      <div><dt>Closed this week</dt><dd>{r.counts.closedWeek}</dd></div>
    </dl>
  );
}

function StageBar({ r }: { r: BotRegisterView }) {
  const total = r.byStage.reduce((n, s) => n + s.open, 0);
  if (!total) return null;
  return (
    <div className="reg-bar">
      <div className="reg-bar-track" aria-hidden="true">
        {r.byStage.filter((s) => s.open).map((s, i) => <span key={s.id} className={`reg-seg s${i % 4}${s.overdue ? ' late' : ''}`} style={{ flexGrow: s.open }} />)}
      </div>
      <ul className="reg-bar-keys">
        {r.byStage.filter((s) => s.open).map((s, i) => (
          <li key={s.id}><i className={`reg-key s${i % 4}`} aria-hidden="true" /><span>{s.label}</span><b className="mono">{s.open}</b>{s.overdue ? <span className="reg-late mono">{`${s.overdue} late`}</span> : null}</li>
        ))}
      </ul>
    </div>
  );
}

function Seats({ r, users }: { r: BotRegisterView; users: Map<string, PublicUser> }) {
  if (!r.seats.length) return null;
  const shown = r.seats.filter((s) => s.used.length || s.waiting.length).concat(r.seats.filter((s) => !s.used.length && !s.waiting.length)).slice(0, 10);
  return (
    <ul className="reg-seats" aria-label="Places">
      {shown.map((s) => (
        <li key={s.key}>
          <span className="reg-seat-name" translate="no">{s.key}</span>
          <span className="reg-seat-boxes" aria-hidden="true">{Array.from({ length: Math.min(12, s.seats) }, (_, i) => <i key={i} className={i < s.used.length ? 'on' : ''} />)}</span>
          <span className="mono reg-seat-n">{`${s.used.length} of ${s.seats} in use`}</span>
          {s.waiting.length > 0 && <span className="chip warn">{`${s.waiting.length} waiting`}</span>}
          {s.used.length > 0 && <span className="reg-seat-who faint" translate="no">{s.used.map((u) => nameOf(users, u.userId)).filter(Boolean).join(', ')}</span>}
        </li>
      ))}
    </ul>
  );
}

export function RegisterBody({ r, users, meId, driver }: { r: BotRegisterView; users: Map<string, PublicUser>; meId: string; driver: TrackDriver }) {
  const [open, setOpen] = useState<string | null>(null);
  if (r.moved) return <div className="flow-foot faint">A newer list is further down this conversation.</div>;
  const oldest = r.oldestDays === 0 ? 'Oldest open: today' : r.oldestDays === 1 ? 'Oldest open: 1 day' : `Oldest open: ${r.oldestDays} days`;
  return (
    <div className="reg">
      {r.mode === 'all' && <Counts r={r} />}
      {r.mode === 'all' && r.counts.open > 0 && <div className="reg-oldest mono">{oldest}</div>}
      {r.mode === 'all' && <StageBar r={r} />}
      <Seats r={r} users={users} />
      {r.rows.length === 0 && (
        <div className="reg-clear">{r.mode === 'all' ? 'Nothing is open.' : <><Stamp text="ALL CLEAR" status="done" /><span className="faint">Nothing waits for you now.</span></>}</div>
      )}
      {r.rows.length > 0 && (
        <ul className="reg-rows">
          {r.rows.map((v) => {
            const here = v.stage;
            const late = !!here?.overdue;
            const isOpen = open === v.itemId;
            return (
              <li key={v.itemId} className={`reg-row${isOpen ? ' open' : ''}${late ? ' late' : ''}`}>
                <button type="button" className="reg-row-head" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : v.itemId)}>
                  <span className="mono reg-ref" translate="no">{v.ref}</span>
                  <span className="reg-title" translate="no">{v.title}</span>
                  <span className="reg-stage">{here?.label}</span>
                  <span className="reg-who" translate="no">{v.queue && v.queue.position > 0 ? '' : nameOf(users, here?.who)}</span>
                  <span className={`mono reg-age${late ? ' late' : ''}`}>{late ? 'Overdue' : `${ageDays(v.createdAt)} d`}</span>
                  <Icon name="chevron" size={13} className="reg-chev" />
                </button>
                {isOpen && <div className="reg-drill"><TrackBody v={v} users={users} meId={meId} driver={driver} /></div>}
              </li>
            );
          })}
        </ul>
      )}
      {r.more > 0 && <div className="reg-more faint">{r.more === 1 ? '1 more open request' : `${r.more} more open requests`}</div>}
      {r.mode === 'all' && r.closed.length > 0 && (
        <div className="reg-closed">
          <span className="trk-cap">Recently closed</span>
          <ul>{r.closed.map((c) => <li key={c.itemId}><span className="mono" translate="no">{c.ref}</span><span className="grow" translate="no">{c.title}</span>{c.stamp && <span className={`reg-mini-stamp ${c.status}`}>{c.stamp}</span>}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
