// Dexterity Sheets, read by the hub for Nib: the Sheets server's read API (HTTP JSON, TCP 47812),
// its address (typed, or found with the UDP question DEXSHEETS?1 to port 47811) and the token an
// administrator generated in Sheets Server Manager and pasted into Control room → Integrations.
//
// The token is sealed (AES-256-GCM with sheets.key beside the database, not in it), never logged,
// never sent to anyone's PC and never sent back to the Control room once saved. People only ever
// see their own Sheets items: the hub asks for the account of the person asking, nobody else's.
// The questions and answers are in packages/core/src/sheets.ts; docs/INTEGRATIONS.md has the contract.
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import type { PublicUser } from '@dex/core';
import { SHEETS_API_PORT, SHEETS_DISCOVERY_PORT, SHEETS_DISCOVERY_QUESTION, sheetsBaseUrl } from '@dex/core/sheets';
import type { SheetsAdminView, SheetsAssigned, SheetsBook, SheetsFound, SheetsMention, SheetsTestResult } from '@dex/core/sheets';

export class SheetsError extends Error {}

export interface SheetsHost {
  dataDir: string;
  meta: (key: string) => string;
  setMeta: (key: string, value: string) => void;
  toAdmins: (name: string, data: unknown) => void;
  audit: (actor: string | null, action: string, target: string | null, detail?: unknown) => void;
  log: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
  /** People who asked for the morning list (for the Control room's count). */
  digestPeople: () => number;
  /** Tests only: where the discovery question goes on this PC (the mock server's port). */
  discoveryPort?: number;
}

const TIMEOUT_MS = 6000;
const MAX_BODY = 1_000_000;

const str = (v: unknown, max = 400): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : typeof v === 'number' ? String(v) : '');
const strOrNull = (v: unknown, max = 60): string | null => str(v, max) || null;

export class SheetsLink {
  private readonly h: SheetsHost;
  private key: Buffer | null = null;

  constructor(host: SheetsHost) { this.h = host; }

  // ------------------------------------------------------------ settings
  private config(): { url: string | null; token: string | null } {
    return { url: this.h.meta('sheets_url') || null, token: this.unseal(this.h.meta('sheets_token')) };
  }
  /** The Sheets server and its token are both saved. */
  configured(): boolean { const c = this.config(); return !!(c.url && c.token); }

  adminView(): SheetsAdminView {
    const c = this.config();
    let lastTest: SheetsTestResult | null = null;
    try { lastTest = this.h.meta('sheets_last_test') ? JSON.parse(this.h.meta('sheets_last_test')) as SheetsTestResult : null; } catch { lastTest = null; }
    return { url: c.url, hasToken: !!c.token, configured: !!(c.url && c.token), lastTest, digestPeople: this.h.digestPeople() };
  }

  private sealKey(): Buffer {
    if (this.key) return this.key;
    const file = path.join(this.h.dataDir, 'sheets.key');
    try {
      const k = fs.readFileSync(file);
      if (k.length === 32) { this.key = k; return k; }
    } catch { /* first use */ }
    const k = crypto.randomBytes(32);
    fs.writeFileSync(file, k, { mode: 0o600 });
    this.key = k;
    return k;
  }
  private seal(text: string): string {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.sealKey(), iv);
    const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return `v1.${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')}`;
  }
  private unseal(sealed: string | null | undefined): string | null {
    if (!sealed || !sealed.startsWith('v1.')) return null;
    try {
      const raw = Buffer.from(sealed.slice(3), 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', this.sealKey(), raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    } catch { return null; }
  }

  private configure(me: PublicUser, d: Record<string, unknown>): SheetsAdminView {
    const changed: string[] = [];
    if (d.url !== undefined) {
      if (d.url === null || d.url === '') this.h.setMeta('sheets_url', '');
      else {
        const url = sheetsBaseUrl(d.url);
        if (!url) throw new SheetsError('Type the Sheets server as a name or address, for example PC-SERVER or 10.0.0.5:47812.');
        this.h.setMeta('sheets_url', url);
      }
      changed.push('url');
    }
    if (d.token !== undefined) {
      if (d.token === null) { this.h.setMeta('sheets_token', ''); changed.push('token removed'); }
      else {
        const t = String(d.token).trim();
        if (t) {
          if (t.length > 512 || /\s/.test(t)) throw new SheetsError('That does not look like a token from Sheets Server Manager.');
          this.h.setMeta('sheets_token', this.seal(t));
          changed.push('token');
        }
      }
    }
    if (changed.length) this.h.setMeta('sheets_last_test', '');
    // the audit names what changed, never the token
    this.h.audit(me.id, 'sheets.config', null, { changed, url: this.config().url });
    const view = this.adminView();
    this.h.toAdmins('admin.sheets', view);
    return view;
  }

  // ------------------------------------------------------------ the read API
  private async get<T>(pathAndQuery: string, over?: { url?: string | null; token?: string | null }): Promise<T> {
    const c = this.config();
    const base = over?.url ?? c.url;
    const token = over?.token ?? c.token;
    if (!base || !token) throw new SheetsError('Dexterity Sheets is not connected to the hub yet. An administrator connects it in Control room → Integrations.');
    let res: Response;
    try {
      res = await fetch(`${base}${pathAndQuery}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
    } catch (err) {
      const why = (err as Error).name === 'TimeoutError' ? 'did not answer in time' : 'could not be reached';
      throw new SheetsError(`The Sheets server ${why}.`);
    }
    if (res.status === 401 || res.status === 403) { void res.body?.cancel(); throw new SheetsError('The Sheets server refused the token. An administrator can paste a new one from Sheets Server Manager.'); }
    if (res.status === 404) { void res.body?.cancel(); throw new SheetsError('The Sheets server does not know that.'); }
    if (!res.ok) { void res.body?.cancel(); throw new SheetsError(`The Sheets server answered ${res.status}.`); }
    const text = await res.text();
    if (text.length > MAX_BODY) throw new SheetsError('The Sheets server sent too much.');
    try { return JSON.parse(text) as T; } catch { throw new SheetsError('The Sheets server sent something that is not JSON.'); }
  }

  /** GET /api/v1/health, with the saved settings or the ones an administrator is typing. */
  async health(over?: { url?: string; token?: string }): Promise<SheetsTestResult> {
    const at = Date.now();
    const url = over?.url ? sheetsBaseUrl(over.url) : this.config().url;
    if (over?.url && !url) return { ok: false, name: null, version: null, error: 'Type the Sheets server as a name or address, for example PC-SERVER or 10.0.0.5:47812.', at };
    try {
      const h = await this.get<{ name?: unknown; version?: unknown }>('/api/v1/health', { url, token: over?.token?.trim() || null });
      return { ok: true, name: strOrNull(h?.name, 80), version: strOrNull(h?.version, 40), error: null, at };
    } catch (err) {
      return { ok: false, name: null, version: null, error: err instanceof SheetsError ? err.message : 'The Sheets server could not be asked.', at };
    }
  }

  private static person(account: string): string { return encodeURIComponent(account); }

  /** What is assigned to this account (DOMAIN\user). */
  async assigned(account: string): Promise<SheetsAssigned[]> {
    const rows = await this.get<unknown>(`/api/v1/people/${SheetsLink.person(account)}/assigned`);
    return (Array.isArray(rows) ? rows : []).slice(0, 500).filter((r): r is Record<string, unknown> => !!r && typeof r === 'object').map((r) => ({
      book: str(r.book, 200), sheet: str(r.sheet, 120), cell: str(r.cell, 40), title: str(r.title, 300), status: str(r.status, 40), due: strOrNull(r.due, 40), link: str(r.link, 2000),
    }));
  }

  /** Mentions of this account since a moment. */
  async mentions(account: string, since: Date): Promise<SheetsMention[]> {
    const rows = await this.get<unknown>(`/api/v1/people/${SheetsLink.person(account)}/mentions?since=${encodeURIComponent(since.toISOString())}`);
    return (Array.isArray(rows) ? rows : []).slice(0, 500).filter((r): r is Record<string, unknown> => !!r && typeof r === 'object').map((r) => ({
      book: str(r.book, 200), sheet: str(r.sheet, 120), cell: str(r.cell, 40), from: str(r.from, 120), text: str(r.text, 600), at: str(r.at, 40), link: str(r.link, 2000),
    }));
  }

  /** The books the server shares, with who has each open. */
  async books(): Promise<SheetsBook[]> {
    const rows = await this.get<unknown>('/api/v1/books');
    return (Array.isArray(rows) ? rows : []).slice(0, 2000).filter((r): r is Record<string, unknown> => !!r && typeof r === 'object').map((r) => ({
      id: str(r.id, 200), name: str(r.name, 200), sharer: str(r.sharer, 120), online: (Array.isArray(r.online) ? r.online : []).map((x) => str(x, 120)).filter(Boolean).slice(0, 200), link: strOrNull(r.link, 2000),
    }));
  }

  /** Sheets servers on the office network: the UDP question, answers for two seconds. */
  discover(waitMs = 2000): Promise<SheetsFound[]> {
    return new Promise((resolve) => {
      const found: SheetsFound[] = [];
      const sock = dgram.createSocket('udp4');
      const done = () => { try { sock.close(); } catch { /* closed */ } resolve(found); };
      sock.on('error', (err) => { this.h.log('warn', 'sheets discovery', { error: err.message }); done(); });
      sock.on('message', (buf, from) => {
        let f: { name?: unknown; address?: unknown; version?: unknown };
        try { f = JSON.parse(buf.toString('utf8')) as typeof f; } catch { return; }
        // the server says its own port; the address is where the answer came from
        const port = str(f.address).split(':').pop() ?? '';
        const address = `${from.address}:${/^\d+$/.test(port) ? port : ''}`;
        // the read API is on its own port of the same PC
        const item: SheetsFound = { name: str(f.name, 80) || from.address, address, version: str(f.version, 40), url: `http://${from.address}:${SHEETS_API_PORT}` };
        if (!found.some((x) => x.address === item.address || (x.name === item.name && from.address === '127.0.0.1'))) found.push(item);
      });
      sock.bind(0, () => {
        try { sock.setBroadcast(true); } catch { /* no broadcast on this PC */ }
        const q = Buffer.from(SHEETS_DISCOVERY_QUESTION);
        const port = this.h.discoveryPort ?? SHEETS_DISCOVERY_PORT;
        if (this.h.discoveryPort === undefined) sock.send(q, port, '255.255.255.255', () => {});
        // a server on the hub's own PC answers on loopback even where broadcast is filtered
        sock.send(q, port, '127.0.0.1', () => {});
        setTimeout(done, waitMs).unref();
      });
    });
  }

  // ------------------------------------------------------------ the Control room
  async handle(op: string, me: PublicUser, d: Record<string, unknown>): Promise<unknown> {
    if (!op.startsWith('admin.sheets.')) return undefined;
    if (me.role !== 'owner' && me.role !== 'admin') throw new SheetsError('Only administrators can do that.');
    if (op === 'admin.sheets.get') return this.adminView();
    if (op === 'admin.sheets.set') return this.configure(me, d);
    if (op === 'admin.sheets.discover') return this.discover();
    if (op === 'admin.sheets.test') {
      const typed = typeof d.url === 'string' && d.url.trim() ? d.url : undefined;
      const token = typeof d.token === 'string' && d.token.trim() ? d.token : undefined;
      const r = await this.health({ url: typed, token });
      // only a test of the saved settings is remembered
      if (!typed && !token) { this.h.setMeta('sheets_last_test', JSON.stringify(r)); this.h.toAdmins('admin.sheets', this.adminView()); }
      if (!r.ok) this.h.log('warn', 'sheets test failed', { error: r.error });
      return r;
    }
    return undefined;
  }
}
