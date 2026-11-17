// Small DOM helpers for the webinar pages: elements without innerHTML (the page's CSP allows no
// inline styles, so style goes through the CSS object model) and line icons drawn for the page.
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

const SVG_NS = 'http://www.w3.org/2000/svg';
/** 1.6 px strokes on a 20 px grid. */
const ICONS: Record<string, string> = {
  hand: 'M7 10.5V5a1.2 1.2 0 0 1 2.4 0v4.5M9.4 9V3.8a1.2 1.2 0 0 1 2.4 0V9M11.8 9V4.8a1.2 1.2 0 0 1 2.4 0v6.7a5.5 5.5 0 0 1-5.5 5.5h-.3a5 5 0 0 1-4-2l-2.2-3a1.2 1.2 0 0 1 1.9-1.5L7 12',
  react: 'M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15zM7 8h.01M13 8h.01M6.8 11.6a4 4 0 0 0 6.4 0',
  door: 'M4 17V3h8v14M12 4.5l4 1.5v11l-4-1M9.5 10h.01M2 17h16',
  up: 'M10 15V5M5.5 9.5L10 5l4.5 4.5',
  copy: 'M7 7h9v10H7zM4 13V3h9',
  cal: 'M3.5 5h13v11.5h-13zM3.5 8.5h13M7 3v3.5M13 3v3.5M6.5 11.5h2M11 11.5h2M6.5 14h2',
  file: 'M5 2.5h6.5l3.5 3.5v11.5H5zM11.5 2.5V6H15M7.5 10.5h5M7.5 13.5h5',
  down: 'M10 3v10M5.5 8.5L10 13l4.5-4.5M4 16.5h12',
  sound: 'M3 8h3l4-3.5v11L6 12H3zM13 7.5a3.5 3.5 0 0 1 0 5M15 5a7 7 0 0 1 0 10',
  mute: 'M3 8h3l4-3.5v11L6 12H3zM13 8l4 4M17 8l-4 4',
  pin: 'M8 3h4l-.5 4.5 2.5 2.5H6l2.5-2.5zM10 10v7',
  x: 'M5 5l10 10M15 5L5 15',
};
export function icon(name: string, size = 18): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'ico');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', ICONS[name] ?? '');
  svg.append(p);
  return svg;
}

export const pad = (n: number) => String(n).padStart(2, '0');
export const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export const day = (t: number) => new Date(t).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
export const capName = (n: string) => {
  const parts = n.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return parts.length > 1 ? `${parts[0].toUpperCase()} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0].toUpperCase();
};
export const sizeText = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
