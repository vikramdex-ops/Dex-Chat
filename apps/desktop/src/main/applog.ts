// The app's own log: a short memory of what happened on this PC (connection changes, warnings,
// update steps, errors in the window, help-desk sessions), kept in memory and in a small file in
// the app's folder. "Send diagnostics" in a support session includes its recent lines. Nothing
// people write (messages, notes, file names they chose) is ever logged, and anything that looks
// like a token or a code is masked before it is kept.
import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';
export type LogSource = 'main' | 'hub' | 'update' | 'renderer' | 'assist';
export interface LogLine { at: number; level: LogLevel; source: LogSource; msg: string; extra?: Record<string, string | number | boolean | null> }

const MAX_LINES = 500;
const MAX_FILE = 1024 * 1024;

/** Mask tokens, pairing and setup codes and long secrets that could slip into an error message. */
export function redact(text: string): string {
  return text
    .replace(/\bdxc_[A-Za-z0-9_-]{8,}/g, 'dxc_[masked]')
    .replace(/\bDX[CP]1-[A-Za-z0-9_-]{6,}/g, 'DX?1-[masked]')
    .replace(/([?&](?:t|token|key|sig)=)[^&\s]+/gi, '$1[masked]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [masked]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[masked]');
}

function cleanExtra(extra: Record<string, unknown> | undefined): LogLine['extra'] {
  if (!extra) return undefined;
  const out: NonNullable<LogLine['extra']> = {};
  for (const [k, v] of Object.entries(extra).slice(0, 12)) {
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
    else if (typeof v === 'string') out[k] = redact(v).slice(0, 300);
    else if (v instanceof Error) out[k] = redact(v.message).slice(0, 300);
  }
  return out;
}

export class AppLog {
  private lines: LogLine[] = [];
  private file: string | null = null;
  private pending: string[] = [];
  private writing = false;

  /** Also keep the log in this file (rotated to .1 at 1 MB). */
  toFile(file: string): void {
    this.file = file;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* the memory log still works */ }
  }

  write(level: LogLevel, source: LogSource, msg: string, extra?: Record<string, unknown>): void {
    const line: LogLine = { at: Date.now(), level, source, msg: redact(String(msg)).slice(0, 500) };
    const e = cleanExtra(extra);
    if (e && Object.keys(e).length) line.extra = e;
    this.lines.push(line);
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
    if (this.file) { this.pending.push(`${new Date(line.at).toISOString()} ${level.toUpperCase()} [${source}] ${line.msg}${line.extra ? ` ${JSON.stringify(line.extra)}` : ''}\n`); void this.flush(); }
  }

  info(source: LogSource, msg: string, extra?: Record<string, unknown>): void { this.write('info', source, msg, extra); }
  warn(source: LogSource, msg: string, extra?: Record<string, unknown>): void { this.write('warn', source, msg, extra); }
  error(source: LogSource, msg: string, extra?: Record<string, unknown>): void { this.write('error', source, msg, extra); }

  /** The latest lines, oldest first. */
  recent(n = 200, source?: LogSource): LogLine[] {
    const list = source ? this.lines.filter((l) => l.source === source) : this.lines;
    return list.slice(-n).map((l) => ({ ...l, ...(l.extra ? { extra: { ...l.extra } } : {}) }));
  }

  private async flush(): Promise<void> {
    if (this.writing || !this.file) return;
    this.writing = true;
    try {
      while (this.pending.length) {
        const chunk = this.pending.splice(0).join('');
        try {
          const st = await fs.promises.stat(this.file).catch(() => null);
          if (st && st.size > MAX_FILE) await fs.promises.rename(this.file, `${this.file}.1`).catch(() => {});
          await fs.promises.appendFile(this.file, chunk);
        } catch { /* a full or read-only disk: the memory log is enough */ }
      }
    } finally { this.writing = false; }
  }
}

/** The one log of this app. */
export const appLog = new AppLog();
