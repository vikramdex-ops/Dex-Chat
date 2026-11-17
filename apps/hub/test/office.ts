// Shared test fixture: a hub on a random port with three approved people.
import { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIdentity } from '@dex/core';
import https from 'node:https';
import type { Conversation, Message } from '@dex/core';
import { HubClient } from '@dex/core/client';
import type { ClientState } from '@dex/core/client';
import { Hub } from '../src/hub.ts';
import type { HubOptions } from '../src/hub.ts';

export const cleanups: Array<() => unknown> = [];
after(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

export async function office(extra: Partial<HubOptions> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexmsg-'));
  const hub = new Hub({ dataDir: dir, port: 0, host: '127.0.0.1', discoveryPort: false, updates: false, ...extra });
  await hub.start();
  cleanups.push(async () => { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const join = async (username: string) => {
    const identity = createIdentity();
    const c = new HubClient({ identity, account: { username, domain: 'DEX', displayName: username[0].toUpperCase() + username.slice(1), hostname: `${username}-pc` } });
    cleanups.push(() => c.disconnect());
    c.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
    await until(c, (s) => s.kind === 'ready' || s.kind === 'pending');
    return { c, identity };
  };
  const owner = (await join('vikram')).c;
  const approve = async (username: string) => {
    const { c, identity } = await join(username);
    await owner.request('admin.decide', { deviceId: identity.deviceId, approve: true });
    await until(c, (s) => s.kind === 'ready');
    return c;
  };
  const priya = await approve('priya');
  const ravi = await approve('ravi');
  return { hub, owner, priya, ravi, join, dir };
}

export function until(c: HubClient, pred: (s: ClientState) => boolean, ms = 5000): Promise<void> {
  if (pred(c.state)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout in ${c.state.kind}`)), ms);
    const on = (s: ClientState) => { if (pred(s)) { clearTimeout(t); c.off('state', on); resolve(); } };
    c.on('state', on);
  });
}

export function nextEvent<T>(c: HubClient, name: string, pred: (d: T) => boolean = () => true, ms = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { c.off('event', on); reject(new Error(`no ${name}`)); }, ms);
    const on = (n: string, d: unknown) => { if (n === name && pred(d as T)) { clearTimeout(t); c.off('event', on); resolve(d as T); } };
    c.on('event', on);
  });
}

export const me = (c: HubClient) => c.session!.me.id;
let seq = 0;
export const nextClientId = () => `t${++seq}`;
export const send = (c: HubClient, convId: string, body: string, parentId?: string) => c.request('msg.send', { convId, body, parentId, clientId: `t${++seq}` });

