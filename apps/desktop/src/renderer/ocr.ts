// Reading text in images, on this PC: pictures you send to a Space are read in the background
// and the text is given to the hub so search finds "V-2201" in a photo of a nameplate. Images in
// Direct conversations are never read for the hub. The engine and English model ship with the app.
import type { FileInfo } from '@dex/core';

type Job = { file: FileInfo; convKind: 'space' | 'direct' };
const queue: Job[] = [];
let running = false;
let worker: { recognize: (img: Blob) => Promise<{ data: { text: string } }>; terminate: () => Promise<unknown> } | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let disabled = false;

const IMAGE = /^image\/(png|jpeg|webp|bmp|gif)$/;
const MAX_BYTES = 12 * 1024 * 1024;

async function getWorker() {
  if (worker) return worker;
  const { createWorker, OEM } = await import('tesseract.js');
  const base = new URL('./ocr/', location.href).href;
  worker = await createWorker('eng', OEM.LSTM_ONLY, {
    workerPath: `${base}worker.min.js`,
    corePath: `${base}tesseract-core-simd-lstm.wasm.js`,
    langPath: base.replace(/\/$/, ''),
    gzip: true,
    cacheMethod: 'none',
    workerBlobURL: false,
  }) as unknown as typeof worker;
  return worker!;
}

async function run(): Promise<void> {
  if (running || disabled) return;
  running = true;
  if (idleTimer) clearTimeout(idleTimer);
  try {
    while (queue.length) {
      const job = queue.shift()!;
      if (job.convKind !== 'space' || !IMAGE.test(job.file.mime) || job.file.size > MAX_BYTES) continue;
      try {
        const url = window.dex.fileUrl ? await window.dex.fileUrl(job.file.id, job.file.name) : `dexfile://f/${job.file.id}`;
        const blob = await (await fetch(url)).blob();
        const w = await getWorker();
        const { data } = await w.recognize(blob);
        const text = data.text.replace(/\s+\n/g, '\n').trim();
        // only keep it when it looks like words, not noise from a photo
        if ((text.match(/[A-Za-z0-9]{3,}/g) ?? []).length >= 2) await window.dex.request('file.setText', { fileId: job.file.id, text });
      } catch (e) {
        if (/Failed to load|wasm|Worker/i.test(String((e as Error).message))) { disabled = true; console.warn('Text in images is not available on this PC:', e); return; }
      }
    }
  } finally {
    running = false;
    // free the engine's memory after a quiet minute
    idleTimer = setTimeout(() => { void worker?.terminate(); worker = null; }, 60_000);
  }
}

/** Read the text in these images (sent by me) in the background. */
export function readImageText(files: FileInfo[], convKind: 'space' | 'direct'): void {
  if (convKind !== 'space' || /Android/i.test(navigator.userAgent)) return;
  for (const file of files) if (IMAGE.test(file.mime)) queue.push({ file, convKind });
  if (queue.length) setTimeout(() => void run(), 1500);
}
