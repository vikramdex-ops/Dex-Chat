// The header of a conversation with a bot: a bot is not a person, so instead of an encryption tag,
// an account name, "Status" and "Last on", it shows a BOT tag, who made it, what it is for, and
// cells that say something: its open requests and those waiting for you (a bot that tracks
// requests), or its hours. Details explains, once, why bot conversations are not end-to-end
// encrypted. Used by chat/Pane.tsx for any Direct conversation with a bot.
import { useEffect, useState } from 'react';
import type { BotAbout, PublicUser } from '@dex/core';
import { hoursText } from '@dex/core/botflows';
import { Dialog } from '../ui.tsx';

export interface BotHeadView {
  subtitle: React.ReactNode;
  facts: Array<[string, string]>;
  placeholder: string;
  details: React.ReactNode;
}

/** What the header shows for a Direct conversation with `bot` (null when it is not one). */
export function useBotHead(bot: PublicUser | undefined, convId: string, title: string, users: Map<string, PublicUser>, lastId: string | null = null): BotHeadView | null {
  const [about, setAbout] = useState<BotAbout | null>(null);
  const [open, setOpen] = useState(false);
  const botId = bot?.role === 'bot' ? bot.id : null;
  useEffect(() => {
    if (!botId) { setAbout(null); return; }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () => void window.dex.request('botflow.about', { botId }).then(setAbout).catch(() => setAbout(null));
    load();
    // its cards change as requests move: read the counts again (at most once a second)
    const off = window.dex.onHubEvent((name, d) => {
      if (name === 'botflow.catalog' || ((name === 'msg.updated' || name === 'msg.new') && (d as { convId?: string } | null)?.convId === convId)) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(load, 800);
      }
    });
    // and now and then, for requests that moved elsewhere
    const every = setInterval(load, 60_000);
    return () => { off(); clearInterval(every); if (timer) clearTimeout(timer); };
  }, [botId, convId, lastId]);
  if (!botId) return null;
  const maker = about?.ownerId ? users.get(about.ownerId)?.displayName : null;
  const by = maker ? `Made by ${maker}` : about?.source === 'api' ? 'Integration' : 'Office bot';
  const facts: Array<[string, string]> = about?.tracked
    ? [['Open', String(about.open)], ['Yours', String(about.yours)]]
    : about?.hours
      ? [['Hours', hoursText(about.hours)], ['Now', about.openNow ? 'Open' : 'Closed']]
      : [['Hours', 'Any time'], ['Can do', String(about?.flows.length ?? 0)]];
  const subtitle = (
    <>
      <span className="chip accent bot-head-tag">Bot</span>
      <span className="pane-sub"><span>{by}</span>{about?.about ? <span translate="no">{` · ${about.about}`}</span> : null}</span>
      <button type="button" className="link bot-head-details" onClick={() => setOpen(true)}>Details</button>
    </>
  );
  const details = open ? (
    <Dialog title={title} onClose={() => setOpen(false)} narrow>
      <dl className="bot-details">
        <div><dt>Made by</dt><dd translate={maker ? 'no' : undefined}>{maker ?? (about?.source === 'api' ? 'An integration' : 'The office')}</dd></div>
        {about?.about && <div><dt>About</dt><dd translate="no">{about.about}</dd></div>}
        {!!about?.flows.length && <div><dt>Can do</dt><dd translate="no">{about.flows.map((f) => f.title).join(', ')}</dd></div>}
        <div><dt>Hours</dt><dd>{about?.hours ? hoursText(about.hours) : 'Any time'}</dd></div>
        {about?.tracked && <div><dt>Requests</dt><dd>{`${about.open} open, ${about.yours} waiting for you`}</dd></div>}
      </dl>
      <p className="faint bot-details-note">Conversations with a bot are not end-to-end encrypted: the office hub runs the bot, so it reads what you answer. Keep passwords and private matters out of them.</p>
    </Dialog>
  ) : null;
  const short = title.length > 28 ? `${title.slice(0, 26).trimEnd()}…` : title;
  return { subtitle, facts, placeholder: `Write to ${short}`, details };
}
