// Desk → Bots: the bots you made (a register: mark, name, who can use it, runs, status) and the
// bots you can use; and each bot's own page once it is live: how often it is used, where people
// stop, recent runs (who, only for finished ones; answers never), its revisions, and pause,
// retire, duplicate or delete.
import { useCallback, useEffect, useState } from 'react';
import type { BotFlowInfo, BotMakerBot, BotStats, PublicUser, Session } from '@dex/core';
import { hoursText } from '@dex/core/botflows';
import { Avatar, Icon, relativeTime, useToast } from '../../ui.tsx';
import { confirmAction } from '../../confirm.tsx';
import { addConversation, chatState } from '../../chat/store.ts';
import { NIB_ACCOUNT } from '@dex/core/nib';
import { useNib } from '../../nib/store.ts';
import { BotMarkTile } from '../BotMark.tsx';
import { openBotMaker } from './open.ts';
import { openBotNetwork, openJobSheet } from '../net/open.ts';
import '../bots.css';
import './maker.css';

const pad = (n: number) => String(n).padStart(2, '0');
const open = (convId: string) => window.dispatchEvent(new CustomEvent('dex-open', { detail: convId }));

function scopeTag(b: BotFlowInfo): string {
  if (b.scope === 'office') return 'Office';
  if (b.scope === 'space') return chatState().conversations.get(b.spaceId ?? '')?.name ?? 'A Space';
  return 'Only me';
}

function StatusTag({ b }: { b: BotFlowInfo }) {
  if (b.requested === 'office') return <span className="chip warn">Waiting for review</span>;
  if (b.status === 'paused') return <span className="chip">Paused</span>;
  if (b.status === 'retired') return <span className="chip">Retired</span>;
  if (!b.openNow) return <span className="chip">Closed now</span>;
  return <span className="chip ok">Live</span>;
}

export function useStart() {
  const toast = useToast();
  return async (name: string) => {
    try {
      const r = await window.dex.request('botflow.start', { flow: name });
      if (chatState().conversations.has(r.convId)) open(r.convId);
      else setTimeout(() => open(r.convId), 400);
    } catch (e) { toast((e as Error).message, true); }
  };
}

export function MyBots({ session }: { session: Session }) {
  const [mine, setMine] = useState<BotMakerBot[] | null>(null);
  const [usable, setUsable] = useState<BotFlowInfo[]>([]);
  const [page, setPage] = useState<string | null>(null);
  const start = useStart();
  const load = useCallback(() => {
    void window.dex.request('botflow.mine').then(setMine).catch(() => setMine([]));
    void window.dex.request('botflow.list').then(setUsable).catch(() => {});
  }, []);
  useEffect(() => { load(); return window.dex.onHubEvent((n) => { if (n === 'botflow.catalog') load(); }); }, [load]);
  const guest = session.me.role === 'guest';
  const current = page ? mine?.find((b) => b.name === page) : undefined;
  if (current) return <BotPage bot={current} session={session} onBack={() => setPage(null)} onChanged={load} />;
  const others = usable.filter((f) => !mine?.some((m) => m.name === f.name));
  return (
    <div className="mybots">
      <OfficeBots session={session} flows={usable} mine={mine ?? []} />
      <section className="desk-group">
        <div className="mybots-head">
          <h3 className="label">Bots you made{mine ? ` · ${mine.length}` : ''}</h3>
          <span className="mybots-tools">
            {!guest && !!mine?.length && <button className="btn ghost sm" onClick={() => openBotNetwork('mine')}><Icon name="branch" size={14} />Bot network</button>}
            {!guest && !!mine?.some((b) => b.definition.jobs?.length) && <button className="btn ghost sm" onClick={() => openJobSheet('mine')}><Icon name="schedule" size={14} />Job sheet</button>}
            {!guest && <button className="btn primary sm" onClick={() => openBotMaker()}><Icon name="plus" size={14} />Make a bot</button>}
          </span>
        </div>
        {mine === null && <div className="tl-more"><span className="spinner" /></div>}
        {mine?.length === 0 && (
          <div className="empty mybots-empty">
            <Icon name="branch" size={20} />
            <span>Make a bot for a request you handle often: plot requests, leave notes, site visits, RFIs.</span>
            {!guest && <button className="btn" onClick={() => openBotMaker()}><Icon name="plus" size={15} />Make a bot</button>}
          </div>
        )}
        {!!mine?.length && (
          <ul className="bm-register" aria-label="Your bots">
            {mine.map((b) => (
              <li key={b.name} className={`bm-reg-row${b.status !== 'live' ? ' off' : ''}`}>
                <button type="button" className="bm-reg-main" onClick={() => setPage(b.name)} aria-label={`${b.title}: open its page`}>
                  {b.persona ? <BotMarkTile mark={b.persona.mark} colour={b.persona.colour} size={36} /> : <span className="bot-tile bm-blank-tile" style={{ width: 36, height: 36 }} />}
                  <span className="bm-reg-text">
                    <b translate="no">{b.title}</b>
                    <span className="mono faint">REV {pad(b.pendingVersion ?? b.version)} · {b.steps} Q · {b.runs === 1 ? '1 RUN' : `${b.runs} RUNS`}</span>
                  </span>
                </button>
                <span className="bm-reg-scope mono" translate={b.scope === 'space' ? 'no' : undefined}>{scopeTag(b)}</span>
                <StatusTag b={b} />
                <span className="bm-reg-actions">
                  <button className="btn ghost sm" onClick={() => openBotMaker({ name: b.name })}><Icon name="edit" size={14} />Edit</button>
                  <button className="btn sm" disabled={b.status !== 'live' || !b.openNow} onClick={() => void start(b.name)}><Icon name="play" size={14} />Start</button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {others.length > 0 && (
        <section className="desk-group">
          <h3 className="label">Bots you can use · {others.length}</h3>
          <ul className="bm-register" aria-label="Bots you can use">
            {others.map((f) => (
              <li key={f.name} className="bm-reg-row">
                <span className="bm-reg-main static">
                  {f.persona ? <BotMarkTile mark={f.persona.mark} colour={f.persona.colour} size={36} /> : <span className="bot-tile bm-blank-tile" style={{ width: 36, height: 36 }}><Icon name="branch" size={16} /></span>}
                  <span className="bm-reg-text"><b translate="no">{f.title}</b><span className="faint" translate="no">{f.description ?? f.botName}</span></span>
                </span>
                <span className="bm-reg-scope mono" translate="no">{f.ownerId ? session.users.find((u) => u.id === f.ownerId)?.displayName ?? '' : f.botName}</span>
                {f.persona?.hours && !f.openNow ? <span className="chip">Opens {hoursText(f.persona.hours)}</span> : <span />}
                <span className="bm-reg-actions">
                  <button className="btn sm" disabled={!f.openNow} onClick={() => void start(f.name)}><Icon name="play" size={14} />Start</button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ the office's own bots
type Kind = 'companion' | 'system' | 'office' | 'colleague' | 'integration';
const KIND_TAG: Record<Kind, string> = { companion: 'COMPANION', system: 'SYSTEM', office: 'OFFICE', colleague: 'MADE BY A COLLEAGUE', integration: 'INTEGRATION' };
const kindOf = (u: PublicUser): Kind => u.account === NIB_ACCOUNT ? 'companion' : u.account === 'system\\dexterity-connect' ? 'system'
  : u.account === 'system\\front-office' ? 'office' : u.account.startsWith('botmaker') ? 'colleague' : 'integration';
const KIND_ORDER: Kind[] = ['companion', 'office', 'system', 'integration', 'colleague'];

/**
 * Every bot in the office, not only the ones you made: Nib, Front Office and its request bots, the
 * system's account bot, integrations and colleagues' bots. A rack of instrument-tag plates (B-01…):
 * the bot's tile, what it is, what it does and the ways in (write to it, start one of its flows).
 * They are bots, and say so; none of them is a person.
 */
function OfficeBots({ session, flows, mine }: { session: Session; flows: BotFlowInfo[]; mine: BotMakerBot[] }) {
  const toast = useToast();
  const start = useStart();
  const nibConv = useNib((st) => st.me?.convId ?? null);
  const mineIds = new Set(mine.map((b) => b.botId));
  const bots = session.users.filter((u) => u.role === 'bot' && !mineIds.has(u.id))
    .sort((a, b) => KIND_ORDER.indexOf(kindOf(a)) - KIND_ORDER.indexOf(kindOf(b)) || a.displayName.localeCompare(b.displayName));
  if (!bots.length) return null;
  const write = async (u: PublicUser) => {
    if (kindOf(u) === 'companion' && nibConv) { window.dispatchEvent(new CustomEvent('dex-open', { detail: nibConv })); return; }
    const had = [...chatState().conversations.values()].find((c) => c.kind === 'direct' && c.members.length === 2 && c.members.includes(u.id) && c.members.includes(session.me.id));
    if (had) { window.dispatchEvent(new CustomEvent('dex-open', { detail: had.id })); return; }
    try {
      const c = await window.dex.request('conv.create', { kind: 'direct', members: [u.id] });
      addConversation(c);
      window.dispatchEvent(new CustomEvent('dex-open', { detail: c.id }));
    } catch (e) { toast((e as Error).message, true); }
  };
  const does = (u: PublicUser, own: BotFlowInfo[]): string => {
    const k = kindOf(u);
    if (k === 'companion') return 'Your day sheet, leave notes, reminders in plain words, who is in and where things are. Ctrl+Alt+N from anywhere.';
    if (k === 'system') return 'Tells you about your own account: a device added or removed, a role changed, guest access ending. It does not read replies.';
    if (own.length) return own.map((f) => f.title).slice(0, 4).join(' · ') + (own.length > 4 ? ` · ${own.length - 4} more` : '');
    return k === 'integration' ? 'Brings notices and answers from an office tool into Dexterity Connect.' : 'A bot a colleague made and shared.';
  };
  return (
    <section className="desk-group office-bots" aria-labelledby="office-bots-h">
      <div className="mybots-head">
        <h3 className="label" id="office-bots-h">Office bots · {bots.length}</h3>
        <span className="faint ob-note">On for everyone. Bots, not people: what they say is automatic.</span>
      </div>
      <ul className="ob-rack">
        {bots.map((u, i) => {
          const k = kindOf(u);
          const own = flows.filter((f) => f.botId === u.id);
          const live = own.filter((f) => f.status === 'live' && f.openNow);
          return (
            <li key={u.id} className={`ob-plate k-${k}`}>
              <div className="ob-tag" aria-hidden="true"><span className="ob-tag-letters mono">{k === 'companion' ? 'NIB' : u.displayName.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase() || 'B'}</span><span className="ob-tag-no mono">B-{pad(i + 1)}</span></div>
              <Avatar user={u} />
              <div className="ob-text">
                <div className="ob-name"><b translate="no">{u.displayName}</b><span className="tag bot-tag">BOT</span><span className="bot-kind">{KIND_TAG[k]}</span></div>
                <p className="ob-does" translate={own.length ? 'no' : undefined}>{does(u, own)}</p>
                <div className="ob-meta mono">{k === 'companion' ? 'ALWAYS HERE' : k === 'system' ? 'WRITES TO YOU' : own.length ? `${own.length} ${own.length === 1 ? 'FLOW' : 'FLOWS'} · ${live.length} OPEN NOW` : 'NOTICES'}</div>
              </div>
              <div className="ob-actions">
                {k !== 'system' && <button className="btn sm" onClick={() => void write(u)}><Icon name="chat" size={14} />{k === 'companion' ? 'Open Nib' : 'Write'}</button>}
                {k === 'system' && <button className="btn ghost sm" onClick={() => void write(u)}><Icon name="chat" size={14} />Its messages</button>}
                {live.slice(0, 2).map((f) => <button key={f.name} className="btn ghost sm" onClick={() => void start(f.name)} title={f.description ?? undefined}><Icon name="play" size={13} /><span translate="no">{f.title}</span></button>)}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function BotPage({ bot, session, onBack, onChanged }: { bot: BotMakerBot; session: Session; onBack: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [stats, setStats] = useState<BotStats | null>(null);
  const start = useStart();
  useEffect(() => { void window.dex.request('botflow.stats', { name: bot.name }).then(setStats).catch((e: Error) => toast(e.message, true)); }, [bot.name, bot.version, toast]);
  const users = new Map<string, PublicUser>(session.users.map((u) => [u.id, u] as const));
  const status = (s: 'live' | 'paused' | 'retired') => void window.dex.request('botflow.status', { name: bot.name, status: s })
    .then(() => { toast(s === 'paused' ? `${bot.title} is paused. Conversations in progress can still finish.` : s === 'retired' ? `${bot.title} is retired` : `${bot.title} is live again`); onChanged(); })
    .catch((e: Error) => toast(e.message, true));
  const remove = async () => {
    if (!(await confirmAction({ title: `Delete ${bot.title}?`, body: 'It stops for everyone, conversations in progress are cancelled, and its revisions and numbers are gone. Its old messages stay.', confirm: 'Delete', danger: true }))) return;
    try { await window.dex.request('botflow.delete', { name: bot.name }); toast(`${bot.title} deleted`); onBack(); onChanged(); } catch (e) { toast((e as Error).message, true); }
  };
  const max = Math.max(1, ...(stats?.steps.map((s) => s.reached) ?? [1]));
  const stopped = stats ? stats.cancelled + stats.expired : 0;
  const rate = stats && stats.runs ? Math.round((stats.finished / stats.runs) * 100) : null;
  return (
    <div className="bm-page">
      <button className="link bm-back" onClick={onBack}><Icon name="back" size={14} />All bots</button>
      <header className="bm-page-tb">
        {bot.persona && <BotMarkTile mark={bot.persona.mark} colour={bot.persona.colour} size={56} />}
        <div className="bm-page-name">
          <h2 translate="no">{bot.title}</h2>
          {bot.persona?.about && <p className="muted" translate="no">{bot.persona.about}</p>}
          <span className="mono faint">REV {pad(bot.version)}{bot.pendingVersion ? ` · REV ${pad(bot.pendingVersion)} WAITING` : ''} · {scopeTag(bot).toUpperCase()}{bot.persona?.hours ? ` · ${hoursText(bot.persona.hours).toUpperCase()}` : ''}</span>
        </div>
        <StatusTag b={bot} />
      </header>
      <div className="bm-page-actions">
        <button className="btn primary" onClick={() => openBotMaker({ name: bot.name })}><Icon name="edit" size={15} />Edit</button>
        <button className="btn" disabled={bot.status !== 'live' || !bot.openNow} onClick={() => void start(bot.name)}><Icon name="play" size={15} />Start</button>
        <button className="btn" onClick={() => openBotMaker({ name: bot.name, section: 'share' })}><Icon name="people" size={15} />Share</button>
        {!!bot.definition.jobs?.length && <button className="btn" onClick={() => openJobSheet('bot', bot.name)}><Icon name="schedule" size={15} />Jobs</button>}
        <button className="btn" onClick={() => openBotNetwork('mine')}><Icon name="branch" size={15} />Network</button>
        {bot.status === 'live' && <button className="btn" onClick={() => status('paused')}><Icon name="pause" size={15} />Pause</button>}
        {bot.status !== 'live' && <button className="btn" onClick={() => status('live')}><Icon name="play" size={15} />{bot.status === 'retired' ? 'Bring back' : 'Resume'}</button>}
        {bot.status !== 'retired' && <button className="btn ghost" onClick={() => status('retired')}><Icon name="archive" size={15} />Retire</button>}
        {bot.persona?.remember && <button className="btn ghost" onClick={() => void window.dex.request('botflow.forget', { name: bot.name }).then(() => toast('Your remembered answers are forgotten'))}>Forget my answers</button>}
        <button className="btn ghost danger" onClick={() => void remove()}><Icon name="trash" size={15} />Delete</button>
      </div>

      {stats === null ? <div className="tl-more"><span className="spinner" /></div> : (
        <>
          <dl className="bm-numbers">
            <div><dt>Runs</dt><dd>{stats.runs}</dd></div>
            <div><dt>Finished</dt><dd>{stats.finished}</dd></div>
            <div><dt>Stopped</dt><dd>{stopped}</dd></div>
            <div><dt>In progress</dt><dd>{stats.active}</dd></div>
            <div><dt>Finish rate</dt><dd>{rate === null ? '—' : `${rate}%`}</dd></div>
          </dl>

          <section className="bm-block-page">
            <h3 className="label">Where people stop</h3>
            {stats.runs === 0 ? <p className="faint">No one has used it yet. Start it yourself, or share it with a Space.</p> : (
              <ol className="bm-drop" aria-label="Runs that reached each question, and stopped there">
                {stats.steps.map((s, i) => (
                  <li key={s.id}>
                    <span className="mono bm-step-no">{pad(i + 1)}</span>
                    <span className="bm-drop-label" translate="no">{s.label}</span>
                    <span className="bm-bar" aria-hidden="true">
                      <i style={{ width: `${(s.reached / max) * 100}%` }} />
                      {s.stopped > 0 && <b style={{ width: `${(s.stopped / max) * 100}%` }} />}
                    </span>
                    <span className="mono bm-drop-n">{s.reached} reached{s.stopped ? ` · ${s.stopped} stopped` : ''}{s.waiting ? ` · ${s.waiting} waiting` : ''}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="bm-block-page">
            <h3 className="label">Recent runs</h3>
            <p className="faint bm-privacy">Answers are never shown here. A name appears only for runs that were finished, since those reached you anyway.</p>
            {stats.recent.length === 0 ? <p className="faint">None yet.</p> : (
              <ul className="bm-runs">
                {stats.recent.map((r, i) => (
                  <li key={i}>
                    <span className="mono faint">{relativeTime(r.at)}</span>
                    <span>
                      {r.status === 'done' ? `${users.get(r.userId ?? '')?.displayName ?? 'Someone'} finished it`
                        : r.status === 'active' ? `Someone is at question ${r.reached + 1}`
                          : r.status === 'expired' ? `Someone left it at question ${r.reached + 1}; it expired`
                            : `Someone stopped at question ${r.reached + 1}`}
                    </span>
                    <span className="mono faint">REV {pad(r.version)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="bm-block-page">
            <h3 className="label">Revisions</h3>
            <p className="faint bm-privacy">A change never alters a conversation already under way: it finishes on the revision it started with.</p>
            <ul className="bm-runs">
              {stats.versions.map((v) => (
                <li key={v.version}>
                  <span className="mono">REV {pad(v.version)}</span>
                  <span>{v.by === session.me.id ? 'Saved by you' : `Saved by ${users.get(v.by ?? '')?.displayName ?? 'an administrator'}`}</span>
                  <span className="mono faint">{v.version === bot.version ? 'LIVE · ' : v.version === bot.pendingVersion ? 'WAITING · ' : ''}{relativeTime(v.at)}</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
