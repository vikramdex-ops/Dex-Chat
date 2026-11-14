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
| | Instant meeting with a link to share | ✅ **M1**: every Room is held under a meeting with a nine-digit ID (482-913-207) and a `dexconnect://meet/ID` link; instant meetings get a private Space of their own | **M2**: a web link for guests |
| | Scheduled meetings, invitations, RSVP, reminders | ✅ Calendar; ✅ **M1**: a Calendar event held as a call is a meeting with its own ID, lobby and co-hosts (the organiser hosts) | **M2**: passcodes for guest links, .ics invitations for people outside |
| | Personal room | ✅ **M1**: each person's standing ID, with its own Space made the first time it is used | |
| | Join before host, lobby, lock meeting | ✅ **M1**: lobby (nobody, outsiders and guests, or everyone waits) with admit or deny one or all; lock; join before host | |
| | Co-hosts | ✅ **M1**: the host gives and takes co-host rights; when every host leaves, the longest-present member runs the meeting | |
| | Mute one or all, remove, lower hands | ✅ **M1**: in the People tab and each tile's menu; muting is enforced on the PC, unmuting is "Ask to unmute" (never forced on); removed people wait in the lobby to come back; end for everyone | |
| | Raise hand, emoji reactions | ✅ **M1**: hands queued in order (people table and tile); six reactions float up the sender's tile, rate-limited on the hub | |
| | Gallery, speaker view, pin, spotlight | ✅ **M1**: gallery (numbered sheets past 25 tiles), speaker with a strip, presentation; pin for yourself, spotlight for everyone (host) | |
| | In-meeting chat, files, polls, whiteboard | ✅ **M1**: a panel with sheet tabs on its edge (People, Chat, Polls, Board, Files) on the meeting's conversation | |
| | Breakout rooms | — | **M2**: the host splits people into rooms (by hand or at random) with a timer, broadcasts a note, and calls everyone back |
| | Annotation on a shared screen | — | **M2**: viewers draw on the presenter's screen (strokes go over the data channel, fade, can be cleared) |
| | Remote control | — | **M3**: the presenter grants control; keyboard and mouse events through a native helper on Windows |
| | Virtual backgrounds | ✅ Blur; ✅ **M1**: drafting sheet, blueprint and plain studio drawn in code, and your own picture (kept on the PC) | |
| | Noise suppression | Browser filters | **M2**: a stronger suppressor (RNNoise, BSD) as an audio worklet, on by default |
| | Consent before video | ✅ **M1**: Control room → Policies → Calls: join with the camera off, and ask before turning it on | |
| | Recording, storage, playback, sharing | Local file ✅ | **M2**: recordings uploaded to the hub, a Recordings shelf, playback with chapters (who spoke when), shared by link |
| | Guests join from a browser (no install) | — | **M2**: the gateway serves a join page; guests wait in the lobby; media through TURN or Cloudflare's SFU |
| | Dial-in by phone | — | Out of scope (needs a telephony provider) |
| Webinars | Registration page and form, approval | — | **M3**: a public registration page through the gateway; registrants listed, approved, reminded |
| | Organizer, panelists, attendees | — | **M3**: attendees see and hear but are not seen or heard; promote to speak |
| | Q&A with upvotes and answered state | — | **M3**: a Questions tab, sorted by votes, answered live or in writing |
| | Polls, handouts, raise hand, reactions | Partly | **M3**: from M1, plus handouts |
| | Practice session | — | **M3**: panelists meet before going live |
| | Live streaming (YouTube and others) | — | **M3**: the hub sends the composited stream over RTMP (ffmpeg) |
| | Follow-up (thank-you, recording link), survey | — | **M3**: an automatic message to attendees, with an optional form |
| Analytics | Meeting history, durations, attendance | Usage report (calls) | **M2**: a report per meeting (who joined, when, how long, hands, polls) and office totals, as CSV |
| Admin | Departments, co-branding, action log, data retention | Mostly ✅ (org, audit, retention) | **M2**: meeting settings in the Control room (lobby, recording, consent, join before host); meeting events in the audit log |
| Security | Encryption, 2FA, lock, consent | ✅ DTLS-SRTP, device keys | **M1–M2**: lock, lobby, passcodes for guest links, consent |

## Building blocks already in place

- **Rooms:** PC-to-PC for up to 8, the hub relay (mediasoup) for up to 50, TURN for people outside.
- **Calendar:** online meetings tied to a conversation, invitations, RSVP and reminders.
- **Recording:** composited on the recorder's PC, with everyone told.
- **Blur:** MediaPipe segmenter, bundled.
- **Polls, forms, whiteboards and notes:** in conversations.
- **The gateway** (Cloudflare Worker) and its encrypted channel to the hub.

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

**M3: webinars.** Registration, roles, Q&A, handouts, practice sessions, live streaming, follow-up
and remote control.

Each phase ships with end-to-end tests that drive several app instances through the feature. The
performance targets above are measured in CI-like runs on the e2e harness.
