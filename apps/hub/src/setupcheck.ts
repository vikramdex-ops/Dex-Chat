// The setup check (Control room, top; docs/GO-LIVE.md): everything the hub can check about itself,
// live, with the one thing to do when something is not right, and the checks only a person can
// make, listed as such and never shown as passed.
//
// Other parts of the hub add their own checks with `health.register(id, fn)`:
//
//   hub.health.register('zoho', () => ({ id: 'zoho.calendar', area: 'Zoho Calendar', title: '…', state: 'pass', detail: '…', fix: null }));
//
// A check may return one check or several, or a promise of them. A check that throws or takes
// longer than five seconds is shown as failed, with what it said, so one broken check never hides
// the others.
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import { minutesOf, summarize, uptimeText } from '@dex/core';
import type { NibConfig, NoticeDesk, RemoteView, SetupCheck, SetupReport } from '@dex/core';
import type { Backups } from './backup.ts';
import { folderThere } from './firstrun.ts';

export type HealthCheck = () => SetupCheck | SetupCheck[] | Promise<SetupCheck | SetupCheck[]>;

const CHECK_MS = 5000;

export class HealthChecks {
  private readonly checks = new Map<string, HealthCheck>();

  /** Add (or replace) a group of checks under an id. Returns a function that removes it. */
  register(id: string, fn: HealthCheck): () => void {
    this.checks.set(id, fn);
    return () => { if (this.checks.get(id) === fn) this.checks.delete(id); };
  }

  ids(): string[] { return [...this.checks.keys()]; }

  async run(): Promise<SetupCheck[]> {
    const groups = await Promise.all([...this.checks].map(async ([id, fn]) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const r = await Promise.race([
          Promise.resolve().then(fn),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('it took too long to answer')), CHECK_MS); timer.unref(); }),
        ]);
        return Array.isArray(r) ? r : [r];
      } catch (err) {
        return [{ id, area: id, title: 'The check could not run', state: 'fail' as const, detail: (err as Error)?.message ?? String(err), fix: 'Restart the hub service; if it stays, send this report to whoever looks after the hub.' }];
      } finally { if (timer) clearTimeout(timer); }
    }));
    return groups.flat();
  }

  async report(hub: SetupReport['hub']): Promise<SetupReport> {
    const checks = await this.run();
    return { at: Date.now(), hub, summary: summarize(checks), checks };
  }
}

// ---------------------------------------------------------------- the database
/** SQLite's quick check, in a worker thread on its own read-only connection, so the hub does not pause. */
const QUICK = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
try {
  const db = new DatabaseSync(workerData.db, { readOnly: true });
  const rows = db.prepare('PRAGMA quick_check').all().map((r) => String(Object.values(r)[0]));
  db.close();
  parentPort.postMessage({ ok: true, result: rows.slice(0, 5).join('; ') });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String((e && e.message) || e) });
}
`;

export function quickCheck(dbPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const w = new Worker(QUICK, { eval: true, workerData: { db: dbPath } });
    let done = false;
    w.once('message', (m: { ok: boolean; result?: string; error?: string }) => {
      done = true;
      void w.terminate();
      if (m.ok) resolve(m.result ?? ''); else reject(new Error(m.error));
    });
    w.once('error', (e) => { if (!done) reject(e); });
    w.once('exit', () => { if (!done) reject(new Error('The check stopped.')); });
  });
}

/** The tables and added columns this version of the hub needs (made on start: store.ts and each module). */
export const REQUIRED_SCHEMA: Record<string, string[]> = {
  meta: ['key', 'value'],
  users: ['availability', 'availability_until', 'ooo', 'receipts', 'status_emoji'],
  profiles: ['seat_id'],
  devices: ['enc_key', 'enc_sig'],
  conversations: [], messages: [], files: [], audit: ['actor', 'action'],
  notice_desks: [], nib_snapshots: [], seat_layouts: [],
};

export function missingSchema(db: DatabaseSync, need = REQUIRED_SCHEMA): string[] {
  const missing: string[] = [];
  for (const [table, cols] of Object.entries(need)) {
    const have = (db.prepare(`PRAGMA table_info("${table.replace(/"/g, '')}")`).all() as Array<{ name: string }>).map((c) => c.name);
    if (!have.length) { missing.push(table); continue; }
    for (const c of cols) if (!have.includes(c)) missing.push(`${table}.${c}`);
  }
  return missing;
}

// ---------------------------------------------------------------- small helpers for checks
const GB = 1024 ** 3;
export function freeBytes(dir: string): { free: number; size: number } | null {
  try {
    const s = fs.statfsSync(dir);
    return { free: Number(s.bavail) * Number(s.bsize), size: Number(s.blocks) * Number(s.bsize) };
  } catch { return null; }
}
export const gb = (n: number) => (n >= 10 * GB ? `${Math.round(n / GB)} GB` : `${(n / GB).toFixed(1)} GB`);
export const sizeText = (n: number) => (n >= GB ? gb(n) : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
export const dataDbPath = (dataDir: string) => path.join(dataDir, 'hub.db');
export { uptimeText };

// ---------------------------------------------------------------- the hub's own checks

export interface SetupDeps {
  db: DatabaseSync;
  dataDir: string;
  startedAt: number;
  version: string;
  backups: Backups;
  nib: () => NibConfig;
  desks: () => NoticeDesk[];
  defaultDesks: string[];
  /** Seats on the floor plan and people at them; null without a floor plan. */
  seats: () => { seats: number; seated: number } | null;
  remote: () => RemoteView;
  ice: () => { mode: 'auto' | 'cloudflare' | 'custom'; keyId: string | null; hasToken: boolean; servers: number };
}

const DAY = 86_400_000;
const when = (t: number) => new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function dayRange(days: number[]): string {
  const s = [...days].sort((a, b) => a - b);
  const run = s.length > 2 && s.every((d, i) => i === 0 || d === s[i - 1] + 1);
  return run ? `${DAYS[s[0]]}–${DAYS[s[s.length - 1]]}` : s.map((d) => DAYS[d]).join(', ');
}

const C = (id: string, area: string, title: string, state: SetupCheck['state'], detail: string, fix: string | null = null): SetupCheck => ({ id, area, title, state, detail, fix });

/** The checks the hub makes about itself: the service, the database, storage, backups, the office's set-up, outside access, and the ones a person makes. */
export function registerBuiltInChecks(health: HealthChecks, d: SetupDeps): void {
  health.register('hub', () => {
    const up = Math.round((Date.now() - d.startedAt) / 1000);
    return C('hub.service', 'Hub', 'The hub service is running', 'pass', `Running for ${uptimeText(up)} (since ${when(d.startedAt)}), version ${d.version}${process.platform === 'win32' ? '' : ` on ${process.platform}`}.`);
  });

  let integrity: { at: number; result: string } | null = null;
  health.register('db', async () => {
    const out: SetupCheck[] = [];
    try {
      if (!integrity || Date.now() - integrity.at > 10 * 60_000) integrity = { at: Date.now(), result: await quickCheck(dataDbPath(d.dataDir)) };
      const size = (() => { try { return fs.statSync(dataDbPath(d.dataDir)).size; } catch { return 0; } })();
      out.push(integrity.result === 'ok'
        ? C('db.integrity', 'Database', 'The database is sound', 'pass', `SQLite's quick check: ok (database ${sizeText(size)}).`)
        : C('db.integrity', 'Database', 'The database is damaged', 'fail', `SQLite's quick check reported: ${integrity.result}`, 'Stop the hub service and restore the last good backup (docs/BACKUP.md, Restoring).'));
    } catch (err) {
      integrity = null;
      out.push(C('db.integrity', 'Database', 'The database could not be checked', 'fail', (err as Error).message, 'Restart the hub service, then run the setup check again.'));
    }
    const missing = missingSchema(d.db);
    out.push(missing.length
      ? C('db.schema', 'Database', 'The database is not up to date', 'fail', `Missing: ${missing.slice(0, 8).join(', ')}.`, 'Restart the hub service: it brings the database up to date when it starts.')
      : C('db.schema', 'Database', 'The database is up to date', 'pass', `Every table and column version ${d.version} needs is there.`));
    return out;
  });

  health.register('storage', () => {
    const s = freeBytes(d.dataDir);
    if (!s) return C('storage.free', 'Storage', 'Free space could not be read', 'info', `The hub could not read the free space of ${d.dataDir}.`);
    const pct = s.size ? Math.round((s.free / s.size) * 100) : 100;
    const detail = `${gb(s.free)} free of ${gb(s.size)} (${pct}%) on the disk with the hub's data.`;
    if (s.free < 2 * GB || pct < 3) return C('storage.free', 'Storage', 'The hub\'s disk is almost full', 'fail', detail, 'Free space on the hub PC now: when the disk is full, messages and files cannot be saved.');
    if (s.free < 10 * GB || pct < 10) return C('storage.free', 'Storage', 'The hub\'s disk is getting full', 'action', detail, 'Free some space on the hub PC, or move the hub to a bigger disk.');
    return C('storage.free', 'Storage', 'There is room for the office\'s messages and files', 'pass', detail);
  });

  health.register('backups', () => {
    const s = d.backups.status();
    const out: SetupCheck[] = [];
    const folder = s.config.folder;
    const auto = s.auto;
    if (folder) {
      out.push(folderThere(folder)
        ? C('backup.folder', 'Backups', 'Backups have a destination', 'pass', auto?.state === 'picked' ? auto.message : `Backups go to ${folder}.`)
        : C('backup.folder', 'Backups', 'The backup folder cannot be reached', 'fail', `${folder} is not there now.`, 'Check that the backup disk is plugged in or the network share is on, or choose another folder in Control room ▸ Backups & leavers.'));
      out.push(C('backup.schedule', 'Backups', 'Backups run every night', 'pass', `Every night at ${s.config.time}; keeps ${s.config.keepDaily} daily, ${s.config.keepWeekly} weekly and ${s.config.keepMonthly} monthly copies.${s.nextRunAt ? ` Next: ${when(s.nextRunAt)}.` : ''}`));
    } else {
      out.push(C('backup.folder', 'Backups', auto?.state === 'needs-disk' ? 'Backups need a second disk or a network share' : 'No backup folder yet', auto?.state === 'failed' ? 'fail' : 'action',
        auto?.message ?? 'No backup folder has been chosen, so nothing is backed up.', auto?.action ?? 'Enter a folder on a second disk or a network share in Control room ▸ Backups & leavers ▸ Backup folder.'));
      // one thing to do (the folder): the schedule and the copies follow from it
      out.push(C('backup.schedule', 'Backups', 'No nightly backup yet', 'info', 'Backups run every night once a backup folder is chosen.'));
    }
    const ok = s.lastSuccess;
    if (s.running) out.push(C('backup.last', 'Backups', 'A backup is running', 'info', `${s.running.step} (started ${when(s.running.since)}).`));
    else if (s.lastRun && !s.lastRun.ok) out.push(C('backup.last', 'Backups', 'The last backup did not work', 'fail', s.lastRun.error ?? 'The last backup stopped.', 'Fix what it says, then click Back up now in Control room ▸ Backups & leavers.'));
    else if (ok) {
      const age = Date.now() - ok.finishedAt;
      const verified = ok.check?.integrity === 'ok';
      const detail = `${when(ok.finishedAt)}, ${sizeText(ok.dbBytes + ok.filesBytes)}; ${verified ? `checked: database sound, ${ok.check!.hashed} of ${ok.check!.files} files compared with their fingerprints` : 'not checked'}.`;
      out.push(age > 2 * DAY || !verified
        ? C('backup.last', 'Backups', 'No recent checked backup', 'fail', detail, 'In Control room ▸ Backups & leavers, click Back up now and see what it says.')
        : C('backup.last', 'Backups', 'The last backup worked and was checked', 'pass', detail));
    } else if (folder) out.push(C('backup.last', 'Backups', 'No backup yet', 'action', 'No backup has run yet.', 'Click Back up now in Control room ▸ Backups & leavers.'));
    else out.push(C('backup.last', 'Backups', 'No backup yet', 'info', 'Nothing has been backed up yet.'));
    return out;
  });

  health.register('seating', () => {
    const s = d.seats();
    if (!s || !s.seats) return C('seating.plan', 'Seating', 'There is no floor plan', 'action', 'The floor plan has no seats.', 'Open Directory ▸ Org chart ▸ Floor ▸ Arrange and draw or import the floor plan.');
    return s.seated
      ? C('seating.plan', 'Seating', 'The seating plan is there', 'pass', `${s.seats} seats on the floor plan; ${s.seated === 1 ? '1 person is' : `${s.seated} people are`} at a seat.`)
      : C('seating.plan', 'Seating', 'Nobody is at a seat yet', 'action', `${s.seats} seats on the floor plan, nobody at one.`, 'Open Directory ▸ Org chart ▸ Floor ▸ Arrange ▸ Import and give people their seats.');
  });

  health.register('notices', () => {
    const desks = d.desks();
    const names = new Set(desks.map((x) => x.name.toLowerCase()));
    const missing = d.defaultDesks.filter((n) => !names.has(n.toLowerCase()));
    const withIssuers = desks.filter((x) => x.issuers.length).length;
    if (missing.length) return C('notices.desks', 'Notice desks', 'A notice desk is missing', 'action', `There is no ${missing.join(', ')} desk.`, 'Add it in Control room ▸ Notice desks.');
    return C('notices.desks', 'Notice desks', 'The notice desks are there', 'pass', `${desks.map((x) => x.name).join(', ')}; ${withIssuers ? `${withIssuers} with their own issuers` : 'administrators issue for all of them until issuers are chosen'}.`);
  });

  health.register('nib', () => {
    const c = d.nib();
    const out: SetupCheck[] = [];
    if (!c.enabled) return C('nib.times', 'Nib', 'Nib is off', 'info', 'Day sheets and the evening register are switched off.', 'If the office wants day sheets, turn Nib on in Control room ▸ Nib & day sheets.');
    const nextMorning = minutesOf(c.followUpAt) < minutesOf(c.digestAt);
    out.push(C('nib.times', 'Nib', 'Nib\'s times are set', 'pass', `Start of day ${c.startPromptAt}, wrap-up ${c.wrapAt}, register ${c.digestAt}, follow-up ${c.followUpAt}${nextMorning ? ' (the next working morning)' : ''}; ${dayRange(c.workdays)}.`));
    out.push(c.openSheets
      ? C('nib.private', 'Nib', 'Day sheets are open to everyone', 'info', 'An administrator chose to let every member see every day sheet.', 'Leave it only if the management wants day sheets open (Control room ▸ Nib & day sheets ▸ 04).')
      : C('nib.private', 'Nib', 'Day sheets are private', 'pass', 'Each person, the people who gave them work, and the management see a day sheet; nobody else.'));
    if (!c.managers.length) out.push(C('nib.register', 'Nib', 'Nobody receives the evening register', 'action', 'No one is chosen to receive the register yet.', 'Add the directors or managers under Control room ▸ Nib & day sheets ▸ 02 Management.'));
    else {
      const last = (d.db.prepare("SELECT MAX(sent_at) AS t FROM nib_snapshots WHERE kind = 'register'").get() as { t: number | null } | undefined)?.t ?? null;
      out.push(last
        ? C('nib.register', 'Nib', 'The evening register is going out', 'pass', `${c.managers.length === 1 ? '1 person receives' : `${c.managers.length} people receive`} it; the last one went ${when(last)}.`)
        : C('nib.register', 'Nib', 'The first register has not gone yet', 'info', `${c.managers.length === 1 ? '1 person receives' : `${c.managers.length} people receive`} it at ${c.digestAt} on working days.`, 'Check after the first working evening that the management received it.'));
    }
    return out;
  });

  health.register('audit', () => {
    const r = d.db.prepare('SELECT COUNT(*) AS n, MAX(at) AS t FROM audit').get() as { n: number; t: number | null };
    return C('audit.log', 'Audit log', 'The audit log is on', 'pass', `Always on: every change in the Control room is recorded. ${r.n === 1 ? '1 entry' : `${r.n} entries`}${r.t ? `, the latest ${when(r.t)}` : ''}.`);
  });

  health.register('remote', () => {
    const v = d.remote();
    const c = v.config;
    if (!c.url) return C('remote.access', 'Outside the office', 'Working from outside is not set up', 'action', 'No gateway address is saved, so phones on mobile data and home PCs cannot reach the hub.', 'Set up the gateway, then enter its address in Control room ▸ Outside the office.');
    if (!c.enabled) return C('remote.access', 'Outside the office', 'Access from outside is switched off', 'action', `The gateway ${c.url} is saved but switched off.`, 'Switch on Allow access from outside the office in Control room ▸ Outside the office.');
    if (!v.status.connected) return C('remote.access', 'Outside the office', 'The hub is not connected to the gateway', 'fail', v.status.error ? `${c.url}: ${v.status.error}` : `${c.url} is not answering.`, 'Check that the hub PC has internet access and that the gateway address is right (Control room ▸ Outside the office).');
    return C('remote.access', 'Outside the office', 'Working from outside works', v.status.pinned ? 'pass' : 'action', `Connected to ${c.url}${v.status.connected && v.status.since ? ` since ${when(v.status.since)}` : ''}; ${v.status.pinned ? 'the gateway is pinned to this hub' : 'the gateway is not pinned to this hub'}.`, v.status.pinned ? null : 'Pin the gateway to this hub: deploy it again with this hub\'s fingerprint (Control room ▸ Outside the office ▸ This hub).');
  });

  health.register('calls', () => {
    const i = d.ice();
    const outside = d.remote().config.enabled;
    if (i.mode === 'cloudflare') {
      return i.keyId && i.hasToken
        ? C('calls.relay', 'Calls', 'Calls across networks have a relay', 'pass', `Cloudflare TURN (key ${i.keyId.slice(0, 6)}…); each call gets short-lived credentials.`)
        : C('calls.relay', 'Calls', 'The call relay is missing its key', 'fail', 'Cloudflare TURN is chosen but its key id or API token is missing.', 'Enter the TURN key id and API token in Control room ▸ Outside the office ▸ Calls across networks.');
    }
    if (i.mode === 'custom') {
      return i.servers
        ? C('calls.relay', 'Calls', 'Calls across networks have a relay', 'pass', `${i.servers === 1 ? '1 relay server' : `${i.servers} relay servers`} set by an administrator.`)
        : C('calls.relay', 'Calls', 'No relay server is set', 'fail', 'Your own relay servers are chosen, but none is listed.', 'Add the relay server in Control room ▸ Outside the office ▸ Calls across networks.');
    }
    return C('calls.relay', 'Calls', 'No relay for calls from outside', outside ? 'action' : 'info', 'Calls inside the office need no relay. From some mobile networks, calls cannot connect without one.', 'Set Relay for calls to Cloudflare TURN in Control room ▸ Outside the office ▸ Calls across networks.');
  });

  // what only a person can check: listed, never passed
  health.register('manual', () => [
    C('manual.message', 'By hand', 'Two PCs can message each other', 'manual', 'The hub cannot see what arrives on a screen.', 'Send a message from one office PC to a colleague on another, and see it arrive.'),
    C('manual.call', 'By hand', 'A call between two PCs works', 'manual', 'Sound and video can only be judged by the people on the call.', 'Call a colleague on another office PC; check you hear and see each other.'),
    C('manual.mobile', 'By hand', 'A phone on mobile data can send a message', 'manual', 'This needs a phone outside the office network.', 'Turn Wi-Fi off on a phone, send a message, and see it arrive on a PC in the office.'),
    C('manual.meetlink', 'By hand', 'A meeting link works from outside, with a guest', 'manual', 'This needs a phone outside the office network.', 'Open a meeting link on a phone using mobile data; let a test guest in from the lobby.'),
  ]);
}
