// Calculator with a shared tape: everyone in the conversation sees each sum as it is worked out,
// with who did it, and can post the tape into the conversation.
import { esc, mergeById, page } from './kit.ts';
import type { BuiltinApp, DexApi } from './kit.ts';

/**
 * Work out an expression: + − × ÷ ^, % (per cent of), brackets, √ and sqrt, sin cos tan and their
 * inverses in degrees, log (base 10), ln, abs and π. Throws an Error with a short reason.
 */
export function evaluate(input: string): number {
  const src = input.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/π/g, 'pi').replace(/√/g, 'sqrt').replace(/,/g, '').trim();
  if (!src) throw new Error('Nothing to work out');
  if (src.length > 500) throw new Error('Too long');
  const toks: Array<{ t: 'n'; v: number } | { t: 'o'; v: string } | { t: 'f'; v: string }> = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ') { i++; continue; }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
    if (num) { toks.push({ t: 'n', v: Number(num[0]) }); i += num[0].length; continue; }
    const word = /^[a-z]+/i.exec(src.slice(i));
    if (word) {
      const w = word[0].toLowerCase();
      if (w === 'pi') toks.push({ t: 'n', v: Math.PI });
      else if (['sqrt', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'log', 'ln', 'abs'].includes(w)) toks.push({ t: 'f', v: w });
      else throw new Error(`Unknown: ${w}`);
      i += w.length;
      continue;
    }
    if ('+-*/^%()'.includes(c)) { toks.push({ t: 'o', v: c }); i++; continue; }
    throw new Error(`Unexpected ${c}`);
  }
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => { const t = peek(); return !!t && t.t === 'o' && t.v === v; };
  const rad = (d: number) => (d * Math.PI) / 180;
  const deg = (r: number) => (r * 180) / Math.PI;
  const fns: Record<string, (x: number) => number> = {
    sqrt: (x) => { if (x < 0) throw new Error('Square root of a negative number'); return Math.sqrt(x); },
    sin: (x) => Math.sin(rad(x)), cos: (x) => Math.cos(rad(x)), tan: (x) => Math.tan(rad(x)),
    asin: (x) => deg(Math.asin(x)), acos: (x) => deg(Math.acos(x)), atan: (x) => deg(Math.atan(x)),
    log: (x) => Math.log10(x), ln: (x) => Math.log(x), abs: (x) => Math.abs(x),
  };
  // expr := term (('+'|'-') term)* ; term := unary (('*'|'/') unary)* ; unary := '-' unary | power ; power := postfix ('^' unary)?
  const expr = (): number => {
    let v = term();
    while (isOp('+') || isOp('-')) { const o = (toks[p++] as { v: string }).v; const r = term(); v = o === '+' ? v + r : v - r; }
    return v;
  };
  const term = (): number => {
    let v = unary();
    for (;;) {
      if (isOp('*') || isOp('/')) {
        const o = (toks[p++] as { v: string }).v;
        const r = unary();
        if (o === '/' && r === 0) throw new Error('Division by zero');
        v = o === '*' ? v * r : v / r;
      } else if (peek() && (peek().t === 'n' || peek().t === 'f' || isOp('('))) v *= power(); // 2(3+4), 2π
      else return v;
    }
  };
  const unary = (): number => {
    if (isOp('-')) { p++; return -unary(); }
    if (isOp('+')) { p++; return unary(); }
    return power();
  };
  const power = (): number => {
    const b = postfix();
    if (isOp('^')) { p++; return b ** unary(); }
    return b;
  };
  const postfix = (): number => {
    let v = atom();
    while (isOp('%')) { p++; v /= 100; }
    return v;
  };
  const atom = (): number => {
    const t = toks[p++];
    if (!t) throw new Error('Unfinished');
    if (t.t === 'n') return t.v;
    if (t.t === 'f') {
      const arg = isOp('(') ? (p++, (() => { const v = expr(); if (!isOp(')')) throw new Error('Missing )'); p++; return v; })()) : power();
      return fns[t.v](arg);
    }
    if (t.v === '(') { const v = expr(); if (!isOp(')')) throw new Error('Missing )'); p++; return v; }
    throw new Error(`Unexpected ${t.v}`);
  };
  const v = expr();
  if (p < toks.length) throw new Error('Check the brackets and operators');
  if (!Number.isFinite(v)) throw new Error('Out of range');
  return v;
}

/** A result as people write it: up to 12 significant figures, no trailing zeros. */
export function formatNumber(v: number): string {
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e15 || a < 1e-9) return v.toExponential(8).replace(/\.?0+e/, 'e');
  return String(Number(v.toPrecision(12)));
}

interface Line { id: string; expr: string; result: string; by: string; byId: string; at: number }
interface Tape { tape: Line[]; clearedAt: number }

function main(dex: DexApi, lib: { evaluate: typeof evaluate; formatNumber: typeof formatNumber; mergeById: typeof mergeById; esc: typeof esc }): void {
  const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
  const input = $<HTMLInputElement>('#expr');
  const out = $<HTMLDivElement>('#out');
  const tapeEl = $<HTMLOListElement>('#tape');
  let me = { id: '', name: '' };
  let tape: Tape = { tape: [], clearedAt: 0 };
  let version = 0;
  const mine = new Map<string, Line>();
  const pretty = (s: string) => s.replace(/\*/g, ' × ').replace(/\//g, ' ÷ ').replace(/(\d)\s*-\s*/g, '$1 − ').replace(/\+/g, ' + ').replace(/\s+/g, ' ').trim();
  const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const render = () => {
    const lines = tape.tape;
    $<HTMLElement>('#count').textContent = String(lines.length);
    const last = lines[lines.length - 1];
    $<HTMLElement>('#lastby').textContent = last ? last.by : '—';
    tapeEl.innerHTML = lines.length
      ? lines.map((l) => `<li data-id="${lib.esc(l.id)}"><span class="te mono">${lib.esc(l.expr)}</span><span class="tr mono">= ${lib.esc(l.result)}</span><span class="tb cap" title="${lib.esc(l.by)} at ${time(l.at)}">${lib.esc(l.by.split(/\s+/).map((w) => w[0] ?? '').join('').slice(0, 3))} · ${time(l.at)}</span></li>`).join('')
      : '<li class="blank faint">The tape is empty. Work something out and it appears here for everyone.</li>';
    tapeEl.scrollTop = tapeEl.scrollHeight;
    ($<HTMLButtonElement>('#post')).disabled = !lines.length;
    ($<HTMLButtonElement>('#clear')).disabled = !lines.length;
  };

  /** Their copy plus my lines they have not seen yet (two people pressing = at once). */
  const merge = (theirs: Tape): Tape => {
    const clearedAt = Math.max(theirs.clearedAt ?? 0, tape.clearedAt);
    const missing = [...mine.values()].filter((l) => l.at > clearedAt && !theirs.tape.some((x) => x.id === l.id));
    return { clearedAt, tape: lib.mergeById(theirs.tape ?? [], missing).filter((l) => l.at > clearedAt).slice(-150) };
  };

  const save = async () => {
    try {
      const r = await dex.state.set(tape, version);
      version = r.version;
      if (r.conflict) {
        const cur = await dex.state.get();
        tape = merge((cur.state as Tape | null) ?? { tape: [], clearedAt: 0 });
        version = cur.version;
        const again = await dex.state.set(tape, version);
        version = again.version;
        render();
      }
    } catch (e) { out.textContent = (e as Error).message; out.className = 'out err'; }
  };

  const run = () => {
    const src = input.value;
    if (!src.trim()) return;
    try {
      const v = lib.evaluate(src);
      const line: Line = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, expr: pretty(src), result: lib.formatNumber(v), by: me.name, byId: me.id, at: Date.now() };
      mine.set(line.id, line);
      tape = { clearedAt: tape.clearedAt, tape: [...tape.tape, line].slice(-150) };
      out.textContent = line.result;
      out.className = 'out';
      input.value = line.result;
      input.select();
      render();
      void save();
    } catch (e) {
      out.textContent = (e as Error).message;
      out.className = 'out err';
    }
  };

  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } if (e.key === 'Escape') { input.value = ''; out.textContent = '0'; } });
  input.addEventListener('input', () => {
    try { out.textContent = input.value.trim() ? lib.formatNumber(lib.evaluate(input.value)) : '0'; out.className = 'out preview'; } catch { out.className = 'out preview faint'; }
  });
  document.querySelectorAll<HTMLButtonElement>('.keys button').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.k ?? '';
    if (k === '=') run();
    else if (k === 'C') { input.value = ''; out.textContent = '0'; out.className = 'out'; }
    else if (k === 'back') input.value = input.value.slice(0, -1);
    else input.value += k;
    input.focus();
    if (k !== '=') input.dispatchEvent(new Event('input'));
  }));
  $<HTMLButtonElement>('#clear').addEventListener('click', () => {
    tape = { tape: [], clearedAt: Date.now() };
    mine.clear();
    render();
    void save();
  });
  $<HTMLButtonElement>('#post').addEventListener('click', async () => {
    const text = ['**Calculator tape**', ...tape.tape.slice(-30).map((l) => `- \`${l.expr} = ${l.result}\` (${l.by})`)].join('\n');
    try { const r = await dex.post(text); if (r.posted) out.textContent = 'Posted'; } catch (e) { out.textContent = (e as Error).message; }
  });

  dex.on('state', (d) => {
    if (d.version <= version) return;
    version = d.version;
    const theirs = (d.state as Tape | null) ?? { tape: [], clearedAt: 0 };
    const merged = merge(theirs);
    const lost = merged.tape.length !== (theirs.tape ?? []).filter((l) => l.at > merged.clearedAt).length;
    tape = merged;
    render();
    if (lost) void save();
  });

  void (async () => {
    const ctx = await dex.context();
    me = ctx.viewer;
    const s = await dex.state.get();
    tape = (s.state as Tape | null) ?? { tape: [], clearedAt: 0 };
    if (!Array.isArray(tape.tape)) tape = { tape: [], clearedAt: 0 };
    version = s.version;
    render();
  })().catch((e: Error) => { out.textContent = e.message; out.className = 'out err'; });
}

const KEYS = [['C', '(', ')', '%', '÷'], ['7', '8', '9', '√', '×'], ['4', '5', '6', '^', '−'], ['1', '2', '3', 'π', '+'], ['0', '.', 'back', '=']];

export const CALCULATOR: BuiltinApp = {
  manifest: {
    id: 'dex-calculator', name: 'Calculator', version: '1.0.0',
    description: 'Work things out together: every sum lands on a tape everyone in the conversation sees.',
    permissions: ['state', 'post'], hosts: [], height: 340,
  },
  html: page({
    title: 'Calculator',
    css: `
.tblock > div:first-child { flex: 1; }
.main { flex: 1; display: grid; grid-template-columns: minmax(200px, 250px) 1fr; min-height: 0; }
.pad { padding: 10px; border-right: 1px solid var(--dex-stroke-strong); display: flex; flex-direction: column; gap: 8px; }
#expr { width: 100%; height: 32px; font: 15px/1 var(--dex-font-mono); text-align: right; }
.out { font: 600 22px/1.1 var(--dex-font-display); text-align: right; min-height: 26px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.out.preview { color: var(--dex-text-3); }
.out.err { font: 12px/1.3 var(--dex-font-body); color: var(--dex-danger); white-space: normal; }
.keys { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; }
.keys button { height: 30px; border: 1px solid var(--dex-stroke); border-radius: 3px; background: var(--dex-subtle); cursor: pointer; font: 14px/1 var(--dex-font-mono); }
.keys button:hover { border-color: var(--dex-stroke-strong); }
.keys button[data-k="="] { grid-column: span 2; background: var(--dex-accent); color: var(--dex-accent-text); border-color: transparent; font-weight: 700; }
.keys button[data-k="C"] { color: var(--dex-danger); }
.side { display: flex; flex-direction: column; min-height: 0; }
#tape { list-style: none; margin: 0; padding: 0; flex: 1; overflow: auto; counter-reset: line; }
#tape li { display: grid; grid-template-columns: 26px 1fr auto auto; gap: 8px; align-items: baseline; padding: 4px 10px 4px 0; border-bottom: 1px solid var(--dex-stroke); counter-increment: line; }
#tape li::before { content: counter(line, decimal-leading-zero); font: 10px/1 var(--dex-font-mono); color: var(--dex-text-3); text-align: right; }
#tape li.blank { display: block; padding: 14px; border: 0; }
#tape li.blank::before { content: none; }
.te { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dex-text-2); }
.tr { font-weight: 700; }
.foot { display: flex; gap: 6px; padding: 6px 8px; border-top: 1px solid var(--dex-stroke-strong); justify-content: flex-end; }
`,
    body: `<div class="app">
  <div class="tblock"><div><span class="cap">Tape</span><b>Every line, for everyone here</b></div><div><span class="cap">Lines</span><b id="count">0</b></div><div><span class="cap">Last by</span><b id="lastby">—</b></div></div>
  <div class="main">
    <div class="pad">
      <input id="expr" class="input" autocomplete="off" spellcheck="false" placeholder="12 × 3.5" aria-label="Sum to work out">
      <div id="out" class="out" aria-live="polite">0</div>
      <div class="keys">${KEYS.flat().map((k) => `<button type="button" data-k="${k === '÷' ? '/' : k === '×' ? '*' : k === '−' ? '-' : k === '√' ? 'sqrt(' : k === 'π' ? 'pi' : k}" aria-label="${k === 'back' ? 'Delete' : k}">${k === 'back' ? '⌫' : k}</button>`).join('')}</div>
    </div>
    <div class="side">
      <ol id="tape" aria-label="Shared tape"></ol>
      <div class="foot"><button id="clear" class="btn ghost" type="button">Clear tape</button><button id="post" class="btn" type="button">Post tape to the conversation</button></div>
    </div>
  </div>
</div>`,
    main,
    lib: { evaluate, formatNumber, mergeById, esc },
  }),
};
