// The emoji picker: search, recently used first, the office's own emoji, then the groups.
import { useMemo, useState } from 'react';
import { ALL_EMOJI, EMOJI_GROUPS } from './emoji-data.ts';
import { EmojiImg, useCustomEmoji } from '../emoji.tsx';

const RECENT_KEY = 'dex-emoji-recent';
function recent(): string[] { try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[]; } catch { return []; } }
function remember(e: string): void { try { localStorage.setItem(RECENT_KEY, JSON.stringify([e, ...recent().filter((x) => x !== e)].slice(0, 16))); } catch { /* storage off */ } }

export function EmojiPicker({ onPick, className = '', onClose }: { onPick: (emoji: string) => void; className?: string; onClose?: () => void }) {
  const [q, setQ] = useState('');
  const custom = useCustomEmoji();
  const pick = (e: string) => { remember(e); onPick(e); };
  const s = q.trim().toLowerCase();
  const found = useMemo(() => (s ? [
    ...[...custom.keys()].filter((n) => n.includes(s.replace(/:/g, ''))).map((n) => `:${n}:`),
    ...ALL_EMOJI.filter((x) => x.words.includes(s)).map((x) => x.e),
  ].slice(0, 80) : []), [s, custom]);
  const cell = (e: string) => (
    <button key={e} type="button" title={e.startsWith(':') ? e : ALL_EMOJI.find((x) => x.e === e)?.words.split(' ')[0]} onClick={() => pick(e)}>
      {e.startsWith(':') ? <EmojiImg name={e.slice(1, -1)} /> : e}
    </button>
  );
  const rec = recent();
  return (
    <div className={`emoji-picker ${className}`} role="dialog" aria-label="Emoji" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); } }}>
      <input className="input" autoFocus placeholder="Find an emoji" value={q} onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && found[0]) { e.preventDefault(); pick(found[0]); } }} aria-label="Find an emoji" />
      <div className="emoji-scroll">
        {s ? (found.length ? <div className="emoji-grid">{found.map(cell)}</div> : <p className="faint" style={{ fontSize: 12.5, padding: 8 }}>No emoji called “{q}”.</p>) : (
          <>
            {rec.length > 0 && <><div className="emoji-group">Recent</div><div className="emoji-grid">{rec.map(cell)}</div></>}
            {custom.size > 0 && <><div className="emoji-group">This office</div><div className="emoji-grid">{[...custom.keys()].map((n) => cell(`:${n}:`))}</div></>}
            {EMOJI_GROUPS.map((g) => <div key={g.name}><div className="emoji-group">{g.name}</div><div className="emoji-grid">{g.items.map((it) => cell(it.slice(0, it.indexOf(' '))))}</div></div>)}
          </>
        )}
      </div>
    </div>
  );
}
