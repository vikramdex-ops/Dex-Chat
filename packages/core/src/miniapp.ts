// The sandbox a tool (mini-app) runs in, and the small API it talks through.
//
// A tool is one HTML page. The desktop app shows it in <iframe sandbox="allow-scripts"> loaded from
// its own dexapp: scheme, never with the app's origin, so it cannot reach the app, its storage or
// the hub. The page is served with a strict Content-Security-Policy (also written into the page
// as a <meta> before anything else): no network unless an administrator granted hosts, no
// frames, forms, plugins or base URLs. Top navigation and popups are left out of the sandbox.
// Everything else goes through postMessage to the host, which checks the tool's permissions and
// asks the person before posting or opening a file.
import type { MiniAppPermission } from './bots.ts';

export const MINIAPP_SCHEME = 'dexapp';
/** Only scripts: no same origin, no top navigation, no popups, no forms, no modals, no downloads. */
export const MINIAPP_SANDBOX = 'allow-scripts';
/** Powerful features a tool never gets. */
export const MINIAPP_ALLOW = "camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'; payment 'none'; usb 'none'; serial 'none'; hid 'none'; bluetooth 'none'";
/** The largest page accepted for a tool (scripts, styles and images inlined). */
export const MINIAPP_MAX_HTML = 3 * 1024 * 1024;

/** "https://plotter.dex.local:8443" style origins; anything else (paths, wildcards, other schemes) is refused. */
export function normaliseHost(raw: string): string | null {
  const v = raw.trim();
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/?$/.test(v)) return null;
  try {
    const u = new URL(v);
    if (u.username || u.password || u.pathname !== '/' || u.search || u.hash) return null;
    return u.origin.toLowerCase();
  } catch { return null; }
}

/** The page's Content-Security-Policy: inline code only, nothing fetched unless hosts were granted. */
export function miniAppCsp(hosts: string[]): string {
  const granted = [...new Set(hosts.map(normaliseHost).filter((h): h is string => !!h))];
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    'media-src data: blob:',
    `connect-src ${granted.length ? granted.join(' ') : "'none'"}`,
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** Response headers for the page (the CSP again, and no sniffing, caching or referrers). */
export function miniAppHeaders(csp: string): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
  };
}

/** The frame that holds a tool: the attributes the app renders, in one place so they can be checked. */
export function miniAppFrame(instanceId: string, name: string, rev: string | number): {
  src: string; sandbox: string; allow: string; referrerPolicy: 'no-referrer'; title: string; loading: 'lazy';
} {
  if (!/^[0-9A-Za-z]{10,40}$/.test(instanceId)) throw new Error('Not a tool instance.');
  return {
    src: `${MINIAPP_SCHEME}://tool/${instanceId}?r=${encodeURIComponent(String(rev))}`,
    sandbox: MINIAPP_SANDBOX,
    allow: MINIAPP_ALLOW,
    referrerPolicy: 'no-referrer',
    title: `${name} (tool)`,
    loading: 'lazy',
  };
}

/** The same frame as HTML markup (for checks and for documentation). */
export function miniAppFrameMarkup(instanceId: string, name: string, rev: string | number, height: number): string {
  const f = miniAppFrame(instanceId, name, rev);
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<iframe src="${esc(f.src)}" sandbox="${f.sandbox}" allow="${esc(f.allow)}" referrerpolicy="${f.referrerPolicy}" title="${esc(f.title)}" loading="${f.loading}" height="${Math.round(height)}"></iframe>`;
}

/**
 * The page as served: the policy as a <meta> first (before any of the tool's own markup, so it
 * applies to every script), then the API, then the tool's page.
 */
export function miniAppDocument(html: string, csp: string): string {
  const body = html.replace(/^﻿/, '').replace(/^\s*<!doctype[^>]*>/i, '');
  const attr = csp.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${attr}"><meta name="referrer" content="no-referrer"><meta charset="utf-8"><script>(${miniAppSdk.toString()})();</script>${body}`;
}

// ---------------------------------------------------------------- the API inside the frame
/** Calls a tool can make (`dex.<call>` in the frame), and the permission each one needs. */
export const MINIAPP_CALLS: Record<string, MiniAppPermission | null> = {
  'context.get': null,
  'ui.resize': null,
  'members.list': 'members',
  'message.post': 'post',
  'state.get': 'state',
  'state.set': 'state',
  'files.list': 'files',
  'files.read': 'files',
};

export interface MiniAppRequest { dex: 1; id: number; method: string; params?: unknown }
export type MiniAppReply = { dex: 1; id: number; ok: true; result: unknown } | { dex: 1; id: number; ok: false; error: string };
export interface MiniAppEvent { dex: 1; event: 'state' | 'theme'; data: unknown }

export function isMiniAppRequest(v: unknown): v is MiniAppRequest {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return r.dex === 1 && typeof r.id === 'number' && Number.isInteger(r.id) && typeof r.method === 'string' && r.method.length < 40;
}

/**
 * Runs inside the frame (written into the page as source): `window.dex`, a promise-based API over
 * postMessage, and the theme as CSS variables (--dex-bg, --dex-text, --dex-accent…). It must not
 * refer to anything outside itself.
 */
export function miniAppSdk(): void {
  type Listener = (data: unknown) => void;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners: Record<string, Listener[]> = {};
  let seq = 0;
  const call = (method: string, params?: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    seq += 1;
    pending.set(seq, { resolve, reject });
    window.parent.postMessage({ dex: 1, id: seq, method, params }, '*');
  });
  const applyTheme = (t: unknown) => {
    const theme = t as { mode?: string; colors?: Record<string, string> } | null;
    if (!theme) return;
    const root = document.documentElement;
    root.dataset.theme = theme.mode === 'dark' ? 'dark' : 'light';
    root.style.colorScheme = theme.mode === 'dark' ? 'dark' : 'light';
    for (const [k, v] of Object.entries(theme.colors ?? {})) if (/^[a-z0-9-]{1,30}$/.test(k) && typeof v === 'string' && v.length < 200) root.style.setProperty(`--dex-${k}`, v);
  };
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window.parent) return;
    const m = e.data as { dex?: number; id?: number; ok?: boolean; result?: unknown; error?: string; event?: string; data?: unknown };
    if (!m || m.dex !== 1) return;
    if (typeof m.event === 'string') {
      if (m.event === 'theme') applyTheme(m.data);
      for (const cb of listeners[m.event] ?? []) { try { cb(m.data); } catch (err) { console.error(err); } }
      return;
    }
    const p = typeof m.id === 'number' ? pending.get(m.id) : undefined;
    if (!p) return;
    pending.delete(m.id as number);
    if (m.ok) p.resolve(m.result); else p.reject(new Error(typeof m.error === 'string' ? m.error : 'The app refused.'));
  });
  const api = {
    context: () => call('context.get').then((c) => { applyTheme((c as { theme?: unknown }).theme); return c; }),
    members: () => call('members.list'),
    post: (text: string) => call('message.post', { text }),
    state: {
      get: () => call('state.get'),
      set: (state: unknown, baseVersion?: number) => call('state.set', { state, baseVersion }),
    },
    files: {
      list: () => call('files.list'),
      read: (fileId: string) => call('files.read', { fileId }),
    },
    resize: (height: number) => call('ui.resize', { height }),
    on: (event: string, cb: Listener) => { (listeners[event] ??= []).push(cb); },
  };
  Object.defineProperty(window, 'dex', { value: Object.freeze(api), writable: false, configurable: false });
}
