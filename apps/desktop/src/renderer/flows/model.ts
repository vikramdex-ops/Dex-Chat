// The on-device sentence model for Describe-to-Automation, loaded on first use in a worker. If it
// cannot load (an old PC without WebAssembly SIMD, a damaged install), drafting carries on with the
// keyword ranker and says so.
import type { Ranker } from '@dex/core/flow-describe';

export type ModelState = { phase: 'idle' | 'loading' | 'ready' } | { phase: 'failed'; reason: string };

let worker: Worker | null = null;
let state: ModelState = { phase: 'idle' };
let ready: Promise<boolean> | null = null;
let seq = 0;
const waiting = new Map<number, { resolve: (s: number[]) => void; reject: (e: Error) => void }>();
const listeners = new Set<(s: ModelState) => void>();

const set = (s: ModelState) => { state = s; for (const l of listeners) l(s); };
export const modelState = () => state;
export function onModelState(fn: (s: ModelState) => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }

/** Start loading the model (once). Resolves true when it is ready, false when it failed. */
export function loadModel(timeoutMs = 45_000): Promise<boolean> {
  if (ready) return ready;
  set({ phase: 'loading' });
  ready = new Promise<boolean>((resolve) => {
    const fail = (reason: string) => {
      set({ phase: 'failed', reason });
      worker?.terminate();
      worker = null;
      for (const w of waiting.values()) w.reject(new Error(reason));
      waiting.clear();
      resolve(false);
    };
    try {
      worker = new Worker(new URL('./describe.worker.ts', import.meta.url), { type: 'module', name: 'automations-model' });
    } catch (e) { fail(`The on-device model could not start (${(e as Error).message}).`); return; }
    const timer = setTimeout(() => fail('The on-device model took too long to load.'), timeoutMs);
    worker.onerror = (e) => { clearTimeout(timer); fail(`The on-device model could not load (${e.message || 'worker error'}).`); };
    worker.onmessage = (e: MessageEvent<{ type: string; id?: number; sims?: number[]; error?: string; message?: string }>) => {
      const m = e.data;
      if (m.type === 'ready') { clearTimeout(timer); set({ phase: 'ready' }); resolve(true); return; }
      if (m.type === 'failed') { clearTimeout(timer); fail(`The on-device model could not load (${m.message ?? 'unknown error'}).`); return; }
      if (m.type === 'ranked' && m.id !== undefined) {
        const w = waiting.get(m.id);
        waiting.delete(m.id);
        if (!w) return;
        if (m.sims) w.resolve(m.sims); else w.reject(new Error(m.error ?? 'ranking failed'));
      }
    };
    worker.postMessage({ type: 'init', base: new URL('./minilm/', location.href).href });
  });
  // a failed load can be tried again later
  void ready.then((ok) => { if (!ok) ready = null; });
  return ready;
}

/** The model as a ranker for draftFlow, or null when it is not available. */
export async function modelRanker(): Promise<Ranker | null> {
  const ok = await loadModel();
  if (!ok || !worker) return null;
  return (clause, candidates) => new Promise<number[]>((resolve, reject) => {
    if (!worker) { reject(new Error('The model stopped.')); return; }
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    worker.postMessage({ type: 'rank', id, clause, candidates });
    setTimeout(() => { if (waiting.delete(id)) reject(new Error('The model did not answer in time.')); }, 10_000);
  });
}
