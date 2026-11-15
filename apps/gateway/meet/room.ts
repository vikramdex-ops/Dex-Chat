// The meeting itself, for a guest in a browser: everyone's video as tiles with zone captions, a
// shared screen, the meeting chat, a hand to raise and reactions. It is loaded only when the guest
// presses Join on the landing page (landing.ts), which keeps the first load small; the landing page
// keeps the name, the device check, the lobby, reconnecting and the closing page.
// Media goes browser to PC (WebRTC, through the office's TURN relay when needed); the signalling
// goes through the gateway to the office hub. Drawn in the app's drafting-sheet language, in code.
import { MEETING_REACTIONS } from '@dex/core/protocol';
import type { GuestDown, GuestRoomView, GuestSeat, RoomChatLine } from '@dex/core/meet';
import { capName, elapsed, h, icon, initials, tintFor, toast } from './shared.ts';

type Step = 'connecting' | 'lobby' | 'room' | 'ended';
interface Link { pc: RTCPeerConnection; polite: boolean; makingOffer: boolean; ignoreOffer: boolean; senders: RTCRtpSender[]; streams: MediaStream[] }
type Signal = { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit | null };

/** How the meeting ended for this guest: the landing page words its closing page from it. */
export type EndKind = 'left' | 'ended' | 'refused' | 'removed' | 'cancelled' | 'passcode' | 'limit' | 'lost' | 'closed';
export interface RoomEvents {
  connecting(again: boolean): void;
  lobby(info: { host: string; title: string }): void;
  admitted(): void;
  /** Before the guest is in: something to fix (a missing name). */
  problem(message: string): void;
  reconnecting(attempt: number): void;
  ended(e: { kind: EndKind; reason: string; joinedAt: number | null; at: number }): void;
  /** A webinar speaker going back to the audience. */
  demoted(to: string): void;
}
export interface RoomStart {
  mount: HTMLElement;
  meetingId: string;
  passcode: string;
  name: string;
  local: MediaStream | null;
  micOn: boolean;
  camOn: boolean;
  /** The speakers chosen on the device check (setSinkId), or ''. */
  speaker: string;
  on: RoomEvents;
}

let app: HTMLElement = document.body;
let meetingId = '';
let passcode = '';
let on: RoomEvents | null = null;
let speaker = '';

const state = {
  step: 'connecting' as Step,
  name: '',
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
  ended: '',
  endKind: null as EndKind | null,
  notice: '',
  askUnmute: '',
  joinedAt: null as number | null,
  attempts: 0,
};

const zone = (i: number, cols: number) => `${String.fromCharCode(65 + (i % cols))}${Math.floor(i / cols) + 1}`;
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function applyMic(): void {
  for (const t of state.local?.getAudioTracks() ?? []) t.enabled = state.micOn;
}

/** What the hub's words mean for the closing page. */
function kindOf(reason: string, code: number): EndKind {
  if (code === 4403) return 'passcode';
  if (code === 4429) return 'limit';
  if (/took you out/.test(reason)) return 'removed';
  if (/did not let you in|locked/.test(reason)) return 'refused';
  if (/cancelled/.test(reason)) return 'cancelled';
  if (/You left/.test(reason)) return 'left';
  if (/ended|not open yet/.test(reason)) return 'ended';
  return 'closed';
}

// ------------------------------------------------------------------ the connection
let pingTimer: ReturnType<typeof setInterval> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const send = (f: unknown) => { if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(f)); };

function connect(): void {
  const again = state.attempts > 0;
  state.step = 'connecting';
  state.ended = '';
  state.endKind = null;
  on?.connecting(again);
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/m/${meetingId}/ws`);
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
    if (state.step === 'ended') return;
    // told why (the host, the passcode, a limit): final. A dropped line: try again, a few times
    if (state.ended) { finish(state.endKind ?? kindOf(state.ended, e.code), state.ended); return; }
    if (e.code === 4429 || e.code === 4403) { finish(kindOf(e.reason, e.code), e.reason || 'The office refused the connection.'); return; }
    if (state.attempts < 6) {
      state.attempts++;
      const wasIn = state.step === 'room';
      for (const dev of [...state.links.keys()]) dropLink(dev);
      if (wasIn) state.room = null;
      on?.reconnecting(state.attempts);
      retryTimer = setTimeout(connect, Math.min(15_000, 1000 * 2 ** (state.attempts - 1)));
      return;
    }
    finish('lost', e.reason || 'The connection to the meeting was lost.');
  };
}

function onFrame(f: GuestDown): void {
  switch (f.t) {
    case 'lobby':
      state.step = 'lobby';
      state.attempts = 0;
      on?.lobby({ host: f.host, title: f.title });
      break;
    case 'admitted':
      state.self = f.self; state.room = f.room; state.iceServers = f.iceServers as RTCIceServer[]; state.chat = f.chat; state.step = 'room';
      state.attempts = 0;
      state.joinedAt = state.joinedAt ?? Date.now();
      // a camera switched off on the check is not sent: stop it (turning it on later starts it afresh)
      if (!state.camOn) for (const t of state.local?.getVideoTracks() ?? []) { t.stop(); state.local!.removeTrack(t); }
      on?.admitted();
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
      if (/^\/w\/[\w-]+\/watch$/.test(f.to)) {
        state.step = 'ended';
        for (const dev of [...state.links.keys()]) dropLink(dev);
        stopScreen(false);
        for (const t of state.local?.getTracks() ?? []) t.stop();
        on?.demoted(f.to);
      }
      break;
    case 'removed': state.ended = 'A host took you out of the meeting.'; state.endKind = 'removed'; break;
    case 'ended': state.ended = f.reason; finish('ended', f.reason); break;
    case 'error':
      state.notice = f.message;
      if (state.step === 'connecting') { on?.problem(f.message); return; }
      renderBanners();
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

function finish(kind: EndKind, reason: string): void {
  if (state.step === 'ended') return;
  state.step = 'ended';
  state.ended = reason;
  if (retryTimer) clearTimeout(retryTimer);
  for (const dev of [...state.links.keys()]) dropLink(dev);
  stopScreen(false);
  try { state.ws?.close(); } catch { /* closed */ }
  state.ws = null;
  state.room = null;
  roomEls = null;
  if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
  on?.ended({ kind, reason, joinedAt: state.joinedAt, at: Date.now() });
}

/** The guest leaves (the Leave button, or the lobby's): the hub is told, then the closing page. */
function leaveMeeting(): void {
  send({ t: 'leave' });
  finish('left', state.step === 'room' ? 'You left the meeting.' : 'You left the lobby.');
}

// ------------------------------------------------------------------ the meeting
let roomEls: { field: HTMLElement; chat: HTMLElement; controls: HTMLElement; banners: HTMLElement; clock: HTMLElement } | null = null;
let clockTimer: ReturnType<typeof setInterval> | null = null;

function renderRoom(): void {
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
    h('button', { type: 'button', class: 'leave', onclick: () => leaveMeeting() }, 'Leave', icon('door', 16)),
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
  // the speakers chosen on the device check, where the browser lets a page choose
  const sink = (a as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId;
  if (speaker && sink) void sink.call(a, speaker).catch(() => {});
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

function start(o: RoomStart): { leave(): void; setMic(on: boolean): void } {
  app = o.mount; meetingId = o.meetingId; passcode = o.passcode; on = o.on; speaker = o.speaker;
  state.name = o.name; state.local = o.local; state.micOn = o.micOn; state.camOn = o.camOn;
  state.step = 'connecting'; state.attempts = 0; state.joinedAt = null; state.ended = ''; state.endKind = null;
  applyMic();
  connect();
  return { leave: leaveMeeting, setMic: (v: boolean) => { state.micOn = v; applyMic(); announce(); } };
}

(window as unknown as { DexRoom: { start: typeof start } }).DexRoom = { start };
