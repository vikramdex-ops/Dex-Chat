// How calls connect across networks. On the office LAN, PCs reach each other directly. A person
// at home or on mobile data is behind a router or carrier NAT, so calls need STUN (to learn the
// public address) and, often, a TURN relay. The administrator picks Cloudflare's TURN service
// (the hub mints short-lived credentials; the API token never leaves the hub) or their own TURN
// server. Media stays encrypted end to end (DTLS-SRTP); a TURN relay only forwards it.
import type { IceConfig, IceServer } from '@dex/core';

const CF_STUN: IceServer = { urls: ['stun:stun.cloudflare.com:3478'] };

export class Ice {
  private cache: { at: number; ttl: number; servers: IceServer[] } | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly getConfig: () => IceConfig & { token?: string };
  private readonly remoteOn: () => boolean;

  private readonly rtc: string;

  /** `rtc`: Cloudflare's Realtime API (a stand-in in tests: DEX_CLOUDFLARE_RTC, src/cfdeploy.ts). */
  constructor(getConfig: () => IceConfig & { token?: string }, remoteOn: () => boolean, fetchFn: typeof fetch = fetch, rtc = 'https://rtc.live.cloudflare.com') {
    this.rtc = rtc.replace(/\/+$/, '');
    this.getConfig = getConfig;
    this.remoteOn = remoteOn;
    this.fetchFn = fetchFn;
  }

  clear(): void { this.cache = null; }

  /** ICE servers for a call right now. Never throws: without a relay, calls still work on the LAN. */
  async servers(): Promise<IceServer[]> {
    const c = this.getConfig();
    if (c.mode === 'custom') return c.servers;
    if (c.mode === 'cloudflare' && c.keyId && c.token) {
      if (this.cache && Date.now() - this.cache.at < this.cache.ttl / 2) return this.cache.servers;
      try {
        const ttl = 24 * 3600;
        const r = await this.fetchFn(`${this.rtc}/v1/turn/keys/${encodeURIComponent(c.keyId)}/credentials/generate-ice-servers`, {
          method: 'POST',
          headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ ttl }),
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) throw new Error(`Cloudflare answered ${r.status}`);
        const j = await r.json() as { iceServers?: IceServer | IceServer[] };
        const list = (Array.isArray(j.iceServers) ? j.iceServers : j.iceServers ? [j.iceServers] : [])
          // browsers block port 53; Cloudflare lists it for other clients
          .map((s) => ({ ...s, urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53(\?|$)/.test(u)) }));
        this.cache = { at: Date.now(), ttl: ttl * 1000, servers: list };
        return list;
      } catch {
        return this.cache?.servers ?? [CF_STUN];
      }
    }
    return this.remoteOn() ? [CF_STUN] : [];
  }
}
