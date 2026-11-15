// Control room ▸ Backups & leavers: the hub's nightly backups (where, when, how many are kept,
// how the last ones went, "Back up now") and offboarding someone who leaves the office (what
// they look after, who takes over, people who left and giving access back).
// See docs/BACKUP.md and apps/hub/src/offboard.ts.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BackupRun, BackupStatus, Departure, MeetingHandover, OffboardPreview, PublicUser, Session } from '@dex/core';
import { Avatar, Icon, Segmented, relativeTime, useToast } from '../ui.tsx';
import { tr } from '../i18n/index.ts';
import './continuity.css';

/** Audit log wording for these actions (Control room ▸ Audit log). */
export const CONTINUITY_AUDIT: Record<string, string> = {
  'backup.settings': 'changed the backup settings',
  'backup.done': 'made a backup of the hub',
  'backup.failed': 'tried to back up the hub, and it did not work',
  'person.offboarded': 'offboarded someone who left the office',
  'person.reactivated': 'gave someone who had left access again',
  'handover.spaces': 'handed Spaces to a colleague',
  'handover.automations': 'handed automations to a colleague',
  'handover.integrations': 'handed integrations and tools to a colleague',
  'handover.scheduled': 'cancelled scheduled messages of someone who left',
  'handover.reminders': 'handed reminders to a colleague',
  'handover.meetings': 'handed meetings over or cancelled them',
  'handover.tickets': 'handed help tickets to a colleague',
  'handover.webinars': 'handed webinars to a colleague',
  'calfeed.on': 'turned on their calendar feed',
  'calfeed.off': 'turned off their calendar feed',
  'calfeed.reset': 'made a new calendar feed address',
};

type Part = 'backups' | 'leavers';

export function ContinuityAdmin({ session, live }: { session: Session; live: boolean }) {
  const [part, setPart] = useState<Part>('backups');
  return (
    <div className="org-admin continuity">
      <Segmented<Part> label="Backups or leavers" value={part} onChange={setPart} options={[
        { value: 'backups', label: 'Backups', icon: 'archive' },
        { value: 'leavers', label: 'Someone leaving', icon: 'user' },
      ]} />
      {part === 'backups' ? <BackupsAdmin live={live} /> : <LeaversAdmin session={session} live={live} />}
    </div>
  );
}

// ------------------------------------------------------------------ backups
export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '–';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function nextText(at: number | null, now = Date.now()): string {
  if (at === null) return 'No backup folder yet';
  if (at <= now + 60_000) return 'Starting now';
  const d = new Date(at);
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const today = new Date(now);
  const tomorrow = new Date(now + 86_400_000);
  if (d.toDateString() === today.toDateString()) return d.getHours() >= 18 || d.getHours() < 6 ? `Tonight at ${t}` : `Today at ${t}`;
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow at ${t}`;
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} at ${t}`;
}

const KEPT_LABEL: Record<string, string> = { latest: 'Latest', daily: 'Day', weekly: 'Week', monthly: 'Month' };

/** Each part is a whole phrase, so it translates as one; the screen draws them with " · " between. */
function checkLine(r: BackupRun): string[] {
  const c = r.check;
  if (!c) return [];
  const msgs = c.rows.messages;
  const parts = [
    c.integrity === 'ok' ? 'Checked: database sound' : `Checked: database ${c.integrity}`,
    ...(msgs !== undefined ? [msgs === 1 ? '1 message' : `${msgs.toLocaleString()} messages`] : []),
    c.files ? `${c.hashed} of ${c.files.toLocaleString()} files compared with their fingerprints` : 'no shared files yet',
    ...(c.missing ? [`${c.missing} removed while it ran`] : []),
  ];
  return parts.flatMap((x, i) => (i ? [' · ', x] : [x]));
}

function BackupsAdmin({ live }: { live: boolean }) {
  const toast = useToast();
  const [s, setS] = useState<BackupStatus | null>(null);
  const [folder, setFolder] = useState('');
  const [time, setTime] = useState('02:00');
  const [keep, setKeep] = useState({ keepDaily: 14, keepWeekly: 8, keepMonthly: 12 });
  const [saving, setSaving] = useState(false);
  const adopt = useCallback((x: BackupStatus, fresh = false) => {
    setS(x);
    if (fresh) { setFolder(x.config.folder ?? ''); setTime(x.config.time); setKeep({ keepDaily: x.config.keepDaily, keepWeekly: x.config.keepWeekly, keepMonthly: x.config.keepMonthly }); }
  }, []);
  useEffect(() => {
    if (!live) return;
    void window.dex.request('admin.backup.get').then((x) => adopt(x, true)).catch((e: Error) => toast(e.message, true));
    return window.dex.onHubEvent((n, d) => { if (n === 'admin.backup') adopt(d as BackupStatus); });
  }, [live, adopt, toast]);
  const save = async (patch: Partial<BackupStatus['config']>, ok: string) => {
    setSaving(true);
    try { adopt(await window.dex.request('admin.backup.set', patch), true); toast(ok); } catch (e) { toast((e as Error).message, true); } finally { setSaving(false); }
  };
  const runNow = async () => {
    try { adopt(await window.dex.request('admin.backup.run')); } catch (e) { toast((e as Error).message, true); }
  };
  if (!s) return <div className="tl-more"><span className="spinner" /></div>;

  const last = s.lastRun;
  const failed = !!last && !last.ok && !s.running;
  const state = s.running ? 'run' : s.warning || failed ? 'warn' : s.lastSuccess ? 'ok' : 'off';
  const dirtyKeep = keep.keepDaily !== s.config.keepDaily || keep.keepWeekly !== s.config.keepWeekly || keep.keepMonthly !== s.config.keepMonthly;
  return (
    <>
      <section className={`card bk-sheet ${state}`} aria-label="Backup status">
        <div className="bk-head">
          <div>
            <div className="eyebrow">Hub backup</div>
            <div className="bk-state" role="status">
              {s.running ? <><span className="spinner" />Backing up · {s.running.step}</>
                : failed ? <><Icon name="warning" size={18} />The last backup did not work</>
                  : s.lastSuccess ? <><Icon name="check" size={18} />Backed up {relativeTime(s.lastSuccess.finishedAt)}</>
                    : s.config.folder ? <>No backup yet</> : <>Backups are off</>}
            </div>
          </div>
          <button className="btn primary" disabled={!live || !s.config.folder || !!s.running} onClick={() => void runNow()}>
            <Icon name="archive" size={16} />Back up now
          </button>
        </div>
        {failed && last?.error && <p className="bk-problem"><Icon name="warning" size={14} /><span>{last.error}</span></p>}
        {s.warning && !failed && <p className="bk-problem"><Icon name="warning" size={14} /><span>{s.warning}</span></p>}
        <div className="bk-block" role="list">
          <div className="bk-cell" role="listitem"><span className="label">Last good backup</span><span className="v">{s.lastSuccess ? new Date(s.lastSuccess.finishedAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–'}</span></div>
          <div className="bk-cell" role="listitem"><span className="label">Size</span><span className="v">{s.lastSuccess ? bytes(s.lastSuccess.dbBytes + s.lastSuccess.filesBytes) : '–'}</span>
            {s.lastSuccess && <span className="sub mono">{s.lastSuccess.filesAdded ? `+${bytes(s.lastSuccess.bytesAdded)} in new files` : 'no new files'}</span>}</div>
          <div className="bk-cell" role="listitem"><span className="label">Next backup</span><span className="v">{s.running ? 'Running now' : nextText(s.nextRunAt)}</span></div>
          <div className="bk-cell" role="listitem"><span className="label">Backup folder holds</span><span className="v">{bytes(s.folderBytes)}</span>{s.config.folder && <span className="sub mono">{s.copies.length === 1 ? '1 copy' : `${s.copies.length} copies`}</span>}</div>
        </div>
        {s.lastSuccess?.check && <div className="bk-check mono">{checkLine(s.lastSuccess)}</div>}
      </section>

      <section className="card">
        <div className="eyebrow">Where and when</div>
        <label htmlFor="bk-folder" className="field-label">Backup folder</label>
        <div className="gw-url-row">
          <input id="bk-folder" className="input mono" value={folder} placeholder="E:\DexConnectBackup  or  \\NAS\backups\dexconnect" onChange={(e) => setFolder(e.target.value)} disabled={!live} />
          <button className="btn" disabled={!live || saving || folder.trim() === (s.config.folder ?? '')} onClick={() => void save({ folder: folder.trim() || null }, folder.trim() ? 'Backup folder saved' : 'Backups turned off')}>
            {folder.trim() || !s.config.folder ? 'Save folder' : 'Turn off backups'}
          </button>
        </div>
        <p className="faint bk-hint">A second disk or a network share, not the hub's own disk. The hub checks it can write there when you save. Only new files are copied each night, so after the first backup runs are quick.</p>
        <div className="setting bk-time">
          <Icon name="clock" className="lead" />
          <div className="txt"><div>Every night at</div><div className="faint">The hub PC's time. If the hub was off then, it backs up as soon as it is on again.</div></div>
          <input type="time" className="input" aria-label="Backup time" value={time} disabled={!live} onChange={(e) => { setTime(e.target.value); if (e.target.value && e.target.value !== s.config.time) void save({ time: e.target.value }, `Backups run at ${e.target.value}`); }} />
        </div>
        <div className="bk-keep">
          <span className="label">Keep</span>
          {/* one phrase per row, with the number box where the translation puts {0} */}
          {([['keepDaily', 'daily copies', 'one a day for {0} days'], ['keepWeekly', 'weekly copies', 'one a week for {0} weeks'], ['keepMonthly', 'monthly copies', 'one a month for {0} months']] as const).map(([k, label, phrase]) => {
            const [before, after = ''] = tr(phrase).split('{0}').map((x) => x.trim());
            return (
            <label key={k} className="bk-keep-field">
              {before && <span>{before}</span>}
              <input type="number" className="input" min={k === 'keepDaily' ? 1 : 0} max={k === 'keepDaily' ? 366 : k === 'keepWeekly' ? 260 : 240} value={keep[k]} aria-label={`How many ${label} to keep`}
                onChange={(e) => setKeep({ ...keep, [k]: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} disabled={!live} />
              {after && <span>{after}</span>}
            </label>
            );
          })}
          <button className="btn sm" disabled={!live || saving || !dirtyKeep} onClick={() => void save(keep, 'Saved what is kept')}>Save</button>
        </div>
      </section>

      {s.copies.length > 0 && (
        <section className="card">
          <div className="eyebrow">Copies in the backup folder</div>
          <div className="bk-copies">
            {s.copies.map((c) => (
              <div key={c.name} className="bk-copy">
                <span className="mono">{c.name}</span>
                <span className="faint">{new Date(c.at).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                <span className="faint mono">{bytes(c.dbBytes)} database</span>
                <span className="bk-kept">{c.kept.map((k) => <span key={k} className={`chip${k === 'latest' ? ' accent' : ''}`}>{KEPT_LABEL[k]}</span>)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {s.history.length > 0 && (
        <section className="card">
          <div className="eyebrow">Recent runs</div>
          <div className="bk-runs">
            {s.history.slice(0, 10).map((r) => (
              <div key={r.startedAt} className={`bk-run ${r.ok ? 'ok' : 'bad'}`}>
                <span className="bk-tick" aria-hidden />
                <div className="txt">
                  <div>{new Date(r.startedAt).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    <span className="faint"> · {r.manual ? 'Back up now' : 'nightly'} · {Math.max(1, Math.round((r.finishedAt - r.startedAt) / 1000))} s</span></div>
                  <div className="faint">{r.ok ? <>
                    {r.filesAdded === 1 ? `1 new file (${bytes(r.bytesAdded)})` : `${r.filesAdded.toLocaleString()} new files (${bytes(r.bytesAdded)})`}
                    {r.removed ? (r.removed === 1 ? ' · 1 older copy removed' : ` · ${r.removed} older copies removed`) : ''}
                  </> : r.error}</div>
                  {r.ok && r.check && <div className="faint mono">{checkLine(r)}</div>}
                </div>
                <span className={`chip ${r.ok ? 'ok' : 'warn'}`}>{r.ok ? 'Worked' : 'Did not work'}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card">
        <div className="eyebrow">Putting a backup back</div>
        <ol className="bk-steps">
          <li>On the hub PC, stop the service: <span className="mono">Services ▸ Dexterity Connect Hub ▸ Stop</span>.</li>
          <li>Open a Command Prompt as administrator in the hub's folder and run <span className="mono selectable">DexterityConnectHub.exe --restore "{s.config.folder ?? 'E:\\DexConnectBackup'}"</span>, or drop the backup folder on <span className="mono">Restore-Hub.cmd</span>.</li>
          <li>Start the service again. The data that was there before is kept beside <span className="mono">hub-data</span>, never deleted.</li>
        </ol>
        <p className="faint bk-hint">The restore refuses to run while the hub is running. README-HUB.txt has the same steps, and what to do on a new PC.</p>
      </section>
    </>
  );
}

// ------------------------------------------------------------------ someone leaving
const isAdmin = (u: PublicUser) => u.role === 'owner' || u.role === 'admin';

function LeaversAdmin({ session, live }: { session: Session; live: boolean }) {
  const toast = useToast();
  const people = useMemo(() => session.users.filter((u) => u.role !== 'bot').sort((a, b) => a.displayName.localeCompare(b.displayName)), [session.users]);
  const byId = useMemo(() => new Map(session.users.map((u) => [u.id, u] as const)), [session.users]);
  const [leaver, setLeaver] = useState('');
  const [preview, setPreview] = useState<OffboardPreview | null>(null);
  const [to, setTo] = useState('');
  const [meetings, setMeetings] = useState<MeetingHandover>('reassign');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Departure | null>(null);
  const [left, setLeft] = useState<Departure[]>([]);
  const loadLeft = useCallback(() => { void window.dex.request('admin.offboard.list').then(setLeft).catch(() => {}); }, []);
  useEffect(() => {
    if (!live) return;
    loadLeft();
    return window.dex.onHubEvent((n) => { if (n === 'admin.offboarded' || n === 'user.added') loadLeft(); });
  }, [live, loadLeft]);
  useEffect(() => {
    setPreview(null);
    if (!leaver) return;
    setDone(null);
    void window.dex.request('admin.offboard.preview', { userId: leaver }).then(setPreview).catch((e: Error) => { toast(e.message, true); setLeaver(''); });
  }, [leaver, toast]);
  const candidates = people.filter((u) => u.id !== session.me.id && u.role !== 'owner' && (session.me.role === 'owner' || u.role !== 'admin'));
  const takers = people.filter((u) => u.id !== leaver && u.role !== 'guest');
  const name = (id: string) => byId.get(id)?.displayName ?? left.find((d) => d.user.id === id)?.user.displayName ?? 'Former member';

  const run = async () => {
    if (!preview || !to) return;
    const taker = byId.get(to)?.displayName ?? 'the colleague';
    if (!confirm(`Offboard ${preview.user.displayName}? They are signed out on every device at once, and what they look after goes to ${taker}. Their messages stay.`)) return;
    setBusy(true);
    try {
      const d = await window.dex.request('admin.offboard.run', { userId: preview.user.id, toUserId: to, meetings, note: note.trim() || undefined });
      setDone(d); setPreview(null); setLeaver(''); setTo(''); setNote('');
      toast(`${d.user.displayName} is offboarded`);
      loadLeft();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const giveBack = async (d: Departure) => {
    if (!confirm(`Give ${d.user.displayName} access again? Their devices can sign in again. What was handed to ${name(d.toId)} stays with them.`)) return;
    try {
      const r = await window.dex.request('admin.offboard.reactivate', { userId: d.user.id });
      toast(r.devices === 1 ? `${r.user.displayName} can sign in again on 1 device` : r.devices ? `${r.user.displayName} can sign in again on ${r.devices} devices` : `${r.user.displayName} can join again from their PC; approve it in Approvals`);
      loadLeft();
    } catch (e) { toast((e as Error).message, true); }
  };

  const p = preview;
  const groups: Array<{ label: string; items: string[]; note?: string }> = p ? [
    { label: 'Signed out', items: [...p.devices.map((d) => `${d.hostname}${d.lastSeen ? ` · seen ${relativeTime(d.lastSeen)}` : ''}`), ...(p.pairingCodes ? [p.pairingCodes === 1 ? '1 unused pairing code' : `${p.pairingCodes} unused pairing codes`] : [])], note: 'Every device is removed at once, with their calendar feed.' },
    { label: 'Spaces', items: [...p.spacesOwned.map((x) => `${x.name} · created by them`), ...p.spacesModerated.map((x) => `${x.name} · moderator`)] },
    { label: 'Automations', items: p.automations.map((f) => `${f.name} · ${f.where === 'direct' ? 'personal, turned off' : f.where === 'office' ? 'office-wide' : 'in a Space'}`) },
    { label: 'Integrations and tools', items: [...p.bots.map((b) => `${b.name} · integration`), ...p.tools.map((t) => `${t.name} · tool`)] },
    { label: 'Meetings from now on', items: p.meetings.map((m) => `${m.title} · ${m.repeats ? 'repeats' : new Date(m.startAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}`) },
    { label: 'Help tickets', items: p.tickets.map((t) => `#${t.number} ${t.summary} · ${t.role === 'technician' ? 'working on it' : 'asked for it, closed'}`) },
    { label: 'Webinars', items: p.webinars.map((w) => `${w.title} · ${w.role}`) },
    { label: 'Desk', items: [
      ...(p.remindersForOthers ? [p.remindersForOthers === 1 ? '1 reminder set for others' : `${p.remindersForOthers} reminders set for others`] : []),
      ...(p.remindersFromOthers ? [p.remindersFromOthers === 1 ? '1 reminder others set for them' : `${p.remindersFromOthers} reminders others set for them`] : []),
      ...(p.scheduled ? [p.scheduled === 1 ? '1 scheduled message, cancelled' : `${p.scheduled} scheduled messages, cancelled`] : []),
    ] },
  ] : [];

  return (
    <>
      <section className="card">
        <div className="eyebrow">Offboard someone who is leaving</div>
        <div className="ob-steps">
          <div className="ob-step">
            <span className="ob-num mono">1</span>
            <div className="ob-body">
              <label htmlFor="ob-who" className="field-label">Who is leaving</label>
              <select id="ob-who" className="input" value={leaver} disabled={!live || busy} onChange={(e) => setLeaver(e.target.value)}>
                <option value="">Choose a person…</option>
                {candidates.map((u) => <option key={u.id} value={u.id}>{u.displayName} · {u.account}</option>)}
              </select>
            </div>
          </div>
          {p && (
            <div className="ob-step">
              <span className="ob-num mono">2</span>
              <div className="ob-body">
                <div className="field-label">{`What ${p.user.displayName} looks after`}</div>
                <div className="ob-groups">
                  {groups.filter((g) => g.items.length).map((g) => (
                    <div key={g.label} className="ob-group">
                      <span className="label">{g.label} · {g.items.length}</span>
                      <ul>{g.items.slice(0, 8).map((x, i) => <li key={i}>{x}</li>)}{g.items.length > 8 && <li className="faint">and {g.items.length - 8} more</li>}</ul>
                      {g.note && <span className="faint">{g.note}</span>}
                    </div>
                  ))}
                  {groups.slice(1).every((g) => !g.items.length) && <p className="faint" style={{ margin: 0 }}>Nothing to hand over: no Spaces, automations, meetings or tickets of theirs.</p>}
                </div>
                <p className="ob-kept"><Icon name="lock" size={14} /><span>{p.messages === 1
                  ? p.onHold ? "1 message they wrote stays where it is, under the office's retention rules and the legal hold on it." : "1 message they wrote stays where it is, under the office's retention rules."
                  : p.onHold ? `${p.messages.toLocaleString()} messages they wrote stay where they are, under the office's retention rules and the legal hold on them.` : `${p.messages.toLocaleString()} messages they wrote stay where they are, under the office's retention rules.`}</span></p>
              </div>
            </div>
          )}
          {p && (
            <div className="ob-step">
              <span className="ob-num mono">3</span>
              <div className="ob-body">
                <label htmlFor="ob-to" className="field-label">Who takes over</label>
                <select id="ob-to" className="input" value={to} disabled={!live || busy} onChange={(e) => setTo(e.target.value)}>
                  <option value="">Choose a colleague…</option>
                  {takers.map((u) => <option key={u.id} value={u.id}>{u.displayName}{u.title ? ` · ${u.title}` : ''}</option>)}
                </select>
                {p.meetings.length > 0 && (
                  <div className="ob-meetings">
                    <span className="field-label">Their meetings from now on</span>
                    <Segmented<MeetingHandover> label="Their meetings" value={meetings} onChange={setMeetings} options={[
                      { value: 'reassign', label: 'Move to the colleague' },
                      { value: 'cancel', label: 'Cancel them' },
                    ]} />
                    <span className="faint">Everyone invited gets a note from Dexterity Connect either way.</span>
                  </div>
                )}
                <label htmlFor="ob-note" className="field-label">Note for the colleague (optional)</label>
                <input id="ob-note" className="input" maxLength={300} value={note} placeholder="e.g. Moved to the Pune office; client contacts are in the P-12 Space" onChange={(e) => setNote(e.target.value)} disabled={!live || busy} />
                <div className="row-actions ob-go">
                  <button className="btn ghost" onClick={() => setLeaver('')} disabled={busy}>Cancel</button>
                  <button className="btn primary danger-fill" disabled={!live || busy || !to} onClick={() => void run()}>
                    <Icon name="power" size={16} />Offboard {p.user.displayName}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
        {done && (
          <div className="ob-done" role="status">
            <Icon name="check" size={16} />
            <span><b>{done.user.displayName}</b> is offboarded and signed out everywhere. {handed(done, name(done.toId))}</span>
          </div>
        )}
      </section>

      <section className="card">
        <div className="eyebrow">Left the office · {left.filter((d) => !d.returnedAt).length}</div>
        {left.length === 0 ? <p className="faint" style={{ margin: 0 }}>No one has been offboarded.</p> : (
          <div className="ob-left">
            {left.map((d) => (
              <div key={d.id} className={`ob-left-row${d.returnedAt ? ' back' : ''}`}>
                <Avatar user={d.user} size="sm" />
                <div className="txt">
                  <div><b>{d.user.displayName}</b> <span className="faint mono">{d.user.account}</span></div>
                  <div className="faint">Left {new Date(d.leftAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })} · {handed(d, name(d.toId))}{d.note ? ` · “${d.note}”` : ''}</div>
                  {d.returnedAt && <div className="faint">Access given again {relativeTime(d.returnedAt)}</div>}
                </div>
                {d.returnedAt ? <span className="chip ok">Back</span> : (
                  <button className="btn sm" disabled={!live || (isAdmin(d.user) && session.me.role !== 'owner')} onClick={() => void giveBack(d)}>Give access again</button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

/**
 * "Handed to Ravi: 2 Spaces, 1 meeting; 1 meeting cancelled." Each count is a whole phrase ("1 meeting",
 * "{0} meetings"), translated on its own before the list is put in the sentence.
 */
function handed(d: Departure, to: string): string {
  const s = d.summary;
  const count = (n: number, one: string, many: string) => (n === 1 ? one : n ? many.replace('{0}', String(n)) : '');
  const parts = [
    count(s.spaces + s.moderated, '1 Space', '{0} Spaces'),
    count(s.automations, '1 automation', '{0} automations'),
    count(s.bots + s.tools, '1 integration', '{0} integrations'),
    count(s.meetingsReassigned, '1 meeting', '{0} meetings'),
    count(s.tickets, '1 ticket', '{0} tickets'),
    count(s.webinars, '1 webinar', '{0} webinars'),
    count(s.reminders, '1 reminder', '{0} reminders'),
  ].filter(Boolean).map((x) => tr(x));
  const n = s.meetingsCancelled;
  if (!parts.length) return n === 1 ? '1 meeting cancelled.' : n ? `${n} meetings cancelled.` : 'Nothing to hand over.';
  const cancelled = n === 1 ? '1 meeting cancelled' : n ? `${n} meetings cancelled` : '';
  const list = cancelled ? `${parts.join(', ')}; ${tr(cancelled)}` : parts.join(', ');
  return `Handed to ${to}: ${list}.`;
}
