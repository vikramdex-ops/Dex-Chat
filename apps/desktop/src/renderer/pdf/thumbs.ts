// First-page thumbnails for PDFs in messages. A chip asks once it is on screen; thumbnails are
// drawn one at a time when the window is idle (PDF.js is loaded for the first one, not at
// start-up), and kept as small JPEGs for the rest of the session. Files that are very large,
// protected or broken keep the plain PDF tile.
import type { FileInfo } from '@dex/core';
import { fileBlob } from './source.ts';
import { openPdf } from './pdfjs.ts';

const MAX_BYTES = 40 * 1024 * 1024;
const KEEP = 240;
const WIDTH = 56;
const HEIGHT = 72;
const cache = new Map<string, Promise<string | null>>();
const urls = new Map<string, string>();
const queue: Array<() => Promise<void>> = [];
let running = false;

const idle = () => new Promise<void>((res) => { if (typeof requestIdleCallback === 'function') requestIdleCallback(() => res(), { timeout: 2500 }); else setTimeout(res, 200); });

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      await idle();
      await queue.shift()!().catch(() => {});
    }
  } finally { running = false; }
}

async function draw(f: Pick<FileInfo, 'id' | 'name'>): Promise<string | null> {
  const { doc } = await openPdf(await fileBlob(f), async () => null);
  try {
    const page = await doc.getPage(1);
    const vp1 = page.getViewport({ scale: 1 });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // fit the chip's tile, the top of the page first (a title block is at the bottom right, but the drawing is recognisable whole)
    const scale = Math.min((WIDTH * dpr) / vp1.width, (HEIGHT * dpr) / vp1.height) * 1.5;
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(vp.width));
    canvas.height = Math.max(1, Math.round(vp.height));
    await page.render({ canvas, viewport: vp, background: '#ffffff' }).promise;
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.84));
    canvas.width = 0;
    canvas.height = 0;
    return blob ? URL.createObjectURL(blob) : null;
  } finally {
    void doc.loadingTask.destroy().catch(() => {});
  }
}

/** The first page of a PDF as an image URL, or null when there is none to show. */
export function chipThumbnail(f: Pick<FileInfo, 'id' | 'name' | 'size'>): Promise<string | null> {
  if (!f.id || f.size > MAX_BYTES) return Promise.resolve(null);
  const have = cache.get(f.id);
  if (have) return have;
  const p = new Promise<string | null>((resolve) => {
    queue.push(async () => {
      try {
        const url = await draw(f);
        if (url) {
          urls.set(f.id, url);
          if (urls.size > KEEP) {
            const [old, oldUrl] = urls.entries().next().value!;
            urls.delete(old);
            cache.delete(old);
            URL.revokeObjectURL(oldUrl);
          }
        }
        resolve(url);
      } catch { resolve(null); }
    });
    void pump();
  });
  cache.set(f.id, p);
  return p;
}
