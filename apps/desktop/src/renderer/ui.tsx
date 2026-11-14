// Shared UI building blocks: icons, avatars, controls, toasts and formatting helpers.
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import type { PublicUser } from '@dex/core';

const PATHS = {
  home: 'M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z',
  people: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6 9c.5-3.4 2.9-5.5 6-5.5s5.5 2.1 6 5.5M16 4.3a3.4 3.4 0 0 1 0 6.4M18 14.6c1.8.8 2.8 2.6 3 5.4',
  shield: 'M12 3.5 5 6v5.5c0 4.3 2.9 7.9 7 9 4.1-1.1 7-4.7 7-9V6zM9 12l2.2 2.2L15.5 10',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-1.6.1-1.4-.1-1.4 2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2.4-1.4L14.2 2h-4.4l-.4 2.6A7.6 7.6 0 0 0 7 6L4.6 5 2.6 8.5l2 1.6-.1 1.4.1 1.4-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2.4 1.4l.4 2.7h4.4l.4-2.6a7.6 7.6 0 0 0 2.4-1.4l2.4 1 2-3.4z',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Zm4.7-1.8L20 20',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  x: 'M6 6l12 12M18 6 6 18',
  monitor: 'M3.5 5h17v11h-17zM9 20h6M12 16v4',
  server: 'M4 4.5h16v6H4zM4 13.5h16v6H4zM7.5 7.5h.01M7.5 16.5h.01',
  lock: 'M6 10.5h12V20H6zM8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5',
  refresh: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4v4.5H15',
  clock: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm0-12v4.5l3 2',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-13v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4',
  moon: 'M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10Z',
  laptop: 'M5 6h14v9H5zM3 18h18',
  power: 'M12 3.5V11M7 6.5a7 7 0 1 0 10 0',
  tray: 'M4 14h4l1.5 2.5h5L16 14h4M4 14l2.5-8h11L20 14v5H4z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8.5c.6-3.8 3.4-6 7-6s6.4 2.2 7 6',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  info: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm0-9v5M12 8h.01',
  wifi: 'M2.5 9a14 14 0 0 1 19 0M5.5 12.3a9.5 9.5 0 0 1 13 0M8.6 15.5a5 5 0 0 1 6.8 0M12 19h.01',
  warning: 'M12 4 2.8 19.5h18.4zM12 10v4.5M12 17h.01',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  pulse: 'M3 12h4l2.5-6 4 12 2.5-6H21',
  plus: 'M12 5v14M5 12h14',
  back: 'M15 5l-7 7 7 7',
  paperclip: 'M20 11.5 12 19.5a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17.2a1.7 1.7 0 0 1-2.4-2.4L15 7',
  doc: 'M6 3.5h8l4 4V20.5H6zM14 3.5v4h4M9 12h6M9 15.5h6',
  sheet: 'M4.5 4.5h15v15h-15zM4.5 9.5h15M4.5 14.5h15M10 4.5v15',
  drawing: 'M4 20 20 4M4 20V10M4 20h10M14 4h6v6M8 16l2 2',
  archive: 'M4 7.5h16v12H4zM3 4.5h18v3H3zM10 11.5h4',
  play: 'M7 5v14l11-7z',
  open: 'M14 4.5h5.5V10M19.5 4.5 11 13M17 13.5V19.5H4.5V7H10',
  download: 'M12 4.5v11M7 11l5 5 5-5M5 19.5h14',
  phone: 'M6.5 3.5h3l1.5 4.5-2 1.5a11 11 0 0 0 5.5 5.5l1.5-2 4.5 1.5v3a2 2 0 0 1-2 2A16 16 0 0 1 4.5 5.5a2 2 0 0 1 2-2z',
  'phone-off': 'M4 15.5c4.6-4.4 11.4-4.4 16 0l-1.6 2.6-3.6-1.3v-2.5a10 10 0 0 0-5.6 0v2.5l-3.6 1.3z',
  video: 'M3.5 6.5h12v11h-12zM15.5 10.5l5-3v9l-5-3',
  'video-off': 'M3.5 6.5h12v11h-12zM15.5 10.5l5-3v9l-5-3M3 3l18 18',
  mic: 'M12 3.5a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0v-5a3 3 0 0 1 3-3zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21',
  'mic-off': 'M12 3.5a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0v-5a3 3 0 0 1 3-3zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M4 4l16 16',
  screen: 'M3.5 4.5h17v12h-17zM8.5 20h7M12 16.5V20M12 8v5M9.5 10.5 12 8l2.5 2.5',
  minimize: 'M5 19h14M9 5v6H3M15 5v6h6',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  bell: 'M6 16.5h12l-1.5-2.5V10a4.5 4.5 0 0 0-9 0v4zM10 19.5h4',
  mute: 'M6 16.5h10.5M10 19.5h4M7.5 10a4.5 4.5 0 0 1 7.7-3.2M16.5 10.5V14l1.5 2.5M4 4l16 16',
  pin: 'M9 4h6l-1 6 3 3H7l3-3zM12 13v7',
  reply: 'M10 7 5 12l5 5M5 12h9a5 5 0 0 1 5 5v1',
  smile: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm-3.5-6.5c.8 1.4 2 2 3.5 2s2.7-.6 3.5-2M9 9.5h.01M15 9.5h.01',
  copy: 'M8 8h11v12H8zM5 16V4h11',
  trash: 'M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13',
  at: 'M16 12a4 4 0 1 1-1.2-2.9M16 8v5.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.6 7.2',
  send: 'M4.5 12 20 4.5 15.5 20l-3.5-6.5zM12 13.5l8-9',
  chat: 'M4.5 5.5h15v10h-8l-4.5 4v-4h-2.5z',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  star: 'M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.6L12 16.7l-5.1 2.7 1-5.6-4.1-4 5.7-.8z',
  alarm: 'M12 20.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15Zm0-11v3.5l2.5 1.5M4 5.5 6.5 3M20 5.5 17.5 3',
  forward: 'M14 7l5 5-5 5M19 12h-9a5 5 0 0 0-5 5v1',
  poll: 'M5 19.5V11M10 19.5V5M15 19.5v-6M20 19.5V8',
  calendar: 'M4.5 6h15v14h-15zM4.5 10.5h15M8.5 3.5v4M15.5 3.5v4',
  desk: 'M3.5 9h17M5 9v10.5M19 9v10.5M5 14h6M8 4.5h8L18 9H6z',
  unread: 'M4.5 6.5h15v11h-15zM4.5 7l7.5 6 7.5-6',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  schedule: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm0-12v4.5l3 2M3.5 20.5l3-3',
  repeat: 'M5 10a6 6 0 0 1 10.5-4L18 8.5M18 4.5v4h-4M19 14a6 6 0 0 1-10.5 4L6 15.5M6 19.5v-4h4',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

// Brand-harmonious avatar colours (all pass 4.5:1 with white initials).
const AVATAR_COLORS = ['#1e6066', '#1c7680', '#2f5d8a', '#6a4c93', '#8a3b5c', '#a0522d', '#4d6b2f', '#3d5a5e', '#7a5a14', '#305f72'];

export function colorFor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return ((parts[0][0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export type Presence = 'on' | 'off' | 'away' | 'room' | 'dnd' | 'busy';

// Presence of everyone, refreshed by the app frame whenever the session changes.
let presenceSource: { online: Set<string>; away: Set<string>; inRoom: Set<string>; users: Map<string, PublicUser> } = { online: new Set(), away: new Set(), inRoom: new Set(), users: new Map() };
export function setPresenceSource(online: string[], away: string[], users: PublicUser[], inRoom: string[] = []): void {
  presenceSource = { online: new Set(online), away: new Set(away), inRoom: new Set(inRoom), users: new Map(users.map((u) => [u.id, u] as const)) };
}
export function presenceFor(id: string): Presence {
  const { online, away, users } = presenceSource;
  if (!online.has(id)) return 'off';
  if (presenceSource.inRoom.has(id)) return 'room';
  if (away.has(id)) return 'away';
  const a = users.get(id)?.availability;
  return a === 'dnd' ? 'dnd' : a === 'busy' ? 'busy' : 'on';
}

/** Rounded-square tile with initials; presence is a beacon ring around it, never a dot. */
export function Avatar({ user, online, presence, size }: {
  user: Pick<PublicUser, 'id' | 'displayName'>;
  online?: boolean;
  presence?: Presence;
  size?: 'sm' | 'lg';
}) {
  const p: Presence | undefined = presence ?? (online === undefined ? undefined : online ? 'on' : 'off');
  return (
    <span className={`avatar${size ? ` ${size}` : ''}`} data-presence={p} style={{ background: colorFor(user.id) }}
      title={p ? `${user.displayName} · ${PRESENCE_LABEL[p]}` : user.displayName}>
      {initials(user.displayName)}
    </span>
  );
}

export const PRESENCE_LABEL: Record<Presence, string> = { on: 'available', off: 'offline', away: 'away', room: 'in a Room', dnd: 'do not disturb', busy: 'busy' };

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="toggle" onClick={() => onChange(!checked)} />;
}

/** A switch with its label beside it, for forms and dialogs (the whole row toggles). */
export function ToggleRow({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="toggle-row" onClick={(e) => { e.preventDefault(); onChange(!checked); }}>
      <Toggle checked={checked} onChange={() => {}} label={label} />
      <span>{label}</span>
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; label: string; onChange: (v: T) => void; options: Array<{ value: T; label: string; icon?: IconName; badge?: number }>;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.icon && <Icon name={o.icon} size={16} />}
          {o.label}
          {!!o.badge && <span className="badge">{o.badge}</span>}
        </button>
      ))}
    </div>
  );
}

export const ROLE_LABEL: Record<PublicUser['role'], string> = { owner: 'Owner', admin: 'Admin', member: 'Member', guest: 'Guest', bot: 'Integration' };

export function relativeTime(ts: number | null, now = Date.now()): string {
  if (!ts) return 'never';
  const s = Math.round((now - ts) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Short, human-checkable code for a device so admins can confirm who they approve. */
export function deviceCode(deviceId: string): string {
  return deviceId.slice(0, 8).toUpperCase().replace(/(.{4})/, '$1 ');
}

/** A centred dialog over a blurred scrim, rendered at the top of the document. */
export function Dialog({ title, children, onClose, narrow }: { title: string; children: ReactNode; onClose: () => void; narrow?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return createPortal(
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`dialog wide${narrow ? ' narrow' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div style={{ display: 'flex', width: '100%', alignItems: 'center' }}>
          <h2 style={{ flex: 1 }}>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/**
 * A menu or picker anchored to a button, rendered at the top of the document so a
 * scrolling or clipped container never cuts it off. Flips above the anchor near the bottom.
 */
export function Popover({ anchor, onClose, className, children, align = 'end' }: {
  anchor: HTMLElement | null; onClose: () => void; className: string; children: ReactNode; align?: 'start' | 'end';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!anchor || !el) return;
    const a = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = align === 'end' ? a.right - w : a.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = a.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, a.top - h - 6);
    setPos({ left, top });
  }, [anchor, align]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node) || anchor?.contains(e.target as Node)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const scroll = (e: Event) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [anchor, onClose]);
  return createPortal(
    <div ref={ref} className={`popover ${className}`} style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 }}>{children}</div>,
    document.body,
  );
}

// ------------------------------------------------------------------ toasts
interface Toast { id: number; text: string; bad?: boolean }
const ToastCtx = createContext<(text: string, bad?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, bad?: boolean) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, bad }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.bad ? ' bad' : ''}`}>
            <Icon name={t.bad ? 'warning' : 'check'} />
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
