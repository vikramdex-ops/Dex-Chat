// Tools (mini-apps) that run inside conversations: a calculator with a shared tape, a unit
// converter, a drawing viewer, a table of a CSV, a punch list. An administrator uploads a bundle
// (a .zip or one .html file), reads what it asks for and approves or rejects it; members add
// approved tools to a conversation. Each tool added keeps its own shared state here (JSON, up to
// 64 KB, last writer wins with a version number), sent to everyone in the conversation.
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ulid } from '@dex/core';
import type { Message, MiniAppInfo, MiniAppPermission, MiniAppState, MiniAppView, Ops, PublicUser } from '@dex/core';
import { MINIAPP_PERMISSIONS, MINIAPP_STATE_MAX } from '@dex/core';
import { MINIAPP_MAX_HTML, miniAppCsp, miniAppDocument, normaliseHost } from '@dex/core/miniapp';
import type { FileStore } from './files.ts';
import type { Messaging, MsgRow } from './messaging.ts';
import type { Store } from './store.ts';
import { ZipError, readZip } from './zip.ts';
import { BUILTIN_MINIAPPS } from './miniapps/index.ts';

export class MiniAppError extends Error {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS miniapps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  description TEXT NOT NULL,
  html TEXT NOT NULL,
  permissions TEXT NOT NULL,
  requested_hosts TEXT NOT NULL DEFAULT '[]',
  hosts TEXT NOT NULL DEFAULT '[]',
  height INTEGER NOT NULL,
  status TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  builtin INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  uploaded_by TEXT,
  uploaded_at INTEGER NOT NULL,
  reviewed_by TEXT,
  reviewed_at INTEGER,
  note TEXT
);
CREATE TABLE IF NOT EXISTS miniapp_instances (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  conv_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  request_key TEXT,
  created_at INTEGER NOT NULL,
  state TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at INTEGER,
  UNIQUE (created_by, request_key)
);
CREATE INDEX IF NOT EXISTS idx_miniapp_instances_app ON miniapp_instances(app_id);
`;

/** A bundle as uploaded: up to 2 MB packed, 4 MB unpacked, 64 files. */
const MAX_UPLOAD = 2 * 1024 * 1024;
const ZIP_LIMITS = { maxEntries: 64, maxTotal: 4 * 1024 * 1024, maxEntry: 3 * 1024 * 1024 };
/** Writes to one tool's state, per person: at most this many in 5 seconds. */
const WRITE_BURST = 25;

export interface Manifest {
  id: string;
  name: string;
  version: string;
  description: string;
  permissions: MiniAppPermission[];
  hosts: string[];
  height: number;
}

interface AppRow {
  id: string; name: string; version: string; description: string; html: string; permissions: string; requested_hosts: string; hosts: string;
  height: number; status: MiniAppInfo['status']; enabled: number; builtin: number; size: number; sha256: string; uploaded_by: string | null;
  uploaded_at: number; reviewed_by: string | null; reviewed_at: number | null; note: string | null;
}
interface InstanceRow { id: string; app_id: string; conv_id: string; created_by: string; request_key: string | null; created_at: number; state: string | null; version: number; updated_by: string | null; updated_at: number | null }

const list = <T>(raw: string): T[] => { try { const v = JSON.parse(raw) as unknown; return Array.isArray(v) ? v as T[] : []; } catch { return []; } };

/** Check a manifest (manifest.json in a zip, or <script type="application/dex-manifest+json"> in a page). */
export function checkManifest(raw: unknown): Manifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new MiniAppError('The manifest must be a JSON object.');
  const r = raw as Record<string, unknown>;
  const s = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');
  const id = s(r.id, 40).toLowerCase();
  if (!/^[a-z][a-z0-9-]{2,39}$/.test(id)) throw new MiniAppError('The manifest "id" uses lower-case letters, digits and dashes (3 to 40).');
  if (id.startsWith('dex-')) throw new MiniAppError('Ids starting with "dex-" belong to the tools that come with Dexterity Connect.');
  const name = s(r.name, 40);
  if (!name) throw new MiniAppError('Give the tool a "name".');
  const version = s(r.version, 20) || '1.0.0';
  if (!/^[0-9A-Za-z.+-]{1,20}$/.test(version)) throw new MiniAppError('"version" is like 1.2.0.');
  const perms = Array.isArray(r.permissions) ? r.permissions.map(String) : [];
  const unknown = perms.filter((p) => !MINIAPP_PERMISSIONS.includes(p as MiniAppPermission));
  if (unknown.length) throw new MiniAppError(`Unknown permission: ${unknown.join(', ')}. Use ${MINIAPP_PERMISSIONS.join(', ')}.`);
  const hosts = (Array.isArray(r.hosts) ? r.hosts : []).slice(0, 10).map((h) => {
    const n = typeof h === 'string' ? normaliseHost(h) : null;
    if (!n) throw new MiniAppError(`"${String(h)}" is not a host: write it like https://plotter.office.local.`);
    return n;
  });
  const permissions = [...new Set([...perms as MiniAppPermission[], ...(hosts.length ? ['network' as const] : [])])].filter((p) => p !== 'network' || hosts.length);
  const height = typeof r.height === 'number' && Number.isFinite(r.height) ? Math.max(120, Math.min(900, Math.round(r.height))) : 320;
  return { id, name, version, description: s(r.description, 300), permissions, hosts: [...new Set(hosts)], height };
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm',
};
const isRemote = (u: string) => /^(https?:)?\/\//i.test(u.trim()) || /^(javascript|data|blob|file):/i.test(u.trim());

/** Join a path in the bundle relative to the page that refers to it. */
function resolvePath(base: string, rel: string): string {
  const parts = (base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : '').concat(rel.split(/[?#]/)[0]).split('/');
  const out: string[] = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
  return out.join('/');
}

/** One self-contained page: scripts, styles, images and fonts from the zip written into it. */
function inline(entry: string, files: Map<string, Buffer>): string {
  const get = (rel: string): Buffer => {
    if (isRemote(rel)) throw new MiniAppError(`The page loads "${rel}" from elsewhere: a bundle carries its own scripts, styles and images.`);
    const f = files.get(resolvePath(entry, rel));
    if (!f) throw new MiniAppError(`"${rel}" is not in the bundle.`);
    return f;
  };
  const dataUri = (rel: string, from = entry): string => {
    const path = resolvePath(from, rel);
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    const mime = MIME[ext];
    const f = files.get(path);
    if (!mime || !f) throw new MiniAppError(`"${rel}" is not in the bundle (or is not an image, font or sound).`);
    return `data:${mime};base64,${f.toString('base64')}`;
  };
  const css = (text: string, from: string) => text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, _q: string, u: string) => (u.startsWith('data:') ? m : (() => {
    if (isRemote(u)) throw new MiniAppError(`A style loads "${u}" from elsewhere: put it in the bundle.`);
    return `url("${dataUri(u, from)}")`;
  })()));
  const page = files.get(entry);
  if (!page) throw new MiniAppError(`The bundle has no ${entry}.`);
  let html = page.toString('utf8');
  html = html.replace(/<script\b([^>]*?)\bsrc\s*=\s*(["'])([^"']+)\2([^>]*)>\s*<\/script\s*>/gi, (_m, a: string, _q: string, src: string, b: string) =>
    `<script${a}${b}>${get(src).toString('utf8').replace(/<\/script/gi, '<\\/script')}</script>`);
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    const href = /\bhref\s*=\s*(["'])([^"']+)\1/i.exec(tag)?.[2];
    if (!href) return tag;
    if (/\brel\s*=\s*(["']?)stylesheet\1/i.test(tag)) return `<style>${css(get(href).toString('utf8'), resolvePath(entry, href)).replace(/<\/style/gi, '<\\/style')}</style>`;
    if (isRemote(href)) throw new MiniAppError(`The page links to "${href}": a bundle carries everything it needs.`);
    return tag.replace(href, dataUri(href));
  });
  html = html.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (_m, a: string, body: string) => `<style${a}>${css(body, entry)}</style>`);
  // images and media in the markup (not inside scripts or styles, which may say src= for their own reasons)
  return html.split(/(<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>)/i).map((seg, i) => (i % 2 ? seg : seg.replace(/<[a-z][^>]*>/gi, (tag) =>
    tag.replace(/\s(src|poster)\s*=\s*(["'])([^"']+)\2/gi, (m, attr: string, q: string, u: string) => {
      if (u.startsWith('data:') || u.startsWith('#')) return m;
      if (isRemote(u)) throw new MiniAppError(`The page loads "${u}" from elsewhere: put it in the bundle.`);
      return ` ${attr}=${q}${dataUri(u)}${q}`;
    })))).join('');
}

const MANIFEST_RE = /<script\b[^>]*type\s*=\s*["']application\/dex-manifest\+json["'][^>]*>([\s\S]*?)<\/script>/i;

/** A bundle as uploaded (a zip, or one HTML page) into its manifest and one page. */
export function parseBundle(fileName: string, data: Buffer): { manifest: Manifest; html: string } {
  if (data.length > MAX_UPLOAD) throw new MiniAppError('A bundle can be up to 2 MB.');
  let manifest: Manifest;
  let html: string;
  if (data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) || /\.zip$/i.test(fileName)) {
    let files: Map<string, Buffer>;
    try { files = readZip(data, ZIP_LIMITS); } catch (err) { throw new MiniAppError(err instanceof ZipError ? err.message : 'The zip file could not be read.'); }
    // a zip made by "compress the folder" has everything under one top folder
    const names = [...files.keys()];
    const top = names.length && names.every((n) => n.includes('/') && n.split('/')[0] === names[0].split('/')[0]) ? `${names[0].split('/')[0]}/` : '';
    if (top) files = new Map([...files].map(([k, v]) => [k.slice(top.length), v]));
    const mf = files.get('manifest.json');
    if (!mf) throw new MiniAppError('The zip needs a manifest.json next to index.html.');
    let raw: unknown;
    try { raw = JSON.parse(mf.toString('utf8')); } catch { throw new MiniAppError('manifest.json is not valid JSON.'); }
    manifest = checkManifest(raw);
    const entry = typeof (raw as { entry?: unknown }).entry === 'string' ? resolvePath('', (raw as { entry: string }).entry) : 'index.html';
    if (!files.has(entry)) throw new MiniAppError(`The zip has no ${entry}.`);
    html = inline(entry, new Map([...files].map(([k, v]) => [k, v])));
  } else {
    html = data.toString('utf8');
    const m = MANIFEST_RE.exec(html);
    if (!m) throw new MiniAppError('Describe the tool in the page: <script type="application/dex-manifest+json">{"id": …, "name": …, "permissions": […]}</script>.');
    let raw: unknown;
    try { raw = JSON.parse(m[1]); } catch { throw new MiniAppError('The manifest in the page is not valid JSON.'); }
    manifest = checkManifest(raw);
    html = inline('index.html', new Map([['index.html', Buffer.from(html)]]));
  }
  if (Buffer.byteLength(html) > MINIAPP_MAX_HTML) throw new MiniAppError('The page is larger than 3 MB once everything is inlined.');
  if (!/<(body|div|main|canvas|svg|script)\b/i.test(html)) throw new MiniAppError('The page has nothing to show.');
  return { manifest, html };
}

export interface MiniAppsDeps {
  store: Store;
  messaging: Messaging;
  files: FileStore;
  deliver: (userIds: string[], name: string, data: (userId: string) => unknown) => void;
  broadcast: (name: string, data: unknown) => void;
}

export class MiniApps {
  private readonly db: DatabaseSync;
  private readonly d: MiniAppsDeps;
  private readonly writes = new Map<string, number[]>();

  constructor(deps: MiniAppsDeps) {
    this.d = deps;
    this.db = deps.store.db;
    this.db.exec(SCHEMA);
    this.seed();
  }

  /** The tools that come with the app: approved, and refreshed when a new version ships. */
  private seed(): void {
    for (const b of BUILTIN_MINIAPPS) {
      const sha = crypto.createHash('sha256').update(b.html).digest('hex');
      const cur = this.app(b.manifest.id);
      if (cur && cur.sha256 === sha) continue;
      this.db.prepare(`INSERT INTO miniapps (id, name, version, description, html, permissions, requested_hosts, hosts, height, status, enabled, builtin, size, sha256, uploaded_by, uploaded_at, reviewed_by, reviewed_at, note)
        VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', ?, 'approved', 1, 1, ?, ?, NULL, ?, NULL, ?, NULL)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, version = excluded.version, description = excluded.description, html = excluded.html,
          permissions = excluded.permissions, height = excluded.height, size = excluded.size, sha256 = excluded.sha256, uploaded_at = excluded.uploaded_at, reviewed_at = excluded.reviewed_at`)
        .run(b.manifest.id, b.manifest.name, b.manifest.version, b.manifest.description, b.html, JSON.stringify(b.manifest.permissions), b.manifest.height,
          Buffer.byteLength(b.html), sha, Date.now(), Date.now());
    }
  }

  private app(id: string): AppRow | undefined {
    return this.db.prepare('SELECT * FROM miniapps WHERE id = ?').get(id) as AppRow | undefined;
  }

  private info(r: AppRow): MiniAppInfo {
    return {
      id: r.id, name: r.name, version: r.version, description: r.description, permissions: list<MiniAppPermission>(r.permissions),
      requestedHosts: list<string>(r.requested_hosts), hosts: list<string>(r.hosts), status: r.status, enabled: !!r.enabled, builtin: !!r.builtin,
      height: r.height, size: r.size, sha256: r.sha256, uploadedBy: r.uploaded_by, uploadedAt: r.uploaded_at, reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at, note: r.note,
    };
  }

  private usable(r: AppRow | undefined): boolean { return !!r && r.status === 'approved' && !!r.enabled; }

  private instance(id: unknown): InstanceRow | undefined {
    return typeof id === 'string' ? this.db.prepare('SELECT * FROM miniapp_instances WHERE id = ?').get(id) as InstanceRow | undefined : undefined;
  }

  /** The tool in a message (called for every message shown; only tool messages have one). */
  view(r: MsgRow): Pick<Message, 'miniapp'> {
    if (!r.client_id || !r.client_id.startsWith('tool-')) return {};
    const inst = this.instance(r.client_id.slice(5));
    if (!inst || inst.conv_id !== r.conv_id || inst.created_by !== r.author_id) return {};
    const app = this.app(inst.app_id);
    const view: MiniAppView = {
      instanceId: inst.id, appId: inst.app_id, name: app?.name ?? 'Tool', version: app?.version ?? '', description: app?.description ?? '',
      height: app?.height ?? 320, permissions: app ? list<MiniAppPermission>(app.permissions) : [], hosts: app ? list<string>(app.hosts) : [],
      available: this.usable(app), addedBy: inst.created_by, stateVersion: inst.version,
    };
    return { miniapp: view };
  }

  private stateOf(inst: InstanceRow): MiniAppState {
    let state: unknown = null;
    if (inst.state) { try { state = JSON.parse(inst.state); } catch { state = null; } }
    return { instanceId: inst.id, convId: inst.conv_id, state, version: inst.version, updatedBy: inst.updated_by, updatedAt: inst.updated_at };
  }

  /** The tool in a conversation the person is in, still approved and switched on. */
  private reach(me: PublicUser, instanceId: unknown, need?: MiniAppPermission): { inst: InstanceRow; app: AppRow } {
    const inst = this.instance(instanceId);
    if (!inst || !this.d.messaging.isMember(inst.conv_id, me.id)) throw new MiniAppError('That tool was not found.');
    const app = this.app(inst.app_id);
    if (!app || !this.usable(app)) throw new MiniAppError(app?.status === 'pending' ? 'This tool is waiting for an administrator to review it.' : 'An administrator switched this tool off.');
    if (need && !list<MiniAppPermission>(app.permissions).includes(need)) throw new MiniAppError(`${app.name} was not approved to use ${need}.`);
    return { inst, app };
  }

  /** Messages that hold a tool, newest first, so their cards can be shown again after a change. */
  private refreshApp(appId: string): void {
    const rows = this.db.prepare(`SELECT m.id FROM messages m JOIN miniapp_instances i ON m.client_id = 'tool-' || i.id AND m.author_id = i.created_by
      WHERE i.app_id = ? AND m.deleted = 0 ORDER BY m.id DESC LIMIT 200`).all(appId) as Array<{ id: string }>;
    for (const r of rows) this.d.messaging.refresh(r.id);
  }

  handle(op: string, me: PublicUser, d: Record<string, unknown>): unknown {
    const isAdmin = me.role === 'owner' || me.role === 'admin';
    const admin = () => { if (!isAdmin) throw new MiniAppError('Only administrators can do that.'); };
    switch (op) {
      case 'miniapp.list':
        return (this.db.prepare("SELECT * FROM miniapps WHERE status = 'approved' AND enabled = 1 ORDER BY builtin DESC, name").all() as unknown as AppRow[]).map((r) => this.info(r)) satisfies Ops['miniapp.list']['res'];

      case 'miniapp.add': {
        if (me.role === 'guest' || me.role === 'bot') throw new MiniAppError('Only members of the office can add tools.');
        const conv = this.d.messaging.memberConv(String(d.convId ?? ''), me.id);
        const app = this.app(String(d.appId ?? ''));
        if (!app || !this.usable(app)) throw new MiniAppError('That tool is not available.');
        const key = typeof d.clientId === 'string' ? d.clientId.slice(0, 64) : null;
        const prior = key ? this.db.prepare('SELECT * FROM miniapp_instances WHERE created_by = ? AND request_key = ?').get(me.id, key) as InstanceRow | undefined : undefined;
        const id = prior?.id ?? ulid();
        if (!prior) {
          this.db.prepare('INSERT INTO miniapp_instances (id, app_id, conv_id, created_by, request_key, created_at, version) VALUES (?, ?, ?, ?, ?, ?, 0)')
            .run(id, app.id, conv.id, me.id, key, Date.now());
          this.d.store.audit(me.id, 'miniapp.added', app.id, { conv: conv.id, instance: id });
        }
        return this.d.messaging.sendAs(me, conv, `Added a tool: ${app.name}`, undefined, [], `tool-${id}`, {}) satisfies Ops['miniapp.add']['res'];
      }

      case 'miniapp.bundle': {
        const { app } = this.reach(me, d.instanceId);
        const csp = miniAppCsp(list<string>(app.hosts));
        return { html: miniAppDocument(app.html, csp), csp, appId: app.id, version: app.version } satisfies Ops['miniapp.bundle']['res'];
      }

      case 'miniapp.state.get': {
        const { inst } = this.reach(me, d.instanceId, 'state');
        return this.stateOf(inst) satisfies Ops['miniapp.state.get']['res'];
      }

      case 'miniapp.state.set': {
        const { inst } = this.reach(me, d.instanceId, 'state');
        let raw: string;
        try { raw = JSON.stringify(d.state ?? null); } catch { throw new MiniAppError('The state must be JSON.'); }
        if (Buffer.byteLength(raw) > MINIAPP_STATE_MAX) throw new MiniAppError(`A tool's shared state can be up to ${MINIAPP_STATE_MAX / 1024} KB.`);
        const k = `${inst.id}:${me.id}`;
        const now = Date.now();
        const recent = (this.writes.get(k) ?? []).filter((t) => t > now - 5000);
        if (recent.length >= WRITE_BURST) throw new MiniAppError('Too many changes at once. Wait a moment.');
        recent.push(now);
        this.writes.set(k, recent);
        const base = typeof d.baseVersion === 'number' ? d.baseVersion : null;
        const conflict = base !== null && base !== inst.version;
        this.db.prepare('UPDATE miniapp_instances SET state = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?').run(raw, me.id, now, inst.id);
        const next = this.stateOf(this.instance(inst.id)!);
        this.d.deliver(this.d.messaging.members(inst.conv_id), 'miniapp.state', () => next);
        return { ...next, conflict } satisfies Ops['miniapp.state.set']['res'];
      }

      case 'admin.miniapps.list':
        admin();
        return (this.db.prepare('SELECT * FROM miniapps ORDER BY builtin DESC, status, name').all() as unknown as AppRow[]).map((r) => this.info(r)) satisfies Ops['admin.miniapps.list']['res'];

      case 'admin.miniapps.source': {
        admin();
        const app = this.app(String(d.id ?? ''));
        if (!app) throw new MiniAppError('Tool not found.');
        return { html: app.html } satisfies Ops['admin.miniapps.source']['res'];
      }

      case 'admin.miniapps.upload': {
        admin();
        const f = typeof d.fileId === 'string' ? this.d.files.info(d.fileId) : null;
        if (!f || f.uploaderId !== me.id) throw new MiniAppError('Upload the bundle again.');
        const data = this.d.files.read(f.id, MAX_UPLOAD);
        if (!data) throw new MiniAppError('A bundle can be up to 2 MB.');
        const { manifest, html } = parseBundle(f.name, data);
        const cur = this.app(manifest.id);
        if (cur?.builtin) throw new MiniAppError('That id belongs to a tool that comes with Dexterity Connect.');
        const sha = crypto.createHash('sha256').update(html).digest('hex');
        // a new version is reviewed again before anyone runs it
        this.db.prepare(`INSERT INTO miniapps (id, name, version, description, html, permissions, requested_hosts, hosts, height, status, enabled, builtin, size, sha256, uploaded_by, uploaded_at, reviewed_by, reviewed_at, note)
          VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, 'pending', ?, 0, ?, ?, ?, ?, NULL, NULL, NULL)
          ON CONFLICT(id) DO UPDATE SET name = excluded.name, version = excluded.version, description = excluded.description, html = excluded.html, permissions = excluded.permissions,
            requested_hosts = excluded.requested_hosts, hosts = '[]', height = excluded.height, status = 'pending', size = excluded.size, sha256 = excluded.sha256,
            uploaded_by = excluded.uploaded_by, uploaded_at = excluded.uploaded_at, reviewed_by = NULL, reviewed_at = NULL, note = NULL`)
          .run(manifest.id, manifest.name, manifest.version, manifest.description, html, JSON.stringify(manifest.permissions), JSON.stringify(manifest.hosts),
            manifest.height, cur ? cur.enabled : 1, Buffer.byteLength(html), sha, me.id, Date.now());
        this.d.store.audit(me.id, 'miniapp.uploaded', manifest.id, { name: manifest.name, version: manifest.version, permissions: manifest.permissions, hosts: manifest.hosts, sha256: sha, file: f.name });
        this.d.broadcast('miniapp.catalog', { changed: true });
        if (cur) this.refreshApp(manifest.id);
        return this.info(this.app(manifest.id)!) satisfies Ops['admin.miniapps.upload']['res'];
      }

      case 'admin.miniapps.review': {
        admin();
        const app = this.app(String(d.id ?? ''));
        if (!app) throw new MiniAppError('Tool not found.');
        if (app.builtin) throw new MiniAppError('Tools that come with Dexterity Connect are approved already; switch them off if you do not want them.');
        const approve = d.approve === true;
        const requested = list<string>(app.requested_hosts);
        const granted = approve ? (Array.isArray(d.hosts) ? d.hosts.map((h) => normaliseHost(String(h))).filter((h): h is string => !!h && requested.includes(h)) : requested) : [];
        const note = typeof d.note === 'string' ? d.note.trim().slice(0, 300) || null : null;
        this.db.prepare('UPDATE miniapps SET status = ?, hosts = ?, reviewed_by = ?, reviewed_at = ?, note = ? WHERE id = ?')
          .run(approve ? 'approved' : 'rejected', JSON.stringify([...new Set(granted)]), me.id, Date.now(), note, app.id);
        this.d.store.audit(me.id, approve ? 'miniapp.approved' : 'miniapp.rejected', app.id, { name: app.name, version: app.version, permissions: list(app.permissions), hosts: granted, note, sha256: app.sha256 });
        this.d.broadcast('miniapp.catalog', { changed: true });
        this.refreshApp(app.id);
        return this.info(this.app(app.id)!) satisfies Ops['admin.miniapps.review']['res'];
      }

      case 'admin.miniapps.enable': {
        admin();
        const app = this.app(String(d.id ?? ''));
        if (!app) throw new MiniAppError('Tool not found.');
        const on = d.enabled === true;
        this.db.prepare('UPDATE miniapps SET enabled = ? WHERE id = ?').run(on ? 1 : 0, app.id);
        this.d.store.audit(me.id, on ? 'miniapp.enabled' : 'miniapp.disabled', app.id, { name: app.name, version: app.version });
        this.d.broadcast('miniapp.catalog', { changed: true });
        this.refreshApp(app.id);
        return this.info(this.app(app.id)!) satisfies Ops['admin.miniapps.enable']['res'];
      }
    }
    return undefined;
  }
}
