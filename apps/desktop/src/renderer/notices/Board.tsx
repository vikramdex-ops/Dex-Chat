// The Notices lens: the notice board drawn as a register (docs/ANNOUNCEMENTS.md). A title block
// with the register's counts and search; the In force shelf of standing policies as pinned sheet
// stacks; one strip of ruled filters; the register of notices; and for issuers the desk's table of
// drafts and scheduled notices. Search reads titles, text and the text of attached PDFs on the hub.
import { useEffect, useMemo, useState } from 'react';
import type { NoticeCategory, NoticeHit, NoticeSummary, Session } from '@dex/core';
import { Icon } from '../ui.tsx';
import { CAT_LABEL, CATEGORY_ORDER, StatusTag, dateText, refText, sheetsBehind, titleOf } from './parts.tsx';
import { openComposer, openNotice, reloadNotices, useNotices } from './store.ts';
import './notices.css';

type Filter = { desk: string; cat: NoticeCategory | 'all'; year: number | 'all'; mine: boolean; archive: boolean };

function Snippet({ text }: { text: string }) {
  return <>{text.split(/\[\[|\]\]/).map((p, i) => (i % 2 ? <mark key={i} translate="no">{p}</mark> : <span key={i} translate="no">{p}</span>))}</>;
}

export default function NoticeBoard({ session }: { session: Session }) {
  const list = useNotices((s) => s.list);
  const fresh = useNotices((s) => s.fresh);
  const [f, setF] = useState<Filter>({ desk: 'all', cat: 'all', year: 'all', mine: false, archive: false });
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<NoticeHit[] | null>(null);
  useEffect(() => { void reloadNotices(); }, []);
  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) { setHits(null); return; }
    const h = setTimeout(() => void window.dex.request('notices.search', { q: t, limit: 30 }).then((r) => setHits(r.hits)).catch(() => setHits([])), 140);
    return () => clearTimeout(h);
  }, [q]);

  const all = list?.notices ?? [];
  const issued = all.filter((n) => n.number && n.status !== 'draft' && n.status !== 'scheduled');
  const live = issued.filter((n) => n.status === 'issued');
  const shelf = live.filter((n) => n.standing).sort((a, b) => (a.number ?? '').localeCompare(b.number ?? ''));
  const need = live.filter((n) => n.needsAck).length;
  const years = [...new Set(issued.map((n) => new Date(n.issuedAt ?? n.updatedAt).getFullYear()))].sort((a, b) => b - a);
  const deskIds = new Set(issued.map((n) => n.deskId));
  const desks = (list?.desks ?? []).filter((d) => deskIds.has(d.id));
  const rows = useMemo(() => issued
    .filter((n) => (f.archive ? n.status === 'expired' || n.status === 'withdrawn' : n.status === 'issued'))
    .filter((n) => f.desk === 'all' || n.deskId === f.desk)
    .filter((n) => f.cat === 'all' || n.category === f.cat)
    .filter((n) => f.year === 'all' || new Date(n.issuedAt ?? n.updatedAt).getFullYear() === f.year)
    .filter((n) => !f.mine || n.needsAck)
    .sort((a, b) => Number(b.needsAck) - Number(a.needsAck) || (b.issuedAt ?? 0) - (a.issuedAt ?? 0)), [issued, f]); // eslint-disable-line react-hooks/exhaustive-deps
  const table = all.filter((n) => n.status === 'draft' || n.status === 'scheduled' || n.pendingRev);
  const canIssue = (list?.canIssue.length ?? 0) > 0;
  const archived = issued.length - live.length;

  return (
    <div className="view nb-view">
      <div className="nb-head">
        <div className="nb-head-title">
          <span className="nb-head-mark" aria-hidden="true"><Icon name="notice" size={22} /></span>
          <div>
            <h1>Notice board</h1>
            <p className="label">
              {`${live.length} in force`}
              {need > 0 && <> · <span className="nb-need">{need === 1 ? '1 needs you' : `${need} need you`}</span></>}
              {archived > 0 && <> · {`${archived} in the archive`}</>}
              <span translate="no"> · {session.hub.name}</span>
            </p>
          </div>
        </div>
        <div className="nb-head-tools">
          <label className="nb-search">
            <Icon name="search" size={16} />
            <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search notices and their PDFs" aria-label="Search notices and their PDFs" maxLength={200} />
          </label>
          {canIssue && <button className="btn primary" onClick={() => openComposer()}><Icon name="plus" size={16} />Draft a notice</button>}
        </div>
      </div>

      {hits ? (
        <section className="nb-section" aria-label="Search results">
          <div className="label nb-sec-label">{hits.length ? (hits.length === 1 ? '1 notice found' : `${hits.length} notices found`) : 'No notices found'}</div>
          {hits.length > 0 && (
            <div className="nb-register">
              {hits.map((h) => (
                <button key={h.notice.id} className="nb-row nb-hit" onClick={() => openNotice(h.notice.id)}>
                  <span className="nb-row-no mono" translate="no">{refText(h.notice)}</span>
                  <span className="nb-row-title"><span translate="no">{titleOf(h.notice)}</span><span className="nb-row-snip"><Snippet text={h.snippet} /></span></span>
                  <span className="nb-row-where">{h.where === 'pdf' ? <span className="chip accent">In the PDF</span> : h.where === 'title' ? <span className="chip">Title</span> : <span className="chip">Text</span>}</span>
                  <span className="nb-row-st"><StatusTag n={h.notice} /></span>
                </button>
              ))}
            </div>
          )}
        </section>
      ) : (
        <>
          {shelf.length > 0 && (
            <section className="nb-section" aria-label="In force">
              <div className="label nb-sec-label">In force · standing policies</div>
              <div className="nb-shelf" role="list">
                {shelf.map((n) => <ShelfStack key={n.id} n={n} />)}
              </div>
            </section>
          )}

          {canIssue && table.length > 0 && (
            <section className="nb-section" aria-label="On the desk’s table">
              <div className="label nb-sec-label">On the desk’s table · drafts and scheduled</div>
              <div className="nb-register nb-table">
                {table.map((n) => (
                  <button key={n.id} className="nb-row" onClick={() => (n.status === 'draft' ? openComposer({ id: n.id }) : openNotice(n.id))}>
                    <span className="nb-row-no mono" translate="no">{n.number ? `${n.number} · Rev ${n.pendingRev?.rev ?? n.rev}` : `${n.deskCode} · Rev ${n.rev}`}</span>
                    <span className="nb-row-title"><span translate="no">{n.title}</span></span>
                    <span className="nb-row-meta">{(n.pendingRev?.status ?? n.status) === 'scheduled' ? `Issues ${dateText(n.pendingRev?.issueAt ?? n.issueAt)}` : n.pendingRev ? 'Revision being written' : 'Draft'}</span>
                    <span className="nb-row-st"><span className={`chip${(n.pendingRev?.status ?? n.status) === 'scheduled' ? ' accent' : ''}`}>{(n.pendingRev?.status ?? n.status) === 'scheduled' ? 'Scheduled' : 'Draft'}</span></span>
                  </button>
                ))}
              </div>
            </section>
          )}

          <section className="nb-section" aria-label="Register">
            <div className="nb-filters" role="group" aria-label="Filter the register">
              <div className="seg" role="group" aria-label="Desk">
                <button type="button" aria-pressed={f.desk === 'all'} onClick={() => setF({ ...f, desk: 'all' })}>All desks</button>
                {desks.map((d) => <button key={d.id} type="button" aria-pressed={f.desk === d.id} onClick={() => setF({ ...f, desk: d.id })}><span translate="no">{d.name}</span></button>)}
              </div>
              <select className="input nb-select" aria-label="Category" value={f.cat} onChange={(e) => setF({ ...f, cat: e.target.value as Filter['cat'] })}>
                <option value="all">Every kind</option>
                {CATEGORY_ORDER.map((c) => <option key={c} value={c}>{CAT_LABEL[c]}</option>)}
              </select>
              <select className="input nb-select" aria-label="Year" value={String(f.year)} onChange={(e) => setF({ ...f, year: e.target.value === 'all' ? 'all' : Number(e.target.value) })}>
                <option value="all">Every year</option>
                {years.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
              <button type="button" className={`when-chip${f.mine ? ' on' : ''}`} aria-pressed={f.mine} onClick={() => setF({ ...f, mine: !f.mine })}>Needs my acknowledgement</button>
              <button type="button" className={`when-chip${f.archive ? ' on' : ''}`} aria-pressed={f.archive} onClick={() => setF({ ...f, archive: !f.archive })}><Icon name="archive" size={14} />Archive</button>
            </div>
            {!list ? (
              <div className="empty" aria-busy="true"><span className="spinner" /></div>
            ) : rows.length === 0 ? (
              <div className="empty nb-empty"><Icon name="notice" size={30} /><span>{issued.length === 0 ? 'Nothing has been issued yet.' : f.archive ? 'Nothing in the archive matches.' : 'No notices match these filters.'}</span>
                {issued.length === 0 && canIssue ? <button className="btn" onClick={() => openComposer()}>Draft the first notice</button> : issued.length > 0 ? <button className="btn ghost" onClick={() => setF({ desk: 'all', cat: 'all', year: 'all', mine: false, archive: false })}>Show everything in force</button> : null}
              </div>
            ) : (
              <div className="nb-register" role="list" aria-label={f.archive ? 'Archive' : 'Register of notices in force'}>
                <div className="nb-row nb-row-head" aria-hidden="true"><span>No. · Rev</span><span>Title</span><span>Desk · kind</span><span>Issued</span><span>Effective</span><span>Status</span></div>
                {rows.map((n) => <RegisterRow key={n.id} n={n} plot={fresh.has(n.id)} />)}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function RegisterRow({ n, plot }: { n: NoticeSummary; plot: boolean }) {
  const t = titleOf(n);
  const label = n.needsAck ? `${n.number} Rev ${n.rev}, ${t}, needs your acknowledgement` : !n.seen && n.status === 'issued' ? `${n.number} Rev ${n.rev}, ${t}, not opened yet` : `${n.number} Rev ${n.rev}, ${t}`;
  return (
    <div role="listitem" className="nb-li">
      <button className={`nb-row${n.needsAck ? ' need' : !n.seen && n.status === 'issued' ? ' unseen' : ''}${plot ? ' plot' : ''}${n.status === 'withdrawn' ? ' withdrawn' : ''}`} onClick={() => openNotice(n.id)} aria-label={label}>
        <span className="nb-row-no mono" translate="no">{refText(n)}</span>
        <span className="nb-row-title"><span translate="no">{titleOf(n)}</span>{n.file && <span className="nb-row-pdf mono" title="Has a PDF">PDF</span>}</span>
        <span className="nb-row-desk"><span translate="no">{n.deskName}</span> · {CAT_LABEL[n.category]}</span>
        <span className="nb-row-date">{dateText(n.issuedAt)}</span>
        <span className="nb-row-date">{dateText(n.effectiveAt)}</span>
        <span className="nb-row-st"><StatusTag n={n} /></span>
      </button>
    </div>
  );
}

function ShelfStack({ n }: { n: NoticeSummary }) {
  const behind = sheetsBehind(n.rev);
  return (
    <div role="listitem" className="nb-stack-wrap">
      <button className={`nb-stack${n.needsAck ? ' need' : ''}`} style={{ '--behind': behind } as React.CSSProperties} onClick={() => openNotice(n.id)}
        aria-label={n.needsAck ? `${n.number} Rev ${n.rev}, ${titleOf(n)}, needs your acknowledgement` : n.acked ? `${n.number} Rev ${n.rev}, ${titleOf(n)}, acknowledged` : `${n.number} Rev ${n.rev}, ${titleOf(n)}`}>
        {Array.from({ length: behind }, (_, i) => <span key={i} className="nb-stack-sheet" style={{ '--i': i + 1 } as React.CSSProperties} aria-hidden="true" />)}
        <span className="nb-stack-top">
          <span className="nb-pin" aria-hidden="true" />
          <span className="nb-stack-no mono" translate="no">{n.number}</span>
          <span className="nb-stack-title" translate="no">{titleOf(n)}</span>
          <span className="nb-stack-foot">
            <span className="mono" translate="no">{`REV ${n.rev}`}</span>
            <span className="mono">{dateText(n.effectiveAt)}</span>
            {n.needsAck ? <span className="chip warn">Acknowledge</span> : n.acked ? <span className="nb-tick" aria-hidden="true"><Icon name="check" size={14} /></span> : null}
          </span>
        </span>
      </button>
    </div>
  );
}
