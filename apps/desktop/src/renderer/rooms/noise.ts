// Strong noise suppression for the microphone in a Room: RNNoise (Xiph, BSD-3-Clause) compiled to
// WebAssembly, run as an AudioWorklet (@sapphi-red/web-noise-suppressor, MIT), on this PC. The
// worklet works on the audio thread in 10 ms frames, so it never holds up the interface. The
// microphone goes in, the cleaned voice comes out as a new track, and that track is what the Room
// sends, records and listens to for "who is speaking". On by default; the Room's sound menu turns
// it off (remembered on this PC). The engine and its WASM are bundled beside the app (vite.config).
import { useSyncExternalStore } from 'react';
import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';

const PREF_KEY = 'dex.room.noise';

interface Chain { ctx: AudioContext; raw: MediaStreamTrack; node: RnnoiseWorkletNode; out: MediaStreamTrack }
let chain: Chain | null = null;
let wasm: Promise<ArrayBuffer> | null = null;
let failed: string | null = null;

const subs = new Set<() => void>();
let snap = { on: readPref(), active: false, problem: null as string | null };
const changed = () => { snap = { on: readPref(), active: !!chain, problem: failed }; for (const f of subs) f(); };

function readPref(): boolean { try { return localStorage.getItem(PREF_KEY) !== 'off'; } catch { return true; } }

/** The person's choice: suppression on (the default) or off. */
export function noisePref(): boolean { return readPref(); }
export function setNoisePref(on: boolean): void {
  try { localStorage.setItem(PREF_KEY, on ? 'on' : 'off'); } catch { /* private mode */ }
  changed();
}

/** For the sound menu: chosen, running now, and why it could not start. */
export const useNoise = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => snap);

const base = () => new URL('./noise/', location.href).href;

/** The microphone through RNNoise: returns the cleaned track (the raw one is kept to switch back). */
export async function processMic(raw: MediaStreamTrack): Promise<MediaStreamTrack> {
  if (chain?.raw === raw) return chain.out;
  releaseNoise(false);
  const ctx = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
  try {
    wasm ??= loadRnnoise({ url: `${base()}rnnoise.wasm`, simdUrl: `${base()}rnnoise_simd.wasm` });
    const binary = await wasm;
    await ctx.audioWorklet.addModule(`${base()}rnnoiseWorklet.js`);
    const node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: binary });
    const dest = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(new MediaStream([raw])).connect(node).connect(dest);
    const out = dest.stream.getAudioTracks()[0];
    out.enabled = raw.enabled;
    // the browser's own (milder) suppressor would only fight RNNoise: echo cancelling and gain stay
    void raw.applyConstraints({ noiseSuppression: false, echoCancellation: true, autoGainControl: true }).catch(() => {});
    chain = { ctx, raw, node, out };
    failed = null;
    changed();
    return out;
  } catch (err) {
    void ctx.close().catch(() => {});
    wasm = null;
    failed = `Noise suppression could not start on this PC (${(err as Error).message}).`;
    changed();
    throw err;
  }
}

/** The microphone as it comes from the device, while suppression runs. */
export function rawMic(): MediaStreamTrack | null { return chain?.raw ?? null; }
export function isProcessed(track: MediaStreamTrack | undefined): boolean { return !!track && chain?.out === track; }

/** In a stream about to be used in a Room: put the cleaned microphone in place of the raw one. */
export async function suppressNoise(stream: MediaStream): Promise<void> {
  if (!readPref()) return;
  const raw = stream.getAudioTracks()[0];
  if (!raw || isProcessed(raw)) return;
  const out = await processMic(raw);
  stream.removeTrack(raw);
  stream.addTrack(out);
}

/** Stop suppressing (the Room ended, or it was turned off); the raw microphone is stopped too unless kept. */
export function releaseNoise(stopRaw = true): void {
  const c = chain;
  if (!c) return;
  chain = null;
  try { c.node.destroy(); } catch { /* already gone */ }
  c.out.stop();
  if (stopRaw) c.raw.stop();
  else void c.raw.applyConstraints({ noiseSuppression: true }).catch(() => {});
  void c.ctx.close().catch(() => {});
  changed();
}
