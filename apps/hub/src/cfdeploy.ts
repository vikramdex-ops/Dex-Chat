// "Set up with Cloudflare" (Control room ▸ Outside the office): from one pasted API token, the hub
// puts the office's Cloudflare parts in place itself, with Cloudflare's REST API and nothing else
// (no Node.js, no wrangler, no source download, no copying addresses or fingerprints):
//
//   token       the token works (/user/tokens/verify; an account-owned token is accepted when it
//               can list its account)
//   account     the account (several: the owner picks one)
//   subdomain   the account's workers.dev name, made from the office's name if there is none
//   gateway     the gateway Worker uploaded as `wrangler deploy` uploads it: the module, the Relay
//               Durable Object binding and its migrations (only those not applied yet), the
//               compatibility date, secrets kept
//   pin         HUB_FINGERPRINT set to this hub's certificate fingerprint
//   workersdev  the Worker's workers.dev address switched on
//   project     the Pages project for Dexterity Meet (dexterity-meet, or a free name, remembered)
//   site        the site deployed as `wrangler pages deploy` deploys it: files by hash (only the
//               missing ones uploaded), _headers, and the front door with its GATEWAY service binding
//   connect     the hub pointed at both addresses, outside access on (who may join and the Control
//               room from outside stay as the administrator set them)
//   verify      the gateway answers, the hub signs in and the gateway reports it pinned, and the
//               meeting site reaches the gateway through its binding
//   turn        a Cloudflare Realtime TURN key for calls, checked by asking it for credentials,
//               saved as "Calls across networks ▸ Cloudflare TURN"
//
// Every step is recorded (meta cf_setup), so running it again updates everything in place and
// never makes a second Worker, project or TURN key; a failed step says why in plain words and
// Retry continues there. The token is used for the run and then forgotten, unless the owner ticks
// "Keep for updates" (then it is stored like the TURN token and never sent to any device).
// The Worker and the site come from the hub's own package (scripts/build-cloud.mjs), so a hub
// update that carries a newer gateway offers "Update the gateway".
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CF_STEPS } from '@dex/core/cfsetup';
import type { CfPermission, CfProblem, CfSetupView, CfStep, CfStepState } from '@dex/core/cfsetup';

// ------------------------------------------------------------------ what the hub carries
export interface CloudBundle {
  format: 1;
  builtAt: string;
  gateway: {
    name: string;
    hash: string;
    metadata: Record<string, unknown>;
    migrations: Array<{ tag: string } & Record<string, unknown>>;
    modules: Array<{ name: string; type: string; text: string }>;
    workersDev: boolean;
    previews: boolean;
  };
  site: {
    name: string;
    hash: string;
    productionBranch: string;
    compatibility_date: string;
    compatibility_flags: string[];
    services: Array<{ name: string; type: 'service'; service: string; environment?: string }>;
    configHash: string;
    outputDir: string;
    files: Array<{ path: string; hash: string; contentType: string; b64: string }>;
    headers: string | null;
    worker: { name: string; text: string };
  };
}

let cached: { bundle: CloudBundle | null } | null = null;
/**
 * The Cloudflare parts this hub carries: inside the single executable (a SEA asset), or
 * cloud-bundle.json beside hub.cjs, or apps/hub/dist when run from the source, or DEX_CLOUD_BUNDLE.
 */
export function loadCloudBundle(): CloudBundle | null {
  if (cached) return cached.bundle;
  const parse = (text: string): CloudBundle | null => {
    try { const b = JSON.parse(text) as CloudBundle; return b.format === 1 && b.gateway && b.site ? b : null; } catch { return null; }
  };
  let bundle: CloudBundle | null = null;
  try {
    const req = createRequire(path.join(process.cwd(), 'x.js'));
    const sea = req('node:sea') as { isSea(): boolean; getAsset(k: string, enc: string): string };
    if (sea.isSea()) bundle = parse(sea.getAsset('cloud-bundle.json', 'utf8'));
  } catch { /* not a single executable, or no asset */ }
  if (!bundle) {
    const main = process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : process.cwd();
    const candidates = [process.env.DEX_CLOUD_BUNDLE, path.join(main, 'cloud-bundle.json'), path.join(main, '../dist/cloud-bundle.json'), path.join(path.dirname(process.execPath), 'cloud-bundle.json')];
    for (const c of candidates) {
      if (!c) continue;
      try { bundle = parse(fs.readFileSync(c, 'utf8')); } catch { /* not there */ }
      if (bundle) break;
    }
  }
  cached = { bundle };
  return bundle;
}

// ------------------------------------------------------------------ where Cloudflare is
export interface CfEndpoints {
  /** https://api.cloudflare.com/client/v4 */
  api: string;
  /** https://rtc.live.cloudflare.com (TURN credentials) */
  rtc: string;
  /** The Worker's workers.dev address. */
  workersDev: (script: string, subdomain: string) => string;
  /** The Pages project's address, from its subdomain (dexterity-meet.pages.dev). */
  pagesDev: (subdomain: string) => string;
}

/**
 * Cloudflare's real addresses. DEX_CLOUDFLARE_API, DEX_CLOUDFLARE_RTC, DEX_CLOUDFLARE_WORKERS_DEV
 * and DEX_CLOUDFLARE_PAGES_DEV replace them for tests against a stand-in (apps/hub/test/cfmock.ts).
 */
export function cloudflareEndpoints(env: NodeJS.ProcessEnv = process.env): CfEndpoints {
  const strip = (u: string) => u.replace(/\/+$/, '');
  return {
    api: strip(env.DEX_CLOUDFLARE_API || 'https://api.cloudflare.com/client/v4'),
    rtc: strip(env.DEX_CLOUDFLARE_RTC || 'https://rtc.live.cloudflare.com'),
    workersDev: env.DEX_CLOUDFLARE_WORKERS_DEV ? () => strip(env.DEX_CLOUDFLARE_WORKERS_DEV!) : (script, sub) => `https://${script}.${sub}.workers.dev`,
    pagesDev: env.DEX_CLOUDFLARE_PAGES_DEV ? () => strip(env.DEX_CLOUDFLARE_PAGES_DEV!) : (sub) => `https://${sub.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`,
  };
}

// ------------------------------------------------------------------ the deployer
interface State {
  phase: CfSetupView['phase'];
  steps: Partial<Record<CfStep, { state: CfStepState; at: number }>>;
  problem: CfProblem | null;
  accounts: Array<{ id: string; name: string }>;
  accountId: string | null;
  accountName: string | null;
  subdomain: string | null;
  gatewayUrl: string | null;
  gatewayHash: string | null;
  projectName: string | null;
  siteUrl: string | null;
  siteHash: string | null;
  turnKeyId: string | null;
  deployedAt: number | null;
  startedAt: number | null;
}
const EMPTY: State = {
  phase: 'idle', steps: {}, problem: null, accounts: [], accountId: null, accountName: null, subdomain: null, gatewayUrl: null, gatewayHash: null,
  projectName: null, siteUrl: null, siteHash: null, turnKeyId: null, deployedAt: null, startedAt: null,
};

export interface CfSetupOptions {
  hubId: string;
  hubName: () => string;
  fingerprint: string;
  version: string;
  meta: { get(key: string): string; set(key: string, value: string): void };
  bundle?: () => CloudBundle | null;
  endpoints?: CfEndpoints;
  fetch?: typeof fetch;
  /** Point the hub at the gateway and the meeting site and switch outside access on. */
  connect: (gatewayUrl: string, siteUrl: string) => void;
  /** Leave the gateway and connect again (to read a new pin). */
  reconnect: () => void;
  gatewayStatus: () => { connected: boolean; pinned: boolean; error: string | null; url: string | null };
  turnConfig: () => { mode: string; keyId: string | null; token: string | null };
  setTurn: (keyId: string, token: string) => void;
  changed: (view: CfSetupView) => void;
  audit: (actor: string, action: string, detail: Record<string, unknown>) => void;
  log: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
  /** How long to wait for new addresses (DNS), the hub's sign-in, and Cloudflare's deployments. */
  waits?: { addressMs?: number; connectMs?: number; deployMs?: number; pollMs?: number };
  /** How long a failed run keeps its token in memory for Retry (default 30 minutes). */
  holdMs?: number;
}

export class CfSetupError extends Error {}

/** A Cloudflare API answer that was not a success (status 0: Cloudflare could not be reached). */
class CfApiError extends Error {
  readonly status: number;
  readonly code: number | null;
  constructor(status: number, code: number | null, message: string) { super(message); this.status = status; this.code = code; }
}
/** Stops the run at a step, with what to tell the owner. */
class Stop extends Error {
  readonly problem: Omit<CfProblem, 'step'>;
  constructor(problem: Omit<CfProblem, 'step'>) { super(problem.code); this.problem = problem; }
}
/** Stops the run without a failure: waiting for the owner to pick an account. */
class Pause extends Error {}

/** Which permission each step needs (what a 403 there means). */
const STEP_PERM: Partial<Record<CfStep, CfPermission>> = {
  account: 'account', subdomain: 'workers', gateway: 'workers', pin: 'workers', workersdev: 'workers', project: 'pages', site: 'pages', turn: 'calls',
};
const META_STATE = 'cf_setup';
const META_TOKEN = 'cf_token';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref?.());

/** A workers.dev or Pages name from the office's name: "Dexterity Design Services" → dexterity-design-services. */
export function cfSlug(name: string, max = 30): string {
  const s = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
  return /^[a-z]/.test(s) && s.length >= 3 ? s : `dexconnect${s ? `-${s}` : ''}`.slice(0, max).replace(/-+$/, '');
}
const rand = (n: number) => Array.from({ length: n }, () => 'abcdefghijkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 32)]).join('');

/** Which migrations a Worker still needs, given the tag it has (as wrangler works it out). */
export function pendingMigrations(all: CloudBundle['gateway']['migrations'], tag: string | null): Record<string, unknown> | undefined {
  if (!all.length) return undefined;
  const steps = (list: typeof all) => list.map(({ tag: _t, ...rest }) => rest);
  const last = all[all.length - 1].tag;
  if (!tag) return { new_tag: last, steps: steps(all) };
  const i = all.findIndex((m) => m.tag === tag);
  if (i === -1) return { old_tag: tag, new_tag: last, steps: steps(all) };
  if (i === all.length - 1) return undefined;
  return { old_tag: tag, new_tag: last, steps: steps(all.slice(i + 1)) };
}

export class CfSetup {
  private state: State;
  private token: string | null = null;
  private keep = false;
  private chosen: string | null = null;
  private listed: Array<{ id: string; name: string }> | null = null;
  private running: Promise<void> | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private actor = '';
  private readonly ep: CfEndpoints;
  private readonly fetchFn: typeof fetch;
  private readonly waits: Required<NonNullable<CfSetupOptions['waits']>>;
  private stopped = false;
  private readonly o: CfSetupOptions;

  constructor(o: CfSetupOptions) {
    this.o = o;
    this.ep = o.endpoints ?? cloudflareEndpoints();
    this.fetchFn = o.fetch ?? fetch;
    this.waits = { addressMs: 4 * 60_000, connectMs: 90_000, deployMs: 120_000, pollMs: 3000, ...o.waits };
    let s: State = { ...EMPTY };
    try { const raw = o.meta.get(META_STATE); if (raw) s = { ...EMPTY, ...JSON.parse(raw) as Partial<State> }; } catch { /* start afresh */ }
    // the hub stopped in the middle of a run: it continues from that step on Retry
    if (s.phase === 'running') {
      const at = CF_STEPS.find((id) => s.steps[id]?.state === 'running') ?? 'token';
      s = { ...s, phase: 'failed', problem: { step: at, code: 'interrupted' }, steps: { ...s.steps, [at]: { state: 'failed', at: Date.now() } } };
    }
    this.state = s;
    this.keep = !!o.meta.get(META_TOKEN);
  }

  private bundle(): CloudBundle | null { return (this.o.bundle ?? loadCloudBundle)(); }

  view(): CfSetupView {
    const s = this.state;
    const b = this.bundle();
    return {
      phase: s.phase,
      steps: CF_STEPS.map((id) => ({ id, state: s.steps[id]?.state ?? 'todo', at: s.steps[id]?.at ?? null })),
      problem: s.problem,
      accounts: s.phase === 'choose' ? s.accounts : [],
      account: s.accountId ? { id: s.accountId, name: s.accountName ?? s.accountId } : null,
      gatewayUrl: s.gatewayUrl,
      siteUrl: s.siteUrl,
      projectName: s.projectName,
      turnKeyId: s.turnKeyId,
      tokenKept: !!this.o.meta.get(META_TOKEN),
      tokenHeld: !!this.token || !!this.o.meta.get(META_TOKEN),
      bundled: !!b,
      updateAvailable: !!b && !!s.gatewayHash && (b.gateway.hash !== s.gatewayHash || (!!s.siteHash && b.site.hash !== s.siteHash)),
      deployedAt: s.deployedAt,
      startedAt: s.startedAt,
    };
  }

  /** The hub is stopping: a run in progress ends at its next step. */
  stop(): void {
    this.stopped = true;
    if (this.holdTimer) clearTimeout(this.holdTimer);
  }

  /** Wait for a run in progress (tests, and the hub stopping). */
  async idle(): Promise<void> { await this.running?.catch(() => {}); }

  start(actor: string, token: string, opts: { keep?: boolean; accountId?: string } = {}): CfSetupView {
    this.begin(actor, token, opts.keep);
    if (opts.accountId) this.chosen = opts.accountId;
    // a new run: every step again (each one updates what is there)
    this.state = { ...this.state, steps: {}, problem: null, phase: 'running', startedAt: Date.now() };
    this.launch('token');
    return this.view();
  }

  choose(actor: string, accountId: string): CfSetupView {
    if (this.state.phase !== 'choose') throw new CfSetupError('There is no account to choose now.');
    if (!this.state.accounts.some((a) => a.id === accountId)) throw new CfSetupError('That account is not one this token can use.');
    if (!this.token) throw new CfSetupError('Paste the token again: the hub no longer holds it.');
    this.actor = actor;
    this.chosen = accountId;
    this.state = { ...this.state, phase: 'running', problem: null };
    this.launch('account');
    return this.view();
  }

  retry(actor: string, token?: string, keep?: boolean): CfSetupView {
    if (this.state.phase !== 'failed') throw new CfSetupError('There is nothing to retry.');
    this.begin(actor, token ?? this.token ?? this.o.meta.get(META_TOKEN), keep ?? this.keep);
    const from = this.resumeAt(this.state.problem?.step ?? 'token');
    this.state = { ...this.state, phase: 'running', problem: null };
    this.launch(from);
    return this.view();
  }

  /** "Update the gateway": the same run, which puts this hub version's Worker and site in place. */
  update(actor: string, token?: string, keep?: boolean): CfSetupView {
    if (!this.state.gatewayHash) throw new CfSetupError('Set up with Cloudflare first.');
    return this.start(actor, token ?? this.token ?? this.o.meta.get(META_TOKEN), { keep: keep ?? this.keep });
  }

  forget(actor: string): CfSetupView {
    this.token = null;
    this.keep = false;
    this.o.meta.set(META_TOKEN, '');
    this.o.audit(actor, 'cloudflare.forget', {});
    this.emit();
    return this.view();
  }

  private begin(actor: string, token: string | null | undefined, keep?: boolean): void {
    if (this.running) throw new CfSetupError('The setup is already running.');
    if (!this.bundle()) throw new CfSetupError('This hub was built without the Cloudflare parts. Use Deploy-Gateway.cmd instead (docs/REMOTE-ACCESS.md).');
    const t = (token ?? '').trim();
    if (!t) throw new CfSetupError('Paste the Cloudflare API token.');
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(t)) throw new CfSetupError('That does not look like a Cloudflare API token: it is a single line of letters, digits, - and _.');
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.actor = actor;
    this.token = t;
    this.keep = !!keep;
    // kept only when asked; unticking forgets a token kept before
    this.o.meta.set(META_TOKEN, this.keep ? t : '');
    this.listed = null;
  }

  /** Retry from the failed step, or earlier if what it needs was never recorded. */
  private resumeAt(step: CfStep): CfStep {
    const s = this.state;
    const i = CF_STEPS.indexOf(step);
    const need: Array<[CfStep, boolean]> = [['account', !!s.accountId], ['subdomain', !!s.subdomain], ['gateway', !!s.gatewayHash], ['project', !!s.projectName && !!s.siteUrl]];
    // the token step lists the accounts the account step needs
    for (const [at, ok] of need) if (CF_STEPS.indexOf(at) < i && !ok) return at === 'account' ? 'token' : at;
    return step === 'account' ? 'token' : step;
  }

  private launch(from: CfStep): void {
    this.save();
    this.emit();
    const p = this.run(from).finally(() => { if (this.running === p) this.running = null; this.emit(); });
    this.running = p;
  }

  private save(): void { this.o.meta.set(META_STATE, JSON.stringify(this.state)); }
  private emit(): void { try { this.o.changed(this.view()); } catch { /* nobody listening */ } }
  private mark(id: CfStep, state: CfStepState): void {
    this.state = { ...this.state, steps: { ...this.state.steps, [id]: { state, at: Date.now() } } };
    this.save();
    this.emit();
  }

  private async run(from: CfStep): Promise<void> {
    const steps: Record<CfStep, () => Promise<void>> = {
      token: () => this.stepToken(), account: () => this.stepAccount(), subdomain: () => this.stepSubdomain(), gateway: () => this.stepGateway(),
      pin: () => this.stepPin(), workersdev: () => this.stepWorkersDev(), project: () => this.stepProject(), site: () => this.stepSite(),
      connect: () => this.stepConnect(), verify: () => this.stepVerify(), turn: () => this.stepTurn(),
    };
    for (const id of CF_STEPS.slice(CF_STEPS.indexOf(from))) {
      if (this.stopped) return;
      this.mark(id, 'running');
      try {
        await steps[id]();
        this.mark(id, 'done');
      } catch (err) {
        if (err instanceof Pause) {
          this.state = { ...this.state, phase: 'choose', steps: { ...this.state.steps, [id]: { state: 'todo', at: Date.now() } } };
          this.save();
          return;
        }
        const problem: CfProblem = { step: id, ...this.problemOf(id, err) };
        this.state = { ...this.state, phase: 'failed', problem, steps: { ...this.state.steps, [id]: { state: 'failed', at: Date.now() } } };
        this.save();
        this.o.log('warn', 'Cloudflare setup stopped', { step: id, code: problem.code, detail: problem.detail });
        this.o.audit(this.actor, 'cloudflare.failed', { step: id, code: problem.code, perm: problem.perm ?? null });
        // the token stays in memory a while, so Retry needs no paste
        if (!this.o.meta.get(META_TOKEN)) {
          if (this.holdTimer) clearTimeout(this.holdTimer);
          this.holdTimer = setTimeout(() => { this.token = null; this.holdTimer = null; this.emit(); }, this.o.holdMs ?? 30 * 60_000);
          this.holdTimer.unref?.();
        }
        return;
      }
    }
    const b = this.bundle()!;
    this.state = { ...this.state, phase: 'done', problem: null, accounts: [], deployedAt: Date.now() };
    this.save();
    if (!this.o.meta.get(META_TOKEN)) this.token = null;
    this.o.audit(this.actor, 'cloudflare.setup', { account: this.state.accountId, gateway: this.state.gatewayUrl, site: this.state.siteUrl, gatewayVersion: b.gateway.hash, siteVersion: b.site.hash, turnKey: this.state.turnKeyId });
    this.o.log('info', 'Cloudflare setup done', { gateway: this.state.gatewayUrl, site: this.state.siteUrl });
  }

  private problemOf(step: CfStep, err: unknown): Omit<CfProblem, 'step'> {
    if (err instanceof Stop) return err.problem;
    if (err instanceof CfApiError) {
      if (err.status === 0) return { code: 'network', detail: err.message };
      if (err.status === 401 || err.code === 1000 || err.code === 9109) return { code: 'token' };
      if (err.status === 403 || err.code === 10000) return { code: 'permission', perm: STEP_PERM[step] ?? 'account' };
      return { code: 'cloudflare', detail: `${err.message}${err.code ? ` (code ${err.code})` : ''}`.slice(0, 300) };
    }
    return { code: 'cloudflare', detail: (err as Error)?.message?.slice(0, 300) ?? String(err) };
  }

  // ---------------------------------------------------------------- Cloudflare's API
  private async call<T>(method: string, p: string, body?: { json?: unknown; form?: FormData; jwt?: string }, headers: Record<string, string> = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.ep.api}${p}`, {
        method,
        headers: { authorization: `Bearer ${body?.jwt ?? this.token}`, ...(body?.json !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body?.form ?? (body?.json !== undefined ? JSON.stringify(body.json) : undefined),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new CfApiError(0, null, (err as Error).message);
    }
    let j: { success?: boolean; result?: T; errors?: Array<{ code?: number; message?: string }> } = {};
    try { j = await res.json() as typeof j; } catch { /* not JSON */ }
    if (!res.ok || j.success === false) {
      const e = j.errors?.[0];
      throw new CfApiError(res.status, typeof e?.code === 'number' ? e.code : null, e?.message ?? `Cloudflare answered ${res.status}`);
    }
    return j.result as T;
  }
  private acct(p: string): string { return `/accounts/${encodeURIComponent(this.state.accountId!)}${p}`; }
  private set(p: Partial<State>): void { this.state = { ...this.state, ...p }; this.save(); }

  // ---------------------------------------------------------------- the steps
  private async stepToken(): Promise<void> {
    try {
      const r = await this.call<{ status?: string }>('GET', '/user/tokens/verify');
      if (r?.status && r.status !== 'active') throw new Stop({ code: 'token', detail: `The token is ${r.status}.` });
    } catch (err) {
      // an account-owned token is not a user's: it is fine if it can list its account
      if (!(err instanceof CfApiError) || !(err.status === 401 || err.status === 403 || err.code === 1000)) throw err;
      try { this.listed = await this.listAccounts(); } catch { throw new Stop({ code: 'token' }); }
      if (!this.listed.length) throw new Stop({ code: 'token' });
    }
  }

  private async listAccounts(): Promise<Array<{ id: string; name: string }>> {
    const r = await this.call<Array<{ id: string; name: string }>>('GET', '/accounts?per_page=50');
    return (r ?? []).filter((a) => /^[0-9a-f]{32}$/.test(a.id)).map((a) => ({ id: a.id, name: String(a.name ?? a.id).slice(0, 120) }));
  }

  private async stepAccount(): Promise<void> {
    const list = this.listed ?? await this.listAccounts();
    if (!list.length) throw new Stop({ code: 'no-account' });
    const pick = list.find((a) => a.id === this.chosen) ?? list.find((a) => a.id === this.state.accountId) ?? (list.length === 1 ? list[0] : null);
    if (!pick) { this.set({ accounts: list }); throw new Pause(); }
    // another account than last time: nothing recorded for the old one applies
    if (this.state.accountId && this.state.accountId !== pick.id) {
      this.set({ subdomain: null, gatewayUrl: null, gatewayHash: null, projectName: null, siteUrl: null, siteHash: null, turnKeyId: null });
    }
    this.chosen = null;
    this.set({ accountId: pick.id, accountName: pick.name, accounts: [] });
  }

  private async stepSubdomain(): Promise<void> {
    try {
      const r = await this.call<{ subdomain: string }>('GET', this.acct('/workers/subdomain'));
      if (r?.subdomain) { this.set({ subdomain: r.subdomain }); return; }
    } catch (err) {
      if (!(err instanceof CfApiError) || !(err.code === 10007 || err.status === 404)) throw err;
    }
    // none yet: one from the office's name, then with a few letters added if someone has it
    const base = cfSlug(this.o.hubName());
    const tries = [base, `${base.slice(0, 24)}-${rand(4)}`, `${base.slice(0, 24)}-${rand(5)}`, `dexconnect-${rand(6)}`];
    let last = '';
    for (const name of tries) {
      try {
        const r = await this.call<{ subdomain: string }>('PUT', this.acct('/workers/subdomain'), { json: { subdomain: name } });
        this.set({ subdomain: r?.subdomain || name });
        return;
      } catch (err) {
        if (!(err instanceof CfApiError) || err.status === 401 || err.status === 403 || err.status === 0) throw err;
        last = err.message;
      }
    }
    throw new Stop({ code: 'subdomain', detail: last });
  }

  private async stepGateway(): Promise<void> {
    const g = this.bundle()!.gateway;
    let tag: string | null = null;
    try {
      const svc = await this.call<{ default_environment?: { script?: { migration_tag?: string } } }>('GET', this.acct(`/workers/services/${g.name}`));
      tag = svc?.default_environment?.script?.migration_tag ?? null;
    } catch (err) {
      if (!(err instanceof CfApiError) || !(err.status === 404 || err.code === 10090 || err.code === 10007)) throw err;
    }
    const migrations = pendingMigrations(g.migrations, tag);
    const metadata = { ...g.metadata, ...(migrations ? { migrations } : {}), keep_bindings: ['secret_text', 'secret_key'] };
    const form = new FormData();
    form.set('metadata', JSON.stringify(metadata));
    for (const m of g.modules) form.set(m.name, new File([m.text], m.name, { type: m.type }));
    await this.call('PUT', this.acct(`/workers/scripts/${g.name}`), { form });
    this.set({ gatewayHash: g.hash });
  }

  private async stepPin(): Promise<void> {
    const g = this.bundle()!.gateway;
    await this.call('PUT', this.acct(`/workers/scripts/${g.name}/secrets`), { json: { name: 'HUB_FINGERPRINT', text: this.o.fingerprint, type: 'secret_text' } });
  }

  private async stepWorkersDev(): Promise<void> {
    const g = this.bundle()!.gateway;
    await this.call('POST', this.acct(`/workers/scripts/${g.name}/subdomain`), { json: { enabled: true, previews_enabled: g.previews } }, { 'Cloudflare-Workers-Script-Api-Date': '2025-08-01' });
    this.set({ gatewayUrl: this.ep.workersDev(g.name, this.state.subdomain!) });
  }

  private async stepProject(): Promise<void> {
    const site = this.bundle()!.site;
    const config = { compatibility_date: site.compatibility_date, compatibility_flags: site.compatibility_flags };
    const first = this.state.projectName ?? site.name;
    const names = [first, `${site.name}-${(this.state.subdomain ?? '').slice(0, 20) || rand(5)}`.replace(/-+$/, ''), `${site.name}-${rand(5)}`].filter((n, i, a) => a.indexOf(n) === i);
    let last = '';
    for (const name of names) {
      const found = await this.call<{ name: string; subdomain?: string }>('GET', this.acct(`/pages/projects/${name}`)).catch((err) => {
        if (err instanceof CfApiError && (err.status === 404 || err.code === 8000007)) return null;
        throw err;
      });
      if (found) { this.set({ projectName: name, siteUrl: this.ep.pagesDev(found.subdomain || `${name}.pages.dev`) }); return; }
      try {
        const made = await this.call<{ name: string; subdomain?: string }>('POST', this.acct('/pages/projects'), { json: { name, production_branch: site.productionBranch, deployment_configs: { production: config, preview: config } } });
        this.set({ projectName: name, siteUrl: this.ep.pagesDev(made?.subdomain || `${name}.pages.dev`) });
        return;
      } catch (err) {
        if (!(err instanceof CfApiError) || err.status === 401 || err.status === 403 || err.status === 0) throw err;
        // made by a run that did not hear the answer: use it
        if (err.code === 8000002 || err.status === 409) {
          const again = await this.call<{ name: string; subdomain?: string }>('GET', this.acct(`/pages/projects/${name}`)).catch(() => null);
          if (again) { this.set({ projectName: name, siteUrl: this.ep.pagesDev(again.subdomain || `${name}.pages.dev`) }); return; }
        }
        last = err.message;
      }
    }
    throw new Stop({ code: 'cloudflare', detail: `Cloudflare would not make the meeting site's project: ${last}` });
  }

  private async stepSite(): Promise<void> {
    const site = this.bundle()!.site;
    const project = this.state.projectName!;
    const { jwt } = await this.call<{ jwt: string }>('GET', this.acct(`/pages/projects/${project}/upload-token`));
    const hashes = [...new Set(site.files.map((f) => f.hash))];
    const missing = new Set(await this.call<string[]>('POST', '/pages/assets/check-missing', { json: { hashes }, jwt }) ?? hashes);
    // the missing files, a few MB at a time
    let batch: Array<{ key: string; value: string; metadata: { contentType: string }; base64: true }> = [];
    let size = 0;
    const flush = async () => { if (batch.length) await this.call('POST', '/pages/assets/upload', { json: batch, jwt }); batch = []; size = 0; };
    const sent = new Set<string>();
    for (const f of site.files) {
      if (!missing.has(f.hash) || sent.has(f.hash)) continue;
      sent.add(f.hash);
      if (size + f.b64.length > 8 << 20) await flush();
      batch.push({ key: f.hash, value: f.b64, metadata: { contentType: f.contentType }, base64: true });
      size += f.b64.length;
    }
    await flush();
    await this.call('POST', '/pages/assets/upsert-hashes', { json: { hashes }, jwt }).catch(() => { /* only makes the next upload quicker */ });

    // the front door, as `wrangler pages deploy` packs it: metadata (with the GATEWAY binding) and the module
    const inner = new FormData();
    inner.set('metadata', JSON.stringify({ main_module: site.worker.name, bindings: site.services, compatibility_date: site.compatibility_date, compatibility_flags: site.compatibility_flags }));
    inner.set(site.worker.name, new File([site.worker.text], site.worker.name, { type: 'application/javascript+module' }));
    const workerBundle = await new Response(inner).blob();
    const form = new FormData();
    form.set('manifest', JSON.stringify(Object.fromEntries(site.files.map((f) => [f.path, f.hash]))));
    form.set('branch', site.productionBranch);
    form.set('commit_message', `Dexterity Connect hub ${this.o.version} (site ${site.hash})`);
    form.set('commit_dirty', 'false');
    form.set('wrangler_config_hash', site.configHash);
    form.set('pages_build_output_dir', site.outputDir);
    if (site.headers) form.set('_headers', new File([site.headers], '_headers'));
    form.set('_worker.bundle', new File([workerBundle], '_worker.bundle'));
    const dep = await this.call<{ id: string; latest_stage?: { status?: string } }>('POST', this.acct(`/pages/projects/${project}/deployments`), { form });
    // Cloudflare builds nothing here, but the deployment goes live a moment later
    const until = Date.now() + this.waits.deployMs;
    let stage = dep?.latest_stage?.status;
    while (dep?.id && stage !== 'success') {
      if (stage === 'failure' || stage === 'canceled') throw new Stop({ code: 'cloudflare', detail: 'Cloudflare could not publish the meeting site.' });
      if (Date.now() > until) break;
      await sleep(this.waits.pollMs);
      const d = await this.call<{ latest_stage?: { status?: string } }>('GET', this.acct(`/pages/projects/${project}/deployments/${dep.id}`)).catch(() => null);
      stage = d?.latest_stage?.status ?? stage;
    }
    this.set({ siteHash: site.hash });
  }

  private async stepConnect(): Promise<void> {
    this.o.connect(this.state.gatewayUrl!, this.state.siteUrl!);
  }

  private async get(url: string): Promise<{ status: number; text: string } | null> {
    try {
      const r = await this.fetchFn(url, { signal: AbortSignal.timeout(15_000), redirect: 'manual' });
      return { status: r.status, text: await r.text() };
    } catch { return null; }
  }

  private async stepVerify(): Promise<void> {
    const gw = this.state.gatewayUrl!;
    const site = this.state.siteUrl!;
    const answers = (r: { status: number; text: string } | null) => !!r && r.status === 200 && r.text.startsWith('Dexterity Connect gateway');
    // 1. the gateway answers on its address (a new workers.dev name can take a few minutes)
    let until = Date.now() + this.waits.addressMs;
    while (!answers(await this.get(`${gw}/health`))) {
      if (Date.now() > until || this.stopped) throw new Stop({ code: 'dns', detail: gw });
      await sleep(this.waits.pollMs);
    }
    // 2. the hub signs in, and the gateway says it is pinned to this hub
    until = Date.now() + this.waits.connectMs;
    let nudged = false;
    for (;;) {
      const s = this.o.gatewayStatus();
      if (s.connected && s.pinned) break;
      if (/another hub/i.test(s.error ?? '')) throw new Stop({ code: 'not-pinned', detail: s.error ?? undefined });
      // connected before the pin reached the gateway: connect again to read it
      if (s.connected && !s.pinned && !nudged && Date.now() > until - this.waits.connectMs / 2) { nudged = true; this.o.reconnect(); }
      if (Date.now() > until || this.stopped) throw new Stop(s.connected ? { code: 'not-pinned' } : { code: 'not-connected', detail: s.error ?? undefined });
      await sleep(Math.min(this.waits.pollMs, 1000));
    }
    // 3. the meeting site: its own files, and the gateway through its binding
    const asset = this.bundle()!.site.files.find((f) => f.path.endsWith('.js'));
    until = Date.now() + this.waits.addressMs;
    for (;;) {
      const viaBinding = answers(await this.get(`${site}/health`));
      const own = !asset || (await this.get(`${site}${asset.path}`))?.status === 200;
      if (viaBinding && own) break;
      if (Date.now() > until || this.stopped) throw new Stop({ code: viaBinding ? 'dns' : 'site', detail: site });
      await sleep(this.waits.pollMs);
    }
  }

  /** Does this TURN key give credentials (a short-lived set, used for nothing)? */
  private async turnWorks(keyId: string, secret: string): Promise<boolean> {
    try {
      const r = await this.fetchFn(`${this.ep.rtc}/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
        method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ ttl: 300 }), signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) return false;
      const j = await r.json() as { iceServers?: unknown };
      return Array.isArray(j.iceServers) ? j.iceServers.length > 0 : !!j.iceServers;
    } catch { return false; }
  }

  private async stepTurn(): Promise<void> {
    const cur = this.o.turnConfig();
    // the office runs its own TURN server: leave it
    if (cur.mode === 'custom') return;
    if (cur.keyId && cur.token && cur.keyId === this.state.turnKeyId && await this.turnWorks(cur.keyId, cur.token)) return;
    const name = `dexterity-connect-${this.o.hubId}`.slice(0, 64);
    const keys = await this.call<Array<{ uid: string; name: string }>>('GET', this.acct('/calls/turn_keys')) ?? [];
    // ours from an earlier run whose token the hub no longer has: replaced, not piled up
    for (const k of keys) if (k.name === name) await this.call('DELETE', this.acct(`/calls/turn_keys/${k.uid}`)).catch(() => {});
    const made = await this.call<{ uid: string; secret?: string; key?: string }>('POST', this.acct('/calls/turn_keys'), { json: { name } });
    const secret = made?.secret ?? made?.key ?? '';
    if (!made?.uid || !secret) throw new Stop({ code: 'cloudflare', detail: 'Cloudflare made a TURN key but did not return its token.' });
    this.set({ turnKeyId: made.uid });
    let works = false;
    for (let i = 0; i < 5 && !works; i++) { works = await this.turnWorks(made.uid, secret); if (!works) await sleep(this.waits.pollMs); }
    if (!works) throw new Stop({ code: 'cloudflare', detail: 'The new TURN key does not give call credentials yet. Retry in a minute.' });
    this.o.setTurn(made.uid, secret);
  }
}
