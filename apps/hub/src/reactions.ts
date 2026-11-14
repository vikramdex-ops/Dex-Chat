// Reaction insights: a history of reactions (added and removed, with times) and a descriptive
// summary of one message's reactions for members of its conversation: the spread per emoji, how
// many members reacted against those who read it without reacting (by read receipts, as each
// person shares them), a timeline, departments, and for announcements the office's usual rate.
// Reactions are not approvals: the summary says so.
import type { DatabaseSync } from 'node:sqlite';
import type { PublicUser, ReactionInsights as Insights } from '@dex/core';
import type { Messaging } from './messaging.ts';
import type { Store } from './store.ts';

export class InsightError extends Error {}

const BUCKETS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 3600_000, 3 * 3600_000, 6 * 3600_000, 12 * 3600_000, 86400_000, 7 * 86400_000, 30 * 86400_000];
const MAX_BUCKETS = 24;
const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 1000) / 10 : 0);

export class ReactionInsights {
  private readonly db: DatabaseSync;
  private readonly store: Store;
  private readonly messaging: Messaging;

  constructor(store: Store, messaging: Messaging) {
    this.store = store;
    this.db = store.db;
    this.messaging = messaging;
    const existed = !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reaction_events'").get();
    this.db.exec(`CREATE TABLE IF NOT EXISTS reaction_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, conv_id TEXT NOT NULL, user_id TEXT NOT NULL,
        emoji TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('add', 'remove')), at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_reaction_events_msg ON reaction_events(message_id, at);`);
    // reactions from before the history existed count as added when they were made
    if (!existed) {
      this.db.exec(`INSERT INTO reaction_events (message_id, conv_id, user_id, emoji, action, at)
        SELECT r.message_id, m.conv_id, r.user_id, r.emoji, 'add', r.created_at FROM reactions r JOIN messages m ON m.id = r.message_id ORDER BY r.created_at`);
    }
  }

  /** The hook in msg.react: record a change of state (a repeated add or a remove of nothing is not one). */
  record(messageId: string, convId: string, userId: string, emoji: string, on: boolean, at = Date.now()): void {
    const last = this.db.prepare('SELECT action FROM reaction_events WHERE message_id = ? AND user_id = ? AND emoji = ? ORDER BY id DESC LIMIT 1').get(messageId, userId, emoji) as { action: string } | undefined;
    const now = !!this.db.prepare('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').get(messageId, userId, emoji);
    if (on && (!now || last?.action === 'add')) return;
    if (!on && (now || !last || last.action === 'remove')) return;
    this.db.prepare('INSERT INTO reaction_events (message_id, conv_id, user_id, emoji, action, at) VALUES (?, ?, ?, ?, ?, ?)').run(messageId, convId, userId, emoji, on ? 'add' : 'remove', at);
  }

  handle(op: string, me: PublicUser, d: Record<string, unknown>): unknown {
    if (op !== 'reactions.insights') return undefined;
    return this.insights(me, typeof d.messageId === 'string' ? d.messageId : '');
  }

  insights(me: PublicUser, messageId: string): Insights {
    // members of the conversation only
    const msg = messageId ? this.messaging.messageFor(messageId, me.id) : null;
    if (!msg || msg.deleted || msg.system) throw new InsightError('Message not found.');
    const conv = this.db.prepare('SELECT kind, everyone, post_policy FROM conversations WHERE id = ?').get(msg.convId) as { kind: string; everyone: number; post_policy: string | null } | undefined;
    const poll = this.db.prepare('SELECT anonymous FROM polls WHERE message_id = ?').get(msg.id) as { anonymous: number } | undefined;
    const anonymous = !!poll?.anonymous;

    const bots = new Set((this.db.prepare("SELECT id FROM users WHERE role = 'bot'").all() as Array<{ id: string }>).map((r) => r.id));
    const audience = this.messaging.members(msg.convId).filter((u) => u !== msg.authorId && !bots.has(u));
    const inAudience = new Set(audience);

    // the spread
    const reactors = new Set<string>();
    let total = 0;
    const distribution = Object.entries(msg.reactions).map(([emoji, users]) => {
      for (const u of users) reactors.add(u);
      total += users.length;
      return { emoji, count: users.length, percent: 0 };
    }).sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));
    for (const x of distribution) x.percent = pct(x.count, total);
    const reacted = audience.filter((u) => reactors.has(u));

    // reacted against read-but-not-reacted, by read receipts as each person shares them
    const viewerShares = (this.db.prepare('SELECT COALESCE(receipts, 1) AS r FROM users WHERE id = ?').get(me.id) as { r: number } | undefined)?.r !== 0;
    const receiptsApply = viewerShares && !msg.parentId && !anonymous;
    let seenNoReaction = 0;
    let notSeen = 0;
    let unknown = 0;
    if (receiptsApply) {
      const rows = this.db.prepare(`SELECT cm.user_id, cm.last_read_id, COALESCE(u.receipts, 1) AS receipts FROM conv_members cm
        LEFT JOIN users u ON u.id = cm.user_id WHERE cm.conv_id = ?`).all(msg.convId) as Array<{ user_id: string; last_read_id: string | null; receipts: number }>;
      for (const r of rows) {
        if (!inAudience.has(r.user_id) || reactors.has(r.user_id)) continue;
        if (r.receipts === 0) unknown++;
        else if (r.last_read_id && r.last_read_id >= msg.id) seenNoReaction++;
        else notSeen++;
      }
    } else unknown = audience.length - reacted.length;

    // the timeline: net reactions over time, cumulative
    const events = this.db.prepare('SELECT action, at FROM reaction_events WHERE message_id = ? ORDER BY at, id').all(msg.id) as Array<{ action: string; at: number }>;
    const adds = events.filter((e) => e.action === 'add');
    const firstAt = adds.length ? adds[0].at : null;
    const lastAt = adds.length ? adds[adds.length - 1].at : null;
    const start = Math.min(msg.createdAt, firstAt ?? msg.createdAt);
    const end = Math.max(lastAt ?? start, events.length ? events[events.length - 1].at : start, start + 1);
    const span = end - start;
    const bucketMs = BUCKETS.find((b) => span / b <= MAX_BUCKETS) ?? Math.ceil(span / MAX_BUCKETS);
    const count = Math.max(1, Math.min(MAX_BUCKETS + 1, Math.floor(span / bucketMs) + 1));
    const buckets = Array.from({ length: count }, (_, i) => ({ start: start + i * bucketMs, added: 0, removed: 0, cumulative: 0 }));
    for (const e of events) {
      const i = Math.min(count - 1, Math.max(0, Math.floor((e.at - start) / bucketMs)));
      if (e.action === 'add') buckets[i].added++; else buckets[i].removed++;
    }
    let running = 0;
    for (const b of buckets) { running += b.added - b.removed; b.cumulative = running; }

    // departments (not for anonymous polls)
    let byDepartment: Insights['byDepartment'] = null;
    const depts = this.db.prepare('SELECT id, name FROM departments').all() as Array<{ id: string; name: string }>;
    if (!anonymous && depts.length) {
      const names = new Map(depts.map((x) => [x.id, x.name] as const));
      const groups = new Map<string | null, { members: number; reacted: number }>();
      for (const uid of audience) {
        const dep = this.store.userById(uid)?.profile.departmentId ?? null;
        const key = dep && names.has(dep) ? dep : null;
        const g = groups.get(key) ?? { members: 0, reacted: 0 };
        g.members++;
        if (reactors.has(uid)) g.reacted++;
        groups.set(key, g);
      }
      byDepartment = [...groups].map(([id, g]) => ({ departmentId: id, name: id ? names.get(id)! : 'No department', members: g.members, reacted: g.reacted, percent: pct(g.reacted, g.members) }))
        .sort((a, b) => b.percent - a.percent || a.name.localeCompare(b.name));
    }

    // announcements: this one against the office's recent ones
    let announcement: Insights['announcement'] = null;
    const isAnnouncement = !!conv && conv.kind === 'space' && (conv.everyone === 1 || conv.post_policy === 'moderators') && !msg.parentId;
    if (isAnnouncement) {
      const others = this.db.prepare(`SELECT m.id, m.conv_id, m.author_id FROM messages m JOIN conversations c ON c.id = m.conv_id
        WHERE c.kind = 'space' AND (c.everyone = 1 OR c.post_policy = 'moderators') AND m.parent_id IS NULL AND m.deleted = 0 AND m.system IS NULL
        AND m.id != ? AND m.created_at >= ? ORDER BY m.id DESC LIMIT 200`).all(msg.id, msg.createdAt - 90 * 86400_000) as Array<{ id: string; conv_id: string; author_id: string }>;
      const sizes = new Map<string, Set<string>>();
      const rates: number[] = [];
      for (const o of others) {
        let members = sizes.get(o.conv_id);
        if (!members) { members = new Set(this.messaging.members(o.conv_id).filter((u) => !bots.has(u))); sizes.set(o.conv_id, members); }
        const size = members.size - (members.has(o.author_id) ? 1 : 0);
        if (size <= 0) continue;
        const n = (this.db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM reactions WHERE message_id = ? AND user_id != ?').get(o.id, o.author_id) as { n: number }).n;
        rates.push(Math.min(1, n / size));
      }
      announcement = {
        responseRate: pct(reacted.length, audience.length),
        officeAverage: rates.length ? Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 1000) / 10 : null,
        compared: rates.length,
      };
    }

    return {
      messageId: msg.id, convId: msg.convId, note: 'Reactions are not approvals', total, people: reactors.size, distribution,
      audience: {
        members: audience.length, reacted: reacted.length, seenNoReaction, notSeen, unknown,
        reactedPercent: pct(reacted.length, audience.length), seenNoReactionPercent: pct(seenNoReaction, audience.length), receipts: receiptsApply,
      },
      timeline: { bucketMs, buckets }, firstAt, lastAt, byDepartment, announcement, anonymous,
    };
  }
}
