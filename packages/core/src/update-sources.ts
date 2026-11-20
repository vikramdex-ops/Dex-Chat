// Where updates come from, and in which order a build is downloaded. Pure (no Node): shared by the
// desktop updater (main process) and the phone (WebView).
//
// Feeds are asked for at all the sources at once, and the newest build any of them knows wins:
//   hub-lan      the office hub's mirror, directly on the office network (pinned certificate)
//   hub-gateway  the same mirror through the internet gateway's encrypted channel, when the app is
//                connected that way (at home, on mobile data)
//   internet     the public feed on raw.githubusercontent.com
//   mirror       the same feed through jsDelivr, for networks where GitHub's raw files are blocked
// The build is then downloaded from the first route that offers exactly that file (same version,
// size and SHA-512), falling back to the next one when a route fails. Every route ends in the same
// size and SHA-512 check, so a route only decides speed, never trust.
import { chooseUpdate, compareVersions, feedUrl, mirrorFeedUrl } from './feed.ts';
import type { Channel, Platform, UpdateAsset, UpdateChoice, UpdateFeed } from './feed.ts';

export type UpdateSource = 'hub-lan' | 'hub-gateway' | 'internet' | 'mirror';
/** For the same version: the order a source is preferred in (the hub's LAN copy is the fastest). */
export const SOURCE_ORDER: readonly UpdateSource[] = ['hub-lan', 'hub-gateway', 'internet', 'mirror'];

/** How a source answered a check. */
export interface SourceResult {
  source: UpdateSource;
  feeds: UpdateFeed[];
  /** It answered at all; "nothing published here" (404) counts. */
  reachable: boolean;
}

/** What one source said, for the "what was tried" lines. */
export interface SourceReport { source: UpdateSource; ok: boolean }

export type DownloadRoute = 'hub-lan' | 'hub-gateway' | 'internet';
/** `url` is a path on the hub (/updates/files/…) for the hub routes, an https URL for the internet. */
export interface Route { route: DownloadRoute; url: string }

export interface UpdatePick extends UpdateChoice {
  /** The source whose feed was chosen. */
  source: UpdateSource;
  /** Where to download it from, in order. Never empty. */
  routes: Route[];
}

/** The URL of a channel's feed at an internet source. */
export const internetFeedUrl = (source: 'internet' | 'mirror', channel: Channel) => (source === 'internet' ? feedUrl(channel) : mirrorFeedUrl(channel));
/** The hub's copy of a channel's feed (the same path on the LAN and through the gateway). */
export const hubFeedPath = (channel: Channel) => `/updates/${channel}.json`;
const HUB_FILE = /^\/updates\/files\/\d+(?:\.\d+){1,3}\/[\w.\-]+$/;

/**
 * Ask every source for every channel at once. A fetcher resolves with the feed (or null: it
 * answered, with nothing usable, such as a 404) and rejects when the source cannot be reached.
 * Sources without a fetcher (no hub, not through the gateway) are left out.
 */
export async function checkSources(
  fetchers: Partial<Record<UpdateSource, (channel: Channel) => Promise<UpdateFeed | null>>>,
  channels: Channel[],
): Promise<SourceResult[]> {
  const sources = SOURCE_ORDER.filter((s) => fetchers[s]);
  return Promise.all(sources.map(async (source) => {
    const settled = await Promise.allSettled(channels.map((ch) => fetchers[source]!(ch)));
    return {
      source,
      feeds: settled.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : [])),
      reachable: settled.some((r) => r.status === 'fulfilled'),
    };
  }));
}

export const reportOf = (results: SourceResult[]): SourceReport[] => results.map((r) => ({ source: r.source, ok: r.reachable }));

/** The newest build for this platform at any source; for the same version, the earlier source in SOURCE_ORDER. */
export function pickUpdate(current: string, results: SourceResult[], platform: Platform): UpdatePick | null {
  let best: { choice: UpdateChoice; source: UpdateSource } | null = null;
  for (const source of SOURCE_ORDER) {
    const r = results.find((x) => x.source === source);
    if (!r) continue;
    const choice = chooseUpdate(current, r.feeds, platform);
    if (choice && (!best || compareVersions(choice.feed.version, best.choice.feed.version) > 0)) best = { choice, source };
  }
  if (!best) return null;
  const routes = downloadRoutes(best.choice, results, platform);
  return routes.length ? { ...best.choice, source: best.source, routes } : null;
}

/**
 * Every route that offers exactly the chosen file, best first:
 * - the hub on the office network: fast, and no internet needed;
 * - then, when GitHub's own feed answered, GitHub (its downloads very likely work too, and they do
 *   not use the office's upload), then the hub through the gateway;
 * - when GitHub's feed did not answer (blocked or unreliable on this network), the hub through the
 *   gateway first, then GitHub anyway.
 */
export function downloadRoutes(choice: UpdateChoice, results: SourceResult[], platform: Platform): Route[] {
  const offered = (source: UpdateSource): UpdateAsset | null => {
    for (const f of results.find((r) => r.source === source)?.feeds ?? []) {
      if (compareVersions(f.version, choice.feed.version) !== 0) continue;
      const a = f.assets.find((x) => x.platform === platform && x.sha512 === choice.asset.sha512 && x.size === choice.asset.size);
      if (a) return a;
    }
    return null;
  };
  const routes: Route[] = [];
  const lan = offered('hub-lan');
  if (lan && HUB_FILE.test(lan.url)) routes.push({ route: 'hub-lan', url: lan.url });
  const gwAsset = offered('hub-gateway');
  const gw: Route | null = gwAsset && HUB_FILE.test(gwAsset.url) ? { route: 'hub-gateway', url: gwAsset.url } : null;
  const netAsset = [offered('internet'), offered('mirror')].find((a) => a && /^https?:\/\//.test(a.url)) ?? null;
  const net: Route | null = netAsset ? { route: 'internet', url: netAsset.url } : null;
  const githubAnswered = !!results.find((r) => r.source === 'internet')?.reachable;
  for (const r of githubAnswered ? [net, gw] : [gw, net]) if (r) routes.push(r);
  return routes;
}

/** Download through each route in turn until one works. A cancelled download is not retried elsewhere. */
export async function tryRoutes<T>(routes: Route[], attempt: (r: Route) => Promise<T>, onFail?: (r: Route, err: Error) => void): Promise<{ value: T; route: Route }> {
  let last: Error = new Error('There is nowhere to download this update from.');
  for (const r of routes) {
    try {
      return { value: await attempt(r), route: r };
    } catch (err) {
      last = err instanceof Error ? err : new Error(String(err));
      if (last.name === 'AbortError') throw last;
      onFail?.(r, last);
    }
  }
  throw last;
}
