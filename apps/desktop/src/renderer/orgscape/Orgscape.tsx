// The office drawing (Directory ▸ Org chart). Everyone on one drafting sheet you pan and zoom like
// a CAD viewer: the general arrangement of reporting lines, or the floor plan from seats. Search
// spotlights a person and flies to them; a route draws how two people are connected; a Space can be
// laid over the sheet as a loop of signal lines; a scale at the foot takes the office back in time
// to see how it grew. Every person on the sheet is also in the schedule beside it (a tree for
// keyboards and screen readers), and the arrow keys walk along the lines.
import { Suspense, lazy, memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { Department, FloorPlan, Holders, PublicUser, SeatMove, WorkMode } from '@dex/core';
import { applyMoves, changedSeats, diffHolders, flowMoves, layoutChanges, placeMoves, seatLabel, ymd } from '@dex/core';
import { tr } from '../i18n/index.ts';
import { Avatar, Icon, presenceFor, presenceText, useToast } from '../ui.tsx';
import type { Presence } from '../ui.tsx';
import { useWork } from '../work/store.ts';
import { startCall } from '../rooms/engine.ts';
import { addConversation } from '../chat/store.ts';
import { Camera, MAX_Z, MIN_Z } from './camera.ts';
import { PLATE_H, PLATE_W, gridRef, layoutGA, marksFor, neighbour, routeBetween, routeLines } from './layout.ts';
import type { GA, Pt } from './layout.ts';
import { layoutFloor, nearestSpot } from './floor.ts';
import type { Floor } from './floor.ts';
import { drawFloor, drawGA, drawRulers, hitFloor, hitGA, readInk, walkBetween } from './render.ts';
import type { Ink, Labels, Marks, Scene } from './render.ts';
import { K, entrance, hitRoom, hitSeat, planFloor, planWalk, toFt } from './plan.ts';
import { drawPlanFloor } from './drawplan.ts';
import type { PlanScene } from './drawplan.ts';
import { addToDraft, currentDraft, draftHolders, reloadSeating, takeFloorRequest, useSeating } from './seating/store.ts';
import { editorReducer, problems } from './seating/editor.ts';
import type { EditorState } from './seating/editor.ts';
import type { ArrangeTab } from './seating/Arrange.tsx';
import { download, renderPlan, toPdf, toPng } from './seating/exportPlan.ts';
import './orgscape.css';
import './seating/seating.css';

// arranging seats and the revisions are for when they are asked for
const Arrange = lazy(() => import('./seating/Arrange.tsx'));
const Revisions = lazy(() => import('./seating/Revisions.tsx').then((m) => ({ default: m.Revisions })));
const UnderlayDialog = lazy(() => import('./seating/Revisions.tsx').then((m) => ({ default: m.UnderlayDialog })));

/** Department colours for the wash: soft, distinct, never amber (amber is for attention). */
const WASH = ['#1c7680', '#2f5d8a', '#6a4c93', '#8a3b5c', '#4d6b2f', '#305f72', '#a0522d', '#3d5a5e', '#5b6abf', '#2e7d5b', '#7a4f8a', '#99673a'];

type Sheet = 'lines' | 'floor';
type SpaceInfo = { id: string; name: string; memberIds: string[]; mine: boolean };

/** Frame times while the drawing moves, for measuring (read by the e2e walk). */
const perf = { frames: [] as Array<{ dt: number; draw: number }>, reset() { this.frames.length = 0; } };
(globalThis as { __orgscapePerf?: typeof perf }).__orgscapePerf = perf;

/** The plot-in plays once per sheet in a session; after that the sheet is simply there. */
const introduced: Record<Sheet, boolean> = { lines: false, floor: false };

/** The callout's size on a wide screen, for choosing its side before it is drawn. */
const CALLOUT_W = 300;
const CALLOUT_H = 330;
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const walkLength = (pts: Pt[]) => pts.reduce((n, p, i) => (i ? n + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
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
  const [route, setRoute] = useState<{ from: string; to: string; t0: number; seat?: string; start?: string } | null>(null);
  const [common, setCommon] = useState<Array<{ id: string; name: string }> | null>(null);
  const [growth, setGrowth] = useState(false);
  const [asAt, setAsAt] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [schedule, setSchedule] = useState(false);
  const [legend, setLegend] = useState(false);
  const [announce, setAnnounce] = useState('');
  const [ink, setInk] = useState<Ink | null>(null);
  // the real floor plan (from the hub), and arranging it
  const { view: sv } = useSeating(live);
  const [arrange, setArrange] = useState<ArrangeTab | null>(null);
  const [revsOpen, setRevsOpen] = useState(false);
  const [underlayOpen, setUnderlayOpen] = useState(false);
  const [wash, setWash] = useState(false);
  const [compare, setCompare] = useState<{ a: string; b: string } | null>(null);
  const [compared, setCompared] = useState<{ plan: FloorPlan; holders: Holders; seats: Set<string>; rev: string } | null>(null);
  const [preview, setPreview] = useState<SeatMove[] | null>(null);
  const [editor, dispatch] = useReducer(editorReducer, null as EditorState | null);
  const [seatSel, setSeatSel] = useState<string | null>(null);
  const [underlayImg, setUnderlayImg] = useState<HTMLImageElement | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [reserve, setReserve] = useState<string | null>(null);
  /** The day a hot desk is booked for in the seat callout (today, or a working day up to two weeks ahead). */
  const [bookDay, setBookDay] = useState<string | null>(null);
  useEffect(() => { setBookDay(null); }, [seatSel]);
  useEffect(() => { setReserve(null); }, [seatSel]);
  const canEdit = !!sv?.canEdit;
  const editing = !!editor && arrange === 'layout';

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
  const today = ymd(Date.now());
  const planShown = editing ? editor!.plan : compared ? compared.plan : sv?.plan ?? null;
  const holdersShown = compared ? compared.holders : sv?.holders ?? null;
  const floor = useMemo(() => (sv && planShown && holdersShown
    ? planFloor(planShown, sv.version, holdersShown, people, compared ? () => null : modeOf, sv.bookings, today)
    : layoutFloor(people, modeOf)), [people, modeOf, sv, planShown, holdersShown, compared, today]);
  const plan = floor.plan ?? null;
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
  const walk = useMemo(() => (route && sheet === 'floor'
    ? (floor.plan ? planWalk(floor, route.from, route.seat ? { seat: route.seat } : { id: route.to }, route.start) : walkBetween(floor, route.from, route.to))
    : null), [route, floor, sheet]);

  // what the plan draws on top: moves to come, a team's preview, revision clouds, the editor's marks
  const deptIndex = useMemo(() => new Map([...departments.values()].sort((a, b) => a.name.localeCompare(b.name)).map((d, i) => [d.id, i] as const)), [departments]);
  const deptColor = useCallback((id: string) => WASH[(deptIndex.get(id) ?? 0) % WASH.length], [deptIndex]);
  const draft = sv ? currentDraft(sv) : null;
  const pending = useMemo(() => {
    if (!sv || compared || editing) return [];
    const out: PlanScene['pending'] = [];
    for (const p of sv.plans) if (p.status === 'scheduled') for (const c of p.changes) out.push({ from: c.from, to: c.to, userId: c.userId, draft: false });
    if (draft && arrange) for (const c of diffHolders(sv.holders, applyMoves(sv.holders, draft.moves))) out.push({ from: c.from, to: c.to, userId: c.userId, draft: true });
    if (preview) { const dh = draftHolders(sv); for (const c of diffHolders(dh, applyMoves(dh, preview))) out.push({ from: c.from, to: c.to, userId: c.userId, draft: true }); }
    return out;
  }, [sv, draft, arrange, preview, compared, editing]);
  const bad = useMemo(() => (editing ? problems(editor!.plan).seats : new Set<string>()), [editing, editor?.plan]); // eslint-disable-line react-hooks/exhaustive-deps
  const dragRef = useRef<PlanScene['drag']>(null);
  const hoverSeat = useRef<string | null>(null);
  const words = useMemo(() => ({ free: tr('Free'), hot: tr('Hot desk'), booked: tr('Booked'), nos: (n: number) => tr(`${n} Nos.`), zoneSeats: (n: number) => (n === 1 ? tr('1 seat') : tr(`${n} seats`)) }), [ink]);

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
      seating: {
        mode: editing ? 'layout' : arrange ? 'arrange' : 'view', wash, deptColor, pending,
        clouds: compared ? { seats: compared.seats, rev: compared.rev } : null,
        hoverSeat: hoverSeat.current, focusSeat: seatSel, selSeats: new Set(editing ? editor!.sel : []), selRoom: editing ? editor!.room : null,
        drag: dragRef.current, bad, underlay: editing && underlayImg && sv?.underlay ? { img: underlayImg, ...sv.underlay } : null, words,
      },
    };
  }

  // ---------------------------------------------------------------- the frame loop
  const raf = useRef(0);
  const calloutSide = useRef<{ id: string; side: 'left' | 'right' } | null>(null);
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
    if (s.seating) { s.seating.drag = dragRef.current; s.seating.hoverSeat = hoverSeat.current; }
    if (s.sheet === 'lines') drawGA(ctx, s.ga, s, cam); else if (s.floor.plan && s.seating) drawPlanFloor(ctx, s.floor, s, cam, s.walk); else drawFloor(ctx, s.floor, s, cam, s.walk);
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
      else if (s.floor.plan) {
        const b = s.floor.building;
        kctx.fillRect(b.x, b.y, b.w, b.h); kctx.strokeRect(b.x, b.y, b.w, b.h);
        kctx.fillStyle = s.ink.text3;
        for (const q of s.floor.plan.seats) kctx.fillRect(q.x - 2 / k, q.y - 2 / k, 4 / k, 4 / k);
      } else for (const r of s.floor.rooms) { kctx.fillRect(r.x, r.y, r.w, r.h); kctx.strokeRect(r.x, r.y, r.w, r.h); }
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
          const side = calloutSide.current?.id === s.selected ? calloutSide.current.side : sx + 14 + w > cam.vw - 8 ? 'left' : 'right';
          const left = side === 'left' ? Math.max(24, cam.toScreen(p.x, p.y)[0] - w - 14) : Math.min(sx + 14, cam.vw - w - 8);
          co.style.transform = `translate(${Math.round(left)}px, ${Math.round(Math.max(26, Math.min(cam.vh - h - 118, sy - 10)))}px)`;
        } else co.style.transform = '';
      }
    }
    if (scaleOut.current) scaleOut.current.textContent = `1:${(1 / cam.z).toFixed(cam.z >= 1 ? 2 : 1)}`;
    const draw = performance.now() - t0;
    // frames close together belong to one movement (a drag, a wheel, a flight)
    if (lastFrame.current && now - lastFrame.current < 250) { perf.frames.push({ dt: now - lastFrame.current, draw }); if (perf.frames.length > 2000) perf.frames.splice(0, 1000); }
    lastFrame.current = now;
    const animating = moving || pigs.current.length > 0 || !!spot.current || (s.intro !== null && !s.reduced && now - s.intro < 2600)
      || (!!s.route && !s.reduced && now - s.route.t0 < 9000);
    if (animating) raf.current = requestAnimationFrame(frame);
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

  /**
   * Show a whole rectangle of the sheet, centred in the part of the stage that is free: inside the
   * rulers (top and left) and above the key plan and title block (bottom).
   */
  const frameRect = useCallback((r: { x: number; y: number; w: number; h: number }, dur: number, maxZ = MAX_Z) => {
    const narrow = cam.vw < 560;
    const left = 18 + 16, top = 18 + 16, right = 16, bottom = narrow ? 64 : 124;
    const aw = Math.max(40, cam.vw - left - right), ah = Math.max(40, cam.vh - top - bottom);
    const z = Math.min(maxZ, Math.max(MIN_Z, Math.min(aw / r.w, ah / r.h)));
    // the world point that must sit at the middle of the stage so the rectangle sits in the free part
    const wx = r.x + r.w / 2 - (left + aw / 2 - cam.vw / 2) / z;
    const wy = r.y + r.h / 2 - (top + ah / 2 - cam.vh / 2) / z;
    if (dur <= 0) { cam.stop(); cam.centreOn(wx, wy, z); } else cam.flyTo(wx, wy, z, performance.now(), dur);
    invalidate();
  }, [cam, invalidate]);

  /** The whole sheet; on the real plan, the building with its dimension strings (the keys sit beside it). */
  const fitTarget = () => { const f = scene.current?.floor; return sheet === 'floor' && f?.plan ? { x: f.building.x - 150, y: f.building.y - 150, w: f.building.w + 300, h: f.building.h + 300 } : cam.bounds; };
  // a new sheet: frame all of it, plot it in the first time, then go to whoever was asked for
  // (on the reporting lines, also to you when the office is too big to read whole)
  const touched = useRef(false);
  const followed = useRef(0);
  /** The person to fly to on the sheet being switched to (the callout's way across). */
  const jumpTo = useRef<{ id: string; n: number } | null>(null);
  useLayoutEffect(() => {
    cam.bounds = { x: 0, y: 0, w: sheetW, h: sheetH };
    spot.current = null;
    frameRect(sheet === 'floor' && floor.plan ? { x: floor.building.x - 150, y: floor.building.y - 150, w: floor.building.w + 300, h: floor.building.h + 300 } : cam.bounds, 0);
    touched.current = false;
    if (!introduced[sheet] && !reduced) { intro.current = performance.now(); introduced[sheet] = true; } else intro.current = null;
    invalidate();
    // a request to open at someone is followed once, not again on every change of sheet
    // (or someone carried across from the other sheet: Find on the floor, See in the reporting lines)
    const jumped = jumpTo.current;
    jumpTo.current = null;
    const asked = jumped ?? (focus && focus.n !== followed.current ? focus : null);
    if (asked && !jumped) followed.current = asked.n;
    const target = asked?.id ?? meId;
    const t = setTimeout(() => {
      if (touched.current) return;
      const p = posOf(target);
      if (p && asked) { setSelected(asked.id); flyTo(asked.id, { zoom: Math.max(cam.z, sheet === 'lines' ? 0.85 : 0.9), callout: true, spotlight: !!jumped }); }
      else if (p && sheet === 'lines' && cam.z < 0.5) cam.flyTo(p.x + p.w / 2, p.y + p.h / 2, 0.85, performance.now(), reduced ? 0 : 900);
      invalidate();
    }, intro.current !== null ? 1500 : 60);
    return () => clearTimeout(t);
  }, [sheet, sheetW, sheetH, focus?.n]);

  const flyTo = useCallback((id: string, opts: { zoom?: number; spotlight?: boolean; callout?: boolean } = {}) => {
    const p = posOf(id);
    if (!p) return;
    touched.current = true;
    const z = opts.zoom ?? Math.min(Math.max(cam.z, 0.9), 1.2);
    if (opts.callout && cam.vw >= 560) {
      // the callout goes on the side that covers fewer people; the person and the callout are
      // framed together, the person's plate and lines left in view beside it
      const cw = (CALLOUT_W + 14) / z, ch = CALLOUT_H / z, top = p.y - 10 / z;
      const s = scene.current;
      const rects: Array<{ x: number; y: number; w: number; h: number }> = !s ? [] : s.sheet === 'lines'
        ? [...s.ga.plates.values()].filter((q) => q.id !== id).map((q) => ({ x: q.x, y: q.y, w: PLATE_W, h: PLATE_H }))
        : [...s.floor.spots.values()].filter((q) => q.id !== id).map((q) => ({ x: q.x - 24, y: q.y - 24, w: 48, h: 48 }));
      const covered = (x: number) => rects.filter((q) => q.x < x + cw && q.x + q.w > x && q.y < top + ch && q.y + q.h > top).length;
      const side = covered(p.x + p.w) <= covered(p.x - cw) ? 'right' : 'left';
      calloutSide.current = { id, side };
      const pairX = side === 'right' ? p.x : p.x - cw, pairW = p.w + cw;
      const left = 34, right = 16, bottom = 124, topIn = 34;
      const wx = pairX + pairW / 2 - ((left + (cam.vw - left - right) / 2) - cam.vw / 2) / z;
      const wy = top + Math.min(ch, (cam.vh - topIn - bottom) / z) / 2 - ((topIn + (cam.vh - topIn - bottom) / 2) - cam.vh / 2) / z;
      cam.flyTo(wx, wy, z, performance.now(), reduced ? 0 : 750);
    } else {
      // on a phone the callout covers the lower half: keep the person in the upper part
      const lift = cam.vw < 560 ? (cam.vh * 0.22) / z : 0;
      cam.flyTo(p.x + p.w / 2, p.y + p.h / 2 + lift, z, performance.now(), reduced ? 0 : 750);
    }
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

  // comparing two revisions: the later one is drawn, with clouds round the seats that changed
  useEffect(() => {
    if (!compare) { setCompared(null); return; }
    let on = true;
    Promise.all([window.dex.request('seating.rev', { rev: compare.a }), window.dex.request('seating.rev', { rev: compare.b })]).then(([a, b]) => {
      if (!on) return;
      const [older, newer] = a.rev.at <= b.rev.at ? [a, b] : [b, a];
      const lc = layoutChanges(older.plan, newer.plan);
      const seats = new Set([...changedSeats(older.holders, newer.holders), ...lc.added, ...lc.moved].filter((id) => newer.plan.seats.some((q) => q.id === id)));
      setCompared({ plan: newer.plan, holders: newer.holders, seats, rev: newer.rev.rev });
      setAnnounce(seats.size === 1 ? tr(`Rev ${older.rev.rev} to Rev ${newer.rev.rev}: 1 seat changed`) : tr(`Rev ${older.rev.rev} to Rev ${newer.rev.rev}: ${seats.size} seats changed`));
      invalidate();
    }).catch((e: Error) => { toast(e.message, true); setCompare(null); });
    return () => { on = false; };
  }, [compare?.a, compare?.b]); // eslint-disable-line react-hooks/exhaustive-deps
  // the underlay, for tracing while the layout is edited
  useEffect(() => {
    if (!editing || !sv?.underlay) { setUnderlayImg(null); return; }
    let on = true;
    window.dex.request('seating.underlayImage').then((r) => { if (!on || !r.image) return; const img = new Image(); img.onload = () => { if (on) { setUnderlayImg(img); invalidate(); } }; img.src = r.image; }).catch(() => {});
    return () => { on = false; };
  }, [editing, sv?.underlay?.x, sv?.underlay?.y, sv?.underlay?.w, sv?.underlay?.opacity]); // eslint-disable-line react-hooks/exhaustive-deps
  // the editor opens on the plan as it is now
  useEffect(() => { if (arrange !== 'layout' && editor && !editor.dirty) dispatch({ t: 'close' }); }, [arrange]); // eslint-disable-line react-hooks/exhaustive-deps
  // dexconnect://floor/W-A14 (a seat notice's "Walk there"): the plan, and the walk to that seat
  const [floorAsk, setFloorAsk] = useState<{ seat: string; n: number } | null>(() => takeFloorRequest());
  useEffect(() => {
    const on = () => { const r = takeFloorRequest(); if (r) setFloorAsk(r); };
    window.addEventListener('dex-floor', on);
    return () => window.removeEventListener('dex-floor', on);
  }, []);
  useEffect(() => {
    if (!floorAsk || !sv) return;
    if (sheet !== 'floor') { setSelected(null); setSheet('floor'); return; }
    if (!floor.plan?.byId.has(floorAsk.seat)) return;
    setFloorAsk(null);
    const fromSeat = sv.notice?.seatId === floorAsk.seat ? sv.notice.from ?? 'entrance' : undefined;
    const t = setTimeout(() => { setSelected(null); startRoute(meId, floorAsk.seat, fromSeat); setAnnounce(tr(`The walk to ${floorAsk.seat}`)); }, 400);
    return () => clearTimeout(t);
  }, [floorAsk, sv, sheet, floor]); // eslint-disable-line react-hooks/exhaustive-deps

  const exportPlan = async (format: 'pdf' | 'png') => {
    if (!sv || !ink) return;
    const rev = sv.revisions[0];
    const c = renderPlan({
      view: sv, people, users, ink, labels, words, deptName, deptColor, wash, office: tr(`Seating plan · ${sv.plan.name}`), today,
      tb: { title: tr('Drawing'), drawing: tr('Seats'), drgNo: tr('Drg no.'), rev: tr('Rev'), date: tr('Date'), scale: rev ? new Date(rev.at).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }) : '', seats: tr(`${Object.values(sv.holders).filter((h) => h.kind === 'person' || h.kind === 'named').length} of ${sv.plan.seats.length} held`) },
    });
    const name = `${sv.plan.drawingNo}-Rev${rev?.rev ?? 'A'}.${format}`;
    download(format === 'pdf' ? await toPdf(c) : await toPng(c), name);
    toast(tr(`Saved ${name}`));
  };

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
  /**
   * Seats whose ID matches what is typed (on the real plan): "W-A1" finds W-A1, W-A10…; and seats
   * held by a name from the office drawing whose person has not joined yet ("Shar" finds Sharada).
   */
  const seatResults = useMemo(() => {
    if (!plan) return [];
    const typed = query.trim().toLowerCase();
    const byName = typed.length < 2 ? [] : plan.seats.filter((x) => x.holder?.kind === 'named' && (x.holder.name.toLowerCase().startsWith(typed) || x.holder.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(typed))))
      .sort((a, b) => (a.holder?.kind === 'named' && b.holder?.kind === 'named' ? a.holder.name.localeCompare(b.holder.name) : 0)).slice(0, 6).map((x) => x.seat.id);
    const q = query.trim().toUpperCase().replace(/\s+/g, '');
    if (q.length < 2 || !/^[A-Z]+[-A-Z0-9]*$/.test(q)) return byName;
    const key = (x: string) => x.replace(/-/g, '');
    const ids = plan.plan.seats.filter((x) => key(x.id).startsWith(key(q))).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true })).slice(0, 4).map((x) => x.id);
    return [...byName, ...ids.filter((x) => !byName.includes(x))].slice(0, 8);
  }, [query, plan]);
  const pickSeat = (seatId: string) => { setSelected(null); setSeatSel(seatId); flyToSeat(seatId); setAnnounce(seatTip(seatId)); };
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
    flyTo(id, { ...opts, callout: true });
    setAnnounce(describe(id));
  };

  // ---------------------------------------------------------------- pointer: pan, fling, pinch, wheel
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ x: number; y: number; moved: number; samples: Array<{ x: number; y: number; t: number }>; pinch?: { d: number; mx: number; my: number } } | null>(null);
  const local = (e: { clientX: number; clientY: number }) => { const r = stage.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  // ---------------------------------------------------------------- seats: drag people, tips, flying to a seat
  const personDrag = useRef<{ ids: string[]; x0: number; y0: number; active: boolean; external?: boolean } | null>(null);
  const seatDrag = useRef<{ origin: FloorPlan; ft: [number, number]; moved: boolean } | null>(null);
  const roomClick = useRef<string | null>(null);
  const seatTip = (seatId: string): string => {
    const m = scene.current?.floor.plan;
    const sv2 = m?.byId.get(seatId);
    if (!m || !sv2) return seatId;
    const zone = m.plan.zones.find((z) => z.id === sv2.seat.zone)?.name ?? '';
    const who = sv2.occupant ? users.get(sv2.occupant)?.displayName ?? '' : sv2.holder?.kind === 'reserved' ? sv2.holder.label : sv2.holder?.kind === 'named' ? sv2.holder.name : sv2.holder?.kind === 'hot' ? tr('Hot desk') : tr('Free');
    const state = sv2.occupant ? (sv2.away ? tr('Away today') : sentence(tr(presenceText(sv2.occupant, presence.get(sv2.occupant) ?? 'off')))) : '';
    return [seatId, zone, who, state].filter(Boolean).join(' · ');
  };
  const seatPos = useCallback((seatId: string) => { const m = scene.current?.floor.plan; const q = m?.byId.get(seatId); return q ? { x: q.x - 24, y: q.y - 24, w: 48, h: 48 } : null; }, []);
  const flyToSeat = useCallback((seatId: string) => {
    const b = seatPos(seatId);
    if (!b) return;
    touched.current = true;
    cam.flyTo(b.x + 24, b.y + 24 + (cam.vw < 560 ? (cam.vh * 0.2) / Math.max(cam.z, 0.9) : 0), Math.max(cam.z, 0.9), performance.now(), reduced ? 0 : 650);
    invalidate();
  }, [cam, seatPos, reduced, invalidate]);
  const movePersonDrag = (x: number, y: number) => {
    const pd = personDrag.current;
    const sc = scene.current;
    if (!pd || !sc?.floor.plan) return;
    if (!pd.active && Math.hypot(x - pd.x0, y - pd.y0) < 6) return;
    pd.active = true;
    const [wx, wy] = cam.toWorld(x, y);
    const hit = x >= 0 && y >= 0 && x <= cam.vw && y <= cam.vh ? hitSeat(sc.floor.plan, wx, wy) : null;
    const target = hit?.seat.id ?? null;
    const dh = sv ? draftHolders(sv) : {};
    const there = target ? dh[target] : null;
    dragRef.current = { ids: pd.ids, x: wx, y: wy, target, swap: !!there && !(there.kind === 'person' && pd.ids.includes(there.userId)) };
    stage.current?.classList.add('dragging');
    invalidate();
  };
  /** Drop people on a seat: one person moves there (swapping with whoever holds it); several fill the zone from that seat on. */
  const dropOn = async (ids: string[], seatId: string) => {
    if (!sv) return;
    const seat = sv.plan.seats.find((q) => q.id === seatId);
    if (!seat) return;
    const dh = draftHolders(sv);
    const moves = ids.length === 1 ? placeMoves(dh, ids[0], seatId) : flowMoves(sv.plan, dh, ids, { zoneId: seat.zone, fromSeat: seatId }).moves;
    if (!moves.length) return;
    const there = dh[seatId];
    try {
      await addToDraft(moves);
      const name = users.get(ids[0])?.displayName ?? '';
      const msg = ids.length > 1 ? tr(`${ids.length} people placed from ${seatId}`) : there && there.kind === 'person' && there.userId !== ids[0] ? tr(`${name} and ${users.get(there.userId)?.displayName ?? ''} swap seats`) : tr(`${name} to ${seatId}`);
      setAnnounce(msg);
      toast(msg);
      if (arrange !== 'moves' && arrange !== 'people') setArrange('people');
    } catch (err) { toast((err as Error).message, true); }
  };
  const endPersonDrag = () => {
    const d = dragRef.current;
    dragRef.current = null;
    stage.current?.classList.remove('dragging');
    invalidate();
    if (d?.target) void dropOn(d.ids, d.target);
  };
  /** A drag that starts in the people list and ends on the plan. */
  const startExternalDrag = (ids: string[], e: React.PointerEvent) => {
    if (!ids.length) return;
    const r0 = stage.current?.getBoundingClientRect();
    if (!r0) return;
    personDrag.current = { ids, x0: e.clientX - r0.left, y0: e.clientY - r0.top, active: false, external: true };
    const move = (ev: PointerEvent) => { const r = stage.current!.getBoundingClientRect(); movePersonDrag(ev.clientX - r.left, ev.clientY - r.top); };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      const r = stage.current!.getBoundingClientRect();
      const inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
      const pd = personDrag.current;
      personDrag.current = null;
      if (pd?.active && inside) endPersonDrag();
      else { dragRef.current = null; stage.current?.classList.remove('dragging'); invalidate(); }
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  };
  // for the end-to-end walk: where a seat is on the screen
  (globalThis as { __seatScreen?: (id: string) => { x: number; y: number } | null }).__seatScreen = (id: string) => {
    const b = seatPos(id); const r = stage.current?.getBoundingClientRect();
    if (!b || !r) return null;
    const [sx, sy] = cam.toScreen(b.x + 24, b.y + 24);
    return { x: r.left + sx, y: r.top + sy };
  };
  const viewCentreFt = (): [number, number] => {
    const m = scene.current?.floor.plan;
    const [x, y] = cam.toWorld(cam.vw / 2, cam.vh / 2);
    return m ? toFt(m, x, y) : [0, 0];
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    touched.current = true;
    cam.stop();
    setTip(null);
    // on the plan: an office manager picks up a person to move; the layout editor picks up seats
    const sc = scene.current;
    if (sc && sc.sheet === 'floor' && sc.floor.plan && pointers.current.size === 1) {
      const [wx, wy] = cam.toWorld(p.x, p.y);
      roomClick.current = null;
      if (editing && editor) {
        const hit = hitSeat(sc.floor.plan, wx, wy);
        if (hit) {
          const id = hit.seat.id;
          if (e.shiftKey) dispatch({ t: 'select', ids: [id], add: true });
          else if (!editor.sel.includes(id)) dispatch({ t: 'select', ids: [id] });
          seatDrag.current = { origin: editor.plan, ft: toFt(sc.floor.plan, wx, wy), moved: false };
          drag.current = null;
          return;
        }
        roomClick.current = hitRoom(sc.floor.plan, wx, wy) ?? '';
      } else if (arrange && canEdit) {
        const id = hitFloor(sc.floor, wx, wy);
        const sp = id ? sc.floor.spots.get(id) : null;
        if (id && sp?.where === 'desk') { personDrag.current = { ids: [id], x0: p.x, y0: p.y, active: false }; drag.current = null; return; }
      }
    }
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      drag.current = { x: p.x, y: p.y, moved: 99, samples: [], pinch: { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 } };
    } else drag.current = { x: p.x, y: p.y, moved: 0, samples: [{ ...p, t: performance.now() }] };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = local(e);
    if (personDrag.current && pointers.current.has(e.pointerId)) { movePersonDrag(p.x, p.y); return; }
    if (seatDrag.current && pointers.current.has(e.pointerId) && editor) {
      const sc = scene.current;
      if (!sc?.floor.plan) return;
      const [wx, wy] = cam.toWorld(p.x, p.y);
      const [fx, fy] = toFt(sc.floor.plan, wx, wy);
      const dx = fx - seatDrag.current.ft[0], dy = fy - seatDrag.current.ft[1];
      if (!seatDrag.current.moved && Math.hypot(dx, dy) * K * cam.z < 5) return;
      seatDrag.current.moved = true;
      dispatch({ t: 'dragTo', origin: seatDrag.current.origin, dx, dy });
      return;
    }
    const d = drag.current;
    if (!d || !pointers.current.has(e.pointerId)) {
      // hover: light the plate and show its grid reference
      const s = scene.current;
      if (!s) return;
      const [wx, wy] = cam.toWorld(p.x, p.y);
      const id = s.sheet === 'lines' ? hitGA(s.ga, wx, wy) : hitFloor(s.floor, wx, wy);
      if (gridOut.current) gridOut.current.textContent = gridRef(wx, wy);
      // on the plan: the seat under the pointer, and a tip saying whose it is
      const seat = s.sheet === 'floor' && s.floor.plan ? hitSeat(s.floor.plan, wx, wy) : null;
      const seatId = seat?.seat.id ?? null;
      if (seatId !== hoverSeat.current) {
        hoverSeat.current = seatId;
        setTip(seat && e.pointerType === 'mouse' ? { x: p.x, y: p.y, text: seatTip(seat.seat.id) } : null);
        invalidate();
      } else if (seat && tip) setTip({ x: p.x, y: p.y, text: tip.text });
      if (id !== hover.current) { hover.current = id; stage.current!.style.cursor = id || seatId ? 'pointer' : ''; invalidate(); }
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
    if (personDrag.current) {
      const pd = personDrag.current;
      personDrag.current = null;
      if (pd.active) { endPersonDrag(); return; }
      // a tap on a person in arrange mode: their callout, as usual
      const sc = scene.current;
      const q = local(e);
      if (sc) { const [wx, wy] = cam.toWorld(q.x, q.y); const id = hitFloor(sc.floor, wx, wy); if (id) { setSeatSel(null); setSelected(id); setKbFocus(id); setAnnounce(describe(id)); flyTo(id, { zoom: Math.max(cam.z, 0.9), callout: true }); } }
      return;
    }
    if (seatDrag.current) { seatDrag.current = null; return; }
    if (!d) return;
    if (pointers.current.size) { const [q] = [...pointers.current.values()]; drag.current = { x: q.x, y: q.y, moved: 99, samples: [] }; return; }
    drag.current = null;
    if (d.moved <= 4 && !d.pinch) {
      const s = scene.current;
      if (!s) return;
      const p = local(e);
      const [wx, wy] = cam.toWorld(p.x, p.y);
      if (editing && roomClick.current !== null) {
        if (roomClick.current) dispatch({ t: 'room', id: roomClick.current }); else dispatch({ t: 'select', ids: [] });
        roomClick.current = null;
        invalidate();
        return;
      }
      const id = s.sheet === 'lines' ? hitGA(s.ga, wx, wy) : hitFloor(s.floor, wx, wy);
      spot.current = null;
      if (id) { setSeatSel(null); setSelected(id); setKbFocus(id); setAnnounce(describe(id)); flyTo(id, { zoom: Math.max(cam.z, s.sheet === 'lines' ? 0.85 : 0.9), callout: true }); }
      else {
        setSelected(null);
        // an empty (or reserved, or away) seat: its own small callout
        const seat = s.sheet === 'floor' && s.floor.plan ? hitSeat(s.floor.plan, wx, wy) : null;
        setSeatSel(seat ? seat.seat.id : null);
        if (seat) setAnnounce(seatTip(seat.seat.id));
      }
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
    // the layout editor: nudge, turn, copy, remove, undo
    if (editing && editor) {
      const step = e.shiftKey ? 1 : (editor.plan.snapInches || 3) / 12;
      const nudge: Record<string, [number, number]> = { ArrowUp: [0, -step], ArrowDown: [0, step], ArrowLeft: [-step, 0], ArrowRight: [step, 0] };
      const ctrl = e.ctrlKey || e.metaKey;
      const act = (a: Parameters<typeof dispatch>[0]) => { e.preventDefault(); dispatch(a); invalidate(); };
      if (nudge[e.key] && editor.sel.length) { act({ t: 'move', dx: nudge[e.key][0], dy: nudge[e.key][1], snap: false }); setAnnounce(tr(`Moved ${editor.sel.length === 1 ? editor.sel[0] : `${editor.sel.length} seats`}`)); return; }
      if ((e.key === 'r' || e.key === 'R') && !ctrl && editor.sel.length) { act({ t: 'rotate', deg: e.shiftKey ? -90 : 90 }); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && editor.sel.length) { act({ t: 'delete' }); return; }
      if (ctrl && e.key.toLowerCase() === 'd') { act({ t: 'duplicate' }); return; }
      if (ctrl && e.key.toLowerCase() === 'z') { act({ t: e.shiftKey ? 'redo' : 'undo' }); return; }
      if (ctrl && e.key.toLowerCase() === 'y') { act({ t: 'redo' }); return; }
      if (e.key === 'Escape' && (editor.sel.length || editor.room)) { act({ t: 'select', ids: [] }); return; }
    }
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
      if (selected === id) onOpenCard(id); else { setSelected(id); setAnnounce(describe(id)); flyTo(id, { zoom: Math.max(cam.z, 0.85), callout: true }); }
      return;
    }
    if (e.key === 'Escape') {
      if (seatSel) setSeatSel(null);
      else if (spot.current) spot.current = null;
      else if (route) setRoute(null);
      else if (overlay) setOverlay(null);
      else if (selected) setSelected(null);
      else return;
      e.preventDefault(); invalidate();
      return;
    }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(1.4); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomBy(1 / 1.4); }
    else if (e.key === '0') { e.preventDefault(); touched.current = true; frameRect(fitTarget(), reduced ? 0 : 400); }
    else if (e.key === 'Home') { e.preventDefault(); pick(meId); }
    else if (e.key === '/') { e.preventDefault(); searchBox.current?.focus(); }
  };

  // the whole sheet is for looking over: the callout steps aside so it covers no one
  const fitAll = () => { touched.current = true; cam.stop(); setSelected(null); frameRect(fitTarget(), reduced ? 0 : 500); };
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
  /** `start`: walk from a seat, or 'entrance' (someone new to the office), rather than from where I sit. */
  const startRoute = (to: string, seat?: string, start?: string) => {
    setRoute({ from: meId, to, t0: performance.now(), ...(seat ? { seat } : {}), ...(start ? { start } : {}) });
    setOverlay(null);
    spot.current = null;
    touched.current = true;
    const ids = sheet === 'lines' ? routeBetween(meId, to, ga) ?? [meId, to] : [meId, to];
    const startBox = start && start !== 'entrance' ? seatPos(start) : start === 'entrance' && floor.plan ? (() => { const [ex, ey] = entrance(floor.plan.plan); return { x: floor.plan.ox + ex * K - 24, y: floor.plan.oy + ey * K - 24, w: 48, h: 48 }; })() : null;
    const boxes = [...(start ? [] : ids.map(posOf)), startBox, seat ? seatPos(seat) : null].filter((b): b is NonNullable<typeof b> => !!b);
    if (boxes.length) {
      const x0 = Math.min(...boxes.map((q) => q.x)), y0 = Math.min(...boxes.map((q) => q.y));
      const x1 = Math.max(...boxes.map((q) => q.x + q.w)), y1 = Math.max(...boxes.map((q) => q.y + q.h));
      // the whole route in the free part of the stage, beside the route card, never closer than 1:1
      const pad = 80, card = cam.vw >= 560 ? 330 / Math.max(cam.z, 0.3) : 0;
      const r = { x: x0 - pad - card, y: y0 - pad, w: x1 - x0 + pad * 2 + card, h: y1 - y0 + pad * 2 };
      frameRect(r, reduced ? 0 : 800, 1);
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
    <div className={`orgscape sheet-${sheet}${schedule ? ' with-schedule' : ''}${sv?.notice?.seatId || compared ? ' with-notice' : ''}${(arrange || revsOpen) && sheet === 'floor' ? ' with-seat-panel' : ''}${editing ? ' editing' : ''}`}>
      <div className="os-bar" role="toolbar" aria-label="Office drawing">
        <div className="seg os-sheets" role="group" aria-label="Sheet">
          <button type="button" aria-pressed={sheet === 'lines'} onClick={() => { if (sheet !== 'lines') { setSelected(null); setSeatSel(null); setArrange(null); setRevsOpen(false); setCompare(null); setSheet('lines'); } }}><Icon name="branch" size={15} />Lines</button>
          <button type="button" aria-pressed={sheet === 'floor'} onClick={() => { if (sheet !== 'floor') { setSelected(null); setSheet('floor'); setGrowth(false); setAsAt(null); } }}><Icon name="grid" size={15} />Floor</button>
        </div>
        <div className="os-find" role="combobox" aria-expanded={searching && results.length + seatResults.length > 0} aria-haspopup="listbox" aria-owns="os-results">
          <Icon name="search" size={15} />
          <input ref={searchBox} className="os-find-input" value={query} placeholder="Find a person, designation, seat or extension" aria-label="Find on the drawing" aria-autocomplete="list" aria-controls="os-results"
            aria-activedescendant={searching && results[hit] ? `os-r-${results[hit].id}` : searching && seatResults[hit - results.length] ? `os-r-seat-${seatResults[hit - results.length]}` : undefined}
            onFocus={() => setSearching(true)} onBlur={() => setTimeout(() => setSearching(false), 150)}
            onChange={(e) => { setQuery(e.target.value); setHit(0); setSearching(true); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setHit((h) => Math.min(results.length + seatResults.length - 1, h + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setHit((h) => Math.max(0, h - 1)); }
              else if (e.key === 'Enter' && results[hit]) { e.preventDefault(); pick(results[hit].id, { spotlight: true }); setSearching(false); stage.current?.focus(); }
              else if (e.key === 'Enter' && seatResults[hit - results.length]) { e.preventDefault(); pickSeat(seatResults[hit - results.length]); setSearching(false); stage.current?.focus(); }
              else if (e.key === 'Escape') { setQuery(''); setSearching(false); }
            }} />
          {searching && results.length + seatResults.length > 0 && (
            <ul className="os-results" id="os-results" role="listbox" aria-label="People on the drawing">
              {results.map((u, i) => (
                <li key={u.id} id={`os-r-${u.id}`} role="option" aria-selected={i === hit} className={i === hit ? 'on' : ''}
                  onMouseDown={(e) => { e.preventDefault(); pick(u.id, { spotlight: true }); setSearching(false); }}>
                  <Avatar user={u} presence={presence.get(u.id)} size="sm" />
                  <span className="os-r-who"><b translate="no">{u.displayName}</b><span className="faint" translate="no">{u.title ?? deptName(u.profile.departmentId ?? '')}</span></span>
                  <span className="os-r-ref mono" aria-label={tr(`Grid ${refOf(u.id)}`)}>{refOf(u.id)}</span>
                </li>
              ))}
              {seatResults.map((sid, j) => {
                const i = results.length + j;
                const q = plan?.byId.get(sid);
                const who = q?.occupant ? users.get(q.occupant)?.displayName ?? '' : q?.holder?.kind === 'reserved' ? q.holder.label : q?.holder?.kind === 'hot' ? tr('Hot desk') : tr('Free');
                return (
                  <li key={`seat-${sid}`} id={`os-r-seat-${sid}`} role="option" aria-selected={i === hit} className={i === hit ? 'on' : ''}
                    onMouseDown={(e) => { e.preventDefault(); pickSeat(sid); setSearching(false); }}>
                    <span className="seat-badge sm mono" aria-hidden="true">{sid}</span>
                    {q?.holder?.kind === 'named'
                      ? <span className="os-r-who"><b translate="no">{q.holder.name}</b><span className="faint">{tr(`Seat ${sid} · from the office drawing`)}</span></span>
                      : <span className="os-r-who"><b className="mono">{tr(`Seat ${sid}`)}</b><span className="faint" translate="no">{who}</span></span>}
                  </li>
                );
              })}
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
          {sheet === 'floor' && plan && (
            <>
              <button type="button" className={`os-tool${wash ? ' on' : ''}`} aria-pressed={wash} onClick={() => { setWash(!wash); invalidate(); }}>
                <Icon name="grid" size={15} /><span>Departments</span>
              </button>
              <button type="button" className={`os-tool${revsOpen ? ' on' : ''}`} aria-pressed={revsOpen} onClick={() => { setRevsOpen(!revsOpen); if (!revsOpen) { setArrange(null); setSchedule(false); } }}>
                <Icon name="history" size={15} /><span>Revisions</span>
              </button>
              {canEdit && (
                <button type="button" className={`os-tool${arrange ? ' on' : ''}`} aria-pressed={!!arrange} onClick={() => { if (arrange) { setArrange(null); setPreview(null); } else { setArrange(!sv?.waiting?.length && draft?.changes.length ? 'moves' : 'people'); setRevsOpen(false); setSchedule(false); setCompare(null); } }}>
                  <Icon name="edit" size={15} /><span>Arrange</span>{(sv?.waiting?.length ?? 0) > 0 && <span className="seat-count mono" aria-label={tr(`${sv!.waiting.length} waiting to be matched`)}>{sv!.waiting.length}</span>}
                </button>
              )}
            </>
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
          aria-label={sheet === 'lines' ? 'Reporting lines of the office. Arrow keys move along the lines, Enter opens a person, plus and minus zoom, 0 shows the whole sheet.' : editing ? 'Layout editor. Click a seat to select it, drag to move it; arrow keys nudge, R turns, Delete removes, Control+Z undoes.' : 'Floor plan of the office. Arrow keys move between desks, Enter opens a person, plus and minus zoom, 0 shows the whole plan.'}
          aria-describedby="os-live"
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
          onPointerLeave={() => { if (hover.current) { hover.current = null; invalidate(); } }}
          onDoubleClick={(e) => { const p = local(e); touched.current = true; const [wx, wy] = cam.toWorld(p.x, p.y); cam.flyTo(wx, wy, cam.z * 2, performance.now(), reduced ? 0 : 300); invalidate(); }}
          onKeyDown={onKeyDown}
          onFocus={() => { if (!kbFocus && !selected) { /* the first arrow starts from you */ } }}>
          <canvas ref={canvas} className="os-canvas" aria-hidden="true" />
          <div id="os-live" className="os-sr" aria-live="polite">{announce}</div>
          {tip && <div className="seat-tip" style={{ transform: `translate(${Math.round(tip.x + 14)}px, ${Math.round(tip.y + 16)}px)` }} aria-hidden="true"><span translate="no">{tip.text}</span></div>}
          {sv?.notice && sv.notice.seatId && (
            <div className="seat-notice" role="status" onPointerDown={(e) => e.stopPropagation()}>
              <Icon name="pin" size={16} />
              <span>{sv.notice.effective <= today ? tr(`From today your seat is ${sv.notice.label}.`) : tr(`From ${new Date(`${sv.notice.effective}T12:00:00`).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })} your seat is ${sv.notice.label}.`)}</span>
              <button type="button" className="btn sm primary" onClick={() => { if (sheet !== 'floor') { setSheet('floor'); setFloorAsk({ seat: sv.notice!.seatId!, n: Date.now() }); } else startRoute(meId, sv.notice!.seatId!, sv.notice!.from ?? 'entrance'); }}><Icon name="branch" size={14} />Walk there</button>
              <button type="button" className="btn sm ghost" onClick={() => void window.dex.request('seating.seen', { planId: sv.notice!.planId }).then(() => reloadSeating()).catch(() => {})}>Got it</button>
            </div>
          )}
          {compared && compare && (
            <div className="seat-notice seat-comparing" role="status" onPointerDown={(e) => e.stopPropagation()}>
              <Icon name="eye" size={16} />
              <span>{compared.seats.size === 1 ? tr(`Comparing Rev ${compare.a} and Rev ${compare.b}: 1 seat changed`) : tr(`Comparing Rev ${compare.a} and Rev ${compare.b}: ${compared.seats.size} seats changed`)}</span>
              <button type="button" className="btn sm ghost" onClick={() => setCompare(null)}>Stop comparing</button>
            </div>
          )}
          {seatSel && plan && !sel && (() => {
            const q = plan.byId.get(seatSel);
            if (!q) return null;
            const zone = plan.plan.zones.find((z) => z.id === q.seat.zone)?.name ?? '';
            const h = q.holder;
            const days = sv?.bookDays?.length ? sv.bookDays : [today];
            const day = bookDay && days.includes(bookDay) ? bookDay : today;
            const dayText = (x: string) => (x === today ? tr('Today') : new Date(`${x}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }));
            const seatBookings = h?.kind === 'hot' ? (sv?.bookings ?? []).filter((b) => b.seatId === seatSel).sort((a, b) => a.day.localeCompare(b.day)) : [];
            const bookedOn = seatBookings.find((b) => b.day === day)?.userId ?? null;
            const run = (f: () => Promise<unknown>, ok: string) => void f().then(() => { toast(ok); return reloadSeating(); }).catch((err: Error) => toast(err.message, true));
            return (
              <div className="os-callout seat-callout" role="dialog" aria-label={tr(`Seat ${seatSel}`)} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') { setSeatSel(null); stage.current?.focus(); } }}>
                <div className="os-co-head">
                  <span className="seat-badge mono" aria-hidden="true">{seatSel}</span>
                  <div className="os-co-who"><b className="mono">{seatSel}</b><span className="faint">{zone}</span></div>
                  <button type="button" className="icon-btn" aria-label="Close" onClick={() => { setSeatSel(null); stage.current?.focus(); }}><Icon name="x" size={15} /></button>
                </div>
                <dl className="os-co-cells">
                  <div><dt className="tb-k">Held by</dt><dd>{h?.kind === 'person' ? <span translate="no">{users.get(h.userId)?.displayName ?? ''}</span> : h?.kind === 'reserved' ? <span translate="no">{h.label}</span> : h?.kind === 'named' ? <span translate="no">{h.name}</span> : h?.kind === 'hot' ? tr('Hot desk') : tr('Nobody: free')}</dd></div>
                  {h?.kind === 'named' && <div><dt className="tb-k">Note</dt><dd>On the office drawing. Not joined yet: the seat becomes theirs when they do.</dd></div>}
                  {h?.kind === 'person' && q.away && <div><dt className="tb-k">Today</dt><dd>{modeOf(h.userId) === 'home' ? 'Working from home' : modeOf(h.userId) === 'site' ? 'On site' : 'At a client'}</dd></div>}
                  {h?.kind === 'hot' && <div><dt className="tb-k">Today</dt><dd>{q.booked ? <span translate="no">{users.get(q.booked)?.displayName ?? ''}</span> : tr('Not booked')}</dd></div>}
                  {(h?.kind === 'reserved' || h?.kind === 'hot') && h.departmentId && <div><dt className="tb-k">Dept</dt><dd translate="no">{deptName(h.departmentId)}</dd></div>}
                  <div><dt className="tb-k">Type</dt><dd>{({ bench: 'Bench desk', pod: 'Pod seat', halfCabin: 'Half-cabin', cabin: 'Cabin', clientCabin: 'Client cabin', reception: 'Reception' } as const)[q.seat.type]}</dd></div>
                  {h?.kind === 'hot' && (
                    <div className="seat-book">
                      <dt className="tb-k"><label htmlFor="seat-book-day">Book for</label></dt>
                      <dd>
                        <select id="seat-book-day" className="input" value={day} onChange={(e) => setBookDay(e.target.value)}>
                          {days.map((x) => { const b = seatBookings.find((y) => y.day === x); return <option key={x} value={x}>{b ? `${dayText(x)} · ${b.userId === meId ? tr('You') : users.get(b.userId)?.displayName ?? ''}` : dayText(x)}</option>; })}
                        </select>
                      </dd>
                    </div>
                  )}
                  {h?.kind === 'hot' && seatBookings.length > 0 && (
                    <div className="seat-bookings">
                      <dt className="tb-k">Booked</dt>
                      <dd><ul>{seatBookings.slice(0, 10).map((b) => <li key={b.day}><span className="mono">{dayText(b.day)}</span> <span translate="no">{b.userId === meId ? tr('You') : users.get(b.userId)?.displayName ?? ''}</span></li>)}</ul></dd>
                    </div>
                  )}
                </dl>
                <div className="os-co-actions">
                  <button type="button" className="btn sm" onClick={() => startRoute(meId, seatSel)}><Icon name="branch" size={14} />Walk there</button>
                  {h?.kind === 'person' && h.userId !== meId && <button type="button" className="btn sm ghost" onClick={() => { setSeatSel(null); pick(h.userId); }}><Icon name="card" size={14} />Person</button>}
                  {h?.kind === 'hot' && !bookedOn && <button type="button" className="btn sm primary" onClick={() => run(() => window.dex.request('seating.book', { seatId: seatSel, day }), day === today ? tr(`${seatSel} is yours today`) : tr(`${seatSel} is yours on ${dayText(day)}`))}>{day === today ? tr('Book for today') : tr(`Book for ${dayText(day)}`)}</button>}
                  {h?.kind === 'hot' && bookedOn === meId && <button type="button" className="btn sm ghost" onClick={() => run(() => window.dex.request('seating.book', { seatId: null, day }), tr('Booking cancelled'))}>Cancel my booking</button>}
                  {canEdit && !h && reserve === null && <button type="button" className="btn sm ghost" onClick={() => setReserve('')}>Reserve…</button>}
                  {canEdit && h?.kind !== 'hot' && h?.kind !== 'person' && <button type="button" className="btn sm ghost" onClick={() => run(() => addToDraft([{ seatId: seatSel, to: { kind: 'hot' } }]), tr('Added to the move plan'))}>Make it a hot desk</button>}
                  {canEdit && h && <button type="button" className="btn sm ghost" onClick={() => run(() => addToDraft([{ seatId: seatSel, to: null }]), tr('Added to the move plan'))}>Free it</button>}
                </div>
                {canEdit && reserve !== null && (
                  <form className="seat-reserve" onSubmit={(e) => { e.preventDefault(); if (reserve.trim()) { run(() => addToDraft([{ seatId: seatSel, to: { kind: 'reserved', label: reserve.trim() } }]), tr('Added to the move plan')); setReserve(null); } }}>
                    <label className="label" htmlFor="seat-res">Reserve for</label>
                    <input id="seat-res" className="input" autoFocus value={reserve} maxLength={60} onChange={(e) => setReserve(e.target.value)} placeholder="Piping · hot desk" />
                    <button type="submit" className="btn sm primary" disabled={!reserve.trim()}>Add to plan</button>
                  </form>
                )}
              </div>
            );
          })()}

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
              {(() => {
                // across to the other sheet, the same person kept selected
                const go = (to: 'floor' | 'lines', id: string) => { jumpTo.current = { id, n: Date.now() }; setSeatSel(null); setRoute(null); setSheet(to); if (to === 'floor') { setGrowth(false); setAsAt(null); } setAnnounce(to === 'floor' ? tr(`${sel.displayName} on the floor`) : tr(`${sel.displayName} in the reporting lines`)); };
                if (sheet === 'floor') return <div className="os-co-across"><button type="button" className="btn sm ghost" onClick={() => go('lines', sel.id)}><Icon name="branch" size={14} />See in the reporting lines</button></div>;
                const sp = floor.spots.get(sel.id);
                const mode = modeOf(sel.id);
                const away = sp?.where === 'away' || (!!mode && mode !== 'office');
                const why = !sp || sp.where === 'unseated' ? tr('No seat on the plan') : away ? (mode === 'site' ? tr('On site today') : mode === 'client' ? tr('At a client today') : tr('Working from home today')) : null;
                return (
                  <div className="os-co-across">
                    {why ? <span className="faint" role="note"><Icon name="grid" size={14} />{why}</span>
                      : <button type="button" className="btn sm ghost" onClick={() => go('floor', sel.id)}><Icon name="grid" size={14} />Find on the floor</button>}
                  </div>
                );
              })()}
            </div>
          )}
        </div>

        <Schedule open={schedule} sheet={sheet} ga={ga} floor={floor} users={users} presence={presence} deptName={deptName} refOf={refOf}
          labels={labels} active={kbFocus ?? selected} onPick={(id) => pick(id)} onOpen={onOpenCard} onClose={() => setSchedule(false)} />
        {sheet === 'floor' && sv && arrange && canEdit && (
          <Suspense fallback={<aside className="seat-panel"><span className="spinner" /></aside>}>
            <Arrange view={sv} people={people} users={users} departments={departments} tab={arrange} onTab={(t) => { setArrange(t); if (t !== 'team') setPreview(null); }}
              onClose={() => { setArrange(null); setPreview(null); }} onDragStart={startExternalDrag} onPreview={(m) => { setPreview(m); invalidate(); }}
              onFocusSeat={(id) => { setSeatSel(id); flyToSeat(id); }} editor={editor} dispatch={(a) => { dispatch(a); invalidate(); }} viewCentreFt={viewCentreFt}
              onUnderlay={() => setUnderlayOpen(true)} />
          </Suspense>
        )}
        {sheet === 'floor' && sv && revsOpen && (
          <Suspense fallback={<aside className="seat-panel"><span className="spinner" /></aside>}>
            <Revisions view={sv} users={users} compare={compare} onCompare={setCompare} onExport={exportPlan} onClose={() => setRevsOpen(false)} />
          </Suspense>
        )}
        {underlayOpen && sv && <Suspense fallback={null}><UnderlayDialog view={sv} onClose={() => setUnderlayOpen(false)} /></Suspense>}
      </div>

      {route && (
        <div className="os-route" role="region" aria-label="Route">
          <div className="os-route-head">
            <span className="label">{sheet === 'floor' ? (route.seat ? tr(`Walk to ${route.seat}`) : 'Walk to their desk') : 'How you connect'}</span>
            <button type="button" className="icon-btn" aria-label="Clear the route" onClick={() => { setRoute(null); invalidate(); }}><Icon name="x" size={15} /></button>
          </div>
          {sheet === 'lines' ? (routeIds ? (
            <ol className="os-steps">
              {routeIds.map((id, i) => (
                <li key={id}><span className="mono os-step-n">{String(i + 1).padStart(2, '0')}</span><button type="button" className="tb-link" translate="no" onClick={() => pick(id)}>{users.get(id)?.displayName}</button>
                  {i > 0 && <span className="faint os-step-why">{ga.plates.get(routeIds[i])?.managerId === routeIds[i - 1]
                    ? tr(`In ${users.get(routeIds[i - 1])?.displayName.split(/\s+/)[0] ?? ''}'s team`) : tr(`Line manager of ${users.get(routeIds[i - 1])?.displayName.split(/\s+/)[0] ?? ''}`)}</span>}</li>
              ))}
            </ol>
          ) : <p className="faint">No reporting line joins you.</p>) : (walk ? <p className="faint">{plan
            ? tr(`From ${route.start === 'entrance' ? tr('the entrance') : route.start ?? plan.seatOf.get(route.from) ?? tr('the entrance')} to ${route.seat ?? plan.seatOf.get(route.to) ?? refOf(route.to)}, round the desks: about ${Math.max(2, Math.round(walkLength(walk) / K / 2.5))} steps.`)
            : tr(`Grid ${refOf(route.from)} to grid ${refOf(route.to)}, along the corridor.`)}</p> : <p className="faint">One of you has no desk in the office today.</p>)}
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
          <div className="os-tb-cell wide"><span className="tb-k">Drawing</span><b>{sheet === 'lines' ? 'Organisation · General arrangement' : plan ? <>{tr(`Floor plan · ${plan.plan.name}`)} <span className="mono">{tr(`Rev ${compared?.rev ?? sv?.revisions[0]?.rev ?? 'A'}`)}</span></> : 'Floor plan · Level 01'}</b></div>
          <div className="os-tb-cell"><span className="tb-k">People</span><span className="mono">{sheet === 'lines' ? tr(`${people.length} · ${online} online`) : tr(`${inOffice} in · ${elsewhere} away`)}</span></div>
          <div className="os-tb-cell"><span className="tb-k">Scale</span><span className="mono" ref={scaleOut}>1:1</span></div>
          <div className="os-tb-cell"><span className="tb-k">Grid</span><span className="mono" ref={gridOut}>—</span></div>
          <div className="os-tb-cell"><span className="tb-k">Drg no.</span><span className="mono" translate="no">{sheet === 'lines' ? 'DDS-ORG-001' : plan?.plan.drawingNo ?? 'DDS-FLR-001'}</span></div>
        </div>
      </div>

      {wash && sheet === 'floor' && plan && (
        <ul className="seat-washkey" aria-label="Departments on the plan">
          {[...new Set(plan.seats.map((q) => q.dept).filter((d): d is string => !!d))].sort((a, b) => deptName(a).localeCompare(deptName(b))).map((d) => (
            <li key={d}><i style={{ background: deptColor(d) }} aria-hidden="true" /><span translate="no">{deptName(d)}</span><span className="mono faint">{plan.seats.filter((q) => q.dept === d).length}</span></li>
          ))}
        </ul>
      )}
      {legend && <Legend sheet={sheet} plan={!!plan} onClose={() => setLegend(false)} />}
    </div>
  );
}

/** What the marks on the sheet mean. */
function Legend({ sheet, plan, onClose }: { sheet: Sheet; plan: boolean; onClose: () => void }) {
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
    ...(plan ? [
      ['seat-free', 'Dashed chair: a free seat'],
      ['seat-res', 'Hatched desk: reserved for a role or team'],
      ['pending', 'Dashed arrow: a move still to take effect'],
      ['revcloud', 'Cloud and triangle: changed between revisions'],
    ] as Array<[string, string]> : []),
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
        const zone = floor.plan && sp.where === 'desk' ? floor.plan.plan.zones.find((z) => z.id === sp.room)?.name : undefined;
        const g = zone ?? (room ? (room.kind === 'bay' ? labels.bay(room.name) : room.kind === 'cabin' ? labels.cabin(room.name) : room.name) : sp.where === 'away' ? labels.awayKey : labels.noSeat);
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
