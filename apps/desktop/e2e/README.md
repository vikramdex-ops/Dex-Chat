# End-to-end tests

These scripts drive the real desktop app (Electron) against a real hub started in the same process. They play
colleagues sending messages, joining Rooms, approving devices and so on, then check what the screen shows.
Each script prints `… E2E PASSED` when it succeeds and saves screenshots (light and dark) in `out/`.

## Running them

```bash
npm ci
npm run desktop:build                 # the scripts run the built app
npm run build -w @dex/mobile          # only for the phone scripts (phone, phone-sec, assist-phone)
npm run e2e                           # every script, one after another
npm run e2e -- nav search pdf         # only these
npm run e2e -- --isolated             # each hub on its own free port (when something else uses 47900)
```

- The runner prints PASS or FAIL for each script, with the path of its log, and exits with 1 if any failed.
- On Linux with no display, it uses `xvfb-run` when that is installed.
- A script that lost the hub port to another program is run again.
- Scripts can also be run on their own: `node apps/desktop/e2e/nav.mts`. Node 22 runs TypeScript directly.
- The scripts use `playwright-core` (a dev dependency) to control Electron.

### Extra setup for some scripts

- **Browser pages** (`m2-guest`, `m3-webinar`, `remote`, `phone-sec`, `assist-phone`) open Chromium. Install it once with `npx playwright-core install chromium`.
- **Gateway pages** (`m2-guest`, `m3-webinar`, `remote`) run the gateway locally with Wrangler (`apps/gateway`).
- **Accessibility checks** (axe) in `tourlib.mts` run only when `DEX_AXE` points at a copy of `axe.min.js`. axe-core is not a dependency of this repository.

## What is here

- `harness.mts`: shared helpers. A fresh hub in a temporary folder; Vikram, the owner, scripted to approve every new device; `launch()` for an app as a named colleague; and screenshots in both themes.
- `seed.mts` and `officeseed.mts`: realistic offices. Long names, Hindi and Tamil text, files and side-tracks; 40 people with departments, managers and seats; `bigOffice(500)`.
- `tourlib.mts`: screenshot tours and layout checks used by the meetings and gateway scripts.
- **One script per area:**
  - messaging: `nav`, `msgacts`, `search`, `format`, `links`, `polish`
  - meetings: `meet`, `m2-*`, `m3-webinar`, `lounge`, `pointers`, `meetrecap` (threads, action points, recaps; a browser guest through the gateway; a hub restart mid-meeting)
  - files: `files`, `pdf`, `media`, `ocr`, `dmsearch`
  - bots: `bots-*`, `botmaker`, `flows`
  - org chart: `org`, `orgscape`
  - devices: `pair`, `phone`, `phone-sec`
  - Control room: `admin2`, `m2-admin`, `policy`, `dlp`
  - notice board: `notices` (desks, scheduled issue, acknowledgement and its register, Rev B, PDF search, urgent banner, expiry; screenshots in `NOTICES_OUT`)
  - plus others.

## Timing

A full run takes about an hour, much of it waiting for calls and the webinar stream. When a script fails, look at its log and screenshots in `out/` first. On a busy machine some steps can time out; run the script again on its own before treating it as a bug.
