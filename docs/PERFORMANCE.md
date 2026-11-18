# Performance and footprint

What the installers weigh, what the apps cost in memory and processor time, how each number is
measured, and what was changed to make them lighter. Every number here was measured on the build
machine described below unless it says "expected"; re-measure with the commands in each section.

The measuring machine: Linux, 4 cores shared with other work, the desktop app under Xvfb (no GPU,
so Chromium draws in software and the GPU process holds its frames). Working sets on Linux count
shared pages too. Compare numbers within this file, not with a Windows PC's Task Manager.

## The installers

| Package | Before (0.1.106) | After | How it was measured |
| --- | --- | --- | --- |
| Windows app, `DexterityConnect-Setup.exe` | 157 MB | about 131 MB (expected) | the NSIS payload electron-builder builds for it, on Linux: 156.4 MB → 130.4 MB; the setup adds about 0.3 MB |
| Windows app, installed | 480 MB | 399 MB | `win-unpacked` |
| `app.asar` (the app itself) | 100.4 MB, 443 files | 67.6 MB, 332 files | `scripts` below |
| macOS DMGs (each) | 165–169 MB | about 145–150 MB (expected) | same contents as Windows (no copied `node_modules`, no source maps, 4 of 55 languages); the CI release build gives the real size |
| Android APK | 18 MB | about 7–8 MB (expected) | the phone's web assets: 50 MB → 10 MB, 14.1 MB → 3.6 MB compressed as in the APK |
| Hub, cloud bundle inside `DexterityConnectHub.exe` | 17.4 MB | 7.7 MB | `node apps/hub/scripts/build-cloud.mjs out.json` |
| Hub zip | 46 MB | about 44 MB (expected) | the bundle compresses 7.5 MB → 5.7 MB with deflate |
| Hub setup | 31 MB | about 31 MB | its solid LZMA already compressed the bundle well (5.79 MB → 5.65 MB) |

### What made the Windows and macOS apps smaller

- **No copied `node_modules`.** MediaPipe, the noise suppressor, jsQR and mediasoup-client were listed
  as the desktop app's runtime `dependencies`, so electron-builder copied them into `app.asar` (31.5 MB,
  29.8 MB of it MediaPipe's four WebAssembly builds). Vite bundles all four into the renderer, so they
  are now `devDependencies` and the package holds only `dist-electron`, `dist-renderer` and
  `package.json`. The main process is bundled by esbuild and needs no `node_modules` either.
- **No source maps.** `main.cjs.map` (1.4 MB) is still written for development but left out of the package.
- **Four languages of Chromium's own strings** (`electronLanguages`: en-US, en-GB, Hindi, Tamil).
  Chromium uses these only for its built-in texts (form-check messages, date pickers, media
  controls); the app's own translations are in the renderer. A PC set to another English (en-IN) uses en-GB. On Windows this
  is 51.2 MB → 4.6 MB of `.pak` files.
- **Solid compression of the Windows payload** (`nsis.differentialPackage: false`). By default
  electron-builder packs the NSIS payload for differential updates: LZMA with a 1 MB dictionary and
  each file on its own. The in-app updater (`apps/desktop/src/main/updater.ts`) downloads whole
  installers and checks their SHA-512, and no blockmap is published, so that costs size for nothing.
  Now the payload is one solid LZMA2 block with a 256 MB dictionary: about 15 MB smaller for the same
  files. Installing is no slower (LZMA unpacks at the same speed; it needs the dictionary in memory,
  256 MB at most, for the few seconds of the install).

What is left in the Windows payload: the Electron runtime 102.7 MB compressed (the same for every
Electron app), the app 28.1 MB, of which the Automations sentence model is about 16 MB.

### Android

The phone app shares the desktop renderer. Describe-to-Automation's worker imported the ONNX runtime,
whose two WebAssembly builds (26.9 MB and 14.3 MB) were bundled into the phone's assets, although the
sentence model's own files are copied into the desktop app only, so on the phone the model never
loaded and drafting always used keywords. The phone build now replaces the worker with the same small
stand-in the iPhone app has used from the start (`apps/mobile/vite.config.ts`): the same keyword
drafting, the same "keywords only" note, 10 MB less in the APK.

### The hub

The hub carries the gateway Worker, the meeting site and the iPhone web app (`cloud-bundle.json`, a
SEA asset). Each of the site's files is now stored brotli-compressed (quality 9, when that saves 10%
or more) and unpacked just before it is uploaded: Cloudflare takes the plain file and compresses it
itself. The hashes are those of the plain files, so a deploy uploads exactly what it did before. The
round trip is tested against a real `wrangler dev` (`apps/hub/test/cfdeploy-workerd.test.ts`).

## Memory and processor time

Measured with `apps/desktop/scripts/perf/memory.mts` (below) against the seeded office: 120 people,
300 conversations, 60,000 messages, the busiest conversation with 6,000.

| At rest, all processes | Before | After |
| --- | --- | --- |
| After start-up: total | 601 MB | 604 MB |
| main process (Browser) | 186 MB (JS heap 14 MB) | 188 MB (JS heap 9 MB) |
| window (Tab) | 181 MB (JS heap 10 MB) | 182 MB (JS heap 10 MB) |
| GPU process (software drawing under Xvfb) | 161 MB | 162 MB |
| network service | 73 MB | 72 MB |
| With the busiest conversation open: window | 200 MB | 202 MB |
| Processor at rest | 1.0% of one core | 1.3% of one core |
| Processor hidden in the tray | 2.3% of one core | 3.6% of one core |

Nothing the app does at rest was changed, and the two runs agree within the noise of a machine whose
load average was 4 to 10 on 4 cores. The savings are in what stays loaded after a feature is used
(below), which a run at rest does not see.

The app at rest was already light, and nothing leaks: in `perf.mts`'s ten minutes of moving between
every lens and conversation the window's memory stays level, and what it holds right after a burst of
navigation (410–850 MB, depending on the background traffic) is garbage that Chromium collects by
itself within about 20 seconds at rest (410 MB → 206 MB measured). With a conversation open, the
blinking caret in the composer costs about 8% of a core in the GPU process here, because Xvfb draws
in software; on a PC with a graphics card this is negligible, and it is not changed.

What stayed in memory after a feature had been used once, and now goes:

| Held after use | Size | Now |
| --- | --- | --- |
| Describe-to-Automation's sentence model (its worker: the ONNX runtime and the model) | about 140 MB in the window's process | ended 3 minutes after its last use; loads again in under a second (`flows/model.ts`) |
| Background blur's segmenter (MediaPipe's WebAssembly engine and model) | about 45 MB | closed a minute after the last camera using it stops (`rooms/blur.ts`) |
| OCR (Tesseract) | | already ended a minute after use (`ocr.ts`) |
| The hub: the parsed cloud bundle, once an administrator opened Outside the office | 50 MB of the hub's heap for the rest of its run | 22 MB, let go two minutes after a setup or update; the card needs only the versions (`apps/hub/src/cfdeploy.ts`) |

The hub's other long-lived maps (rate limits, sessions, the statement cache of 2,000 compiled SQL
statements, SQLite's default 2 MB page cache) are bounded: by the number of people, devices or
rules, or pruned when they pass a size.

## Start-up and use

`perf.mts --quick` before these changes (the renderer's start-up code is unchanged by them):

| | Value | Budget |
| --- | --- | --- |
| Start, warm | 646 ms | 1,500 ms |
| Start, cold | 726 ms | 3,000 ms |
| Script loaded at start | 57 files, 1.8 MB (of 91 chunks, 5.6 MB) | |

The window loads only what it shows: calls, the whiteboard, PDF.js, OCR, the sentence model, the
segmenter, the Control room, the bot maker and each language's words load when first used.

## How to measure

```bash
npm run desktop:build
# the installer's contents: an unpacked app (and, for Windows, the NSIS payload; on Linux the
# final step needs wine, but the payload .7z in apps/desktop/release is the installer's size)
cd apps/desktop && CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --linux dir --win dir --x64 --publish never
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --win nsis --x64 --publish never
# memory and idle processor time, with budgets
PLAYWRIGHT=/path/to/playwright-core/index.mjs xvfb-run -a node apps/desktop/scripts/perf/memory.mts --check
# start-up, lenses, scrolling, typing, search and ten minutes of use, with budgets
PLAYWRIGHT=/path/to/playwright-core/index.mjs xvfb-run -a node apps/desktop/scripts/perf/perf.mts --check
```

`memory.mts` budgets (all processes at rest under 900 MB, the window under 300 MB, the main process
under 260 MB, the window with the busiest conversation under 600 MB, under 8% of a core at rest and
5% hidden in the tray) leave room for a busy machine; a missed budget means look, not panic.

## Not done, and why

- **Downloading the sentence model on first use instead of shipping it** (about 16 MB of the
  Windows installer). The hub would have to carry it instead (its setup installs one flat folder and
  is tested by an install, repair, upgrade and self-update run on every release), people outside the
  office reach the hub only through the gateway, and the app promises that drafting works on the PC
  with nothing downloaded. It is used by the people who write automations, so the saving is real;
  if it is wanted, serve it from the hub's update mirror with a SHA-256 check and keep the keyword
  fallback.
- **DMG format.** The DMGs stay UDZO at zlib level 9. ULFO (lzfse) is not clearly smaller and UDBZ
  (bzip2) is slower to open; neither can be checked here.
- **Android R8 and resource shrinking.** Capacitor finds plugins by reflection; its own ProGuard
  rules cover that, but without an Android SDK here the release APK could not be built and opened to
  prove it. Worth doing with a phone to test on: `minifyEnabled true` with
  `proguard-android-optimize.txt` and a keep rule for `in.co.dexteritydesign.connect.**`.
- **Removing Electron's own files** (for example `dxcompiler.dll`, 25.8 MB, used by WebGPU, which the
  app does not use). Deleting runtime files from Electron is fragile across upgrades.
- **Chromium switches and V8 heap flags.** At rest the app uses about 1% of a core and the window's
  JavaScript heap is 10–30 MB, so there was nothing for them to fix.
- **Minifying the hub's bundle** (4.1 MB): about 0.4 MB compressed, at the cost of readable stack
  traces in the hub's log.
- **Splitting the window's start-up code further**: start-up is 650–730 ms against a 1.5 s budget.
