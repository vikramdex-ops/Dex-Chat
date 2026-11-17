// Connecting Zoho Calendar (docs/ZOHO-CALENDAR.md): the browser opens Zoho's sign-in page, and
// Zoho sends the person back to http://127.0.0.1:47917/zoho/callback, which this app listens on
// for a few minutes only. Only the answer whose state matches the sign-in this app started is
// taken; it goes to the hub, which exchanges the code with the office's client secret (this PC
// never sees the secret or the tokens).
import http from 'node:http';
import type { ZohoCallback } from '@dex/core/zoho';

/** How long Zoho's answer is waited for. */
const WAIT_MS = 5 * 60_000;

let current: { server: http.Server; reject: (e: Error) => void } | null = null;

/** The loopback address in the sign-in address, checked: only 127.0.0.1 (or localhost) and our path. */
export function loopbackOf(authUrl: string, allowHttp: boolean): { port: number; path: string } {
  let u: URL;
  try { u = new URL(authUrl); } catch { throw new Error('The Zoho sign-in address is not valid.'); }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:' && u.hostname === '127.0.0.1')) throw new Error('The Zoho sign-in address must be https.');
  let r: URL;
  try { r = new URL(u.searchParams.get('redirect_uri') ?? ''); } catch { throw new Error('The Zoho sign-in address has no return address.'); }
  if (r.protocol !== 'http:' || (r.hostname !== '127.0.0.1' && r.hostname !== 'localhost') || !r.port || r.pathname !== '/zoho/callback') throw new Error('The return address must be on this PC.');
  return { port: Number(r.port), path: r.pathname };
}

const PAGE = (ok: boolean, text: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dexterity Connect</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#f6f5f1;color:#1d2328;display:grid;place-items:center;min-height:100vh;margin:0}
main{border:1px solid #1d2328;padding:28px 32px;max-width:420px;background:#fff}p.cap{font:12px ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:${ok ? '#1c7680' : '#9a3b1a'};margin:0 0 8px}
@media (prefers-color-scheme: dark){body{background:#121619;color:#e7e9ea}main{background:#1a2024;border-color:#e7e9ea}}</style></head>
<body><main><p class="cap">Dexterity Connect · Zoho Calendar</p><p>${text}</p></main></body></html>`;

/**
 * Open Zoho's sign-in and wait for its answer on the loopback address. `open` shows the page
 * (the system browser); the promise settles with what Zoho sent, or fails after five minutes.
 */
export function zohoSignIn(authUrl: string, state: string, open: (url: string) => Promise<void>, allowHttp = false): Promise<ZohoCallback> {
  const { port, path } = loopbackOf(authUrl, allowHttp);
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(state)) return Promise.reject(new Error('The sign-in was not started properly. Try again.'));
  // a second Connect replaces the first one
  if (current) { current.reject(new Error('A newer Zoho sign-in was started.')); current.server.close(); current = null; }
  return new Promise<ZohoCallback>((resolve, reject) => {
    let done = false;
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const reply = (status: number, ok: boolean, text: string) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
        res.end(PAGE(ok, text));
      };
      if (req.method !== 'GET' || u.pathname !== path) { reply(404, false, 'Nothing here.'); return; }
      if (u.searchParams.get('state') !== state) { reply(400, false, 'This answer does not belong to the sign-in Dexterity Connect started. Close this tab and choose Connect Zoho Calendar again.'); return; }
      const q = (k: string) => u.searchParams.get(k) ?? undefined;
      const answer: ZohoCallback = { state, code: q('code'), error: q('error'), location: q('location'), accountsServer: q('accounts-server') };
      reply(200, !answer.error, answer.error ? 'Zoho was not given access. You can close this tab.' : 'Zoho is connected. You can close this tab and go back to Dexterity Connect.');
      finish(() => resolve(answer));
    });
    const timer = setTimeout(() => finish(() => reject(new Error('Zoho did not answer within five minutes. Choose Connect Zoho Calendar again.'))), WAIT_MS);
    const finish = (then: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (current?.server === server) current = null;
      server.close();
      server.closeAllConnections?.();
      then();
    };
    current = { server, reject: (e) => finish(() => reject(e)) };
    server.once('error', (err: NodeJS.ErrnoException) => finish(() => reject(new Error(err.code === 'EADDRINUSE'
      ? `Another program is using port ${port} on this PC, which Zoho returns to. Close it and try again.` : 'Could not wait for Zoho\'s answer on this PC.'))));
    server.listen(port, '127.0.0.1', () => { void open(authUrl).catch((err: Error) => finish(() => reject(new Error(`Could not open the browser: ${err.message}`)))); });
  });
}

/**
 * TEST ONLY (DEXCONNECT_TEST_ZOHO_BROWSER=fetch, unpackaged builds): no browser. The sign-in page
 * of the mock Zoho answers at once with a redirect, which is followed to the loopback address.
 */
export async function fetchLikeBrowser(url: string): Promise<void> {
  const r = await fetch(url, { redirect: 'manual' });
  const next = r.headers.get('location');
  if (!next) throw new Error(`no redirect (${r.status})`);
  await fetch(next);
}
