// Hub persistence: SQLite (WAL) via Node's built-in driver, so the hub has no native modules.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ulid } from '@dex/core';
import type { DeviceRecord, DeviceStatus, PublicUser, Role } from '@dex/core';

interface UserRow {
  id: string; account: string; display_name: string; role: Role; title: string | null;
  status_text: string | null; created_at: number;
}
interface DeviceRow {
  id: string; user_id: string; public_key: string; hostname: string; status: DeviceStatus;
  created_at: number; last_seen: number | null; account: string; display_name: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  title TEXT,
  status_text TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  public_key TEXT NOT NULL,
  hostname TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER,
  decided_by TEXT,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status, created_at);
CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  actor TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at);
`;

export const toPublicUser = (r: UserRow): PublicUser => ({
  id: r.id, account: r.account, displayName: r.display_name, role: r.role,
  title: r.title, statusText: r.status_text, createdAt: r.created_at,
});

const toDevice = (r: DeviceRow): DeviceRecord => ({
  id: r.id, userId: r.user_id, hostname: r.hostname, status: r.status, createdAt: r.created_at,
  lastSeen: r.last_seen, account: r.account, displayName: r.display_name,
});

const DEVICE_SELECT = `SELECT d.*, u.account, u.display_name FROM devices d JOIN users u ON u.id = d.user_id`;

export class Store {
  readonly db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'hub.db'));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
    this.db.exec(SCHEMA);
  }

  close(): void { this.db.close(); }

  meta(key: string, init: () => string): string {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    if (row) return row.value;
    const value = init();
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(key, value);
    return value;
  }

  // ------------------------------------------------------------- users
  userCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  userById(id: string): PublicUser | null {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return r ? toPublicUser(r) : null;
  }

  userByAccount(account: string): PublicUser | null {
    const r = this.db.prepare('SELECT * FROM users WHERE account = ?').get(account) as UserRow | undefined;
    return r ? toPublicUser(r) : null;
  }

  /** Users with at least one approved device: the people colleagues can see. */
  activeUsers(): PublicUser[] {
    const rows = this.db.prepare(`SELECT * FROM users u WHERE EXISTS
      (SELECT 1 FROM devices d WHERE d.user_id = u.id AND d.status = 'approved') ORDER BY display_name COLLATE NOCASE`).all() as unknown as UserRow[];
    return rows.map(toPublicUser);
  }

  createUser(account: string, displayName: string, role: Role): PublicUser {
    const id = ulid();
    this.db.prepare('INSERT INTO users (id, account, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, account, displayName, role, Date.now());
    return this.userById(id)!;
  }

  updateUser(id: string, patch: { displayName?: string; title?: string | null; statusText?: string | null; role?: Role }): PublicUser {
    const cur = this.userById(id);
    if (!cur) throw new Error('user not found');
    this.db.prepare('UPDATE users SET display_name = ?, title = ?, status_text = ?, role = ? WHERE id = ?').run(
      patch.displayName ?? cur.displayName,
      patch.title === undefined ? cur.title : patch.title,
      patch.statusText === undefined ? cur.statusText : patch.statusText,
      patch.role ?? cur.role,
      id,
    );
    return this.userById(id)!;
  }

  // ----------------------------------------------------------- devices
  device(id: string): (DeviceRecord & { publicKey: string }) | null {
    const r = this.db.prepare(`${DEVICE_SELECT} WHERE d.id = ?`).get(id) as DeviceRow | undefined;
    return r ? { ...toDevice(r), publicKey: r.public_key } : null;
  }

  devices(): DeviceRecord[] {
    const rows = this.db.prepare(`${DEVICE_SELECT} ORDER BY CASE d.status WHEN 'pending' THEN 0 ELSE 1 END, d.created_at DESC`).all() as unknown as DeviceRow[];
    return rows.map(toDevice);
  }

  pendingPosition(deviceId: string): number {
    const d = this.device(deviceId);
    if (!d) return 0;
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM devices WHERE status = 'pending' AND created_at <= ?`).get(d.createdAt) as { n: number };
    return r.n;
  }

  pendingCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM devices WHERE status = 'pending'`).get() as { n: number }).n;
  }

  createDevice(id: string, userId: string, publicKey: string, hostname: string, status: DeviceStatus): DeviceRecord {
    this.db.prepare('INSERT INTO devices (id, user_id, public_key, hostname, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, userId, publicKey, hostname, status, Date.now());
    return this.device(id)!;
  }

  setDeviceStatus(id: string, status: DeviceStatus, actor: string | null): DeviceRecord {
    this.db.prepare('UPDATE devices SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?').run(status, actor, Date.now(), id);
    return this.device(id)!;
  }

  touchDevice(id: string): void {
    this.db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(Date.now(), id);
  }

  // ------------------------------------------------------------- audit
  audit(actor: string | null, action: string, target: string | null, detail?: unknown): void {
    this.db.prepare('INSERT INTO audit (id, at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ulid(), Date.now(), actor, action, target, detail === undefined ? null : JSON.stringify(detail));
  }

  auditTrail(limit = 200): Array<{ id: string; at: number; actor: string | null; action: string; target: string | null; detail: unknown }> {
    const rows = this.db.prepare('SELECT * FROM audit ORDER BY at DESC, id DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string, at: r.at as number, actor: r.actor as string | null, action: r.action as string,
      target: r.target as string | null, detail: r.detail ? JSON.parse(r.detail as string) : null,
    }));
  }
}
