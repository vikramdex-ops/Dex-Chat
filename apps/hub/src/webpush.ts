// Notifications for the iPhone web app (Web Push). An iPhone cannot keep the app's connection open
// in the background, and Apple's own push for apps needs a developer account the office does not
// have. Safari's Web Push needs neither: the installed web app subscribes with the office's public
// VAPID key, and its subscription names the push service to send to (Apple's, for an iPhone).
//
// The hub sends the pushes itself, because only the hub knows what a push may say: who the message
// is for, whether that device is on screen right now, the person's notification preferences, Do
// not disturb, muted conversations and mentions. The VAPID private key stays in the hub's database
// beside its other keys; the gateway and the Cloudflare account hold nothing new. Each push is
// encrypted to the device's subscription keys (RFC 8291), so the push service carries only
// ciphertext, and with "Show previews" off it says only "New message".
//
// When to push: a device with a subscription gets pushes while it has no connection that is on
// screen (the app tells the hub with push.active when it goes to the background and back).
// Messages are gathered for a moment and sent one notification per conversation, as Android shows
// them; a subscription the push service says is gone (404, 410) is removed.
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { PushPrefs } from '@dex/core';
import { encryptPush, pushEndpointProblem, validVapidKeys, vapidAuthorization } from '@dex/core/webpush';
import type { PushPayload, VapidKeys } from '@dex/core/webpush';
import type { MissedNotices } from './missed.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS push_subs (
  device_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  prefs TEXT NOT NULL,
  cursor TEXT,
  badge INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_ok INTEGER,
  last_error TEXT
);
`;

/** How long messages are gathered before a push goes, and the most notifications one round sends. */
const GATHER_MS = 1200;
const MAX_PER_ROUND = 4;
/** A push waits at the push service for a day at most (a phone that is off for longer catches up in the app). */
const TTL_SECONDS = 24 * 3600;

interface SubRow { device_id: string; user_id: string; endpoint: string; p256dh: string; auth: string; prefs: string; cursor: string | null; badge: number; last_ok: number | null; last_error: string | null }

export interface WebPushOptions {
  db: DatabaseSync;
  missed: MissedNotices;
  /** The office's key pair, made once and kept (store.meta). */
  keys: () => VapidKeys;
  /** The contact in VAPID tokens: the office's meeting site, or the app's public page. */
  subject: () => string;
  /** Does this device have a connection that is on screen right now? */
  onScreen: (deviceId: string) => boolean;
  /** Do not disturb (no notifications at all, as on the other devices). */
  dnd: (userId: string) => boolean;
  /** Only for tests and the e2e test's local push service: allow http://127.0.0.1. */
  allowLocal?: boolean;
  fetch?: typeof fetch;
  log: (level: 'info' | 'warn' | 'error' | 'debug', msg: string, extra?: Record<string, unknown>) => void;
}

/** Makes a key pair synchronously (node:crypto), for store.meta. */
export function makeVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x!, 'base64url'), Buffer.from(pub.y!, 'base64url')]);
  return { publicKey: raw.toString('base64url'), privateKey: priv.d! };
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Checks and normalises what a device sends as its preferences. */
export function cleanPrefs(p: unknown): PushPrefs {
  const v = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  let zone = typeof v.zone === 'string' ? v.zone.slice(0, 64) : 'UTC';
  try { new Intl.DateTimeFormat('en-GB', { timeZone: zone }); } catch { zone = 'UTC'; }
  return {
    notifyFor: v.notifyFor === 'mentions' || v.notifyFor === 'none' ? v.notifyFor : 'all',
    showPreviews: v.showPreviews !== false,
    quietFrom: typeof v.quietFrom === 'string' && TIME_RE.test(v.quietFrom) ? v.quietFrom : null,
    quietTo: typeof v.quietTo === 'string' && TIME_RE.test(v.quietTo) ? v.quietTo : null,
    zone,
    silent: v.silent === true,
  };
}

/** Is it quiet hours for these preferences at `now`, in the device's own time zone? */
export function quietNow(p: PushPrefs, now = Date.now()): boolean {
  if (!p.quietFrom || !p.quietTo) return false;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: p.zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
  const t = Number(parts.find((x) => x.type === 'hour')?.value ?? 0) * 60 + Number(parts.find((x) => x.type === 'minute')?.value ?? 0);
  const m = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const a = m(p.quietFrom), b = m(p.quietTo);
  return a <= b ? t >= a && t < b : t >= a || t < b;
}

export class WebPush {
  private readonly o: WebPushOptions;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Map<string, Promise<void>>();

  constructor(o: WebPushOptions) {
    this.o = o;
    o.db.exec(SCHEMA);
  }

  private keys(): VapidKeys {
    const k = this.o.keys();
    if (!validVapidKeys(k)) throw new Error('The hub\'s push keys are damaged.');
    return k;
  }

  publicKey(): string { return this.keys().publicKey; }

  private row(deviceId: string): SubRow | null {
    return (this.o.db.prepare('SELECT * FROM push_subs WHERE device_id = ?').get(deviceId) as SubRow | undefined) ?? null;
  }

  /** Throws a message for the person when the subscription cannot be used. */
  subscribe(deviceId: string, userId: string, sub: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }, prefs: unknown): void {
    const endpoint = typeof sub.endpoint === 'string' ? sub.endpoint : '';
    const problem = pushEndpointProblem(endpoint, this.o.allowLocal);
    if (problem) throw new Error(problem);
    const p256dh = typeof sub.keys?.p256dh === 'string' ? sub.keys.p256dh : '';
    const auth = typeof sub.keys?.auth === 'string' ? sub.keys.auth : '';
    if (!/^[A-Za-z0-9_-]{86,88}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,44}$/.test(auth)) throw new Error('That push subscription is not complete.');
    const cursor = this.o.missed.list(userId, null).cursor;
    this.o.db.prepare(`INSERT INTO push_subs (device_id, user_id, endpoint, p256dh, auth, prefs, cursor, badge, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(device_id) DO UPDATE SET user_id = excluded.user_id, endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth, prefs = excluded.prefs, cursor = excluded.cursor, badge = 0, last_error = NULL`)
      .run(deviceId, userId, endpoint, p256dh, auth, JSON.stringify(cleanPrefs(prefs)), cursor, Date.now());
  }

  unsubscribe(deviceId: string): void {
    this.o.db.prepare('DELETE FROM push_subs WHERE device_id = ?').run(deviceId);
    const t = this.timers.get(deviceId);
    if (t) clearTimeout(t);
    this.timers.delete(deviceId);
  }

  status(deviceId: string): { subscribed: boolean; lastOk: number | null; lastError: string | null } {
    const r = this.row(deviceId);
    return { subscribed: !!r, lastOk: r?.last_ok ?? null, lastError: r?.last_error ?? null };
  }

  /** The app came on screen: what it shows from now on is its own; the badge starts again. */
  seen(deviceId: string): void {
    const r = this.row(deviceId);
    if (!r) return;
    this.o.db.prepare('UPDATE push_subs SET cursor = ?, badge = 0 WHERE device_id = ?').run(this.o.missed.list(r.user_id, null).cursor, deviceId);
  }

  /** New messages for these people: devices that are not on screen get a push shortly. */
  onMessage(userIds: Iterable<string>): void {
    const ids = [...userIds];
    if (!ids.length) return;
    const rows = this.o.db.prepare(`SELECT device_id FROM push_subs WHERE user_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Array<{ device_id: string }>;
    for (const { device_id: deviceId } of rows) {
      if (this.o.onScreen(deviceId) || this.timers.has(deviceId)) continue;
      const t = setTimeout(() => { this.timers.delete(deviceId); void this.flush(deviceId); }, GATHER_MS);
      t.unref?.();
      this.timers.set(deviceId, t);
    }
  }

  /** One device's round: what arrived since its cursor, filtered by its preferences, one push per conversation. */
  private flush(deviceId: string): Promise<void> {
    const prev = this.running.get(deviceId) ?? Promise.resolve();
    const next = prev.then(() => this.round(deviceId)).catch((err) => this.o.log('warn', 'push round failed', { error: (err as Error).message }));
    this.running.set(deviceId, next);
    void next.finally(() => { if (this.running.get(deviceId) === next) this.running.delete(deviceId); });
    return next;
  }

  private async round(deviceId: string): Promise<void> {
    const r = this.row(deviceId);
    if (!r || this.o.onScreen(deviceId)) return;
    const page = this.o.missed.list(r.user_id, r.cursor);
    this.o.db.prepare('UPDATE push_subs SET cursor = ? WHERE device_id = ?').run(page.cursor, deviceId);
    const prefs = cleanPrefs(JSON.parse(r.prefs));
    if (!page.items.length || prefs.notifyFor === 'none' || this.o.dnd(r.user_id) || quietNow(prefs)) return;
    const wanted = page.items.filter((i) => !(i.muted && !i.mentioned) && (prefs.notifyFor !== 'mentions' || i.personal));
    if (!wanted.length) return;
    const badge = r.badge + wanted.length;
    this.o.db.prepare('UPDATE push_subs SET badge = ? WHERE device_id = ?').run(badge, deviceId);
    const byConv = new Map<string, typeof wanted>();
    for (const i of wanted) byConv.set(i.convId, [...(byConv.get(i.convId) ?? []), i]);
    const groups = [...byConv.values()];
    // many conversations at once: the newest few, and one line for the rest
    const shown = groups.slice(-MAX_PER_ROUND);
    for (const list of shown) {
      const last = list[list.length - 1];
      // an end-to-end encrypted message cannot be read here: only the app on the phone opens it
      let text = last.sealed ? 'New encrypted message' : last.text || 'New message';
      if (!prefs.showPreviews) text = 'New message';
      const body = list.length > 1 ? `${list.length} new messages · ${text}` : text;
      await this.send(r, { title: prefs.showPreviews ? last.title : 'Dexterity Connect', body, link: last.link, tag: last.convId, badge, silent: prefs.silent });
    }
    if (groups.length > shown.length) {
      const rest = groups.length - shown.length;
      await this.send(r, { title: 'Dexterity Connect', body: rest === 1 ? 'And 1 more conversation' : `And ${rest} more conversations`, tag: 'more', badge, silent: true });
    }
  }

  /** Preferences ▸ Notifications ▸ Send a test. */
  async test(deviceId: string): Promise<{ ok: boolean; error: string | null }> {
    const r = this.row(deviceId);
    if (!r) return { ok: false, error: 'Notifications are not switched on for this iPhone.' };
    const ok = await this.send(r, { title: 'Dexterity Connect', body: 'Notifications reach this iPhone.', tag: 'test', test: true, silent: false });
    return { ok, error: ok ? null : this.row(deviceId)?.last_error ?? 'The push service did not take the notification.' };
  }

  private async send(r: SubRow, payload: PushPayload): Promise<boolean> {
    const fetcher = this.o.fetch ?? fetch;
    try {
      const body = await encryptPush({ p256dh: r.p256dh, auth: r.auth }, new TextEncoder().encode(JSON.stringify(payload)));
      const authorization = await vapidAuthorization({ endpoint: r.endpoint, subject: this.o.subject(), keys: this.keys() });
      const topic = payload.tag ? crypto.createHash('sha256').update(payload.tag).digest('base64url').slice(0, 32) : undefined;
      const res = await fetcher(r.endpoint, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000),
        headers: {
          authorization, 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream',
          ttl: String(TTL_SECONDS), urgency: payload.silent ? 'normal' : 'high', ...(topic ? { topic } : {}),
        },
        body: body as unknown as BodyInit,
      });
      await res.arrayBuffer().catch(() => null);
      if (res.status === 404 || res.status === 410) {
        // the person turned notifications off on the phone, or removed the app
        this.unsubscribe(r.device_id);
        this.o.log('info', 'push subscription gone', { device: r.device_id, status: res.status });
        return false;
      }
      if (res.status < 200 || res.status >= 300) throw new Error(`The push service answered ${res.status}.`);
      this.o.db.prepare('UPDATE push_subs SET last_ok = ?, last_error = NULL WHERE device_id = ?').run(Date.now(), r.device_id);
      return true;
    } catch (err) {
      const msg = (err as Error).name === 'TimeoutError' ? 'The push service did not answer.' : (err as Error).message.slice(0, 200);
      this.o.db.prepare('UPDATE push_subs SET last_error = ? WHERE device_id = ?').run(msg, r.device_id);
      this.o.log('warn', 'push not sent', { device: r.device_id, error: msg });
      return false;
    }
  }

  close(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
