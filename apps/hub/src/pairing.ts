// Pairing codes: a person adds their own phone or laptop from a device that is already approved.
// The code carries a one-time token (stored only as a SHA-256 hash) that is valid for 24 hours;
// the new device joins already approved, as that person, and their other devices are told.
import crypto from 'node:crypto';
import os from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import type { Store } from './store.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pair_tokens (
  hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  device_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_pair_user ON pair_tokens(user_id, created_at);
CREATE TABLE IF NOT EXISTS paired_devices (device_id TEXT PRIMARY KEY, kind TEXT NOT NULL, at INTEGER NOT NULL);
`;

export const PAIR_TTL_MS = 24 * 3600_000;
const sha = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

export class Pairing {
  private readonly db: DatabaseSync;

  constructor(store: Store) {
    this.db = store.db;
    this.db.exec(SCHEMA);
  }

  /** A fresh token for this person. At most 5 unused ones are kept; older ones stop working. */
  create(userId: string, kind: 'phone' | 'laptop', now = Date.now()): { token: string; expiresAt: number } {
    this.db.prepare('DELETE FROM pair_tokens WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)').run(now, now - 30 * 86400_000);
    const unused = this.db.prepare('SELECT hash FROM pair_tokens WHERE user_id = ? AND used_at IS NULL ORDER BY created_at DESC').all(userId) as Array<{ hash: string }>;
    for (const r of unused.slice(4)) this.db.prepare('DELETE FROM pair_tokens WHERE hash = ?').run(r.hash);
    const token = crypto.randomBytes(18).toString('base64url');
    const expiresAt = now + PAIR_TTL_MS;
    this.db.prepare('INSERT INTO pair_tokens (hash, user_id, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(sha(token), userId, kind, now, expiresAt);
    return { token, expiresAt };
  }

  /** Use a token once. Returns who it belongs to, or why it can't be used. */
  consume(token: string, deviceId: string, now = Date.now()): { userId: string; kind: string } | { error: string } {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) return { error: 'That pairing code is not complete. Copy all of it, starting with DXP1-.' };
    const row = this.db.prepare('SELECT user_id, kind, expires_at, used_at FROM pair_tokens WHERE hash = ?').get(sha(token)) as { user_id: string; kind: string; expires_at: number; used_at: number | null } | undefined;
    if (!row) return { error: 'That pairing code is not valid any more. Make a new one on your PC: Preferences → Your devices.' };
    if (row.used_at) return { error: 'That pairing code was already used. Make a new one on your PC: Preferences → Your devices.' };
    if (row.expires_at < now) return { error: 'That pairing code has expired (codes last 24 hours). Make a new one on your PC: Preferences → Your devices.' };
    this.db.prepare('UPDATE pair_tokens SET used_at = ?, device_id = ? WHERE hash = ?').run(now, deviceId, sha(token));
    this.db.prepare('INSERT OR REPLACE INTO paired_devices (device_id, kind, at) VALUES (?, ?, ?)').run(deviceId, row.kind, now);
    return { userId: row.user_id, kind: row.kind };
  }

  isPaired(deviceId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM paired_devices WHERE device_id = ?').get(deviceId);
  }
}

/** This PC's addresses on the office network, for pairing codes ("host:port"). */
export function lanAddresses(port: number): string[] {
  const all: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      // link-local addresses are useless to a phone
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) all.push(a.address);
    }
  }
  const priv = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return [...all.filter(priv), ...all.filter((ip) => !priv(ip))].slice(0, 4).map((ip) => `${ip}:${port}`);
}
