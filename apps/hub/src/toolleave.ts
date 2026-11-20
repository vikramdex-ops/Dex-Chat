// Leave for office tools: an integration an administrator allowed to read leave (Control room →
// Integrations → "Reads leave") asks who is away, from Nib's leave note, with its integration token.
// Project Opener uses it to fill in and run its Handover. Off for every integration until an
// administrator turns it on; the switch is audited (`bot.leave`). A tool tells people things with
// tool notices (toolnotices.ts); this is only the reading side.
//
//   GET /api/bot/leave?account=<sign-in>       that member's leave from today on: dates and cover only
//   GET /api/bot/leave/changes?since=<cursor>  whose leave was noted or cancelled after the cursor
//                                              (without `since`: only the cursor to start from)
import type { DatabaseSync } from 'node:sqlite';
import type { PublicUser } from '@dex/core';

/** One leave as a tool sees it: never the kind, the note or the handover. */
export interface ToolLeave {
  id: string; from: string; to: string; half: 'am' | 'pm' | null; current: boolean;
  cover: { account: string; name: string } | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tool_leave_prefs (bot_id TEXT PRIMARY KEY, reads_leave INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS nib_leave_changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, at INTEGER NOT NULL);
`;
const KEEP_MS = 30 * 86_400_000;

export interface ToolLeaveDeps {
  db: DatabaseSync;
  userById: (id: string) => PublicUser | null;
  userForAccount: (account: string) => PublicUser | null;
  /** Leave that ends on or after `date` (not cancelled), oldest first. */
  leaveFrom: (uid: string, date: string) => Array<{ id: string; from: string; to: string; half: 'am' | 'pm' | null; coverId: string | null }>;
  today: () => string;
  now?: () => number;
}

export interface LeaveAnswer { status: number; body: Record<string, unknown> }

export class ToolLeaveReads {
  private readonly d: ToolLeaveDeps;
  constructor(d: ToolLeaveDeps) { this.d = d; d.db.exec(SCHEMA); }
  private now() { return this.d.now ? this.d.now() : Date.now(); }

  readsLeave(botId: string): boolean {
    return (this.d.db.prepare('SELECT reads_leave FROM tool_leave_prefs WHERE bot_id = ?').get(botId) as { reads_leave: number } | undefined)?.reads_leave === 1;
  }
  setReadsLeave(botId: string, on: boolean): void {
    this.d.db.prepare('INSERT INTO tool_leave_prefs (bot_id, reads_leave) VALUES (?, ?) ON CONFLICT(bot_id) DO UPDATE SET reads_leave = excluded.reads_leave').run(botId, on ? 1 : 0);
  }

  /** Nib calls this whenever someone's leave is noted or cancelled. */
  leaveChanged(uid: string): void {
    this.d.db.prepare('INSERT INTO nib_leave_changes (user_id, at) VALUES (?, ?)').run(uid, this.now());
    this.d.db.prepare('DELETE FROM nib_leave_changes WHERE at < ?').run(this.now() - KEEP_MS);
  }

  /** `GET /api/bot/leave…` for an integration; null when the path is not one of these. */
  handle(bot: PublicUser, method: string, rawUrl: string): LeaveAnswer | null {
    const url = new URL(rawUrl, 'https://hub');
    if (method !== 'GET' || (url.pathname !== '/api/bot/leave' && url.pathname !== '/api/bot/leave/changes')) return null;
    if (!this.readsLeave(bot.id)) return { status: 403, body: { ok: false, error: 'An administrator has not let this integration read leave (Control room → Integrations → Reads leave).' } };
    if (url.pathname === '/api/bot/leave/changes') {
      const top = (this.d.db.prepare('SELECT MAX(seq) AS s FROM nib_leave_changes').get() as { s: number | null }).s ?? 0;
      if (!url.searchParams.has('since')) return { status: 200, body: { ok: true, cursor: top, accounts: [] } };
      const since = Number(url.searchParams.get('since')) || 0;
      const ids = (this.d.db.prepare('SELECT DISTINCT user_id FROM nib_leave_changes WHERE seq > ? AND seq <= ?').all(since, top) as Array<{ user_id: string }>).map((r) => r.user_id);
      return { status: 200, body: { ok: true, cursor: top, accounts: ids.map((id) => this.d.userById(id)?.account).filter((a): a is string => !!a) } };
    }
    const person = this.d.userForAccount(url.searchParams.get('account') ?? '');
    if (!person || person.role === 'bot' || person.role === 'guest') return { status: 404, body: { ok: false, error: 'No member has that sign-in.' } };
    const today = this.d.today();
    const leave: ToolLeave[] = this.d.leaveFrom(person.id, today).map((l) => {
      const cover = l.coverId ? this.d.userById(l.coverId) : null;
      return { id: l.id, from: l.from, to: l.to, half: l.half, current: l.from <= today && l.to >= today, cover: cover ? { account: cover.account, name: cover.displayName } : null };
    });
    return { status: 200, body: { ok: true, account: person.account, today, leave } };
  }
}
