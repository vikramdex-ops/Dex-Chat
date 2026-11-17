// An integration's card in the timeline: one step of a flow with its input inline, Pick up
// where you left off, the list of things it can do, a summary handed to someone, and the end.
// Laid out like a sheet: a title strip with the step on a scale bar, the question, the answer.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BotFlowCard as Card, BotFlowInput, Message, OpName, Ops, PublicUser } from '@dex/core';
import { Avatar, Icon, useToast } from '../ui.tsx';
import { renderBody } from '../chat/format.tsx';
import { chatState } from '../chat/store.ts';
import { filesSupported, formatSize, startUploads } from '../chat/files.tsx';
import { BotMarkTile } from './BotMark.tsx';
import { formatDateTime } from '../time.ts';
import { RegisterBody, TrackBody } from './TrackCard.tsx';
import { RelayBody } from './net/RelayCard.tsx';
import type { TrackDriver } from './TrackCard.tsx';

const req = <K extends OpName>(op: K, data?: Ops[K]['req']) => window.dex.request(op, data);

/**
 * What a card's buttons do. In a conversation they ask the hub; in the bot maker's test run they
 * move a run kept in the app, so the maker sees exactly the cards a colleague would.
 */
export interface FlowDriver {
  answer: (sessionId: string, stepId: string, value: string) => Promise<unknown>;
  back: (sessionId: string) => Promise<unknown>;
  cancel: (sessionId: string) => Promise<unknown>;
  resume: (sessionId: string, over: boolean) => Promise<unknown>;
  start: (flow: string, convId: string) => Promise<{ convId: string; resumed: boolean }>;
  /** A test run: files are named, not uploaded. */
  test?: boolean;
  /** Tracked requests: the buttons of whoever acts now. */
  track?: TrackDriver;
}

const HUB_TRACK: TrackDriver = {
  act: (itemId, action, note) => req('botflow.act', note ? { itemId, action, note } : { itemId, action }),
  tick: (itemId, index, on) => req('botflow.tick', { itemId, index, on }),
  withdraw: (itemId) => req('botflow.withdraw', { itemId }),
  takeover: (itemId) => req('botflow.takeover', { itemId }),
};

export const HUB_DRIVER: FlowDriver = {
  answer: (sessionId, stepId, value) => req('botflow.answer', { sessionId, stepId, value }),
  back: (sessionId) => req('botflow.back', { sessionId }),
  cancel: (sessionId) => req('botflow.cancel', { sessionId }),
  resume: (sessionId, over) => req('botflow.resume', over ? { sessionId, over: true } : { sessionId }),
  start: (flow, convId) => req('botflow.start', { flow, convId }),
  track: HUB_TRACK,
};
const open = (convId: string) => window.dispatchEvent(new CustomEvent('dex-open', { detail: convId }));
const pad = (n: number) => String(n).padStart(2, '0');
const when = (t?: number) => (t ? formatDateTime(t, { weekday: 'short', day: 'numeric', month: 'short' }) : '');

/** The step as a scale bar: one tick per step, filled up to here. */
function Scale({ n, of }: { n: number; of?: number }) {
  if (!of) return <span className="flow-step mono">Step {pad(n)}</span>;
  return (
    <span className="flow-step mono" aria-label={`Step ${n} of ${of}`}>
      <span className="flow-scale" aria-hidden="true">{Array.from({ length: Math.min(of, 24) }, (_, i) => <i key={i} className={i < n - 1 ? 'done' : i === n - 1 ? 'here' : ''} />)}</span>
      {pad(n)} / {pad(of)}
    </span>
  );
}

function PersonPick({ users, meId, onPick, busy, initial }: { users: Map<string, PublicUser>; meId: string; onPick: (id: string) => void; busy: boolean; initial?: string }) {
  const [q, setQ] = useState(initial ?? '');
  const people = useMemo(() => [...users.values()].filter((u) => u.role !== 'bot' && u.id !== meId), [users, meId]);
  const t = q.trim().toLowerCase();
  const hits = (t ? people.filter((u) => u.displayName.toLowerCase().includes(t) || u.account.toLowerCase().includes(t) || (u.title ?? '').toLowerCase().includes(t)) : people).slice(0, 6);
  return (
    <div className="flow-person">
      <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or sign-in" aria-label="Search for a person" autoFocus />
      <div className="flow-people" role="listbox" aria-label="People">
        {hits.map((u) => (
          <button key={u.id} role="option" aria-selected="false" type="button" className="flow-person-row" disabled={busy} onClick={() => onPick(u.id)}>
            <Avatar user={u} size="sm" /><span className="grow"><b>{u.displayName}</b>{u.title && <span className="faint"> · {u.title}</span>}</span><span className="mono faint">{u.account.split('\\').pop()}</span>
          </button>
        ))}
        {!hits.length && <span className="faint flow-none">No one matches.</span>}
      </div>
    </div>
  );
}

function StepInput({ card, users, meId, answer, busy, test }: { card: Card; users: Map<string, PublicUser>; meId: string; answer: (v: string) => void; busy: boolean; test?: boolean }) {
  const input = card.input as BotFlowInput;
  const prev = card.previous ?? null;
  const [text, setText] = useState(prev?.value ?? '');
  const [upload, setUpload] = useState<{ name: string; sent: number; size: number; error?: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setText(prev?.value ?? ''); }, [card.stepId, prev?.value]);
  const v = input.validate;
  switch (input.kind) {
    case 'choice':
      return (
        <div className="flow-opts" role="group" aria-label="Choices">
          {(input.options ?? []).map((o) => <button key={o.value} type="button" className={`flow-opt${prev?.value === o.value ? ' was' : ''}`} disabled={busy} onClick={() => answer(o.value)}>{o.label}</button>)}
        </div>
      );
    case 'confirm':
      return (
        <div className="flow-opts">
          <button type="button" className="btn primary" disabled={busy} onClick={() => answer('yes')}><Icon name="check" size={15} />{input.yes ?? 'Yes'}</button>
          <button type="button" className="btn" disabled={busy} onClick={() => answer('no')}>{input.no ?? 'No'}</button>
        </div>
      );
    case 'person':
      return <PersonPick users={users} meId={meId} busy={busy} onPick={answer} initial={prev?.label} />;
    case 'file': {
      const pick = (files: FileList | null) => {
        const f = files?.[0];
        if (!f) return;
        if (test) { answer(`test:${f.name}`); return; }
        setUpload({ name: f.name, sent: 0, size: f.size });
        startUploads([f], (_k, patch) => {
          if (!patch) return;
          if (patch.error) setUpload((u) => (u ? { ...u, error: patch.error } : u));
          else if (patch.info) { setUpload((u) => (u ? { ...u, sent: u.size } : u)); answer(patch.info.id); } else if (patch.sent !== undefined) setUpload((u) => (u ? { ...u, sent: patch.sent ?? 0 } : u));
        });
      };
      return (
        <div className="flow-opts">
          <input ref={fileRef} type="file" hidden accept={input.accept?.join(',')} onChange={(e) => pick(e.target.files)} />
          <button type="button" className="btn" disabled={busy || (!test && !filesSupported()) || (!!upload && !upload.error)} onClick={() => fileRef.current?.click()}><Icon name="paperclip" size={15} />{prev?.value ? 'Attach another file' : 'Attach a file'}</button>
          {upload && <span className={`mono ${upload.error ? 'flow-err' : 'faint'}`}>{upload.error ?? `${upload.name} · ${Math.round((upload.sent / Math.max(1, upload.size)) * 100)}% of ${formatSize(upload.size)}`}</span>}
          {!upload && input.accept?.length ? <span className="faint mono">{input.accept.join(' ')}</span> : null}
          {prev?.value && <button type="button" className="btn ghost" disabled={busy} onClick={() => answer(prev.value)}>Keep {prev.label}</button>}
        </div>
      );
    }
    default: {
      const type = v?.type === 'date' ? 'date' : 'text';
      const submit = (e: React.FormEvent) => { e.preventDefault(); if (text.trim()) answer(text); };
      return (
        <>
        <form className="flow-text" onSubmit={submit}>
          {input.multiline
            ? <textarea className="input" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={input.placeholder} aria-label="Your answer" autoFocus onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(e); }} />
            : <input className="input" type={type} value={text} onChange={(e) => setText(e.target.value)} placeholder={input.placeholder} aria-label="Your answer" autoFocus inputMode={v?.type === 'number' ? 'decimal' : v?.type === 'email' ? 'email' : undefined} min={v?.type === 'date' && v.notBefore === 'today' ? new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10) : undefined} />}
          <button className="btn primary" disabled={busy || !text.trim()}>Next<Icon name="dimsend" size={15} /></button>
        </form>
        {!!input.suggestions?.length && (
          <div className="flow-quick" role="group" aria-label="Quick replies">
            {input.suggestions.map((q) => <button key={q} type="button" className="flow-quick-btn" disabled={busy} onClick={() => answer(q)}>{q}</button>)}
          </div>
        )}
        </>
      );
    }
  }
}

export function FlowCardView({ m, meId, users, driver = HUB_DRIVER }: { m: Message; meId: string; users: Map<string, PublicUser>; driver?: FlowDriver }) {
  const card = m.botflow as Card;
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setError(null); }, [card.state, card.stepId]);
  const mine = card.ownerId === meId;
  const act = async (p: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try { await p(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const sid = card.sessionId ?? '';
  const start = (flow: string) => act(async () => {
    const r = await driver.start(flow, m.convId);
    if (r.convId !== m.convId) { if (chatState().conversations.has(r.convId)) open(r.convId); toast(r.resumed ? 'Carried on where you left off' : `Started in your conversation with ${users.get(card.botId)?.displayName ?? 'the integration'}`); }
  });
  const bot = users.get(card.botId);
  const head = (right: React.ReactNode) => (
    <div className={`flow-tb${card.persona ? ' has-mark' : ''}`}>
      {card.persona && <BotMarkTile mark={card.persona.mark} colour={card.persona.colour} size={18} />}
      <span className="flow-title">{card.title}</span>{right}
    </div>
  );

  if (card.kind === 'menu' || card.kind === 'offer') {
    return (
      <div className="flow-card">
        {head(<span className="flow-step mono">{card.kind === 'menu' ? 'Can do' : 'Start'}</span>)}
        {card.kind === 'menu' && <div className="flow-q">{renderBody(m.body, users, meId)}</div>}
        <div className="flow-list">
          {(card.flows ?? []).map((f) => (
            <div key={f.name} className="flow-list-row">
              <span className="grow"><b>{f.title}</b>{f.description && <span className="faint"> {f.description}</span>}</span>
              <button className="btn" disabled={busy || (card.kind === 'menu' && !mine)} onClick={() => void start(f.name)}>Start</button>
            </div>
          ))}
        </div>
        {error && <div className="flow-err" role="alert">{error}</div>}
      </div>
    );
  }

  const track = driver.track ?? HUB_TRACK;
  if (card.kind === 'relay') {
    const v = card.relay;
    const pending = v?.hops.some((h) => h.status === 'pending');
    return (
      <div className={`flow-card relay${v?.moved ? ' moved' : ''}${pending ? ' live' : ''}`}>
        {head(<span className="flow-step mono"><Icon name="branch" size={12} />{v && v.tags.length > 1 ? 'Between bots' : 'Relay'}</span>)}
        {v ? <RelayBody v={v} retry={driver.test ? undefined : (hopId) => req('botnet.retry', { hopId })} /> : <div className="flow-foot faint">This is no longer available.</div>}
      </div>
    );
  }
  if (card.kind === 'track') {
    const v = card.track;
    if (!v) return <div className="flow-card track">{head(null)}<div className="flow-foot faint">This request is no longer available.</div></div>;
    if (v.moved) return <div className="flow-card track moved">{head(<span className="flow-step mono" translate="no">{v.ref}</span>)}<div className="flow-foot faint"><span className="mono" translate="no">{v.ref}</span><span>{' · '}</span><span>See the latest card below.</span></div></div>;
    return (
      <div className={`flow-card track${v.role === 'actor' ? ' acting' : ''}`}>
        {head(<span className="flow-step mono">{v.role === 'actor' ? 'For you' : v.status === 'open' ? 'Following' : 'Closed'}</span>)}
        <TrackBody v={v} users={users} meId={meId} driver={track} />
      </div>
    );
  }
  if (card.kind === 'register') {
    const r = card.register;
    return (
      <div className={`flow-card register${r?.moved ? ' moved' : ''}`}>
        {head(<span className="flow-step mono">{r?.mode === 'mine' ? 'Waiting for you' : r?.mode === 'team' ? 'Passed up to you' : 'Register'}{r && !r.moved ? <span className="reg-at">{formatDateTime(r.at, { day: 'numeric', month: 'short' })}</span> : null}</span>)}
        {r ? <RegisterBody r={r} users={users} meId={meId} driver={track} /> : <div className="flow-foot faint">This bot is switched off.</div>}
      </div>
    );
  }
  if (card.kind === 'done' && card.track) {
    if (card.track.moved) {
      return <div className="flow-card done track moved">{head(<span className="flow-step mono"><Icon name="check" size={12} />Sent</span>)}<div className="flow-foot faint"><span className="mono" translate="no">{card.track.ref}</span><span>{' · '}</span><span>See the latest card below.</span></div></div>;
    }
    return (
      <div className={`flow-card done track${card.track.role === 'actor' ? ' acting' : ''}`}>
        {head(<span className="flow-step mono"><Icon name="check" size={12} />Sent</span>)}
        {card.prompt && <div className="flow-q">{renderBody(card.prompt, users, meId)}</div>}
        <TrackBody v={card.track} users={users} meId={meId} driver={track} />
      </div>
    );
  }

  if (card.kind === 'summary' || card.kind === 'done') {
    const from = card.requesterId ? users.get(card.requesterId) : undefined;
    return (
      <div className={`flow-card ${card.kind}`}>
        {head(<span className="flow-step mono">{card.kind === 'done' ? <><Icon name="check" size={12} />Finished</> : 'For you'}</span>)}
        {card.kind === 'summary' && from && <div className="flow-from"><Avatar user={from} size="sm" /><span><b>{from.displayName}</b> asks: {card.prompt}</span></div>}
        {card.kind === 'done' && card.prompt && <div className="flow-q">{renderBody(card.prompt, users, meId)}</div>}
        {!!card.lines?.length && (
          <dl className="flow-lines">{card.lines.map((l, i) => <div key={i}><dt>{l.label}</dt><dd className="selectable">{l.value}</dd></div>)}</dl>
        )}
        {!!card.notes?.length && <ul className="flow-notes mono">{card.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
        {card.kind === 'summary' && <div className="flow-foot faint">The task is on your Desk. Mark it done there once you have dealt with it.</div>}
      </div>
    );
  }

  if (card.kind === 'resume') {
    return (
      <div className={`flow-card resume ${card.state}`}>
        {head(card.stepNo ? <Scale n={card.stepNo} of={card.stepCount} /> : null)}
        <div className="flow-q"><b>Pick up where you left off:</b> {card.stepCount ? `step ${card.stepNo} of ${card.stepCount}` : `step ${card.stepNo}`}.</div>
        <div className="flow-meta mono faint">Started {when(card.startedAt)} · last answered {when(card.updatedAt)} · kept until {when(card.expiresAt)}</div>
        {card.state === 'active' && mine ? (
          <div className="flow-foot">
            <button className="btn primary" disabled={busy} onClick={() => void act(() => driver.resume(sid, false))}>Resume</button>
            <button className="btn" disabled={busy} onClick={() => void act(() => driver.resume(sid, true))}>Start over</button>
            <span className="grow" />
            <button className="btn ghost" disabled={busy} onClick={() => void act(() => driver.cancel(sid))}>Cancel</button>
          </div>
        ) : <div className="flow-foot faint">{card.state === 'moved' ? 'Carried on below.' : card.state === 'cancelled' ? 'Cancelled.' : card.state === 'expired' ? 'This expired.' : 'Finished.'}</div>}
        {error && <div className="flow-err" role="alert">{error}</div>}
      </div>
    );
  }

  // a step
  const answer = (value: string) => void act(() => driver.answer(sid, card.stepId ?? '', value));
  const active = card.state === 'active' && mine;
  return (
    <div className={`flow-card step ${card.state}`}>
      {head(card.stepNo ? <Scale n={card.stepNo} of={card.stepCount} /> : null)}
      {card.intro && <div className="flow-intro">{renderBody(card.intro, users, meId)}</div>}
      <div className="flow-q">{renderBody(card.prompt ?? m.body, users, meId)}</div>
      {active && card.lastTime && (
        <div className="flow-again">
          <button type="button" className="flow-again-btn" disabled={busy} onClick={() => answer(card.lastTime!.value)}>
            <Icon name="refresh" size={14} /><span>{card.lastTimeWords || card.lastTime.label}</span>
          </button>
        </div>
      )}
      {active && card.suggested && (
        <div className="flow-again">
          <button type="button" className="flow-again-btn" disabled={busy} onClick={() => answer(card.suggested!.value)}>
            <Icon name="user" size={14} /><span>{`Your lead: ${users.get(card.suggested.value)?.displayName ?? card.suggested.label}`}</span>
          </button>
        </div>
      )}
      {active && <StepInput card={card} users={users} meId={meId} answer={answer} busy={busy} test={driver.test} />}
      {card.state === 'answered' && card.answer && (
        <div className="flow-answer"><Icon name="check" size={14} /><span className="selectable">{card.input?.kind === 'person' ? (users.get(card.answer.value)?.displayName ?? card.answer.label) : card.answer.label}</span></div>
      )}
      {error && <div className="flow-err" role="alert">{error}</div>}
      {active ? (
        <div className="flow-foot">
          {card.canBack && <button className="btn ghost" disabled={busy} onClick={() => void act(() => driver.back(sid))}><Icon name="back" size={14} />Back</button>}
          {card.input?.optional && <button className="btn ghost" disabled={busy} onClick={() => answer('')}>Skip</button>}
          <span className="grow" />
          <button className="btn ghost" disabled={busy} onClick={() => void act(() => driver.cancel(sid))}>Cancel</button>
        </div>
      ) : card.state !== 'answered' && (
        <div className="flow-foot faint">{card.state === 'moved' ? 'Carried on below.' : card.state === 'cancelled' ? 'Cancelled. Nothing was sent.' : card.state === 'expired' ? 'This expired before it was finished.' : card.state === 'active' ? `Waiting for ${users.get(card.ownerId ?? '')?.displayName ?? 'someone'}${bot ? ` and ${bot.displayName}` : ''}.` : ''}</div>
      )}
    </div>
  );
}
