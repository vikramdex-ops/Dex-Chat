# Dexterity Meet: setup and operations

Dexterity Meet is the public face of meetings in Dexterity Connect. Every meeting has a clean
address that guests open from their invitation:

- `https://dexterity-meet.pages.dev/482-913-207` (by meeting ID), or
- `https://dexterity-meet.pages.dev/p12-design-review` (a name the host chose), or
- `https://dexterity-meet.pages.dev/vikram` (a person's own room).

Each address opens a landing page drawn as one of our drawing sheets. It shows:

- what the meeting is, when (in the visitor's own time zone), and who hosts it;
- a countdown;
- Add to calendar;
- a device check;
- Join.

The guest waits in the lobby until a host lets them in. Guests need no app and no account.

Staff instructions are in [MEETINGS.md](MEETINGS.md). The gateway itself is described in
[REMOTE-ACCESS.md](REMOTE-ACCESS.md).

> **[checked]**: run here, against Cloudflare's local runtime (`wrangler dev` and
> `wrangler pages dev`) and in the automated tests.
>
> **[not tested]**: written from Cloudflare's documentation, not yet run against the real
> service. See section 9.

## 1. Setup

**Set up with Cloudflare** (Control room → Outside the office) puts the meeting site in place
together with the gateway, from one pasted token ([REMOTE-ACCESS.md](REMOTE-ACCESS.md), "Set up with
Cloudflare"). For the meeting site it:

1. finds or makes the Pages project `dexterity-meet` in the office's account (if Cloudflare will not
   make that name, `dexterity-meet-<suffix>`), and remembers it;
2. publishes the site as `wrangler pages deploy` does from `apps/meet-site`: the files by content hash
   (only those Cloudflare does not have yet), `_headers`, and the front door `_worker.js` with its
   `GATEWAY` service binding to `dexconnect-gateway`, sent with the deployment the way wrangler
   sends bindings from `wrangler.jsonc`;
3. saves the address Cloudflare gave the project (`https://dexterity-meet.pages.dev`, or a suffixed
   `*.pages.dev` when another account has the name) as **Meeting site address**;
4. checks it: the site's own files load, and its `/health` reaches the gateway through the binding.

Then check it yourself:

1. Open the meeting site's address (shown in the card) in a browser. It should say *Join a meeting
   with Dexterity Design Services*.
2. In the Meet lens, copy your personal room's link (it ends in your first name).
3. Open it on a phone using mobile data.

Leave **Name on meeting pages** as *Dexterity Design Services* (or change it).

### By hand (fallback)

On a PC with Node.js 22 and a copy of this repository, with a token that has **Account · Cloudflare
Pages · Edit** as well as the Workers permissions: double-click `scripts\release\Deploy-Gateway.cmd`,
paste the token and the **Account ID**. It deploys the gateway Worker, creates the Pages project
`dexterity-meet` and deploys the site, then prints both addresses:

```
Gateway address:       https://dexconnect-gateway.<your-subdomain>.workers.dev
Meeting site address:  https://dexterity-meet.pages.dev
```

If Cloudflare says the name is taken, run `Deploy-Gateway.cmd -SiteName dexmeet-<something>`. The
GitHub workflow **Actions → gateway → Run workflow** does the same with repository secrets. Paste
the meeting site address into **Control room → Outside the office → Meeting site address** and
**Save address**.

Until the site's address is saved, meeting pages are served on the gateway's own address
(`https://dexconnect-gateway…workers.dev/482-913-207`), so nothing breaks while you set up.

What ends up where:

| What | Where | Secret? |
|---|---|---|
| The Cloudflare token | Pasted into **Set up with Cloudflare** and forgotten after the run (or kept in the hub's database with **Keep it on the hub for gateway updates**, never sent to a device); or typed into the deploy script, or a GitHub repository secret; never in the repository | Yes |
| The meeting site's address and the name on pages | The hub's database (Control room), sent to the gateway when the hub connects | No |
| Meeting names, "show the title", the note for afterwards | The hub's database | No |
| Passcodes | The hub's database; in guest links only after `#` | Yes |

### A domain of the office's own, later

The site's address is configuration, not code. To use, say, `meet.dexteritydesign.co.in`:

1. In Cloudflare, open **Workers & Pages → dexterity-meet → Custom domains → Set up a custom
   domain**, enter `meet.dexteritydesign.co.in` and follow the one DNS record it asks for
   **[not tested]**. If the domain's DNS is not on Cloudflare, add the CNAME it shows at your DNS
   provider.
2. When the domain shows **Active**, go to **Control room → Outside the office → Meeting site
   address**, enter `https://meet.dexteritydesign.co.in` and choose **Save address**.

New links use the new address at once. Links already sent keep working:

- links on `dexterity-meet.pages.dev` still reach the same project;
- the gateway sends links on its own address, and old `/m/` links, to the new address.

## 2. How it works

```
 Guest's browser                         Cloudflare (the office's account)                 Office
 ───────────────                         ─────────────────────────────────                 ──────
 https://dexterity-meet.pages.dev/p12-design-review#Hx7kP2qR
        │  (the #passcode never leaves the browser)
        ▼
 ┌──────────────────────────────┐   service binding   ┌──────────────────────────────┐
 │ Pages: dexterity-meet        │ ──────────────────► │ Worker: dexconnect-gateway    │
 │  /assets/*  its own files    │   (inside           │  /<ref>        landing shell  │
 │  everything else ──────────► │    Cloudflare)      │  /api/m/<ref>  page.info      │◄──── one outbound
 └──────────────────────────────┘                     │  /api/m/<ref>/check  passcode │      WebSocket from
                                                      │  /api/m/<ID>/ws  guest socket │      the hub (TLS,
                                                      │  /w/<ref>…     webinar pages  │      pinned key)
                                                      └──────────────────────────────┘
                                                                 │ "w" and "g" frames
                                                                 ▼
                                                      hub: meet-public.ts (names, what a page may
                                                      learn), meet-guests.ts (the guest's session)
```

The parts:

- **The landing page** (`apps/gateway/meet/landing.ts`, `landing.css`) is one small shell for
  every meeting. The HTML holds no meeting data. The page asks `/api/m/<ref>` for what it may
  show, and POSTs the passcode to `/api/m/<ref>/check`.
- **The meeting itself** (`apps/gateway/meet/room.ts`, the old guest page) loads only when the
  guest presses Join. Before Join the page downloads about 52 KB of script and 24 KB of styles
  (about 19 KB and 6 KB compressed) plus one 32 KB font; the meeting adds 19 KB (8 KB compressed)
  on Join. No framework. The living drawing (`plate.ts`) is about 11 KB of that script.
- **The hub answers** in `apps/hub/src/meet-public.ts`. It resolves the name or ID, works out the
  state (upcoming, open, live, ended, cancelled) from the Calendar and the live Room, and builds
  the answers.
- **The guest socket** is unchanged (`meet-guests.ts`): the passcode, the lobby, then only that
  meeting.
- **Files are named after their content** (`landing.3f9a1c2b.js`), so browsers keep them for a
  year. The HTML is never cached.

### Why a Pages project bound to the Worker

The browser must only ever see the clean address. We looked at three ways:

| Option | Free? | Clean address on day one | Moving parts | Chosen |
|---|---|---|---|---|
| **Pages site + service binding to the gateway Worker** | Yes | `*.pages.dev` | Two deploys (one script) | **Yes** |
| Worker on a custom domain or route | Yes, but needs a domain on Cloudflare | No (a domain must be bought and moved first) | One deploy | Later, optional |
| Pages Function that `fetch`es the Worker's `workers.dev` address | Yes | Yes | Two deploys | No |

The Pages project is the only free way to get a clean `*.pages.dev` address. Its front door
(`apps/meet-site/src/worker.ts`, built to `_worker.js`) serves the pages' files itself and passes
everything else to the gateway through a **service binding**.

Why a service binding:

- The call stays inside Cloudflare. It never goes over the public internet to `workers.dev`.
- It keeps the request's own address, so the gateway builds every link, redirect and CSP for the
  clean host.
- It carries the WebSocket for the meeting, and adds no cost or delay of note.

A Pages Function that fetched the Worker's public address would work too, but it does an extra
public hop, and it puts the Worker's address into configuration.

Serving the Worker on a custom domain needs a domain on Cloudflare first. The design above is
ready for one: add the domain to the Pages project, as in section 1.

**Fallbacks.** If the Pages site lacks a file (the gateway was deployed after it), the gateway
serves its own copy: every page file is also built into the Worker. Before a site address is set,
the gateway serves the whole site itself.

## 3. Security in plain words

### What we protect

The office's people, meetings and network. A meeting page is public: anyone can type an address.
So:

- **Before a valid passcode, a page learns only what the host allowed.** By default that is the
  date and time and "Meeting with Dexterity Design Services".
- **The title and the host's first name** are shown before the passcode only when the host leaves
  **Show the title on the invitation page** on.
  - It is **on by default for scheduled meetings.** Invitations go to named people, the title is
    already in their calendars, and a guest who opens the link wants to know they are in the
    right place.
  - It is **off for instant meetings and personal rooms.** Their titles are often working names
    ("Leak at client X"), and their links get pasted into chats.
- **Never exposed, before or after the passcode:**
  - attendee lists, other than people's first names once the guest has been let in;
  - email addresses;
  - internal ids, other than the nine-digit meeting ID;
  - the hub's address, and anyone's IP address;
  - conversation contents and other meetings.
- **One answer for nothing here.** Before a passcode, an unknown name, a meeting that ended, one
  that was cancelled and one whose link is off all get the same answer (`{"found":false}`), and
  the page reads the same for each. A wrong passcode, an unknown name and a switched-off link all
  get the same refusal. With the right passcode, the guest may learn that the meeting was
  cancelled or has ended.

### The rules, and where they are enforced

1. **Two questions only.** The site answers `page.info` (before a passcode) and `page.check`
   (after it). The hub builds both answers from a fixed list of fields. The gateway then passes
   **only** those fields, whatever the hub sends, so a mistake on the hub cannot leak through the
   site. The answers are never cached.
2. **The passcode** is in the link's `#fragment`, which browsers never send to a server, or typed
   on the page.
   - It reaches the office only in the body of the check request and the meeting socket's first
     frame.
   - The page takes it out of the address bar at once, so a shared screen does not show it.
   - Calendar links to Google and Outlook.com never carry it; the downloaded `.ics` file does,
     since it stays on the guest's computer.
   - The office's calendar feeds never carry it.
3. **Limits.**
   - **Per address, at the gateway.** 60 page questions a minute. 30 names that lead nowhere in
     10 minutes. **5 wrong passcodes in 10 minutes**, counted together with the guest socket's
     (the existing `guestFails`) and kept in the Durable Object's storage. After that, both the
     page and the socket are refused for 10 minutes.
   - **Per meeting.** 240 page questions a minute at the gateway. On the hub, 50 wrong passcodes
     in 10 minutes pause that meeting's checks for one minute, and the flood is audited
     (`meeting.passcodeFlood`).
   - The hub's own limit of 10 wrong passcodes per address applies to the socket as before.
   - Passcodes are 8 characters from a 54-letter alphabet (about 46 bits), so guessing is out of
     reach even across many addresses. The pause is short so that a flood cannot keep real guests
     out for long.
4. **Headers on every page:**
   - `Content-Security-Policy` with `default-src 'none'`, `script-src 'self'`, `style-src 'self'`,
     `font-src 'self'` and `connect-src 'self' wss://<this host>`. No inline code, no `eval`, and
     no request to any other host: no fonts CDN, no analytics. The fonts (Outfit, JetBrains Mono)
     are served by the site.
   - `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
   - `Referrer-Policy: no-referrer`.
   - HSTS for a year.
   - `X-Content-Type-Options: nosniff`.
   - `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy: same-origin`.
   - `X-Robots-Tag: noindex`.
   - `Permissions-Policy`: camera, microphone and screen capture for this page only; geolocation,
     payment and USB for nobody. Webinar pages, which only watch, get no camera or microphone.
5. **Names (slugs).**
   - 3–40 characters: `a`–`z`, `0`–`9` and single hyphens, starting with a letter. A name can
     never look like a meeting ID.
   - Accents are dropped (é → e); any other letter is refused. A Cyrillic "а" never becomes a
     Latin "a", so a look-alike address cannot be made.
   - The site's own words are kept (`api`, `assets`, `w`, `m`, `admin`, `login`, `help`, …), as
     are names that would look official or like another product (`dexterity-…`, `zoom`, `teams`, …).
   - Names are unique.
   - **A released name** (renamed, cleared, or its meeting cancelled or over) keeps leading only
     to the meeting it named, and only that meeting's host can take it back, for **30 days**.
     After that anyone may use it. A name never routes to someone else's next meeting in between.
6. **Guests on the hub** are as before:
   - one session per guest, scoped to one meeting, with no account;
   - always admitted through the lobby, whatever the meeting's lobby rule;
   - audited: knocked, joined, removed.

   New: a guest with the right passcode is refused, with words, when the meeting was cancelled,
   has ended, or is not open yet (the room opens ten minutes before a scheduled start).
7. **The gateway's own address answers no meeting questions** once the site is set. It only
   redirects pages there. Only the hub that owns the meeting pages (the same certificate) can set
   or change the site's address.

### Accept knowingly

- Anyone who has a link with its passcode can ask to join. The lobby is the control.
- Readable names can be guessed. When the title is shown, a guessed name tells the title and the
  host's first name, as well as the time. Hosts who mind leave the title hidden or use the ID.
- Traffic passes through Cloudflare. The page and its questions are TLS to Cloudflare. Meeting
  media goes browser to PC (WebRTC, DTLS-SRTP), never through the gateway.

Tests for each rule: `apps/hub/test/meet-public.test.ts`, `apps/gateway/test/gateway.test.ts`,
`packages/core/test/meetlink.test.ts` and the end-to-end `apps/desktop/e2e/meetlink.mts`. They
include the leak cases: no title when hidden, no host name, no attendees, no email, no hub id, in
the DOM and in every network answer.

## 4. What a guest sees

Every state is the same drawing sheet:

- a border with grid references;
- the work column on the left;
- on the right, a living drawing about this meeting and this visitor
  (`apps/gateway/meet/plate.ts`), and the title block in the corner (meeting, date, time in their
  zone and at the office, host, ID, status). On a desktop both stay in view as the visitor works
  down the form; on a phone they come after it.

The living drawing has three parts, all drawn in code:

1. **Time, dimensioned.** The meeting's slot on a day ruler with two parallel scales: the
   visitor's time above, the office's below, like a dual-unit dimension. A NOW cursor moves along
   it. Before the start, a dashed leader from NOW to the start carries the countdown, and the ten
   minutes the room is open early are hatched. While the meeting runs, the elapsed part is hatched
   in amber. When it is over, its length is dimensioned. A repeating meeting shows its next time;
   a cancelled one has a revision cloud round the slot with a CANCELLED note.
2. **Readiness, as instrument tags.** CAM, MIC, SPK and NET as ISA bubbles on a loop to a YOU
   node: hollow until checked, then teal with a tick. MIC draws a live trace from the level meter;
   SPK fills after "Test speakers"; NET is a real round trip to the site (`/health`, three times,
   the middle one, every 20 seconds). Before the passcode only NET and the clock are live.
3. **A revision block that fills itself:** drawn when the page opens; CHECKED with the visitor's
   name when all checks pass; AWAITING APPROVAL in the lobby (a quiet blink); APPROVED FOR ENTRY
   when the host lets them in (a stamp plotted over the opening meeting for a moment, and kept in
   the block); ISSUED with the time spent, after the meeting.

The drawing shows only this meeting's times and the visitor's own checks, never anything about
other people. It is decorative for screen readers; the same information is in a text caption kept
current beside it. Reduced motion stops the cursor's glide, the leader and the blink.

Light and dark follow the system or the page's switch. The page works at 390 px and on a desktop.

| State | What the page says and does |
|---|---|
| No passcode yet | "Meeting with Dexterity Design Services" (or the title, if shown), the date and time in the visitor's zone with the office's zone noted when it differs, a countdown, a passcode field, Add to calendar, and "At Dexterity? Open in Dexterity Connect" |
| Nothing here | "No meeting to show here yet", a passcode field, and a box for another meeting's ID or name. The same for an unknown name, a meeting that ended, one that was cancelled and a switched-off link |
| Before the room opens | The whole title block and a live countdown. "The room opens at 09:50", with the plan being plotted, quietly, over and over. Calendar file, Google Calendar, Outlook.com. The device check; name; Join, greyed out until the room opens, which it does by itself |
| Open, or in progress | "The room is open", or an amber "In progress since 10:02". Name and Join; "Open in Dexterity Connect" for staff |
| Device check | Camera preview with its zone caption; the mic level as a ruled scale; Mic and Camera on or off; Test speakers (two notes, through the speakers chosen where the browser allows); Choose devices (camera, microphone, speakers) |
| Lobby | "The host will let you in" when a host is in the meeting; otherwise "The host has been told" (the host is not in yet, has been notified, and lets them in from wherever they are; [MEETINGS.md](MEETINGS.md), *Who is waiting*). An amber timer for how long they have waited, "your place is held while this page is open", a small preview, Mic, and Leave the lobby. It changes by itself when a host comes in. The plan shows them at the door |
| Let in before the host | A host can let a guest in from Nib's card or the app's indicator before opening the room: the guest opens it and sees "HOST · ON THE WAY: Priya Raman let you in and has been told you are here" until a host joins |
| In the meeting | The meeting itself (tiles in zones, shared screen, chat, hand, reactions), loaded on Join. The chat says that the office keeps it with the meeting; Attach sends a file to it (up to 25 MB, and the office's blocked types and upload limit apply, checked by the hub before it is stored). Guests cannot come back to the chat after leaving; the organiser may email them the recap ([MEETINGS.md](MEETINGS.md), *Meeting threads, action points and recaps*). The chat box grows with the text (six lines, then it scrolls; Enter sends, Shift+Enter is a new line). Over a screen shared from the office app, **Ask for control** (with a mouse and keyboard); the presenter decides, and the guest then works on it with **Release** to give it back. A screen the guest shares is view only, and the page says so ([MEETINGS.md](MEETINGS.md), *Give control*) |
| Reconnecting | "Reconnecting…" over the meeting; up to six tries. The host may need to let them in again |
| Refused, removed, passcode, too many tries | Plain words for each, and what to do |
| Closing page | "Thanks for joining", time in the meeting, when they left, the host's note ("Afterwards"), the next time of a repeating meeting with Add the next one, and Join again while the meeting runs |
| Cancelled | "This meeting was cancelled", with a revision cloud on the plan (after the passcode) |

The page updates itself every 15 seconds while it is open, and when it is shown again. A
reschedule, a cancellation, or the host arriving shows up without a reload. The guest keeps what
they typed.

Accessibility:

- everything works from the keyboard;
- each view moves focus to its heading;
- changes are announced in a live region; the countdown has a label rather than ticking aloud;
- contrast is AA in both themes;
- reduced motion stops the plotting and the pulses.

Browsers: Chrome, Edge, Firefox and Safari 16 and later. The page checks for each feature before
using it (speaker choice, `AudioContext`, screen sharing).

## 5. Day to day

**Hosts (in the app)**

- **Calendar → New meeting**, held as a call:
  1. Switch on **Guests from outside can join from a browser**.
  2. Give it a name (checked as you type), or take the one suggested from the title
     (**Use …/fst-project-handover**: it fills the field and is checked like a typed name; a name
     already taken says so and is not kept, and what you typed stays), choose **Show the title on
     the invitation page** and the lobby rule. Clearing the name puts the page back at the
     meeting ID. A clipboard that refuses a copy says so.
  3. Save. The dialog stays open on the invitation: the clean link with its passcode,
     **Copy invitation** (text), **Download invitation (.ics)** and **Send by email**.
- **Send by email** opens the invitation as a draft in the PC's mail program (Outlook, Windows Mail,
  Thunderbird): the app writes an `.eml` file to a temporary folder (removed after a day) and opens
  it. The draft has the subject "Invitation: P-12 design review · Wed 18 Nov, 3:00 PM IST", the
  invitation as text and as a formatted message (a button to the meeting page, the meeting ID, the
  passcode when the link carries it, "nothing to install", a tip to check the camera and
  microphone early), and the `.ics` attached (`METHOD:PUBLISH`, so the guest's calendar adds it
  rather than treating the draft as a meeting request from them). The guest's address is left for
  you to fill in. Where no mail program opens drafts, and on phones, a plain email opens through
  `mailto:` without the attachment, and the app says so. Webinar registrants get the same, addressed
  to them, from the **Send by email** button on their row.
- **Editing the meeting** keeps everything. The same block lets you:
  - rename the page;
  - renew the passcode (old links stop working);
  - change the title setting;
  - leave a note for afterwards.
- **Moving the meeting** in the Calendar moves the page's time. Invitations and the calendar feed
  keep their UID, so calendars update the entry instead of adding a second one.
- **Cancelling** shows "This meeting was cancelled" to anyone who opens the link with the
  passcode, and on any page already open.
- **The Meet lens** shows each coming meeting's page with a copy button. **Your personal room** is
  named after you (`…/vikram`; `…/vikram-shah` when the first name is taken). Change it under
  **Change the name**; turn guests on under **Guests from outside**.
- **Ten minutes before a call**, the reminder's notification opens the meeting's Room directly.

**Staff opening a meeting link** (from Outlook, or from the calendar feed, which carries the
clean link without the passcode) get the landing page. **Open in Dexterity Connect** opens it in
the app (`dexconnect://meet/<ID>`).

**Old links** (`https://<gateway>/m/<ID>#<passcode>`) open the new page, passcode included.

## 6. Calendar integration

- **Invitations** (`packages/core/src/ics.ts`):
  - `UID:meeting-<ID>@dexconnect`: one per meeting, the same in the app's file and in the page's
    "Calendar file".
  - `URL`: the clean link with `#passcode`.
  - `LOCATION`: the place, if any, and the clean link without the passcode, since locations show
    on shared screens.
  - `DESCRIPTION`: the link, the passcode on its own line, the app link and the meeting ID.
- **The office calendar feed** (`/cal/<token>.ics`, `apps/hub/src/calfeed.ts`) carries the clean
  link, by name or ID and **without the passcode**, in `URL`, `LOCATION` and the description,
  beside the app link. Feeds are copied by Google and Outlook, and staff do not need a passcode.
- **Zoho Calendar sync** (`apps/hub/src/zoho.ts`, [`ZOHO-CALENDAR.md`](ZOHO-CALENDAR.md)) writes the same
  description and place as the feed (`CalendarFeeds.details`): the clean link and app link, **never the
  passcode**, into each person's own Zoho calendar.
- **The page's Add to calendar**:
  - the `.ics` file has the passcode, since it stays on the computer;
  - the Google Calendar and Outlook.com links carry the link without it, with "the passcode is in
    your invitation".

## 7. Troubleshooting

| What you see | What to do |
|---|---|
| **Set up with Cloudflare** stops at *Meeting site project* with a missing permission | The token lacks **Cloudflare Pages · Edit**. Edit the token in Cloudflare, add it, then **Retry** |
| It stops at *Check* with "The meeting site does not reach the gateway yet" | A new project can take a minute to go live. **Retry** in a few minutes; if it persists, check the gateway `dexconnect-gateway` is in the same account |
| The deploy script stops at the meeting site: "Authentication error" or "not allowed" | The token lacks **Cloudflare Pages · Edit**. Add it and run the script again |
| "Cloudflare would not create the Pages project" (deploy script) | The name `dexterity-meet` is taken by another account. Run `Deploy-Gateway.cmd -SiteName <another>` and paste that address |
| The site says "This meeting site is not connected to the office's gateway yet" | The Pages project has no binding to the Worker. Check that the gateway was deployed in the **same** Cloudflare account under the name `dexconnect-gateway`, then run the script again |
| The site says "The office is not connected right now" | The hub is off, or access from outside is switched off. See Control room → Outside the office |
| Links still show `…workers.dev` | The meeting site address is not saved in the Control room |
| A guest sees "No meeting to show here yet" | The link is off for that meeting, the meeting is over, or the address is mistyped. Ask them for the passcode, or send the invitation again |
| "Too many tries from your network" | Five wrong passcodes from that network in ten minutes. It clears by itself after ten minutes |
| A guest sits in "Reconnecting…" | Their network dropped, or the hub restarted. The page tries six times; then "Join again" |
| A name is refused | Taken, kept for the site, or used by someone else within the last 30 days. The field says which and, for the last, from when it is free |

## 8. Developing

```
node apps/gateway/scripts/build-guest.mjs   # the pages into the Worker (wrangler runs it too)
node apps/meet-site/scripts/build.mjs       # the Pages site into apps/meet-site/dist
npm run dev -w @dex/gateway                 # wrangler dev: the gateway serves the site itself
```

To run the production topology locally, start the gateway's `wrangler dev`, then
`wrangler pages dev` in `apps/meet-site`. Set the same `WRANGLER_REGISTRY_PATH` for both, so that
the site's service binding finds this gateway and not another one running on the PC. The
end-to-end test does exactly that.

## 9. What was tested, and what was not

Automated, on the development PC (15 November 2026):

- **Core:** names, look-alike letters, reserved words, addresses and calendar links (9 tests).
- **Hub** (`meet-public.test.ts`, 7 tests):
  - names: unique, released with the grace period, reclaimed;
  - personal room names;
  - what a page learns before and after the passcode, with leak checks;
  - one answer for unknown, ended, cancelled and switched off;
  - the meeting's flood pause;
  - reschedule, cancellation and the guest socket;
  - clean links in guest links and feeds, with no passcode in feeds.
- **Gateway in Cloudflare's local runtime** (`gateway.test.ts`, 7 tests):
  - the shell and its headers, assets, canonical addresses and old links;
  - the page's questions, with the field allowlist and per-address limits;
  - the shared lockout;
  - the site taking over from the gateway's address, and only the owning hub setting it.
- **End to end** (`apps/desktop/e2e/meetlink.mts`) through `wrangler pages dev` bound to
  `wrangler dev`: the whole walk in section 4. It covers scheduling with a name, the invitation
  and `.ics`, both title settings with DOM and network leak checks, the device check, waiting, a
  reschedule, the lobby, sound and video both ways, a dropped line, the closing page, a personal
  room, an old link, a cancellation, nothing here, and the lockout. Screenshots at 1440 and 390,
  light and dark.

- **Set up with Cloudflare** (17 November 2026): the hub's deployment of the site to a stand-in for
  Cloudflare's API (`apps/hub/test/cfdeploy.test.ts`: manifest and hashes, the bundle's `GATEWAY`
  binding, taken names, an existing project reused, a failed deployment retried without a second
  project), and what it uploaded run in `wrangler dev` with the gateway it deployed
  (`cfdeploy-workerd.test.ts`: the site's files, `/health` through the binding, a meeting page with
  its CSP). The card in the app: `apps/desktop/e2e/cfsetup.mts`.

**Not yet run for real:**

- an actual Cloudflare Pages deployment and its service binding in production;
- `wrangler pages project create` and `pages deploy`, and the hub's own Pages direct upload, with a real token;
- the token's Pages permission;
- a custom domain;
- Safari and Firefox, other than by feature checks (the tests use Chromium);
- the PowerShell script on Windows.

Run **Set up with Cloudflare** (or section 1 by hand), then join a meeting from a phone on mobile data, before telling staff.
