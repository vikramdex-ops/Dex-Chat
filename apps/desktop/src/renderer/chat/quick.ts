// The three one-click reactions on the message bar, chosen in Preferences (kept on this device).
export const QUICK_DEFAULT = ['👍', '✅', '👀'];
const KEY = 'dex-quick-reactions';
export function quickReactions(): string[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as unknown; if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'string')) return v as string[]; } catch { /* storage off */ }
  return QUICK_DEFAULT;
}
export function setQuickReactions(list: string[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 3))); } catch { /* storage off */ }
  window.dispatchEvent(new Event('dex-quick'));
}
