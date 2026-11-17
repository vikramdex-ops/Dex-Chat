// Which part of the Control room a link opens (dexconnect://admin/holidays): kept here, outside the
// Control room's own code, which is loaded only when it is first opened.
const ALIAS: Record<string, { tab: string; anchor?: string }> = { holidays: { tab: 'bots', anchor: 'office-holidays' } };
let pending: string | null = null;
const listeners = new Set<(tab: string) => void>();

export function requestAdminTab(name: string): void {
  const a = ALIAS[name] ?? { tab: name };
  pending = a.tab;
  for (const l of listeners) l(a.tab);
  if (a.anchor) {
    const id = a.anchor;
    // once the tab is drawn
    let tries = 0;
    const find = () => { const el = document.getElementById(id); if (el) el.scrollIntoView({ block: 'start' }); else if (tries++ < 20) setTimeout(find, 100); };
    setTimeout(find, 50);
  }
}
/** The tab a link asked for (once). */
export function takeAdminTab(): string | null { const t = pending; pending = null; return t; }
export function onAdminTab(fn: (tab: string) => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
