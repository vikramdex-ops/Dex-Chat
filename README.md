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
| Messaging | Spaces (open / private), Direct (1:1 and groups), side-tracks, @mentions and @everyone, reactions (with office emoji), pins, edit / delete, quote, reply privately, copy a link to a message, select several to forward, copy, save or delete, Seen receipts, typing, drafts, formatting, line-number references |
| Desk | Saved messages, reminders (on a message or standalone, for yourself or a colleague, repeating, snooze), messages scheduled to send later (sent by the hub even with your PC off), forwarding with credit, mark unread, polls (single or multiple choice, anonymous, closing time) |
| Organisation | Departments (nested, with heads), designations, reporting lines, extension, phone, seat, joining date, birthday and custom fields; an org chart; profiles beside the Directory; CSV import from Excel or Dexterity Sheets that also covers people who have not joined yet |
| Remote work | Check in from the title bar (office, home, site or client), breaks, change place during the day, live "who's working" on Pulse and on profiles, your timesheet on the Desk, team attendance for managers and administrators, CSV export; forgotten check-outs close at the last activity |
| Calendar | Week grid and agenda, meetings with invitations and Going / Maybe / Not going, repeating meetings, reminders with a Join card, conference rooms that cannot be double-booked, free/busy while planning, meetings tied to a conversation and announced there, one-click Join into a call |
| Guests | Invite codes for people outside the company, limited to chosen Spaces and their people, approved at once, with access that ends on its own (extend or end it any time) |
| Compliance | Retention for Space and Direct messages, legal holds that keep every version of edited or deleted messages, exports to HTML, CSV or JSON (Direct message text is never exported) |
| Commands | Slash commands in the composer (/remind, /poll, /meet, /call, /status, /checkin, /dnd, /shrug, /help…) and integration commands that call a tool's signed webhook |
| Notes, forms, whiteboards | Shared notes per conversation and personal notes on the Desk (save as you type, never overwrite a colleague, edit in Slate), forms with answers and CSV export, live whiteboards that can be posted as an image, voice notes |
| Privacy | Direct messages are end-to-end encrypted (X25519 + AES-256-GCM, signed by each device's Ed25519 key); the hub only stores sealed envelopes; safety codes to compare in person; your other devices hand history to a new one |
| Outside the office | Phones and home laptops on any network or mobile data reach the hub through the office's own gateway on Cloudflare (no port opened at the office, end-to-end encrypted to the hub, pinned to its certificate); setup codes and QR codes; calls across networks with STUN/TURN (see [`docs/REMOTE-ACCESS.md`](docs/REMOTE-ACCESS.md)) |
| Hub-off mode | If the hub PC is down, PCs find each other on the network and pass encrypted Direct messages straight across; everything written meanwhile is added to the hub's history when it is back |
| Files and media | Drag, drop, paste or attach up to the office limit (1 GB by default); stored once on the hub; inline images with a viewer; voice notes, video messages and screen recordings that play inline; Open / Save; Files panel |
| Rooms (calls) | Voice and video, up to 8 people, screen sharing with a picker, recording (everyone is told; saved on the PC or shared in the conversation), mini-Room, ringing, missed calls; media peer-to-peer on the LAN |
| Search | Ctrl+K across people, conversations, commands and message text; a Search screen (Ctrl+Shift+F or a conversation's header) with filters for person, conversation, Direct or Spaces, dates and files; text in images found by OCR on the sender's PC (Spaces only) |
| Presence | Available, Busy, Do not disturb, Invisible; automatic Away on idle or screen lock; beacon rings |
| Notifications | Native toasts that open the conversation (Android too, with a background connection), taskbar / dock badge, mute per conversation, notify about everything / Direct and mentions / nothing, a choice of generated sounds, hide message text |
| Admin | Control room: approvals, devices, roles, organisation, guests, compliance, policies (edit window, upload limit, PC-to-PC fallback, call recording, office emoji), usage report, integrations, audit log, update mirror status |
| Integrations | Bot API, slash commands with signed webhooks, `dexconnect://share` links; Hopper notices, Slate notes, and Share to Dexterity Connect in Project Opener, Sleuth, Datum and Dexterity Sheets, whose links open back in the tool (see [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md)) |
| Updates | In-app updater on Windows, macOS and Android: on open, every 4 h and on demand; stable and beta channels; installs from the hub's mirror when offline |
| Phones | The same app on Android: images and voice notes inline, open files in another app, save to Downloads, attach from the phone, a layout made for small screens |
| Comfort | Preferences for compact density and text size (also Ctrl+= / Ctrl+-), a keyboard shortcuts sheet (Ctrl+/), Alt+↑/↓ between conversations, light and dark themes |
| Platforms | Windows (NSIS), macOS (arm64 and x64 DMG), Android (APK), and the hub as a Windows service. Built by CI on every push |

**Next:** the remaining parity items in [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md) (OCR, call recording, video messages, custom emoji).

## How it fits together

| Part | What it is | Where it runs |
| --- | --- | --- |
| **Hub** (`apps/hub`) | Always-on service that holds the directory and approvals, and in later phases history, files and call relay | One office PC, as a Windows service |
| **Desktop app** (`apps/desktop`) | Electron + React app people use every day | Every Windows PC (macOS builds too) |
| **Phone app** (`apps/mobile`) | The same React UI in a Capacitor shell with a native LAN plugin | Android phones on the office Wi-Fi |
| **Core** (`packages/core`) | Shared protocol, device identity, LAN discovery and hub client | Used by both |

Apps find the hub on their own with a LAN broadcast probe. Every PC has its own Ed25519 device key, sealed with Windows DPAPI. The first device to join becomes the owner, and every later device waits until an admin approves it. Both sides see the same 8-character device code, so the admin can confirm who they are approving. Each sign-in proof is tied to that particular connection and to the hub's certificate, so a stolen or replayed proof is useless. The connection itself is TLS, pinned to the hub's certificate fingerprint.

## Getting the installers

Every push runs GitHub Actions (**Actions → build**). It tests everything, builds the Windows installer,
both macOS DMGs, the Android APK and the hub package, and publishes them to the
[public release repository](https://github.com/dexterity-admin/dexterity-connect/releases):
pushes to `main` publish to the **stable** channel, other branches to **beta**. Installed apps update from there,
or from the hub's mirror when they have no internet.

### Setting up the office

1. **Hub PC:** extract the hub zip to where it should live (for example `D:\Dexterity Connect Hub`) and double-click `Install-Hub.cmd`. It installs the service, opens its two firewall ports and starts it.
2. **Your PC:** install Dexterity Connect, open it, and click **Request access**. As the first person, you become the owner.
3. **Everyone else:** they install and open the app, then approve them from **Admin → Approvals**.

## Development

Requires Node.js 22.18 or newer.

```bash
npm install
npm test               # core + hub test suites
npm run typecheck
npm run hub            # run a hub from source (data in ./hub-data)
npm run desktop:dev    # build and launch the desktop app
```

## Repository layout

```
apps/hub        hub service, its tests, Windows service packaging
apps/desktop    Electron main process, preload bridge, React UI
apps/gateway    the internet gateway: a Cloudflare Worker that relays encrypted traffic to the hub
apps/mobile     Android app (Capacitor) and its native LAN, file and notification plugin
packages/core   protocol, identity, discovery, hub client, end-to-end encryption (+ tests)
brand/          Dexterity International logo files and colour tokens
docs/           blueprint, design language, Cliq feature inventory, integrations, third-party licences
```

Internal software. © Dexterity Design Services Pvt. Ltd. All rights reserved.
