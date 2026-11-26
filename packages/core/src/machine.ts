// Elevated remote support (docs/HELP-DESK.md, "Elevated control"): the Dexterity Connect IT Support
// service runs as SYSTEM on an office PC and connects to the hub on its own, as a machine device
// (no person signs in on it). Through it IT sees and uses the PC's console, whatever is on it: the
// person's desktop, administrator windows, UAC prompts, the lock and sign-in screens. The service
// speaks a few JSON frames over the hub's websocket; these are their shapes and the checks both
// sides share. The service cannot do Ed25519 (.NET Framework), so machines prove their key with
// ECDSA P-256 over the same authentication payload as people's devices.
import crypto from 'node:crypto';
import { KEYS } from './assist.ts';
import type { InputEvent } from './assist.ts';

/** What the hub knows of a machine (Control room ▸ Policies ▸ Remote support, the Help desk's list of PCs). */
export interface MachineInfo {
  id: string;
  hostname: string;
  online: boolean;
  /** Who is signed in to the console (DOMAIN\user), or null at the sign-in screen. */
  consoleUser: string | null;
  /** The console is locked, or nobody is signed in. */
  locked: boolean;
  /** The service's version. */
  version: string;
  firstSeen: number;
  lastSeen: number;
  /** The elevated session running on it now, if any. */
  session: ElevatedSession | null;
}

export interface ElevatedSession {
  id: string;
  machineId: string;
  hostname: string;
  techId: string;
  ticketId: string;
  startedAt: number;
  endedAt: number | null;
  /** The PC restarted or dropped off and the session waits for it (policy assistReconnect). */
  pausedAt: number | null;
  /** Why it ended (the person at the PC stopped it, the PC went away…). */
  why: string | null;
}

/** A picture of the PC's screen, relayed to the technician. */
export interface MachineFrame { s: string; w: number; h: number; d: string; seq: number }

/** The service's hello. `sig` is ECDSA P-256 / SHA-256 as r||s (IEEE P1363, what .NET's ECDsaCng makes) over authPayload(nonce, hub fingerprint, id). */
export interface MachineHello {
  t: 'machine';
  id: string;
  /** SPKI DER, base64. */
  publicKey: string;
  hostname: string;
  version: string;
  sig: string;
  consoleUser?: string | null;
  locked?: boolean;
}

/** A machine's id: the first 32 hex characters of the SHA-256 of its public key, after "m". */
export function machineIdFor(publicKeyB64: string): string {
  return `m${crypto.createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest('hex').slice(0, 31)}`;
}

/** Check a machine's signature: its key must be P-256. */
export function verifyMachineSignature(publicKeyB64: string, payload: Uint8Array, sigB64: string): boolean {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return false;
    return crypto.verify('sha256', payload, { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
}

/** Largest picture the hub relays (base64 characters); the websocket takes 1 MB a frame. */
export const FRAME_MAX = 900_000;

/** A frame from the service, or null when it is not one. */
export function decodeFrame(raw: unknown): MachineFrame | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  const int = (n: unknown, max: number) => (typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= max ? n : null);
  const w = int(v.w, 16384); const h = int(v.h, 16384); const seq = int(v.seq, Number.MAX_SAFE_INTEGER);
  if (typeof v.s !== 'string' || !w || !h || !seq || typeof v.d !== 'string' || !v.d.length || v.d.length > FRAME_MAX || !/^[A-Za-z0-9+/=]+$/.test(v.d.slice(0, 64))) return null;
  return { s: v.s, w, h, d: v.d, seq };
}

/** One input command for the service: pointer positions 0..1 on its screen picture, keys as virtual-key codes. */
export type MachineInput =
  | { t: 'move'; x: number; y: number }
  | { t: 'button'; b: 'left' | 'right' | 'middle'; down: boolean; x: number; y: number }
  | { t: 'wheel'; dx: number; dy: number; x: number; y: number }
  | { t: 'key'; vk: number; ext: boolean; down: boolean };

/** Input events (already through the gate) as the service's commands. */
export function machineInputs(events: InputEvent[]): MachineInput[] {
  const out: MachineInput[] = [];
  for (const ev of events) {
    if (ev.t !== 'key') { out.push(ev); continue; }
    const k = KEYS[ev.code];
    if (k) out.push({ t: 'key', vk: k.vk, ext: !!k.ext, down: ev.down });
  }
  return out;
}
