// The cards Nib posts, drawn from nib.card as the viewer may see them (docs/NIB.md §4, §5): a lead's
// transmittal, the management's register (a sheet index of people, the output, the call-outs, leave
// and who is missing), the follow-up, the week, and the leave, cover and welcome cards. Loaded with
// the first Nib card on screen.
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { CellStatus, LeadCardView, LeadRow, Message, NibCard, NibItemLite, NibRegister, NibSheetView, NibWeek, PublicUser, RegisterCell, UnitTotal } from '@dex/core';
import { Avatar, Icon, useToast } from '../ui.tsx';
import { NibTile } from './NibMark.tsx';
import { DimBar, ItemQty, ProjectTag } from './parts.tsx';
import { cardFor, forgetCard, openTray, setCard, useCardVersion, useNib } from './store.ts';
import { LEAVE_WORD, STATUS_WORD, dayLabel, firstName, qtyWords } from './words.ts';
import { formatTime } from '../time.ts';
import { act } from './Tray.tsx';

const go = (url: string) => window.dispatchEvent(new CustomEvent('dex-deeplink', { detail: url }));
const writeTo = (id: string) => void window.dex.request('conv.create', { kind: 'direct', members: [id] }).then((c) => go(`dexconnect://conversation/${c.id}`)).catch(() => {});
const dwg = (kind: string, date: string) => `NIB-${kind}-${date.replace(/-/g, '').slice(2)}`;

export default function NibMessageCard({ m, meId, users }: { m: Message; meId: string; users: Map<string, PublicUser> }) {
  useCardVersion();
  const ref = m.nib!;
  const { card, error, loading } = cardFor(ref.kind, ref.ref, m.id);
  if (loading) return <div className="nib-card loading" aria-busy="true"><span className="spinner" /></div>;
  if (error || !card) return <div className="nib-card gone"><span className="faint">{m.body}</span></div>;
  switch (card.kind) {
    case 'lead': return <LeadCard v={card.lead} users={users} />;
    case 'register': return <RegisterCard r={card.register} sentAt={card.sentAt} users={users} />;
    case 'followup': return <FollowUpCard r={card.register} sentAt={card.sentAt} users={users} />;
    case 'week': return <WeekCard w={card.week} users={users} />;
    case 'ask': return <AskCard c={card} />;
    case 'leave': case 'leaveSpace': return <LeaveCard c={card} users={users} meId={meId} />;
    case 'cover': return <CoverCard c={card} users={users} />;
    case 'welcome': return <Frame kind="WELCOME BACK" title={dayLabel(card.leave.to)}><p className="nib-line">Welcome back.</p><button className="btn sm" onClick={() => openTray({ v: 'welcome' })}>What moved while I was away</button></Frame>;
    case 'joiner': return <JoinerCard c={card} users={users} />;
    case 'hello': return <HelloCard />;
    case 'reply': return <ReplyCard c={card} users={users} />;
  }
  return null;
}

function Frame({ kind, title, no, children, className }: { kind: string; title: string; no?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`nib-card${className ? ` ${className}` : ''}`}>
      <div className="nib-card-tb">
        <NibTile size={20} />
        <span className="mono nib-card-kind">{kind}</span>
        <span className="nib-card-title" translate="no">{title}</span>
        {no && <span className="mono nib-card-no" translate="no">{no}</span>}
      </div>
      <div className="nib-card-body">{children}</div>
    </div>
  );
}

const unitText = (u: UnitTotal) => (u.total > u.done ? qtyWords({ done: u.done, total: u.total, unit: u.unit }) : qtyWords({ done: null, total: u.done, unit: u.unit }));

// ------------------------------------------------------------------ a lead's transmittal
function LeadCard({ v, users }: { v: LeadCardView; users: Map<string, PublicUser> }) {
  const toast = useToast();
  const me = useNib((s) => s.me);
  const ack = (userId?: string) => void window.dex.request('nib.ack', { date: v.date, ...(userId ? { userId } : {}) }).then((lead) => { setCard('lead', v.date, { kind: 'lead', lead }); toast(userId ? 'Marked seen' : 'All marked seen'); }).catch((e: Error) => toast(e.message, true));
  const people = v.rows.length;
  return (
    <Frame kind="FROM YOUR DESK" title={`${dayLabel(v.date)} · ${people === 1 ? '1 person' : `${people} people`}`} no={dwg('TX', v.date)} className="k-lead">
      {v.rows.length === 0 ? <p className="nib-line">Nobody has sent work from you yet today.</p> : (
        <ul className="nib-rows">
          {v.rows.map((r) => <LeadRowView key={r.userId} r={r} users={users} onSeen={() => ack(r.userId)} />)}
        </ul>
      )}
      {v.totals.length > 0 && (
        <div className="nib-totals" aria-label="Totals">
          {v.totals.slice(0, 4).map((t) => (
            <span key={t.project ?? ''} className="nib-total">
              <span className="nib-job mono" translate="no">{t.project ?? '—'}</span>
              <span className="mono" translate="no">{t.units.map(unitText).join(' · ') || (t.items === 1 ? '1 item' : `${t.items} items`)}</span>
            </span>
          ))}
        </div>
      )}
      {v.waiting.length > 0 && (
        <p className="nib-waiting"><span className="label">Waiting for</span>{v.waiting.map((id) => <span key={id} className="nib-waiting-who" translate="no"><Avatar user={users.get(id) ?? { id, displayName: '?' }} size="sm" />{firstName(users.get(id)?.displayName ?? '')}</span>)}</p>
      )}
      {v.rows.some((r) => !r.seenAt) && me && <div className="nib-card-actions"><button className="btn sm" onClick={() => ack()}><Icon name="check" size={14} />Seen all</button></div>}
    </Frame>
  );
}
function LeadRowView({ r, users, onSeen }: { r: LeadRow; users: Map<string, PublicUser>; onSeen?: () => void }) {
  const u = users.get(r.userId);
  return (
    <li className={`nib-row${r.late ? ' late' : ''}`}>
      <div className="nib-row-head">
        {u ? <Avatar user={u} size="sm" /> : null}
        <span className="nib-row-name" translate="no">{u?.displayName ?? 'Former member'}</span>
        {r.sentAt && <span className="mono faint">{formatTime(r.sentAt)}</span>}
        {r.late && <span className="chip">LATE</span>}
        {r.changed && <span className="chip">CHANGED</span>}
        <span className="nib-row-acts">
          {onSeen && (r.seenAt ? <span className="nib-seen mono"><Icon name="check" size={12} />SEEN</span> : <button className="btn ghost sm" onClick={onSeen}>Seen</button>)}
          <button className="btn ghost sm" onClick={() => writeTo(r.userId)} aria-label={`Write to ${u?.displayName ?? ''}`}>Write</button>
        </span>
      </div>
      <ItemLines items={r.items} />
      {r.note && <p className="nib-row-note" translate="no">{r.note}</p>}
      {r.blockers && <p className="nib-row-block" translate="no"><Icon name="warning" size={13} />{r.blockers}</p>}
    </li>
  );
}
function ItemLines({ items }: { items: NibItemLite[] }) {
  return (
    <ul className="nib-lines">
      {items.map((x) => (
        <li key={x.id} className={`s-${x.status}`}>
          <span className="nib-line-what"><span translate="no">{x.activity}</span><ProjectTag code={x.project} /></span>
          <ItemQty x={x} />
          <span className={`nib-state mono s-${x.status}`}>{STATUS_WORD[x.status].toUpperCase()}</span>
          {x.note && <span className="nib-line-note" translate="no">{x.note}</span>}
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ the register
const CELL_WORD: Record<CellStatus, string> = { reported: 'Reported', blocked: 'Reported, with a blocker', nothing: 'Nothing today', missing: 'Not reported', away: 'Not in, not reported', leave: 'On leave' };
type Panel = 'output' | 'callouts' | 'people';

function Headline({ r }: { r: NibRegister }) {
  const h = r.headline;
  const cells: Array<[string, number, string?]> = [
    ['Expected', h.roster - h.leave], ['In today', h.in], ['Reported', h.reported, 'ok'], ['Not yet', h.missing + h.away, h.missing + h.away ? 'gap' : undefined], ['On leave', h.leave], ['Blocked', h.blocked, h.blocked ? 'warn' : undefined],
  ];
  return (
    <div className="nib-head-cells" role="list" aria-label="Headline">
      {cells.map(([l, n, tone]) => <div key={l} role="listitem" className={`nib-head-cell${tone ? ` ${tone}` : ''}`}><span className="nib-head-n">{n}</span><span className="label">{l}</span></div>)}
    </div>
  );
}

function RegisterCard({ r, sentAt, users }: { r: NibRegister; sentAt: number; users: Map<string, PublicUser> }) {
  const [panel, setPanel] = useState<Panel>('output');
  const [pick, setPick] = useState<string | null>(null);
  const calls = r.callouts.length;
  return (
    <Frame kind="DAILY REGISTER" title={dayLabel(r.date, { weekday: 'long', day: 'numeric', month: 'short' })} no={dwg('REG', r.date)} className="k-register">
      <Headline r={r} />
      <Grid r={r} users={users} pick={pick} onPick={setPick} />
      {pick && <PersonPanel userId={pick} date={r.date} r={r} users={users} onClose={() => setPick(null)} />}
      <div className="seg nib-panels" role="tablist" aria-label="More">
        <button role="tab" aria-selected={panel === 'output'} aria-pressed={panel === 'output'} onClick={() => setPanel('output')}>Output</button>
        <button role="tab" aria-selected={panel === 'callouts'} aria-pressed={panel === 'callouts'} onClick={() => setPanel('callouts')}>{calls ? `Call-outs · ${calls}` : 'Call-outs'}</button>
        <button role="tab" aria-selected={panel === 'people'} aria-pressed={panel === 'people'} onClick={() => setPanel('people')}>{`Leave and missing · ${r.leave.length + r.missing.length}`}</button>
      </div>
      <div role="tabpanel" className="nib-panel">
        {panel === 'output' && <Output r={r} />}
        {panel === 'callouts' && <Callouts r={r} users={users} onPick={setPick} />}
        {panel === 'people' && <LeaveMissing r={r} users={users} onPick={setPick} />}
      </div>
      <p className="nib-card-foot mono faint">{`AS AT ${formatTime(sentAt).toUpperCase()} · LATE SHEETS COME IN ONE FOLLOW-UP`}</p>
    </Frame>
  );
}

/** Everyone as a cell, by department: a sheet index. One focus stop; arrows walk, Enter opens.
 *  Drawn again only when the register or the person picked changes (not for a tab below it). */
const Grid = memo(function Grid({ r, users, pick, onPick }: { r: NibRegister; users: Map<string, PublicUser>; pick: string | null; onPick: (id: string) => void }) {
  const flat = useMemo(() => r.groups.flatMap((g) => g.cells), [r]);
  const [at, setAt] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const big = flat.length > 80;
  const move = (i: number) => { const n = Math.max(0, Math.min(flat.length - 1, i)); setAt(n); box.current?.querySelector<HTMLButtonElement>(`[data-i="${n}"]`)?.focus(); };
  const cols = () => { const row = box.current?.querySelector('.nib-grid-cells'); return row ? Math.max(1, Math.floor(row.clientWidth / (big ? 20 : 30))) : 10; };
  const choose = useMemo(() => (idx: number) => { setAt(idx); const c = flat[idx]; if (c) onPick(c.userId); }, [flat, onPick]);
  let i = -1;
  return (
    <div ref={box} className={`nib-grid${big ? ' big' : ''}`} role="group" aria-label={`Register: ${flat.length} people`}
      onKeyDown={(e) => {
        const k = e.key;
        if (k === 'ArrowRight') { e.preventDefault(); move(at + 1); } else if (k === 'ArrowLeft') { e.preventDefault(); move(at - 1); }
        else if (k === 'ArrowDown') { e.preventDefault(); move(at + cols()); } else if (k === 'ArrowUp') { e.preventDefault(); move(at - cols()); }
        else if (k === 'Home') { e.preventDefault(); move(0); } else if (k === 'End') { e.preventDefault(); move(flat.length - 1); }
      }}>
      {r.groups.map((g) => (
        <div key={g.id ?? 'none'} className="nib-grid-row">
          <span className="nib-grid-label"><span translate="no">{g.name}</span><span className="mono">{`${g.reported}/${g.expected}`}</span></span>
          <div className="nib-grid-cells">
            {g.cells.map((c) => {
              i++;
              const idx = i;
              const u = users.get(c.userId);
              return <Cell key={c.userId} c={c} u={u} idx={idx} active={idx === at} picked={pick === c.userId} onClick={choose} big={big} />;
            })}
          </div>
        </div>
      ))}
      <div className="nib-legend" aria-hidden="true">
        {(['reported', 'blocked', 'nothing', 'missing', 'away', 'leave'] as CellStatus[]).map((s) => <span key={s}><i className={`nib-cell mini s-${s}`} />{CELL_WORD[s]}</span>)}
      </div>
    </div>
  );
});
const Cell = memo(function Cell({ c, u, idx, active, picked, onClick, big }: { c: RegisterCell; u: PublicUser | undefined; idx: number; active: boolean; picked: boolean; onClick: (idx: number) => void; big: boolean }) {
  const name = u?.displayName ?? 'Former member';
  const ini = name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <button data-i={idx} tabIndex={active ? 0 : -1} className={`nib-cell s-${c.status}${picked ? ' picked' : ''}${c.late ? ' late' : ''}`} style={{ '--fill': c.fill } as React.CSSProperties}
      aria-label={`${name}: ${CELL_WORD[c.status]}${c.items ? `, ${c.items} items` : ''}`} title={`${name} · ${CELL_WORD[c.status]}`} onClick={() => onClick(idx)}>
      <span className="nib-cell-fill" />
      {!big && <span className="nib-cell-ini" translate="no">{ini}</span>}
    </button>
  );
});

function PersonPanel({ userId, date, r, users, onClose }: { userId: string; date: string; r: NibRegister; users: Map<string, PublicUser>; onClose: () => void }) {
  const [s, setS] = useState<NibSheetView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setS(null); setErr(null); void window.dex.request('nib.sheet', { userId, date }).then(setS).catch((e: Error) => setErr(e.message)); }, [userId, date]);
  const u = users.get(userId);
  const cell = r.groups.flatMap((g) => g.cells).find((c) => c.userId === userId);
  const miss = r.missing.find((m) => m.userId === userId);
  const lv = r.leave.find((l) => l.userId === userId);
  return (
    <div className="nib-person-panel" role="region" aria-label={u?.displayName ?? 'Person'}>
      <div className="nib-row-head">
        {u && <Avatar user={u} size="sm" />}
        <span className="nib-row-name" translate="no">{u?.displayName ?? 'Former member'}</span>
        {cell && <span className={`nib-state mono s-${cell.status}`}>{CELL_WORD[cell.status].toUpperCase()}</span>}
        <span className="nib-row-acts">
          <button className="btn ghost sm" onClick={() => writeTo(userId)}>Write</button>
          <button className="icon-btn sm" aria-label="Close" onClick={onClose}><Icon name="x" size={14} /></button>
        </span>
      </div>
      {lv && <p className="nib-line">{lv.half ? `${LEAVE_WORD[lv.kind]}: the ${lv.half === 'am' ? 'morning' : 'afternoon'}.` : `${LEAVE_WORD[lv.kind]}, back after ${dayLabel(lv.to)}.`}</p>}
      {miss && <p className="nib-line">{miss.asks === 0 ? 'Not asked yet.' : miss.asks === 1 ? 'Nib asked once.' : `Nib asked ${miss.asks} times.`}{miss.busy ? ` ${BUSY_WORD[miss.busy]}` : ''}</p>}
      {err ? <p className="faint">{err}</p> : !s ? <span className="spinner" /> : s.items.length ? <ItemLines items={s.items} /> : !lv && !miss && <p className="faint">No items.</p>}
      {s?.day?.note && <p className="nib-row-note" translate="no">{s.day.note}</p>}
      {s?.day?.blockers && <p className="nib-row-block" translate="no"><Icon name="warning" size={13} />{s.day.blockers}</p>}
    </div>
  );
}
const BUSY_WORD: Record<string, string> = { room: 'In a Room through the wrap-up.', meeting: 'In meetings through the wrap-up.', dnd: 'On Do not disturb through the wrap-up.', busy: 'Heads-down through the wrap-up.' };

function Output({ r }: { r: NibRegister }) {
  const [all, setAll] = useState(false);
  const list = all ? r.projects : r.projects.slice(0, 5);
  return (
    <>
      {r.units.length > 0 && (
        <div className="nib-units">
          {r.units.slice(0, 5).map((u) => (
            <div key={u.unit ?? 'count'} className="nib-unit">
              <span className="nib-unit-n" translate="no">{u.total > u.done ? `${u.done}` : `${u.done}`}{u.total > u.done && <small>{` / ${u.total}`}</small>}</span>
              <span className="label" translate="no">{u.unit ?? 'items'}</span>
            </div>
          ))}
        </div>
      )}
      {r.projects.length === 0 ? <p className="faint">No work reported yet.</p> : (
        <ul className="nib-bars" aria-label="By job">
          {list.map((p) => {
            const u = p.units[0];
            return (
              <li key={p.project ?? 'none'}>
                <span className="nib-bar-name"><span className="nib-job mono" translate="no">{p.project ?? '—'}</span>{p.name && <span className="faint" translate="no">{p.name}</span>}</span>
                <DimBar value={p.progress} label={`${Math.round(p.progress * 100)}%`} />
                <span className="mono nib-bar-n" translate="no">{u ? unitText(u) : p.items === 1 ? '1 item' : `${p.items} items`}</span>
                <span className="mono faint">{p.people === 1 ? '1 PERSON' : `${p.people} PEOPLE`}</span>
              </li>
            );
          })}
        </ul>
      )}
      {r.projects.length > 5 && <button className="link" onClick={() => setAll(!all)}>{all ? 'Fewer jobs' : `${r.projects.length - 5} more jobs`}</button>}
    </>
  );
}
const CALL_WORD: Record<string, string> = { blocker: 'BLOCKED', overdue: 'PAST DUE', stalled: 'NO PROGRESS', givers: 'MANY GIVERS' };
function Callouts({ r, users, onPick }: { r: NibRegister; users: Map<string, PublicUser>; onPick: (id: string) => void }) {
  if (!r.callouts.length) return <p className="faint">Nothing to call out. A quiet day.</p>;
  return (
    <ul className="nib-calls">
      {r.callouts.slice(0, 6).map((c, i) => (
        <li key={i} className={`k-${c.kind}`}>
          <button className="nib-list-row" onClick={() => onPick(c.userId)}>
            <span className="mono nib-call-kind">{CALL_WORD[c.kind]}</span>
            <span className="nib-call-who" translate="no">{firstName(users.get(c.userId)?.displayName ?? '')}</span>
            {c.project && <ProjectTag code={c.project} />}
            <span className="nib-call-text" translate="no">{c.text}</span>
          </button>
        </li>
      ))}
      {r.callouts.length > 6 && <li className="faint">{`${r.callouts.length - 6} more`}</li>}
    </ul>
  );
}
function LeaveMissing({ r, users, onPick }: { r: NibRegister; users: Map<string, PublicUser>; onPick: (id: string) => void }) {
  const name = (id: string) => firstName(users.get(id)?.displayName ?? '');
  return (
    <>
      <p className="nib-group-line"><span className="label">{r.leave.length === 1 ? 'On leave · 1' : `On leave · ${r.leave.length}`}</span>
        {r.leave.length === 0 ? <span className="faint">Nobody.</span> : r.leave.map((l) => (
          <button key={l.userId} className="nib-who" onClick={() => onPick(l.userId)} translate="no">{`${name(l.userId)} (${l.half ? (l.half === 'am' ? 'morning' : 'afternoon') : l.kind === 'sick' ? 'sick' : `to ${dayLabel(l.to, { weekday: 'short' })}`})`}</button>
        ))}
      </p>
      <p className="nib-group-line"><span className="label">{`Not reported · ${r.missing.length}`}</span>
        {r.missing.length === 0 ? <span className="faint">Everyone reported.</span> : r.missing.map((m) => (
          <button key={m.userId} className={`nib-who${m.away ? ' away' : ''}`} onClick={() => onPick(m.userId)}>
            <span translate="no">{name(m.userId)}</span><span className="mono faint">{m.asks === 1 ? 'ASKED 1×' : `ASKED ${m.asks}×`}</span>
          </button>
        ))}
      </p>
    </>
  );
}

// ------------------------------------------------------------------ the follow-up
function FollowUpCard({ r, sentAt, users }: { r: NibRegister; sentAt: number; users: Map<string, PublicUser> }) {
  return (
    <Frame kind="FOLLOW-UP" title={dayLabel(r.date, { weekday: 'long', day: 'numeric', month: 'short' })} no={dwg('FU', r.date)} className="k-followup">
      <p className="nib-line">{r.late.length === 1 ? 'One sheet came in after the register.' : `${r.late.length} sheets came in after the register.`}</p>
      <ul className="nib-rows">
        {r.late.map((l) => <LeadRowView key={l.userId} r={{ userId: l.userId, sentAt: l.sentAt, late: true, changed: false, seenAt: null, items: l.items, note: l.note, blockers: l.blockers }} users={users} />)}
      </ul>
      <LeaveMissing r={{ ...r, leave: [] }} users={users} onPick={(id) => writeTo(id)} />
      <p className="nib-card-foot mono faint">{`AS AT ${formatTime(sentAt).toUpperCase()}`}</p>
    </Frame>
  );
}

// ------------------------------------------------------------------ the week
const CELL_FILL: Record<CellStatus, string> = { reported: 'var(--accent)', blocked: 'var(--accent)', nothing: 'var(--accent-soft)', missing: 'url(#nib-hatch)', away: 'var(--subtle-2, rgba(0,0,0,.06))', leave: 'none' };
function WeekCard({ w, users }: { w: NibWeek; users: Map<string, PublicUser> }) {
  const rows = Math.min(25, Math.max(1, w.people.length));
  const blocks = Math.max(1, Math.ceil(w.people.length / rows));
  const cw = 9; const gap = 2; const head = 13; const bw = w.dates.length * (cw + gap) + 12;
  const height = head + rows * (cw + gap);
  const max = Math.max(1, ...w.days.map((d) => d.expected));
  return (
    <Frame kind="THE WEEK" title={`${dayLabel(w.from)} – ${dayLabel(w.to)}`} no={dwg('WK', w.to)} className="k-week">
      <div className="nib-week-days" aria-label="Day sheets by day">
        {w.days.map((d) => (
          <div key={d.date} className="nib-week-day">
            <span className="nib-week-bar" style={{ height: `${Math.round((d.reported / max) * 100)}%` }} />
            <span className="mono">{dayLabel(d.date, { weekday: 'narrow' })}</span>
            <span className="mono faint">{d.expected ? `${d.reported}/${d.expected}` : '–'}</span>
          </div>
        ))}
      </div>
      <span className="label">{w.people.length === 1 ? 'One person, day by day' : `${w.people.length} people, day by day`}</span>
      <svg className="nib-week-grid" width={blocks * bw} height={height} role="img" aria-label={`${w.people.length} people by day`}>
        <defs><pattern id="nib-hatch" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="3" stroke="var(--text-3)" strokeWidth="1" /></pattern></defs>
        {Array.from({ length: blocks }, (_, b) => w.dates.map((d, di) => <text key={`h${b}-${di}`} x={b * bw + di * (cw + gap) + cw / 2} y={8} textAnchor="middle">{dayLabel(d, { weekday: 'narrow' })}</text>))}
        {w.people.map((p, i) => {
          const b = Math.floor(i / rows); const row = i % rows;
          return p.cells.map((c, di) => (
            <rect key={`${p.userId}-${di}`} x={b * bw + di * (cw + gap)} y={head + row * (cw + gap)} width={cw} height={cw}
              fill={c ? CELL_FILL[c] : 'none'} stroke={!c ? 'var(--stroke-strong)' : c === 'leave' || c === 'missing' ? 'var(--text-3)' : 'none'} strokeDasharray={c === 'leave' ? '2 1' : !c ? '1 1.5' : undefined} strokeWidth={0.8}>
              <title>{`${users.get(p.userId)?.displayName ?? ''} · ${dayLabel(w.dates[di])} · ${c ? CELL_WORD[c] : 'No register'}`}</title>
            </rect>
          ));
        })}
      </svg>
      <ul className="nib-bars" aria-label="Jobs this week">
        {w.projects.slice(0, 5).map((p) => {
          const top = Math.max(1, ...p.perDay);
          return (
            <li key={p.project ?? 'none'}>
              <span className="nib-bar-name"><span className="nib-job mono" translate="no">{p.project ?? '—'}</span>{p.name && <span className="faint" translate="no">{p.name}</span>}</span>
              <span className="nib-spark" aria-hidden="true">{p.perDay.map((v, i) => <i key={i} style={{ height: `${Math.max(6, Math.round((v / top) * 100))}%` }} />)}</span>
              <span className="mono nib-bar-n" translate="no">{p.units.slice(0, 2).map(unitText).join(' · ')}</span>
            </li>
          );
        })}
      </ul>
    </Frame>
  );
}

// ------------------------------------------------------------------ the person's own cards
function AskCard({ c }: { c: Extract<NibCard, { kind: 'ask' }> }) {
  const me = useNib((s) => s.me);
  const live = me && me.date === c.date ? me.day.state : c.state;
  return (
    <Frame kind="DAY SHEET" title={dayLabel(c.date)}>
      {live === 'sent' ? <p className="nib-line"><Icon name="check" size={14} />Sent. Thank you.</p>
        : live === 'nothing' ? <p className="nib-line">Nothing that day. Noted.</p>
          : <><p className="nib-line">{c.items === 0 ? 'Your day sheet is still blank. Thirty seconds, before the register.' : c.items === 1 ? 'Your day sheet is still open, with 1 item. Thirty seconds, before the register.' : `Your day sheet is still open, with ${c.items} items. Thirty seconds, before the register.`}</p>
            <div className="nib-card-actions"><button className="btn primary sm" onClick={() => openTray({ v: 'wrap' })}>Check and send</button></div></>}
    </Frame>
  );
}

function LeaveCard({ c, users, meId }: { c: Extract<NibCard, { kind: 'leave' | 'leaveSpace' }>; users: Map<string, PublicUser>; meId: string }) {
  const l = c.leave;
  const who = users.get(l.userId)?.displayName ?? 'A colleague';
  const cover = l.coverId ? users.get(l.coverId) : undefined;
  const when = l.half ? `${l.half === 'am' ? 'the morning' : 'the afternoon'} of ${dayLabel(l.from)}` : l.from === l.to ? dayLabel(l.from) : `${dayLabel(l.from)} – ${dayLabel(l.to)}`;
  return (
    <Frame kind={c.kind === 'leaveSpace' ? 'AWAY' : 'LEAVE'} title={when} className="k-leave">
      <div className="nib-leave-line">
        {users.get(l.userId) && <Avatar user={users.get(l.userId)!} size="sm" />}
        <span>{l.cancelled ? `${who} cancelled this leave.` : c.kind === 'leaveSpace' ? `${who} is away.` : `${who} is on ${LEAVE_WORD[l.kind].toLowerCase()}.`}</span>
      </div>
      {cover && !l.cancelled && <p className="nib-line">{cover.id === meId ? 'You are covering.' : `For anything urgent, ask ${cover.displayName}.`}</p>}
      {l.note && <p className="nib-row-note" translate="no">{l.note}</p>}
      {cover && cover.id !== meId && <div className="nib-card-actions"><button className="btn ghost sm" onClick={() => writeTo(cover.id)}>{`Write to ${firstName(cover.displayName)}`}</button></div>}
    </Frame>
  );
}

function CoverCard({ c, users }: { c: Extract<NibCard, { kind: 'cover' }>; users: Map<string, PublicUser> }) {
  const toast = useToast();
  const l = c.leave;
  const who = users.get(l.userId)?.displayName ?? 'A colleague';
  const take = (itemId: string) => void window.dex.request('nib.cover.take', { leaveId: l.id, itemId }).then(() => { forgetCard('cover'); toast('On your day sheet'); }).catch((e: Error) => toast(e.message, true));
  return (
    <Frame kind="HANDOVER" title={l.from === l.to ? dayLabel(l.from) : `${dayLabel(l.from)} – ${dayLabel(l.to)}`} className="k-cover">
      <div className="nib-leave-line">{users.get(l.userId) && <Avatar user={users.get(l.userId)!} size="sm" />}<span>{`${who} is on leave, and you are covering.`}</span></div>
      {l.handover && <blockquote className="nib-handover" translate="no">{l.handover}</blockquote>}
      {c.items.length > 0 && (
        <ul className="nib-lines">
          {c.items.map((x) => (
            <li key={x.id} className={`s-${x.status}`}>
              <span className="nib-line-what"><span translate="no">{x.activity}</span><ProjectTag code={x.project} /></span>
              <ItemQty x={x} />
              {c.taken.includes(x.id) ? <span className="nib-seen mono"><Icon name="check" size={12} />ON YOUR SHEET</span> : <button className="btn ghost sm" onClick={() => take(x.id)}>Add to my day sheet</button>}
            </li>
          ))}
        </ul>
      )}
      <div className="nib-card-actions"><button className="btn ghost sm" onClick={() => writeTo(l.userId)}>{`Write to ${firstName(who)}`}</button></div>
    </Frame>
  );
}

const TOUR: Array<{ title: string; text: string; url: string }> = [
  { title: 'Pulse', text: 'What needs you, and the office at a glance.', url: 'dexconnect://pulse' },
  { title: 'Direct and Spaces', text: 'Conversations with people, and with teams and jobs.', url: 'dexconnect://conversation/' },
  { title: 'Desk', text: 'Your reminders, kept messages and bots.', url: 'dexconnect://desk' },
  { title: 'Calendar and Meet', text: 'Meetings, Rooms and the conference rooms.', url: 'dexconnect://calendar' },
  { title: 'Nib', text: 'Your day sheet, leave and the odd reminder. The tile beside yours.', url: 'nib' },
];
function JoinerCard({ c, users }: { c: Extract<NibCard, { kind: 'joiner' }>; users: Map<string, PublicUser> }) {
  const me = users.get(c.userId);
  return (
    <Frame kind="WELCOME" title={me ? firstName(me.displayName) : ''} className="k-joiner">
      <p className="nib-line">{me ? `Welcome to the office, ${firstName(me.displayName)}. I’m Nib. Five stops, and you know your way round.` : 'Welcome to the office. I’m Nib.'}</p>
      <ol className="nib-tour">
        {TOUR.map((t, i) => (
          <li key={t.title}>
            <span className="mono nib-tour-no">{String(i + 1).padStart(2, '0')}</span>
            <span className="nib-tour-main"><b>{t.title}</b><span className="faint">{t.text}</span></span>
            {t.url !== 'dexconnect://conversation/' && <button className="btn ghost sm" onClick={() => (t.url === 'nib' ? openTray() : go(t.url))}>Show me</button>}
          </li>
        ))}
      </ol>
      {c.meet.length > 0 && (
        <>
          <span className="label">People to meet</span>
          <div className="nib-people">
            {c.meet.map((id) => { const u = users.get(id); return u ? <button key={id} className="nib-person-chip" onClick={() => writeTo(id)}><Avatar user={u} size="sm" /><span translate="no">{u.displayName}</span>{u.title && <span className="faint" translate="no">{u.title}</span>}</button> : null; })}
          </div>
        </>
      )}
      <div className="nib-card-actions"><button className="btn sm" onClick={() => go('dexconnect://directory')}><Icon name="drawing" size={14} />See the office drawing</button></div>
    </Frame>
  );
}
function HelloCard() {
  return (
    <Frame kind="NIB" title="Hello" className="k-hello">
      <p className="nib-line">I’m Nib. I keep day sheets, leave notes and the odd reminder.</p>
      <ul className="nib-did">
        <li><Icon name="daysheet" size={14} /><span>Tell me what work came in, in plain words. I send your leads one tidy sheet.</span></li>
        <li><Icon name="calendar" size={14} /><span>Going on leave? One short note and I tell everyone who needs to know.</span></li>
        <li><Icon name="alarm" size={14} /><span>Ask me for reminders, your next meeting, who’s in, or where a drawing is.</span></li>
      </ul>
      <div className="nib-card-actions"><button className="btn primary sm" onClick={() => openTray()}>Open Nib</button></div>
    </Frame>
  );
}

function ReplyCard({ c, users }: { c: Extract<NibCard, { kind: 'reply' }>; users: Map<string, PublicUser> }) {
  const toast = useToast();
  const me = useNib((s) => s.me);
  const p = c.parse;
  const item = c.itemId ? me?.items.find((x) => x.id === c.itemId) : undefined;
  if (c.itemId) {
    const giver = p.giver?.id ? users.get(p.giver.id) : undefined;
    return (
      <Frame kind="NOTED" title={item ? dayLabel(item.date) : ''} className="k-reply">
        {item ? (
          <div className="nib-reply-item">
            {giver && <Avatar user={giver} size="sm" />}
            <span className="nib-line-what"><span translate="no">{item.activity}</span><ProjectTag code={item.project} /></span>
            <ItemQty x={item} />
          </div>
        ) : <p className="nib-line faint">That item is no longer on your sheet.</p>}
        {item && <p className="faint nib-fine">{giver ? `On your day sheet, from ${giver.displayName}.` : 'On your day sheet.'}</p>}
        {item && (
          <div className="nib-card-actions">
            <button className="btn ghost sm" onClick={() => openTray()}>Change</button>
            <button className="btn ghost sm" onClick={() => void window.dex.request('nib.item.delete', { id: item.id }).then(() => toast('Taken off your sheet')).catch((e: Error) => toast(e.message, true))}>Undo</button>
          </div>
        )}
      </Frame>
    );
  }
  const skill = p.intent;
  if (skill === 'nothing') return <Frame kind="NIB" title=""><p className="nib-line">Nothing today. Fair enough.</p></Frame>;
  return (
    <Frame kind="NIB" title="" className="k-reply">
      <p className="nib-line">{skill === 'leave' ? 'Going on leave? I’ll set it all up in one short note.' : skill === 'unknown' ? 'I didn’t catch any work in that. Try “got 6 GAs from Ravi for P-14”.' : 'Here’s what I can do with that.'}</p>
      <div className="nib-card-actions">
        <button className="btn sm" onClick={() => void act(p, c.text, toast)}>{skill === 'leave' ? 'Open the leave note' : skill === 'unknown' ? 'Open Nib' : 'Show me'}</button>
      </div>
    </Frame>
  );
}
