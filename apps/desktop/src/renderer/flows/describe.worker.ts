// The Automations drafter's sentence model, in a worker so the window never waits on it. It turns
// a clause and each candidate's example phrases into embeddings (all-MiniLM-L6-v2, quantized, on the
// CPU through the ONNX runtime's WebAssembly build) and answers with cosine similarities. The model
// and the runtime ship with the app (see flowModelAssets in vite.config.ts); nothing is downloaded.
import * as ort from 'onnxruntime-web/webgpu';
// the runtime's WebAssembly, emitted by the build as one of the app's own files
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';

type In =
  | { type: 'init'; base: string }
  | { type: 'rank'; id: number; clause: string; candidates: Array<{ kind: string; examples: string[] }> };

type Embed = (text: string | string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ data: Float32Array; dims: number[] }>;

let embed: Embed | null = null;
let loading: Promise<void> | null = null;
const cache = new Map<string, Float32Array>();

async function load(base: string): Promise<void> {
  // point the runtime at the copy in the app before transformers.js looks for one
  ort.env.wasm.wasmPaths = { wasm: new URL(wasmUrl, self.location.href).href };
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  const t = await import('@huggingface/transformers');
  t.env.allowRemoteModels = false;
  t.env.allowLocalModels = true;
  t.env.localModelPath = `${base}models/`;
  t.env.useBrowserCache = false;
  t.env.useWasmCache = false;
  const pipe = await t.pipeline('feature-extraction', 'all-MiniLM-L6-v2', { dtype: 'q8', device: 'wasm' });
  embed = pipe as unknown as Embed;
}

async function vectors(texts: string[]): Promise<Float32Array[]> {
  const missing = [...new Set(texts.filter((t) => !cache.has(t)))];
  if (missing.length) {
    const out = await embed!(missing, { pooling: 'mean', normalize: true });
    const dim = out.dims[out.dims.length - 1];
    missing.forEach((t, i) => cache.set(t, out.data.slice(i * dim, (i + 1) * dim)));
    if (cache.size > 2000) cache.clear();
  }
  return texts.map((t) => cache.get(t)!);
}

const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

self.onmessage = async (e: MessageEvent<In>) => {
  const m = e.data;
  if (m.type === 'init') {
    loading ??= load(m.base);
    try {
      await loading;
      (self as unknown as Worker).postMessage({ type: 'ready' });
    } catch (err) {
      loading = null;
      (self as unknown as Worker).postMessage({ type: 'failed', message: String((err as Error)?.message ?? err) });
    }
    return;
  }
  if (m.type === 'rank') {
    try {
      if (!embed) throw new Error('The model is not loaded.');
      const [q] = await vectors([m.clause]);
      const sims: number[] = [];
      for (const c of m.candidates) {
        const ex = await vectors(c.examples);
        sims.push(Math.max(...ex.map((v) => dot(q, v))));
      }
      (self as unknown as Worker).postMessage({ type: 'ranked', id: m.id, sims });
    } catch (err) {
      (self as unknown as Worker).postMessage({ type: 'ranked', id: m.id, error: String((err as Error)?.message ?? err) });
    }
  }
};
