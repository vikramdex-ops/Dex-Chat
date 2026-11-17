// The hub updating itself (apps/hub/src/hub-update.ts): the office installs the hub once with
// DexterityConnectHub-Setup.exe, and from then on the hub finds newer builds in the release feed,
// downloads and checks the setup, and runs it itself at a quiet time (03:00 by default, after the
// night's backup, never while a meeting or call is live). If the new version does not start, the
// setup puts the old one back and the hub does not try that version again by itself.
// The types extend the hub protocol (protocol.ts) by declaration merging.
import type { Channel } from './feed.ts';

export interface HubUpdateConfig {
  /** Install new versions by itself at `time` (default on). */
  auto: boolean;
  /** Start of the quiet window, hub-local time ("03:00"). The window lasts two hours. */
  time: string;
  /** stable: what everyone gets. beta: also builds published for trying out. */
  channel: Channel;
}

export const HUB_UPDATE_DEFAULTS: HubUpdateConfig = { auto: true, time: '03:00', channel: 'stable' };
/** How long the quiet window stays open: a meeting still going at 03:00 can end by 05:00. */
export const HUB_UPDATE_WINDOW_MS = 2 * 3600_000;

/** One update the hub ran (or tried), newest first in the history. */
export interface HubUpdateRun {
  at: number;
  from: string;
  to: string;
  ok: boolean;
  /** Who pressed "Update now" (a user id), or null when the hub did it at its quiet time. */
  by: string | null;
  /** What happened, in plain words. */
  message: string;
  /** The setup log on the hub PC, when there is something to read in it. */
  log: string | null;
  /** fresh: a backup made just before; recent: tonight's backup; none: backups are not set up. */
  backup: 'fresh' | 'recent' | 'none';
}

/**
 * Why an update that is due is waiting: something live on the hub (it waits until that ends, up
 * to the end of the quiet window), the night's backup still running, the backup before the update,
 * or that backup having failed with no other good backup in the last day (it waits for the next
 * quiet window). The Control room words each one.
 */
export type HubUpdateWait = 'webinar' | 'meeting' | 'call' | 'backup-running' | 'backing-up' | 'backup-failed';

export interface HubUpdateView {
  /** The version running now. */
  version: string;
  /** False when this hub cannot install updates itself (not the installed Windows service). */
  supported: boolean;
  unsupportedReason: string | null;
  config: HubUpdateConfig;
  lastCheck: number | null;
  lastError: string | null;
  checking: boolean;
  /** A newer version in the feed for this hub's channel (null when this hub is the newest). */
  available: { version: string; channel: Channel; size: number; releasedAt: string; notes: string } | null;
  /** The newer version's setup is on the hub and its size and SHA-512 matched the feed. */
  downloaded: boolean;
  /** When it installs, if nothing stops it. */
  nextAt: number | null;
  /** Why it is waiting right now, or null. */
  waiting: HubUpdateWait | null;
  /** The setup is running: the hub goes offline for about a minute. */
  installing: { version: string; since: number } | null;
  /** The last version that did not work. The hub does not try it again by itself. */
  failed: { version: string; at: number; message: string; log: string | null } | null;
  /** "Update now" was pressed: it installs as soon as no meeting is live (or at once, forced). */
  requested: { by: string; force: boolean; at: number } | null;
  history: HubUpdateRun[];
  /** Where the setup writes what it did, on the hub PC. */
  setupLog: string;
}

declare module './protocol.ts' {
  interface Ops {
    /** Administrators: the hub's version and its updates; `check` looks at the feed now. */
    'admin.hubUpdate.get': { req: { check?: boolean } | void; res: HubUpdateView };
    'admin.hubUpdate.set': { req: Partial<HubUpdateConfig>; res: HubUpdateView };
    /** Install the newer version now: waits until no meeting is live, unless `force`. */
    'admin.hubUpdate.now': { req: { force?: boolean }; res: HubUpdateView };
    /** Let the hub try a version that did not work again (at the next quiet time, or "Update now"). */
    'admin.hubUpdate.retry': { req: void; res: HubUpdateView };
  }
  interface Events {
    'admin.hubUpdate': HubUpdateView;
  }
}
