// The bot network sheet: every bot as an instrument tag on a drawing, the connections between
// them as routed lines (asks, handoffs, listening), each as heavy as the week's traffic along it,
// with a pulse running along a line as a message passes. Picking a line shows its recent
// exchanges and failures. For a maker: their own bots and the bots they connect to; for an
// administrator, also the whole office. The lines are also a ruled list under the drawing, for
// the keyboard and screen readers.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BotLinkKind, BotNetExchange, BotNetMap, Session } from '@dex/core';
import { Icon, Segmented, trapTab, useDialogFocus } from '../../ui.tsx';
import { formatDateTime } from '../../time.ts';
import { Tag, hopStamp } from './RelayCard.tsx';
import './net.css';

/** Names and data drawn in the SVG are not translated (the JSX runtime reads translate="no"). */
const NOTR = { translate: 'no' } as unknown as React.SVGProps<SVGTextElement>;

const COL = 196;
const ROW = 104;
const M = 46;
const pad = (n: number) => String(n).padStart(2, '0');
const KIND_WORD: Record<BotLinkKind, string> = { query: 'ASKS', handoff: 'HANDS TO', event: 'LISTENS' };
type Edge = BotNetMap['edges'][number];
const edgeKey = (e: Pick<Edge, 'from' | 'to'>) => `${e.from}>${e.to}`;

/** Places the bots in columns: those that only ask on the left, those that answer on the right. */
function layout(map: BotNetMap): { pos: Map<string, { x: number; y: number }>; w: number; h: number } {
  const rank = new Map<string, number>(map.nodes.map((n) => [n.key, 0]));
  const flow = map.edges.filter((e) => e.from !== e.to);
  for (let i = 0; i < map.nodes.length + 1; i++) {
    let moved = false;
    for (const e of flow) {
      const want = (rank.get(e.from) ?? 0) + 1;
      if ((rank.get(e.to) ?? 0) < want && want < 6) { rank.set(e.to, want); moved = true; }
    }
    if (!moved) break;
  }
  const top = Math.max(0, ...map.nodes.filter((n) => !n.system).map((n) => rank.get(n.key) ?? 0));
  for (const n of map.nodes) if (n.system) rank.set(n.key, top + 1);
  const cols = new Map<number, string[]>();
  for (const n of [...map.nodes].sort((a, b) => Number(b.mine) - Number(a.mine) || a.title.localeCompare(b.title))) {
    const r = rank.get(n.key) ?? 0;
    cols.set(r, [...(cols.get(r) ?? []), n.key]);
  }
  const used = [...cols.keys()].sort((a, b) => a - b);
  const pos = new Map<string, { x: number; y: number }>();
  let rows = 1;
  used.forEach((r, ci) => {
    const list = cols.get(r)!;
    rows = Math.max(rows, list.length);
    list.forEach((k, i) => pos.set(k, { x: M + 40 + ci * COL, y: M + 34 + i * ROW }));
  });
  return { pos, w: M * 2 + 40 + Math.max(1, used.length) * COL - 40, h: M * 2 + 40 + rows * ROW };
}

/** A routed line between two tags: out of the right side, along a channel, into the left side, with rounded bends. */
function route(a: { x: number; y: number }, b: { x: number; y: number }, lane: number, bottom: number): string {
  const r = 6;
  if (b.x > a.x + 30) {
    const cx = (a.x + b.x) / 2 + lane * 7;
    const sx = a.x + 22; const ex = b.x - 22;
    if (Math.abs(a.y - b.y) < 2) return `M${sx} ${a.y}H${ex}`;
    const dy = Math.sign(b.y - a.y);
    return `M${sx} ${a.y}H${cx - r}Q${cx} ${a.y} ${cx} ${a.y + dy * r}V${b.y - dy * r}Q${cx} ${b.y} ${cx + r} ${b.y}H${ex}`;
  }
  // back along the drawing: down under the tags, along the bottom, up into the other
  const yb = bottom + lane * 7;
  const dx = Math.sign(b.x - a.x) || 1;
  return `M${a.x} ${a.y + 22}V${yb - r}Q${a.x} ${yb} ${a.x + dx * r} ${yb}H${b.x - dx * r}Q${b.x} ${yb} ${b.x} ${yb - r}V${b.y + 22}`;
}

export default function NetworkSheet({ session, scope: first, onClose }: { session: Session; scope: 'mine' | 'office'; onClose: () => void }) {
  const box = useRef<HTMLElement>(null);
  useDialogFocus(box, false);
  const admin = session.me.role === 'owner' || session.me.role === 'admin';
  const [scope, setScope] = useState<'mine' | 'office'>(admin ? first : 'mine');
  const [map, setMap] = useState<BotNetMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [ex, setEx] = useState<BotNetExchange[] | null>(null);
  const [pulses, setPulses] = useState<Array<{ id: number; key: string }>>([]);
  const seq = useRef(0);
  const load = useCallback(() => { void window.dex.request('botnet.map', { scope }).then((m) => { setMap(m); setError(null); }).catch((e: Error) => setError(e.message)); }, [scope]);
  useEffect(() => { load(); }, [load]);
  // live: a pulse runs along the line, and the weights catch up a moment later
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = window.dex.onHubEvent((name, d) => {
      if (name !== 'botnet.pulse') return;
      const p = d as { from: string; to: string };
      const id = ++seq.current;
      setPulses((list) => [...list.slice(-12), { id, key: edgeKey(p) }]);
      setTimeout(() => setPulses((list) => list.filter((x) => x.id !== id)), 1800);
      if (t) clearTimeout(t);
      t = setTimeout(load, 900);
    });
    return () => { off(); if (t) clearTimeout(t); };
  }, [load]);
  useEffect(() => {
    if (!sel) { setEx(null); return; }
    const [from, to] = sel.split('>');
    setEx(null);
    void window.dex.request('botnet.edge', { from, to, scope }).then((r) => setEx(r.exchanges)).catch((e: Error) => setError(e.message));
  }, [sel, scope]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); if (sel) setSel(null); else onClose(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [sel, onClose]);

  const lay = useMemo(() => (map ? layout(map) : null), [map]);
  const title = (k: string) => map?.nodes.find((n) => n.key === k)?.title ?? k;
  const week = map?.edges.reduce((n, e) => n + e.count, 0) ?? 0;
  const fails = map?.edges.reduce((n, e) => n + e.failures, 0) ?? 0;
  const today = new Date();
  const drawingNo = `BN-${String(today.getFullYear()).slice(2)}${pad(today.getMonth() + 1)}${pad(today.getDate())}`;
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const selEdge = map?.edges.find((e) => edgeKey(e) === sel) ?? null;
  const kindOf = (e: Edge): BotLinkKind => (e.kinds.includes('handoff') ? 'handoff' : e.kinds.includes('query') ? 'query' : 'event');

  return createPortal(
    <div className="sheet-scrim net-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside ref={box} tabIndex={-1} className="net-sheet" role="dialog" aria-modal="true" aria-label="Bot network" onKeyDown={trapTab}>
        <header className="net-tb">
          <div className="net-tb-mark"><Icon name="branch" size={24} /></div>
          <div className="net-tb-name">
            <span className="net-cap">{scope === 'office' ? 'Drawing · the office' : 'Drawing · your bots'}</span>
            <h2>Bot network</h2>
          </div>
          {map && (
            <dl className="net-tb-cells">
              <div><dt className="net-cap">Bots</dt><dd>{map.nodes.length}</dd></div>
              <div><dt className="net-cap">Lines</dt><dd>{map.edges.length}</dd></div>
              <div><dt className="net-cap">This week</dt><dd>{week}</dd></div>
              <div><dt className="net-cap">No.</dt><dd translate="no">{drawingNo}</dd></div>
            </dl>
          )}
          <div className="net-tb-actions">
            {admin && <Segmented<'mine' | 'office'> label="Show" value={scope} onChange={(s) => { setScope(s); setSel(null); }} options={[{ value: 'mine', label: 'My bots' }, { value: 'office', label: 'The office' }]} />}
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)"><Icon name="x" size={18} /></button>
          </div>
        </header>
        <div className="net-body">
          <div className="net-main">
            <ul className="net-legend" aria-label="Key">
              <li><svg width="34" height="10" aria-hidden="true"><path d="M1 5H33" stroke="currentColor" fill="none" /><circle cx="11" cy="5" r="1.8" fill="var(--layer-solid)" stroke="currentColor" /><circle cx="22" cy="5" r="1.8" fill="var(--layer-solid)" stroke="currentColor" /></svg>Asks a question</li>
              <li><svg width="34" height="10" aria-hidden="true"><path d="M1 5H31M27 1.5 31 5l-4 3.5" stroke="currentColor" fill="none" /></svg>Hands a request over</li>
              <li><svg width="34" height="10" aria-hidden="true"><path d="M1 5H33" stroke="currentColor" fill="none" strokeDasharray="7 3 1.5 3" /></svg>Listens for</li>
              <li><svg width="34" height="10" aria-hidden="true"><path d="M1 5H33" stroke="currentColor" strokeWidth="4" fill="none" /></svg>Heavier: more this week</li>
            </ul>
            {error && <div className="flow-err" role="alert">{error}</div>}
            {!map && !error && <div className="tl-more"><span className="spinner" /></div>}
            {map && !map.nodes.length && (
              <div className="net-empty"><Icon name="branch" size={22} /><span>None of your bots talks to another yet. In the bot maker, a question can ask another bot, and the end can hand the request on.</span></div>
            )}
            {map && lay && map.nodes.length > 0 && (
              <div className="nw-wrap">
                <svg className="nw-svg" viewBox={`0 0 ${lay.w} ${lay.h}`} role="group" aria-label={`${map.nodes.length} bots, ${map.edges.length} connections`}>
                  <rect x={12} y={12} width={lay.w - 24} height={lay.h - 24} className="nw-frame" />
                  <rect x={22} y={22} width={lay.w - 44} height={lay.h - 44} className="nw-frame heavy" />
                  {Array.from({ length: Math.max(1, Math.floor((lay.w - 44) / COL)) }, (_x, i) => <text key={`c${i}`} x={22 + COL / 2 + i * COL} y={19} textAnchor="middle" className="nw-ref">{String.fromCharCode(65 + i)}</text>)}
                  {Array.from({ length: Math.max(1, Math.floor((lay.h - 44) / ROW)) }, (_x, i) => <text key={`r${i}`} x={17} y={22 + ROW / 2 + i * ROW} textAnchor="middle" className="nw-ref">{i + 1}</text>)}
                  {map.edges.map((e, i) => {
                    const a = lay.pos.get(e.from); const b = lay.pos.get(e.to);
                    if (!a || !b) return null;
                    const k = kindOf(e);
                    const d = route(a, b, (i % 5) - 2, lay.h - M - 4);
                    const weight = 1.1 + Math.min(4, Math.log2(e.count + 1));
                    const key = edgeKey(e);
                    const live = pulses.filter((p) => p.key === key);
                    const id = `nw-e${i}`;
                    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
                    return (
                      <g key={key} className={`nw-edge ${k}${e.count ? '' : ' quiet'}${sel === key ? ' sel' : ''}`} tabIndex={0} role="button"
                        aria-label={`${title(e.from)} ${KIND_WORD[k].toLowerCase()} ${title(e.to)}: ${e.count} this week${e.failures ? `, ${e.failures} failed` : ''}`}
                        aria-pressed={sel === key} onClick={() => setSel(sel === key ? null : key)} onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setSel(sel === key ? null : key); } }}>
                        <path d={d} className="nw-hit" />
                        <path d={d} id={id} className="nw-line" style={{ strokeWidth: weight }} />
                        {k === 'handoff' && <path d={`M${b.x - 30} ${b.y - 4.5}l6 4.5l-6 4.5`} className="nw-line" style={{ strokeWidth: 1.4 }} />}
                        {k === 'query' && b.x > a.x + 30 && <><circle cx={a.x + 32} cy={a.y} r={2.2} className="nw-dots" /><circle cx={b.x - 34} cy={b.y} r={2.2} className="nw-dots" /></>}
                        {e.count > 0 && <text x={b.x > a.x + 30 ? (a.x + b.x) / 2 + ((i % 5) - 2) * 7 + 5 : mid.x} y={b.x > a.x + 30 ? Math.min(a.y, b.y) + (Math.abs(a.y - b.y) < 2 ? -6 : Math.abs(a.y - b.y) / 2) : lay.h - M + 8} className="nw-count">{e.count}</text>}
                        {e.failures > 0 && (
                          <g className="nw-fail" transform={`translate(${b.x - 52} ${b.y + (Math.abs(a.y - b.y) < 2 ? 6 : -16)})`}>
                            <rect width={22} height={11} />
                            <text x={11} y={8.5} textAnchor="middle">{`!${e.failures}`}</text>
                          </g>
                        )}
                        {!reduced && live.map((p) => (
                          <circle key={p.id} r={4.5} className="nw-pulse">
                            <animateMotion dur="1.5s" fill="freeze"><mpath href={`#${id}`} /></animateMotion>
                          </circle>
                        ))}
                      </g>
                    );
                  })}
                  {map.nodes.map((n, i) => {
                    const p = lay.pos.get(n.key)!;
                    const sub = n.system ? 'SYSTEM' : n.mine ? 'YOURS' : n.scopeOf === 'office' ? 'OFFICE' : n.scopeOf === 'space' ? 'SPACE' : 'PRIVATE';
                    return (
                      <g key={n.key} className={`nw-node${n.mine ? ' mine' : ''}`} tabIndex={-1} aria-label={`${n.title}, ${sub.toLowerCase()}`}>
                        <rect x={p.x - 66} y={p.y + 26} width={132} height={30} className="nw-plate" />
                        <Tag t={n} x={p.x} y={p.y} n={i + 1} r={20} />
                        <text x={p.x} y={p.y + 39} textAnchor="middle" className="nw-title" {...NOTR}>{n.title.length > 22 ? `${n.title.slice(0, 21)}…` : n.title}</text>
                        <text x={p.x} y={p.y + 51} textAnchor="middle" className="nw-sub">{sub}</text>
                      </g>
                    );
                  })}
                  <g transform={`translate(${lay.w - 210} ${lay.h - 46})`}>
                    <rect width={186} height={22} className="nw-tb-box" />
                    <text x={8} y={14} className="nw-tb">{`BOT NETWORK · ${drawingNo}`}</text>
                  </g>
                </svg>
              </div>
            )}
            {map && map.edges.length > 0 && (
              <ul className="nw-list" aria-label="Connections">
                {map.edges.map((e) => (
                  <li key={edgeKey(e)}>
                    <button type="button" aria-pressed={sel === edgeKey(e)} onClick={() => setSel(sel === edgeKey(e) ? null : edgeKey(e))}>
                      <span className="nw-kind">{KIND_WORD[kindOf(e)]}</span>
                      <span><b translate="no">{title(e.from)}</b><span aria-hidden="true">{' → '}</span><b translate="no">{title(e.to)}</b></span>
                      <span className="mono faint">{e.failures ? `${e.count} · ${e.failures} failed` : e.declared && !e.count ? 'Not used yet' : `${e.count} this week`}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <aside className="net-side" aria-label="Along the line">
            {!selEdge && (
              <>
                <span className="net-cap">Along a line</span>
                <p className="faint" style={{ margin: '6px 0 0' }}>Pick a line on the drawing, or in the list, to see what passed along it this week and what failed.</p>
                {map && <p className="mono" style={{ margin: '12px 0 0', fontSize: 12 }}>{fails ? `${week} messages · ${fails} failed` : `${week} messages this week`}</p>}
              </>
            )}
            {selEdge && (
              <>
                <span className="net-cap">{KIND_WORD[kindOf(selEdge)]}</span>
                <h3 style={{ margin: '4px 0 0', font: '600 15px var(--font-display)' }}><span translate="no">{title(selEdge.from)}</span>{' → '}<span translate="no">{title(selEdge.to)}</span></h3>
                <p className="faint mono" style={{ margin: '4px 0 0', fontSize: 11 }}>{selEdge.lastAt ? `Last: ${formatDateTime(selEdge.lastAt, { weekday: 'short', day: 'numeric', month: 'short' })}` : 'Not used yet'}</p>
                {!ex && <div className="tl-more"><span className="spinner" /></div>}
                {ex && !ex.length && <p className="faint">Nothing has passed along it yet.</p>}
                {ex && ex.length > 0 && (
                  <ol className="nw-ex" aria-label="Recent exchanges">
                    {ex.map((x) => {
                      const hop = { ...x, from: '', to: '', back: null, ref: null, canRetry: false };
                      const ok = x.status === 'ok' || x.status === 'returned';
                      return (
                        <li key={x.id}>
                          <span className="mono faint">{formatDateTime(x.at, { day: 'numeric', month: 'short' })}</span>
                          {x.userId ? <span className="faint" translate="no">{session.users.find((u) => u.id === x.userId)?.displayName ?? ''}</span> : <span />}
                          <span className={`rl-mini-stamp ${ok ? 'ok' : x.status === 'pending' ? 'wait' : 'bad'}`}>{hopStamp(hop)}</span>
                          <span className="nw-ex-ask" translate="no">{x.ask}</span>
                          <span className="nw-ex-res">{x.answer ? <span translate="no">{x.answer}</span> : x.reason ? <span>{x.reason}</span> : null}{x.ms !== null ? <span className="mono faint">{` · ${x.ms} ms`}</span> : null}</span>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </>
            )}
          </aside>
        </div>
      </aside>
    </div>,
    document.body,
  );
}
