// A rule drawn as a schematic on a ruled sheet: the trigger, then each condition, then each step,
// as boxes in reading order joined by connectors that turn down to the next row when the sheet is
// narrow. Boxes the drafter was unsure about carry an amber revision mark.
import { useLayoutEffect, useRef, useState } from 'react';
import type { FlowGraph } from '@dex/core';
import { ACTION_LABEL, CONDITION_LABEL, TRIGGER_LABEL, actionSummary, conditionSummary, triggerSummary } from './labels.ts';
import type { Names } from './labels.ts';

export interface NodeMark { confidence: number; missing: string[]; /** the person has looked at it since it was drafted */ checked?: boolean }

const NODE_W = 200;
const NODE_H = 116;
const GAP = 56;
const ROW_GAP = 60;
const PAD = 28;

interface Item { id: string; tag: string; role: string; title: string; summary: string }

export function items(graph: FlowGraph, names: Names): Item[] {
  return [
    { id: graph.trigger.id, tag: graph.trigger.id.toUpperCase(), role: 'When', title: TRIGGER_LABEL[graph.trigger.kind], summary: triggerSummary(graph.trigger, names) },
    ...graph.conditions.map((c) => ({ id: c.id, tag: c.id.toUpperCase(), role: 'Only if', title: CONDITION_LABEL[c.kind], summary: conditionSummary(c, names) })),
    ...graph.actions.map((a, i) => ({ id: a.id, tag: a.id.toUpperCase(), role: `Then · ${i + 1}`, title: ACTION_LABEL[a.kind], summary: actionSummary(a, names) })),
  ];
}

export function FlowGraphView({ graph, names, selected, onSelect, marks, errors }: {
  graph: FlowGraph;
  names: Names;
  selected: string | null;
  onSelect: (id: string) => void;
  marks?: Record<string, NodeMark>;
  errors?: Record<string, string>;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(880);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const list = items(graph, names);
  const cols = Math.max(1, Math.floor((width - PAD * 2 + GAP) / (NODE_W + GAP)));
  const rows = Math.ceil(list.length / cols);
  // centre the drawing on the sheet
  const used = Math.min(cols, list.length) * NODE_W + (Math.min(cols, list.length) - 1) * GAP;
  const left = Math.max(PAD, (width - used) / 2);
  const pos = list.map((_, i) => ({ x: left + (i % cols) * (NODE_W + GAP), y: PAD + 18 + Math.floor(i / cols) * (NODE_H + ROW_GAP) }));
  const height = PAD * 2 + 18 + rows * NODE_H + (rows - 1) * ROW_GAP;
  const firstAction = 1 + graph.conditions.length;

  const wires: Array<{ d: string; label: string | null; lx: number; ly: number }> = [];
  for (let i = 0; i + 1 < list.length; i++) {
    const a = pos[i];
    const b = pos[i + 1];
    const label = i + 1 === firstAction ? 'then' : i === 0 && graph.conditions.length ? 'if' : null;
    if (Math.abs(a.y - b.y) < 1) {
      const y = a.y + NODE_H / 2;
      wires.push({ d: `M ${a.x + NODE_W} ${y} H ${b.x - 2}`, label, lx: (a.x + NODE_W + b.x) / 2, ly: y - 8 });
    } else {
      const mid = a.y + NODE_H + ROW_GAP / 2;
      wires.push({ d: `M ${a.x + NODE_W / 2} ${a.y + NODE_H} V ${mid} H ${b.x + NODE_W / 2} V ${b.y - 2}`, label, lx: (a.x + b.x + NODE_W) / 2, ly: mid - 7 });
    }
  }
  // zone references along the frame, as on a drawing sheet
  const zones = Math.max(2, Math.round(width / 160));

  return (
    <div className="fl-sheet" ref={box} style={{ height }} role="group" aria-label="Rule schematic">
      <svg className="fl-wires" width={width} height={height} aria-hidden="true">
        <defs>
          <marker id="fl-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 1 L 9 5 L 0 9" fill="none" stroke="currentColor" strokeWidth="1.4" />
          </marker>
        </defs>
        <rect className="fl-frame" x="8.5" y="8.5" width={Math.max(0, width - 17)} height={Math.max(0, height - 17)} />
        {Array.from({ length: zones }, (_, i) => {
          const x = 8.5 + ((width - 17) / zones) * (i + 0.5);
          return <text key={i} className="fl-zone" x={x} y={20} textAnchor="middle">{String.fromCharCode(65 + i)}</text>;
        })}
        {Array.from({ length: zones - 1 }, (_, i) => {
          const x = 8.5 + ((width - 17) / zones) * (i + 1);
          return <line key={i} className="fl-zone-tick" x1={x} x2={x} y1={8.5} y2={14} />;
        })}
        {wires.map((w, i) => (
          <g key={i}>
            <path className="fl-wire" d={w.d} markerEnd="url(#fl-arrow)" />
            {w.label && <text className="fl-wire-label" x={w.lx} y={w.ly} textAnchor="middle">{w.label}</text>}
          </g>
        ))}
      </svg>
      {list.map((it, i) => {
        const mark = marks?.[it.id];
        const unsure = !!mark && (mark.missing.length > 0 || (mark.confidence < 0.7 && !mark.checked));
        const error = errors?.[it.id];
        return (
          <button key={it.id} type="button" className={`fl-node${selected === it.id ? ' on' : ''}${unsure ? ' unsure' : ''}${error ? ' bad' : ''}${i >= firstAction ? ' act' : i > 0 ? ' cond' : ' trig'}`}
            style={{ left: pos[i].x, top: pos[i].y, width: NODE_W, height: NODE_H }}
            aria-pressed={selected === it.id} onClick={() => onSelect(it.id)} title={error ?? undefined}>
            <span className="fl-node-head">
              <span className="fl-node-tag">{it.tag}</span>
              <span className="fl-node-role">{it.role}</span>
              {mark && <span className={`fl-conf${unsure ? ' low' : ''}`} title={unsure ? 'Check this part' : 'Drafted from your words'}>{unsure ? '△ ' : ''}{Math.round(mark.confidence * 100)}%</span>}
            </span>
            <span className="fl-node-title">{it.title}</span>
            <span className="fl-node-sum" translate="no">{it.summary}</span>
            {unsure && mark.missing.length > 0 && <span className="fl-node-miss">Fill in: {mark.missing.map((m) => MISSING[m] ?? m).join(', ')}</span>}
          </button>
        );
      })}
    </div>
  );
}

const MISSING: Record<string, string> = { to: 'who', emoji: 'reaction', url: 'address', tag: 'tag', pattern: 'words', targets: 'who', conversation: 'where', convId: 'where', people: 'who' };
