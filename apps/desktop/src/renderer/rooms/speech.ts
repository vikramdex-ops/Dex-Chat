// Who is speaking: one audio context for the whole Room, one analyser per voice, read ten times a
// second (never per video frame). Tiles subscribe to their own device only, so a voice starting
// or stopping re-renders one tile; the active speaker (for the speaker layout) changes only after
// someone has spoken for a moment, so the big tile does not flicker between people.
import { useSyncExternalStore } from 'react';

const TICK_MS = 100;
const LOUD = 0.045;
/** Ticks of quiet before a voice counts as stopped (a short pause in a sentence is still speaking). */
const HOLD = 4;
/** Ticks someone must lead before they become the active speaker. */
const SWITCH = 8;

interface Voice { src: MediaStreamAudioSourceNode; an: AnalyserNode; buf: Uint8Array<ArrayBuffer>; stream: MediaStream; quiet: number; speaking: boolean; level: number }

let ctx: AudioContext | null = null;
const voices = new Map<string, Voice>();
const subs = new Map<string, Set<() => void>>();
const activeSubs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let active: string | null = null;
let leader: string | null = null;
let leadTicks = 0;

function emit(key: string): void { for (const f of subs.get(key) ?? []) f(); }

function tick(): void {
  let loudest: string | null = null;
  let top = 0;
  for (const [key, v] of voices) {
    v.an.getByteTimeDomainData(v.buf);
    let sum = 0;
    for (let i = 0; i < v.buf.length; i++) { const x = (v.buf[i] - 128) / 128; sum += x * x; }
    const rms = Math.sqrt(sum / v.buf.length);
    v.level = rms;
    const loud = rms > LOUD;
    v.quiet = loud ? 0 : v.quiet + 1;
    const speaking = loud || v.quiet < HOLD;
    if (speaking !== v.speaking) { v.speaking = speaking; emit(key); }
    if (loud && rms > top && !key.startsWith('self:')) { top = rms; loudest = key; }
  }
  // the active speaker changes once someone else has led for a moment
  if (loudest && loudest !== active) {
    if (loudest === leader) leadTicks++; else { leader = loudest; leadTicks = 1; }
    if (leadTicks >= SWITCH || active === null || !voices.has(active)) { active = loudest; leadTicks = 0; for (const f of activeSubs) f(); }
  } else if (!loudest) { leader = null; leadTicks = 0; }
}

/**
 * Follow a device's voice. `key` is the device id (or "self:" + id for this PC, which never
 * becomes the active speaker for its own screen). Calling again with a new stream replaces it.
 */
export function watchVoice(key: string, stream: MediaStream | null): void {
  const cur = voices.get(key);
  if (cur && cur.stream === stream) return;
  if (cur) { cur.src.disconnect(); voices.delete(key); if (cur.speaking) emit(key); }
  if (!stream || !stream.getAudioTracks().length) { stopIfIdle(); return; }
  try {
    ctx ??= new AudioContext();
    const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    const an = ctx.createAnalyser();
    an.fftSize = 256;
    src.connect(an);
    voices.set(key, { src, an, buf: new Uint8Array(new ArrayBuffer(an.fftSize)), stream, quiet: HOLD, speaking: false, level: 0 });
    timer ??= setInterval(tick, TICK_MS);
  } catch { /* no audio on this PC: nobody shows as speaking */ }
}

/** Stop following every voice not in `keep` (people who left). */
export function keepVoices(keep: Set<string>): void {
  for (const key of [...voices.keys()]) if (!keep.has(key)) watchVoice(key, null);
}

function stopIfIdle(): void {
  if (voices.size) return;
  if (timer) { clearInterval(timer); timer = null; }
  if (active !== null) { active = null; for (const f of activeSubs) f(); }
  void ctx?.close().catch(() => {});
  ctx = null;
}

/** Forget everything (the Room ended). */
export function stopVoices(): void {
  for (const key of [...voices.keys()]) watchVoice(key, null);
  stopIfIdle();
}

export function useSpeaking(key: string): boolean {
  return useSyncExternalStore(
    (f) => { const s = subs.get(key) ?? new Set(); s.add(f); subs.set(key, s); return () => { s.delete(f); if (!s.size) subs.delete(key); }; },
    () => voices.get(key)?.speaking ?? false,
  );
}

/** The device of whoever is speaking now (held for a moment), or null. */
export function useActiveSpeaker(): string | null {
  return useSyncExternalStore((f) => { activeSubs.add(f); return () => activeSubs.delete(f); }, () => active);
}
