// Ctrl+G (GO TO): one box to find people and conversations and run commands. Arrow keys move, Enter runs, Esc closes.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Message, PublicUser } from '@dex/core';
import { Avatar, Icon, presenceFor } from './ui.tsx';
import type { IconName } from './ui.tsx';

interface Command { id: string; label: string; icon: IconName; run: () => void; hint?: string }

type Hit = { message: Message; snippet: string };

/** "a [[match]] here" → text with <mark>s */
function Snippet({ text }: { text: string }) {
  const parts = text.replace(/<@[0-9A-Z]{26}>/g, '@…').split(/\[\[|\]\]/);
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>))}</>;
}

export function CommandPalette({ users, online, commands, onClose, onPerson, convName, onMessage, onSearch }: {
  users: PublicUser[];
  online: Set<string>;
  commands: Command[];
  onClose: () => void;
  onPerson: (id: string) => void;
  convName?: (convId: string) => string;
  onMessage?: (m: Message) => void;
  onSearch?: (q: string) => void;
}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2 || !onMessage) { setHits([]); return; }
    setSearching(true);
    const t = setTimeout(() => {
      void window.dex.request('search', { q: term, limit: 12 }).then((r) => setHits(r.messages)).catch(() => setHits([])).finally(() => setSearching(false));
    }, 180);
    return () => clearTimeout(t);
  }, [q, onMessage]);
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);

  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    const people = users
      .filter((u) => u.role !== 'bot')
      .filter((u) => !s || [u.displayName, u.account, u.title ?? '', u.statusText ?? ''].some((f) => f.toLowerCase().includes(s)))
      .sort((a, b) => Number(online.has(b.id)) - Number(online.has(a.id)) || a.displayName.localeCompare(b.displayName))
      .slice(0, 8)
      .map((u) => ({ kind: 'person' as const, id: u.id, user: u }));
    const cmds = commands
      .filter((c) => !s || c.label.toLowerCase().includes(s))
      .map((c) => ({ kind: 'command' as const, id: c.id, command: c }));
    const msgs = hits.map((h) => ({ kind: 'message' as const, id: `m-${h.message.id}`, hit: h }));
    const all = s.length >= 2 && onSearch ? [{ kind: 'command' as const, id: 'search-all', command: { id: 'search-all', label: `Search everything for “${q.trim()}” with filters`, icon: 'search' as IconName, hint: 'Search', run: () => onSearch(q.trim()) } }] : [];
    return s ? [...cmds.filter((c) => c.command.hint).slice(0, 5), ...people.slice(0, 5), ...msgs, ...all, ...cmds.filter((c) => !c.command.hint)].slice(0, 24)
      : [...cmds.filter((c) => !c.command.hint), ...people.slice(0, 5)];
  }, [q, users, online, commands, hits, onSearch]);

  useEffect(() => { setIndex(0); }, [q]);

  const run = (i: number) => {
    const r = results[i];
    if (!r) return;
    onClose();
    if (r.kind === 'person') onPerson(r.id);
    else if (r.kind === 'message') onMessage?.(r.hit.message);
    else r.command.run();
  };

  return (
    <div className="scrim palette-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Go to">
        <div className="palette-input">
          <span className="palette-goto">Go to ▸</span>
          <input
            ref={input}
            value={q}
            placeholder="A person, a conversation, a command or words in a message"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(results.length - 1, i + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); run(index); }
              else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            }}
            aria-activedescendant={results[index] ? `pal-${results[index].id}` : undefined}
          />
          <span className="kbd">Esc</span>
        </div>
        <ul className="palette-list" role="listbox">
          {results.length === 0 && <li className="palette-empty">{searching ? 'Searching messages…' : `Nothing matches “${q}”.`}</li>}
          {results.map((r, i) => (
            <li key={r.id} id={`pal-${r.id}`} role="option" aria-selected={i === index}
              onMouseEnter={() => setIndex(i)} onMouseDown={(e) => { e.preventDefault(); run(i); }}>
              {r.kind === 'message' ? (
                <>
                  <span className="pal-icon"><Icon name="doc" size={16} /></span>
                  <span className="pal-main pal-snippet"><Snippet text={r.hit.snippet} /></span>
                  <span className="pal-meta">{users.find((u) => u.id === r.hit.message.authorId)?.displayName.split(' ')[0]} · {convName?.(r.hit.message.convId) ?? ''}</span>
                </>
              ) : r.kind === 'person' ? (
                <>
                  <Avatar user={r.user} presence={presenceFor(r.id)} size="sm" />
                  <span className="pal-main">{r.user.displayName}</span>
                  <span className="pal-meta mono">{r.user.account}</span>
                </>
              ) : (
                <>
                  <span className="pal-icon"><Icon name={r.command.icon} size={16} /></span>
                  <span className="pal-main">{r.command.label}</span>
                  <span className="pal-meta">{r.command.hint ?? 'Command'}</span>
                </>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
