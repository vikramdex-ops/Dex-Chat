// Data sheet: a CSV shared in the conversation as a sortable table and a bar chart of one
// column. Everyone sees the same file, sort and chart once they have opened it.
import { parseCsv } from '@dex/core';
import { esc, page } from './kit.ts';
import type { BuiltinApp, DexApi } from './kit.ts';

/** A cell as a number when it reads as one (1,234.5 · -3 · 12% · 4.5e3); null otherwise. */
export function cellNumber(s: string): number | null {
  const t = s.trim().replace(/,/g, '').replace(/%$/, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
  return Number(t);
}

/** Columns that are numbers: at least four in five of their filled cells read as one. */
export function numericColumns(rows: string[][], cols: number, num: (s: string) => number | null): boolean[] {
  return Array.from({ length: cols }, (_, c) => {
    const filled = rows.map((r) => r[c] ?? '').filter((v) => v.trim() !== '');
    return filled.length > 0 && filled.filter((v) => num(v) !== null).length / filled.length >= 0.8;
  });
}

/** Rows sorted by one column (numbers as numbers, text in natural order; blanks last). */
export function sortRows(rows: string[][], col: number, dir: 1 | -1, numeric: boolean, num: (s: string) => number | null): string[][] {
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return rows.slice().sort((a, b) => {
    const x = a[col] ?? '';
    const y = b[col] ?? '';
    if (!x.trim() && !y.trim()) return 0;
    if (!x.trim()) return 1;
    if (!y.trim()) return -1;
    if (numeric) { const nx = num(x); const ny = num(y); if (nx !== null && ny !== null) return (nx - ny) * dir; }
    return coll.compare(x, y) * dir;
  });
}

interface Shared { fileId: string | null; fileName: string; openedBy: string; sort: { col: number; dir: 1 | -1 } | null; x: number; y: number; tab: 'table' | 'chart' }

function main(dex: DexApi, lib: { parseCsv: typeof parseCsv; cellNumber: typeof cellNumber; numericColumns: typeof numericColumns; sortRows: typeof sortRows; esc: typeof esc }): void {
  const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
  let me = { id: '', name: '' };
  let shared: Shared = { fileId: null, fileName: '', openedBy: '', sort: null, x: 0, y: 1, tab: 'table' };
  let version = 0;
  let loaded: string | null = null;
  let head: string[] = [];
  let body: string[][] = [];
  let numeric: boolean[] = [];
  let filter = '';
  const say = (t: string, bad = false) => { const m = $<HTMLDivElement>('#msg'); m.textContent = t; m.className = bad ? 'msg err' : 'msg faint'; };
  const save = async () => { try { version = (await dex.state.set(shared, version)).version; } catch (e) { say((e as Error).message, true); } };

  const rows = (): string[][] => {
    const f = filter.trim().toLowerCase();
    const list = f ? body.filter((r) => r.some((c) => c.toLowerCase().includes(f))) : body;
    return shared.sort ? lib.sortRows(list, shared.sort.col, shared.sort.dir, !!numeric[shared.sort.col], lib.cellNumber) : list;
  };

  const renderTable = () => {
    const list = rows();
    const max = 2000;
    $<HTMLElement>('#count').textContent = `${list.length}${list.length !== body.length ? ` of ${body.length}` : ''}`;
    $<HTMLTableSectionElement>('#thead').innerHTML = `<tr><th class="rn">#</th>${head.map((h, i) => `<th class="${numeric[i] ? 'n' : ''}"><button type="button" data-col="${i}" aria-label="Sort by ${lib.esc(h)}">${lib.esc(h || `Column ${i + 1}`)}${shared.sort?.col === i ? (shared.sort.dir === 1 ? ' ▲' : ' ▼') : ''}</button></th>`).join('')}</tr>`;
    $<HTMLTableSectionElement>('#tbody').innerHTML = list.slice(0, max).map((r, ri) => `<tr><td class="rn">${ri + 1}</td>${head.map((_, i) => `<td class="${numeric[i] ? 'n' : ''}">${lib.esc(r[i] ?? '')}</td>`).join('')}</tr>`).join('')
      + (list.length > max ? `<tr><td colspan="${head.length + 1}" class="faint">${list.length - max} more rows: sort or filter to see them.</td></tr>` : '');
  };

  const renderChart = () => {
    const xs = $<HTMLSelectElement>('#cx');
    const ys = $<HTMLSelectElement>('#cy');
    xs.innerHTML = head.map((h, i) => `<option value="${i}">${lib.esc(h || `Column ${i + 1}`)}</option>`).join('');
    ys.innerHTML = head.map((h, i) => (numeric[i] ? `<option value="${i}">${lib.esc(h || `Column ${i + 1}`)}</option>` : '')).join('');
    xs.value = String(shared.x);
    if (numeric[shared.y]) ys.value = String(shared.y);
    const y = Number(ys.value);
    const svg = $<HTMLDivElement>('#chart');
    if (!numeric[y]) { svg.innerHTML = '<div class="empty">This sheet has no column of numbers to chart.</div>'; return; }
    const pts = rows().map((r) => ({ label: r[shared.x] ?? '', v: lib.cellNumber(r[y] ?? '') })).filter((p): p is { label: string; v: number } => p.v !== null).slice(0, 40);
    if (!pts.length) { svg.innerHTML = '<div class="empty">No numbers in that column.</div>'; return; }
    const W = Math.max(320, svg.clientWidth || 600);
    const H = Math.max(160, (svg.clientHeight || 220) - 4);
    const L = 54; const B = 46; const T = 10; const R = 10;
    const lo = Math.min(0, ...pts.map((p) => p.v));
    const hi = Math.max(0, ...pts.map((p) => p.v));
    const span = hi - lo || 1;
    const step = 10 ** Math.floor(Math.log10(span / 4));
    const tick = [1, 2, 5, 10].map((m) => m * step).find((t) => span / t <= 6) ?? step * 10;
    const yOf = (v: number) => T + (H - T - B) * (1 - (v - lo) / span);
    const bw = (W - L - R) / pts.length;
    const ticks: number[] = [];
    for (let t = Math.ceil(lo / tick) * tick; t <= hi + 1e-9; t += tick) ticks.push(t);
    const fmt = (v: number) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toPrecision(3)}M` : Math.abs(v) >= 1e4 ? `${(v / 1e3).toPrecision(3)}k` : String(Number(v.toPrecision(4))));
    svg.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${lib.esc(head[y])} by ${lib.esc(head[shared.x])}">
      ${ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${yOf(t)}" y2="${yOf(t)}" class="grid"/><text x="${L - 6}" y="${yOf(t) + 3}" class="ax" text-anchor="end">${fmt(t)}</text>`).join('')}
      <line x1="${L}" x2="${W - R}" y1="${yOf(0)}" y2="${yOf(0)}" class="zero"/>
      ${pts.map((p, i) => { const y0 = yOf(Math.max(0, p.v)); const h = Math.abs(yOf(p.v) - yOf(0)); const x = L + i * bw + bw * 0.15; return `<rect x="${x}" y="${y0}" width="${Math.max(1, bw * 0.7)}" height="${Math.max(0.5, h)}" class="bar"><title>${lib.esc(p.label)}: ${p.v}</title></rect>${pts.length <= 24 ? `<text x="${x + bw * 0.35}" y="${H - B + 12}" class="ax" text-anchor="end" transform="rotate(-35 ${x + bw * 0.35} ${H - B + 12})">${lib.esc(p.label.slice(0, 14))}</text>` : ''}`; }).join('')}
    </svg>`;
  };

  const render = () => {
    document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === shared.tab)));
    $<HTMLElement>('#tableview').hidden = shared.tab !== 'table';
    $<HTMLElement>('#chartview').hidden = shared.tab !== 'chart';
    $<HTMLElement>('#sheet').textContent = loaded ? shared.fileName : '—';
    $<HTMLElement>('#cols').textContent = String(head.length);
    if (!loaded) { $<HTMLElement>('#count').textContent = '0'; return; }
    if (shared.tab === 'table') renderTable(); else renderChart();
  };

  const offer = () => {
    const bar = $<HTMLDivElement>('#follow');
    if (shared.fileId && shared.fileId !== loaded) {
      bar.hidden = false;
      bar.innerHTML = `<span class="grow">${lib.esc(shared.openedBy || 'Someone')} is looking at <b>${lib.esc(shared.fileName)}</b>.</span><button class="btn primary" type="button" id="follow-open">Open it here</button>`;
      $<HTMLButtonElement>('#follow-open').addEventListener('click', () => void open(shared.fileId!));
    } else bar.hidden = true;
  };

  const open = async (fileId: string) => {
    say('Asking to open the file…');
    let f: { name: string; bytes: ArrayBuffer };
    try { f = await dex.files.read(fileId); } catch (e) { say((e as Error).message, true); return; }
    if (/\.(xlsx|xlsm|xls|ods)$/i.test(f.name)) { say(`${f.name} is a workbook. Save the sheet as CSV (CSV UTF-8) from Excel or Dexterity Sheets, share that, and open it here.`, true); return; }
    const table = lib.parseCsv(new TextDecoder().decode(f.bytes).slice(0, 8_000_000));
    if (!table.length) { say('That file has no rows.', true); return; }
    const width = Math.min(60, Math.max(...table.map((r) => r.length)));
    head = (table[0] ?? []).slice(0, width).map((h) => h.trim());
    while (head.length < width) head.push('');
    body = table.slice(1, 50001).map((r) => r.slice(0, width));
    numeric = lib.numericColumns(body, width, lib.cellNumber);
    loaded = fileId;
    $<HTMLElement>('#empty').hidden = true;
    say(`${f.name}: ${body.length} rows, ${width} columns.${table.length > 50001 ? ' Only the first 50,000 rows are shown.' : ''}`);
    if (shared.fileId !== fileId) {
      const firstNum = numeric.findIndex((n, i) => n && i > 0);
      shared = { fileId, fileName: f.name, openedBy: me.name, sort: null, x: 0, y: firstNum >= 0 ? firstNum : numeric.indexOf(true), tab: shared.tab };
      void save();
    }
    offer();
    render();
  };

  $<HTMLTableSectionElement>('#thead').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-col]');
    if (!b) return;
    const col = Number(b.dataset.col);
    shared = { ...shared, sort: shared.sort?.col === col ? (shared.sort.dir === 1 ? { col, dir: -1 } : null) : { col, dir: 1 } };
    render();
    void save();
  });
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => t.addEventListener('click', () => { shared = { ...shared, tab: t.dataset.tab === 'chart' ? 'chart' : 'table' }; render(); void save(); }));
  $<HTMLSelectElement>('#cx').addEventListener('change', (e) => { shared = { ...shared, x: Number((e.target as HTMLSelectElement).value) }; render(); void save(); });
  $<HTMLSelectElement>('#cy').addEventListener('change', (e) => { shared = { ...shared, y: Number((e.target as HTMLSelectElement).value) }; render(); void save(); });
  $<HTMLInputElement>('#filter').addEventListener('input', (e) => { filter = (e.target as HTMLInputElement).value; render(); });
  $<HTMLButtonElement>('#open').addEventListener('click', () => { const v = $<HTMLSelectElement>('#file').value; if (v) void open(v); });

  dex.on('state', (d) => {
    if (d.version <= version) return;
    version = d.version;
    const s = d.state as Shared | null;
    if (s) shared = { fileId: s.fileId ?? null, fileName: s.fileName ?? '', openedBy: s.openedBy ?? '', sort: s.sort ?? null, x: s.x ?? 0, y: s.y ?? 1, tab: s.tab === 'chart' ? 'chart' : 'table' };
    offer();
    render();
  });

  void (async () => {
    me = (await dex.context()).viewer;
    const [files, s] = await Promise.all([dex.files.list(), dex.state.get()]);
    const sheets = files.filter((f) => /\.(csv|tsv|txt|xlsx|xlsm|xls|ods)$/i.test(f.name));
    $<HTMLSelectElement>('#file').innerHTML = sheets.length ? sheets.map((f) => `<option value="${lib.esc(f.id)}">${lib.esc(f.name)}</option>`).join('') : '<option value="">No CSV files shared here yet</option>';
    $<HTMLButtonElement>('#open').disabled = !sheets.length;
    const st = s.state as Shared | null;
    if (st) shared = { fileId: st.fileId ?? null, fileName: st.fileName ?? '', openedBy: st.openedBy ?? '', sort: st.sort ?? null, x: st.x ?? 0, y: st.y ?? 1, tab: st.tab === 'chart' ? 'chart' : 'table' };
    version = s.version;
    offer();
    render();
  })().catch((e: Error) => say(e.message, true));
}

export const DATA_SHEET: BuiltinApp = {
  manifest: {
    id: 'dex-table', name: 'Data sheet', version: '1.0.0',
    description: 'A CSV from the conversation as a sortable table and a bar chart, the same view for everyone.',
    permissions: ['files', 'state'], hosts: [], height: 420,
  },
  html: page({
    title: 'Data sheet',
    css: `
.bar { display: flex; gap: 6px; align-items: center; padding: 6px 8px; flex: none; }
.bar select { max-width: 220px; }
#filter { width: 150px; }
.view { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; }
.ruled td.rn, .ruled th.rn { width: 34px; color: var(--dex-text-3); font: 10px/1.4 var(--dex-font-mono); text-align: right; }
.ruled th button { all: unset; cursor: pointer; }
.ruled th.n { text-align: right; }
.ruled td { white-space: nowrap; max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
#chart { flex: 1; min-height: 0; padding: 4px 8px; }
#chart .grid { stroke: var(--dex-stroke); }
#chart .zero { stroke: var(--dex-text-3); }
#chart .bar { fill: var(--dex-accent); }
#chart .ax { fill: var(--dex-text-3); font: 10px var(--dex-font-mono); }
.chartbar { display: flex; gap: 6px; align-items: center; padding: 6px 8px; border-bottom: 1px solid var(--dex-stroke); }
#follow { display: flex; gap: 8px; align-items: center; padding: 6px 10px; background: var(--dex-accent-soft); border-bottom: 1px solid var(--dex-stroke-strong); font-size: 12px; }
#empty { position: absolute; inset: 0; }
.msg { padding: 4px 10px; font-size: 11.5px; border-top: 1px solid var(--dex-stroke); flex: none; }
`,
    body: `<div class="app">
  <div class="tblock"><div style="flex:1"><span class="cap">File</span><b id="sheet">—</b></div><div><span class="cap">Rows</span><b id="count">0</b></div><div><span class="cap">Cols</span><b id="cols">0</b></div></div>
  <div id="follow" hidden></div>
  <div class="bar"><select id="file" class="input" aria-label="CSV file to open"></select><button id="open" class="btn" type="button">Open</button><span class="grow"></span><input id="filter" class="input" placeholder="Filter rows" aria-label="Filter rows"></div>
  <div class="tabs" role="tablist"><button class="tab" role="tab" type="button" data-tab="table">Table</button><button class="tab" role="tab" type="button" data-tab="chart">Chart</button></div>
  <div class="view">
    <div id="tableview" class="scroll" style="flex:1"><table class="ruled"><thead id="thead"></thead><tbody id="tbody"></tbody></table></div>
    <div id="chartview" hidden style="flex:1;display:flex;flex-direction:column;min-height:0"><div class="chartbar"><span class="cap">Label</span><select id="cx" class="input"></select><span class="cap">Value</span><select id="cy" class="input"></select></div><div id="chart"></div></div>
    <div id="empty" class="empty">Open a CSV shared in this conversation. Workbooks (.xlsx): save the sheet as CSV first.</div>
  </div>
  <div id="msg" class="msg faint" aria-live="polite">Files open only after you agree, one at a time.</div>
</div>`,
    main,
    lib: { parseCsv, cellNumber, numericColumns, sortRows, esc },
  }),
};
