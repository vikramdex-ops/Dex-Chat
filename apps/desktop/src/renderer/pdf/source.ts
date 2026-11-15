// Where the viewer's bytes come from, and where Download and "Open in the default app" send
// them. The viewer itself only ever sees a Blob or an ArrayBuffer, so it does not care whether a
// file was downloaded from the hub as it is or decrypted on this device first.
import type { FileInfo } from '@dex/core';
import type { PdfSource } from './pdfjs.ts';

/** The file's bytes: the dexfile: scheme on desktop, the phone's cached copy on phones. */
export async function fileBlob(f: Pick<FileInfo, 'id' | 'name'>): Promise<Blob> {
  const url = window.dex.fileUrl ? await window.dex.fileUrl(f.id, f.name) : `dexfile://f/${f.id}`;
  const r = await fetch(url);
  if (r.status === 404) throw new Error('That file is no longer available.');
  if (!r.ok) throw new Error(`The file could not be loaded (${r.status}).`);
  return r.blob();
}

const toBuffer = async (b: PdfSource): Promise<ArrayBuffer> => (b instanceof Blob ? b.arrayBuffer() : b instanceof Uint8Array ? b.slice().buffer : b);

export interface FileCommands {
  download: (bytes?: PdfSource | null) => Promise<void>;
  openExternal: (bytes?: PdfSource | null) => Promise<void>;
  canDownload: boolean;
  canOpen: boolean;
}

/** Download (to Downloads) and Open in the default app (a temporary copy on desktop). */
export function fileCommands(f: Pick<FileInfo, 'id' | 'name'>): FileCommands {
  const d = window.dex;
  return {
    canDownload: !!(d.saveCopy || d.saveFile),
    canOpen: !!(d.openCopy || d.openFile),
    download: async (bytes) => {
      if (d.saveCopy) { await d.saveCopy(f.name, bytes ? { data: await toBuffer(bytes) } : { id: f.id }); return; }
      if (d.saveFile) { await d.saveFile(f.id, f.name); return; }
      throw new Error('Files can be saved from the PC app.');
    },
    openExternal: async (bytes) => {
      if (d.openCopy) { await d.openCopy(f.name, bytes ? { data: await toBuffer(bytes) } : { id: f.id }); return; }
      if (d.openFile) { await d.openFile(f.id, f.name); return; }
      throw new Error('Files can be opened from the PC app.');
    },
  };
}
