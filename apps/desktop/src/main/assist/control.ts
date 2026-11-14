// The requester's side of remote control, in the main process: only while the requester has said
// yes, every event from the technician goes through the input gate (rate limit, blocked chords,
// held-key tracking), is mapped onto the shared display and handed to the platform's injector.
// Taking control back releases anything the technician was holding down.
import { InputGate, decodeInputBatch } from '@dex/core/assist';
import type { InputEvent, Rect } from '@dex/core/assist';
import { helperCommands } from './windows.ts';
import type { WindowsHelper } from './windows.ts';
import { xdotoolCommands } from './linux.ts';
import type { Xdotool } from './linux.ts';

export interface InputSink {
  /** Get ready to inject (start a helper); rejects when this PC cannot. */
  prepare(): Promise<void>;
  send(ev: InputEvent, rect: Rect): void;
  stop(): void;
}

export function windowsSink(helper: WindowsHelper): InputSink {
  return {
    prepare: async () => { await helper.start(); },
    send: (ev, rect) => helper.send(helperCommands(ev, rect)),
    stop: () => helper.stop(),
  };
}

export function xdotoolSink(x: Xdotool): InputSink {
  return { prepare: async () => {}, send: (ev, rect) => x.send(xdotoolCommands(ev, rect)), stop: () => x.stop() };
}

export class RemoteControl {
  readonly gate = new InputGate();
  private rect: Rect | null = null;
  private readonly sink: InputSink;
  private readonly log: (level: 'info' | 'warn', msg: string, extra?: Record<string, unknown>) => void;
  private blocked = 0;
  private injected = 0;

  constructor(sink: InputSink, log: RemoteControl['log']) {
    this.sink = sink;
    this.log = log;
  }

  get active(): boolean { return this.gate.enabled; }

  /** The shared display, in the injector's pixels. */
  setDisplay(rect: Rect | null): void {
    this.rect = rect;
    if (!rect && this.active) this.revoke('the shared screen went away');
  }

  /** The requester said yes. */
  async grant(): Promise<void> {
    if (!this.rect) throw new Error('Share your whole screen first.');
    await this.sink.prepare();
    this.gate.set(true);
    this.blocked = 0;
    this.injected = 0;
    this.log('info', 'remote control granted', { display: `${this.rect.width}x${this.rect.height}@${this.rect.x},${this.rect.y}` });
  }

  /** The requester (or the hotkey, or the end of the session) took control back. */
  revoke(why: string): void {
    if (!this.gate.enabled) return;
    const releases = this.gate.set(false);
    if (this.rect) for (const ev of releases) this.sink.send(ev, this.rect);
    this.sink.stop();
    this.log('info', 'remote control stopped', { why, injected: this.injected, blocked: this.blocked });
  }

  /** A message from the technician ({ k: 'in', e: [...] }). Returns how many events reached the input. */
  input(raw: unknown, now = Date.now()): number {
    if (!this.gate.enabled || !this.rect) return 0;
    let n = 0;
    for (const ev of decodeInputBatch(raw)) {
      const r = this.gate.accept(ev, now);
      if (r.ok) { this.sink.send(r.ev, this.rect); n++; continue; }
      if (r.reason === 'chord') { this.blocked++; this.log('warn', 'blocked a system key combination from the technician', { chord: r.detail ?? '' }); }
    }
    this.injected += n;
    return n;
  }
}
