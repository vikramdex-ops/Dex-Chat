// Nib for office tools: hub-issued, per-tool, admin-revocable keys that let a tool (Project Opener)
// have Nib write to a member and read members' leave, and nothing else. An administrator makes one
// key per tool in Control room → Integrations; the tool gets it once through the office's shared
// configuration, never per person. Every message and every key change is in the audit trail.
//
//   POST /api/nib/message        { id, to: [account], text, card?: { title, lines, url } }   scope "message"
//   GET  /api/nib/leave?account= the member's leave from today on, with the cover                scope "leave"
//   GET  /api/nib/leave/changes?since=<cursor>  accounts whose leave changed since the cursor (without
//        `since`: only the cursor to start from)                                                 scope "leave"
//
// All three take `Authorization: Bearer nibt_…`. Trust the hub by its certificate fingerprint.
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { NibToolKey as NibToolView, NibToolScope, PublicUser } from '@dex/core';

export const NIB_TOOL_SCOPES: NibToolScope[] = ['message', 'leave'];

/** One leave as a tool sees it: dates and cover only (never the kind, the note or the handover). */
export interface NibToolLeave {
  id: string; from: string; to: string; half: 'am' | 'pm' | null; current: boolean;
  cover: { account: string; name: string } | null;
}

interface ToolRow { id: string; name: string; token_hash: string; scopes: string; created_by: string | null; created_at: number; last_used: number | null; revoked_at: number | null }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nib_tools (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL,
  created_by TEXT, created_at INTEGER NOT NULL, last_used INTEGER, revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS nib_leave_changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, at INTEGER NOT NULL);
`;

/** Links a card may carry: the web and the office's own tools (as in `dexconnect://share`). */
const CARD_URL = /^(https:\/\/|projectopener:\/\/|dexconnect:\/\/|sleuth:\/\/|datum:\/\/|dexterity:\/\/)[^\s<>()\[\]]{1,1990}$/i;
const PER_MINUTE = 600;

export interface NibToolDeps {
  db: DatabaseSync;
  userById: (id: string) => PublicUser | null;
  userForAccount: (account: string) => PublicUser | null;
  audit: (actor: string | null, action: string, target: string | null, detail?: unknown) => void;
  /** Nib's plain line, once per key; false when Nib is off or cannot reach the person. */
  note: (uid: string, key: string, text: string) => boolean;
  /** Leave from `date` on (not cancelled), oldest first. */
  leaveFrom: (uid: string, date: string) => Array<{ id: string; from: string; to: string; half: 'am' | 'pm' | null; coverId: string | null }>;
  today: () => string;
  log: (level: 'info' | 'warn', msg: string, extra?: Record<string, unknown>) => void;
  now?: () => number;
}

const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max) : '');
const oneLine = (v: unknown, max: number) => clean(v, max).replace(/\s+/g, ' ');

export class NibTools {
  private readonly rate = new Map<string, number[]>();
  private readonly d: NibToolDeps;
  constructor(d: NibToolDeps) { this.d = d; d.db.exec(SCHEMA); }
  private now() { return this.d.now ? this.d.now() : Date.now(); }

  // ------------------------------------------------------------ keys (administrators)
  create(by: PublicUser, name: unknown, scopes: unknown): { tool: NibToolView; token: string } {
    const n = oneLine(name, 60);
    if (!n) throw new Error('Name the tool this key is for.');
    const s = [...new Set((Array.isArray(scopes) ? scopes : NIB_TOOL_SCOPES).filter((x): x is NibToolScope => NIB_TOOL_SCOPES.includes(x as NibToolScope)))];
    if (!s.length) throw new Error('Choose what the key may do: message, leave or both.');
    const token = `nibt_${crypto.randomBytes(24).toString('base64url')}`;
    const id = crypto.randomBytes(8).toString('hex');
    this.d.db.prepare('INSERT INTO nib_tools (id, name, token_hash, scopes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, n, hash(token), JSON.stringify(s), by.id, this.now());
    this.d.audit(by.id, 'nib.tool.created', id, { name: n, scopes: s });
    return { tool: this.view(this.row(id)!), token };
  }
  list(): NibToolView[] {
    return (this.d.db.prepare('SELECT * FROM nib_tools ORDER BY created_at DESC').all() as unknown as ToolRow[]).map((r) => this.view(r));
  }
  revoke(by: PublicUser, id: unknown): void {
    const r = typeof id === 'string' ? this.row(id) : undefined;
    if (!r) throw new Error('That key was not found.');
    if (r.revoked_at) return;
    this.d.db.prepare('UPDATE nib_tools SET revoked_at = ? WHERE id = ?').run(this.now(), r.id);
    this.d.audit(by.id, 'nib.tool.revoked', r.id, { name: r.name });
  }
  private row(id: string) { return this.d.db.prepare('SELECT * FROM nib_tools WHERE id = ?').get(id) as unknown as ToolRow | undefined; }
  private view(r: ToolRow): NibToolView {
    return { id: r.id, name: r.name, scopes: JSON.parse(r.scopes) as NibToolScope[], createdAt: r.created_at, createdBy: r.created_by, lastUsed: r.last_used, revokedAt: r.revoked_at };
  }

  // ------------------------------------------------------------ leave changes (from Nib)
  /** Nib calls this whenever someone's leave is noted or cancelled. */
  leaveChanged(uid: string): void {
    this.d.db.prepare('INSERT INTO nib_leave_changes (user_id, at) VALUES (?, ?)').run(uid, this.now());
    this.d.db.prepare('DELETE FROM nib_leave_changes WHERE at < ?').run(this.now() - 30 * 86_400_000);
  }

  // ------------------------------------------------------------ http
  async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const tool = token.startsWith('nibt_') ? this.d.db.prepare('SELECT * FROM nib_tools WHERE token_hash = ?').get(hash(token)) as unknown as ToolRow | undefined : undefined;
    if (!tool || tool.revoked_at) { req.resume(); reply(401, { ok: false, error: 'Unknown or revoked Nib key.' }); return; }
    const now = this.now();
    const times = (this.rate.get(tool.id) ?? []).filter((t) => t > now - 60_000);
    if (times.length >= PER_MINUTE) { req.resume(); reply(429, { ok: false, error: 'Too many requests; try again in a minute.' }); return; }
    times.push(now); this.rate.set(tool.id, times);
    this.d.db.prepare('UPDATE nib_tools SET last_used = ? WHERE id = ?').run(now, tool.id);
    const scopes = JSON.parse(tool.scopes) as NibToolScope[];
    const url = new URL(req.url ?? '/', 'https://hub');
    const allowed = (s: NibToolScope) => { if (scopes.includes(s)) return true; req.resume(); reply(403, { ok: false, error: `This key may not use ${s}.` }); return false; };

    if (req.method === 'GET' && url.pathname === '/api/nib/leave') {
      if (!allowed('leave')) return;
      const person = this.d.userForAccount(url.searchParams.get('account') ?? '');
      if (!person || person.role === 'bot' || person.role === 'guest') { reply(404, { ok: false, error: 'No member has that sign-in.' }); return; }
      const today = this.d.today();
      const leave: NibToolLeave[] = this.d.leaveFrom(person.id, today).map((l) => {
        const cover = l.coverId ? this.d.userById(l.coverId) : null;
        return { id: l.id, from: l.from, to: l.to, half: l.half, current: l.from <= today && l.to >= today, cover: cover ? { account: cover.account, name: cover.displayName } : null };
      });
      reply(200, { ok: true, account: person.account, today, leave });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/nib/leave/changes') {
      if (!allowed('leave')) return;
      const since = Number(url.searchParams.get('since') ?? 0) || 0;
      const top = (this.d.db.prepare('SELECT MAX(seq) AS s FROM nib_leave_changes').get() as { s: number | null }).s ?? 0;
      const ids = (this.d.db.prepare('SELECT DISTINCT user_id FROM nib_leave_changes WHERE seq > ? AND seq <= ?').all(since, top) as Array<{ user_id: string }>).map((r) => r.user_id);
      const accounts = url.searchParams.has('since') ? ids.map((id) => this.d.userById(id)?.account).filter((a): a is string => !!a) : [];
      reply(200, { ok: true, cursor: top, accounts });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/nib/message') {
      if (!allowed('message')) return;
      let raw = '';
      try { for await (const c of req) { raw += c; if (raw.length > 32 * 1024) throw new Error('too large'); } } catch { reply(413, { ok: false, error: 'Message too large.' }); return; }
      let body: { id?: unknown; text?: unknown; to?: unknown; card?: { title?: unknown; lines?: unknown; url?: unknown } };
      try { body = JSON.parse(raw); } catch { reply(400, { ok: false, error: 'Invalid JSON.' }); return; }
      const key = typeof body.id === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(body.id) ? body.id : '';
      if (!key) { reply(400, { ok: false, error: 'Give each message an "id" (letters, digits, . _ : -; up to 64) so a retry is not sent twice.' }); return; }
      const card = body.card && typeof body.card === 'object' ? body.card : null;
      const cardLines: string[] = [];
      if (card) {
        const title = oneLine(card.title, 200).replace(/[[\]]/g, '');
        const link = typeof card.url === 'string' && CARD_URL.test(card.url.trim()) ? card.url.trim() : '';
        if (title) cardLines.push(link ? `**[${title}](${link})**` : `**${title}**`);
        else if (link) cardLines.push(link);
        if (Array.isArray(card.lines)) for (const l of card.lines.slice(0, 8)) { const t = oneLine(l, 300); if (t) cardLines.push(`- ${t}`); }
      }
      const text = clean(body.text, 2000);
      if (!text && !cardLines.length) { reply(400, { ok: false, error: 'Nothing to send: give "text" or a "card".' }); return; }
      const message = [`*${tool.name}*`, text, cardLines.join('\n')].filter(Boolean).join('\n\n');
      const recipients = Array.isArray(body.to) ? body.to.filter((x): x is string => typeof x === 'string').slice(0, 50) : [];
      const delivered: string[] = []; const unknown: string[] = []; const failed: string[] = [];
      for (const who of recipients) {
        const person = this.d.userForAccount(who);
        if (!person || person.role === 'bot' || person.role === 'guest') { unknown.push(who); continue; }
        if (this.d.note(person.id, `t:${tool.id}:${key}`, message)) delivered.push(person.account);
        else failed.push(person.account);
      }
      this.d.audit(null, 'nib.tool.message', tool.id, { tool: tool.name, id: key, delivered, unknown, failed });
      this.d.log('info', 'nib tool message', { tool: tool.name, delivered: delivered.length, unknown: unknown.length, failed: failed.length });
      const code = delivered.length ? 200 : failed.length ? 503 : 404;
      reply(code, { ok: delivered.length > 0, delivered, unknown, failed, ...(code === 503 ? { error: 'Nib is off or cannot reach them.' } : {}) });
      return;
    }
    req.resume();
    reply(404, { ok: false, error: 'not found' });
  }
}
