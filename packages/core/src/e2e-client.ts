// The app's side of end-to-end encryption, used by the desktop main process and the phone
// bridge. It sits between the UI and the hub: Direct messages are sealed on the way out and
// opened on the way in, so the UI only ever sees text and the hub only ever sees envelopes.
import { isSealed, open, rawEd25519FromSpki, rewrap, safetyCode, seal, sealedFor, verifyDeviceKey, encKeyStatement } from './e2e.ts';
import type { DeviceKey } from './e2e.ts';
import { decryptFile, encryptFile, newFileSecret, sealedFileSize } from './e2e-files.ts';
import type { FileSecret, SealedFileMeta } from './e2e-files.ts';
import type { Conversation, FileInfo, Message, OfficePolicy, PublicUser } from './protocol.ts';
import { applyDlp, dlpBlockedMessage } from './dlp.ts';
import type { DlpRule } from './dlp.ts';

export interface E2EHost {
  deviceId: string;
  /** X25519 key pair of this device (base64). */
  encSecret: string;
  encPublic: string;
  sign: (payload: Uint8Array) => string | Promise<string>;
  /** Raw hub request (not passed back through this layer). */
  request: (op: string, data?: unknown) => Promise<unknown>;
  log?: (msg: string, extra?: unknown) => void;
  /** A colleague's display name, for explanations ("Ravi Kumar needs to update"). */
  nameOf?: (userId: string) => string | undefined;
}

/** Why a file cannot go into a conversation that stopped being end-to-end encrypted after it was attached. */
export const FILES_NEED_E2E = 'This conversation is no longer end-to-end encrypted, so the encrypted files attached to this message cannot be sent. Remove them and attach them again.';
export const FORWARD_FILES_NEED_E2E = 'Encrypted files can only be forwarded to Direct conversations that are end-to-end encrypted. Save the file and attach it there instead.';

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', zip: 'application/zip', mp4: 'video/mp4', webm: 'audio/webm',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  dwg: 'image/vnd.dwg', dxf: 'image/vnd.dxf',
};
/** The type the hub would have given a file of this name (it cannot see an encrypted file's name). */
export function mimeFromName(name: string): string {
  return MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

/** The office requires end-to-end encryption and someone in the conversation has no key yet. */
export function encryptionRequiredMessage(names: string[]): string {
  const who = names.length ? names.join(', ') : 'Someone in this conversation';
  return `Your office requires Direct messages to be end-to-end encrypted. ${who} ${names.length > 1 ? 'need' : 'needs'} to update Dexterity Connect (or open it once) before you can send messages here.`;
}

type ConvInfo = { kind: 'space' | 'direct'; members: string[] };
type Bytes = AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

/** How to upload one file: where, how many bytes, and how its bytes are changed on the way. */
export interface UploadPlan {
  /** The hub path to POST to (with the name and type, or "sealed" for an encrypted file). */
  path: string;
  /** Bytes the hub receives (an encrypted file is a little larger). */
  size: number;
  /** Encrypted on this device, for an end-to-end encrypted Direct conversation. */
  sealed: boolean;
  /** The file's bytes as uploaded: unchanged, or encrypted chunk by chunk. */
  transform: (src: Bytes) => AsyncIterable<Uint8Array>;
  /** What the app shows once the hub answers: for an encrypted file, its real name, type and size. */
  done: (info: FileInfo) => FileInfo;
}

async function* passThrough(src: Bytes): AsyncIterable<Uint8Array> { for await (const p of src) yield p; }
const KEY_TTL = 10 * 60_000;
const PLAIN_LIMIT = 8000;
const FILE_KEYS_LIMIT = 8000;
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
  /** fileId -> key and real name of an encrypted attachment (uploads from here, and opened messages) */
  private readonly fileKeys = new Map<string, SealedFileMeta>();
  /** messageId (or scheduled message id) -> its encrypted attachments, to keep them on an edit or forward */
  private readonly msgFiles = new Map<string, SealedFileMeta[]>();
  /** messages fetched to find the key of a file listed on its own (the Files panel) */
  private readonly fetching = new Map<string, Promise<void>>();
  private bots = new Set<string>();
  /** Office policy: file types that cannot be shared, and whether Direct messages must be encrypted. */
  private blockedTypes: string[] = [];
  private requireE2E = false;

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
    // the office's data-loss rules apply to sealed messages here, before the hub sees them
    try {
      const policy = (await this.host.request('policy.get')) as OfficePolicy;
      this.applyPolicy(policy);
      if (this.dlp.length) this.guests = new Set(((await this.host.request('directory.list')) as { users: PublicUser[] }).users.filter((u) => u.role === 'guest').map((u) => u.id));
    } catch { /* not fatal: the hub applies the rules to everything it can read */ }
    void this.shareHistory().catch((err) => this.host.log?.('history sharing failed', { error: (err as Error).message }));
  }

  /** The hub dropped the connection: publish again next time (the hub may have been rebuilt). */
  reset(): void {
    this.published = false;
  }

  setBots(ids: string[]): void { this.bots = new Set(ids); }

  private applyPolicy(p: OfficePolicy): void {
    this.dlp = p.dlp ?? [];
    this.blockedTypes = p.blockedFileTypes ?? [];
    this.requireE2E = p.requireE2E === true;
  }

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
  async status(convId: string): Promise<{ encrypted: boolean; code: string | null; missing: string[]; required?: boolean }> {
    const c = await this.conv(convId);
    if (!c || c.kind !== 'direct') return { encrypted: false, code: null, missing: [] };
    const keys = await this.keysOf(c.members, true);
    const missing = c.members.filter((m) => !(keys.get(m)?.length));
    const all = [...keys.values()].flat();
    const bot = c.members.some((m) => this.bots.has(m));
    return { encrypted: !missing.length && !bot, code: missing.length ? null : safetyCode(all), missing, required: this.requireE2E && !bot };
  }

  /** Does the office's policy stop plain messages in this conversation? (Direct, with no integration in it.) */
  private async mustEncrypt(convId: string): Promise<boolean> {
    if (!this.requireE2E) return false;
    const c = await this.conv(convId);
    return !!c && c.kind === 'direct' && !c.members.some((m) => this.bots.has(m));
  }

  private async requiredError(convId: string): Promise<Error> {
    const c = await this.conv(convId);
    const keys = c ? await this.keysOf(c.members).catch(() => new Map<string, DeviceKey[]>()) : new Map<string, DeviceKey[]>();
    const missing = (c?.members ?? []).filter((m) => !(keys.get(m)?.length));
    const names = missing.map((m) => (m === this.meId ? 'This device' : this.host.nameOf?.(m))).filter((n): n is string => !!n);
    return new Error(encryptionRequiredMessage(names));
  }

  // ------------------------------------------------------------ files
  /**
   * Should a file shared in this conversation be encrypted on this device first? Returns the
   * file's new secret, or null for an ordinary upload (Spaces, integrations, people without keys).
   * The office's blocked file types are checked here, because the hub only ever sees "sealed".
   */
  async fileSecretFor(convId: string | undefined, name: string): Promise<FileSecret | null> {
    if (!convId) return null;
    const rec = await this.recipients(convId);
    if (!rec) {
      if (await this.mustEncrypt(convId)) throw await this.requiredError(convId);
      return null;
    }
    const ext = name.toLowerCase().match(/\.([a-z0-9]{1,10})$/)?.[1];
    if (ext && this.blockedTypes.includes(ext)) throw new Error(`Your office doesn't allow .${ext} files to be shared.`);
    return newFileSecret();
  }

  /** Plan an upload: encrypted on this device when it is for an end-to-end encrypted Direct conversation. */
  async planUpload(convId: string | undefined, file: { name: string; mime?: string; size: number }): Promise<UploadPlan> {
    const secret = await this.fileSecretFor(convId, file.name);
    if (!secret) {
      return {
        path: `/files?name=${encodeURIComponent(file.name)}${file.mime ? `&type=${encodeURIComponent(file.mime)}` : ''}`,
        size: file.size, sealed: false, transform: passThrough, done: (info) => info,
      };
    }
    return {
      // the hub learns neither the name nor the type
      path: '/files?name=sealed&sealed=1',
      size: sealedFileSize(file.size),
      sealed: true,
      transform: (src) => encryptFile(src, secret),
      done: (info) => {
        const meta: SealedFileMeta = { id: info.id, k: secret.k, n: secret.n, name: file.name.slice(0, 200) || 'file', mime: file.mime && /^[\w.+-]+\/[\w.+-]+$/.test(file.mime) && file.mime.length <= 100 ? file.mime.toLowerCase() : mimeFromName(file.name), size: file.size };
        this.registerFile(meta);
        return { ...info, name: meta.name, mime: meta.mime, size: meta.size, sealed: true };
      },
    };
  }

  /** How to read a downloaded file: decrypted when it is an encrypted attachment this device has the key of. */
  downloadTransform(fileId: string): ((src: Bytes) => AsyncIterable<Uint8Array>) | null {
    const meta = this.fileKeys.get(fileId);
    return meta ? (src) => decryptFile(src, meta) : null;
  }

  /** An encrypted upload finished: keep its key until the message that carries it is sent. */
  registerFile(meta: SealedFileMeta): void {
    this.fileKeys.delete(meta.id);
    this.fileKeys.set(meta.id, meta);
    if (this.fileKeys.size > FILE_KEYS_LIMIT) this.fileKeys.delete(this.fileKeys.keys().next().value!);
  }

  /** The key of an encrypted attachment this device has seen (null for ordinary files). */
  fileKey(fileId: string): SealedFileMeta | null {
    return this.fileKeys.get(fileId) ?? null;
  }

  private sealedFiles(ids: unknown): SealedFileMeta[] {
    if (!Array.isArray(ids)) return [];
    return ids.map((id) => (typeof id === 'string' ? this.fileKeys.get(id) : undefined)).filter((m): m is SealedFileMeta => !!m);
  }

  /** Open a message only to learn the keys of its attachments (a file listed without its message). */
  private learnFrom(messageId: string): Promise<void> {
    let p = this.fetching.get(messageId);
    if (!p) {
      p = (async () => {
        const m = await this.host.request('msg.get', { messageId }) as Message;
        if (m && typeof m.body === 'string' && isSealed(m.body)) await this.openOne(m);
      })().catch(() => undefined);
      this.fetching.set(messageId, p);
      if (this.fetching.size > 500) this.fetching.delete(this.fetching.keys().next().value!);
    }
    return p;
  }

  private dlp: DlpRule[] = [];
  private guests = new Set<string>();

  private async sealFor(convId: string, text: string, files: SealedFileMeta[] = []): Promise<string> {
    if (isSealed(text) || (!text && !files.length)) return text;
    const rec = await this.recipients(convId);
    if (!rec) {
      // never silently: the hub marks the message as not end-to-end encrypted, and the office may forbid it
      if (files.length) throw new Error(FILES_NEED_E2E);
      if (await this.mustEncrypt(convId)) throw await this.requiredError(convId);
      return text;
    }
    if (this.dlp.length) {
      const members = this.convs.get(convId)?.members ?? [];
      const r = applyDlp(text, this.dlp, { withGuests: members.some((m) => this.guests.has(m)) });
      if (r.blockedBy) throw new Error(dlpBlockedMessage(r.blockedBy));
      text = r.text;
    }
    return seal({ convId, text, senderDeviceId: this.host.deviceId, sign: this.host.sign, recipients: rec, files });
  }

  // ------------------------------------------------------------ outgoing
  async outgoing(op: string, data: unknown): Promise<unknown> {
    const d = (data ?? {}) as Record<string, unknown>;
    switch (op) {
      case 'msg.send':
      case 'sched.create':
        if (typeof d.convId === 'string' && typeof d.body === 'string') return { ...d, body: await this.sealFor(d.convId, d.body, this.sealedFiles(d.files)) };
        return data;
      case 'msg.edit': {
        // an edit keeps the message's encrypted attachments readable
        const convId = typeof d.messageId === 'string' ? this.msgConv.get(d.messageId) : undefined;
        if (convId && typeof d.body === 'string') return { ...d, body: await this.sealFor(convId, d.body, this.msgFiles.get(d.messageId as string)) };
        return data;
      }
      case 'sched.update': {
        const convId = typeof d.id === 'string' ? this.schedConv.get(d.id) : undefined;
        if (convId && typeof d.body === 'string') return { ...d, body: await this.sealFor(convId, d.body, this.msgFiles.get(d.id as string)) };
        return data;
      }
      case 'msg.forward': {
        // a sealed message is re-sealed (or given as text) for every target
        const id = typeof d.messageId === 'string' ? d.messageId : '';
        if (!Array.isArray(d.convIds)) return data;
        let text = this.plain.get(id);
        if (text === undefined) {
          // a message from a Space forwarded into encrypted Direct conversations is sealed there too
          let direct = false;
          for (const t of d.convIds) if (typeof t === 'string' && (await this.recipients(t))) direct = true;
          if (!direct) return data;
          const src = await this.host.request('msg.get', { messageId: id }) as Message;
          if (isSealed(src.body)) return data;
          text = src.poll ? `📊 ${src.body}` : src.body;
        }
        const files = this.msgFiles.get(id) ?? [];
        const bodies: Record<string, string> = {};
        for (const t of d.convIds) {
          if (typeof t !== 'string') continue;
          if (files.length && !(await this.recipients(t))) throw new Error(FORWARD_FILES_NEED_E2E);
          bodies[t] = await this.sealFor(t, text, files);
        }
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
      // opening registers the keys of encrypted attachments, which the walk below then names
      if (isSealed(o.body)) out = { ...(out ?? o), ...(await this.openOne(o as unknown as Message)) };
    }
    // an encrypted attachment: show its real name, type and size (the hub knows it only as "sealed")
    if (o.sealed === true && typeof o.id === 'string' && typeof o.mime === 'string') {
      if (!this.fileKeys.has(o.id) && typeof o.messageId === 'string' && !this.offline) await this.learnFrom(o.messageId);
      const meta = this.fileKeys.get(o.id);
      if (meta) out = { ...(out ?? o), name: meta.name, mime: meta.mime, size: meta.size };
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
    if (r.files?.length) {
      // only files actually attached to this message (the envelope cannot name someone else's file)
      const attached = Array.isArray((m as Message).files) ? new Set((m as Message).files.map((f) => f.id)) : null;
      const files = r.files.filter((f) => !attached || attached.has(f.id));
      for (const f of files) this.registerFile(f);
      this.msgFiles.set(m.id, files);
      if (this.msgFiles.size > PLAIN_LIMIT) this.msgFiles.delete(this.msgFiles.keys().next().value!);
    }
    return { body: r.text, e2e: r.verified ? 'ok' : 'unverified' };
  }

  private remember(id: string, text: string): void {
    this.plain.set(id, text);
    if (this.plain.size > PLAIN_LIMIT) this.plain.delete(this.plain.keys().next().value!);
  }

  /** A hub event about keys: forget cached keys; share history with a new device of mine. */
  async onEvent(name: string, data: unknown): Promise<void> {
    if (name === 'policy.updated') { this.applyPolicy(data as OfficePolicy); return; }
    if ((name === 'user.added' || name === 'user.updated') && (data as PublicUser).role) {
      const u = data as PublicUser;
      if (u.role === 'guest') this.guests.add(u.id); else this.guests.delete(u.id);
      return;
    }
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
