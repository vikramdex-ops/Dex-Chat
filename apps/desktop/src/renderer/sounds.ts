// Notification sounds, generated with WebAudio: no audio files ship with the app.
import type { MessageSound } from '../shared/bridge.ts';

let ctx: AudioContext | null = null;
let last = 0;

const TONES: Record<Exclude<MessageSound, 'none'>, Array<{ f: number; at: number; len: number; type?: OscillatorType }>> = {
  // two rising notes, like a drafting pen tapped twice
  chime: [{ f: 880, at: 0, len: 0.16 }, { f: 1318.5, at: 0.11, len: 0.26 }],
  // one short soft click
  tick: [{ f: 1600, at: 0, len: 0.05, type: 'triangle' }],
  // a falling drop
  drop: [{ f: 1046.5, at: 0, len: 0.09 }, { f: 659.3, at: 0.07, len: 0.22 }],
};

/** Play a notification sound (no more than one every 900 ms, so a burst of messages stays calm). */
export function playSound(kind: MessageSound, volume = 0.6, force = false): void {
  if (kind === 'none') return;
  const now = Date.now();
  if (!force && now - last < 900) return;
  last = now;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const t0 = ctx.currentTime + 0.01;
    for (const n of TONES[kind]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = n.type ?? 'sine';
      osc.frequency.value = n.f;
      gain.gain.setValueAtTime(0, t0 + n.at);
      gain.gain.linearRampToValueAtTime(0.22 * volume, t0 + n.at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.len);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + n.at);
      osc.stop(t0 + n.at + n.len + 0.02);
    }
  } catch { /* no audio device */ }
}
