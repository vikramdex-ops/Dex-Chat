// Long lists (a Desk with hundreds of reminders, the agenda, the Directory) appear at once with
// their first rows, and the rest follow over the next frames as low-priority work, so opening a
// lens never waits for rows below the fold and the keyboard and mouse stay answered meanwhile.
import { startTransition, useEffect, useState } from 'react';

/** The first `first` items now, then `step` more each frame until all are shown. */
export function useProgressive<T>(items: readonly T[], first = 40, step = 120): readonly T[] {
  const [n, setN] = useState(first);
  const more = n < items.length;
  useEffect(() => {
    if (!more) return;
    const id = requestAnimationFrame(() => startTransition(() => setN((x) => x + step)));
    return () => cancelAnimationFrame(id);
  }, [more, n, step]);
  return more ? items.slice(0, n) : items;
}
