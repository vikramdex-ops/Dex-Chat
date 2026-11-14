// One place that decides whether to show a system notification and play a sound, from the
// person's Preferences (Notifications section).
import { SETTINGS_EXTRA_DEFAULTS, type Settings } from '../shared/bridge.ts';
import { playSound } from './sounds.ts';

type AlertPrefs = Pick<Settings, 'sound' | 'notifyFor' | 'showPreviews'>;
let prefs: AlertPrefs = { ...SETTINGS_EXTRA_DEFAULTS };
/** Android plays the notification's own sound. */
let nativeSound = false;

export function setAlertPrefs(s: Partial<Settings>, platform?: string): void {
  nativeSound = platform === 'android';
  prefs = { sound: s.sound ?? prefs.sound, notifyFor: s.notifyFor ?? prefs.notifyFor, showPreviews: s.showPreviews ?? prefs.showPreviews };
}

/**
 * kind 'message': an ordinary message; 'personal': a Direct message, a mention or a reply to
 * you; 'reminder': reminders, meetings and invitations, which always notify.
 */
export function alertUser(kind: 'message' | 'personal' | 'reminder', title: string, body: string, link?: string): void {
  if (kind !== 'reminder') {
    if (prefs.notifyFor === 'none') return;
    if (prefs.notifyFor === 'mentions' && kind === 'message') return;
  }
  window.dex.notify(title, prefs.showPreviews || kind === 'reminder' ? body : 'New message', link);
  if (!nativeSound) playSound(prefs.sound);
}
