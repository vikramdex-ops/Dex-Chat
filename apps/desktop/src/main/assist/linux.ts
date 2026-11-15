// Remote control on Linux (X11): xdotool, when it is installed, kept running and fed one command
// per line on stdin ("xdotool -" reads a script as it arrives). Wayland desktops do not let one
// program move another's pointer, so control is not offered there.
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { KEYS, toScreen } from '@dex/core/assist';
import type { InputEvent, Rect } from '@dex/core/assist';

const BUTTON = { left: 1, middle: 2, right: 3 } as const;

/** xdotool's script lines for one input event, for a display at `rect` (X pixels). */
export function xdotoolCommands(ev: InputEvent, rect: Rect): string[] {
  const at = (x: number, y: number) => (x < 0 || y < 0 ? null : toScreen(x, y, rect));
  const move = (p: { x: number; y: number } | null) => (p ? [`mousemove ${p.x} ${p.y}`] : []);
  switch (ev.t) {
    case 'move': return move(at(ev.x, ev.y));
    case 'button': return [...move(at(ev.x, ev.y)), `${ev.down ? 'mousedown' : 'mouseup'} ${BUTTON[ev.b]}`];
    case 'wheel': {
      const out = move(at(ev.x, ev.y));
      // buttons 4/5 scroll up/down, 6/7 left/right, one click per notch
      if (ev.dy) out.push(`click --repeat ${Math.abs(ev.dy)} ${ev.dy > 0 ? 5 : 4}`);
      if (ev.dx) out.push(`click --repeat ${Math.abs(ev.dx)} ${ev.dx > 0 ? 7 : 6}`);
      return out;
    }
    case 'key': {
      const k = KEYS[ev.code];
      return k ? [`${ev.down ? 'keydown' : 'keyup'} ${k.x}`] : [];
    }
  }
}

/** Can this Linux session take remote input? */
export function xdotoolAvailable(env: NodeJS.ProcessEnv = process.env): { ok: boolean; reason: string | null } {
  if (env.XDG_SESSION_TYPE === 'wayland' && !env.DISPLAY) return { ok: false, reason: 'This Wayland desktop does not let other programs use the pointer, so remote control is not offered.' };
  if (!env.DISPLAY) return { ok: false, reason: 'No X display: remote control is not offered.' };
  const r = spawnSync('xdotool', ['version'], { encoding: 'utf8', timeout: 3000 });
  if (r.error || r.status !== 0) return { ok: false, reason: 'Remote control on Linux needs xdotool (sudo apt install xdotool).' };
  return { ok: true, reason: null };
}

export class Xdotool {
  private proc: ChildProcessWithoutNullStreams | null = null;
  onError: (msg: string) => void = () => {};

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc;
    const p = spawn('xdotool', ['-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (d: string) => this.onError(d.trim().slice(0, 300)));
    p.stdout.resume();
    p.on('error', (e) => { this.onError(e.message); this.proc = null; });
    p.on('exit', () => { if (this.proc === p) this.proc = null; });
    this.proc = p;
    return p;
  }

  send(lines: string[]): void {
    if (!lines.length) return;
    try { this.ensure().stdin.write(`${lines.join('\n')}\n`); } catch (e) { this.onError((e as Error).message); this.proc = null; }
  }

  stop(): void {
    const p = this.proc;
    this.proc = null;
    if (!p) return;
    try { p.stdin.end(); } catch { /* gone */ }
    setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 1000).unref();
  }
}
