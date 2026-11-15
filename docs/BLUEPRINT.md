# Dexterity Connect — product & engineering blueprint

Status: **building, see the progress table in section 5** · Date: 2026-11-14 · Owner: Dexterity Design Services Pvt. Ltd.

Dexterity Connect is an internal messenger for Dexterity's office. It has **every non-AI capability of Zoho
Cliq** and works with the internet unplugged. This document is the single source of truth for what we are
building, why, and in what order.

---

## 1. What the reverse engineering established

| Question | Finding | Evidence |
| --- | --- | --- |
| What is the Cliq desktop app? | An **Electron** shell (Chromium + Node) that loads Zoho's web client from Zoho's servers. | Zoho's own notices: macOS 1.8.0 and Windows 1.7.0 dropped old OS versions "because the framework we use (Electron)" no longer supports them. The installed `ZohoCorp.CliqBeta 1.8.6.0` package has a main bundle, six preloads (`main`, `chat`, `login`, `search`, `downloads`, `child`), helper windows and one native addon (`windows-focus-assist`). |
| Where do the features live? | On Zoho's servers and in the remotely loaded web bundle, **not in the binary**. | The package contains no messaging, call, file or search implementation. |
| Is Ghidra useful here? | Barely. Ghidra disassembles native machine code. The only native code is the focus-assist addon, which reads Windows' Do-Not-Disturb state. Electron app logic is JavaScript inside `app.asar`. You read it by extracting the archive, not by disassembling it. | Package structure. |
| So how was the feature set established? | From Zoho's public help centre, changelog (2017 → Oct 2026), admin guides and limits pages. That gives the complete, authoritative feature list, nuances and limits included. | `docs/CLIQ-FEATURE-INVENTORY.md`, with sources. |
| What do we take from Cliq? | **Capabilities only.** No code, assets, wording, layout or visual language. The UI is designed from scratch to Windows 11 conventions and Dexterity branding. | — |

## 2. Decisions from the requirements interview

| Area | Decision |
| --- | --- |
| Name | **Dexterity Connect** |
| Brand | Dexterity International palette (teal, amber) with our own product icon. Publisher and copyright: **Dexterity Design Services Pvt. Ltd.**, matching the rest of the internal tool suite. |
| Platforms | **Windows 10/11 desktop** plus **phone browser on office Wi-Fi** (installable web app, v1). |
| Scale | 25–100 users. Design headroom: 500. |
| Network | **Hybrid**: a hub on a dedicated always-on PC, with automatic direct PC-to-PC fallback when the hub is down, and resync when it returns. |
| Sign-in | **Automatic from the Windows account.** First launch registers the device; an admin approves it once. No passwords. |
| Privacy | **Direct messages are end-to-end encrypted** (the hub cannot read them). Channels and groups are encrypted in transit and auditable by admins. |
| Calls | **In v1**: 1:1 and group voice/video, screen share, meetings, recording. |
| AI | **No cloud AI.** One small model runs on the PC to draft automation rules from plain words (nothing leaves the PC, and nothing runs until a person approves it). |
| v1 modules | Everything: remote-work check-in/out, org directory & chart, calendar & meetings, polls/forms/notes, bots/slash commands/webhooks, whiteboard, guest users, compliance suite. |
| Disk rule | Development artefacts never on `C:` (this project is built in the cloud and in CI; nothing is written to the developer's `C:`). The installed app uses normal Windows locations. |
| Look & feel | **Windows 11 native**: Mica/acrylic surfaces, follows system light/dark, Dexterity teal as the accent, Fluent-style motion. A design language of our own: no layout, iconography, wording or interaction pattern borrowed from Cliq. |
| Platforms (revised) | Windows **and macOS** desktop, **Android APK**, plus the phone browser. Every push builds every installer in GitHub Actions. |
| Distribution | Source stays in this repository, which must be private. Installers, release notes and the 3D landing page are published to the public repository **dexterity-admin/dexterity-connect** (GitHub Pages: dexterity-admin.github.io/dexterity-connect). |
| Release channels | Pushes to `main` = **stable** (everyone). Other branches = **beta** (only people who opt in). |
| Updates | In-app updater on every platform: checks on open, on a timer and on demand, then downloads, verifies, installs and relaunches inside the app. Offline offices update from the hub's mirror. |
| Feel | Lighter and faster than Cliq: performance budgets enforced in CI (see section 8). |
| Ecosystem | Dexterity's own tools are wired in **on both sides**: Connect gets cards, launchers and an open bot/webhook API, and each tool gets small hooks (`dexterity://` links, "share to Connect"). Hopper's alerts move from its Zoho Cliq bot to Connect. |
| Identity | Custom app icon: a "D" that is also a speech bubble, with an amber spark at its heart and a fine orbit around it. Used everywhere: app, tray, installers, landing page, Android. |

## 3. Architecture

```
          office LAN (no internet)
 ┌──────────────────────────────────────────────────────────┐
 │  HUB PC (Windows service, always on)                     │
 │   ├─ Connect Hub (Node 22, TypeScript)                   │
 │   │   ├─ WSS API + REST (TLS, self-issued office CA)     │
 │   │   ├─ SQLite (WAL) + FTS5 search · file store (dedupe)│
 │   │   ├─ scheduler (reminders, scheduled msgs, retention)│
 │   │   ├─ bot runtime (sandboxed JS) · webhooks           │
 │   │   └─ PWA host for phones                             │
 │   └─ mediasoup relay (bundled worker) for large Rooms    │
 └───────────▲──────────────────────────▲───────────────────┘
             │ WSS                      │ WebRTC media
 ┌───────────┴────────┐        ┌────────┴───────────┐
 │ Desktop app (PC A) │◀──────▶│ Desktop app (PC B) │  direct P2P link:
 │ Electron + React   │  WSS   │                    │  used when hub is down,
 │ local SQLite cache │ WebRTC │                    │  for 1:1 calls and large
 └────────────────────┘        └────────────────────┘  file transfers
```

### 3.1 Components

| Component | Technology | Why |
| --- | --- | --- |
| Desktop shell | Electron (latest stable), TypeScript | Same Chromium on every PC, so WebRTC, screen capture (`desktopCapturer`) and notifications behave identically. Mica via `backgroundMaterial`. |
| UI | React 19 + Vite, small stores on `useSyncExternalStore`, CSS variables design system, a translating JSX runtime (Hindi, Tamil) | Optimistic updates, rendering only what is on screen, and code split by view keep it quick. No heavy UI kit. |
| Local store (every PC) | The user profile folder: history this PC has seen, the outbox for the PC-to-PC fallback, and (being added) an encrypted index for searching end-to-end encrypted Direct messages | Quick start, history when the hub is down. |
| Hub | Node 22 TypeScript service, `ws`, SQLite, packaged as a Windows service | Single installer on the hub PC; no admin skills needed. |
| Group media | PC to PC (mesh) up to 8; above that the hub's mediasoup relay (ISC licence, bundled worker) with `mediasoup-client`; TURN for people outside | Runs offline on the hub; about 50 in a Room on the office network, webinars up to 500 watching. |
| 1:1 media | Plain WebRTC P2P (no TURN needed on a LAN) | Lowest latency; works with the hub off. |
| Crypto | X25519, Ed25519 and HKDF (`@noble/curves`, `@noble/hashes`) with AES-256-GCM from WebCrypto; keys held with Windows DPAPI via Electron `safeStorage`, and in the Android Keystore on phones | Device-bound identity; E2E DMs and their files. |
| Discovery | UDP broadcast beacon + mDNS (`_dexconnect._tcp`) | Finds the hub and peers with zero configuration. |
| Installer | electron-builder NSIS (client) + NSIS (hub, registers the service and firewall rules) | One click; the installer creates its own firewall rules, so no manual PowerShell. |
| Releases | `scripts/release/Build-Release.cmd` on an office PC: tests → Windows installer, hub package, Android APK → release page and update feed ([`RELEASING.md`](RELEASING.md)) | One double-click; the GitHub workflow remains for manual runs. |

### 3.2 Identity and sign-in
1. On first launch the app reads the Windows account (`DOMAIN\user`), display name and PC name. It then generates
   an Ed25519/X25519 device key pair, sealed with DPAPI.
2. It finds the hub, which issues the office CA and a TLS pin. It then sends a join request to the admin's
   approval queue.
3. Once approved, the user is signed in silently on every later launch. A second device for the same Windows
   user needs its own approval.
4. Guests get a time-limited invite code instead of Windows identity, and are scoped to named channels.

### 3.3 Message flow and the hybrid network
- Every message has a globally unique, time-sortable ID (ULID) and a per-device sequence number. Delivery is
  idempotent, so duplicates from hub and P2P paths merge cleanly.
- **Hub up:** client → hub → fan-out to recipients. The hub stores channel history; DMs are stored as ciphertext.
- **Hub down:** clients switch to **direct mode** when the connection drops. Desktop PCs find each other with
  signed beacons (UDP 47902) and pass end-to-end sealed Direct messages straight across over a connection where
  the caller proves its device key. Messages wait in the sender's outbox for anyone not reachable. Files, Spaces
  and calls wait for the hub. *(As built.)*
- **Hub back:** clients upload what they sent and received while it was down. The hub merges by ID and
  redistributes anything that is missing. Ordering is by ULID (hybrid logical clock), so history matches on every PC.
- Large files always prefer a direct PC-to-PC transfer when both are online. That saves hub disk, the way
  Cliq's own peer-to-peer file option does.

### 3.4 Encryption
- Transport: TLS 1.3 everywhere, with certificates from the office CA the hub creates at install.
- DMs: each message gets a random AES-256-GCM key, wrapped for every device of every member with an ephemeral
  X25519 key and HKDF, and signed with the sender device's Ed25519 key. The hub only ever sees the sealed
  envelope; a user's existing device re-wraps history for a new device. People can compare a safety code.
  *(As built; hub-side search excludes DMs.)*
- DM files, photos, voice notes and recordings: encrypted on the sending device before upload, each with its own
  random AES-256-GCM key and nonce prefix, in 128 KB chunks (so large files stream in both directions; the chunk
  number and a last-chunk flag are in each nonce, so chunks cannot be reordered, dropped or cut off). The key, the
  real name, type and size travel inside the sealed message body, covered by the sender's signature. The hub stores
  ciphertext as "Encrypted file", never shows it inline, never reads it (no previews, no text extraction, no tools)
  and refuses to attach it anywhere but an encrypted DM. Devices decrypt on download, so images, previews and
  thumbnails are made on the device. The office's blocked file types are checked on the device before encryption.
  Older, unencrypted DM files keep working. *(As built.)*
- A DM that cannot be sealed (someone's app has no encryption key yet, or the sender's app is older) is never sent
  silently: the hub marks it with the reason, everyone sees a small open lock on it, and the sender sees a notice
  above the Dock before sending. Control room ▸ Policies ▸ *Require end-to-end encryption* stops such messages on the
  device and on the hub, with an explanation, until the person updates. Conversations with an integration are exempt.
- Device keys: on Windows and macOS sealed with Electron `safeStorage` (DPAPI, Keychain). A key made while sealing was
  unavailable is sealed on the next start; a sealed key that cannot be unsealed *right now* is never replaced. On
  Android the keys are wrapped by an AES-256 key held in the Android Keystore (`DexNative.secureGet/secureSet`);
  older versions' plain copies move there on first start.
- Channels and groups: encrypted at rest on the hub; readable by compliance admins (retention, eDiscovery, export).
- Planned hardening after v1: a double-ratchet layer for forward secrecy on DMs.

### 3.5 Phone notifications without Google push
The Android app does not use Firebase Cloud Messaging: the office network has no Google account, and messages should
not leave it. Notifications instead depend on the app staying connected, which Android and several makers (Xiaomi,
Vivo, Oppo, Realme, OnePlus, Samsung, Huawei) restrict to save battery. *(As built.)*
- **Foreground service** (`HubService`, type `remoteMessaging`) with a quiet, low-importance "Connected to the office"
  notification while *Stay connected in the background* is on. Restarted after a reboot and after an app update
  (`BootReceiver`), and by Android (`START_STICKY`) if it stops it.
- **Its own wait for messages.** When the app's WebView is gone or disconnected, the service long-polls the hub's
  `GET /notify/wait` (pinned to the hub's certificate, with a per-device token kept in the Keystore and revoked with
  the device) and shows what arrives with the person's preferences. This works on the office network; outside it the
  app's own connection through the gateway carries notifications while it runs.
- **Nothing lost.** On every reconnect the app asks the hub (`notify.missed`) for what arrived since the last message
  it or the service heard about, and shows it (encrypted DMs are opened on the phone first).
- **Battery exemption** (`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`), asked only after a sheet explains why.
- **Preferences ▸ Notifications check** shows each requirement (notification permission, background connection,
  battery exemption, restricted background use, the maker's autostart switches) and opens the right settings page,
  with step-by-step instructions for each maker (apps cannot read autostart switches, so people tick them off).

**Google push as an option later.** If the office creates a Firebase project, FCM could wake the phone instead of the
always-on service. It would need: a Firebase project and its `google-services.json` in the Android build (the Gradle
file already applies the plugin when that file exists); the Firebase Messaging library and a service that receives
messages; each phone registering its FCM token with the hub; the hub holding a Firebase service-account key and
calling the FCM HTTP v1 API through the internet (so the hub needs outbound internet access to Google). Payloads
would carry only a "something new" ping and a conversation id, never message text, so encrypted DMs stay private and
the app fetches the content itself. It would not help phones on networks that block Google, and Chinese-market phones
without Google services would still need the current approach.

## 4. Feature matrix with ratings

Ratings: **Offline** = can it work with no internet · **Fidelity** = how close to Cliq's capability we land ·
**Effort** = S (days) / M (1–2 weeks) / L (3+ weeks) · **Upgrade** = where we do better than Cliq.

| # | Area | Offline | Fidelity | Effort | Our approach / upgrade |
| --- | --- | --- | --- | --- | --- |
| 1 | Composer & formatting (markdown, headings, code blocks with syntax, lists, links, quotes, M↓ cheat-sheet, undo auto-format, 4,000 chars) | Full | 100% | M | Live inline preview while typing; slash menu for blocks |
| 2 | Emoji, custom emoji (5k org / 100 per user), stickers | Full | 100% | S | Emoji bundled offline; admin emoji packs |
| 3 | Voice, video & screen-recorded messages (15 min, playback speed, background blur) | Full | 100% | M | Waveform scrubbing; recorded locally, no upload wait in direct mode |
| 4 | Edit (10×, admin window), delete, multi-select (25), forward (25, keep original sender), copy, permalink, mark unread, fork | Full | 100% | M | `dexconnect://` permalinks open the exact message |
| 5 | Reactions (configurable 3 quick reactions), reply/quote, reply privately | Full | 100% | S | — |
| 6 | Threads (follow, close, list all, reply-mode toggle) | Full | 100% | M | Side-by-side thread pane with its own drafts |
| 7 | Pins (25, timed: 1 h / 1 wk / forever), stars (typed), saved items | Full | 100% | S | — |
| 8 | Read receipts (ticks + per-user read info), last seen, typing | Full | 100% | S | Toggle per user, as in Cliq |
| 9 | Scheduled messages (25 per chat), reminders (message or standalone, others, recurring) | Full | 100% | M | Hub runs schedules; direct mode runs them locally |
| 10 | Mentions (@user, @channel, @all, #channel), Mentions & Replies view, hashtags + trends | Full | 100% | M | Amber mention highlights; unified Activity inbox |
| 11 | Chat types: 1:1, groups (500), channel conversion, bots | Full | 100% | M | — |
| 12 | Channels: org / team / private, roles (admin, moderator, member), permission matrix, announcement-only, archive, join/leave notices | Full | 100% | M | Per-department team channels generated from the org chart; official notices get a register of their own, with acknowledgements ([`ANNOUNCEMENTS.md`](ANNOUNCEMENTS.md)) |
| 13 | Chat organisation: pinned chats (100), folders (50), custom sections, filters, resizable sidebar | Full | 100% | S | Keyboard-reorderable sections |
| 14 | Chat tabs & chat actions (pin files, forms, links, widgets to a chat) | Full | 100% | M | — |
| 15 | Presence: available, away, busy, invisible, DND (timed / scheduled), on-call / in-meeting auto, custom status, OOO with delegate | Full | 100% | M | Windows Focus Assist sync without a native addon |
| 16 | Notifications: global, per-chat, mute 1 h from the toast, sound sets, admin defaults | Full | 100% | M | Native Windows toasts with inline reply; taskbar badge (Cliq lacks it) |
| 17 | Files: drag/paste, multi-preview, 1 GB, P2P transfer, media tab, pan/zoom viewer, image annotation, PDF/Office preview | Full | 95% | M | PDFs in an in-app viewer (tiled for A0/A1 sheets, search, copy, rotate, password prompt); Office docs show a card and open in the local app |
| 18 | Search: Ctrl+K, filters (person, chat, date, type), jump to date; DMs searched locally | Full | 100% | M | Results as you type in under 50 ms from the local FTS index |
| 19 | OCR of text in images | Full (local engine) | 90% | M | Tesseract on the hub for channel images and locally for DMs |
| 20 | 1:1 voice/video, screen share (with system audio), promote to group, ringtone | Full | 100% | L | P2P on the LAN gives near-zero latency |
| 21 | Group calls & meetings (host, co-host, lock, handover, pinned video, PiP, network stats, background blur, noise suppression) | Full (SFU on hub) | 95% | L | LiveKit SFU; 100+ participants |
| 22 | Meeting recording | Full | 95% | M | Recorded by the host client; stored on the hub, shareable inside the office |
| 23 | Screen-share annotation, slide sharing | Full | 90% | M | — |
| 24 | Live events / webinars (front and back stage, RTMP) | Full | 70% | L | **Later phase**: not requested for v1 |
| 25 | Whiteboard (per meeting / channel, 20 editors) | Full | 100% | L | CRDT (Yjs) synced through the hub or P2P |
| 26 | Calendar & meetings: schedule, invites, time zones, room booking | Full | 100% | M | Meeting rooms modelled as resources |
| 27 | Polls (7 days, CSV export), forms (builder, file fields, QR), notes (shared, reminders) | Full | 100% | M | — |
| 28 | Remote work: check-in/out timer, default status, manager attendance view, CSV reports | Full | 100% | M | — |
| 29 | Org directory & chart: departments, designations, custom fields, reporting lines | Full | 100% | M | Seeded from a CSV import |
| 30 | Bots, slash commands, message actions, widgets, schedulers, incoming webhooks, REST API | Full (local runtime) | 85% | L | JavaScript in a sandbox instead of Deluge; office tools can post through webhooks |
| 31 | Guest users (channel-scoped, invite codes) | Full | 100% | S | — |
| 32 | Themes (light, dark, auto), message views (classic, compact, bubbles), font scaling, contrast, full keyboard navigation | Full | 100% | M | Mica + system accent; WCAG 2.2 AA |
| 33 | Customisable keyboard shortcuts, incl. G-sequences and single-key message actions | Full | 100% | S | — |
| 34 | Admin: user approval, roles, defaults, policies (edit window, uploads, P2P files, mention limits), usage reports | Full | 100% | M | Admin console inside the app |
| 35 | Compliance: retention (90-day minimum), audit trail, legal hold, eDiscovery, DLP alerts, export (JSON/PDF) | Full (channels) | 90% | L | DMs excluded by design (E2E) |
| 36 | Multi-account, tray, start at sign-in, deep links, downloads manager, update check | Full | 100% | S | Updates pushed from the hub, so no internet is needed |
| 37 | Mobile | Office Wi-Fi only | 70% | M | Android app: chat, files, notifications through its own background connection (no Google push; see §3.5). |
| — | **Not possible offline / out of scope**: Zia & all AI · Google Drive/WorkDrive attachments · Jira/GitHub/Zoho integrations (cloud) · PSTN phone calls · mobile push via Apple/Google · external cross-company channels | — | — | — | — |

**Overall fidelity for the requested scope: about 97%** of Cliq's non-AI, non-cloud capability. The only shortfalls are
Live Events (deferred), Office-document inline preview, and Deluge scripting (replaced by JavaScript).

**Status against this plan (November 2026), from the code rather than the plan:**
- **Not built:**
  - Windows Focus Assist sync (row 15) and inline reply from a Windows notification (row 16).
  - Office documents open in their own app; there is no inline Office preview.
- **Being added:**
  - an in-app PDF viewer (row 17);
  - automatic hub backups;
  - offboarding;
  - a calendar feed for Outlook and phones;
  - end-to-end encrypted attachments in Direct messages;
  - searching encrypted Direct messages on the device.
- **Built beyond this plan:** the full meeting and webinar suite, the IT help desk with consented remote control, lounges, automations, bot conversations and tools inside conversations.
- **Untested outside this development environment:** everything above on real office Windows PCs, Android phones from several makers, and real home and mobile networks. A pilot is the next step.

## 5. Build plan

**Progress (2026-11-14):**

| Phase | State |
| --- | --- |
| P0 Foundation | ✅ Done |
| P1 Messaging core | ✅ Done, including end-to-end encrypted Direct messages and the hub-off PC-to-PC mode |
| P2 Files & search | ✅ Files, a viewer with zoom, rotate and mark-up, a PDF viewer for drawing sheets, Files panel, full-text search with filters, on-device search of encrypted Direct messages, OCR of images, voice notes, video messages and screen recordings, files on phones |
| P3 Calls | ✅ 1:1 and group Rooms (mesh up to 8, the hub's relay above that), add people, screen share, PiP, call quality, recording, mini-Room, Join from meetings, STUN/TURN across networks, background blur and backgrounds, noise suppression; the meeting suite (meetings, guests, recordings, breakouts, webinars) is in [`MEETINGS.md`](MEETINGS.md) |
| P4 Productivity | ✅ Saved messages, reminders, scheduled messages, polls, forms, notes (with Slate), calendar and conference rooms, remote work, organisation and org chart |
| P5 Platform & governance | ✅ Bot API, slash commands with signed webhooks, share links for office tools, whiteboards, guests, retention, legal hold, exports, Control room, audit |
| P6 Mobile & polish | ✅ Android app with updater, files and a phone layout; pop-out windows, global shortcut, quiet hours, 12/24-hour time |
| Outside the office | ✅ Internet gateway on Cloudflare: devices on any network or mobile data reach the hub through an end-to-end encrypted channel pinned to the hub's certificate; the office opens no ports (see [`REMOTE-ACCESS.md`](REMOTE-ACCESS.md)) |

Each phase ends with installers built by CI, a test pass, and a short demo note.

| Phase | Content | Ships |
| --- | --- | --- |
| **P0 Foundation** | Monorepo (`apps/desktop`, `apps/hub`, `packages/core`, `packages/ui`), design system in Dexterity tokens, Electron shell (Mica, tray, deep links, auto-start), hub service, discovery, Windows identity + device approval, TLS with the office CA, local SQLite, sync protocol | App installs, finds the hub, signs in silently |
| **P1 Messaging core** | Channels, DMs, groups, threads, composer and formatting, reactions, edit/delete/forward, pins, stars, read receipts, typing, presence and statuses, notifications, chat organisation, E2E DMs, hybrid P2P fallback | Day-to-day chat replaces Cliq |
| **P2 Files & search** | File sharing incl. P2P transfer, viewer, annotation, media tab, Ctrl+K search, OCR, voice/video messages | — |
| **P3 Calls** | 1:1 and group calls, screen share, meetings, recording, PiP, background effects | — |
| **P4 Productivity** | Reminders, scheduled messages, polls, forms, notes, calendar and rooms, remote work, org directory and chart | — |
| **P5 Platform & governance** | Bots, slash commands, webhooks, REST API, whiteboard, guests, admin console, compliance suite | — |
| **P6 Mobile & polish** | Phone PWA, accessibility audit, performance budget (cold start < 1.5 s, chat switch < 50 ms), hub-pushed updates | v1.0 |

## 8. Distribution, updates and performance

### Release flow
| Trigger | Result |
| --- | --- |
| Any push | Tests, then Windows installer, macOS DMGs, Android APK and hub package as build artefacts |
| Push to `main` | Same, plus a release in the public repository; every installed app is offered the update |
| Other branches | Optional *beta* channel for testers (opt-in in Settings) |

### In-app updater (desktop and Android)
- **When it checks:** at start-up, every 4 hours while running, and when you click "Check for updates".
  It checks quietly while you're in a call and holds the prompt until the call ends.
- **Where it checks:** the public release repository when the PC has internet. Otherwise the hub's update
  mirror, which the hub refreshes whenever it has internet, or which an admin fills by uploading an installer
  from the admin console. Offices that never connect still update.
- **Flow:** "Update available" → background download with progress (resumable, so a dropped download
  continues) → SHA-512 check against the release manifest → "Restart to update" (or install on quit) → the app
  relaunches into the new version and shows what changed.
- **Edge cases handled:** no network, a hub without the mirror, a corrupted or partial download, a
  version older than the installed one (refused), the disk full, a second instance running, an update
  arriving mid-download, admin-pinned versions (hold everyone on a known-good build), and mandatory
  security updates.
- **macOS caveat:** Apple only allows silent self-replacement for signed apps. Unsigned builds
  download the new DMG and walk the user through a two-click replace, until an Apple Developer ID is added.
- **Android:** downloads the new APK and hands it to Android's installer (one tap to confirm).
  Every build is signed with the same key so Android accepts it as an update.

### Performance budgets (targets; measured with the performance script, not enforced automatically)
| Metric | Budget |
| --- | --- |
| Cold start to usable window | < 1.5 s on an office PC |
| Switching conversations | < 50 ms, no spinner for cached chats |
| Typing latency | < 16 ms per keystroke (one frame) |
| Scrolling 10,000 messages | 60 fps (virtualised list) |
| Renderer JS (gzip) | < 350 KB initial; heavy views (calls, whiteboard) load on demand |
| Idle memory | < 250 MB |

## 9. Dexterity tool ecosystem

| Tool | What it is | Connect integration |
| --- | --- | --- |
| **Hopper** | Office file manager with @mention file sending and client links | Its Cliq bot alerts (downloads, link expiry, DMs) move to a Connect bot. "Send to @person" shows as a rich transfer card in chat. Folder paths in messages get "Open in Hopper". Shared directory and presence. |
| **Dexterity Sheets** | Live co-authored spreadsheets on an office server | Sheets links unfurl into cards (who is editing, last change). Cell @mentions arrive as Connect messages. Named versions ("Issued Rev B") attach to threads. Automation-rule outputs become reminders. |
| **Project Opener** | One-click project launch sets | A project shared into chat becomes a card with "Open all". Each project can have its own channel. Path-offline alerts post to the channel. Its team-hub presence and announcements merge into Connect. |
| **Slate** | Lightweight co-editing text/CSV editor | Notes in every chat and channel open and co-edit in Slate. Text/CSV attachments get "Open in Slate". Revised files posted in chat get a side-by-side diff. CSVs preview as grids. |
| **Sleuth** | OCR search for tags inside drawings | Line numbers and tags in messages (6"-P-1001-A1B) become links to the drawing with the tag ringed. `/find <tag>` searches the shared index. Revision change reports post to project channels. |
| **Datum** | Offline piping data book and calculators | `/datum 6" 300# WN` posts a component card with key dimensions. Shared selections open in Datum. Its QR-from-PC install pattern distributes Connect's Android app too. |

Common plumbing: a `dexterity://<tool>/<action>?…` link scheme, a local webhook/bot API on the hub (also the
replacement for Hopper's Cliq bot), and a launcher panel in Connect that shows which tools are installed.

## 6. What Dexterity needs to provide

| Item | When | Notes |
| --- | --- | --- |
| A dedicated always-on Windows PC for the hub | Before the P0 pilot | Any PC with 8 GB RAM, an SSD and a fixed LAN IP or DHCP reservation. |
| An admin user | At hub install | The first person to sign in becomes admin; they approve everyone else. |
| A department/designation CSV (optional) | P4 | Name, Windows username, department, designation, manager. Seeds the org chart. |
| Code-signing certificate (optional) | Before rollout | Removes the Windows SmartScreen warning. Without one, users click "Run anyway" once. |
| The office's actual seating layout drawing | Received (A3 print of 18-Jul-2026) and built in | Transcribed at real scale into `apps/hub/seed/floor-l01.json` (153 seats: 53 + 20 + 42 bench seats, 18 senior pod seats, 8 half-cabins, 9 client cabins, 2 MD's cabins, reception) and seeded on every hub as Rev A. The **Floor** sheet now draws it; seats are moved with move plans and revisions. See [`SEATING.md`](SEATING.md). Still wanted from the office: the real name of "Room A", where north is, and an up-to-date list of who sits where (import it as a draft). The user guide's floor figure (`docs/guide/figures/fig-org-floor.png`) needs redrawing. |
| A Cloudflare account (free plan) | For use outside the office | Hosts the gateway. Add an API token and account ID as repository secrets; the workflow deploys it. See [`REMOTE-ACCESS.md`](REMOTE-ACCESS.md). |

Everything else (builds, installers, firewall rules, certificates, the hub setup) is automated.

## 7. What happens to the existing "Lattice" skeleton

It is superseded. Its useful ideas (UDP discovery, file dedupe, the test approach) carry over into the hub. The
UI, the plain-HTTP transport, the name-only sign-in and the C:-fallback data path do not. It stays in git history.
