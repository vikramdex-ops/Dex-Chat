// Directory ▸ People ▸ Left the office: colleagues who were offboarded, and who to ask instead.
// They are no longer among the people you can message; their messages stay where they are.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LeftPerson, Session } from '@dex/core';
import { Avatar, Icon } from '../ui.tsx';
import './continuity.css';

export function LeftTheOffice({ session, query, onOpen }: { session: Session; query: string; onOpen: (userId: string) => void }) {
  const [list, setList] = useState<LeftPerson[]>([]);
  const [open, setOpen] = useState(false);
  const load = useCallback(() => { void window.dex.request('directory.left').then(setList).catch(() => {}); }, []);
  useEffect(() => {
    load();
    return window.dex.onHubEvent((n) => { if (n === 'user.left' || n === 'user.added') load(); });
  }, [load]);
  const names = useMemo(() => new Map(session.users.map((u) => [u.id, u.displayName] as const)), [session.users]);
  const q = query.trim().toLowerCase();
  const shown = list.filter((p) => !q || [p.user.displayName, p.user.account, p.user.title ?? ''].some((f) => f.toLowerCase().includes(q)));
  if (!list.length || (q && !shown.length)) return null;
  return (
    <div className="left-office">
      <button className="left-office-head" aria-expanded={open || !!q} onClick={() => setOpen(!open)}>
        <span className="label">Left the office · {shown.length}</span>
        <Icon name="chevron" size={16} />
      </button>
      {(open || !!q) && (
        <div className="left-office-list">
          {shown.map((p) => {
            const contact = names.get(p.contactId);
            return (
              <div key={p.user.id} className="left-person">
                <Avatar user={p.user} size="sm" />
                <div className="who">
                  <span className="name">{p.user.displayName}</span>
                  <span className="faint">{p.user.title || p.user.account}</span>
                  {contact && <span className="faint">Ask <button className="link" onClick={() => onOpen(p.contactId)}>{contact}</button> instead</span>}
                  <span className="left-stamp">Left {new Date(p.leftAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
