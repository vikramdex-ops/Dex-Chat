# End-to-end tests

These scripts drive the real desktop app (Electron) against a real hub started in the same process. They play
colleagues sending messages, joining Rooms, approving devices and so on, then check what the screen shows.
Each script prints `… E2E PASSED` when it succeeds and saves screenshots (light and dark) in `out/`.

## Running them

```bash
npm ci
npm run desktop:build                 # the scripts run the built app
npm run build -w @dex/mobile          # only for the phone scripts (phone, phone-sec, phone-resume, anyupdate, assist-phone)
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

- **Browser pages** (`m2-guest`, `m3-webinar`, `lobby`, `remote`, `phone-sec`, `phone-resume`, `anyupdate`, `assist-phone`) open Chromium. Install it once with `npx playwright-core install chromium`.
- **Gateway pages** (`m2-guest`, `m3-webinar`, `lobby`, `remote`, `anyupdate`) run the gateway locally with Wrangler (`apps/gateway`).
- **Accessibility checks** (axe) in `tourlib.mts` run only when `DEX_AXE` points at a copy of `axe.min.js`. axe-core is not a dependency of this repository.

## What is here

- `harness.mts`: shared helpers. A fresh hub in a temporary folder; Vikram, the owner, scripted to approve every new device; `launch()` for an app as a named colleague; and screenshots in both themes.
- `seed.mts` and `officeseed.mts`: realistic offices. Long names, Hindi and Tamil text, files and side-tracks; 40 people with departments, managers and seats; `bigOffice(500)`.
- `tourlib.mts`: screenshot tours and layout checks used by the meetings and gateway scripts.
- **One script per area:**
  - messaging: `nav`, `msgacts`, `search`, `format`, `links`, `polish`
  - meetings: `meet`, `m2-*`, `m3-webinar`, `lounge`, `pointers`, `meetrecap` (threads, action points, recaps; a browser guest through the gateway; a hub restart mid-meeting), `lobby` (who is waiting: a browser guest at a personal room while the host's app is elsewhere, the notification, indicator, corner card and Nib card, Decline and Admit from them, the meeting chat's count and background notification, End for everyone from every tab and the folded chip, an instant meeting's lobby, Hindi; uses the system Chrome when Playwright's Chromium is not installed; screenshots in `LOBBY_OUT`)
  - files: `files`, `pdf`, `media`, `ocr`, `dmsearch`
  - bots: `bots-*`, `botmaker`, `flows`, `templates`, `botnet` (bots talking to bots: a handoff with its relay card, a query in a flow, an event, a refusal, a loop stopped; scheduled jobs in plain words, a dry run, runs with the hub's clock moved, missed runs, the job sheet and the network sheet)
  - org chart: `org`, `orgscape`
  - devices: `pair`, `phone`, `phone-sec`, `phone-resume` (reopening the phone app: a short trip to the background with its socket closed shows nothing and keeps the conversation, a message sent meanwhile appears; a long outage gets one row after 3 s; a recreated WebView shows the mark, then the app; the phone app's own code in Chromium with `phonemock.mts`, the stand-in native layer), `anyupdate` (updates on any network: GitHub and jsDelivr unreachable, the phone on mobile data and a laptop at home find and download the build from the hub through the local gateway, verified; what a failed check shows, in Hindi too), `iphone` (the iPhone web app against a real hub and the gateway, in Chromium with iPhone emulation: the Add to Home Screen guide, joining with a pasted code, messages, a photo and a file, Web Push to a local push service, a tapped notification, offline; needs `npm run build -w @dex/web`; screenshots in `IPHONE_OUT`)
  - Control room: `admin2`, `m2-admin`, `owners` (several owners, handing over, what an administrator may not change), `policy`, `dlp`, `hubupdate` (the hub updating itself, against a stand-in feed and launcher: a new version found and checked, Update now waiting for a live call, the setup started when it ends, an update that went back with its log and Try again, the setup check line, the switch; screenshots in `HUBUPDATE_OUT`)
  - seating: `seating` (the real floor plan: dragging people onto seats, a swap, a team moved with a preview, a plan for Monday applied by the hub's clock, the moved person's notice and walk, revisions compared, a bench added in the layout editor, a CSV import, 150 seats measured; screenshots in `SEATING_OUT`)
  - notice board: `notices` (desks, scheduled issue, acknowledgement and its register, Rev B, PDF search, urgent banner, expiry; screenshots in `NOTICES_OUT`)
  - Nib: `nib` (a whole day in three apps), `nibfix` (the wrap-up fits its tray in three languages, Nib's times, a tray kept live from another device, the lobby rule names), `nibasks` (wrap-up 18:00, register 18:30: when the asks go in the Control room and its note for a short window, the drop, the callout and the message, the register's "asked 3×", one follow-up at 19:00), `holidaypdf` (the holiday circular dropped into Nib's conversation, read back, registered, Office holidays with each day's source, the same PDF again; `HOLIDAY_PDF` for the real circular, `HOLIDAY_SCAN` for a scan read on the PC)
  - Zoho Calendar: `zoho` (against the mock Zoho in `apps/hub/test/zoho-mock.ts`, never the real one: the disabled button before setup, the Control room's one form, Connect through the loopback listener, a 10:00 IST meeting arriving in Zoho at 04:30Z, a read-only Zoho event, Reconnect; screenshots in `ZOHO_OUT`)
  - plus others.

## Timing

A full run takes about an hour, much of it waiting for calls and the webinar stream. When a script fails, look at its log and screenshots in `out/` first. On a busy machine some steps can time out; run the script again on its own before treating it as a bug.
