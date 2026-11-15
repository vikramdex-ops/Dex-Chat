// Dexterity Meet's landing page: https://<meeting site>/<meeting ID or name>#<passcode>.
//
// One drawing sheet per meeting. Before the passcode it shows only what the host allowed (the date
// and time, "Meeting with <office>", and the title and the host's first name when they left that
// on); with the passcode, the whole title block. Then: a live countdown or "In progress since …",
// Add to calendar, a device check (camera preview, a mic level, a speaker test, choosing devices),
// the guest's name and Join; for staff, "Open in Dexterity Connect". Waiting states (the room opens
// at …, the lobby, reconnecting) and a closing page (time spent, the host's follow-up, the next
// time of a repeating meeting) are drawn here too. The meeting itself (room.ts) loads on Join.
//
// The passcode is read from the #fragment (no server sees it), kept for this tab and taken out of
// the address bar; it is sent only in the body of the check request and the meeting's first frame.
// Every piece of text from the office is put on the page as text, never as HTML.
import { calendarLinks, meetPageUrl, parseMeetRef, refSegment } from '@dex/core/meetlink';
import type { MeetPageDetails, MeetPagePublic } from '@dex/core/meetlink';
import { buildIcs } from '@dex/core/ics';
import { clock, dayText, elapsed, h, icon, initials, lengthText, localZone, pad, svg, tintFor, toast, zoneCity, zoneOffset } from './shared.ts';
import type { EndKind, RoomEvents, RoomStart } from './room.ts';

type View = 'loading' | 'home' | 'none' | 'locked' | 'ready' | 'speaker' | 'connecting' | 'lobby' | 'room' | 'end' | 'limit' | 'offline';
interface EndInfo { kind: EndKind; reason: string; joinedAt: number | null; at: number }
type DexRoomApi = { start(o: RoomStart): { leave(): void; setMic(on: boolean): void } };

const root = document.getElementById('app') as HTMLElement;
const REF = root.dataset.ref ?? '';
const ROOM_JS = root.dataset.roomJs ?? '';
const ROOM_CSS = root.dataset.roomCss ?? '';
const parsed = parseMeetRef(REF);
const PASS_RE = /^[A-Za-z0-9]{6,10}$/;
const NAME_KEY = 'dex.guest.name';
const passKey = (r: string) => `dex.guest.pass.${r}`;
const store = {
  get(k: string): string { try { return sessionStorage.getItem(k) ?? ''; } catch { return ''; } },
  set(k: string, v: string): void { try { sessionStorage.setItem(k, v); } catch { /* private */ } },
  del(k: string): void { try { sessionStorage.removeItem(k); } catch { /* private */ } },
  local(k: string, v?: string): string { try { if (v !== undefined) localStorage.setItem(k, v); return localStorage.getItem(k) ?? ''; } catch { return v ?? ''; } },
};

// the passcode: from the fragment (then out of the address bar, so a shared screen never shows it)
const fromHash = (() => { try { return decodeURIComponent(location.hash.slice(1)).trim(); } catch { return ''; } })();
if (PASS_RE.test(fromHash)) store.set(passKey(REF), fromHash);
if (location.hash) history.replaceState(null, '', location.pathname);
// a webinar attendee the organiser invited to speak arrives from the watch page with a one-time pass
const SPEAKER = parsed?.kind === 'id' && store.get(`dex.webinar.speak.${parsed.id}`) === '1';

const S = {
  view: 'loading' as View,
  pub: null as MeetPagePublic | null,
  det: null as MeetPageDetails | null,
  passcode: store.get(passKey(REF)),
  passError: '',
  skew: 0,
  name: store.local(NAME_KEY),
  local: null as MediaStream | null,
  checking: false,
  micOn: true,
  camOn: true,
  devices: { cam: '', mic: '', out: '' },
  lobby: { host: '', since: 0 },
  end: null as EndInfo | null,
  reconnecting: 0,
  problem: '',
};
const now = () => Date.now() + S.skew;
let room: { leave(): void; setMic(on: boolean): void } | null = null;
const timers: Array<ReturnType<typeof setInterval>> = [];
const clearTimers = () => { for (const t of timers.splice(0)) clearInterval(t); };

// ------------------------------------------------------------------ talking to the office
async function call<T>(path: string, body?: unknown): Promise<{ status: number; data: T | null }> {
  try {
    const res = await fetch(path, body === undefined
      ? { headers: { accept: 'application/json' }, cache: 'no-store', credentials: 'omit' }
      : { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), cache: 'no-store', credentials: 'omit' });
    // the office's clock, so a countdown is right on a PC whose clock is off
    const date = Date.parse(res.headers.get('date') ?? '');
    if (Number.isFinite(date) && Math.abs(date - Date.now()) > 30_000) S.skew = date - Date.now();
    const data = await res.json().catch(() => null) as T | null;
    return { status: res.status, data };
  } catch {
    return { status: 0, data: null };
  }
}
const api = (sub = '') => `/api/m/${encodeURIComponent(REF)}${sub}`;

async function load(first = false): Promise<void> {
  if (S.passcode) {
    const r = await call<MeetPageDetails & { error?: string }>(api('/check'), { passcode: S.passcode });
    if (r.status === 200 && r.data?.ok) { S.det = r.data; S.pub = null; S.view = 'ready'; return; }
    if (r.status === 429) { S.problem = r.data?.error ?? 'Too many tries from your network. Wait a few minutes.'; S.view = 'limit'; return; }
    if (r.status === 0 || r.status >= 500) { if (first || !S.det) S.view = 'offline'; return; }
    // the passcode did not work: forget it, and show what may be shown without one
    store.del(passKey(REF));
    S.passcode = '';
    S.det = null;
    S.passError = first ? 'The passcode in your link did not work. Check the invitation, or type it here.' : 'That passcode does not open a meeting at this address.';
  }
  const r = await call<MeetPagePublic | { found: false; error?: string }>(api());
  if (r.status === 200 && r.data && 'found' in r.data && r.data.found) { S.pub = r.data; S.view = 'locked'; return; }
  if (r.status === 429) { S.problem = (r.data as { error?: string } | null)?.error ?? 'Too many tries from your network. Wait a few minutes.'; S.view = 'limit'; return; }
  if (r.status === 0 || r.status >= 500) { S.view = 'offline'; return; }
  S.pub = null;
  S.view = 'none';
}

// ------------------------------------------------------------------ words for times
const ZONE = localZone();
function whenLines(m: { startAt: number | null; endAt: number | null; zone: string | null }): { day: string; time: string; office: string | null } | null {
  if (!m.startAt || !m.endAt) return null;
  const office = m.zone && m.zone !== ZONE && zoneOffset(m.zone, m.startAt) !== zoneOffset(ZONE, m.startAt)
    ? `${clock(m.startAt, m.zone)} – ${clock(m.endAt, m.zone)} in ${zoneCity(m.zone)}` : null;
  return { day: dayText(m.startAt), time: `${clock(m.startAt)} – ${clock(m.endAt)}`, office };
}
function untilText(ms: number): string {
  const m = Math.max(0, Math.ceil(ms / 60_000));
  if (m >= 2 * 1440) return `${Math.floor(m / 1440)} days`;
  if (m >= 60) return `${Math.floor(m / 60)} h ${pad(m % 60)} min`;
  return `${m} min`;
}

/** The meeting as this page may describe it now (with the passcode, or only what is public). */
function facts() {
  const d = S.det, p = S.pub;
  const m = (d ?? p)!;
  const org = m.org;
  return {
    id: m.id,
    ref: m.ref,
    org,
    title: d?.title ?? p?.title ?? null,
    host: d?.host ?? p?.host ?? null,
    kind: m.kind,
    startAt: m.startAt, endAt: m.endAt, zone: m.zone,
    state: d?.state ?? p?.state ?? 'open',
    liveSince: m.liveSince, opensAt: m.opensAt, repeats: m.repeats,
    next: d?.next ?? null, followUp: d?.followUp ?? null,
  };
}

// ------------------------------------------------------------------ the frame: header, sheet, title block, footer
function themeButton(): HTMLElement {
  const dark = () => document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  const b = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Switch between light and dark' }, icon(dark() ? 'sun' : 'moon'));
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => b.replaceChildren(icon(dark() ? 'sun' : 'moon')));
  b.addEventListener('click', () => {
    const next = dark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.local('dex.meet.theme', next);
    b.replaceChildren(icon(next === 'dark' ? 'sun' : 'moon'));
  });
  return b;
}

function header(org: string): HTMLElement {
  return h('header', { class: 'top' },
    h('a', { class: 'lockup', href: '/', 'aria-label': 'Dexterity Meet home' },
      h('img', { src: root.dataset.mark ?? '', alt: '', width: '30', height: '30' }),
      h('span', { class: 'wm' }, h('b', {}, 'Dexterity Meet'), h('small', {}, org))),
    h('div', { class: 'top-tools' }, themeButton()),
  );
}

/** Ruled cells in the sheet's corner: what, when, where the office is, who. */
function titleBlock(rows: Array<[string, string, string?]>, foot: Array<[string, string]>): HTMLElement {
  return h('dl', { class: 'tblock', 'aria-label': 'Meeting details' },
    ...rows.map(([k, v, sub]) => h('div', { class: 'tb-row' }, h('dt', { class: 'tb-label' }, k), h('dd', {}, h('span', { class: 'tb-v' }, v), sub ? h('span', { class: 'tb-sub' }, sub) : null))),
    h('div', { class: 'tb-foot' }, ...foot.map(([k, v]) => h('div', {}, h('dt', { class: 'tb-label' }, k), h('dd', { class: 'mono' }, v)))),
  );
}

function frame(opts: { org: string; kicker: string; title: string; titleHidden?: boolean; state?: HTMLElement | null; body: Array<HTMLElement | null>; plan: string; block?: HTMLElement | null; tone?: string }): void {
  clearTimers();
  document.body.classList.remove('in-room');
  const h1 = h('h1', { tabindex: '-1', class: opts.titleHidden ? 'muted-title' : undefined }, opts.title);
  const refs = (n: number, letters: boolean) => h('div', { class: `refs ${letters ? 'top' : 'side'}`, 'aria-hidden': 'true' }, ...Array.from({ length: n }, (_, i) => h('span', {}, letters ? String.fromCharCode(65 + i) : String(i + 1))));
  root.replaceChildren(
    h('a', { class: 'skip', href: '#work' }, 'Skip to the meeting'),
    header(opts.org),
    h('main', { class: `sheet${opts.tone ? ` ${opts.tone}` : ''}` },
      refs(6, true), refs(4, false),
      h('div', { class: 'sheet-in' },
        h('section', { class: 'work', id: 'work' },
          h('p', { class: 'kicker label' }, opts.kicker),
          h1,
          opts.state ?? null,
          ...opts.body),
        h('aside', { class: 'plan', 'aria-label': 'The meeting at a glance' },
          drawing(opts.plan),
          opts.block ?? null),
      ),
    ),
    h('footer', { class: 'foot' },
      h('p', {}, icon('shield', 15), h('span', {}, 'Served by Dexterity Design Services from the office\'s own meeting service. Your camera and microphone go only to the people in the meeting; nothing on this page is tracked.')),
      h('p', { class: 'legal mono' }, `© ${new Date().getFullYear()} DEXTERITY DESIGN SERVICES PRIVATE LIMITED`)),
    h('div', { id: 'say', class: 'vh', 'aria-live': 'polite' }),
  );
  document.title = `${opts.title} · Dexterity Meet`;
  requestAnimationFrame(() => h1.focus({ preventScroll: true }));
}

/** Tell screen readers what changed (the sheet itself is redrawn quietly). */
function say(text: string): void { const el = document.getElementById('say'); if (el) el.textContent = text; }

// ------------------------------------------------------------------ the drawing: the room on plan
/**
 * A meeting room drawn on plan, in our own hand: walls, a door with its swing, a table with
 * chairs, a dimension line and a north point. Its state is the meeting's: drawing itself while
 * we wait, chairs taken while live, someone at the door in the lobby, a revision cloud when
 * cancelled, a dashed outline when there is nothing here.
 */
let drawnOnce = false;
function drawing(kind: string): HTMLElement {
  // plotted in on the first sheet of a visit; later states show the room at once (the waiting loop and the lobby ring still move)
  setTimeout(() => { drawnOnce = true; }, 2000);
  const p = (d: string, cls = 'ln', extra: Record<string, string | number> = {}) => svg('path', { d, class: cls, pathLength: 1, ...extra });
  const chairs: SVGElement[] = [];
  const seat = (x: number, y: number, i: number) => chairs.push(svg('rect', { x: x - 9, y: y - 7, width: 18, height: 14, rx: 2, class: `chair c${i}` }));
  [96, 136, 176, 216].forEach((x, i) => { seat(x, 70, i); seat(x, 150, i + 4); });
  const g = svg('g', { class: 'room-plan' },
    // walls: a double line, with the door opening on the south wall
    p('M20 20H300V200H178M142 200H20Z', 'ln wall'),
    p('M28 28H292V192H178M142 192H28Z', 'ln wall in'),
    // windows on the north wall
    p('M70 20V28M110 20V28M210 20V28M250 20V28', 'ln thin'),
    // the door and its swing
    p('M142 200L142 236', 'ln door'),
    p('M142 236A36 36 0 0 0 178 200', 'ln swing'),
    // the table
    svg('rect', { x: 76, y: 84, width: 160, height: 52, rx: 4, class: 'ln table', pathLength: 1 }),
    ...chairs,
    // dimension line under the plan
    p('M20 262H300M20 256V268M300 256V268', 'ln dim'),
    // north point
    p('M282 236L290 256L282 251L274 256Z', 'ln north'),
  );
  const dimText = svg('text', { x: 160, y: 258, class: 'dimtext', 'text-anchor': 'middle' });
  dimText.textContent = '4 800';
  const nText = svg('text', { x: 282, y: 232, class: 'dimtext', 'text-anchor': 'middle' });
  nText.textContent = 'N';
  g.append(dimText, nText);
  if (kind === 'lobby') {
    g.append(svg('circle', { cx: 160, cy: 222, r: 9, class: 'you' }), svg('circle', { cx: 160, cy: 222, r: 16, class: 'you-ring' }));
  }
  if (kind === 'cancelled') {
    g.append(p('M60 60q10-16 26-6q12-14 26 0q14-12 26 2q16-8 22 10q14 6 6 22q10 12-4 22q4 16-14 16q-6 14-22 6q-12 12-26 2q-16 8-24-6q-16 0-14-16q-12-10-2-22q-8-16 8-20q2-16 14-10z', 'ln cloud'));
    const tag = svg('g', { class: 'void' }, svg('rect', { x: 196, y: 40, width: 84, height: 22, rx: 1 }));
    const t = svg('text', { x: 238, y: 55.5, 'text-anchor': 'middle' });
    t.textContent = 'CANCELLED';
    tag.append(t);
    g.append(tag);
  }
  const box = svg('svg', { viewBox: '0 0 320 276', class: `dwg k-${kind}${drawnOnce ? ' still' : ''}`, role: 'img', 'aria-label': kind === 'live' ? 'The meeting room, with people at the table' : kind === 'lobby' ? 'The meeting room, with you waiting at the door' : kind === 'cancelled' ? 'The meeting room, marked cancelled' : 'The meeting room on plan' }, g);
  return h('figure', { class: 'drawing' }, box);
}

// ------------------------------------------------------------------ the state line
function stateLine(f: ReturnType<typeof facts>): HTMLElement {
  const el = h('div', { class: 'state', role: 'timer', 'aria-live': 'off' });
  let opened = false;
  const draw = () => {
    const t = now();
    if (f.state === 'live') {
      el.className = 'state live';
      el.replaceChildren(h('span', { class: 'pip', 'aria-hidden': 'true' }), h('span', { class: 'label' }, 'In progress'), h('span', { class: 'big mono' }, `since ${clock(f.liveSince ?? t)}`));
      el.setAttribute('aria-label', `In progress since ${clock(f.liveSince ?? t)}`);
    } else if (f.state === 'upcoming' && f.startAt) {
      const left = f.startAt - t;
      const s = Math.max(0, Math.floor(left / 1000));
      const parts: Array<[string, string]> = s >= 86_400 ? [[String(Math.floor(s / 86400)), 'days'], [pad(Math.floor((s % 86400) / 3600)), 'h'], [pad(Math.floor((s % 3600) / 60)), 'min']] : [[pad(Math.floor(s / 3600)), 'h'], [pad(Math.floor((s % 3600) / 60)), 'min'], [pad(s % 60), 's']];
      el.className = 'state soon';
      el.replaceChildren(h('span', { class: 'label' }, 'Starts in'), h('span', { class: 'count', 'aria-hidden': 'true' }, ...parts.map(([n, u]) => h('span', { class: 'cell' }, h('b', { class: 'mono' }, n), h('i', { class: 'label' }, u)))));
      el.setAttribute('aria-label', `Starts in ${untilText(left)}`);
      if (f.opensAt && f.opensAt <= t && !opened) { opened = true; void refresh(); }
    } else if (f.state === 'open') {
      el.className = 'state open';
      el.replaceChildren(h('span', { class: 'pip open', 'aria-hidden': 'true' }), h('span', { class: 'label' }, f.kind === 'scheduled' && f.startAt && f.startAt > t ? `The room is open · starts at ${clock(f.startAt)}` : 'The room is open'), h('span', { class: 'big mono' }, f.kind === 'personal' ? 'ask to come in' : 'the host lets you in'));
      el.setAttribute('aria-label', 'The room is open. Ask to join and the host lets you in.');
    } else {
      el.className = 'state over';
      el.replaceChildren(h('span', { class: 'label' }, f.state === 'cancelled' ? 'Cancelled' : 'Ended'));
    }
  };
  draw();
  timers.push(setInterval(draw, 1000));
  return el;
}

// ------------------------------------------------------------------ add to calendar
function calendarRow(f: ReturnType<typeof facts>, at: { startAt: number; endAt: number } | null, label = 'Add to calendar'): HTMLElement | null {
  const when = at ?? (f.startAt && f.endAt ? { startAt: f.startAt, endAt: f.endAt } : null);
  if (!when) return null;
  const page = meetPageUrl(location.origin, f.ref);
  const title = f.title ?? `Meeting with ${f.org}`;
  const details = `Join from your browser: ${page}\nThe passcode is in your invitation.${f.host ? `\nHosted by ${f.host}, ${f.org}.` : ''}`;
  const links = calendarLinks({ title, startAt: when.startAt, endAt: when.endAt, url: page, details });
  const ics = () => {
    // the file stays on this computer, so it may carry the passcode in the link's fragment
    const text = buildIcs({
      uid: at ? `meeting-${f.id}-${when.startAt}@dexconnect` : `meeting-${f.id}@dexconnect`, title, startAt: when.startAt, endAt: when.endAt,
      organizer: { name: f.host ? `${f.host} · ${f.org}` : f.org, email: null, id: f.id }, office: f.org, meetingId: f.id,
      guestUrl: S.passcode ? meetPageUrl(location.origin, f.ref, S.passcode) : page, pageUrl: page, passcode: S.passcode || null,
      appLink: `dexconnect://meet/${refSegment(f.id)}`,
    }, `${dayText(when.startAt)}, ${clock(when.startAt)} – ${clock(when.endAt)} (${ZONE})`);
    const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }));
    const a = h('a', { href: url, download: `${title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) || 'Meeting'}.ics` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    toast('Calendar file saved. Open it to add the meeting.');
  };
  return h('div', { class: 'cal-row', role: 'group', 'aria-label': label },
    h('span', { class: 'label' }, label),
    h('button', { type: 'button', class: 'cal-cell', onclick: ics, title: 'An .ics file for Outlook, Apple Calendar and others' }, icon('down', 15), h('span', {}, 'Calendar file')),
    h('a', { class: 'cal-cell', href: links.google, target: '_blank', rel: 'noopener noreferrer' }, icon('cal', 15), h('span', {}, 'Google Calendar')),
    h('a', { class: 'cal-cell', href: links.outlook, target: '_blank', rel: 'noopener noreferrer' }, icon('cal', 15), h('span', {}, 'Outlook.com')),
  );
}

// ------------------------------------------------------------------ the device check
let meterStop: (() => void) | null = null;
const canChooseSpeakers = typeof (HTMLMediaElement.prototype as HTMLMediaElement & { setSinkId?: unknown }).setSinkId === 'function';

async function getMedia(): Promise<MediaStream | null> {
  if (!navigator.mediaDevices?.getUserMedia) return null;
  const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(S.devices.mic ? { deviceId: { exact: S.devices.mic } } : {}) };
  const video: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 }, ...(S.devices.cam ? { deviceId: { exact: S.devices.cam } } : {}) };
  try { return await navigator.mediaDevices.getUserMedia({ audio, video }); } catch { /* try sound only */ }
  try { return await navigator.mediaDevices.getUserMedia({ audio }); } catch { return null; }
}

async function startCheck(): Promise<void> {
  S.checking = true;
  for (const t of S.local?.getTracks() ?? []) t.stop();
  S.local = await getMedia();
  S.camOn = !!S.local?.getVideoTracks().length && S.camOn;
  S.micOn = !!S.local?.getAudioTracks().length && S.micOn;
  for (const t of S.local?.getAudioTracks() ?? []) t.enabled = S.micOn;
  render();
}

function preview(small = false): HTMLElement {
  const cam = S.local?.getVideoTracks()[0];
  const live = !!cam && S.camOn;
  const v = h('video', { autoplay: true, playsinline: true, muted: true, class: 'mirror' }) as HTMLVideoElement;
  v.muted = true;
  if (live) { v.srcObject = S.local; void v.play().catch(() => {}); }
  return h('div', { class: `preview${live ? ' live' : ''}${small ? ' small' : ''}` },
    live ? v : h('span', { class: 'face', style: `--tint:${tintFor(S.name || 'guest')}` }, initials(S.name || 'You')),
    h('span', { class: 'cap' }, h('b', {}, 'A1'), h('span', {}, `${(S.name.trim().split(/\s+/)[0] || 'YOU').toUpperCase()} · PREVIEW`)),
  );
}

/** The mic level as a ruled scale: twenty ticks, lit as you speak. */
function meter(): HTMLElement {
  const ticks = Array.from({ length: 20 }, (_, i) => h('i', { class: i % 5 === 4 ? 'major' : '' }));
  const el = h('div', { class: 'meter', role: 'meter', 'aria-label': 'Microphone level', 'aria-valuemin': '0', 'aria-valuemax': '20', 'aria-valuenow': '0' }, ...ticks);
  meterStop?.();
  const track = S.local?.getAudioTracks()[0];
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!track || !AC) return el;
  const ctx = new AC();
  const an = ctx.createAnalyser();
  an.fftSize = 512;
  ctx.createMediaStreamSource(new MediaStream([track])).connect(an);
  const buf = new Uint8Array(an.fftSize);
  let lastSaid = -1;
  const t = setInterval(() => {
    an.getByteTimeDomainData(buf);
    let sum = 0;
    for (const b of buf) { const x = (b - 128) / 128; sum += x * x; }
    const lit = S.micOn ? Math.min(20, Math.round(Math.sqrt(sum / buf.length) * 90)) : 0;
    if (Math.abs(lit - lastSaid) >= 2) { el.setAttribute('aria-valuenow', String(lit)); lastSaid = lit; }
    ticks.forEach((tk, i) => tk.classList.toggle('on', i < lit));
  }, 100);
  meterStop = () => { clearInterval(t); void ctx.close().catch(() => {}); meterStop = null; };
  return el;
}

/** A short two-note chime, through the speakers chosen. */
async function testSpeakers(btn: HTMLButtonElement): Promise<void> {
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) { toast('This browser cannot play a test sound.'); return; }
  const ctx = new AC();
  const dest = ctx.createMediaStreamDestination();
  const a = new Audio();
  a.srcObject = dest.stream;
  const sink = (a as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId;
  if (S.devices.out && sink) await sink.call(a, S.devices.out).catch(() => {});
  for (const [f, at] of [[660, 0], [880, 0.28]] as const) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
    g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.5);
    o.connect(g).connect(dest);
    o.start(ctx.currentTime + at); o.stop(ctx.currentTime + at + 0.55);
  }
  void a.play().catch(() => {});
  btn.setAttribute('aria-pressed', 'true');
  btn.querySelector('span')!.textContent = 'Playing…';
  setTimeout(() => { void ctx.close().catch(() => {}); btn.setAttribute('aria-pressed', 'false'); btn.querySelector('span')!.textContent = 'Test speakers'; toast('Heard two notes? Your speakers work.'); }, 1100);
}

async function deviceChooser(): Promise<HTMLElement> {
  const list = await navigator.mediaDevices?.enumerateDevices?.().catch(() => [] as MediaDeviceInfo[]) ?? [];
  const sel = (kind: MediaDeviceKind, label: string, key: 'cam' | 'mic' | 'out') => {
    const items = list.filter((d) => d.kind === kind && d.deviceId);
    if (!items.length) return null;
    const id = `dev-${key}`;
    const current = S.devices[key] || (key === 'cam' ? S.local?.getVideoTracks()[0]?.getSettings().deviceId : key === 'mic' ? S.local?.getAudioTracks()[0]?.getSettings().deviceId : '') || '';
    const s = h('select', { id, class: 'input' }, ...items.map((d, i) => h('option', { value: d.deviceId, selected: d.deviceId === current || undefined }, d.label || `${label} ${i + 1}`)));
    s.addEventListener('change', () => { S.devices[key] = s.value; if (key === 'out') toast('Speakers chosen'); else void startCheck(); });
    return h('div', { class: 'dev' }, h('label', { for: id, class: 'field-label' }, label), s);
  };
  return h('div', { class: 'devices' }, sel('videoinput', 'Camera', 'cam'), sel('audioinput', 'Microphone', 'mic'), canChooseSpeakers ? sel('audiooutput', 'Speakers', 'out') : null);
}

function checkPanel(n: string): HTMLElement {
  const hasCam = !!S.local?.getVideoTracks().length;
  const hasMic = !!S.local?.getAudioTracks().length;
  const tool = (onOff: boolean, label: string, ico: string, f: () => void, disabled = false) =>
    h('button', { type: 'button', class: `tool${onOff ? ' on' : ' off'}`, 'aria-pressed': String(onOff), onclick: f, disabled }, icon(ico), h('span', {}, label));
  if (!S.checking) {
    return h('section', { class: 'panel check', 'aria-labelledby': 'chk-h' },
      h('div', { class: 'panel-head' }, h('span', { class: 'label', id: 'chk-h' }, `${n} · Camera, microphone and speakers`)),
      h('div', { class: 'check-grid' },
        h('div', { class: 'preview off' }, h('span', { class: 'face', style: `--tint:${tintFor(S.name || 'guest')}` }, initials(S.name || 'You')), h('span', { class: 'cap' }, h('b', {}, 'A1'), h('span', {}, 'CAMERA OFF'))),
        h('div', { class: 'check-side' },
          h('p', { class: 'small' }, 'See how you look and sound before you go in. Nothing is sent until the host lets you in.'),
          h('button', { type: 'button', class: 'btn', onclick: () => void startCheck() }, icon('cam', 16), 'Check camera and mic'),
          h('button', { type: 'button', class: 'tool wide', onclick: (e: Event) => void testSpeakers(e.currentTarget as HTMLButtonElement) }, icon('sound'), h('span', {}, 'Test speakers')),
        )),
    );
  }
  const chooser = h('details', { class: 'choose' }, h('summary', { class: 'label' }, 'Choose devices'));
  chooser.addEventListener('toggle', () => { if (chooser.open && chooser.children.length === 1) void deviceChooser().then((d) => chooser.append(d)); });
  return h('section', { class: 'panel check', 'aria-labelledby': 'chk-h' },
    h('div', { class: 'panel-head' }, h('span', { class: 'label', id: 'chk-h' }, `${n} · Camera, microphone and speakers`)),
    h('div', { class: 'check-grid' },
      preview(),
      h('div', { class: 'check-side' },
        h('span', { class: 'field-label' }, 'Microphone level'),
        meter(),
        h('p', { class: 'faint small' }, hasMic ? 'Say something: the scale moves when the meeting can hear you.' : 'No microphone could be used. You can still listen and use the chat.'),
        h('div', { class: 'tools' },
          tool(S.micOn && hasMic, S.micOn && hasMic ? 'Mic on' : 'Mic off', S.micOn && hasMic ? 'mic' : 'mic-off', () => { S.micOn = !S.micOn; for (const t of S.local?.getAudioTracks() ?? []) t.enabled = S.micOn; render(); }, !hasMic),
          tool(S.camOn && hasCam, S.camOn && hasCam ? 'Camera on' : 'Camera off', S.camOn && hasCam ? 'cam' : 'cam-off', () => { S.camOn = !S.camOn; for (const t of S.local?.getVideoTracks() ?? []) t.enabled = S.camOn; render(); }, !hasCam),
          h('button', { type: 'button', class: 'tool', 'aria-pressed': 'false', onclick: (e: Event) => void testSpeakers(e.currentTarget as HTMLButtonElement) }, icon('sound'), h('span', {}, 'Test speakers')),
        ),
        !hasCam ? h('p', { class: 'faint small' }, 'No camera could be used: you join with your initials on a tile.') : null,
        chooser,
      )),
  );
}

// ------------------------------------------------------------------ name and join
function joinPanel(n: string, f: ReturnType<typeof facts>, canJoin: boolean, why: string | null): HTMLElement {
  const input = h('input', { id: 'join-name', class: 'input', maxlength: '60', autocomplete: 'name', placeholder: 'For example, Dana Wright', value: S.name, 'aria-describedby': 'name-help', required: true });
  input.addEventListener('input', () => { S.name = input.value; });
  const label = SPEAKER ? 'Go on stage' : f.state === 'live' ? 'Join the meeting' : 'Ask to join';
  const go = h('button', { class: 'btn primary lg join', type: 'submit', disabled: !canJoin }, icon('door', 18), label);
  const form = h('form', { class: 'panel join', 'aria-labelledby': 'join-h', onsubmit: (e: Event) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v) { input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
    S.name = v.slice(0, 60);
    store.local(NAME_KEY, S.name);
    void join();
  } },
  h('div', { class: 'panel-head' }, h('span', { class: 'label', id: 'join-h' }, `${n} · Your name, then join`)),
  h('label', { class: 'field-label', for: 'join-name' }, 'Your name'),
  h('div', { class: 'join-row' }, input, go),
  h('p', { id: 'name-help', class: 'faint small' }, why ?? (SPEAKER ? 'Everyone watching sees and hears you until the organiser brings you back to the audience.' : 'Everyone in the meeting sees this name. You wait in the lobby until the host lets you in.')),
  S.problem ? h('p', { class: 'problem', role: 'alert' }, S.problem) : null,
  );
  return form;
}

function staffLink(id: string): HTMLElement {
  return h('p', { class: 'staff' }, icon('app', 16),
    h('span', {}, 'At Dexterity? ', h('a', { href: `dexconnect://meet/${refSegment(id)}` }, 'Open in Dexterity Connect'), ' to join from the app.'));
}

function passForm(): HTMLElement {
  const input = h('input', { id: 'pass', class: 'input mono', maxlength: '10', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'Hx7kP2qR', 'aria-describedby': 'pass-help', 'aria-invalid': S.passError ? 'true' : undefined });
  return h('form', { class: 'panel pass', 'aria-labelledby': 'pass-h', onsubmit: async (e: Event) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!PASS_RE.test(v)) { S.passError = 'A passcode is 6 to 10 letters and digits.'; render(); return; }
    S.passcode = v;
    store.set(passKey(REF), v);
    S.passError = '';
    await load();
    render();
  } },
  h('div', { class: 'panel-head' }, h('span', { class: 'label', id: 'pass-h' }, '01 · Passcode')),
  h('label', { class: 'field-label', for: 'pass' }, 'Passcode from your invitation'),
  h('div', { class: 'join-row' }, input, h('button', { class: 'btn primary', type: 'submit' }, icon('key', 16), 'Continue')),
  h('p', { id: 'pass-help', class: S.passError ? 'problem' : 'faint small', role: S.passError ? 'alert' : undefined }, S.passError || 'It is in the invitation, after the # in the link or on its own line.'),
  );
}

// ------------------------------------------------------------------ the views
function blockFor(f: ReturnType<typeof facts>, status: string): HTMLElement {
  const w = whenLines(f);
  const rows: Array<[string, string, string?]> = [
    ['Meeting', f.title ?? `Meeting with ${f.org}`],
  ];
  if (w) {
    rows.push(['Date', w.day]);
    rows.push(['Time', w.time, `your time · ${zoneCity(ZONE)}`]);
    if (w.office) rows.push(['At the office', w.office]);
  } else rows.push(['When', f.kind === 'personal' ? 'A standing room: any time the host is in' : 'Now']);
  rows.push(['Host', f.host ? `${f.host} · ${f.org}` : f.org]);
  return titleBlock(rows, [['ID', refSegment(f.id)], ['Status', status], ['Drawn', 'Dexterity Connect']]);
}

function statusWord(s: string): string { return ({ upcoming: 'UPCOMING', open: 'OPEN', live: 'LIVE', ended: 'ENDED', cancelled: 'CANCELLED' } as Record<string, string>)[s] ?? s.toUpperCase(); }

function renderReady(): void {
  const f = facts();
  if (f.state === 'cancelled' || f.state === 'ended') { renderOver(f); return; }
  const w = whenLines(f);
  const t = now();
  const waiting = f.state === 'upcoming';
  const canJoin = !waiting || SPEAKER;
  const why = waiting && f.opensAt ? `The room opens at ${clock(f.opensAt)}, ten minutes before the start. This page opens it for you.` : null;
  const lead = waiting
    ? h('p', { class: 'lead' }, `The room opens at ${clock(f.opensAt ?? f.startAt ?? t)}. Get ready while you wait: check your camera and microphone below.`)
    : f.state === 'live' ? h('p', { class: 'lead' }, `${f.host ?? 'The host'} is in the meeting. Ask to join and you will be let in from the lobby.`)
      : h('p', { class: 'lead' }, `Ask to join now; ${f.host ?? 'the host'} lets you in from the lobby${f.kind === 'scheduled' && f.startAt && f.startAt > t ? ` (it starts at ${clock(f.startAt)})` : ''}.`);
  frame({
    org: f.org,
    kicker: `${f.kind === 'personal' ? 'Personal room' : f.kind === 'scheduled' ? (f.repeats ? 'Repeating meeting' : 'Meeting') : 'Meeting'} · ${refSegment(f.id)}`,
    title: f.title ?? `Meeting with ${f.org}`,
    state: stateLine(f),
    body: [
      w ? h('p', { class: 'when' }, icon('clock', 16), h('span', {}, h('b', {}, `${w.day}, ${w.time}`), ' your time', w.office ? h('span', { class: 'faint' }, ` · ${w.office}`) : null)) : null,
      lead,
      calendarRow(f, null),
      checkPanel('01'),
      joinPanel('02', f, canJoin, why),
      staffLink(f.id),
    ],
    plan: f.state === 'live' ? 'live' : waiting ? 'waiting' : 'open',
    block: blockFor(f, statusWord(f.state)),
    tone: f.state === 'live' ? 'is-live' : undefined,
  });
  // the room opens by itself at its time
  if (waiting && f.opensAt) {
    const ms = f.opensAt - t;
    if (ms > 0 && ms < 2 ** 31) timers.push(setTimeout(() => { void refresh(); }, ms + 500) as unknown as ReturnType<typeof setInterval>);
  }
}

function renderLocked(): void {
  const f = facts();
  const w = whenLines(f);
  frame({
    org: f.org,
    kicker: `${f.kind === 'personal' ? 'Personal room' : 'Meeting'} · ${refSegment(f.id)}`,
    title: f.title ?? `Meeting with ${f.org}`,
    titleHidden: !f.title,
    state: stateLine(f),
    body: [
      w ? h('p', { class: 'when' }, icon('clock', 16), h('span', {}, h('b', {}, `${w.day}, ${w.time}`), ' your time', w.office ? h('span', { class: 'faint' }, ` · ${w.office}`) : null)) : null,
      h('p', { class: 'lead' }, f.title ? 'Enter the passcode from your invitation to see the details and join.' : 'The host keeps the details of this meeting for the people invited. Enter the passcode from your invitation to see them and join.'),
      passForm(),
      calendarRow(f, null),
      staffLink(f.id),
    ],
    plan: f.state === 'live' ? 'live' : f.state === 'upcoming' ? 'waiting' : 'open',
    block: blockFor(f, statusWord(f.state)),
    tone: f.state === 'live' ? 'is-live' : undefined,
  });
}

function renderNone(): void {
  frame({
    org: 'Dexterity Design Services',
    kicker: parsed?.kind === 'id' ? `Meeting · ${refSegment(parsed.id)}` : `Address · /${REF}`,
    title: 'No meeting to show here yet',
    body: [
      h('p', { class: 'lead' }, 'The address may be mistyped, the meeting may be over, or its host keeps it to invited people. If your invitation has a passcode, enter it.'),
      passForm(),
      parsed?.kind === 'id' ? staffLink(parsed.id) : null,
      findForm(),
    ],
    plan: 'none',
    block: titleBlock([['Meeting', '—'], ['Date', '—'], ['Host', 'Dexterity Design Services']], [['ID', parsed?.kind === 'id' ? refSegment(parsed.id) : '—'], ['Status', '—'], ['Drawn', 'Dexterity Connect']]),
  });
}

function findForm(): HTMLElement {
  const input = h('input', { id: 'find', class: 'input mono', maxlength: '64', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: '482-913-207 or p12-design-review' });
  return h('form', { class: 'panel find', 'aria-labelledby': 'find-h', onsubmit: (e: Event) => {
    e.preventDefault();
    const raw = input.value.trim();
    // a whole link pasted in: keep its path and fragment
    const m = raw.match(/^https?:\/\/[^/]+\/([^#?]+)(#.*)?$/);
    const ref = (m ? m[1] : raw).trim().toLowerCase().replace(/\s+/g, '-');
    const r = parseMeetRef(ref);
    if (!r) { input.setAttribute('aria-invalid', 'true'); toast('A meeting ID has nine digits; a name is letters, digits and hyphens.'); return; }
    location.assign(`/${r.kind === 'id' ? refSegment(r.id) : r.slug}${m?.[2] ?? ''}`);
  } },
  h('div', { class: 'panel-head' }, h('span', { class: 'label', id: 'find-h' }, REF ? 'Another meeting' : '01 · Meeting ID or name')),
  h('label', { class: 'field-label', for: 'find' }, 'Meeting ID, name or link'),
  h('div', { class: 'join-row' }, input, h('button', { class: 'btn', type: 'submit' }, icon('arrow', 16), 'Go')),
  );
}

function renderHome(): void {
  frame({
    org: 'Dexterity Design Services',
    kicker: 'Dexterity Meet',
    title: 'Join a meeting with Dexterity Design Services',
    body: [
      h('p', { class: 'lead' }, 'Open the link in your invitation, or type the meeting ID or name here. You join from this browser: nothing to install.'),
      findForm(),
    ],
    plan: 'open',
    block: titleBlock([['Meeting', 'Yours, from the invitation'], ['Host', 'Dexterity Design Services']], [['ID', '—'], ['Status', '—'], ['Drawn', 'Dexterity Connect']]),
  });
}

function renderOver(f: ReturnType<typeof facts>): void {
  const cancelled = f.state === 'cancelled';
  // a cancellation cancels every repeat: there is no next time
  const next = !cancelled && f.next && f.next.startAt > now() ? f.next : null;
  frame({
    org: f.org,
    kicker: `${cancelled ? 'Cancelled' : 'Ended'} · ${refSegment(f.id)}`,
    title: cancelled ? 'This meeting was cancelled' : 'This meeting has ended',
    body: [
      h('p', { class: 'lead' }, cancelled ? `${f.host ?? 'The host'} cancelled ${f.title ? `"${f.title}"` : 'this meeting'}. There is nothing to join. If you still need to meet, reply to the invitation.` : `${f.title ? `"${f.title}"` : 'This meeting'} is over.${next ? ' It meets again:' : ''}`),
      f.followUp && !cancelled ? followUp(f) : null,
      next ? nextBlock(f, next) : null,
    ],
    plan: cancelled ? 'cancelled' : 'over',
    block: blockFor(f, statusWord(f.state)),
    tone: cancelled ? 'is-void' : undefined,
  });
}

function followUp(f: ReturnType<typeof facts>): HTMLElement {
  return h('figure', { class: 'follow' }, h('figcaption', { class: 'label' }, `From ${f.host ?? 'the host'}`), h('blockquote', {}, f.followUp ?? ''));
}

function nextBlock(f: ReturnType<typeof facts>, next: { startAt: number; endAt: number }): HTMLElement {
  return h('div', { class: 'next' },
    h('p', { class: 'when' }, icon('cal', 16), h('span', {}, h('b', {}, `Next: ${dayText(next.startAt)}, ${clock(next.startAt)} – ${clock(next.endAt)}`), ' your time')),
    calendarRow(f, next, 'Add the next one'),
  );
}

function renderSpeaker(): void {
  const id = parsed?.kind === 'id' ? parsed.id : '';
  frame({
    org: 'Dexterity Design Services',
    kicker: `Webinar · ${refSegment(id)}`,
    title: 'You are invited to speak',
    body: [
      h('p', { class: 'lead' }, 'The organiser asked you onto the stage of the webinar. Check your camera and microphone, then go on stage.'),
      checkPanel('01'),
      joinPanel('02', { id, ref: refSegment(id), org: 'Dexterity Design Services', title: null, host: null, kind: 'instant', startAt: null, endAt: null, zone: null, state: 'live', liveSince: null, opensAt: null, repeats: false, next: null, followUp: null }, true, null),
    ],
    plan: 'live',
    block: titleBlock([['Webinar', refSegment(id)], ['You', 'Speaker']], [['ID', refSegment(id)], ['Status', 'ON STAGE'], ['Drawn', 'Dexterity Connect']]),
    tone: 'is-live',
  });
}

function renderSimple(kicker: string, title: string, lead: string, plan: string, extra: Array<HTMLElement | null> = []): void {
  const org = (S.det ?? S.pub)?.org ?? 'Dexterity Design Services';
  frame({ org, kicker, title, body: [h('p', { class: 'lead', role: 'status' }, lead), ...extra], plan, block: S.det || S.pub ? blockFor(facts(), '—') : null });
}

// ------------------------------------------------------------------ joining: the meeting's own script loads now
let roomApi: DexRoomApi | null = null;
function loadRoom(): Promise<DexRoomApi> {
  if (roomApi) return Promise.resolve(roomApi);
  return new Promise((resolve, reject) => {
    const css = h('link', { rel: 'stylesheet', href: ROOM_CSS });
    document.head.append(css);
    const s = h('script', { src: ROOM_JS, defer: true });
    s.onload = () => { roomApi = (window as unknown as { DexRoom?: DexRoomApi }).DexRoom ?? null; if (roomApi) resolve(roomApi); else reject(new Error('no room')); };
    s.onerror = () => reject(new Error('The meeting could not be loaded. Check your connection and try again.'));
    document.head.append(s);
  });
}

async function join(): Promise<void> {
  const f = S.det ?? null;
  const meetingId = f?.id ?? (parsed?.kind === 'id' ? parsed.id : '');
  const pass = SPEAKER ? S.passcode : S.passcode;
  if (!meetingId || !pass) return;
  S.problem = '';
  renderConnecting(false);
  if (!S.local) await startCheck().catch(() => {});
  meterStop?.();
  let api: DexRoomApi;
  try { api = await loadRoom(); } catch (e) { S.problem = (e as Error).message; render(); return; }
  const events: RoomEvents = {
    connecting: (again) => { if (S.view !== 'room') renderConnecting(again); },
    lobby: (info) => { S.lobby = { host: info.host, since: S.lobby.since || Date.now() }; S.view = 'lobby'; S.reconnecting = 0; renderLobby(); say(`You are in the lobby. ${info.host} sees that you are waiting.`); },
    admitted: () => { S.view = 'room'; S.reconnecting = 0; document.getElementById('reconnect')?.remove(); document.body.classList.add('in-room'); document.title = `${f?.title ?? 'Meeting'} · Dexterity Meet`; },
    problem: (message) => { S.problem = message; S.view = 'ready'; render(); },
    reconnecting: (n) => { S.reconnecting = n; showReconnecting(n); },
    ended: (e) => { S.end = e; S.view = 'end'; room = null; document.getElementById('reconnect')?.remove(); document.body.classList.remove('in-room'); for (const t of S.local?.getTracks() ?? []) t.stop(); S.local = null; S.checking = false; void afterMeeting(); },
    demoted: (to) => { store.del(`dex.webinar.speak.${meetingId}`); store.del(passKey(REF)); location.replace(to); },
  };
  room = api.start({ mount: root, meetingId, passcode: pass, name: S.name, local: S.local, micOn: S.micOn, camOn: S.camOn, speaker: S.devices.out, on: events });
}

function renderConnecting(again: boolean): void {
  S.view = 'connecting';
  const f = S.det ? facts() : null;
  frame({
    org: f?.org ?? 'Dexterity Design Services',
    kicker: f ? `Meeting · ${refSegment(f.id)}` : 'Meeting',
    title: again ? 'Reconnecting…' : 'Reaching the office…',
    state: h('div', { class: 'state open' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), h('span', { class: 'label' }, again ? 'Reconnecting' : 'Checking the passcode')),
    body: [h('p', { class: 'lead', role: 'status' }, again ? 'The connection dropped. Trying again; the host may need to let you in once more.' : 'One moment while the office checks your passcode.')],
    plan: 'waiting',
    block: f ? blockFor(f, 'CONNECTING') : null,
  });
}

function renderLobby(): void {
  const f = S.det ? facts() : null;
  const waited = h('b', { class: 'timer', 'aria-hidden': 'true' }, '00:00');
  frame({
    org: f?.org ?? 'Dexterity Design Services',
    kicker: `Lobby · ${f ? refSegment(f.id) : ''}`,
    title: SPEAKER ? 'Going on stage…' : 'The host will let you in',
    state: h('div', { class: 'state wait' }, h('span', { class: 'pip', 'aria-hidden': 'true' }), h('span', { class: 'label' }, 'In the lobby · waiting'), waited),
    body: [
      h('p', { class: 'lead' }, `${S.lobby.host || 'The host'} sees that you are waiting. Your place is held while this page is open: you need not do anything.`),
      h('div', { class: 'lobby-grid' },
        preview(true),
        h('div', { class: 'lobby-side' },
          h('div', { class: 'tools' },
            h('button', { type: 'button', class: `tool${S.micOn ? ' on' : ' off'}`, 'aria-pressed': String(S.micOn), disabled: !S.local?.getAudioTracks().length, onclick: () => { S.micOn = !S.micOn; for (const t of S.local?.getAudioTracks() ?? []) t.enabled = S.micOn; room?.setMic(S.micOn); renderLobby(); } }, icon(S.micOn ? 'mic' : 'mic-off'), h('span', {}, S.micOn ? 'Mic on' : 'Mic off')),
            h('button', { type: 'button', class: 'tool', onclick: () => room?.leave() }, icon('door'), h('span', {}, 'Leave the lobby')),
          ),
          h('p', { class: 'faint small' }, 'Keep this tab open. If you close it, you leave the lobby.'),
        )),
    ],
    plan: 'lobby',
    block: f ? blockFor(f, 'IN THE LOBBY') : null,
  });
  const since = S.lobby.since || Date.now();
  timers.push(setInterval(() => { waited.textContent = elapsed(Date.now() - since); }, 1000));
}

function showReconnecting(n: number): void {
  if (S.view !== 'room') { renderConnecting(true); return; }
  document.getElementById('reconnect')?.remove();
  document.body.append(h('div', { id: 'reconnect', class: 'reconnect', role: 'status' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), h('b', {}, 'Reconnecting…'), h('span', {}, n > 1 ? `Try ${n}. The host may need to let you in again.` : 'The connection dropped. Hold on.')));
}

/** The closing page: time spent, the host's follow-up, and the next time of a repeating meeting. */
async function afterMeeting(): Promise<void> {
  const e = S.end!;
  if (S.passcode && !SPEAKER) { const r = await call<MeetPageDetails>(api('/check'), { passcode: S.passcode }); if (r.status === 200 && r.data?.ok) S.det = r.data; }
  const f = S.det ? facts() : null;
  const spent = e.joinedAt ? e.at - e.joinedAt : 0;
  const stillOn = f && (f.state === 'live' || f.state === 'open');
  const words: Record<EndKind, [string, string]> = {
    left: ['Thanks for joining', e.joinedAt ? 'You left the meeting.' : 'You left the lobby before the host let you in.'],
    ended: ['The meeting has ended', e.reason || 'The host ended the meeting.'],
    refused: ['The host did not let you in', e.reason && !/did not let you in/.test(e.reason) ? e.reason : 'If you think this is a mistake, reply to your invitation.'],
    removed: ['You were taken out of the meeting', 'A host removed you from the meeting.'],
    cancelled: ['This meeting was cancelled', 'There is nothing to join.'],
    passcode: ['The passcode did not work', e.reason || 'Check the invitation, or ask the host for a new link.'],
    limit: ['Too many tries from your network', e.reason || 'Wait a few minutes, then try again.'],
    lost: ['We lost the connection', 'Check your internet connection and join again.'],
    closed: ['You are out of the meeting', e.reason || 'The office closed the connection.'],
  };
  const [title, lead] = words[e.kind];
  const facts2: HTMLElement[] = [];
  if (spent > 0) facts2.push(h('div', {}, h('span', { class: 'label' }, 'Time in the meeting'), h('b', { class: 'mono' }, lengthText(spent))));
  facts2.push(h('div', {}, h('span', { class: 'label' }, e.joinedAt ? 'Left at' : 'At'), h('b', { class: 'mono' }, clock(e.at))));
  const again = (e.kind === 'left' || e.kind === 'lost' || e.kind === 'closed') && stillOn;
  const next = f?.next && f.next.startAt > now() ? f.next : f && f.state === 'upcoming' && f.repeats && f.startAt && f.endAt && f.startAt > now() ? { startAt: f.startAt, endAt: f.endAt } : null;
  frame({
    org: f?.org ?? 'Dexterity Design Services',
    kicker: `End of meeting${f ? ` · ${refSegment(f.id)}` : ''}`,
    title,
    body: [
      h('p', { class: 'lead', role: 'status' }, lead),
      h('div', { class: 'spent' }, ...facts2),
      f?.followUp ? followUp(f) : null,
      next && f ? nextBlock(f, next) : null,
      h('div', { class: 'actions' },
        again ? h('button', { class: 'btn primary', type: 'button', onclick: () => { S.end = null; S.view = 'ready'; render(); void join(); } }, icon('door', 16), 'Join again') : null,
        e.kind === 'passcode' ? h('button', { class: 'btn', type: 'button', onclick: () => { store.del(passKey(REF)); S.passcode = ''; S.det = null; void boot(); } }, 'Enter the passcode') : null,
      ),
      h('p', { class: 'faint small' }, 'You can close this tab.'),
    ],
    plan: e.kind === 'cancelled' ? 'cancelled' : 'over',
    block: f ? blockFor(f, e.kind === 'left' ? 'YOU LEFT' : statusWord(f.state)) : null,
  });
}

// ------------------------------------------------------------------ one render for the page's state
function render(): void {
  meterStop?.();
  switch (S.view) {
    case 'home': renderHome(); break;
    case 'none': renderNone(); break;
    case 'locked': renderLocked(); break;
    case 'ready': renderReady(); break;
    case 'speaker': renderSpeaker(); break;
    case 'lobby': renderLobby(); break;
    case 'connecting': renderConnecting(false); break;
    case 'limit': renderSimple('Wait a moment', 'Too many tries from your network', S.problem, 'none'); break;
    case 'offline': renderSimple('Not reachable', 'The office cannot be reached right now', 'Its meeting service may be restarting. This page tries again by itself every few seconds.', 'none'); break;
    case 'end': void afterMeeting(); break;
    case 'room': break;
    default: break;
  }
}

/** Ask again (a reschedule, a cancellation, the room opening): redraw only when something changed. */
let lastSeen = '';
async function refresh(): Promise<void> {
  if (S.view !== 'ready' && S.view !== 'locked' && S.view !== 'none' && S.view !== 'offline') return;
  const before = S.view;
  await load();
  const seen = JSON.stringify([S.view, S.det && { ...S.det, liveSince: S.det.liveSince }, S.pub, S.passError]);
  if (seen !== lastSeen || before !== S.view) {
    lastSeen = seen;
    // keep what the guest typed (their name, a passcode, an ID), and where they were, across the redraw
    const typed = (document.getElementById('join-name') as HTMLInputElement | null)?.value;
    if (typed !== undefined) S.name = typed;
    const kept = [...document.querySelectorAll<HTMLInputElement>('input[id]')].map((i) => [i.id, i.value] as const);
    const focus = document.activeElement?.id;
    render();
    for (const [id, value] of kept) { const el = document.getElementById(id) as HTMLInputElement | null; if (el && !el.value) el.value = value; }
    if (focus && focus !== 'work') (document.getElementById(focus) as HTMLElement | null)?.focus();
    const f = S.det ?? S.pub;
    if (f && before === S.view) say(f.state === 'live' ? 'The meeting is in progress.' : f.state === 'open' ? 'The room is open. You can ask to join.' : f.state === 'cancelled' ? 'This meeting was cancelled.' : 'The meeting details changed.');
  }
}

async function boot(): Promise<void> {
  const theme = store.local('dex.meet.theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  if (!REF) { S.view = 'home'; render(); return; }
  if (!parsed) { S.view = 'none'; render(); return; }
  if (SPEAKER) { S.view = 'speaker'; render(); return; }
  await load(true);
  lastSeen = JSON.stringify([S.view, S.det, S.pub, S.passError]);
  render();
}

void boot();
// every 15 seconds: a reschedule, a cancellation or the host arriving shows without a reload
setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 15_000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refresh(); });
// the whole link pasted into this tab again (only its #fragment changes, so the page is not reloaded)
window.addEventListener('hashchange', () => {
  const h2 = (() => { try { return decodeURIComponent(location.hash.slice(1)).trim(); } catch { return ''; } })();
  if (!location.hash) return;
  history.replaceState(null, '', location.pathname);
  if (!PASS_RE.test(h2) || S.view === 'room' || S.view === 'lobby' || S.view === 'connecting') return;
  S.passcode = h2;
  store.set(passKey(REF), h2);
  S.passError = '';
  void load().then(render);
});
