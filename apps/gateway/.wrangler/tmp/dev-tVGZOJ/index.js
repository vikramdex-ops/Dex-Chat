var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
import { DurableObject } from "cloudflare:workers";
var MAX_FRAME = (1 << 20) + 64;
var MAX_DEVICES = 600;
var CONNECTS_PER_MINUTE = 40;
var ID_RE = "[0-9A-Za-z_-]{6,64}";
var SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000",
  "x-frame-options": "DENY",
  "cache-control": "no-store"
};
var text = /* @__PURE__ */ __name((body, status = 200, extra = {}) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS, ...extra } }), "text");
function refuse(code, reason) {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
}
__name(refuse, "refuse");
var src_default = {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/health") return text("Dexterity Connect gateway\n");
    if (url.pathname === "/join") return joinPage();
    const m = url.pathname.match(new RegExp(`^/(hub|c)/(${ID_RE})$`));
    if (!m) return text("Not found\n", 404);
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return text("Expected a WebSocket\n", 426);
    return env.RELAY.get(env.RELAY.idFromName(m[2])).fetch(req);
  }
};
var u32 = /* @__PURE__ */ __name((n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
}, "u32");
var b64d = /* @__PURE__ */ __name((s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)), "b64d");
var hex = /* @__PURE__ */ __name((b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0").toUpperCase()).join(":"), "hex");
function contains(hay, needle) {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}
__name(contains, "contains");
var Relay = class extends DurableObject {
  static {
    __name(this, "Relay");
  }
  attempts = /* @__PURE__ */ new Map();
  limited(ip) {
    const now = Date.now();
    for (const [k, w2] of this.attempts) {
      if (w2.until > now) break;
      this.attempts.delete(k);
    }
    const w = this.attempts.get(ip) ?? { n: 0, until: now + 6e4 };
    w.n++;
    this.attempts.set(ip, w);
    return w.n > CONNECTS_PER_MINUTE;
  }
  hub() {
    for (const ws of this.ctx.getWebSockets("hub")) if (ws.deserializeAttachment().authed) return ws;
    return null;
  }
  async fetch(req) {
    const url = new URL(req.url);
    const [, kind, hubId] = url.pathname.split("/");
    const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
    if (this.limited(ip)) return refuse(4429, "Too many connections; try again in a minute");
    const { 0: client, 1: server } = new WebSocketPair();
    if (kind === "hub") {
      if (this.ctx.getWebSockets("hub").length >= 4) return refuse(4429, "Too many hub connections");
      const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))));
      this.ctx.acceptWebSocket(server, ["hub"]);
      server.serializeAttachment({ kind: "hub", hubId, authed: false, nonce });
      server.send(JSON.stringify({ t: "challenge", v: 1, n: nonce }));
      return new Response(null, { status: 101, webSocket: client });
    }
    const hub = this.hub();
    if (!hub) return refuse(4404, "The office hub is not connected to the gateway");
    if (this.ctx.getWebSockets("device").length >= MAX_DEVICES) return refuse(4429, "The gateway is full");
    let sid = 0;
    do
      sid = crypto.getRandomValues(new Uint32Array(1))[0] || 1;
    while (this.ctx.getWebSockets(`s:${sid}`).length);
    this.ctx.acceptWebSocket(server, ["device", `s:${sid}`]);
    server.serializeAttachment({ kind: "device", hubId, sid, ip });
    const cf = req.cf;
    hub.send(JSON.stringify({ t: "open", s: sid, ip, country: cf?.country ?? null }));
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, msg) {
    const a = ws.deserializeAttachment();
    const size = typeof msg === "string" ? msg.length * 3 : msg.byteLength;
    if (size > MAX_FRAME) {
      ws.close(1009, "Message too big");
      return;
    }
    if (a.kind === "device") {
      if (typeof msg === "string") {
        ws.close(1003, "Binary frames only");
        return;
      }
      const hub = this.hub();
      if (!hub) {
        ws.close(4404, "The office hub disconnected");
        return;
      }
      const out = new Uint8Array(msg.byteLength + 4);
      out.set(u32(a.sid), 0);
      out.set(new Uint8Array(msg), 4);
      hub.send(out);
      return;
    }
    if (!a.authed) {
      if (typeof msg !== "string") {
        ws.close(4401, "Authenticate first");
        return;
      }
      await this.authenticate(ws, a, msg);
      return;
    }
    if (typeof msg === "string") {
      let c;
      try {
        c = JSON.parse(msg);
      } catch {
        return;
      }
      if (c.t === "close" && typeof c.s === "number") {
        for (const d of this.ctx.getWebSockets(`s:${c.s}`)) d.close(c.code && c.code >= 4e3 && c.code < 5e3 ? c.code : 4e3, (c.reason ?? "Closed by the hub").slice(0, 120));
      }
      return;
    }
    const bytes = new Uint8Array(msg);
    if (bytes.length < 4) return;
    const sid = new DataView(msg).getUint32(0);
    for (const d of this.ctx.getWebSockets(`s:${sid}`)) d.send(bytes.subarray(4));
  }
  async authenticate(ws, a, raw) {
    try {
      const m = JSON.parse(raw);
      if (m.t !== "auth") throw new Error("expected auth");
      const cert = b64d(m.cert);
      const spki = b64d(m.spki);
      const fp = hex(await crypto.subtle.digest("SHA-256", cert));
      if (!contains(cert, spki)) throw new Error("key is not the certificate's");
      const key = await crypto.subtle.importKey("spki", spki, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64d(m.sig), new TextEncoder().encode(`dexconnect-gw-hub-v1|${a.hubId}|${a.nonce}`));
      if (!ok) throw new Error("bad signature");
      const pinned = this.env.HUB_FINGERPRINT?.trim().toUpperCase() || await this.ctx.storage.get("fp");
      if (pinned && pinned !== fp) {
        ws.close(4403, "This gateway belongs to another hub");
        return;
      }
      if (!pinned) await this.ctx.storage.put("fp", fp);
      for (const old of this.ctx.getWebSockets("hub")) if (old !== ws && old.deserializeAttachment().authed) old.close(4001, "Replaced");
      for (const d of this.ctx.getWebSockets("device")) d.close(4404, "The office hub reconnected");
      ws.serializeAttachment({ ...a, authed: true, nonce: void 0 });
      ws.send(JSON.stringify({ t: "ready", fp, pinned: !!this.env.HUB_FINGERPRINT }));
    } catch {
      ws.close(4401, "Authentication failed");
    }
  }
  async webSocketClose(ws) {
    this.gone(ws);
  }
  async webSocketError(ws) {
    this.gone(ws);
  }
  gone(ws) {
    const a = ws.deserializeAttachment();
    if (!a) return;
    if (a.kind === "device") {
      this.hub()?.send(JSON.stringify({ t: "closed", s: a.sid }));
    } else if (a.authed && !this.hub()) {
      for (const d of this.ctx.getWebSockets("device")) d.close(4404, "The office hub disconnected");
    }
  }
};
function joinPage() {
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
<\/script></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...SECURITY_HEADERS,
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    }
  });
}
__name(joinPage, "joinPage");

// ../../node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-uvTHvf/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-uvTHvf/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  Relay,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
