// Dexterity Meet's public face: the clean address every meeting has on the office's meeting site
// (https://dexterity-meet.pages.dev/482-913-207, a name the host chose such as
// …/p12-design-review, or a person's room such as …/vikram), what that page may learn before and
// after the passcode, and the rules for names (slugs). The passcode always travels in the #fragment
// or is typed on the page; it is never part of a path or a query.
import type { LobbyRule, MeetingKind, Recurrence } from './protocol.ts';

/** The office's meeting site when nothing else is set: a free Cloudflare Pages project. */
export const MEET_SITE_DEFAULT = 'https://dexterity-meet.pages.dev';
/** The name pages show before a passcode when the office has not chosen one. */
export const MEET_ORG_DEFAULT = 'Dexterity Design Services';

export const SLUG_MIN = 3;
export const SLUG_MAX = 40;
/** A released name routes only to the meeting it named, and only its host can take it back, for this long. */
export const SLUG_GRACE_MS = 30 * 86_400_000;
/** Guests can ask to join this long before a scheduled start ("the room opens at …"). */
export const ROOM_OPENS_BEFORE_MS = 10 * 60_000;

/**
 * Names nobody may take: the site's own paths, words that would look official or like someone
 * else's product, and generic words a guest could be tricked by.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'w', 'm', 'c', 'api', 'ws', 'assets', 'asset', 'static', 'cal', 'calendar', 'join', 'health', 'hub', 'gateway', 'cdn', 'fonts',
  'admin', 'administrator', 'root', 'system', 'support', 'help', 'helpdesk', 'about', 'contact', 'login', 'logout', 'signin', 'sign-in',
  'signup', 'sign-up', 'register', 'account', 'accounts', 'password', 'reset', 'verify', 'security', 'privacy', 'terms', 'legal', 'status',
  'settings', 'profile', 'office', 'staff', 'team', 'official', 'dexterity', 'dexterity-meet', 'dexterity-connect', 'dexconnect', 'dex',
  'meet', 'meeting', 'meetings', 'room', 'rooms', 'webinar', 'webinars', 'watch', 'survey', 'lobby', 'new', 'home', 'index', 'www', 'mail',
  'email', 'robots', 'favicon', 'sitemap', 'download', 'downloads', 'app', 'apps', 'share', 'test', 'null', 'undefined', 'true', 'false',
  'zoom', 'teams', 'google', 'gmeet', 'microsoft', 'outlook', 'zoho', 'webex', 'skype', 'slack', 'cloudflare', 'pages',
]);

/**
 * A name as people type it, made into a slug: accents dropped (é → e), letters lowered, spaces,
 * dots and underscores turned into hyphens. Anything that is still not a-z, 0-9 or a hyphen stays,
 * so slugProblem() can refuse it (a Cyrillic "а" never becomes a Latin "a").
 */
export function normalizeSlug(input: string): string {
  return String(input ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim()
    .replace(/[\s._]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Why a slug (already normalised) cannot be used, in plain words, or null when it can. */
export function slugProblem(slug: string): string | null {
  if (slug.length < SLUG_MIN) return `A name needs at least ${SLUG_MIN} characters.`;
  if (slug.length > SLUG_MAX) return `A name can be up to ${SLUG_MAX} characters.`;
  if (!/^[a-z0-9-]+$/.test(slug)) return 'Use only the letters a to z, digits and hyphens.';
  if (!/^[a-z]/.test(slug)) return 'A name starts with a letter.';
  if (/-$/.test(slug) || /--/.test(slug)) return 'Hyphens go between words, one at a time.';
  if (RESERVED_SLUGS.has(slug) || /^(xn|api|admin|www|dexterity|dexconnect)-/.test(slug)) return 'That name is kept for the site. Choose another.';
  return null;
}

/** A suggestion from a meeting's title ("P-12 Design review" → "p-12-design-review"), or '' when nothing usable is left. */
export function slugFrom(title: string): string {
  let s = normalizeSlug(title).replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '');
  if (s.length > SLUG_MAX) s = s.slice(0, SLUG_MAX).replace(/-[^-]*$/, '') || s.slice(0, SLUG_MAX);
  s = s.replace(/-+$/, '');
  return slugProblem(s) ? '' : s;
}

/** What a path segment on the meeting site names: a meeting ID (with or without dashes) or a slug. */
export type MeetRef = { kind: 'id'; id: string } | { kind: 'slug'; slug: string };
export function parseMeetRef(segment: string): MeetRef | null {
  const t = String(segment ?? '');
  if (t.length > 64) return null;
  if (/^[1-9]\d{2}-?\d{3}-?\d{3}$/.test(t)) return { kind: 'id', id: t.replace(/-/g, '') };
  if (/^[a-z][a-z0-9-]{1,39}$/.test(t) && !slugProblem(t)) return { kind: 'slug', slug: t };
  return null;
}

/** The site's address without a trailing slash. */
export const siteBase = (base: string): string => String(base ?? '').trim().replace(/\/+$/, '');
/** 482913207 or a slug → the path segment shown in links (IDs with dashes). */
export const refSegment = (ref: string): string => (/^\d{9}$/.test(ref) ? `${ref.slice(0, 3)}-${ref.slice(3, 6)}-${ref.slice(6)}` : ref);
/** https://dexterity-meet.pages.dev/p12-design-review#Hx7kP2q (the passcode only when given). */
export function meetPageUrl(base: string, ref: string, passcode?: string | null): string {
  return `${siteBase(base)}/${refSegment(ref)}${passcode ? `#${passcode}` : ''}`;
}
/** https://dexterity-meet.pages.dev/w/<name or ID>: a webinar's registration page. */
export const webinarPageUrl = (base: string, ref: string): string => `${siteBase(base)}/w/${refSegment(ref)}`;

/** The meeting site's address as an administrator types it: https (or a local test address), no path. */
export function siteUrlProblem(url: string): string | null {
  if (!url) return null;
  if (!/^(https:\/\/[a-z0-9.-]+\.[a-z]{2,}|http:\/\/(127\.0\.0\.1|localhost))(:\d{2,5})?$/i.test(url)) return 'Enter the meeting site\'s https:// address with no path, for example https://dexterity-meet.pages.dev';
  return null;
}

// ---------------------------------------------------------------- what the page learns
/** Where a meeting stands, as the page shows it. */
export type MeetPageState = 'upcoming' | 'open' | 'live' | 'ended' | 'cancelled';

/**
 * Before a passcode: only what the host allowed. Date and time, and "Meeting with <office>"; the
 * title and the host's first name only when the host left "Show the title on the invitation page"
 * on. Never people, emails, other ids or the hub's address.
 */
export interface MeetPagePublic {
  found: true;
  /** Nine digits: the one id a page may know. */
  id: string;
  /** The path segment the page should show (the meeting's name, or the dashed ID). */
  ref: string;
  kind: 'scheduled' | 'personal' | 'instant';
  /** "Dexterity Design Services" */
  org: string;
  title: string | null;
  /** First name only. */
  host: string | null;
  /** A scheduled meeting's (next) time; null for personal rooms and instant meetings. */
  startAt: number | null;
  endAt: number | null;
  /** The office's time zone, to note beside the visitor's own. */
  zone: string | null;
  repeats: boolean;
  /** upcoming, open (ask to join), or live (in progress since liveSince). Ended and cancelled are never told before the passcode. */
  state: 'upcoming' | 'open' | 'live';
  liveSince: number | null;
  /** From when guests can ask to join (ten minutes before the start), or null when they can now. */
  opensAt: number | null;
}
/** Not found, ended, cancelled, switched off: one answer for all of them. */
export interface MeetPageNone { found: false }
export type MeetPageInfo = MeetPagePublic | MeetPageNone;

/** After the passcode: everything a guest needs for this meeting and nothing about anyone else. */
export interface MeetPageDetails extends Omit<MeetPagePublic, 'found' | 'state' | 'title' | 'host'> {
  ok: true;
  title: string;
  host: string;
  state: MeetPageState;
  recurrence: Recurrence;
  /** The next time after this one, for a repeating meeting. */
  next: { startAt: number; endAt: number } | null;
  /** What the host chose to tell guests afterwards (minutes coming, a link…). */
  followUp: string | null;
}

/** The public page of a meeting, as its host sees and sets it (desktop: the event dialog, the Meet lens). */
export interface MeetPublicView {
  meetingId: string;
  kind: MeetingKind;
  /** The meeting's own name on the site, or null for the ID only. */
  slug: string | null;
  /** https://…/p12-design-review (no passcode), or null when the site is not set up. */
  url: string | null;
  /** The same with #passcode: what guests are sent. */
  guestUrl: string | null;
  /** The address by ID, which always works. */
  idUrl: string | null;
  passcode: string | null;
  /** Guests can join from a browser. */
  enabled: boolean;
  showTitle: boolean;
  lobby: LobbyRule;
  followUp: string | null;
  /** The office's meeting site, or null. */
  site: string | null;
  /** Why guests cannot join now, in plain words, or null. */
  problem: string | null;
}

declare module './protocol.ts' {
  interface Ops {
    'meet.public.get': { req: { id: string }; res: MeetPublicView };
    'meet.public.set': { req: { id: string; slug?: string | null; showTitle?: boolean; followUp?: string | null; enabled?: boolean; regenerate?: boolean; lobby?: LobbyRule }; res: MeetPublicView };
    'meet.slug.check': { req: { slug: string; id?: string }; res: { slug: string; ok: boolean; problem: string | null } };
    /** Your personal room's name on the meeting site (from your name; you can change it). */
    'meet.personal.slug': { req: { slug: string }; res: MeetPublicView };
  }
  interface RemoteConfig {
    /** The meeting site's address (https://dexterity-meet.pages.dev, or the office's own domain), or null for the gateway's. */
    siteUrl?: string | null;
    /** The name meeting pages show before a passcode. */
    orgName?: string;
  }
}

/** Calendar links for "Add to calendar" (Google Calendar, Outlook.com): no passcode, so it never reaches their servers. */
export function calendarLinks(o: { title: string; startAt: number; endAt: number; url: string; details: string }): { google: string; outlook: string } {
  const z = (t: number) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const google = `https://calendar.google.com/calendar/render?${new URLSearchParams({ action: 'TEMPLATE', text: o.title, dates: `${z(o.startAt)}/${z(o.endAt)}`, details: o.details, location: o.url }).toString()}`;
  const outlook = `https://outlook.live.com/calendar/0/deeplink/compose?${new URLSearchParams({ path: '/calendar/action/compose', rru: 'addevent', subject: o.title, startdt: new Date(o.startAt).toISOString(), enddt: new Date(o.endAt).toISOString(), body: o.details, location: o.url }).toString()}`;
  return { google, outlook };
}
