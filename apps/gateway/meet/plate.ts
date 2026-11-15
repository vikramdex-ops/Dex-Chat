// The landing page's living drawing: a sheet about this meeting and this visitor, drawn in code.
//
// 01 TIME. The meeting's slot as a dimension on a day ruler with two parallel scales, the
//    visitor's time above and the office's below (a dual-unit dimension, as mm and inches on one
//    drawing). A NOW cursor moves along it; before the start a leader runs from NOW to the start
//    with the countdown; the ten minutes the room is open before the start are a hatched lead-in;
//    while the meeting runs the elapsed part is hatched; when it is over its length is dimensioned;
//    the next times of a repeating meeting are ticks to the right; a cancellation is a revision
//    cloud with a note.
// 02 READINESS. Instrument tags in the ISA bubble style, CAM, MIC, SPK and NET, on a loop to a
//    YOU node: hollow until checked, then teal with a tick. MIC draws a live trace from the level
//    meter; SPK fills after "Test speakers"; NET is a real round trip to this site.
// 03 REVISIONS. A revision block that fills itself: drawn, checked (with the visitor's name),
//    awaiting approval in the lobby, approved for entry (a stamp plotted in), issued.
//
// Only this meeting's times and this visitor's own checks: nothing about anyone else is drawn.
// The SVG is decorative (aria-hidden); a text equivalent sits beside it and is kept current.
import { clock, h, pad, svg, zoneCity, zoneOffset } from './shared.ts';

export interface PlateTime {
  startAt: number | null;
  endAt: number | null;
  opensAt: number | null;
  liveSince: number | null;
  state: 'upcoming' | 'open' | 'live' | 'ended' | 'cancelled';
  zone: string | null;
  next: { startAt: number; endAt: number } | null;
  repeats: boolean;
}
export type PlateMode = 'home' | 'none' | 'locked' | 'ready' | 'lobby' | 'end' | 'cancelled';

/** What the visitor has checked, kept across the page's redraws. */
export const READY = {
  cam: null as boolean | null, // null: not checked yet; false: no camera
  mic: null as boolean | null,
  spk: false,
  net: null as number | null,
  levels: [] as number[],
};
/** The revision block's entries, kept across redraws. */
export const REV = {
  drawnAt: Date.now(),
  checkedAt: null as number | null,
  checkedBy: '',
  awaiting: false,
  approvedAt: null as number | null,
  issued: null as { at: number; spentMs: number } | null,
  stampShown: false,
};

const W = 360;
const X0 = 50, X1 = 352;
const MIN = 60_000;
const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
const localZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
const hm = (t: number, zone?: string) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', ...(zone ? { timeZone: zone } : {}) });
const len = (ms: number) => { const m = ms > 0 ? Math.max(1, Math.round(ms / MIN)) : 0; return m > 90 ? `${Math.floor(m / 60)} H ${pad(m % 60)} MIN` : `${m} MIN`; };
const T = (x: number, y: number, s: string, cls: string, anchor = 'start') => { const t = svg('text', { x, y, class: cls, 'text-anchor': anchor }); t.textContent = s; return t; };

let current: { update(): void; caption(): void } | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let netTimer: ReturnType<typeof setInterval> | null = null;

/** Round trip to this site, three times, the middle one: the NET tag's reading. */
async function measureNet(): Promise<void> {
  const times: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    try { const r = await fetch('/health', { cache: 'no-store', credentials: 'omit' }); await r.arrayBuffer(); times.push(performance.now() - t0); } catch { /* offline */ }
  }
  READY.net = times.length ? Math.round(times.sort((a, b) => a - b)[Math.floor(times.length / 2)]) : null;
  current?.update();
  current?.caption();
}

/** One MIC reading (0–20 from the level meter), ten a second while the device check runs. */
export function pushLevel(v: number): void {
  READY.levels.push(v);
  if (READY.levels.length > 48) READY.levels.shift();
  if (v >= 2 && READY.mic !== true) { READY.mic = true; current?.update(); current?.caption(); checkAll(); }
  current?.update();
}
export function markCamera(ok: boolean): void { READY.cam = ok; current?.update(); current?.caption(); checkAll(); }
export function markNoMic(): void { if (READY.mic === null) { READY.mic = false; current?.update(); current?.caption(); } }
export function markSpeakers(): void { READY.spk = true; current?.update(); current?.caption(); checkAll(); }
let checkedName = () => '';
function checkAll(): void {
  if (REV.checkedAt) return;
  if (READY.mic === true && READY.spk && READY.net !== null && READY.cam !== null) {
    REV.checkedAt = Date.now();
    REV.checkedBy = checkedName();
    current?.update();
    current?.caption();
  }
}

export function plate(o: { time: PlateTime | null; mode: PlateMode; name: () => string; devices: boolean }): HTMLElement {
  checkedName = o.name;
  const now0 = Date.now();
  const t = o.time;
  const zone = localZone();
  const office = t?.zone || zone;
  const sameZone = zoneOffset(office, now0) === zoneOffset(zone, now0);

  // ---- the ruler's window: the slot, the lead-in and now, with a margin; at most 12 hours
  let a: number, b: number;
  const slotS = t?.startAt ?? (t?.state === 'live' ? t.liveSince : null);
  const slotE = t?.endAt ?? null;
  if (t && slotS) {
    const lo = Math.min(t.opensAt ?? slotS, slotS, t.state === 'ended' || t.state === 'cancelled' ? slotS : now0);
    const hi = Math.max(slotE ?? now0 + 60 * MIN, t.state === 'ended' || t.state === 'cancelled' ? slotE ?? slotS : now0);
    a = lo - 40 * MIN; b = hi + 40 * MIN;
    if (b - a > 12 * 60 * MIN) {
      // a meeting far off: the ruler shows the slot's day around it; NOW points off the sheet
      a = slotS - 2 * 60 * MIN; b = (slotE ?? slotS + 60 * MIN) + 2 * 60 * MIN;
    }
  } else { a = now0 - 60 * MIN; b = now0 + 3 * 60 * MIN; }
  const span = b - a;
  const x = (tt: number) => X0 + ((tt - a) / span) * (X1 - X0);
  const cx = (tt: number) => Math.max(X0, Math.min(X1, x(tt)));

  const root = svg('svg', { viewBox: `0 0 ${W} 352`, class: `plate m-${o.mode}${t ? ` s-${t.state}` : ''}`, 'aria-hidden': 'true', focusable: 'false' });
  const defs = svg('defs');
  const hatch = svg('pattern', { id: 'pl-hatch', width: 5, height: 5, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, svg('line', { x1: 0, y1: 0, x2: 0, y2: 5, class: 'hl' }));
  const hatchLive = svg('pattern', { id: 'pl-hatch-live', width: 5, height: 5, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, svg('line', { x1: 0, y1: 0, x2: 0, y2: 5, class: 'hl live' }));
  const arrow = svg('marker', { id: 'pl-arr', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, svg('path', { d: 'M0 1L7 4L0 7', class: 'arr' }));
  defs.append(hatch, hatchLive, arrow);
  root.append(defs);

  // ================================================================ 01 TIME
  root.append(T(0, 10, '01 · TIME', 'sec'), svg('line', { x1: 52, y1: 7, x2: 150, y2: 7, class: 'rule' }));
  const yA = 46, yB = 84;
  // the two scales: named in the margin, their zones in the section's heading
  root.append(T(W, 10, sameZone ? `YOURS = OFFICE · ${zoneCity(office).toUpperCase()}` : `YOURS ${zoneCity(zone).toUpperCase()} · OFFICE ${zoneCity(office).toUpperCase()}`, 'cap', 'end'));
  root.append(T(0, yA + 3, 'YOURS', 'cap'), T(0, yB + 3, 'OFFICE', 'cap'));
  // scales: a tick every 15 minutes, labels on whole hours (fewer when the span is long)
  const step = span > 8 * 60 * MIN ? 2 : 1;
  const scale = svg('g', { class: 'scale' });
  scale.append(svg('line', { x1: X0, y1: yA, x2: X1, y2: yA, class: 'base' }), svg('line', { x1: X0, y1: yB, x2: X1, y2: yB, class: 'base' }));
  for (let tt = Math.ceil(a / (15 * MIN)) * 15 * MIN; tt <= b; tt += 15 * MIN) {
    const xx = x(tt);
    const d = new Date(tt);
    const whole = d.getMinutes() === 0 && d.getHours() % step === 0;
    scale.append(svg('line', { x1: xx, y1: yA, x2: xx, y2: yA - (whole ? 7 : 3), class: 'tk' }));
    if (whole) scale.append(T(xx, yA - 10, hm(tt), 'num', 'middle'));
    // the office's scale, with its own whole hours (a half-hour zone puts them between ours)
    const od = Number(new Intl.DateTimeFormat('en-GB', { timeZone: office, minute: '2-digit' }).format(d));
    const oh = Number(new Intl.DateTimeFormat('en-GB', { timeZone: office, hour: '2-digit', hourCycle: 'h23' }).format(d));
    const owhole = od === 0 && oh % step === 0;
    scale.append(svg('line', { x1: xx, y1: yB, x2: xx, y2: yB + (owhole ? 7 : 3), class: 'tk' }));
    if (owhole) scale.append(T(xx, yB + 17, hm(tt, office), 'num', 'middle'));
  }
  // a half-hour office zone: its whole hours fall on our half hours; draw those ticks too
  root.append(scale);

  // the slot, its lead-in, the elapsed part
  const g = svg('g', { class: 'slot' });
  let slotRect: SVGRectElement | null = null;
  let elapsed: SVGRectElement | null = null;
  if (t && slotS) {
    const sE = slotE ?? (t.state === 'live' ? now0 : slotS + 60 * MIN);
    if (t.opensAt && t.opensAt < slotS && t.state !== 'cancelled' && t.state !== 'ended') g.append(svg('rect', { x: cx(t.opensAt), y: yA + 4, width: Math.max(0, cx(slotS) - cx(t.opensAt)), height: yB - yA - 8, class: 'lead', fill: 'url(#pl-hatch)' }));
    slotRect = svg('rect', { x: cx(slotS), y: yA + 4, width: Math.max(2, cx(sE) - cx(slotS)), height: yB - yA - 8, class: 'band', pathLength: 1 });
    g.append(slotRect);
    if (t.state === 'live') { elapsed = svg('rect', { x: cx(t.liveSince ?? slotS), y: yA + 4, width: 0, height: yB - yA - 8, class: 'done', fill: 'url(#pl-hatch-live)' }); g.append(elapsed); }
    // witness lines and the dimension under the scales: the slot's length
    const dy = 132;
    g.append(
      svg('line', { x1: cx(slotS), y1: yB + 22, x2: cx(slotS), y2: dy + 4, class: 'wit' }),
      svg('line', { x1: cx(sE), y1: yB + 22, x2: cx(sE), y2: dy + 4, class: 'wit' }),
      svg('line', { x1: cx(slotS) + 1, y1: dy, x2: cx(sE) - 1, y2: dy, class: 'dim', 'marker-start': 'url(#pl-arr)', 'marker-end': 'url(#pl-arr)' }),
      T((cx(slotS) + cx(sE)) / 2, dy - 4, t.state === 'ended' ? `${len(sE - slotS)} · HELD` : len(sE - slotS), 'dimt', 'middle'),
    );
    if (t.opensAt && t.opensAt < slotS && t.state !== 'ended' && t.state !== 'cancelled') g.append(T(cx(t.opensAt) - 2, yA + 1, 'OPENS', 'tiny', 'end'));
    // the next times of a repeating meeting
    if (t.next && t.state !== 'cancelled') g.append(T(X1, 148, `NEXT ${new Date(t.next.startAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }).toUpperCase()} ${hm(t.next.startAt)} →`, 'tiny', 'end'));
    if (t.repeats && t.state !== 'cancelled') for (let i = 1; i <= 3; i++) g.append(svg('line', { x1: X1 - 2 - i * 5, y1: yB - 6, x2: X1 - 2 - i * 5, y2: yB - 2, class: 'rep' }));
    if (t.state === 'cancelled') {
      const l = cx(slotS) - 10, r = cx(sE) + 10, top = yA - 6, bot = yB + 6;
      const bumps: string[] = [`M${l} ${top + 6}`];
      for (let xx = l; xx < r; xx += 12) bumps.push(`q6 -9 12 0`);
      bumps.push(`q9 6 0 12`);
      for (let yy = top + 18; yy < bot; yy += 12) bumps.push(`q9 6 0 12`);
      for (let xx = r; xx > l; xx -= 12) bumps.push(`q-6 9 -12 0`);
      for (let yy = bot; yy > top + 6; yy -= 12) bumps.push(`q-9 -6 0 -12`);
      g.append(svg('path', { d: bumps.join(' '), class: 'cloud', pathLength: 1 }));
      // the note, in the slot itself
      const mx = (cx(slotS) + cx(sE)) / 2;
      g.append(svg('rect', { x: mx - 40, y: (yA + yB) / 2 - 8, width: 80, height: 15, class: 'void' }), T(mx, (yA + yB) / 2 + 3, 'CANCELLED', 'voidt', 'middle'));
    }
  }
  root.append(g);

  // NOW: a cursor across both scales, and the countdown as a leader to the start
  const now = svg('g', { class: 'now' });
  const cur = svg('line', { x1: 0, y1: 30, x2: 0, y2: yB + 4, class: 'cur' });
  const tagR = svg('rect', { x: -15, y: 14, width: 30, height: 12, class: 'nowtag' });
  const tagT = T(0, 23, 'NOW', 'nowt', 'middle');
  const lead = svg('line', { x1: 0, y1: (yA + yB) / 2, x2: 0, y2: (yA + yB) / 2, class: 'leader', 'marker-end': 'url(#pl-arr)' });
  const leadT = T(0, (yA + yB) / 2 - 4, '', 'leadt', 'middle');
  now.append(lead, leadT, cur, tagR, tagT);
  root.append(now);
  // NOW off the sheet (the meeting was long ago, or is far off): an arrow at the edge says where
  const offL = T(X0, 23, '', 'offnow');
  root.append(offL);

  // ================================================================ 02 READINESS
  const y0 = 168;
  root.append(T(0, y0, '02 · READINESS', 'sec'), svg('line', { x1: 84, y1: y0 - 3, x2: W, y2: y0 - 3, class: 'rule' }));
  const by = y0 + 42;
  const you = svg('g', { class: 'you' }, svg('circle', { cx: 38, cy: by, r: 17, class: 'yo' }), svg('circle', { cx: 38, cy: by, r: 12.5, class: 'yi' }));
  you.append(T(38, by + 3, 'YOU', 'yt', 'middle'));
  const trunkY = by + 42;
  root.append(svg('path', { d: `M38 ${by + 17}V${trunkY}H${X1 - 24}`, class: 'loop', pathLength: 1 }));
  root.append(you);
  const tags: Array<{ id: 'cam' | 'mic' | 'spk' | 'net'; label: string; x: number }> = [
    { id: 'net', label: 'NET', x: 100 }, { id: 'cam', label: 'CAM', x: 168 }, { id: 'mic', label: 'MIC', x: 236 }, { id: 'spk', label: 'SPK', x: 304 },
  ];
  const tagEls = new Map<string, { g: SVGGElement; val: SVGTextElement }>();
  tags.forEach((tg, i) => {
    const gg = svg('g', { class: `tag t-${tg.id}` });
    gg.append(
      svg('line', { x1: tg.x, y1: by + 33, x2: tg.x, y2: trunkY, class: 'drop' }),
      svg('circle', { cx: tg.x, cy: by, r: 16, class: 'bub' }),
      svg('line', { x1: tg.x - 16, y1: by, x2: tg.x + 16, y2: by, class: 'mid' }),
      T(tg.x, by - 4, tg.label, 'tl', 'middle'),
      T(tg.x, by + 11, `${pad(i + 1)}`, 'tn', 'middle'),
      svg('path', { d: `M${tg.x + 9} ${by - 18}l3 3l6 -7`, class: 'tick' }),
    );
    const val = T(tg.x, by + 28, '', 'tv', 'middle');
    gg.append(val);
    root.append(gg);
    tagEls.set(tg.id, { g: gg, val });
  });
  // the MIC's live trace, beside its bubble
  const trace = svg('polyline', { points: '', class: 'trace' });
  root.append(svg('rect', { x: 210, y: y0 + 4, width: 52, height: 16, class: 'tracebox' }), trace);

  // ================================================================ 03 REVISIONS
  const ry = 268;
  root.append(T(0, ry, '03 · REVISIONS', 'sec'), svg('line', { x1: 84, y1: ry - 3, x2: W, y2: ry - 3, class: 'rule' }));
  const rows = svg('g', { class: 'revs' });
  root.append(rows);
  const stamp = svg('g', { class: 'stamp' });
  root.append(stamp);

  // ---- updates: once a second (the cursor), and whenever a check changes
  const update = () => {
    const n = Date.now();
    const onSheet = n >= a && n <= b;
    const nx = cx(n);
    now.setAttribute('transform', `translate(${nx} 0)`);
    now.classList.toggle('off', !onSheet);
    offL.textContent = '';
    if (!onSheet) {
      const away = Math.abs(n - (n > b ? b : a));
      const d = away >= 86_400_000 ? `${Math.round(away / 86_400_000)} D` : away >= 3_600_000 ? `${Math.round(away / 3_600_000)} H` : `${Math.round(away / MIN)} MIN`;
      if (n > b) { offL.setAttribute('x', String(X0)); offL.setAttribute('text-anchor', 'start'); offL.textContent = `NOW: ${d} AFTER THIS SHEET →`; }
      else { offL.setAttribute('x', String(X0)); offL.setAttribute('text-anchor', 'start'); offL.textContent = `← NOW: ${d} BEFORE`; }
    }
    // the leader: from NOW to the start, with the countdown
    if (t && t.startAt && (t.state === 'upcoming' || t.state === 'open') && t.startAt > n) {
      const sx = cx(t.startAt) - nx;
      lead.setAttribute('x2', String(Math.max(0, sx - 2)));
      const m = Math.ceil((t.startAt - n) / MIN);
      leadT.textContent = m >= 60 ? `${Math.floor(m / 60)} H ${pad(m % 60)}` : `${m} MIN`;
      leadT.setAttribute('x', String(Math.max(18, sx / 2)));
      lead.style.display = sx > 24 ? '' : 'none';
      leadT.style.display = sx > 40 ? '' : 'none';
      if (!onSheet) { now.classList.remove('off'); now.setAttribute('transform', `translate(${X0} 0)`); offL.textContent = ''; }
    } else { lead.style.display = 'none'; leadT.style.display = 'none'; }
    if (elapsed && t?.liveSince) elapsed.setAttribute('width', String(Math.max(0, cx(n) - cx(t.liveSince))));
    // readiness
    const set = (id: string, ok: boolean | null, text: string, na = false) => {
      const e = tagEls.get(id)!;
      e.g.classList.toggle('ok', ok === true);
      e.g.classList.toggle('na', na);
      e.g.classList.toggle('wait', !o.devices && id !== 'net');
      e.val.textContent = text;
    };
    set('net', READY.net !== null, READY.net === null ? 'MEASURING' : `${READY.net} MS`);
    set('cam', READY.cam === true, READY.cam === null ? (o.devices ? 'CHECK' : '—') : READY.cam ? 'LIVE' : 'NONE', READY.cam === false);
    const lv = READY.levels.length ? READY.levels[READY.levels.length - 1] : 0;
    set('mic', READY.mic === true, READY.mic === null ? (o.devices ? 'SPEAK' : '—') : READY.mic ? `L${pad(lv)}` : 'NONE', READY.mic === false);
    set('spk', READY.spk, READY.spk ? 'TESTED' : o.devices ? 'TEST' : '—');
    // the trace: the last levels, newest on the right
    const L = READY.levels;
    trace.setAttribute('points', L.map((v, i) => `${210 + (52 * (i + 48 - L.length)) / 47},${y0 + 19 - Math.min(14, (v / 20) * 14)}`).join(' '));
    // revisions
    const list: Array<[string, string, string, string?]> = [['0', 'DRAWN · MEETING SHEET OPENED', hm(REV.drawnAt)]];
    if (REV.checkedAt) list.push(['A', `CHECKED · ${(checkedName() || REV.checkedBy || 'YOU').toUpperCase().slice(0, 26)}`, hm(REV.checkedAt)]);
    if (t?.state === 'cancelled') list.push(['V', 'VOID · CANCELLED BY THE HOST', '—', 'void']);
    if (REV.awaiting && !REV.approvedAt) list.push(['B', 'AWAITING APPROVAL', hm(n), 'await']);
    if (REV.approvedAt) list.push(['B', 'APPROVED FOR ENTRY', hm(REV.approvedAt)]);
    if (REV.issued) list.push(['C', `ISSUED · ${len(REV.issued.spentMs)} IN THE MEETING`, hm(REV.issued.at)]);
    rows.replaceChildren(svg('line', { x1: 0, y1: ry + 6, x2: W, y2: ry + 6, class: 'rr' }));
    list.slice(-4).forEach(([rev, what, when, cls], i) => {
      const yy = ry + 20 + i * 18;
      rows.append(
        svg('rect', { x: 0, y: yy - 12, width: W, height: 18, class: `rowbg${cls ? ` ${cls}` : ''}` }),
        T(10, yy, rev, 'rev', 'middle'), T(28, yy, what, `rd${cls ? ` ${cls}` : ''}`), T(W - 4, yy, when, 'rt', 'end'),
        svg('line', { x1: 0, y1: yy + 6, x2: W, y2: yy + 6, class: 'rr' }),
      );
    });
    rows.append(svg('line', { x1: 20, y1: ry + 6, x2: 20, y2: ry + 6 + Math.min(4, list.length) * 18, class: 'rr' }), svg('line', { x1: W - 46, y1: ry + 6, x2: W - 46, y2: ry + 6 + Math.min(4, list.length) * 18, class: 'rr' }));
    // the stamp: plotted in once, when the host lets the visitor in
    if (REV.approvedAt && !stamp.childNodes.length) {
      const sx = 196, sy = ry + 30;
      stamp.setAttribute('transform', `rotate(-6 ${sx + 64} ${sy + 18})`);
      stamp.append(svg('rect', { x: sx, y: sy, width: 128, height: 34, rx: 2, class: 'st', pathLength: 1 }), svg('rect', { x: sx + 3, y: sy + 3, width: 122, height: 28, rx: 1, class: 'st in', pathLength: 1 }), T(sx + 64, sy + 15, 'APPROVED', 'stt', 'middle'), T(sx + 64, sy + 26, `FOR ENTRY · ${hm(REV.approvedAt)}`, 'sts', 'middle'));
      if (!REV.stampShown && !reduced()) stamp.classList.add('plot');
      REV.stampShown = true;
    }
  };

  // the text the drawing stands for
  const cap = h('figcaption', { class: 'vh' });
  const caption = () => {
    const parts: string[] = [];
    if (t?.startAt && t.endAt) {
      parts.push(`Time: ${clock(t.startAt)} to ${clock(t.endAt)} your time (${zoneCity(zone)})${sameZone ? ', the same as the office' : `; ${hm(t.startAt, office)} to ${hm(t.endAt, office)} office time (${zoneCity(office)})`}.`);
      if (t.state === 'live' && t.liveSince) parts.push(`In progress since ${clock(t.liveSince)}.`);
      if (t.state === 'cancelled') parts.push('Cancelled.');
      if (t.next && t.state !== 'cancelled') parts.push(`Next: ${new Date(t.next.startAt).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}, ${clock(t.next.startAt)}.`);
    }
    const st = (ok: boolean | null, yes: string, no: string, wait: string) => (ok === true ? yes : ok === false ? no : wait);
    parts.push(`Readiness: network ${READY.net === null ? 'being measured' : `${READY.net} milliseconds`}; camera ${st(READY.cam, 'working', 'none found', 'not checked yet')}; microphone ${st(READY.mic, 'heard', 'none found', 'not checked yet')}; speakers ${READY.spk ? 'tested' : 'not tested yet'}.`);
    if (REV.checkedAt) parts.push('Checked and ready.');
    if (REV.awaiting && !REV.approvedAt) parts.push('Awaiting approval from the host.');
    if (REV.approvedAt) parts.push(`Approved for entry at ${clock(REV.approvedAt)}.`);
    if (REV.issued) parts.push(`Issued: ${Math.max(1, Math.round(REV.issued.spentMs / MIN))} minutes in the meeting.`);
    cap.textContent = parts.join(' ');
  };
  update();
  caption();
  current = { update, caption };
  if (timer) clearInterval(timer);
  timer = setInterval(() => current?.update(), 1000);
  if (!netTimer) { void measureNet(); netTimer = setInterval(() => { if (document.visibilityState === 'visible') void measureNet(); }, 20_000); }
  return h('figure', { class: 'living' }, root, cap);
}
