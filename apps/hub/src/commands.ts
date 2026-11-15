// Slash commands for integrations: an administrator gives an integration commands and a
// webhook address on the office network (Hopper, a build server, a script). When someone
// types the command, the hub calls the webhook with an HMAC-signed request and posts the reply.
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { DatabaseSync } from 'node:sqlite';
import type { BotAction, Ops, PublicUser, SlashCommand, Widget } from '@dex/core';
import type { Messaging } from './messaging.ts';
import type { Store } from './store.ts';

export class CommandError extends Error {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bot_commands (
  command TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  description TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_webhooks (
  bot_id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  secret TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_actions (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  label TEXT NOT NULL,
  scope TEXT NOT NULL,
  position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_widgets (
  bot_id TEXT NOT NULL,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  lines TEXT NOT NULL,
  url TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, key)
);
`;

/** Names the app handles itself; integrations cannot take them. */
export const BUILT_IN = ['remind', 'poll', 'meet', 'call', 'video', 'available', 'busy', 'dnd', 'invisible', 'status', 'checkin', 'checkout', 'break', 'shrug', 'schedule', 'help', 'away', 'me'];
const TIMEOUT_MS = 8000;

/** POST JSON and read a JSON reply (up to 64 KB), ignoring certificate names on the LAN. */
export function post(url: string, body: string, headers: Record<string, string>): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers }, timeout: TIMEOUT_MS, rejectUnauthorized: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { text += c; if (text.length > 64 * 1024) req.destroy(new Error('reply too large')); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

export class Commands {
  private readonly db: DatabaseSync;
  private readonly store: Store;
  private readonly messaging: Messaging;

  constructor(store: Store, messaging: Messaging) {
    this.store = store;
    this.db = store.db;
    this.messaging = messaging;
    this.db.exec(SCHEMA);
  }

  actions(): BotAction[] {
    return (this.db.prepare('SELECT a.id, a.label, a.scope, a.bot_id FROM bot_actions a ORDER BY a.bot_id, a.position').all() as Array<{ id: string; label: string; scope: BotAction['scope']; bot_id: string }>)
      .flatMap((r) => { const b = this.store.userById(r.bot_id); return b && this.store.botActive(b.id) ? [{ id: r.id, label: r.label, scope: r.scope, botId: b.id, botName: b.displayName }] : []; });
  }

  widgets(): Widget[] {
    return (this.db.prepare('SELECT * FROM bot_widgets ORDER BY updated_at DESC LIMIT 40').all() as Array<{ bot_id: string; key: string; title: string; lines: string; url: string | null; updated_at: number }>)
      .flatMap((r) => {
        const b = this.store.userById(r.bot_id);
        if (!b || !this.store.botActive(b.id)) return [];
        let lines: string[] = []; try { lines = JSON.parse(r.lines) as string[]; } catch { /* skip */ }
        return [{ botId: b.id, botName: b.displayName, key: r.key, title: r.title, lines, url: r.url, updatedAt: r.updated_at }];
      });
  }

  /** POST /api/bot/widget: an integration sets (or removes) one of its Pulse cards. */
  setWidget(botId: string, body: Record<string, unknown>): Widget[] {
    const key = typeof body.key === 'string' ? body.key.trim().slice(0, 40) : '';
    if (!/^[\w.-]{1,40}$/.test(key)) throw new CommandError('Give the Pulse card a "key" (letters, numbers, . _ -).');
    if (body.remove === true) {
      this.db.prepare('DELETE FROM bot_widgets WHERE bot_id = ? AND key = ?').run(botId, key);
      return this.widgets();
    }
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 80) : '';
    if (!title) throw new CommandError('Give the Pulse card a "title".');
    const lines = (Array.isArray(body.lines) ? body.lines : []).filter((l): l is string => typeof l === 'string').map((l) => l.trim().slice(0, 200)).filter(Boolean).slice(0, 8);
    const url = typeof body.url === 'string' && /^https?:\/\/\S+$/.test(body.url) ? body.url.slice(0, 2000) : null;
    if ((this.db.prepare('SELECT COUNT(*) AS n FROM bot_widgets WHERE bot_id = ? AND key != ?').get(botId, key) as { n: number }).n >= 5) throw new CommandError('An integration can have up to 5 Pulse cards.');
    this.db.prepare('INSERT INTO bot_widgets (bot_id, key, title, lines, url, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(bot_id, key) DO UPDATE SET title = excluded.title, lines = excluded.lines, url = excluded.url, updated_at = excluded.updated_at')
      .run(botId, key, title, JSON.stringify(lines), url, Date.now());
    return this.widgets();
  }

  /** Call an integration's webhook, signed; read { text, ephemeral }. */
  private async call(bot: PublicUser, url: string, secret: string, payload: string): Promise<{ text: string | null; ephemeral: boolean }> {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = crypto.createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
    let reply: { status: number; text: string };
    try {
      reply = await post(url, payload, { 'x-dex-timestamp': ts, 'x-dex-signature': `sha256=${sig}`, 'user-agent': 'DexterityConnectHub' });
    } catch (err) {
      throw new CommandError(`${bot.displayName} did not answer (${(err as Error).message}).`);
    }
    if (reply.status < 200 || reply.status >= 300) throw new CommandError(`${bot.displayName} answered with an error (${reply.status}).`);
    let body: { text?: unknown; ephemeral?: unknown } = {};
    try { body = reply.text ? JSON.parse(reply.text) : {}; } catch { body = { text: reply.text }; }
    const out = typeof body.text === 'string' ? body.text.trim().slice(0, 4000) : '';
    return { text: out || null, ephemeral: body.ephemeral === true };
  }

  list(): SlashCommand[] {
    const active = new Set(this.store.bots().filter((b) => b.active).map((b) => b.bot.id));
    return [...(this.db.prepare('SELECT * FROM bot_commands ORDER BY command').all() as Array<{ command: string; bot_id: string; description: string }>)
      .filter((c) => active.has(c.bot_id)).map((c) => ({ command: c.command, description: c.description, botId: c.bot_id })), ...(this.extra?.list() ?? [])]
      .sort((a, b) => a.command.localeCompare(b.command));
  }

  /** Commands the hub answers itself for an integration (the commands that start flows). */
  extra: {
    list: () => SlashCommand[];
    run: (command: string, me: PublicUser, convId: string, text: string) => Promise<{ text: string | null; ephemeral: boolean; open?: string }> | null;
  } | null = null;

  async handle(op: string, me: PublicUser, d: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case 'admin.bots.commands': {
        if (me.role !== 'owner' && me.role !== 'admin') throw new CommandError('Only administrators can do that.');
        const bot = typeof d.userId === 'string' ? this.store.userById(d.userId) : null;
        if (!bot || bot.role !== 'bot') throw new CommandError('Integration not found.');
        const url = typeof d.webhookUrl === 'string' ? d.webhookUrl.trim() : '';
        if (!/^https?:\/\/[^\s/]+(\/\S*)?$/i.test(url)) throw new CommandError('The webhook address should start with http:// or https://');
        const list = Array.isArray(d.commands) ? d.commands as Array<Record<string, unknown>> : [];
        if (list.length > 20) throw new CommandError('Up to 20 commands per integration.');
        const cmds = list.map((c) => ({ command: String(c.command ?? '').trim().replace(/^\//, '').toLowerCase(), description: String(c.description ?? '').trim().slice(0, 120) }));
        for (const c of cmds) {
          if (!/^[a-z][a-z0-9-]{1,23}$/.test(c.command)) throw new CommandError(`"/${c.command}" is not a valid command: use letters, numbers and dashes.`);
          if (BUILT_IN.includes(c.command)) throw new CommandError(`/${c.command} is built into the app.`);
          const owner = this.db.prepare('SELECT bot_id FROM bot_commands WHERE command = ?').get(c.command) as { bot_id: string } | undefined;
          if (owner && owner.bot_id !== bot.id) throw new CommandError(`/${c.command} already belongs to another integration.`);
          if (this.extra?.list().some((x) => x.command === c.command)) throw new CommandError(`/${c.command} already starts a flow.`);
        }
        const actions = (Array.isArray(d.actions) ? d.actions as Array<Record<string, unknown>> : []).slice(0, 10)
          .map((a) => ({ label: String(a.label ?? '').trim().slice(0, 40), scope: a.scope === 'spaces' || a.scope === 'direct' ? a.scope : 'everywhere' }))
          .filter((a) => a.label);
        const secret = crypto.randomBytes(24).toString('base64url');
        this.db.prepare('DELETE FROM bot_actions WHERE bot_id = ?').run(bot.id);
        actions.forEach((a, i) => this.db.prepare('INSERT INTO bot_actions (id, bot_id, label, scope, position) VALUES (?, ?, ?, ?, ?)').run(crypto.randomBytes(8).toString('hex'), bot.id, a.label, a.scope, i));
        this.db.prepare('DELETE FROM bot_commands WHERE bot_id = ?').run(bot.id);
        for (const c of cmds) this.db.prepare('INSERT INTO bot_commands (command, bot_id, description) VALUES (?, ?, ?)').run(c.command, bot.id, c.description || `Runs ${bot.displayName}`);
        this.db.prepare('INSERT INTO bot_webhooks (bot_id, url, secret) VALUES (?, ?, ?) ON CONFLICT(bot_id) DO UPDATE SET url = excluded.url, secret = excluded.secret').run(bot.id, url, secret);
        this.store.audit(me.id, 'bot.commands', bot.id, { commands: cmds.map((c) => c.command), url });
        return { secret } satisfies Ops['admin.bots.commands']['res'];
      }

      case 'cmd.list':
        return this.list() satisfies Ops['cmd.list']['res'];

      case 'actions.list':
        return this.actions() satisfies Ops['actions.list']['res'];

      case 'widgets.list':
        return this.widgets() satisfies Ops['widgets.list']['res'];

      case 'action.run': {
        if (me.role === 'bot') throw new CommandError('Integrations cannot run actions.');
        const a = this.db.prepare('SELECT a.id, a.label, a.scope, a.bot_id, w.url, w.secret FROM bot_actions a JOIN bot_webhooks w ON w.bot_id = a.bot_id WHERE a.id = ?').get(String(d.actionId ?? '')) as { id: string; label: string; scope: string; bot_id: string; url: string; secret: string } | undefined;
        const bot = a ? this.store.userById(a.bot_id) : null;
        if (!a || !bot || !this.store.botActive(bot.id)) throw new CommandError('That action is no longer available.');
        const msg = this.messaging.messageFor(String(d.messageId ?? ''), me.id);
        if (!msg || msg.deleted) throw new CommandError('Message not found.');
        const conv = this.messaging.memberConv(msg.convId, me.id) as { id: string; kind: string; name: string | null };
        if ((a.scope === 'spaces' && conv.kind !== 'space') || (a.scope === 'direct' && conv.kind !== 'direct')) throw new CommandError(`${a.label} works in ${a.scope === 'spaces' ? 'Spaces' : 'Direct conversations'} only.`);
        // an encrypted message's text comes from the app, which the person asked to send on
        const text = msg.body.startsWith('e2e1:') ? (typeof d.text === 'string' ? d.text.slice(0, 8000) : '') : msg.body;
        const author = this.store.userById(msg.authorId);
        const payload = JSON.stringify({
          action: { id: a.id, label: a.label }, at: new Date().toISOString(),
          user: { id: me.id, name: me.displayName, account: me.account },
          message: { id: msg.id, text, createdAt: new Date(msg.createdAt).toISOString(), author: author ? { id: author.id, name: author.displayName, account: author.account } : null, files: msg.files.map((f) => ({ name: f.name, size: f.size, type: f.mime })) },
          conversation: { id: conv.id, kind: conv.kind, name: conv.name },
        });
        const out = await this.call(bot, a.url, a.secret, payload);
        if (out.text && !out.ephemeral) {
          this.messaging.ensureMember(conv.id, bot.id);
          this.messaging.sendAs(bot, this.messaging.memberConv(conv.id, bot.id), out.text, msg.parentId ?? msg.id, [], `act-${crypto.randomBytes(8).toString('hex')}`, {});
        }
        return out satisfies Ops['action.run']['res'];
      }

      case 'cmd.run': {
        const command = typeof d.command === 'string' ? d.command.replace(/^\//, '').toLowerCase() : '';
        const hooked = this.extra?.run(command, me, String(d.convId), typeof d.text === 'string' ? d.text.slice(0, 4000) : '');
        if (hooked) return await hooked;
        const row = this.db.prepare('SELECT c.bot_id, w.url, w.secret FROM bot_commands c JOIN bot_webhooks w ON w.bot_id = c.bot_id WHERE c.command = ?').get(command) as { bot_id: string; url: string; secret: string } | undefined;
        const bot = row ? this.store.userById(row.bot_id) : null;
        if (!row || !bot || !this.list().some((c) => c.command === command)) throw new CommandError(`There is no /${command} command.`);
        const conv = this.messaging.memberConv(String(d.convId), me.id) as { id: string; kind: string; name: string | null };
        const text = typeof d.text === 'string' ? d.text.slice(0, 4000) : '';
        const payload = JSON.stringify({
          command: `/${command}`, text, at: new Date().toISOString(),
          user: { id: me.id, name: me.displayName, account: me.account },
          conversation: { id: conv.id, kind: conv.kind, name: conv.name },
        });
        const ts = String(Math.floor(Date.now() / 1000));
        const sig = crypto.createHmac('sha256', row.secret).update(`${ts}.${payload}`).digest('hex');
        let reply: { status: number; text: string };
        try {
          reply = await post(row.url, payload, { 'x-dex-timestamp': ts, 'x-dex-signature': `sha256=${sig}`, 'user-agent': 'DexterityConnectHub' });
        } catch (err) {
          throw new CommandError(`${bot.displayName} did not answer (${(err as Error).message}).`);
        }
        if (reply.status < 200 || reply.status >= 300) throw new CommandError(`${bot.displayName} answered with an error (${reply.status}).`);
        let body: { text?: unknown; ephemeral?: unknown } = {};
        try { body = reply.text ? JSON.parse(reply.text) : {}; } catch { body = { text: reply.text }; }
        const out = typeof body.text === 'string' ? body.text.trim().slice(0, 4000) : '';
        const ephemeral = body.ephemeral === true;
        if (out && !ephemeral) {
          this.messaging.ensureMember(conv.id, bot.id);
          this.messaging.sendAs(bot, this.messaging.memberConv(conv.id, bot.id), out, typeof d.parentId === 'string' ? d.parentId : undefined, [], `cmd-${crypto.randomBytes(8).toString('hex')}`, {});
        }
        return { text: out || null, ephemeral } satisfies Ops['cmd.run']['res'];
      }
    }
    return undefined;
  }
}
