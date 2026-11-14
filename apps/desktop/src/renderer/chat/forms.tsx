// Forms in conversations: the builder, the card in the timeline, filling one in, and the
// creator's table of answers (exportable as CSV).
import { useEffect, useState } from 'react';
import { toCsv } from '@dex/core';
import type { Conversation, FormField, FormFieldType, FormResponse, FormView, Message, PublicUser } from '@dex/core';
import { Avatar, Dialog, Icon, useToast } from '../ui.tsx';
import { downloadText } from '../work/store.ts';

const TYPE_LABEL: Record<FormFieldType, string> = { text: 'Short answer', long: 'Paragraph', choice: 'One choice', multi: 'Several choices', number: 'Number', date: 'Date' };

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
      <div className="poll-q">{form.title}</div>
      {form.description && <p className="muted" style={{ margin: '0 0 10px', fontSize: 13 }}>{form.description}</p>}
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
      {form.fields.map((f) => <div key={f.id} className="field"><label>{f.label}{f.required && <span className="req"> *</span>}</label>{input(f)}</div>)}
      <div className="dialog-actions">
        <span className="faint">{missing.length ? `${missing.length} required left` : 'Ready to send'}</span>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || missing.length > 0} onClick={() => void submit()}>Send answers</button>
      </div>
    </Dialog>
  );
}

function FormAnswers({ formId, users, onClose }: { formId: string; users: Map<string, PublicUser>; onClose: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<{ form: FormView; responses: FormResponse[] } | null>(null);
  useEffect(() => { void window.dex.request('form.responses', { formId }).then(setData).catch((e: Error) => toast(e.message, true)); }, [formId, toast]);
  const show = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(', ') : v ?? '');
  const exportCsv = () => {
    if (!data) return;
    downloadText(`${data.form.title.replace(/[^\w -]/g, '').slice(0, 60) || 'form'}-answers.csv`, toCsv([
      ['Name', 'Account', 'Answered at', ...data.form.fields.map((f) => f.label)],
      ...data.responses.map((r) => [users.get(r.userId)?.displayName ?? '', users.get(r.userId)?.account ?? '', new Date(r.at).toLocaleString(), ...data.form.fields.map((f) => show(r.answers[f.id]))]),
    ]));
  };
  return (
    <Dialog title={data ? `${data.form.title} · ${data.responses.length} answers` : 'Answers'} onClose={onClose}>
      {!data && <div className="tl-more"><span className="spinner" /></div>}
      {data && data.responses.length === 0 && <p className="faint">No answers yet.</p>}
      {data && data.responses.length > 0 && (
        <div className="att-grid-wrap">
          <table className="att-table">
            <thead><tr><th>Person</th>{data.form.fields.map((f) => <th key={f.id}>{f.label}</th>)}</tr></thead>
            <tbody>{data.responses.map((r) => {
              const u = users.get(r.userId);
              return <tr key={r.userId}><td><span className="att-person">{u && <Avatar user={u} size="sm" />}{u?.displayName ?? 'Former member'}</span></td>{data.form.fields.map((f) => <td key={f.id}>{show(r.answers[f.id])}</td>)}</tr>;
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
        <button className="btn" disabled={!data?.responses.length} onClick={exportCsv}><Icon name="download" size={15} />Export CSV</button>
      </div>
    </Dialog>
  );
}
