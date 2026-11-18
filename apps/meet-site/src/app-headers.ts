// The headers of Dexterity Connect for iPhone (the web app at /app/ on the meeting site). Shared by
// the site's front door (worker.ts) and the e2e test's local copy of the site, so both serve it the
// same way. No Cloudflare or Node types: plain strings in, plain records out.
//
// - The page and the service worker are never cached by the browser on their own (the service
//   worker keeps the app shell itself and finds a new build at once); files named after their
//   content are cached for a year.
// - The CSP allows scripts only from this site, and connections to this site and to secure
//   WebSockets (wss:), which is how the app reaches the office's gateway: the channel inside is
//   end-to-end encrypted and pinned to the hub's certificate, so a socket elsewhere learns nothing.
//   On a local test address, plain ws: to the same machine too.
// - Camera and microphone (calls, scanning the pairing code, photos) for this site only.
export function appHeaders(pathname: string, origin: string): Record<string, string> {
  const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
  const immutable = /^\/app\/assets\//.test(pathname);
  const page = pathname === '/app/' || pathname.endsWith('.html');
  const fresh = page || /\/app\/(sw\.js|manifest\.webmanifest|version\.json)$/.test(pathname);
  const h: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'cross-origin-resource-policy': 'same-origin',
    'x-robots-tag': 'noindex, nofollow, noarchive',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : fresh ? 'no-cache' : 'public, max-age=86400',
  };
  if (!local) h['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  if (pathname.endsWith('/sw.js')) h['service-worker-allowed'] = '/app/';
  if (pathname.endsWith('.webmanifest')) h['content-type'] = 'application/manifest+json; charset=utf-8';
  if (page) {
    h['content-security-policy'] = [
      "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
      "font-src 'self' data:", "media-src 'self' blob: mediastream:", `connect-src 'self' blob: data: wss:${local ? ' ws://127.0.0.1:* ws://localhost:*' : ''}`,
      "worker-src 'self' blob:", "frame-src 'self' blob:", "manifest-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
    ].join('; ');
    h['permissions-policy'] = 'camera=(self), microphone=(self), display-capture=(), fullscreen=(self), autoplay=(self), clipboard-read=(self), clipboard-write=(self), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()';
    h['cross-origin-opener-policy'] = 'same-origin';
  }
  return h;
}
