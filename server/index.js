// Lattice — offline-first LAN messenger server.
// Node built-ins only: http, node:sqlite, dgram, crypto, fs. No npm install required.
import http from 'node:http';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');
const PORT = Number(process.env.PORT || 3000);
const DISCOVERY_PORT = Number(process.env.DISCOVERY_PORT || 47823);
const WORKSPACE_NAME = process.env.WORKSPACE_NAME || 'Office';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_BYTES || 512 * 1024 * 1024);
const MAX_JSON = 512 * 1024;
const VERSION = '1.0.0';

fs.mkdirSync(FILES_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'lattice.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  device TEXT,
  hue INTEGER NOT NULL DEFAULT 210,
  role TEXT NOT NULL DEFAULT 'member',
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT,
  topic TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  last_read TEXT,
  PRIMARY KEY (channel_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  file_id TEXT,
  reply_to TEXT,
  forwarded_from TEXT,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  disk_path TEXT NOT NULL,
  sha256 TEXT,
  uploader_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages(reply_to);
CREATE INDEX IF NOT EXISTS idx_members_user ON members(user_id);
CREATE INDEX IF NOT EXISTS idx_files_sha ON files(sha256);
`);

// forward migrations for databases created by earlier builds
for (const sql of [
  'ALTER TABLE messages ADD COLUMN file_id TEXT',
  'ALTER TABLE messages ADD COLUMN forwarded_from TEXT',
  "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'",
]) {
  try { db.exec(sql); } catch { /* column already present */ }
}

const now = () => Date.now();
const uid = () => crypto.randomUUID();
const newToken = () => crypto.randomBytes(24).toString('hex');

function log(level, msg, extra) {
  const order = { error: 0, warn: 1, info: 2, debug: 3 };
  if (order[level] > order[LOG_LEVEL]) return;
  const line = { t: new Date().toISOString(), level, msg, ...(extra || {}) };
  console.log(JSON.stringify(line));
}

// ---------------------------------------------------------------- realtime
const streams = new Map(); // userId -> Set<res>
const onlineIds = () => new Set([...streams.entries()].filter(([, s]) => s.size > 0).map(([id]) => id));

function send(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function publish(event, payload, { toUsers = null } = {}) {
  for (const userId of toUsers ?? [...streams.keys()]) {
    const set = streams.get(userId);
    if (!set) continue;
    for (const res of set) {
      try { send(res, event, payload); } catch { set.delete(res); }
    }
  }
}

// ------------------------------------------------------------------ helpers
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'SAMEORIGIN',
  'content-security-policy':
    "default-src 'self'; img-src 'self' data: blob:; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'self'; base-uri 'none'",
};

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}
const fail = (res, code, message) => json(res, code, { error: message });

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON) throw Object.assign(new Error('payload too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { status: 400 });
  }
}

const COOKIE_RE = /(?:^|;\s*)lattice=([a-f0-9]{48})/;
function bearer(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  const m = (req.headers.cookie || '').match(COOKIE_RE);
  return m ? m[1] : null;
}
const userByToken = (t) => (t ? db.prepare('SELECT * FROM users WHERE token = ?').get(t) : null);

function hueFor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

const publicUser = (u) => ({ id: u.id, name: u.name, device: u.device, hue: u.hue, role: u.role });
const isAdmin = (u) => u && u.role === 'admin';
const memberIds = (channelId) => db.prepare('SELECT user_id FROM members WHERE channel_id = ?').all(channelId).map((r) => r.user_id);
const isMember = (channelId, userId) => memberIds(channelId).includes(userId);

function channelView(channelId, viewerId) {
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!ch) return null;
  const members = memberIds(channelId)
    .map((id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id))
    .filter(Boolean)
    .map(publicUser);
  const membership = db.prepare('SELECT * FROM members WHERE channel_id = ? AND user_id = ?').get(channelId, viewerId);
  const last = db
    .prepare('SELECT id, created_at, body, deleted FROM messages WHERE channel_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
    .get(channelId);
  let unread = 0;
  if (membership?.last_read) {
    const row = db.prepare('SELECT created_at, id FROM messages WHERE id = ?').get(membership.last_read);
    if (row) {
      unread = db
        .prepare('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND deleted = 0 AND author_id != ? AND (created_at > ? OR (created_at = ? AND id > ?))')
        .get(channelId, viewerId, row.created_at, row.created_at, row.id).n;
    }
  } else {
    unread = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND deleted = 0 AND author_id != ?').get(channelId, viewerId).n;
  }
  return {
    id: ch.id,
    kind: ch.kind,
    name: ch.name,
    topic: ch.topic,
    createdBy: ch.created_by,
    unread,
    lastMessageAt: last ? last.created_at : null,
    preview: last && !last.deleted ? last.body.slice(0, 90) : '',
    members,
  };
}

function hydrate(row) {
  if (!row) return null;
  const author = db.prepare('SELECT * FROM users WHERE id = ?').get(row.author_id);
  const file = row.file_id ? db.prepare('SELECT * FROM files WHERE id = ?').get(row.file_id) : null;
  const reactions = db.prepare('SELECT emoji, user_id FROM reactions WHERE message_id = ?').all(row.id);
  const replyCount = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE reply_to = ? AND deleted = 0').get(row.id).n;
  return {
    id: row.id,
    channelId: row.channel_id,
    author: author ? publicUser(author) : { id: row.author_id, name: 'Removed user', hue: 0, role: 'member' },
    body: row.deleted ? '' : row.body,
    replyTo: row.reply_to,
    forwardedFrom: row.forwarded_from,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deleted: !!row.deleted,
    pinned: !!row.pinned,
    replyCount,
    file: file ? { id: file.id, name: file.name, mime: file.mime, size: file.size, inline: file.mime.startsWith('image/') } : null,
    reactions,
  };
}

// cursor helpers keep pagination stable when timestamps collide
const encodeCursor = (row) => Buffer.from(`${row.created_at}:${row.id}`).toString('base64url');
function decodeCursor(raw) {
  if (!raw) return null;
  try {
    const [ts, id] = Buffer.from(String(raw), 'base64url').toString('utf8').split(':');
    const created = Number(ts);
    if (!Number.isFinite(created) || !id) return null;
    return { created, id };
  } catch {
    return null;
  }
}

// -------------------------------------------------------------- rate limits
const buckets = new Map();
function rateLimited(key, limit, windowMs) {
  const t = now();
  const b = buckets.get(key);
  if (!b || b.reset < t) {
    buckets.set(key, { count: 1, reset: t + windowMs });
    return false;
  }
  b.count += 1;
  return b.count > limit;
}
setInterval(() => {
  const t = now();
  for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k);
}, 60000).unref();

// ---------------------------------------------------------------- static
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, rel);
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) return fail(res, 403, 'forbidden');
  try {
    const data = await fsp.readFile(target);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': MIME[path.extname(target)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'content-length': data.length,
    });
    res.end(data);
  } catch {
    fail(res, 404, 'not found');
  }
}

// ------------------------------------------------------------- discovery
const discovered = new Map();
const instanceId = crypto.randomBytes(8).toString('hex');
const hostName = os.hostname();
let udp = null;

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push({ iface: name, address: i.address });
  }
  return out;
}

function startDiscovery() {
  if (process.env.LATTICE_NO_DISCOVERY === '1') return;
  try {
    udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    udp.on('error', (err) => log('warn', 'discovery socket error', { error: err.message }));
    udp.on('message', (msg) => {
      let info;
      try { info = JSON.parse(msg.toString('utf8')); } catch { return; }
      if (!info || info.kind !== 'lattice' || info.instanceId === instanceId) return;
      discovered.set(info.instanceId, { ...info, seenAt: now() });
    });
    udp.bind(DISCOVERY_PORT, '0.0.0.0', () => {
      try { udp.setBroadcast(true); } catch { /* not permitted on some networks */ }
      const announce = () => {
        const payload = Buffer.from(JSON.stringify({
          kind: 'lattice',
          instanceId,
          workspace: WORKSPACE_NAME,
          port: PORT,
          hostname: hostName,
          platform: `${os.type()} ${os.release()}`,
          addresses: lanAddresses(),
        }));
        const targets = new Set(['255.255.255.255']);
        for (const { address } of lanAddresses()) {
          const parts = address.split('.');
          parts[3] = '255';
          targets.add(parts.join('.'));
        }
        for (const addr of targets) {
          try { udp.send(payload, DISCOVERY_PORT, addr); } catch { /* ignored */ }
        }
      };
      announce();
      setInterval(announce, 15000).unref();
    });
  } catch (err) {
    log('warn', 'discovery unavailable', { error: err.message });
  }
}

function peersPayload() {
  const cutoff = now() - 45000;
  return {
    workspace: WORKSPACE_NAME,
    self: { hostname: hostName, port: PORT, addresses: lanAddresses() },
    peers: [...discovered.values()]
      .filter((p) => p.seenAt > cutoff)
      .map((p) => ({
        instanceId: p.instanceId,
        workspace: p.workspace,
        hostname: p.hostname,
        platform: p.platform,
        port: p.port,
        addresses: p.addresses,
      })),
  };
}

// ------------------------------------------------------------------ routes
async function handler(req, res) {
  const started = process.hrtime.bigint();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;
  const ip = req.socket.remoteAddress || 'local';
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (pathname !== '/api/events') log('debug', 'request', { method: req.method, path: pathname, status: res.statusCode, ms: Math.round(ms) });
  });

  const mutating = req.method !== 'GET' && req.method !== 'HEAD';
  if (mutating && rateLimited(`w:${ip}`, 240, 60000)) return fail(res, 429, 'Too many requests. Wait a moment and try again.');
  if (pathname === '/api/upload' && rateLimited(`u:${ip}`, 40, 60000)) return fail(res, 429, 'Too many uploads. Wait a minute.');

  if (req.method === 'GET' && pathname === '/api/health') {
    return json(res, 200, {
      ok: true,
      version: VERSION,
      workspace: WORKSPACE_NAME,
      users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
      online: onlineIds().size,
      messages: db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
      discovery: Boolean(udp),
      uptimeSeconds: Math.round(process.uptime()),
    });
  }
  if (req.method === 'GET' && pathname === '/api/peers') return json(res, 200, peersPayload());

  if (req.method === 'POST' && pathname === '/api/join') {
    const body = await readJson(req);
    const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!name) return fail(res, 400, 'Enter a display name.');
    const existing = userByToken(bearer(req));
    if (existing) {
      db.prepare('UPDATE users SET name = ?, last_seen = ? WHERE id = ?').run(name, now(), existing.id);
      const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
      publish('user-update', { user: publicUser(updated) });
      return json(res, 200, { token: existing.token, user: publicUser(updated) });
    }
    const id = uid();
    const token = newToken();
    const device = String(body.device || os.hostname()).trim().slice(0, 60) || os.hostname();
    const role = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0 ? 'admin' : 'member';
    db.prepare('INSERT INTO users (id, name, device, hue, role, token, created_at, last_seen) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, name, device, hueFor(name), role, token, now(), now());

    let general = db.prepare("SELECT * FROM channels WHERE kind = 'channel' AND name = 'general'").get();
    if (!general) {
      general = { id: uid() };
      db.prepare('INSERT INTO channels (id, kind, name, topic, created_by, created_at) VALUES (?,?,?,?,?,?)')
        .run(general.id, 'channel', 'general', 'Company-wide announcements and chatter', id, now());
    }
    db.prepare('INSERT OR IGNORE INTO members (channel_id, user_id, joined_at) VALUES (?,?,?)').run(general.id, id, now());
    publish('presence', { users: [...onlineIds()] });
    res.setHeader('set-cookie', `lattice=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
    log('info', 'user joined', { name, role });
    return json(res, 200, { token, user: publicUser({ id, name, device, hue: hueFor(name), role }) });
  }

  const queryToken = url.searchParams.get('t');
  const user = userByToken(bearer(req)) || userByToken(queryToken);
  if (!user && pathname.startsWith('/api/')) return fail(res, 401, 'Sign in to continue.');
  if (user) db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now(), user.id);

  if (req.method === 'GET' && pathname === '/api/bootstrap') {
    const channels = db
      .prepare('SELECT channel_id FROM members WHERE user_id = ?')
      .all(user.id)
      .map((r) => channelView(r.channel_id, user.id))
      .filter(Boolean)
      .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
    return json(res, 200, {
      me: publicUser(user),
      workspace: WORKSPACE_NAME,
      version: VERSION,
      channels,
      discoverable: db
        .prepare("SELECT * FROM channels WHERE kind = 'channel' ORDER BY name")
        .all()
        .filter((c) => !isMember(c.id, user.id))
        .map((c) => ({ id: c.id, name: c.name, topic: c.topic, members: memberIds(c.id).length })),
      users: db.prepare('SELECT * FROM users ORDER BY name').all().map(publicUser),
      online: [...onlineIds()],
      serverTime: now(),
    });
  }

  if (req.method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    if (!streams.has(user.id)) streams.set(user.id, new Set());
    streams.get(user.id).add(res);
    send(res, 'ready', { online: [...onlineIds()], serverTime: now() });
    publish('presence', { users: [...onlineIds()] });

    const keepAlive = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* closed */ }
    }, 20000);
    const close = () => {
      clearInterval(keepAlive);
      streams.get(user.id)?.delete(res);
      if (streams.get(user.id)?.size === 0) {
        streams.delete(user.id);
        publish('presence', { users: [...onlineIds()] });
      }
    };
    req.on('close', close);
    req.on('error', close);
    return;
  }

  // ---- messages -------------------------------------------------------
  const listMatch = pathname.match(/^\/api\/channels\/([^/]+)\/messages$/);
  if (listMatch && req.method === 'GET') {
    const channelId = listMatch[1];
    if (!isMember(channelId, user.id)) return fail(res, 403, 'You are not in this conversation.');
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 60), 1), 200);
    const cursor = decodeCursor(url.searchParams.get('before'));
    const rows = cursor
      ? db
          .prepare(
            `SELECT * FROM messages WHERE channel_id = ?
             AND (created_at < ? OR (created_at = ? AND id < ?))
             ORDER BY created_at DESC, id DESC LIMIT ?`
          )
          .all(channelId, cursor.created, cursor.created, cursor.id, limit + 1)
      : db.prepare('SELECT * FROM messages WHERE channel_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(channelId, limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    return json(res, 200, {
      messages: page.map(hydrate),
      hasMore,
      oldestCursor: page.length ? encodeCursor(page[0]) : null,
    });
  }

  if (listMatch && req.method === 'POST') {
    const channelId = listMatch[1];
    if (!isMember(channelId, user.id)) return fail(res, 403, 'You are not in this conversation.');
    const body = await readJson(req);
    const text = String(body.body || '').slice(0, 8000);
    const fileId = body.fileId || null;
    if (!text.trim() && !fileId) return fail(res, 400, 'Write something or attach a file.');
    if (fileId && !db.prepare('SELECT 1 FROM files WHERE id = ?').get(fileId)) return fail(res, 400, 'Attachment not found.');
    const id = uid();
    const ts = now();
    db.prepare('INSERT INTO messages (id, channel_id, author_id, body, file_id, reply_to, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, channelId, user.id, text, fileId, body.replyTo || null, ts);
    db.prepare('UPDATE members SET last_read = ? WHERE channel_id = ? AND user_id = ?').run(id, channelId, user.id);
    const message = hydrate(db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
    publish('message', { message }, { toUsers: memberIds(channelId) });
    return json(res, 201, { message });
  }

  // ---- single message actions ----------------------------------------
  const actionMatch = pathname.match(/^\/api\/messages\/([^/]+)\/(reactions|pin|edit|delete|forward|thread)$/);
  if (actionMatch) {
    const target = db.prepare('SELECT * FROM messages WHERE id = ?').get(actionMatch[1]);
    if (!target) return fail(res, 404, 'Message not found.');
    if (!isMember(target.channel_id, user.id)) return fail(res, 403, 'You are not in this conversation.');
    const action = actionMatch[2];

    if (action === 'thread' && req.method === 'GET') {
      const replies = db.prepare('SELECT * FROM messages WHERE reply_to = ? ORDER BY created_at, id').all(target.id);
      return json(res, 200, { root: hydrate(target), replies: replies.map(hydrate) });
    }

    if (req.method !== 'POST') return fail(res, 405, 'Method not allowed.');
    const body = await readJson(req).catch(() => ({}));

    if (action === 'reactions') {
      const emoji = String(body.emoji || '').slice(0, 8);
      if (!emoji) return fail(res, 400, 'Pick an emoji.');
      const mine = db.prepare('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').get(target.id, user.id, emoji);
      if (mine) db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(target.id, user.id, emoji);
      else db.prepare('INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?,?,?,?)').run(target.id, user.id, emoji, now());
    } else if (action === 'pin') {
      if (target.channel_id && !isMember(target.channel_id, user.id)) return fail(res, 403, 'Not a member.');
      db.prepare('UPDATE messages SET pinned = ? WHERE id = ?').run(target.pinned ? 0 : 1, target.id);
    } else if (action === 'edit') {
      if (target.author_id !== user.id) return fail(res, 403, 'Only the author can edit a message.');
      const text = String(body.body || '').slice(0, 8000);
      if (!text.trim()) return fail(res, 400, 'Message cannot be empty.');
      db.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?').run(text, now(), target.id);
    } else if (action === 'delete') {
      if (target.author_id !== user.id && !isAdmin(user)) return fail(res, 403, 'Only the author or an admin can delete a message.');
      db.prepare('UPDATE messages SET deleted = 1, body = ? WHERE id = ?').run('', target.id);
    } else if (action === 'forward') {
      const targets = Array.isArray(body.channelIds) ? body.channelIds : [];
      if (!targets.length) return fail(res, 400, 'Choose where to forward it.');
      const created = [];
      for (const channelId of targets.slice(0, 10)) {
        if (!isMember(channelId, user.id)) continue;
        const id = uid();
        db.prepare('INSERT INTO messages (id, channel_id, author_id, body, file_id, forwarded_from, created_at) VALUES (?,?,?,?,?,?,?)')
          .run(id, channelId, user.id, target.deleted ? '' : target.body, target.file_id || null, target.author_id, now());
        const message = hydrate(db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
        publish('message', { message }, { toUsers: memberIds(channelId) });
        created.push(message);
      }
      if (!created.length) return fail(res, 403, 'You are not a member of those conversations.');
      return json(res, 201, { forwarded: created.length });
    }

    const message = hydrate(db.prepare('SELECT * FROM messages WHERE id = ?').get(target.id));
    publish('message-update', { message }, { toUsers: memberIds(target.channel_id) });
    return json(res, 200, { message });
  }

  if (req.method === 'POST' && pathname === '/api/read') {
    const body = await readJson(req);
    if (!body.channelId || !body.messageId) return fail(res, 400, 'channelId and messageId are required.');
    if (!isMember(body.channelId, user.id)) return fail(res, 403, 'Not a member.');
    db.prepare('UPDATE members SET last_read = ? WHERE channel_id = ? AND user_id = ?').run(body.messageId, body.channelId, user.id);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/read-all') {
    const rows = db.prepare('SELECT channel_id FROM members WHERE user_id = ?').all(user.id);
    for (const { channel_id } of rows) {
      const last = db.prepare('SELECT id FROM messages WHERE channel_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(channel_id);
      if (last) db.prepare('UPDATE members SET last_read = ? WHERE channel_id = ? AND user_id = ?').run(last.id, channel_id, user.id);
    }
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/typing') {
    const body = await readJson(req);
    if (!body.channelId) return fail(res, 400, 'channelId required.');
    publish('typing', { channelId: body.channelId, user: publicUser(user) }, {
      toUsers: memberIds(body.channelId).filter((id) => id !== user.id),
    });
    return json(res, 200, { ok: true });
  }

  // ---- channels -------------------------------------------------------
  if (req.method === 'POST' && pathname === '/api/channels') {
    const body = await readJson(req);
    const kind = body.kind === 'dm' ? 'dm' : 'channel';
    const invitees = Array.isArray(body.memberIds) ? body.memberIds.filter((x) => x !== user.id) : [];

    if (kind === 'dm') {
      if (invitees.length !== 1) return fail(res, 400, 'A direct message needs exactly one other person.');
      if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(invitees[0])) return fail(res, 404, 'That person no longer exists.');
      const existing = db
        .prepare(
          `SELECT c.id FROM channels c
            WHERE c.kind = 'dm'
              AND (SELECT COUNT(*) FROM members m WHERE m.channel_id = c.id) = 2
              AND EXISTS (SELECT 1 FROM members m WHERE m.channel_id = c.id AND m.user_id = ?)
              AND EXISTS (SELECT 1 FROM members m WHERE m.channel_id = c.id AND m.user_id = ?)`
        )
        .get(user.id, invitees[0]);
      if (existing) return json(res, 200, { channel: channelView(existing.id, user.id) });
      const id = uid();
      db.prepare('INSERT INTO channels (id, kind, created_by, created_at) VALUES (?,?,?,?)').run(id, 'dm', user.id, now());
      for (const m of [user.id, invitees[0]]) {
        db.prepare('INSERT INTO members (channel_id, user_id, joined_at) VALUES (?,?,?)').run(id, m, now());
      }
      publish('channel', { channel: channelView(id, invitees[0]) }, { toUsers: [invitees[0]] });
      return json(res, 201, { channel: channelView(id, user.id) });
    }

    const name = String(body.name || '').trim().replace(/^#/, '').replace(/\s+/g, '-').toLowerCase().slice(0, 40);
    if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(name)) return fail(res, 400, 'Use letters, numbers, dots, dashes or underscores.');
    if (db.prepare("SELECT 1 FROM channels WHERE kind = 'channel' AND name = ?").get(name)) return fail(res, 409, 'That channel already exists.');
    const id = uid();
    db.prepare('INSERT INTO channels (id, kind, name, topic, created_by, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, 'channel', name, String(body.topic || '').slice(0, 140), user.id, now());
    for (const m of new Set([user.id, ...invitees])) {
      db.prepare('INSERT OR IGNORE INTO members (channel_id, user_id, joined_at) VALUES (?,?,?)').run(id, m, now());
    }
    for (const m of memberIds(id)) publish('channel', { channel: channelView(id, m) }, { toUsers: [m] });
    return json(res, 201, { channel: channelView(id, user.id) });
  }

  const chanMatch = pathname.match(/^\/api\/channels\/([^/]+)(?:\/(join|leave))?$/);
  if (chanMatch) {
    const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(chanMatch[1]);
    if (!ch) return fail(res, 404, 'Channel not found.');
    const verb = chanMatch[2];
    if (verb === 'join' && req.method === 'POST') {
      if (ch.kind !== 'channel') return fail(res, 400, 'You cannot join a direct message.');
      db.prepare('INSERT OR IGNORE INTO members (channel_id, user_id, joined_at) VALUES (?,?,?)').run(ch.id, user.id, now());
      for (const m of memberIds(ch.id)) publish('channel', { channel: channelView(ch.id, m) }, { toUsers: [m] });
      return json(res, 200, { channel: channelView(ch.id, user.id) });
    }
    if (verb === 'leave' && req.method === 'POST') {
      if (ch.kind === 'channel' && ch.name === 'general') return fail(res, 400, 'You cannot leave #general.');
      db.prepare('DELETE FROM members WHERE channel_id = ? AND user_id = ?').run(ch.id, user.id);
      publish('channel-removed', { channelId: ch.id }, { toUsers: [user.id] });
      return json(res, 200, { ok: true });
    }
    if (!verb && req.method === 'PATCH') {
      if (!isMember(ch.id, user.id)) return fail(res, 403, 'Not a member.');
      if (ch.kind === 'dm') return fail(res, 400, 'Direct messages have no settings.');
      const body = await readJson(req);
      const topic = body.topic !== undefined ? String(body.topic).slice(0, 140) : ch.topic;
      const name = body.name !== undefined && ch.name !== 'general'
        ? String(body.name).trim().replace(/^#/, '').toLowerCase().slice(0, 40)
        : ch.name;
      db.prepare('UPDATE channels SET name = ?, topic = ? WHERE id = ?').run(name, topic, ch.id);
      for (const m of memberIds(ch.id)) publish('channel', { channel: channelView(ch.id, m) }, { toUsers: [m] });
      return json(res, 200, { channel: channelView(ch.id, user.id) });
    }
    if (!verb && req.method === 'DELETE') {
      if (!isAdmin(user)) return fail(res, 403, 'Only an admin can delete a channel.');
      if (ch.name === 'general') return fail(res, 400, 'You cannot delete #general.');
      const ids = db.prepare('SELECT id FROM messages WHERE channel_id = ?').all(ch.id).map((r) => r.id);
      for (const id of ids) db.prepare('DELETE FROM reactions WHERE message_id = ?').run(id);
      db.prepare('DELETE FROM messages WHERE channel_id = ?').run(ch.id);
      db.prepare('DELETE FROM members WHERE channel_id = ?').run(ch.id);
      db.prepare('DELETE FROM channels WHERE id = ?').run(ch.id);
      for (const m of memberIds(ch.id)) publish('channel-removed', { channelId: ch.id }, { toUsers: [m] });
      publish('channel-removed', { channelId: ch.id });
      return json(res, 200, { ok: true });
    }
  }

  // ---- uploads --------------------------------------------------------
  if (req.method === 'POST' && pathname === '/api/upload') {
    const rawName = req.headers['x-file-name'];
    if (!rawName) return fail(res, 400, 'Missing x-file-name header.');
    const name = decodeURIComponent(String(rawName)).replace(/[\u0000-\u001f]/g, '').slice(0, 200) || 'file';
    const mime = String(req.headers['content-type'] || 'application/octet-stream').slice(0, 120);
    const id = uid();
    const tmp = path.join(FILES_DIR, `${id}.part`);
    let size = 0;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(tmp);
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_UPLOAD) throw Object.assign(new Error('File is larger than the server allows.'), { status: 413 });
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      }
    } catch (err) {
      out.destroy();
      await fsp.rm(tmp, { force: true });
      return fail(res, err.status || 500, err.message);
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    if (size === 0) {
      await fsp.rm(tmp, { force: true });
      return fail(res, 400, 'That file is empty.');
    }
    const sha256 = hash.digest('hex');
    const known = db.prepare('SELECT * FROM files WHERE sha256 = ? LIMIT 1').get(sha256);
    let diskPath;
    if (known && fs.existsSync(known.disk_path)) {
      diskPath = known.disk_path; // identical bytes already stored: keep one copy on disk
      await fsp.rm(tmp, { force: true });
    } else {
      diskPath = path.join(FILES_DIR, id);
      await fsp.rename(tmp, diskPath);
    }
    db.prepare('INSERT INTO files (id, name, mime, size, disk_path, sha256, uploader_id, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, name, mime, size, diskPath, sha256, user.id, now());
    return json(res, 201, { file: { id, name, mime, size, inline: mime.startsWith('image/') } });
  }

  const fileMatch = pathname.match(/^\/api\/files\/([^/]+)$/);
  if (fileMatch && (req.method === 'GET' || req.method === 'HEAD')) {
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(fileMatch[1]);
    if (!file || !fs.existsSync(file.disk_path)) return fail(res, 404, 'File not found.');
    const stat = fs.statSync(file.disk_path);
    const inline = url.searchParams.get('inline') === '1' && file.mime.startsWith('image/');
    const safe = file.name.replace(/["\\\r\n]/g, '');
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': file.mime || 'application/octet-stream',
      'content-length': stat.size,
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file.disk_path).pipe(res);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/search') {
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 120);
    const scope = url.searchParams.get('channel');
    if (!q) return json(res, 200, { results: [] });
    const rows = db
      .prepare(
        `SELECT m.* FROM messages m
           JOIN members mm ON mm.channel_id = m.channel_id AND mm.user_id = ?
          WHERE m.deleted = 0 AND m.body LIKE ?
          ${scope ? 'AND m.channel_id = ?' : ''}
          ORDER BY m.created_at DESC, m.id DESC LIMIT 60`
      )
      .all(...(scope ? [user.id, `%${q}%`, scope] : [user.id, `%${q}%`]));
    return json(res, 200, {
      results: rows.filter((r) => isMember(r.channel_id, user.id)).map((r) => ({ ...hydrate(r), channel: channelView(r.channel_id, user.id) })),
    });
  }

  // ---- admin ----------------------------------------------------------
  if (req.method === 'GET' && pathname === '/api/admin/overview') {
    if (!isAdmin(user)) return fail(res, 403, 'Admin only.');
    const files = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes FROM files').get();
    return json(res, 200, {
      workspace: WORKSPACE_NAME,
      version: VERSION,
      dataDir: DATA_DIR,
      counts: {
        users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
        channels: db.prepare("SELECT COUNT(*) AS n FROM channels WHERE kind = 'channel'").get().n,
        directMessages: db.prepare("SELECT COUNT(*) AS n FROM channels WHERE kind = 'dm'").get().n,
        messages: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE deleted = 0').get().n,
        files: files.n,
        fileBytes: files.bytes,
      },
      online: [...onlineIds()],
    });
  }

  if (req.method === 'GET' && pathname === '/api/admin/export') {
    if (!isAdmin(user)) return fail(res, 403, 'Admin only.');
    const dump = {
      exportedAt: new Date().toISOString(),
      workspace: WORKSPACE_NAME,
      version: VERSION,
      users: db.prepare('SELECT id, name, device, hue, role, created_at, last_seen FROM users').all(),
      channels: db.prepare('SELECT * FROM channels').all(),
      members: db.prepare('SELECT * FROM members').all(),
      messages: db.prepare('SELECT * FROM messages').all(),
      reactions: db.prepare('SELECT * FROM reactions').all(),
      files: db.prepare('SELECT id, name, mime, size, sha256, uploader_id, created_at FROM files').all(),
    };
    const body = JSON.stringify(dump, null, 2);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="lattice-export-${new Date().toISOString().slice(0, 10)}.json"`,
      'content-length': Buffer.byteLength(body),
    });
    return res.end(body);
  }

  if (req.method === 'POST' && pathname === '/api/users/role') {
    if (!isAdmin(user)) return fail(res, 403, 'Admin only.');
    const body = await readJson(req);
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(String(body.userId || ''));
    if (!target) return fail(res, 404, 'User not found.');
    const role = body.role === 'admin' ? 'admin' : 'member';
    if (target.id === user.id && role === 'member') return fail(res, 400, 'You cannot remove your own admin role.');
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, target.id);
    publish('user-update', { user: publicUser({ ...target, role }) });
    return json(res, 200, { user: publicUser({ ...target, role }) });
  }

  if (pathname.startsWith('/api/')) return fail(res, 404, 'Unknown endpoint.');
  return serveStatic(res, pathname);
}

const server = http.createServer((req, res) => {
  handler(req, res).catch((err) => {
    log('error', 'request failed', { error: err.message, path: req.url });
    if (!res.headersSent) fail(res, err.status || 500, err.message || 'Server error.');
    else res.end();
  });
});

function shutdown(signal) {
  log('info', 'shutting down', { signal });
  for (const set of streams.values()) for (const res of set) { try { res.end(); } catch { /* closed */ } }
  streams.clear();
  server.close(() => {
    try { db.close(); } catch { /* already closed */ }
    if (udp) try { udp.close(); } catch { /* closed */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, '0.0.0.0', () => {
  startDiscovery();
  const urls = lanAddresses().map((a) => `http://${a.address}:${PORT}`).join('  ');
  log('info', 'listening', { port: PORT, dataDir: DATA_DIR, urls: urls || `http://localhost:${PORT}` });
  console.log('');
  console.log(`  Lattice ${VERSION} — ${WORKSPACE_NAME}`);
  console.log(`  Local:    http://localhost:${PORT}`);
  console.log(`  Network:  ${urls || 'no LAN address detected'}`);
  console.log(`  Data:     ${DATA_DIR}`);
  console.log('');
});
