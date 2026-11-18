// Dexterity Meet's front door on Cloudflare Pages (built into dist/_worker.js). Two jobs only:
// - /assets/<name>: the pages' scripts, styles, fonts and mark, from this site's own files (named
//   after their content, so cached for a year);
// - /app/: Dexterity Connect for iPhone, the web app people add to the Home Screen (apps/web, copied
//   into dist/app by scripts/build.mjs), from this site's own files with the headers app-headers.ts
//   sets;
// - everything else (a meeting's page, its two questions, the guest's socket, webinar pages) goes to
//   the office's gateway Worker through the GATEWAY service binding. The request keeps this site's
//   address, so the gateway builds every link and CSP for it; the browser never learns the Worker's
//   own address, and nothing here holds or logs a passcode (it is in the #fragment or a POST body).
import { appHeaders } from './app-headers.ts';

/** The two bindings, as far as this file uses them (Pages' ASSETS, and the GATEWAY service binding). */
interface Binding { fetch(req: Request): Promise<Response> }
interface Env {
  ASSETS: Binding;
  GATEWAY?: Binding;
}

const HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin',
  'x-robots-tag': 'noindex, nofollow, noarchive',
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/app') return Response.redirect(`${url.origin}/app/${url.search}`, 301);
    if (url.pathname.startsWith('/app/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed\n', { status: 405, headers: { allow: 'GET, HEAD', ...HEADERS } });
      // the page itself is /app/ (Pages serves index.html there)
      const path = url.pathname === '/app/index.html' ? '/app/' : url.pathname;
      const r = await env.ASSETS.fetch(new Request(`${url.origin}${path}`, { method: req.method }));
      if (r.status !== 200) return new Response('Not found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...HEADERS } });
      const out = new Response(r.body, r);
      for (const [k, v] of Object.entries(appHeaders(path, url.origin))) out.headers.set(k, v);
      return out;
    }
    if (url.pathname.startsWith('/assets/') && (req.method === 'GET' || req.method === 'HEAD')) {
      const r = await env.ASSETS.fetch(new Request(url.toString(), { method: req.method }));
      if (r.status === 200) {
        const out = new Response(r.body, r);
        for (const [k, v] of Object.entries(HEADERS)) out.headers.set(k, v);
        out.headers.set('cache-control', 'public, max-age=31536000, immutable');
        return out;
      }
      // a file this copy of the site does not have yet (the gateway was deployed after it): the gateway has it
    }
    if (!env.GATEWAY) {
      return new Response('This meeting site is not connected to the office\'s gateway yet. Try again later.\n', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...HEADERS } });
    }
    try {
      return await env.GATEWAY.fetch(req);
    } catch {
      return new Response('The office\'s meeting service is not answering right now. Try again in a minute.\n', { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '30', ...HEADERS } });
    }
  },
};
