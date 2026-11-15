# Meetings and webinars inside Dexterity Connect

A plan for the full meeting suite, the meeting and webinar features of products like Zoho Meeting,
built into Dexterity Connect and drawn in its own design language. People should never need a second
app to meet a colleague, a site or a client.

Sources for the feature survey: Zoho Meeting's features and plan-comparison pages and Zoho Webinar's
product pages (November 2026). AI features (generated keynotes, transcripts) are out of scope, as for
the rest of the app.

## Principles

- **One place.** A meeting is a Room with a schedule, a link, a lobby and host controls. It lives in
  its conversation, on the Calendar and on a new **Meet** lens. There is no separate meetings app.
- **Snappy.** The meeting screen loads only when a meeting starts (code split). Video tiles are
  virtualised past 25 people. Speaker detection runs on the audio thread at 10 Hz, never per frame.
  Nothing is polled faster than once a second. Targets: join in under 1.5 s on the office network,
  first remote frame in under 2 s, and under 15% CPU for a 6-person gallery on an office PC.
- **Our look.** The Room is a drawing sheet. Its controls sit in the title block, people are tiles
  with zone captions, and the speaker gets a revision cloud. Every new panel uses the same
  vocabulary: sheet tabs, ruled cells and mono captions.
- **Works where people are.** In the office, media goes PC to PC, or through the hub's relay for
  more than 8 people. From outside it goes through TURN. Guests without the app join from a browser
  through the office gateway.

## Feature map

| Area | Feature | Today | Plan |
| --- | --- | --- | --- |
| Meetings | HD audio, video, screen and app sharing | ✅ Rooms | Simulcast layers on the relay so slow PCs get lighter video |
| | Instant meeting with a link to share | ✅ **M1**: every Room is held under a meeting with a nine-digit ID (482-913-207) and a `dexconnect://meet/ID` link; instant meetings get a private Space of their own; ✅ **M2**: a guest link for browsers; ✅ **Dexterity Meet**: a clean address on the office's meeting site (`https://dexterity-meet.pages.dev/482-913-207`, a name the host chose such as `…/p12-design-review`, or a personal room `…/vikram`), passcode after `#` ([DEXTERITY-MEET.md](DEXTERITY-MEET.md)) | |
| | Scheduled meetings, invitations, RSVP, reminders | ✅ Calendar; ✅ **M1**: a Calendar event held as a call is a meeting with its own ID, lobby and co-hosts (the organiser hosts); ✅ **M2**: passcodes for guest links, invitations as text or `.ics` (one VEVENT, UTC, the organiser, the link and passcode); ✅ **Dexterity Meet**: the event dialog sets the meeting's page (name, show the title, lobby, a note for afterwards); rescheduling moves the page, cancelling shows it; one UID per meeting; the calendar feed carries the clean link without the passcode | |
| | Personal room | ✅ **M1**: each person's standing ID, with its own Space made the first time it is used | |
| | Join before host, lobby, lock meeting | ✅ **M1**: lobby (nobody, outsiders and guests, or everyone waits) with admit or deny one or all; lock; join before host | |
| | Co-hosts | ✅ **M1**: the host gives and takes co-host rights; when every host leaves, the longest-present member runs the meeting | |
| | Mute one or all, remove, lower hands | ✅ **M1**: in the People tab and each tile's menu; muting is enforced on the PC, unmuting is "Ask to unmute" (never forced on); removed people wait in the lobby to come back; end for everyone | |
| | Raise hand, emoji reactions | ✅ **M1**: hands queued in order (people table and tile); six reactions float up the sender's tile, rate-limited on the hub | |
| | Gallery, speaker view, pin, spotlight | ✅ **M1**: gallery (numbered sheets past 25 tiles), speaker with a strip, presentation; pin for yourself, spotlight for everyone (host) | |
| | In-meeting chat, files, polls, whiteboard | ✅ **M1**: a panel with sheet tabs on its edge (People, Chat, Polls, Board, Files) on the meeting's conversation | |
| | Breakout rooms | ✅ **M2**: the host splits people into rooms (drag between columns, pick from a list, or deal out at random) with a timer; a note to every room; visit or move anyone; call everyone back after a 60-second countdown | |
| | Annotation on a shared screen | ✅ **M2**: live pointers on a shared screen: everyone's labelled pointer, highlights that fade after 4 s unless kept, numbered markers with a note, ink that fades; the presenter clears all or turns pointers off, and sees them on their own screen in a click-through window. Also on pictures looked at together and on whiteboards | |
| | Remote control | ✅ IT support sessions (docs/HELP-DESK.md): the requester allows it separately and stops it any time; ✅ **meetings and webinar stages**: the presenter gives control of a shared screen to one person at a time ("Give control" in their person menu, or "Ask for control" answered by the presenter), with the same consent, banner, stop keys, rate limit and blocked chords; the hub passes input only from the person granted, and audits it | |
| | Virtual backgrounds | ✅ Blur; ✅ **M1**: drafting sheet, blueprint and plain studio drawn in code, and your own picture (kept on the PC) | |
| | Noise suppression | ✅ **M2**: RNNoise (BSD-3-Clause) as an audio worklet on the PC, on by default, switched in the Room's sound menu | |
| | Consent before video | ✅ **M1**: Control room → Policies → Calls: join with the camera off, and ask before turning it on | |
| | Recording, storage, playback, sharing | ✅ **M2**: kept on the hub (resumable chunks, a size limit), a Recordings shelf, a viewer with chapters (who spoke when), shared with the conversation or by a link for the office, retention, audited downloads | |
| | Guests join from a browser (no install) | ✅ **M2**: a join page (name, camera and mic check, lobby); guests always wait to be let in; media PC to browser through TURN; meetings on the relay stay on the office network; ✅ **Dexterity Meet**: a landing page per meeting (title block, countdown or "in progress since", Add to calendar, a device check with speakers and device choice, waiting, lobby, reconnecting, a closing page) on a clean host, the meeting's code loaded only on Join | |
| | Dial-in by phone | — | Out of scope (needs a telephony provider) |
| Webinars | Registration page and form, approval | ✅ **M3**: `https://<gateway>/w/ID` (name, email, the organiser's questions, a honeypot, limits per address); auto or manual approval; each registrant's personal link; registrants in a ruled table (approve, turn away, CSV); invitations and reminders as text, `.ics` and a mail-merge CSV | |
| | Organizer, panelists, attendees | ✅ **M3**: organiser (host, co-hosts) and up to 7 panelists on a PC-to-PC stage with a backstage Space; attendees watch one composed stage, never seen or heard; invited to speak with their consent (app or browser) and brought back | |
| | Q&A with upvotes and answered state | ✅ **M3**: Questions tab, anonymous if allowed, votes, sorted by votes; answered live or in writing; dismiss, pin, show on the stage | |
| | Polls, handouts, raise hand, reactions | ✅ **M3**: polls launched live with results shown or hidden; handouts (up to 12 files) downloaded in the app or the browser; hands queue for the organiser; reactions float up the stage | |
| | Practice session | ✅ **M3**: the stage opens as a practice session; attendees wait on a "starting soon" sheet with a countdown; the organiser clicks Go live | |
| | Live streaming (YouTube and others) | ✅ **M3**: the composed stage, encoded by ffmpeg on the hub PC, sent over RTMP to the address and key entered; health shown (bitrate, frames, dropped frames, state) | |
| | Follow-up (thank-you, recording link), survey | ✅ **M3**: a thank-you with the recording and a survey: in the app for colleagues who watched, as email text for registrants (attended or no-show); the survey in the app or on the gateway | |
| Analytics | Meeting history, durations, attendance | ✅ **M2**: a report per meeting (who joined, when and for how long with rejoins summed, hands, reactions, polls, recordings) and office totals by week, both as CSV | |
| Admin | Departments, co-branding, action log, data retention | ✅ **M2**: meeting settings in the Control room (lobby default, join before host, guest links, largest recording; consent and recording as before); meeting events in the audit log | |
| Security | Encryption, 2FA, lock, consent | ✅ DTLS-SRTP, device keys; ✅ **M1–M2**: lock, lobby, passcodes for guest links (in the link's fragment, limited per address), consent | |

## Building blocks already in place

- **Rooms:** PC-to-PC for up to 8, the hub relay (mediasoup) for up to 50, TURN for people outside.
- **Calendar:** online meetings tied to a conversation, invitations, RSVP and reminders.
- **Recording:** composited on the recorder's PC, with everyone told.
- **Blur:** MediaPipe segmenter, bundled.
- **Polls, forms, whiteboards and notes:** in conversations.
- **The gateway** (Cloudflare Worker) and its encrypted channel to the hub.
- **Lounges:** standing audio Rooms inside a Space ("Piping desk") that people drop into and out of,
  with no ringing; shown on the Switchboard and the Space header with who is in them.
- **A data channel per PC-to-PC link** in every Room, for small messages (pointers, remote control);
  through the hub (`room.data`) on the relay.

## Phases

**M1: meetings people run every day.** Meeting IDs and links, personal rooms, lobby and lock,
co-hosts, host controls, raise hand and reactions, layouts with pin and spotlight, the in-meeting
panel, virtual backgrounds, consent before video, and a **Meet** lens to start, join and schedule
meetings and see upcoming ones and past recordings.

*Delivered (November 2026):* everything above, with the Meet lens listing recent meetings from the
hub's meeting log (who, when, how long); the recordings shelf is M2. The hub keeps meetings in
`apps/hub/src/meetings.ts` and the live rules in `rooms.ts` (`meet.*` and the `room.*` host
controls, tested in `apps/hub/test/meetings.test.ts`). The Room sheet (`rooms/Stage.tsx`), its
panel and lobby (`meet/`) and the Meet lens load only when used. On phones the lens strip already
holds five lenses, so Meet is a card on Pulse. Media is unchanged: PC to PC up to 8, the hub's
relay above that (a Calendar meeting with more than 8 invited opens on the relay). Measured on the
e2e harness (three app instances with fake cameras on one shared Linux machine, software
rendering): about 0.53 s from clicking Join to the first frame of a colleague's camera, and 10 to
20% of one core for the renderer in a three-person gallery with three cameras (median 13%).

**M2: meetings that include the outside.** Guests join from a browser through the gateway. Also:
recordings stored on the hub with playback and sharing, breakout rooms, annotation, stronger noise
suppression, and per-meeting reports.

*Delivered (November 2026)*:

- **Guests from a browser.** A meeting's guest link is now its page on the office's meeting site,
  `https://dexterity-meet.pages.dev/<ID or name>#<passcode>` (Dexterity Meet, below; old
  `https://<gateway>/m/<ID>#<passcode>` links redirect there). The meeting itself
  (`apps/gateway/meet/room.ts`, formerly `guest/page.ts`, built with esbuild) loads on Join:
  the guest's name, a camera and mic check (preview and a ruled level scale), the lobby, then the
  meeting: tiles with zone captions, a shared screen, the meeting chat, a hand and reactions,
  their own screen share, all in the drafting-sheet look with system fonts and nothing loaded from
  elsewhere. The passcode (6–10 characters) stays in the fragment and is sent in the join frame;
  the page then removes it from the address bar. The page's socket reaches the hub as *guest
  frames* on the hub's own gateway connection (`remote.ts`); the hub gives each guest a session of
  its own (`apps/hub/src/meet-guests.ts`) that can only join that meeting: no account, no
  Directory, no conversations, names of the people in the meeting and nothing more, never host
  controls. Guests always wait in the lobby (whatever the lobby rule) and a locked meeting refuses
  them. Wrong passcodes are limited per address twice: 5 in 10 minutes in the Durable Object's
  storage, 10 in 10 minutes on the hub. Hosts turn the link on or off and renew its passcode; the
  office can turn guest links off. Media is WebRTC between the browser and each PC, with the ICE
  servers the hub hands out (Cloudflare TURN when set up), and the Electron app needs nothing new to
  talk to a browser: the same perfect-negotiation signalling, relayed through the gateway.
- **Relay meetings and guests: the decision.** Meetings of more than 8 people run on the hub's
  mediasoup relay, which listens on the office network. A browser on the internet cannot reach
  it: the office opens no ports (the gateway's whole point), and a TURN server on the internet
  cannot reach a private address either, so forwarding guest media through the relay would mean
  exposing the office to the internet. Relay meetings therefore stay on the office network: a
  guest knocking is refused with a plain message, the hosts are told who could not get in and
  why, and the host's guest-link panel warns before anyone is invited (a Calendar meeting with
  more than 8 invited counts). Guests count towards the 8 people of a PC-to-PC meeting. Tested in
  `apps/hub/test/meet-guests.test.ts`.
- **The meeting chat.** People who cannot read a meeting's conversation (browser guests, people
  let in from outside) talk in the *meeting chat*: every Room keeps one in memory on the hub, the
  meeting's breakout rooms share it, and it is gone when the meeting ends. Members see it as
  "Everyone here" beside the conversation in the panel's Chat tab whenever such people are in the
  Room. The conversation's own chat is unchanged (and stays end-to-end encrypted where it was).
- **Invitations.** "Copy invitation", "Download invitation (.ics)" and "Send by email" (a draft in the PC's mail program with the formatted invitation and the .ics attached, `packages/core/src/eml.ts`; `mailto:` where that cannot open) in the Calendar's meeting dialog and the
  Room's host controls: one VEVENT with a stable UID, DTSTART/DTEND in UTC, the organiser (their
  email when the Directory has one), and the guest link with its passcode when it is on
  (`packages/core/src/ics.ts`).
- **Recordings on the hub.** When a recording stops, the PC uploads it over the hub connection in
  512 KB chunks (it works through the gateway too); a dropped connection resumes where the hub got
  to; the office sets the largest size. The recorder follows the Room's 10 Hz speaker detection and
  writes a chapter each time a different person has led the talking for 0.8 s. The Meet lens has a
  Recordings shelf (title, date, length, who recorded it, size) and a viewer with the chapters as a
  schedule and as a strip under the video, and talking time per person. Only the recorder (and
  administrators) can watch until it is shared: with the meeting's conversation, or by a
  `dexconnect://recording/…` link for anyone in the office (not guests); the hub enforces it on
  every download, and every download is in the audit log. Recordings follow the office retention
  (as Space or Direct messages, by their conversation), legal holds keep them, administrators
  delete them (`apps/hub/src/recordings.ts`).
- **Reports.** The hub writes attendance as people come and go (so a report survives a restart):
  for each meeting, who joined, first in and last out, time in the meeting with rejoins summed and
  a second device not counted twice, visits, hands, reactions, the polls asked in its conversation
  while it ran, its recordings and breakouts. The Meet lens's Recent meetings open it; it exports
  as CSV. The Control room's Usage page has meetings by week (count, hours, average size, browser
  guests, recordings), also as CSV (`apps/hub/src/meet-reports.ts`, `packages/core/src/meet-csv.ts`).
- **Breakout rooms.** Each breakout is a Room of its own under the same meeting (its own media:
  PC to PC, or the relay if a breakout of a relay meeting has more than 8), so the Room engine is
  reused as it is: the hub moves a device from one Room to another and the engine reconnects
  without leaving the meeting. The host sets them up in a sheet of columns (drag, pick, or deal at
  random), with an optional timer; sends a note to every room; visits or moves anyone; and calls
  everyone back, which shows a 60-second countdown to everyone first (the timer running out does
  the same). The conversation's chat and the meeting chat are shared by all rooms
  (`apps/hub/src/breakouts.ts`).
- **Noise suppression.** RNNoise (Xiph, BSD-3-Clause) compiled to WebAssembly, run as an
  AudioWorklet (`@sapphi-red/web-noise-suppressor`, MIT), bundled beside the app like the
  segmenter. It cleans the microphone before it is sent, recorded or used for "who is speaking";
  on by default, switched in the Room's sound menu (the small NS tab on the mic). Phones keep the
  browser's own filters for now.
- **Control room and audit.** Meeting settings: who waits in the lobby by default, join before the
  host, guest links allowed, the largest recording kept, with consent before video and recording
  as before. Meetings starting and ending, admissions and denials, lock, removals, guest links
  turned on, off or renewed, guests knocking, joining and removed, breakouts, and recordings
  stored, shared, downloaded, deleted and purged go into the audit log.

Measured on the e2e harness (one shared Linux machine, software rendering, fake cameras): a
browser guest's first frame of the host's camera about 0.8 s after the host clicks Admit, and the
host's first frame of the guest's about 0.9 s; with strong noise suppression on and off,
in a four-person gallery, the renderer used 16.7% and 18.9% of one core with it on against 19.6%
and 14.7% with it off (two runs, medians of three 4-second samples): the difference is smaller than
the machine's own noise, because the worklet works on the audio thread in 10 ms frames. Long tasks
on the main thread over 12 seconds were 12 and 6 with it on and 20 with it off (the gallery's
software video rendering causes them), so it does not stall the interface. Hub tests: `meet-guests.test.ts` and `meet-m2.test.ts`; Worker tests:
`apps/gateway/test/gateway.test.ts`; end-to-end runs: a guest in headless Chromium through the
gateway with an Electron host, and four apps in breakout rooms.

*Dexterity Meet, delivered (15 November 2026):* the public face of meetings
([DEXTERITY-MEET.md](DEXTERITY-MEET.md)). Every meeting has a clean address on a free Cloudflare
Pages project, `dexterity-meet`, whose only code passes requests to the gateway through a service
binding (`apps/meet-site`), so guests never see the Worker's address; the address is configuration
(Control room → Outside the office → Meeting site), ready for the office's own domain. Hosts name
a meeting's page (checked, unique, homograph-safe, released with a 30-day grace period); personal
rooms are named from the person. The landing page (`apps/gateway/meet/landing.ts`) is one drawing
sheet: before the passcode only the date, time and "Meeting with Dexterity Design Services" (title
and first name when the host allows it); after it, the whole title block, a countdown or "in
progress since", Add to calendar (.ics, Google, Outlook.com), the device check, name and Join, and
"Open in Dexterity Connect" for staff; waiting, lobby, reconnecting and closing states (time spent,
the host's note, the next time). Unknown, ended, cancelled and switched-off meetings get one
answer before the passcode; wrong passcodes share the guest socket's lockout; the gateway passes
only an allowlist of fields; strict CSP and headers, no third-party requests (fonts served by the
site). The Calendar dialog, the Meet lens and the Calendar's meeting details show the clean link;
reminders open the Room directly. Tests: `packages/core/test/meetlink.test.ts`,
`apps/hub/test/meet-public.test.ts`, `apps/gateway/test/gateway.test.ts`, and the end-to-end
`apps/desktop/e2e/meetlink.mts` through `wrangler pages dev` bound to `wrangler dev`.

*Annotation, delivered (November 2026):* live pointers (`apps/desktop/src/renderer/pointers/`,
`packages/core/src/pointers.ts`). In a Room the messages travel over each link's data channel (or
the hub's `room.data` on the relay), at most 30 a second, positions relative to the shared picture;
for a picture or a whiteboard several people look at together, the hub keeps who is looking and who
presents (`apps/hub/src/pointers.ts`, `point.*`). Ink strokes are capped at 400 points. The
presenter's own screen shows the pointers in a transparent, click-through, always-on-top window
(on Linux only where the desktop composites windows). Tested in `packages/core/test/pointers.test.ts`,
`apps/hub/test/lounges.test.ts` and end to end with two app instances.

**M3: webinars.** Registration, roles, Q&A, handouts, practice sessions, live streaming, follow-up
and remote control.

*Delivered (November 2026)*; remote control came after Help Me (see *Give control* below):

- **A webinar is a meeting of kind `webinar`** (`apps/hub/src/webinars.ts`, types in
  `packages/core/src/webinar.ts`). The organiser plans it on the Meet lens (title, description,
  date, length, up to 7 panelists, approval, whether the office sees it listed, the registration
  questions). Its organiser (the meeting's host, with co-hosts) and panelists meet in a PC-to-PC
  Room, the *stage*, with a private backstage Space for their chat and files. Attendees never enter
  that Room: the hub refuses them (`rooms.ts`), so they are never seen or heard, and they see a
  clean stage, not a gallery of each other. The Room sheet adds the stage bar (practice or LIVE,
  who is watching, Go live, End, the stream's health, a preview of what attendees see) and the
  panel's webinar tabs: Questions, Audience, Polls and Handouts (`meet/webinar/StageTabs.tsx`).
- **One stage, composed once.** The hub chooses a *broadcaster*: an organiser's PC on the office
  network (else a panelist's there, else any PC on the stage; it changes over when that PC
  leaves). It composes the stage on a canvas, 1280×720 at 25 frames a second driven by a worker's
  clock (so it keeps moving behind other windows): everyone on the stage as tiles with zone
  captions, a shared screen large, a question the organiser shows on the stage as a ruled
  callout, and a title strip with LIVE in amber; the voices are mixed (`meet/webinar/compositor.ts`).
  That one picture and sound go out three ways (`meet/webinar/broadcast.ts`).
- **Attendees on the office network: the relay.** The broadcaster sends the stage once to a relay
  room of its own on the hub's mediasoup (`stage:<room>`); each attendee takes two tracks from it,
  so a large audience costs the office little (up to 500 watching). Only the broadcaster may send
  to that room; the hub checks it on every `relay.produce`.
- **Remote attendees: the decision.** Browsers through the gateway, and the app outside the office,
  cannot reach the relay (the office opens no ports, and a TURN server on the internet cannot reach
  a private address: the M2 reasoning). Compositing on the hub would need the hub to receive every
  panelist's media, which only the relay could do, and HLS through the gateway would carry video
  through Cloudflare's Durable Object. So **the broadcaster's PC sends the composed stage straight
  to each remote viewer**, one WebRTC connection each, through TURN when needed, **at most 25**
  (about 25 × 1.5 Mbit/s of upload on that PC). The hub counts the seats: earlier viewers keep
  theirs, a seat that comes free goes to the next viewer waiting, and anyone beyond the 25 is told
  plainly that the webinar sends to as many viewers outside the office as it can, keeps the
  questions, votes and poll, and sees a link to the live stream's page when the organiser gave one.
  Measured on the e2e harness: see below.
- **Registration** (`/w/<ID>` on the gateway, `apps/gateway/webinar/`): the webinar's details,
  name, email and the organiser's questions (a line of text or one of a list, each required or
  not). Auto-approve gives the personal link at once; manual approval gives it too, and it opens
  the webinar once the organiser approves (the page checks again every 20 seconds). The link is
  `https://<gateway>/w/<ID>/watch#<token>` (128 random bits, in the fragment); it identifies the
  person in the report. The gateway drops forms with the honeypot filled, takes JSON of at most
  16 KiB, allows 5 registrations an hour per address and 300 an hour in all (in the Durable
  Object's storage); the hub checks it all again, refuses duplicates without revealing the link,
  and keeps the organiser's cap (up to 5,000). The registrants table approves and turns away (one
  or many), exports CSV and writes invitations and reminders.
- **Email: the decision.** The hub has no mail server and no SMTP setting (nothing in the code
  sends mail), and faking it would be worse than not sending. So the app **writes** the mail: per
  registrant or for all, the invitation or reminder text with their personal link, an `.ics` with
  the same link (`packages/core/src/ics.ts`, one VEVENT per person), and a mail-merge CSV; the
  organiser sends them from their own mailbox. It says so where the texts are made.
- **Q&A, polls, hands, reactions, handouts.** Attendees ask (anonymously when the organiser
  allows; then nobody sees the name, the organiser included) and vote; the list is sorted by
  pinned, then votes, then time. Panelists mark a question answered live or answer it in writing;
  the organiser dismisses, pins, or shows it on the stage. Updates reach everyone at most once a
  second, coalesced, so a large audience does not flood the hub. Polls are the webinar's own (the
  M1 polls live in a conversation attendees are not in), launched live, with results shown to
  attendees or kept for the stage; each answer is in the report. Hands queue for the organiser in
  the Audience tab; reactions float up every viewer's stage. Handouts are files the organiser
  attaches (up to 12, 50 MB each): the app downloads them through the hub's file route (allowed
  for an hour after asking), browsers receive them in pieces over their connection; every download
  is in the report.
- **Practice and go-live.** Opening the stage starts the practice session; attendees who come early
  wait on a "starting soon" sheet with a countdown in ruled cells (and can already ask questions).
  The organiser clicks Go live; ending the webinar tells every viewer and closes the stage. A stage
  closed during practice goes back to waiting.
- **Invited to speak.** The organiser invites someone from the Audience tab; they see an invitation
  and choose. In the app they come onto the stage with their mic, or their camera too; from a
  browser the watch page opens the meeting page with a one-time pass (two minutes, used once,
  no lobby, their registered name). Back to the audience returns them to watching (the browser
  page goes back to the watch page, which kept their link).
- **Live streaming.** The organiser enters the service's RTMP address and key (the key stays on
  the hub; the app shows its last four characters) and an optional watch page. While streaming,
  the broadcaster records the stage (WebM, VP8 and Opus) in one-second pieces and sends them to
  the hub over its connection; the hub pipes them into ffmpeg, which encodes H.264 and AAC and
  sends FLV to the service (`apps/hub/src/webinar-stream.ts`). The hub finds ffmpeg at the path an
  administrator set in the webinar's Live stream tab, or `DEX_FFMPEG`, else on PATH, else in
  `C:\Program Files\ffmpeg\bin`, `C:\ffmpeg\bin` and the winget, Chocolatey and Scoop folders, and
  needs an H.264 encoder (libx264, OpenH264 or Media Foundation). **On Windows**: on the hub PC,
  `winget install --id Gyan.FFmpeg -e --scope machine` in an administrator PowerShell (or unzip a
  release "essentials" build so that `C:\ffmpeg\bin\ffmpeg.exe` exists), then restart the hub or
  set the path. Health comes from ffmpeg's progress: bitrate, frames per second, dropped frames,
  time sent and the state (starting, live, stalled, failed with ffmpeg's last line, with the key
  removed). If ffmpeg stops while streaming, the hub tries again up to five times, asking the
  broadcaster for a fresh recording; a new broadcaster starts a fresh one too.
- **Follow-up.** After the webinar the organiser writes a thank-you, picks a recording (its office
  link is turned on) and a link for people outside, and an optional survey (a form of questions).
  Colleagues who watched get it in the app from the system bot, with a `dexconnect://webinar/ID/survey`
  link that opens the survey; registrants get email text (a thank-you if they attended, "we missed
  you" if not), with their own survey link on the gateway (`/w/<ID>/survey#<token>`).
- **Reports.** The webinar's report (`web.report`, and the meeting report's webinar part in
  `meet-reports.ts`): registrants with attended or no-show and minutes watched while it was live,
  attendees (office or registered), questions with votes and answers, each poll with each person's
  answer, handout downloads, the survey's answers; all of it in the CSV.
- **Remote control** was not in M3 itself: it came once Help Me had built the input helper (below).

Hub tests: `webinars.test.ts` (planning, registration and approval, invitations and `.ics`, practice
and go-live, attendees who cannot publish, the routes, Q&A, polls, hands, handouts, speakers from
the app and the browser, follow-up, survey, report and CSV) and `webinar-stream.test.ts` (finding
ffmpeg, progress as health, a real stream to a local RTMP listener, a failing one without the key);
Worker tests: the webinar pages, requests answered by the hub, the honeypot, form limits and
registrations per address (`apps/gateway/test/gateway.test.ts`).

Measured on the e2e harness (the real gateway Worker under `wrangler dev`, three Electron apps and
headless Chromium on one shared Linux machine, software rendering, fake cameras): from the
organiser clicking Go live to the first frame of the composed stage, about 1.1 s for an attendee
in the app through the relay and about 1.2 s for a browser attendee straight from the organiser's
PC; the stage arrives at 1280×720. The live stream to a local RTMP listener (ffmpeg in listen
mode) ran at 1.1 to 1.7 Mbit/s (two runs) with H.264 and AAC, and the listener received over 400 frames in
the run. The run covers registration and approval, the countdown sheet, practice and go-live, an
attendee refused when publishing, Q&A, a poll, a raised hand, a speaker invited and brought back,
handouts in the app and the browser, folding the sheet away, the live stream, the end, the
follow-up, the survey in the app and in the browser, and the report.

### Give control (remote control in meetings), delivered (November 2026)

While someone shares a whole screen in a meeting or on a webinar's stage, **the presenter** (the
person sharing) can let one other person use their mouse and keyboard. It is the support session's
remote control (docs/HELP-DESK.md) with the meeting's people: the same consent sheet, input path,
rate limit, blocked chords, stop keys and injection on the presenter's PC, refactored into shared
pieces rather than copied.

- **Entry points.** *Give control…* in a person's menu (their tile's or the People tab's), shown
  only to the person sharing. *Ask for control* on the shared screen for the people watching it:
  the presenter gets a request sheet (*"Ravi Kumar asks for control"*: **Refuse** or **Accept…**);
  a refusal is told to the asker; asks are limited to four a minute per person.
- **Consent.** Either way the presenter then sees the same separate sheet as a support session:
  *"Let Ravi Kumar use your mouse and keyboard?"*, what that means, how to stop it, that system keys
  are never passed on, and when it ends; nothing happens until **Allow control**. Only a whole
  screen can be given (not one window).
- **While control is on.** The presenter has the amber banner across the app with a big **Stop
  control**, the share bar above everything (amber, with **Stop control** and **Stop sharing**)
  and an amber frame around the shared screen, and **Ctrl+Alt+Shift+S** stops it from anywhere,
  even while the other person types. The controller sees an amber edge round the picture and
  *"You are controlling Priya Raman's screen"* with **Release**; everyone else sees who is
  controlling. One person at a time: giving it to someone else means taking it back first.
- **Input.** The controller's pointer, buttons, wheel and keys become the same small events as in a
  support session (positions relative to the shared picture, `KeyboardEvent.code` keys), batched
  and sent to the presenter only: over that link's data channel PC to PC, or through the hub
  (`room.data`) on the relay. The presenter's main process takes input only from the device it
  was told and drops anything else, maps positions onto the shared display, and applies the 120
  events a second and the blocked chords.
- **It ends on its own** when the presenter stops sharing (or switches to one window), when either
  person leaves the Room (or is moved to a breakout), or when the meeting ends; the presenter's PC
  stops first and releases anything held down, and both are told why.
- **Not offered** to browser guests, phones (no input to give), or attendees invited onto a
  webinar's stage (only its organiser, co-hosts and panelists can be given control); a Mac
  presenter's screen is view only (the person menu says so, and viewers see *VIEW ONLY · MAC*),
  as is a Linux desktop without X11 and xdotool.
- **The hub** keeps one grant per Room (`apps/hub/src/meet-control.ts`, `room.control.*`): only the
  sharing device grants, only to someone allowed; on the relay it passes input events only from
  the person granted and only to the presenter (anyone else's are dropped); it ends the grant when
  the Room changes; and it audits `meeting.control.granted` and `meeting.control.revoked` (the
  presenter, the controller, from, to, how long, and why it ended). Rules shared with the apps
  are in `packages/core/src/meet-control.ts`; the app's side is `apps/desktop/src/renderer/meet/`
  (`Control.tsx`, `control-store.ts`).

Tested in `apps/hub/test/meet-control.test.ts` (granting, who may send, asking and refusing, ending
on its own, who is not offered it, the webinar stage, the audit) and `apps/desktop/test/assist.test.ts`
(input only from the allowed device), and end to end on Linux under Xvfb with xdotool: two apps in
a meeting, one shares and gives control from the other's person menu, and the other's pointer
moves the real X pointer and clicks a button in the presenter's window; Stop on the banner ends it
and input afterwards (from the controller's view, through the hub, or straight to the main
process) is ignored; asking, accepting and the stop keys; and stopping the share ends it.

Each phase ships with end-to-end tests that drive several app instances through the feature. The
performance targets above are measured in CI-like runs on the e2e harness.

## Meeting threads, action points and recaps

*Design (November 2026).* After any meeting, everyone who was invited or attended finds everything
from it in one place, and during the meeting an action point takes one line or one key. Code: the
hub's `apps/hub/src/meet-threads.ts`, the shared rules in `packages/core/src/meet-threads.ts`, the
app's `apps/desktop/src/renderer/meet/` (`Register.tsx`, `Capture.tsx`, `Recap.tsx`,
`ThreadCards.tsx`) and the guest page `apps/gateway/meet/room.ts`.

### 1. Every meeting has a thread

A meeting's **thread** is a conversation, so everything a conversation already does (search,
files, pins, notes, boards, polls, Decisions, retention, legal holds, export, offline catch-up)
works on it unchanged. Nothing new stores messages.

| Meeting | Its thread |
| --- | --- |
| Instant meeting | Its private Space (as today) |
| Personal room | Its Space, made the first time it is used (as today) |
| A conversation's Room | That conversation |
| Calendar meeting set in a conversation | That conversation |
| Calendar meeting with "Conversation: None" | **New:** a private Space made when the meeting is saved (when it has someone besides the organiser, or is held as a call), named after it, with the invitees in it. Old events get one the first time it is needed. It replaces the group Direct the Room used to open, so guests' chat can live in it (below). |
| Webinar | Its backstage Space (organisers and panelists) |

- **Recurring meetings** are one event, so the series has one thread. Each time it is held is an
  **occurrence**: the hub keeps one row per occurrence (meeting, thread, the Calendar slot it
  belongs to, when it really started and ended, the Rooms it used, the note-taker, its state).
  When an occurrence starts, a divider card is posted in the thread (`15 NOV · WEEKLY PIPING SYNC ·
  STARTED 10:02`); when it ends, its recap card.
- **Before the meeting** invitees chat and share files in the thread. The Room's panel shows the
  thread's chat and files, so the agenda and drawings shared beforehand are there when it starts.
- **An occurrence is found** by the Calendar slot that is running, about to start (up to 60
  minutes early) or just ended (up to 60 minutes late); outside any slot, the Room is an occurrence
  of its own. A Room of the same meeting opened again within 15 minutes of the last one ending
  (everyone dropped, the host came back, the hub restarted) **resumes** that occurrence: one
  divider, one recap card (it updates in place).

### 2. The meeting chat with guests, saved

The meeting chat ("Everyone here", which browser guests read and write) is saved **as it is
said**, line by line, as messages in the thread, never at the end. A hub that restarts mid-meeting
loses nothing: the chat a guest or colleague sees when they come back is read from the thread.

- **Authorship.** A colleague's line is their own message. A guest's line is a message from the
  guest's meeting identity (`guest:…`, no office account) with their name kept beside it, shown as
  `Mr Rao · GUEST`. Two guests with the same name in one occurrence are `Mr Rao` and `Mr Rao (2)`.
- **What guests see** is only the meeting chat of the occurrence they are in, as before. What
  members write in the thread (the "Conversation" sheet) is never shown to guests.
- **Breakouts** share the meeting chat; each line saved from a breakout carries its label
  (`B2 · PIPING`).
- **Files from guests.** The guest page has Attach: the file is sent in chunks through the gateway
  and checked by the hub with the office's file rules (blocked types, the upload size, and at most
  25 MB from a browser) before it is stored and posted in the thread as the guest's line.
  Guests see the file's name in the chat; colleagues can open it.
- **End-to-end encryption.** Members' own Direct messages stay sealed. The meeting chat is never
  end-to-end encrypted (a browser guest holds no keys and the hub relays every line), so when a
  meeting's thread is an encrypted Direct conversation, its meeting-chat lines are stored in that
  Direct as plain lines marked with the open lock and the reason "meeting chat with guests: not end
  to end encrypted". Nothing that was sealed is opened, and the office's "require encryption" rule,
  which governs what members' apps send, is not bypassed for members. For such a thread the hub
  cannot read the members' messages, so **the recap is assembled on the PC**: the hub gives the
  occurrence, attendance, recordings, action points (owner, due and status; their text is the
  sealed message) and the time range; the app reads and decrypts that range of the thread itself.

### 3. Who can come back to it

- **Thread members**: invitees, everyone admitted to an instant meeting or personal room (as
  today), office members who attended a Calendar meeting's own thread, and anyone the organiser
  adds later.
- **Attendees who are not members** (let in from outside to a meeting held in a Space they are not
  in) do not get the Space. They can open the **recap** of the occurrence they attended, which
  then shows only what they could see in the meeting: the meeting chat, its files, the action
  points, decisions and polls from the meeting, attendance and recordings shared with them.
- **Removed from the invitation:** before the meeting, they leave the meeting's own thread; after
  attending an occurrence, they keep it (they were there; records rules decide what stays). In a
  thread that is an existing conversation, membership of that conversation decides.
- **Guests** cannot come back after leaving. The organiser may send them the recap by email.
- **Records rules** apply unchanged: a thread is a conversation (Space or Direct retention, legal
  holds, compliance export). The recap is built from what is still there, so a purged or deleted
  message, file or action point never comes back through it; action points and saved chat lines
  are removed with their messages.

### 4. Action points

An action point is a message in the thread with a register entry: `AP-07` (numbered per thread,
so a series has one register), the task, an owner (a colleague, or a guest by name: `Mr Rao
(guest)`), an optional due date, and a status (open, done, dropped). Three ways to capture, all
ending in the same card:

1. **From chat.** A line starting `/action`, `/ap`, `AP:`, `Action:`, `→` or `->` (in the Room's
   chat or any thread's Dock) shows the parsed card above the composer as you type (owner and due
   underlined like Nib's words, `OWNER` and `DUE` captions). Enter logs it; the owner and date are
   chips to change before or after. `Ravi to send the revised GA by Fri` → owner Ravi, task "Send
   the revised GA", due Friday. Nib's name matching (`findPerson`) and date words (`by Friday`,
   `kal tak`, `20/11`) are reused.
2. **One key in the Room.** `A` (when not typing) or `Ctrl+Shift+A` opens the capture strip along
   the bottom of the stage: a ruled strip with the next number, the words, owner and due. The
   note-taker logs a point without leaving the stage; Escape closes it.
3. **Promote anything.** *Make an action point* on any message's menu (thread or Room chat, a
   guest's line too) and on a selection in a note.

Then:

- **The register.** A *Register* sheet tab in the Room's panel: 01 Agenda, 02 Action points (the
  ones brought forward from earlier occurrences first), 03 Decisions taken in this occurrence.
- **Owners learn at once**: one quiet notification, a To-do on their Desk (the card's message,
  filed as To-do, and a reminder on the due date at the start of the working day), and an item on
  their Nib day sheet given by the meeting's organiser (`source: meeting`). A guest owner gets none
  of these.
- **Done.** The owner (or the organiser, or whoever logged it) ticks it on the card, the
  register, the recap or their Desk; their Desk reminder and Nib item close with it, and ticking
  the Nib item done ticks the action point.
- **Overdue** points are reminded once a working day, within working hours (Nib's workdays,
  between the day's start prompt and the wrap-up), one grouped message per person listing all
  theirs, never one ping each, and not while they are on leave.
- **Recurring meetings** carry open points forward: the next occurrence's register and recap list
  them at the top, *Brought forward*, until they are done or dropped.

### 5. The recap

When an occurrence ends a **recap card** is posted in the thread: a title block (title, date,
time, duration, drawing number `MTG-482913207-03`) over a ruled line of counts (people, files,
action points open and done, decisions). It opens the **recap sheet**, drawn as a drawing's title
block and register:

`01 ATTENDANCE` (who attended and for how long, joins summed, two devices counted once; who was
invited and absent) · `02 RECORDING` (with chapters, once processed) · `03 ACTION POINTS` (owners,
due, status, progress as a dimension line; brought forward first) · `04 DECISIONS` · `05 FILES`
(each with a link to its message) · `06 POLLS` (results) · `07 NOTES AND BOARDS` (notes and
whiteboards changed during it) · `08 AGENDA` (ticked or not reached) · `09 CHAT` (collapsed,
searchable, paged for long meetings; deleted messages are not shown).

**Reach it from** the card in the thread, the Calendar (an event opened after it happened shows
its recap), the Meet lens (Recent meetings: Recap) and search (the chat and files are messages).
**Copy recap** puts plain text on the clipboard; **Send by email** builds an `.eml` draft
(`packages/core/src/eml.ts`) with the parts the organiser ticks (for guests, for example, only the
action points and files) and the addresses typed.

### 6. Other basics

- **Agenda** with time boxes, edited in the Register before or during the meeting and ticked off
  as it goes; the item running is shown on the stage's title block with its time left.
- **Joined late? Catch up.** Coming in more than three minutes after the start, a small card
  says what you missed: lines of chat since it started and the action points so far.
- **Note-taker.** The host gives the role from a person's menu (`NOTE-TAKER` tag); the recap
  names them.
- **Files** open in the app's viewer from the panel (PDFs in the PDF viewer).
- **Pins** work in the thread as in any conversation.
- **Breakout rooms**' chat is labelled by breakout in the main thread (above).

### 7. Edge cases

| Case | What happens |
| --- | --- |
| Never started | No divider or recap. The Calendar shows the event as not held; chat in the thread stays; open action points carry to the next occurrence. |
| Ended with nobody else joining | A recap is still posted when anything was captured (chat, files, action points); otherwise only the divider. |
| Started early | Up to 60 minutes before its slot it belongs to that slot. |
| Host left and came back | Same Room, same occurrence; the host rule is unchanged. |
| Everyone dropped, back within 15 minutes | The occurrence resumes; one recap, updated. |
| Hub restarted mid-meeting | Chat was saved as said; attendance as people came and went. The Room reopens under the same occurrence; an occurrence nobody returns to is closed 15 minutes later with its recap. |
| Two devices for one person | Attendance merges them; capture is idempotent (client ids); notifications go to the person. |
| Removed from the invitation | See §3. |
| Cancelled | The thread stays, with a *Cancelled* card; its recaps and action points stay. |
| Rescheduled | Same event, same thread; occurrences follow the new time. |
| "This and following" | The Calendar edits a series as a whole; a split series made later keeps the conversation, so the thread continues. |
| Very long meetings, many files | The chat in the recap is paged (200 at a time); files and attendance are listed in full, ruled; the Room's saved chat keeps the last 200 lines in memory. |
| Guest name collision | `(2)` within the occurrence. |
| Deleted messages and files | Not in the recap; an action point whose message is deleted is dropped from the register. |
| Edit window | Saved chat lines follow it like any message; editing a card's text edits the action point. |
| Retention purge | Messages go with their action points and chat records; the recap is built from what is left. |
| Offline clients | The thread syncs like any conversation; action point changes arrive as message updates. |
| Encrypted Direct | See §2. |
| Hindi and Tamil | Every string translated; the parser reads English words and the Hindi words Nib already reads. |
| Phone | The register, capture strip and recap sheet fit 390 px. |
