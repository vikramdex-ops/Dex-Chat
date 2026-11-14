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
| | Instant meeting with a link to share | Partly (Room in a conversation) | **M1**: every meeting has a short ID and a link (`dexconnect://meet/ID`, plus a web link for guests) |
| | Scheduled meetings, invitations, RSVP, reminders | ✅ Calendar | **M1**: "Meeting" type with ID, passcode, lobby, co-hosts; .ics invitations for people outside |
| | Personal room | — | **M1**: each person's standing meeting ID |
| | Join before host, lobby, lock meeting | — | **M1**: lobby with admit or deny (one at a time or all), lock, join-before-host setting |
| | Co-hosts | — | **M1**: the host gives and takes co-host rights; co-hosts have every host control |
| | Mute one or all, remove, lower hands | — | **M1**: host controls in the people table; "Ask to unmute" (never forced on) |
| | Raise hand, emoji reactions | — | **M1**: hand in the people table and on the tile, queued in order; reactions float up the tile |
| | Gallery, speaker view, pin, spotlight | Gallery only | **M1**: three layouts (gallery, speaker strip, presentation); pin for yourself, spotlight for everyone (host) |
| | In-meeting chat, files, polls, whiteboard | In the conversation | **M1**: a meeting panel with sheet tabs (Chat, People, Polls, Board, Files) without leaving the Room |
| | Breakout rooms | — | **M2**: the host splits people into rooms (by hand or at random) with a timer, broadcasts a note, and calls everyone back |
| | Annotation on a shared screen | — | **M2**: viewers draw on the presenter's screen (strokes go over the data channel, fade, can be cleared) |
| | Remote control | — | **M3**: the presenter grants control; keyboard and mouse events through a native helper on Windows |
| | Virtual backgrounds | Blur ✅ | **M1**: office backgrounds (drawn in code) and your own image, with the same segmenter |
| | Noise suppression | Browser filters | **M2**: a stronger suppressor (RNNoise, BSD) as an audio worklet, on by default |
| | Consent before video | — | **M1**: an office setting: join with the camera off, and ask before turning it on |
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

**M2: meetings that include the outside.** Guests join from a browser through the gateway. Also:
recordings stored on the hub with playback and sharing, breakout rooms, annotation, stronger noise
suppression, and per-meeting reports.

**M3: webinars.** Registration, roles, Q&A, handouts, practice sessions, live streaming, follow-up
and remote control.

Each phase ships with end-to-end tests that drive several app instances through the feature. The
performance targets above are measured in CI-like runs on the e2e harness.
