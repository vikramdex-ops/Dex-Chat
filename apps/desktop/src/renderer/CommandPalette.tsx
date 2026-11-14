// Ctrl+K: one box to find people and run commands. Arrow keys move, Enter runs, Esc closes.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PublicUser } from '@dex/core';
import { Avatar, Icon } from './ui.tsx';
import type { IconName } from './ui.tsx';

interface Command { id: string; label: string; icon: IconName; run: () => void }

export function CommandPalette({ users, online, commands, onClose, onPerson }: {
  users: PublicUser[];
  online: Set<string>;
  commands: Command[];
  onClose: () => void;
  onPerson: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);

  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    const people = users
      .filter((u) => !s || [u.displayName, u.account, u.title ?? '', u.statusText ?? ''].some((f) => f.toLowerCase().includes(s)))
      .sort((a, b) => Number(online.has(b.id)) - Number(online.has(a.id)) || a.displayName.localeCompare(b.displayName))
      .slice(0, 8)
      .map((u) => ({ kind: 'person' as const, id: u.id, user: u }));
    const cmds = commands
      .filter((c) => !s || c.label.toLowerCase().includes(s))
      .map((c) => ({ kind: 'command' as const, id: c.id, command: c }));
    return s ? [...people, ...cmds] : [...cmds, ...people];
  }, [q, users, online, commands]);

  useEffect(() => { setIndex(0); }, [q]);

  const run = (i: number) => {
    const r = results[i];
    if (!r) return;
    onClose();
    if (r.kind === 'person') onPerson(r.id); else r.command.run();
  };

  return (
    <div className="scrim palette-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search and commands">
        <div className="palette-input">
          <Icon name="search" size={18} />
          <input
            ref={input}
            value={q}
            placeholder="Find a person or a command"
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
          {results.length === 0 && <li className="palette-empty">Nothing matches “{q}”.</li>}
          {results.map((r, i) => (
            <li key={r.id} id={`pal-${r.id}`} role="option" aria-selected={i === index}
              onMouseEnter={() => setIndex(i)} onMouseDown={(e) => { e.preventDefault(); run(i); }}>
              {r.kind === 'person' ? (
                <>
                  <Avatar user={r.user} presence={online.has(r.id) ? 'on' : 'off'} size="sm" />
                  <span className="pal-main">{r.user.displayName}</span>
                  <span className="pal-meta mono">{r.user.account}</span>
                </>
              ) : (
                <>
                  <span className="pal-icon"><Icon name={r.command.icon} size={16} /></span>
                  <span className="pal-main">{r.command.label}</span>
                  <span className="pal-meta">Command</span>
                </>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
