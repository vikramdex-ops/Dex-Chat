# Outside the office: the internet gateway

People can use Dexterity Connect at home, on leave or on mobile data, on their own laptop or
Android phone, with every feature they have in the office: messages, files, calls, the Desk,
the Calendar and notifications. This page explains how it works, what is exposed to the internet,
and how to set it up.

## How it works

```
 Phone / home laptop ──wss──▶  Gateway (Cloudflare Worker, your account)  ◀──wss── Office hub
          └──────────── encrypted channel, device ⇄ hub (the gateway cannot read it) ────────┘
```

- **The office opens no ports.** The hub connects *out* to the gateway and keeps that connection
  open. Nothing on the office network listens on the internet.
- **The gateway only relays.** It is a small Cloudflare Worker (`apps/gateway`, about 450 lines, plus the guest meeting page and the webinar pages)
  with one Durable Object per hub. It pairs each device's WebSocket with the hub's and passes
  opaque binary frames. It stores no messages, files or keys. The only things it saves are the hub's
  certificate fingerprint (only when you don't pin one), which hub its meeting pages lead to, and,
  for ten minutes, how many wrong guest passcodes came from an address, and for an hour, how many
  webinar registrations came from an address (and from all addresses together).
- **Each device has an encrypted channel to the hub.** Inside the gateway's WebSocket, the device and
  the hub run their own handshake (`packages/core/src/remote.ts`):
  - X25519 key exchange, HKDF-SHA256, and one AES-256-GCM key per direction.
  - A 64-bit counter as the nonce, so a frame cannot be replayed, dropped or reordered without
    the channel failing.
  - The hub signs the handshake with the private key of its own TLS certificate. Each device
    checks that the certificate's SHA-256 fingerprint is the one it already pins, the same
    fingerprint it uses on the office network. A gateway, a Cloudflare employee or anyone on
    the path cannot pose as the hub or read the traffic.
- **The hub treats the device as if it were on the office network.** The hub replays each channel
  into its own local endpoint. Sign-in (the device's Ed25519 proof, bound to the hub's
  fingerprint), approval, roles, guests, retention, legal hold and every permission apply unchanged.
- **Inside the channel, HTTP is limited** to file transfers (`POST /files`, `GET /files/<id>`) and
  update downloads. The bot API and everything else answer `403`.
- **Calls** carry their signalling through the channel. The audio and video use WebRTC, encrypted
  end to end with DTLS-SRTP. Across networks they need STUN/TURN; see *Calls across networks*.
- **Devices pick the route themselves.** They try the office network first and use the gateway
  when it is unreachable. A phone on mobile data, or on a Wi-Fi where the gateway worked last time,
  tries the gateway first, then the office network. Once the hub is seen on the office Wi-Fi again,
  they move back to it. The title bar shows a globe while the app is going through the internet.
- **Updates come through it too.** A phone or laptop connected through the gateway asks the hub's
  update mirror through the channel (`GET /updates/<channel>.json` and `/updates/files/…`, with
  ranges, so a dropped download resumes), alongside GitHub and jsDelivr, and downloads from whichever
  works: a network that blocks GitHub still updates, from the office. The build's size and SHA-512 are
  checked as for any other download.

## What is exposed, and how it is limited

| Surface | Who can reach it | Limits |
| --- | --- | --- |
| Gateway `/hub/<id>` | Anyone on the internet | Only a connection that signs a fresh challenge with the hub certificate's key is accepted. With `HUB_FINGERPRINT` set, it must be *this* hub's certificate. Otherwise the first hub is remembered and any other hub is refused. At most 4 hub connections. |
| Gateway `/c/<id>` | Anyone on the internet | Refused unless the hub is connected. Binary frames only, at most 1 MiB each. 40 connections a minute per address, 600 devices at once. The first frame must be a valid handshake, or the hub closes it. |
| Gateway `/join`, `/health` | Anyone | Static pages, strict headers, no data. |
| Meeting site `/<meeting ID or name>`, `/assets/*` | Anyone | Dexterity Meet's landing page: one shell with no meeting data, its script, styles and fonts named by content, a strict content security policy (nothing loads from anywhere else, `connect-src` only the site). Served on the meeting site's address (the Pages project passes requests to the gateway through a service binding), or on the gateway's own address until a site is set. See [DEXTERITY-MEET.md](DEXTERITY-MEET.md). |
| Meeting site `/api/m/<ref>`, `/api/m/<ref>/check` | Anyone | What a page may show before a passcode (date, time, the office; the title and the host's first name when allowed), and the passcode check (POST body). Only an allowlist of fields passes the gateway; unknown, ended, cancelled and switched-off meetings get one answer. 60 questions a minute and 30 names that lead nowhere per 10 minutes per address, 240 a minute per meeting; wrong passcodes count with the socket's (5 per 10 minutes per address). Not answered on the gateway's own address once a site is set. |
| Gateway `/m/<meeting ID>` | Anyone | Old guest links: redirected to the meeting's page on the meeting site (the browser keeps the `#passcode`). |
| Meeting site `/api/m/<meeting ID>/ws` (and the old gateway `/m/<meeting ID>/ws`) | Anyone with a guest link | Refused unless the hub is connected. JSON frames only, at most 64 KiB each and 400 per 10 seconds. 20 connections a minute and 5 wrong passcodes per 10 minutes per address (kept in the Durable Object's storage), 300 guests at once. The hub checks the passcode (and limits wrong ones again, 10 per 10 minutes per address); a guest only ever reaches the meeting's lobby. |
| Gateway `/w/<webinar ID>`, `/w/<ID>/watch`, `/w/<ID>/survey` | Anyone | The webinar's registration, watch and survey pages and their script and styles: static, from the Worker, the same strict content security policy; they ask for no camera or microphone. |
| Gateway `/w/<ID>/info`, `/register`, `/survey-info`, `/answers` | Anyone | Answered by the hub over its own connection (10 seconds at most, else a plain error). JSON of at most 16 KiB. A form with the hidden honeypot field filled is thanked and dropped. 60 requests a minute per address; 5 registrations an hour per address and 300 an hour in all (kept in the Durable Object's storage); 10 survey answers an hour per address. The hub checks everything again: the webinar's cap and whether registration is open, valid answers, one registration per email (a duplicate never learns the link), 10 registrations an hour per address. |
| Gateway `/cal/<token>.ics` | Anyone with a person's calendar address | GET and HEAD only. Refused unless the hub is connected. 30 requests a minute per address at the gateway. The hub checks the token (43 random characters, kept only as a SHA-256 hash), turns a network away for an hour after 30 wrong addresses, and answers with that person's feed as `text/calendar` (at most 250,000 characters). A reset or an offboarding stops the old address at once. |
| Gateway `/w/<ID>/ws` | Anyone with a personal link | A guest socket, as for meetings: the token is checked by the hub, and a link that does not work counts as a wrong passcode for the address (5 per 10 minutes at the gateway). An attendee's session can only watch that webinar: ask, vote, answer the poll, raise a hand, react, download its handouts. |
| Hub, through a channel | A device that completed the handshake | Unknown devices can only *ask* to join (they become pending). At most 10 such requests an hour from outside, and administrators can turn new joins from outside off altogether. The Control room is office-only unless an administrator allows it. Every action is audited, and outside connections show as `internet <address> (<country>)`. |
| Office hub on the internet | Nobody | It accepts no inbound connections from the internet. |
| Bot API, integrations, update mirror admin | Office network only | Not reachable through the gateway. |

What the gateway (and Cloudflare) *can* see:
- That a device is connected, its IP address and country, and when.
- The sizes and timing of encrypted frames.

They never see message text, file contents, names, keys or call media.

The one exception is a calendar feed someone chose to subscribe to through the gateway
(Preferences → Calendar → From anywhere): Outlook and phone calendars cannot open the encrypted
channel, so the gateway passes that feed on as it is, and it can read the meeting titles, times and
meeting links in it. On the office network the same feed comes straight from the hub.

## Guests in meetings (browser, no install)

A meeting's hosts can give people outside the office a **guest link**, for example
`https://dexterity-meet.pages.dev/p12-design-review#Hx7kP2qR`: the meeting's page on the office's
meeting site (Dexterity Meet, [DEXTERITY-MEET.md](DEXTERITY-MEET.md)), which the gateway serves
through the Pages project's service binding. Old links, `https://<gateway>/m/<ID>#<passcode>`,
redirect there. The page: the guest enters their name, checks their camera and microphone, and waits in the
lobby until a host lets them in. Then they see and hear the meeting, share their screen, write in
the meeting chat, raise a hand and react. Nothing is installed.

- **The passcode** (6 to 10 letters and digits) is the part after `#`. Browsers never send the
  fragment to a server, so it appears in no log; the page sends it in its first frame and then
  removes it from the address bar. The hub checks it.
- **Guests always wait in the lobby**, whatever the meeting's lobby setting, and a locked meeting
  refuses them. They have no account: the hub gives each one a short session that can only take
  part in that meeting. They see the names of the people in the meeting and nothing else (no
  Directory, no conversations, no presence). They never inherit host controls.
- **Hosts** turn the link on or off, renew its passcode (the old link stops working), and copy it
  or a whole invitation (as text, or an `.ics` file for any calendar) from the Room's host controls,
  the Calendar's meeting dialog, or the personal room card on the Meet lens. **Administrators**
  can turn guest links off for the office (**Control room → Policies → Meetings**): every link
  stops at once.
- **How it travels.** The page's WebSocket goes to the gateway, which passes its frames to the
  hub as *guest frames* on the hub's own outbound connection (TLS to Cloudflare). Guest frames are
  not inside a device's end-to-end channel: the gateway serves the guest's page, so for guests it
  is trusted the way any website is trusted by its visitors. Pin the gateway to the hub
  (`HUB_FINGERPRINT`) so only your hub can receive them. The gateway remembers which hub
  meeting pages lead to: the first hub that signs in, and only that hub (the same certificate)
  afterwards.
- **Media** goes straight between the guest's browser and the PCs in the meeting (WebRTC,
  encrypted with DTLS-SRTP), through TURN when needed: set up **Cloudflare TURN** (below) for
  guests on strict networks. The gateway never carries audio or video.
- **Meetings of more than 8 people** run on the hub's relay, which is on the office network.
  Browsers outside cannot reach it (the office opens no ports, and a TURN server on the internet
  cannot reach a private address), so such meetings refuse browser guests with a clear message,
  and their hosts are told. The guest link panel says so before anyone is invited. Guests count
  towards the 8 people a PC-to-PC meeting holds.
- Every guest knocking, being let in, refused or removed is in the audit log, with the address.

## Webinars: registration and watching from a browser

A webinar's organiser shares its **registration page**, for example
`https://dexconnect-gateway.example.workers.dev/w/482913207`. Anyone can open it: it shows the
webinar (title, date and time in the visitor's own time zone, the organiser and the office, what it
is about) and a form: name, email and the organiser's questions.

- **Personal links.** Each registrant gets their own link, `…/w/482913207/watch#<token>`, at once.
  With manual approval the link opens a "waiting for the organiser" sheet until they are approved.
  The token (128 random bits) is in the fragment, so no server logs it; the page keeps it for the
  tab, takes it out of the address bar, and sends it in its first frame. It identifies the person
  in the webinar's report (attended or no-show, minutes, their questions and answers).
- **Abuse.** The gateway limits requests per address in the Durable Object (registrations in its
  storage, so they survive it sleeping), caps registrations passed on in an hour, drops forms whose
  honeypot field (hidden from people) is filled, and refuses anything but small JSON. The hub
  checks the form again and keeps the organiser's cap.
- **No email is sent.** The hub has no mail server. The organiser copies each invitation or
  reminder (with the personal link), saves `.ics` files, or exports a mail-merge CSV, and sends them
  from their own mailbox. The registration page itself offers the calendar file.
- **Watching.** The watch page is a sheet with the stage, the questions (ask, anonymously if the
  organiser allows, and vote), the current poll, handouts to download, a hand to raise and
  reactions. Before the organiser goes live it shows a countdown. The stage comes straight from the
  office PC composing it, through TURN when needed: the gateway carries only the signalling, never
  the video. **At most 25 viewers outside the office** are sent the stage this way (it is that PC's
  upload); anyone beyond that is told so, keeps the questions and the poll, and sees the live
  stream's page when the organiser gave one. Attendees on the office network watch through the
  hub's relay instead, with room for hundreds.
- **Speaking.** If the organiser invites a browser attendee to speak and they accept, the page
  opens the meeting page with a one-time pass (two minutes, once): they check their camera and mic
  and come onto the stage without waiting in the lobby. When the organiser brings them back, they
  return to the watch page.
- **The survey** after the webinar is `…/w/482913207/survey#<token>`, from the follow-up email.

## Data protection and allowed networks

In **Control room → Policies → Data protection** an administrator can:

- stop or mask (as ••••) payment card numbers (Luhn-checked), Aadhaar numbers (Verhoeff-checked), PAN
  numbers, bank account and IFSC details, and chosen words and phrases, everywhere or only where guests
  can see. The hub checks everything it can read; for encrypted Direct messages, the sender's own
  device checks before sealing.
- list file types that can't be shared (for example `exe, bat, ps1`).
- allow outside access only from listed networks (for example the office's other branches). Devices
  on other networks are refused, and signed out at once when the list changes.

## The iPhone web app and its notifications

- The meeting site (Cloudflare Pages) also serves **Dexterity Connect for iPhone** at `/app/`, from the
  same bundle the hub deploys; **Update the gateway** updates it. `/app/` on the gateway's own address
  redirects there. Its page allows scripts only from the site and connections to the site and to secure
  WebSockets (the gateway); see `apps/meet-site/src/app-headers.ts`.
- It uses the same encrypted device channel (`/c/<hub id>`) as Android outside the office; the gateway
  learns nothing new.
- **Notifications (Web Push)** are sent by the **hub**, not the gateway: the hub encrypts each one to the
  iPhone's subscription (RFC 8291) and signs it with the office's VAPID key (RFC 8292), kept in the hub's
  database. The push service (Apple's, for an iPhone) sees ciphertext, the time and the size; with **Show
  message text in notifications** off the content is only "New message". The hub needs outbound https to
  the push service (`web.push.apple.com` for iPhones). Nothing is registered with Apple.

## Pairing codes (personal devices)

- A pairing code (`DXP1-…`) carries the hub's id and certificate fingerprint, its office addresses,
  the gateway address and a random 144-bit token. The hub stores only the token's SHA-256 hash.
- It works **once**, for **24 hours**, and only for the person who made it. At most 5 unused codes
  per person exist; older ones stop working.
- The device that uses it joins **already approved, as that person**. Their other devices are told at
  once ("A device was added to your account") and can remove it in **Preferences → Your devices**.
  Every pairing is in the audit log.
- In the QR code the code is in the link's `#fragment`, which browsers never send to a server.
- Administrators can turn pairing off (**Control room → Policies → Personal devices**); new devices
  then wait for approval as before. Removing a person's devices, or a person leaving, makes their
  unused codes useless.

Things that remain the office's responsibility:
- Approving only devices you recognise.
- Removing lost devices in the Control room (**Devices → Remove**). A removed device can no
  longer sign in, from anywhere.
- Keeping the Cloudflare account protected with a strong password and two-factor sign-in.

## Setting it up (once, about 10 minutes)

The free Cloudflare plan is enough for an office of 25–100 people; the paid Workers plan, $5 a month,
raises the limits if it is ever needed.

### Set up with Cloudflare (from the Control room)

The owner does two things on Cloudflare's website and pastes one token into the app. The hub does
everything else itself, with Cloudflare's API: no Node.js, no source code, no command prompt, and
no addresses or fingerprints to copy.

1. **A Cloudflare account**, made with the office email address
   (<https://dash.cloudflare.com/sign-up>), and the email confirmed.
2. **One API token.** In **Control room → Outside the office → Set up with Cloudflare**, **Open the
   token form** opens Cloudflare's *Create API Token* page with the permissions filled in
   (Cloudflare's documented template link, `permissionGroupKeys`). The token needs exactly:

   | Permission | What the hub does with it |
   | --- | --- |
   | Account · Workers Scripts · Edit | the workers.dev name, the gateway Worker, its `HUB_FINGERPRINT` secret and its workers.dev address |
   | Account · Cloudflare Pages · Edit | the meeting site's Pages project and its deployments |
   | Account · Account Settings · Read | listing the account(s) the token reaches |
   | Account · Cloudflare Realtime (Calls) · Edit | the TURN key for calls across networks |

   A template link can carry the first three for a personal token; the owner adds the Realtime row
   by hand (**+ Add more → Account → Cloudflare Realtime → Edit**; Cloudflare may call it *Calls*),
   then **Continue to summary → Create Token**. Without the Realtime row everything else still
   works, and the last step says what to add.
3. **Paste it** into the card and choose **Set up**. Optionally tick **Keep it on the hub for
   gateway updates**.

The card shows each step as the hub does it (`apps/hub/src/cfdeploy.ts`):

| Step | What happens | Cloudflare API |
| --- | --- | --- |
| Check the token | The token is live. An account-owned token is accepted when it can list its account. | `GET /user/tokens/verify` |
| Choose the account | One account is used as it is; with several, the card asks which is the office's. | `GET /accounts` |
| Workers address | The account's workers.dev name; if it has none, one made from the office's name (with a few letters added if that is taken). | `GET`/`PUT /accounts/{id}/workers/subdomain` |
| Upload the gateway | The Worker as `wrangler deploy` uploads it: the module, the `Relay` Durable Object binding, only the migrations it does not have yet, the compatibility date, existing secrets kept. | `GET /accounts/{id}/workers/services/dexconnect-gateway`, `PUT /accounts/{id}/workers/scripts/dexconnect-gateway` (multipart) |
| Pin the gateway | `HUB_FINGERPRINT` set to this hub's certificate fingerprint. | `PUT …/scripts/dexconnect-gateway/secrets` |
| Turn on the gateway's address | `https://dexconnect-gateway.<name>.workers.dev` | `POST …/scripts/dexconnect-gateway/subdomain` |
| Meeting site project | The Pages project `dexterity-meet` (an existing one of that name in the account is reused; if Cloudflare will not make it, `dexterity-meet-<suffix>`), remembered. Its address is the one Cloudflare gives the project (`<name>.pages.dev`, or with a suffix if another account has that name). | `GET`/`POST /accounts/{id}/pages/projects` |
| Publish the meeting site | Direct upload as `wrangler pages deploy` does it: only the files Cloudflare lacks (by hash), then a deployment with the manifest, `_headers` and the front door (`_worker.js`) with its `GATEWAY` service binding. | `…/upload-token`, `/pages/assets/check-missing`, `/pages/assets/upload`, `/pages/assets/upsert-hashes`, `POST …/deployments` |
| Connect this hub | The two addresses saved and **Allow access from outside the office** switched on. **Who may use it** (new devices from outside, the Control room from outside) is left as it was. | — |
| Check | The gateway's `/health` answers; the hub signs in and the gateway reports it **pinned**; the meeting site's own files load and its `/health` reaches the gateway through the binding. A new account's workers.dev name can take a few minutes: the card says so, and Retry checks again. | — |
| Relay for calls | A Realtime TURN key named `dexterity-connect-<hub id>`, checked by asking it for short-lived credentials, then saved as **Calls across networks → Cloudflare TURN**. A working key from an earlier run is kept; an unusable one of that name is replaced, not added to. An office that chose its own TURN server keeps it. | `GET`/`POST`/`DELETE /accounts/{id}/calls/turn_keys`, `POST rtc.live.cloudflare.com/v1/turn/keys/{key}/credentials/generate-ice-servers` |

- **Resumable and idempotent.** Every step and what it made is recorded in the hub's database
  (`meta.cf_setup`). If a step stops, the card says why in plain words (for a missing permission, which
  one) and **Retry** continues from that step. Running the setup again updates the Worker and the site
  in place: it never makes a second project, Worker or TURN key. A hub stopped mid-run shows Retry.
- **The token** is used for the run and then forgotten. After a failed step it stays in the hub's
  memory for 30 minutes, so Retry needs no paste. With **Keep it on the hub for gateway updates** it is
  stored in the hub's database like the TURN token, never sent to any device and never shown again;
  **Forget the token** removes it. The hub's backups contain it then, as they contain the TURN token.
- **What it deploys** ships inside the hub: `apps/hub/scripts/build-cloud.mjs` (run by the hub build)
  puts wrangler's own bundle of the gateway and the built meeting site into `cloud-bundle.json`, which
  the single-executable hub carries inside itself (about 0.6 MB). When a newer hub carries a newer
  gateway or site, the card offers **Update the gateway** (one click with a kept token).
- Every run is in the audit log (`cloudflare.setup`, `cloudflare.failed`), with the account and the
  addresses but never the token.

### Setting it up by hand (fallback)

For a hub built without the Cloudflare parts, or when the command line is preferred:

1. **An API token** with the permissions above (or the **Edit Cloudflare Workers** template plus
   **Account · Cloudflare Pages · Edit**). Note your **Account ID** (Workers & Pages overview, right side).
2. **Deploy the gateway.** In GitHub, add two repository secrets: `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`. Then run **Actions → gateway → Run workflow**. Its summary shows
   the gateway's address, `https://dexconnect-gateway.<your-subdomain>.workers.dev`. Without
   GitHub: double-click `scripts\release\Deploy-Gateway.cmd` on an office PC with Node.js and a copy of
   the source; it asks for the token and account id and prints the addresses.
3. **Turn it on.** In the app, **Control room → Outside the office**: paste the gateway address,
   **Save address**, switch on **Allow access from outside the office**, and under **Meeting site ·
   Dexterity Meet** paste the meeting site's address ([DEXTERITY-MEET.md](DEXTERITY-MEET.md)).
4. **Pin the gateway to the hub.** Copy the **Fingerprint** shown on the same page into a third
   repository secret, `HUB_FINGERPRINT`, and run the workflow again (or run
   `Deploy-Gateway.cmd -Fingerprint <it>`). The status then says *gateway pinned to this hub*.
5. **TURN for calls**: see *Calls across networks* below.

### Everyone's devices

- **Phones and home laptops.** People add their own devices; no administrator is involved:
  - On their office PC: **Preferences → Your devices → Add my phone** shows a QR code. The phone's
    camera opens the download page, which installs the Android app and copies a one-time pairing
    code. On first launch the app finds the code and signs in as that person. (If it doesn't, the
    app's **Scan the code on your PC** reads the same QR code.)
  - **Add my laptop** shows the same kind of code as text. They email or message it to themselves
    and paste it into the app on the laptop.
  - Devices that have been on the office network once already know the gateway and simply work
    outside.
  - **iPhones and iPads** scan the same **Add my phone** QR code: the download page sends them to
    `<gateway>/app/` with the code in the `#fragment`, the gateway redirects to the meeting site's
    `/app/`, and they add Dexterity Connect for iPhone to the Home Screen
    ([IPHONE.md](IPHONE.md)). An iPhone always connects through the gateway, so a code made while
    access from outside is off cannot work on one, and says so.

### What was checked, and what the first real run must confirm

Checked here (17 November 2026), without a real Cloudflare account:

- `apps/hub/test/cfdeploy.test.ts` runs the whole setup against a stand-in for Cloudflare's API
  (`apps/hub/test/cfmock.ts`) whose request shapes were recorded from wrangler 4.162 deploying this
  repository (`wrangler deploy`, `secret put`, `pages project create`, `pages deploy` pointed at the
  stand-in): the full run, running it again (nothing duplicated, no second migration, files not sent
  again), a missing permission and Retry from that step, no Realtime permission, several accounts,
  taken workers.dev and pages.dev names, an existing project reused, a failure part-way and Retry, a
  wrong token, an account-owned token, a kept token and **Update the gateway**, a hub stopped mid-run.
- `apps/hub/test/cfdeploy-workerd.test.ts` builds the real `cloud-bundle.json`, lets the hub deploy it
  to the stand-in, then runs exactly what was uploaded in Cloudflare's local runtime (`wrangler dev`,
  workerd): the hub signs in to the gateway and is reported **pinned** by the `HUB_FINGERPRINT` it set,
  the site's front door serves its files and reaches the gateway through the `GATEWAY` binding its
  deployment carried, a meeting page has its CSP, and a hub with another certificate is refused.
- The file hashes match wrangler's (BLAKE3 of base64 content plus extension, checked against
  wrangler's own `blake3-wasm`).
- `apps/desktop/e2e/cfsetup.mts` drives the card in the app against the stand-in.

Not checked (needs a real account; do it once and watch the card):

- the token template link opening Cloudflare's form with the three permissions (Cloudflare's
  documented `permissionGroupKeys` link), and the Realtime row added by hand;
- Cloudflare accepting the Worker upload with `keep_bindings` and the migration as sent, the secret,
  the workers.dev switch (sent with `Cloudflare-Workers-Script-Api-Date: 2025-08-01`, as wrangler does);
- a Pages direct upload made with the hub's `_worker.bundle` and `wrangler_config_hash` taking its
  `GATEWAY` binding from the deployment (wrangler's way when a `wrangler.jsonc` is used), and the
  project's real `*.pages.dev` name;
- `POST /calls/turn_keys` returning the key's token (`secret` in Cloudflare's reference) and
  credentials from `rtc.live.cloudflare.com`;
- how long a new account's workers.dev name takes to answer (the card waits four minutes, then
  offers Retry).

On the first real run: watch every step tick, then check the status line says **gateway pinned
to this hub**, open the meeting site's address in a browser, join a test meeting from a phone on
mobile data, and make a call from outside to confirm TURN.

## Calls across networks

On the office network, calls go straight between PCs. Someone at home or on mobile data is behind
a router or a mobile carrier's NAT, so the call needs help to get through. Choose in **Control room →
Outside the office → Calls across networks**:

- **Basic** (default): a public STUN server. This works with most home routers. Some mobile networks
  block direct calls.
- **Cloudflare TURN** (recommended):
  - **Set up with Cloudflare** makes the key and chooses this for you. By hand: in Cloudflare,
    **Realtime → TURN Server → Create**, then paste the **key id** and its **API token** here.
  - The hub creates short-lived credentials for each call, and the token never leaves the hub.
  - Cloudflare's free allowance is generous for an office's calls.
- **Own TURN server**: the addresses, username and password of a TURN server you run (for
  example coturn).

## Turning it off

Switching off **Allow access from outside the office** disconnects everyone who is outside at once.
Devices then work only on the office network until it is switched on again. Deleting the Worker in
Cloudflare has the same effect.
