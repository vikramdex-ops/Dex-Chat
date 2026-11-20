// Which way a phone tries first when it (re)connects to the hub: the office network, or the
// internet gateway. A phone on mobile data cannot reach the office's LAN address, and waiting for
// that attempt to time out (seconds) before trying the gateway made every reopen show
// "Connecting…". The way that worked last on this kind of network is remembered.

export type NetworkKind = 'wifi' | 'cellular' | 'other';
export type RouteMemory = Partial<Record<NetworkKind, 'lan' | 'remote'>>;

/** What the WebView says the phone is connected through (Network Information API), roughly. */
export function networkKind(conn: { type?: string } | undefined | null): NetworkKind {
  const t = conn?.type;
  if (t === 'wifi' || t === 'ethernet') return 'wifi';
  if (t === 'cellular' || t === 'wimax') return 'cellular';
  return 'other';
}

/**
 * Try the gateway first? Only when the hub has one and the phone knows an office address too (with
 * only one of them there is no choice). On mobile data always; otherwise when the gateway is the
 * way that worked last time on this kind of network.
 */
export function preferGateway(o: { network: NetworkKind; memory: RouteMemory | undefined; hasGateway: boolean; hasOfficeAddress: boolean }): boolean {
  if (!o.hasGateway || !o.hasOfficeAddress) return false;
  if (o.network === 'cellular') return true;
  return o.memory?.[o.network] === 'remote';
}

/** Remember the way that just worked on this kind of network; returns the memory unchanged when nothing changed. */
export function rememberRoute(memory: RouteMemory | undefined, network: NetworkKind, via: 'lan' | 'remote'): RouteMemory {
  const m = memory ?? {};
  return m[network] === via ? m : { ...m, [network]: via };
}
