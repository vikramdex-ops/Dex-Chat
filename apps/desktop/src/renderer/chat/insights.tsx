// Reaction insights: what a message's reactions show, drawn as small ruled charts in SVG.
// Distribution (horizontal bars with exact counts), who reacted / read without reacting / has not
// read (one stacked bar), a cumulative timeline, departments, and for announcements the response
// rate against the office's average. Every chart has one axis, labels on the marks, a legend when
// there is more than one series, a hover readout, and the same numbers as a table. The note that
// reactions are not approvals stays at the top.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactionInsights } from '@dex/core';
import { Dialog, Icon, useToast } from '../ui.tsx';
import { EmojiGlyph } from '../emoji.tsx';
import './messages.css';

/** The chart's own width, for drawing in real pixels (text stays its size on a phone). */
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(560);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth || 560);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setW(el.clientWidth || 560));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Round axis ticks: 0, 1, 2… or 0, 5, 10… up to at least `max`. */
export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const s = Math.max(1, step);
  const top = Math.ceil(max / s) * s;
  const out: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += s) out.push(Math.round(v));
  return out;
}

const pct = (n: number) => `${Math.round(n)}%`;
const at = (t: number) => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const shortAt = (t: number, span: number) => new Date(t).toLocaleString([], span > 36 * 3600_000 ? { day: 'numeric', month: 'short' } : { hour: '2-digit', minute: '2-digit' });

/** A bar path: square at the baseline, a 4 px round end at the data end (r shrinks for tiny bars). */
function barPath(x: number, y: number, w: number, h: number): string {
  if (w <= 0) return '';
  const r = Math.min(4, w, h / 2);
  return `M${x} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h - r}Q${x + w} ${y + h} ${x + w - r} ${y + h}H${x}Z`;
}

/** The floating readout for the mark under the pointer or in focus. */
function Readout({ tip }: { tip: { x: number; y: number; value: string; label: string } | null }) {
  if (!tip) return null;
  return <div className="ri-tip" style={{ left: tip.x, top: tip.y }} role="status"><b>{tip.value}</b><span>{tip.label}</span></div>;
}
type Tip = { x: number; y: number; value: string; label: string } | null;

// ------------------------------------------------------------------ charts
function HBars({ rows, max, unit, label }: { rows: Array<{ key: string; head: React.ReactNode; value: number; text: string; tip: string }>; max: number; unit: (v: number) => string; label: string }) {
  const [ref, w] = useWidth();
  const [tip, setTip] = useState<Tip>(null);
  const LEFT = 96;
  const RIGHT = 96;
  const ROW = 30;
  const BAR = 16;
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const plot = Math.max(80, w - LEFT - RIGHT);
  const h = rows.length * ROW + 26;
  const x = (v: number) => LEFT + (v / top) * plot;
  return (
    <div ref={ref} className="ri-chart">
      <div className="ri-heads" style={{ width: LEFT - 10 }} aria-hidden="true">
        {rows.map((r) => <div key={r.key} className="ri-head" style={{ height: ROW }}>{r.head}</div>)}
      </div>
      <svg width={w} height={h} role="img" aria-label={label} onPointerLeave={() => setTip(null)}>
        {ticks.map((t) => <line key={t} className="ri-grid" x1={x(t)} x2={x(t)} y1={0} y2={rows.length * ROW} />)}
        <line className="ri-axis" x1={LEFT} x2={LEFT} y1={0} y2={rows.length * ROW} />
        {rows.map((r, i) => {
          const y = i * ROW + (ROW - BAR) / 2;
          const bw = Math.max(r.value > 0 ? 2 : 0, x(r.value) - LEFT);
          const show = () => setTip({ x: Math.min(w - 140, LEFT + bw + 8), y: y - 6, value: r.text, label: r.tip });
          return (
            <g key={r.key} className="ri-mark" tabIndex={0} aria-label={`${r.tip}: ${r.text}`} onPointerMove={show} onFocus={show} onBlur={() => setTip(null)}>
              <rect className="ri-hit" x={LEFT} y={i * ROW} width={plot + RIGHT} height={ROW} />
              <path className="ri-bar s1" d={barPath(LEFT, y, bw, BAR)} />
              <text className="ri-val" x={LEFT + bw + 6} y={y + BAR / 2} dominantBaseline="central">{r.text}</text>
            </g>
          );
        })}
        {ticks.map((t) => <text key={t} className="ri-tick" x={x(t)} y={rows.length * ROW + 16} textAnchor="middle">{unit(t)}</text>)}
      </svg>
      <Readout tip={tip} />
    </div>
  );
}

const AUDIENCE = [
  { key: 'reacted', label: 'Reacted', cls: 's1' },
  { key: 'seen', label: 'Read, no reaction', cls: 's2' },
  { key: 'notSeen', label: 'Not read yet', cls: 's3' },
  { key: 'unknown', label: 'Unknown (receipts off)', cls: 's4' },
] as const;

function AudienceBar({ a }: { a: ReactionInsights['audience'] }) {
  const [ref, w] = useWidth();
  const [tip, setTip] = useState<Tip>(null);
  const values: Record<(typeof AUDIENCE)[number]['key'], number> = a.receipts
    ? { reacted: a.reacted, seen: a.seenNoReaction, notSeen: a.notSeen, unknown: a.unknown }
    : { reacted: a.reacted, seen: 0, notSeen: 0, unknown: a.members - a.reacted };
  const parts = AUDIENCE.filter((p) => values[p.key] > 0);
  const total = Math.max(1, a.members);
  const H = 28;
  const GAP = 2;
  let x0 = 0;
  const usable = w - GAP * Math.max(0, parts.length - 1);
  return (
    <div className="ri-audience">
      <div ref={ref} className="ri-chart">
        <svg width={w} height={H} role="img" aria-label={`Of ${a.members} members: ${parts.map((p) => `${values[p.key]} ${p.label.toLowerCase()}`).join(', ')}`} onPointerLeave={() => setTip(null)}>
          {parts.map((p) => {
            const pw = (values[p.key] / total) * usable;
            const x = x0;
            x0 += pw + GAP;
            const share = pct((values[p.key] / total) * 100);
            const fits = pw > share.length * 7.5 + 12;
            const show = () => setTip({ x: Math.min(w - 150, x + 4), y: H + 6, value: `${values[p.key]} · ${share}`, label: p.label });
            return (
              <g key={p.key} className="ri-mark" tabIndex={0} aria-label={`${p.label}: ${values[p.key]} (${share})`} onPointerMove={show} onFocus={show} onBlur={() => setTip(null)}>
                <rect className={`ri-seg ${p.cls}`} x={x} y={0} width={Math.max(1, pw)} height={H} rx={4} />
                {fits && <text className={`ri-in ${p.cls}`} x={x + 8} y={H / 2} dominantBaseline="central">{share}</text>}
              </g>
            );
          })}
        </svg>
        <Readout tip={tip} />
      </div>
      <ul className="ri-legend" aria-label="Legend">
        {parts.map((p) => <li key={p.key}><i className={`ri-key ${p.cls}`} aria-hidden="true" />{p.label}<b className="mono">{values[p.key]}</b></li>)}
      </ul>
      {!a.receipts && <p className="faint ri-small">Read receipts cannot be shown here (yours are off, or this is a side-track reply), so only reactions are counted.</p>}
    </div>
  );
}

function Timeline({ t, firstAt }: { t: ReactionInsights['timeline']; firstAt: number | null }) {
  const [ref, w] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const b = t.buckets;
  if (!b.length || !firstAt) return <p className="faint ri-small">No reactions yet.</p>;
  const L = 34;
  const R = 44;
  const T = 10;
  const H = 150;
  const B = 24;
  const max = Math.max(...b.map((x) => x.cumulative), 1);
  const ticks = niceTicks(max, 3);
  const top = ticks[ticks.length - 1] || 1;
  const t0 = b[0].start;
  const t1 = b[b.length - 1].start + t.bucketMs;
  const span = Math.max(1, t1 - t0);
  const x = (time: number) => L + ((time - t0) / span) * (w - L - R);
  const y = (v: number) => T + (1 - v / top) * (H - T - B);
  // steps: the count holds until the next bucket
  let d = `M${x(t0)} ${y(0)}`;
  for (const k of b) d += `V${y(k.cumulative)}H${x(k.start + t.bucketMs)}`;
  const area = `${d}V${y(0)}Z`;
  const last = b[b.length - 1];
  const hb = hover === null ? null : b[hover];
  const timeTicks = [t0, t0 + span / 2, t1];
  return (
    <div ref={ref} className="ri-chart">
      <svg width={w} height={H} role="img" aria-label={`Reactions added over time, reaching ${last.cumulative}`}
        onPointerMove={(e) => {
          const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const tm = t0 + ((e.clientX - box.left - L) / (w - L - R)) * span;
          setHover(Math.max(0, Math.min(b.length - 1, Math.floor((tm - t0) / t.bucketMs))));
        }} onPointerLeave={() => setHover(null)}>
        {ticks.map((v) => <g key={v}><line className="ri-grid" x1={L} x2={w - R} y1={y(v)} y2={y(v)} /><text className="ri-tick" x={L - 6} y={y(v)} textAnchor="end" dominantBaseline="central">{v}</text></g>)}
        <line className="ri-axis" x1={L} x2={w - R} y1={y(0)} y2={y(0)} />
        <path className="ri-area" d={area} />
        <path className="ri-line" d={d} />
        <circle className="ri-dot" cx={x(t1)} cy={y(last.cumulative)} r={4} />
        <text className="ri-val" x={x(t1) + 8} y={y(last.cumulative)} dominantBaseline="central">{last.cumulative}</text>
        {timeTicks.map((tm, i) => <text key={i} className="ri-tick" x={x(tm)} y={H - 6} textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}>{shortAt(tm, span)}</text>)}
        {hb && <line className="ri-cross" x1={x(hb.start + t.bucketMs / 2)} x2={x(hb.start + t.bucketMs / 2)} y1={T} y2={y(0)} />}
      </svg>
      {hb && (
        <div className="ri-tip" style={{ left: Math.min(w - 170, x(hb.start)), top: 0 }} role="status">
          <b>{hb.cumulative} in all</b><span>+{hb.added}{hb.removed ? ` · −${hb.removed}` : ''} · {shortAt(hb.start, span)}</span>
        </div>
      )}
    </div>
  );
}

function Announcement({ a }: { a: NonNullable<ReactionInsights['announcement']> }) {
  const [ref, w] = useWidth();
  const L = 0;
  const H = 46;
  const BAR = 18;
  const x = (v: number) => L + (v / 100) * (w - 40);
  const avg = a.officeAverage;
  return (
    <div>
      <div ref={ref} className="ri-chart">
        <svg width={w} height={H} role="img" aria-label={`This announcement ${pct(a.responseRate)}${avg !== null ? `, office average ${pct(avg)}` : ''}`}>
          {[0, 25, 50, 75, 100].map((v) => <g key={v}><line className="ri-grid" x1={x(v)} x2={x(v)} y1={0} y2={BAR + 6} /><text className="ri-tick" x={x(v)} y={H - 4} textAnchor={v === 0 ? 'start' : v === 100 ? 'end' : 'middle'}>{v}%</text></g>)}
          <path className="ri-bar s1" d={barPath(L, 3, Math.max(2, x(a.responseRate) - L), BAR)}><title>{`This announcement: ${pct(a.responseRate)}`}</title></path>
          {avg !== null && <line className="ri-ref" x1={x(avg)} x2={x(avg)} y1={0} y2={BAR + 6}><title>{`Office average: ${pct(avg)}`}</title></line>}
          <text className="ri-val" x={Math.min(w - 36, x(a.responseRate) + 6)} y={3 + BAR / 2} dominantBaseline="central">{pct(a.responseRate)}</text>
        </svg>
      </div>
      <ul className="ri-legend" aria-label="Legend">
        <li><i className="ri-key s1" aria-hidden="true" />This announcement<b className="mono">{pct(a.responseRate)}</b></li>
        {avg !== null
          ? <li><i className="ri-key ref" aria-hidden="true" />Office average, last 90 days<b className="mono">{pct(avg)}</b><span className="faint"> · {a.compared} compared</span></li>
          : <li className="faint">No other announcements in the last 90 days to compare with.</li>}
      </ul>
    </div>
  );
}

function Tables({ r }: { r: ReactionInsights }) {
  return (
    <div className="ri-tables">
      <table className="dr-table"><caption className="label">Stamps</caption><thead><tr><th scope="col">Stamp</th><th scope="col">Count</th><th scope="col">Share</th></tr></thead>
        <tbody>{r.distribution.map((x) => <tr key={x.emoji}><td><EmojiGlyph emoji={x.emoji} size={16} /></td><td className="mono">{x.count}</td><td className="mono">{pct(x.percent)}</td></tr>)}</tbody></table>
      <table className="dr-table"><caption className="label">Members</caption><tbody>
        <tr><th scope="row">Members</th><td className="mono">{r.audience.members}</td></tr>
        <tr><th scope="row">Reacted</th><td className="mono">{r.audience.reacted} · {pct(r.audience.reactedPercent)}</td></tr>
        {r.audience.receipts && <><tr><th scope="row">Read, no reaction</th><td className="mono">{r.audience.seenNoReaction} · {pct(r.audience.seenNoReactionPercent)}</td></tr>
          <tr><th scope="row">Not read yet</th><td className="mono">{r.audience.notSeen}</td></tr><tr><th scope="row">Unknown</th><td className="mono">{r.audience.unknown}</td></tr></>}
      </tbody></table>
      {r.byDepartment && <table className="dr-table"><caption className="label">Departments</caption><thead><tr><th scope="col">Department</th><th scope="col">Reacted</th><th scope="col">Share</th></tr></thead>
        <tbody>{r.byDepartment.map((x) => <tr key={x.departmentId ?? 'none'}><td translate="no">{x.name}</td><td className="mono">{x.reacted} of {x.members}</td><td className="mono">{pct(x.percent)}</td></tr>)}</tbody></table>}
      {r.timeline.buckets.length > 0 && <table className="dr-table"><caption className="label">Over time</caption><thead><tr><th scope="col">From</th><th scope="col">Added</th><th scope="col">Removed</th><th scope="col">In all</th></tr></thead>
        <tbody>{r.timeline.buckets.filter((x) => x.added || x.removed).map((x) => <tr key={x.start}><td className="mono">{at(x.start)}</td><td className="mono">{x.added}</td><td className="mono">{x.removed}</td><td className="mono">{x.cumulative}</td></tr>)}</tbody></table>}
    </div>
  );
}

// ------------------------------------------------------------------ the panel
export function ReactionInsightsPanel({ messageId, onClose }: { messageId: string; onClose: () => void }) {
  const toast = useToast();
  const [r, setR] = useState<ReactionInsights | null>(null);
  const [table, setTable] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () => void window.dex.request('reactions.insights', { messageId }).then((v) => { if (live) setR(v); }).catch((e: Error) => { if (live) { toast(e.message, true); onClose(); } });
    load();
    // stamps added while the panel is open show at once
    const off = window.dex.onHubEvent((name, data) => { if (name === 'msg.updated' && (data as { id?: string }).id === messageId) load(); });
    return () => { live = false; off(); };
  }, [messageId]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog title="Reaction insights" onClose={onClose}>
      <div className="ri-note" role="note"><Icon name="warning" size={14} /><b>{r?.note ?? 'Reactions are not approvals'}</b><span>A stamp shows how people felt, not that they agreed to anything. Ask for a Decision when you need an answer.</span></div>
      {!r ? <div className="tl-more"><span className="spinner" /></div> : (
        <div className="ri-body">
          <dl className="title-block ri-block" aria-label="In short">
            <div><dt>Stamps</dt><dd>{r.total}</dd></div>
            <div><dt>People</dt><dd>{r.people}</dd></div>
            <div><dt>First</dt><dd>{r.firstAt ? at(r.firstAt) : '—'}</dd></div>
            <div><dt>Latest</dt><dd>{r.lastAt ? at(r.lastAt) : '—'}</dd></div>
          </dl>
          <div className="ri-view">
            <button className={`lbtn${table ? '' : ' on'}`} aria-pressed={!table} onClick={() => setTable(false)}><Icon name="insight" size={13} />Charts</button>
            <button className={`lbtn${table ? ' on' : ''}`} aria-pressed={table} onClick={() => setTable(true)}><Icon name="rows" size={13} />Table</button>
          </div>
          {table ? <Tables r={r} /> : (
            <>
              <section className="ri-sheet"><h3 className="label">Stamps · distribution</h3>
                {r.distribution.length ? <HBars label="Stamps by count" max={Math.max(...r.distribution.map((x) => x.count))} unit={(v) => String(v)}
                  rows={r.distribution.map((x) => ({ key: x.emoji, head: <EmojiGlyph emoji={x.emoji} size={18} />, value: x.count, text: `${x.count} · ${pct(x.percent)}`, tip: `Stamp ${x.emoji}` }))} /> : <p className="faint ri-small">No stamps yet.</p>}
              </section>
              <section className="ri-sheet"><h3 className="label">Members · {r.audience.members}</h3><AudienceBar a={r.audience} /></section>
              <section className="ri-sheet"><h3 className="label">Stamps over time · in all</h3><Timeline t={r.timeline} firstAt={r.firstAt} /></section>
              {r.byDepartment && r.byDepartment.length > 0 && (
                <section className="ri-sheet"><h3 className="label">By department · share who reacted</h3>
                  <HBars label="Share of each department who reacted" max={100} unit={(v) => `${v}%`}
                    rows={r.byDepartment.map((x) => ({ key: x.departmentId ?? 'none', head: <span className="ri-dept" title={x.name} translate="no">{x.name}</span>, value: x.percent, text: `${x.reacted}/${x.members} · ${pct(x.percent)}`, tip: x.name }))} />
                </section>
              )}
              {r.announcement && <section className="ri-sheet"><h3 className="label">Announcement · response rate</h3><Announcement a={r.announcement} /></section>}
              {r.anonymous && <p className="faint ri-small">An anonymous poll: only counts are shown, never who.</p>}
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}
