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
| Messaging | Spaces (open / private), Direct (1:1 and groups), side-tracks, @mentions and @everyone, reactions, pins, edit / delete, Seen receipts, typing, drafts, formatting, line-number references |
| Desk | Saved messages, reminders (on a message or standalone, for yourself or a colleague, repeating, snooze), messages scheduled to send later (sent by the hub even with your PC off), forwarding with credit, mark unread, polls (single or multiple choice, anonymous, closing time) |
| Organisation | Departments (nested, with heads), designations, reporting lines, extension, phone, seat, joining date, birthday and custom fields; an org chart; profiles beside the Directory; CSV import from Excel or Dexterity Sheets that also covers people who have not joined yet |
| Files | Drag, drop, paste or attach up to 1 GB; stored once on the hub; inline images with a viewer; Open / Save; Files panel |
| Rooms (calls) | Voice and video, up to 8 people, screen sharing with a picker, mini-Room, ringing, missed calls; media peer-to-peer on the LAN |
| Search | Ctrl+K across people, conversations, commands and message text (FTS5), jump to the message |
| Presence | Available, Busy, Do not disturb, Invisible; automatic Away on idle or screen lock; beacon rings |
| Notifications | Native toasts that open the conversation, taskbar / dock badge, mute per conversation |
| Admin | Control room: approvals, devices, roles, integrations (bot tokens), audit log, update mirror status |
| Integrations | Bot API on the hub; Hopper sends its notices here instead of Zoho Cliq (Hopper branch `claude/epic-fermi-h7zdk1`) |
| Updates | In-app updater on Windows, macOS and Android: on open, every 4 h and on demand; stable and beta channels; installs from the hub's mirror when offline |
| Platforms | Windows (NSIS), macOS (arm64 and x64 DMG), Android (APK), and the hub as a Windows service. Built by CI on every push |

**Next:** direct PC-to-PC fallback when the hub is off, end-to-end encryption of Direct messages, forms and notes, calendar and remote-work check-in, guest invites, retention and legal
hold, file viewing on phones, and the Sheets, Slate, Sleuth, Project Opener and Datum integrations.

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
packages/core   protocol, identity, discovery, hub client (+ tests)
brand/          Dexterity International logo files and colour tokens
docs/           blueprint and Cliq feature inventory
```

Internal software. © Dexterity Design Services Pvt. Ltd. All rights reserved.
