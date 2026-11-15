// The file viewer's "Open in the default app" and "Download" for bytes the window already has
// (a PDF it is showing, a file it decrypted). Opening goes through a temporary copy, so another
// program editing or locking the file cannot touch the cached original; the copies are removed
// when the app starts again.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { app, shell } from 'electron';

const tempRoot = () => path.join(os.tmpdir(), 'dexterity-connect-open');
const safeName = (n: string) => String(n || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').slice(0, 150) || 'file';
const MAX_BYTES = 2 * 1024 * 1024 * 1024;

export interface ViewerSource { data?: ArrayBuffer | Uint8Array; path?: string }

async function writeFrom(src: ViewerSource, target: string): Promise<void> {
  if (src.data instanceof ArrayBuffer || ArrayBuffer.isView(src.data)) {
    const bytes = src.data instanceof ArrayBuffer ? new Uint8Array(src.data) : new Uint8Array(src.data.buffer, src.data.byteOffset, src.data.byteLength);
    if (bytes.byteLength > MAX_BYTES) throw new Error('That file is too large to copy.');
    await fsp.writeFile(target, bytes);
  } else if (typeof src.path === 'string' && src.path) {
    await fsp.copyFile(src.path, target);
  } else {
    throw new Error('There is nothing to open.');
  }
}

/** Write a temporary copy and open it with the program the system uses for its type. */
export async function openTempCopy(name: string, src: ViewerSource): Promise<void> {
  const dir = path.join(tempRoot(), randomBytes(6).toString('hex'));
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, safeName(name));
  await writeFrom(src, target);
  const err = await shell.openPath(target);
  if (err) { shell.showItemInFolder(target); throw new Error(`No program on this PC opens this kind of file. It is in the folder that just opened. (${err})`); }
}

/** Save into Downloads (a new name if one is taken) and show it in its folder. */
export async function saveBytes(name: string, src: ViewerSource): Promise<string> {
  const dir = app.getPath('downloads');
  const clean = safeName(name);
  const ext = path.extname(clean);
  const base = path.basename(clean, ext);
  let target = path.join(dir, clean);
  for (let i = 2; fs.existsSync(target); i++) target = path.join(dir, `${base} (${i})${ext}`);
  await writeFrom(src, target);
  shell.showItemInFolder(target);
  return target;
}

/** Remove the temporary copies of earlier runs (another program may still hold today's open). */
export async function pruneTempCopies(): Promise<void> {
  try {
    const cutoff = Date.now() - 12 * 3600_000;
    for (const d of await fsp.readdir(tempRoot())) {
      const p = path.join(tempRoot(), d);
      const st = await fsp.stat(p);
      if (st.mtimeMs < cutoff) await fsp.rm(p, { recursive: true, force: true });
    }
  } catch { /* nothing there */ }
}
