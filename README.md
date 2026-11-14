# Dexterity Connect

Dexterity's internal workplace messenger. It runs entirely on the office network, works with the internet unplugged, and is designed from scratch around Dexterity's brand.

> Status: **Phase 0 (foundation)**. Device sign-in, admin approval, the people directory and live presence work end to end. Messaging is next.
> The full plan is in [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md). The feature research is in [`docs/CLIQ-FEATURE-INVENTORY.md`](docs/CLIQ-FEATURE-INVENTORY.md).

## How it fits together

| Part | What it is | Where it runs |
| --- | --- | --- |
| **Hub** (`apps/hub`) | Always-on service that holds the directory and approvals, and in later phases history, files and call relay | One office PC, as a Windows service |
| **Desktop app** (`apps/desktop`) | Electron + React app people use every day | Every Windows PC (macOS builds too) |
| **Core** (`packages/core`) | Shared protocol, device identity, LAN discovery and hub client | Used by both |

Apps find the hub on their own with a LAN broadcast probe. Every PC has its own Ed25519 device key, sealed with Windows DPAPI. The first device to join becomes the owner, and every later device waits until an admin approves it. Both sides see the same 8-character device code, so the admin can confirm who they are approving. Each sign-in proof is tied to that particular connection and to the hub's certificate, so a stolen or replayed proof is useless. The connection itself is TLS, pinned to the hub's certificate fingerprint.

## Getting the installers

Every push runs GitHub Actions (**Actions → build**), which tests everything and then produces:

- `DexterityConnect-Setup-<version>.exe`: the Windows app installer
- `DexterityConnect-<version>-mac-arm64.dmg` / `-x64.dmg`: macOS (unsigned)
- `DexterityConnectHub-<version>-win-x64.zip`: the hub as a Windows service

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

Internal use only. © Dexterity International.
