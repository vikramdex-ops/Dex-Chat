// Message add-ons: poll cards, forwarded credit, and the dialogs for reminders, forwarding,
// new polls and scheduled sends.
import { useMemo, useState } from 'react';
import type { Conversation, Message, PublicUser, RepeatRule } from '@dex/core';
import { Dialog, Icon, ToggleRow, colorFor, useToast } from '../ui.tsx';
import { REPEAT_LABEL, describeWhen, toLocalInput, whenPresets } from '../desk/store.ts';
import { plainPreview, renderBody } from './format.tsx';
import { holdUnread, useChat } from './store.ts';
import { ConvTile, convTitle } from './Switchboard.tsx';

// ------------------------------------------------------------------ poll card
export function PollCard({ m, meId, users }: { m: Message; meId: string; users: Map<string, PublicUser> }) {
  const toast = useToast();
  const poll = m.poll!;
  const [busy, setBusy] = useState(false);
  const total = poll.options.reduce((n, o) => n + o.votes, 0);
  const voted = poll.mine.length > 0;
  const showResults = voted || poll.closed;
  const leader = Math.max(0, ...poll.options.map((o) => o.votes));
  const vote = async (i: number) => {
    if (poll.closed || busy) return;
    const next = poll.multi ? (poll.mine.includes(i) ? poll.mine.filter((x) => x !== i) : [...poll.mine, i]) : (poll.mine[0] === i ? [] : [i]);
    setBusy(true);
    try { await window.dex.request('poll.vote', { messageId: m.id, options: next }); } catch (e) { toast((e as Error).message, true); }
    setBusy(false);
  };
  return (
    <div className={`poll${poll.closed ? ' closed' : ''}`} role="group" aria-label={`Poll: ${poll.question}`}>
      <div className="poll-head">
        <Icon name="poll" size={16} />
        <span className="label">{poll.closed ? 'Poll · voting closed' : poll.multi ? 'Poll · choose any' : 'Poll · choose one'}{poll.anonymous ? ' · anonymous' : ''}</span>
      </div>
      <div className="poll-q">{renderBody(poll.question, users, meId)}</div>
      <div className="poll-options">
        {poll.options.map((o, i) => {
          const pct = total ? Math.round((o.votes / total) * 100) : 0;
          const mine = poll.mine.includes(i);
          return (
            <button key={i} className={`poll-opt${mine ? ' mine' : ''}${showResults && o.votes === leader && leader > 0 ? ' lead' : ''}`} disabled={poll.closed || busy}
              onClick={() => void vote(i)} aria-pressed={mine}>
              <span className="poll-row">
                <span className={`poll-mark${poll.multi ? ' square' : ''}`}>{mine && <Icon name="check" size={12} />}</span>
                <span className="poll-text" translate="no">{o.text}</span>
                {showResults && (
                  <span className="poll-count">
                    {!poll.anonymous && o.voters.length > 0 && (
                      <span className="poll-faces" title={o.voters.map((id) => (id === meId ? 'You' : users.get(id)?.displayName ?? 'Someone')).join(', ')}>
                        {o.voters.slice(0, 3).map((id) => <span key={id} className="poll-face" style={{ background: colorFor(id) }} />)}
                      </span>
                    )}
                    {o.votes} · {pct}%
                  </span>
                )}
              </span>
              {showResults && <span className="poll-scale" aria-hidden="true"><span className="poll-fill" style={{ width: `${pct}%` }} /></span>}
            </button>
          );
        })}
      </div>
      <div className="poll-foot faint">
        {poll.voterCount} {poll.voterCount === 1 ? 'vote' : 'votes'}
        {poll.closesAt && !poll.closed && <> · closes {describeWhen(poll.closesAt)}</>}
        {!showResults && <> · vote to see results</>}
        {!poll.closed && m.authorId === meId && (
          <button className="link" onClick={() => void window.dex.request('poll.close', { messageId: m.id }).catch((e: Error) => toast(e.message, true))}>Close voting</button>
        )}
        {m.authorId === meId && showResults && (
          <button className="link" onClick={() => {
            const rows: string[][] = [['Option', 'Votes', ...(poll.anonymous ? [] : ['Voters'])], ...poll.options.map((o) => [o.text, String(o.votes), ...(poll.anonymous ? [] : [o.voters.map((v) => users.get(v)?.displayName ?? 'Someone').join('; ')])])];
            const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\r\n');
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob(['\ufeff', csv], { type: 'text/csv' }));
            a.download = `Poll results - ${plainPreview(poll.question, users).slice(0, 40).replace(/[\\/:*?"<>|]/g, '')}.csv`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
          }}>Export results</button>
        )}
      </div>
    </div>
  );
}

export function ForwardedTag({ m, users, meId }: { m: Message; users: Map<string, PublicUser>; meId: string }) {
  const f = m.forwardedFrom!;
  const conv = useChat((s) => s.conversations.get(f.convId));
  const who = f.authorId === meId ? 'you' : users.get(f.authorId)?.displayName ?? 'a former member';
  const where = conv?.kind === 'space' ? ` in ${conv.name}` : '';
  return (
    <div className="fwd-tag">
      <Icon name="forward" size={13} />
      <span>Passed on from <b>{who}</b>{where} · {describeWhen(f.createdAt)}</span>
    </div>
  );
}

// ------------------------------------------------------------------ when picker
function WhenPicker({ kind, value, onChange }: { kind: 'remind' | 'send'; value: number | null; onChange: (ts: number) => void }) {
  const presets = useMemo(() => whenPresets(kind), [kind]);
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <div className="when">
      <div className="when-presets">
        {presets.map((p) => (
          <button key={p.id} className={`when-chip${picked === p.id ? ' on' : ''}`} onClick={() => { setPicked(p.id); onChange(p.at()); }}>{p.label}</button>
        ))}
      </div>
      <div className="field">
        <label htmlFor="when-at">Or pick a date and time</label>
        <input id="when-at" className="input" type="datetime-local" min={toLocalInput(Date.now())} value={value ? toLocalInput(value) : ''}
          onChange={(e) => { setPicked(null); const t = new Date(e.target.value).getTime(); if (Number.isFinite(t)) onChange(t); }} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ reminder dialog
export function RemindDialog({ message, users, meId, onClose }: {
  message?: Message; users: Map<string, PublicUser>; meId: string; onClose: () => void;
}) {
  const toast = useToast();
  const conv = useChat((s) => (message ? s.conversations.get(message.convId) : undefined));
  const [text, setText] = useState('');
  const [at, setAt] = useState<number | null>(null);
  const [repeat, setRepeat] = useState<RepeatRule>('none');
  const [forUser, setForUser] = useState(meId);
  const [busy, setBusy] = useState(false);
  // for a message, only people who can see it; otherwise anyone
  const people = [...users.values()].filter((u) => u.role !== 'bot' && (!conv || conv.members.includes(u.id)))
    .sort((a, b) => (a.id === meId ? -1 : b.id === meId ? 1 : a.displayName.localeCompare(b.displayName)));
  const save = async () => {
    if (!at) return;
    setBusy(true);
    try {
      await window.dex.request('remind.create', { text: text.trim() || undefined, messageId: message?.id, dueAt: at, repeat, forUserId: forUser });
      toast(`Reminder set for ${describeWhen(at)}${forUser !== meId ? ` for ${users.get(forUser)?.displayName}` : ''}`);
      onClose();
    } catch (e) { toast((e as Error).message, true); setBusy(false); }
  };
  return (
    <Dialog title={message ? 'Remind about this message' : 'New reminder'} onClose={onClose}>
      {message && <div className="quote">{message.body ? renderBody(message.body, users, meId) : <span className="faint">Attachment</span>}</div>}
      <div className="field">
        <label htmlFor="rem-text">{message ? 'Note (optional)' : 'Remind me to'}</label>
        <input id="rem-text" className="input" autoFocus maxLength={500} value={text} onChange={(e) => setText(e.target.value)}
          placeholder={message ? 'Follow up with the client' : 'Send the revised MTO to Priya'} onKeyDown={(e) => { if (e.key === 'Enter' && at) void save(); }} />
      </div>
      <WhenPicker kind="remind" value={at} onChange={setAt} />
      <div className="form-row">
        <div className="field">
          <label htmlFor="rem-repeat">Repeat</label>
          <select id="rem-repeat" className="input" value={repeat} onChange={(e) => setRepeat(e.target.value as RepeatRule)}>
            {(Object.keys(REPEAT_LABEL) as RepeatRule[]).map((r) => <option key={r} value={r}>{REPEAT_LABEL[r]}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rem-who">Who</label>
          <select id="rem-who" className="input" value={forUser} onChange={(e) => setForUser(e.target.value)}>
            {people.map((u) => <option key={u.id} value={u.id}>{u.id === meId ? 'Me' : u.displayName}</option>)}
          </select>
        </div>
      </div>
      <div className="dialog-actions">
        <span className="faint">{at ? describeWhen(at) : 'Choose when'}</span>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!at || busy || (!message && !text.trim())} onClick={() => void save()}><Icon name="alarm" size={15} />Set reminder</button>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ forward dialog
export function ForwardDialog({ message, more = [], users, meId, online, onClose }: {
  message: Message; /** further messages forwarded together (multi-select), in order */ more?: Message[];
  users: Map<string, PublicUser>; meId: string; online: Set<string>; onClose: () => void;
}) {
  const toast = useToast();
  const conversations = useChat((s) => s.conversations);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const list = [...conversations.values()].filter((c) => c.joined)
    .map((c) => ({ c, title: convTitle(c, users, meId) }))
    .filter((x) => !q || x.title.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (b.c.lastMessage?.createdAt ?? b.c.createdAt) - (a.c.lastMessage?.createdAt ?? a.c.createdAt));
  const go = async () => {
    setBusy(true);
    try {
      const all = [message, ...more];
      for (const [i, m] of all.entries()) await window.dex.request('msg.forward', { messageId: m.id, convIds: picked, note: i === 0 ? note.trim() || undefined : undefined });
      toast(picked.length === 1 ? `Forwarded to ${convTitle(conversations.get(picked[0])!, users, meId)}` : `Forwarded to ${picked.length} conversations`);
      onClose();
    } catch (e) { toast((e as Error).message, true); setBusy(false); }
  };
  return (
    <Dialog title="Forward" onClose={onClose}>
      {more.length ? <div className="quote">{1 + more.length} messages</div>
        : <div className="quote">{message.body ? renderBody(message.body, users, meId) : <span className="faint">{message.files.length} {message.files.length === 1 ? 'file' : 'files'}</span>}</div>}
      <input className="input" autoFocus placeholder="Search conversations" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search conversations" />
      <div className="picker-list">
        {list.length === 0 && <div className="faint" style={{ padding: 12 }}>No conversations match.</div>}
        {list.map(({ c, title }) => (
          <label key={c.id} className={`picker-row${picked.includes(c.id) ? ' on' : ''}`}>
            <input type="checkbox" checked={picked.includes(c.id)} disabled={!picked.includes(c.id) && picked.length >= 10}
              onChange={() => setPicked(picked.includes(c.id) ? picked.filter((x) => x !== c.id) : [...picked, c.id])} />
            <ConvTile c={c} users={users} meId={meId} online={online} size="sm" />
            <span className="sb-main"><span className="sb-name">{title}</span><span className="sb-preview">{c.kind === 'space' ? 'Space' : 'Direct'}</span></span>
          </label>
        ))}
      </div>
      <input className="input" placeholder="Add a note (optional)" maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="dialog-actions">
        <span />
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!picked.length || busy} onClick={() => void go()}><Icon name="forward" size={15} />Forward{picked.length > 1 ? ` (${picked.length})` : ''}</button>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ new poll
export function PollDialog({ conv, parentId, onClose }: { conv: Conversation; parentId: string | null; onClose: () => void }) {
  const toast = useToast();
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multi, setMulti] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [closes, setCloses] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const filled = options.map((o) => o.trim()).filter(Boolean);
  const dupes = new Set(filled.map((o) => o.toLowerCase())).size !== filled.length;
  const create = async () => {
    setBusy(true);
    try {
      await window.dex.request('poll.create', {
        convId: conv.id, question: question.trim(), options: filled, multi, anonymous, closesAt: closes, parentId: parentId ?? undefined,
        clientId: `poll-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      });
      onClose();
    } catch (e) { toast((e as Error).message, true); setBusy(false); }
  };
  return (
    <Dialog title="New poll" onClose={onClose}>
      <div className="field">
        <label htmlFor="poll-q">Question</label>
        <input id="poll-q" className="input" autoFocus maxLength={300} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Which day suits the site visit?" />
      </div>
      <div className="field">
        <label>Choices</label>
        <div className="poll-edit">
          {options.map((o, i) => (
            <div key={i} className="poll-edit-row">
              <span className={`poll-mark${multi ? ' square' : ''}`} />
              <input className="input" maxLength={120} value={o} placeholder={`Choice ${i + 1}`}
                onChange={(e) => { const next = options.slice(); next[i] = e.target.value; if (i === options.length - 1 && e.target.value && options.length < 10) next.push(''); setOptions(next); }} />
              {options.length > 2 && <button className="icon-btn" aria-label={`Remove choice ${i + 1}`} onClick={() => setOptions(options.filter((_, j) => j !== i))}><Icon name="x" size={14} /></button>}
            </div>
          ))}
        </div>
        {dupes && <span className="field-error">Each choice must be different.</span>}
      </div>
      <ToggleRow checked={multi} onChange={setMulti} label="People can choose more than one" />
      <ToggleRow checked={anonymous} onChange={setAnonymous} label="Anonymous: hide who voted for what" />
      <div className="field">
        <label htmlFor="poll-close">Closes (optional)</label>
        <input id="poll-close" className="input" type="datetime-local" min={toLocalInput(Date.now())} value={closes ? toLocalInput(closes) : ''}
          onChange={(e) => { const t = new Date(e.target.value).getTime(); setCloses(Number.isFinite(t) ? t : null); }} />
      </div>
      <div className="dialog-actions">
        <span className="faint">{filled.length} choices</span>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!question.trim() || filled.length < 2 || dupes || busy} onClick={() => void create()}><Icon name="poll" size={15} />Post poll</button>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ schedule send
export function ScheduleDialog({ preview, users, meId, onPick, onClose }: {
  preview: string; users: Map<string, PublicUser>; meId: string; onPick: (at: number) => Promise<void>; onClose: () => void;
}) {
  const [at, setAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const tooSoon = at !== null && at < Date.now() + 60_000;
  return (
    <Dialog title="Send later" onClose={onClose}>
      {preview && <div className="quote">{renderBody(preview, users, meId)}</div>}
      <WhenPicker kind="send" value={at} onChange={setAt} />
      {tooSoon && <span className="field-error">Choose a time at least a minute from now.</span>}
      <p className="faint" style={{ fontSize: 12.5, margin: 0 }}>The office hub sends it at that time, even if your PC is switched off.</p>
      <div className="dialog-actions">
        <span className="faint">{at ? describeWhen(at) : 'Choose when'}</span>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!at || tooSoon || busy} onClick={() => { if (!at) return; setBusy(true); void onPick(at).finally(() => setBusy(false)); }}>
          <Icon name="schedule" size={15} />Send at this time
        </button>
      </div>
    </Dialog>
  );
}

/** "Mark unread" from a message: the conversation stays unread until you come back to it. */
export async function markUnreadFrom(m: Message): Promise<void> {
  holdUnread(m.convId);
  await window.dex.request('conv.markUnread', { convId: m.convId, messageId: m.id });
}
