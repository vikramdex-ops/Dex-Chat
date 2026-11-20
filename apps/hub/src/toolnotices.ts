// Tool notices: how any office tool (Project Opener, Dexterity Sheets, Hopper, Datum…) tells a
// person something through Nib, with one HTTP call and its integration token.
//
//   GET  /api/bot/hello    who am I, what does this hub offer (a tool's Test button)
//   POST /api/bot/notify   a notice for people (and optionally a Space)
//
// Nib is not an integration and nothing outside the hub posts as it. So the tool asks, and the hub
// writes: the line in the person's conversation with Nib always starts with the integration's own
// name, set here and not by the tool, so a notice can never pass for Nib's own words. An
// administrator can switch "through Nib" off per integration (Control room → Integrations); the
// notice then arrives as a Direct message from the integration, as it does for someone Nib cannot
// write to (a guest). Either way the call succeeds: a tool never has to know which it was.
//
// Made for tools that retry: the same `key` for the same person is delivered once (7 days), a
// notice without a key is not repeated within 10 minutes, and a request over the rate limit is
// refused whole with Retry-After, so a tool's outbox can send it again unchanged.
// The contract is in docs/TOOL-NOTICES.md.
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { PublicUser } from '@dex/core';
import type { Messaging } from './messaging.ts';
import type { Nib } from './nib.ts';
import type { Store } from './store.ts';
import { localDate } from './work.ts';

export const TOOL_API_VERSION = 1;
/** Deliveries (one per person or Space) an integration may ask for in a minute. */
export const NOTICES_PER_MINUTE = 120;
const MAX_RECIPIENTS = 50;
const KEY_DAYS = 7;
const AUTO_KEY_MS = 10 * 60_000;
const PRUNE_EVERY_MS = 3600_000;
const LINK = /^(?:https?|dexconnect|projectopener|dexterity|sleuth|datum):\/\/[^\s<>"`]{1,2000}$/i;
const KINDS: Record<string, string> = { task: 'Task', mention: 'Mention', alert: 'Alert', reminder: 'Reminder', review: 'Review', update: 'Update' };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tool_notices (
  bot_id TEXT NOT NULL, key TEXT NOT NULL, target TEXT NOT NULL, via TEXT NOT NULL,
  conv_id TEXT, message_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (bot_id, key, target)
);
CREATE INDEX IF NOT EXISTS idx_tool_notices_at ON tool_notices(created_at);
CREATE TABLE IF NOT EXISTS tool_notice_prefs (bot_id TEXT PRIMARY KEY, via_nib INTEGER NOT NULL DEFAULT 1);
`;

export type NoticeVia = 'nib' | 'integration';
export type NoticeStatus = 'delivered' | 'duplicate' | 'unknown' | 'failed';
export interface NoticeResult {
  /** The recipient as the tool wrote it (`space:<name>` for the Space). */
  to: string;
  status: NoticeStatus;
  via?: NoticeVia;
  /** The person's Windows sign-in as the office knows it. */
  account?: string;
  /** On leave today: the day they are back and who covers (their sign-in), so the tool can say so. */
  away?: { back: string | null; cover: string | null };
}
export interface NoticeAnswer {
  ok: boolean;
  api: number;
  results: NoticeResult[];
  delivered: number;
  duplicates: number;
  failed: number;
  unknown: string[];
  error?: string;
  retryAfterSec?: number;
}

export interface ToolNoticeDeps {
  db: DatabaseSync;
  store: Store;
  messaging: Messaging;
  nib: Nib;
  hub: () => { id: string; name: string; version: string };
  log: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
  now?: () => number;
}

const line = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const prose = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max) : '');

export class ToolNotices {
  private readonly d: ToolNoticeDeps;
  private readonly rate = new Map<string, number[]>();
  private pruned = 0;

  constructor(d: ToolNoticeDeps) {
    this.d = d;
    d.db.exec(SCHEMA);
  }

  private now(): number { return this.d.now ? this.d.now() : Date.now(); }

  // ------------------------------------------------------------ the administrator's switch
  /** Do this integration's notices arrive through Nib? On unless an administrator switched it off. */
  viaNib(botId: string): boolean {
    const r = this.d.db.prepare('SELECT via_nib FROM tool_notice_prefs WHERE bot_id = ?').get(botId) as { via_nib: number } | undefined;
    return r ? !!r.via_nib : true;
  }
  setViaNib(botId: string, on: boolean): void {
    this.d.db.prepare('INSERT INTO tool_notice_prefs (bot_id, via_nib) VALUES (?, ?) ON CONFLICT(bot_id) DO UPDATE SET via_nib = excluded.via_nib').run(botId, on ? 1 : 0);
  }
  /** Notices passed on for an integration in the last 7 days, and the last one. */
  stats(botId: string): { notices: number; lastNotice: number | null } {
    const r = this.d.db.prepare('SELECT COUNT(*) AS n, MAX(created_at) AS last FROM tool_notices WHERE bot_id = ? AND created_at > ?').get(botId, this.now() - KEY_DAYS * 86400_000) as { n: number; last: number | null };
    return { notices: r.n, lastNotice: r.last };
  }

  // ------------------------------------------------------------ GET /api/bot/hello
  hello(bot: PublicUser): Record<string, unknown> {
    return {
      ok: true, api: TOOL_API_VERSION,
      integration: { id: bot.id, name: bot.displayName },
      hub: this.d.hub(),
      features: ['hello', 'notify', 'message', 'widget', 'flows', 'sessions'],
      notices: { via: this.viaNib(bot.id) ? 'nib' : 'integration', perMinute: NOTICES_PER_MINUTE, maxRecipients: MAX_RECIPIENTS, keyDays: KEY_DAYS },
    };
  }

  // ------------------------------------------------------------ POST /api/bot/notify
  /** The notice as Markdown, without the line that says which tool it is from. */
  private compose(b: Record<string, unknown>): string {
    const out: string[] = [];
    const title = line(b.title, 200);
    if (title) out.push(`**${title.replace(/\*\*/g, '')}**`);
    const text = prose(b.text, 2000);
    if (text) out.push(text);
    if (Array.isArray(b.lines)) for (const l of b.lines.slice(0, 8)) { const t = line(l, 300); if (t) out.push(`- ${t}`); }
    const link = b.link && typeof b.link === 'object' ? b.link as { title?: unknown; url?: unknown } : typeof b.link === 'string' ? { url: b.link } : null;
    const url = link && typeof link.url === 'string' ? link.url.trim() : '';
    if (url && LINK.test(url)) {
      const label = line(link?.title, 80).replace(/[[\]]/g, '');
      const safe = url.replace(/\(/g, '%28').replace(/\)/g, '%29');
      out.push(label ? `[${label}](${safe})` : safe);
    }
    return out.join('\n');
  }

  private limited(botId: string, n: number): number {
    const now = this.now();
    const times = (this.rate.get(botId) ?? []).filter((t) => t > now - 60_000);
    if (times.length + n > NOTICES_PER_MINUTE) {
      this.rate.set(botId, times);
      // when enough of the minute's deliveries have aged out for this request to fit
      const need = times.length + n - NOTICES_PER_MINUTE;
      const at = times[Math.min(need, times.length) - 1] ?? now;
      return Math.max(1, Math.ceil((at + 60_000 - now) / 1000));
    }
    for (let i = 0; i < n; i++) times.push(now);
    this.rate.set(botId, times);
    return 0;
  }

  private had(botId: string, key: string, target: string, auto: boolean): { via: NoticeVia } | null {
    const r = this.d.db.prepare('SELECT via, created_at FROM tool_notices WHERE bot_id = ? AND key = ? AND target = ?').get(botId, key, target) as { via: NoticeVia; created_at: number } | undefined;
    if (!r) return null;
    const age = this.now() - r.created_at;
    return age < (auto ? AUTO_KEY_MS : KEY_DAYS * 86400_000) ? { via: r.via } : null;
  }
  private record(botId: string, key: string, target: string, via: NoticeVia, convId: string, messageId: string): void {
    this.d.db.prepare('INSERT OR REPLACE INTO tool_notices (bot_id, key, target, via, conv_id, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(botId, key, target, via, convId, messageId, this.now());
  }
  private prune(): void {
    const now = this.now();
    if (now - this.pruned < PRUNE_EVERY_MS) return;
    this.pruned = now;
    this.d.db.prepare('DELETE FROM tool_notices WHERE created_at < ?').run(now - KEY_DAYS * 86400_000);
  }

  /** As the integration itself: a Direct message to the person. */
  private direct(bot: PublicUser, uid: string, body: string, clientId: string): { convId: string; messageId: string } {
    const conv = this.d.messaging.handle('conv.create', bot, { kind: 'direct', members: [uid] }) as { id: string };
    const msg = this.d.messaging.handle('msg.send', bot, { convId: conv.id, body, clientId }) as { id: string };
    return { convId: conv.id, messageId: msg.id };
  }

  notify(bot: PublicUser, raw: unknown): { status: number; body: NoticeAnswer } {
    const answer = (status: number, error: string, extra: Partial<NoticeAnswer> = {}): { status: number; body: NoticeAnswer } =>
      ({ status, body: { ok: false, api: TOOL_API_VERSION, results: [], delivered: 0, duplicates: 0, failed: 0, unknown: [], error, ...extra } });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return answer(400, 'Send a JSON object.');
    const b = raw as Record<string, unknown>;
    const content = this.compose(b);
    if (!content) return answer(400, 'Nothing to say: give "title", "text" or "lines".');
    if (b.to !== undefined && !Array.isArray(b.to)) return answer(400, '"to" is a list of Windows sign-ins.');
    const to = [...new Set((Array.isArray(b.to) ? b.to : []).filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean))];
    if (to.length > MAX_RECIPIENTS) return answer(400, `Up to ${MAX_RECIPIENTS} people in one notice.`);
    const spaceName = line(b.space, 120);
    if (!to.length && !spaceName) return answer(400, 'Nobody to tell: give "to" or "space".');
    if (b.key !== undefined && (typeof b.key !== 'string' || !b.key.trim() || b.key.length > 160)) return answer(400, '"key" is up to 160 characters.');

    const wait = this.limited(bot.id, to.length + (spaceName ? 1 : 0));
    if (wait) return answer(429, `Too many notices in a minute (${NOTICES_PER_MINUTE}). Send this one again in ${wait} s.`, { retryAfterSec: wait });
    this.prune();

    const explicit = typeof b.key === 'string';
    const key = explicit ? (b.key as string).trim() : `auto:${crypto.createHash('sha256').update(content).digest('hex').slice(0, 32)}`;
    const wantNib = b.via !== 'integration' && this.viaNib(bot.id);
    const kind = typeof b.kind === 'string' ? KINDS[b.kind.toLowerCase()] ?? '' : '';
    const sender = typeof b.from === 'string' ? this.d.store.userForAccount(b.from) : null;
    const head = [`**${bot.displayName}**`, kind, sender && sender.role !== 'bot' ? `from ${sender.displayName}` : ''].filter(Boolean).join(' · ');
    const active = new Set(this.d.store.activeUsers().map((u) => u.id));
    const today = localDate(this.d.nib.now());
    const results: NoticeResult[] = [];
    const seen = new Set<string>();

    for (const who of to) {
      const person = this.d.store.userForAccount(who);
      if (!person || person.role === 'bot' || !active.has(person.id)) { results.push({ to: who, status: 'unknown' }); continue; }
      if (seen.has(person.id)) continue;   // the same person written twice ("priya", "DEX\priya")
      seen.add(person.id);
      const r: NoticeResult = { to: who, status: 'delivered', account: person.account };
      const leave = this.d.nib.leaveInfo(person.id, today);
      if (leave) r.away = { back: leave.back, cover: leave.coverId ? this.d.store.userById(leave.coverId)?.account ?? null : null };
      const before = this.had(bot.id, key, person.id, !explicit);
      if (before) { results.push({ ...r, status: 'duplicate', via: before.via }); continue; }
      try {
        const clientId = `tool-${crypto.randomBytes(8).toString('hex')}`;
        const viaNib = wantNib ? this.d.nib.toolLine(person.id, `${head}\n${content}`) : null;
        const sent = viaNib ?? this.direct(bot, person.id, [kind && `${kind}${sender && sender.role !== 'bot' ? ` · from ${sender.displayName}` : ''}`, content].filter(Boolean).join('\n'), clientId);
        r.via = viaNib ? 'nib' : 'integration';
        this.record(bot.id, key, person.id, r.via, sent.convId, sent.messageId);
        results.push(r);
      } catch (err) {
        this.d.log('warn', 'tool notice not delivered', { bot: bot.displayName, error: (err as Error).message });
        results.push({ ...r, status: 'failed' });
      }
    }

    if (spaceName) {
      const label = `space:${spaceName}`;
      const space = this.d.messaging.spaceByName(spaceName);
      if (!space) results.push({ to: label, status: 'unknown' });
      else if (this.had(bot.id, key, `space:${space}`, !explicit)) results.push({ to: label, status: 'duplicate', via: 'integration' });
      else {
        try {
          // a Space hears a tool in the tool's own name: Nib only speaks there for the office's own news
          this.d.messaging.ensureMember(space, bot.id);
          const msg = this.d.messaging.handle('msg.send', bot, { convId: space, body: [kind, content].filter(Boolean).join('\n'), clientId: `tool-${crypto.randomBytes(8).toString('hex')}` }) as { id: string };
          this.record(bot.id, key, `space:${space}`, 'integration', space, msg.id);
          results.push({ to: label, status: 'delivered', via: 'integration' });
        } catch (err) {
          this.d.log('warn', 'tool notice not posted in the Space', { bot: bot.displayName, error: (err as Error).message });
          results.push({ to: label, status: 'failed' });
        }
      }
    }

    const count = (s: NoticeStatus) => results.filter((r) => r.status === s).length;
    const delivered = count('delivered'), duplicates = count('duplicate'), failed = count('failed');
    const body: NoticeAnswer = { ok: delivered + duplicates > 0, api: TOOL_API_VERSION, results, delivered, duplicates, failed, unknown: results.filter((r) => r.status === 'unknown').map((r) => r.to) };
    this.d.log('info', 'tool notice', { bot: bot.displayName, delivered, duplicates, failed, unknown: body.unknown.length });
    // nothing got through and something broke on the hub's side: the tool should try again
    if (failed && !delivered && !duplicates) return { status: 500, body: { ...body, error: 'The notice could not be delivered. Send it again with the same key.' } };
    return { status: 200, body };
  }
}
