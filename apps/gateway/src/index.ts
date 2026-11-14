// Dexterity Connect gateway: lets phones and home laptops reach the office hub from any network
// without opening a single port at the office. The hub keeps one outbound WebSocket here; each
// device opens another; this Worker pairs them and passes opaque, end-to-end encrypted frames
// between them (packages/core/src/remote.ts has the channel). It never sees a message, a file or
// a password, and holds no data: only who is connected right now.
//
// Hardening, in the spirit of the relays it learnt from:
// - Only the hub that proves it holds the pinned certificate key can take the hub side.
// - Device sockets are binary-only, at most 1 MiB a frame, rate limited per address, and capped.
// - Nothing but /hub/<id>, /c/<id>, /join and /health answers; every reply carries strict headers.
import { DurableObject } from 'cloudflare:workers';

interface Env {
  RELAY: DurableObjectNamespace<Relay>;
  /** The hub's certificate fingerprint (Control room > Remote access). Without it, the first hub to connect is trusted. */
  HUB_FINGERPRINT?: string;
}

const MAX_FRAME = (1 << 20) + 64;
const MAX_DEVICES = 600;
const CONNECTS_PER_MINUTE = 40;
const ID_RE = '[0-9A-Za-z_-]{6,64}';

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
};
const text = (body: string, status = 200, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS, ...extra } });

/** A socket that closes with a code as soon as it opens: a browser cannot read why an upgrade was refused. */
function refuse(code: number, reason: string): Response {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/health') return text('Dexterity Connect gateway\n');
    if (url.pathname === '/join') return joinPage();
    const m = url.pathname.match(new RegExp(`^/(hub|c)/(${ID_RE})$`));
    if (!m) return text('Not found\n', 404);
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return text('Expected a WebSocket\n', 426);
    return env.RELAY.get(env.RELAY.idFromName(m[2])).fetch(req);
  },
};

interface Attachment { kind: 'hub' | 'device'; hubId: string; authed?: boolean; nonce?: string; sid?: number; ip?: string }

const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; };
const b64d = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(':');
function contains(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** One relay per hub id. Uses hibernating WebSockets, so a quiet office costs nothing between frames. */
export class Relay extends DurableObject<Env> {
  private readonly attempts = new Map<string, { n: number; until: number }>();

  private limited(ip: string): boolean {
    const now = Date.now();
    for (const [k, w] of this.attempts) { if (w.until > now) break; this.attempts.delete(k); }
    const w = this.attempts.get(ip) ?? { n: 0, until: now + 60_000 };
    w.n++;
    this.attempts.set(ip, w);
    return w.n > CONNECTS_PER_MINUTE;
  }

  private hub(): WebSocket | null {
    for (const ws of this.ctx.getWebSockets('hub')) if ((ws.deserializeAttachment() as Attachment).authed) return ws;
    return null;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const [, kind, hubId] = url.pathname.split('/');
    const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
    if (this.limited(ip)) return refuse(4429, 'Too many connections; try again in a minute');
    const { 0: client, 1: server } = new WebSocketPair();

    if (kind === 'hub') {
      if (this.ctx.getWebSockets('hub').length >= 4) return refuse(4429, 'Too many hub connections');
      const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))));
      this.ctx.acceptWebSocket(server, ['hub']);
      server.serializeAttachment({ kind: 'hub', hubId, authed: false, nonce } satisfies Attachment);
      server.send(JSON.stringify({ t: 'challenge', v: 1, n: nonce }));
      return new Response(null, { status: 101, webSocket: client });
    }

    const hub = this.hub();
    if (!hub) return refuse(4404, 'The office hub is not connected to the gateway');
    if (this.ctx.getWebSockets('device').length >= MAX_DEVICES) return refuse(4429, 'The gateway is full');
    let sid = 0;
    do sid = crypto.getRandomValues(new Uint32Array(1))[0] || 1; while (this.ctx.getWebSockets(`s:${sid}`).length);
    this.ctx.acceptWebSocket(server, ['device', `s:${sid}`]);
    server.serializeAttachment({ kind: 'device', hubId, sid, ip } satisfies Attachment);
    const cf = (req as Request & { cf?: { country?: string } }).cf;
    hub.send(JSON.stringify({ t: 'open', s: sid, ip, country: cf?.country ?? null }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    const a = ws.deserializeAttachment() as Attachment;
    const size = typeof msg === 'string' ? msg.length * 3 : msg.byteLength;
    if (size > MAX_FRAME) { ws.close(1009, 'Message too big'); return; }

    if (a.kind === 'device') {
      if (typeof msg === 'string') { ws.close(1003, 'Binary frames only'); return; }
      const hub = this.hub();
      if (!hub) { ws.close(4404, 'The office hub disconnected'); return; }
      const out = new Uint8Array(msg.byteLength + 4);
      out.set(u32(a.sid!), 0);
      out.set(new Uint8Array(msg), 4);
      hub.send(out);
      return;
    }

    if (!a.authed) {
      if (typeof msg !== 'string') { ws.close(4401, 'Authenticate first'); return; }
      await this.authenticate(ws, a, msg);
      return;
    }
    if (typeof msg === 'string') {
      let c: { t?: string; s?: number; code?: number; reason?: string };
      try { c = JSON.parse(msg); } catch { return; }
      if (c.t === 'close' && typeof c.s === 'number') {
        for (const d of this.ctx.getWebSockets(`s:${c.s}`)) d.close(c.code && c.code >= 4000 && c.code < 5000 ? c.code : 4000, (c.reason ?? 'Closed by the hub').slice(0, 120));
      }
      return;
    }
    const bytes = new Uint8Array(msg);
    if (bytes.length < 4) return;
    const sid = new DataView(msg).getUint32(0);
    for (const d of this.ctx.getWebSockets(`s:${sid}`)) d.send(bytes.subarray(4));
  }

  private async authenticate(ws: WebSocket, a: Attachment, raw: string): Promise<void> {
    try {
      const m = JSON.parse(raw) as { t: string; cert: string; spki: string; sig: string };
      if (m.t !== 'auth') throw new Error('expected auth');
      const cert = b64d(m.cert);
      const spki = b64d(m.spki);
      const fp = hex(await crypto.subtle.digest('SHA-256', cert));
      if (!contains(cert, spki)) throw new Error('key is not the certificate\'s');
      const key = await crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
      const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64d(m.sig), new TextEncoder().encode(`dexconnect-gw-hub-v1|${a.hubId}|${a.nonce}`));
      if (!ok) throw new Error('bad signature');
      const pinned = this.env.HUB_FINGERPRINT?.trim().toUpperCase() || (await this.ctx.storage.get<string>('fp'));
      if (pinned && pinned !== fp) { ws.close(4403, 'This gateway belongs to another hub'); return; }
      if (!pinned) await this.ctx.storage.put('fp', fp);
      // a reconnecting hub replaces the old connection; devices reconnect to reach it
      for (const old of this.ctx.getWebSockets('hub')) if (old !== ws && (old.deserializeAttachment() as Attachment).authed) old.close(4001, 'Replaced');
      for (const d of this.ctx.getWebSockets('device')) d.close(4404, 'The office hub reconnected');
      ws.serializeAttachment({ ...a, authed: true, nonce: undefined } satisfies Attachment);
      ws.send(JSON.stringify({ t: 'ready', fp, pinned: !!this.env.HUB_FINGERPRINT }));
    } catch {
      ws.close(4401, 'Authentication failed');
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> { this.gone(ws); }
  async webSocketError(ws: WebSocket): Promise<void> { this.gone(ws); }

  private gone(ws: WebSocket): void {
    const a = ws.deserializeAttachment() as Attachment | null;
    if (!a) return;
    if (a.kind === 'device') {
      this.hub()?.send(JSON.stringify({ t: 'closed', s: a.sid }));
    } else if (a.authed && !this.hub()) {
      for (const d of this.ctx.getWebSockets('device')) d.close(4404, 'The office hub disconnected');
    }
  }
}

/** /join#DXC1-…: a QR code on a colleague's screen leads here; it opens the app with the code. */
function joinPage(): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dexterity Connect</title><style>
:root{color-scheme:light dark;--a:#1c7680}body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f4f6f6;color:#15191b;display:grid;place-items:center;min-height:100vh}
@media(prefers-color-scheme:dark){body{background:#0d1416;color:#e8f2f3}.card{background:#172729!important}}
.card{max-width:420px;margin:16px;padding:28px;border-radius:16px;background:#fff;box-shadow:0 8px 30px rgba(0,0,0,.12)}
h1{font-size:22px;margin:0 0 8px}a.btn,button{display:block;width:100%;box-sizing:border-box;text-align:center;padding:12px;border-radius:10px;border:0;margin-top:12px;font:600 15px system-ui;cursor:pointer;text-decoration:none}
a.btn{background:var(--a);color:#fff}button{background:transparent;color:inherit;border:1px solid rgba(127,127,127,.4)}code{word-break:break-all;font-size:12px;opacity:.75}
</style></head><body><div class="card"><h1>Join Dexterity Connect</h1>
<p>Install Dexterity Connect, then open it with this code. Your office administrator approves the new device before it can see anything.</p>
<a class="btn" id="open" href="#">Open Dexterity Connect</a><button id="copy">Copy the setup code</button>
<p><a href="https://github.com/dexterity-admin/dexterity-connect/releases/latest" rel="noreferrer">Download the app</a></p>
<p><code id="code"></code></p></div>
<script>
const code=(location.hash.slice(1).match(/DXC1-[A-Za-z0-9_-]+/)||[''])[0];
document.getElementById('code').textContent=code||'No setup code in this link.';
document.getElementById('open').href='dexconnect://remote?code='+encodeURIComponent(code);
document.getElementById('copy').onclick=()=>navigator.clipboard.writeText(code).then(()=>{document.getElementById('copy').textContent='Copied'});
</script></body></html>`;
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS,
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}
