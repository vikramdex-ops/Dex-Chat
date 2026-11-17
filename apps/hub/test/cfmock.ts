// A stand-in for the parts of Cloudflare's REST API that "Set up with Cloudflare" (src/cfdeploy.ts)
// calls, with the behaviour we rely on: tokens and their permissions, several accounts, the
// workers.dev subdomain (taken names), Worker uploads with Durable Object migrations, secrets,
// workers.dev routes, Pages projects and direct upload (upload token, check-missing, upload,
// upsert-hashes, deployments with a manifest and a _worker.bundle), Realtime TURN keys and their
// short-lived credentials. It also runs "workers.dev" and "pages.dev" for what was deployed: a
// small fake gateway (the hub's challenge, the pin from HUB_FINGERPRINT, /health) and the site
// (its files by the manifest, everything else to the gateway when the bundle binds GATEWAY to it).
// Shapes follow Cloudflare's API reference and what wrangler 4 sends (recorded in cfmock's log).
// Used by apps/hub/test/cfdeploy.test.ts and apps/desktop/e2e/cfsetup.mts.
import http from 'node:http';
import crypto, { X509Certificate } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';

export type Perm = 'workers' | 'pages' | 'calls' | 'accounts';
export interface MockToken { perms: Perm[]; accounts?: string[]; /** an account-owned token: /user/tokens/verify does not know it */ accountOwned?: boolean }
export interface MockScript {
  metadata: Record<string, unknown>;
  modules: Map<string, { type: string; text: string }>;
  migrationTag: string | null;
  secrets: Map<string, string>;
  workersDev: boolean;
  uploads: number;
}
export interface MockProject {
  name: string;
  subdomain: string;
  production_branch: string;
  deployment_configs: Record<string, unknown>;
  deployments: Array<{ id: string; manifest: Record<string, string>; bundle: { metadata: Record<string, unknown>; main: string } | null; headers: string | null; branch: string; fields: Record<string, string> }>;
}
interface Account { id: string; name: string; subdomain: string | null; scripts: Map<string, MockScript>; projects: Map<string, MockProject>; turnKeys: Map<string, { uid: string; name: string; secret: string; created: string }> }
export interface Logged { method: string; path: string; auth: string | null; contentType: string | null; body?: unknown }

const ok = (result: unknown) => ({ success: true, errors: [], messages: [], result });
const fail = (code: number, message: string) => ({ success: false, errors: [{ code, message }], messages: [], result: null });

export class CloudflareMock {
  readonly tokens = new Map<string, MockToken>();
  readonly accounts = new Map<string, Account>();
  /** workers.dev subdomains other Cloudflare customers already have. */
  readonly takenSubdomains = new Set<string>();
  /** pages.dev names other customers already have: a new project gets <name>-<random>.pages.dev. */
  readonly takenPagesNames = new Set<string>();
  readonly assets = new Map<string, { b64: string; contentType: string }>();
  readonly jwts = new Map<string, { account: string; project: string }>();
  readonly log: Logged[] = [];
  /** "METHOD /path-pattern" → an error to answer once (then the route works again). */
  readonly failOnce = new Map<string, { status: number; code: number; message: string }>();
  /** Called when a Worker is uploaded or its secrets change (a test can run the real bundle). */
  onScript: ((name: string, s: MockScript) => void | Promise<void>) | null = null;
  /** A real gateway (wrangler dev) the site passes requests to through its binding, instead of the fake one. */
  gatewayOrigin: string | null = null;
  /** workers.dev and pages.dev, as the hub should reach them (the fake gateway and site, or a real local one). */
  workersDevUrl = '';
  pagesDevUrl = '';
  apiBase = '';
  rtcBase = '';
  private servers: http.Server[] = [];
  private wss = new WebSocketServer({ noServer: true });
  /** What the fake gateway saw: hubs that signed in, and whether they were pinned. */
  readonly hubs: Array<{ hubId: string; fp: string; pinned: boolean }> = [];

  addAccount(id: string, name: string, subdomain: string | null = null): Account {
    const a: Account = { id, name, subdomain, scripts: new Map(), projects: new Map(), turnKeys: new Map() };
    this.accounts.set(id, a);
    return a;
  }

  async start(): Promise<this> {
    const listen = async (handler: http.RequestListener, upgrade?: (req: http.IncomingMessage, sock: import('node:stream').Duplex, head: Buffer) => void) => {
      const s = http.createServer(handler);
      if (upgrade) s.on('upgrade', upgrade);
      await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
      this.servers.push(s);
      return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    };
    const api = await listen((req, res) => void this.api(req, res).catch((err) => { res.writeHead(500); res.end(String(err)); }));
    this.apiBase = `${api}/client/v4`;
    this.rtcBase = `${api}/rtc`;
    this.workersDevUrl = await listen((req, res) => this.workersDev(req, res), (req, sock, head) => this.gatewayUpgrade(req, sock, head));
    this.pagesDevUrl = await listen((req, res) => void this.pagesDev(req, res));
    return this;
  }

  async stop(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    await Promise.all(this.servers.map((s) => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); })));
  }

  account(id: string): Account { const a = this.accounts.get(id); if (!a) throw new Error(`no account ${id}`); return a; }

  // ------------------------------------------------------------------ the API
  private async api(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const ct = req.headers['content-type'] ?? null;
    const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || null;
    const entry: Logged = { method: req.method ?? 'GET', path: url.pathname, auth, contentType: ct };
    this.log.push(entry);
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const json = (): Record<string, unknown> => { try { const j = JSON.parse(raw.toString() || '{}'); entry.body = j; return j; } catch { return {}; } };
    const form = async () => { const f = await new Request('http://x', { method: 'POST', headers: { 'content-type': ct ?? '' }, body: raw }).formData(); return f; };
    const p = url.pathname.replace(/^\/client\/v4/, '');
    const m = req.method ?? 'GET';
    // a scripted failure
    for (const [k, e] of this.failOnce) {
      const [fm, fp] = k.split(' ');
      if (fm === m && new RegExp(`^${fp}$`).test(p)) { this.failOnce.delete(k); send(e.status, fail(e.code, e.message)); return; }
    }

    // TURN credentials (rtc.live.cloudflare.com): the key's own secret, not the API token
    if (url.pathname.startsWith('/rtc/')) {
      const k = url.pathname.match(/^\/rtc\/v1\/turn\/keys\/([0-9a-f]{32})\/credentials\/generate-ice-servers$/);
      const key = k ? [...this.accounts.values()].flatMap((a) => [...a.turnKeys.values()]).find((t) => t.uid === k[1]) : null;
      if (!key || key.secret !== auth) { res.writeHead(401); res.end('unauthorized'); return; }
      send(201, { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: `u-${key.uid.slice(0, 6)}`, credential: 'short-lived' }] });
      return;
    }

    // Pages' asset endpoints take the upload JWT
    if (p.startsWith('/pages/assets/')) {
      const j = auth ? this.jwts.get(auth) : null;
      if (!j) { send(401, fail(8000013, 'Unauthorized')); return; }
      const body = json() as unknown;
      if (p === '/pages/assets/check-missing') { send(200, ok(((body as { hashes: string[] }).hashes ?? []).filter((h) => !this.assets.has(h)))); return; }
      if (p === '/pages/assets/upload') {
        for (const f of body as Array<{ key: string; value: string; metadata: { contentType: string }; base64: boolean }>) {
          if (!f.base64 || !/^[0-9a-f]{32}$/.test(f.key)) { send(400, fail(8000096, 'bad upload')); return; }
          this.assets.set(f.key, { b64: f.value, contentType: f.metadata.contentType });
        }
        send(200, ok(null)); return;
      }
      if (p === '/pages/assets/upsert-hashes') { send(200, ok(null)); return; }
      send(404, fail(7003, 'No route for that URI')); return;
    }

    const tok = auth ? this.tokens.get(auth) : null;
    if (!tok) { send(401, fail(1000, 'Invalid API Token')); return; }
    const has = (perm: Perm) => tok.perms.includes(perm);
    const denied = () => send(403, fail(10000, 'Authentication error'));
    const mine = [...this.accounts.values()].filter((a) => !tok.accounts || tok.accounts.includes(a.id));

    if (p === '/user/tokens/verify' && m === 'GET') {
      if (tok.accountOwned) { send(401, fail(1000, 'Invalid API Token')); return; }
      send(200, ok({ id: 'tok1', status: 'active' })); return;
    }
    if (p === '/accounts' && m === 'GET') {
      if (!mine.length) { send(200, ok([])); return; }
      send(200, { ...ok(mine.map((a) => ({ id: a.id, name: a.name }))), result_info: { page: 1, per_page: 20, count: mine.length, total_count: mine.length } }); return;
    }
    const am = p.match(/^\/accounts\/([0-9a-f]{32})(\/.*)$/);
    if (!am) { send(404, fail(7003, 'No route for that URI')); return; }
    const acct = mine.find((a) => a.id === am[1]);
    if (!acct) { denied(); return; }
    const rest = am[2];
    let r: RegExpMatchArray | null;

    if (rest === '/workers/subdomain') {
      if (!has('workers')) { denied(); return; }
      if (m === 'GET') { if (!acct.subdomain) send(404, fail(10007, 'This account does not have a workers.dev subdomain.')); else send(200, ok({ subdomain: acct.subdomain })); return; }
      if (m === 'PUT') {
        const want = String(json().subdomain ?? '');
        if (acct.subdomain) { send(409, fail(10036, 'The account already has a subdomain.')); return; }
        if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(want) || this.takenSubdomains.has(want)) { send(409, fail(10031, 'Subdomain is unavailable.')); return; }
        acct.subdomain = want; this.takenSubdomains.add(want);
        send(200, ok({ subdomain: want })); return;
      }
    }
    if ((r = rest.match(/^\/workers\/services\/([a-z0-9-]+)$/)) && m === 'GET') {
      if (!has('workers')) { denied(); return; }
      const s = acct.scripts.get(r[1]);
      if (!s) { send(404, fail(10090, 'workers.api.error.service_not_found')); return; }
      send(200, ok({ id: r[1], default_environment: { environment: 'production', script: { id: r[1], migration_tag: s.migrationTag ?? undefined } } })); return;
    }
    if ((r = rest.match(/^\/workers\/scripts\/([a-z0-9-]+)$/)) && m === 'PUT') {
      if (!has('workers')) { denied(); return; }
      const f = await form();
      const meta = JSON.parse(String(f.get('metadata') ?? '{}')) as Record<string, unknown>;
      entry.body = meta;
      const main = String(meta.main_module ?? '');
      const mainPart = f.get(main);
      if (!main || !mainPart || typeof mainPart === 'string') { send(400, fail(10021, 'No such module: main_module')); return; }
      const before = acct.scripts.get(r[1]);
      const migrations = meta.migrations as { old_tag?: string; new_tag: string; steps: Array<{ new_sqlite_classes?: string[] }> } | undefined;
      const bindings = (meta.bindings ?? []) as Array<{ type: string; name: string; class_name?: string; text?: string }>;
      const doClasses = bindings.filter((b) => b.type === 'durable_object_namespace').map((b) => b.class_name);
      const tag = before?.migrationTag ?? null;
      if (migrations) {
        if ((migrations.old_tag ?? null) !== tag) { send(400, fail(10079, `migration precondition failed: expected old_tag ${tag ?? 'none'}`)); return; }
      }
      const known = new Set<string>(tag ? ['Relay'] : []);
      for (const st of migrations?.steps ?? []) for (const c of st.new_sqlite_classes ?? []) known.add(c);
      for (const c of doClasses) if (!known.has(c!)) { send(400, fail(10074, `Cannot create binding for class '${c}' that is not created by a migration`)); return; }
      const keep = new Set((meta.keep_bindings ?? []) as string[]);
      const secrets = keep.has('secret_text') && before ? new Map(before.secrets) : new Map<string, string>();
      for (const b of bindings) if (b.type === 'secret_text' && b.text) secrets.set(b.name, b.text);
      const modules = new Map<string, { type: string; text: string }>();
      for (const [k, v] of f) if (k !== 'metadata' && typeof v !== 'string') modules.set(k, { type: v.type, text: await v.text() });
      const s: MockScript = { metadata: meta, modules, migrationTag: migrations?.new_tag ?? tag, secrets, workersDev: before?.workersDev ?? false, uploads: (before?.uploads ?? 0) + 1 };
      acct.scripts.set(r[1], s);
      await this.onScript?.(r[1], s);
      send(200, ok({ id: r[1], etag: crypto.randomBytes(8).toString('hex'), has_modules: true, migration_tag: s.migrationTag })); return;
    }
    if ((r = rest.match(/^\/workers\/(?:workers|scripts)\/([a-z0-9-]+)(?:\/settings)?$/)) && m === 'GET') {
      // what wrangler reads around a deploy (not used by the hub)
      if (!has('workers')) { denied(); return; }
      if (!acct.scripts.has(r[1])) { send(404, fail(10007, 'This Worker does not exist on your account.')); return; }
      send(200, ok({ id: r[1], name: r[1], observability: { enabled: true } })); return;
    }
    if ((r = rest.match(/^\/workers\/scripts\/([a-z0-9-]+)\/deployments$/)) && m === 'GET') {
      if (!has('workers')) { denied(); return; }
      const s = acct.scripts.get(r[1]);
      if (!s) { send(404, fail(10007, 'This Worker does not exist on your account.')); return; }
      send(200, ok({ deployments: [] })); return;
    }
    if ((r = rest.match(/^\/workers\/scripts\/([a-z0-9-]+)\/subdomain$/))) {
      if (!has('workers')) { denied(); return; }
      const s = acct.scripts.get(r[1]);
      if (!s) { send(404, fail(10007, 'This Worker does not exist on your account.')); return; }
      if (m === 'POST') { const j = json(); s.workersDev = !!j.enabled; }
      send(200, ok({ enabled: s.workersDev, previews_enabled: false })); return;
    }
    if ((r = rest.match(/^\/workers\/scripts\/([a-z0-9-]+)\/secrets$/))) {
      if (!has('workers')) { denied(); return; }
      const s = acct.scripts.get(r[1]);
      if (!s) { send(404, fail(10007, 'This Worker does not exist on your account.')); return; }
      if (m === 'PUT') {
        const j = json() as { name?: string; text?: string; type?: string };
        if (j.type !== 'secret_text' || !j.name || typeof j.text !== 'string') { send(400, fail(10021, 'bad secret')); return; }
        s.secrets.set(j.name, j.text);
        entry.body = { name: j.name, type: j.type, text: '(hidden)' };
        await this.onScript?.(r[1], s);
        send(200, ok({ name: j.name, type: 'secret_text' })); return;
      }
      send(200, ok([...s.secrets.keys()].map((name) => ({ name, type: 'secret_text' })))); return;
    }
    if (rest === '/pages/projects' || rest.startsWith('/pages/projects/')) {
      if (!has('pages')) { denied(); return; }
      if (rest === '/pages/projects' && m === 'POST') {
        const j = json() as { name?: string; production_branch?: string; deployment_configs?: Record<string, unknown> };
        const name = String(j.name ?? '');
        if (!/^[a-z0-9][a-z0-9-]{0,56}[a-z0-9]$/.test(name)) { send(400, fail(8000016, 'Project name is invalid.')); return; }
        if (acct.projects.has(name)) { send(409, fail(8000002, 'A project with this name already exists. Choose a different project name.')); return; }
        const subdomain = this.takenPagesNames.has(name) ? `${name}-${crypto.randomBytes(2).toString('hex')}.pages.dev` : `${name}.pages.dev`;
        this.takenPagesNames.add(name);
        const proj: MockProject = { name, subdomain, production_branch: j.production_branch ?? 'main', deployment_configs: j.deployment_configs ?? {}, deployments: [] };
        acct.projects.set(name, proj);
        send(200, ok({ name, subdomain, production_branch: proj.production_branch, deployment_configs: proj.deployment_configs })); return;
      }
      if ((r = rest.match(/^\/pages\/projects\/([a-z0-9-]+)(\/.*)?$/))) {
        const proj = acct.projects.get(r[1]);
        if (!proj) { send(404, fail(8000007, 'Project not found. The specified project name does not match any of your existing projects.')); return; }
        const sub = r[2] ?? '';
        if (sub === '' && m === 'GET') { send(200, ok({ name: proj.name, subdomain: proj.subdomain, production_branch: proj.production_branch, deployment_configs: proj.deployment_configs })); return; }
        if (sub === '' && m === 'PATCH') { const j = json(); proj.deployment_configs = { ...proj.deployment_configs, ...(j.deployment_configs as object) }; send(200, ok({ name: proj.name, subdomain: proj.subdomain, deployment_configs: proj.deployment_configs })); return; }
        if (sub === '/upload-token' && m === 'GET') { const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
          const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ max_file_count_allowed: 20000, exp: Math.floor(Date.now() / 1000) + 3600, nonce: crypto.randomBytes(6).toString('hex') })}.sig`; this.jwts.set(jwt, { account: acct.id, project: proj.name }); send(200, ok({ jwt })); return; }
        if ((r = sub.match(/^\/deployments\/([0-9a-f-]{36})$/)) && m === 'GET') {
          const dep = proj.deployments.find((d) => d.id === r![1]);
          if (!dep) { send(404, fail(8000009, 'Deployment not found.')); return; }
          send(200, ok({ id: dep.id, latest_stage: { name: 'deploy', status: 'success' } })); return;
        }
        if (sub === '/deployments' && m === 'POST') {
          const f = await form();
          const fields: Record<string, string> = {};
          for (const [k, v] of f) if (typeof v === 'string') fields[k] = v;
          const manifest = JSON.parse(fields.manifest ?? '{}') as Record<string, string>;
          for (const h of Object.values(manifest)) if (!this.assets.has(h)) { send(400, fail(8000096, `A file in the manifest was not uploaded: ${h}`)); return; }
          const wb = f.get('_worker.bundle');
          let bundle: MockProject['deployments'][number]['bundle'] = null;
          if (wb && typeof wb !== 'string') {
            // the bundle is itself a multipart body (metadata and the module), as wrangler makes it
            const bytes = Buffer.from(await wb.arrayBuffer());
            const boundary = bytes.toString('latin1').match(/^--(\S+)/)?.[1];
            if (!boundary) { send(400, fail(8000000, 'bad _worker.bundle')); return; }
            const inner = await new Request('http://x', { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body: bytes }).formData();
            const metadata = JSON.parse(String(inner.get('metadata'))) as Record<string, unknown>;
            const mainPart = inner.get(String(metadata.main_module));
            if (!mainPart || typeof mainPart === 'string') { send(400, fail(8000000, 'the bundle has no main module')); return; }
            bundle = { metadata, main: await mainPart.text() };
          }
          const hp = f.get('_headers');
          const dep = { id: crypto.randomUUID(), manifest, bundle, headers: hp && typeof hp !== 'string' ? await hp.text() : null, branch: fields.branch ?? '', fields };
          entry.body = { fields: Object.keys(fields), files: [...f.keys()].filter((k) => typeof f.get(k) !== 'string'), bundleMetadata: bundle?.metadata };
          proj.deployments.push(dep);
          send(200, ok({ id: dep.id, url: `https://${dep.id.slice(0, 8)}.${proj.subdomain}`, environment: dep.branch === proj.production_branch ? 'production' : 'preview', latest_stage: { name: 'deploy', status: 'active' } })); return;
        }
      }
    }
    if (rest === '/calls/turn_keys' || rest.startsWith('/calls/turn_keys/')) {
      if (!has('calls')) { denied(); return; }
      if (rest === '/calls/turn_keys' && m === 'GET') { send(200, ok([...acct.turnKeys.values()].map(({ uid, name, created }) => ({ uid, name, created, modified: created })))); return; }
      if (rest === '/calls/turn_keys' && m === 'POST') {
        const j = json();
        const k = { uid: crypto.randomBytes(16).toString('hex'), name: String(j.name ?? ''), secret: crypto.randomBytes(32).toString('hex'), created: new Date().toISOString() };
        acct.turnKeys.set(k.uid, k);
        send(201, ok({ uid: k.uid, name: k.name, secret: k.secret, created: k.created, modified: k.created })); return;
      }
      if ((r = rest.match(/^\/calls\/turn_keys\/([0-9a-f]{32})$/)) && m === 'DELETE') {
        if (!acct.turnKeys.delete(r[1])) { send(404, fail(10404, 'not found')); return; }
        send(200, ok({ uid: r[1] })); return;
      }
    }
    send(404, fail(7003, 'No route for that URI'));
  }

  // ------------------------------------------------------------------ workers.dev: the fake gateway
  private deployedGateway(): { acct: Account; s: MockScript } | null {
    for (const acct of this.accounts.values()) {
      const s = acct.scripts.get('dexconnect-gateway');
      if (s && s.workersDev && acct.subdomain) return { acct, s };
    }
    return null;
  }

  private workersDev(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.deployedGateway()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('There is nothing here yet\n'); return; }
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Dexterity Connect gateway\n'); return; }
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found\n');
  }

  private gatewayUpgrade(req: http.IncomingMessage, sock: import('node:stream').Duplex, head: Buffer): void {
    const g = this.deployedGateway();
    const m = (req.url ?? '').match(/^\/hub\/([0-9A-Za-z_-]{6,64})$/);
    if (!g || !m) { sock.destroy(); return; }
    this.wss.handleUpgrade(req, sock, head, (ws) => {
      const nonce = crypto.randomBytes(16).toString('base64url');
      ws.send(JSON.stringify({ t: 'challenge', n: nonce }));
      ws.once('message', (raw) => {
        try {
          const a = JSON.parse(raw.toString()) as { t: string; cert: string; spki: string; sig: string };
          const cert = Buffer.from(a.cert, 'base64');
          const x = new X509Certificate(cert);
          if (!crypto.verify('sha256', Buffer.from(`dexconnect-gw-hub-v1|${m[1]}|${nonce}`), x.publicKey, Buffer.from(a.sig, 'base64'))) throw new Error('bad signature');
          const fp = x.fingerprint256;
          const pin = g.s.secrets.get('HUB_FINGERPRINT')?.trim().toUpperCase();
          if (pin && pin !== fp) { ws.close(4403, 'This gateway belongs to another hub'); return; }
          this.hubs.push({ hubId: m[1], fp, pinned: !!pin });
          ws.send(JSON.stringify({ t: 'ready', fp, pinned: !!pin }));
        } catch { ws.close(4401, 'Authentication failed'); }
      });
    });
  }

  // ------------------------------------------------------------------ pages.dev: the deployed site
  private async pagesDev(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const proj = [...this.accounts.values()].flatMap((a) => [...a.projects.values()]).find((p) => p.deployments.length);
    const dep = proj?.deployments.at(-1);
    if (!dep) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Nothing is deployed here yet\n'); return; }
    const path = (req.url ?? '/').split('?')[0];
    const h = dep.manifest[path];
    if (h) { const a = this.assets.get(h)!; res.writeHead(200, { 'content-type': a.contentType }); res.end(Buffer.from(a.b64, 'base64')); return; }
    const binding = (dep.bundle?.metadata.bindings as Array<{ type: string; name: string; service?: string }> | undefined)?.find((b) => b.type === 'service' && b.name === 'GATEWAY');
    const acct = [...this.accounts.values()].find((a) => a.projects.get(proj!.name) === proj)!;
    if (!binding || !acct.scripts.has(binding.service ?? '')) { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('This meeting site is not connected to the office\'s gateway yet.\n'); return; }
    // the binding: the request goes to the gateway (a real one when a test runs it, else /health and a shell)
    if (this.gatewayOrigin) {
      try {
        const r = await fetch(`${this.gatewayOrigin}${req.url ?? '/'}`, { method: req.method, redirect: 'manual' });
        res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
      } catch { res.writeHead(502); res.end('The office\'s meeting service is not answering right now.\n'); }
      return;
    }
    if (path === '/health') { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Dexterity Connect gateway\n'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>Dexterity Meet</title>');
  }
}
