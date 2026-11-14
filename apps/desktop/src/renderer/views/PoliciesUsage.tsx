// Control room ▸ Policies (edit window, upload limit, PC-to-PC fallback, call recording) and
// ▸ Usage (activity per day, busiest Spaces and people, storage, calls).
import { useEffect, useMemo, useRef, useState } from 'react';
import { EmojiImg, useCustomEmoji } from '../emoji.tsx';
import type { OfficePolicy, PublicUser, UsageReport } from '@dex/core';
import { Avatar, Icon, Segmented, Toggle, useToast } from '../ui.tsx';
import { formatSize } from '../chat/files.tsx';

const EDIT: Array<[number | null, string]> = [[null, 'Any time'], [5, '5 minutes'], [15, '15 minutes'], [60, '1 hour'], [1440, '1 day'], [10080, '7 days']];
const UPLOAD: Array<[number, string]> = [[25, '25 MB'], [100, '100 MB'], [250, '250 MB'], [1024, '1 GB'], [2048, '2 GB'], [4096, '4 GB']];

export function PoliciesAdmin() {
  const toast = useToast();
  const [p, setP] = useState<OfficePolicy | null>(null);
  useEffect(() => { void window.dex.request('policy.get').then(setP).catch(() => {}); }, []);
  const save = (patch: Partial<OfficePolicy>) => void window.dex.request('admin.policy.set', patch).then((n) => { setP(n); toast('Policy saved'); }).catch((e: Error) => toast(e.message, true));
  if (!p) return <div className="tl-more"><span className="spinner" /></div>;
  const uploadOptions = UPLOAD.some(([v]) => v === p.maxUploadMb) ? UPLOAD : [...UPLOAD, [p.maxUploadMb, `${p.maxUploadMb} MB`] as [number, string]].sort((a, b) => a[0] - b[0]);
  return (
    <div className="org-admin">
      <section className="card">
        <div className="eyebrow">Messages</div>
        <div className="form-row">
          <div className="field"><label htmlFor="p-edit">People can edit or delete their messages</label>
            <select id="p-edit" className="input" value={p.editWindowMinutes ?? ''} onChange={(e) => save({ editWindowMinutes: e.target.value ? Number(e.target.value) : null })}>
              {EDIT.map(([v, l]) => <option key={String(v)} value={v ?? ''}>{v === null ? l : `For ${l} after sending`}</option>)}
            </select></div>
          <div className="field"><label htmlFor="p-up">Largest file people can share</label>
            <select id="p-up" className="input" value={p.maxUploadMb} onChange={(e) => save({ maxUploadMb: Number(e.target.value) })}>
              {uploadOptions.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></div>
        </div>
        <p className="faint" style={{ fontSize: 12.5, margin: '10px 0 0' }}>Space moderators can always remove messages in their Spaces. Earlier versions of messages on legal hold are kept either way.</p>
      </section>
      <section className="card">
        <div className="eyebrow">When the hub is off</div>
        <div className="setting" style={{ marginTop: 6 }}>
          <div className="txt"><div>Direct messages pass straight between PCs</div><div className="faint">Encrypted, signed and limited to the office network. Messages written then are posted to the hub when it is back.</div></div>
          <Toggle label="Direct messages pass straight between PCs" checked={p.peerFallback} onChange={(v) => save({ peerFallback: v })} />
        </div>
      </section>
      <EmojiAdmin />
      <section className="card">
        <div className="eyebrow">Calls</div>
        <div className="setting" style={{ marginTop: 6 }}>
          <div className="txt"><div>People can record calls</div><div className="faint">Everyone in the call sees that it is being recorded. The recording is saved on the PC of the person who recorded it.</div></div>
          <Toggle label="People can record calls" checked={p.allowRecording} onChange={(v) => save({ allowRecording: v })} />
        </div>
      </section>
    </div>
  );
}

const shortDay = (k: string) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString([], { day: 'numeric', month: 'short' }); };

function DailyChart({ daily }: { daily: UsageReport['daily'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(4, ...daily.map((d) => d.messages));
  const nice = (() => { const step = 10 ** Math.floor(Math.log10(max)); return Math.ceil(max / step) * step; })();
  const W = 640, H = 180, L = 36, B = 22, T = 8;
  const bw = (W - L) / daily.length;
  const y = (v: number) => T + (H - T - B) * (1 - v / nice);
  const gap = Math.min(4, bw * 0.25);
  const ticks = [0, nice / 2, nice];
  const every = Math.ceil(daily.length / 8);
  const h = hover === null ? null : daily[hover];
  return (
    <div className="usage-chart">
      <div className="usage-legend"><span><i className="sw s1" />Spaces</span><span><i className="sw s2" />Direct</span></div>
      <div className="usage-plot" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Messages per day, Spaces and Direct">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={L} x2={W} y1={y(t)} y2={y(t)} className="grid" />
              <text x={L - 6} y={y(t) + 4} className="tick" textAnchor="end">{t}</text>
            </g>
          ))}
          {daily.map((d, i) => {
            const x = L + i * bw + gap / 2;
            const w = Math.max(1, bw - gap);
            const ySpace = y(d.space);
            const yAll = y(d.messages);
            const base2 = d.space ? ySpace - 2 : y(0);
            const r = Math.max(0, Math.min(4, w / 2, (d.direct ? base2 - yAll : y(0) - ySpace)));
            return (
              <g key={d.day} onMouseEnter={() => setHover(i)}>
                <rect x={L + i * bw} y={T} width={bw} height={H - T - B} fill="transparent" />
                {d.space > 0 && <path className="s1" d={`M${x},${y(0)} V${ySpace + (d.direct ? 0 : r)} ${d.direct ? '' : `Q${x},${ySpace} ${x + r},${ySpace} H${x + w - r} Q${x + w},${ySpace} ${x + w},${ySpace + r}`} ${d.direct ? `H${x + w}` : ''} V${y(0)} Z`} />}
                {d.direct > 0 && base2 > yAll && <path className="s2" d={`M${x},${base2} V${yAll + r} Q${x},${yAll} ${x + r},${yAll} H${x + w - r} Q${x + w},${yAll} ${x + w},${yAll + r} V${base2} Z`} />}
                {hover === i && <rect x={x - 1} y={T} width={w + 2} height={H - T - B} className="hover-col" />}
                {i % every === 0 && <text x={x + w / 2} y={H - 6} className="tick" textAnchor="middle">{shortDay(d.day)}</text>}
              </g>
            );
          })}
          <line x1={L} x2={W} y1={y(0)} y2={y(0)} className="axis" />
        </svg>
        {h && (
          <div className="usage-tip" style={{ left: `${((L + (hover! + 0.5) * bw) / W) * 100}%` }}>
            <b>{shortDay(h.day)}</b>
            <span><i className="sw s1" />Spaces <b>{h.space}</b></span>
            <span><i className="sw s2" />Direct <b>{h.direct}</b></span>
            <span className="faint">{h.activePeople} {h.activePeople === 1 ? "person" : "people"} · {h.calls} {h.calls === 1 ? "call" : "calls"}{h.callMinutes ? ` · ${h.callMinutes} min` : ''}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function UsageAdmin({ users }: { users: PublicUser[] }) {
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [r, setR] = useState<UsageReport | null>(null);
  const [table, setTable] = useState(false);
  useEffect(() => { setR(null); void window.dex.request('admin.usage', { days }).then(setR).catch(() => {}); }, [days]);
  const byId = useMemo(() => new Map(users.map((u) => [u.id, u] as const)), [users]);
  return (
    <div className="org-admin">
      <div className="toolbar" style={{ justifyContent: 'space-between' }}>
        <Segmented<'7' | '30' | '90'> label="Period" value={String(days) as '7' | '30' | '90'} onChange={(v) => setDays(Number(v) as 7 | 30 | 90)} options={[
          { value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' },
        ]} />
        <button className="btn ghost sm" onClick={() => setTable(!table)}><Icon name="list" size={14} />{table ? 'Show chart' : 'Show as table'}</button>
      </div>
      {!r ? <div className="tl-more"><span className="spinner" /></div> : (
        <>
          <div className="usage-tiles">
            <div className="card tile"><span className="eyebrow">People active</span><b>{r.totals.activePeople}</b><span className="faint">of {r.totals.people} · {r.totals.activeDevices} devices seen</span></div>
            <div className="card tile"><span className="eyebrow">Messages</span><b>{r.totals.messages.toLocaleString()}</b><span className="faint">{Math.round(r.totals.messages / r.days).toLocaleString()} a day · {r.totals.spaces} Spaces</span></div>
            <div className="card tile"><span className="eyebrow">Calls</span><b>{r.totals.calls}</b><span className="faint">{r.totals.callMinutes.toLocaleString()} minutes talked</span></div>
            <div className="card tile"><span className="eyebrow">Files stored</span><b>{formatSize(r.totals.fileBytes)}</b><span className="faint">{r.totals.files.toLocaleString()} files on the hub</span></div>
          </div>
          <section className="card">
            <div className="eyebrow">Messages per day</div>
            {table ? (
              <div className="usage-table"><table>
                <thead><tr><th>Day</th><th>Spaces</th><th>Direct</th><th>People</th><th>Calls</th><th>Call minutes</th></tr></thead>
                <tbody>{[...r.daily].reverse().map((d) => <tr key={d.day}><td>{shortDay(d.day)}</td><td>{d.space}</td><td>{d.direct}</td><td>{d.activePeople}</td><td>{d.calls}</td><td>{d.callMinutes}</td></tr>)}</tbody>
              </table></div>
            ) : <DailyChart daily={r.daily} />}
          </section>
          <div className="usage-lists">
            <section className="card">
              <div className="eyebrow">Busiest Spaces</div>
              {r.topSpaces.length === 0 && <p className="faint">No Space messages in this period.</p>}
              {r.topSpaces.map((s) => (
                <div key={s.id} className="usage-row"><Icon name="grid" size={15} /><span>{s.name}</span><b>{s.messages.toLocaleString()}</b></div>
              ))}
            </section>
            <section className="card">
              <div className="eyebrow">Most messages sent</div>
              {r.topPeople.length === 0 && <p className="faint">No messages in this period.</p>}
              {r.topPeople.map((p) => {
                const u = byId.get(p.userId);
                return <div key={p.userId} className="usage-row"><Avatar user={u ?? { id: p.userId, displayName: '?' }} size="sm" /><span>{u?.displayName ?? 'Someone'}</span><b>{p.messages.toLocaleString()}</b></div>;
              })}
            </section>
          </div>
          <p className="faint" style={{ fontSize: 12 }}>Counts come from the hub: messages, calls and files. Nobody's message text is read to make this report.</p>
        </>
      )}
    </div>
  );
}

function EmojiAdmin() {
  const toast = useToast();
  const list = useCustomEmoji();
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = useRef<HTMLInputElement>(null);
  const add = async () => {
    if (!file) return;
    if (file.size > 256 * 1024) { toast('Emoji images can be up to 256 KB.', true); return; }
    setBusy(true);
    try {
      const info = await window.dex.uploadFile!(`emoji-${Date.now().toString(36)}`, { data: await file.arrayBuffer(), name: file.name, mime: file.type || undefined });
      await window.dex.request('admin.emoji.add', { name, fileId: info.id });
      toast(`:${name.toLowerCase()}: added`);
      setName(''); setFile(null);
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  return (
    <section className="card">
      <div className="eyebrow">Office emoji</div>
      <p className="muted" style={{ marginTop: 0 }}>Small square images people can use in messages as <span className="mono">:name:</span> and as reactions. PNG, GIF, WebP or JPEG, up to 256 KB.</p>
      {list.size > 0 && (
        <div className="emoji-admin-grid">
          {[...list.values()].map((e) => (
            <div key={e.name} className="emoji-admin-item">
              <EmojiImg name={e.name} size={28} />
              <span className="mono">:{e.name}:</span>
              <button className="icon-btn" title={`Remove :${e.name}:`} onClick={() => { if (confirm(`Remove :${e.name}:? Messages that use it show the name instead.`)) void window.dex.request('admin.emoji.remove', { name: e.name }).catch((err: Error) => toast(err.message, true)); }}><Icon name="x" size={14} /></button>
            </div>
          ))}
        </div>
      )}
      {window.dex.uploadFile && (
        <div className="org-admin-add" style={{ marginTop: 10 }}>
          <input className="input" placeholder="name, e.g. pipe-rack" maxLength={32} value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))} aria-label="Emoji name" />
          <button className="btn" onClick={() => pick.current?.click()}><Icon name="paperclip" size={14} />{file ? file.name : 'Choose image'}</button>
          <input ref={pick} type="file" hidden accept="image/png,image/gif,image/webp,image/jpeg" onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); if (f && !name) setName(f.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)); e.target.value = ''; }} />
          <button className="btn primary" disabled={busy || !file || name.length < 2} onClick={() => void add()}>{busy ? <span className="spinner" /> : <Icon name="plus" size={14} />}Add</button>
        </div>
      )}
    </section>
  );
}
