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
| | Remote control | ✅ IT support sessions (docs/HELP-DESK.md): the requester allows it separately and stops it any time | **M3**: the presenter of a meeting grants control the same way |
| | Virtual backgrounds | ✅ Blur; ✅ **M1**: drafting sheet, blueprint and plain studio drawn in code, and your own picture (kept on the PC) | |
| | Noise suppression | ✅ **M2**: RNNoise (BSD-3-Clause) as an audio worklet on the PC, on by default, switched in the Room's sound menu | |
| | Consent before video | ✅ **M1**: Control room → Policies → Calls: join with the camera off, and ask before turning it on | |
| | Recording, storage, playback, sharing | ✅ **M2**: kept on the hub (resumable chunks, a size limit), a Recordings shelf, a viewer with chapters (who spoke when), shared with the conversation or by a link for the office, retention, audited downloads | |
| | Guests join from a browser (no install) | ✅ **M2**: the gateway serves a join page (name, camera and mic check, lobby); guests always wait to be let in; media PC to browser through TURN; meetings on the relay stay on the office network | |
| | Dial-in by phone | — | Out of scope (needs a telephony provider) |
| Webinars | Registration page and form, approval | — | **M3**: a public registration page through the gateway; registrants listed, approved, reminded |
| | Organizer, panelists, attendees | — | **M3**: attendees see and hear but are not seen or heard; promote to speak |
| | Q&A with upvotes and answered state | — | **M3**: a Questions tab, sorted by votes, answered live or in writing |
| | Polls, handouts, raise hand, reactions | Partly | **M3**: from M1, plus handouts |
| | Practice session | — | **M3**: panelists meet before going live |
| | Live streaming (YouTube and others) | — | **M3**: the hub sends the composited stream over RTMP (ffmpeg) |
| | Follow-up (thank-you, recording link), survey | — | **M3**: an automatic message to attendees, with an optional form |
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

Each phase ships with end-to-end tests that drive several app instances through the feature. The
performance targets above are measured in CI-like runs on the e2e harness.
