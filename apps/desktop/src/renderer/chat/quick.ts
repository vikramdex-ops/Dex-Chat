// Stamps: up to four reactions kept on hand in the Stamp flyout of the spine tool column,
// chosen in Preferences ("Stamps on hand") and kept on this device.
export const MAX_STAMPS = 4;
export const STAMPS_DEFAULT = ['👍', '✅', '👀', '🙏'];
const KEY = 'dex-quick-reactions';

export function stampsOnHand(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as unknown;
    if (Array.isArray(v) && v.length <= MAX_STAMPS && v.every((x) => typeof x === 'string' && x.length > 0)) return v as string[];
  } catch { /* storage off */ }
  return STAMPS_DEFAULT;
}

export function setStampsOnHand(list: string[]): void {
  const clean = [...new Set(list.filter(Boolean))].slice(0, MAX_STAMPS);
  try { localStorage.setItem(KEY, JSON.stringify(clean)); } catch { /* storage off */ }
  window.dispatchEvent(new Event('dex-stamps'));
}
