// "Open folder" on a link card: shows a folder on the office share (\\server\share\…) or a
// drive (D:\…) in Explorer. Only folders that exist are opened; files, other kinds of paths and
// anything that is not a plain Windows path are refused, so a message can never start a program.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_PATH = 1024;
const BAD = /[<>"|?*:\u0000-\u001f]/;

/** A path from a card as Windows writes it, or null when it is not one we open. */
export function windowsFolderPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let p = raw.trim();
  if (!p || p.length > MAX_PATH) return null;
  if (/^file:/i.test(p)) {
    try {
      const u = new URL(p);
      p = u.host ? `\\\\${u.host}${decodeURIComponent(u.pathname).replace(/\//g, '\\')}` : fileURLToPath(p, { windows: true });
    } catch { return null; }
  }
  const unc = /^\\\\[^\\/:]+\\[^\\/]+/.test(p);
  const drive = /^[A-Za-z]:\\/.test(p);
  if (!unc && !drive) return null;
  // no device paths (\\?\, \\.\), no wildcards or control characters, no climbing out with ..
  if (/^\\\\[?.]\\/.test(p) || BAD.test(p.slice(2)) || p.split(/[\\/]/).some((s) => s === '..')) return null;
  const norm = path.win32.normalize(p);
  return unc ? (norm.startsWith('\\\\') ? norm : null) : /^[A-Za-z]:\\/.test(norm) ? norm : null;
}

/** Check a folder for Open folder: a Windows share or drive path that exists and is a folder. */
export async function checkFolder(raw: unknown, platform: NodeJS.Platform = process.platform, stat: (p: string) => Promise<fs.Stats> = (p) => fs.promises.stat(p)): Promise<string> {
  const p = windowsFolderPath(raw);
  if (!p) throw new Error('Only folders on the office share (\\\\server\\share) or a drive (D:\\) can be opened.');
  if (platform !== 'win32') throw new Error('Folders on the office share open on Windows PCs.');
  let st: fs.Stats;
  try { st = await stat(p); } catch { throw new Error('That folder cannot be found from this PC. Check that you can reach the share.'); }
  if (!st.isDirectory()) throw new Error('That is a file, not a folder. Open it from the folder instead.');
  return p;
}
