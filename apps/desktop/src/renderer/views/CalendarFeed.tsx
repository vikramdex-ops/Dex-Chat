// Preferences ▸ Calendar: a private address Outlook or a phone subscribes to, so your Dexterity
// Connect meetings show in the calendar you already use. Read-only: changes and cancellations
// come through when the calendar refreshes. The hub keeps only a hash of the address, so this PC
// remembers the address it was shown; another device shows it again only after a reset.
import { useCallback, useEffect, useState } from 'react';
import type { CalendarFeedInfo, Session } from '@dex/core';
import type { AppState } from '../../shared/bridge.ts';
import { Icon, Toggle, relativeTime, useToast } from '../ui.tsx';
import './continuity.css';

type Urls = NonNullable<CalendarFeedInfo['urls']>;
const keyFor = (session: Session) => `dex.calfeed.${session.hub.id}.${session.me.id}`;

/** The address this PC was shown, with when it was made (a reset on another device makes it stale). */
function remembered(session: Session): { urls: Urls; createdAt: number | null } | null {
  try {
    const v = JSON.parse(localStorage.getItem(keyFor(session)) ?? 'null') as { urls?: Urls; createdAt?: number | null } | null;
    return v?.urls && typeof v.urls.path === 'string' ? { urls: v.urls, createdAt: v.createdAt ?? null } : null;
  } catch { return null; }
}
function remember(session: Session, urls: Urls | null, createdAt: number | null): void {
  try { if (urls) localStorage.setItem(keyFor(session), JSON.stringify({ urls, createdAt })); else localStorage.removeItem(keyFor(session)); } catch { /* private storage off */ }
}

export function CalendarFeedSettings({ state, session }: { state: AppState; session: Session }) {
  const toast = useToast();
  const live = state.phase === 'ready';
  const [info, setInfo] = useState<CalendarFeedInfo | null>(null);
  const [urls, setUrls] = useState<Urls | null>(() => remembered(session)?.urls ?? null);
  const [busy, setBusy] = useState(false);
  const adopt = useCallback((x: CalendarFeedInfo) => {
    setInfo(x);
    const kept = remembered(session);
    if (x.urls) { setUrls(x.urls); remember(session, x.urls, x.createdAt); }
    else if (!x.enabled || (kept && kept.createdAt !== x.createdAt)) { setUrls(null); remember(session, null, null); }
  }, [session]);
  useEffect(() => { if (live) void window.dex.request('cal.feed.get').then(adopt).catch(() => {}); }, [live, adopt]);
  const act = async (fn: () => Promise<CalendarFeedInfo>, ok: string) => {
    setBusy(true);
    try { adopt(await fn()); toast(ok); } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const copy = (text: string) => { void navigator.clipboard.writeText(text).then(() => toast('Calendar address copied')).catch(() => toast('Could not copy. Select the address and copy it.', true)); };

  // on the office network: the address this PC reaches the hub at, which colleagues' PCs and phones on the Wi-Fi share
  const office = urls ? (state.via !== 'remote' && state.hub?.host ? `https://${state.hub.host}:${state.hub.port}${urls.path}` : urls.office[0] ?? null) : null;
  const outside = urls ? (info?.gateway ? `${info.gateway.replace(/\/+$/, '')}${urls.path}` : urls.outside) : null;
  const best = outside ?? office;

  return (
    <section>
      <h3>Calendar</h3>
      <div className="setting">
        <Icon name="calendar" className="lead" />
        <div className="txt">
          <div>Show my meetings in Outlook or on my phone</div>
          <div className="faint">A private address for your calendar app to subscribe to. It lists the meetings you organise or are invited to, with their meeting links, and picks up changes and cancellations. Your calendar app cannot change anything here.</div>
        </div>
        <Toggle label="Private calendar feed" checked={!!info?.enabled} onChange={(on) => void act(() => window.dex.request('cal.feed.set', { enabled: on }), on ? 'Calendar address made' : 'Calendar address turned off: calendars subscribed to it stop updating')} />
      </div>

      {info?.enabled && (urls ? (
        <>
          {outside && <FeedUrl label="From anywhere" url={outside} hint="Through the office's gateway. Best for phones and for Outlook at home." onCopy={copy} />}
          {office && <FeedUrl label="On the office network" url={office} hint={outside ? 'Works only while you are at the office.' : 'Works while you are on the office network. Your administrator can turn on access from outside for phones on mobile data.'} onCopy={copy} />}
          <div className="cf-how">
            <div>
              <span className="label"><Icon name="laptop" size={14} />Add to Outlook</span>
              <ol>
                <li>Copy the address above.</li>
                <li>In Outlook, open the Calendar and choose <b>Add calendar ▸ Subscribe from web</b> (in classic Outlook: <b>Add calendar ▸ From internet</b>).</li>
                <li>Paste the address and name it Dexterity Connect.</li>
              </ol>
            </div>
            <div>
              <span className="label"><Icon name="mobile" size={14} />Add to phone calendar</span>
              <ol>
                <li><b>iPhone:</b> Settings ▸ Calendar ▸ Accounts ▸ Add Account ▸ Other ▸ Add Subscribed Calendar, then paste.</li>
                <li><b>Android:</b> open Google Calendar on a computer, choose <b>Other calendars ▸ + ▸ From URL</b> and paste; it appears on the phone.</li>
              </ol>
            </div>
          </div>
          <p className="cf-note"><Icon name="lock" size={13} /><span>Anyone with this address can see your meeting titles and times, so keep it to yourself. Calendars refresh it every hour or so.{best === office && !outside ? ' The hub uses its own certificate on the office network; if Outlook will not subscribe, ask your administrator to turn on access from outside.' : ''}{outside ? ' Through the gateway, the office\'s gateway passes your calendar on in readable form.' : ''}</span></p>
        </>
      ) : (
        <div className="setting">
          <Icon name="info" className="lead" />
          <div className="txt"><div>The address is shown only on the device that made it</div><div className="faint">The hub keeps a fingerprint of it, not the address. Make a new one to see it here: the old address stops working, so subscribe again with the new one.</div></div>
          <button className="btn" disabled={!live || busy} onClick={() => void act(() => window.dex.request('cal.feed.reset'), 'New calendar address made')}>Make a new address</button>
        </div>
      ))}

      {info?.enabled && (
        <div className="setting">
          <Icon name="refresh" className="lead" />
          <div className="txt">
            <div>{info.lastFetchedAt ? `A calendar app last fetched it ${relativeTime(info.lastFetchedAt)}` : 'No calendar app has fetched it yet'}</div>
            <div className="faint">Shared it by mistake? Make a new address: the old one stops working at once.</div>
          </div>
          {urls && <button className="btn" disabled={!live || busy} onClick={() => { if (confirm('Make a new calendar address? The old one stops working at once, so Outlook and your phone need the new one.')) void act(() => window.dex.request('cal.feed.reset'), 'New calendar address made: the old one no longer works'); }}>Make a new address</button>}
        </div>
      )}
    </section>
  );
}

function FeedUrl({ label, url, hint, onCopy }: { label: string; url: string; hint: string; onCopy: (u: string) => void }) {
  return (
    <div className="cf-url">
      <span className="label">{label}</span>
      <div className="cf-url-row">
        <input className="input mono selectable" readOnly value={url} aria-label={`Calendar address, ${label.toLowerCase()}`} onFocus={(e) => e.currentTarget.select()} />
        <button className="btn primary" onClick={() => onCopy(url)}><Icon name="copy" size={15} />Copy</button>
      </div>
      <span className="faint">{hint}</span>
    </div>
  );
}
