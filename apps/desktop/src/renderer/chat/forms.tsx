// Forms in conversations: the builder, the card in the timeline, filling one in (text, choices,
// numbers, dates, a file or photo, a scanned barcode), and the creator's table of answers
// (exportable as CSV).
import { useEffect, useRef, useState } from 'react';
import { toCsv } from '@dex/core';
import type { Conversation, FormField, FormFieldType, FormResponse, FormView, Message, PublicUser } from '@dex/core';
import { Avatar, Dialog, Icon, useToast } from '../ui.tsx';
import { downloadText } from '../work/store.ts';
import { FileImg, fileSrc, filesSupported, formatSize } from './files.tsx';
import { BARCODE_FORMATS, QrScanner } from '../views/Pairing.tsx';
import { policyNow } from '../policy.ts';

const TYPE_LABEL: Record<FormFieldType, string> = { text: 'Short answer', long: 'Paragraph', choice: 'One choice', multi: 'Several choices', number: 'Number', date: 'Date', file: 'File or photo', scan: 'Scan a code' };

type Draft = { label: string; type: FormFieldType; options: string; required: boolean };

export function FormBuilder({ conv, onClose }: { conv: Conversation; onClose: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [fields, setFields] = useState<Draft[]>([{ label: '', type: 'text', options: '', required: true }]);
  const [busy, setBusy] = useState(false);
  const set = (i: number, patch: Partial<Draft>) => setFields(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const post = async () => {
    setBusy(true);
    try {
      await window.dex.request('form.create', {
        convId: conv.id, title, description: description || undefined, clientId: `form-${Date.now().toString(36)}`,
        fields: fields.filter((f) => f.label.trim()).map((f) => ({ label: f.label, type: f.type, required: f.required, options: f.type === 'choice' || f.type === 'multi' ? f.options.split('\n').map((o) => o.trim()).filter(Boolean) : undefined })),
      });
      onClose();
    } catch (e) { toast((e as Error).message, true); setBusy(false); }
  };
  return (
    <Dialog title="New form" onClose={onClose}>
      <div className="field"><label htmlFor="f-title">Title</label><input id="f-title" className="input" autoFocus maxLength={140} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Site visit sign-up" /></div>
      <div className="field"><label htmlFor="f-desc">Description (optional)</label><input id="f-desc" className="input" maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="The bus leaves at 7:00 from the office" /></div>
      <div className="form-qs">
        {fields.map((f, i) => (
          <div key={i} className="form-q">
            <div className="form-q-head">
              <span className="label">Question {i + 1}</span>
              <select className="input" value={f.type} onChange={(e) => set(i, { type: e.target.value as FormFieldType })} aria-label="Answer type">
                {(Object.keys(TYPE_LABEL) as FormFieldType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
              </select>
              {fields.length > 1 && <button className="icon-btn" aria-label={`Remove question ${i + 1}`} onClick={() => setFields(fields.filter((_, j) => j !== i))}><Icon name="x" size={14} /></button>}
            </div>
            <input className="input" maxLength={200} value={f.label} placeholder="Question" onChange={(e) => set(i, { label: e.target.value })} />
            {(f.type === 'choice' || f.type === 'multi') && <textarea className="input" rows={3} value={f.options} placeholder={'One choice per line\nYes\nNo'} onChange={(e) => set(i, { options: e.target.value })} />}
            <label className="check-line"><input type="checkbox" checked={f.required} onChange={(e) => set(i, { required: e.target.checked })} />Required</label>
          </div>
        ))}
      </div>
      {fields.length < 30 && <button className="btn ghost" onClick={() => setFields([...fields, { label: '', type: 'text', options: '', required: false }])}><Icon name="plus" size={15} />Add a question</button>}
      <div className="dialog-actions">
        <span className="faint">Answers are visible to you only.</span>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!title.trim() || !fields.some((f) => f.label.trim()) || busy} onClick={() => void post()}><Icon name="list" size={15} />Post form</button>
      </div>
    </Dialog>
  );
}

export function FormCard({ m, meId, users }: { m: Message; meId: string; users: Map<string, PublicUser> }) {
  const form = m.form!;
  const [filling, setFilling] = useState(false);
  const [answers, setAnswers] = useState(false);
  const mineForm = m.authorId === meId;
  return (
    <div className={`poll form-card${form.closed ? ' closed' : ''}`}>
      <div className="poll-head"><Icon name="list" size={16} /><span className="label">Form{form.closed ? ' · closed' : ''} · {form.fields.length} {form.fields.length === 1 ? 'question' : 'questions'}</span></div>
      <div className="poll-q" translate="no">{form.title}</div>
      {form.description && <p className="muted" style={{ margin: '0 0 10px', fontSize: 13 }} translate="no">{form.description}</p>}
      <div className="row-actions">
        {!form.closed && <button className={`btn${form.mine ? '' : ' primary'}`} onClick={() => setFilling(true)}>{form.mine ? 'Change my answers' : 'Fill in'}</button>}
        {form.mine && <span className="chip ok"><Icon name="check" size={12} />Answered</span>}
        {mineForm && <button className="btn ghost" onClick={() => setAnswers(true)}>See answers · {form.responses}</button>}
      </div>
      {filling && <FillForm form={form} onClose={() => setFilling(false)} />}
      {answers && <FormAnswers formId={form.id} users={users} onClose={() => setAnswers(false)} />}
    </div>
  );
}

/** A file or photo answer: picked, uploaded at once, and kept as the file's id. */
function FileAnswer({ value, onChange }: { value: string | undefined; onChange: (id: string | undefined) => void }) {
  const toast = useToast();
  const pick = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; size: number } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!window.dex.uploadFile) return <span className="faint">Files can be added from the Dexterity Connect app on a PC or phone.</span>;
  const choose = async (f: File | undefined) => {
    if (!f) return;
    const limit = policyNow().maxUploadMb;
    if (f.size > limit * 1024 * 1024) { toast(`That file is larger than the office limit of ${limit} MB.`, true); return; }
    setBusy(true);
    try {
      const path = window.dex.pathForFile?.(f) || '';
      const info = await window.dex.uploadFile!(`form-${Date.now().toString(36)}`, path ? { path, name: f.name, mime: f.type || undefined } : { data: await f.arrayBuffer(), name: f.name, mime: f.type || undefined });
      setFile({ name: info.name, size: info.size });
      onChange(info.id);
    } catch (e) { toast((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true); } finally { setBusy(false); }
  };
  return (
    <div className="form-file">
      <input ref={pick} type="file" hidden onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ''; }} />
      {value ? (
        <span className="form-file-chip"><Icon name="paperclip" size={14} /><span className="sb-name" translate="no">{file?.name ?? 'Your file'}</span>{file && <span className="faint mono">{formatSize(file.size)}</span>}</span>
      ) : null}
      <button type="button" className="btn sm" disabled={busy} onClick={() => pick.current?.click()}>{busy ? <span className="spinner" /> : <Icon name="paperclip" size={14} />}{value ? 'Replace' : 'Choose a file or photo'}</button>
      {value && <button type="button" className="btn ghost sm" onClick={() => { setFile(null); onChange(undefined); }}>Remove</button>}
    </div>
  );
}

/** A scanned answer: typed, or read from a barcode or QR code with the camera. */
function ScanAnswer({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const [scan, setScan] = useState(false);
  const camera = !!navigator.mediaDevices?.getUserMedia;
  return (
    <div className="scan-field">
      <input className="input mono" maxLength={500} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Scan or type the code" aria-label={label} />
      {camera && <button type="button" className="btn" onClick={() => setScan(true)}><Icon name="video" size={14} />Scan</button>}
      {scan && <QrScanner formats={BARCODE_FORMATS} hint="Hold the barcode or QR code inside the square" onClose={() => setScan(false)} onCode={(t) => { setScan(false); onChange(t.trim().slice(0, 500)); }} />}
    </div>
  );
}

function FillForm({ form, onClose }: { form: FormView; onClose: () => void }) {
  const toast = useToast();
  const [a, setA] = useState<Record<string, string | string[]>>(form.mine ?? {});
  const [busy, setBusy] = useState(false);
  const missing = form.fields.filter((f) => f.required && (a[f.id] === undefined || a[f.id] === '' || (Array.isArray(a[f.id]) && !(a[f.id] as string[]).length)));
  const submit = async () => {
    setBusy(true);
    try { await window.dex.request('form.respond', { formId: form.id, answers: a }); toast('Answers sent'); onClose(); } catch (e) { toast((e as Error).message, true); setBusy(false); }
  };
  const input = (f: FormField) => {
    const v = a[f.id];
    switch (f.type) {
      case 'long': return <textarea className="input" rows={4} value={(v as string) ?? ''} onChange={(e) => setA({ ...a, [f.id]: e.target.value })} />;
      case 'number': return <input className="input" type="number" value={(v as string) ?? ''} onChange={(e) => setA({ ...a, [f.id]: e.target.value })} />;
      case 'date': return <input className="input" type="date" value={(v as string) ?? ''} onChange={(e) => setA({ ...a, [f.id]: e.target.value })} />;
      case 'file': return <FileAnswer value={v as string | undefined} onChange={(id) => { const next = { ...a }; if (id) next[f.id] = id; else delete next[f.id]; setA(next); }} />;
      case 'scan': return <ScanAnswer label={f.label} value={(v as string) ?? ''} onChange={(t) => setA({ ...a, [f.id]: t })} />;
      case 'choice': return <div className="chip-row">{(f.options ?? []).map((o) => <button key={o} type="button" className={`when-chip${v === o ? ' on' : ''}`} onClick={() => setA({ ...a, [f.id]: o })}>{o}</button>)}</div>;
      case 'multi': {
        const list = Array.isArray(v) ? v : [];
        return <div className="chip-row">{(f.options ?? []).map((o) => <button key={o} type="button" className={`when-chip${list.includes(o) ? ' on' : ''}`} onClick={() => setA({ ...a, [f.id]: list.includes(o) ? list.filter((x) => x !== o) : [...list, o] })}>{o}</button>)}</div>;
      }
      default: return <input className="input" maxLength={500} value={(v as string) ?? ''} onChange={(e) => setA({ ...a, [f.id]: e.target.value })} />;
    }
  };
  return (
    <Dialog title={form.title} onClose={onClose}>
      {form.description && <p className="muted" style={{ margin: 0 }}>{form.description}</p>}
      {form.fields.map((f) => <div key={f.id} className="field"><label translate="no">{f.label}{f.required && <span className="req"> *</span>}</label>{input(f)}</div>)}
      <div className="dialog-actions">
        <span className="faint">{missing.length ? `${missing.length} required left` : 'Ready to send'}</span>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || missing.length > 0} onClick={() => void submit()}>Send answers</button>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ files answered in forms
/** The hub gives a form's author each answered file by id: its kind is read from its first bytes. */
const kinds = new Map<string, Promise<string>>();
const TYPE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav' };
function extOf(id: string): Promise<string> {
  let p = kinds.get(id);
  if (!p) {
    p = (async () => {
      const url = window.dex.fileUrl ? await window.dex.fileUrl(id, id) : fileSrc(id);
      const r = await fetch(url);
      const reader = r.body?.getReader();
      const head = reader ? (await reader.read()).value : undefined;
      void reader?.cancel().catch(() => {});
      if (head && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return 'pdf';
      return TYPE_EXT[(r.headers.get('content-type') ?? '').split(';')[0]] ?? '';
    })().catch(() => '');
    kinds.set(id, p);
  }
  return p;
}
/** The name an answered file is opened and saved under: "Photo - Priya Raman.jpg". */
const answerFileName = (field: string, person: string, ext: string) => `${`${field} - ${person}`.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 100)}${ext ? `.${ext}` : ''}`;

function AnswerFile({ id, name }: { id: string; name: string | undefined }) {
  const toast = useToast();
  const image = !!name && /\.(png|jpg|gif|webp|bmp)$/.test(name);
  const open = () => {
    if (!window.dex.openFile || !name) return;
    void window.dex.openFile(id, name).catch((e: Error) => toast(e.message, true));
  };
  return (
    <button type="button" className="answer-file" onClick={open} title={name ? `Open ${name}` : 'Open the file'} disabled={!name || !window.dex.openFile}>
      {image && filesSupported() ? <span className="answer-thumb"><FileImg f={{ id, name: name! }} lazy /></span> : <Icon name="paperclip" size={14} />}
      <span translate="no">{name ?? '…'}</span>
    </button>
  );
}

function FormAnswers({ formId, users, onClose }: { formId: string; users: Map<string, PublicUser>; onClose: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<{ form: FormView; responses: FormResponse[] } | null>(null);
  /** file id → the name it is opened, saved and exported under */
  const [names, setNames] = useState<Map<string, string>>(new Map());
  useEffect(() => { void window.dex.request('form.responses', { formId }).then(setData).catch((e: Error) => toast(e.message, true)); }, [formId, toast]);
  useEffect(() => {
    if (!data) return;
    let live = true;
    const files = data.form.fields.filter((f) => f.type === 'file');
    const jobs = data.responses.flatMap((r) => files.map((f) => ({ id: r.answers[f.id], field: f.label, person: users.get(r.userId)?.displayName ?? 'Former member' })))
      .filter((j): j is { id: string; field: string; person: string } => typeof j.id === 'string' && !!j.id);
    void Promise.all(jobs.map(async (j) => [j.id, answerFileName(j.field, j.person, await extOf(j.id))] as const)).then((l) => { if (live) setNames(new Map(l)); });
    return () => { live = false; };
  }, [data, users]);
  const show = (f: FormField, v: string | string[] | undefined) => (Array.isArray(v) ? v.join(', ') : f.type === 'file' && v ? names.get(v) ?? '' : v ?? '');
  const exportCsv = () => {
    if (!data) return;
    downloadText(`${data.form.title.replace(/[^\w -]/g, '').slice(0, 60) || 'form'}-answers.csv`, toCsv([
      ['Name', 'Account', 'Answered at', ...data.form.fields.map((f) => f.label)],
      ...data.responses.map((r) => [users.get(r.userId)?.displayName ?? '', users.get(r.userId)?.account ?? '', new Date(r.at).toLocaleString(), ...data.form.fields.map((f) => show(f, r.answers[f.id]))]),
    ]));
  };
  return (
    <Dialog title={data ? `${data.form.title} · ${data.responses.length} answers` : 'Answers'} onClose={onClose}>
      {!data && <div className="tl-more"><span className="spinner" /></div>}
      {data && data.responses.length === 0 && <p className="faint">No answers yet.</p>}
      {data && data.responses.length > 0 && (
        <div className="att-grid-wrap">
          <table className="att-table">
            <thead><tr><th>Person</th>{data.form.fields.map((f) => <th key={f.id} translate="no">{f.label}</th>)}</tr></thead>
            <tbody>{data.responses.map((r) => {
              const u = users.get(r.userId);
              return <tr key={r.userId}><td><span className="att-person" translate="no">{u && <Avatar user={u} size="sm" />}{u?.displayName ?? 'Former member'}</span></td>{data.form.fields.map((f) => {
                const v = r.answers[f.id];
                return <td key={f.id} translate="no" className={f.type === 'scan' ? 'mono' : undefined}>{f.type === 'file' && typeof v === 'string' && v ? <AnswerFile id={v} name={names.get(v)} /> : show(f, v)}</td>;
              })}</tr>;
            })}</tbody>
          </table>
        </div>
      )}
      {data && (() => {
        const choice = data.form.fields.filter((f) => f.type === 'choice' || f.type === 'multi');
        return choice.length > 0 && data.responses.length > 0 ? (
          <div className="form-tally">
            {choice.map((f) => (
              <div key={f.id}><div className="label">{f.label}</div>
                {(f.options ?? []).map((o) => {
                  const n = data.responses.filter((r) => (Array.isArray(r.answers[f.id]) ? (r.answers[f.id] as string[]).includes(o) : r.answers[f.id] === o)).length;
                  return <div key={o} className="team-bar"><span className="team-bar-label">{o}</span><span className="team-bar-track"><span style={{ width: `${(n / data.responses.length) * 100}%` }} /></span><span className="mono team-bar-n">{n}</span></div>;
                })}
              </div>
            ))}
          </div>
        ) : null;
      })()}
      <div className="dialog-actions">
        <span />
        {data && !data.form.closed && <button className="btn ghost danger" onClick={() => void window.dex.request('form.close', { formId }).then(() => { toast('Form closed'); onClose(); }).catch((e: Error) => toast(e.message, true))}>Close form</button>}
        <button className="btn" disabled={!data?.responses.length || (data.form.fields.some((f) => f.type === 'file') && !names.size && data.responses.some((r) => data.form.fields.some((f) => f.type === 'file' && r.answers[f.id])))} onClick={exportCsv}><Icon name="download" size={15} />Export CSV</button>
      </div>
    </Dialog>
  );
}
