// Hub persistence: SQLite (WAL) via Node's built-in driver, so the hub has no native modules.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ulid } from '@dex/core';
import type { Availability, DeviceRecord, DeviceStatus, PublicUser, Role } from '@dex/core';

interface UserRow {
  id: string; account: string; display_name: string; role: Role; title: string | null;
  status_text: string | null; availability: Availability | null; created_at: number;
  availability_until?: number | null; ooo?: string | null;
  receipts?: number | null; status_emoji?: string | null; last_seen_at?: number | null;
  // from profiles (LEFT JOIN)
  department_id?: string | null; manager_id?: string | null; phone?: string | null; extension?: string | null; location?: string | null; seat_id?: string | null;
  email?: string | null; employee_id?: string | null; joined_on?: string | null; birthday?: string | null; fields?: string | null;
  left_at?: number | null;
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
CREATE TABLE IF NOT EXISTS profiles (
  account TEXT PRIMARY KEY,
  display_name TEXT,
  title TEXT,
  department_id TEXT,
  manager_account TEXT,
  phone TEXT,
  extension TEXT,
  location TEXT,
  email TEXT,
  employee_id TEXT,
  joined_on TEXT,
  birthday TEXT,
  fields TEXT
);
CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  parent_id TEXT,
  head_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_tokens (
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used INTEGER
);
CREATE TABLE IF NOT EXISTS departures (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  left_at INTEGER NOT NULL,
  by_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  meetings TEXT NOT NULL,
  note TEXT,
  summary TEXT NOT NULL,
  devices TEXT NOT NULL,
  returned_at INTEGER,
  returned_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_departures_user ON departures(user_id, returned_at);
CREATE TABLE IF NOT EXISTS hooks (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  bot_id TEXT NOT NULL,
  conv_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used INTEGER
);
`;

function parseFields(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string')) as Record<string, string> : {};
  } catch { return {}; }
}

function parseOoo(raw: string | null | undefined): PublicUser['ooo'] {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as NonNullable<PublicUser['ooo']>;
    return typeof v.until === 'number' ? { until: v.until, message: v.message ?? null, delegateId: v.delegateId ?? null } : null;
  } catch { return null; }
}

export const toPublicUser = (r: UserRow): PublicUser => ({
  id: r.id, account: r.account, displayName: r.display_name, role: r.role,
  title: r.title, statusText: r.status_text, availability: r.availability ?? 'available', createdAt: r.created_at,
  availabilityUntil: r.availability_until ?? null,
  ooo: parseOoo(r.ooo),
  lastSeen: r.availability === 'invisible' ? null : r.last_seen_at ?? null,
  statusEmoji: r.status_emoji ?? null,
  readReceipts: r.receipts !== 0,
  profile: {
    departmentId: r.department_id ?? null, managerId: r.manager_id ?? null, phone: r.phone ?? null, extension: r.extension ?? null,
    location: r.location ?? null, email: r.email ?? null, employeeId: r.employee_id ?? null, joinedOn: r.joined_on ?? null,
    birthday: r.birthday ?? null, fields: parseFields(r.fields),
    ...(r.seat_id ? { seatId: r.seat_id } : {}),
  },
  // offboarding (offboard.ts): only on people who have left
  ...(r.left_at ? { leftAt: r.left_at } : {}),
});

/** Users with their organisation profile (the manager is stored by account so imports work before people join). */
const USER_SELECT = `SELECT u.*, p.department_id, p.phone, p.extension, p.location, p.seat_id, p.email, p.employee_id, p.joined_on, p.birthday, p.fields,
  (SELECT m.id FROM users m WHERE m.account = p.manager_account) AS manager_id,
  (SELECT MAX(d.last_seen) FROM devices d WHERE d.user_id = u.id AND d.status = 'approved') AS last_seen_at,
  (SELECT MAX(dp.left_at) FROM departures dp WHERE dp.user_id = u.id AND dp.returned_at IS NULL) AS left_at
  FROM users u LEFT JOIN profiles p ON p.account = u.account`;

/**
 * Every part of the hub prepares its SQL where it runs it (`db.prepare(sql).get(...)`), and
 * compiling a statement costs several times more than running a simple one: a list of 60 messages
 * prepared about a thousand. The database keeps the compiled statements instead, the most recently
 * used few thousand, so the same text is compiled once. Statements finish before they return (no
 * iterators are kept), so sharing one between callers is safe.
 */
export function cacheStatements(db: DatabaseSync, max = 2000): void {
  const prepare = db.prepare.bind(db);
  const cache = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  db.prepare = (sql: string) => {
    let st = cache.get(sql);
    if (st) {
      // most recently used last, so the oldest is dropped first
      cache.delete(sql);
      cache.set(sql, st);
      return st;
    }
    st = prepare(sql);
    cache.set(sql, st);
    if (cache.size > max) cache.delete(cache.keys().next().value!);
    return st;
  };
}

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
    cacheStatements(this.db);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
    this.db.exec(SCHEMA);
    try { this.db.exec(`ALTER TABLE users ADD COLUMN availability TEXT NOT NULL DEFAULT 'available'`); } catch { /* already there */ }
    try { this.db.exec('ALTER TABLE profiles ADD COLUMN seat_id TEXT'); } catch { /* already there */ }
    for (const col of ['enc_key TEXT', 'enc_sig TEXT']) { try { this.db.exec(`ALTER TABLE devices ADD COLUMN ${col}`); } catch { /* already there */ } }
    for (const col of ['availability_until INTEGER', 'ooo TEXT', 'receipts INTEGER NOT NULL DEFAULT 1', 'status_emoji TEXT']) { try { this.db.exec(`ALTER TABLE users ADD COLUMN ${col}`); } catch { /* already there */ } }
    // a count of changes to people, their profiles and devices (whatever part of the hub makes
    // them), so the people list is read again only after one (see activeUsers)
    this.db.exec('CREATE TEMP TABLE IF NOT EXISTS people_rev (n INTEGER NOT NULL); INSERT INTO people_rev (n) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM people_rev);');
    for (const table of ['users', 'profiles', 'devices']) {
      for (const ev of ['INSERT', 'UPDATE', 'DELETE']) this.db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS people_rev_${table}_${ev.toLowerCase()} AFTER ${ev} ON main.${table} BEGIN UPDATE people_rev SET n = n + 1; END`);
    }
  }

  /** The people list as last read, and the change count it was read at. */
  private people: { rev: number; list: PublicUser[] } | null = null;

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
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role != 'bot'").get() as { n: number }).n;
  }

  userById(id: string): PublicUser | null {
    const r = this.db.prepare(`${USER_SELECT} WHERE u.id = ?`).get(id) as UserRow | undefined;
    return r ? toPublicUser(r) : null;
  }

  userByAccount(account: string): PublicUser | null {
    const r = this.db.prepare(`${USER_SELECT} WHERE u.account = ?`).get(account) as UserRow | undefined;
    return r ? toPublicUser(r) : null;
  }

  /** People with at least one approved device, plus integrations (bots): who colleagues can see. */
  activeUsers(): PublicUser[] {
    // asked for many times per message sent (mentions, search text, out of office): read once per change
    const rev = (this.db.prepare('SELECT n FROM temp.people_rev').get() as { n: number }).n;
    if (this.people?.rev === rev) return this.people.list.slice();
    const rows = this.db.prepare(`${USER_SELECT} WHERE u.role = 'bot' OR EXISTS
      (SELECT 1 FROM devices d WHERE d.user_id = u.id AND d.status = 'approved') ORDER BY u.display_name COLLATE NOCASE`).all() as unknown as UserRow[];
    const list = rows.map(toPublicUser);
    this.people = { rev, list };
    return list.slice();
  }

  createUser(account: string, displayName: string, role: Role): PublicUser {
    const id = ulid();
    // an administrator may have imported this person's details before they joined
    const pre = this.db.prepare('SELECT display_name, title FROM profiles WHERE account = ?').get(account) as { display_name: string | null; title: string | null } | undefined;
    this.db.prepare('INSERT INTO users (id, account, display_name, role, title, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, account, pre?.display_name || displayName, role, pre?.title ?? null, Date.now());
    return this.userById(id)!;
  }

  /** Timed availability and out of office (kept apart from updateUser's simple fields). */
  setPrefs(id: string, patch: { receipts?: boolean; statusEmoji?: string | null }): void {
    if (patch.receipts !== undefined) this.db.prepare('UPDATE users SET receipts = ? WHERE id = ?').run(patch.receipts ? 1 : 0, id);
    if (patch.statusEmoji !== undefined) this.db.prepare('UPDATE users SET status_emoji = ? WHERE id = ?').run(patch.statusEmoji, id);
  }

  setPresenceExtras(id: string, patch: { availabilityUntil?: number | null; ooo?: PublicUser['ooo'] }): void {
    if (patch.availabilityUntil !== undefined) this.db.prepare('UPDATE users SET availability_until = ? WHERE id = ?').run(patch.availabilityUntil, id);
    if (patch.ooo !== undefined) this.db.prepare('UPDATE users SET ooo = ? WHERE id = ?').run(patch.ooo ? JSON.stringify(patch.ooo) : null, id);
  }

  updateUser(id: string, patch: { displayName?: string; title?: string | null; statusText?: string | null; role?: Role; availability?: Availability }): PublicUser {
    const cur = this.userById(id);
    if (!cur) throw new Error('user not found');
    this.db.prepare('UPDATE users SET display_name = ?, title = ?, status_text = ?, role = ?, availability = ? WHERE id = ?').run(
      patch.displayName ?? cur.displayName,
      patch.title === undefined ? cur.title : patch.title,
      patch.statusText === undefined ? cur.statusText : patch.statusText,
      patch.role ?? cur.role,
      patch.availability ?? cur.availability,
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

  // ------------------------------------------------------------- bots
  createBotToken(userId: string, tokenHash: string, by: string): void {
    this.db.prepare('INSERT INTO bot_tokens (user_id, token_hash, created_by, created_at) VALUES (?, ?, ?, ?)').run(userId, tokenHash, by, Date.now());
  }

  botByTokenHash(tokenHash: string): PublicUser | null {
    const r = this.db.prepare('SELECT user_id FROM bot_tokens WHERE token_hash = ?').get(tokenHash) as { user_id: string } | undefined;
    if (!r) return null;
    this.db.prepare('UPDATE bot_tokens SET last_used = ? WHERE token_hash = ?').run(Date.now(), tokenHash);
    return this.userById(r.user_id);
  }

  bots(): Array<{ bot: PublicUser; createdAt: number; lastUsed: number | null; active: boolean }> {
    const rows = this.db.prepare(`SELECT u.*, MIN(t.created_at) AS t_created, MAX(t.last_used) AS t_used, COUNT(t.token_hash) AS n
      FROM users u LEFT JOIN bot_tokens t ON t.user_id = u.id WHERE u.role = 'bot' AND u.account != 'system\\dexterity-connect' AND u.account NOT LIKE 'botmaker%' GROUP BY u.id ORDER BY u.display_name`).all() as unknown as Array<UserRow & { t_created: number | null; t_used: number | null; n: number }>;
    return rows.map((r) => ({ bot: toPublicUser(r), createdAt: r.t_created ?? r.created_at, lastUsed: r.t_used, active: r.n > 0 }));
  }

  /** An integration is active while it has a token (revoking stops its webhooks too). */
  botActive(userId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM bot_tokens WHERE user_id = ? LIMIT 1').get(userId);
  }

  revokeBotTokens(userId: string): void {
    this.db.prepare('DELETE FROM bot_tokens WHERE user_id = ?').run(userId);
  }

  /** Resolve "DOMAIN\\user" or a bare "user" to one person (bare names must be unambiguous). */
  userForAccount(input: string): PublicUser | null {
    const v = input.trim().toLowerCase();
    if (!v) return null;
    if (v.includes('\\')) return this.userByAccount(v);
    const rows = this.db.prepare(`${USER_SELECT} WHERE u.role != 'bot' AND (u.account LIKE ? ESCAPE '!')`).all(`%!\\${v.replace(/[!%_]/g, (c) => `!${c}`)}`) as unknown as UserRow[];
    return rows.length === 1 ? toPublicUser(rows[0]) : null;
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
