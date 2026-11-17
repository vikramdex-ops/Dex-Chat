// Control room ▸ People & roles: who works the IT desk (the `it` capability). People on the desk
// see the Help desk queue, take requests and open support sessions.
import { useState } from 'react';
import type { PublicUser, Session } from '@dex/core';
import { Avatar, Icon, useToast } from '../ui.tsx';
import { useHelp } from './store.ts';

export function ItDeskAdmin({ session, live }: { session: Session; live: boolean }) {
  const toast = useToast();
  const staff = useHelp((s) => s.staff);
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const people = session.users.filter((u) => u.role !== 'bot' && u.role !== 'guest');
  const byId = new Map(session.users.map((u) => [u.id, u] as const));
  const set = async (u: PublicUser, on: boolean) => {
    setBusy(true);
    try { await window.dex.request('admin.help.staff', { userId: u.id, on }); toast(on ? `${u.displayName} is on the IT desk` : `${u.displayName} is no longer on the IT desk`); setAdding(''); }
    catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  return (
    <section className="card it-desk" aria-label="IT desk">
      <div className="it-desk-head">
        <div>
          <h3>IT desk</h3>
          <p className="muted">People here receive help requests, see the queue and may start support sessions. Each session still needs the requester's own yes for their screen and their mouse and keyboard.</p>
        </div>
      </div>
      {staff.length === 0 && <p className="faint">No one yet: requests wait in the queue until someone is added.</p>}
      <ul className="it-desk-list">
        {staff.map((id) => {
          const u = byId.get(id);
          if (!u) return null;
          return (
            <li key={id}>
              <Avatar user={u} size="sm" /><span className="it-name">{u.displayName}</span><span className="mono faint">{u.account}</span>
              <button className="btn ghost danger sm" disabled={!live || busy} onClick={() => void set(u, false)}>Remove</button>
            </li>
          );
        })}
      </ul>
      <div className="it-desk-add">
        <select className="input" value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Person to add to the IT desk" disabled={!live}>
          <option value="">Add someone to the IT desk…</option>
          {people.filter((u) => !staff.includes(u.id)).map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
        </select>
        <button className="btn" disabled={!live || !adding || busy} onClick={() => { const u = byId.get(adding); if (u) void set(u, true); }}><Icon name="plus" size={15} />Add</button>
      </div>
    </section>
  );
}
