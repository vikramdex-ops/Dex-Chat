// Node/Electron hub client: the portable HubSession over a `ws` WebSocket with the hub's
// certificate checked by fingerprint, signing with the device's Ed25519 key.
import type { TLSSocket } from 'node:tls';
import WebSocket from 'ws';
import { signWith } from './identity.ts';
import type { DeviceIdentity } from './identity.ts';
import type { WindowsAccount } from './protocol.ts';
import { HubSession } from './session.ts';
import type { HubSocket, OpenSocket } from './session.ts';

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
    handshakeTimeout: 8000,
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

export class HubClient extends HubSession {
  constructor(opts: HubClientOptions) {
    super({
      deviceId: opts.identity.deviceId,
      publicKey: opts.identity.publicKey,
      sign: (payload) => signWith(opts.identity, payload),
      account: opts.account,
      open: openNodeSocket,
      requestTimeoutMs: opts.requestTimeoutMs,
      maxBackoffMs: opts.maxBackoffMs,
    });
  }
}
