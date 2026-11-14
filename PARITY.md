# Zoho Cliq parity tracker

This is the working definition of "shippable": every Cliq capability, with an honest status for
Lattice. It exists so progress is measurable instead of claimed.

## What REA actually established

The installed `ZohoCorp.CliqBeta 1.8.6.0` package is a **thin Electron shell**: 128 files, a main
bundle, six preloads (`main`, `chat`, `login`, `search`, `downloads`, `child`), windows for
about/basic-auth/downloader/manage-accounts/notifier/update, `auto-launch`, `applescript`, and one
native addon (`windows-focus-assist`). It contains **no** messaging, call, file or search
implementation — those live on Zoho's servers and in a remote web bundle.

Consequence: "reproduce every feature REA found" means reproducing the **shell** features (section A),
which is what this release does. Everything in sections B–F is product behaviour that was never in
the binary, so it is designed here from the outside in, and graded against your offline-LAN constraint.

Legend: **Done** = built and covered by tests · **Desktop** = provided by the Electron shell ·
**Partial** = present with a documented gap · **Planned** = next up · **Out of scope** = needs internet
or a media server by nature.

## A. Shell features (the part REA could prove)

| Feature | Cliq | Lattice | Notes |
| --- | --- | --- | --- |
| Tray icon with menu | yes | **Desktop** | Open, copy server link, quit |
| Launch at sign-in | yes (`auto-launch`) | **Desktop** | Tray toggle writes the login item |
| Native notifications | yes (`notifierWindow`) | **Done** + Desktop | Web Notifications, suppressed when the tab is focused |
| Unread badge / counts | yes | **Done** | Per-channel counters in the sidebar |
| Deep links (`cliq://`) | yes | **Desktop** | `lattice://<channel>/<message>` focuses and routes |
| Download handling | yes (`downloads_preload`) | **Done** + Desktop | Attachment download endpoint; shell notifies on completion |
| About / version window | yes | **Desktop** | About panel plus tray version item |
| Update check | yes (`updateWindow`) | **Partial** | Tray links to the release page; no silent auto-update (offline offices cannot pull) |
| Multiple accounts | yes (`manageAccounts`) | **Planned** | Today one workspace per server; multi-server switcher is next |
| Focus assist / DND | yes (`focusassist.node`) | **Partial** | Notifications respect the OS DND; no native addon shipped |
| Windows Store packaging (MSIX) | yes | **Partial** | NSIS + portable + dmg + AppImage/deb in CI; MSIX needs a certificate |

## B. Messaging

| Feature | Cliq | Lattice | Notes |
| --- | --- | --- | --- |
| Channels | yes | **Done** | Create, join, leave, rename topic |
| Direct messages | yes | **Done** | Reused automatically between two people |
| Group conversations | yes | **Done** | Channels with a member picker |
| Replies / threads | yes | **Done** | Reply quoting plus a thread panel with its own composer |
| Edit and delete | yes | **Done** | Author-only (delete also for admins), "(edited)" marker |
| Forwarding | yes | **Done** | Pick one or many conversations |
| Reactions | yes | **Done** | 👍 ✅ 👀 toggles with counts |
| Pins / starred | yes | **Done** | Pins with a per-conversation list |
| Mentions / @notifications | yes | **Done** | Highlighted in the message, counted as an `@n` badge. Matched by name; unique handles are the next refinement |
| Typing indicators | yes | **Done** | |
| Presence / availability | yes | **Partial** | Online/away from the live connection; no manual status text |
| Read receipts | yes | **Done** | "Seen by n of m" under your latest message, updated live over SSE |
| Search | yes | **Done** | Scoped to your conversations, optional current-channel filter |
| Message scheduling | yes | **Planned** | |
| Reminders | yes | **Planned** | |
| Polls / forms | yes | **Planned** | |
| Voice notes | yes | **Planned** | MediaRecorder + the existing upload path |
| Broadcast messages | yes | **Planned** | |
| Quick replies / templates | yes | **Planned** | |
| Chat mute | yes | **Done** | Per-person mute; the unread badge hides but mentions still count |
| Chat archive | yes | **Planned** | |

## C. Files and media

| Feature | Cliq | Lattice | Notes |
| --- | --- | --- | --- |
| File sharing | yes | **Done** | Drag, drop or paste; 512 MB per file |
| Upload progress | yes | **Done** | Percentage while sending |
| Image previews | yes | **Done** | Inline, click to open full size |
| Disk deduplication | yes (server side) | **Done** | Identical bytes stored once |
| File browser / gallery | yes | **Planned** | |
| Document preview (PDF/Office) | yes | **Planned** | |
| Screen sharing | yes | **Out of scope** | Needs an on-prem SFU |

## D. Calls and meetings

| Feature | Cliq | Lattice | Notes |
| --- | --- | --- | --- |
| 1:1 voice / video | yes | **Out of scope** | Needs LiveKit/Jitsi on the same box |
| Group calls, meetings, webinars | yes | **Out of scope** | Same |
| Call recording | yes | **Out of scope** | Same |

## E. Automation and integrations

| Feature | Cliq | Lattice | Notes |
| --- | --- | --- | --- |
| Bots | yes | **Planned** | Local bot over the HTTP API |
| Slash commands | yes | **Planned** | Start with `/me`, `/shrug`, `/poll` |
| Incoming webhooks | yes | **Planned** | LAN-only hooks |
| Zoho / Jira / Google integrations | yes | **Out of scope** | Require internet |
| Translation, smart replies | yes | **Out of scope** | Would need a local model |

## F. Administration and security

| Feature | Cliq | Lattice | Notes |
| --- | --- | --- | --- |
| Roles and permissions | yes | **Done** | First user is admin; promote/demote |
| Channel administration | yes | **Done** | Admin can delete a channel |
| Data export | yes | **Done** | JSON export from Admin tools |
| Retention and e-discovery | yes | **Planned** | |
| SSO / directory sync | yes | **Planned** | AD/LDAP on the LAN |
| Audit log | yes | **Planned** | Structured JSON logs exist today |
| End-to-end encryption | no (server-side) | **Planned** | TLS via reverse proxy today |

## Definition of done for v2

1. ~~Mentions and directed notifications, plus a "seen by" line.~~ done
2. ~~Muted conversations.~~ done — archive still to do.
3. Scheduling, reminders and polls.
4. Voice notes.
5. Bots and slash commands over a documented local API.
6. Multi-server switcher in the desktop shell.
7. Retention settings and an audit log.
8. Unique @handles (names can repeat in a real office).

Calls and third-party integrations stay out of scope because they contradict the constraint that
started this project: everything works with the internet cable unplugged.
