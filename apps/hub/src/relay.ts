// The relay for large Rooms: with more than 8 people, PCs no longer send to each other. Each sends
// its audio and video once to the hub, which passes it on to everyone else (a selective forwarding
// unit, mediasoup, ISC licence). Media stays on the office network and is encrypted (DTLS-SRTP)
// between each PC and the hub. Signalling uses the hub connection like everything else.
import fs from 'node:fs';
import path from 'node:path';
import type { types as ms } from 'mediasoup';
import { createRequire } from 'node:module';
import type { RelayProducer } from '@dex/core';

export class RelayError extends Error {}

interface Peer {
  roomId: string;
  userId: string;
  transports: Map<string, ms.WebRtcTransport>;
  producers: Map<string, { p: ms.Producer; source: RelayProducer['source'] }>;
  consumers: Map<string, ms.Consumer>;
}

const CODECS: ms.RouterRtpCodecCapability[] = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, parameters: { 'x-google-start-bitrate': 800 } },
  { kind: 'video', mimeType: 'video/H264', clockRate: 90000, parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1 } },
];

export interface RelayHost {
  /** The hub address PCs reach (their LAN view of this PC). */
  announced(): string;
  deliverToDevice(deviceId: string, name: string, data: unknown): void;
  log(level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>): void;
}

/** Where the mediasoup worker program is: beside the packaged hub, or in node_modules while developing. */
export function workerBin(): string | null {
  if (process.env.MEDIASOUP_WORKER_BIN && fs.existsSync(process.env.MEDIASOUP_WORKER_BIN)) return process.env.MEDIASOUP_WORKER_BIN;
  const beside = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'mediasoup-worker.exe' : 'mediasoup-worker');
  if (fs.existsSync(beside) && !/node(\.exe)?$/i.test(process.execPath)) return beside;
  try {
    // the package's main file is node/lib/index.js; the worker is built under worker/out/Release
    const dir = path.resolve(path.dirname(createRequire(import.meta.url).resolve('mediasoup')), '..', '..');
    const dev = path.join(dir, 'worker', 'out', 'Release', process.platform === 'win32' ? 'mediasoup-worker.exe' : 'mediasoup-worker');
    return fs.existsSync(dev) ? dev : null;
  } catch { return null; }
}

export class Relay {
  private readonly host: RelayHost;
  private worker: Promise<ms.Worker> | null = null;
  private broken = false;
  private readonly routers = new Map<string, Promise<ms.Router>>();
  /** by device */
  private readonly peers = new Map<string, Peer>();
  readonly ports: [number, number];

  constructor(host: RelayHost, ports: [number, number] = [47910, 47999]) {
    this.host = host;
    this.ports = ports;
  }

  /** Whether large Rooms can use the relay on this hub. */
  available(): boolean { return !this.broken && !!workerBin(); }

  private getWorker(): Promise<ms.Worker> {
    this.worker ??= (async () => {
      const bin = workerBin();
      if (!bin) throw new RelayError('The relay for large Rooms is not installed on this hub.');
      const mediasoup = await import('mediasoup');
      const w = await mediasoup.createWorker({ workerBin: bin, rtcMinPort: this.ports[0], rtcMaxPort: this.ports[1], logLevel: 'warn' });
      w.on('died', (err) => {
        this.host.log('error', 'relay worker stopped', { error: String(err) });
        this.worker = null;
        this.routers.clear();
        for (const [dev, p] of this.peers) this.host.deliverToDevice(dev, 'relay.reset', { roomId: p.roomId });
        this.peers.clear();
      });
      return w;
    })().catch((err) => { this.broken = true; this.worker = null; throw err; });
    return this.worker;
  }

  private router(roomId: string): Promise<ms.Router> {
    let r = this.routers.get(roomId);
    if (!r) {
      r = this.getWorker().then((w) => w.createRouter({ mediaCodecs: CODECS }));
      this.routers.set(roomId, r);
      r.catch(() => this.routers.delete(roomId));
    }
    return r;
  }

  private peer(deviceId: string, roomId: string, userId: string): Peer {
    let p = this.peers.get(deviceId);
    if (p && p.roomId !== roomId) { this.leave(deviceId); p = undefined; }
    if (!p) { p = { roomId, userId, transports: new Map(), producers: new Map(), consumers: new Map() }; this.peers.set(deviceId, p); }
    return p;
  }

  private findTransport(deviceId: string, id: unknown): ms.WebRtcTransport {
    const t = this.peers.get(deviceId)?.transports.get(String(id ?? ''));
    if (!t) throw new RelayError('That connection to the relay has closed. Rejoin the Room.');
    return t;
  }

  /** Everything the relay knows about one device's Room. `participants`: the devices in the Room now. */
  async handle(op: string, userId: string, deviceId: string, d: Record<string, unknown>, room: { id: string; participants: Array<{ deviceId: string; userId: string }> } | null): Promise<unknown> {
    switch (op) {
      case 'relay.caps': {
        if (!room) throw new RelayError('That Room has ended.');
        this.peer(deviceId, room.id, userId);
        return { rtpCapabilities: (await this.router(room.id)).rtpCapabilities };
      }
      case 'relay.transport': {
        if (!room) throw new RelayError('That Room has ended.');
        const p = this.peer(deviceId, room.id, userId);
        if (p.transports.size >= 4) throw new RelayError('Too many relay connections from this device.');
        const router = await this.router(room.id);
        const ip = '0.0.0.0';
        const t = await router.createWebRtcTransport({
          listenInfos: [{ protocol: 'udp', ip, announcedAddress: this.host.announced() }, { protocol: 'tcp', ip, announcedAddress: this.host.announced() }],
          enableUdp: true, enableTcp: true, preferUdp: true, initialAvailableOutgoingBitrate: 1_000_000,
          appData: { direction: d.direction === 'send' ? 'send' : 'recv' },
        });
        p.transports.set(t.id, t);
        return { id: t.id, iceParameters: t.iceParameters, iceCandidates: t.iceCandidates, dtlsParameters: t.dtlsParameters };
      }
      case 'relay.connect': {
        await this.findTransport(deviceId, d.transportId).connect({ dtlsParameters: d.dtlsParameters as ms.DtlsParameters });
        return { ok: true };
      }
      case 'relay.produce': {
        const p = this.peers.get(deviceId);
        if (!p || !room) throw new RelayError('Join the Room first.');
        const t = this.findTransport(deviceId, d.transportId);
        const kind = d.kind === 'audio' ? 'audio' : 'video';
        const source = (['mic', 'camera', 'screen', 'screen-audio'] as const).find((s) => s === d.source) ?? (kind === 'audio' ? 'mic' : 'camera');
        if ([...p.producers.values()].length >= 4) throw new RelayError('Too many tracks from this device.');
        const producer = await t.produce({ kind, rtpParameters: d.rtpParameters as ms.RtpParameters, appData: { source } });
        p.producers.set(producer.id, { p: producer, source });
        producer.on('transportclose', () => p.producers.delete(producer.id));
        const info: RelayProducer = { producerId: producer.id, userId, deviceId, kind, source };
        for (const other of room.participants) if (other.deviceId !== deviceId) this.host.deliverToDevice(other.deviceId, 'relay.producer', { roomId: room.id, ...info });
        return { id: producer.id };
      }
      case 'relay.producers': {
        if (!room) return [];
        const out: RelayProducer[] = [];
        for (const [dev, p] of this.peers) {
          if (p.roomId !== room.id || dev === deviceId) continue;
          for (const { p: pr, source } of p.producers.values()) out.push({ producerId: pr.id, userId: p.userId, deviceId: dev, kind: pr.kind, source });
        }
        return out;
      }
      case 'relay.consume': {
        const p = this.peers.get(deviceId);
        if (!p || !room) throw new RelayError('Join the Room first.');
        const router = await this.router(room.id);
        const producerId = String(d.producerId ?? '');
        if (!router.canConsume({ producerId, rtpCapabilities: d.rtpCapabilities as ms.RtpCapabilities })) throw new RelayError('This device cannot play that track.');
        const t = this.findTransport(deviceId, d.transportId);
        const c = await t.consume({ producerId, rtpCapabilities: d.rtpCapabilities as ms.RtpCapabilities, paused: true });
        p.consumers.set(c.id, c);
        const gone = () => { p.consumers.delete(c.id); this.host.deliverToDevice(deviceId, 'relay.producerClosed', { roomId: room.id, producerId }); };
        c.on('producerclose', gone);
        c.on('transportclose', () => p.consumers.delete(c.id));
        return { id: c.id, producerId, kind: c.kind, rtpParameters: c.rtpParameters };
      }
      case 'relay.resume': {
        const c = this.peers.get(deviceId)?.consumers.get(String(d.consumerId ?? ''));
        if (c) await c.resume();
        return { ok: true };
      }
      case 'relay.close': {
        const p = this.peers.get(deviceId);
        const pr = p?.producers.get(String(d.producerId ?? ''));
        if (pr) { pr.p.close(); p!.producers.delete(pr.p.id); }
        return { ok: true };
      }
      default:
        return undefined;
    }
  }

  /** A device left its Room (or disconnected): close its tracks; others are told by the consumers. */
  leave(deviceId: string): void {
    const p = this.peers.get(deviceId);
    if (!p) return;
    this.peers.delete(deviceId);
    for (const t of p.transports.values()) t.close();
  }

  /** The Room ended. */
  closeRoom(roomId: string): void {
    for (const [dev, p] of [...this.peers]) if (p.roomId === roomId) this.leave(dev);
    const r = this.routers.get(roomId);
    this.routers.delete(roomId);
    void r?.then((x) => x.close()).catch(() => {});
  }

  async stop(): Promise<void> {
    for (const dev of [...this.peers.keys()]) this.leave(dev);
    this.routers.clear();
    const w = this.worker;
    this.worker = null;
    if (w) await w.then((x) => x.close()).catch(() => {});
  }
}
