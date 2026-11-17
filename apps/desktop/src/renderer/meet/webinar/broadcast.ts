// The PC composing a webinar's stage (the broadcaster: an organiser's PC on the office network
// when there is one; the hub chooses). It sends the composed stage three ways, as the hub asks:
//   - to the stage's relay room, for attendees on the office network (one video and one audio
//     track, however many watch);
//   - straight to each viewer the relay cannot reach, one RTCPeerConnection each (this PC
//     offers), at most 25: the hub keeps the count;
//   - as one-second WebM pieces to the hub, which hands them to ffmpeg for the live stream (a new
//     recording each time the hub asks for one: ffmpeg needs a stream from its start).
import type { Device, types } from 'mediasoup-client';
// the relay's client loads with the first call through the relay, not with the app
const loadDevice = async () => new (await import('mediasoup-client')).Device();
import type { ViewersMsg } from './store.ts';
import { webState } from './store.ts';
import type { Compositor } from './compositor.ts';

type Signal = { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit | null };
const relayReq = (op: string, params: Record<string, unknown>) => window.dex.request(op as never, params as never) as Promise<Record<string, unknown>>;

/** Bytes as base64, a slice at a time. */
function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export interface BroadcastStatus { direct: number; relay: boolean; streaming: boolean; error: string | null }

export class StageBroadcast {
  private readonly meetingId: string;
  private readonly comp: Compositor;
  private readonly onStatus: (s: BroadcastStatus) => void;
  private readonly pcs = new Map<string, RTCPeerConnection>();
  private ice: RTCIceServer[] = [];
  private device: Device | null = null;
  private send: types.Transport | null = null;
  private producers: types.Producer[] = [];
  private relayOn = false;
  private relayBusy: Promise<void> | null = null;
  private recorder: MediaRecorder | null = null;
  private epoch = -1;
  private seq = 0;
  private off: () => void;
  private closed = false;
  private error: string | null = null;

  constructor(meetingId: string, comp: Compositor, onStatus: (s: BroadcastStatus) => void) {
    this.meetingId = meetingId;
    this.comp = comp;
    this.onStatus = onStatus;
    this.off = window.dex.onHubEvent((name, data) => {
      const d = data as Record<string, unknown>;
      if (name === 'web.viewers' && d.meetingId === meetingId) this.apply(d as unknown as ViewersMsg);
      else if (name === 'web.signal' && d.meetingId === meetingId) void this.signal(String(d.fromDevice), d.data as Signal);
      else if (name === 'relay.reset' && this.relayOn) { this.closeRelay(); void this.openRelay(); }
    });
    void window.dex.request('room.ice').then((r) => { this.ice = r.iceServers as RTCIceServer[]; }).catch(() => {}).finally(() => {
      // the hub may have said whom to send to before this PC started composing
      const last = webState().viewers.get(meetingId);
      if (last) this.apply(last);
    });
  }

  private status(): void {
    this.onStatus({ direct: this.pcs.size, relay: this.relayOn && this.producers.length > 0, streaming: !!this.recorder && this.recorder.state === 'recording', error: this.error });
  }

  private apply(msg: ViewersMsg): void {
    if (this.closed) return;
    // viewers straight from this PC
    const want = new Set(msg.live ? msg.viewers.map((v) => v.deviceId) : []);
    for (const [dev, pc] of this.pcs) if (!want.has(dev)) { pc.close(); this.pcs.delete(dev); }
    for (const dev of want) if (!this.pcs.has(dev)) this.offer(dev);
    // the relay room
    if (msg.relay && !this.relayOn) void this.openRelay();
    else if (!msg.relay && this.relayOn) this.closeRelay();
    // the live stream
    if (msg.stream && (msg.epoch !== this.epoch || !this.recorder)) { this.epoch = msg.epoch; this.record(); }
    else if (!msg.stream && this.recorder) this.stopRecording();
    this.status();
  }

  // ---------------------------------------------------------------- straight to viewers
  private offer(deviceId: string): void {
    const pc = new RTCPeerConnection({ iceServers: this.ice, bundlePolicy: 'max-bundle' });
    this.pcs.set(deviceId, pc);
    for (const t of this.comp.stream.getTracks()) {
      const sender = pc.addTrack(t, this.comp.stream);
      if (t.kind === 'video') {
        const p = sender.getParameters();
        p.encodings = [{ ...(p.encodings?.[0] ?? {}), maxBitrate: 1_500_000 }];
        void sender.setParameters(p).catch(() => {});
      }
    }
    const sig = (data: Signal) => { void window.dex.request('web.signal', { id: this.meetingId, toDevice: deviceId, data }).catch(() => {}); };
    pc.onicecandidate = (e) => sig({ candidate: e.candidate ? e.candidate.toJSON() : null });
    pc.onnegotiationneeded = async () => {
      try { await pc.setLocalDescription(); sig({ description: pc.localDescription!.toJSON() }); } catch { /* the next negotiation tries again */ }
    };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') pc.restartIce(); this.status(); };
  }

  private async signal(from: string, data: Signal): Promise<void> {
    const pc = this.pcs.get(from);
    if (!pc) return;
    try {
      if (data.description?.type === 'answer') await pc.setRemoteDescription(data.description);
      else if (data.candidate !== undefined) await pc.addIceCandidate(data.candidate ?? undefined).catch(() => {});
    } catch { /* a stale answer */ }
  }

  // ---------------------------------------------------------------- the relay room
  private openRelay(): Promise<void> {
    if (this.relayBusy) return this.relayBusy;
    this.relayOn = true;
    this.relayBusy = (async () => {
      try {
        const { rtpCapabilities } = await relayReq('relay.caps', { stage: this.meetingId }) as { rtpCapabilities: types.RtpCapabilities };
        this.device = await loadDevice();
        await this.device.load({ routerRtpCapabilities: rtpCapabilities });
        const d = await relayReq('relay.transport', { stage: this.meetingId, direction: 'send' });
        const t = this.device.createSendTransport({ id: d.id, iceParameters: d.iceParameters, iceCandidates: d.iceCandidates, dtlsParameters: d.dtlsParameters } as types.TransportOptions);
        t.on('connect', ({ dtlsParameters }, ok, fail) => { relayReq('relay.connect', { transportId: t.id, dtlsParameters }).then(() => ok(), fail); });
        t.on('produce', ({ kind, rtpParameters, appData }, ok, fail) => {
          relayReq('relay.produce', { stage: this.meetingId, transportId: t.id, kind, rtpParameters, source: (appData as { source: string }).source }).then((r) => ok({ id: String(r.id) }), fail);
        });
        this.send = t;
        const video = this.comp.stream.getVideoTracks()[0];
        const audio = this.comp.stream.getAudioTracks()[0];
        if (video) this.producers.push(await t.produce({ track: video, appData: { source: 'camera' }, encodings: [{ maxBitrate: 1_800_000 }], codecOptions: { videoGoogleStartBitrate: 1000 } }));
        if (audio) this.producers.push(await t.produce({ track: audio, appData: { source: 'mic' } }));
        this.error = null;
      } catch (err) {
        this.error = `The office relay could not take the stage: ${(err as Error).message}`;
        this.relayOn = false;
      } finally {
        this.relayBusy = null;
        this.status();
      }
    })();
    return this.relayBusy;
  }

  private closeRelay(): void {
    this.relayOn = false;
    for (const p of this.producers) p.close();
    this.producers = [];
    this.send?.close();
    this.send = null;
    this.device = null;
  }

  // ---------------------------------------------------------------- the live stream
  private record(): void {
    this.stopRecording();
    const types = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8', 'video/webm'];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) ?? 'video/webm';
    const rec = new MediaRecorder(this.comp.stream, { mimeType, videoBitsPerSecond: 3_000_000, audioBitsPerSecond: 128_000 });
    this.recorder = rec;
    this.seq = 0;
    // pieces are sent in order: each waits for the one before it
    let chain = Promise.resolve();
    rec.ondataavailable = (e) => {
      if (!e.data.size || this.recorder !== rec) return;
      const seq = this.seq++;
      chain = chain.then(async () => {
        const data = base64(new Uint8Array(await e.data.arrayBuffer()));
        await window.dex.request('web.stream.chunk', { id: this.meetingId, seq, data }).catch(() => {});
      });
    };
    rec.onerror = () => { this.error = 'The live stream recording stopped on this PC.'; this.status(); };
    rec.start(1000);
    this.status();
  }

  private stopRecording(): void {
    const r = this.recorder;
    this.recorder = null;
    if (r && r.state !== 'inactive') r.stop();
  }

  /** The broadcaster stops composing (another PC took over, the stage closed). */
  close(): void {
    this.closed = true;
    this.off();
    this.stopRecording();
    this.closeRelay();
    for (const pc of this.pcs.values()) pc.close();
    this.pcs.clear();
  }
}
