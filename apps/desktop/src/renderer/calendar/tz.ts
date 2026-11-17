// Time zones for the Calendar: meetings set in another zone (a client in Dubai), a second zone column
// on the week grid, and the first day of the week. Uses only the platform's Intl data.
import { useSyncExternalStore } from 'react';

export interface CalPrefs { firstDay: 0 | 1 | 6; zone2: string | null }
const KEY = 'dex.calendar.prefs';
const listeners = new Set<() => void>();
let prefs: CalPrefs = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<CalPrefs>;
    return { firstDay: v.firstDay === 0 || v.firstDay === 6 ? v.firstDay : 1, zone2: typeof v.zone2 === 'string' && validZone(v.zone2) ? v.zone2 : null };
  } catch { return { firstDay: 1, zone2: null }; }
})();
export const calPrefs = () => prefs;
export function setCalPrefs(patch: Partial<CalPrefs>): void {
  prefs = { ...prefs, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
  for (const l of listeners) l();
}
export const useCalPrefs = () => useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, calPrefs);

export function validZone(z: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: z }); return true; } catch { return false; }
}
export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Minutes the zone is ahead of UTC at that instant. */
export function zoneOffsetMin(zone: string, t: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t));
  const g = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'));
  return Math.round((asUtc - Math.floor(t / 1000) * 1000) / 60_000);
}

/** "2026-11-20T10:00" as clock time in the zone ('' = this device's own zone) → instant. */
export function fromZoneInput(value: string, zone: string): number {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/);
  if (!m) return NaN;
  const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0)];
  if (!zone) return new Date(y, mo, d, h, mi).getTime();
  const wall = Date.UTC(y, mo, d, h, mi);
  let t = wall - zoneOffsetMin(zone, wall) * 60_000;
  t = wall - zoneOffsetMin(zone, t) * 60_000; // settle across a daylight-saving change
  return t;
}

/** Instant → "2026-11-20T10:00" as clock time in the zone ('' = this device's own zone). */
export function toZoneInput(t: number, zone: string): string {
  const d = zone ? new Date(t + zoneOffsetMin(zone, t) * 60_000) : new Date(t - new Date(t).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

/** A short name for a zone: "Dubai", "London", "New York". */
export const zoneName = (z: string) => z.split('/').pop()!.replace(/_/g, ' ');

/** "10:00 AM" in the zone. */
export const timeIn = (t: number, zone: string, opts: Intl.DateTimeFormatOptions = {}) =>
  new Date(t).toLocaleTimeString([], { timeZone: zone, hour: 'numeric', minute: '2-digit', ...opts });

/** Zones people pick most, then every zone the platform knows. */
export const COMMON_ZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Riyadh', 'Asia/Qatar', 'Asia/Kuwait', 'Asia/Muscat', 'Asia/Singapore', 'Asia/Kuala_Lumpur', 'Asia/Shanghai', 'Asia/Tokyo',
  'Australia/Perth', 'Australia/Sydney', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Amsterdam', 'Africa/Lagos', 'Africa/Johannesburg', 'America/New_York', 'America/Chicago', 'America/Houston', 'America/Los_Angeles', 'America/Sao_Paulo'];
export function allZones(): string[] {
  const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  const common = COMMON_ZONES.filter(validZone);
  return [...common, ...list.filter((z) => !common.includes(z))];
}

/** "GMT+4" style label for a zone now. */
export function zoneOffsetLabel(zone: string, t = Date.now()): string {
  const m = zoneOffsetMin(zone, t);
  const sign = m < 0 ? '−' : '+';
  const a = Math.abs(m);
  return `GMT${sign}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, '0')}` : ''}`;
}
