// The meeting itself, for a guest in a browser: everyone's video as tiles with zone captions, a
// shared screen, the meeting chat, a hand to raise and reactions. It is loaded only when the guest
// presses Join on the landing page (landing.ts), which keeps the first load small; the landing page
// keeps the name, the device check, the lobby, reconnecting and the closing page.
// Media goes browser to PC (WebRTC, through the office's TURN relay when needed); the signalling
// goes through the gateway to the office hub. Drawn in the app's drafting-sheet language, in code.
import { MEETING_REACTIONS } from '@dex/core/protocol';
import { GUEST_FILE_CHUNK, GUEST_FILE_MAX } from '@dex/core/meet';
import type { GuestDown, GuestRoomView, GuestSeat, RoomChatLine } from '@dex/core/meet';
import { autoGrow, enterAction } from '@dex/core/compose';
import { InputBatcher, KEYS, domButton, fromPicture, wheelNotches } from '@dex/core/assist';
import type { InputEvent, MouseButton } from '@dex/core/assist';
import { BROWSER_VIEW_ONLY } from '@dex/core/meet-control';
import { capName, elapsed, h, icon, initials, tintFor, toast } from './shared.ts';

type Step = 'connecting' | 'lobby' | 'room' | 'ended';
interface Link { pc: RTCPeerConnection; polite: boolean; makingOffer: boolean; ignoreOffer: boolean; senders: RTCRtpSender[]; streams: MediaStream[] }
type Signal = { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit | null };

/** How the meeting ended for this guest: the landing page words its closing page from it. */
export type EndKind = 'left' | 'ended' | 'refused' | 'removed' | 'cancelled' | 'passcode' | 'limit' | 'lost' | 'closed';
export interface RoomEvents {
  connecting(again: boolean): void;
  /** `hostIn`: a host is in the meeting now; false: they have been told and let you in from wherever they are. */
  lobby(info: { host: string; title: string; hostIn: boolean }): void;
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
  /** A file going to the meeting chat: its name and how much has gone. */
  sending: null as { id: string; name: string; sent: number; size: number } | null,
  /** Asked the person sharing for control, waiting for their answer. */
  asked: false,
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
  ws.onmessage = (e) => {
    let f: GuestDown;
    try { f = JSON.parse(String(e.data)) as GuestDown; } catch { return; /* not ours */ }
    try { onFrame(f); } catch (err) { console.error('meeting frame', f.t, err); }
  };
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
      on?.lobby({ host: f.host, title: f.title, hostIn: f.hostIn !== false });
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
    case 'fileDone':
      if (state.sending?.id === f.id) state.sending = null;
      if (!f.ok) toast(f.reason ?? 'The file could not be shared.');
      renderChat();
      break;
    case 'chat':
      state.chat.push(f.line);
      if (state.chat.length > 300) state.chat.shift();
      if (!state.chatOpen && f.line.name !== state.self?.name) state.unread++;
      renderChat(); renderControls();
      break;
    case 'reaction': floatReaction(f.deviceId, f.emoji); break;
    case 'control':
      // the presenter said no, or control ended (they took it back, sharing stopped, we gave it back)
      state.asked = false;
      state.notice = f.text;
      renderField(); renderBanners();
      break;
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
  composeEls?.grow.stop();
  composeEls = null;
  dropShare();
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
  const fig = shareFrom ? shareFigure(shareFrom, seats) : null;
  if (!fig) dropShare();
  roomEls.field.classList.toggle('sharing', !!shareFrom);
  // the shared screen stays in place (its picture, and a control surface with its focus): only the tiles change
  const field = roomEls.field;
  if (fig && field.firstElementChild === fig) { for (const c of [...field.children].slice(1)) c.remove(); field.append(grid); }
  else field.replaceChildren(...(fig ? [fig] : []), grid);
}

// ------------------------------------------------------------------ the shared screen, and control of it
let shareEl: { from: string; stream: MediaStream | null; fig: HTMLElement; video: HTMLVideoElement; who: HTMLElement; ctl: HTMLElement } | null = null;

/** The shared screen's figure, kept while the same screen is shown; its control layer follows the Room. */
function shareFigure(from: string, seats: GuestSeat[]): HTMLElement {
  const mine = from === state.self!.deviceId;
  const stream = mine ? state.screen : screenStream(from);
  if (!shareEl || shareEl.from !== from || shareEl.stream !== stream) {
    dropShare();
    const video = h('video', { autoplay: true, playsinline: true, muted: true }) as HTMLVideoElement;
    video.muted = true;
    video.srcObject = stream;
    void video.play().catch(() => {});
    const who = h('span', {});
    const ctl = h('div', { class: 'share-ctl' });
    const fig = h('figure', { class: 'share' }, video, ctl, h('figcaption', { class: 'cap' }, h('b', {}, 'SHEET'), who));
    shareEl = { from, stream, fig, video, who, ctl };
  }
  const seat = seats.find((s) => s.deviceId === from);
  shareEl.who.textContent = mine ? 'YOUR SCREEN · SHARED' : `${capName(seat?.name ?? '')} · SCREEN`;
  renderShareControl(seat ?? null, mine);
  return shareEl.fig;
}

function dropShare(): void {
  surface?.stop();
  surface = null;
  shareEl = null;
}

/**
 * Over the shared screen: "Ask for control" when the person sharing (in the office app) allows it,
 * who controls it now, or, for the guest who has it, the control surface. A screen this guest
 * shares from the browser says plainly that nobody can control it.
 */
function renderShareControl(seat: GuestSeat | null, mine: boolean): void {
  if (!shareEl || !state.room || !state.self) return;
  const c = state.room.control ?? null;
  const ctl = shareEl.ctl;
  const name = seat?.name ?? '';
  if (mine) {
    surface?.stop(); surface = null;
    if (!ctl.querySelector('.share-note')) ctl.replaceChildren(h('p', { class: 'share-note', role: 'note' }, h('b', { class: 'mono' }, 'VIEW ONLY'), h('span', {}, BROWSER_VIEW_ONLY)));
    return;
  }
  if (c && seat && c.controllerDevice === state.self.deviceId && c.presenterDevice === seat.deviceId) {
    state.asked = false;
    if (!surface || surface.presenter !== seat.deviceId) {
      surface?.stop();
      surface = controlSurface(seat.deviceId, name);
      ctl.replaceChildren(surface.el);
      surface.el.focus();
    }
    return;
  }
  surface?.stop(); surface = null;
  if (c) { ctl.replaceChildren(h('span', { class: 'ctl-flag mono', role: 'status' }, `${capName(c.controllerName)} IS CONTROLLING`)); return; }
  // asking needs a mouse and keyboard: not offered on a phone or tablet
  if (!seat?.controllable || !matchMedia('(pointer: fine)').matches) { ctl.replaceChildren(); return; }
  const first = name.split(' ')[0];
  ctl.replaceChildren(h('button', {
    type: 'button', class: 'ctl-ask', disabled: state.asked, title: `Ask ${name} to let you use their mouse and keyboard`,
    onclick: () => { state.asked = true; send({ t: 'control', a: 'ask' }); toast(`Asked ${first} for control`); renderField(); },
  }, icon('screen', 14), state.asked ? 'Asked for control…' : 'Ask for control'));
}

/** This guest's hands on the presenter's PC: pointer and keys over the picture, sent in small batches. */
let surface: { el: HTMLElement; presenter: string; stop(): void } | null = null;
function controlSurface(presenter: string, name: string): NonNullable<typeof surface> {
  const batch = new InputBatcher();
  const held = { keys: new Set<string>(), buttons: new Set<MouseButton>() };
  const at = (e: { clientX: number; clientY: number }) => {
    const v = shareEl?.video;
    if (!v) return null;
    const r = v.getBoundingClientRect();
    return fromPicture(e.clientX, e.clientY, { x: r.left, y: r.top, width: r.width, height: r.height }, v.videoWidth, v.videoHeight);
  };
  const push = (ev: InputEvent) => batch.push(ev);
  const letGo = () => {
    for (const code of held.keys) push({ t: 'key', code, down: false });
    for (const b of held.buttons) push({ t: 'button', b, down: false, x: -1, y: -1 });
    held.keys.clear(); held.buttons.clear();
  };
  // fifteen messages a second at most: the gateway's guest connection has room for that and the signalling
  const flush = () => { const m = batch.take(); if (m) send({ t: 'input', e: m.e }); };
  const timer = setInterval(flush, 66);
  const release = h('button', { type: 'button', class: 'btn sm', onpointerdown: (e: Event) => e.stopPropagation(), onclick: (e: Event) => { e.stopPropagation(); send({ t: 'control', a: 'stop' }); } }, 'Release');
  const el = h('div', { class: 'ctl-surface', tabindex: '0', 'aria-label': `Controlling ${name}'s screen. Your pointer and keys go to their PC.` },
    h('span', { class: 'ctl-tag' }, h('span', {}, 'You are controlling ', h('b', {}, name), '\'s screen'), release));
  el.addEventListener('pointermove', (e) => { const p = at(e); if (p) push({ t: 'move', ...p }); });
  el.addEventListener('pointerdown', (e) => {
    el.focus();
    const b = domButton(e.button); const p = at(e);
    if (!b || !p) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    held.buttons.add(b);
    push({ t: 'button', b, down: true, ...p });
  });
  el.addEventListener('pointerup', (e) => {
    const b = domButton(e.button);
    if (!b || !held.buttons.delete(b)) return;
    push({ t: 'button', b, down: false, ...(at(e) ?? { x: -1, y: -1 }) });
  });
  el.addEventListener('wheel', (e) => { const p = at(e); if (!p) return; e.preventDefault(); const dy = wheelNotches(e.deltaY, e.deltaMode); const dx = wheelNotches(e.deltaX, e.deltaMode); if (dx || dy) push({ t: 'wheel', dx, dy, ...p }); }, { passive: false });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('keydown', (e) => { if (!(e.code in KEYS)) return; e.preventDefault(); e.stopPropagation(); held.keys.add(e.code); push({ t: 'key', code: e.code, down: true }); });
  el.addEventListener('keyup', (e) => { if (!(e.code in KEYS)) return; e.preventDefault(); e.stopPropagation(); if (!held.keys.delete(e.code)) return; push({ t: 'key', code: e.code, down: false }); });
  el.addEventListener('blur', letGo);
  return { el, presenter, stop: () => { letGo(); flush(); clearInterval(timer); el.remove(); } };
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
  // on a phone the label is one short word (Camera, Share, Hand): pressed or not shows in the button's look,
  // and its accessible name stays the whole label
  const tool = (on: boolean | null, label: string, ico: string, f: () => void, extra: Record<string, unknown> = {}, short = label) =>
    h('button', { type: 'button', class: `tool${on === true ? ' on' : on === false ? ' off' : ''}`, 'aria-pressed': on === null ? undefined : String(on), 'aria-label': label, title: label, onclick: f, ...extra },
      icon(ico), h('span', { class: 'long' }, label), h('span', { class: 'short', 'aria-hidden': 'true' }, short));
  const canShare = typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  roomEls.controls.replaceChildren(...[
    tool(state.micOn && hasMic, state.micOn && hasMic ? 'Mic on' : 'Mic off', state.micOn && hasMic ? 'mic' : 'mic-off', () => { state.micOn = !state.micOn; state.askUnmute = ''; applyMic(); announce(); renderControls(); renderField(); renderBanners(); }, { disabled: !hasMic }, 'Mic'),
    tool(state.camOn && hasCam, state.camOn && hasCam ? 'Camera on' : 'Camera off', state.camOn && hasCam ? 'cam' : 'cam-off', () => void toggleCamera(), {}, 'Cam'),
    canShare ? tool(!!state.screen, state.screen ? 'Stop sharing' : 'Share screen', 'screen', () => void toggleScreen(), {}, state.screen ? 'Stop' : 'Share') : null,
    tool(state.hand, state.hand ? 'Hand up' : 'Raise hand', 'hand', () => { state.hand = !state.hand; send({ t: 'hand', up: state.hand }); renderControls(); }, { class: `tool${state.hand ? ' raised' : ''}` }, 'Hand'),
    tool(null, 'React', 'react', (e?: unknown) => openReact((e as MouseEvent | undefined)?.currentTarget as HTMLElement | undefined), { 'aria-haspopup': 'menu' }),
    tool(state.chatOpen, state.unread ? `Chat · ${state.unread}` : 'Chat', 'chat', () => { state.chatOpen = !state.chatOpen; state.unread = 0; app.querySelector('.room')?.classList.toggle('chat-open', state.chatOpen); renderControls(); renderChat(); }, {}, state.unread ? `Chat ${state.unread}` : 'Chat'),
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
  // let in before the host came: they have been told and join from wherever they are
  if (r.hostAway) out.push(h('div', { class: 'banner', role: 'status' }, h('span', { class: 'mono' }, 'HOST · ON THE WAY'), h('span', {}, `${r.hostAway} let you in and has been told you are here. They join you shortly.`)));
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
  if (!state.chat.length) list.append(h('p', { class: 'faint small empty' }, 'Nothing said yet. Everyone in the meeting reads this chat, and the office keeps it with the meeting.'));
  let prev: RoomChatLine | null = null;
  // my own lines: by my guest identity (two guests may share a name)
  const meUser = state.self ? `guest:${state.self.deviceId.slice('guestdev:'.length)}` : '';
  for (const l of state.chat) {
    const run = prev && prev.userId === l.userId && prev.name === l.name && l.at - prev.at < 5 * 60_000;
    const mine = l.guest && (l.userId === meUser || (!l.userId && l.name === state.self?.name));
    list.append(h('div', { class: `line${run ? ' run' : ''}${mine ? ' mine' : ''}` },
      run ? null : h('div', { class: 'line-head' }, h('span', { class: 'mono' }, mine ? 'YOU' : capName(l.name)), l.guest && !mine ? h('span', { class: 'flag' }, 'GUEST') : null, l.breakout ? h('span', { class: 'mono faint' }, l.breakout.toUpperCase()) : null, h('span', { class: 'mono faint' }, clock(l.at))),
      l.text ? h('div', { class: 'line-body' }, l.text) : null,
      l.file ? h('div', { class: 'line-file' }, icon('clip', 14), h('span', {}, l.file.name), h('span', { class: 'mono faint' }, sizeText(l.file.size))) : null));
    prev = l;
  }
  const s = state.sending;
  const c = composer();
  const sending = s ? h('div', { class: 'sending', role: 'status' }, icon('clip', 14), h('span', {}, `Sending ${s.name}`), h('span', { class: 'mono' }, `${Math.round((s.sent / Math.max(1, s.size)) * 100)}%`)) : h('div', { class: 'sending', hidden: true });
  const oldList = roomEls.chat.querySelector(':scope > .chat-list');
  if (oldList && c.form.parentElement === roomEls.chat) {
    // the writing box stays where it is (with its text and focus): only the lines change
    oldList.replaceWith(list);
    roomEls.chat.querySelector(':scope > .sending')?.replaceWith(sending);
  } else {
    roomEls.chat.replaceChildren(
      h('div', { class: 'chat-head' }, h('span', { class: 'tb-label' }, 'Meeting chat'), h('button', { class: 'icon-btn', 'aria-label': 'Close the chat', onclick: () => { state.chatOpen = false; app.querySelector('.room')?.classList.remove('chat-open'); renderControls(); } }, icon('x', 14))),
      list, sending, c.form);
    c.grow.fit();
  }
  c.attach.disabled = !!s;
  list.scrollTop = list.scrollHeight;
}


/**
 * The chat's writing box, made once per meeting page: it keeps a half-written message (and its
 * focus) while lines arrive. It grows with the text up to six lines, then scrolls; Enter sends,
 * Shift+Enter starts a new line, and Enter while an input method is composing is left to it.
 */
let composeEls: { form: HTMLFormElement; input: HTMLTextAreaElement; attach: HTMLButtonElement; grow: { fit(): void; stop(): void } } | null = null;
function composer(): NonNullable<typeof composeEls> {
  if (composeEls) return composeEls;
  const input = h('textarea', { class: 'input', rows: '1', maxlength: '2000', placeholder: 'Message everyone', 'aria-label': 'Message to the meeting', enterkeyhint: 'send' }) as HTMLTextAreaElement;
  const grow = autoGrow(input);
  const submit = () => { const t = input.value.trim(); if (!t) return; send({ t: 'chat', text: t }); input.value = ''; grow.fit(); };
  input.addEventListener('keydown', (e) => { if (enterAction(e) === 'send') { e.preventDefault(); submit(); } });
  const picker = h('input', { type: 'file', class: 'visually-hidden', 'aria-hidden': 'true', tabindex: '-1' }) as HTMLInputElement;
  picker.addEventListener('change', () => { const f = picker.files?.[0]; picker.value = ''; if (f) void sendFile(f); });
  const attach = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Attach a file', title: 'Attach a file (the office keeps it with the meeting)', onclick: () => picker.click() }, icon('clip', 16)) as HTMLButtonElement;
  const form = h('form', { class: 'compose', onsubmit: (e: Event) => { e.preventDefault(); submit(); } },
    attach, picker, input, h('button', { class: 'btn primary sm', type: 'submit' }, 'Send')) as HTMLFormElement;
  composeEls = { form, input, attach, grow };
  return composeEls;
}

const sizeText = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Send a file to the meeting chat in chunks; the hub checks it against the office's file rules. */
async function sendFile(f: File): Promise<void> {
  if (state.sending) return;
  if (f.size > GUEST_FILE_MAX) { toast(`Files can be up to ${GUEST_FILE_MAX / 1024 / 1024} MB.`); return; }
  if (!f.size) { toast('That file is empty.'); return; }
  const id = Math.random().toString(36).slice(2, 12);
  state.sending = { id, name: f.name, sent: 0, size: f.size };
  renderChat();
  send({ t: 'file', id, name: f.name, mime: f.type || 'application/octet-stream', size: f.size });
  const buf = new Uint8Array(await f.arrayBuffer());
  for (let i = 0, k = 0; i < buf.length; i += GUEST_FILE_CHUNK, k++) {
    if (state.sending?.id !== id) return; // refused, or the meeting ended
    const part = buf.subarray(i, i + GUEST_FILE_CHUNK);
    let bin = '';
    for (let j = 0; j < part.length; j += 0x8000) bin += String.fromCharCode(...part.subarray(j, j + 0x8000));
    send({ t: 'fileChunk', id, i: k, data: btoa(bin) });
    state.sending.sent = Math.min(f.size, i + part.length);
    // stay under the gateway's frame rate, and let the page draw the progress
    if (k % 8 === 7) { renderChat(); await new Promise((r) => setTimeout(r, 120)); }
  }
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
// a window narrowed to a phone's width: the chat makes way for the people
matchMedia('(max-width: 720px)').addEventListener?.('change', (e) => { if (e.matches && state.chatOpen) { state.chatOpen = false; app.querySelector('.room')?.classList.remove('chat-open'); renderControls(); } });

function start(o: RoomStart): { leave(): void; setMic(on: boolean): void } {
  app = o.mount; meetingId = o.meetingId; passcode = o.passcode; on = o.on; speaker = o.speaker;
  state.name = o.name; state.local = o.local; state.micOn = o.micOn; state.camOn = o.camOn;
  state.step = 'connecting'; state.attempts = 0; state.joinedAt = null; state.ended = ''; state.endKind = null;
  applyMic();
  connect();
  return { leave: leaveMeeting, setMic: (v: boolean) => { state.micOn = v; applyMic(); announce(); } };
}

(window as unknown as { DexRoom: { start: typeof start } }).DexRoom = { start };
