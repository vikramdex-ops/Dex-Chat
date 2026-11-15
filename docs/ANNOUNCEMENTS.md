# The notice board

Official notices from management, HR, IT and Admin used to arrive as messages in the Office
space: a PDF here, a text there, pinned until the pins ran out. They scrolled away, nobody could
tell which version of the leave policy was in force, and no one knew who had read the safety
circular. The notice board gives them a home of their own: a **register of issued notices**, drawn
the way our people already keep drawings, with numbers, revisions, stamps and an acknowledgement
register.

Code: `packages/core/src/notices.ts` (shared rules and types), `apps/hub/src/notices.ts` (the
register on the hub), `apps/desktop/src/renderer/notices/` (the lens, the reading sheet, the
composer, Pulse, the banner and the Control room section). Tests: `apps/hub/test/noticeboard.test.ts`,
`packages/core/test/notices.test.ts`, and the walk `apps/desktop/e2e/notices.mts`.

## 1. Where it lives, and why

- **A lens of its own: Notices** (Ctrl+8, or G then N), after Meet on a PC.
  - A notice is reference material, like the Directory or the Calendar. People come back to it to
    look something up ("what is the carry-forward rule?"), months after it was issued.
  - A card inside Pulse would bury it again under what changed today. So the board is its own
    place, and everything else points at it.
- **Pulse is the doorway**, not the home.
  - Notices waiting for my acknowledgement are rows in **Needs you**.
  - A strip, **This week at the office**, shows holidays and events on their day, and the policies
    issued this week. It is the board's front page, and the way in on a phone, where the lens strip
    has room for five.
- **A banner** under the title bar for urgent notices only: one at a time, dismissible, shown once.
- **Search** (Ctrl+Shift+F and the GO TO field) finds notices by their title, their text, their
  number and the text inside their PDFs.
- **Deep links**: `dexconnect://notices/<id>` opens a notice. The desktop notification and Nib's
  reminder use it.

## 2. The register

| Piece | What it is |
| --- | --- |
| **Number** | `HR-POL-0012`: the desk's code, the category's code and a running number per desk and category. It is given when the notice is **first issued**, so drafts that never go out leave no gaps. A draft's preview shows the number it will get. |
| **Revision** | Lettered like drawings: Rev A, B, … Z, AA. Issuing Rev B supersedes Rev A. |
| **Issuing desk** | HR, IT, Admin and Management come set up. Administrators add more (two to four letters for the code) and choose each desk's **issuers** in the Control room. A desk that has issued notices keeps its code. |
| **Category** | Policy (POL), Notice (NTC), Circular (CIR), Holiday (HOL), IT advisory (ITA), Safety (SAF), Event (EVT). |
| **Dates** | Issue date, effective date (defaults to the issue date) and an optional expiry. A holiday or an event uses the effective date for its day. |
| **Audience** | Everyone, or any of: departments (and the departments under them), roles (administrators, members), work locations (as written on profiles), named people. **Guests never.** The audience is worked out from the organisation **every time**, so a new joiner in Piping sees the policies in force for Piping and is asked to acknowledge them. |
| **Status** | Draft, Scheduled, Issued, Withdrawn, Expired (in the archive). Earlier revisions are Superseded. |

### The board on screen

- **Title block** at the top: `NOTICE BOARD`, the register's counts (`14 IN FORCE · 2 NEED YOU`),
  search and **Draft a notice** for issuers.
- **In force** shelf: policies (and anything the author marks as standing) drawn as **pinned sheet
  stacks**. Each stack has a drawing pin, and one sheet behind it for every earlier revision. The
  top sheet shows the number, revision, title and either a teal tick (acknowledged) or an amber
  ACKNOWLEDGE tag.
- **Filters**, in one strip of ruled cells:
  - the desk (All, HR, IT…);
  - the category;
  - the year;
  - **Needs my acknowledgement**;
  - **Archive** (expired and withdrawn).
- **The register**: one ruled row per notice.
  - Columns: number, revision, title, desk, category, issued, effective, status.
  - An amber tick on the left edge marks a notice that needs me; a teal tick marks one I have not
    opened yet.
  - At 390 px each row becomes a small title block: the number line, the title, and a mono meta line.
- **On the desk's table** (issuers only): drafts and scheduled notices, and revisions being written.
- **Empty state**: the drafting grid, one line ("Nothing has been issued yet") and one action.

## 3. Reading a notice

A notice opens as a **reading sheet**: a full-height sheet from the right on a PC (880 px), and
the whole screen on a phone.

1. **The title block** is drawn as a drawing's title block in ruled cells:
   - ISSUED BY (the desk and the person);
   - NO., REV, DATE, EFFECTIVE, EXPIRES;
   - FOR (the audience in words);
   - the category tag.
   - A withdrawn notice carries a **WITHDRAWN** stamp across it, with the reason and date. An
     earlier revision, when opened from the history, carries **SUPERSEDED**.
2. **The language strip.** When the author added Hindi or Tamil versions, a row of ruled cells
   (English · हिन्दी · தமிழ்) offers them. The reader's own language is chosen first when it exists.
   The app's interface is translated as usual. The notice's own words are what the author wrote,
   and are never machine-translated.
3. **The body**, written with the same formatting as messages: bold, lists, links.
   - In a new revision, every **new or changed paragraph sits in a revision cloud**, a scalloped
     outline drawn in code, with a **revision triangle** carrying the letter.
   - The author's change note sits above the body in a ruled box: `REV B · WHAT CHANGED`.
4. **The attached PDF** is shown **inline** in our PDF viewer (pages, thumbnails strip, zoom,
   search), not as a file chip. It has a Full screen button. Keys reach it only while it has focus.
5. **Questions and answers**: the desk's published answers, numbered.
6. **Ask the issuer**: a private question to the desk. It is not a thread. The desk answers
   privately, or publishes the answer to the notice's questions and answers, where everyone sees
   it. The asker gets one line from Nib when the answer comes. Five questions a day per notice at
   most.
7. **Related notices** (the ones the author linked, then the desk's others of the same kind), and
   the **revision history** (Rev, date, change note, status). Opening an older revision shows it
   with its stamp.
8. **Acknowledgement**, when the notice asks for it. This is a deliberate act:
   - a statement to tick, "I have read HR-POL-0012 Rev B and understood it";
   - for policies, up to three **check questions** chosen by the author, each with two to four
     answers. The right answers stay on the hub. A wrong answer says only "One of the answers does
     not match the notice. Read it again and try once more."
   - then **Acknowledge**.
   - A rubber **stamp** (READ AND UNDERSTOOD, the name, the date, the number and revision) lands on
     the title block once. With reduced motion it simply appears.

On a phone the acknowledgement sits in a bar along the bottom of the sheet, and the PDF fills the
width.

## 4. Acknowledgements and reminders

- **Whose acknowledgement counts.** An acknowledgement counts for the revision in force and every
  later one, until a revision **asks again** (the author's choice when issuing it).
- **The acknowledgement register** is for the desk's issuers and administrators. It is drawn like
  a transmittal's acknowledgement register:
  - one ruled row per department;
  - each person as a square cell, filled teal when they have acknowledged, hatched while waiting
    (initials and time on hover and for screen readers);
  - counts per row and in the title block.
  - It **fills live**: each acknowledgement colours its cell as it arrives.
- **Reminders to readers** are polite and grouped:
  - Nothing is chased on the day a notice is issued.
  - From 10:00 the next day, each person gets **at most one line a day** from Nib. That one line
    lists everything still waiting for them.
  - Each revision is reminded about **three times at most**.
- **Reminders from the desk.** The desk can send one reminder per notice per day
  (**Remind those waiting**). It goes only to people who have not had a line that day.
- **The desk's digest.** From 16:00, each issuer gets **one line a day**: the desk's notices still
  waiting, with counts by department. It replaces a message for every acknowledgement.
- When Nib is turned off, the lines come from the Dexterity Connect system bot.

## 5. Revisions

- **Revise** on an issued notice opens the composer on the next revision (Rev B). Readers keep
  seeing Rev A until Rev B is issued.
- The author writes a **change note** and chooses **Ask everyone to acknowledge again** (off by
  default).
- **Issuing Rev B:**
  - marks Rev A as **Superseded**;
  - works out which paragraphs are new or changed. Paragraphs are blocks separated by a blank
    line; moved ones and changes of spacing or case do not count. Those paragraphs get the
    revision clouds;
  - counts the paragraphs taken out, and notes the count under the change note.
- **What readers see:** their Pulse shows the notice again only when it asks for a new
  acknowledgement. Otherwise its row in the register carries the teal "not opened" tick until they
  open it.
- A draft revision can be thrown away. The revision in force is untouched.

## 6. Issuing

The **composer** is a sheet with numbered sections, like a settings schedule:

1. **Desk and kind.** The desk (only those I issue for), the category, and **Standing** (on the
   In force shelf; on by default for policies).
2. **Text.** The title and the body.
3. **Attachment.** A PDF, uploaded to the hub. Its text is read on the hub (`pdf.ts`, the first 12
   pages) and indexed for search.
4. **For.** Everyone, or departments, roles, locations and people. A live count says how many
   people that is now.
5. **Acknowledgement.** Ask for it, and add check questions.
6. **Dates.** Effective and expiry.
7. **Translations.** Optional Hindi and Tamil title and body.
8. **Revision.** For Rev B onwards: the change note and Ask again.
9. **Related.** Up to ten notices to link.

Actions:

- **Save draft**.
- **Preview**: the reading sheet exactly as a reader in the audience will see it.
- **Schedule…**: a date and time. It issues on the hub's timer, even if no one is signed in.
- **Issue now**.

Other parts of issuing:

- **Email copy.** For a notice that has been issued, issuers can open an `.eml` draft in the PC's
  mail program (`packages/core/src/eml.ts`) with the PDF attached. It is addressed to the people
  in the audience who do not use the app and have an email address on their profile. The draft
  says how many have no address.
- **Urgent notices** (an IT outage, a safety alert) are for **administrators only**:
  - They go out at once and cannot be scheduled.
  - They show a single **banner** under the title bar for everyone in the audience: an amber rule,
    the number and title, **Read** and **Dismiss**.
  - Dismissing is remembered on the hub, so the banner shows **once** across a person's devices.
  - It lasts a day unless an expiry is given (a week at most).
  - The office can issue **three urgent notices a day**. A fourth is refused, and the author is
    told to issue it as an ordinary notice.
- **Notifications.** When a notice is issued for someone, their app shows one desktop
  notification: "personal" when it asks for acknowledgement or is urgent, otherwise an ordinary
  message notification (quiet hours and Preferences apply).

## 7. Lifecycle and records

- **Expiry.** At its expiry, a notice moves to the **archive** (status Expired), on the hub's
  timer.
- **Withdrawal.** A notice in force can be withdrawn with a **reason**. It keeps a stamped record:
  WITHDRAWN, the date, who withdrew it and why. It asks no one for anything any more. A draft
  revision waiting behind it is dropped.
- **Retention.** Withdrawn and expired notices are kept for ever by default. An administrator can
  keep them for a number of days instead (at least a year).
  - Past that, they are removed, unless a **legal hold** covers their author (Control room ▸
    Compliance).
  - Notices in force are never removed.
- **Export.** Control room ▸ Notice desks exports the whole register (JSON, CSV or HTML). The
  export has every revision, its audience in words, its change note, and every acknowledgement with
  its time. It is the record for an audit.
- **Audit.** These are written to the audit log: issuing, scheduling, unscheduling, revising,
  withdrawing, discarding, expiry, desk changes, retention, exports, email copies, reminders,
  questions, answers and moves from the Office space.
  - Acknowledgements are kept in their own register, with their times, rather than as audit
    lines, so the log stays readable.
- **Files.** A notice's PDF is kept as long as the notice is. Only people who can see the notice
  can open the PDF.

## 8. Moving the Office space's pins

Control room ▸ Notice desks lists the messages **pinned in the Office space**.

1. An administrator ticks the ones that are really notices, and chooses the desk and the category.
2. **Move to the board** makes each one an issued notice for everyone:
   - The message's first line becomes the title, and the rest becomes the body.
   - Its first PDF becomes the attachment.
   - The notice keeps the date it was posted.
3. The pin comes off the message, so the Space's pins are left for conversation.

A message is moved once.

## 9. Motion, and what it is for

| Moment | What moves | Why |
| --- | --- | --- |
| A new notice arrives | Its register row **plots in** once: the rules draw from left to right like a pen plotter, then the text fades in. | You see what is new without a badge. |
| Acknowledging | The **stamp** lands on the title block with a short press (scale and a slight turn), and its ink settles. | It is the moment of signing for something. It should feel deliberate. |
| The acknowledgement register | Cells fill as people acknowledge. | The desk watches the round come in. |
| Pulse | **This week at the office** is a scale of seven day cells, with holidays and events on their day. | The week at a glance. |

Every motion is 120 to 260 ms and plays once. `prefers-reduced-motion` turns all of it off: rows
and stamps appear in place, and cells change without a transition.

## 10. Access and the phone

- **Keyboard:**
  - Every row, filter, stack and cell is reachable.
  - Enter opens a notice, and Escape closes the sheet.
  - The register is a list of buttons with full descriptions (number, title, status, "needs your
    acknowledgement").
- **Screen readers:** the acknowledgement register's cells are described as "Name, acknowledged
  at …" or "Name, waiting".
- **Contrast:** AA in both themes. Amber is used only for "needs you", urgent notices and
  "waiting"; status and category tags are mono captions in hairline boxes.
- **At 390 px:**
  - The shelf scrolls sideways.
  - The register rows stack.
  - The reading sheet takes the whole screen, with the acknowledgement bar at the bottom.
  - The composer's sections stack.

## 11. Operations (hub)

Every operation is in `packages/core/src/notices.ts`:

- for everyone: `notices.list`, `notices.get`, `notices.search`, `notices.ack`, `notices.seen`,
  `notices.ask`, `notices.dismiss`;
- for issuers: `notices.save`, `notices.issue`, `notices.discard`, `notices.withdraw`,
  `notices.answer`, `notices.acks`, `notices.remind`, `notices.emailCopy`;
- for administrators: `admin.notices.get`, `admin.notices.setDesk`, `admin.notices.removeDesk`,
  `admin.notices.setRetention`, `admin.notices.pinned`, `admin.notices.import`,
  `admin.notices.export`;
- the event `notices.changed` (with `issued` for the people a notice was just issued to).

The app-wide `search` also returns `notices` when it is not scoped to one conversation.

**The clock.** The board keeps its own clock: `now()`, and `setClock()` for tests and the
end-to-end walk in the same process. `tick()` runs on the hub's 10-second timer and does five
things:

- issues scheduled revisions;
- expires notices;
- sends the morning reminders;
- sends the afternoon digest;
- applies retention, once an hour.

A scheduled notice that cannot go out goes back to a draft, and its author is told. This happens,
for example, when the day's three urgent notices are used.

## 12. Not done, on purpose

- **No comment thread** on a notice. Questions go privately to the desk, and answers are published
  deliberately.
- **No reactions, and no "seen by" list for readers.** The acknowledgement register is the desk's,
  not everyone's.
- **No machine translation** of a notice's own words.
- **No read receipts unless asked.** Opening a notice only clears your own "not opened" tick. The
  desk sees acknowledgements, never who opened what.
