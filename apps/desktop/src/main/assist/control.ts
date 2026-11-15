// The controlled PC's side of remote control, in the main process, shared by support sessions
// (the requester lets IT in) and meetings (the presenter gives control): only while this PC's
// person has said yes, every event from the one device they allowed goes through the input gate
// (rate limit, blocked chords, held-key tracking), is mapped onto the shared display and handed to
// the platform's injector. Taking control back releases anything that was held down.
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
  /** The only device whose input is taken (null: the window already checks who it comes from). */
  private from: string | null = null;

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

  /** The device allowed to send input now (null when control is off, or any device the window passes on). */
  get allowed(): string | null { return this.gate.enabled ? this.from : null; }

  /** This PC's person said yes, to input from `from` (a device id) or from whoever the window passes on (null). */
  async grant(from: string | null = null): Promise<void> {
    if (!this.rect) throw new Error('Share your whole screen first.');
    await this.sink.prepare();
    this.gate.set(true);
    this.from = from;
    this.blocked = 0;
    this.injected = 0;
    this.log('info', 'remote control granted', { display: `${this.rect.width}x${this.rect.height}@${this.rect.x},${this.rect.y}`, ...(from ? { to: from.slice(0, 12) } : {}) });
  }

  /** The requester (or the hotkey, or the end of the session) took control back. */
  revoke(why: string): void {
    if (!this.gate.enabled) return;
    const releases = this.gate.set(false);
    if (this.rect) for (const ev of releases) this.sink.send(ev, this.rect);
    this.sink.stop();
    this.from = null;
    this.log('info', 'remote control stopped', { why, injected: this.injected, blocked: this.blocked });
  }

  /** A message from the person in control ({ k: 'in', e: [...] }), sent by `from`. Returns how many events reached the input. */
  input(raw: unknown, now = Date.now(), from: string | null = null): number {
    if (!this.gate.enabled || !this.rect) return 0;
    // anyone but the device that was allowed is ignored, whatever the window passes on
    if (this.from && from !== this.from) return 0;
    let n = 0;
    for (const ev of decodeInputBatch(raw)) {
      const r = this.gate.accept(ev, now);
      if (r.ok) { this.sink.send(r.ev, this.rect); n++; continue; }
      if (r.reason === 'chord') { this.blocked++; this.log('warn', 'blocked a system key combination from the person in control', { chord: r.detail ?? '' }); }
    }
    this.injected += n;
    return n;
  }
}
