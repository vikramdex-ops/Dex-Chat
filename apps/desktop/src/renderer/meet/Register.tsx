// The Register sheet tab beside the Room: a drawing's register for the meeting. 01 Agenda (time
// boxes, ticked off as it goes), 02 Action points (those brought forward from earlier occurrences
// first, then this meeting's, and a last row to log one), 03 Decisions taken in this meeting.
import { useEffect, useState } from 'react';
import { AGENDA_MAX } from '@dex/core';
import type { AgendaItem, PublicUser, RoomInfo } from '@dex/core';
import { Icon, useToast } from '../ui.tsx';
import { useChat } from '../chat/store.ts';
import { ApStrip, useRegister } from './actions.tsx';
import { CaptureForm } from './Capture.tsx';

/** A thread's agenda (the running occurrence's, or the next one's), kept up to date. */
export function useAgenda(convId: string | null): { occurrenceId: string | null; items: AgendaItem[] } | null {
  const [a, setA] = useState<{ occurrenceId: string | null; items: AgendaItem[] } | null>(null);
  useEffect(() => {
    if (!convId) return;
    let live = true;
    void window.dex.request('agenda.get', { convId }).then((x) => { if (live) setA(x); }).catch(() => {});
    const off = window.dex.onHubEvent((name, data) => {
      const d = data as { convId: string; occurrenceId: string | null; items: AgendaItem[] };
      if (name === 'agenda.updated' && d.convId === convId) setA({ occurrenceId: d.occurrenceId, items: d.items });
      if (name === 'meet.occurrence' && (data as { convId: string }).convId === convId) void window.dex.request('agenda.get', { convId }).then((x) => { if (live) setA(x); }).catch(() => {});
    });
    return () => { live = false; off(); };
  }, [convId]);
  return a;
}

export default function Register({ room, users, meId }: { room: RoomInfo; users: Map<string, PublicUser>; meId: string }) {
  const reg = useRegister(room.convId, room.occurrenceId);
  const carried = (reg.actions ?? []).filter((a) => a.carried);
  const own = (reg.actions ?? []).filter((a) => !a.carried);
  const msgs = useChat((s) => s.timelines.get(room.convId)?.messages);
  const decisions = (msgs ?? []).filter((m) => m.decision && !m.deleted && m.createdAt >= room.startedAt);
  return (
    <div className="meet-register">
      <AgendaPart convId={room.convId} />
      <section className="reg-sec" aria-labelledby="reg-02">
        <h3 id="reg-02" className="recap-label"><span className="mono">02</span>ACTION POINTS<span className="mono faint">{own.length + carried.length}</span></h3>
        {reg.actions === null && <div className="tl-more"><span className="spinner" /></div>}
        {carried.length > 0 && <p className="reg-sub mono">{carried.length === 1 ? 'BROUGHT FORWARD · 1 OPEN FROM EARLIER' : `BROUGHT FORWARD · ${carried.length} OPEN FROM EARLIER`}</p>}
        {carried.map((a) => <div key={a.id} className="reg-ap"><div className="reg-ap-text" translate="no">{a.text || <span className="faint">Encrypted: open it in the thread</span>}</div><ApStrip ap={a} users={users} meId={meId} compact /></div>)}
        {carried.length > 0 && <p className="reg-sub mono">THIS MEETING</p>}
        {reg.actions !== null && !own.length && <p className="meet-empty">Nothing logged yet. Type below, or press A on the stage.</p>}
        {own.map((a) => <div key={a.id} className="reg-ap"><div className="reg-ap-text" translate="no">{a.text || <span className="faint">Encrypted: open it in the thread</span>}</div><ApStrip ap={a} users={users} meId={meId} compact /></div>)}
        <CaptureForm room={room} convId={room.convId} users={users} meId={meId} source="register" next={reg.next} />
      </section>
      <section className="reg-sec" aria-labelledby="reg-03">
        <h3 id="reg-03" className="recap-label"><span className="mono">03</span>DECISIONS<span className="mono faint">{decisions.length}</span></h3>
        {!decisions.length && <p className="meet-empty">Decisions asked in the meeting's conversation appear here.</p>}
        {decisions.map((m) => <div key={m.id} className="reg-decision"><Icon name="decision" size={14} /><span translate="no">{m.decision!.question}</span></div>)}
      </section>
    </div>
  );
}

/** The agenda: anyone in the thread writes it ("10 GA comments" is ten minutes on the GA comments) and ticks it off. */
function AgendaPart({ convId }: { convId: string }) {
  const toast = useToast();
  const agenda = useAgenda(convId);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const items = agenda?.items ?? [];
  const now = items.find((i) => !i.doneAt);
  const save = () => {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, AGENDA_MAX);
    const list = lines.map((l, i) => {
      const m = /^(\d{1,3})\s*(?:m|min|mins|minutes)?\s*[-–:·]?\s+(.+)$/i.exec(l);
      return { id: items[i]?.text === (m ? m[2] : l) ? items[i].id : undefined, text: m ? m[2] : l, minutes: m ? Number(m[1]) : null };
    });
    void window.dex.request('agenda.set', { convId, items: list }).then(() => setEditing(false)).catch((e: Error) => toast(e.message, true));
  };
  const tick = (i: AgendaItem) => void window.dex.request('agenda.tick', { convId, id: i.id, done: !i.doneAt }).catch((e: Error) => toast(e.message, true));
  const total = items.reduce((s, i) => s + (i.minutes ?? 0), 0);
  return (
    <section className="reg-sec" aria-labelledby="reg-01">
      <h3 id="reg-01" className="recap-label"><span className="mono">01</span>AGENDA<span className="mono faint">{total ? `${total} MIN` : items.length || ''}</span>
        {!editing && <button className="link sm reg-edit" onClick={() => { setText(items.map((i) => (i.minutes ? `${i.minutes} ${i.text}` : i.text)).join('\n')); setEditing(true); }}>{items.length ? 'Change' : 'Write the agenda'}</button>}
      </h3>
      {editing ? (
        <div className="reg-agenda-edit">
          <textarea className="input" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={'10 GA comments from the client\n15 Nozzle loads\n5 Next steps'} aria-label="The agenda, one item a line, minutes first" />
          <p className="faint small">One item a line. Minutes first make a time box.</p>
          <div className="row-actions"><button className="btn ghost sm" onClick={() => setEditing(false)}>Cancel</button><button className="btn primary sm" onClick={save}>Save the agenda</button></div>
        </div>
      ) : (
        <ol className="reg-agenda">
          {!items.length && <li className="meet-empty">No agenda yet.</li>}
          {items.map((i) => (
            <li key={i.id} className={`${i.doneAt ? 'done' : ''}${i === now ? ' now' : ''}`}>
              <button className="ap-box" role="checkbox" aria-checked={!!i.doneAt} aria-label={i.doneAt ? `${i.text}: covered` : `Tick off ${i.text}`} onClick={() => tick(i)}>{i.doneAt && <Icon name="check" size={12} />}</button>
              <span className="mono">{String(i.n).padStart(2, '0')}</span>
              <span className="reg-agenda-text" translate="no">{i.text}</span>
              {i.minutes && <span className="mono faint">{i.minutes} MIN</span>}
              {i === now && <span className="tag live mono">NOW</span>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

