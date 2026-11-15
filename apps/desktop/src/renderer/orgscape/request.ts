// Ask the Directory to open the office drawing at someone (from Pulse, a profile, a link). The
// Directory may not be on screen yet, so the request waits until it is taken.
let pending: string | null = null;
const listeners = new Set<(id: string) => void>();

export function requestChart(userId: string): void {
  pending = userId;
  for (const l of listeners) l(userId);
}

/** The person the drawing was asked to open at, once. */
export function takeChartRequest(): string | null {
  const p = pending;
  pending = null;
  return p;
}

export function onChartRequest(f: (id: string) => void): () => void {
  listeners.add(f);
  return () => { listeners.delete(f); };
}
