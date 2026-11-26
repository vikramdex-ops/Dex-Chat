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
- **Administrator windows and UAC prompts:** the helper runs with the person's own rights, never
  elevated, so Windows itself keeps its input out of an elevated (administrator) window and off
  the secure desktop of a UAC prompt or Ctrl+Alt+Del: the person in control sees such a prompt
  but cannot answer it; the person whose PC it is answers it. The app makes no attempt to get
  around this, in support sessions or in meetings. For that, an office uses **elevated control**
  through the IT Support service, installed by an administrator and behind its own policy (below).
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

## Remote support (Control room ▸ Policies ▸ Remote support)

Five policies, **each off until an administrator turns it on** (`OfficePolicy.assistUnattended`,
`assistClipboard`, `assistFiles`, `assistReconnect`, `assistElevated`; stored by
`apps/hub/src/policies.ts`, changes audited as `policy.set`). The first four work in the signed-in
desktop app; elevated control (administrator windows, UAC prompts, Ctrl+Alt+Del, the sign-in
screen, across a restart) works through the IT Support service: see "Elevated control" below.

**Unattended access** (`assistUnattended`). Anyone on the IT desk may connect to any office PC
without the person accepting: **Connect now** on a ticket, or *Connect to someone's PC…* at the top
of the Help desk (which opens a ticket for that person, held by the technician). The hub
(`help.connect`) refuses it unless the policy is on and the caller is IT staff; the session is
marked `unattended`. The person's app, if the policy is on, joins by itself (not when they are in
another Room or meeting: then the invite card stays) **with no microphone at all** (turning it on
asks), and once the technician is in the Room too, shares its main screen and gives control
(the policy is checked again before each step). It says so everywhere: a notification, the dock (*"Ravi connected without
asking"*), the amber banner (*"… connected without asking (unattended access is on for this
office)"*), the amber frame and the share bar (*IT CONNECTED WITHOUT ASKING*). **The person can
always stop it** exactly as in an attended session: Stop control, Stop sharing, End, Shift+Esc or
Ctrl+Alt+Shift+S. Nothing is given again by itself after they stop it (the hub remembers it for the
session, `stopped`), unless IT presses Connect now again. The hub chooses the **one PC** of theirs
that IT reaches: only a desktop app that said it can be controlled (`help.device`; never a phone or
the web app), the one already in the session, or else the one in use, on the office network; their
other devices never join or act on it. Everything Connect now needs is checked before anything is
written, so a refused connect leaves no ticket behind. It needs the app running and someone signed
in to Windows. An administrator turning the policy off stops control and the screen the app shared
by itself at once in running unattended sessions (they go on as ordinary sessions the person decides
in). Recorded: `help.unattended.started` / `help.unattended.ended`,
`unattended: true` on `help.session.started`, `help.consent.granted` and `help.session.ended`, and
*"connected without asking"* on the ticket.

**Clipboard** (`assistClipboard`). While control is on, text copied on either PC can be pasted on
the other (`{ k: 'clip', text }` on the data channel; text only; up to 8,000 characters of JSON, what
the hub relays when a Room has no data channel: longer text is not sent and the person is told).
What was on the clipboard before control began is not sent; only what is copied from then on. Each
side takes it only from the other person's device in the session.

**Files and folders** (`assistFiles`). Drop files, or a whole folder (up to 500 files at a time), on
the technician's picture or on the requester's dock. Each is uploaded to the hub's file store and
kept on the ticket (`help.drop`: every file checked first and attached in one transaction, one
timeline line per drop (every file is uploaded first, then one `help.drop`), audit
`help.files.dropped`; up to 2,000 dropped files a ticket, which do not
count toward its 40 attachments and are not in its list of files; only `help.drop` can attach them).
The hub tells the other side (`help.dropped`), whose device in the session saves them one at a
time under **Downloads\Dexterity IT\T-0042\** at their place in the folder; paths are
cleaned (`safeRelativePath`: no drive, no "..", no reserved names, on the hub and again on the PC)
and nothing is overwritten (`COPYFILE_EXCL`, the next free name).
**Send a file** still works without the policy.

**Reconnect** (`assistReconnect`). Once both people have been in the session's Room, either of them
dropping out (a network drop, a PC restarting) pauses the session instead of ending it: sharing and
control stop at once (`help.session.paused`), nothing can be shared while one side is away, and it
waits **10 minutes** (`reconnectGraceMs`) for **both** to be back; one side returning alone does not
end the wait. (Without the policy, either person leaving stops what was shared.) Each app joins
it again when it is back online or starts (`help.live`), and the session resumes
(`help.session.resumed`, with how long it was paused). After a network drop, the requester's app
shares the same screen again and, if they had given control, gives it again (it tells them); after
a restart it remembers nothing, so they choose again, unless the session is unattended. A
connection that does not come back in time ends the session (*"The connection did not come back in
time."*). Without the policy a dropped Room ends the session, as before. Each person rejoins only
from the device they were in the session on (`requesterDevice`, `techDevice`); the hub refuses any
other device of theirs.

## Elevated control (the IT Support service)

With **`assistElevated`** on, anyone on the IT desk can use an office PC **with administrator
rights**, whatever is on its screen: the person's desktop, administrator windows, UAC prompts, the
Windows security screen (Ctrl+Alt+Del), the lock and sign-in screens, also when nobody is signed in,
and across a restart (with `assistReconnect`). It goes through the **Dexterity Connect IT Support
service** (`apps/desktop/support-service/DexSupport.cs`), not through the app.

**Installing it** needs administrator rights on the PC, once:

- **Control room ▸ Policies ▸ Remote support ▸ Install on this PC** (on that PC, signed in to the
  office hub over the office network). Windows asks for administrator approval; the app never runs
  anything elevated without that prompt. It is offered only when the app is installed for everyone
  (Program Files): a copy installed for one person lives in their own folder, where anything running
  as them could swap `DexSupport.exe` before the administrator approves, so the app refuses and
  points to the setup switch below (Program Files is read from HKLM, not from environment variables).
  A declined prompt is reported as declined (Windows error 1223, in any language), never as installed.
- **For many PCs at once**: run the setup as an administrator (GPO, PsExec, Intune):
  `DexterityConnect-Setup-x.y.z.exe /S /SUPPORTHUB=hub-host:47900 /SUPPORTFP=AA:BB:…` (the hub's
  certificate fingerprint, shown in the hub's admin console).
- Either way `DexSupport.exe --install --hub HOST:PORT --fingerprint FP` copies itself to
  `%ProgramFiles%\Dexterity Connect Support\` (only administrators can change it, so nobody can swap
  the program a SYSTEM service runs), writes `%ProgramData%\Dexterity Connect Support\config.json`
  (owner Administrators, SYSTEM and Administrators only). A folder of that name someone else made
  first, or a link, is moved aside (renamed, never deleted recursively, which as administrator could
  be steered through a link inside it); the new folder is checked to really be ours, and the install
  stops if someone made one in between. The installer logs only to the console, never into that
  folder. The service reads `config.json` from one open handle and only when its folder and the file
  can be changed by SYSTEM and Administrators alone, with no other name for the file (no hard link).
  It creates the PC's **P-256 key in the machine key store** (never
  exported), sets `SoftwareSASGeneration` so services may send Ctrl+Alt+Del, and registers the
  automatic LocalSystem service `DexConnectSupport` (restarted on failure). `--uninstall` removes it
  all, puts `SoftwareSASGeneration` back as it was, and deletes the key; **Remove from this PC** does
  the same. Removing the app leaves the service in place.
- The service is built with the C# compiler of .NET Framework 4.8, which is part of Windows 10 and 11
  (`npm run support:build -w @dex/desktop`; Build-Release and CI do it before packaging). No SDK,
  no third-party code. It connects on the office network only, not through the internet gateway.

**On the hub** (`apps/hub/src/machines.ts`) the service is a **machine device**: it signs the same
authentication payload as people's devices with its P-256 key (`machineIdFor`,
`verifyMachineSignature` in `packages/core/src/machine.ts`; the hub's certificate is pinned by its
fingerprint) and is **accepted without approval** (`machine.added` in the audit log), on the office
network only (a machine connecting through the internet gateway is refused, and so is a technician
trying to connect, type or send Ctrl+Alt+Del through it) and at most 30 new PCs
an hour (2,000 in all). Control room lists every PC with the service; **Remove** blocks that key for
good (`machine.removed`; to add the PC again, remove the service from it and install it again, which
makes a new key).

**Connecting.** The Help desk lists the office PCs with the service (online, who is signed in, locked
or at the sign-in screen), each with a short ID (the start of its key's fingerprint). Names are what
each PC says about itself: two PCs with one name are both marked **SAME NAME**, and connecting to
either asks the technician to check the ID and when it was first seen (a pretend PC could show a
fake sign-in or UAC screen to collect a password). **Connect** (`machine.connect`) is refused unless the caller is on the IT
desk and the policy is on; one technician per PC at a time. The hub opens a ticket held by the
technician for the person signed in to the PC (matched by Windows account; the technician's own when
nobody is signed in or the account is unknown) and records *"Connected to DDS-PC-07 with
administrator rights"*. The viewer shows the PC's pictures (JPEG, up to 1920 wide, about 9 a second,
two in flight: the technician's app acknowledges each one it draws), the same mouse-and-keyboard
surface as a support session, **Ctrl+Alt+Del** (the real secure attention sequence, `SendSAS`,
audited as `help.elevated.sas`) and **End**. Input goes through the hub's **InputGate** (120 events a
second, the blocked chords, held keys released) and reaches the PC as virtual-key codes; the PC
limits the rate again. Every picture, input and Ctrl+Alt+Del checks again that the technician is still on the IT
desk and the policy is still on; taking someone off the IT desk or turning the policy off ends their
sessions at once (*"The technician is no longer on the IT desk."*, *"An administrator turned elevated
control off."*).

**On the PC.** The service (session 0) starts a worker (`DexSupport.exe --worker`) in the active
console session with its own SYSTEM token; a pipe only SYSTEM can open joins them. The worker follows
the **input desktop** (Default, Winlogon, the UAC prompt's) with `OpenInputDesktop` and
`SetThreadDesktop`, captures every monitor with GDI (`BitBlt`, the pointer drawn in), injects with
`SendInput`, and lets go of every held key and button when a session stops. A sign-in, sign-out or
switch of user moves the worker to the new console session.

**The person at the PC always sees it and can stop it**, on whatever desktop is showing (theirs, the
lock or sign-in screen, a UAC prompt), in the Dexterity look (deep teal, amber, the Di mark):

- **Arrival screen** when a session starts: full screen on the main monitor (the others dim and point
  to it): *"Ravi Kumar from IT is connecting to this PC"*, with administrator rights, the ticket, what
  IT can do, **OK, carry on** and **Stop now**. A line runs down for 12 seconds and hands over to the
  panel (Enter or Escape is OK). Shown once per session, not again when the desktop changes.
- **An amber frame** around every monitor while IT is connected, breathing slowly; clicks pass through.
- **A floating panel** at the top: the Di mark, a live dot, who, the ticket and for how long, the stop
  keys and a big **Stop**. It never takes the keyboard, and can be dragged out of the way.

Sizes follow the screen's scaling. `DexSupport.exe --preview-notice "Name" T-0042 20` shows it on the
current desktop without the service. **Stop** (or **Ctrl+Alt+Shift+S**) ends the session. A stop ends the session for good (*"The person at the PC pressed Stop."* on the
ticket). With nobody signed in IT may still connect; the strip is on the sign-in screen.

**Restarts.** The service stopping (a restart, an update) closes its link without ending the session,
so with `assistReconnect` the session waits and goes on when the PC is back; if the PC returns before
the hub noticed it left, the session starts again on the new link. A session the person stopped is
remembered by the service for a day (in its own folder, so also across a restart of the PC) and
never taken up again, even if the hub did not hear the stop.

**Recorded:** `help.elevated.started` (PC, who was signed in, locked), `help.elevated.sas`,
`help.elevated.ended` (duration, pictures sent, why), `help.session.paused` / `resumed` when the PC
restarts or drops off (with `assistReconnect` the session waits 10 minutes and goes on when the
service is back; otherwise it ends), `machine.added`, `machine.removed`, and the same lines on the
ticket. The service logs to `%ProgramData%\Dexterity Connect Support\service.log`.

**Not covered:** Remote Desktop sessions (the service follows the console only); PCs reached only
through the internet gateway; macOS and Linux.

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
- Remote support: `apps/hub/test/remote-support.test.ts` (the four policies off by default and
  admin-only, unattended access for IT staff only and its audit trail, pause and resume after a
  dropped Room, the grace period running out, dropped files) and
  `packages/core/test/assist-transfer.test.ts` (clipboard messages, cleaned paths for dropped files).
- Elevated control: `apps/hub/test/machines.test.ts` (a fake service in Node with a P-256 key over
  the hub's websocket: joining without approval, wrong keys refused, IT staff and policy only, input
  through the gate as virtual-key codes, Ctrl+Alt+Del, the person's stop, restart pause and resume,
  removal), `packages/core/test/machine.test.ts`, and on Windows
  `node apps/desktop/support-service/smoke.ts` (builds the real exe, runs it as the current user
  against an in-process hub: online, pictures, the pointer moved; also a CI step on windows-latest).
  SYSTEM, the secure desktop, the sign-in screen and Ctrl+Alt+Del need the installed service and are
  checked by hand on a PC (an administrator approves the install).
- End to end: `apps/desktop/e2e/unattended.mts` (Connect now from the Help desk, the person's app
  joining muted and sharing and giving control by itself, the notices, dropped files landing in
  Downloads\Dexterity IT\T-0001, rejoining by itself after a reload, the person stopping control,
  the audit log). Runs on Windows as well as under Xvfb. Clipboard sync is not covered end to end:
  both apps of the script share one clipboard.
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
