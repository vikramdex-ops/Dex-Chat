// The stage, composed on the broadcaster's PC: everyone on the stage drawn into one 1280×720
// picture as a drawing sheet (a faint drafting grid, people as tiles with zone captions, a shared
// screen as the sheet under discussion), a title strip along the foot (the webinar, LIVE in amber,
// the time it has run), and a question the organiser shows on the stage as a ruled callout. The
// sound is everyone's voices mixed. The same picture and sound go to attendees (the relay, or
// straight to viewers outside) and to the live stream. A worker's timer drives the frames, so the
// picture keeps moving while the window is in the background.
import type { WebinarQuestion } from '@dex/core';
import { callState, capName, zoneRef } from '../../rooms/engine.ts';
import { onVoiceTick } from '../../rooms/speech.ts';
import { colorFor, initials } from '../../ui.tsx';

export const STAGE_W = 1280;
export const STAGE_H = 720;
const FPS = 25;
const STRIP = 56;
const MONO = '"Cascadia Mono", "JetBrains Mono", Consolas, monospace';
const DISPLAY = '"Outfit Variable", "Segoe UI", sans-serif';

export interface StageScene {
  title: string;
  meetingId: string;
  live: boolean;
  wentLiveAt: number | null;
  question: WebinarQuestion | null;
}

export interface Compositor {
  stream: MediaStream;
  canvas: HTMLCanvasElement;
  stop(): void;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function cover(ctx: CanvasRenderingContext2D, v: HTMLVideoElement, x: number, y: number, w: number, h: number, contain = false): void {
  const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
  const s = contain ? Math.min(w / vw, h / vh) : Math.max(w / vw, h / vh);
  const dw = vw * s, dh = vh * s;
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.drawImage(v, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
}

/** A caption cell: "A1 | PRIYA R." */
function caption(ctx: CanvasRenderingContext2D, x: number, y: number, zone: string, text: string, maxW: number, muted: boolean): void {
  ctx.font = `600 14px ${MONO}`;
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  const zw = ctx.measureText(zone).width + 16;
  const label = muted ? `${text} · MIC OFF` : text;
  const tw = Math.min(ctx.measureText(label).width + 18, Math.max(0, maxW - zw));
  ctx.fillStyle = '#172729'; ctx.fillRect(x, y, zw + tw, 26);
  ctx.fillStyle = '#243a3d'; ctx.fillRect(x, y, zw, 26);
  ctx.strokeStyle = 'rgba(232,242,243,.3)'; ctx.lineWidth = 1; ctx.strokeRect(x + .5, y + .5, zw + tw - 1, 25);
  ctx.fillStyle = '#7fd0d9'; ctx.fillText(zone, x + 8, y + 13.5);
  ctx.save(); ctx.beginPath(); ctx.rect(x + zw, y, tw - 6, 26); ctx.clip();
  ctx.fillStyle = '#e8f2f3'; ctx.fillText(label, x + zw + 9, y + 13.5);
  ctx.restore();
}

/** Words wrapped to a width, at most `lines` lines (the last one ends with … when cut). */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, lines: number): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width <= width) { cur = next; continue; }
    if (cur) out.push(cur);
    cur = w;
    if (out.length === lines) break;
  }
  if (out.length < lines && cur) out.push(cur);
  if (out.length === lines && words.join(' ').length > out.join(' ').length) {
    let last = out[lines - 1];
    while (last.length > 1 && ctx.measureText(`${last}…`).width > width) last = last.slice(0, -1);
    out[lines - 1] = `${last}…`;
  }
  return out;
}

const hms = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const fmtId = (id: string) => `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}`;

/** Start composing the stage of the Room this PC is in. */
export function startCompositor(scene: () => StageScene, nameOf: (userId: string) => string, meId: string, meDevice: string): Compositor {
  const canvas = document.createElement('canvas');
  canvas.width = STAGE_W; canvas.height = STAGE_H;
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const audio = new AudioContext();
  const mix = audio.createMediaStreamDestination();
  const sources = new Map<string, { node: MediaStreamAudioSourceNode; track: MediaStreamTrack }>();
  const videos = new Map<string, HTMLVideoElement>();
  // who is speaking (the Room's 10 Hz detection): their tile gets a teal frame
  let speaker: string | null = null;
  let held = 0;
  const offVoice = onVoiceTick((key) => {
    if (key) { speaker = key.startsWith('self:') ? meDevice : key; held = 8; } else if (held > 0 && --held === 0) speaker = null;
  });

  const videoFor = (key: string, stream: MediaStream): HTMLVideoElement => {
    let v = videos.get(key);
    if (!v || v.srcObject !== stream) {
      v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.srcObject = stream;
      void v.play().catch(() => {});
      videos.set(key, v);
    }
    return v;
  };

  const syncAudio = () => {
    const st = callState();
    const want = new Map<string, MediaStreamTrack>();
    const mine = st.local?.getAudioTracks()[0];
    if (mine) want.set('me', mine);
    for (const p of st.peers.values()) {
      const a = p.streams[0]?.getAudioTracks()[0];
      if (a) want.set(p.deviceId, a);
      // a shared screen's sound too
      const sa = p.streams[1]?.getAudioTracks()[0];
      if (sa) want.set(`${p.deviceId}:screen`, sa);
    }
    const ownScreen = st.screen?.getAudioTracks()[0];
    if (ownScreen) want.set('me:screen', ownScreen);
    for (const [k, s] of sources) if (want.get(k) !== s.track) { s.node.disconnect(); sources.delete(k); }
    for (const [k, track] of want) if (!sources.has(k)) { const node = audio.createMediaStreamSource(new MediaStream([track])); node.connect(mix); sources.set(k, { node, track }); }
  };

  const grid = () => {
    ctx.fillStyle = '#0f1d1f';
    ctx.fillRect(0, 0, STAGE_W, STAGE_H);
    ctx.lineWidth = 1;
    for (let x = 0; x <= STAGE_W; x += 16) { ctx.strokeStyle = x % 80 === 0 ? 'rgba(127,208,217,.07)' : 'rgba(127,208,217,.03)'; ctx.beginPath(); ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, STAGE_H - STRIP); ctx.stroke(); }
    for (let y = 0; y <= STAGE_H - STRIP; y += 16) { ctx.strokeStyle = y % 80 === 0 ? 'rgba(127,208,217,.07)' : 'rgba(127,208,217,.03)'; ctx.beginPath(); ctx.moveTo(0, y + .5); ctx.lineTo(STAGE_W, y + .5); ctx.stroke(); }
  };

  const frame = () => {
    const st = callState();
    const room = st.room;
    const sc = scene();
    syncAudio();
    grid();
    type T = { key: string; userId: string; name: string; stream: MediaStream | null; camera: boolean; muted: boolean };
    const tiles: T[] = [];
    if (room) {
      tiles.push({ key: meDevice, userId: meId, name: nameOf(meId), stream: st.local, camera: st.camera, muted: st.muted });
      for (const p of room.participants) {
        if (p.deviceId === meDevice) continue;
        const peer = st.peers.get(p.deviceId);
        tiles.push({ key: p.deviceId, userId: p.userId, name: nameOf(p.userId), stream: peer?.streams[0] ?? null, camera: p.camera, muted: p.muted });
      }
    }
    const sharerStream = st.screen ?? [...st.peers.values()].map((p) => p.streams.find((x, i) => i > 0 && x.getVideoTracks().length)).find(Boolean) ?? null;
    const top = 24, bottom = STAGE_H - STRIP - 24;
    let area = { x: 24, y: top, w: STAGE_W - 48, h: bottom - top };
    if (sharerStream) {
      // the shared sheet, large; the people in a column on the right
      const sw = STAGE_W - 48 - 272;
      ctx.fillStyle = '#0b1416'; ctx.fillRect(24, top, sw, bottom - top);
      cover(ctx, videoFor('screen', sharerStream), 24, top, sw, bottom - top, true);
      ctx.strokeStyle = 'rgba(232,242,243,.22)'; ctx.strokeRect(24.5, top + .5, sw - 1, bottom - top - 1);
      caption(ctx, 36, top + 12, 'SHEET', 'SHARED SCREEN', sw - 24, false);
      area = { x: STAGE_W - 24 - 256, y: top, w: 256, h: bottom - top };
    }
    const n = Math.max(1, tiles.length);
    const cols = sharerStream ? 1 : n === 1 ? 1 : n <= 4 ? 2 : n <= 6 ? 3 : 4;
    const rows = sharerStream ? Math.min(n, 4) : Math.ceil(n / cols);
    const gap = 16;
    // 16:9 tiles, as large as the area allows, centred
    let tw = (area.w - gap * (cols - 1)) / cols;
    let th = tw * 9 / 16;
    if (th * rows + gap * (rows - 1) > area.h) { th = (area.h - gap * (rows - 1)) / rows; tw = th * 16 / 9; }
    const gw = tw * cols + gap * (cols - 1), gh = th * rows + gap * (rows - 1);
    const ox = area.x + (area.w - gw) / 2, oy = area.y + (area.h - gh) / 2;
    tiles.slice(0, sharerStream ? 4 : 8).forEach((t, i) => {
      const x = ox + (i % cols) * (tw + gap), y = oy + Math.floor(i / cols) * (th + gap);
      ctx.fillStyle = '#172729';
      ctx.fillRect(x, y, tw, th);
      const vt = t.stream?.getVideoTracks()[0];
      if (t.camera && vt && vt.readyState === 'live') cover(ctx, videoFor(t.key, t.stream!), x, y, tw, th);
      else {
        const side = Math.min(tw, th) * 0.38;
        ctx.fillStyle = colorFor(t.userId);
        roundRect(ctx, x + (tw - side) / 2, y + (th - side) / 2, side, side, side * 0.3);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = `600 ${Math.round(side * 0.38)}px ${DISPLAY}`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(initials(t.name), x + tw / 2, y + th / 2 + 1);
      }
      const speaking = speaker === t.key && tiles.length > 1;
      ctx.strokeStyle = speaking ? '#47b0a4' : 'rgba(232,242,243,.18)';
      ctx.lineWidth = speaking ? 3 : 1;
      ctx.strokeRect(x + (speaking ? 1.5 : .5), y + (speaking ? 1.5 : .5), tw - (speaking ? 3 : 1), th - (speaking ? 3 : 1));
      ctx.lineWidth = 1;
      caption(ctx, x + 10, y + th - 36, zoneRef(i, cols), capName(t.name), tw - 20, t.muted);
    });
    if (!tiles.length) {
      ctx.fillStyle = '#9db4b7'; ctx.font = `600 22px ${DISPLAY}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('The stage is empty', STAGE_W / 2, (STAGE_H - STRIP) / 2);
    }
    // a question the organiser shows on the stage: a ruled callout at the top left
    const q = sc.question;
    if (q) {
      ctx.font = `600 26px ${DISPLAY}`;
      const lines = wrap(ctx, q.text, 560, 3);
      const bw = 620, bh = 64 + lines.length * 34;
      const bx = 40, by = 40;
      ctx.fillStyle = 'rgba(15,29,31,.94)'; ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = '#47b0a4'; ctx.lineWidth = 2; ctx.strokeRect(bx + 1, by + 1, bw - 2, bh - 2); ctx.lineWidth = 1;
      ctx.fillStyle = '#243a3d'; ctx.fillRect(bx + 2, by + 2, bw - 4, 34);
      ctx.font = `700 14px ${MONO}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#7fd0d9'; ctx.fillText(`QUESTION · ${q.anonymous || !q.author ? 'ANONYMOUS' : capName(q.author)}`, bx + 16, by + 19);
      ctx.textAlign = 'right'; ctx.fillStyle = '#e8f2f3'; ctx.fillText(`▲ ${q.votes}`, bx + bw - 16, by + 19);
      ctx.textAlign = 'left'; ctx.fillStyle = '#ffffff'; ctx.font = `600 26px ${DISPLAY}`;
      lines.forEach((l, i) => ctx.fillText(l, bx + 18, by + 60 + i * 34));
    }
    // the title strip: the webinar, its ID, LIVE in amber and how long it has run
    const sy = STAGE_H - STRIP;
    ctx.fillStyle = '#172729'; ctx.fillRect(0, sy, STAGE_W, STRIP);
    ctx.fillStyle = 'rgba(232,242,243,.3)'; ctx.fillRect(0, sy, STAGE_W, 1);
    const cells = [0, 760, 980, 1130, STAGE_W];
    for (const cx of cells.slice(1, -1)) ctx.fillRect(cx, sy, 1, STRIP);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    const label = (x: number, text: string) => { ctx.font = `600 11px ${MONO}`; ctx.fillStyle = '#829a9d'; ctx.fillText(text, x + 16, sy + 20); };
    label(0, 'WEBINAR');
    ctx.font = `600 19px ${DISPLAY}`; ctx.fillStyle = '#e8f2f3';
    ctx.save(); ctx.beginPath(); ctx.rect(0, sy, 750, STRIP); ctx.clip(); ctx.fillText(sc.title, 16, sy + 44); ctx.restore();
    label(760, sc.live ? 'ON AIR' : 'PRACTICE');
    ctx.font = `700 18px ${MONO}`;
    if (sc.live) {
      ctx.fillStyle = '#f7af44';
      ctx.beginPath(); ctx.arc(782, sy + 38, 6, 0, Math.PI * 2); ctx.fill();
      ctx.fillText(`LIVE ${hms(Date.now() - (sc.wentLiveAt ?? Date.now()))}`, 796, sy + 44);
    } else { ctx.fillStyle = '#9db4b7'; ctx.fillText('NOT LIVE', 776, sy + 44); }
    label(980, 'ID');
    ctx.font = `600 16px ${MONO}`; ctx.fillStyle = '#e8f2f3'; ctx.fillText(fmtId(sc.meetingId), 996, sy + 43);
    label(1130, 'SHEET');
    ctx.fillText('STAGE', 1146, sy + 43);
  };

  const stream = canvas.captureStream(FPS);
  for (const t of mix.stream.getAudioTracks()) stream.addTrack(t);
  frame();
  // a worker's timer is not slowed down when the window is in the background
  const worker = new Worker(new URL('./tick.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = () => { try { frame(); } catch { /* the next frame tries again */ } };
  worker.postMessage(Math.round(1000 / FPS));
  return {
    stream, canvas,
    stop() {
      worker.postMessage(0);
      worker.terminate();
      offVoice();
      for (const s of sources.values()) s.node.disconnect();
      sources.clear();
      void audio.close();
      for (const v of videos.values()) v.srcObject = null;
      videos.clear();
      for (const t of stream.getTracks()) t.stop();
    },
  };
}
