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
| | Instant meeting with a link to share | ✅ **M1**: every Room is held under a meeting with a nine-digit ID (482-913-207) and a `dexconnect://meet/ID` link; instant meetings get a private Space of their own; ✅ **M2**: a guest link for browsers (`https://<gateway>/m/ID#passcode`) | |
| | Scheduled meetings, invitations, RSVP, reminders | ✅ Calendar; ✅ **M1**: a Calendar event held as a call is a meeting with its own ID, lobby and co-hosts (the organiser hosts); ✅ **M2**: passcodes for guest links, invitations as text or `.ics` (one VEVENT, UTC, the organiser, the link and passcode) | |
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
| | Guests join from a browser (no install) | ✅ **M2**: the gateway serves a join page (name, camera and mic check, lobby); guests always wait to be let in; media PC to browser through TURN; meetings on the relay stay on the office network | |
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

- **Guests from a browser.** A meeting's guest link is `https://<gateway>/m/<ID>#<passcode>`. The
  gateway Worker serves a small page (`apps/gateway/guest/`, built into the Worker with esbuild):
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
- **Invitations.** "Copy invitation" and "Download .ics" in the Calendar's meeting dialog and the
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
