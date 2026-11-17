// Engineering unit converter: length, pressure, flow, temperature, mass, area, volume and
// density, with a schedule of every unit at once and a shared list of noted conversions.
import { esc, mergeById, page } from './kit.ts';
import type { BuiltinApp, DexApi } from './kit.ts';

/** Each unit as `base = value × factor + offset`, in SI base units of its quantity. */
export interface UnitDef { id: string; label: string; factor: number; offset?: number }
export interface Quantity { id: string; label: string; base: string; units: UnitDef[] }

const G = 9.80665;
const INCH = 0.0254;
const FOOT = 0.3048;
const USGAL = 3.785411784e-3;
const IMPGAL = 4.54609e-3;
const BBL = 0.158987294928;
const LB = 0.45359237;

export const QUANTITIES: Quantity[] = [
  { id: 'length', label: 'Length', base: 'm', units: [
    { id: 'mm', label: 'mm', factor: 1e-3 }, { id: 'cm', label: 'cm', factor: 1e-2 }, { id: 'm', label: 'm', factor: 1 }, { id: 'km', label: 'km', factor: 1e3 },
    { id: 'thou', label: 'thou (mil)', factor: INCH / 1000 }, { id: 'in', label: 'in', factor: INCH }, { id: 'ft', label: 'ft', factor: FOOT }, { id: 'yd', label: 'yd', factor: 0.9144 },
    { id: 'mi', label: 'mile', factor: 1609.344 },
  ] },
  { id: 'pressure', label: 'Pressure', base: 'Pa', units: [
    { id: 'Pa', label: 'Pa', factor: 1 }, { id: 'kPa', label: 'kPa', factor: 1e3 }, { id: 'MPa', label: 'MPa', factor: 1e6 }, { id: 'bar', label: 'bar', factor: 1e5 },
    { id: 'mbar', label: 'mbar', factor: 100 }, { id: 'psi', label: 'psi', factor: (LB * G) / (INCH * INCH) }, { id: 'ksi', label: 'ksi', factor: (1000 * LB * G) / (INCH * INCH) },
    { id: 'kgcm2', label: 'kg/cm²', factor: G * 1e4 }, { id: 'atm', label: 'atm', factor: 101325 }, { id: 'mmHg', label: 'mmHg', factor: 133.322387415 },
    { id: 'torr', label: 'torr', factor: 101325 / 760 }, { id: 'mH2O', label: 'm H₂O', factor: G * 1000 }, { id: 'inH2O', label: 'in H₂O', factor: 249.08891 },
  ] },
  { id: 'flow', label: 'Flow', base: 'm³/s', units: [
    { id: 'm3s', label: 'm³/s', factor: 1 }, { id: 'm3h', label: 'm³/h', factor: 1 / 3600 }, { id: 'Ls', label: 'L/s', factor: 1e-3 }, { id: 'Lmin', label: 'L/min', factor: 1e-3 / 60 },
    { id: 'Lh', label: 'L/h', factor: 1e-3 / 3600 }, { id: 'usgpm', label: 'US gpm', factor: USGAL / 60 }, { id: 'igpm', label: 'imp gpm', factor: IMPGAL / 60 },
    { id: 'cfm', label: 'ft³/min', factor: (FOOT ** 3) / 60 }, { id: 'bpd', label: 'bbl/day', factor: BBL / 86400 }, { id: 'MLd', label: 'ML/day', factor: 1000 / 86400 },
  ] },
  { id: 'temperature', label: 'Temperature', base: 'K', units: [
    { id: 'C', label: '°C', factor: 1, offset: 273.15 }, { id: 'F', label: '°F', factor: 5 / 9, offset: (459.67 * 5) / 9 },
    { id: 'K', label: 'K', factor: 1, offset: 0 }, { id: 'R', label: '°R', factor: 5 / 9, offset: 0 },
  ] },
  { id: 'mass', label: 'Mass', base: 'kg', units: [
    { id: 'g', label: 'g', factor: 1e-3 }, { id: 'kg', label: 'kg', factor: 1 }, { id: 't', label: 'tonne', factor: 1000 }, { id: 'oz', label: 'oz', factor: LB / 16 },
    { id: 'lb', label: 'lb', factor: LB }, { id: 'shton', label: 'short ton', factor: 2000 * LB }, { id: 'lton', label: 'long ton', factor: 2240 * LB },
  ] },
  { id: 'area', label: 'Area', base: 'm²', units: [
    { id: 'mm2', label: 'mm²', factor: 1e-6 }, { id: 'cm2', label: 'cm²', factor: 1e-4 }, { id: 'm2', label: 'm²', factor: 1 }, { id: 'ha', label: 'hectare', factor: 1e4 },
    { id: 'km2', label: 'km²', factor: 1e6 }, { id: 'in2', label: 'in²', factor: INCH ** 2 }, { id: 'ft2', label: 'ft²', factor: FOOT ** 2 }, { id: 'yd2', label: 'yd²', factor: 0.9144 ** 2 },
    { id: 'acre', label: 'acre', factor: 4046.8564224 },
  ] },
  { id: 'volume', label: 'Volume', base: 'm³', units: [
    { id: 'mL', label: 'mL', factor: 1e-6 }, { id: 'L', label: 'L', factor: 1e-3 }, { id: 'm3', label: 'm³', factor: 1 }, { id: 'in3', label: 'in³', factor: INCH ** 3 },
    { id: 'ft3', label: 'ft³', factor: FOOT ** 3 }, { id: 'usgal', label: 'US gal', factor: USGAL }, { id: 'impgal', label: 'imp gal', factor: IMPGAL }, { id: 'bbl', label: 'bbl (oil)', factor: BBL },
  ] },
  { id: 'density', label: 'Density', base: 'kg/m³', units: [
    { id: 'kgm3', label: 'kg/m³', factor: 1 }, { id: 'gcm3', label: 'g/cm³', factor: 1000 }, { id: 'kgL', label: 'kg/L', factor: 1000 }, { id: 'lbft3', label: 'lb/ft³', factor: LB / FOOT ** 3 },
    { id: 'lbin3', label: 'lb/in³', factor: LB / INCH ** 3 }, { id: 'lbgal', label: 'lb/US gal', factor: LB / USGAL }, { id: 'sg', label: 'SG (water at 4 °C)', factor: 999.972 },
  ] },
];

/** Convert between two units of one quantity. */
export function convert(quantities: Quantity[], quantity: string, value: number, from: string, to: string): number {
  const q = quantities.find((x) => x.id === quantity);
  const a = q?.units.find((u) => u.id === from);
  const b = q?.units.find((u) => u.id === to);
  if (!q || !a || !b) throw new Error('Unknown unit');
  const base = value * a.factor + (a.offset ?? 0);
  return (base - (b.offset ?? 0)) / b.factor;
}

/** Six significant figures, or scientific notation for very large and small numbers. */
export function sig(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e9 || a < 1e-5) return v.toExponential(5).replace(/\.?0+e/, 'e');
  return String(Number(v.toPrecision(6)));
}

interface Noted { id: string; text: string; by: string; at: number }

function main(dex: DexApi, lib: { QUANTITIES: Quantity[]; convert: typeof convert; sig: typeof sig; esc: typeof esc; mergeById: typeof mergeById }): void {
  const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
  const Q = lib.QUANTITIES;
  let q = Q[1];
  const pick: Record<string, { from: string; to: string }> = { length: { from: 'mm', to: 'in' }, pressure: { from: 'bar', to: 'psi' }, flow: { from: 'm3h', to: 'usgpm' }, temperature: { from: 'C', to: 'F' }, mass: { from: 'kg', to: 'lb' }, area: { from: 'm2', to: 'ft2' }, volume: { from: 'm3', to: 'usgal' }, density: { from: 'kgm3', to: 'sg' } };
  let me = { id: '', name: '' };
  let noted: Noted[] = [];
  let version = 0;
  const mineIds = new Set<string>();
  const value = $<HTMLInputElement>('#v');
  const from = $<HTMLSelectElement>('#from');
  const to = $<HTMLSelectElement>('#to');

  const tabs = $<HTMLDivElement>('#tabs');
  tabs.innerHTML = Q.map((x) => `<button class="tab" role="tab" type="button" data-q="${x.id}">${lib.esc(x.label)}</button>`).join('');
  const options = () => q.units.map((u) => `<option value="${u.id}">${lib.esc(u.label)}</option>`).join('');
  const setQuantity = (id: string) => {
    q = Q.find((x) => x.id === id) ?? Q[0];
    tabs.querySelectorAll<HTMLButtonElement>('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.q === q.id)));
    $<HTMLElement>('#qname').textContent = q.label;
    from.innerHTML = options();
    to.innerHTML = options();
    from.value = pick[q.id].from;
    to.value = pick[q.id].to;
    calc();
  };
  const read = (): number | null => {
    const t = value.value.replace(/,/g, '').trim();
    if (!/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return null;
    return Number(t);
  };
  const line = () => {
    const v = read();
    if (v === null) return '';
    const fu = q.units.find((u) => u.id === from.value)!;
    const tu = q.units.find((u) => u.id === to.value)!;
    return `${lib.sig(v)} ${fu.label} = ${lib.sig(lib.convert(Q, q.id, v, fu.id, tu.id))} ${tu.label}`;
  };
  const calc = () => {
    pick[q.id] = { from: from.value, to: to.value };
    const v = read();
    const res = $<HTMLDivElement>('#res');
    const sched = $<HTMLTableSectionElement>('#sched');
    if (v === null) { res.textContent = value.value.trim() ? 'Write a number' : '—'; res.classList.toggle('err', !!value.value.trim()); sched.innerHTML = ''; return; }
    res.classList.remove('err');
    const tu = q.units.find((u) => u.id === to.value)!;
    res.innerHTML = `${lib.esc(lib.sig(lib.convert(Q, q.id, v, from.value, to.value)))} <span class="u">${lib.esc(tu.label)}</span>`;
    if (q.id === 'temperature' && lib.convert(Q, q.id, v, from.value, 'K') < 0) { res.textContent = 'Below absolute zero'; res.classList.add('err'); }
    sched.innerHTML = q.units.map((u) => `<tr class="${u.id === to.value ? 'hit' : ''}"><td>${lib.esc(u.label)}</td><td class="n">${lib.esc(lib.sig(lib.convert(Q, q.id, v, from.value, u.id)))}</td></tr>`).join('');
  };
  const renderNoted = () => {
    $<HTMLOListElement>('#noted').innerHTML = noted.length
      ? noted.slice().reverse().map((n) => `<li><span class="mono">${lib.esc(n.text)}</span><span class="cap">${lib.esc(n.by)}</span></li>`).join('')
      : '<li class="faint">Conversions you note appear here for everyone.</li>';
  };
  const save = async () => {
    const r = await dex.state.set({ noted }, version);
    version = r.version;
    if (r.conflict) {
      const cur = await dex.state.get();
      const theirs = ((cur.state as { noted?: Noted[] } | null)?.noted) ?? [];
      noted = lib.mergeById(theirs, noted.filter((n) => mineIds.has(n.id))).slice(-60);
      version = (await dex.state.set({ noted }, cur.version)).version;
      renderNoted();
    }
  };

  tabs.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest('button'); if (b?.dataset.q) setQuantity(b.dataset.q); });
  value.addEventListener('input', calc);
  from.addEventListener('change', calc);
  to.addEventListener('change', calc);
  $<HTMLButtonElement>('#swap').addEventListener('click', () => { const f = from.value; from.value = to.value; to.value = f; calc(); });
  $<HTMLButtonElement>('#note').addEventListener('click', () => {
    const text = line();
    if (!text) return;
    const n = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, text, by: me.name, at: Date.now() };
    mineIds.add(n.id);
    noted = [...noted, n].slice(-60);
    renderNoted();
    void save();
  });
  $<HTMLButtonElement>('#post').addEventListener('click', () => { const text = line(); if (text) void dex.post(`\`${text}\``).catch(() => {}); });
  dex.on('state', (d) => {
    if (d.version <= version) return;
    version = d.version;
    noted = ((d.state as { noted?: Noted[] } | null)?.noted) ?? [];
    renderNoted();
  });

  setQuantity('pressure');
  value.value = '10';
  calc();
  void (async () => {
    me = (await dex.context()).viewer;
    const s = await dex.state.get();
    noted = ((s.state as { noted?: Noted[] } | null)?.noted) ?? [];
    version = s.version;
    renderNoted();
  })();
}

export const UNIT_CONVERTER: BuiltinApp = {
  manifest: {
    id: 'dex-units', name: 'Unit converter', version: '1.0.0',
    description: 'Length, pressure, flow, temperature, mass, area, volume and density, with every unit at once and a shared list of noted conversions.',
    permissions: ['state', 'post'], hosts: [], height: 360,
  },
  html: page({
    title: 'Unit converter',
    css: `
.body { flex: 1; display: grid; grid-template-columns: 1fr 210px; min-height: 0; }
.calc { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.calc .row .input { flex: 1; }
#v { font: 15px/1 var(--dex-font-mono); text-align: right; }
#res { font: 600 22px/1.2 var(--dex-font-display); text-align: right; }
#res .u { font-size: 14px; color: var(--dex-text-2); }
#res.err { font: 12px/1.3 var(--dex-font-body); color: var(--dex-danger); }
.sched { flex: 1; }
.ruled tr.hit td { color: var(--dex-accent-ink); font-weight: 700; }
.side { border-left: 1px solid var(--dex-stroke-strong); display: flex; flex-direction: column; min-height: 0; }
.side .cap { padding: 7px 10px 4px; }
#noted { list-style: none; margin: 0; padding: 0 10px; flex: 1; overflow: auto; }
#noted li { display: grid; padding: 4px 0; border-bottom: 1px solid var(--dex-stroke); font-size: 12px; }
.side .row { padding: 6px 8px; border-top: 1px solid var(--dex-stroke-strong); }
`,
    body: `<div class="app">
  <div class="tblock"><div style="flex:1"><span class="cap">Quantity</span><b id="qname">Pressure</b></div><div><span class="cap">Basis</span><b>SI · g = 9.80665 m/s²</b></div></div>
  <div class="tabs" id="tabs" role="tablist" aria-label="Quantity"></div>
  <div class="body">
    <div class="calc">
      <div class="row"><input id="v" class="input" inputmode="decimal" aria-label="Value" autocomplete="off"><select id="from" class="input" aria-label="From unit"></select></div>
      <div class="row"><button id="swap" class="btn ghost" type="button" title="Swap units" aria-label="Swap units">⇅</button><select id="to" class="input" aria-label="To unit"></select></div>
      <div id="res" aria-live="polite">—</div>
      <div class="scroll sched"><table class="ruled"><thead><tr><th>Unit</th><th style="text-align:right">Value</th></tr></thead><tbody id="sched"></tbody></table></div>
    </div>
    <div class="side">
      <span class="cap">Noted here</span>
      <ol id="noted"></ol>
      <div class="row"><button id="note" class="btn" type="button">Note it</button><button id="post" class="btn ghost" type="button">Post</button></div>
    </div>
  </div>
</div>`,
    main,
    lib: { QUANTITIES: QUANTITIES as unknown as Record<string, unknown>, convert, sig, esc, mergeById },
  }),
};
