// The office's custom emoji (added by administrators), kept live, and how they are drawn.
import { useSyncExternalStore } from 'react';
import type { CustomEmoji } from '@dex/core';
import { useFileSrc } from './chat/files.tsx';

let map = new Map<string, CustomEmoji>();
const subs = new Set<() => void>();
const set = (list: CustomEmoji[]) => { map = new Map(list.map((e) => [e.name, e] as const)); for (const f of subs) f(); };
let started = false;

export function startEmoji(): void {
  if (!started) {
    started = true;
    window.dex.onHubEvent((name, data) => { if (name === 'emoji.updated') set(data as CustomEmoji[]); });
  }
  void window.dex.request('emoji.list').then(set).catch(() => {});
}
export const customEmoji = () => map;
export const useCustomEmoji = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => map);

/** ":pipe:" → "pipe" when it names an office emoji. */
export const customName = (s: string) => { const m = /^:([a-z0-9][a-z0-9_-]{1,31}):$/.exec(s); return m && map.has(m[1]) ? m[1] : null; };

export function EmojiImg({ name, size = 20 }: { name: string; size?: number }) {
  const e = useCustomEmoji().get(name);
  const src = useFileSrc({ id: e?.fileId ?? 'none', name: `${name}.png` });
  if (!e) return <>{`:${name}:`}</>;
  return src ? <img className="custom-emoji" src={src} alt={`:${name}:`} title={`:${name}:`} width={size} height={size} /> : <span className="custom-emoji" style={{ width: size, height: size }} />;
}

/** A reaction or picker entry: a Unicode emoji, or an office one written :name:. */
export function EmojiGlyph({ emoji, size }: { emoji: string; size?: number }) {
  const n = /^:([a-z0-9][a-z0-9_-]{1,31}):$/.exec(emoji);
  return n ? <EmojiImg name={n[1]} size={size} /> : <>{emoji}</>;
}
