// The page a guest opens from a meeting invitation: https://<gateway>/m/<meeting ID>#<passcode>.
// Three sheets before the meeting (your name, a camera and mic check, the lobby) and then the
// meeting itself: everyone's video as tiles with zone captions, a shared screen, the meeting chat,
// a hand to raise and reactions. Media goes browser to PC (WebRTC, through the office's TURN
// relay when needed); the signalling goes through this gateway to the office hub. Drawn in the
// app's drafting-sheet language, in code: no images, fonts or libraries are loaded.
import { MEETING_REACTIONS } from '@dex/core/protocol';
import type { GuestDown, GuestRoomView, GuestSeat, RoomChatLine } from '@dex/core/meet';

type Step = 'name' | 'check' | 'connecting' | 'lobby' | 'room' | 'ended';
interface Link { pc: RTCPeerConnection; polite: boolean; makingOffer: boolean; ignoreOffer: boolean; senders: RTCRtpSender[]; streams: MediaStream[] }
type Signal = { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit | null };

const app = document.getElementById('app') as HTMLElement;
const meetingId = app.dataset.meeting ?? '';
const displayId = `${meetingId.slice(0, 3)}-${meetingId.slice(3, 6)}-${meetingId.slice(6)}`;

// the passcode comes in the fragment; it is kept for this tab and taken out of the address bar,
// so it does not show when someone shares their screen
const PASS_KEY = `dex.guest.pass.${meetingId}`;
const NAME_KEY = 'dex.guest.name';
const fromHash = decodeURIComponent(location.hash.slice(1)).trim();
let passcode = /^[A-Za-z0-9]{6,10}$/.test(fromHash) ? fromHash : '';
try {
  if (passcode) sessionStorage.setItem(PASS_KEY, passcode); else passcode = sessionStorage.getItem(PASS_KEY) ?? '';
} catch { /* storage blocked: keep it in memory */ }
if (location.hash) history.replaceState(null, '', location.pathname);
// a webinar attendee the organiser invited to speak comes here from the watch page with a one-time pass
const SPEAKER = (() => { try { return sessionStorage.getItem(`dex.webinar.speak.${meetingId}`) === '1'; } catch { return false; } })();

const state = {
  step: 'name' as Step,
  name: (() => { try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; } })(),
  local: null as MediaStream | null,
  screen: null as MediaStream | null,
  micOn: true,
  camOn: true,
  ws: null as WebSocket | null,
  self: null as { deviceId: string; name: string } | null,
  room: null as GuestRoomView | null,
  iceServers: [] as RTCIceServer[],
  links: new Map<string, Link>(),
  chat: [] as RoomChatLine[],
  chatOpen: window.innerWidth > 900,
  unread: 0,
  hand: false,
  lobbyHost: '',
  lobbyTitle: '',
  lobbySince: 0,
  ended: '',
  notice: '',
  askUnmute: '',
};

// ------------------------------------------------------------------ small DOM helpers
type Kid = Node | string | null | false | undefined;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    // through the CSS object model: the page's CSP allows no style attributes
    else if (k === 'style') for (const decl of String(v).split(';')) { const i = decl.indexOf(':'); if (i > 0) el.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim()); }
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== false && c !== undefined) el.append(c);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Line icons drawn for this page (1.6 px strokes on a 20 px grid). */
const ICONS: Record<string, string> = {
  mic: 'M10 3a2.5 2.5 0 0 1 2.5 2.5v4a2.5 2.5 0 0 1-5 0v-4A2.5 2.5 0 0 1 10 3zM5 9.5a5 5 0 0 0 10 0M10 14.5V17M7 17h6',
  'mic-off': 'M12.5 8.5v1a2.5 2.5 0 0 1-4.2 1.8M7.5 7V5.5a2.5 2.5 0 0 1 4.6-1.4M5 9.5a5 5 0 0 0 8.4 3.6M15 9.5a5 5 0 0 1-.3 1.6M10 14.5V17M7 17h6M3 3l14 14',
  cam: 'M3 6h9a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 12 14H3a1.5 1.5 0 0 1-1.5-1.5v-5A1.5 1.5 0 0 1 3 6zM13.5 9l4-2.5v7l-4-2.5',
  'cam-off': 'M6 6h6a1.5 1.5 0 0 1 1.5 1.5v4M13.5 13.5V12.5M12 14H3a1.5 1.5 0 0 1-1.5-1.5v-5A1.5 1.5 0 0 1 3 6M13.5 9l4-2.5v7l-4-2.5M2 2l16 16',
  screen: 'M2.5 4h15v9h-15zM7 16.5h6M10 13v3.5M7.5 9.5L10 7l2.5 2.5M10 7v4.5',
  hand: 'M7 10.5V5a1.2 1.2 0 0 1 2.4 0v4.5M9.4 9V3.8a1.2 1.2 0 0 1 2.4 0V9M11.8 9V4.8a1.2 1.2 0 0 1 2.4 0v6.7a5.5 5.5 0 0 1-5.5 5.5h-.3a5 5 0 0 1-4-2l-2.2-3a1.2 1.2 0 0 1 1.9-1.5L7 12',
  react: 'M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15zM7 8h.01M13 8h.01M6.8 11.6a4 4 0 0 0 6.4 0',
  chat: 'M3 4h14v9H8l-4 3.5V13H3z M6 7.5h8M6 10h5',
  door: 'M4 17V3h8v14M12 4.5l4 1.5v11l-4-1M9.5 10h.01M2 17h16',
  x: 'M5 5l10 10M15 5L5 15',
};
function icon(name: string, size = 18): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'ico');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', ICONS[name] ?? '');
  svg.append(p);
  return svg;
}

const capName = (n: string) => {
  const parts = n.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return parts.length > 1 ? `${parts[0].toUpperCase()} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0].toUpperCase();
};
const initials = (n: string) => n.trim().split(/\s+/).slice(0, 2).map((x) => x[0]?.toUpperCase() ?? '').join('') || '?';
const zone = (i: number, cols: number) => `${String.fromCharCode(65 + (i % cols))}${Math.floor(i / cols) + 1}`;
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const elapsed = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
/** A tile's colour from the person's device id: stable, in the office's palette. */
const TINTS = ['#2a8c98', '#1e6066', '#4f7a5a', '#6b5b8c', '#8c5a3c', '#3c6e8c', '#7a6a2e', '#5c6f73'];
const tintFor = (id: string) => { let x = 0; for (const c of id) x = (x * 31 + c.charCodeAt(0)) >>> 0; return TINTS[x % TINTS.length]; };

// ------------------------------------------------------------------ the sheet frame
function titleBlock(sheet: string): HTMLElement {
  const cell = (label: string, value: string, cls = '') => h('div', { class: `tb-cell ${cls}` }, h('span', { class: 'tb-label' }, label), h('span', { class: 'tb-value' }, value));
  return h('footer', { class: 'title-block', 'aria-label': 'Meeting details' },
    cell('Meeting', state.lobbyTitle || state.room?.title || '—', 'wide'),
    cell('ID', displayId, 'mono'),
    cell('You', state.name.trim() || '—'),
    cell('Sheet', sheet, 'mono'),
  );
}

function frame(sheet: string, body: HTMLElement): void {
  app.replaceChildren(h('div', { class: 'sheet' },
    h('header', { class: 'sheet-head' }, h('span', { class: 'mark' }, h('i', { 'aria-hidden': 'true' }), 'Dexterity Connect'), h('span', { class: 'mono faint' }, `GUEST · ${displayId}`)),
    h('section', { class: 'sheet-body' }, body),
    titleBlock(sheet),
  ));
}

// ------------------------------------------------------------------ sheet 1: your name
function renderName(): void {
  const input = h('input', { id: 'join-name', class: 'input', maxlength: '60', autocomplete: 'name', placeholder: 'For example, Dana Wright', value: state.name, 'aria-describedby': 'name-help' });
  const next = h('button', { class: 'btn primary', type: 'submit' }, 'Next: camera and mic');
  const form = h('form', { class: 'step', onsubmit: (e: Event) => { e.preventDefault(); const v = input.value.trim(); if (!v) { input.focus(); return; } state.name = v.slice(0, 60); try { localStorage.setItem(NAME_KEY, state.name); } catch { /* private */ } void goCheck(); } },
    h('p', { class: 'label' }, 'Sheet 1 · Who is joining'),
    h('h1', {}, SPEAKER ? 'You are invited to speak' : 'Join the meeting'),
    h('p', { class: 'lead' }, SPEAKER ? 'The organiser asked you onto the stage of the webinar. Everyone watching will see and hear you until the organiser brings you back to the audience.' : 'You are joining as a guest from your browser. Nothing to install. The host lets you in from the lobby.'),
    h('label', { class: 'field-label', for: 'join-name' }, 'Your name'),
    input,
    h('p', { id: 'name-help', class: 'faint small' }, 'Everyone in the meeting sees this name.'),
    !passcode ? h('p', { class: 'problem', role: 'alert' }, 'This link has no passcode. Open the whole link from your invitation (it ends with # and the passcode).') : null,
    h('div', { class: 'actions' }, next),
  );
  frame('1 OF 3', form);
  if (!passcode) next.setAttribute('disabled', '');
  input.focus();
}

// ------------------------------------------------------------------ sheet 2: camera and mic
let meterStop: (() => void) | null = null;

async function getMedia(): Promise<MediaStream | null> {
  const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  try { return await navigator.mediaDevices.getUserMedia({ audio, video: { width: { ideal: 1280 }, height: { ideal: 720 } } }); } catch { /* try sound only */ }
  try { return await navigator.mediaDevices.getUserMedia({ audio }); } catch { return null; }
}

async function goCheck(): Promise<void> {
  state.step = 'check';
  if (!state.local) state.local = await getMedia();
  state.camOn = !!state.local?.getVideoTracks().length;
  state.micOn = !!state.local?.getAudioTracks().length;
  renderCheck();
}

function preview(): HTMLElement {
  const v = h('video', { autoplay: true, playsinline: true, muted: true, class: 'mirror' }) as HTMLVideoElement;
  v.muted = true;
  const cam = state.local?.getVideoTracks()[0];
  const box = h('div', { class: `preview${cam && state.camOn ? ' live' : ''}` },
    cam && state.camOn ? v : h('span', { class: 'face', style: `--tint:${tintFor(state.name)}` }, initials(state.name)),
    h('span', { class: 'cap' }, h('b', {}, 'A1'), h('span', {}, 'YOU · PREVIEW')),
  );
  if (cam && state.camOn) { v.srcObject = state.local; void v.play().catch(() => {}); }
  return box;
}

/** The mic level as a ruled scale: twenty ticks, lit as you speak. */
function meter(): HTMLElement {
  const ticks = Array.from({ length: 20 }, (_, i) => h('i', { class: i % 5 === 4 ? 'major' : '' }));
  const el = h('div', { class: 'meter', role: 'meter', 'aria-label': 'Microphone level', 'aria-valuemin': '0', 'aria-valuemax': '20' }, ...ticks);
  meterStop?.();
  const track = state.local?.getAudioTracks()[0];
  if (!track) return el;
  const ctx = new AudioContext();
  const an = ctx.createAnalyser();
  an.fftSize = 512;
  ctx.createMediaStreamSource(new MediaStream([track])).connect(an);
  const buf = new Uint8Array(an.fftSize);
  const t = setInterval(() => {
    an.getByteTimeDomainData(buf);
    let sum = 0;
    for (const b of buf) { const x = (b - 128) / 128; sum += x * x; }
    const lit = state.micOn ? Math.min(20, Math.round(Math.sqrt(sum / buf.length) * 90)) : 0;
    el.setAttribute('aria-valuenow', String(lit));
    ticks.forEach((tk, i) => tk.classList.toggle('on', i < lit));
  }, 100);
  meterStop = () => { clearInterval(t); void ctx.close(); meterStop = null; };
  return el;
}

function renderCheck(): void {
  const hasCam = !!state.local?.getVideoTracks().length;
  const hasMic = !!state.local?.getAudioTracks().length;
  const toggle = (on: boolean, label: string, ico: string, icoOff: string, f: () => void, disabled: boolean) =>
    h('button', { type: 'button', class: `tool${on ? ' on' : ' off'}`, 'aria-pressed': String(on), onclick: f, disabled }, icon(on ? ico : icoOff), h('span', {}, label));
  const body = h('div', { class: 'step check' },
    h('p', { class: 'label' }, 'Sheet 2 · Camera and microphone'),
    h('h1', {}, 'Check how you look and sound'),
    h('div', { class: 'check-grid' },
      preview(),
      h('div', { class: 'check-side' },
        h('span', { class: 'field-label' }, 'Microphone'),
        meter(),
        h('p', { class: 'faint small' }, hasMic ? 'Say something: the scale moves when the meeting can hear you.' : 'No microphone could be used. You can still listen and chat.'),
        h('div', { class: 'tools' },
          toggle(state.micOn && hasMic, state.micOn && hasMic ? 'Mic on' : 'Mic off', 'mic', 'mic-off', () => { state.micOn = !state.micOn; applyMic(); renderCheck(); }, !hasMic),
          toggle(state.camOn && hasCam, state.camOn && hasCam ? 'Camera on' : 'Camera off', 'cam', 'cam-off', () => { state.camOn = !state.camOn; for (const t of state.local?.getVideoTracks() ?? []) t.enabled = state.camOn; renderCheck(); }, !hasCam),
        ),
        !hasCam ? h('p', { class: 'faint small' }, 'No camera could be used: you join with your name on a tile.') : null,
      ),
    ),
    h('p', { class: 'faint small' }, SPEAKER ? 'You are seen and heard as soon as you go on stage.' : 'Nothing is sent until the host lets you in.'),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn ghost', onclick: () => { meterStop?.(); state.step = 'name'; renderName(); } }, 'Back'),
      h('button', { type: 'button', class: 'btn primary', onclick: () => connect() }, SPEAKER ? 'Go on stage' : 'Ask to join'),
    ),
  );
  frame('2 OF 3', body);
}

function applyMic(): void {
  for (const t of state.local?.getAudioTracks() ?? []) t.enabled = state.micOn;
}

// ------------------------------------------------------------------ the connection
let pingTimer: ReturnType<typeof setInterval> | null = null;
const send = (f: unknown) => { if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(f)); };

function connect(): void {
  meterStop?.();
  state.step = 'connecting';
  state.ended = '';
  renderLobby();
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/m/${meetingId}/ws`);
  state.ws = ws;
  ws.onopen = () => {
    send({ t: 'join', name: state.name, passcode });
    pingTimer = setInterval(() => send({ t: 'ping' }), 25_000);
  };
  ws.onmessage = (e) => { try { onFrame(JSON.parse(String(e.data)) as GuestDown); } catch { /* not ours */ } };
  ws.onclose = (e) => {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    if (state.ws !== ws) return;
    state.ws = null;
    if (state.step !== 'ended') finish(state.ended || e.reason || (state.step === 'room' ? 'The connection to the meeting was lost.' : 'The office could not be reached. Try again in a moment.'), true);
  };
}

function onFrame(f: GuestDown): void {
  switch (f.t) {
    case 'lobby':
      state.step = 'lobby'; state.lobbyHost = f.host; state.lobbyTitle = f.title; state.lobbySince = Date.now();
      renderLobby();
      break;
    case 'admitted':
      state.self = f.self; state.room = f.room; state.iceServers = f.iceServers as RTCIceServer[]; state.chat = f.chat; state.step = 'room';
      // a camera switched off on the check sheet is not sent: stop it (turning it on later starts it afresh)
      if (!state.camOn) for (const t of state.local?.getVideoTracks() ?? []) { t.stop(); state.local!.removeTrack(t); }
      renderRoom();
      announce();
      // the newcomer reaches out to everyone already there
      for (const s of f.room.seats) if (s.deviceId !== f.self.deviceId) ensureLink(s.deviceId);
      break;
    case 'room': setRoom(f.room, false); break;
    case 'moved': setRoom(f.room, true); break;
    case 'signal': void onSignal(f.from, f.data as Signal); break;
    case 'chat':
      state.chat.push(f.line);
      if (state.chat.length > 300) state.chat.shift();
      if (!state.chatOpen && f.line.name !== state.self?.name) state.unread++;
      renderChat(); renderControls();
      break;
    case 'reaction': floatReaction(f.deviceId, f.emoji); break;
    case 'muted':
      state.micOn = false; applyMic(); announce();
      state.notice = `${f.by} muted you`; renderControls(); renderBanners();
      break;
    case 'unmuteAsk': state.askUnmute = f.by; renderBanners(); break;
    case 'denied': state.ended = f.reason; break;
    case 'demoted':
      // a webinar speaker goes back to the audience: the watch page (it kept their personal link)
      if (/^\/w\/\d{9}\/watch$/.test(f.to)) {
        state.step = 'ended';
        for (const dev of [...state.links.keys()]) dropLink(dev);
        stopScreen(false);
        for (const t of state.local?.getTracks() ?? []) t.stop();
        try { sessionStorage.removeItem(`dex.webinar.speak.${meetingId}`); sessionStorage.removeItem(PASS_KEY); } catch { /* private */ }
        location.replace(f.to);
      }
      break;
    case 'removed': state.ended = 'A host took you out of the meeting.'; break;
    case 'ended': state.ended = f.reason; finish(f.reason, false); break;
    case 'error':
      state.notice = f.message; renderBanners();
      if (state.step === 'connecting' || state.step === 'check') { state.step = 'check'; renderCheck(); toast(f.message); }
      break;
  }
}

function announce(): void {
  send({ t: 'media', muted: !state.micOn, camera: !!state.local?.getVideoTracks().some((t) => t.readyState === 'live') && state.camOn, screen: !!state.screen });
}

function setRoom(room: GuestRoomView, moved: boolean): void {
  if (moved) {
    // another room of the meeting (a breakout, or back): new links with the people there
    for (const dev of [...state.links.keys()]) dropLink(dev);
    state.room = room;
    renderRoom();
    for (const s of room.seats) if (s.deviceId !== state.self?.deviceId) ensureLink(s.deviceId);
    return;
  }
  const before = state.room;
  state.room = room;
  for (const dev of [...state.links.keys()]) if (!room.seats.some((s) => s.deviceId === dev)) dropLink(dev);
  state.hand = room.seats.some((s) => s.deviceId === state.self?.deviceId && s.hand > 0);
  if (!before || before.breakout !== room.breakout) renderRoom();
  else { renderField(); renderControls(); renderBanners(); }
}

function finish(reason: string, canRetry: boolean): void {
  state.step = 'ended';
  state.ended = reason;
  for (const dev of [...state.links.keys()]) dropLink(dev);
  stopScreen(false);
  meterStop?.();
  try { state.ws?.close(); } catch { /* closed */ }
  state.ws = null;
  state.room = null;
  const body = h('div', { class: 'step ended' },
    h('p', { class: 'label' }, 'End of sheet'),
    h('h1', {}, 'You are out of the meeting'),
    h('p', { class: 'lead', role: 'status' }, reason),
    h('div', { class: 'actions' },
      canRetry && passcode ? h('button', { class: 'btn primary', onclick: () => { void goCheck(); } }, 'Join again') : null,
    ),
  );
  frame('—', body);
  if (!canRetry) { for (const t of state.local?.getTracks() ?? []) t.stop(); state.local = null; }
}

// ------------------------------------------------------------------ sheet 3: the lobby
let lobbyTimer: ReturnType<typeof setInterval> | null = null;
function renderLobby(): void {
  if (lobbyTimer) clearInterval(lobbyTimer);
  const waiting = h('span', { class: 'mono wait-clock' }, '00:00');
  const body = h('div', { class: 'step lobby' },
    h('p', { class: 'label' }, 'Sheet 3 · The lobby'),
    h('h1', {}, state.step === 'connecting' ? 'Reaching the office…' : `Waiting for ${state.lobbyHost} to let you in`),
    h('div', { class: 'lobby-grid' },
      preview(),
      h('div', { class: 'lobby-side' },
        h('div', { class: 'lobby-wait', role: 'status' }, h('span', { class: 'pulse', 'aria-hidden': 'true' }), h('span', { class: 'mono' }, state.step === 'connecting' ? 'CONNECTING' : 'IN THE LOBBY'), waiting),
        h('p', { class: 'lead' }, state.step === 'connecting' ? 'Checking the passcode with the office.' : `${state.lobbyTitle || 'The meeting'} · the host sees that you are waiting. Keep this page open.`),
        h('div', { class: 'tools' },
          h('button', { type: 'button', class: `tool${state.micOn ? ' on' : ' off'}`, 'aria-pressed': String(state.micOn), disabled: !state.local?.getAudioTracks().length, onclick: () => { state.micOn = !state.micOn; applyMic(); renderLobby(); } }, icon(state.micOn ? 'mic' : 'mic-off'), h('span', {}, state.micOn ? 'Mic on' : 'Mic off')),
          h('button', { type: 'button', class: 'tool', onclick: () => { send({ t: 'leave' }); finish('You left the lobby.', true); } }, icon('door'), h('span', {}, 'Leave')),
        ),
      ),
    ),
  );
  frame('3 OF 3', body);
  const since = state.lobbySince || Date.now();
  lobbyTimer = setInterval(() => { if (state.step !== 'lobby' && state.step !== 'connecting') { clearInterval(lobbyTimer!); lobbyTimer = null; return; } waiting.textContent = elapsed(Date.now() - since); }, 1000);
}

// ------------------------------------------------------------------ the meeting
let roomEls: { field: HTMLElement; chat: HTMLElement; controls: HTMLElement; banners: HTMLElement; clock: HTMLElement } | null = null;
let clockTimer: ReturnType<typeof setInterval> | null = null;

function renderRoom(): void {
  if (lobbyTimer) { clearInterval(lobbyTimer); lobbyTimer = null; }
  const room = state.room!;
  const field = h('section', { class: 'field', 'aria-label': 'People in the meeting' });
  const chat = h('aside', { class: 'chat', 'aria-label': 'Meeting chat' });
  const controls = h('div', { class: 'controls', role: 'toolbar', 'aria-label': 'Your controls' });
  const banners = h('div', { class: 'banners' });
  const clockEl = h('span', { class: 'mono big' }, elapsed(Date.now() - room.startedAt));
  const block = h('footer', { class: 'room-block' },
    h('div', { class: 'rb-name' }, h('span', { class: 'tb-label' }, room.breakout ? 'Breakout' : 'Meeting'), h('h2', {}, room.breakout ?? room.title), h('span', { class: 'mono faint' }, `ID ${room.meetingId}`)),
    h('div', { class: 'rb-facts' }, h('div', {}, h('span', { class: 'tb-label' }, 'Time'), clockEl), h('div', {}, h('span', { class: 'tb-label' }, 'Opened'), h('span', { class: 'mono' }, clock(room.startedAt)))),
    controls,
  );
  app.replaceChildren(h('div', { class: `room${state.chatOpen ? ' chat-open' : ''}` }, banners, field, chat, block));
  roomEls = { field, chat, controls, banners, clock: clockEl };
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = setInterval(() => {
    if (!roomEls || !state.room) { clearInterval(clockTimer!); clockTimer = null; return; }
    roomEls.clock.textContent = elapsed(Date.now() - state.room.startedAt);
    if (state.room.returningAt) renderBanners();
  }, 1000);
  renderField(); renderChat(); renderControls(); renderBanners();
}

/** Tiles for everyone; a shared screen takes the sheet and people go in a strip. */
const tileEls = new Map<string, HTMLElement>();
function renderField(): void {
  if (!roomEls || !state.room || !state.self) return;
  const seats = [...state.room.seats].sort((a, b) => Number(b.deviceId === state.self!.deviceId) - Number(a.deviceId === state.self!.deviceId));
  const shareFrom = state.screen ? state.self.deviceId : seats.find((s) => s.screen && s.deviceId !== state.self!.deviceId && screenStream(s.deviceId))?.deviceId ?? null;
  const cols = shareFrom ? Math.max(1, seats.length) : seats.length <= 1 ? 1 : seats.length <= 4 ? 2 : seats.length <= 9 ? 3 : 4;
  const keep = new Set(seats.map((s) => s.deviceId));
  for (const [dev, el] of tileEls) if (!keep.has(dev)) { el.remove(); tileEls.delete(dev); }
  const grid = h('div', { class: `grid${shareFrom ? ' strip' : ''}`, style: `--cols:${cols}` });
  seats.forEach((s, i) => grid.append(tile(s, zone(i, cols))));
  const parts: HTMLElement[] = [];
  if (shareFrom) {
    const stream = shareFrom === state.self.deviceId ? state.screen : screenStream(shareFrom);
    const v = h('video', { autoplay: true, playsinline: true, muted: true }) as HTMLVideoElement;
    v.muted = true;
    v.srcObject = stream;
    void v.play().catch(() => {});
    const who = shareFrom === state.self.deviceId ? 'YOUR SCREEN · SHARED' : `${capName(seats.find((s) => s.deviceId === shareFrom)?.name ?? '')} · SCREEN`;
    parts.push(h('figure', { class: 'share' }, v, h('figcaption', { class: 'cap' }, h('b', {}, 'SHEET'), h('span', {}, who))));
  }
  roomEls.field.classList.toggle('sharing', !!shareFrom);
  roomEls.field.replaceChildren(...parts, grid);
}

function screenStream(deviceId: string): MediaStream | null {
  const l = state.links.get(deviceId);
  return l?.streams.find((x, i) => i > 0 && x.getVideoTracks().length) ?? null;
}

function tile(s: GuestSeat, zoneRef: string): HTMLElement {
  const me = s.deviceId === state.self!.deviceId;
  const stream = me ? state.local : state.links.get(s.deviceId)?.streams[0] ?? null;
  const camLive = me ? state.camOn && !!state.local?.getVideoTracks().length : s.camera && !!stream?.getVideoTracks().length;
  let el = tileEls.get(s.deviceId);
  if (!el) { el = h('div', { class: 'tile', 'data-device': s.deviceId }); tileEls.set(s.deviceId, el); }
  el.style.setProperty('--tint', tintFor(s.deviceId));
  el.classList.toggle('has-video', camLive);
  el.classList.toggle('hand-up', s.hand > 0);
  el.setAttribute('aria-label', `${zoneRef} · ${me ? 'You' : s.name}${s.muted ? ' · mic off' : ''}${s.hand ? ` · hand raised (${s.hand})` : ''}`);
  // keep the video element (and its playback) when only the caption changes
  let v = el.querySelector('video');
  if (camLive && stream) {
    if (!v) { v = h('video', { autoplay: true, playsinline: true, muted: true }) as HTMLVideoElement; v.muted = true; }
    if (v.srcObject !== stream) { v.srcObject = stream; void v.play().catch(() => {}); }
    v.classList.toggle('mirror', me);
  } else v = null;
  const face = h('div', { class: 'face-box' }, v ?? h('span', { class: 'face' }, initials(s.name)));
  const cap = h('span', { class: 'cap' }, h('b', {}, zoneRef), h('span', {}, me ? 'YOU' : capName(s.name)), s.muted ? icon('mic-off', 12) : null);
  const tags = h('span', { class: 'tags' },
    s.hand ? h('span', { class: 'hand', title: `Hand raised, number ${s.hand} in line` }, icon('hand', 12), String(s.hand)) : null,
    s.host ? h('span', { class: 'flag' }, 'HOST') : null,
    s.guest && !me ? h('span', { class: 'flag' }, 'GUEST') : null,
  );
  const reacts = el.querySelector('.reacts') ?? h('div', { class: 'reacts', 'aria-hidden': 'true' });
  el.replaceChildren(face, cap, tags, reacts);
  return el;
}

function floatReaction(deviceId: string, emoji: string): void {
  const el = tileEls.get(deviceId)?.querySelector('.reacts');
  if (!el) return;
  const tag = h('span', { style: `left:${15 + Math.floor(Math.random() * 60)}%` }, h('b', {}, emoji));
  el.append(tag);
  setTimeout(() => tag.remove(), 2400);
}

// ------------------------------------------------------------------ controls
let reactMenu: HTMLElement | null = null;
function renderControls(): void {
  if (!roomEls) return;
  const hasMic = !!state.local?.getAudioTracks().length;
  const hasCam = !!state.local?.getVideoTracks().length;
  const tool = (on: boolean | null, label: string, ico: string, f: () => void, extra: Record<string, unknown> = {}) =>
    h('button', { type: 'button', class: `tool${on === true ? ' on' : on === false ? ' off' : ''}`, 'aria-pressed': on === null ? undefined : String(on), onclick: f, ...extra }, icon(ico), h('span', {}, label));
  const canShare = typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  roomEls.controls.replaceChildren(...[
    tool(state.micOn && hasMic, state.micOn && hasMic ? 'Mic on' : 'Mic off', state.micOn && hasMic ? 'mic' : 'mic-off', () => { state.micOn = !state.micOn; state.askUnmute = ''; applyMic(); announce(); renderControls(); renderField(); renderBanners(); }, { disabled: !hasMic }),
    tool(state.camOn && hasCam, state.camOn && hasCam ? 'Camera on' : 'Camera off', state.camOn && hasCam ? 'cam' : 'cam-off', () => void toggleCamera()),
    canShare ? tool(!!state.screen, state.screen ? 'Stop sharing' : 'Share screen', 'screen', () => void toggleScreen()) : null,
    tool(state.hand, state.hand ? 'Hand up' : 'Raise hand', 'hand', () => { state.hand = !state.hand; send({ t: 'hand', up: state.hand }); renderControls(); }, { class: `tool${state.hand ? ' hand' : ''}` }),
    tool(null, 'React', 'react', (e?: unknown) => openReact((e as MouseEvent | undefined)?.currentTarget as HTMLElement | undefined), { 'aria-haspopup': 'menu' }),
    tool(state.chatOpen, state.unread ? `Chat · ${state.unread}` : 'Chat', 'chat', () => { state.chatOpen = !state.chatOpen; state.unread = 0; app.querySelector('.room')?.classList.toggle('chat-open', state.chatOpen); renderControls(); renderChat(); }),
    h('button', { type: 'button', class: 'leave', onclick: () => { send({ t: 'leave' }); finish('You left the meeting.', true); } }, 'Leave', icon('door', 16)),
  ].filter((x): x is HTMLButtonElement => !!x));
}

function openReact(anchor?: HTMLElement): void {
  reactMenu?.remove();
  const at = anchor ?? roomEls?.controls;
  const menu = h('div', { class: 'react-menu', role: 'menu', 'aria-label': 'Reactions' },
    h('span', { class: 'tb-label' }, 'React · everyone sees it'),
    h('div', { class: 'react-row' }, ...MEETING_REACTIONS.map((e) => h('button', { type: 'button', role: 'menuitem', 'aria-label': `React ${e}`, onclick: () => { send({ t: 'react', emoji: e }); reactMenu?.remove(); reactMenu = null; } }, e))),
  );
  document.body.append(menu);
  const r = at?.getBoundingClientRect();
  if (r) { menu.style.left = `${Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, r.left))}px`; menu.style.top = `${Math.max(8, r.top - menu.offsetHeight - 8)}px`; }
  reactMenu = menu;
  setTimeout(() => document.addEventListener('pointerdown', function off(e) { if (!menu.contains(e.target as Node)) { menu.remove(); if (reactMenu === menu) reactMenu = null; document.removeEventListener('pointerdown', off); } }), 0);
}

async function toggleCamera(): Promise<void> {
  const local = state.local ?? new MediaStream();
  state.local = local;
  if (state.camOn && local.getVideoTracks().length) {
    for (const t of local.getVideoTracks()) {
      t.stop();
      local.removeTrack(t);
      for (const l of state.links.values()) for (const sd of l.senders.filter((x) => x.track === t)) { l.pc.removeTrack(sd); l.senders = l.senders.filter((x) => x !== sd); }
    }
    state.camOn = false;
  } else {
    try {
      const cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
      const t = cam.getVideoTracks()[0];
      local.addTrack(t);
      for (const l of state.links.values()) l.senders.push(l.pc.addTrack(t, local));
      state.camOn = true;
    } catch { toast('The camera could not be started.'); }
  }
  announce(); renderControls(); renderField();
}

async function toggleScreen(): Promise<void> {
  if (state.screen) { stopScreen(true); return; }
  try {
    const screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15 } }, audio: false });
    const t = screen.getVideoTracks()[0];
    t.contentHint = 'detail';
    t.onended = () => stopScreen(true);
    for (const l of state.links.values()) for (const tr of screen.getTracks()) l.senders.push(l.pc.addTrack(tr, screen));
    state.screen = screen;
    announce(); renderControls(); renderField();
  } catch { /* the guest cancelled the picker */ }
}

function stopScreen(tell: boolean): void {
  const screen = state.screen;
  if (!screen) return;
  for (const t of screen.getTracks()) {
    t.stop();
    for (const l of state.links.values()) for (const sd of l.senders.filter((x) => x.track === t)) { l.pc.removeTrack(sd); l.senders = l.senders.filter((x) => x !== sd); }
  }
  state.screen = null;
  if (tell) { announce(); renderControls(); renderField(); }
}

// ------------------------------------------------------------------ banners: breakouts, notes, the host
function renderBanners(): void {
  if (!roomEls || !state.room) return;
  const r = state.room;
  const out: HTMLElement[] = [];
  if (r.returningAt) {
    const left = Math.max(0, Math.ceil((r.returningAt - Date.now()) / 1000));
    out.push(h('div', { class: 'banner amber', role: 'status' }, h('span', { class: 'mono' }, `BACK TO THE MAIN ROOM IN ${elapsed(left * 1000)}`), h('span', {}, 'The host is calling everyone back.')));
  }
  if (r.breakout && !r.returningAt) out.push(h('div', { class: 'banner', role: 'status' }, h('span', { class: 'mono' }, r.breakout.toUpperCase()), h('span', {}, 'You are in a breakout room. The meeting chat is still shared.')));
  if (r.note) out.push(h('div', { class: 'banner', role: 'status' }, h('span', { class: 'mono' }, `NOTE · ${clock(r.note.at)}`), h('span', {}, r.note.text)));
  if (state.askUnmute && !state.micOn) {
    out.push(h('div', { class: 'banner amber', role: 'alertdialog' }, h('span', {}, `${state.askUnmute} asks you to turn your mic on`),
      h('button', { class: 'btn sm primary', onclick: () => { state.micOn = true; state.askUnmute = ''; applyMic(); announce(); renderControls(); renderBanners(); } }, 'Turn mic on'),
      h('button', { class: 'btn sm ghost', onclick: () => { state.askUnmute = ''; renderBanners(); } }, 'Stay muted')));
  }
  if (state.notice) {
    const n = state.notice;
    out.push(h('div', { class: 'banner', role: 'status' }, h('span', {}, n), h('button', { class: 'icon-btn', 'aria-label': 'Dismiss', onclick: () => { state.notice = ''; renderBanners(); } }, icon('x', 14))));
  }
  roomEls.banners.replaceChildren(...out);
}

// ------------------------------------------------------------------ the meeting chat
function renderChat(): void {
  if (!roomEls) return;
  const list = h('div', { class: 'chat-list', 'aria-live': 'polite' });
  if (!state.chat.length) list.append(h('p', { class: 'faint small empty' }, 'Nothing said yet. Everyone in the meeting reads this chat; it is not kept after the meeting.'));
  let prev: RoomChatLine | null = null;
  for (const l of state.chat) {
    const run = prev && prev.name === l.name && l.at - prev.at < 5 * 60_000;
    const mine = l.guest && l.name === state.self?.name;
    list.append(h('div', { class: `line${run ? ' run' : ''}${mine ? ' mine' : ''}` },
      run ? null : h('div', { class: 'line-head' }, h('span', { class: 'mono' }, mine ? 'YOU' : capName(l.name)), l.guest && !mine ? h('span', { class: 'flag' }, 'GUEST') : null, h('span', { class: 'mono faint' }, clock(l.at))),
      h('div', { class: 'line-body' }, l.text)));
    prev = l;
  }
  const input = h('textarea', { class: 'input', rows: '1', maxlength: '2000', placeholder: 'Message everyone', 'aria-label': 'Message to the meeting' }) as HTMLTextAreaElement;
  const submit = () => { const t = input.value.trim(); if (!t) return; send({ t: 'chat', text: t }); input.value = ''; };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
  roomEls.chat.replaceChildren(
    h('div', { class: 'chat-head' }, h('span', { class: 'tb-label' }, 'Meeting chat'), h('button', { class: 'icon-btn', 'aria-label': 'Close the chat', onclick: () => { state.chatOpen = false; app.querySelector('.room')?.classList.remove('chat-open'); renderControls(); } }, icon('x', 14))),
    list,
    h('form', { class: 'compose', onsubmit: (e: Event) => { e.preventDefault(); submit(); } }, input, h('button', { class: 'btn primary sm', type: 'submit' }, 'Send')),
  );
  list.scrollTop = list.scrollHeight;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(text: string): void {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(t);
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 5000);
}

// ------------------------------------------------------------------ peer connections (as the app does them)
function signal(to: string, data: Signal): void { send({ t: 'signal', to, data }); }

function ensureLink(deviceId: string): Link {
  const existing = state.links.get(deviceId);
  if (existing) return existing;
  const pc = new RTCPeerConnection({ iceServers: state.iceServers, bundlePolicy: 'max-bundle' });
  const link: Link = { pc, polite: (state.self?.deviceId ?? '') > deviceId, makingOffer: false, ignoreOffer: false, senders: [], streams: [] };
  state.links.set(deviceId, link);
  const local = state.local;
  if (local) for (const t of local.getTracks()) if (t.kind === 'audio' || state.camOn) link.senders.push(pc.addTrack(t, local));
  if (state.screen) for (const t of state.screen.getTracks()) link.senders.push(pc.addTrack(t, state.screen));
  pc.onicecandidate = (e) => signal(deviceId, { candidate: e.candidate ? e.candidate.toJSON() : null });
  pc.onnegotiationneeded = async () => {
    try {
      link.makingOffer = true;
      await pc.setLocalDescription();
      signal(deviceId, { description: pc.localDescription!.toJSON() });
    } catch { /* retried on the next negotiation */ } finally { link.makingOffer = false; }
  };
  pc.ontrack = (e) => {
    const stream = e.streams[0] ?? new MediaStream([e.track]);
    if (!link.streams.some((s) => s.id === stream.id)) {
      link.streams.push(stream);
      stream.onremovetrack = () => { if (!stream.getTracks().length) link.streams = link.streams.filter((x) => x !== stream); renderField(); };
      stream.onaddtrack = () => renderField();
    }
    if (e.track.kind === 'audio') playAudio(deviceId, stream);
    e.track.onunmute = () => renderField();
    renderField();
  };
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') pc.restartIce(); };
  return link;
}

const audioEls = new Map<string, HTMLAudioElement>();
function playAudio(deviceId: string, stream: MediaStream): void {
  const key = `${deviceId}:${stream.id}`;
  if (audioEls.has(key)) return;
  const a = h('audio', { autoplay: true }) as HTMLAudioElement;
  a.srcObject = stream;
  a.hidden = true;
  document.body.append(a);
  void a.play().catch(() => {});
  audioEls.set(key, a);
}

async function onSignal(from: string, data: Signal): Promise<void> {
  const link = ensureLink(from);
  const pc = link.pc;
  try {
    if (data.description) {
      const collision = data.description.type === 'offer' && (link.makingOffer || pc.signalingState !== 'stable');
      link.ignoreOffer = !link.polite && collision;
      if (link.ignoreOffer) return;
      await pc.setRemoteDescription(data.description);
      if (data.description.type === 'offer') {
        await pc.setLocalDescription();
        signal(from, { description: pc.localDescription!.toJSON() });
      }
    } else if (data.candidate !== undefined) {
      try { await pc.addIceCandidate(data.candidate ?? undefined); } catch (err) { if (!link.ignoreOffer) throw err; }
    }
  } catch { /* a broken negotiation recovers on the next offer */ }
}

function dropLink(deviceId: string): void {
  const l = state.links.get(deviceId);
  if (!l) return;
  l.pc.close();
  state.links.delete(deviceId);
  for (const [k, a] of audioEls) if (k.startsWith(`${deviceId}:`)) { a.srcObject = null; a.remove(); audioEls.delete(k); }
  tileEls.get(deviceId)?.remove();
  tileEls.delete(deviceId);
}

window.addEventListener('pagehide', () => { if (state.ws) send({ t: 'leave' }); });

// ------------------------------------------------------------------ start
if (!/^[1-9]\d{8}$/.test(meetingId)) {
  frame('—', h('div', { class: 'step' }, h('h1', {}, 'This is not a meeting link'), h('p', { class: 'lead' }, 'Open the link from your invitation again.')));
} else renderName();
