// Drawing viewer: an SVG, PNG, JPEG or the first page of a PDF shared in the conversation, with
// pan and zoom, and numbered markers everyone sees (a balloon on the drawing, a note beside it).
import { esc, mergeById, page } from './kit.ts';
import type { BuiltinApp, DexApi } from './kit.ts';
import { drawPdfPage, pdfFirstPage } from './pdf.ts';

interface Marker { id: string; x: number; y: number; n: number; note: string; by: string; byId: string; at: number; gone?: boolean }
interface Shared { fileId: string | null; fileName: string; openedBy: string; markers: Marker[] }

function main(dex: DexApi, lib: { pdfFirstPage: typeof pdfFirstPage; drawPdfPage: typeof drawPdfPage; mergeById: typeof mergeById; esc: typeof esc }): void {
  const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
  const stage = $<HTMLDivElement>('#stage');
  const layer = $<HTMLDivElement>('#layer');
  const pick = $<HTMLSelectElement>('#file');
  const msg = $<HTMLDivElement>('#msg');
  let me = { id: '', name: '' };
  let shared: Shared = { fileId: null, fileName: '', openedBy: '', markers: [] };
  let version = 0;
  let loaded: string | null = null;
  let size = { w: 1, h: 1 };
  let view = { x: 0, y: 0, z: 1 };
  let marking = false;
  let selected: string | null = null;
  const mine = new Set<string>();
  const KINDS = /\.(svg|png|jpe?g|gif|webp|pdf)$/i;

  const say = (text: string, bad = false) => { msg.textContent = text; msg.className = bad ? 'msg err' : 'msg faint'; };
  // a PDF page is drawn again at the zoom it is shown at, so thin lines stay sharp
  let pdf: { page: Awaited<ReturnType<typeof lib.pdfFirstPage>>; canvas: HTMLCanvasElement; drawn: number; timer: number; run: number } | null = null;
  const redraw = () => {
    if (!pdf) return;
    const p = pdf;
    window.clearTimeout(p.timer);
    p.timer = window.setTimeout(() => {
      const w = p.page.rotate % 180 ? p.page.box[3] - p.page.box[1] : p.page.box[2] - p.page.box[0];
      const h = p.page.rotate % 180 ? p.page.box[2] - p.page.box[0] : p.page.box[3] - p.page.box[1];
      const scale = Math.max(0.25, Math.min(view.z * (window.devicePixelRatio || 1), 6000 / Math.max(w, h)));
      if (Math.abs(scale - p.drawn) / p.drawn < 0.08) return;
      const run = ++p.run;
      const next = document.createElement('canvas');
      void lib.drawPdfPage(next, p.page, scale).then(() => {
        if (run !== p.run || pdf !== p) return;
        const ctx = p.canvas.getContext('2d');
        p.canvas.width = next.width;
        p.canvas.height = next.height;
        ctx?.drawImage(next, 0, 0);
        p.drawn = scale;
      });
    }, 160);
  };
  const apply = () => {
    redraw();
    layer.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
    $<HTMLElement>('#zoom').textContent = `${Math.round(view.z * 100)}%`;
    layer.querySelectorAll<HTMLElement>('.balloon').forEach((b) => { b.style.transform = `translate(-50%, -50%) scale(${1 / view.z})`; });
  };
  const fit = () => {
    const r = stage.getBoundingClientRect();
    const z = Math.min((r.width - 16) / size.w, (r.height - 16) / size.h, 4);
    view = { z: z > 0 ? z : 1, x: (r.width - size.w * z) / 2, y: (r.height - size.h * z) / 2 };
    apply();
  };
  const zoomAt = (factor: number, cx: number, cy: number) => {
    const z = Math.max(0.05, Math.min(40, view.z * factor));
    view = { z, x: cx - ((cx - view.x) * z) / view.z, y: cy - ((cy - view.y) * z) / view.z };
    apply();
  };

  const renderMarkers = () => {
    const live = shared.markers.filter((m) => !m.gone);
    $<HTMLElement>('#count').textContent = String(live.length);
    layer.querySelectorAll('.balloon').forEach((b) => b.remove());
    if (loaded && loaded === shared.fileId) {
      for (const m of live) {
        const b = document.createElement('button');
        b.className = `balloon${m.id === selected ? ' sel' : ''}`;
        b.type = 'button';
        b.style.left = `${m.x * size.w}px`;
        b.style.top = `${m.y * size.h}px`;
        b.textContent = String(m.n);
        b.title = `${m.n}. ${m.note || 'No note'} (${m.by})`;
        b.addEventListener('pointerdown', (e) => e.stopPropagation());
        b.addEventListener('click', (e) => { e.stopPropagation(); selected = m.id; renderMarkers(); });
        layer.appendChild(b);
      }
    }
    $<HTMLOListElement>('#marks').innerHTML = live.length ? live.map((m) => `<li class="${m.id === selected ? 'sel' : ''}" data-id="${lib.esc(m.id)}"><span class="num">${m.n}</span><span class="grow"><input class="input note" data-id="${lib.esc(m.id)}" value="${lib.esc(m.note)}" placeholder="Add a note" aria-label="Note for marker ${m.n}"><span class="cap">${lib.esc(m.by)}</span></span><button class="btn ghost del" data-id="${lib.esc(m.id)}" type="button" aria-label="Remove marker ${m.n}">×</button></li>`).join('')
      : `<li class="faint hint">${loaded ? 'Choose Mark, then click the drawing to drop a numbered marker everyone sees.' : 'Markers appear here.'}</li>`;
    apply();
  };

  const save = async () => {
    const r = await dex.state.set(shared, version);
    version = r.version;
    if (r.conflict) {
      const cur = await dex.state.get();
      const theirs = (cur.state as Shared | null) ?? shared;
      shared = { ...theirs, markers: theirs.fileId === shared.fileId ? lib.mergeById(theirs.markers ?? [], shared.markers.filter((m) => mine.has(m.id))) : theirs.markers ?? [] };
      version = (await dex.state.set(shared, cur.version)).version;
    }
    renderMarkers();
  };
  const touch = (m: Marker, patch: Partial<Marker>) => { Object.assign(m, patch, { at: Date.now() }); mine.add(m.id); void save(); };

  const open = async (fileId: string) => {
    say('Asking to open the file…');
    let f: { name: string; mime: string; bytes: ArrayBuffer };
    try { f = await dex.files.read(fileId); } catch (e) { say((e as Error).message, true); return; }
    layer.querySelectorAll('img, canvas').forEach((x) => x.remove());
    pdf = null;
    const isPdf = /pdf/i.test(f.mime) || /\.pdf$/i.test(f.name);
    try {
      if (isPdf) {
        say('Drawing the first page…');
        const pg = await lib.pdfFirstPage(new Uint8Array(f.bytes));
        const w = (pg.rotate % 180 ? pg.box[3] - pg.box[1] : pg.box[2] - pg.box[0]);
        const h = (pg.rotate % 180 ? pg.box[2] - pg.box[0] : pg.box[3] - pg.box[1]);
        const scale = Math.min(4, 2400 / Math.max(w, h));
        const canvas = document.createElement('canvas');
        await lib.drawPdfPage(canvas, pg, scale);
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        layer.prepend(canvas);
        pdf = { page: pg, canvas, drawn: scale, timer: 0, run: 0 };
        size = { w, h };
        say([pg.pages > 1 ? `Page 1 of ${pg.pages}.` : '', ...pg.warnings].filter(Boolean).join(' ') || `${f.name}`);
      } else {
        const url = URL.createObjectURL(new Blob([f.bytes], { type: /svg/i.test(f.mime) || /\.svg$/i.test(f.name) ? 'image/svg+xml' : f.mime || 'image/png' }));
        const img = new Image();
        img.alt = f.name;
        img.draggable = false;
        await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('This file could not be shown.')); img.src = url; });
        size = { w: img.naturalWidth || 1000, h: img.naturalHeight || 700 };
        img.style.width = `${size.w}px`;
        img.style.height = `${size.h}px`;
        layer.prepend(img);
        say(f.name);
      }
    } catch (e) { say((e as Error).message || 'This file could not be shown.', true); return; }
    loaded = fileId;
    $<HTMLElement>('#sheet').textContent = f.name;
    $<HTMLElement>('#empty').hidden = true;
    fit();
    if (shared.fileId !== fileId) {
      shared = { fileId, fileName: f.name, openedBy: me.name, markers: [] };
      mine.clear();
      void save();
    }
    renderMarkers();
  };

  const offerShared = () => {
    const bar = $<HTMLDivElement>('#follow');
    if (shared.fileId && shared.fileId !== loaded) {
      bar.hidden = false;
      bar.innerHTML = `<span class="grow">${lib.esc(shared.openedBy || 'Someone')} is looking at <b>${lib.esc(shared.fileName)}</b>${shared.markers.filter((m) => !m.gone).length ? ` with ${shared.markers.filter((m) => !m.gone).length} markers` : ''}.</span><button class="btn primary" type="button" id="follow-open">Open it here</button>`;
      $<HTMLButtonElement>('#follow-open').addEventListener('click', () => void open(shared.fileId!));
    } else bar.hidden = true;
  };

  // pan with a drag, zoom with the wheel, drop markers when marking
  let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
  stage.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }; stage.setPointerCapture(e.pointerId); });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (drag.moved) { view.x = drag.vx + dx; view.y = drag.vy + dy; apply(); }
  });
  stage.addEventListener('pointerup', (e) => {
    const d = drag;
    drag = null;
    if (!d || d.moved || !marking || !loaded) return;
    const r = stage.getBoundingClientRect();
    const x = (e.clientX - r.left - view.x) / view.z / size.w;
    const y = (e.clientY - r.top - view.y) / view.z / size.h;
    if (x < 0 || y < 0 || x > 1 || y > 1) return;
    const n = Math.max(0, ...shared.markers.map((m) => m.n)) + 1;
    const m: Marker = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, x, y, n, note: '', by: me.name, byId: me.id, at: Date.now() };
    mine.add(m.id);
    shared = { ...shared, markers: [...shared.markers, m] };
    selected = m.id;
    void save().then(() => (document.querySelector(`.note[data-id="${m.id}"]`) as HTMLInputElement | null)?.focus());
  });
  stage.addEventListener('wheel', (e) => { e.preventDefault(); const r = stage.getBoundingClientRect(); zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  stage.addEventListener('keydown', (e) => { if (e.key === '+' || e.key === '=') zoomAt(1.2, stage.clientWidth / 2, stage.clientHeight / 2); if (e.key === '-') zoomAt(1 / 1.2, stage.clientWidth / 2, stage.clientHeight / 2); if (e.key === '0') fit(); });
  $<HTMLButtonElement>('#zin').addEventListener('click', () => zoomAt(1.25, stage.clientWidth / 2, stage.clientHeight / 2));
  $<HTMLButtonElement>('#zout').addEventListener('click', () => zoomAt(0.8, stage.clientWidth / 2, stage.clientHeight / 2));
  $<HTMLButtonElement>('#fit').addEventListener('click', fit);
  $<HTMLButtonElement>('#mark').addEventListener('click', (e) => { marking = !marking; (e.currentTarget as HTMLElement).classList.toggle('on', marking); stage.classList.toggle('marking', marking); });
  $<HTMLButtonElement>('#open').addEventListener('click', () => { if (pick.value) void open(pick.value); });
  $<HTMLOListElement>('#marks').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const id = t.closest<HTMLElement>('[data-id]')?.dataset.id;
    const m = shared.markers.find((x) => x.id === id);
    if (!m) return;
    if (t.classList.contains('del')) { touch(m, { gone: true }); return; }
    selected = m.id;
    view.x = stage.clientWidth / 2 - m.x * size.w * view.z;
    view.y = stage.clientHeight / 2 - m.y * size.h * view.z;
    renderMarkers();
  });
  $<HTMLOListElement>('#marks').addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    const m = shared.markers.find((x) => x.id === t.dataset.id);
    if (m && t.classList.contains('note')) touch(m, { note: t.value.slice(0, 300) });
  });
  new ResizeObserver(() => { if (loaded) fit(); }).observe(stage);

  dex.on('state', (d) => {
    if (d.version <= version) return;
    version = d.version;
    const theirs = (d.state as Shared | null) ?? shared;
    shared = { fileId: theirs.fileId ?? null, fileName: theirs.fileName ?? '', openedBy: theirs.openedBy ?? '', markers: theirs.markers ?? [] };
    offerShared();
    renderMarkers();
  });

  void (async () => {
    me = (await dex.context()).viewer;
    const [files, s] = await Promise.all([dex.files.list(), dex.state.get()]);
    const usable = files.filter((f) => KINDS.test(f.name));
    pick.innerHTML = usable.length ? usable.map((f) => `<option value="${lib.esc(f.id)}">${lib.esc(f.name)}</option>`).join('') : '<option value="">No drawings shared here yet</option>';
    $<HTMLButtonElement>('#open').disabled = !usable.length;
    const st = s.state as Shared | null;
    if (st) shared = { fileId: st.fileId ?? null, fileName: st.fileName ?? '', openedBy: st.openedBy ?? '', markers: st.markers ?? [] };
    version = s.version;
    offerShared();
    renderMarkers();
  })().catch((e: Error) => say(e.message, true));
}

export const DIAGRAM_VIEWER: BuiltinApp = {
  manifest: {
    id: 'dex-diagram', name: 'Drawing viewer', version: '1.0.0',
    description: 'Look at an SVG, PNG or the first page of a PDF from the conversation together: pan, zoom and numbered markers everyone sees.',
    permissions: ['files', 'state'], hosts: [], height: 440,
  },
  html: page({
    title: 'Drawing viewer',
    css: `
.bar { display: flex; gap: 6px; align-items: center; padding: 6px 8px; border-bottom: 1px solid var(--dex-stroke-strong); flex: none; }
.bar select { max-width: 220px; }
.body { flex: 1; display: grid; grid-template-columns: 1fr 200px; min-height: 0; }
#stage { position: relative; overflow: hidden; cursor: grab; background: var(--dex-subtle); touch-action: none; outline: none; }
#stage.marking { cursor: crosshair; }
#layer { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
#layer img, #layer canvas { display: block; background: #fff; box-shadow: 0 0 0 1px var(--dex-stroke-strong); user-select: none; }
#empty { position: absolute; inset: 0; }
.balloon { position: absolute; width: 22px; height: 22px; border-radius: 50%; border: 1.5px solid var(--dex-amber); background: var(--dex-bg); color: var(--dex-text); font: 700 11px/1 var(--dex-font-mono); display: grid; place-items: center; cursor: pointer; padding: 0; transform-origin: center; }
.balloon.sel { background: var(--dex-amber); color: #1a1205; }
.side { border-left: 1px solid var(--dex-stroke-strong); display: flex; flex-direction: column; min-height: 0; }
.side > .cap { padding: 7px 10px 4px; }
#marks { list-style: none; margin: 0; padding: 0 6px; overflow: auto; flex: 1; }
#marks li { display: flex; gap: 6px; align-items: flex-start; padding: 5px 2px; border-bottom: 1px solid var(--dex-stroke); }
#marks li.sel { background: var(--dex-amber-soft); }
#marks li.hint { display: block; font-size: 12px; padding: 8px 4px; }
#marks .num { flex: none; width: 20px; height: 20px; border-radius: 50%; border: 1.5px solid var(--dex-amber); font: 700 10px/17px var(--dex-font-mono); text-align: center; }
#marks .grow { display: grid; gap: 2px; }
#marks .input { height: 24px; font-size: 12px; width: 100%; }
#marks .del { height: 22px; padding: 0 6px; }
#follow { display: flex; gap: 8px; align-items: center; padding: 6px 10px; background: var(--dex-accent-soft); border-bottom: 1px solid var(--dex-stroke-strong); flex: none; font-size: 12px; }
.msg { padding: 4px 10px; font-size: 11.5px; border-top: 1px solid var(--dex-stroke); flex: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
`,
    body: `<div class="app">
  <div class="tblock"><div style="flex:1"><span class="cap">Sheet</span><b id="sheet">—</b></div><div><span class="cap">Markers</span><b id="count">0</b></div><div><span class="cap">Zoom</span><b id="zoom">100%</b></div></div>
  <div id="follow" hidden></div>
  <div class="bar">
    <select id="file" class="input" aria-label="Drawing to open"></select><button id="open" class="btn" type="button">Open</button>
    <span class="grow"></span>
    <button id="mark" class="btn" type="button" title="Drop numbered markers">Mark</button>
    <button id="zout" class="btn ghost" type="button" aria-label="Zoom out">−</button><button id="fit" class="btn ghost" type="button">Fit</button><button id="zin" class="btn ghost" type="button" aria-label="Zoom in">+</button>
  </div>
  <div class="body">
    <div id="stage" tabindex="0" aria-label="Drawing: drag to pan, wheel to zoom"><div id="layer"></div><div id="empty" class="empty">Open an SVG, PNG or PDF shared in this conversation.</div></div>
    <div class="side"><span class="cap">Markers</span><ol id="marks"></ol></div>
  </div>
  <div id="msg" class="msg faint" aria-live="polite">Files open only after you agree, one at a time.</div>
</div>`,
    main,
    lib: { pdfFirstPage, drawPdfPage, mergeById, esc },
  }),
};
