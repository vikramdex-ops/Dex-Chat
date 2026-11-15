// The app's side of a large Room: one connection out to the hub's relay (mediasoup-client) for
// this PC's microphone, camera and screen, and one in, carrying everyone else's.
import type { Device, types } from 'mediasoup-client';
// the relay's client loads with the first call through the relay, not with the app
const loadDevice = async () => new (await import('mediasoup-client')).Device();
import type { RelayProducer } from '@dex/core';

type Source = RelayProducer['source'];
export interface RelayPeer { deviceId: string; userId: string; streams: MediaStream[] }

export class RelayClient {
  readonly roomId: string;
  private device: Device | null = null;
  private send: types.Transport | null = null;
  private recv: types.Transport | null = null;
  /** by local track id */
  private readonly producers = new Map<string, types.Producer>();
  /** by producer id */
  private readonly incoming = new Map<string, { consumer: types.Consumer; deviceId: string; userId: string; source: Source }>();
  private readonly changed: (peers: Map<string, RelayPeer>) => void;
  private closed = false;
  private pending: RelayProducer[] = [];

  constructor(roomId: string, changed: (peers: Map<string, RelayPeer>) => void) {
    this.roomId = roomId;
    this.changed = changed;
  }

  async join(local: MediaStream | null, screen: MediaStream | null): Promise<void> {
    const { rtpCapabilities } = await window.dex.request('relay.caps', { roomId: this.roomId });
    this.device = await loadDevice();
    await this.device.load({ routerRtpCapabilities: rtpCapabilities as types.RtpCapabilities });
    this.send = await this.transport('send');
    this.recv = await this.transport('recv');
    for (const t of local?.getTracks() ?? []) await this.add(t, t.kind === 'audio' ? 'mic' : 'camera');
    for (const t of screen?.getTracks() ?? []) await this.add(t, t.kind === 'audio' ? 'screen-audio' : 'screen');
    for (const p of await window.dex.request('relay.producers', { roomId: this.roomId })) await this.consume(p);
    for (const p of this.pending.splice(0)) await this.consume(p);
  }

  private async transport(direction: 'send' | 'recv'): Promise<types.Transport> {
    const d = await window.dex.request('relay.transport', { roomId: this.roomId, direction });
    const opts = { id: d.id, iceParameters: d.iceParameters, iceCandidates: d.iceCandidates, dtlsParameters: d.dtlsParameters } as types.TransportOptions;
    const t = direction === 'send' ? this.device!.createSendTransport(opts) : this.device!.createRecvTransport(opts);
    t.on('connect', ({ dtlsParameters }, ok, fail) => { window.dex.request('relay.connect', { transportId: t.id, dtlsParameters }).then(() => ok(), fail); });
    if (direction === 'send') {
      t.on('produce', ({ kind, rtpParameters, appData }, ok, fail) => {
        window.dex.request('relay.produce', { transportId: t.id, kind, rtpParameters, source: (appData as { source: Source }).source }).then(({ id }) => ok({ id }), fail);
      });
    }
    return t;
  }

  /** Send a local track to the Room. */
  async add(track: MediaStreamTrack, source: Source): Promise<void> {
    if (!this.send || this.closed || this.producers.has(track.id)) return;
    const p = await this.send.produce({
      track, appData: { source },
      ...(source === 'camera' ? { encodings: [{ maxBitrate: 900_000 }], codecOptions: { videoGoogleStartBitrate: 600 } } : {}),
    });
    this.producers.set(track.id, p);
  }

  /** Stop sending a local track. */
  remove(track: MediaStreamTrack): void {
    const p = this.producers.get(track.id);
    if (!p) return;
    this.producers.delete(track.id);
    p.close();
    void window.dex.request('relay.close', { producerId: p.id }).catch(() => {});
  }

  /** Send another track in place of one (blur on or off). */
  async replace(from: MediaStreamTrack, to: MediaStreamTrack): Promise<void> {
    const p = this.producers.get(from.id);
    if (!p) return;
    await p.replaceTrack({ track: to });
    this.producers.delete(from.id);
    this.producers.set(to.id, p);
  }

  /** Someone else's track: play it. */
  async consume(info: RelayProducer): Promise<void> {
    if (this.closed || this.incoming.has(info.producerId)) return;
    if (!this.recv || !this.device) { this.pending.push(info); return; }
    const d = await window.dex.request('relay.consume', { transportId: this.recv.id, producerId: info.producerId, rtpCapabilities: this.device.rtpCapabilities });
    const consumer = await this.recv.consume({ id: d.id, producerId: d.producerId, kind: d.kind, rtpParameters: d.rtpParameters as types.RtpParameters });
    this.incoming.set(info.producerId, { consumer, deviceId: info.deviceId, userId: info.userId, source: info.source });
    await window.dex.request('relay.resume', { consumerId: consumer.id });
    this.publish();
  }

  /** Someone stopped sending a track, or left. */
  drop(producerId: string): void {
    const c = this.incoming.get(producerId);
    if (!c) return;
    c.consumer.close();
    this.incoming.delete(producerId);
    this.publish();
  }

  /** Forget everyone on devices that are no longer in the Room. */
  keepOnly(deviceIds: Set<string>): void {
    let changed = false;
    for (const [id, c] of this.incoming) if (!deviceIds.has(c.deviceId)) { c.consumer.close(); this.incoming.delete(id); changed = true; }
    if (changed) this.publish();
  }

  private publish(): void {
    const by = new Map<string, { userId: string; main: MediaStreamTrack[]; screen: MediaStreamTrack[] }>();
    for (const c of this.incoming.values()) {
      const e = by.get(c.deviceId) ?? { userId: c.userId, main: [], screen: [] };
      (c.source === 'screen' || c.source === 'screen-audio' ? e.screen : e.main).push(c.consumer.track);
      by.set(c.deviceId, e);
    }
    const peers = new Map<string, RelayPeer>();
    for (const [deviceId, e] of by) {
      const streams = [new MediaStream(e.main)];
      if (e.screen.length) streams.push(new MediaStream(e.screen));
      peers.set(deviceId, { deviceId, userId: e.userId, streams });
    }
    this.changed(peers);
  }

  /** For the call's quality line: the worst round trip and loss on the two connections. */
  async stats(): Promise<RTCStatsReport[]> {
    const out: RTCStatsReport[] = [];
    for (const t of [this.send, this.recv]) if (t) try { out.push(await t.getStats()); } catch { /* closed */ }
    return out;
  }

  close(): void {
    this.closed = true;
    for (const p of this.producers.values()) p.close();
    for (const c of this.incoming.values()) c.consumer.close();
    this.producers.clear();
    this.incoming.clear();
    this.send?.close();
    this.recv?.close();
  }
}
