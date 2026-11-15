// The composer (docs/ANNOUNCEMENTS.md, "Issuing"): one sheet of numbered sections, like a settings
// schedule. Desk and kind, text, the PDF, who it is for (with a live count), acknowledgement and
// its check questions, dates, translations, the revision's change note, related notices; then
// Save draft, Preview (the reading sheet as a reader will see it), Schedule or Issue now.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FileInfo, NoticeAudience, NoticeCategory, NoticeDraftInput, NoticeLang, NoticeView, Session } from '@dex/core';
import { changedParagraphs, nextRev } from '@dex/core/notices';
import { Icon, ToggleRow, trapTab, useDialogFocus, useToast } from '../ui.tsx';
import { confirmAction } from '../confirm.tsx';
import { useOrg } from '../org/store.ts';
import { CAT_LABEL, CATEGORY_ORDER, LANG_NAME, audienceCount } from './parts.tsx';
import { NoticeReading } from './Sheet.tsx';
import { openNotice, reloadNotices, useNotices } from './store.ts';
import './notices.css';

type Check = { prompt: string; options: string[]; answer: number };
interface Form {
  deskId: string; category: NoticeCategory; title: string; body: string; fileId: string | null; file: FileInfo | null;
  audience: NoticeAudience; ackRequired: boolean; checks: Check[]; effective: string; expires: string; standing: boolean; urgent: boolean;
  changeNote: string; reack: boolean; related: string[]; translations: Partial<Record<NoticeLang, { title: string; body: string }>>;
}
const ymd = (t: number | null | undefined) => { if (!t) return ''; const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dayAt = (s: string, end = false) => { if (!s) return null; const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, end ? 23 : 0, end ? 59 : 0).getTime(); };
const blank = (deskId: string): Form => ({
  deskId, category: 'notice', title: '', body: '', fileId: null, file: null, audience: { everyone: true, departments: [], roles: [], locations: [], people: [] },
  ackRequired: false, checks: [], effective: '', expires: '', standing: false, urgent: false, changeNote: '', reack: false, related: [], translations: {},
});

export default function NoticeComposer({ id, deskId, session, onClose }: { id?: string; deskId?: string; session: Session; onClose: () => void }) {
  const toast = useToast();
  const org = useOrg();
  const list = useNotices((s) => s.list);
  const myDesks = (list?.desks ?? []).filter((d) => list?.canIssue.includes(d.id));
  const [view, setView] = useState<NoticeView | null>(null);
  const [f, setF] = useState<Form | null>(id ? null : blank(deskId ?? list?.canIssue[0] ?? ''));
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [when, setWhen] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useDialogFocus(ref, false);
  const users = useMemo(() => new Map(session.users.map((u) => [u.id, u] as const)), [session.users]);

  useEffect(() => {
    if (!id) return;
    void window.dex.request('notices.get', { id }).then((v) => {
      setView(v);
      const r = v.draft ?? v.current;
      setF({
        deskId: v.deskId, category: v.category, title: r.title, body: r.body, fileId: r.file?.id ?? null, file: r.file, audience: r.audience, ackRequired: r.ackRequired,
        checks: v.draft ? v.draft.checkDefs.map((c) => ({ prompt: c.prompt, options: c.options, answer: c.answer })) : [],
        effective: v.draft || !v.number ? ymd(r.effectiveAt) : '', expires: ymd(r.expiresAt), standing: r.standing, urgent: r.urgent,
        changeNote: v.draft ? r.changeNote ?? '' : '', reack: v.draft ? r.reack : false, related: v.related.map((x) => x.id).slice(0, 10), translations: r.translations,
      });
    }).catch((e: Error) => { toast(e.message, true); onClose(); });
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement | null)?.closest?.('.pdfv, .dialog')) { if (preview) setPreview(false); else onClose(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose, preview]);

  if (!f) return <div className="sheet-scrim nb-scrim"><aside ref={ref} className="sheet nb-sheet" role="dialog" aria-modal="true" aria-label="Notice"><div className="tl-more"><span className="spinner" /></div></aside></div>;
  const set = (patch: Partial<Form>) => setF({ ...f, ...patch });
  const revising = !!view?.number;
  const rev = view?.draft?.rev ?? (revising ? nextRev(view!.rev) : 'A');
  const isAdmin = list?.canUrgent ?? false;
  const count = audienceCount(f.audience, session.users, org.departments);
  const scheduled = view?.draft?.status === 'scheduled' || (!revising && view?.status === 'scheduled');

  const input = (): NoticeDraftInput => ({
    ...(view ? { id: view.id } : {}), deskId: f.deskId, category: f.category, title: f.title, body: f.body, fileId: f.fileId, audience: f.audience,
    ackRequired: f.ackRequired, checks: f.ackRequired ? f.checks : [], effectiveAt: dayAt(f.effective), expiresAt: dayAt(f.expires, true), standing: f.standing, urgent: f.urgent,
    changeNote: f.changeNote || null, reack: f.reack, related: f.related, translations: f.translations,
  });
  const save = async (quiet = false): Promise<NoticeView | null> => {
    try {
      const v = await window.dex.request('notices.save', input());
      setView(v); void reloadNotices();
      if (!quiet) toast('Draft saved');
      return v;
    } catch (e) { toast((e as Error).message, true); return null; }
  };
  const issue = async (at: number | null) => {
    setBusy(at ? 'schedule' : 'issue');
    try {
      const v = await save(true);
      if (!v) return;
      if (!at && !(await confirmAction({ title: `Issue ${v.number ?? v.nextNumber} Rev ${rev} now?`, body: count === 1 ? 'It goes to 1 person at once.' : `It goes to ${count} people at once.`, confirm: 'Issue now' }))) return;
      const done = await window.dex.request('notices.issue', { id: v.id, ...(at ? { at } : {}) });
      void reloadNotices();
      toast(at ? `Scheduled for ${new Date(at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : `Issued ${done.number} Rev ${done.rev}`);
      onClose();
      if (!at) openNotice(done.id);
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(null); }
  };
  const unschedule = async () => {
    if (!view) return;
    try { const v = await window.dex.request('notices.issue', { id: view.id, at: null }); setView(v); void reloadNotices(); toast('Back to a draft'); } catch (e) { toast((e as Error).message, true); }
  };
  const discard = async () => {
    if (!view) { onClose(); return; }
    if (!(await confirmAction({ title: revising ? `Throw away Rev ${rev}?` : 'Throw away this draft?', body: revising ? `Rev ${view.rev} stays in force.` : 'It was never issued, so nothing else changes.', confirm: 'Throw away', danger: true }))) return;
    try { await window.dex.request('notices.discard', { id: view.id }); void reloadNotices(); onClose(); } catch (e) { toast((e as Error).message, true); }
  };
  const attach = async (file: File | undefined) => {
    if (!file || !window.dex.uploadFile) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { toast('Attach a PDF.', true); return; }
    setUploading(true);
    try { const info = await window.dex.uploadFile(`notice-${Date.now().toString(36)}`, { data: await file.arrayBuffer(), name: file.name, mime: 'application/pdf' }); set({ fileId: info.id, file: info }); } catch (e) { toast((e as Error).message, true); } finally { setUploading(false); }
  };
  const toggleIn = <K extends 'departments' | 'roles' | 'people'>(k: K, v: NoticeAudience[K][number]) => {
    const cur = f.audience[k] as string[];
    set({ audience: { ...f.audience, everyone: false, [k]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] } });
  };

  // the preview: the reading sheet with this draft as the revision in force
  const previewView: NoticeView | null = view && preview ? (() => {
    const r = view.draft ?? view.current;
    const diff = revising ? changedParagraphs(view.current.body, r.body) : { changed: [], removed: 0 };
    return { ...view, title: r.title, urgent: r.urgent, current: { ...r, ...diff, status: 'issued', issuedAt: null }, revisions: view.revisions.filter((x) => x.issuedAt), rev, status: 'issued', needsAck: false, acked: false, withdrawn: null, faq: view.faq } as NoticeView;
  })() : null;

  return (
    <div className="sheet-scrim nb-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside ref={ref} tabIndex={-1} onKeyDown={trapTab} className="sheet nb-sheet nb-compose" role="dialog" aria-modal="true" aria-label={revising ? `Revise ${view?.number}` : 'Draft a notice'}>
        <button className="sheet-close" onClick={onClose} aria-label="Close" title="Close (Esc)"><Icon name="x" size={18} /></button>
        <div className="sheet-body">
          {previewView ? (
            <div className="view nb-read">
              <div className="nb-preview-bar"><span className="label">Preview · as readers will see it</span><button className="btn" onClick={() => setPreview(false)}><Icon name="edit" size={15} />Back to the draft</button></div>
              <NoticeReading n={previewView} users={users} me={session.me} preview />
            </div>
          ) : (
            <div className="view">
              <div className="nb-compose-head">
                <h1>{revising ? `Revise ${view?.number}` : view ? 'Draft notice' : 'Draft a notice'}</h1>
                <p className="label">{revising ? `Rev ${rev} · Rev ${view?.rev} stays in force until this one is issued` : `${myDesks.find((d) => d.id === f.deskId)?.code ?? ''} · Rev A · numbered when issued`}</p>
              </div>
              <div className="settings nb-form">
                <section>
                  <div className="label nb-num">01 · Desk and kind</div>
                  <div className="form-grid nb-grid2">
                    <div className="field"><label htmlFor="nb-desk">Issuing desk</label>
                      <select id="nb-desk" className="input" value={f.deskId} disabled={!!view} onChange={(e) => set({ deskId: e.target.value })}>
                        {myDesks.map((d) => <option key={d.id} value={d.id}>{`${d.name} (${d.code})`}</option>)}
                      </select></div>
                    <div className="field"><label htmlFor="nb-cat">Kind</label>
                      <select id="nb-cat" className="input" value={f.category} disabled={revising} onChange={(e) => { const c = e.target.value as NoticeCategory; set({ category: c, standing: c === 'policy' ? true : f.standing }); }}>
                        {CATEGORY_ORDER.map((c) => <option key={c} value={c}>{CAT_LABEL[c]}</option>)}
                      </select></div>
                  </div>
                  <div className="nb-toggles">
                    <ToggleRow checked={f.standing} onChange={(v) => set({ standing: v })} label="On the In force shelf while it is in force" />
                    {isAdmin && <ToggleRow checked={f.urgent} onChange={(v) => set({ urgent: v })} label="Urgent: a banner for everyone it is for (three a day for the office)" />}
                  </div>
                </section>

                <section>
                  <div className="label nb-num">02 · Text</div>
                  <div className="field"><label htmlFor="nb-title">Title</label><input id="nb-title" className="input" maxLength={160} value={f.title} onChange={(e) => set({ title: e.target.value })} placeholder="Leave policy 2026" /></div>
                  <div className="field"><label htmlFor="nb-body">The notice</label>
                    <textarea id="nb-body" className="input nb-bodyedit" rows={9} maxLength={20000} value={f.body} onChange={(e) => set({ body: e.target.value })} placeholder="Write it as you would on letterhead. A blank line starts a new paragraph; **bold** and lists work as in messages." /></div>
                </section>

                <section>
                  <div className="label nb-num">03 · Attachment</div>
                  {f.file ? (
                    <div className="nb-attached"><span className="file-ico">PDF</span><span translate="no">{f.file.name}</span><button className="btn ghost sm" onClick={() => set({ fileId: null, file: null })}>Remove</button></div>
                  ) : window.dex.uploadFile ? (
                    <>
                      <input ref={fileInput} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => void attach(e.target.files?.[0])} aria-label="PDF to attach" />
                      <button className="btn" disabled={uploading} onClick={() => fileInput.current?.click()}>{uploading ? <span className="spinner" /> : <Icon name="paperclip" size={15} />}Attach the PDF</button>
                      <p className="faint nb-hint">Readers see it inside the notice, and its text is found by search.</p>
                    </>
                  ) : <p className="faint">PDFs are attached from a PC.</p>}
                </section>

                <section>
                  <div className="label nb-num">{`04 · For · ${count === 1 ? '1 person now' : `${count} people now`}`}</div>
                  <ToggleRow checked={f.audience.everyone} onChange={(v) => set({ audience: { ...f.audience, everyone: v } })} label="Everyone in the office (never guests)" />
                  {!f.audience.everyone && (
                    <div className="nb-aud">
                      <fieldset className="nb-aud-set"><legend>Departments (and the ones under them)</legend>
                        <div className="nb-aud-opts">{org.departments.map((d) => <label key={d.id} className={`nb-opt${f.audience.departments.includes(d.id) ? ' on' : ''}`}><input type="checkbox" checked={f.audience.departments.includes(d.id)} onChange={() => toggleIn('departments', d.id)} /><span translate="no">{d.name}</span></label>)}</div>
                      </fieldset>
                      <fieldset className="nb-aud-set"><legend>Roles</legend>
                        <div className="nb-aud-opts">
                          <label className={`nb-opt${f.audience.roles.includes('admin') ? ' on' : ''}`}><input type="checkbox" checked={f.audience.roles.includes('admin')} onChange={() => toggleIn('roles', 'admin')} /><span>Administrators</span></label>
                          <label className={`nb-opt${f.audience.roles.includes('member') ? ' on' : ''}`}><input type="checkbox" checked={f.audience.roles.includes('member')} onChange={() => toggleIn('roles', 'member')} /><span>Members</span></label>
                        </div>
                      </fieldset>
                      <div className="field"><label htmlFor="nb-loc">Locations, as on profiles (separate with commas)</label>
                        <input id="nb-loc" className="input" value={f.audience.locations.join(', ')} onChange={(e) => set({ audience: { ...f.audience, everyone: false, locations: e.target.value.split(',').map((x) => x.trimStart()).filter((x, i, a) => x || i === a.length - 1) } })} placeholder="Site — Jamnagar, Site — Dahej" /></div>
                      <div className="field"><label htmlFor="nb-ppl">People</label>
                        <select id="nb-ppl" className="input" value="" onChange={(e) => { if (e.target.value) toggleIn('people', e.target.value); }}>
                          <option value="">Add a person…</option>
                          {session.users.filter((u) => u.role !== 'bot' && u.role !== 'guest' && !f.audience.people.includes(u.id)).map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
                        </select>
                        {f.audience.people.length > 0 && <div className="nb-aud-opts">{f.audience.people.map((p) => <button key={p} type="button" className="nb-opt on" onClick={() => toggleIn('people', p)} aria-label={`Remove ${users.get(p)?.displayName ?? ''}`}><span translate="no">{users.get(p)?.displayName ?? 'Former colleague'}</span><Icon name="x" size={12} /></button>)}</div>}
                      </div>
                    </div>
                  )}
                </section>

                <section>
                  <div className="label nb-num">05 · Acknowledgement</div>
                  <ToggleRow checked={f.ackRequired} onChange={(v) => set({ ackRequired: v })} label="Ask readers to acknowledge: read and understood" />
                  {f.ackRequired && (
                    <div className="nb-checks-edit">
                      {f.checks.map((c, i) => (
                        <fieldset key={i} className="nb-check-edit"><legend>{`Check question ${i + 1}`}</legend>
                          <input className="input" aria-label={`Check question ${i + 1}`} maxLength={200} value={c.prompt} onChange={(e) => set({ checks: f.checks.map((x, k) => (k === i ? { ...x, prompt: e.target.value } : x)) })} placeholder="How many days of earned leave carry forward?" />
                          {c.options.map((o, j) => (
                            <div key={j} className="nb-opt-edit">
                              <input type="radio" name={`nb-right-${i}`} checked={c.answer === j} onChange={() => set({ checks: f.checks.map((x, k) => (k === i ? { ...x, answer: j } : x)) })} aria-label={`Answer ${j + 1} is right`} />
                              <input className="input" aria-label={`Answer ${j + 1}`} maxLength={120} value={o} onChange={(e) => set({ checks: f.checks.map((x, k) => (k === i ? { ...x, options: x.options.map((y, m) => (m === j ? e.target.value : y)) } : x)) })} />
                              {c.options.length > 2 && <button type="button" className="icon-btn" aria-label={`Remove answer ${j + 1}`} onClick={() => set({ checks: f.checks.map((x, k) => (k === i ? { ...x, options: x.options.filter((_, m) => m !== j), answer: x.answer === j ? 0 : x.answer > j ? x.answer - 1 : x.answer } : x)) })}><Icon name="x" size={13} /></button>}
                            </div>
                          ))}
                          <div className="nb-ask-actions">
                            {c.options.length < 4 && <button type="button" className="btn ghost sm" onClick={() => set({ checks: f.checks.map((x, k) => (k === i ? { ...x, options: [...x.options, ''] } : x)) })}>Add an answer</button>}
                            <button type="button" className="btn ghost sm danger" onClick={() => set({ checks: f.checks.filter((_, k) => k !== i) })}>Remove the question</button>
                          </div>
                        </fieldset>
                      ))}
                      {f.checks.length < 3 && <button type="button" className="btn ghost" onClick={() => set({ checks: [...f.checks, { prompt: '', options: ['', ''], answer: 0 }] })}><Icon name="plus" size={15} />Add a check question</button>}
                      <p className="faint nb-hint">Readers answer them before they can acknowledge. The right answers stay on the hub.</p>
                    </div>
                  )}
                </section>

                <section>
                  <div className="label nb-num">06 · Dates</div>
                  <div className="form-grid nb-grid2">
                    <div className="field"><label htmlFor="nb-eff">{f.category === 'holiday' || f.category === 'event' ? 'The day' : 'Effective from'}</label><input id="nb-eff" className="input" type="date" value={f.effective} onChange={(e) => set({ effective: e.target.value })} /></div>
                    <div className="field"><label htmlFor="nb-exp">Expires (it moves to the archive)</label><input id="nb-exp" className="input" type="date" value={f.expires} onChange={(e) => set({ expires: e.target.value })} /></div>
                  </div>
                </section>

                <section>
                  <div className="label nb-num">07 · Translations (optional)</div>
                  <p className="faint nb-hint">Readers who use the app in Hindi or Tamil see your version when there is one. Nothing is translated by machine.</p>
                  {(['hi', 'ta'] as NoticeLang[]).map((l) => (
                    <details key={l} className="nb-tr" open={!!(f.translations[l]?.title || f.translations[l]?.body)}>
                      <summary><span translate="no">{LANG_NAME[l]}</span></summary>
                      <input className="input" lang={l} aria-label={`Title in ${l === 'hi' ? 'Hindi' : 'Tamil'}`} maxLength={160} value={f.translations[l]?.title ?? ''} onChange={(e) => set({ translations: { ...f.translations, [l]: { title: e.target.value, body: f.translations[l]?.body ?? '' } } })} />
                      <textarea className="input" lang={l} rows={5} aria-label={`The notice in ${l === 'hi' ? 'Hindi' : 'Tamil'}`} maxLength={20000} value={f.translations[l]?.body ?? ''} onChange={(e) => set({ translations: { ...f.translations, [l]: { title: f.translations[l]?.title ?? '', body: e.target.value } } })} />
                    </details>
                  ))}
                </section>

                {revising && (
                  <section>
                    <div className="label nb-num">{`08 · Rev ${rev}`}</div>
                    <div className="field"><label htmlFor="nb-change">What changed</label><textarea id="nb-change" className="input" rows={2} maxLength={600} value={f.changeNote} onChange={(e) => set({ changeNote: e.target.value })} placeholder="Carry forward raised from 30 to 45 days." /></div>
                    <ToggleRow checked={f.reack} onChange={(v) => set({ reack: v })} label="Ask everyone to acknowledge again" />
                    <p className="faint nb-hint">{f.reack ? 'Everyone it is for is asked again, and earlier acknowledgements stop counting.' : `Acknowledgements of Rev ${view?.rev} still count. Changed paragraphs are marked with a revision cloud.`}</p>
                  </section>
                )}

                {(list?.notices ?? []).filter((n) => n.number && n.id !== view?.id).length > 0 && (
                  <section>
                    <div className="label nb-num">{revising ? '09 · Related' : '08 · Related'}</div>
                    <select className="input" aria-label="Link a related notice" value="" onChange={(e) => { if (e.target.value && f.related.length < 10) set({ related: [...f.related, e.target.value] }); }}>
                      <option value="">Link a related notice…</option>
                      {(list?.notices ?? []).filter((n) => n.number && n.id !== view?.id && !f.related.includes(n.id)).map((n) => <option key={n.id} value={n.id}>{`${n.number} · ${n.title}`}</option>)}
                    </select>
                    {f.related.length > 0 && <div className="nb-aud-opts">{f.related.map((r) => { const n = list?.notices.find((x) => x.id === r); return <button key={r} type="button" className="nb-opt on" onClick={() => set({ related: f.related.filter((x) => x !== r) })}><span className="mono" translate="no">{n?.number ?? ''}</span><Icon name="x" size={12} /></button>; })}</div>}
                  </section>
                )}
              </div>
            </div>
          )}
        </div>
        {!previewView && (
          <footer className="nb-compose-foot">
            <button className="btn ghost danger" onClick={() => void discard()}>{view ? 'Throw away' : 'Cancel'}</button>
            <span className="nb-flex" />
            <button className="btn ghost" disabled={!!busy} onClick={() => void save()}>Save draft</button>
            <button className="btn" disabled={!!busy} onClick={() => void save(true).then((v) => { if (v) setPreview(true); })}><Icon name="search" size={15} />Preview</button>
            {scheduled ? (
              <button className="btn" onClick={() => void unschedule()}>Take back to a draft</button>
            ) : when !== null ? (
              <span className="nb-when">
                <input className="input" type="datetime-local" aria-label="Issue on" value={when} onChange={(e) => setWhen(e.target.value)} />
                <button className="btn" disabled={!when || !!busy} onClick={() => void issue(new Date(when).getTime())}>{busy === 'schedule' ? <span className="spinner" /> : <Icon name="clock" size={15} />}Schedule</button>
              </span>
            ) : !f.urgent && <button className="btn" onClick={() => setWhen('')}><Icon name="clock" size={15} />Schedule…</button>}
            {!scheduled && <button className="btn primary" disabled={!!busy} onClick={() => void issue(null)}>{busy === 'issue' ? <span className="spinner" /> : <Icon name="send" size={15} />}{revising ? `Issue Rev ${rev}` : 'Issue now'}</button>}
          </footer>
        )}
      </aside>
    </div>
  );
}
