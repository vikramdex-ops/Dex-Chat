// The setup check (Control room, top): what the hub can check about itself after it is installed,
// live, in place of a list of things to look at by hand. Each check passes, fails, needs someone to
// act (with the one thing to do), or is a check only a person can make (a phone on mobile data, a
// call between two PCs), which is never shown as passed. The types extend the hub protocol
// (protocol.ts) by declaration merging, so the request and event maps stay one map.
// See docs/GO-LIVE.md and apps/hub/src/setupcheck.ts.

/** pass: fine. fail: broken now. action: works, but someone has to do something. manual: a person checks it. info: worth knowing. */
export type SetupState = 'pass' | 'fail' | 'action' | 'manual' | 'info';

export interface SetupCheck {
  /** Stable id ("db.integrity"): other modules register theirs with their own prefix ("zoho.sync"). */
  id: string;
  /** What it is about, as a person reads it ("Backups"). */
  area: string;
  title: string;
  state: SetupState;
  /** What the hub found, one line. */
  detail: string;
  /** The one thing to do, when it is not a pass (null when there is nothing to do). */
  fix: string | null;
}

/** How backups were chosen when the hub started for the first time (apps/hub/src/firstrun.ts). */
export interface BackupAuto {
  /**
   * picked: the hub chose a folder on a second disk and set it up.
   * needs-disk: no safe place on this PC (one disk, or only another part of the same disk).
   * unsupported: the hub cannot look at the disks here (not Windows, or PowerShell did not answer).
   * failed: a disk was found but the folder could not be made private or written to.
   */
  state: 'picked' | 'needs-disk' | 'unsupported' | 'failed';
  at: number;
  /** The folder the hub chose (picked). */
  folder: string | null;
  /** What the hub found, in plain words. */
  message: string;
  /** What to do, when something has to be done. */
  action: string | null;
  /** The first backup after picking: did it work, and was it checked. */
  first: { ok: boolean; at: number; bytes: number; verified: boolean; error: string | null } | null;
}

export interface SetupReport {
  at: number;
  hub: { id: string; name: string; version: string; startedAt: number; uptimeSec: number };
  summary: Record<SetupState, number>;
  checks: SetupCheck[];
}

export const SETUP_STATE_WORD: Record<SetupState, string> = { pass: 'PASS', fail: 'FAIL', action: 'ACTION', manual: 'BY HAND', info: 'NOTE' };

/** Sort order on the sheet: what is broken first, then what needs doing, then what a person checks, then the passes. */
export const SETUP_STATE_ORDER: SetupState[] = ['fail', 'action', 'manual', 'info', 'pass'];

export function summarize(checks: SetupCheck[]): Record<SetupState, number> {
  const out: Record<SetupState, number> = { pass: 0, fail: 0, action: 0, manual: 0, info: 0 };
  for (const c of checks) out[c.state]++;
  return out;
}

/** "3 h 12 min", "4 days 2 h": how long the hub has been running. */
export function uptimeText(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d === 1 ? '1 day' : `${d} days`} ${h} h`;
  if (h) return `${h} h ${m} min`;
  return `${m} min`;
}

/** The report as plain text, for the owner to keep or send (Copy report, Download). */
export function setupReportText(r: SetupReport): string {
  const when = new Date(r.at);
  const p2 = (n: number) => String(n).padStart(2, '0');
  const stamp = `${when.getFullYear()}-${p2(when.getMonth() + 1)}-${p2(when.getDate())} ${p2(when.getHours())}:${p2(when.getMinutes())}`;
  const lines = [
    'DEXTERITY CONNECT · SETUP CHECK',
    `${r.hub.name} · version ${r.hub.version} · hub ${r.hub.id}`,
    `Checked ${stamp} (hub PC time) · running for ${uptimeText(r.hub.uptimeSec)}`,
    `${r.summary.pass} passed · ${r.summary.fail} failed · ${r.summary.action} need action · ${r.summary.manual} to check by hand`,
    '',
  ];
  const sorted = [...r.checks].sort((a, b) => SETUP_STATE_ORDER.indexOf(a.state) - SETUP_STATE_ORDER.indexOf(b.state));
  for (const c of sorted) {
    lines.push(`[${SETUP_STATE_WORD[c.state]}] ${c.area}: ${c.title}`);
    lines.push(`    ${c.detail}`);
    if (c.fix) lines.push(`    To do: ${c.fix}`);
  }
  return lines.join('\r\n') + '\r\n';
}

declare module './protocol.ts' {
  interface Ops {
    /** Administrators: every check the hub can make about itself, and the ones a person makes. */
    'admin.setup.report': { req: void; res: SetupReport };
  }
}
