// Node/Electron hub client: the portable HubSession over a `ws` WebSocket with the hub's
// certificate checked by fingerprint, signing with the device's Ed25519 key.
import type { TLSSocket } from 'node:tls';
import WebSocket from 'ws';
import { signWith } from './identity.ts';
import type { DeviceIdentity } from './identity.ts';
import type { WindowsAccount } from './protocol.ts';
import { HubSession } from './session.ts';
import type { HubSocket, HubTarget, OpenSocket } from './session.ts';
import { openRemoteSocket } from './remote.ts';
import type { OpenRaw } from './remote.ts';

export type { ClientState, HubTarget } from './session.ts';

export interface HubClientOptions {
  identity: DeviceIdentity;
  account: WindowsAccount;
  requestTimeoutMs?: number;
  maxBackoffMs?: number;
}

export const openNodeSocket: OpenSocket = (target, h) => {
  const host = target.host.includes(':') ? `[${target.host}]` : target.host;
  const ws = new WebSocket(`wss://${host}:${target.port}/ws`, {
    rejectUnauthorized: false, // trust comes from the pinned fingerprint, checked by the session
    // with a gateway to fall back on, do not wait long for an office network that is not there
    handshakeTimeout: target.remote ? 3500 : 8000,
    maxPayload: 8 * 1024 * 1024,
  });
  let closed = false;
  const close = (reason: string) => { if (!closed) { closed = true; h.onClose(reason); } };
  ws.on('upgrade', (res) => {
    h.onOpen((res.socket as TLSSocket).getPeerX509Certificate?.()?.fingerprint256 ?? '');
  });
  ws.on('message', (raw) => h.onMessage(raw.toString()));
  ws.on('close', () => close('connection closed'));
  ws.on('error', (err) => close(err.message));
  const sock: HubSocket = {
    send: (data) => { if (ws.readyState === WebSocket.OPEN) ws.send(data); },
    close: () => { closed = true; ws.removeAllListeners(); ws.on('error', () => {}); ws.terminate(); },
  };
  return sock;
};

/** A binary WebSocket to the internet gateway, with ordinary certificate checks (Cloudflare's). */
export const openNodeRaw: OpenRaw = (url, h) => {
  const ws = new WebSocket(url, { handshakeTimeout: 15000, maxPayload: 2 * 1024 * 1024 });
  let closed = false;
  const close = (reason: string) => { if (!closed) { closed = true; h.onClose(reason); } };
  ws.on('open', () => h.onOpen());
  ws.on('message', (raw, isBinary) => { if (isBinary) { const b = raw as Buffer; h.onBinary(new Uint8Array(b.buffer, b.byteOffset, b.length)); } });
  ws.on('close', (code, reason) => close(reason.toString() || (code === 4404 ? 'The office hub is not connected to the gateway' : 'connection closed')));
  ws.on('error', (err) => close(err.message));
  return {
    send: (data) => { if (ws.readyState === WebSocket.OPEN) ws.send(data); },
    close: () => { closed = true; ws.removeAllListeners(); ws.on('error', () => {}); ws.terminate(); },
  };
};

export const openNodeRemote: OpenSocket = (target, h) => {
  if (!target.remote) throw new Error('no gateway for this hub');
  return openRemoteSocket(openNodeRaw, target as HubTarget & { remote: { url: string; hubId: string } }, h);
};

export class HubClient extends HubSession {
  constructor(opts: HubClientOptions) {
    super({
      deviceId: opts.identity.deviceId,
      publicKey: opts.identity.publicKey,
      sign: (payload) => signWith(opts.identity, payload),
      account: opts.account,
      open: openNodeSocket,
      openRemote: openNodeRemote,
      requestTimeoutMs: opts.requestTimeoutMs,
      maxBackoffMs: opts.maxBackoffMs,
    });
  }
}
