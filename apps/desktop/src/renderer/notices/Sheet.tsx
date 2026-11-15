// A notice opened: the reading sheet (docs/ANNOUNCEMENTS.md, "Reading a notice"). A title block in
// ruled cells; the language strip when the author wrote other versions; the change note and the
// body with revision clouds on changed paragraphs; the attached PDF inline in our viewer; the
// desk's questions and answers; asking the issuer privately; related notices and the revision
// history; and the acknowledgement, a deliberate act that lands a stamp. Issuers also get the
// acknowledgement register (filling live), their questions, and Revise, Withdraw, Email copy.
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import type { NoticeAckChart, NoticeLang, NoticeRevision, NoticeView, PublicUser, Session } from '@dex/core';
import { buildEml } from '@dex/core/eml';
import { Avatar, Dialog, Icon, trapTab, useDialogFocus, useToast } from '../ui.tsx';
import { renderBody } from '../chat/format.tsx';
import { useOrg } from '../org/store.ts';
import { fileBlob, fileCommands } from '../pdf/source.ts';
import { nextRev, paragraphs } from '@dex/core/notices';
import { AckStamp, AudienceWords, CAT_LABEL, LANG_NAME, RevisionCloud, STATUS_LABEL, dateText, dateTimeText, readingLang, refText, textOf, titleOf } from './parts.tsx';
import { openComposer, openNotice, reloadNotices } from './store.ts';
import './notices.css';

const PdfViewer = lazy(() => import('../pdf/PdfViewer.tsx'));

type Tab = 'notice' | 'acks' | 'questions';

/** The sheet itself: loads the notice, keeps it live, and holds the issuer's tabs. */
export default function NoticeSheet({ id, session, onClose }: { id: string; session: Session; onClose: () => void }) {
  const toast = useToast();
  const [n, setN] = useState<NoticeView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('notice');
  const [landing, setLanding] = useState(false);
  const ref = useRef<HTMLElement>(null);
  useDialogFocus(ref, false);
  const load = () => window.dex.request('notices.get', { id }).then((v) => { setN(v); setFailed(null); return v; }).catch((e: Error) => { setFailed(e.message); return null; });
  useEffect(() => {
    void load().then((v) => { if (v && v.status === 'issued' && !v.seen) void window.dex.request('notices.seen', { id }).then(() => reloadNotices()).catch(() => {}); });
    return window.dex.onHubEvent((name, data) => { if (name === 'notices.changed' && (data as { id: string }).id === id) void load(); });
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !(e.target as HTMLElement | null)?.closest?.('.pdfv, .dialog, [role="dialog"] [role="dialog"]')) onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const users = useMemo(() => new Map(session.users.map((u) => [u.id, u] as const)), [session.users]);

  const ack = async (answers: number[]) => {
    try {
      const v = await window.dex.request('notices.ack', { id, answers });
      setN(v); setLanding(true); void reloadNotices();
      toast(`Acknowledged ${v.number} Rev ${v.rev}`);
    } catch (e) { toast((e as Error).message, true); }
  };

  return (
    <div className="sheet-scrim nb-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside ref={ref} tabIndex={-1} onKeyDown={trapTab} className="sheet nb-sheet" role="dialog" aria-modal="true" aria-label={n ? `${n.number ?? ''} ${n.title}` : 'Notice'}>
        <button className="sheet-close" onClick={onClose} aria-label="Close" title="Close (Esc)"><Icon name="x" size={18} /></button>
        <div className="sheet-body">
          {!n ? (
            <div className="view">{failed ? <div className="empty"><Icon name="notice" size={30} /><span>{failed}</span><button className="btn" onClick={onClose}>Back to the board</button></div> : <div className="tl-more"><span className="spinner" /></div>}</div>
          ) : (
            <div className="view nb-read">
              {n.canIssue && (
                <div className="sheet-tabs nb-tabs" role="tablist" aria-label="Notice">
                  <button role="tab" type="button" className="sheet-tab" aria-selected={tab === 'notice'} onClick={() => setTab('notice')}><Icon name="notice" size={15} /><span>Notice</span></button>
                  {n.number && n.current.ackRequired && <button role="tab" type="button" className="sheet-tab" aria-selected={tab === 'acks'} onClick={() => setTab('acks')}><Icon name="stamp" size={15} /><span>Acknowledgements</span>{n.acks && <span className="sheet-n mono">{`${n.acks.done}/${n.acks.total}`}</span>}</button>}
                  <button role="tab" type="button" className="sheet-tab" aria-selected={tab === 'questions'} onClick={() => setTab('questions')}><Icon name="info" size={15} /><span>Questions</span>{!!n.inbox?.filter((a) => !a.answer).length && <span className="sheet-n mono attention">{n.inbox.filter((a) => !a.answer).length}</span>}</button>
                </div>
              )}
              {tab === 'notice' && <NoticeReading n={n} users={users} me={session.me} landing={landing} onAck={ack} onChanged={setN} />}
              {tab === 'acks' && n.canIssue && <AckRegister n={n} users={users} />}
              {tab === 'questions' && n.canIssue && <Inbox n={n} users={users} onChanged={setN} />}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

/** The notice as readers see it (the composer's preview draws it too, with `preview`). */
export function NoticeReading({ n, users, me, landing = false, preview = false, onAck, onChanged }: {
  n: NoticeView; users: Map<string, PublicUser>; me: PublicUser; landing?: boolean; preview?: boolean;
  onAck?: (answers: number[]) => void; onChanged?: (v: NoticeView) => void;
}) {
  const toast = useToast();
  const org = useOrg();
  const [revKey, setRevKey] = useState<string | null>(null);
  const shownRev: NoticeRevision = (revKey && n.revisions.find((r) => r.rev === revKey && r.status !== 'draft' && r.status !== 'scheduled')) || n.current;
  const langs = (['hi', 'ta'] as NoticeLang[]).filter((l) => shownRev.translations[l]?.title || shownRev.translations[l]?.body);
  const [lang, setLang] = useState<'en' | NoticeLang>(() => readingLang(langs));
  useEffect(() => { if (lang !== 'en' && !langs.includes(lang)) setLang('en'); }, [shownRev.rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const text = textOf(shownRev, lang);
  const paras = paragraphs(text.body);
  const changed = new Set(lang === 'en' ? shownRev.changed : []);
  const old = shownRev.rev !== n.current.rev;
  const author = users.get(shownRev.authorId);
  const ackBlock = !preview && !old && n.status === 'issued' && n.current.ackRequired && (n.needsAck || n.acked);
  const [busy, setBusy] = useState<string | null>(null);
  const [withdraw, setWithdraw] = useState(false);

  const emailCopy = async () => {
    setBusy('mail');
    try {
      const m = await window.dex.request('notices.emailCopy', { id: n.id });
      const file = n.current.file;
      const attachments = file ? [{ name: file.name, type: file.mime || 'application/pdf', data: new Uint8Array(await (await fileBlob(file)).arrayBuffer()) }] : [];
      if (!window.dex.openMailDraft) throw new Error('An email draft can be made on a PC.');
      await window.dex.openMailDraft(`${n.number ?? 'notice'}-rev-${n.rev}`, buildEml({ to: m.to, subject: m.subject, text: m.text, html: m.html, attachments }));
      toast(m.to.length ? (m.to.length === 1 ? 'Email draft opened for 1 person without the app' : `Email draft opened for ${m.to.length} people without the app`) : 'Email draft opened. Everyone in the audience uses the app; add any addresses yourself.');
      if (m.withoutEmail) toast(m.withoutEmail === 1 ? '1 person without the app has no email address on their profile' : `${m.withoutEmail} people without the app have no email address on their profile`);
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(null); }
  };

  return (
    <article className={`nb-notice${n.status === 'withdrawn' ? ' is-withdrawn' : ''}`} aria-label={text.title}>
      {/* the title block */}
      <header className="nb-tb">
        <div className="nb-tb-main">
          <span className="nb-tb-cat chip">{CAT_LABEL[n.category]}</span>
          {n.urgent && <span className="chip warn">Urgent</span>}
          <h1 className="nb-tb-title" translate="no">{text.title}</h1>
        </div>
        <dl className="nb-tb-cells">
          <div className="nb-cell wide"><dt>Issued by</dt><dd><span translate="no">{n.deskName}</span>{author && <> · <span translate="no">{author.displayName}</span></>}</dd></div>
          <div className="nb-cell"><dt>Number</dt><dd className="mono" translate="no">{n.number ?? n.nextNumber}</dd></div>
          <div className="nb-cell"><dt>Rev</dt><dd className="mono nb-rev" translate="no">{shownRev.rev}</dd></div>
          <div className="nb-cell"><dt>Date</dt><dd>{shownRev.issuedAt ? dateText(shownRev.issuedAt) : preview ? 'On issue' : '—'}</dd></div>
          <div className="nb-cell"><dt>Effective</dt><dd>{dateText(shownRev.effectiveAt ?? shownRev.issuedAt) || (preview ? 'On issue' : '—')}</dd></div>
          <div className="nb-cell"><dt>Expires</dt><dd>{dateText(shownRev.expiresAt) || 'No expiry'}</dd></div>
          <div className="nb-cell wide for"><dt>Addressed to</dt><dd><AudienceWords a={shownRev.audience} departments={org.departments} users={users} /></dd></div>
          <div className="nb-cell st"><dt>Status</dt><dd>{old ? STATUS_LABEL[shownRev.status] : STATUS_LABEL[n.status]}</dd></div>
        </dl>
        {n.status === 'withdrawn' && n.withdrawn && !old && (
          <div className="nb-big-stamp withdrawn" role="note"><span>Withdrawn</span><small>{dateText(n.withdrawn.at)}</small></div>
        )}
        {old && <div className="nb-big-stamp superseded" role="note"><span>Superseded</span><small>{`by Rev ${n.current.rev}`}</small></div>}
        {n.acked && !old && n.ackedAt && !preview && <AckStamp name={me.displayName} at={n.ackedAt} refLine={refText({ number: n.number, rev: n.ackedRev ?? n.rev })} landing={landing} />}
      </header>

      {n.status === 'withdrawn' && n.withdrawn && !old && (
        <p className="nb-withdrawn-note" role="note">{users.get(n.withdrawn.by) ? `Withdrawn on ${dateText(n.withdrawn.at)} by ${users.get(n.withdrawn.by)!.displayName}.` : `Withdrawn on ${dateText(n.withdrawn.at)}.`} <span translate="no">{n.withdrawn.reason}</span></p>
      )}

      {n.canIssue && !preview && !old && (
        <div className="nb-actions">
          {n.status === 'issued' && !n.draft && <button className="btn" onClick={() => openComposer({ id: n.id })}><Icon name="edit" size={15} />{`Revise (Rev ${nextRev(n.rev)})`}</button>}
          {n.draft && <button className="btn" onClick={() => openComposer({ id: n.id })}><Icon name="edit" size={15} />{n.draft.status === 'scheduled' ? `Rev ${n.draft.rev} is scheduled` : `Continue Rev ${n.draft.rev}`}</button>}
          {n.status === 'issued' && window.dex.openMailDraft && <button className="btn ghost" disabled={busy === 'mail'} onClick={() => void emailCopy()}>{busy === 'mail' ? <span className="spinner" /> : <Icon name="mail" size={15} />}Email copy</button>}
          {n.status === 'issued' && <button className="btn ghost danger" onClick={() => setWithdraw(true)}>Withdraw…</button>}
        </div>
      )}

      {langs.length > 0 && (
        <div className="seg nb-langs" role="group" aria-label="Language of the notice">
          {(['en', ...langs] as Array<'en' | NoticeLang>).map((l) => <button key={l} type="button" aria-pressed={lang === l} onClick={() => setLang(l)}><span translate="no">{LANG_NAME[l]}</span></button>)}
        </div>
      )}

      {shownRev.changeNote && (
        <div className="nb-change">
          <div className="label">{`Rev ${shownRev.rev} · What changed`}</div>
          <p translate="no">{shownRev.changeNote}</p>
          {shownRev.removed > 0 && <p className="faint">{shownRev.removed === 1 ? '1 paragraph was taken out.' : `${shownRev.removed} paragraphs were taken out.`}</p>}
        </div>
      )}

      {paras.length > 0 && (
        <div className="nb-body" translate="no" lang={lang === 'en' ? undefined : lang}>
          {paras.map((p, i) => {
            const body = <div className="nb-para">{renderBody(p, users, me.id)}</div>;
            return changed.has(i) ? <RevisionCloud key={`${shownRev.rev}-${i}`} rev={shownRev.rev}>{body}</RevisionCloud> : <div key={`${shownRev.rev}-${i}`}>{body}</div>;
          })}
        </div>
      )}

      {shownRev.file && <InlinePdf file={shownRev.file} />}

      {ackBlock && <AckBlock n={n} onAck={onAck} />}

      {n.faq.length > 0 && (
        <section className="nb-faq" aria-label="Questions and answers">
          <div className="label nb-sec-label">Questions and answers</div>
          <ol>{n.faq.map((f) => <li key={f.id}><p className="nb-q" translate="no">{f.question}</p><p className="nb-a" translate="no">{f.answer}</p></li>)}</ol>
        </section>
      )}

      {!preview && n.number && n.status === 'issued' && <AskIssuer n={n} onChanged={onChanged} />}

      {(n.related.length > 0 || n.revisions.filter((r) => r.issuedAt).length > 1) && (
        <div className="nb-foot">
          {n.related.length > 0 && (
            <section aria-label="Related notices">
              <div className="label nb-sec-label">Related notices</div>
              <div className="nb-related">
                {n.related.map((r) => <button key={r.id} className="nb-rel" onClick={() => openNotice(r.id)}><span className="mono" translate="no">{refText(r)}</span><span translate="no">{titleOf(r)}</span></button>)}
              </div>
            </section>
          )}
          {n.revisions.filter((r) => r.issuedAt).length > 0 && (
            <section aria-label="Revision history">
              <div className="label nb-sec-label">Revision history</div>
              <table className="nb-revs">
                <thead><tr><th>Rev</th><th>Issued</th><th>What changed</th><th>Status</th></tr></thead>
                <tbody>
                  {n.revisions.filter((r) => r.issuedAt).map((r) => (
                    <tr key={r.rev} className={r.rev === shownRev.rev ? 'on' : ''}>
                      <td><button className="link mono" onClick={() => setRevKey(r.rev === n.current.rev ? null : r.rev)} aria-label={`Show Rev ${r.rev}`} translate="no">{r.rev}</button></td>
                      <td>{dateText(r.issuedAt)}</td>
                      <td>{r.changeNote ? <span translate="no">{r.changeNote}</span> : r.rev === 'A' ? 'First issue' : '—'}{r.reack && <span className="chip nb-reack">Asked again</span>}</td>
                      <td><span className="chip">{STATUS_LABEL[r.status]}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </div>
      )}
      {withdraw && <WithdrawDialog n={n} onClose={() => setWithdraw(false)} onDone={(v) => { setWithdraw(false); onChanged?.(v); void reloadNotices(); }} />}
    </article>
  );
}

/** The PDF in our viewer, in the sheet: pages, the strip of thumbnails, zoom and search, and Full screen. */
function InlinePdf({ file }: { file: NonNullable<NoticeRevision['file']> }) {
  const [full, setFull] = useState(false);
  const cmd = fileCommands(file);
  const props = {
    name: file.name, size: file.size, load: () => fileBlob(file),
    onDownload: cmd.canDownload ? (b: Parameters<typeof cmd.download>[0]) => cmd.download(b) : undefined,
    onOpenExternal: cmd.canOpen ? (b: Parameters<typeof cmd.openExternal>[0]) => cmd.openExternal(b) : undefined,
  };
  return (
    <section className="nb-pdf" aria-label={`Attached: ${file.name}`}>
      <Suspense fallback={<div className="nb-pdf-wait"><span className="spinner" /></div>}>
        {full ? <PdfViewer {...props} onClose={() => setFull(false)} /> : <PdfViewer {...props} inline onExpand={() => setFull(true)} onClose={() => {}} />}
      </Suspense>
    </section>
  );
}

/** "Read and understood": the statement, the check questions, then Acknowledge. */
function AckBlock({ n, onAck }: { n: NoticeView; onAck?: (answers: number[]) => void }) {
  const [sure, setSure] = useState(false);
  const [answers, setAnswers] = useState<number[]>(() => n.current.checks.map(() => -1));
  const [busy, setBusy] = useState(false);
  if (!n.needsAck) return null;
  const ready = sure && answers.every((a) => a >= 0);
  return (
    <section className="nb-ack" aria-label="Acknowledge">
      <div className="label">{`Acknowledgement · ${n.deskName} asks you to confirm`}</div>
      {n.current.checks.length > 0 && (
        <div className="nb-checks">
          {n.current.checks.map((c, i) => (
            <fieldset key={c.id} className="nb-check">
              <legend translate="no">{c.prompt}</legend>
              <div className="nb-check-opts">
                {c.options.map((o, j) => (
                  <label key={j} className={`nb-opt${answers[i] === j ? ' on' : ''}`}>
                    <input type="radio" name={`${n.id}-${c.id}`} checked={answers[i] === j} onChange={() => setAnswers(answers.map((a, k) => (k === i ? j : a)))} />
                    <span translate="no">{o}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
      )}
      <div className="nb-ack-bar">
        <label className="nb-sure"><input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} /><span>{`I have read ${n.number} Rev ${n.rev} and understood it.`}</span></label>
        <button className="btn primary" disabled={!ready || busy} onClick={() => { setBusy(true); Promise.resolve(onAck?.(answers)).finally(() => setBusy(false)); }}>
          {busy ? <span className="spinner" /> : <Icon name="stamp" size={16} />}Acknowledge
        </button>
      </div>
    </section>
  );
}

/** A private question to the desk, and my earlier questions with their answers. */
function AskIssuer({ n, onChanged }: { n: NoticeView; onChanged?: (v: NoticeView) => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const send = async () => {
    try { const v = await window.dex.request('notices.ask', { id: n.id, text: text.trim() }); setText(''); setOpen(false); onChanged?.(v); toast(`Sent to the ${n.deskName} desk. You get a line from Nib when they answer.`); } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <section className="nb-ask" aria-label="Ask the issuer">
      {n.asked.length > 0 && (
        <ul className="nb-asked">
          {n.asked.map((a) => (
            <li key={a.id}>
              <p className="nb-q" translate="no">{a.text}</p>
              {a.answer ? <p className="nb-a"><span translate="no">{a.answer}</span>{a.published && <span className="chip">Added for everyone</span>}</p> : <p className="faint">{`Waiting for the ${n.deskName} desk`}</p>}
            </li>
          ))}
        </ul>
      )}
      {open ? (
        <form className="nb-ask-form" onSubmit={(e) => { e.preventDefault(); if (text.trim()) void send(); }}>
          <label className="field-label" htmlFor={`ask-${n.id}`}>{`Your question to the ${n.deskName} desk (only they see it)`}</label>
          <textarea id={`ask-${n.id}`} className="input" rows={3} maxLength={600} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
          <div className="nb-ask-actions"><button type="button" className="btn ghost" onClick={() => setOpen(false)}>Cancel</button><button className="btn primary" disabled={!text.trim()}>Send to the desk</button></div>
        </form>
      ) : (
        <button className="btn ghost nb-ask-open" onClick={() => setOpen(true)}><Icon name="info" size={15} />Ask the issuer privately</button>
      )}
    </section>
  );
}

function WithdrawDialog({ n, onClose, onDone }: { n: NoticeView; onClose: () => void; onDone: (v: NoticeView) => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  return (
    <Dialog title={`Withdraw ${n.number} Rev ${n.rev}?`} onClose={onClose} narrow>
      <p className="muted" style={{ margin: 0 }}>It stops being in force at once and asks no one for anything. Readers keep a stamped record with your reason.</p>
      <div className="field"><label htmlFor="nb-wd">Why it is withdrawn</label><input id="nb-wd" className="input" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Replaced by the revised handbook" /></div>
      <div className="dialog-actions"><span /><button className="btn ghost" onClick={onClose}>Keep it</button>
        <button className="btn danger-solid" disabled={!reason.trim()} onClick={() => void window.dex.request('notices.withdraw', { id: n.id, reason: reason.trim() }).then((v) => { toast(`Withdrew ${v.number}`); onDone(v); }).catch((e: Error) => toast(e.message, true))}>Withdraw</button></div>
    </Dialog>
  );
}

/** The acknowledgement register: a ruled row per department, a cell per person, filling live. */
function AckRegister({ n, users }: { n: NoticeView; users: Map<string, PublicUser> }) {
  const toast = useToast();
  const [c, setC] = useState<NoticeAckChart | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => void window.dex.request('notices.acks', { id: n.id }).then(setC).catch((e: Error) => toast(e.message, true));
  useEffect(() => {
    load();
    return window.dex.onHubEvent((name, data) => { if (name === 'notices.changed' && (data as { id: string }).id === n.id) load(); });
  }, [n.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!c) return <div className="tl-more"><span className="spinner" /></div>;
  const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
  const remind = async () => {
    setBusy(true);
    try { const r = await window.dex.request('notices.remind', { id: n.id }); toast(r.sent === 1 ? 'Reminded 1 person' : r.sent ? `Reminded ${r.sent} people` : 'Everyone waiting had a reminder today already'); load(); } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  return (
    <section className="nb-acks" aria-label="Acknowledgement register">
      <header className="nb-acks-tb">
        <div><div className="label">Acknowledgement register</div><div className="mono" translate="no">{`${c.number} · Rev ${c.rev}`}</div></div>
        <div className="nb-acks-count"><span className="stat">{c.done}</span><span className="faint">{`of ${c.total} · ${pct}%`}</span></div>
        <div className="nb-acks-bar" role="progressbar" aria-label="Acknowledged" aria-valuemin={0} aria-valuemax={c.total} aria-valuenow={c.done}><span style={{ width: `${pct}%` }} /></div>
        <button className="btn" disabled={busy || c.done === c.total || !!c.remindFrom} onClick={() => void remind()} title={c.remindFrom ? 'A reminder already went today' : undefined}>
          {busy ? <span className="spinner" /> : <Icon name="alarm" size={15} />}{c.remindFrom ? 'Reminded today' : 'Remind those waiting'}
        </button>
      </header>
      <div className="nb-acks-rows">
        {c.departments.map((d) => {
          const done = d.people.filter((p) => p.acked).length;
          return (
            <div key={d.id ?? 'none'} className="nb-acks-row">
              <div className="nb-acks-dept"><span translate="no">{d.name}</span><span className="mono faint">{`${done}/${d.people.length}`}</span></div>
              <ul className="nb-cells" aria-label={d.name}>
                {d.people.map((p) => {
                  const u = users.get(p.userId);
                  const name = u?.displayName ?? 'Former colleague';
                  const label = p.acked ? `${name}, acknowledged ${dateTimeText(p.at)}` : `${name}, waiting`;
                  return <li key={p.userId} className={`nb-cellp${p.acked ? ' done' : ''}`} title={label} aria-label={label} tabIndex={0}><span translate="no">{name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('')}</span></li>;
                })}
              </ul>
            </div>
          );
        })}
      </div>
      <p className="faint nb-acks-note">Reminders go to readers once a day at most, grouped in one line from Nib. The desk gets one digest each afternoon.</p>
    </section>
  );
}

/** Questions readers asked the desk: answer privately, or add the answer to the notice for everyone. */
function Inbox({ n, users, onChanged }: { n: NoticeView; users: Map<string, PublicUser>; onChanged: (v: NoticeView) => void }) {
  const toast = useToast();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const list = n.inbox ?? [];
  if (!list.length) return <div className="empty"><Icon name="info" size={30} /><span>No one has asked about this notice.</span></div>;
  const answer = (askId: string, publish: boolean) => void window.dex.request('notices.answer', { id: n.id, askId, answer: (drafts[askId] ?? '').trim(), publish })
    .then((v) => { onChanged(v); toast(publish ? 'Answered and added to the notice for everyone' : 'Answered privately'); }).catch((e: Error) => toast(e.message, true));
  return (
    <ul className="nb-inbox">
      {list.map((a) => {
        const u = users.get(a.userId);
        return (
          <li key={a.id} className="nb-inbox-item">
            <div className="nb-inbox-who">{u && <Avatar user={u} size="sm" />}<span translate="no">{u?.displayName ?? 'Former colleague'}</span><span className="faint">{dateTimeText(a.at)}</span></div>
            <p className="nb-q" translate="no">{a.text}</p>
            {a.answer ? <p className="nb-a"><span translate="no">{a.answer}</span>{a.published && <span className="chip">Added for everyone</span>}</p> : (
              <div className="nb-inbox-answer">
                <textarea className="input" rows={2} maxLength={2000} aria-label="Answer" value={drafts[a.id] ?? ''} onChange={(e) => setDrafts({ ...drafts, [a.id]: e.target.value })} />
                <div className="nb-ask-actions">
                  <button className="btn ghost" disabled={!(drafts[a.id] ?? '').trim()} onClick={() => answer(a.id, false)}>Answer privately</button>
                  <button className="btn primary" disabled={!(drafts[a.id] ?? '').trim()} onClick={() => answer(a.id, true)}>Answer and add for everyone</button>
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
