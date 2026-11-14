// Shared UI building blocks: icons, avatars, controls, toasts and formatting helpers.
import { createContext, useCallback, useContext, useState } from 'react';
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

export function Avatar({ user, online, size }: { user: Pick<PublicUser, 'id' | 'displayName'>; online?: boolean; size?: 'sm' | 'lg' }) {
  return (
    <span className={`avatar${size ? ` ${size}` : ''}`} style={{ background: colorFor(user.id) }} title={user.displayName}>
      {initials(user.displayName)}
      {online !== undefined && <span className={`presence${online ? ' on' : ''}`} aria-label={online ? 'online' : 'offline'} />}
    </span>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="toggle" onClick={() => onChange(!checked)} />;
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

export const ROLE_LABEL: Record<PublicUser['role'], string> = { owner: 'Owner', admin: 'Admin', member: 'Member', guest: 'Guest' };

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
