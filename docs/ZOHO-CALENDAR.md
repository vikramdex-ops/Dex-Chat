# Zoho Calendar

*November 2026. Code: `apps/hub/src/zoho.ts` (sync), `packages/core/src/zoho.ts` (types, data centres, times),
`apps/desktop/src/main/zoho.ts` (sign-in on the PC), `apps/desktop/src/renderer/views/ZohoCalendar.tsx` (screens).
Tests: `apps/hub/test/zoho.test.ts` and `apps/desktop/e2e/zoho.mts`, both against `apps/hub/test/zoho-mock.ts`.*

The office uses Zoho Mail, so people's appointments live in Zoho Calendar. Dexterity Connect syncs with it,
**beside** the private calendar feed (`/cal/<token>.ics`, Preferences → Calendar, `docs/DEXTERITY-MEET.md` §6),
which stays for Outlook and phones.

- **Dexterity → Zoho.** Every meeting you organise, or said **Going** to, appears in the Zoho calendar you chose,
  and follows every change, cancellation and decline.
- **Zoho → Dexterity.** Your Zoho events for the next four weeks show in your Calendar, hatched and read-only.
  Colleagues planning a meeting see that time as busy (no title), and you show as *In a meeting* during them.

> **Status.** Everything below is built and tested against a mock Zoho server that implements the endpoints as
> Zoho documents them. **It has not been run against the real Zoho.** It works for real only once a person has
> registered the office's Zoho OAuth client ([Setting it up](#setting-it-up-one-step-for-the-office)), and the
> points under [Not yet verified with real Zoho](#not-yet-verified-with-real-zoho) should be checked then.

## What each person does

Nothing is set up per person by an administrator. Members (never guests) see **Connect Zoho Calendar**:

- on a card above the week in the **Calendar** lens ("See your Zoho Calendar here"; *Not now* hides it);
- at the top of **Preferences → Calendar**;
- in a one-time message from Dexterity Connect (in Pulse) when the office's Zoho client is first saved.

Before the client is saved, the button is shown **disabled**, with "Your office's Zoho connection isn't set up yet."

1. Click **Connect Zoho Calendar**. The browser opens Zoho's sign-in and consent page.
2. Sign in and allow access. The browser shows "Zoho is connected. You can close this tab."
3. The app shows **Connected as `you@yourcompany.com` · last synced just now**. The first sync has already run.

Preferences → Calendar then offers **Sync now**, the calendar to copy meetings into (the Zoho default calendar
unless you choose another), the counts, any problem in words, and **Disconnect**. If Zoho stops accepting the
connection, the Calendar card and Preferences turn amber with **Reconnect Zoho Calendar**, and you get one
message about it. Reconnecting copies what was missed and duplicates nothing.

Connecting starts on the Windows app, which receives Zoho's answer on the PC (below). The phone app shows the
status, but says to connect from the PC.

## Setting it up: one step for the office

**Why it can't be avoided.** Zoho lets an app reach someone's calendar only through an OAuth client, and a client
always belongs to a Zoho account, which registers it in Zoho's API console and gets its Client ID and secret.
Dexterity Connect has no Zoho account of its own, and putting a shared client in the code would mean committing
a secret. So the office registers one client once. After that, people connect themselves.

1. Sign in at **https://api-console.zoho.in** (India; the address for other regions is shown in the Control room)
   with the office's Zoho administrator account.
2. **Add Client → Server-based Applications.**
   - Client name: `Dexterity Connect`.
   - Homepage URL: the office's website.
   - **Authorized Redirect URIs:** `http://127.0.0.1:47917/zoho/callback`, exactly as written. The Control room
     shows it with a Copy button.
3. **Create.** If any colleague's Zoho account is in another region, open the client's **Settings** and turn on
   **Multi-DC** for those regions.
4. In Dexterity Connect: **Control room → 11 Integrations → Zoho Calendar**.
   - **Zoho data centre:** India (the default).
   - Paste the **Client ID** and **Client secret**.
   - Click **Save and invite everyone**.

Scopes asked of each person: `ZohoCalendar.calendar.READ`, `ZohoCalendar.event.ALL`, `AaaServer.profile.Read` (the
last one only to show which account is connected).

The same section lists who is connected, with their Zoho email, calendar, last sync and any error. It never
shows event titles or times. **Zoho Calendar for everyone** off pauses every connection without forgetting it.
Saving a **different** Client ID asks everyone to reconnect, since tokens belong to the client that issued them.
**Remove secret** stops syncing until a secret is saved again.

## How it works

### Why these choices

| Question | Choice | Why |
| --- | --- | --- |
| Client type | **Server-based** (Authorization Code with client secret) | The refresh token must live on the hub so sync runs while the person's PC is off. Zoho's PKCE types (client-based and mobile) are meant for tokens kept on the device. A self client is one person's own. Non-browser (device code) needs a code typed in for every person. |
| Where Zoho returns | `http://127.0.0.1:47917/zoho/callback`, on the person's PC | The hub is on the office LAN, so Zoho's servers can't reach it, and the gateway would be a second moving part. The browser that signs in runs on the same PC as the app, so a loopback address reaches the app with nothing exposed. Zoho requires a redirect beginning with `http://` or `https://` that exactly matches the registered one. Loopback is not mentioned either way (see below). |
| Who exchanges the code | **The hub**, with the client secret | The secret never reaches a PC. The app hands the code (good for two minutes, once) to the hub over its signed-in connection. |
| PKCE | Not used | Zoho documents PKCE only for client-based and mobile clients. The protection comes from a 256-bit `state` the hub issues, bound to the person and good for ten minutes and one use, checked by both the app and the hub. |
| Which meetings | Organised by you, or answered **Going** | Pending invitations and *Maybe* would fill Zoho with meetings you may not attend. Declining removes the copy, and saying Going again brings it back. |
| Attendees in Zoho | Not sent | Each person gets their own copy in their own calendar. Listing attendees would make Zoho email them and create second copies. |
| Repeats | Zoho's `rrule` when it gives the same days, else one Zoho event per time for the next 90 days (60 at most) | Daily, weekly, weekdays (starting on a weekday) and monthly up to the 28th map exactly. A monthly meeting on the 29th–31st moves to the month's last day in Dexterity, while a rule would skip the month. |
| Time zone | Times sent in UTC (`yyyyMMdd'T'HHmmss'Z'`), with the meeting's zone (or the office's) as `timezone` | A 10:00 meeting in Chennai is sent as `…T043000Z` with `Asia/Kolkata`. Repeats use the hub's zone, the one Dexterity counts them in. |
| Meeting link | The clean meeting page and app link, **never the passcode** | Zoho calendars are shared and copied, exactly like feeds (`docs/DEXTERITY-MEET.md` §6). The description and place are made by the same code as the feed (`CalendarFeeds.details`). |
| Edited in Zoho | **Dexterity wins.** The change is put back on the next sync, and the person is told once per meeting. | One source of truth for the office's own meetings. A move made in Zoho would not tell the other invitees. |
| Deleted in Zoho | Made again, with a message: "To leave it, decline it in Dexterity Connect." | Same rule. Declining is the way out and tells the organiser. |
| Zoho → Dexterity | The chosen calendar, read-only, for the person only, as busy time for others | Event contents never leave the person's own view. Free/busy, "In a meeting" and Nib's busy rule see the time, not the title. |

### Direction by direction

| | Dexterity → Zoho | Zoho → Dexterity |
| --- | --- | --- |
| Created | Copied within seconds (a change marks the people concerned, a short timer runs the sync) | Read every 10 minutes and on **Sync now** |
| Changed | The same Zoho event is updated with its etag (no duplicates) | Shown as changed at the next read |
| Cancelled, declined, taken off | The Zoho event is deleted | Gone at the next read |
| Repeats | `rrule`, or one event per time | Each time shown (`byinstance=true`) |
| All-day | `isallday` with dates | Shown on the all-day row; not counted as busy for others (holidays, birthdays) |
| Marked free in Zoho (`transparency = 1`) | — | Not shown |
| Edited in Zoho | Put back (Dexterity's version) | — |
| Past meetings | Left as they are in Zoho | Kept 7 days, then dropped |

### Data on the hub

- `zoho_accounts`: one row per connected person, holding:
  - their data centre, accounts server and Calendar API address;
  - the refresh and access tokens, **sealed** (AES-256-GCM with `zoho.key` beside the database, not in it);
  - their email, calendar and status counts, last sync, last error, failures and next try.
- `zoho_map`: (person, meeting, time) → Zoho uid, calendar, etag and a hash of what was sent. This is what
  prevents duplicates across retries, reconnects and hub restarts. Unchanged meetings cost no API call.
- `zoho_external`: the person's Zoho events (title, times, all-day) for the read range.
- `zoho_auth`: sign-ins in progress (state, person, time). Ten minutes, one use.
- The client ID is in `meta`. The client secret is in `meta`, sealed the same way, and is **never returned** to
  any device, logged, or committed.

A database copy alone (a backup) does not carry usable tokens. A hub restored on another PC without `zoho.key`
asks everyone to reconnect, which duplicates nothing.

### Data centres

The client's data centre is chosen in the Control room (default **India**). Each person's own is detected:

- From the redirect's `accounts-server` (accepted only if it is one of Zoho's known accounts servers; anything
  else is refused, and the secret is never sent there).
- Otherwise from `location` (`in`, `us`, `eu`, `au`, `jp`, `ca`, `sa`, `uk`, `cn`).

The code is exchanged at that accounts server. Calendar calls go to the matching Calendar host: India is
`accounts.zoho.in` and `calendar.zoho.in`, the US is `accounts.zoho.com` and `calendar.zoho.com`, and so on
(`ZOHO_DCS` in `packages/core/src/zoho.ts`).

### Reliability

- **Access tokens** last an hour. They are kept and refreshed shortly before expiry. Zoho allows ten per refresh
  token per ten minutes, so they are never refreshed per call. A `401` refreshes once and retries.
- **Revoked or invalid refresh token** (`invalid_code`): the status becomes **Reconnect needed**. The person gets
  one message, and administrators see it in the list.
- **Busy or unreachable** (`429`, `5xx`, network): two retries with doubling waits. Then the run stops, the error
  is shown in words, and the next try waits 1, 2, 4… up to 60 minutes.
- **Stale etag** on an update: Zoho's current etag is fetched, and Dexterity's version is written again.
- **A version Zoho refuses** (other `4xx`): noted, and not retried until the meeting changes. The rest go on.
- **Gentle on limits:** one person at a time, at most 40 writes per run (the rest follow), and reads every 10
  minutes.
- **Someone who leaves the office** is disconnected, and their token is revoked.
- **Disconnect** removes copies of upcoming meetings from Zoho, revokes the refresh token, and forgets the rest.

### Logs

Logs record people's ids, error kinds and HTTP statuses. They never record tokens, codes, the client secret or
event contents.

## What Zoho documents (checked November 2026)

| Topic | What the docs say | Source |
| --- | --- | --- |
| Client types | Server-based (Authorization Code); client-based (implicit, or code with PKCE); mobile (PKCE); non-browser (device); self client | https://www.zoho.com/calendar/help/api/oauth2-user-guide.html |
| Authorization | `GET {accounts}/oauth/v2/auth` with `client_id`, `response_type=code`, `redirect_uri` (must match exactly, start with http:// or https://), `scope`, `access_type=offline` (refresh token), `prompt=consent` | https://www.zoho.com/accounts/protocol/oauth/web-apps/authorization.html |
| Redirect | `code` (two minutes, once), `location`; `accounts-server` in the example; `error=access_denied` when refused | same page; https://www.zoho.com/crm/developer/docs/api/v8/auth-request.html |
| Tokens | `POST {accounts}/oauth/v2/token`, `grant_type=authorization_code`: `access_token`, `refresh_token`, `api_domain`, `expires_in` 3600. Errors `invalid_client`, `invalid_client_secret`, `invalid_redirect_uri`, `invalid_code` | https://www.zoho.com/accounts/protocol/oauth/web-apps/access-token.html |
| Refresh | `grant_type=refresh_token`. Refresh tokens do not expire until revoked. `invalid_code` when revoked. Ten access tokens per ten minutes | https://www.zoho.com/accounts/protocol/oauth/web-apps/access-token-expiry.html |
| Revoke | `POST {accounts}/oauth/v2/revoke/token` with `token` (and `token_type`) | https://www.zoho.com/accounts/protocol/oauth/revoke-refresh-token.html |
| Data centres | accounts.zoho.com, .eu, .in, .com.au, .jp, zohocloud.ca, .sa, .uk; full list at `https://accounts.zoho.com/oauth/serverinfo`; use the user's DC from `location` | https://www.zoho.com/accounts/protocol/oauth/multi-dc.html |
| Calendars | `GET /api/v1/calendars` (`uid`, `name`, `isdefault`, `privilege`), scope `ZohoCalendar.calendar.READ` | https://www.zoho.com/calendar/help/api/get-calendar-list.html |
| Create | `POST /api/v1/calendars/{cal}/events?eventdata={…}` (a query parameter): `title`, `dateandtime{timezone,start,end}` in `yyyyMMdd'T'HHmmss'Z'` or `yyyyMMdd` (all-day), `isallday`, `description` (10,000), `location` (255), `rrule`, `transparency`, `attendees`; answer has `uid`, `etag`. Scope `ZohoCalendar.event.ALL` / `.CREATE` | https://www.zoho.com/calendar/help/api/post-create-event.html |
| Update | `PUT …/events/{uid}?eventdata=…`; `etag` mandatory, in the header or in eventdata; replaces the event | https://www.zoho.com/calendar/help/api/put-update-event.html |
| Delete | `DELETE …/events/{uid}` with header `etag` | https://www.zoho.com/calendar/help/api/delete-event.html |
| Get | `GET …/events/{uid}`: `etag`, `lastmodifiedtime`, times may come back with an offset (`20170722T150000+0530`) | https://www.zoho.com/calendar/help/api/get-event-details.html |
| List | `GET …/events?range={"start":…,"end":…}` (31 days at most), `byinstance=true` for each time of a repeat ("minimal information") | https://www.zoho.com/calendar/help/api/get-events-list.html |
| Header | `Authorization: Bearer <token>` for Calendar (Zoho Mail uses `Zoho-oauthtoken`) | OAuth user guide above |

## Not yet verified with real Zoho

Where the docs are silent, the code is defensive. Check these on the first real connection:

1. **Loopback redirect.** That Zoho's console accepts `http://127.0.0.1:47917/zoho/callback` for a server-based
   client. If it does not, register the gateway instead: an `https://` page on the office's gateway that forwards
   `code`, `state`, `location` and `accounts-server` to the app. This would be a change to `zohoRedirectUri` and
   the app's sign-in, and it is not built.
2. **`state` echoed back.** Zoho's pages don't mention `state`, though it is standard OAuth. The app and hub
   require it.
3. **Calendar host per data centre.** `calendar.zoho.in` and the others are inferred from the pattern of
   `calendar.zoho.com`. The token response's `api_domain` (`www.zohoapis.in`) is recorded in the mock but not used.
4. **Stale-etag answer.** Not documented. `409`, `412`, or a `400` mentioning `etag` are all treated as a conflict.
5. **All-day end date.** Sent as the day after (exclusive, as in iCalendar). If Zoho shows two-day events, send
   the last day instead.
6. **The `UNTIL` format** inside `rrule` (sent as `yyyyMMdd'T'HHmmss'Z'`).
7. **The email scope** (`AaaServer.profile.Read` and `GET {accounts}/oauth/user/info`). If it is refused, the
   person is shown as "Connected" without an email.
8. **Rate limits.** Zoho Calendar publishes none. The hub stays slow on purpose and backs off on `429`.

## Testing

- **`apps/hub/test/zoho.test.ts`** (10 tests) runs against the mock. It covers:
  - times (10:00 IST = 04:30Z, offsets, all-day dates) and repeat rules;
  - the admin form (administrators only, the secret never returned, one invitation);
  - connecting with the account in another data centre, a wrong or foreign `state`, a foreign accounts server,
    *access denied*, and `location` alone;
  - create, change, decline, re-accept, taken off, cancel and repeat, with no duplicates and no needless writes;
  - times written one by one, and all-day meetings;
  - Zoho events in the person's Calendar only, as anonymous busy time for others, *In a meeting*, and the admin
    view without contents;
  - edits and deletions in Zoho put back, including a stale etag;
  - an expired access token, a revoked refresh token (*Reconnect needed*, told once), and reconnecting without
    duplicates;
  - retries on `503` and `429` with backoff;
  - the map surviving a hub restart, a change of calendar, and disconnecting (copies removed, token revoked).
- **`apps/desktop/e2e/zoho.mts`** drives the built app against the same mock. It runs the disabled button, the
  Control room form and invitation, one-click Connect through the real loopback listener, a 10:00 IST meeting
  arriving at 04:30Z, a hatched read-only Zoho event, the Preferences status, 390 px, Reconnect, the people list,
  and Hindi. Test-only switches:
  - `DEX_ZOHO_TEST_DCS` and `DEX_ZOHO_CALLBACK_PORT` point the hub at the mock;
  - `DEXCONNECT_TEST_ZOHO_BROWSER=fetch` (unpackaged builds only) follows the mock's sign-in page instead of
    opening a browser.

  None of these is set in an office.
