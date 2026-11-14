// The app's side of end-to-end encryption, used by the desktop main process and the phone
// bridge. It sits between the UI and the hub: Direct messages are sealed on the way out and
// opened on the way in, so the UI only ever sees text and the hub only ever sees envelopes.
import { isSealed, open, rawEd25519FromSpki, rewrap, safetyCode, seal, sealedFor, verifyDeviceKey, encKeyStatement } from './e2e.ts';
import type { DeviceKey } from './e2e.ts';
import type { Conversation, Message } from './protocol.ts';

export interface E2EHost {
  deviceId: string;
  /** X25519 key pair of this device (base64). */
  encSecret: string;
  encPublic: string;
  sign: (payload: Uint8Array) => string | Promise<string>;
  /** Raw hub request (not passed back through this layer). */
  request: (op: string, data?: unknown) => Promise<unknown>;
  log?: (msg: string, extra?: unknown) => void;
}

type ConvInfo = { kind: 'space' | 'direct'; members: string[] };
const KEY_TTL = 10 * 60_000;
const PLAIN_LIMIT = 8000;
const MAX_DEPTH = 7;

export class E2EClient {
  private readonly host: E2EHost;
  private meId = '';
  private published = false;
  private readonly keys = new Map<string, { at: number; list: DeviceKey[] }>();
  private readonly convs = new Map<string, ConvInfo>();
  private readonly msgConv = new Map<string, string>();
  private readonly schedConv = new Map<string, string>();
  /** messageId -> decrypted text (for previews, edits and forwards) */
  private readonly plain = new Map<string, string>();
  private bots = new Set<string>();

  constructor(host: E2EHost) {
    this.host = host;
  }

  /** Call after each sign-in. Publishes this device's key and shares history with new devices of yours. */
  async ready(meId: string, botIds: string[]): Promise<void> {
    this.meId = meId;
    this.bots = new Set(botIds);
    this.keys.clear();
    if (!this.published) {
      const sig = await this.host.sign(encKeyStatement(this.host.deviceId, this.host.encPublic));
      await this.host.request('e2e.publish', { encKey: this.host.encPublic, sig });
      this.published = true;
    }
    try {
      const list = await this.host.request('conv.list') as Conversation[];
      for (const c of list) this.convs.set(c.id, { kind: c.kind, members: c.members });
    } catch { /* not fatal */ }
    void this.shareHistory().catch((err) => this.host.log?.('history sharing failed', { error: (err as Error).message }));
  }

  /** The hub dropped the connection: publish again next time (the hub may have been rebuilt). */
  reset(): void {
    this.published = false;
  }

  setBots(ids: string[]): void { this.bots = new Set(ids); }

  // ------------------------------------------------------------ keys
  private offline = false;

  private async keysOf(userIds: string[], fresh = false): Promise<Map<string, DeviceKey[]>> {
    const want = this.offline ? [] : [...new Set(userIds)].filter((u) => fresh || !this.keys.has(u) || Date.now() - this.keys.get(u)!.at > KEY_TTL);
    if (want.length) {
      const got = await this.host.request('e2e.keys', { userIds: want }) as DeviceKey[];
      const by = new Map<string, DeviceKey[]>(want.map((u) => [u, []]));
      for (const k of got) if (verifyDeviceKey(k) && by.has(k.userId)) by.get(k.userId)!.push(k);
      for (const [u, list] of by) this.keys.set(u, { at: Date.now(), list });
    }
    return new Map(userIds.map((u) => [u, this.keys.get(u)?.list ?? []]));
  }

  private signKeyOf = (deviceId: string): Uint8Array | null => {
    for (const { list } of this.keys.values()) {
      const k = list.find((x) => x.deviceId === deviceId);
      if (k) return rawEd25519FromSpki(k.signKey);
    }
    return null;
  };

  private async conv(convId: string): Promise<ConvInfo | null> {
    if (!this.convs.has(convId) && !this.offline) {
      try {
        const list = await this.host.request('conv.list') as Conversation[];
        for (const c of list) this.convs.set(c.id, { kind: c.kind, members: c.members });
      } catch { return null; }
    }
    return this.convs.get(convId) ?? null;
  }

  /**
   * Devices to seal a message in this conversation for, or null to send it as it is:
   * only Direct conversations, and only when every member has at least one key.
   */
  async recipients(convId: string): Promise<DeviceKey[] | null> {
    const c = await this.conv(convId);
    if (!c || c.kind !== 'direct' || c.members.some((m) => this.bots.has(m))) return null;
    const keys = await this.keysOf(c.members);
    if ([...keys.values()].some((l) => l.length === 0)) {
      // someone may have just upgraded: ask the hub again once before giving up
      const again = await this.keysOf(c.members.filter((m) => !(keys.get(m)?.length)), true);
      if ([...again.values()].some((l) => l.length === 0)) return null;
      for (const [u, l] of again) keys.set(u, l);
    }
    return [...keys.values()].flat();
  }

  /** Whether a conversation's new messages are encrypted, and its safety code. */
  async status(convId: string): Promise<{ encrypted: boolean; code: string | null; missing: string[] }> {
    const c = await this.conv(convId);
    if (!c || c.kind !== 'direct') return { encrypted: false, code: null, missing: [] };
    const keys = await this.keysOf(c.members, true);
    const missing = c.members.filter((m) => !(keys.get(m)?.length));
    const all = [...keys.values()].flat();
    return { encrypted: !missing.length && !c.members.some((m) => this.bots.has(m)), code: missing.length ? null : safetyCode(all), missing };
  }

  private async sealFor(convId: string, text: string): Promise<string> {
    if (!text || isSealed(text)) return text;
    const rec = await this.recipients(convId);
    if (!rec) return text;
    return seal({ convId, text, senderDeviceId: this.host.deviceId, sign: this.host.sign, recipients: rec });
  }

  // ------------------------------------------------------------ outgoing
  async outgoing(op: string, data: unknown): Promise<unknown> {
    const d = (data ?? {}) as Record<string, unknown>;
    switch (op) {
      case 'msg.send':
      case 'sched.create':
        if (typeof d.convId === 'string' && typeof d.body === 'string') return { ...d, body: await this.sealFor(d.convId, d.body) };
        return data;
      case 'msg.edit': {
        const convId = typeof d.messageId === 'string' ? this.msgConv.get(d.messageId) : undefined;
        if (convId && typeof d.body === 'string') return { ...d, body: await this.sealFor(convId, d.body) };
        return data;
      }
      case 'sched.update': {
        const convId = typeof d.id === 'string' ? this.schedConv.get(d.id) : undefined;
        if (convId && typeof d.body === 'string') return { ...d, body: await this.sealFor(convId, d.body) };
        return data;
      }
      case 'msg.forward': {
        // a sealed message is re-sealed (or given as text) for every target
        const id = typeof d.messageId === 'string' ? d.messageId : '';
        const text = this.plain.get(id);
        if (text === undefined || !Array.isArray(d.convIds)) return data;
        const bodies: Record<string, string> = {};
        for (const t of d.convIds) if (typeof t === 'string') bodies[t] = await this.sealFor(t, text);
        return { ...d, bodies };
      }
    }
    return data;
  }

  // ------------------------------------------------------------ incoming
  /** Open every sealed message inside a response or event (returns a new value). */
  async incoming<T>(value: T): Promise<T> {
    return await this.walk(value, 0) as T;
  }

  private async walk(v: unknown, depth: number): Promise<unknown> {
    if (depth > MAX_DEPTH || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) {
      let changed = false;
      const out = await Promise.all(v.map(async (x) => { const y = await this.walk(x, depth + 1); if (y !== x) changed = true; return y; }));
      return changed ? out : v;
    }
    const o = v as Record<string, unknown>;
    let out: Record<string, unknown> | null = null;
    // conversations: remember members; show decrypted previews
    if (typeof o.id === 'string' && (o.kind === 'direct' || o.kind === 'space') && Array.isArray(o.members)) {
      this.convs.set(o.id, { kind: o.kind, members: o.members as string[] });
      const last = o.lastMessage as { id?: string; body?: string } | null;
      if (last && typeof last.id === 'string' && this.plain.has(last.id)) out = { ...o, lastMessage: { ...last, body: this.plain.get(last.id)!.slice(0, 280) } };
    }
    // messages (and scheduled messages, which carry convId and body too)
    if (typeof o.id === 'string' && typeof o.convId === 'string' && typeof o.body === 'string') {
      if ('sendAt' in o) this.schedConv.set(o.id, o.convId); else this.msgConv.set(o.id, o.convId);
      if (isSealed(o.body)) out = { ...(out ?? o), ...(await this.openOne(o as unknown as Message)) };
    }
    for (const [k, x] of Object.entries(o)) {
      if (x && typeof x === 'object') {
        const y = await this.walk(x, depth + 1);
        if (y !== x) { out ??= { ...o }; out[k] = y; }
      }
    }
    return out ?? o;
  }

  private async openOne(m: Pick<Message, 'id' | 'convId' | 'body'>): Promise<{ body: string; e2e: Message['e2e'] }> {
    let r = await open({ convId: m.convId, body: m.body, myDeviceId: this.host.deviceId, mySecret: this.host.encSecret, signKeyOf: this.signKeyOf });
    if ('text' in r && !r.verified) {
      // the sender's key may not be cached yet
      const conv = await this.conv(m.convId);
      if (conv) { await this.keysOf(conv.members).catch(() => null); r = await open({ convId: m.convId, body: m.body, myDeviceId: this.host.deviceId, mySecret: this.host.encSecret, signKeyOf: this.signKeyOf }); }
    }
    if ('error' in r) return { body: '', e2e: 'locked' };
    this.remember(m.id, r.text);
    return { body: r.text, e2e: r.verified ? 'ok' : 'unverified' };
  }

  private remember(id: string, text: string): void {
    this.plain.set(id, text);
    if (this.plain.size > PLAIN_LIMIT) this.plain.delete(this.plain.keys().next().value!);
  }

  /** A hub event about keys: forget cached keys; share history with a new device of mine. */
  async onEvent(name: string, data: unknown): Promise<void> {
    if (name !== 'e2e.keysChanged') return;
    const { userId } = data as { userId: string; deviceId: string };
    this.keys.delete(userId);
    if (userId === this.meId) await this.shareHistory().catch((err) => this.host.log?.('history sharing failed', { error: (err as Error).message }));
  }

  /** Wrap keys of my sealed Direct messages for my devices that cannot read them yet. */
  async shareHistory(limitPerConv = 400): Promise<number> {
    if (!this.meId) return 0;
    const mine = (await this.keysOf([this.meId], true)).get(this.meId) ?? [];
    const others = mine.filter((k) => k.deviceId !== this.host.deviceId);
    if (!others.length) return 0;
    let shared = 0;
    for (const [convId, c] of this.convs) {
      if (c.kind !== 'direct') continue;
      let before: string | undefined;
      for (let seen = 0; seen < limitPerConv;) {
        const page = await this.host.request('msg.list', { convId, before, limit: 100 }) as { messages: Message[]; hasMore: boolean };
        const items: Array<{ messageId: string; wraps: Record<string, string> }> = [];
        for (const m of page.messages) {
          if (!isSealed(m.body)) continue;
          const have = new Set(sealedFor(m.body));
          if (!have.has(this.host.deviceId)) continue;
          const need = others.filter((k) => !have.has(k.deviceId));
          if (!need.length) continue;
          const wraps = await rewrap({ body: m.body, myDeviceId: this.host.deviceId, mySecret: this.host.encSecret, devices: need });
          if (wraps) items.push({ messageId: m.id, wraps });
        }
        if (items.length) shared += (await this.host.request('e2e.addKeys', { items }) as { updated: number }).updated;
        seen += page.messages.length;
        // stop paging once the newest page is already shared (common case on each sign-in)
        if (!page.hasMore || !page.messages.length || (!items.length && seen >= 100)) break;
        before = page.messages[0].id;
      }
    }
    return shared;
  }

  // ------------------------------------------------------------ hub-off mode
  /** While the hub is unreachable, work only from what is cached (keys, conversations). */
  setOffline(offline: boolean): void { this.offline = offline; }

  /** Fetch and cache everyone's keys (for talking directly when the hub is off). */
  async cacheKeys(userIds: string[]): Promise<void> { await this.keysOf(userIds, true); }

  /** What to keep on disk so Direct messages still work after a restart with the hub off. */
  snapshot(): { meId: string; convs: Array<{ id: string } & ConvInfo>; keys: DeviceKey[] } {
    return { meId: this.meId, convs: [...this.convs].map(([id, c]) => ({ id, ...c })), keys: [...this.keys.values()].flatMap((k) => k.list) };
  }

  seed(snap: { meId: string; convs: Array<{ id: string } & ConvInfo>; keys: DeviceKey[] }): void {
    if (!this.meId) this.meId = snap.meId;
    for (const c of snap.convs) if (!this.convs.has(c.id)) this.convs.set(c.id, { kind: c.kind, members: c.members });
    const by = new Map<string, DeviceKey[]>();
    for (const k of snap.keys) if (verifyDeviceKey(k)) by.set(k.userId, [...(by.get(k.userId) ?? []), k]);
    for (const [u, list] of by) if (!this.keys.has(u)) this.keys.set(u, { at: 0, list });
  }

  /** Cached facts for the hub-off mode. */
  conversationOf(convId: string): ConvInfo | null { return this.convs.get(convId) ?? null; }
  deviceKey(deviceId: string): DeviceKey | null {
    for (const { list } of this.keys.values()) { const k = list.find((x) => x.deviceId === deviceId); if (k) return k; }
    return null;
  }
  devicesOf(userId: string): DeviceKey[] { return this.keys.get(userId)?.list ?? []; }
  get me(): string { return this.meId; }
  /** Seal a message for a Direct conversation, or null if it cannot be sealed. */
  async sealDirect(convId: string, text: string): Promise<string | null> {
    const sealed = await this.sealFor(convId, text);
    return isSealed(sealed) ? sealed : null;
  }

  /** Text of a message this device has opened (for forwarding and quoting). */
  textOf(messageId: string): string | undefined {
    return this.plain.get(messageId);
  }
}
