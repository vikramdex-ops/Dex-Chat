// Office policies an administrator sets in the Control room (how long a message can be edited,
// the largest upload, whether PCs may message each other directly while the hub is off, whether
// calls may be recorded) and the usage report: activity per day, busiest Spaces, storage, calls.
import type { DatabaseSync } from 'node:sqlite';
import type { OfficeLine, OfficePolicy, Ops, PublicUser, UsageReport } from '@dex/core';
import { ulid } from '@dex/core';
import { validCidr, validDlpRules } from '@dex/core/dlp';
import type { FileStore } from './files.ts';
import type { Store } from './store.ts';

export class PolicyError extends Error {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS call_log (
  id TEXT PRIMARY KEY,
  conv_id TEXT NOT NULL,
  started_by TEXT NOT NULL,
  ended_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  missed INTEGER NOT NULL,
  video INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_call_log_at ON call_log(ended_at);
`;

const DAY = 86400_000;
const dayKey = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export class Policies {
  private readonly db: DatabaseSync;
  private readonly store: Store;
  private readonly files: FileStore;
  private readonly defaultBytes: number;
  private readonly changed: (p: OfficePolicy) => void;

  constructor(store: Store, files: FileStore, changed: (p: OfficePolicy) => void) {
    this.store = store;
    this.db = store.db;
    this.files = files;
    this.changed = changed;
    this.db.exec(SCHEMA);
    this.defaultBytes = files.maxBytes;
    this.files.maxBytes = this.uploadBytes();
  }

  private meta(key: string): string | null {
    const v = this.store.meta(key, () => '');
    return v === '' ? null : v;
  }
  private setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  get(): OfficePolicy {
    const edit = this.meta('policy_edit_minutes');
    const up = Number(this.meta('policy_upload_mb'));
    return {
      editWindowMinutes: edit === null || edit === 'none' ? null : Number(edit),
      maxUploadMb: Number.isFinite(up) && up >= 1 ? up : Math.max(1, Math.ceil(this.defaultBytes / 1024 / 1024)),
      peerFallback: this.meta('policy_peer') !== '0',
      allowRecording: this.meta('policy_recording') !== '0',
      cameraConsent: this.meta('policy_camera_consent') === '1',
      requireE2E: this.meta('policy_require_e2e') === '1',
      assistUnattended: this.meta('policy_assist_unattended') === '1',
      assistClipboard: this.meta('policy_assist_clipboard') === '1',
      assistFiles: this.meta('policy_assist_files') === '1',
      assistReconnect: this.meta('policy_assist_reconnect') === '1',
      assistPrivacy: this.meta('policy_assist_privacy') === '1',
      personalDevices: this.meta('policy_personal_devices') !== '0',
      memberEmoji: this.meta('policy_member_emoji') !== '0',
      dlp: this.json('policy_dlp', []),
      blockedFileTypes: this.json('policy_blocked_types', []),
      outsideNetworks: this.json('policy_outside_networks', []),
      defaultSpaces: (() => { try { return JSON.parse(this.meta('policy_default_spaces') ?? '[]') as string[]; } catch { return []; } })(),
      // meetings (Control room ▸ Policies ▸ Meetings)
      meetingLobby: (['off', 'outside', 'everyone'] as const).find((v) => v === this.meta('policy_meeting_lobby')) ?? 'outside',
      guestLinks: this.meta('policy_guest_links') !== '0',
      joinBeforeHost: this.meta('policy_join_before_host') !== '0',
      recordingMaxMb: (() => { const v = Number(this.meta('policy_recording_mb')); return Number.isInteger(v) && v >= 50 ? v : 2048; })(),
    };
  }

  private json<T>(key: string, fallback: T): T {
    try { const v = this.meta(key); return v ? JSON.parse(v) as T : fallback; } catch { return fallback; }
  }

  lines(): OfficeLine[] { return this.json<OfficeLine[]>('office_lines', []); }
  linesChanged: (list: OfficeLine[]) => void = () => {};

  /** The upload limit in bytes: the administrator's choice, or what the hub was started with. */
  private uploadBytes(): number {
    const up = Number(this.meta('policy_upload_mb'));
    return Number.isFinite(up) && up >= 1 ? up * 1024 * 1024 : this.defaultBytes;
  }

  /** Milliseconds after sending that an author may still edit or delete, or null for any time. */
  editWindowMs(): number | null {
    const m = this.get().editWindowMinutes;
    return m === null ? null : m * 60_000;
  }

  logCall(id: string, convId: string, startedBy: string, video: boolean, missed: boolean, durationMs: number, at = Date.now()): void {
    this.db.prepare('INSERT OR IGNORE INTO call_log (id, conv_id, started_by, ended_at, duration_ms, missed, video) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, convId, startedBy, at, Math.max(0, Math.round(durationMs)), missed ? 1 : 0, video ? 1 : 0);
  }

  usage(days: number, now = Date.now()): UsageReport {
    const start = new Date(now - (days - 1) * DAY);
    start.setHours(0, 0, 0, 0);
    const from = start.getTime();
    const daily = new Map<string, UsageReport['daily'][number]>();
    for (let t = from; t <= now; t += DAY) { const k = dayKey(t); daily.set(k, { day: k, messages: 0, direct: 0, space: 0, activePeople: 0, calls: 0, callMinutes: 0 }); }
    const msgs = this.db.prepare(`SELECT m.created_at, m.author_id, c.kind FROM messages m JOIN conversations c ON c.id = m.conv_id
      JOIN users u ON u.id = m.author_id WHERE m.created_at >= ? AND u.role != 'bot'`).all(from) as Array<{ created_at: number; author_id: string; kind: string }>;
    const people = new Map<string, Set<string>>();
    const byPerson = new Map<string, number>();
    for (const m of msgs) {
      const d = daily.get(dayKey(m.created_at));
      if (!d) continue;
      d.messages++;
      if (m.kind === 'direct') d.direct++; else d.space++;
      (people.get(d.day) ?? people.set(d.day, new Set()).get(d.day)!).add(m.author_id);
      byPerson.set(m.author_id, (byPerson.get(m.author_id) ?? 0) + 1);
    }
    for (const [k, s] of people) daily.get(k)!.activePeople = s.size;
    const calls = this.db.prepare('SELECT ended_at, duration_ms, missed FROM call_log WHERE ended_at >= ?').all(from) as Array<{ ended_at: number; duration_ms: number; missed: number }>;
    for (const c of calls) {
      const d = daily.get(dayKey(c.ended_at));
      if (!d) continue;
      d.calls++;
      if (!c.missed) d.callMinutes += c.duration_ms / 60_000;
    }
    for (const d of daily.values()) d.callMinutes = Math.round(d.callMinutes);
    const topSpaces = this.db.prepare(`SELECT c.id, c.name, COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conv_id
      WHERE c.kind = 'space' AND m.created_at >= ? GROUP BY c.id ORDER BY n DESC LIMIT 8`).all(from) as Array<{ id: string; name: string | null; n: number }>;
    const files = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM files').get() as { n: number; bytes: number };
    const uniqueActive = new Set(msgs.map((m) => m.author_id)).size;
    const count = (sql: string, ...a: number[]) => (this.db.prepare(sql).get(...a) as { n: number }).n;
    return {
      days, from,
      daily: [...daily.values()],
      totals: {
        people: count(`SELECT COUNT(*) AS n FROM users u WHERE u.role != 'bot' AND EXISTS (SELECT 1 FROM devices d WHERE d.user_id = u.id AND d.status = 'approved')`),
        activePeople: uniqueActive,
        activeDevices: count(`SELECT COUNT(*) AS n FROM devices WHERE status = 'approved' AND last_seen >= ?`, from),
        spaces: count(`SELECT COUNT(*) AS n FROM conversations WHERE kind = 'space'`),
        messages: msgs.length,
        files: files.n,
        fileBytes: files.bytes,
        calls: calls.length,
        callMinutes: Math.round(calls.reduce((s, c) => s + (c.missed ? 0 : c.duration_ms), 0) / 60_000),
      },
      topSpaces: topSpaces.map((s) => ({ id: s.id, name: s.name ?? 'Space', messages: s.n })),
      topPeople: [...byPerson.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([userId, messages]) => ({ userId, messages })),
    };
  }

  handle(op: string, me: PublicUser, d: Record<string, unknown>): unknown {
    if (op === 'policy.get') return this.get() satisfies Ops['policy.get']['res'];
    if (op === 'lines.office') return this.lines() satisfies Ops['lines.office']['res'];
    if (me.role !== 'owner' && me.role !== 'admin') throw new PolicyError('Only administrators can do that.');
    switch (op) {
      case 'admin.lines.add': {
        const text = typeof d.text === 'string' ? d.text.replace(/\s+/g, ' ').trim().slice(0, 280) : '';
        if (text.length < 3) throw new PolicyError('Write the line first.');
        const by = typeof d.by === 'string' && d.by.trim() ? d.by.trim().slice(0, 80) : null;
        const date = typeof d.date === 'string' && d.date ? d.date : null;
        if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new PolicyError('Choose a date, or none for any day.');
        const list = this.lines();
        if (list.length >= 500) throw new PolicyError('The office can keep up to 500 lines.');
        list.push({ id: ulid(), text, by, date, addedBy: me.id, addedAt: Date.now() });
        this.setMeta('office_lines', JSON.stringify(list));
        this.store.audit(me.id, 'lines.add', null, { date });
        this.linesChanged(list);
        return list satisfies Ops['admin.lines.add']['res'];
      }
      case 'admin.lines.remove': {
        const list = this.lines().filter((l) => l.id !== d.id);
        this.setMeta('office_lines', JSON.stringify(list));
        this.linesChanged(list);
        return list satisfies Ops['admin.lines.remove']['res'];
      }
      case 'admin.policy.set': {
        if (d.editWindowMinutes !== undefined) {
          const v = d.editWindowMinutes;
          if (v === null) this.setMeta('policy_edit_minutes', 'none');
          else if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 730 * 1440) this.setMeta('policy_edit_minutes', String(v));
          else throw new PolicyError('Choose an edit window between 1 minute and 2 years, or no limit.');
        }
        if (d.maxUploadMb !== undefined) {
          const v = d.maxUploadMb;
          if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 4096) throw new PolicyError('Choose an upload limit between 1 MB and 4 GB.');
          this.setMeta('policy_upload_mb', String(v));
        }
        if (typeof d.peerFallback === 'boolean') this.setMeta('policy_peer', d.peerFallback ? '1' : '0');
        if (typeof d.allowRecording === 'boolean') this.setMeta('policy_recording', d.allowRecording ? '1' : '0');
        if (typeof d.cameraConsent === 'boolean') this.setMeta('policy_camera_consent', d.cameraConsent ? '1' : '0');
        if (typeof d.requireE2E === 'boolean') this.setMeta('policy_require_e2e', d.requireE2E ? '1' : '0');
        for (const [k, key] of [['assistUnattended', 'policy_assist_unattended'], ['assistClipboard', 'policy_assist_clipboard'], ['assistFiles', 'policy_assist_files'], ['assistReconnect', 'policy_assist_reconnect'], ['assistPrivacy', 'policy_assist_privacy']] as const) {
          if (typeof d[k] === 'boolean') this.setMeta(key, d[k] ? '1' : '0');
        }
        if (typeof d.personalDevices === 'boolean') this.setMeta('policy_personal_devices', d.personalDevices ? '1' : '0');
        if (typeof d.memberEmoji === 'boolean') this.setMeta('policy_member_emoji', d.memberEmoji ? '1' : '0');
        if (d.meetingLobby !== undefined) {
          if (d.meetingLobby !== 'off' && d.meetingLobby !== 'outside' && d.meetingLobby !== 'everyone') throw new PolicyError('Choose who waits in the lobby: guests and people from outside, everyone, or only guests from a browser.');
          this.setMeta('policy_meeting_lobby', d.meetingLobby);
        }
        if (typeof d.guestLinks === 'boolean') this.setMeta('policy_guest_links', d.guestLinks ? '1' : '0');
        if (typeof d.joinBeforeHost === 'boolean') this.setMeta('policy_join_before_host', d.joinBeforeHost ? '1' : '0');
        if (d.recordingMaxMb !== undefined) {
          const v = d.recordingMaxMb;
          if (typeof v !== 'number' || !Number.isInteger(v) || v < 50 || v > 16384) throw new PolicyError('Choose a recording limit between 50 MB and 16 GB.');
          this.setMeta('policy_recording_mb', String(v));
        }
        if (d.dlp !== undefined) this.setMeta('policy_dlp', JSON.stringify(validDlpRules(d.dlp)));
        if (d.blockedFileTypes !== undefined) {
          if (!Array.isArray(d.blockedFileTypes)) throw new PolicyError('List file types like exe, bat, ps1.');
          const types = [...new Set(d.blockedFileTypes.map((t) => String(t).trim().toLowerCase().replace(/^\./, '')).filter((t) => /^[a-z0-9]{1,10}$/.test(t)))].slice(0, 100);
          this.setMeta('policy_blocked_types', JSON.stringify(types));
        }
        if (d.outsideNetworks !== undefined) {
          if (!Array.isArray(d.outsideNetworks)) throw new PolicyError('List networks like 203.0.113.0/24.');
          const nets = d.outsideNetworks.map((n) => String(n).trim()).filter(Boolean).slice(0, 100);
          const bad = nets.find((n) => !validCidr(n));
          if (bad) throw new PolicyError(`"${bad.slice(0, 60)}" is not an address or network. Write it like 203.0.113.0/24.`);
          this.setMeta('policy_outside_networks', JSON.stringify(nets));
        }
        if (Array.isArray(d.defaultSpaces)) this.setMeta('policy_default_spaces', JSON.stringify(d.defaultSpaces.filter((x): x is string => typeof x === 'string').slice(0, 30)));
        const p = this.get();
        this.files.maxBytes = this.uploadBytes();
        this.store.audit(me.id, 'policy.set', null, p);
        this.changed(p);
        return p satisfies Ops['admin.policy.set']['res'];
      }
      case 'admin.usage': {
        const days = typeof d.days === 'number' && [7, 30, 90].includes(d.days) ? d.days : 30;
        return this.usage(days) satisfies Ops['admin.usage']['res'];
      }
      default:
        return undefined;
    }
  }
}
