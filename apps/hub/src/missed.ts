// Notifications a phone missed. Android may stop the app's background connection (some makers
// do so aggressively), and there is no Google push on the office network. So a phone asks, each
// time it reconnects, for what arrived since the last message it heard about, and shows it.
//
// A phone's background service can also wait for new messages on its own, without the app's
// WebView, through GET /notify/wait with a per-device token: a long poll that answers as soon as
// something arrives, or after 50 seconds with nothing. That keeps notifications coming after a
// reboot or when Android restarts the service without the app.
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { ulid } from '@dex/core';
import { isSealed } from '@dex/core/e2e';
import type { MissedNotice, PublicUser } from '@dex/core';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notify_tokens (
  device_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
`;

/** How far back a reconnecting phone is told about (older unread messages are in the app). */
const LOOKBACK_MS = 3 * 86400_000;
const MAX_ITEMS = 50;
const WAIT_MS = 50_000;

interface Row { id: string; conv_id: string; author_id: string; body: string; parent_id: string | null; created_at: number; kind: 'direct' | 'space'; name: string | null; muted: number; members: number }

const hash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

export class MissedNotices {
  private readonly db: DatabaseSync;
  private readonly users: () => PublicUser[];
  private readonly fileNames: (messageId: string) => string[];
  /** Long polls waiting for a person's next message. */
  private readonly waiting = new Map<string, Set<() => void>>();

  constructor(db: DatabaseSync, users: () => PublicUser[], fileNames: (messageId: string) => string[]) {
    this.db = db;
    this.users = users;
    this.fileNames = fileNames;
    db.exec(SCHEMA);
  }

  /** The newest message this person can see: where a phone starts counting from. */
  private latest(userId: string): string {
    const r = this.db.prepare(`SELECT MAX(m.id) AS id FROM messages m JOIN conv_members cm ON cm.conv_id = m.conv_id AND cm.user_id = ?`).get(userId) as { id: string | null };
    // nothing yet: "now" (message ids sort by time)
    return r.id ?? ulid();
  }

  /**
   * Messages from others since `after` (a message id) that would have notified: not your own,
   * not notices, not read yet, not older than three days. With no `after`, nothing, and the
   * cursor to start from.
   */
  list(userId: string, after: unknown, limit = MAX_ITEMS): { items: MissedNotice[]; cursor: string | null; more?: boolean } {
    const since = typeof after === 'string' && /^[0-9A-Z]{26}$/.test(after) ? after : null;
    if (!since) return { items: [], cursor: this.latest(userId) };
    const n = Math.max(1, Math.min(MAX_ITEMS, Math.floor(limit)));
    const rows = this.db.prepare(`SELECT m.id, m.conv_id, m.author_id, m.body, m.parent_id, m.created_at, c.kind, c.name, cm.muted,
        (SELECT COUNT(*) FROM conv_members x WHERE x.conv_id = m.conv_id) AS members
      FROM messages m JOIN conv_members cm ON cm.conv_id = m.conv_id AND cm.user_id = ? JOIN conversations c ON c.id = m.conv_id
      WHERE m.id > ? AND m.author_id != ? AND m.deleted = 0 AND m.system IS NULL AND m.created_at > ?
        AND (m.parent_id IS NOT NULL OR cm.last_read_id IS NULL OR m.id > cm.last_read_id)
      ORDER BY m.id LIMIT ?`).all(userId, since, userId, Date.now() - LOOKBACK_MS, n + 1) as unknown as Row[];
    const more = rows.length > n;
    const page = rows.slice(0, n);
    const names = new Map(this.users().map((u) => [u.id, u.displayName]));
    const mentionOf = this.db.prepare('SELECT 1 FROM mentions WHERE message_id = ? AND user_id = ?');
    const mineParent = this.db.prepare('SELECT 1 FROM messages WHERE id = ? AND author_id = ?');
    const items = page.map((r): MissedNotice => {
      const sealed = isSealed(r.body);
      const mentioned = !sealed && (r.body.includes('<@all>') || !!mentionOf.get(r.id, userId));
      const reply = !!r.parent_id && !!mineParent.get(r.parent_id, userId);
      const who = names.get(r.author_id) ?? 'Someone';
      const where = r.kind === 'space' ? r.name ?? 'a Space' : r.members > 2 ? 'a group' : '';
      const title = mentioned ? `@ you${where ? ` in ${where}` : ''} · ${who}` : r.parent_id ? `Side-track${where ? ` in ${where}` : ''} · ${who}` : where ? `${where} · ${who}` : who;
      let text = sealed ? '' : r.body.replace(/<@([0-9A-Z]{26}|all)>/g, (_m, id: string) => `@${id === 'all' ? 'all' : names.get(id) ?? 'someone'}`).slice(0, 200);
      if (!sealed && !text) { const f = this.fileNames(r.id); text = f.length ? `📎 ${f.length === 1 ? f[0] : `${f.length} files`}` : ''; }
      return {
        id: r.id, convId: r.conv_id, authorId: r.author_id, kind: r.kind, title, text, body: r.body, sealed,
        personal: mentioned || r.kind === 'direct' || reply, mentioned, muted: !!r.muted, parentId: r.parent_id, at: r.created_at,
        link: `dexconnect://conversation/${r.conv_id}`,
      };
    });
    return { items, cursor: page.length ? page[page.length - 1].id : since, ...(more ? { more: true } : {}) };
  }

  /** A new token for this device's background service (the previous one stops working). */
  token(deviceId: string, userId: string): string {
    const t = crypto.randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO notify_tokens (device_id, user_id, token_hash, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET user_id = excluded.user_id, token_hash = excluded.token_hash, created_at = excluded.created_at')
      .run(deviceId, userId, hash(t), Date.now());
    return t;
  }

  /** Forget a removed device's token. */
  revoke(deviceId: string): void {
    this.db.prepare('DELETE FROM notify_tokens WHERE device_id = ?').run(deviceId);
  }

  /** The person a token belongs to, while their device is still approved. */
  private userOf(token: string): string | null {
    const r = this.db.prepare(`SELECT t.user_id FROM notify_tokens t JOIN devices d ON d.id = t.device_id
      WHERE t.token_hash = ? AND d.status = 'approved' AND d.user_id = t.user_id`).get(hash(token)) as { user_id: string } | undefined;
    return r?.user_id ?? null;
  }

  /** Something new for these people: answer their waiting long polls. */
  wake(userIds: Iterable<string>): void {
    for (const u of userIds) {
      const set = this.waiting.get(u);
      if (!set) continue;
      this.waiting.delete(u);
      for (const fn of set) fn();
    }
  }

  /** Answer every waiting poll now (the hub is stopping). */
  close(): void {
    for (const set of this.waiting.values()) for (const fn of set) fn();
    this.waiting.clear();
  }

  /** GET /notify/wait?after=<message id>, authorised by the device's notification token. */
  route(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'https://hub');
    const send = (code: number, body: unknown) => {
      if (res.headersSent || res.destroyed) return;
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET' || url.pathname !== '/notify/wait') { send(404, { error: 'not found' }); return; }
    const auth = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
    const userId = auth ? this.userOf(auth) : null;
    if (!userId) { send(401, { error: 'Open Dexterity Connect to sign in again.' }); return; }
    const after = url.searchParams.get('after');
    const now = this.list(userId, after);
    if (now.items.length || !after) { send(200, now); return; }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.waiting.get(userId)?.delete(answer);
      send(200, this.list(userId, after));
    };
    const answer = () => finish();
    const timer = setTimeout(finish, WAIT_MS);
    timer.unref?.();
    let set = this.waiting.get(userId);
    if (!set) { set = new Set(); this.waiting.set(userId, set); }
    set.add(answer);
    // the phone went away (its service stopped, or the network dropped)
    res.on('close', () => { done = true; clearTimeout(timer); this.waiting.get(userId)?.delete(answer); });
  }
}
