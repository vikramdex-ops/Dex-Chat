// Punch list: the snags found on a site walk, by area and discipline, ticked off as they are
// fixed, with a tally board of what is still open. Everyone in the conversation works on one list.
import { esc, mergeById, page } from './kit.ts';
import type { BuiltinApp, DexApi } from './kit.ts';

export interface PunchItem { id: string; n: number; text: string; area: string; disc: string; pri: 'A' | 'B' | 'C'; by: string; created: number; done: boolean; doneBy: string | null; at: number }

/** Counts of open items by discipline and priority, for the tally board. */
export function tally(items: PunchItem[]): { open: number; closed: number; byDisc: Array<[string, number, number]>; a: number } {
  const live = items.filter((i) => i.text);
  const by = new Map<string, [number, number]>();
  for (const i of live) { const t = by.get(i.disc) ?? [0, 0]; t[i.done ? 1 : 0]++; by.set(i.disc, t); }
  return {
    open: live.filter((i) => !i.done).length,
    closed: live.filter((i) => i.done).length,
    a: live.filter((i) => !i.done && i.pri === 'A').length,
    byDisc: [...by.entries()].map(([d, [o, c]]) => [d, o, c] as [string, number, number]).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])),
  };
}

const DISCIPLINES = ['Civil', 'Structural', 'Architectural', 'Mechanical', 'Piping', 'Electrical', 'Instrumentation', 'HVAC', 'Fire', 'General'];

function main(dex: DexApi, lib: { tally: typeof tally; mergeById: typeof mergeById; esc: typeof esc; DISCIPLINES: string[] }): void {
  const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
  let me = { id: '', name: '' };
  let items: PunchItem[] = [];
  let title = 'Punch list';
  let version = 0;
  let show: 'open' | 'all' | 'closed' = 'open';
  const touched = new Set<string>();
  $<HTMLSelectElement>('#disc').innerHTML = lib.DISCIPLINES.map((d) => `<option>${lib.esc(d)}</option>`).join('');

  const render = () => {
    const t = lib.tally(items);
    $<HTMLElement>('#open').textContent = String(t.open);
    $<HTMLElement>('#closed').textContent = String(t.closed);
    $<HTMLElement>('#acount').textContent = String(t.a);
    $<HTMLElement>('#title').textContent = title;
    $<HTMLElement>('#tally').innerHTML = t.byDisc.length ? t.byDisc.map(([d, o, c]) => `<div class="tal"><span class="cap">${lib.esc(d)}</span><span class="bars">${'<i class="o"></i>'.repeat(Math.min(o, 20))}${'<i class="c"></i>'.repeat(Math.min(c, 20))}</span><b class="mono">${o}<span class="faint">/${o + c}</span></b></div>`).join('') : '<div class="faint" style="padding:8px">Nothing logged yet.</div>';
    document.querySelectorAll<HTMLButtonElement>('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.show === show)));
    const list = items.filter((i) => i.text && (show === 'all' || (show === 'open' ? !i.done : i.done)));
    const areas = [...new Set(list.map((i) => i.area || 'No area'))].sort();
    $<HTMLDivElement>('#list').innerHTML = list.length ? areas.map((a) => `<div class="area"><div class="cap ahead">${lib.esc(a)}</div>${list.filter((i) => (i.area || 'No area') === a).sort((x, y) => x.pri.localeCompare(y.pri) || x.n - y.n).map((i) => `
      <label class="item${i.done ? ' done' : ''}" data-id="${lib.esc(i.id)}">
        <input type="checkbox" ${i.done ? 'checked' : ''} data-id="${lib.esc(i.id)}" aria-label="Fixed: ${lib.esc(i.text)}">
        <span class="no mono">PL-${String(i.n).padStart(3, '0')}</span>
        <span class="pri p${i.pri}" title="Priority ${i.pri}">${i.pri}</span>
        <span class="grow txt">${lib.esc(i.text)}<span class="cap meta">${lib.esc(i.disc)} · ${lib.esc(i.by)}${i.done && i.doneBy ? ` · fixed, ${lib.esc(i.doneBy)}` : ''}</span></span>
        <button class="btn ghost del" type="button" data-del="${lib.esc(i.id)}" aria-label="Remove PL-${i.n}">×</button>
      </label>`).join('')}</div>`).join('')
      : `<div class="empty" style="height:100%">${show === 'closed' ? 'Nothing fixed yet.' : items.some((i) => i.text) ? 'Everything on this list is fixed.' : 'Log the first snag below: what, where, which discipline.'}</div>`;
  };

  const merge = (theirs: PunchItem[]) => lib.mergeById(theirs, items.filter((i) => touched.has(i.id)));
  const save = async () => {
    try {
      const r = await dex.state.set({ title, items }, version);
      version = r.version;
      if (r.conflict) {
        const cur = await dex.state.get();
        const st = cur.state as { title?: string; items?: PunchItem[] } | null;
        items = merge(st?.items ?? []);
        version = (await dex.state.set({ title: st?.title ?? title, items }, cur.version)).version;
        render();
      }
    } catch (e) { $<HTMLElement>('#msg').textContent = (e as Error).message; }
  };
  const change = (id: string, patch: Partial<PunchItem>) => {
    const i = items.find((x) => x.id === id);
    if (!i) return;
    Object.assign(i, patch, { at: Date.now() });
    touched.add(id);
    render();
    void save();
  };

  // the frame may not submit forms: Log it and Enter add the item
  const add = () => {
    const text = $<HTMLInputElement>('#text').value.trim().slice(0, 300);
    if (!text) return;
    const n = Math.max(0, ...items.map((i) => i.n)) + 1;
    const it: PunchItem = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, n, text, area: $<HTMLInputElement>('#area').value.trim().slice(0, 60), disc: $<HTMLSelectElement>('#disc').value, pri: ($<HTMLSelectElement>('#pri').value as 'A' | 'B' | 'C'), by: me.name, created: Date.now(), done: false, doneBy: null, at: Date.now() };
    items = [...items, it].slice(-400);
    touched.add(it.id);
    $<HTMLInputElement>('#text').value = '';
    $<HTMLInputElement>('#text').focus();
    if (show === 'closed') show = 'open';
    render();
    void save();
  };
  $<HTMLButtonElement>('#log').addEventListener('click', add);
  document.querySelectorAll<HTMLElement>('#add input').forEach((el) => el.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); add(); } }));
  $<HTMLDivElement>('#list').addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.type === 'checkbox' && t.dataset.id) change(t.dataset.id, { done: t.checked, doneBy: t.checked ? me.name : null });
  });
  $<HTMLDivElement>('#list').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-del]');
    if (b?.dataset.del) { e.preventDefault(); change(b.dataset.del, { text: '' }); }
  });
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((b) => b.addEventListener('click', () => { show = (b.dataset.show as typeof show) ?? 'open'; render(); }));
  // the frame may not open dialogs: rename in place
  $<HTMLButtonElement>('#rename').addEventListener('click', () => {
    const box = $<HTMLDivElement>('#renamebox');
    box.hidden = !box.hidden;
    $<HTMLInputElement>('#newname').value = title;
    if (!box.hidden) $<HTMLInputElement>('#newname').focus();
  });
  const rename = () => {
    title = $<HTMLInputElement>('#newname').value.trim().slice(0, 60) || 'Punch list';
    $<HTMLDivElement>('#renamebox').hidden = true;
    render();
    void save();
  };
  $<HTMLButtonElement>('#saveName').addEventListener('click', rename);
  $<HTMLInputElement>('#newname').addEventListener('keydown', (e) => { if (e.key === 'Enter') rename(); if (e.key === 'Escape') $<HTMLDivElement>('#renamebox').hidden = true; });
  $<HTMLButtonElement>('#post').addEventListener('click', () => {
    const open = items.filter((i) => i.text && !i.done).sort((x, y) => x.pri.localeCompare(y.pri) || x.n - y.n);
    const t = lib.tally(items);
    const text = [`**${title}**: ${t.open} open (${t.a} priority A), ${t.closed} fixed`, ...open.slice(0, 40).map((i) => `- PL-${String(i.n).padStart(3, '0')} [${i.pri}] ${i.area ? `${i.area}: ` : ''}${i.text} (${i.disc})`)].join('\n');
    void dex.post(text).catch((e: Error) => { $<HTMLElement>('#msg').textContent = e.message; });
  });

  dex.on('state', (d) => {
    if (d.version <= version) return;
    version = d.version;
    const st = d.state as { title?: string; items?: PunchItem[] } | null;
    title = st?.title ?? title;
    const theirs = st?.items ?? [];
    items = merge(theirs);
    render();
    if (items.length !== theirs.length || items.some((i, k) => theirs[k]?.id !== i.id || theirs[k]?.at !== i.at)) void save();
  });

  void (async () => {
    me = (await dex.context()).viewer;
    const s = await dex.state.get();
    const st = s.state as { title?: string; items?: PunchItem[] } | null;
    title = st?.title ?? 'Punch list';
    items = Array.isArray(st?.items) ? st!.items : [];
    version = s.version;
    render();
  })();
}

export const PUNCH_LIST: BuiltinApp = {
  manifest: {
    id: 'dex-punchlist', name: 'Punch list', version: '1.0.0',
    description: 'Snags from a site walk by area and discipline, ticked off as they are fixed, with a tally of what is still open.',
    permissions: ['state', 'post'], hosts: [], height: 440,
  },
  html: page({
    title: 'Punch list',
    css: `
.body { flex: 1; display: grid; grid-template-columns: 1fr 200px; min-height: 0; }
.main { display: flex; flex-direction: column; min-height: 0; }
#list { flex: 1; overflow: auto; padding: 0 8px 8px; }
.ahead { padding: 8px 2px 3px; border-bottom: 1px solid var(--dex-stroke-strong); }
.item { display: flex; gap: 8px; align-items: flex-start; padding: 5px 2px; border-bottom: 1px solid var(--dex-stroke); cursor: pointer; }
.item input { margin-top: 3px; accent-color: var(--dex-accent); }
.item.done .txt { text-decoration: line-through; color: var(--dex-text-3); }
.no { color: var(--dex-text-3); font-size: 11px; margin-top: 2px; }
.pri { width: 16px; height: 16px; border-radius: 3px; display: grid; place-items: center; font: 700 10px/1 var(--dex-font-mono); border: 1px solid var(--dex-stroke-strong); margin-top: 1px; }
.pri.pA { background: var(--dex-amber); color: #1a1205; border-color: transparent; }
.txt { display: grid; }
.meta { margin-top: 2px; }
.del { height: 20px; padding: 0 6px; }
#add { display: grid; grid-template-columns: 1fr 120px 120px 54px auto; gap: 6px; padding: 6px 8px; border-top: 1px solid var(--dex-stroke-strong); }
.side { border-left: 1px solid var(--dex-stroke-strong); display: flex; flex-direction: column; min-height: 0; }
.side > .cap { padding: 7px 10px 4px; }
#tally { flex: 1; overflow: auto; padding: 0 10px; }
.tal { display: grid; grid-template-columns: 1fr auto; gap: 2px 6px; padding: 5px 0; border-bottom: 1px solid var(--dex-stroke); }
.tal .bars { grid-column: 1 / 2; display: flex; gap: 2px; flex-wrap: wrap; }
.tal .bars i { width: 5px; height: 10px; border-radius: 1px; }
.tal .bars i.o { background: var(--dex-amber); }
.tal .bars i.c { background: var(--dex-stroke-strong); }
.tal b { grid-row: 1 / 3; grid-column: 2; align-self: center; }
.side .row { padding: 6px 8px; border-top: 1px solid var(--dex-stroke-strong); }
#msg { font-size: 11.5px; color: var(--dex-danger); padding: 0 8px; }
`,
    body: `<div class="app">
  <div class="tblock"><div style="flex:1"><span class="cap">List</span><b id="title">Punch list</b></div><div><span class="cap">Open</span><b id="open">0</b></div><div><span class="cap">Priority A</span><b id="acount">0</b></div><div><span class="cap">Fixed</span><b id="closed">0</b></div></div>
  <div class="tabs" role="tablist"><button class="tab" role="tab" type="button" data-show="open">Open</button><button class="tab" role="tab" type="button" data-show="all">All</button><button class="tab" role="tab" type="button" data-show="closed">Fixed</button></div>
  <div class="body">
    <div class="main">
      <div id="list"></div>
      <div id="msg" aria-live="polite"></div>
      <div id="add"><input id="text" class="input" placeholder="What needs fixing" aria-label="What needs fixing" maxlength="300"><input id="area" class="input" placeholder="Area, e.g. Pump house" aria-label="Area" maxlength="60"><select id="disc" class="input" aria-label="Discipline"></select><select id="pri" class="input" aria-label="Priority"><option value="A">A</option><option value="B" selected>B</option><option value="C">C</option></select><button id="log" class="btn primary" type="button">Log it</button></div>
    </div>
    <div class="side"><span class="cap">Tally · open of logged</span><div id="tally"></div><div id="renamebox" class="row" hidden><input id="newname" class="input grow" maxlength="60" aria-label="List name"><button id="saveName" class="btn" type="button">Save</button></div><div class="row"><button id="rename" class="btn ghost" type="button">Rename</button><button id="post" class="btn" type="button" title="Post the open items to the conversation">Post list</button></div></div>
  </div>
</div>`,
    main,
    lib: { tally, mergeById, esc, DISCIPLINES: DISCIPLINES as unknown as Record<string, unknown> },
  }),
};
