// Small pieces Nib's tray and cards share: a dimension-line progress bar, a stepper, a person
// picker with the Directory's names, a job tag and a giver's tile.
import { useId, useMemo, useRef, useState } from 'react';
import type { NibItem, NibItemLite, PublicUser } from '@dex/core';
import { Avatar } from '../ui.tsx';
import { fractionOf, qtyWords } from './words.ts';

/** Progress as a dimension line: ticks at both ends, the done part drawn in teal. */
export function DimBar({ value, blocked, label }: { value: number; blocked?: boolean; label?: string }) {
  const p = Math.max(0, Math.min(1, value));
  return (
    <span className={`nib-dim${blocked ? ' blocked' : ''}`} role="img" aria-label={label ?? `${Math.round(p * 100)}%`}>
      <span className="nib-dim-fill" style={{ width: `${p * 100}%` }} />
    </span>
  );
}

/** The numbers of an item: "18 / 40 sheets" and its bar, or only the words. */
export function ItemQty({ x }: { x: Pick<NibItem | NibItemLite, 'qty' | 'status'> }) {
  const f = fractionOf(x);
  const words = qtyWords(x.qty);
  if (!words && f === null) return null;
  return (
    <span className="nib-qty">
      {words && <span className="nib-qty-n mono" translate="no">{words}</span>}
      {f !== null && <DimBar value={f} blocked={x.status === 'blocked'} label={words || undefined} />}
    </span>
  );
}

export function ProjectTag({ code }: { code: string | null }) {
  return code ? <span className="nib-job mono" translate="no">{code}</span> : null;
}

/** Who gave it: their tile, or a lettered box for someone outside the Directory. */
export function GiverTile({ id, name, users }: { id: string | null; name: string | null; users: Map<string, PublicUser> }) {
  const u = id ? users.get(id) : undefined;
  if (u) return <Avatar user={u} size="sm" />;
  if (name) return <span className="nib-giver-box mono" title={name} translate="no">{name.slice(0, 2).toUpperCase()}</span>;
  return <span className="nib-giver-box none" aria-hidden="true" />;
}

/** − 18 + of 40 */
export function Stepper({ value, onChange, max, label }: { value: number; onChange: (v: number) => void; max?: number | null; label: string }) {
  const clamp = (v: number) => Math.max(0, max ? Math.min(max, v) : v);
  return (
    <span className="nib-stepper" role="group" aria-label={label}>
      <button type="button" className="icon-btn sm" aria-label="One less" onClick={() => onChange(clamp(value - 1))}>−</button>
      <input className="input mono" inputMode="decimal" aria-label={label} value={String(value)} onChange={(e) => { const v = Number(e.target.value.replace(',', '.')); if (Number.isFinite(v)) onChange(clamp(v)); }} />
      <button type="button" className="icon-btn sm" aria-label="One more" onClick={() => onChange(clamp(value + 1))}>+</button>
    </span>
  );
}

/** Type a name; the Directory completes it (arrows and Enter choose). */
export function PersonPick({ users, exclude, onPick, placeholder, label }: { users: PublicUser[]; exclude: string[]; onPick: (u: PublicUser) => void; placeholder: string; label: string }) {
  const id = useId();
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const hits = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    return users.filter((u) => u.role !== 'bot' && u.role !== 'guest' && !exclude.includes(u.id) && u.displayName.toLowerCase().split(/\s+/).some((w) => w.startsWith(t) || u.displayName.toLowerCase().startsWith(t))).slice(0, 6);
  }, [q, users, exclude]);
  const pick = (u: PublicUser) => { onPick(u); setQ(''); setAt(0); input.current?.focus(); };
  return (
    <div className="nib-person">
      <input ref={input} className="input" role="combobox" aria-expanded={hits.length > 0} aria-controls={`${id}-list`} aria-autocomplete="list" aria-label={label} placeholder={placeholder}
        aria-activedescendant={hits[at] ? `${id}-${hits[at].id}` : undefined} value={q}
        onChange={(e) => { setQ(e.target.value); setAt(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setAt((a) => Math.min(hits.length - 1, a + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((a) => Math.max(0, a - 1)); }
          else if (e.key === 'Enter' && hits[at]) { e.preventDefault(); pick(hits[at]); }
        }} />
      {hits.length > 0 && (
        <ul id={`${id}-list`} role="listbox" className="nib-person-list" aria-label={label}>
          {hits.map((u, i) => (
            <li key={u.id} id={`${id}-${u.id}`} role="option" aria-selected={i === at} className={i === at ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); pick(u); }}>
              <Avatar user={u} size="sm" /><span translate="no">{u.displayName}</span>{u.title && <span className="faint" translate="no">{u.title}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
