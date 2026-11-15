// Pulse's way into the office drawing: who is new this month, whose birthday or work anniversary
// it is, and one colleague from another department to meet today. Each opens the drawing at them.
import { useMemo } from 'react';
import type { PublicUser } from '@dex/core';
import { tr } from '../i18n/index.ts';
import { Avatar, presenceFor } from '../ui.tsx';
import { useOrg } from '../org/store.ts';
import { marksFor } from './layout.ts';
import { requestChart } from './request.ts';
import './orgscape.css';

/** Today's colleague to meet: someone from another department, the same for everyone all day. */
export function meetToday(people: PublicUser[], me: PublicUser, day = Math.floor(Date.now() / 86400_000)): PublicUser | null {
  const pool = people.filter((u) => u.id !== me.id && u.role !== 'guest' && u.role !== 'bot' && (!me.profile.departmentId || u.profile.departmentId !== me.profile.departmentId))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!pool.length) return null;
  let h = day;
  for (const ch of me.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return pool[h % pool.length];
}

export function OfficeDrawingCard({ users, me, onOpen }: { users: PublicUser[]; me: PublicUser; onOpen: () => void }) {
  const org = useOrg();
  const people = useMemo(() => users.filter((u) => u.role !== 'bot' && u.role !== 'guest'), [users]);
  const today = useMemo(() => {
    const now = new Date();
    const fresh: PublicUser[] = [], cake: PublicUser[] = [], years: Array<[PublicUser, number]> = [];
    for (const u of people) { const m = marksFor(u, now); if (m.isNew) fresh.push(u); if (m.birthday) cake.push(u); if (m.years) years.push([u, m.years]); }
    return { fresh, cake, years };
  }, [people]);
  const meet = useMemo(() => meetToday(people, me), [people, me]);
  const dept = (u: PublicUser) => org.departments.find((d) => d.id === u.profile.departmentId)?.name ?? '';
  const go = (id: string) => { requestChart(id); onOpen(); };
  if (people.length < 2) return null;
  return (
    <div className="card office-card">
      <div className="eyebrow">The office drawing</div>
      {today.fresh.length > 0 && (
        <div className="oc-row">
          <span className="tb-k">{tr(`New this month · ${today.fresh.length}`)}</span>
          <div className="oc-faces">{today.fresh.slice(0, 5).map((u) => (
            <button key={u.id} type="button" className="oc-face" onClick={() => go(u.id)} aria-label={tr(`${u.displayName} on the drawing`)} title={u.displayName}>
              <Avatar user={u} presence={presenceFor(u.id)} size="sm" />
            </button>
          ))}</div>
        </div>
      )}
      {(today.cake.length > 0 || today.years.length > 0) && (
        <div className="oc-row oc-today">
          {today.cake.slice(0, 2).map((u) => <button key={u.id} type="button" className="tb-link" onClick={() => go(u.id)}>{tr(`Birthday today: ${u.displayName.split(/\s+/)[0]}`)}</button>)}
          {today.years.slice(0, 2).map(([u, n]) => <button key={u.id} type="button" className="tb-link" onClick={() => go(u.id)}>{n === 1 ? tr(`${u.displayName.split(/\s+/)[0]}: 1 year here today`) : tr(`${u.displayName.split(/\s+/)[0]}: ${n} years here today`)}</button>)}
        </div>
      )}
      {meet && (
        <button type="button" className="oc-meet" onClick={() => go(meet.id)}>
          <Avatar user={meet} presence={presenceFor(meet.id)} size="sm" />
          <span className="oc-meet-who">
            <span className="tb-k">{dept(meet) ? tr(`Meet someone in ${dept(meet)}`) : tr('Meet someone today')}</span>
            <b translate="no">{meet.displayName}</b>
            <span className="faint" translate="no">{[meet.title, meet.profile.location].filter(Boolean).join(' · ')}</span>
          </span>
        </button>
      )}
      <button type="button" className="link oc-open" onClick={() => go(me.id)}>Open the drawing</button>
    </div>
  );
}
