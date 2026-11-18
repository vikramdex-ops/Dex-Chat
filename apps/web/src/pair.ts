// Joining from an iPhone, kept free of browser APIs so the rules can be tested in Node.
//
// A browser cannot reach the hub on the office network: it refuses the hub's own (self-issued)
// certificate, and it cannot look for the hub with UDP discovery. So the web app always goes
// through the office's internet gateway, inside the same end-to-end encrypted channel the Android
// app uses outside the office, pinned to the hub's certificate fingerprint from the code. A code
// from an office that has not set up access from outside cannot work here, and says so.
import { parsePairCode, parseSetupCode } from '@dex/core/remote';
import type { HubTarget } from '@dex/core/session';

export const NO_GATEWAY = 'Your office has not set up access from outside yet, and an iPhone can only join that way. Ask your administrator to turn it on (Control room ▸ Outside the office), then make a new code on your PC.';

/** The code a link carried in its #fragment (the get page sends people here with it), if any. */
export function codeFromHash(hash: string): string | null {
  let raw = hash.replace(/^#/, '');
  try { raw = decodeURIComponent(raw); } catch { /* keep it as it is */ }
  return raw.match(/DX[PC]1-[A-Za-z0-9_-]{20,3000}/)?.[0] ?? null;
}

/** A notification's conversation link carried in the #fragment (#open=dexconnect://…). */
export function openFromHash(hash: string): string | null {
  const m = hash.match(/^#open=(.+)$/);
  if (!m) return null;
  let link = m[1];
  try { link = decodeURIComponent(link); } catch { return null; }
  return /^dexconnect:\/\/[\w./?=&%-]+$/.test(link) ? link : null;
}

/**
 * What to connect to for a pairing ("DXP1-") or setup ("DXC1-") code: always the gateway, never
 * the office addresses in it. Throws a message for the person when the code cannot be used here.
 */
export function webTarget(code: string): { target: HubTarget; pairToken: string | null; kind: 'pair' | 'setup' } {
  const p = parsePairCode(code);
  if (p) {
    if (!p.url) throw new Error(NO_GATEWAY);
    return { target: { host: '', port: 0, hubId: p.hubId, name: p.name, fp: p.fp, remote: { url: p.url, hubId: p.hubId } }, pairToken: p.token, kind: 'pair' };
  }
  const s = parseSetupCode(code);
  if (s) return { target: { host: '', port: 0, hubId: s.hubId, name: s.name, fp: s.fp, remote: { url: s.url, hubId: s.hubId } }, pairToken: null, kind: 'setup' };
  if (/DXP1-/.test(code)) throw new Error('That pairing code is not complete. Copy all of it, starting with DXP1-.');
  throw new Error('That setup code is not complete. Copy all of it, starting with DXC1-.');
}

/** iPhone, iPad (which says it is a Mac, but has touch) or something else, from the browser's own description. */
export function deviceOf(ua: string, touchPoints = 0): 'iphone' | 'ipad' | 'other' {
  if (/iPhone|iPod/.test(ua)) return 'iphone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'ipad';
  return 'other';
}

/** The name colleagues and the Control room see for this device. */
export const deviceName = (d: 'iphone' | 'ipad' | 'other') => (d === 'iphone' ? 'iPhone (web app)' : d === 'ipad' ? 'iPad (web app)' : 'Browser (web app)');
