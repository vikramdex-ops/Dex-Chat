// Writing boxes that grow with what is written: a one-line box becomes a few ruled lines as the
// text wraps, up to a limit, and then scrolls. Enter sends and Shift+Enter starts a new line,
// except while an input method (Hindi, Tamil, Japanese…) is still composing a word: then Enter
// belongs to the input method. Shared by the app's meeting chat and the browser meeting page;
// any other composer can use it too.

/** Lines a growing box shows before it scrolls. */
export const GROW_MAX_LINES = 6;

export interface GrowMetrics {
  /** The text's full height inside the box (Element.scrollHeight, padding included). */
  scrollHeight: number;
  /** One line of text, in px. */
  lineHeight: number;
  /** Top and bottom padding together. */
  padY: number;
  /** Top and bottom border together. */
  borderY: number;
  /** box-sizing: border-box (the height includes padding and border). */
  borderBox: boolean;
  maxLines: number;
  /** The box is never shorter than this (its CSS min-height), in px. */
  minHeight?: number;
}

/**
 * The height to give a growing box for its text, whether it must scroll, and whether it is past
 * one line (it then takes its multi-line look).
 */
export function growHeight(m: GrowMetrics): { height: number; scroll: boolean; multi: boolean } {
  const lh = m.lineHeight > 0 && Number.isFinite(m.lineHeight) ? m.lineHeight : 20;
  // the text's own height (scrollHeight counts the padding, never the border)
  const content = Math.max(0, (Number.isFinite(m.scrollHeight) ? m.scrollHeight : 0) - m.padY);
  const max = Math.max(1, Math.floor(m.maxLines)) * lh;
  const inner = Math.min(content, max);
  // CSS height (and min-height) count padding and border in border-box, neither in content-box
  const height = Math.max(m.minHeight ?? 0, Math.ceil(inner + (m.borderBox ? m.padY + m.borderY : 0)));
  return { height, scroll: content > max + 1, multi: Math.round(content / lh) > 1 };
}

/** What a key press in a growing box does: send the message, or nothing special (a new line, or the input method's). */
export function enterAction(e: { key: string; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; isComposing?: boolean; keyCode?: number }): 'send' | null {
  if (e.key !== 'Enter') return null;
  // an input method is choosing a word: Enter confirms it, it does not send (229: Chromium and Safari during composition)
  if (e.isComposing || e.keyCode === 229) return null;
  if (e.shiftKey || e.altKey) return null;
  return 'send';
}

/** Fit a textarea to its text now (call it after the text changes, and when its width changes). */
export function fitTextarea(el: HTMLTextAreaElement, maxLines = GROW_MAX_LINES): void {
  const cs = getComputedStyle(el);
  const px = (v: string) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const fontSize = px(cs.fontSize) || 14;
  const lineHeight = cs.lineHeight === 'normal' ? fontSize * 1.35 : px(cs.lineHeight) || fontSize * 1.35;
  el.style.height = 'auto';
  // 'auto' makes a textarea as tall as its rows: measure the text from there
  const { height, scroll, multi } = growHeight({
    scrollHeight: el.scrollHeight, lineHeight, padY: px(cs.paddingTop) + px(cs.paddingBottom), borderY: px(cs.borderTopWidth) + px(cs.borderBottomWidth),
    borderBox: cs.boxSizing === 'border-box', maxLines, minHeight: px(cs.minHeight),
  });
  el.style.height = `${height}px`;
  // the ruled lines of a grown box follow its line height
  el.style.setProperty('--grow-lh', `${lineHeight}px`);
  el.style.overflowY = scroll ? 'auto' : 'hidden';
  el.classList.toggle('grown', multi);
}

/**
 * Keep a textarea fitted: on input and when its width changes (the panel is resized). Returns a
 * function that stops watching. Call `fit()` yourself after setting its value from code.
 */
export function autoGrow(el: HTMLTextAreaElement, maxLines = GROW_MAX_LINES): { fit(): void; stop(): void } {
  const fit = () => fitTextarea(el, maxLines);
  el.addEventListener('input', fit);
  let width = 0;
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => {
    const w = Math.round(entries[0]?.contentRect.width ?? 0);
    if (w && w !== width) { width = w; fit(); }
  }) : null;
  ro?.observe(el);
  fit();
  return { fit, stop: () => { el.removeEventListener('input', fit); ro?.disconnect(); } };
}
