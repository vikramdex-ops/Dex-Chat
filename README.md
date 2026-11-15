<p align="center">
  <a href="https://dexterity-admin.github.io/dexterity-connect/">
    <img src="https://raw.githubusercontent.com/dexterity-admin/dexterity-connect/gh-pages/assets/readme-hero.svg" alt="Dexterity Connect" width="100%" />
  </a>
</p>

# Dexterity Connect

Dexterity Design Services' workplace messenger. It runs entirely on the office network, works with the
internet unplugged, and uses its own design language ("Drafting Table", see
[`docs/DESIGN-LANGUAGE.md`](docs/DESIGN-LANGUAGE.md)).

- **Product page:** https://dexterity-admin.github.io/dexterity-connect/
- **Installers and update feed:** https://github.com/dexterity-admin/dexterity-connect/releases
- **Plan, decisions, ratings:** [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md) · Cliq research: [`docs/CLIQ-FEATURE-INVENTORY.md`](docs/CLIQ-FEATURE-INVENTORY.md)

## What works today

| Area | Built |
| --- | --- |
| Sign-in | Windows account, per-device Ed25519 keys (DPAPI-sealed), admin approval with matching device codes, pinned TLS |
| Messaging | Spaces (open / private), Direct (1:1 and groups), side-tracks, @mentions and @everyone, reactions (with office emoji), pins, edit / delete, quote, reply privately, copy a link to a message (shown as a preview card), select several to forward (up to 25 conversations), copy, save or delete, read receipts with Read by…, last seen, typing, drafts, Markdown formatting with a live preview and code highlighting, an emoji picker with skin tones, quick reactions you choose, notices when people join, leave or rename, jump to a date, an Activity feed of replies and mentions, line-number references |
| Desk | Saved messages, reminders (on a message or standalone, for yourself or a colleague, repeating, snooze), messages scheduled to send later (sent by the hub even with your PC off), forwarding with credit, mark unread, polls (single or multiple choice, anonymous, closing time) |
| Organisation | Departments (nested, with heads), designations, reporting lines, extension, phone, seat, joining date, birthday and custom fields; an org chart; profiles beside the Directory; CSV import from Excel or Dexterity Sheets that also covers people who have not joined yet |
| Remote work | Check in from the title bar (office, home, site or client), breaks, change place during the day, live "who's working" on Pulse and on profiles, your timesheet on the Desk, team attendance for managers and administrators, CSV export; forgotten check-outs close at the last activity |
| Calendar | Week grid and agenda, meetings set in another time zone, a second time-zone column, the week starting on Monday, Sunday or Saturday, meetings with invitations and Going / Maybe / Not going, repeating meetings, reminders with a Join card, conference rooms that cannot be double-booked, free/busy while planning, meetings tied to a conversation and announced there, one-click Join into a call |
| Guests | Invite codes for people outside the company, limited to chosen Spaces and their people, approved at once, with access that ends on its own (extend or end it any time) |
| Compliance | Retention for Space and Direct messages, legal holds that keep every version of edited or deleted messages, exports to HTML, CSV or JSON (Direct message text is never exported) |
| Commands | Slash commands in the composer (/remind, /poll, /meet, /call, /status, /checkin, /dnd, /shrug, /help…) and integration commands that call a tool's signed webhook |
| Notes, forms, whiteboards | Shared notes per conversation and personal notes on the Desk (save as you type, never overwrite a colleague, edit in Slate), forms with answers and CSV export, live whiteboards that can be posted as an image, voice notes |
| Privacy | Direct messages are end-to-end encrypted (X25519 + AES-256-GCM, signed by each device's Ed25519 key); the hub only stores sealed envelopes; safety codes to compare in person; your other devices hand history to a new one; each device searches its own Direct messages from an index encrypted with a key in the PC's secure storage (DPAPI on Windows, the Keychain on macOS), deleted on sign-out or when the device is removed (phones keep that index in memory only, until the phone app has secure storage) |
| Outside the office | Phones and home laptops on any network or mobile data reach the hub through the office's own gateway on Cloudflare (no port opened at the office, end-to-end encrypted to the hub, pinned to its certificate); people add their own phone or laptop from **Preferences → Your devices** (a QR code that installs and pairs the phone, or a text code for a laptop; no administrator needed); calls across networks with STUN/TURN (see [`docs/REMOTE-ACCESS.md`](docs/REMOTE-ACCESS.md)) |
| Data protection | Stop or mask card, Aadhaar, PAN and bank numbers and chosen words (on the hub, and on the sender's device for encrypted messages), block file types, allow outside access only from listed networks |
| Personal devices | Add your own phone (a QR code that installs and pairs it) or laptop (a text code) from Preferences → Your devices; no administrator; your other devices are told; several offices on one device |
| Message screens | Link cards under messages for office links, tool links, share paths, meetings and web pages (fetched by the hub, never by the apps), with Open, Join, Copy path, Open folder, open in the tool and Discuss in a side-track, a quiet "no access" note, and the author can remove a card; Restyle a draft as Concise, Formal, Diplomatic, Explanatory or Technical on the PC and accept or reject each revision, or restyle a copy of someone else's message for yourself; Decisions: a question whose options close or ask a follow-up (up to 4 steps), each person walking their own path, with a results sheet, CSV export and an Automations trigger; reaction insights with charts (distribution, who reacted or read, over time, departments, announcements against the office average) that say reactions are not approvals; references: drag a message or file onto another conversation, Pane or the Dock (or Reference in…) to point at it without copying it, shown only to people who can open the source |
| More in messages | Pins that end on their own, kinds of kept messages (To do, Important, Follow up, Reference), hashtags with exact search, start a new Space from a message and its side-track, stickers and office emoji added by anyone (if allowed), forms with file and scan-a-code answers, a document scanner that sends a straightened PDF |
| More for integrations | Message actions in every message's menu, Pulse widgets kept up to date through the Bot API, and a system bot that tells people about their own account |
| Hub-off mode | If the hub PC is down, PCs find each other on the network and pass encrypted Direct messages straight across; everything written meanwhile is added to the hub's history when it is back |
| Files and media | Drag, drop, paste or attach up to the office limit (1 GB by default); stored once on the hub; inline images with a viewer; PDFs in a viewer of their own (big A0/A1 drawing sheets drawn in tiles at screen resolution, fit width or page and 25–800% zoom with wheel and pinch, rotate, a page strip, go to page, search with highlights, copy text, password-protected files; the first page shown in the message); Office files (Word, Excel, PowerPoint) as a card that opens them in their own program; voice notes, video messages and screen recordings that play inline; Open / Save; Files panel |
| Rooms (calls) | Voice and video: up to 8 people PC to PC, and up to 50 through the hub's relay on the office network; background blur and office backgrounds, strong noise suppression (RNNoise, on the PC), add people during a call, screen sharing with a picker, picture-in-picture, a call-quality indicator, recording (everyone is told; kept on the hub with chapters for who spoke when, or saved on the PC), mini-Room, ringing, missed calls, call history on each profile; media peer-to-peer on the LAN and through STUN/TURN from outside |
| Meetings | Meeting IDs and links, personal rooms, the Meet lens, lobby, lock, co-hosts and host controls, hands and reactions, layouts; guests who join from a browser with a passcode link (through the office's gateway, no install, always let in from the lobby); invitations as text or `.ics`; breakout rooms with a timer, notes and a call back; a meeting chat that includes guests; a Recordings shelf with a viewer and sharing; a report for every meeting and office totals, as CSV; the presenter can give control of a shared screen to a colleague (Give control, or answer Ask for control), stopped any time (see [`docs/MEETINGS.md`](docs/MEETINGS.md)) |
| Search | Ctrl+K across people, conversations, commands and message text; a Search screen (Ctrl+Shift+F or a conversation's header) with filters for person, conversation, Direct or Spaces, dates and files; text in images found by OCR on the sender's PC (Spaces only); end-to-end encrypted Direct messages found from each device's own encrypted index of what it received and sent (Hindi and Tamil included), marked "from this device" |
| Presence | Available, Busy, Do not disturb, Invisible, In a meeting (from the Calendar); status emoji; out-of-office with a delegate and an automatic reply; automatic Away on idle or screen lock; last seen; beacon rings |
| Notifications | Native toasts that open the conversation (Android too, with a background connection), taskbar / dock badge, mute per conversation, notify about everything / Direct and mentions / nothing, quiet hours, a choice of generated sounds, hide message text |
| Admin | Control room: approvals, devices, roles, organisation, guests, compliance, policies (edit window, upload limit, PC-to-PC fallback, call recording, meetings, office emoji), default Spaces for new people, reported messages, removing with a reason, turning a group into a Space, usage report, integrations and webhooks, outside-the-office gateway, audit log, update mirror status |
| Backups and leavers | Nightly hub backups to a second disk or a network share, taken while the hub runs, copying only new files, checked after every run and kept by day, week and month, with "Back up now", an alert to administrators after two days without one, and `--restore` that keeps the old data aside (see [`docs/BACKUP.md`](docs/BACKUP.md)); offboarding in one step: every device signed out, Spaces, automations, integrations, reminders, meetings, help tickets and webinars handed to a colleague, messages kept for compliance, "Left the office" in the Directory, and access given back when someone returns; a private calendar feed for Outlook and phones (Preferences → Calendar) |
| Bots you make | Any member makes their own bot on the Desk (Desk → Bots): from a design-office template (plot request, leave note, site visit, RFI log, drawing issue request), a few words drafted by the small model on the PC, a copy of another bot, or blank. Questions are edited visually (choices, checked text, numbers, dates, a person, a file, a confirmation, routes between them) beside a test run that plays the bot with its real cards; JSON stays as an advanced view. Each bot has its own drawn symbol or monogram, a colour, a voice (plain, warm, brief, formal) that words what it says, a greeting by name, quick replies, office hours, and remembers last answers if asked. Keep it private, share it with a Space, or ask an administrator to make it office-wide; edits are revisions that never change a conversation under way; each bot has a page with runs, where people stop and recent runs, and can be paused or retired |
| Automations | Rules for a conversation or every Space, drawn as a schematic and edited part by part: when a file is attached, someone reacts, votes, answers a form or reaches the end of a Decision, writes certain words or mentions someone, then notify people, post, set a reminder or To do, tag, call a webhook (guarded against the office network unless allowed) or read a PDF's title and revision; a test run, a run log, 30 runs a minute at most. Describe a rule in your own words and a small model on the PC drafts it for you to approve (see [`docs/AUTOMATIONS.md`](docs/AUTOMATIONS.md)) |
| Integrations | Bot API, incoming webhooks that accept Slack-style payloads, slash commands with signed webhooks, `dexconnect://share` links; Hopper notices, Slate notes, and Share to Dexterity Connect in Project Opener, Sleuth, Datum and Dexterity Sheets, whose links open back in the tool (see [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md)) |
| Updates | In-app updater on Windows, macOS and Android: on open, every 4 h and on demand; stable and beta channels; installs from the hub's mirror when offline |
| Phones | The same app on Android, in the office or anywhere on mobile data: images and voice notes inline, open files in another app, save to Downloads, attach from the phone, a layout made for small screens |
| Comfort | Pop a conversation out into its own window, a global shortcut to bring the app forward (Ctrl+Alt+D), Preferences for compact density and text size (also Ctrl+= / Ctrl+-), 12- or 24-hour time, sidebar sorting and a resizable sidebar, a keyboard shortcuts sheet (Ctrl+/), Alt+↑/↓ between conversations, light and dark themes |
| Platforms | Windows (NSIS), macOS (arm64 and x64 DMG), Android (APK), and the hub as a Windows service. Built by CI on every push |

**Next:** a pilot on the office's own PCs and phones, then the remaining items in [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md).

## How it fits together

| Part | What it is | Where it runs |
| --- | --- | --- |
| **Hub** (`apps/hub`) | Always-on service that holds the directory and approvals, and in later phases history, files and call relay | One office PC, as a Windows service |
| **Desktop app** (`apps/desktop`) | Electron + React app people use every day | Every Windows PC (macOS builds too) |
| **Phone app** (`apps/mobile`) | The same React UI in a Capacitor shell with a native LAN plugin | Android phones, on the office Wi-Fi or anywhere |
| **Core** (`packages/core`) | Shared protocol, device identity, LAN discovery and hub client | Used by both |

Apps find the hub on their own with a LAN broadcast probe. Every PC has its own Ed25519 device key, sealed with Windows DPAPI. The first device to join becomes the owner, and every later device waits until an admin approves it. Both sides see the same 8-character device code, so the admin can confirm who they are approving. Each sign-in proof is tied to that particular connection and to the hub's certificate, so a stolen or replayed proof is useless. The connection itself is TLS, pinned to the hub's certificate fingerprint.

## Getting the installers

Releases are built on an office Windows PC: double-click `scripts\release\Build-Release.cmd`
([docs/RELEASING.md](docs/RELEASING.md)). It tests everything and builds the Windows installer, the
Android APK and the hub package. With `-Publish`, it puts them on the
[public release repository](https://github.com/dexterity-admin/dexterity-connect/releases) and in the
update feed: **stable** from `main`, **beta** from other branches. Installed apps update from there, or
from the hub's mirror when they have no internet. Pushing code builds nothing.

### Setting up the office

1. **Hub PC:** extract the hub zip to where it should live (for example `D:\Dexterity Connect Hub`) and double-click `Install-Hub.cmd`. It installs the service, opens its two firewall ports and starts it.
2. **Your PC:** install Dexterity Connect, open it, and click **Request access**. As the first person, you become the owner.
3. **Everyone else:** they install and open the app, then approve them in **Control room → Approvals** (click your tile at the top right).
4. **Backups:** choose a backup folder on a second disk or a network share in **Control room → Backups & leavers** (see [`docs/BACKUP.md`](docs/BACKUP.md)).

## Development

Requires Node.js 22.18 or newer.

```bash
npm install
npm test               # core + hub test suites
npm run typecheck
npm run hub            # run a hub from source (data in ./hub-data)
npm run desktop:dev    # build and launch the desktop app
```

### Performance at office scale

The app is held to these budgets with an office of 120 people, 300 conversations, two years of
history (60,000 messages), 3,000 files, 2,000 Desk items and 400 events: start to a usable screen
under 1.5 s warm and 3 s cold, a lens switch under 100 ms, a conversation open under 150 ms, no
long task over 50 ms while scrolling or typing, the hub's hot operations under 30 ms at p95, and
the window's memory under 400 MB.

```bash
node apps/hub/scripts/seed-office.ts ./hub-data       # seed a hub with that office
node apps/hub/scripts/bench-ops.ts --check            # hub operations, p50 and p95
npm run desktop:build && PLAYWRIGHT=/path/to/playwright xvfb-run -a node apps/desktop/scripts/perf/perf.mts --check
```

`perf.mts` drives the built app through start-up, every lens, a busy conversation, 5,000 messages
of scrolling back, typing, search and ten minutes of moving around, with background office
traffic, and prints each measurement against its budget. `DEX_ROOT` points it at another checkout
(an earlier commit in a worktree) for a before-and-after comparison.

## Repository layout

```
apps/hub        hub service, its tests, Windows service packaging
apps/desktop    Electron main process, preload bridge, React UI
apps/gateway    the internet gateway: a Cloudflare Worker that relays encrypted traffic to the hub, and serves the guest meeting page
apps/mobile     Android app (Capacitor) and its native LAN, file and notification plugin
packages/core   protocol, identity, discovery, hub client, end-to-end encryption (+ tests)
brand/          Dexterity International logo files and colour tokens
docs/           blueprint, design language, Cliq feature inventory, integrations, third-party licences
```

Internal software. © Dexterity Design Services Pvt. Ltd. All rights reserved.
