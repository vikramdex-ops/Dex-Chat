// A textarea that grows with what is written (up to a few lines, then it scrolls), for React.
// The measuring and the Enter rule live in @dex/core/compose so the browser meeting page and any
// other composer share them: useAutoGrow(ref, value) here, autoGrow(el) and enterAction(e) there.
import { useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { GROW_MAX_LINES, autoGrow } from '@dex/core/compose';

export { enterAction } from '@dex/core/compose';

/** Keep the textarea in `ref` fitted to `value` (and to its width), up to `maxLines` lines. */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string, maxLines = GROW_MAX_LINES): void {
  const grow = useRef<ReturnType<typeof autoGrow> | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    grow.current = autoGrow(el, maxLines);
    return () => { grow.current?.stop(); grow.current = null; };
  }, [ref, maxLines]);
  // a value set from code (sent, cleared, restored) does not fire 'input'
  useLayoutEffect(() => { grow.current?.fit(); }, [value]);
}
