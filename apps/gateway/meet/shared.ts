// Small pieces both Dexterity Meet scripts use (the landing page and the meeting): elements made
// without innerHTML (the pages' CSP allows no inline styles either, so style goes through the CSS
// object model), our own line icons, and times written for the visitor.
export type Kid = Node | string | null | false | undefined;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'style') for (const decl of String(v).split(';')) { const i = decl.indexOf(':'); if (i > 0) el.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim()); }
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== false && c !== undefined) el.append(c);
  return el;
}

export const SVG_NS = 'http://www.w3.org/2000/svg';
export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, ...kids: SVGElement[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of kids) el.append(c);
  return el;
}

/** Line icons drawn for these pages: 1.6 px strokes on a 20 px grid. No handsets, no speech bubbles. */
const ICONS: Record<string, string> = {
  mic: 'M10 3a2.5 2.5 0 0 1 2.5 2.5v4a2.5 2.5 0 0 1-5 0v-4A2.5 2.5 0 0 1 10 3zM5 9.5a5 5 0 0 0 10 0M10 14.5V17M7 17h6',
  'mic-off': 'M12.5 8.5v1a2.5 2.5 0 0 1-4.2 1.8M7.5 7V5.5a2.5 2.5 0 0 1 4.6-1.4M5 9.5a5 5 0 0 0 8.4 3.6M15 9.5a5 5 0 0 1-.3 1.6M10 14.5V17M7 17h6M3 3l14 14',
  cam: 'M3 6h9a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 12 14H3a1.5 1.5 0 0 1-1.5-1.5v-5A1.5 1.5 0 0 1 3 6zM13.5 9l4-2.5v7l-4-2.5',
  'cam-off': 'M6 6h6a1.5 1.5 0 0 1 1.5 1.5v4M13.5 13.5V12.5M12 14H3a1.5 1.5 0 0 1-1.5-1.5v-5A1.5 1.5 0 0 1 3 6M13.5 9l4-2.5v7l-4-2.5M2 2l16 16',
  screen: 'M2.5 4h15v9h-15zM7 16.5h6M10 13v3.5M7.5 9.5L10 7l2.5 2.5M10 7v4.5',
  hand: 'M7 10.5V5a1.2 1.2 0 0 1 2.4 0v4.5M9.4 9V3.8a1.2 1.2 0 0 1 2.4 0V9M11.8 9V4.8a1.2 1.2 0 0 1 2.4 0v6.7a5.5 5.5 0 0 1-5.5 5.5h-.3a5 5 0 0 1-4-2l-2.2-3a1.2 1.2 0 0 1 1.9-1.5L7 12',
  react: 'M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15zM7 8h.01M13 8h.01M6.8 11.6a4 4 0 0 0 6.4 0',
  // the meeting chat: a spine with entries hanging off it, as in the app
  chat: 'M5 3v14M5 5.5h9M5 9.5h11M5 13.5h7',
  door: 'M4 17V3h8v14M12 4.5l4 1.5v11l-4-1M9.5 10h.01M2 17h16',
  x: 'M5 5l10 10M15 5L5 15',
  clip: 'M13 6.5 7.8 11.7a1.8 1.8 0 0 0 2.5 2.5l5.6-5.6a3.2 3.2 0 0 0-4.5-4.5L5.6 9.9a4.6 4.6 0 0 0 6.5 6.5L16 12.5',
  cal: 'M3.5 5h13v11.5h-13zM3.5 8.5h13M7 3v3.5M13 3v3.5M6.5 11.5h2M11 11.5h2M6.5 14h2',
  sound: 'M3 8h3l4-3.5v11L6 12H3zM13 7.5a3.5 3.5 0 0 1 0 5M15 5a7 7 0 0 1 0 10',
  key: 'M7 12.5a3.5 3.5 0 1 1 3.3-4.6H17v3h-2v2h-2.5v-2h-2.2A3.5 3.5 0 0 1 7 12.5zM6 9h.01',
  app: 'M3 4.5h14v10H3zM7 17h6M10 14.5V17M6 8l2 1.5L6 11M10 11h3',
  copy: 'M7 7h9v10H7zM4 13V3h9',
  down: 'M10 3v10M5.5 8.5L10 13l4.5-4.5M4 16.5h12',
  sun: 'M10 6.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM10 2v1.5M10 16.5V18M2 10h1.5M16.5 10H18M4.3 4.3l1.1 1.1M14.6 14.6l1.1 1.1M4.3 15.7l1.1-1.1M14.6 5.4l1.1-1.1',
  moon: 'M16 12.5A6.5 6.5 0 0 1 7.5 4a6.5 6.5 0 1 0 8.5 8.5z',
  check: 'M4.5 10.5l3.5 3.5 7.5-8',
  clock: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM10 6v4.2l2.6 1.6',
  shield: 'M10 2.5 16 5v5c0 3.6-2.5 6.5-6 7.5-3.5-1-6-3.9-6-7.5V5zM7.3 10.2l1.9 1.9 3.6-3.9',
  warn: 'M10 3.2 17.5 16h-15zM10 8v3.6M10 13.7v.4',
  arrow: 'M4 10h12M11.5 5.5L16 10l-4.5 4.5',
  globe: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM3 10h14M10 3c2 2 2.8 4.5 2.8 7s-.8 5-2.8 7c-2-2-2.8-4.5-2.8-7S8 5 10 3z',
};
export function icon(name: string, size = 18): SVGSVGElement {
  const s = svg('svg', { viewBox: '0 0 20 20', width: size, height: size, 'aria-hidden': 'true', class: 'ico' });
  s.append(svg('path', { d: ICONS[name] ?? '' }));
  return s;
}

export const pad = (n: number) => String(n).padStart(2, '0');
export const clock = (t: number, zone?: string) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', ...(zone ? { timeZone: zone } : {}) });
export const dayText = (t: number, zone?: string) => new Date(t).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', ...(zone ? { timeZone: zone } : {}) });
export const elapsed = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); const hh = Math.floor(s / 3600); return `${hh ? `${hh}:` : ''}${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`; };
/** "42 min", "1 h 05 min" */
export const lengthText = (ms: number) => { const m = Math.max(1, Math.round(ms / 60_000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${pad(m % 60)} min`; };
export const capName = (n: string) => {
  const parts = n.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return parts.length > 1 ? `${parts[0].toUpperCase()} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0].toUpperCase();
};
export const initials = (n: string) => n.trim().split(/\s+/).slice(0, 2).map((x) => x[0]?.toUpperCase() ?? '').join('') || '?';
/** A tile's colour from an id: stable, in the office's palette. */
const TINTS = ['#2a8c98', '#1e6066', '#4f7a5a', '#6b5b8c', '#8c5a3c', '#3c6e8c', '#7a6a2e', '#5c6f73'];
export const tintFor = (id: string) => { let x = 0; for (const c of id) x = (x * 31 + c.charCodeAt(0)) >>> 0; return TINTS[x % TINTS.length]; };

/** The visitor's time zone, and a short readable name for any zone ("London", "Kolkata"). */
export const localZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
export const zoneCity = (z: string) => (z.split('/').pop() ?? z).replace(/_/g, ' ');
/** Minutes a zone is ahead of UTC at a moment (to tell whether two zones differ then). */
export function zoneOffset(zone: string, t: number): number {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(t));
    const g = (k: string) => Number(p.find((x) => x.type === k)?.value ?? 0);
    return Math.round((Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute')) - Math.floor(t / 60_000) * 60_000) / 60_000);
  } catch { return 0; }
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(text: string): void {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(t);
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 5000);
}
