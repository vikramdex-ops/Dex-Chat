// Control room ▸ Policies (edit window, upload limit, PC-to-PC fallback, call recording) and
// ▸ Usage (activity per day, busiest Spaces and people, storage, calls).
import { useEffect, useMemo, useRef, useState } from 'react';
import { EmojiImg, StickerImg, useCustomEmoji, useStickers } from '../emoji.tsx';
import type { OfficeLine, OfficePolicy, PublicUser, ReportItem, UsageReport } from '@dex/core';
import { DLP_DETECTORS, validCidr } from '@dex/core/dlp';
import type { DlpDetector, DlpRule } from '@dex/core/dlp';
import { useChat } from '../chat/store.ts';
import { Avatar, Icon, Segmented, Toggle, relativeTime, useToast } from '../ui.tsx';
import { confirmAction } from '../confirm.tsx';
import { formatSize } from '../chat/files.tsx';
import { MeetingPolicies, MeetingTotals } from '../meet/MeetAdmin.tsx';
import './policies.css';
import { LinkPreviewSettings } from '../chat/linkcards.tsx';

const EDIT: Array<[number | null, string]> = [[null, 'Any time'], [5, '5 minutes'], [15, '15 minutes'], [60, '1 hour'], [1440, '1 day'], [10080, '7 days'], [43200, '30 days'], [525600, '1 year'], [1051200, '2 years']];
const UPLOAD: Array<[number, string]> = [[25, '25 MB'], [100, '100 MB'], [250, '250 MB'], [1024, '1 GB'], [2048, '2 GB'], [4096, '4 GB']];

export function PoliciesAdmin() {
  const toast = useToast();
  const [p, setP] = useState<OfficePolicy | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setTry] = useState(0);
  useEffect(() => { setProblem(null); void window.dex.request('policy.get').then(setP).catch((e: Error) => setProblem(e.message)); }, [attempt]);
  const save = (patch: Partial<OfficePolicy>) => void window.dex.request('admin.policy.set', patch).then((n) => { setP(n); toast('Policy saved'); }).catch((e: Error) => toast(e.message, true));
  if (!p) return problem ? <p className="load-problem" role="alert"><Icon name="warning" size={15} /><span><b>The policies could not be loaded</b> · {problem}</span><button className="btn ghost sm" onClick={() => setTry((n) => n + 1)}>Try again</button></p> : <div className="tl-more"><span className="spinner" /></div>;
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
      <LinkPreviewSettings />
      <section className="card">
        <div className="eyebrow">Direct messages</div>
        <div className="setting" style={{ marginTop: 6 }}>
          <div className="txt"><div>Require end-to-end encryption</div><div className="faint">Nothing is sent in a Direct conversation until everyone in it has an app that encrypts. People on an older version are asked to update; until then, the conversation shows why it is waiting. Conversations with an integration are not affected.</div></div>
          <Toggle label="Require end-to-end encryption for Direct messages" checked={p.requireE2E === true} onChange={(v) => save({ requireE2E: v })} />
        </div>
      </section>
      <section className="card">
        <div className="eyebrow">When the hub is off</div>
        <div className="setting" style={{ marginTop: 6 }}>
          <div className="txt"><div>Direct messages pass straight between PCs</div><div className="faint">Encrypted, signed and limited to the office network. Messages written then are posted to the hub when it is back.</div></div>
          <Toggle label="Direct messages pass straight between PCs" checked={p.peerFallback} onChange={(v) => save({ peerFallback: v })} />
        </div>
      </section>
      <OfficeLines />
      <DataProtection p={p} save={save} />
      <DefaultSpaces p={p} save={save} />
      <EmojiAdmin />
      <StickersAdmin />
      <section className="card">
        <div className="eyebrow">Who adds emoji and stickers</div>
        <div className="setting" style={{ marginTop: 6 }}>
          <div className="txt"><div>Everyone can add office emoji and stickers</div><div className="faint">From the emoji and sticker pickers. People can remove what they added; administrators can remove anything. Off: only administrators add them here.</div></div>
          <Toggle label="Everyone can add office emoji and stickers" checked={p.memberEmoji !== false} onChange={(v) => save({ memberEmoji: v })} />
        </div>
      </section>
      <section className="card">
        <div className="eyebrow">Rooms</div>
        <div className="setting" style={{ marginTop: 6 }}>
          <div className="txt"><div>People can record calls</div><div className="faint">Everyone in the call sees that it is being recorded. The recording is kept on the hub (up to the size set under Meetings), and the person who recorded it chooses who can watch it.</div></div>
          <Toggle label="People can record calls" checked={p.allowRecording} onChange={(v) => save({ allowRecording: v })} />
        </div>
        <div className="setting">
          <div className="txt"><div>Join meetings with the camera off and ask before turning it on</div><div className="faint">Everyone comes into Rooms and meetings with the camera off. Turning it on asks first, so no one appears on screen by surprise.</div></div>
          <Toggle label="Join meetings with the camera off and ask before turning it on" checked={p.cameraConsent === true} onChange={(v) => save({ cameraConsent: v })} />
        </div>
      </section>
      <MeetingPolicies p={p} save={save} />
      <section className="card" aria-label="Remote support">
        <div className="eyebrow">Remote support</div>
        <p className="faint" style={{ margin: '6px 0 0' }}>For people on the IT desk (Help desk). Everything here is off until you turn it on; every session is shown on the PC and kept on the ticket and in the Audit log.</p>
        <div className="setting" style={{ marginTop: 6 }}>
          <div className="txt"><div>IT can connect to any office PC without the person accepting</div><div className="faint">From the Help desk, IT staff press Connect now. The person's app shares the whole screen and gives control by itself, shows an amber frame and a banner saying IT connected without asking, and they can stop it at any time (Stop control, or Shift+Esc). Needs the app running and someone signed in to Windows.</div></div>
          <Toggle label="IT can connect to any office PC without the person accepting" checked={p.assistUnattended === true} onChange={(v) => save({ assistUnattended: v })} />
        </div>
        <div className="setting">
          <div className="txt"><div>Share the clipboard in support sessions</div><div className="faint">While IT has control, text copied on one PC can be pasted on the other, both ways.</div></div>
          <Toggle label="Share the clipboard in support sessions" checked={p.assistClipboard === true} onChange={(v) => save({ assistClipboard: v })} />
        </div>
        <div className="setting">
          <div className="txt"><div>Drop files and folders into support sessions</div><div className="faint">Files and whole folders dropped on the session are saved at the other end in Downloads\Dexterity IT\ the ticket's number, and kept on the ticket.</div></div>
          <Toggle label="Drop files and folders into support sessions" checked={p.assistFiles === true} onChange={(v) => save({ assistFiles: v })} />
        </div>
        <div className="setting">
          <div className="txt"><div>Support sessions reconnect by themselves</div><div className="faint">After a network drop or a restart of either PC, the session waits up to 10 minutes and both apps join it again. After a network drop, what the person was sharing is shared again; after a restart they choose again, unless the session is unattended. They see it and can stop it.</div></div>
          <Toggle label="Support sessions reconnect by themselves" checked={p.assistReconnect === true} onChange={(v) => save({ assistReconnect: v })} />
        </div>
      </section>
      <section className="card">
        <div className="eyebrow">Personal devices</div>
        <div className="setting" style={{ marginTop: 6 }}>
          <div className="txt"><div>People can add their own phones and laptops</div><div className="faint">From Preferences → Your devices, with a one-time code that lasts 24 hours. The new device joins as that person without approval. Off: every new device waits for an administrator.</div></div>
          <Toggle label="People can add their own phones and laptops" checked={p.personalDevices !== false} onChange={(v) => save({ personalDevices: v })} />
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
            <span className="faint">{h.activePeople === 1 ? '1 person' : `${h.activePeople} people`} · {h.calls === 1 ? '1 Room' : `${h.calls} Rooms`}{h.callMinutes ? ` · ${h.callMinutes} min` : ''}</span>
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
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setTry] = useState(0);
  useEffect(() => { setR(null); setProblem(null); void window.dex.request('admin.usage', { days }).then(setR).catch((e: Error) => setProblem(e.message)); }, [days, attempt]);
  const byId = useMemo(() => new Map(users.map((u) => [u.id, u] as const)), [users]);
  return (
    <div className="org-admin">
      <div className="toolbar" style={{ justifyContent: 'space-between' }}>
        <Segmented<'7' | '30' | '90'> label="Period" value={String(days) as '7' | '30' | '90'} onChange={(v) => setDays(Number(v) as 7 | 30 | 90)} options={[
          { value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' },
        ]} />
        <button className="btn ghost sm" onClick={() => setTable(!table)}><Icon name="list" size={14} />{table ? 'Show chart' : 'Show as table'}</button>
      </div>
      {!r ? (problem ? <p className="load-problem" role="alert"><Icon name="warning" size={15} /><span><b>Usage could not be loaded</b> · {problem}</span><button className="btn ghost sm" onClick={() => setTry((n) => n + 1)}>Try again</button></p> : <div className="tl-more"><span className="spinner" /></div>) : (
        <>
          <div className="usage-tiles">
            <div className="card tile"><span className="eyebrow">People active</span><b>{r.totals.activePeople}</b><span className="faint">of {r.totals.people} · {r.totals.activeDevices} devices seen</span></div>
            <div className="card tile"><span className="eyebrow">Messages</span><b>{r.totals.messages.toLocaleString()}</b><span className="faint">{Math.round(r.totals.messages / r.days).toLocaleString()} a day · {r.totals.spaces} Spaces</span></div>
            <div className="card tile"><span className="eyebrow">Rooms</span><b>{r.totals.calls}</b><span className="faint">{r.totals.callMinutes.toLocaleString()} minutes talked</span></div>
            <div className="card tile"><span className="eyebrow">Files stored</span><b>{formatSize(r.totals.fileBytes)}</b><span className="faint">{r.totals.files.toLocaleString()} files on the hub</span></div>
          </div>
          <section className="card">
            <div className="eyebrow">Messages per day</div>
            {table ? (
              <div className="usage-table" tabIndex={0} role="region" aria-label="The figures as a table"><table>
                <thead><tr><th>Day</th><th>Spaces</th><th>Direct</th><th>People</th><th>Rooms</th><th>Room minutes</th></tr></thead>
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
          <MeetingTotals />
          <p className="faint" style={{ fontSize: 12 }}>Counts come from the hub: messages, calls, meetings and files. Nobody's message text is read to make this report.</p>
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
              <button className="icon-btn" title={`Remove :${e.name}:`} onClick={() => void confirmAction({ title: `Remove :${e.name}:?`, body: 'Messages that use it show the name instead.', confirm: 'Remove emoji', danger: true }).then((ok) => { if (ok) void window.dex.request('admin.emoji.remove', { name: e.name }).catch((err: Error) => toast(err.message, true)); })}><Icon name="x" size={14} /></button>
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

function StickersAdmin() {
  const toast = useToast();
  const list = useStickers();
  const [name, setName] = useState('');
  const [pack, setPack] = useState('Office');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = useRef<HTMLInputElement>(null);
  const add = async () => {
    if (!file) return;
    if (file.size > 512 * 1024) { toast('Stickers can be up to 512 KB.', true); return; }
    setBusy(true);
    try {
      const info = await window.dex.uploadFile!(`sticker-${Date.now().toString(36)}`, { data: await file.arrayBuffer(), name: file.name, mime: file.type || undefined });
      await window.dex.request('sticker.add', { name: name.trim(), pack: pack.trim() || 'Office', fileId: info.id });
      toast(`${name.trim()} added to ${pack.trim() || 'Office'}`);
      setName(''); setFile(null);
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const packs = [...new Set(list.map((x) => x.pack))];
  return (
    <section className="card">
      <div className="eyebrow">Stickers</div>
      <p className="muted" style={{ marginTop: 0 }}>Larger pictures sent on their own, grouped in packs (the office's mascot, site safety, festivals). PNG, GIF or WebP with a transparent background, up to 512 KB.</p>
      {packs.map((pk) => (
        <div key={pk} className="sticker-pack">
          <div className="label">{pk}</div>
          <div className="sticker-admin-grid">
            {list.filter((x) => x.pack === pk).map((x) => (
              <div key={x.id} className="sticker-admin-item">
                <StickerImg id={x.id} size={64} />
                <span>{x.name}</span>
                <button className="icon-btn" title={`Remove ${x.name}`} onClick={() => void window.dex.request('sticker.remove', { id: x.id }).catch((err: Error) => toast(err.message, true))}><Icon name="x" size={14} /></button>
              </div>
            ))}
          </div>
        </div>
      ))}
      {window.dex.uploadFile && (
        <div className="org-admin-add" style={{ marginTop: 10 }}>
          <input className="input" placeholder="Sticker name" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} aria-label="Sticker name" />
          <input className="input" placeholder="Pack" maxLength={40} value={pack} onChange={(e) => setPack(e.target.value)} aria-label="Sticker pack" list="sticker-packs" />
          <datalist id="sticker-packs">{packs.map((pk) => <option key={pk} value={pk} />)}</datalist>
          <button className="btn" onClick={() => pick.current?.click()}><Icon name="paperclip" size={14} />{file ? file.name : 'Choose image'}</button>
          <input ref={pick} type="file" hidden accept="image/png,image/gif,image/webp" onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); if (f && !name) setName(f.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').slice(0, 40)); e.target.value = ''; }} />
          <button className="btn primary" disabled={busy || !file || !name.trim()} onClick={() => void add()}>{busy ? <span className="spinner" /> : <Icon name="plus" size={14} />}Add</button>
        </div>
      )}
    </section>
  );
}

/** Spaces every newly approved person joins. */
function DefaultSpaces({ p, save }: { p: OfficePolicy; save: (patch: Partial<OfficePolicy>) => void }) {
  const conversations = useChat((s) => s.conversations);
  const spaces = [...conversations.values()].filter((c) => c.kind === 'space' && !c.everyone && !c.archived).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  const chosen = new Set(p.defaultSpaces ?? []);
  return (
    <section className="card">
      <div className="eyebrow">New people join</div>
      <p className="muted" style={{ marginTop: 0 }}>Besides the Office space, everyone approved from now on joins these Spaces. Guests never do.</p>
      {spaces.length === 0 ? <p className="faint">Create a Space first (for example Induction or Announcements).</p> : (
        <div className="default-spaces">
          {spaces.map((c) => (
            <label key={c.id} className="check-line">
              <input type="checkbox" checked={chosen.has(c.id)} onChange={(e) => { const next = new Set(chosen); if (e.target.checked) next.add(c.id); else next.delete(c.id); save({ defaultSpaces: [...next] }); }} />
              {c.name}{c.private ? ' (private)' : ''}
            </label>
          ))}
        </div>
      )}
    </section>
  );
}

/** Control room ▸ Reports: messages people reported, to remove or dismiss. */
export function ReportsAdmin({ users, onOpen }: { users: PublicUser[]; onOpen: (convId: string, messageId: string) => void }) {
  const toast = useToast();
  const [all, setAll] = useState(false);
  const [list, setList] = useState<ReportItem[] | null>(null);
  const byId = useMemo(() => new Map(users.map((u) => [u.id, u] as const)), [users]);
  const load = () => void window.dex.request('admin.reports.list', { status: all ? 'all' : 'open' }).then(setList).catch(() => setList([]));
  useEffect(() => { load(); return window.dex.onHubEvent((n) => { if (n === 'admin.reports') load(); }); }, [all]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = (r: ReportItem, action: 'remove' | 'dismiss') => void window.dex.request('admin.reports.resolve', { id: r.id, action }).then(() => { toast(action === 'remove' ? 'Message removed' : 'Report dismissed'); load(); }).catch((e: Error) => toast(e.message, true));
  const name = (id: string | null) => (id ? byId.get(id)?.displayName ?? 'Someone' : '');
  return (
    <div className="org-admin">
      <div className="toolbar"><Segmented<'open' | 'all'> label="Show" value={all ? 'all' : 'open'} onChange={(v) => setAll(v === 'all')} options={[{ value: 'open', label: 'Waiting' }, { value: 'all', label: 'All' }]} /></div>
      {list === null && <div className="tl-more"><span className="spinner" /></div>}
      {list?.length === 0 && <div className="empty"><Icon name="check" size={32} /><span>{all ? 'No reports yet.' : 'Nothing waiting.'}</span></div>}
      {list?.map((r) => (
        <section key={r.id} className="card report">
          <div className="report-head">
            <span className={`chip ${r.status === 'open' ? 'warn' : ''}`}>{r.status === 'open' ? 'Waiting' : r.status === 'removed' ? 'Removed' : 'Dismissed'}</span>
            <b>{r.reason}</b>
            <span className="faint">reported by {name(r.reporterId)} · {relativeTimeOf(r.createdAt)}</span>
          </div>
          <div className="report-msg"><span className="faint">{name(r.authorId)} in {r.convName}{r.quoted ? ' (quoted by the reporter; the hub cannot read Direct messages)' : ''}</span><div>{r.text || <span className="faint">No text</span>}</div></div>
          {r.status === 'open' ? (
            <div className="row-actions">
              <button className="btn ghost sm" onClick={() => onOpen(r.convId, r.messageId)}>Open</button>
              <button className="btn ghost sm" onClick={() => act(r, 'dismiss')}>Dismiss</button>
              <button className="btn danger sm" onClick={() => act(r, 'remove')}>Remove the message</button>
            </div>
          ) : <div className="faint" style={{ fontSize: 12 }}>{r.status === 'removed' ? 'Removed' : 'Dismissed'} by {name(r.resolvedBy)}</div>}
        </section>
      ))}
    </div>
  );
}
const relativeTimeOf = (t: number) => relativeTime(t);

/** Control room ▸ Policies ▸ The day's line: the office's own lines, any day or on a date. */
function OfficeLines() {
  const toast = useToast();
  const [list, setList] = useState<OfficeLine[]>([]);
  const [text, setText] = useState('');
  const [by, setBy] = useState('');
  const [date, setDate] = useState('');
  useEffect(() => { void window.dex.request('lines.office').then(setList).catch(() => {}); }, []);
  const add = () => void window.dex.request('admin.lines.add', { text, by: by || null, date: date || null })
    .then((l) => { setList(l); setText(''); setBy(''); setDate(''); toast(date ? `Set for ${new Date(`${date}T00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' })}` : 'Added to the office lines'); })
    .catch((e: Error) => toast(e.message, true));
  return (
    <section className="card">
      <div className="eyebrow">The day's line</div>
      <p className="muted" style={{ marginTop: 0 }}>Pulse shows one line a day to everyone. Add the office's own: a line on a date (a launch, a festival, a milestone) is shown that day; the others come round every third day between the built-in ones.</p>
      {list.length > 0 && (
        <div className="dlp-rules" style={{ marginBottom: 10 }}>
          {list.map((l) => (
            <div key={l.id} className="dlp-rule">
              <span className="dlp-act mask">{l.date ? new Date(`${l.date}T00:00`).toLocaleDateString([], { day: '2-digit', month: 'short' }).toUpperCase() : 'ANY DAY'}</span>
              <span className="txt"><b>{l.text}</b><span className="faint">{l.by ?? 'Dexterity Design Services'}</span></span>
              <button className="icon-btn" title="Remove this line" aria-label="Remove this line" onClick={() => void window.dex.request('admin.lines.remove', { id: l.id }).then(setList).catch((e: Error) => toast(e.message, true))}><Icon name="trash" size={15} /></button>
            </div>
          ))}
        </div>
      )}
      <div className="field"><label htmlFor="ol-text">A line</label>
        <textarea id="ol-text" className="input" rows={2} maxLength={280} value={text} onChange={(e) => setText(e.target.value)} placeholder="Twenty years of drawings, one sheet at a time." /></div>
      <div className="form-row" style={{ alignItems: 'end' }}>
        <div className="field"><label htmlFor="ol-by">By (optional)</label><input id="ol-by" className="input" maxLength={80} value={by} onChange={(e) => setBy(e.target.value)} placeholder="Dexterity Design Services" /></div>
        <div className="field"><label htmlFor="ol-date">On (optional)</label><input id="ol-date" className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <button className="btn primary" disabled={text.trim().length < 3} onClick={add}><Icon name="plus" size={14} />Add line</button>
      </div>
    </section>
  );
}

/** Control room ▸ Policies ▸ Data protection: sensitive numbers and words, file types, outside networks. */
function DataProtection({ p, save }: { p: OfficePolicy; save: (patch: Partial<OfficePolicy>) => void }) {
  const rules = p.dlp ?? [];
  const [adding, setAdding] = useState<{ detector: DlpDetector; words: string; name: string; action: DlpRule['action']; scope: DlpRule['scope'] } | null>(null);
  const [types, setTypes] = useState((p.blockedFileTypes ?? []).join(', '));
  const [nets, setNets] = useState((p.outsideNetworks ?? []).join('\n'));
  useEffect(() => { setTypes((p.blockedFileTypes ?? []).join(', ')); setNets((p.outsideNetworks ?? []).join('\n')); }, [p.blockedFileTypes, p.outsideNetworks]);
  const badNet = nets.split(/\n/).map((x) => x.trim()).filter(Boolean).find((x) => !validCidr(x));
  const describe = (r: DlpRule) => `${r.action === 'block' ? 'Stopped' : 'Masked as ••••'} · ${r.scope === 'with-guests' ? 'where guests can see' : 'everywhere'}`;
  return (
    <section className="card">
      <div className="eyebrow">Data protection</div>
      <p className="faint" style={{ fontSize: 12.5, margin: '4px 0 10px' }}>Checked on the hub for everything it can read, and on the sender's own device before an encrypted Direct message is sealed.</p>
      <div className="dlp-rules">
        {rules.length === 0 && <div className="faint" style={{ fontSize: 13 }}>No rules yet: any text can be sent.</div>}
        {rules.map((r) => (
          <div key={r.id} className="dlp-rule">
            <span className={`dlp-act ${r.action}`}>{r.action === 'block' ? 'STOP' : 'MASK'}</span>
            <span className="txt"><b>{r.name}</b><span className="faint">{describe(r)}{r.detector === 'words' && r.words ? (() => { const n = r.words.split(/[,\n]/).filter((w) => w.trim()).length; return n === 1 ? ' · 1 word or phrase' : ` · ${n} words and phrases`; })() : ''}</span></span>
            <button className="icon-btn" title={`Remove ${r.name}`} aria-label={`Remove ${r.name}`} onClick={() => save({ dlp: rules.filter((x) => x.id !== r.id) })}><Icon name="trash" size={15} /></button>
          </div>
        ))}
      </div>
      {adding ? (
        <form className="dlp-form" onSubmit={(e) => { e.preventDefault(); save({ dlp: [...rules, { id: Math.random().toString(36).slice(2, 10), ...adding, name: adding.name.trim() || DLP_DETECTORS[adding.detector] }] }); setAdding(null); }}>
          <div className="form-row">
            <div className="field"><label htmlFor="dlp-what">Look for</label>
              <select id="dlp-what" className="input" value={adding.detector} onChange={(e) => setAdding({ ...adding, detector: e.target.value as DlpDetector })}>
                {(Object.keys(DLP_DETECTORS) as DlpDetector[]).map((k) => <option key={k} value={k}>{DLP_DETECTORS[k]}</option>)}
              </select></div>
            <div className="field"><label htmlFor="dlp-name">Name people see</label>
              <input id="dlp-name" className="input" placeholder={DLP_DETECTORS[adding.detector]} value={adding.name} maxLength={60} onChange={(e) => setAdding({ ...adding, name: e.target.value })} /></div>
          </div>
          {adding.detector === 'words' && (
            <div className="field"><label htmlFor="dlp-words">Words and phrases (comma or one per line)</label>
              <textarea id="dlp-words" className="input" rows={3} value={adding.words} onChange={(e) => setAdding({ ...adding, words: e.target.value })} placeholder="Project Falcon, tender price" /></div>
          )}
          <div className="form-row">
            <div className="field"><label>When found</label>
              <Segmented label="When found" value={adding.action} onChange={(v) => setAdding({ ...adding, action: v as DlpRule['action'] })} options={[{ value: 'block', label: 'Stop the message' }, { value: 'mask', label: 'Mask it as ••••' }]} /></div>
            <div className="field"><label>Where</label>
              <Segmented label="Where" value={adding.scope} onChange={(v) => setAdding({ ...adding, scope: v as DlpRule['scope'] })} options={[{ value: 'everywhere', label: 'Everywhere' }, { value: 'with-guests', label: 'Where guests can see' }]} /></div>
          </div>
          <div className="dialog-actions">
            <button type="button" className="btn ghost" onClick={() => setAdding(null)}>Cancel</button>
            <button className="btn primary" disabled={adding.detector === 'words' && !adding.words.trim()}>Add rule</button>
          </div>
        </form>
      ) : (
        <div><button className="btn" onClick={() => setAdding({ detector: 'card', words: '', name: '', action: 'mask', scope: 'everywhere' })}><Icon name="plus" size={15} />Add a rule</button></div>
      )}
      <div className="form-row" style={{ marginTop: 16, alignItems: 'start' }}>
        <div className="field"><label htmlFor="p-types">File types that can't be shared</label>
          <input id="p-types" className="input mono" placeholder="exe, bat, ps1" value={types} onChange={(e) => setTypes(e.target.value)}
            onBlur={() => { const list = types.split(/[\s,]+/).filter(Boolean); if (list.join(',') !== (p.blockedFileTypes ?? []).join(',')) save({ blockedFileTypes: list }); }} /></div>
        <div className="field"><label htmlFor="p-nets">Outside the office, only from these networks</label>
          <textarea id="p-nets" className="input mono" rows={3} placeholder={'Any network\n(one per line, e.g. 203.0.113.0/24)'} value={nets} onChange={(e) => setNets(e.target.value)} />
          <span className={badNet ? 'error-text' : 'faint'} style={{ fontSize: 12 }}>{badNet ? `"${badNet}" is not an address or network.` : 'Leave empty for any network. Devices on other networks are signed out at once.'}</span>
          <div><button className="btn sm" disabled={!!badNet || nets.split(/\n/).map((x) => x.trim()).filter(Boolean).join('|') === (p.outsideNetworks ?? []).join('|')}
            onClick={() => save({ outsideNetworks: nets.split(/\n/).map((x) => x.trim()).filter(Boolean) })}>Save networks</button></div>
        </div>
      </div>
    </section>
  );
}
