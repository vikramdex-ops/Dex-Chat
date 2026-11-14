// Slate integration: a note opens in Slate (the office text editor) as a file in the app's own
// folder; when it is saved there, the new text is sent back to the note. Falls back to the
// system's default editor for .md files when Slate is not installed.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { app, shell } from 'electron';

const watchers = new Map<string, { watcher: fs.FSWatcher; timer: ReturnType<typeof setTimeout> | null; last: string; stop: ReturnType<typeof setTimeout> }>();

export function slateExe(): string | null {
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Slate', 'slate.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Slate', 'slate.exe'),
  ].filter(Boolean) as string[];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

const safe = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 80) || 'Note';

export async function editInSlate(noteId: string, title: string, body: string, onChange: (noteId: string, text: string) => void): Promise<'slate' | 'default'> {
  if (!/^[0-9A-Z]{26}$/.test(noteId)) throw new Error('Save the note first.');
  const dir = path.join(app.getPath('userData'), 'notes', noteId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safe(title)}.md`);
  fs.writeFileSync(file, body, 'utf8');
  watch(noteId, file, body, onChange);
  const exe = slateExe();
  if (exe) {
    const child = spawn(exe, [file], { detached: true, stdio: 'ignore' });
    child.on('error', () => void shell.openPath(file));
    child.unref();
    return 'slate';
  }
  const err = await shell.openPath(file);
  if (err) throw new Error(`Could not open an editor: ${err}`);
  return 'default';
}

function watch(noteId: string, file: string, initial: string, onChange: (noteId: string, text: string) => void): void {
  watchers.get(noteId)?.watcher.close();
  const entry = {
    watcher: fs.watch(path.dirname(file), () => {
      if (entry.timer) clearTimeout(entry.timer);
      // editors save in several steps; read once things settle
      entry.timer = setTimeout(() => {
        let text: string;
        try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
        if (text === entry.last) return;
        entry.last = text;
        onChange(noteId, text.replace(/\r\n/g, '\n'));
      }, 400);
    }),
    timer: null as ReturnType<typeof setTimeout> | null,
    last: initial,
    // stop listening after a working day
    stop: setTimeout(() => stopWatching(noteId), 10 * 3600_000),
  };
  watchers.set(noteId, entry);
}

export function stopWatching(noteId?: string): void {
  for (const [id, w] of watchers) {
    if (noteId && id !== noteId) continue;
    w.watcher.close();
    if (w.timer) clearTimeout(w.timer);
    clearTimeout(w.stop);
    watchers.delete(id);
  }
}
