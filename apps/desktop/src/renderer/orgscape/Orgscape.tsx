// The office drawing (Directory ▸ Org chart). Everyone on one drafting sheet you pan and zoom like
// a CAD viewer: the general arrangement of reporting lines, or the floor plan from seats. Search
// spotlights a person and flies to them; a route draws how two people are connected; a Space can be
// laid over the sheet as a loop of signal lines; a scale at the foot takes the office back in time
// to see how it grew. Every person on the sheet is also in the schedule beside it (a tree for
// keyboards and screen readers), and the arrow keys walk along the lines.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Department, PublicUser, WorkMode } from '@dex/core';
import { tr } from '../i18n/index.ts';
import { Avatar, Icon, presenceFor, presenceText, useToast } from '../ui.tsx';
import type { Presence } from '../ui.tsx';
import { useWork } from '../work/store.ts';
import { startCall } from '../rooms/engine.ts';
import { addConversation } from '../chat/store.ts';
import { Camera } from './camera.ts';
import { PLATE_H, PLATE_W, gridRef, layoutGA, marksFor, neighbour, routeBetween, routeLines } from './layout.ts';
import type { GA, Pt } from './layout.ts';
import { layoutFloor, nearestSpot } from './floor.ts';
import type { Floor } from './floor.ts';
import { drawFloor, drawGA, drawRulers, hitFloor, hitGA, readInk, walkBetween } from './render.ts';
import type { Ink, Labels, Marks, Scene } from './render.ts';
import './orgscape.css';

type Sheet = 'lines' | 'floor';
type SpaceInfo = { id: string; name: string; memberIds: string[]; mine: boolean };

/** Frame times while the drawing moves, for measuring (read by the e2e walk). */
const perf = { frames: [] as Array<{ dt: number; draw: number }>, reset() { this.frames.length = 0; } };
(globalThis as { __orgscapePerf?: typeof perf }).__orgscapePerf = perf;

/** The plot-in plays once per sheet in a session; after that the sheet is simply there. */
const introduced: Record<Sheet, boolean> = { lines: false, floor: false };

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const monthLabel = (t: number) => new Date(t).toLocaleDateString([], { month: 'short', year: 'numeric' });

export function Orgscape({ people, users, departments, meId, focus, live, onOpenCard, onMessage }: {
  people: PublicUser[]; users: Map<string, PublicUser>; departments: Map<string, Department>; meId: string;
  /** Fly to this person (from a profile's "See in the org chart", Pulse or a link). */
  focus: { id: string; n: number } | null;
  live: boolean; onOpenCard: (id: string) => void; onMessage: (id: string) => void;
}) {
  const toast = useToast();
  const work = useWork();
  const [sheet, setSheet] = useState<Sheet>('lines');
  const [selected, setSelected] = useState<string | null>(null);
  const [kbFocus, setKbFocus] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hit, setHit] = useState(0);
  const [searching, setSearching] = useState(false);
  const [spaces, setSpaces] = useState<SpaceInfo[] | null>(null);
  const [spaceMenu, setSpaceMenu] = useState<{ person: string | null } | null>(null);
  const [overlay, setOverlay] = useState<SpaceInfo | null>(null);
  const [route, setRoute] = useState<{ from: string; to: string; t0: number } | null>(null);
  const [common, setCommon] = useState<Array<{ id: string; name: string }> | null>(null);
  const [growth, setGrowth] = useState(false);
  const [asAt, setAsAt] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [schedule, setSchedule] = useState(false);
  const [legend, setLegend] = useState(false);
  const [announce, setAnnounce] = useState('');
  const [ink, setInk] = useState<Ink | null>(null);

  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const keyPlan = useRef<HTMLCanvasElement>(null);
  const callout = useRef<HTMLDivElement>(null);
  const scaleOut = useRef<HTMLSpanElement>(null);
  const gridOut = useRef<HTMLSpanElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const cam = useRef(new Camera()).current;
  const reduced = useMemo(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches, []);

  const deptName = useCallback((id: string) => departments.get(id)?.name ?? '', [departments]);
  const ga = useMemo(() => layoutGA(people, departments), [people, departments]);
  const modeOf = useCallback((id: string): WorkMode | null => { const w = work.get(id); return w && w.status !== 'out' ? w.mode : null; }, [work]);
  const floor = useMemo(() => layoutFloor(people, modeOf), [people, modeOf]);
  const joinedAt = useMemo(() => new Map(people.flatMap((u) => { const t = u.profile.joinedOn ? Date.parse(`${u.profile.joinedOn}T00:00:00`) : NaN; return Number.isNaN(t) ? [] : [[u.id, t] as const]; })), [people]);
  const marks = useMemo(() => { const now = new Date(); return new Map<string, Marks>(people.map((u) => [u.id, marksFor(u, now)] as const)); }, [people]);
  const sheetW = sheet === 'lines' ? ga.w : floor.w, sheetH = sheet === 'lines' ? ga.h : floor.h;
  const cols = Math.ceil((sheetW - 144) / 420), rows = Math.ceil((sheetH - 144) / 420);

  // presence, read fresh each render (the frame refreshes it whenever the session changes)
  const presence = new Map<string, Presence>(people.map((u) => [u.id, presenceFor(u.id)] as const));
  const presenceKey = people.map((u) => presence.get(u.id)).join(',');
  const online = people.reduce((n, u) => n + (presence.get(u.id) !== 'off' ? 1 : 0), 0);

  const labels: Labels = useMemo(() => ({
    area: tr('Area'), you: tr('You are here'), isNew: tr('New'), years: (n: number) => tr(`${n} yrs`),
    inOffice: (n: number) => tr(`${n} in`), people: (n: number) => (n === 1 ? tr('1 person') : tr(`${n} people`)),
    corridor: tr('Corridor'), north: tr('N'), home: tr('Home'), site: tr('Site'), client: tr('Client'), noSeat: tr('No seat set'),
    awayKey: tr('Working away from the office'), bay: (b: string) => tr(`Bay ${b}`), cabin: (c: string) => tr(`Cabin ${c}`), reception: tr('Front office'),
  }), [ink]);

  // the lines lit for whoever is in focus: up to the top, and their own team
  const lit = selected ?? kbFocus;
  const hot = useMemo(() => {
    const set = new Set<string>();
    if (!lit || sheet !== 'lines') return set;
    let cur: string | null = lit;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) { seen.add(cur); const p = ga.plates.get(cur); if (!p?.managerId) break; set.add(cur); cur = p.managerId; }
    for (const r of ga.plates.get(lit)?.reports ?? []) set.add(r);
    return set;
  }, [lit, ga, sheet]);

  const routeIds = useMemo(() => (route ? (sheet === 'lines' ? routeBetween(route.from, route.to, ga) : [route.from, route.to]) : null), [route, ga, sheet]);
  const walk = useMemo(() => (route && sheet === 'floor' ? walkBetween(floor, route.from, route.to) : null), [route, floor, sheet]);

  // everything the drawing needs, read by the frame loop without re-rendering React
  const scene = useRef<Scene & { sheet: Sheet; ga: GA; floor: Floor; walk: Pt[] | null; cols: number; rows: number } | null>(null);
  const pigs = useRef<Scene['pigs']>([]);
  const spot = useRef<Scene['spotlight']>(null);
  const hover = useRef<string | null>(null);
  const intro = useRef<number | null>(null);
  if (ink) {
    scene.current = {
      users, presence: (id) => presence.get(id) ?? 'off', me: meId, focus: kbFocus, hover: hover.current, selected, hot,
      spotlight: spot.current, route: route && routeIds ? { ids: routeIds, lines: sheet === 'lines' ? routeLines(routeIds, ga) : [], t0: route.t0 } : null,
      overlay: overlay ? { name: overlay.name, members: new Set(overlay.memberIds) } : null,
      asAt: sheet === 'lines' ? asAt : null, joinedAt, marks, pigs: pigs.current, intro: intro.current, now: performance.now(), reduced, ink, labels, deptName, modeOf,
      sheet, ga, floor, walk, cols, rows,
    };
  }

  // ---------------------------------------------------------------- the frame loop
  const raf = useRef(0);
  const lastFrame = useRef(0);
  const posOf = useCallback((id: string): { x: number; y: number; w: number; h: number } | null => {
    const s = scene.current;
    if (!s) return null;
    if (s.sheet === 'lines') { const p = s.ga.plates.get(id); return p ? { x: p.x, y: p.y, w: PLATE_W, h: PLATE_H } : null; }
    const sp = s.floor.spots.get(id);
    return sp ? { x: sp.x - 24, y: sp.y - 24, w: 48, h: 48 } : null;
  }, []);

  const frame = useCallback((now: number) => {
    raf.current = 0;
    const s = scene.current, c = canvas.current;
    if (!s || !c) return;
    const t0 = performance.now();
    const moving = cam.step(now);
    s.now = now;
    s.hover = hover.current;
    if (spot.current && now - spot.current.t0 > 4000) spot.current = null;
    s.spotlight = spot.current;
    s.pigs = pigs.current = pigs.current.filter((p) => now - p.t0 < 2000);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = s.ink.window;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.setTransform(dpr * cam.z, 0, 0, dpr * cam.z, -cam.x * cam.z * dpr, -cam.y * cam.z * dpr);
    if (s.sheet === 'lines') drawGA(ctx, s.ga, s, cam); else drawFloor(ctx, s.floor, s, cam, s.walk);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawRulers(ctx, cam, s.ink, s.cols, s.rows);
    // the key plan: the sheet small, with the view on it
    const kp = keyPlan.current;
    const kctx = kp?.getContext('2d');
    if (kp && kctx) {
      const kw = kp.width, kh = kp.height;
      const sw = s.sheet === 'lines' ? s.ga.w : s.floor.w, sh = s.sheet === 'lines' ? s.ga.h : s.floor.h;
      const k = Math.min(kw / sw, kh / sh);
      kctx.setTransform(1, 0, 0, 1, 0, 0);
      kctx.clearRect(0, 0, kw, kh);
      kctx.setTransform(k, 0, 0, k, (kw - sw * k) / 2, (kh - sh * k) / 2);
      kctx.fillStyle = s.ink.paper; kctx.fillRect(0, 0, sw, sh);
      kctx.fillStyle = s.ink.accentSoft; kctx.strokeStyle = s.ink.accent; kctx.lineWidth = 1 / k;
      if (s.sheet === 'lines') for (const a of s.ga.areas) { kctx.fillRect(a.x, a.y, a.w, a.h); if (!a.inner) kctx.strokeRect(a.x, a.y, a.w, a.h); }
      else for (const r of s.floor.rooms) { kctx.fillRect(r.x, r.y, r.w, r.h); kctx.strokeRect(r.x, r.y, r.w, r.h); }
      kctx.fillStyle = s.ink.accent;
      const dot = (id: string | null) => { if (!id) return; const p = posOf(id); if (p) kctx.fillRect(p.x + p.w / 2 - 3 / k, p.y + p.h / 2 - 3 / k, 6 / k, 6 / k); };
      dot(s.me);
      dot(s.selected);
      const v = cam.view(0);
      kctx.strokeStyle = s.ink.text; kctx.lineWidth = 1.5 / k;
      kctx.strokeRect(v.x, v.y, v.w, v.h);
    }
    // the callout follows its plate
    const co = callout.current;
    if (co && s.selected) {
      const p = posOf(s.selected);
      if (p) {
        const [sx, sy] = cam.toScreen(p.x + p.w, p.y);
        const narrow = cam.vw < 560;
        if (!narrow) {
          const w = co.offsetWidth, h = co.offsetHeight;
          const left = sx + 14 + w > cam.vw - 8 ? Math.max(24, cam.toScreen(p.x, p.y)[0] - w - 14) : sx + 14;
          co.style.transform = `translate(${Math.round(left)}px, ${Math.round(Math.min(cam.vh - h - 8, Math.max(26, sy)))}px)`;
        } else co.style.transform = '';
      }
    }
    if (scaleOut.current) scaleOut.current.textContent = `1:${(1 / cam.z).toFixed(cam.z >= 1 ? 2 : 1)}`;
    const draw = performance.now() - t0;
    if (lastFrame.current) { perf.frames.push({ dt: now - lastFrame.current, draw }); if (perf.frames.length > 2000) perf.frames.splice(0, 1000); }
    lastFrame.current = now;
    const animating = moving || pigs.current.length > 0 || !!spot.current || (s.intro !== null && !s.reduced && now - s.intro < 2600)
      || (!!s.route && !s.reduced && now - s.route.t0 < 9000);
    if (animating) raf.current = requestAnimationFrame(frame);
    else lastFrame.current = 0;
  }, [cam, posOf]);

  const invalidate = useCallback(() => { if (!raf.current) raf.current = requestAnimationFrame(frame); }, [frame]);
  useEffect(() => () => { if (raf.current) cancelAnimationFrame(raf.current); }, []);
  useEffect(() => { invalidate(); });

  // the theme: colours come from the page, and change with it
  useEffect(() => {
    const read = () => setInk(readInk());
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'lang'] });
    return () => mo.disconnect();
  }, []);

  // size: the canvas fills the stage at the screen's resolution
  useLayoutEffect(() => {
    const el = stage.current, c = canvas.current;
    if (!el || !c) return;
    const size = () => {
      const r = el.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      c.width = Math.max(1, Math.round(r.width * dpr)); c.height = Math.max(1, Math.round(r.height * dpr));
      c.style.width = `${r.width}px`; c.style.height = `${r.height}px`;
      cam.resize(r.width, r.height);
      invalidate();
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(el);
    return () => ro.disconnect();
  }, [cam, invalidate]);

  // a new sheet: fit it, plot it in the first time, then go to whoever was asked for (or to you)
  const touched = useRef(false);
  useLayoutEffect(() => {
    cam.bounds = { x: 0, y: 0, w: sheetW, h: sheetH };
    spot.current = null;
    cam.fit(cam.bounds, 24);
    touched.current = false;
    if (!introduced[sheet] && !reduced) { intro.current = performance.now(); introduced[sheet] = true; } else intro.current = null;
    invalidate();
    const target = focus?.id ?? meId;
    const t = setTimeout(() => {
      if (touched.current) return;
      const p = posOf(target);
      if (p && (focus || cam.z < 0.5)) cam.flyTo(p.x + p.w / 2, p.y + p.h / 2, Math.max(cam.z, sheet === 'lines' ? 0.85 : 0.9), performance.now(), reduced ? 0 : 900);
      if (focus) setSelected(focus.id);
      invalidate();
    }, intro.current !== null ? 1500 : 60);
    return () => clearTimeout(t);
  }, [sheet, sheetW, sheetH, focus?.n]);

  const flyTo = useCallback((id: string, opts: { zoom?: number; spotlight?: boolean } = {}) => {
    const p = posOf(id);
    if (!p) return;
    touched.current = true;
    cam.flyTo(p.x + p.w / 2, p.y + p.h / 2, opts.zoom ?? Math.max(cam.z, 0.9), performance.now(), reduced ? 0 : 750);
    if (opts.spotlight) spot.current = { id, t0: performance.now() + (reduced ? 0 : 500) };
    invalidate();
  }, [cam, posOf, reduced, invalidate]);

  /** Keep someone in view without flying across the sheet (for the arrow keys). */
  const reveal = useCallback((id: string) => {
    const p = posOf(id);
    if (!p) return;
    const [sx, sy] = cam.toScreen(p.x, p.y);
    const m = 60;
    if (sx < m || sy < m || sx + p.w * cam.z > cam.vw - m || sy + p.h * cam.z > cam.vh - m || cam.z < 0.5) flyTo(id, { zoom: Math.max(cam.z, 0.75) });
    else invalidate();
  }, [cam, posOf, flyTo, invalidate]);

  // something changed for someone: run a pulse down their line
  const prevPresence = useRef<Map<string, Presence> | null>(null);
  useEffect(() => {
    const prev = prevPresence.current;
    prevPresence.current = presence;
    if (!prev) return;
    const now = performance.now();
    let n = 0;
    for (const [id, p] of presence) {
      const was = prev.get(id);
      if (was === undefined || was === p || n > 12) continue;
      if ((was === 'off' && p !== 'off') || (p === 'room' && was !== 'room')) { pigs.current.push({ id, t0: now + n * 120, room: p === 'room' }); n++; }
    }
    if (n) invalidate();
  }, [presenceKey]);

  // Spaces, for the overlay
  const loadSpaces = useCallback(() => { if (live) window.dex.request('people.spaces').then((r) => setSpaces(r.spaces)).catch(() => setSpaces([])); }, [live]);
  useEffect(() => { loadSpaces(); }, [loadSpaces]);
  // Spaces in common with the far end of a route
  useEffect(() => {
    setCommon(null);
    if (!route || !live) return;
    const other = route.from === meId ? route.to : route.to === meId ? route.from : null;
    if (!other || other === meId) return;
    let on = true;
    window.dex.request('people.common', { userId: other }).then((r) => { if (on) setCommon(r.spaces); }).catch(() => {});
    return () => { on = false; };
  }, [route, live, meId]);

  // growth: play the office's history month by month
  const span = useMemo(() => {
    const ts = [...joinedAt.values()];
    if (!ts.length) return null;
    const first = new Date(Math.min(...ts)); first.setDate(1);
    const months = (new Date().getFullYear() - first.getFullYear()) * 12 + new Date().getMonth() - first.getMonth();
    return { first: first.getTime(), months: Math.max(1, months) };
  }, [joinedAt]);
  const monthAt = (i: number) => { if (!span) return Date.now(); const d = new Date(span.first); d.setMonth(d.getMonth() + i + 1, 0); d.setHours(23, 59, 59); return d.getTime(); };
  const asAtIndex = span && asAt !== null ? Math.round(((new Date(asAt).getFullYear() - new Date(span.first).getFullYear()) * 12 + new Date(asAt).getMonth() - new Date(span.first).getMonth())) : span?.months ?? 0;
  useEffect(() => {
    if (!playing || !span) return;
    let i = asAt === null || asAtIndex >= span.months ? 0 : asAtIndex;
    const step = Math.max(16, 7000 / span.months);
    const t = setInterval(() => {
      i++;
      if (i >= span.months) { setAsAt(null); setPlaying(false); return; }
      setAsAt(monthAt(i));
    }, reduced ? 400 : step);
    return () => clearInterval(t);
  }, [playing, span]);
  const presentAt = asAt === null ? people.length : people.filter((u) => (joinedAt.get(u.id) ?? -Infinity) <= asAt).length;

  // ---------------------------------------------------------------- search
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return people.filter((u) => [u.displayName, u.title ?? '', deptName(u.profile.departmentId ?? ''), u.profile.location ?? '', u.profile.extension ?? '']
      .some((f) => f.toLowerCase().includes(q))).sort((a, b) => Number(!a.displayName.toLowerCase().startsWith(q)) - Number(!b.displayName.toLowerCase().startsWith(q)) || a.displayName.localeCompare(b.displayName)).slice(0, 8);
  }, [query, people, deptName]);
  const refOf = (id: string) => {
    if (sheet === 'lines') return ga.plates.get(id)?.ref ?? '';
    const sp = floor.spots.get(id);
    return sp ? gridRef(sp.x, sp.y) : '';
  };
  const describe = (id: string) => {
    const u = users.get(id);
    if (!u) return '';
    const p = presence.get(id) ?? 'off';
    const reps = ga.plates.get(id)?.reports.length ?? 0;
    const mgr = ga.plates.get(id)?.managerId;
    return [u.displayName, u.title, deptName(u.profile.departmentId ?? ''), sentence(tr(presenceText(id, p))),
      mgr ? tr(`Reports to ${users.get(mgr)?.displayName ?? ''}`) : null, reps ? (reps === 1 ? tr('1 direct report') : tr(`${reps} direct reports`)) : null,
      tr(`Grid ${refOf(id)}`)].filter(Boolean).join(', ');
  };
  const pick = (id: string, opts: { spotlight?: boolean } = {}) => {
    setSelected(id);
    setKbFocus(id);
    flyTo(id, opts);
    setAnnounce(describe(id));
  };

  // ---------------------------------------------------------------- pointer: pan, fling, pinch, wheel
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ x: number; y: number; moved: number; samples: Array<{ x: number; y: number; t: number }>; pinch?: { d: number; mx: number; my: number } } | null>(null);
  const local = (e: { clientX: number; clientY: number }) => { const r = stage.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    touched.current = true;
    cam.stop();
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      drag.current = { x: p.x, y: p.y, moved: 99, samples: [], pinch: { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 } };
    } else drag.current = { x: p.x, y: p.y, moved: 0, samples: [{ ...p, t: performance.now() }] };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = local(e);
    const d = drag.current;
    if (!d || !pointers.current.has(e.pointerId)) {
      // hover: light the plate and show its grid reference
      const s = scene.current;
      if (!s) return;
      const [wx, wy] = cam.toWorld(p.x, p.y);
      const id = s.sheet === 'lines' ? hitGA(s.ga, wx, wy) : hitFloor(s.floor, wx, wy);
      if (gridOut.current) gridOut.current.textContent = gridRef(wx, wy);
      if (id !== hover.current) { hover.current = id; stage.current!.style.cursor = id ? 'pointer' : ''; invalidate(); }
      return;
    }
    pointers.current.set(e.pointerId, p);
    if (d.pinch && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      cam.panBy(mx - d.pinch.mx, my - d.pinch.my);
      cam.zoomAt(mx, my, dist / Math.max(1, d.pinch.d));
      d.pinch = { d: dist, mx, my };
      invalidate();
      return;
    }
    const dx = p.x - d.x, dy = p.y - d.y;
    d.moved += Math.abs(dx) + Math.abs(dy);
    d.x = p.x; d.y = p.y;
    if (d.moved > 4) { cam.panBy(dx, dy); stage.current!.classList.add('panning'); invalidate(); }
    d.samples.push({ ...p, t: performance.now() });
    if (d.samples.length > 6) d.samples.shift();
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    pointers.current.delete(e.pointerId);
    stage.current?.classList.remove('panning');
    if (!d) return;
    if (pointers.current.size) { const [q] = [...pointers.current.values()]; drag.current = { x: q.x, y: q.y, moved: 99, samples: [] }; return; }
    drag.current = null;
    if (d.moved <= 4 && !d.pinch) {
      const s = scene.current;
      if (!s) return;
      const p = local(e);
      const [wx, wy] = cam.toWorld(p.x, p.y);
      const id = s.sheet === 'lines' ? hitGA(s.ga, wx, wy) : hitFloor(s.floor, wx, wy);
      spot.current = null;
      if (id) { setSelected(id); setKbFocus(id); setAnnounce(describe(id)); } else setSelected(null);
      invalidate();
      return;
    }
    // a fling keeps going a little
    const sm = d.samples;
    if (sm.length >= 2 && !reduced) {
      const a = sm[0], b = sm[sm.length - 1];
      const dt = Math.max(1, b.t - a.t);
      if (performance.now() - b.t < 80) { cam.fling(((b.x - a.x) / dt) * 0.9, ((b.y - a.y) / dt) * 0.9, performance.now()); invalidate(); }
    }
  };
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      touched.current = true;
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      // a pinch on a touchpad, or a mouse wheel's notches, zoom; two-finger scrolling pans
      const mouseWheel = e.deltaMode === 1 || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 40);
      if (e.ctrlKey || mouseWheel) cam.zoomAt(x, y, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018)));
      else cam.panBy(-e.deltaX, -e.deltaY);
      invalidate();
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [cam, invalidate]);

  // ---------------------------------------------------------------- keyboard
  const onKeyDown = (e: React.KeyboardEvent) => {
    const s = scene.current;
    if (!s) return;
    const dirs: Record<string, 'up' | 'down' | 'left' | 'right' | undefined> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    const dir = dirs[e.key];
    const zoomBy = (f: number) => { touched.current = true; cam.flyTo(...cam.toWorld(cam.vw / 2, cam.vh / 2), cam.z * f, performance.now(), reduced ? 0 : 220); invalidate(); };
    if (dir && e.shiftKey) { e.preventDefault(); touched.current = true; cam.panBy(dir === 'left' ? 120 : dir === 'right' ? -120 : 0, dir === 'up' ? 120 : dir === 'down' ? -120 : 0); invalidate(); return; }
    if (dir) {
      e.preventDefault();
      const from = kbFocus ?? selected;
      const next = !from ? meId : s.sheet === 'lines' ? neighbour(from, dir, s.ga) : nearestSpot(from, dir, s.floor);
      if (!next) return;
      setKbFocus(next);
      if (selected) setSelected(next);
      reveal(next);
      setAnnounce(describe(next));
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      const id = kbFocus ?? selected;
      if (!id) return;
      e.preventDefault();
      if (selected === id) onOpenCard(id); else { setSelected(id); setAnnounce(describe(id)); }
      return;
    }
    if (e.key === 'Escape') {
      if (spot.current) spot.current = null;
      else if (route) setRoute(null);
      else if (overlay) setOverlay(null);
      else if (selected) setSelected(null);
      else return;
      e.preventDefault(); invalidate();
      return;
    }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(1.4); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomBy(1 / 1.4); }
    else if (e.key === '0') { e.preventDefault(); touched.current = true; cam.stop(); cam.fit(cam.bounds, 24); invalidate(); }
    else if (e.key === 'Home') { e.preventDefault(); pick(meId); }
    else if (e.key === '/') { e.preventDefault(); searchBox.current?.focus(); }
  };

  const fitAll = () => { touched.current = true; cam.stop(); const z = cam.fitZoom(cam.bounds, 24); cam.flyTo(cam.bounds.w / 2, cam.bounds.h / 2, z, performance.now(), reduced ? 0 : 500); invalidate(); };
  const zoomBtn = (f: number) => { touched.current = true; const [wx, wy] = cam.toWorld(cam.vw / 2, cam.vh / 2); cam.flyTo(wx, wy, cam.z * f, performance.now(), reduced ? 0 : 240); invalidate(); };
  const keyPlanGo = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.type === 'pointermove' && !(e.buttons & 1)) return;
    const kp = keyPlan.current!;
    const r = kp.getBoundingClientRect();
    const k = Math.min(kp.width / sheetW, kp.height / sheetH);
    const sx = ((e.clientX - r.left) * (kp.width / r.width) - (kp.width - sheetW * k) / 2) / k;
    const sy = ((e.clientY - r.top) * (kp.height / r.height) - (kp.height - sheetH * k) / 2) / k;
    touched.current = true;
    cam.stop();
    cam.centreOn(sx, sy);
    invalidate();
  };

  /** Draw how you connect to someone (lines), or the walk to their desk (floor), and frame it. */
  const startRoute = (to: string) => {
    setRoute({ from: meId, to, t0: performance.now() });
    setOverlay(null);
    spot.current = null;
    touched.current = true;
    const ids = sheet === 'lines' ? routeBetween(meId, to, ga) ?? [meId, to] : [meId, to];
    const boxes = ids.map(posOf).filter((b): b is NonNullable<typeof b> => !!b);
    if (boxes.length) {
      const x0 = Math.min(...boxes.map((q) => q.x)), y0 = Math.min(...boxes.map((q) => q.y));
      const x1 = Math.max(...boxes.map((q) => q.x + q.w)), y1 = Math.max(...boxes.map((q) => q.y + q.h));
      cam.flyTo((x0 + x1) / 2, (y0 + y1) / 2, Math.min(1, cam.fitZoom({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, 90)), performance.now(), reduced ? 0 : 800);
    }
    invalidate();
  };

  const call = async (id: string) => {
    try {
      const c = await window.dex.request('conv.create', { kind: 'direct', members: [id] });
      addConversation(c);
      await startCall(c.id, false);
    } catch (e) { toast((e as Error).message, true); }
  };

  const sel = selected ? users.get(selected) : undefined;
  const selPlate = selected ? ga.plates.get(selected) : undefined;
  const selMarks = selected ? marks.get(selected) : undefined;
  const theirSpaces = (spaces ?? []).filter((s) => !spaceMenu?.person || s.memberIds.includes(spaceMenu.person));
  const inOffice = sheet === 'floor' ? [...floor.spots.values()].filter((sp) => sp.where !== 'away' && sp.where !== 'unseated' && presence.get(sp.id) !== 'off').length : 0;
  const elsewhere = sheet === 'floor' ? floor.away.reduce((n, a) => n + a.people.length, 0) : 0;

  return (
    <div className={`orgscape sheet-${sheet}${schedule ? ' with-schedule' : ''}`}>
      <div className="os-bar" role="toolbar" aria-label="Office drawing">
        <div className="seg os-sheets" role="group" aria-label="Sheet">
          <button type="button" aria-pressed={sheet === 'lines'} onClick={() => { setSheet('lines'); }}><Icon name="branch" size={15} />Lines</button>
          <button type="button" aria-pressed={sheet === 'floor'} onClick={() => { setSheet('floor'); setGrowth(false); setAsAt(null); }}><Icon name="grid" size={15} />Floor</button>
        </div>
        <div className="os-find" role="combobox" aria-expanded={searching && results.length > 0} aria-haspopup="listbox" aria-owns="os-results">
          <Icon name="search" size={15} />
          <input ref={searchBox} className="os-find-input" value={query} placeholder="Find a person, designation, seat or extension" aria-label="Find on the drawing" aria-autocomplete="list" aria-controls="os-results"
            aria-activedescendant={searching && results[hit] ? `os-r-${results[hit].id}` : undefined}
            onFocus={() => setSearching(true)} onBlur={() => setTimeout(() => setSearching(false), 150)}
            onChange={(e) => { setQuery(e.target.value); setHit(0); setSearching(true); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setHit((h) => Math.min(results.length - 1, h + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setHit((h) => Math.max(0, h - 1)); }
              else if (e.key === 'Enter' && results[hit]) { e.preventDefault(); pick(results[hit].id, { spotlight: true }); setSearching(false); stage.current?.focus(); }
              else if (e.key === 'Escape') { setQuery(''); setSearching(false); }
            }} />
          {searching && results.length > 0 && (
            <ul className="os-results" id="os-results" role="listbox" aria-label="People on the drawing">
              {results.map((u, i) => (
                <li key={u.id} id={`os-r-${u.id}`} role="option" aria-selected={i === hit} className={i === hit ? 'on' : ''}
                  onMouseDown={(e) => { e.preventDefault(); pick(u.id, { spotlight: true }); setSearching(false); }}>
                  <Avatar user={u} presence={presence.get(u.id)} size="sm" />
                  <span className="os-r-who"><b translate="no">{u.displayName}</b><span className="faint" translate="no">{u.title ?? deptName(u.profile.departmentId ?? '')}</span></span>
                  <span className="os-r-ref mono" aria-label={tr(`Grid ${refOf(u.id)}`)}>{refOf(u.id)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="os-tools">
          <button type="button" className={`os-tool${overlay ? ' on' : ''}`} aria-haspopup="listbox" aria-expanded={!!spaceMenu} onClick={() => { setSpaceMenu(spaceMenu ? null : { person: null }); loadSpaces(); }}>
            <Icon name="chat" size={15} /><span>{overlay ? `# ${overlay.name}` : 'Spaces'}</span>
          </button>
          {sheet === 'lines' && span && (
            <button type="button" className={`os-tool${growth ? ' on' : ''}`} aria-pressed={growth} onClick={() => { setGrowth(!growth); if (growth) { setAsAt(null); setPlaying(false); } }}>
              <Icon name="history" size={15} /><span>Growth</span>
            </button>
          )}
          <button type="button" className={`os-tool${schedule ? ' on' : ''}`} aria-pressed={schedule} onClick={() => setSchedule(!schedule)}>
            <Icon name="list" size={15} /><span>Schedule</span>
          </button>
          <button type="button" className={`os-tool${legend ? ' on' : ''}`} aria-pressed={legend} onClick={() => setLegend(!legend)}>
            <Icon name="info" size={15} /><span>Key</span>
          </button>
        </div>
        {spaceMenu && (
          <div className="os-menu" role="listbox" aria-label={spaceMenu.person ? tr(`Spaces ${users.get(spaceMenu.person)?.displayName ?? ''} is in`) : tr('Lay a Space over the drawing')}
            onKeyDown={(e) => { if (e.key === 'Escape') { setSpaceMenu(null); } }}>
            <div className="os-menu-head label">{spaceMenu.person ? tr(`${users.get(spaceMenu.person)?.displayName.split(/\s+/)[0] ?? ''}'s Spaces`) : 'Who works together'}</div>
            {overlay && <button type="button" role="option" aria-selected={false} className="os-menu-item" onClick={() => { setOverlay(null); setSpaceMenu(null); }}><Icon name="x" size={14} />Clear the overlay</button>}
            {spaces === null ? <div className="os-menu-empty"><span className="spinner" /></div>
              : theirSpaces.length === 0 ? <div className="os-menu-empty faint">No Spaces to show.</div>
              : theirSpaces.slice(0, 40).map((sp) => (
                <button key={sp.id} type="button" role="option" aria-selected={overlay?.id === sp.id} className="os-menu-item" onClick={() => { setOverlay(sp); setSpaceMenu(null); setRoute(null); touched.current = true; invalidate(); }}>
                  <span translate="no"># {sp.name}</span><span className="mono faint">{sp.memberIds.length}</span>{sp.mine && <span className="chip">Yours</span>}
                </button>
              ))}
          </div>
        )}
      </div>

      <div className="os-body">
        <div ref={stage} className="os-stage" tabIndex={0} role="application" aria-roledescription={tr('drawing')}
          aria-label={sheet === 'lines' ? 'Reporting lines of the office. Arrow keys move along the lines, Enter opens a person, plus and minus zoom, 0 shows the whole sheet.' : 'Floor plan of the office. Arrow keys move between desks, Enter opens a person, plus and minus zoom, 0 shows the whole plan.'}
          aria-describedby="os-live"
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
          onPointerLeave={() => { if (hover.current) { hover.current = null; invalidate(); } }}
          onDoubleClick={(e) => { const p = local(e); touched.current = true; const [wx, wy] = cam.toWorld(p.x, p.y); cam.flyTo(wx, wy, cam.z * 2, performance.now(), reduced ? 0 : 300); invalidate(); }}
          onKeyDown={onKeyDown}
          onFocus={() => { if (!kbFocus && !selected) { /* the first arrow starts from you */ } }}>
          <canvas ref={canvas} className="os-canvas" aria-hidden="true" />
          <div id="os-live" className="os-sr" aria-live="polite">{announce}</div>

          {sel && (
            <div ref={callout} className="os-callout" role="dialog" aria-label={tr(`${sel.displayName} on the drawing`)} onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') { setSelected(null); stage.current?.focus(); } }}>
              <div className="os-co-head">
                <Avatar user={sel} presence={presence.get(sel.id)} />
                <div className="os-co-who">
                  <b translate="no">{sel.displayName}</b>
                  <span className="faint" translate="no">{sel.title ?? deptName(sel.profile.departmentId ?? '')}</span>
                </div>
                <button type="button" className="icon-btn" aria-label="Close" onClick={() => { setSelected(null); stage.current?.focus(); }}><Icon name="x" size={15} /></button>
              </div>
              <dl className="os-co-cells">
                <div><dt className="tb-k">Status</dt><dd>{sentence(tr(presenceText(sel.id, presence.get(sel.id) ?? 'off')))}{sel.statusText && <span className="os-co-sub" translate="no">{sel.statusEmoji ? `${sel.statusEmoji} ` : ''}{sel.statusText}</span>}</dd></div>
                <div><dt className="tb-k">Grid</dt><dd className="mono">{refOf(sel.id)}</dd></div>
                {sel.profile.departmentId && <div><dt className="tb-k">Dept</dt><dd translate="no">{deptName(sel.profile.departmentId)}</dd></div>}
                {sel.profile.location && <div><dt className="tb-k">Seat</dt><dd translate="no">{sel.profile.location}</dd></div>}
                {sel.profile.extension && <div><dt className="tb-k">Ext</dt><dd className="mono">{sel.profile.extension}</dd></div>}
                {selPlate?.managerId && <div><dt className="tb-k">Line manager</dt><dd><button type="button" className="tb-link" onClick={() => pick(selPlate.managerId!)}>{users.get(selPlate.managerId)?.displayName}</button></dd></div>}
                {!!selPlate?.team && <div><dt className="tb-k">Team</dt><dd>{selPlate.team === 1 ? tr('1 person') : tr(`${selPlate.team} people`)}</dd></div>}
                {sheet === 'floor' && modeOf(sel.id) && modeOf(sel.id) !== 'office' && <div><dt className="tb-k">Today</dt><dd>{modeOf(sel.id) === 'home' ? 'Working from home' : modeOf(sel.id) === 'site' ? 'On site' : 'At a client'}</dd></div>}
              </dl>
              {(selMarks?.isNew || selMarks?.birthday || !!selMarks?.years) && (
                <div className="os-co-marks">
                  {selMarks.isNew && <span className="chip accent">New this month</span>}
                  {selMarks.birthday && <span className="chip accent">Birthday today</span>}
                  {!!selMarks.years && <span className="chip accent">{selMarks.years === 1 ? tr('1 year here today') : tr(`${selMarks.years} years here today`)}</span>}
                </div>
              )}
              <div className="os-co-actions">
                {sel.id !== meId && <button type="button" className="btn primary sm" disabled={!live} onClick={() => onMessage(sel.id)}><Icon name="edit" size={14} />Write</button>}
                {sel.id !== meId && <button type="button" className="btn sm room-btn" disabled={!live} onClick={() => void call(sel.id)}><Icon name="phone" size={14} />Room</button>}
                {sel.id !== meId && <button type="button" className="btn sm" onClick={() => startRoute(sel.id)}><Icon name="branch" size={14} />{sheet === 'floor' ? 'Walk there' : 'How we connect'}</button>}
                <button type="button" className="btn sm" onClick={() => { setSpaceMenu({ person: sel.id }); loadSpaces(); }}><Icon name="chat" size={14} />Spaces</button>
                <button type="button" className="btn sm ghost" onClick={() => onOpenCard(sel.id)}><Icon name="card" size={14} />Card</button>
              </div>
            </div>
          )}
        </div>

        <Schedule open={schedule} sheet={sheet} ga={ga} floor={floor} users={users} presence={presence} deptName={deptName} refOf={refOf}
          labels={labels} active={kbFocus ?? selected} onPick={(id) => pick(id)} onOpen={onOpenCard} onClose={() => setSchedule(false)} />
      </div>

      {route && (
        <div className="os-route" role="region" aria-label="Route">
          <div className="os-route-head">
            <span className="label">{sheet === 'floor' ? 'Walk to their desk' : 'How you connect'}</span>
            <button type="button" className="icon-btn" aria-label="Clear the route" onClick={() => { setRoute(null); invalidate(); }}><Icon name="x" size={15} /></button>
          </div>
          {sheet === 'lines' ? (routeIds ? (
            <ol className="os-steps">
              {routeIds.map((id, i) => (
                <li key={id}><span className="mono os-step-n">{String(i + 1).padStart(2, '0')}</span><button type="button" className="tb-link" translate="no" onClick={() => pick(id)}>{users.get(id)?.displayName}</button>
                  {i > 0 && i < routeIds.length && <span className="faint os-step-why">{ga.plates.get(routeIds[i])?.managerId === routeIds[i - 1] ? tr('their team') : tr('line manager')}</span>}</li>
              ))}
            </ol>
          ) : <p className="faint">No reporting line joins you.</p>) : (walk ? <p className="faint">{tr(`Grid ${refOf(route.from)} to grid ${refOf(route.to)}, along the corridor.`)}</p> : <p className="faint">One of you has no desk in the office today.</p>)}
          {common && common.length > 0 && (
            <div className="os-common">
              <span className="label">{tr(`Spaces you share · ${common.length}`)}</span>
              <div className="chip-row">{common.slice(0, 6).map((c) => <button key={c.id} type="button" className="chip" translate="no" onClick={() => void window.dex.openLink?.(`dexconnect://conversation/${c.id}`).catch(() => {})}># {c.name}</button>)}</div>
            </div>
          )}
        </div>
      )}

      {growth && span && sheet === 'lines' && (
        <div className="os-growth" role="group" aria-label="How the office grew">
          <button type="button" className="icon-btn" aria-label={playing ? 'Pause' : 'Play the office growing'} onClick={() => { if (!playing && asAt === null) setAsAt(monthAt(0)); setPlaying(!playing); }}><Icon name={playing ? 'pause' : 'play'} size={15} /></button>
          <input type="range" className="os-scale" min={0} max={span.months} value={Math.min(span.months, asAtIndex)} aria-label="As at" aria-valuetext={asAt === null ? tr('Today') : monthLabel(asAt)}
            onChange={(e) => { setPlaying(false); const i = Number(e.target.value); setAsAt(i >= span.months ? null : monthAt(i)); }} />
          <span className="os-asat"><span className="tb-k">As at</span><b>{asAt === null ? tr('Today') : monthLabel(asAt)}</b><span className="faint">{tr(`${presentAt} of ${people.length} people`)}</span></span>
        </div>
      )}

      <div className="os-foot">
        <canvas ref={keyPlan} className="os-keyplan" width={336} height={210} aria-hidden="true" onPointerDown={keyPlanGo} onPointerMove={keyPlanGo} />
        <div className="os-zoom" role="group" aria-label="Zoom">
          <button type="button" className="icon-btn" aria-label="Zoom in" onClick={() => zoomBtn(1.5)}><Icon name="plus" size={15} /></button>
          <button type="button" className="icon-btn" aria-label="Zoom out" onClick={() => zoomBtn(1 / 1.5)}><Icon name="minus" size={15} /></button>
          <button type="button" className="icon-btn" aria-label="Show the whole sheet" onClick={fitAll}><Icon name="expand" size={15} /></button>
          <button type="button" className="icon-btn" aria-label="Go to me" onClick={() => pick(meId)}><Icon name="user" size={15} /></button>
        </div>
        <div className="os-titleblock" aria-label="Title block">
          <div className="os-tb-cell wide"><span className="tb-k">Drawing</span><b>{sheet === 'lines' ? 'Organisation · General arrangement' : 'Floor plan · Level 01'}</b></div>
          <div className="os-tb-cell"><span className="tb-k">People</span><span className="mono">{sheet === 'lines' ? tr(`${people.length} · ${online} online`) : tr(`${inOffice} in · ${elsewhere} away`)}</span></div>
          <div className="os-tb-cell"><span className="tb-k">Scale</span><span className="mono" ref={scaleOut}>1:1</span></div>
          <div className="os-tb-cell"><span className="tb-k">Grid</span><span className="mono" ref={gridOut}>—</span></div>
          <div className="os-tb-cell"><span className="tb-k">Drg no.</span><span className="mono" translate="no">{sheet === 'lines' ? 'DDS-ORG-001' : 'DDS-FLR-001'}</span></div>
        </div>
      </div>

      {legend && <Legend sheet={sheet} onClose={() => setLegend(false)} />}
    </div>
  );
}

/** What the marks on the sheet mean. */
function Legend({ sheet, onClose }: { sheet: Sheet; onClose: () => void }) {
  const rows: Array<[string, string]> = sheet === 'lines' ? [
    ['plate-on', 'Solid plate, tick down the edge: in the office now'],
    ['plate-off', 'Paper plate: not signed in'],
    ['room', 'Amber tick and ring: in a Room'],
    ['cloud', 'Revision cloud: joined this month'],
    ['flag', 'Pennant: birthday today'],
    ['team', 'Number in a box: people in their team'],
    ['area', 'Chain line: a department'],
    ['ghost', 'Dashed plate: had not joined yet'],
    ['signal', 'Dashed lines to a tag: a Space they share'],
  ] : [
    ['desk-on', 'Tile on a desk: in the office'],
    ['desk-off', 'Outlined tile: not signed in'],
    ['desk-away', 'Dashed desk: working elsewhere today'],
    ['cloud', 'Revision cloud: joined this month'],
    ['walk', 'Dotted line: the walk to their desk'],
  ];
  return (
    <div className="os-legend" role="dialog" aria-label="Key to the drawing" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div className="os-route-head"><span className="label">Key</span><button type="button" className="icon-btn" aria-label="Close the key" onClick={onClose}><Icon name="x" size={15} /></button></div>
      <ul>{rows.map(([k, text]) => <li key={k}><i className={`os-sym ${k}`} aria-hidden="true" /><span>{text}</span></li>)}</ul>
    </div>
  );
}

/**
 * The schedule: everyone on the sheet as a tree (lines) or by room (floor), for keyboards and
 * screen readers. Hidden until asked for, but it shows itself as soon as focus comes into it.
 */
const Schedule = memo(function Schedule({ open, sheet, ga, floor, users, presence, deptName, refOf, labels, active, onPick, onOpen, onClose }: {
  open: boolean; sheet: Sheet; ga: GA; floor: Floor; users: Map<string, PublicUser>; presence: Map<string, Presence>; deptName: (id: string) => string; refOf: (id: string) => string;
  labels: Labels; active: string | null; onPick: (id: string) => void; onOpen: (id: string) => void; onClose: () => void;
}) {
  const list = useRef<HTMLUListElement>(null);
  // the tree, flattened in reading order: [id, level, parent]
  const flat = useMemo(() => {
    const out: Array<{ key: string; id: string | null; level: number; label: string; parent: string | null; size: number }> = [];
    if (sheet === 'lines') {
      const walk = (id: string, level: number, parent: string | null) => {
        out.push({ key: id, id, level, label: '', parent, size: 0 });
        for (const r of ga.plates.get(id)?.reports ?? []) walk(r, level + 1, id);
      };
      const tops = ga.order.filter((id) => !ga.plates.get(id)!.managerId);
      for (const id of tops) walk(id, 1, null);
    } else {
      const groups = new Map<string, string[]>();
      for (const sp of floor.spots.values()) {
        const room = sp.room ? floor.rooms.find((r) => r.key === sp.room) : null;
        const g = room ? (room.kind === 'bay' ? labels.bay(room.name) : room.kind === 'cabin' ? labels.cabin(room.name) : room.name) : sp.where === 'away' ? labels.awayKey : labels.noSeat;
        (groups.get(g) ?? groups.set(g, []).get(g)!).push(sp.id);
      }
      for (const [g, ids] of groups) {
        out.push({ key: `g:${g}`, id: null, level: 1, label: g, parent: null, size: ids.length });
        for (const id of ids) out.push({ key: id, id, level: 2, label: '', parent: `g:${g}`, size: 0 });
      }
    }
    return out;
  }, [sheet, ga, floor, labels]);
  const [cursor, setCursor] = useState(0);
  useEffect(() => { const i = flat.findIndex((f) => f.id === active); if (i >= 0) setCursor(i); }, [active, flat]);
  const focusAt = (i: number) => {
    const j = Math.max(0, Math.min(flat.length - 1, i));
    setCursor(j);
    (list.current?.querySelector(`[data-i="${j}"]`) as HTMLElement | null)?.focus();
    const id = flat[j].id;
    if (id) onPick(id);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const it = flat[cursor];
    if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(cursor + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(cursor - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusAt(0); }
    else if (e.key === 'End') { e.preventDefault(); focusAt(flat.length - 1); }
    else if (e.key === 'ArrowLeft' && it?.parent) { e.preventDefault(); focusAt(flat.findIndex((f) => f.key === it.parent)); }
    else if (e.key === 'ArrowRight' && flat[cursor + 1]?.parent === it?.key) { e.preventDefault(); focusAt(cursor + 1); }
    else if ((e.key === 'Enter' || e.key === ' ') && it?.id) { e.preventDefault(); onOpen(it.id); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };
  const hasKids = (i: number) => flat[i + 1]?.parent === flat[i].key;
  return (
    <nav className={`os-schedule${open ? ' open' : ''}`} aria-label="Schedule of people">
      <div className="os-route-head"><span className="label">{sheet === 'lines' ? 'Schedule · reporting lines' : 'Schedule · by room'}</span>
        {open && <button type="button" className="icon-btn" aria-label="Close the schedule" onClick={onClose}><Icon name="x" size={15} /></button>}</div>
      <ul ref={list} role="tree" aria-label={sheet === 'lines' ? 'Reporting lines' : 'People by room'} onKeyDown={onKey}>
        {flat.map((f, i) => {
          const u = f.id ? users.get(f.id) : undefined;
          const p = f.id ? presence.get(f.id) ?? 'off' : 'off';
          return (
            <li key={f.key} role="treeitem" data-i={i} aria-level={f.level} aria-expanded={hasKids(i) ? true : undefined} aria-selected={!!f.id && f.id === active}
              tabIndex={i === cursor ? 0 : -1} className={`os-sch-row${f.id && f.id === active ? ' on' : ''}${f.id ? '' : ' group'}`} style={{ paddingLeft: 10 + (f.level - 1) * 16 }}
              onClick={() => { setCursor(i); if (f.id) onPick(f.id); }} onDoubleClick={() => f.id && onOpen(f.id)}>
              {u ? (
                <>
                  <span className={`os-sch-dot p-${p}`} aria-hidden="true" />
                  <span className="os-sch-name" translate="no">{u.displayName}</span>
                  <span className="os-sch-meta faint">{u.title ? <span translate="no">{u.title}</span> : null}{u.profile.departmentId ? <span translate="no">{deptName(u.profile.departmentId)}</span> : null}<span>{sentence(tr(presenceText(u.id, p)))}</span></span>
                  <span className="os-sch-ref mono" aria-label={tr(`Grid ${refOf(u.id)}`)}>{refOf(u.id)}</span>
                </>
              ) : <><span className="os-sch-name" translate="no">{f.label}</span><span className="mono faint">{f.size}</span></>}
            </li>
          );
        })}
      </ul>
    </nav>
  );
});
