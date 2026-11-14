// Recording a call, on the PC of the person recording: every participant's camera (or their
// initials), any shared screen, and everyone's voices mixed together, drawn into one video.
// The hub tells everyone in the call that it is being recorded.
import { useSyncExternalStore } from 'react';
import { callState } from './engine.ts';

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

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';
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
    ctx.fillStyle = '#0d1416';
    ctx.fillRect(0, 0, W, H);
    type T = { key: string; name: string; stream: MediaStream | null; camera: boolean };
    const tiles: T[] = [{ key: 'me', name: nameOf(meId), stream: st.local, camera: st.camera }];
    for (const p of st.room.participants) {
      const peer = st.peers.get(p.deviceId);
      if (!peer) continue;
      tiles.push({ key: p.deviceId, name: nameOf(p.userId), stream: peer.streams[0] ?? null, camera: p.camera });
    }
    // a shared screen takes the stage, people go in a strip on the right
    const sharer = st.screen ?? [...st.peers.values()].map((p) => p.streams.find((x, i) => i > 0 && x.getVideoTracks().length)).find(Boolean) ?? null;
    let area = { x: 0, y: 0, w: W, h: H };
    if (sharer) {
      drawCover(ctx, videoFor(r, 'screen', sharer), 0, 0, W - 240, H, true);
      area = { x: W - 240, y: 0, w: 240, h: H };
    }
    const n = tiles.length;
    const cols = sharer ? 1 : Math.ceil(Math.sqrt(n));
    const rows = sharer ? Math.min(n, 5) : Math.ceil(n / cols);
    const tw = area.w / cols, th = sharer ? Math.min(area.h / rows, 135) : area.h / rows;
    tiles.slice(0, sharer ? 5 : 9).forEach((t, i) => {
      const x = area.x + (i % cols) * tw + 4, y = area.y + Math.floor(i / cols) * th + 4, w = tw - 8, h = th - 8;
      ctx.fillStyle = '#1b2a2d';
      ctx.fillRect(x, y, w, h);
      const vt = t.stream?.getVideoTracks()[0];
      if (t.camera && vt && vt.readyState === 'live') drawCover(ctx, videoFor(r, t.key, t.stream!), x, y, w, h);
      else {
        ctx.fillStyle = '#2b6f78';
        const rad = Math.min(w, h) * 0.18;
        ctx.beginPath(); ctx.arc(x + w / 2, y + h / 2, rad, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = `600 ${Math.round(rad * 0.8)}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(initials(t.name), x + w / 2, y + h / 2);
      }
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.font = '500 15px sans-serif';
      const label = t.name;
      const lw = ctx.measureText(label).width + 16;
      ctx.fillRect(x + 8, y + h - 30, lw, 22);
      ctx.fillStyle = '#ffffff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(label, x + 16, y + h - 19);
    });
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
