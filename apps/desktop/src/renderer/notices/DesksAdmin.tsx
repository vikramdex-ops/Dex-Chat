// Control room ▸ Notice desks (docs/ANNOUNCEMENTS.md): the issuing desks and who issues for each;
// how long withdrawn and expired notices are kept; the register's export; and moving the Office
// space's pinned messages onto the board.
import { useEffect, useMemo, useState } from 'react';
import type { FileInfo, NoticeCategory, NoticeDesk, Session } from '@dex/core';
import { Avatar, Icon, useToast } from '../ui.tsx';
import { plainPreview } from '../chat/format.tsx';
import { CAT_LABEL, CATEGORY_ORDER, dateText } from './parts.tsx';
import { reloadNotices } from './store.ts';
import './notices.css';

type Pin = { messageId: string; body: string; authorId: string; createdAt: number; files: FileInfo[] };

export function NoticeDesksAdmin({ session }: { session: Session }) {
  const toast = useToast();
  const [desks, setDesks] = useState<NoticeDesk[] | null>(null);
  const [retention, setRetention] = useState<number | null>(null);
  const [adding, setAdding] = useState({ code: '', name: '' });
  const [pins, setPins] = useState<Pin[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [moveTo, setMoveTo] = useState<{ deskId: string; category: NoticeCategory }>({ deskId: '', category: 'notice' });
  const [busy, setBusy] = useState<string | null>(null);
  const users = useMemo(() => new Map(session.users.map((u) => [u.id, u] as const)), [session.users]);
  const people = session.users.filter((u) => u.role !== 'bot' && u.role !== 'guest');
  const take = (r: { desks: NoticeDesk[]; retentionDays: number | null }) => { setDesks(r.desks); setRetention(r.retentionDays); };
  useEffect(() => {
    void window.dex.request('admin.notices.get').then((r) => { take(r); setMoveTo((m) => ({ ...m, deskId: m.deskId || (r.desks.find((d) => d.code === 'ADM') ?? r.desks[0])?.id || '' })); }).catch((e: Error) => toast(e.message, true));
    void window.dex.request('admin.notices.pinned').then(setPins).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveDesk = async (d: { id?: string; code: string; name: string; issuers: string[] }, ok: string) => {
    try { take(await window.dex.request('admin.notices.setDesk', d)); void reloadNotices(); toast(ok); return true; } catch (e) { toast((e as Error).message, true); return false; }
  };
  const exportAs = async (format: 'json' | 'csv' | 'html') => {
    setBusy(format);
    try {
      const r = await window.dex.request('admin.notices.export', { format });
      toast(r.notices === 1 ? 'Exported 1 notice' : `Exported ${r.notices} notices`);
      if (window.dex.saveFile) await window.dex.saveFile(r.file.id, r.file.name); else await window.dex.openFile?.(r.file.id, r.file.name);
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(null); }
  };
  const move = async () => {
    setBusy('move');
    try {
      const r = await window.dex.request('admin.notices.import', { messageIds: [...chosen], deskId: moveTo.deskId, category: moveTo.category });
      toast(r.created === 1 ? 'Moved 1 message onto the notice board' : `Moved ${r.created} messages onto the notice board`);
      setChosen(new Set()); setPins(await window.dex.request('admin.notices.pinned')); void reloadNotices();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(null); }
  };
  if (!desks) return <div className="tl-more"><span className="spinner" /></div>;

  return (
    <div className="settings nb-admin">
      <p className="muted nb-admin-intro">Official notices go on the notice board, numbered by the desk that issues them. Choose who issues for each desk; administrators can issue for any desk, and only they can issue urgent notices.</p>
      <section>
        <h3>Issuing desks</h3>
        {desks.map((d) => (
          <div key={d.id} className="setting nb-desk">
            <span className="nb-desk-code mono" translate="no">{d.code}</span>
            <div className="txt">
              <div><span translate="no">{d.name}</span>{d.issued > 0 && <span className="faint">{d.issued === 1 ? ' · 1 notice issued' : ` · ${d.issued} notices issued`}</span>}</div>
              <div className="faint">{d.issuers.length ? (d.issuers.length === 1 ? '1 issuer' : `${d.issuers.length} issuers`) : 'No issuers yet: only administrators issue for it.'}</div>
              <div className="nib-pick">
                {d.issuers.map((id) => { const u = users.get(id); return u ? <button key={id} type="button" className="nib-giver on rm" aria-pressed onClick={() => void saveDesk({ ...d, issuers: d.issuers.filter((x) => x !== id) }, `${u.displayName} no longer issues for ${d.name}`)} title="Remove" aria-label={`Remove ${u.displayName} from ${d.name}`}><Avatar user={u} size="sm" /><span className="nib-giver-name" translate="no" title={u.displayName}>{u.displayName}</span><Icon name="x" size={12} /></button> : null; })}
              </div>
              <select className="input nb-add-issuer" aria-label={`Add an issuer for ${d.name}`} value="" onChange={(e) => { const u = users.get(e.target.value); if (u) void saveDesk({ ...d, issuers: [...d.issuers, u.id] }, `${u.displayName} now issues for ${d.name}`); }}>
                <option value="">Add an issuer…</option>
                {people.filter((u) => !d.issuers.includes(u.id)).map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
              </select>
            </div>
            {d.issued === 0 && <button className="btn ghost danger sm" onClick={() => void window.dex.request('admin.notices.removeDesk', { id: d.id }).then(take).catch((e: Error) => toast(e.message, true))}>Remove</button>}
          </div>
        ))}
        <form className="setting nb-desk-new" onSubmit={(e) => { e.preventDefault(); void saveDesk({ code: adding.code, name: adding.name, issuers: [] }, `Added the ${adding.name} desk`).then((ok) => { if (ok) setAdding({ code: '', name: '' }); }); }}>
          <Icon name="plus" className="lead" />
          <div className="txt nb-desk-fields">
            <input className="input mono" aria-label="Desk code" placeholder="QA" maxLength={4} value={adding.code} onChange={(e) => setAdding({ ...adding, code: e.target.value.toUpperCase().replace(/[^A-Z]/g, '') })} />
            <input className="input" aria-label="Desk name" placeholder="Quality" maxLength={60} value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} />
          </div>
          <button className="btn" disabled={adding.code.length < 2 || !adding.name.trim()}>Add a desk</button>
        </form>
      </section>

      <section>
        <h3>Records</h3>
        <div className="setting">
          <Icon name="archive" className="lead" />
          <div className="txt"><div>Keep withdrawn and expired notices</div><div className="faint">Notices in force are always kept. A legal hold on a notice’s author keeps theirs past this.</div></div>
          <select className="input nb-select" aria-label="Keep withdrawn and expired notices" value={String(retention ?? '')}
            onChange={(e) => void window.dex.request('admin.notices.setRetention', { days: e.target.value ? Number(e.target.value) : null }).then((r) => { take(r); toast('Saved'); }).catch((er: Error) => toast(er.message, true))}>
            <option value="">For ever</option>
            <option value="365">1 year</option>
            <option value="1095">3 years</option>
            <option value="2555">7 years</option>
          </select>
        </div>
        <div className="setting">
          <Icon name="download" className="lead" />
          <div className="txt"><div>Export the register</div><div className="faint">Every notice and revision, who it was for, what changed, and every acknowledgement with its time.</div></div>
          <div className="nb-export">
            {(['csv', 'html', 'json'] as const).map((fm) => <button key={fm} className="btn sm" disabled={!!busy} onClick={() => void exportAs(fm)}>{busy === fm ? <span className="spinner" /> : null}<span className="mono">{fm.toUpperCase()}</span></button>)}
          </div>
        </div>
      </section>

      <section>
        <h3>Pinned in the Office space</h3>
        {pins.length === 0 ? <p className="faint">No messages are pinned in the Office space.</p> : (
          <div className="setting nb-pins">
            <Icon name="pin" className="lead" />
            <div className="txt">
              <div>Move pinned messages onto the notice board</div>
              <div className="faint">Each becomes a notice issued to everyone on the day it was posted: its first line the title, its first PDF the attachment. The pin comes off the message.</div>
              <ul className="nb-pin-list">
                {pins.map((p) => (
                  <li key={p.messageId}>
                    <label className={`nb-opt${chosen.has(p.messageId) ? ' on' : ''}`}>
                      <input type="checkbox" checked={chosen.has(p.messageId)} onChange={() => { const s = new Set(chosen); if (s.has(p.messageId)) s.delete(p.messageId); else s.add(p.messageId); setChosen(s); }} />
                      <span className="nb-pin-text"><span translate="no">{plainPreview(p.body, users).slice(0, 140)}</span><span className="faint"><span translate="no">{users.get(p.authorId)?.displayName ?? ''}</span>{` · ${dateText(p.createdAt)}`}{p.files.length ? ` · ${p.files.length === 1 ? '1 file' : `${p.files.length} files`}` : ''}</span></span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="nb-move">
                <select className="input" aria-label="From the desk" value={moveTo.deskId} onChange={(e) => setMoveTo({ ...moveTo, deskId: e.target.value })}>{desks.map((d) => <option key={d.id} value={d.id}>{`${d.name} (${d.code})`}</option>)}</select>
                <select className="input" aria-label="As" value={moveTo.category} onChange={(e) => setMoveTo({ ...moveTo, category: e.target.value as NoticeCategory })}>{CATEGORY_ORDER.map((c) => <option key={c} value={c}>{CAT_LABEL[c]}</option>)}</select>
                <button className="btn primary" disabled={!chosen.size || !moveTo.deskId || busy === 'move'} onClick={() => void move()}>{busy === 'move' ? <span className="spinner" /> : <Icon name="notice" size={15} />}{chosen.size === 1 ? 'Move 1 to the board' : `Move ${chosen.size} to the board`}</button>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
