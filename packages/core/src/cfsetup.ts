// "Set up with Cloudflare" (Control room ▸ Outside the office): the owner pastes one Cloudflare
// API token, and the hub deploys the gateway Worker and the meeting site, pins the gateway to
// itself, makes a TURN key for calls, turns outside access on and checks it all works
// (apps/hub/src/cfdeploy.ts, docs/REMOTE-ACCESS.md). Shared by the hub and the Control room.

/** The steps, in order. Each is recorded on the hub, so a run can continue where one failed. */
export const CF_STEPS = ['token', 'account', 'subdomain', 'gateway', 'pin', 'workersdev', 'project', 'site', 'connect', 'verify', 'turn'] as const;
export type CfStep = typeof CF_STEPS[number];
export type CfStepState = 'todo' | 'running' | 'done' | 'failed';

/**
 * Why a step stopped, as a code the Control room words (and translates) itself:
 * - token: Cloudflare did not accept the token (wrong, expired or revoked);
 * - permission: the token lacks `perm` (one of CF_PERMISSIONS' names);
 * - no-account: the token reaches no account;
 * - subdomain: no workers.dev name could be made (`detail`: what Cloudflare said);
 * - network: Cloudflare could not be reached from the hub PC;
 * - cloudflare: Cloudflare refused, with its own message in `detail`;
 * - dns: the new addresses do not answer yet (new accounts take a few minutes);
 * - not-connected / not-pinned: the hub did not sign in to the gateway / the gateway did not pin it;
 * - site: the meeting site does not reach the gateway;
 * - no-bundle: this hub was built without the Cloudflare parts;
 * - interrupted: the hub stopped during the run.
 */
export type CfProblemCode = 'token' | 'permission' | 'no-account' | 'subdomain' | 'network' | 'cloudflare' | 'dns' | 'not-connected' | 'not-pinned' | 'site' | 'no-bundle' | 'interrupted';
export interface CfProblem { step: CfStep; code: CfProblemCode; perm?: CfPermission; detail?: string }

/** The token's permissions, as Cloudflare's token form names them. */
export const CF_PERMISSIONS = {
  workers: 'Account · Workers Scripts · Edit',
  pages: 'Account · Cloudflare Pages · Edit',
  calls: 'Account · Cloudflare Realtime (Calls) · Edit',
  account: 'Account · Account Settings · Read',
} as const;
export type CfPermission = keyof typeof CF_PERMISSIONS;

/**
 * Cloudflare's "Create API token" page with the permissions filled in (Cloudflare's documented
 * token template link: permissionGroupKeys). Realtime has no key a template link can carry for a
 * personal token, so the owner adds that one row by hand (the Control room says how).
 */
export const CF_TOKEN_LINK = `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(JSON.stringify([
  { key: 'workers_scripts', type: 'edit' },
  { key: 'page', type: 'edit' },
  { key: 'account_settings', type: 'read' },
]))}&accountId=*&zoneId=all&name=${encodeURIComponent('Dexterity Connect hub')}`;
export const CF_SIGNUP_LINK = 'https://dash.cloudflare.com/sign-up';

export interface CfSetupView {
  /** idle: never run (or reset); running; choose: several accounts, pick one; failed; done. */
  phase: 'idle' | 'running' | 'choose' | 'failed' | 'done';
  steps: Array<{ id: CfStep; state: CfStepState; at: number | null }>;
  problem: CfProblem | null;
  /** While phase is 'choose'. */
  accounts: Array<{ id: string; name: string }>;
  account: { id: string; name: string } | null;
  gatewayUrl: string | null;
  siteUrl: string | null;
  projectName: string | null;
  /** The TURN key made for calls (its token stays on the hub). */
  turnKeyId: string | null;
  /** The token is saved on the hub for updates ("Keep for updates"); it is never sent back. */
  tokenKept: boolean;
  /** The hub still holds this run's token in memory, so Retry needs no paste. */
  tokenHeld: boolean;
  /** This hub carries the Cloudflare parts (dist/cloud-bundle.json). */
  bundled: boolean;
  /** This hub version carries a newer gateway or site than the one deployed: offer "Update the gateway". */
  updateAvailable: boolean;
  deployedAt: number | null;
  startedAt: number | null;
}

declare module './protocol.ts' {
  interface Ops {
    'admin.cloudflare.get': { req: void; res: CfSetupView };
    /** Start (or run again): the token is used for this run, kept only with `keep`. */
    'admin.cloudflare.start': { req: { token: string; keep?: boolean; accountId?: string }; res: CfSetupView };
    /** Several accounts: carry on with this one. */
    'admin.cloudflare.choose': { req: { accountId: string }; res: CfSetupView };
    /** Continue from the step that failed (a token only if the hub no longer holds one). */
    'admin.cloudflare.retry': { req: { token?: string; keep?: boolean }; res: CfSetupView };
    /** Deploy this hub version's gateway and site in place ("Update the gateway"). */
    'admin.cloudflare.update': { req: { token?: string; keep?: boolean }; res: CfSetupView };
    /** Forget a kept token (and any held in memory). */
    'admin.cloudflare.forget': { req: void; res: CfSetupView };
  }
  interface Events {
    'admin.cloudflare': CfSetupView;
  }
}
