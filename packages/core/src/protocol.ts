// Wire protocol shared by the hub, the desktop app and (later) the phone web app.
// Every frame is one JSON object with a `t` discriminator.

export const PROTOCOL_VERSION = 1;
export const APP_ID = 'dexconnect';
export const DEFAULT_HUB_PORT = 47900;
export const DISCOVERY_PORT = 47901;

export type Role = 'owner' | 'admin' | 'member' | 'guest';
export type DeviceStatus = 'pending' | 'approved' | 'rejected' | 'revoked';

export interface WindowsAccount {
  /** Windows sign-in name, e.g. "priya.raman" */
  username: string;
  /** Domain, or the PC name on a workgroup machine */
  domain: string;
  /** Friendly name shown to colleagues */
  displayName: string;
  /** PC name */
  hostname: string;
}

export interface HubInfo {
  id: string;
  name: string;
  version: string;
  protocol: number;
}

export interface PublicUser {
  id: string;
  account: string;
  displayName: string;
  role: Role;
  title: string | null;
  statusText: string | null;
  createdAt: number;
}

export interface DeviceRecord {
  id: string;
  userId: string;
  hostname: string;
  status: DeviceStatus;
  createdAt: number;
  lastSeen: number | null;
  account: string;
  displayName: string;
}

export interface AuditEntry {
  id: string;
  at: number;
  actor: string | null;
  action: string;
  target: string | null;
  detail: unknown;
}

export interface Session {
  hub: HubInfo;
  me: PublicUser;
  deviceId: string;
  users: PublicUser[];
  online: string[];
}

// ---- hub -> client
export type ServerFrame =
  | { t: 'hello'; hub: HubInfo; nonce: string }
  | { t: 'unknown' }
  | { t: 'pending'; position: number }
  | { t: 'rejected'; reason: string }
  | { t: 'ready'; session: Session }
  | { t: 'res'; id: string; ok: true; data: unknown }
  | { t: 'res'; id: string; ok: false; error: string }
  | { t: 'evt'; name: string; data: unknown }
  | { t: 'error'; error: string };

// ---- client -> hub
export type ClientFrame =
  | { t: 'auth'; deviceId: string; sig: string }
  | { t: 'register'; deviceId: string; publicKey: string; account: WindowsAccount; sig: string }
  | { t: 'req'; id: string; op: string; data?: unknown };

/**
 * What a device signs to prove possession of its key. Binding the hub's TLS certificate
 * fingerprint means a relay with a different certificate cannot reuse the signature.
 */
export function authPayload(nonce: string, hubFingerprint: string, deviceId: string): Buffer {
  return Buffer.from(`${APP_ID}-auth-v${PROTOCOL_VERSION}|${nonce}|${hubFingerprint}|${deviceId}`, 'utf8');
}

export function accountKey(account: Pick<WindowsAccount, 'domain' | 'username'>): string {
  return `${account.domain}\\${account.username}`.toLowerCase();
}

// Request/response operations available in a session.
export interface Ops {
  'directory.list': { req: void; res: { users: PublicUser[]; online: string[] } };
  'me.update': { req: { displayName?: string; title?: string | null; statusText?: string | null }; res: PublicUser };
  'admin.devices': { req: void; res: DeviceRecord[] };
  'admin.decide': { req: { deviceId: string; approve: boolean }; res: DeviceRecord };
  'admin.setRole': { req: { userId: string; role: Exclude<Role, 'owner'> }; res: PublicUser };
  'admin.revoke': { req: { deviceId: string }; res: DeviceRecord };
  'admin.audit': { req: { limit?: number } | void; res: AuditEntry[] };
  'ping': { req: void; res: { at: number } };
}
export type OpName = keyof Ops;

// Server-pushed events.
export interface Events {
  'presence': { userId: string; online: boolean };
  'user.updated': PublicUser;
  'user.added': PublicUser;
  'admin.pending': DeviceRecord;
  'device.updated': DeviceRecord;
}
export type EventName = keyof Events;
