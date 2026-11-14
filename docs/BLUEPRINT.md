# Dexterity Connect — product & engineering blueprint

Status: **approved scope, pre-build** · Date: 2026-11-14 · Owner: Dexterity International

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
| Brand | Dexterity International (teal diamond, amber D). Tokens in `brand/BRAND.md`. |
| Platforms | **Windows 10/11 desktop** plus **phone browser on office Wi-Fi** (installable web app, v1). |
| Scale | 25–100 users. Design headroom: 500. |
| Network | **Hybrid**: a hub on a dedicated always-on PC, with automatic direct PC-to-PC fallback when the hub is down, and resync when it returns. |
| Sign-in | **Automatic from the Windows account.** First launch registers the device; an admin approves it once. No passwords. |
| Privacy | **Direct messages are end-to-end encrypted** (the hub cannot read them). Channels and groups are encrypted in transit and auditable by admins. |
| Calls | **In v1**: 1:1 and group voice/video, screen share, meetings, recording. |
| AI | **Excluded entirely.** |
| v1 modules | Everything: remote-work check-in/out, org directory & chart, calendar & meetings, polls/forms/notes, bots/slash commands/webhooks, whiteboard, guest users, compliance suite. |
| Disk rule | Development artefacts never on `C:` (this project is built in the cloud and in CI; nothing is written to the developer's `C:`). The installed app uses normal Windows locations. |
| Look & feel | **Windows 11 native**: Mica/acrylic surfaces, follows system light/dark, Dexterity teal as the accent, Fluent-style motion. Deliberately unlike Cliq. |

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
 │   └─ LiveKit SFU (single binary, bundled) for group calls│
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
| UI | React 19 + Vite, Zustand state, TanStack Virtual lists, CSS variables design system | Virtualised message lists and optimistic updates give the "zero-lag" feel. No heavy UI kit. |
| Local store (every PC) | SQLite (`better-sqlite3`) + FTS5 | Instant cold start, offline history, local search of encrypted DMs, outbox for P2P fallback. |
| Hub | Node 22 TypeScript service, `ws`, SQLite, packaged as a Windows service | Single installer on the hub PC; no admin skills needed. |
| Group media | LiveKit server (Apache-2.0 Go binary), `livekit-client` | Runs offline on the hub; handles 100-person calls, simulcast, screen share. |
| 1:1 media | Plain WebRTC P2P (no TURN needed on a LAN) | Lowest latency; works with the hub off. |
| Crypto | libsodium (X25519 + XChaCha20-Poly1305, Ed25519 signatures); keys held with Windows DPAPI via Electron `safeStorage` | Device-bound identity; E2E DMs. |
| Discovery | UDP broadcast beacon + mDNS (`_dexconnect._tcp`) | Finds the hub and peers with zero configuration. |
| Installer | electron-builder NSIS (client) + NSIS (hub, registers the service and firewall rules) | One click; the installer creates its own firewall rules, so no manual PowerShell. |
| CI | GitHub Actions: tests → Windows installers → release on tag | Built entirely in the cloud. |

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
- **Hub down:** clients detect it within 3 s and switch to **direct mode**. Peers are found by beacon, and
  DMs and group messages go straight to online recipients' PCs over pinned TLS. Messages for offline people
  wait in the sender's outbox. File transfers go peer-to-peer.
- **Hub back:** clients upload what they sent and received while it was down. The hub merges by ID and
  redistributes anything that is missing. Ordering is by ULID (hybrid logical clock), so history matches on every PC.
- Large files always prefer a direct PC-to-PC transfer when both are online. That saves hub disk, the way
  Cliq's own peer-to-peer file option does.

### 3.4 Encryption
- Transport: TLS 1.3 everywhere, with certificates from the office CA the hub creates at install.
- DMs: each message gets a random key, sealed to every device of both participants (sender-keys model).
  The hub only ever sees ciphertext. Search over DMs runs on the local index of each PC.
- Channels and groups: encrypted at rest on the hub; readable by compliance admins (retention, eDiscovery, export).
- Planned hardening after v1: a double-ratchet layer for forward secrecy on DMs.

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
| 12 | Channels: org / team / private, roles (admin, moderator, member), permission matrix, announcement-only, archive, join/leave notices | Full | 100% | M | Per-department team channels generated from the org chart |
| 13 | Chat organisation: pinned chats (100), folders (50), custom sections, filters, resizable sidebar | Full | 100% | S | Keyboard-reorderable sections |
| 14 | Chat tabs & chat actions (pin files, forms, links, widgets to a chat) | Full | 100% | M | — |
| 15 | Presence: available, away, busy, invisible, DND (timed / scheduled), on-call / in-meeting auto, custom status, OOO with delegate | Full | 100% | M | Windows Focus Assist sync without a native addon |
| 16 | Notifications: global, per-chat, mute 1 h from the toast, sound sets, admin defaults | Full | 100% | M | Native Windows toasts with inline reply; taskbar badge (Cliq lacks it) |
| 17 | Files: drag/paste, multi-preview, 1 GB, P2P transfer, media tab, pan/zoom viewer, image annotation, PDF/Office preview | Full | 95% | M | Office preview limited to PDF/images/text/video; Office docs open in the local app |
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
| 37 | Mobile | Office Wi-Fi only | 70% | M | Installable PWA served by the hub: chat, files, notifications while open. Native apps later. |
| — | **Not possible offline / out of scope**: Zia & all AI · Google Drive/WorkDrive attachments · Jira/GitHub/Zoho integrations (cloud) · PSTN phone calls · mobile push via Apple/Google · external cross-company channels | — | — | — | — |

**Overall fidelity for the requested scope: about 97%** of Cliq's non-AI, non-cloud capability. The only shortfalls are
Live Events (deferred), Office-document inline preview, and Deluge scripting (replaced by JavaScript).

## 5. Build plan

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

## 6. What Dexterity needs to provide

| Item | When | Notes |
| --- | --- | --- |
| A dedicated always-on Windows PC for the hub | Before the P0 pilot | Any PC with 8 GB RAM, an SSD and a fixed LAN IP or DHCP reservation. |
| An admin user | At hub install | The first person to sign in becomes admin; they approve everyone else. |
| A department/designation CSV (optional) | P4 | Name, Windows username, department, designation, manager. Seeds the org chart. |
| Code-signing certificate (optional) | Before rollout | Removes the Windows SmartScreen warning. Without one, users click "Run anyway" once. |

Everything else (builds, installers, firewall rules, certificates, the hub setup) is automated.

## 7. What happens to the existing "Lattice" skeleton

It is superseded. Its useful ideas (UDP discovery, file dedupe, the test approach) carry over into the hub. The
UI, the plain-HTTP transport, the name-only sign-in and the C:-fallback data path do not. It stays in git history.
