// Update feed format, validation and version choice. Pure: runs in Node, Electron and the
// Android WebView alike. Downloading lives in updates.ts (Node) and the Android native layer.

export type Channel = 'stable' | 'beta';
export type Platform = 'win-x64' | 'mac-arm64' | 'mac-x64' | 'android' | 'hub-win-x64';

export const PUBLIC_REPO = 'dexterity-admin/dexterity-connect';
export const FEED_BRANCH = 'update-feed';
export const feedUrl = (channel: Channel) => `https://raw.githubusercontent.com/${PUBLIC_REPO}/${FEED_BRANCH}/${channel}.json`;
/**
 * The same feed through a second CDN (jsDelivr serves files of a public branch), for networks where
 * raw.githubusercontent.com is blocked or unreliable (some Indian mobile networks). jsDelivr keeps a
 * branch's files for up to 12 hours, so this copy can lag behind a release; it is only a fallback,
 * and the newest version found anywhere wins.
 */
export const mirrorFeedUrl = (channel: Channel) => `https://cdn.jsdelivr.net/gh/${PUBLIC_REPO}@${FEED_BRANCH}/${channel}.json`;
/** Where people can always download the newest version by hand (opened in the browser). */
export const DOWNLOAD_PAGE = 'https://dexterity-admin.github.io/dexterity-connect/#download';

export interface UpdateAsset {
  platform: Platform;
  file: string;
  url: string;
  size: number;
  /** base64 SHA-512 of the file */
  sha512: string;
}

export interface UpdateFeed {
  schema: 1;
  channel: Channel;
  version: string;
  releasedAt: string;
  notes: string;
  /** Install as soon as possible and do not offer "later". */
  mandatory?: boolean;
  /** Installs older than this must update before continuing. */
  minVersion?: string;
  assets: UpdateAsset[];
}

const VERSION_RE = /^\d+(\.\d+){1,3}$/;
/** A base64 SHA-512 digest (64 bytes). A pattern rather than Buffer: this file also runs in the phone's WebView, which has no Buffer. */
const SHA512_RE = /^[A-Za-z0-9+/]{86}==$/;

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Strict validation: a feed comes from the network, so nothing is trusted until checked. */
export function parseFeed(value: unknown, opts: { allowHttp?: boolean } = {}): UpdateFeed | null {
  if (!value || typeof value !== 'object') return null;
  const f = value as Record<string, unknown>;
  if (f.schema !== 1 || (f.channel !== 'stable' && f.channel !== 'beta')) return null;
  if (typeof f.version !== 'string' || !VERSION_RE.test(f.version)) return null;
  if (!Array.isArray(f.assets)) return null;
  const platforms: Platform[] = ['win-x64', 'mac-arm64', 'mac-x64', 'android', 'hub-win-x64'];
  const assets: UpdateAsset[] = [];
  for (const a of f.assets as Array<Record<string, unknown>>) {
    if (!a || !platforms.includes(a.platform as Platform)) continue;
    if (typeof a.file !== 'string' || !/^[\w.\-]+$/.test(a.file)) continue;
    if (typeof a.url !== 'string' || !(opts.allowHttp ? /^(https?:\/\/|\/)/ : /^(https:\/\/|\/)/).test(a.url)) continue;
    if (typeof a.size !== 'number' || a.size <= 0) continue;
    if (typeof a.sha512 !== 'string' || !SHA512_RE.test(a.sha512)) continue;
    assets.push({ platform: a.platform as Platform, file: a.file, url: a.url, size: a.size, sha512: a.sha512 });
  }
  return {
    schema: 1,
    channel: f.channel,
    version: f.version,
    releasedAt: typeof f.releasedAt === 'string' ? f.releasedAt : '',
    notes: typeof f.notes === 'string' ? f.notes.slice(0, 20000) : '',
    mandatory: f.mandatory === true,
    minVersion: typeof f.minVersion === 'string' && VERSION_RE.test(f.minVersion) ? f.minVersion : undefined,
    assets,
  };
}

export interface UpdateChoice {
  feed: UpdateFeed;
  asset: UpdateAsset;
  mandatory: boolean;
}

/**
 * Pick the newest build for this platform that is newer than what is installed. Beta users
 * consider both feeds, so a stable release newer than the last beta still reaches them.
 */
export function chooseUpdate(current: string, feeds: Array<UpdateFeed | null>, platform: Platform): UpdateChoice | null {
  let best: UpdateChoice | null = null;
  for (const feed of feeds) {
    if (!feed) continue;
    const asset = feed.assets.find((a) => a.platform === platform);
    if (!asset || compareVersions(feed.version, current) <= 0) continue;
    if (!best || compareVersions(feed.version, best.feed.version) > 0) {
      const mandatory = !!feed.mandatory || (!!feed.minVersion && compareVersions(current, feed.minVersion) < 0);
      best = { feed, asset, mandatory };
    }
  }
  return best;
}
