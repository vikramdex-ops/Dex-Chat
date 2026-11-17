// Small pieces shared by the Room's surfaces: glyphs drawn on the shared icon grid, video and
// audio elements bound to streams, and the running clock of a Room.
import { useEffect, useRef, useState } from 'react';

/** Glyphs only the Room uses, drawn on the same 24 px grid and stroke as the shared icon set. */
export const GLYPHS = {
  float: 'M3.5 5h17v14h-17zM12 12h6.5v5H12z',
  blur: 'M12 4.5a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM6.5 19.5c.6-3.2 2.8-5.2 5.5-5.2s4.9 2 5.5 5.2M3 7h1M3 11h1M3 15h1M20 7h1M20 11h1M20 15h1',
  ring: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6 9c.5-3.4 2.9-5.5 6-5.5 1.5 0 2.8.5 3.8 1.4M18 13.5v7M14.5 17h7',
  chevron: 'm7 10 5 5 5-5',
  door: 'M5 20.5h14M7 20.5V3.5h8.5v17M12.5 12h.01M15.5 6.5l3-1.5v15.5',
  fold: 'M4 4.5h16M12 20V9M7.5 13.5 12 9l4.5 4.5',
  hand: 'M8.5 12.5V6a1.4 1.4 0 0 1 2.8 0v5.5M11.3 11V4.6a1.4 1.4 0 0 1 2.8 0V11M14.1 11.2V6.2a1.4 1.4 0 0 1 2.8 0v7.3c0 4.1-2.4 7-5.9 7-2.5 0-4-1.2-5.3-3.3l-2.2-3.6a1.35 1.35 0 0 1 2.2-1.6l1.8 2.2',
  gallery: 'M3.5 4.5h7.5v6.5H3.5zM13 4.5h7.5v6.5H13zM3.5 13h7.5v6.5H3.5zM13 13h7.5v6.5H13z',
  speaker: 'M3.5 4h17v11h-17zM3.5 17.5h4.5V20H3.5zM9.75 17.5h4.5V20h-4.5zM16 17.5h4.5V20H16z',
  presentation: 'M3.5 4.5h12.5v11H3.5zM18 4.5h2.5v3H18zM18 9.5h2.5v3H18zM18 14.5h2.5v3H18zM6.5 8.5h6.5M6.5 11.5h4',
  spotlight: 'M12 2.8v2.4M5.5 5.5l1.7 1.7M18.5 5.5l-1.7 1.7M8 14.2a4 4 0 1 1 8 0c0 1.4-.7 2.3-1.4 3H9.4c-.7-.7-1.4-1.6-1.4-3zM9.5 20.5h5',
  react: 'M12 20.5a8.5 8.5 0 1 1 0-17 8.5 8.5 0 0 1 0 17zM8.5 14c.9 1.3 2.1 2 3.5 2s2.6-.7 3.5-2M9 9.5h.01M15 9.5h.01',
  backdrop: 'M3.5 4.5h17v15h-17zM12 8.5a2.3 2.3 0 1 1 0 4.6 2.3 2.3 0 0 1 0-4.6zM7.5 19.5c.5-2.6 2.3-4.2 4.5-4.2s4 1.6 4.5 4.2M3.5 9h3M17.5 9h3',
  copy: 'M8.5 8.5h11v11h-11zM5 15.5H4.5v-11h11V5',
  more: 'M5.5 12h.01M12 12h.01M18.5 12h.01',
  people: 'M9 11a3.2 3.2 0 1 0 0-6.4A3.2 3.2 0 0 0 9 11zm-5.5 8.5c.5-3 2.7-5 5.5-5s5 2 5.5 5M16 5a3 3 0 0 1 0 6M17.5 14.6c1.7.6 2.8 2.3 3 4.9',
} as const;

export function Glyph({ name, size = 18 }: { name: keyof typeof GLYPHS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={name === 'more' ? 2.6 : 1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={GLYPHS[name]} />
    </svg>
  );
}

export function Video({ stream, muted, mirror, fit = 'cover' }: { stream: MediaStream; muted?: boolean; mirror?: boolean; fit?: 'cover' | 'contain' }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream; }, [stream]);
  return <video ref={ref} autoPlay playsInline muted={muted} style={{ transform: mirror ? 'scaleX(-1)' : undefined, objectFit: fit }} />;
}

export function AudioOut({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => { if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream; }, [stream]);
  return <audio ref={ref} autoPlay />;
}

/** "12:04" since a moment, ticking once a second while shown. */
export function useDuration(since: number | undefined): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  if (!since) return '0:00';
  const s = Math.max(0, Math.floor((now - since) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s % 60).padStart(2, '0')}`;
}

/** The running time as its own small component, so the clock re-renders only itself. */
export function Clock({ since, className }: { since: number | undefined; className?: string }) {
  return <span className={className}>{useDuration(since)}</span>;
}
