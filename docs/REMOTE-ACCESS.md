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
- **The gateway only relays.** It is a small Cloudflare Worker (`apps/gateway`, about 350 lines, plus the guest meeting page)
  with one Durable Object per hub. It pairs each device's WebSocket with the hub's and passes
  opaque binary frames. It stores no messages, files or keys. The only things it saves are the hub's
  certificate fingerprint (only when you don't pin one), which hub its meeting pages lead to, and,
  for ten minutes, how many wrong guest passcodes came from an address.
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
  when it is unreachable. Once the hub is seen on the office Wi-Fi again, they move back to it. The
  title bar shows a globe while the app is going through the internet.

## What is exposed, and how it is limited

| Surface | Who can reach it | Limits |
| --- | --- | --- |
| Gateway `/hub/<id>` | Anyone on the internet | Only a connection that signs a fresh challenge with the hub certificate's key is accepted. With `HUB_FINGERPRINT` set, it must be *this* hub's certificate. Otherwise the first hub is remembered and any other hub is refused. At most 4 hub connections. |
| Gateway `/c/<id>` | Anyone on the internet | Refused unless the hub is connected. Binary frames only, at most 1 MiB each. 40 connections a minute per address, 600 devices at once. The first frame must be a valid handshake, or the hub closes it. |
| Gateway `/join`, `/health` | Anyone | Static pages, strict headers, no data. |
| Gateway `/m/<meeting ID>` | Anyone | The guest meeting page and its script and styles: static, served from the Worker, with a strict content security policy (nothing loads from anywhere else). |
| Gateway `/m/<meeting ID>/ws` | Anyone with a guest link | Refused unless the hub is connected. JSON frames only, at most 64 KiB each and 400 per 10 seconds. 20 connections a minute and 5 wrong passcodes per 10 minutes per address (kept in the Durable Object's storage), 300 guests at once. The hub checks the passcode (and limits wrong ones again, 10 per 10 minutes per address); a guest only ever reaches the meeting's lobby. |
| Hub, through a channel | A device that completed the handshake | Unknown devices can only *ask* to join (they become pending). At most 10 such requests an hour from outside, and administrators can turn new joins from outside off altogether. The Control room is office-only unless an administrator allows it. Every action is audited, and outside connections show as `internet <address> (<country>)`. |
| Office hub on the internet | Nobody | It accepts no inbound connections from the internet. |
| Bot API, integrations, update mirror admin | Office network only | Not reachable through the gateway. |

What the gateway (and Cloudflare) *can* see:
- That a device is connected, its IP address and country, and when.
- The sizes and timing of encrypted frames.

They never see message text, file contents, names, keys or call media.

## Guests in meetings (browser, no install)

A meeting's hosts can give people outside the office a **guest link**, for example
`https://dexconnect-gateway.example.workers.dev/m/482913207#Hx7kP2qR`. It opens a small page served by
the gateway: the guest enters their name, checks their camera and microphone, and waits in the
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

## Data protection and allowed networks

In **Control room → Policies → Data protection** an administrator can:

- stop or mask (as ••••) payment card numbers (Luhn-checked), Aadhaar numbers (Verhoeff-checked), PAN
  numbers, bank account and IFSC details, and chosen words and phrases, everywhere or only where guests
  can see. The hub checks everything it can read; for encrypted Direct messages, the sender's own
  device checks before sealing.
- list file types that can't be shared (for example `exe, bat, ps1`).
- allow outside access only from listed networks (for example the office's other branches). Devices
  on other networks are refused, and signed out at once when the list changes.

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

## Setting it up (once, about 15 minutes)

1. **A Cloudflare account.** The free plan is enough for an office of 25–100 people; the paid
   Workers plan, $5 a month, raises the limits if it is ever needed.
2. **An API token.** In Cloudflare: **My Profile → API Tokens → Create Token → "Edit Cloudflare
   Workers"** template. Also note your **Account ID** (Workers & Pages overview, right side).
3. **Deploy the gateway.** In GitHub, add two repository secrets: `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`. Then run **Actions → gateway → Run workflow**. Its summary shows
   the gateway's address, `https://dexconnect-gateway.<your-subdomain>.workers.dev`. (Or, on any
   PC with Node.js: `cd apps/gateway && npx wrangler deploy`.)
4. **Turn it on.** In the app, **Control room → Outside the office**:
   - paste the address;
   - **Save address**;
   - switch on **Allow access from outside the office**.

   The status turns green within seconds.
5. **Pin the gateway to the hub (recommended).** Copy the **Fingerprint** shown on the same page into a
   third repository secret, `HUB_FINGERPRINT`, and run the workflow again. The status then says
   *gateway pinned to this hub*.
6. **Phones and home laptops.** People add their own devices; no administrator is involved:
   - On their office PC: **Preferences → Your devices → Add my phone** shows a QR code. The phone's
     camera opens the download page, which installs the Android app and copies a one-time pairing
     code. On first launch the app finds the code and signs in as that person. (If it doesn't, the
     app's **Scan the code on your PC** reads the same QR code.)
   - **Add my laptop** shows the same kind of code as text. They email or message it to themselves
     and paste it into the app on the laptop.
   - Devices that have been on the office network once already know the gateway and simply work
     outside.

## Calls across networks

On the office network, calls go straight between PCs. Someone at home or on mobile data is behind
a router or a mobile carrier's NAT, so the call needs help to get through. Choose in **Control room →
Outside the office → Calls across networks**:

- **Basic** (default): a public STUN server. This works with most home routers. Some mobile networks
  block direct calls.
- **Cloudflare TURN** (recommended):
  - In Cloudflare, **Realtime → TURN Server → Create**.
  - Paste the **key id** and its **API token** here.
  - The hub creates short-lived credentials for each call, and the token never leaves the hub.
  - Cloudflare's free allowance is generous for an office's calls.
- **Own TURN server**: the addresses, username and password of a TURN server you run (for
  example coturn).

## Turning it off

Switching off **Allow access from outside the office** disconnects everyone who is outside at once.
Devices then work only on the office network until it is switched on again. Deleting the Worker in
Cloudflare has the same effect.
