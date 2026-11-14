// Slash commands for integrations: an administrator gives an integration commands and a
// webhook address on the office network (Hopper, a build server, a script). When someone
// types the command, the hub calls the webhook with an HMAC-signed request and posts the reply.
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { DatabaseSync } from 'node:sqlite';
import type { Ops, PublicUser, SlashCommand } from '@dex/core';
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
`;

/** Names the app handles itself; integrations cannot take them. */
export const BUILT_IN = ['remind', 'poll', 'meet', 'call', 'video', 'available', 'busy', 'dnd', 'invisible', 'status', 'checkin', 'checkout', 'break', 'shrug', 'schedule', 'help', 'away', 'me'];
const TIMEOUT_MS = 8000;

/** POST JSON and read a JSON reply (up to 64 KB), ignoring certificate names on the LAN. */
function post(url: string, body: string, headers: Record<string, string>): Promise<{ status: number; text: string }> {
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

  list(): SlashCommand[] {
    const active = new Set(this.store.bots().filter((b) => b.active).map((b) => b.bot.id));
    return (this.db.prepare('SELECT * FROM bot_commands ORDER BY command').all() as Array<{ command: string; bot_id: string; description: string }>)
      .filter((c) => active.has(c.bot_id)).map((c) => ({ command: c.command, description: c.description, botId: c.bot_id }));
  }

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
        }
        const secret = crypto.randomBytes(24).toString('base64url');
        this.db.prepare('DELETE FROM bot_commands WHERE bot_id = ?').run(bot.id);
        for (const c of cmds) this.db.prepare('INSERT INTO bot_commands (command, bot_id, description) VALUES (?, ?, ?)').run(c.command, bot.id, c.description || `Runs ${bot.displayName}`);
        this.db.prepare('INSERT INTO bot_webhooks (bot_id, url, secret) VALUES (?, ?, ?) ON CONFLICT(bot_id) DO UPDATE SET url = excluded.url, secret = excluded.secret').run(bot.id, url, secret);
        this.store.audit(me.id, 'bot.commands', bot.id, { commands: cmds.map((c) => c.command), url });
        return { secret } satisfies Ops['admin.bots.commands']['res'];
      }

      case 'cmd.list':
        return this.list() satisfies Ops['cmd.list']['res'];

      case 'cmd.run': {
        const command = typeof d.command === 'string' ? d.command.replace(/^\//, '').toLowerCase() : '';
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
