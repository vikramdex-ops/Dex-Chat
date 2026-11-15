// The relay card: bots asking and handing to each other for this person, drawn as a small loop
// diagram. Each bot is an instrument tag (the ISA bubble the Meet page's readiness tags use: its
// letters above the bar, its loop number below), the hops are signal lines between them, and a
// pulse runs along a line and back as a question is asked and answered (or a request is handed
// over and comes back). Each hop is labelled with what was asked or handed over, and stamped
// (ANSWERED, HANDED, BACK, REFUSED, STOPPED). Below the drawing the same hops are a ruled
// schedule, which is what a screen reader reads. Reduced motion: the pulse does not travel.
import { useEffect, useMemo, useState } from 'react';
import type { BotHop, BotRelayView, BotTag } from '@dex/core';
import { BOT_COLOURS } from '@dex/core';
import { Icon } from '../../ui.tsx';
import { chatState } from '../../chat/store.ts';
import { formatTime } from '../../time.ts';
import { trLine } from './words.ts';
import './net.css';

/** Names and data drawn in the SVG are not translated (the JSX runtime reads translate="no"). */
const NOTR = { translate: 'no' } as unknown as React.SVGProps<SVGTextElement>;

const pad = (n: number) => String(n).padStart(2, '0');
/** Hops this window has already seen travel (a card drawn again does not pulse again). */
const seen = new Set<string>();
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The stamp for a hop, in capitals on the drawing. */
export function hopStamp(h: BotHop): string {
  if (h.status === 'returned') return 'BACK';
  if (h.status === 'pending') return h.kind === 'handoff' ? 'HANDING' : 'ASKING';
  if (h.status === 'ok') return h.kind === 'handoff' ? 'HANDED' : h.kind === 'event' ? 'HEARD' : 'ANSWERED';
  if (h.status === 'refused') return 'REFUSED';
  if (h.status === 'loop') return 'STOPPED';
  if (h.status === 'limited') return 'SLOWED';
  if (h.status === 'timeout') return 'NO ANSWER';
  return 'FAILED';
}
const good = (h: BotHop) => h.status === 'ok' || h.status === 'returned';
/** The caption of a hop ("SEAT?") and its data ("CAESAR II"). */
const split = (ask: string) => { const i = ask.indexOf(' · '); return i < 0 ? { cap: ask, data: '' } : { cap: ask.slice(0, i), data: ask.slice(i + 3) }; };

/** One bot as an instrument tag. */
export function Tag({ t, x, y, n, r = 18, live }: { t: BotTag; x: number; y: number; n: number; r?: number; live?: boolean }) {
  const fill = t.colour ? BOT_COLOURS[t.colour] : null;
  return (
    <g className={`rl-tag${t.system ? ' sys' : ''}${live ? ' live' : ''}`} transform={`translate(${x} ${y})`}>
      {fill && <rect x={-r - 2} y={-r - 2} width={6} height={6} fill={fill} className="rl-swatch" />}
      <circle r={r} className="rl-bub" />
      <line x1={-r} y1={0} x2={r} y2={0} className="rl-mid" />
      <text y={-5} className="rl-tl" textAnchor="middle" {...NOTR}>{t.tag}</text>
      <text y={11} className="rl-tn" textAnchor="middle" {...NOTR}>{'B-' + pad(n)}</text>
    </g>
  );
}

const W = 156; // room for one bot
const H = 116;

export function RelayDiagram({ v, compact }: { v: BotRelayView; compact?: boolean }) {
  const [, setTick] = useState(0);
  const pos = useMemo(() => new Map(v.tags.map((t, i) => [t.key, i])), [v.tags]);
  const width = Math.max(2, v.tags.length) * W;
  const cy = 46;
  const x = (k: string) => W / 2 + (pos.get(k) ?? 0) * W;
  // pulses only for hops this window has not seen yet, and not long ago
  const fresh = v.hops.filter((h) => !seen.has(`${h.id}:${h.status}`) && Date.now() - h.at < 20_000 && !reduced());
  useEffect(() => {
    if (!fresh.length) return;
    const t = setTimeout(() => { for (const h of fresh) seen.add(`${h.id}:${h.status}`); setTick((n) => n + 1); }, 2600);
    return () => clearTimeout(t);
  }, [fresh.map((h) => `${h.id}:${h.status}`).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  // the newest hop between each pair is the one labelled on the line
  const last = new Map<string, BotHop>();
  for (const h of v.hops) last.set([h.from, h.to].sort().join('|'), h);
  const lines = [...last.values()];
  const words = v.hops.map((h) => `${v.tags.find((t) => t.key === h.from)?.title ?? h.from} to ${v.tags.find((t) => t.key === h.to)?.title ?? h.to}: ${h.ask}${h.answer ? `, ${h.answer}` : ''}, ${hopStamp(h)}`).join('. ');
  return (
    <svg className={`rl-svg${compact ? ' compact' : ''}`} viewBox={`0 0 ${width} ${H}`} width={Math.round(width * 1.25)} height={Math.round(H * 1.25)} role="img" aria-label={words}>
      {lines.map((h) => {
        const a = x(h.from); const b = x(h.to);
        const apart = Math.abs((pos.get(h.from) ?? 0) - (pos.get(h.to) ?? 0));
        // neighbours: a straight signal line; further apart: routed over the tags between, with rounded bends
        const up = cy - 30 - apart * 4;
        const path = apart <= 1 ? `M${a} ${cy}H${b}` : `M${a} ${cy - 18}V${up + 6}Q${a} ${up} ${a + Math.sign(b - a) * 6} ${up}H${b - Math.sign(b - a) * 6}Q${b} ${up} ${b} ${up + 6}V${cy - 18}`;
        const mid = (a + b) / 2;
        const { cap, data } = split(h.ask);
        const isFresh = fresh.includes(h);
        const out = h.kind === 'event' ? 'rl-evt' : h.kind === 'handoff' ? 'rl-hand' : 'rl-ask';
        return (
          <g key={h.id} className={`rl-hop ${out} ${good(h) ? 'ok' : h.status === 'pending' ? 'wait' : 'bad'}`}>
            <path d={path} className="rl-line" id={`rl-${h.id}`} />
            {h.kind === 'query' && apart <= 1 && Array.from({ length: Math.max(0, Math.floor(Math.abs(b - a) / 16) - 2) }, (_x, i) => <circle key={i} cx={Math.min(a, b) + 24 + i * 16} cy={cy} r={1.6} className="rl-link" />)}
            {h.kind === 'handoff' && <path d={`M${b - Math.sign(b - a) * 24} ${cy - 4}l${Math.sign(b - a) * 5} 4l${-Math.sign(b - a) * 5} 4`} className="rl-arrow" />}
            <text x={mid} y={apart <= 1 ? cy - 9 : up - 5} textAnchor="middle" className="rl-cap"><tspan>{cap}</tspan>{data && <tspan className="rl-data" {...NOTR}>{` ${data.slice(0, 22)}`}</tspan>}</text>
            {h.answer && <text x={mid} y={apart <= 1 ? cy + 15 : up + 12} textAnchor="middle" className="rl-ans" {...NOTR}>{`→ ${trLine(h.answer).slice(0, 26)}`}</text>}
            {isFresh && (
              <circle r={4} className="rl-pulse">
                <animateMotion dur={good(h) || h.status === 'pending' ? '1.8s' : '1.1s'} fill="freeze" keyPoints={good(h) ? '0;1;0' : '0;0.55;0'} keyTimes="0;0.5;1" calcMode="linear">
                  <mpath href={`#rl-${h.id}`} />
                </animateMotion>
              </circle>
            )}
            <g transform={`translate(${mid} ${apart <= 1 ? cy + 34 : up - 26})`} className="rl-stamp-g">
              <rect x={-30} y={-8} width={60} height={14} className="rl-stamp-box" />
              <text y={2.5} textAnchor="middle" className="rl-stamp-t">{hopStamp(h)}</text>
            </g>
          </g>
        );
      })}
      {v.tags.map((t, i) => <Tag key={t.key} t={t} x={x(t.key)} y={cy} n={i + 1} live={v.hops.some((h) => h.status === 'pending' && (h.to === t.key))} />)}
      {v.tags.map((t) => <text key={`n-${t.key}`} x={x(t.key)} y={H - 6} textAnchor="middle" className="rl-name" {...NOTR}>{t.title.length > 24 ? `${t.title.slice(0, 23)}…` : t.title}</text>)}
    </svg>
  );
}

/** The card in the conversation: the drawing, then the hops as a ruled schedule. */
export function RelayBody({ v, retry }: { v: BotRelayView; retry?: (hopId: string) => Promise<unknown> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (v.moved) return <div className="flow-foot faint">A newer relay card for this is further down.</div>;
  const titleOf = (k: string) => v.tags.find((t) => t.key === k)?.title ?? k;
  const open = (k: string) => {
    const id = v.tags.find((t) => t.key === k)?.botId;
    const conv = id ? [...chatState().conversations.values()].find((c) => c.kind === 'direct' && c.members.includes(id)) : undefined;
    if (conv) window.dispatchEvent(new CustomEvent('dex-open', { detail: conv.id }));
  };
  return (
    <div className="rl">
      <RelayDiagram v={v} />
      <ol className="rl-list" aria-label="Between the bots">
        {v.hops.map((h, i) => {
          const { cap, data } = split(h.ask);
          return (
            <li key={h.id} className={`rl-row ${good(h) ? 'ok' : h.status === 'pending' ? 'wait' : 'bad'}`}>
              <span className="rl-no mono" aria-hidden="true">{pad(i + 1)}</span>
              <span className="rl-who" role="text" aria-label={`${titleOf(h.from)} to ${titleOf(h.to)}`}><span translate="no" aria-hidden="true">{titleOf(h.from)}</span><span aria-hidden="true">{' → '}</span><span translate="no" aria-hidden="true">{titleOf(h.to)}</span></span>
              <span className="rl-what mono"><span>{cap}</span>{data && <span translate="no">{` ${data}`}</span>}</span>
              <span className="rl-res">{h.answer ? <span>{trLine(h.answer)}</span> : h.reason ? <span>{trLine(h.reason)}</span> : <span className="faint">…</span>}</span>
              <span className={`rl-mini-stamp ${good(h) ? 'ok' : h.status === 'pending' ? 'wait' : 'bad'}`}>{hopStamp(h)}</span>
              <span className="rl-at mono faint">{formatTime(h.at)}</span>
              {h.back && <span className="rl-back"><Icon name="back" size={12} /><span translate="no">{h.back.words}</span></span>}
              {h.canRetry && retry && (
                <button type="button" className="btn ghost sm rl-retry" disabled={busy === h.id} onClick={() => { setBusy(h.id); setError(null); void retry(h.id).catch((e: Error) => setError(e.message)).finally(() => setBusy(null)); }}>
                  <Icon name="refresh" size={13} />Ask again
                </button>
              )}
              {h.kind === 'handoff' && good(h) && v.tags.find((t) => t.key === h.to)?.botId && (
                <button type="button" className="btn ghost sm rl-open" onClick={() => open(h.to)}><Icon name="open" size={13} />{`Open ${titleOf(h.to)}`}</button>
              )}
            </li>
          );
        })}
      </ol>
      {error && <div className="flow-err" role="alert">{error}</div>}
    </div>
  );
}
