// Tools (mini-apps) in conversations are served from their own dexapp: scheme, never from the
// app's origin, with the strict policy the hub sets for each one (packages/core/src/miniapp.ts).
// Frames inside the app may only ever show tools: a tool cannot send its frame to a web page.
import { protocol } from 'electron';
import type { WebContents } from 'electron';
import { MINIAPP_SCHEME, miniAppHeaders } from '@dex/core/miniapp';

/** For protocol.registerSchemesAsPrivileged (before the app is ready). */
export const MINIAPP_PRIVILEGES = { scheme: MINIAPP_SCHEME, privileges: { standard: true, secure: true } };

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

/** dexapp://tool/<instance id> → the tool's page, fetched from the hub for this person. */
export function handleMiniAppScheme(request: (op: 'miniapp.bundle', data: { instanceId: string }) => Promise<{ html: string; csp: string }>): void {
  protocol.handle(MINIAPP_SCHEME, async (req) => {
    const u = new URL(req.url);
    const m = u.pathname.match(/^\/([0-9A-Za-z]{10,40})$/);
    if (u.host !== 'tool' || !m || req.method !== 'GET') return new Response('not found', { status: 404 });
    try {
      const r = await request('miniapp.bundle', { instanceId: m[1] });
      return new Response(r.html, { status: 200, headers: miniAppHeaders(r.csp) });
    } catch (err) {
      // a short note in the frame (the card around it says what to do)
      const csp = "default-src 'none'; style-src 'unsafe-inline'";
      const body = `<!doctype html><meta charset="utf-8"><style>html,body{height:100%;margin:0}body{display:grid;place-items:center;font:13px system-ui,sans-serif;color:#6f8386;padding:16px;text-align:center}</style><p>${escape((err as Error).message || 'This tool is not available.')}</p>`;
      return new Response(body, { status: 200, headers: miniAppHeaders(csp) });
    }
  });
}

/** Keep every frame inside a window on the dexapp: scheme (the main frame has its own guard). */
export function guardFrames(contents: WebContents): void {
  contents.on('will-frame-navigate', (e) => {
    if (e.isMainFrame) return;
    if (!e.url.startsWith(`${MINIAPP_SCHEME}://tool/`)) e.preventDefault();
  });
}
