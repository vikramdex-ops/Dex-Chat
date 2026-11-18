// What the service worker shows for a push, and where a tap leads. No browser APIs here, so the
// rules can be tested in Node.
import type { PushPayload } from '@dex/core/webpush';

export interface Shown {
  title: string;
  options: { body: string; tag: string; data: { link: string | null }; icon: string; badge: string; silent: boolean; renotify: boolean; lang?: string };
  /** For the Home Screen icon (navigator.setAppBadge); null leaves it as it is. */
  badge: number | null;
}

const clip = (s: unknown, n: number, fallback: string) => (typeof s === 'string' && s.trim() ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n) : fallback);

/**
 * A push's payload as a notification. Safari stops sending pushes to a web app that receives one
 * without showing a notification, so anything unreadable still shows something plain.
 */
export function noticeFor(data: unknown, base: string): Shown {
  const p = (data && typeof data === 'object' ? data : {}) as Partial<PushPayload>;
  const link = typeof p.link === 'string' && /^dexconnect:\/\/[\w./?=&%-]+$/.test(p.link) ? p.link : null;
  const tag = typeof p.tag === 'string' && /^[\w-]{1,64}$/.test(p.tag) ? p.tag : 'dexconnect';
  return {
    title: clip(p.title, 120, 'Dexterity Connect'),
    options: { body: clip(p.body, 240, 'New message'), tag, data: { link }, icon: `${base}icon-192.png`, badge: `${base}icon-192.png`, silent: p.silent === true, renotify: true },
    badge: typeof p.badge === 'number' && Number.isFinite(p.badge) && p.badge >= 0 ? Math.min(9999, Math.floor(p.badge)) : null,
  };
}

/** The address a tapped notification opens: the app, with the conversation in the #fragment. */
export const openUrl = (base: string, link: string | null) => (link ? `${base}#open=${encodeURIComponent(link)}` : base);
