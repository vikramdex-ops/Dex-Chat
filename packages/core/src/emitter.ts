// Minimal event emitter that runs anywhere (Node, Electron renderer, Android WebView).
type Listener = (...args: any[]) => void;

export class Emitter {
  private readonly listeners = new Map<string, Set<Listener>>();

  on(event: string, fn: Listener): this {
    let set = this.listeners.get(event);
    if (!set) { set = new Set(); this.listeners.set(event, set); }
    set.add(fn);
    return this;
  }

  off(event: string, fn: Listener): this {
    this.listeners.get(event)?.delete(fn);
    return this;
  }

  once(event: string, fn: Listener): this {
    const wrap: Listener = (...args) => { this.off(event, wrap); fn(...args); };
    return this.on(event, wrap);
  }

  emit(event: string, ...args: unknown[]): boolean {
    const set = this.listeners.get(event);
    if (!set?.size) return false;
    for (const fn of [...set]) fn(...args);
    return true;
  }

  removeAllListeners(event?: string): this {
    if (event) this.listeners.delete(event); else this.listeners.clear();
    return this;
  }
}
