// "Send by email": the invitation as a draft for the PC's mail program. The window builds the
// .eml (packages/core/src/eml.ts); this writes it to a temporary folder and opens it with the
// program the system uses for .eml files (Outlook, Windows Mail and Thunderbird open it as an
// unsent message thanks to "X-Unsent: 1"). Drafts older than a day are removed at start-up.
// mailto: links (the fallback) are opened here too, and nothing else.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const draftRoot = () => path.join(os.tmpdir(), 'dexterity-connect-mail');
const MAX = 2 * 1024 * 1024;
const safeName = (n: string) => String(n || 'Invitation').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').trim().slice(0, 100) || 'Invitation';

export interface DraftDeps {
  open: (p: string) => Promise<string>;
  /** TEST ONLY: record instead of opening (see drives.ts's test hook). */
  record?: ((p: string) => void) | null;
}

/** Write the draft and open it; returns where it was written. Throws when nothing opens .eml files. */
export async function openMailDraft(name: string, eml: unknown, deps: DraftDeps): Promise<string> {
  if (typeof eml !== 'string' || !eml.startsWith('MIME-Version: 1.0\r\n') || !/\r\nX-Unsent: 1\r\n/.test(eml.slice(0, 4000))) throw new Error('That is not an email draft.');
  if (eml.length > MAX) throw new Error('The draft is too large.');
  const dir = path.join(draftRoot(), randomBytes(6).toString('hex'));
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${safeName(name).replace(/\.eml$/i, '')}.eml`);
  await fsp.writeFile(target, eml, 'utf8');
  if (deps.record) { deps.record(target); return target; }
  const err = await deps.open(target);
  if (err) throw new Error(`No mail program on this PC opens email drafts (${err}).`);
  return target;
}

/** Only mailto: links, of a sane length. */
export function mailtoOk(url: unknown): url is string {
  return typeof url === 'string' && url.length <= 8000 && /^mailto:[^\s]*$/i.test(url);
}

/** Remove drafts older than a day (the mail program may still hold today's). */
export async function pruneMailDrafts(now = Date.now()): Promise<void> {
  try {
    for (const d of await fsp.readdir(draftRoot())) {
      const p = path.join(draftRoot(), d);
      const st = await fsp.stat(p);
      if (st.mtimeMs < now - 24 * 3600_000) await fsp.rm(p, { recursive: true, force: true });
    }
  } catch { /* nothing there */ }
}
