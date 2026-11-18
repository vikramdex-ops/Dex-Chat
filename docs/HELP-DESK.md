# Help desk: asking IT for help, and support sessions

Anyone in the office can ask IT for help from inside Dexterity Connect. IT works the requests as a
queue and, when it helps, opens a **support session**: a two-person Room in which the person being
helped decides, one step at a time, what IT may see and touch. Every grant is recorded.

## Asking for help

- **Where:** your tile menu ▸ **Help me…**, the command palette (Ctrl+G, "Help me"), the tray icon's
  menu, or the link `dexconnect://help`. On a phone it is in the same tile menu.
- **What you say:** one line about what is wrong, what it is about (an application, this PC or a
  device, network, printing and plotting, sign-in and access, drawings and files, something else),
  details if you like, and optionally a picture:
  - **Add a picture of my screen** (desktop): the app steps aside for a moment and pictures the
    screen it is on, so the picture shows what is behind the app. You see it before sending and can
    remove it.
  - **A picture from a file** (desktop and phone).
- It becomes a ticket, `T-0042`, in the IT desk's queue. **Your requests** in the same dialog shows
  where each one stands; you are told when someone takes yours.

## The IT desk

- IT people are those an administrator puts on the **IT desk**: **Control room ▸ People & roles ▸ IT
  desk**. It is a capability (`it`) on top of the person's role; guests and integrations cannot have
  it. Changes are in the audit log.
- People on the desk get the **Help desk** item in their tile menu and the command palette, and a
  notification for each new request.
- **The queue** lists active requests (waiting ones first, oldest first) and closed ones on their
  own tab: reference, who asked, about what, how long ago, and a status stamp: *IN THE QUEUE*,
  *WITH IT* (taken), *IN SESSION*, *CLOSED*.
- **A ticket** shows its title block (ref, status, who asked, category, the requester's system,
  opened, technician, rating), the request, its files (pictures, diagnostics, files sent in
  sessions) and a timeline. Anyone on it can add a note.
- **Take it** assigns the ticket to you (taking over from a colleague is allowed when no session is
  running). **Hand back** returns it to the queue. The requester or the technician **closes** it;
  the requester can **reopen** it, and it goes back to the same technician if they are still on the
  desk.

## Support sessions

The technician who took a ticket presses **Start a support session**. The requester gets a card,
*"Ravi Kumar from IT is ready to help"*, and chooses **Join the session** or **Not now**. Only the
requester and the assigned technician can be in the session's Room: other people on the IT desk can
read the ticket but cannot join, see or hear the session.

In the session the two hear each other (a microphone is not required to join). The requester has a
dock at the side of their screen (it folds to a small chip) that says who is with them and what
they share, with a stop button for each. The technician has a sheet with the requester's screen,
what they have allowed, and the ticket.

### 1. Seeing the screen

- The technician can **ask**; the requester always chooses. The sheet *"Share your screen with Ravi
  Kumar?"* shows pictures of each screen and window: the requester shares a whole screen or one
  window, or says **Not now**.
- While a screen is shared, an **amber frame** stays around that screen and a **share bar** stays
  on top of everything: *"Sharing your screen with Ravi Kumar · Stop sharing"*. Both are windows of
  their own, so they stay visible whatever else is open. The frame lets the pointer through.
- The technician can point at the shared screen with live pointers (see docs/MEETINGS.md); the
  requester sees them on their real screen.

### 2. Diagnostics

**Send diagnostics** (the requester's dock, or when the technician asks) gathers, on the
requester's PC:

- the app's version, its update channel and what it is built on;
- the operating system, processor, memory and free disk space;
- the displays (size, scale, which is main);
- the network: whether the hub answers and how fast (three round trips), whether the app is on the
  office network or the internet gateway (and the gateway's host), and whether each STUN/TURN
  server the hub gives for calls answers (a STUN binding request over UDP, a connection over
  TCP/TLS);
- the app's own recent log lines (`src/main/applog.ts`: connection changes, warnings, update steps,
  errors in its window, help-desk events) and recent errors in the window.

It **never** includes message content, names of files people shared, notes, keys, tokens or
passwords (TURN credentials included); log lines are written without them and anything that looks
like a token or a code is masked. The requester sees the summary and can open **the file as it
will be sent** before pressing **Send to T-0042**. It is attached to the ticket as JSON.

### 3. Files

Either side can **Send a file**: it uploads through the hub's file store (with progress) and is
attached to the ticket, so both can save it (with progress) and it stays on the ticket.

### 4. Remote control

Only after a **second, separate** consent: *"Let Ravi Kumar use your mouse and keyboard?"*. It needs
a whole screen to be shared. While it is on:

- an amber banner across the top of the app says *"Ravi Kumar is using your mouse and keyboard"*
  with a big **Stop control** button, and the share bar turns amber with its own **Stop control**;
- **Shift+Esc** or **Ctrl+Alt+Shift+S** stops control at once from anywhere, even while the
  technician is typing (global shortcuts of the requester's PC; the same keys from the technician
  are never passed on);
- stopping the screen share, leaving or ending the session, the app reloading or losing the hub
  also stops control. Keys and buttons the technician was holding are released.

How it works:

- The technician's pointer and keys travel over the session Room's **data channel** (PC to PC; the
  hub carries them only when there is no data channel) as small JSON events: pointer positions
  relative to the shared picture (0..1), mouse buttons, wheel notches and key codes
  (`KeyboardEvent.code`, so they type the requester's keyboard layout).
- The requester's **main process** decides what reaches the input (`packages/core/src/assist.ts`,
  `apps/desktop/src/main/assist/control.ts`): nothing while consent is off; at most **120 events a
  second**; system chords are never passed on (Ctrl+Alt+Del, Ctrl+Alt+End, Ctrl+Alt+Backspace,
  Win+L, Ctrl+Alt+F-keys, Alt+SysRq and the stop chord); positions are mapped onto the shared
  display.
- **Windows:** a small long-lived helper. Windows PowerShell compiles an inline C# class with
  `Add-Type` and runs it, sent as `-EncodedCommand` (no files written, not subject to the script
  execution policy). It declares itself per-monitor DPI aware (`SetProcessDpiAwarenessContext`), so
  positions are physical pixels on the **virtual screen** (all monitors, including ones left of or
  above the main one); it moves the pointer with `SendInput` (absolute, virtual desk) and
  `SetCursorPos`, and presses buttons, turns the wheel and types with `SendInput`. It reads one
  JSON command per line on stdin. No native Node modules and no third-party programs.
- **Linux (X11):** `xdotool`, kept running and fed one command per line. Without it, or on Wayland,
  control is not offered and the requester is told why.
- **macOS:** view only. Control would need Accessibility permission, which the app does not ask
  for; the requester is told so and IT guides them over the call instead.
- **Phones:** requests and sessions (with sound) work; screen sharing, diagnostics and control are
  desktop-only.

**The same pieces in meetings.** "Give control" in a meeting or on a webinar's stage
(docs/MEETINGS.md) uses this remote control as it is: the consent sheet, the amber banner, the share
bar, the stop keys, the controller's surface over the picture, the input events, gate, rate limit,
chords and mapping, and the injectors. The main process's `assist:consent` takes a *context*
(`support` or `meeting`) and, in a meeting, the one device whose input it accepts; in a support
session the window checks that input comes from the technician. In a meeting the frame and bar show
only while someone has control, since the meeting's own sheet shows the share.

## What is recorded

- **The ticket's timeline:** opened, taken (and from whom), notes, files, diagnostics, session
  started, joined and ended (with its length), every grant and every stop of screen or control
  (with how long it lasted), asks from the technician, closed, reopened, rated.
- **The audit log** (Control room ▸ Audit log): `help.opened`, `help.taken`,
  `help.session.started`, `help.consent.granted` and `help.consent.revoked` (who, when, what, the
  technician, from and to, and the duration), `help.diagnostics`, `help.session.ended` (with every
  grant), `help.closed`, and `help.staff.granted` / `help.staff.removed`.
- A session cut short by a hub restart is closed on its timeline when the hub starts again.

## After the session

When it ends, the requester is asked *"How did it go?"*: a rating from one to five, a word for IT,
and **Solved: close it** or **It still needs work** (which keeps or reopens the ticket).

## Where it is in the code

| Part | Files |
| --- | --- |
| Records and rules (hub) | `apps/hub/src/helpdesk.ts`; the session Room in `apps/hub/src/rooms.ts` (`enterPurpose`) |
| Protocol | `packages/core/src/helpdesk.ts`, `help.*` ops and events in `packages/core/src/protocol.ts` |
| Input events, gate, chords, mapping | `packages/core/src/assist.ts` |
| Requester's PC | `apps/desktop/src/main/assist/` (`index.ts` wiring, `control.ts`, `windows.ts`, `linux.ts`, `diagnostics.ts`, `overlay.ts`), `apps/desktop/src/main/applog.ts` |
| Screens | `apps/desktop/src/renderer/help/` (Help me, Help desk, the session, consent sheets, the share bar) |
| Shared with meetings ("Give control") | the main-process side above (with its *context*), `help/control.tsx` (the control consent sheet, the banner with Stop, the controller's surface), `help/ShareBar.tsx`, `packages/core/src/assist.ts`; the meeting's own parts are `packages/core/src/meet-control.ts`, `apps/hub/src/meet-control.ts` and `apps/desktop/src/renderer/meet/Control.tsx` and `control-store.ts` |

## Tests

- Hub: `apps/hub/test/helpdesk.test.ts` (tickets and the queue, the `it` capability, who may join a
  session, consent as the protocol carries it, the audit trail, a restart).
- Units: `packages/core/test/assist.test.ts` (the event decoder, the rate limit, the chord list,
  coordinates), `apps/desktop/test/assist.test.ts` (the generated C# and PowerShell, the JSON lines
  both sides speak, xdotool's commands, the control gate, input only from the device allowed in a
  meeting, diagnostics without secrets).
- End to end on Linux under Xvfb with xdotool: a technician's pointer and keys move the real
  pointer, click a button and type into a field in the requester's own window.
- **Windows:** the helper cannot run in the Linux test environment. CI's `input helper (windows)`
  job on `windows-latest` compiles it with `Add-Type` and moves the pointer through its JSON
  protocol, reading it back with `GetCursorPos` (`apps/desktop/scripts/assist-helper-smoke.ts`).
  It is a job of its own that nothing depends on, so it cannot hold up a release.
