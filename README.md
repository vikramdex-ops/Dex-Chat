# Lattice

An offline-first messenger for an office LAN. Messages and files travel only between machines on
your own network — there is no cloud, no account service, and no internet requirement.

Built with Node.js built-ins only (HTTP, `node:sqlite`, UDP, crypto). No dependencies to install.

## Requirements

- Node.js **22.5 or newer** on the machine that hosts the server (Windows, macOS or Linux).
- Every colleague needs only a modern browser — nothing to install on their PC.

## Quick start (Windows, everything on D:)

1. Copy this folder to `D:\lattice`.
2. Double-click `start.bat` (or run `node server\index.js` in that folder).
3. It prints two addresses. Share the **Network** one, e.g. `http://192.168.1.24:3000`.
4. Each colleague opens that address, types their name, and is in.

Nothing is written outside the folder you copied. Keep the folder on `D:` and no other disk is touched.

### Windows Firewall

Allow Node.js on **private** networks when prompted, or add the rules once in an admin PowerShell:

```powershell
New-NetFirewallRule -DisplayName "Lattice TCP" -Direction Inbound -Protocol TCP -LocalPort 3000 -Profile Private -Action Allow
New-NetFirewallRule -DisplayName "Lattice Discovery" -Direction Inbound -Protocol UDP -LocalPort 47823 -Profile Private -Action Allow
```

## Configuration

All settings are environment variables; every one is optional.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `WORKSPACE_NAME` | `Office` | Name shown in the sidebar |
| `DATA_DIR` | `./data` | Where the database and uploads live |
| `MAX_UPLOAD_BYTES` | `536870912` | Largest single file (512 MB) |
| `DISCOVERY_PORT` | `47823` | UDP port used to find other Lattice servers |
| `LATTICE_NO_DISCOVERY` | unset | Set to `1` to disable the UDP beacon |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug` |

Example:

```powershell
$env:PORT = "8080"; $env:WORKSPACE_NAME = "Dex Engineering"; $env:DATA_DIR = "D:\lattice\data"
node server\index.js
```

## What it does

- Channels, direct messages and group conversations
- Replies and threads, reactions, pins, forwarding, edit and delete
- Full-text search scoped to conversations you belong to
- File sharing with drag and drop, progress, inline image preview, and disk deduplication
- Presence, typing indicators, unread counts and read state
- LAN discovery: other Lattice servers on the same subnet appear under "People on this network"
- Admin tools: workspace overview, JSON export, role management, channel deletion

## Data, backup and restore

Everything lives under `DATA_DIR`:

- `lattice.db` — SQLite database (WAL mode)
- `files/` — uploaded file content

To back up, stop the server and copy the whole folder. To move it, copy the folder anywhere and point
`DATA_DIR` at it. Admins can also download a JSON export from **Settings → Admin**.

`data/` is git-ignored and is never created outside the folder you run from.

## Day-to-day operation

- **Start at boot:** create a Task Scheduler task (Windows) or a systemd unit (Linux) that runs
  `node server/index.js` in this folder. `SIGINT`/`SIGTERM` shut it down cleanly.
- **First user is the admin.** Promote others in Settings → Admin.
- **Health check:** `GET /api/health` returns workspace, counts and uptime — point your monitoring at it.
- **Logs:** one JSON object per line on stdout, so they can be piped into a file or a log collector.

## Desktop app and installers

The same server also ships as a desktop application built with Electron, which adds the tray icon,
launch-at-sign-in, native notifications, `lattice://` links and download handling. The app starts the
LAN server itself on port **47825** and stores data beside the executable when that location is
writable (for example `D:\lattice\data`), so a `D:` install never writes to `C:`.

```bash
npm ci          # installs Electron and electron-builder
npm run desktop # run the app against the current folder
npm run dist:win    # NSIS installer + portable .exe
npm run dist:linux  # AppImage + .deb
npm run dist:mac    # .dmg
```

Installers are produced automatically by `.github/workflows/build.yml` on **every push and pull
request** (Windows, Linux and macOS in parallel, uploaded as build artifacts). Pushing a tag such as
`v1.0.0` also publishes a GitHub release with the installers attached. The workflow runs the full test
suite first and will not package if tests fail.

Desktop builds are unsigned. Windows SmartScreen will warn on first run until you add a code-signing
certificate; see the `CSC_*` secrets electron-builder reads.

## Feature parity

`PARITY.md` tracks every Zoho Cliq capability against Lattice, including what the reverse engineering
established about the Cliq desktop package and what is deliberately out of scope for an air-gapped
office.

## Tests

```bash
node --test tests/
```

The suite starts a real server in a temporary data directory and covers authentication, membership
authorization, messaging, threads, forwarding, pagination, uploads and dedupe, search scoping,
read state, channel lifecycle, admin boundaries and live event delivery.

## Security notes

- Each user gets a random 48-character token; the browser stores it and sends it as a bearer token.
- Every message, file and search is authorized against channel membership on the server.
- Responses carry a strict Content-Security-Policy, and uploads are served as attachments unless they
  are images explicitly requested for inline preview.
- Traffic is plain HTTP. On a trusted office LAN that is normally acceptable; if you need encryption,
  put the server behind a reverse proxy with TLS, or run it over WireGuard.
- There are no passwords. Anyone who can reach the port can create an identity. Restrict access with
  the firewall or the reverse proxy if the network is not trusted.

## Limits and roadmap

Media calls, screen sharing, message translation and third-party integrations are intentionally out of
scope: each needs either an on-premise media server or internet access. Self-hosted Jitsi or LiveKit on
the same machine is the standard way to add calls.

## License

Internal use. No third-party code is bundled: every dependency is a Node.js built-in.
