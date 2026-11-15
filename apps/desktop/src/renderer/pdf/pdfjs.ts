// PDF.js (pdfjs-dist, Apache-2.0), loaded the first time a PDF is opened or a PDF's thumbnail is
// drawn, never at start-up. Its parser worker, the worker that draws pages off the main thread,
// and its fonts, character maps and image decoders are copied beside the app at build time
// (see pdf-assets.ts beside vite.config.ts), so nothing is downloaded.
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';

export type PdfLib = typeof import('pdfjs-dist');
/** What the viewer is given: the file's bytes, however the app got them (downloaded or decrypted). */
export type PdfSource = Blob | ArrayBuffer | Uint8Array;

let lib: Promise<PdfLib> | null = null;
const base = () => new URL('./pdfjs/', location.href).href;

export function loadPdfjs(): Promise<PdfLib> {
  lib ??= import('pdfjs-dist').then((m) => {
    const o = m.GlobalWorkerOptions;
    o.workerSrc = `${base()}pdf.worker.min.mjs`;
    // pages are drawn in a worker of their own where the browser can (OffscreenCanvas), so a
    // dense drawing never holds up the window
    if (typeof OffscreenCanvas !== 'undefined') o.rendererSrc = `${base()}pdf.renderer.min.mjs`;
    try {
      // one parser for every PDF, and two drawing workers (the viewer's, and the thumbnails')
      o.workerPort = new Worker(o.workerSrc, { type: 'module', name: 'pdf' });
      if (o.rendererSrc) o.rendererPorts = [0, 1].map((n) => new Worker(o.rendererSrc, { type: 'module', name: `pdf-draw-${n}` }));
    } catch { /* each document starts its own workers */ }
    return m;
  }).catch((e) => { lib = null; throw e; });
  return lib;
}

export type PdfFailure = { kind: 'password'; wrong: boolean } | { kind: 'broken'; message: string } | { kind: 'missing'; message: string };

/** Big files are read in ranges straight from the Blob rather than copied whole into memory. */
const RANGE_FROM = 4 * 1024 * 1024;

export interface OpenedPdf { doc: PDFDocumentProxy; task: PDFDocumentLoadingTask }

/**
 * Open a PDF. `askPassword` is called when the file is protected (again, with wrong = true, after
 * a password that did not work); returning null gives up.
 */
export async function openPdf(src: PdfSource, askPassword: (wrong: boolean) => Promise<string | null>): Promise<OpenedPdf> {
  const m = await loadPdfjs();
  const common = {
    cMapUrl: `${base()}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base()}standard_fonts/`,
    wasmUrl: `${base()}wasm/`,
    iccUrl: `${base()}iccs/`,
    enableXfa: false,
    // a drawing with a huge embedded scan should not take the PC's memory with it
    maxImageSize: 100_000_000,
    canvasMaxAreaInBytes: 256 * 1024 * 1024,
  };
  let task: PDFDocumentLoadingTask;
  if (src instanceof Blob && src.size > RANGE_FROM) {
    const blob = src;
    class BlobRange extends m.PDFDataRangeTransport {
      requestDataRange(begin: number, end: number): void {
        void blob.slice(begin, end).arrayBuffer().then((b) => this.onDataRange(begin, new Uint8Array(b))).catch(() => {});
      }
    }
    task = m.getDocument({ ...common, range: new BlobRange(blob.size, null), disableAutoFetch: true, disableStream: true });
  } else {
    const data = src instanceof Blob ? new Uint8Array(await src.arrayBuffer()) : src instanceof Uint8Array ? src.slice() : new Uint8Array(src.slice(0));
    task = m.getDocument({ ...common, data });
  }
  task.onPassword = (update: (pw: string) => void, reason: number) => {
    void askPassword(reason === m.PasswordResponses.INCORRECT_PASSWORD).then((pw) => {
      if (pw === null) void task.destroy(); else update(pw);
    });
  };
  const doc = await task.promise;
  return { doc, task };
}

/** What went wrong, in words for the person. */
export function describeFailure(e: unknown): PdfFailure {
  const err = e as { name?: string; message?: string };
  if (err?.name === 'PasswordException') return { kind: 'password', wrong: /incorrect/i.test(err.message ?? '') };
  if (/no longer available|not found|404/i.test(err?.message ?? '')) return { kind: 'missing', message: 'That file is no longer on the hub.' };
  return { kind: 'broken', message: 'This PDF could not be read. It may be damaged, cut short, or not a PDF at all.' };
}
