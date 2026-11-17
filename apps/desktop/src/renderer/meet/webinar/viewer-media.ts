// The stage, as an attendee's PC receives it. On the office network it comes through the hub's
// relay (two tracks, taken from the stage's relay room); from outside the office, or when the hub
// has no relay, the PC composing the stage sends it straight here (one RTCPeerConnection; that
// PC offers, this one answers, through TURN when the hub hands it out). Attendees never send.
import type { Device, types } from 'mediasoup-client';
// the relay's client loads with the first call through the relay, not with the app
const loadDevice = async () => new (await import('mediasoup-client')).Device();
import type { RelayProducer, StageRoute } from '@dex/core';

type Signal = { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit | null };
/** The relay ops for the stage carry the webinar's ID instead of a Room's (hub.ts finds the stage's relay room). */
const relayReq = (op: string, params: Record<string, unknown>) => window.dex.request(op as never, params as never) as Promise<Record<string, unknown>>;

export class StageViewer {
  private readonly meetingId: string;
  private readonly onStream: (s: MediaStream | null) => void;
  private route: StageRoute = 'none';
  private device: Device | null = null;
  private recv: types.Transport | null = null;
  private readonly consumers = new Map<string, types.Consumer>();
  /** Tracks announced while the relay connection was still being set up. */
  private pending: RelayProducer[] = [];
  private relayRoom: string | null = null;
  private pc: RTCPeerConnection | null = null;
  private pcFrom = '';
  private ice: RTCIceServer[] = [];
  private off: (() => void) | null = null;
  private closed = false;

  constructor(meetingId: string, onStream: (s: MediaStream | null) => void) {
    this.meetingId = meetingId;
    this.onStream = onStream;
    this.off = window.dex.onHubEvent((name, data) => {
      const d = data as Record<string, unknown>;
      if (name === 'web.signal' && d.meetingId === this.meetingId && this.route === 'direct') void this.signal(String(d.fromDevice), d.data as Signal);
      else if (name === 'relay.producer' && this.relayRoom && d.roomId === this.relayRoom) void this.consume(d as unknown as RelayProducer).catch(() => {});
      else if (name === 'relay.producerClosed' && this.relayRoom && d.roomId === this.relayRoom) this.dropProducer(String(d.producerId));
      else if (name === 'relay.reset' && this.route === 'relay') { const room = this.relayRoom?.slice(6) ?? null; this.route = 'none'; void this.setRoute('relay', room); }
    }) as unknown as () => void;
    void window.dex.request('room.ice').then((r) => { this.ice = r.iceServers as RTCIceServer[]; }).catch(() => {});
  }

  /** How this PC gets the stage now. */
  async setRoute(route: StageRoute, roomId: string | null): Promise<void> {
    if (this.closed) return;
    const was = this.route;
    this.route = route;
    this.relayRoom = roomId ? `stage:${roomId}` : null;
    if (route !== 'relay' || was === 'relay') this.closeRelay();
    if (route !== 'direct') this.closePc();
    if (route === 'relay') await this.openRelay().catch(() => { this.onStream(null); });
    else if (route !== 'direct') this.onStream(null);
  }

  // ---------------------------------------------------------------- through the relay
  private async openRelay(): Promise<void> {
    const { rtpCapabilities } = await relayReq('relay.caps', { stage: this.meetingId }) as { rtpCapabilities: types.RtpCapabilities };
    this.device = await loadDevice();
    await this.device.load({ routerRtpCapabilities: rtpCapabilities });
    const d = await relayReq('relay.transport', { stage: this.meetingId, direction: 'recv' });
    const t = this.device.createRecvTransport({ id: d.id, iceParameters: d.iceParameters, iceCandidates: d.iceCandidates, dtlsParameters: d.dtlsParameters } as types.TransportOptions);
    t.on('connect', ({ dtlsParameters }, ok, fail) => { relayReq('relay.connect', { transportId: t.id, dtlsParameters }).then(() => ok(), fail); });
    this.recv = t;
    const list = await relayReq('relay.producers', { stage: this.meetingId }) as unknown as RelayProducer[];
    for (const p of list) await this.consume(p);
    for (const p of this.pending.splice(0)) await this.consume(p);
  }

  private async consume(p: RelayProducer): Promise<void> {
    if (this.consumers.has(p.producerId)) return;
    if (!this.recv || !this.device) { if (this.route === 'relay') this.pending.push(p); return; }
    const d = await relayReq('relay.consume', { stage: this.meetingId, transportId: this.recv.id, producerId: p.producerId, rtpCapabilities: this.device.rtpCapabilities });
    const c = await this.recv.consume({ id: String(d.id), producerId: String(d.producerId), kind: d.kind as 'audio' | 'video', rtpParameters: d.rtpParameters as types.RtpParameters });
    this.consumers.set(p.producerId, c);
    // the relay room is named for the stage; producers announced there are this stage's
    await relayReq('relay.resume', { consumerId: c.id });
    this.publish();
  }

  private dropProducer(id: string): void {
    const c = this.consumers.get(id);
    if (!c) return;
    c.close();
    this.consumers.delete(id);
    this.publish();
  }

  private publish(): void {
    const tracks = [...this.consumers.values()].map((c) => c.track);
    this.onStream(tracks.length ? new MediaStream(tracks) : null);
  }

  private closeRelay(): void {
    this.pending = [];
    for (const c of this.consumers.values()) c.close();
    this.consumers.clear();
    this.recv?.close();
    this.recv = null;
    this.device = null;
  }

  // ---------------------------------------------------------------- straight from the stage's PC
  private async signal(from: string, data: Signal): Promise<void> {
    if (data.description?.type === 'offer' && (from !== this.pcFrom || !this.pc)) { this.closePc(); this.openPc(from); }
    const pc = this.pc;
    if (!pc || from !== this.pcFrom) return;
    try {
      if (data.description) {
        await pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') {
          await pc.setLocalDescription();
          void window.dex.request('web.signal', { id: this.meetingId, toDevice: from, data: { description: pc.localDescription!.toJSON() } }).catch(() => {});
        }
      } else if (data.candidate !== undefined) await pc.addIceCandidate(data.candidate ?? undefined).catch(() => {});
    } catch { /* the next offer recovers */ }
  }

  private openPc(from: string): void {
    const pc = new RTCPeerConnection({ iceServers: this.ice });
    this.pc = pc;
    this.pcFrom = from;
    pc.onicecandidate = (e) => { void window.dex.request('web.signal', { id: this.meetingId, toDevice: from, data: { candidate: e.candidate ? e.candidate.toJSON() : null } }).catch(() => {}); };
    pc.ontrack = (e) => this.onStream(e.streams[0] ?? new MediaStream([e.track]));
  }

  private closePc(): void {
    this.pc?.close();
    this.pc = null;
    this.pcFrom = '';
  }

  close(): void {
    this.closed = true;
    this.off?.();
    this.closeRelay();
    this.closePc();
  }
}
