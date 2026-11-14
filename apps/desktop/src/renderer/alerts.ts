// One place that decides whether to show a system notification and play a sound, from the
// person's Preferences (Notifications section).
import { SETTINGS_EXTRA_DEFAULTS, type Settings } from '../shared/bridge.ts';
import { playSound } from './sounds.ts';

type AlertPrefs = Pick<Settings, 'sound' | 'notifyFor' | 'showPreviews' | 'quietFrom' | 'quietTo'>;
let prefs: AlertPrefs = { ...SETTINGS_EXTRA_DEFAULTS };
/** Android plays the notification's own sound. */
let nativeSound = false;

export function setAlertPrefs(s: Partial<Settings>, platform?: string): void {
  nativeSound = platform === 'android';
  prefs = { sound: s.sound ?? prefs.sound, notifyFor: s.notifyFor ?? prefs.notifyFor, showPreviews: s.showPreviews ?? prefs.showPreviews, quietFrom: s.quietFrom ?? null, quietTo: s.quietTo ?? null };
}

/**
 * kind 'message': an ordinary message; 'personal': a Direct message, a mention or a reply to
 * you; 'reminder': reminders, meetings and invitations, which always notify.
 */
/** Now inside the person's quiet hours (which may run past midnight)? */
export function inQuietHours(now = new Date()): boolean {
  if (!prefs.quietFrom || !prefs.quietTo) return false;
  const m = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const t = now.getHours() * 60 + now.getMinutes();
  const a = m(prefs.quietFrom), b = m(prefs.quietTo);
  return a <= b ? t >= a && t < b : t >= a || t < b;
}

/** True in a popped-out conversation window: the main window notifies. */
export const isPopout = typeof location !== 'undefined' && location.hash.startsWith('#popout=');

export function alertUser(kind: 'message' | 'personal' | 'reminder', title: string, body: string, link?: string): void {
  if (isPopout) return;
  if (kind !== 'reminder') {
    if (prefs.notifyFor === 'none' || inQuietHours()) return;
    if (prefs.notifyFor === 'mentions' && kind === 'message') return;
  }
  window.dex.notify(title, prefs.showPreviews || kind === 'reminder' ? body : 'New message', link);
  if (!nativeSound) playSound(prefs.sound);
}
