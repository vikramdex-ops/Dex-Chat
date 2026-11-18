# Dexterity Connect for iPhone

iPhones and iPads use Dexterity Connect as a **web app** that people add to the Home Screen from
Safari. There is no App Store app, no TestFlight, no Apple Developer account and no Apple push
certificate, and there never will be: the office has none and will not make one. Everything the
iPhone app needs comes from parts the office already runs: the office hub, and the Cloudflare
gateway Worker and meeting site that the hub deploys and updates itself
([REMOTE-ACCESS.md](REMOTE-ACCESS.md)).

The goal is the same experience and the same features as the Android app. Where iOS does not let a
web app do something, the app says so in plain words (table below) instead of failing.

## What people do

1. On their office PC: **Preferences → Your devices → Add my phone**.
2. They point the iPhone's camera at the QR code. The download page
   (`https://dexterity-admin.github.io/dexterity-connect/get/`) sees an iPhone or iPad and sends
   Safari on to `<gateway>/app/`, keeping the code in the `#fragment` (never sent to a server). The
   gateway forwards to the meeting site, `https://dexterity-meet.pages.dev/app/`, where the app lives.
3. Safari shows **Add Dexterity Connect to your iPhone**: copy the code, tap **Share → Add to Home
   Screen → Add**. (A Home Screen web app has storage of its own, apart from Safari's, so the code is
   carried across on the clipboard.)
4. They open **Dexterity** from the Home Screen and tap **Paste the code** (or scan the QR code with
   **Scan the code on your PC**). The iPhone joins as them, already approved, like an Android phone.
5. The app asks once whether to turn on notifications (iOS only asks from a tap).

People can also paste a code they emailed themselves, on the download page or in the app.
**Continue in Safari without adding it** works too, but without notifications, and Safari may clear
a site's data after a few weeks unused.

## How it works

| Part | Where | What it does |
| --- | --- | --- |
| The web app | `apps/web` | The same React interface as the desktop and Android apps (`apps/desktop/src/renderer`), with a bridge (`apps/web/src/bridge.ts`) built only from browser APIs. Built by Vite into `apps/web/dist`. |
| Where it is served | `apps/meet-site` | The meeting site's build copies `apps/web/dist` to `/app/`; its front door (`src/worker.ts`) serves it with the headers in `src/app-headers.ts`. The hub's cloud bundle carries it, so **Control room → Outside the office → Update the gateway** ships a new iPhone app. |
| `/app/` on the gateway | `apps/gateway` | Redirects to the meeting site (302, the `#fragment` is kept). Before the site exists, a page says how to set it up. |
| Connection | `packages/core/src/remote.ts` | Always through the gateway (`/c/<hub id>`), with the browser's WebSocket, inside the end-to-end encrypted channel pinned to the hub's certificate fingerprint from the code, exactly as Android outside the office. |
| Device keys | IndexedDB | The Ed25519 device key and the end-to-end encryption key, made on the iPhone, never sent anywhere (the hub sees only the public halves). The app asks for persistent storage. |
| Offline and updates | `apps/web/src/sw.ts` | A service worker keeps the app shell, so the app opens at once and, without a connection, shows its own "Reaching the office hub" screen. Each build has its own cache; a new build waits until the person taps **Reload to update**. |
| Notifications | `packages/core/src/webpush.ts`, `apps/hub/src/webpush.ts` | Standard Web Push (below). |

### Why the gateway only

A browser cannot reach the hub on the office network: it refuses the hub's own certificate (the
office issues it itself, which is fine for the apps that pin it, not for Safari), and a web page
cannot look for the hub with UDP discovery. So the iPhone app reaches the office through the
gateway even on the office Wi-Fi. Everything stays end-to-end encrypted between the iPhone and the
hub; the gateway sees sizes and timing only. A pairing code from an office that has not turned on
access from outside cannot work on an iPhone: the download page, the app and the PC's **Add my
phone** dialog all say so.

### Notifications without an Apple account

Safari supports standard Web Push (RFC 8030, 8291, 8292) for web apps on the Home Screen, from iOS
16.4. Nothing is registered with Apple: the push service's address comes from the iPhone's own
subscription.

- **Who sends:** the **hub**. Only the hub knows who a message is for, whether that iPhone is on
  screen, the person's notification preferences, Do not disturb and muted conversations. The VAPID
  key pair is made by the hub on first use and kept in its database with its other keys; the
  gateway and the Cloudflare account hold nothing new. (Sending from the gateway's Durable Object
  would have needed the hub to pass it every message's preview anyway, and put a private key in
  Cloudflare.)
- **When:** the app tells the hub when it goes to the background and comes back (`push.active`).
  While an iPhone has no connection on screen, new messages are gathered for about a second and sent
  as one notification per conversation (the same as Android's), at most four at once and a line for
  the rest.
- **What it says:** the hub applies the person's choices, which the app sends with its subscription:
  **Notify about** (everything, Direct and mentions, nothing), **Show message text in notifications**
  (off: the push says only "New message", and the push service never sees the text), quiet hours
  (in the iPhone's own time zone), muted conversations and Do not disturb. A message in an end-to-end
  encrypted conversation says "New encrypted message": the hub cannot read it, and the service
  worker does not hold the keys.
- **How:** each push is encrypted to the iPhone's subscription keys (RFC 8291, aes128gcm) and signed
  with the office's VAPID key (RFC 8292). The hub only sends to https addresses on the internet (never
  to an address on the office network). A subscription the push service says is gone (404, 410) is
  removed; removing the device removes it too.
- **On the iPhone:** the notification shows the conversation, the Home Screen badge shows how many
  messages are waiting (`navigator.setAppBadge`), and a tap opens that conversation.
- **Preferences → On this iPhone** shows whether notifications are on, turns them on or off and
  sends a test.

## Compared with Android

Every method of the Android bridge (`apps/mobile/src/bridge.ts`, `DexNative`) and every
Android-only feature, and what the iPhone app does instead.

| Android (`DexNative` / feature) | iPhone web app | Why |
| --- | --- | --- |
| `discover` (UDP discovery) | Not used: always the gateway | Web pages cannot send UDP. |
| `wsOpen` / `wsSend` / `wsClose` (pinned TLS on the office network) | Not used: always the gateway | Safari refuses the hub's own certificate. |
| `gwOpen` / `gwSend` (gateway socket) | The browser's `WebSocket` | Same channel, same pinning. |
| `secureGet` / `secureSet` (Android Keystore) | IndexedDB in the web app's own storage | iOS has no web API for a hardware key store; Safari 16 has no Ed25519 in WebCrypto. The keys stay on the iPhone. |
| `httpGet` (update feeds) | Not needed | The app updates with the office's gateway. |
| `download` / `installApk` (self-update) | Service worker update and **Reload to update** | A new gateway bundle is a new app; no store, no install. |
| `fileGet` / `fileUpload` / `fileWrite` / `fileRead` / `fileDelete` | Files through the encrypted channel, kept in memory (up to 160 MB, oldest dropped) | No file system for web apps. |
| `openFile` | iOS share sheet (**Open in…**, **Save to Files**); a download if the sheet cannot open | Web apps cannot open another app directly. |
| `saveToDownloads` | A download (Files → Downloads) | — |
| Attach from the phone | The file picker (Photo Library, Take Photo or Video, Choose File) | — |
| `clipboardText` (code from the download page) | **Paste the code** button (iOS shows its own Paste prompt) | Safari reads the clipboard only from a tap. |
| `showNotification` / `askNotifications` | Web Push from the hub; permission asked from a tap | — |
| `keepAlive`, `HubService.java` (background connection) | None: Web Push instead | iOS stops a web app's page soon after it leaves the screen. |
| `watchConfig` / `setConnected` / `watchCursor` (`/notify/wait` long poll) | Push subscription with the same preferences (`push.subscribe`) | The hub pushes instead of the phone polling. |
| `notifyHealth` / Notifications check / `openSettings` / `requestBatteryExemption` | Hidden; **Preferences → On this iPhone** instead | iOS has no battery optimisation or maker switches for web apps; it says when notifications are blocked and where to turn them on. |
| `takeLaunchLink` / `deepLink` (tapped notification) | The notification opens `/app/#open=<link>`, or the running app gets it from the service worker | — |
| `deviceInfo` | "iPhone (web app)" / "iPad (web app)" as the device name | Browsers do not tell a page the model. |
| Background catch-up (`notify.missed` on reconnect) | Not needed | Pushes already showed what arrived. |
| Badge | `navigator.setAppBadge` | iOS 16.4+. |
| Voice notes | Recorded as AAC (`.m4a`) | Safari's recorder has no WebM. |
| Calls, Rooms, meetings | Work while the app is open, through the gateway and the office's TURN relay | **Calls do not ring while the app is closed**: iOS does not let web apps ring in the background. Said in Preferences. |
| Screen sharing | Hidden | iOS has no screen sharing for web pages. |
| Describe-to-Automation's on-device model | Keyword drafting only (the drafter says so) | The 26 MB runtime is too big for the meeting site and a phone. |
| Several offices | Supported | Each office's gateway is reached from the code. |

## Limits worth knowing

- **iOS 16.4 or later** for notifications, and only from the Home Screen.
- **WebKit was not available for automated tests** here: the e2e test runs Chromium with iPhone
  emulation. The first real iPhone should confirm: Add to Home Screen and the launch screens, the
  safe areas, a real push from Apple's service, the share sheet, voice notes and a call through the
  TURN relay.
- Push needs the hub to reach the push service on the internet (for an iPhone, `web.push.apple.com`),
  over https, from the hub PC.

## For developers

- Build: `npm run build -w @dex/web` (into `apps/web/dist`); `npm run build -w @dex/meet-site` builds
  it again and copies it to `/app/`; the hub's `build-cloud.mjs` carries both.
- Tests: `apps/web/test/web.test.ts` (codes, gateway-only joining, device names, notifications, the
  site's headers and routes), `packages/core/test/webpush.test.ts` (RFC 8291's own example, VAPID),
  `apps/hub/test/webpush.test.ts` (when and what the hub pushes), `apps/gateway/test` (`/app/`), and
  the e2e walk `apps/desktop/e2e/iphone.mts` (real hub and gateway, a local push service).
- `state.platform` is `'ios-web'`; `isPhonePlatform()` in `apps/desktop/src/shared/bridge.ts` covers
  both phones. The web app's own interface is in `apps/desktop/src/renderer/views/WebApp.tsx`.
