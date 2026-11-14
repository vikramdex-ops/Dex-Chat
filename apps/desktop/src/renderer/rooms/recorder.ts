// Recording a Room, on the PC of the person recording: every participant's camera (or their
// tile), any shared screen, and everyone's voices mixed together, drawn into one video laid out
// like the Room sheet (zone captions, a title strip). The hub tells everyone in the Room that it
// is being recorded.
import { useSyncExternalStore } from 'react';
import { callState, capName, clock, sheetColumns, zoneRef } from './engine.ts';
import { colorFor, initials } from '../ui.tsx';

interface Rec {
  recorder: MediaRecorder;
  chunks: Blob[];
  started: number;
  timer: ReturnType<typeof setInterval>;
  audio: AudioContext;
  sources: Map<string, MediaStreamAudioSourceNode>;
  videos: Map<string, HTMLVideoElement>;
  roomId: string;
}

export interface Recording { blob: Blob; ms: number; convId: string; roomId: string }

let rec: Rec | null = null;
let done: Recording | null = null;
const subs = new Set<() => void>();
type Snap = { recording: true; started: number; done?: undefined } | { recording: false; done: Recording } | null;
let snap: Snap = null;
const changed = () => {
  snap = rec ? { recording: true, started: rec.started } : done ? { recording: false, done } : null;
  for (const f of subs) f();
};
export const useRecorder = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => snap);
export const recordSupported = () => typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
export const clearRecording = () => { done = null; changed(); };

const W = 1280, H = 720;

function videoFor(r: Rec, key: string, stream: MediaStream): HTMLVideoElement {
  let v = r.videos.get(key);
  if (!v || v.srcObject !== stream) {
    v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.srcObject = stream;
    void v.play().catch(() => {});
    r.videos.set(key, v);
  }
  return v;
}

function drawCover(ctx: CanvasRenderingContext2D, v: HTMLVideoElement, x: number, y: number, w: number, h: number, contain = false): void {
  const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
  const s = contain ? Math.min(w / vw, h / vh) : Math.max(w / vw, h / vh);
  const dw = vw * s, dh = vh * s;
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.drawImage(v, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
}

const MONO = '"Cascadia Mono", "JetBrains Mono", Consolas, monospace';
const STRIP = 30; // the title strip along the bottom of the video

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** A drawing-callout caption: "A1 | PRIYA R." in the tile's top-left corner. */
function caption(ctx: CanvasRenderingContext2D, x: number, y: number, zone: string, text: string, maxW: number): void {
  ctx.font = `600 13px ${MONO}`;
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  const zw = ctx.measureText(zone).width + 14;
  const tw = Math.min(ctx.measureText(text).width + 16, Math.max(0, maxW - zw));
  ctx.fillStyle = '#172729'; ctx.fillRect(x, y, zw + tw, 24);
  ctx.fillStyle = '#243a3d'; ctx.fillRect(x, y, zw, 24);
  ctx.strokeStyle = 'rgba(232,242,243,.28)'; ctx.lineWidth = 1; ctx.strokeRect(x + .5, y + .5, zw + tw - 1, 23);
  ctx.fillStyle = '#7fd0d9'; ctx.fillText(zone, x + 7, y + 12.5);
  ctx.save(); ctx.beginPath(); ctx.rect(x + zw, y, tw - 6, 24); ctx.clip();
  ctx.fillStyle = '#e8f2f3'; ctx.fillText(text, x + zw + 8, y + 12.5);
  ctx.restore();
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Start recording the current call. Throws if the office does not allow it. */
export async function startRecording(nameOf: (userId: string) => string, meId: string): Promise<void> {
  const s = callState();
  if (!s.room || rec) return;
  const roomId = s.room.id;
  await window.dex.request('room.record', { roomId, on: true });
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const audio = new AudioContext();
  const mix = audio.createMediaStreamDestination();
  const r: Rec = { recorder: null as unknown as MediaRecorder, chunks: [], started: Date.now(), timer: 0 as unknown as ReturnType<typeof setInterval>, audio, sources: new Map(), videos: new Map(), roomId };

  const syncAudio = () => {
    const st = callState();
    const want = new Map<string, MediaStream>();
    if (st.local?.getAudioTracks().length) want.set('me', st.local);
    for (const p of st.peers.values()) { const a = p.streams[0]; if (a?.getAudioTracks().length) want.set(p.deviceId, a); }
    for (const [k, node] of r.sources) if (!want.has(k)) { node.disconnect(); r.sources.delete(k); }
    for (const [k, stream] of want) if (!r.sources.has(k)) { const n = audio.createMediaStreamSource(stream); n.connect(mix); r.sources.set(k, n); }
  };

  const frame = () => {
    const st = callState();
    // the call ended (or we left): finish the file
    if (!st.room || st.room.id !== roomId) { if (r.recorder.state !== 'inactive') r.recorder.stop(); return; }
    syncAudio();
    ctx.fillStyle = '#0f1d1f';
    ctx.fillRect(0, 0, W, H);
    type T = { key: string; id: string; name: string; stream: MediaStream | null; camera: boolean };
    const tiles: T[] = [{ key: 'me', id: meId, name: nameOf(meId), stream: st.local, camera: st.camera }];
    for (const p of st.room.participants) {
      const peer = st.peers.get(p.deviceId);
      if (!peer) continue;
      tiles.push({ key: p.deviceId, id: p.userId, name: nameOf(p.userId), stream: peer.streams[0] ?? null, camera: p.camera });
    }
    // a shared screen is the sheet being discussed; people go in a column on the right
    const sharer = st.screen ?? [...st.peers.values()].map((p) => p.streams.find((x, i) => i > 0 && x.getVideoTracks().length)).find(Boolean) ?? null;
    const field = { x: 0, y: 0, w: W, h: H - STRIP };
    let area = field;
    if (sharer) {
      ctx.fillStyle = '#0b1416'; ctx.fillRect(8, 8, W - 256, field.h - 16);
      drawCover(ctx, videoFor(r, 'screen', sharer), 8, 8, W - 256, field.h - 16, true);
      area = { x: W - 240, y: 0, w: 240, h: field.h };
    }
    const n = tiles.length;
    const cols = sheetColumns(n, !!sharer);
    const rows = sharer ? Math.min(n, 5) : Math.ceil(n / cols);
    const tw = area.w / cols, th = sharer ? Math.min(area.h / rows, 135) : area.h / rows;
    tiles.slice(0, sharer ? 5 : 9).forEach((t, i) => {
      const x = area.x + (i % cols) * tw + 8, y = area.y + Math.floor(i / cols) * th + 8, w = tw - 16, h = th - 16;
      ctx.fillStyle = '#172729';
      ctx.fillRect(x, y, w, h);
      const vt = t.stream?.getVideoTracks()[0];
      if (t.camera && vt && vt.readyState === 'live') drawCover(ctx, videoFor(r, t.key, t.stream!), x, y, w, h);
      else {
        // the person's tile: a rounded square in their colour with initials
        const side = Math.min(w, h) * 0.34;
        ctx.fillStyle = colorFor(t.id);
        roundRect(ctx, x + (w - side) / 2, y + (h - side) / 2, side, side, side * 0.3);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = `600 ${Math.round(side * 0.38)}px "Outfit Variable", sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(initials(t.name), x + w / 2, y + h / 2 + 1);
      }
      ctx.strokeStyle = 'rgba(232,242,243,.16)'; ctx.lineWidth = 1; ctx.strokeRect(x + .5, y + .5, w - 1, h - 1);
      caption(ctx, x + 8, y + 8, zoneRef(i, cols), capName(t.name), w - 16);
    });
    // the title strip: what this is, when it started and how long it has run
    ctx.fillStyle = '#172729'; ctx.fillRect(0, H - STRIP, W, STRIP);
    ctx.fillStyle = 'rgba(232,242,243,.28)'; ctx.fillRect(0, H - STRIP, W, 1);
    ctx.font = `600 13px ${MONO}`; ctx.textBaseline = 'middle';
    ctx.textAlign = 'left'; ctx.fillStyle = '#7fd0d9';
    ctx.fillText(`ROOM RECORDING · ${new Date(r.started).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }).toUpperCase()} · ${clock(r.started)}`, 12, H - STRIP / 2);
    ctx.textAlign = 'right'; ctx.fillStyle = '#ef7d6d';
    ctx.fillText(`● REC ${elapsed(Date.now() - r.started)}`, W - 12, H - STRIP / 2);
  };

  const stream = canvas.captureStream(15);
  for (const t of mix.stream.getAudioTracks()) stream.addTrack(t);
  const types = ['video/webm;codecs=vp8,opus', 'video/webm'];
  const recorder = new MediaRecorder(stream, { mimeType: types.find((t) => MediaRecorder.isTypeSupported(t)) ?? 'video/webm', videoBitsPerSecond: 1_200_000, audioBitsPerSecond: 64_000 });
  recorder.ondataavailable = (e) => { if (e.data.size) r.chunks.push(e.data); };
  recorder.onstop = () => {
    clearInterval(r.timer);
    for (const n of r.sources.values()) n.disconnect();
    void audio.close();
    for (const v of r.videos.values()) v.srcObject = null;
    done = { blob: new Blob(r.chunks, { type: 'video/webm' }), ms: Date.now() - r.started, convId: s.room?.convId ?? '', roomId };
    rec = null;
    changed();
  };
  r.recorder = recorder;
  frame();
  r.timer = setInterval(frame, 1000 / 15);
  recorder.start(1000);
  rec = r;
  changed();
}

export function stopRecording(): void {
  if (!rec) return;
  const r = rec;
  void window.dex.request('room.record', { roomId: r.roomId, on: false }).catch(() => {});
  if (r.recorder.state !== 'inactive') r.recorder.stop();
}
