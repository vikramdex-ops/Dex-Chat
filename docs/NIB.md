# Nib: the office's companion

Nib is the one bot everyone in the office has. It is named after the nib of a drafting pen: the
small part that does the actual drawing. Nib is in every app from the first day, it cannot be
removed, and it does three jobs that make a design office run more smoothly:

1. **Day sheets.** Who gave you work today, what you did with it, and a register of it all for
   the leads and the management, without anyone chasing anyone.
2. **Leave, done once.** One short conversation sets your away status, blocks your calendar,
   tells your leads and your cover, answers people who write to you, moves your Desk reminders
   and welcomes you back.
3. **Everyday skills.** A morning brief, reminders in plain words, "where is…", "who's in",
   your next meeting, birthdays and anniversaries, a welcome for new joiners, and help with the app.

This page is the design. Code: `packages/core/src/nib.ts` (the parser, the nudge policy, the
register, permissions; shared and unit-tested), `apps/hub/src/nib.ts` (tables, ops, the clock,
cards), `apps/desktop/src/renderer/nib/` (everything people see).

## 1. Personality

Nib speaks like the quiet senior draughtsman at the next board: brief, warm, a little dry, never
chatty for the sake of it.

| Rule | Yes | No |
| --- | --- | --- |
| Numbers first | "18 of 40 sheets. Noted." | "Great job! You've made amazing progress today!" |
| One sentence where one will do | "Pens down at 6:15. Your sheet's ready to check." | Two paragraphs about productivity |
| Office words | sheet, register, issue, mark-up, pens down, on the board | tasks, tickets, synergy |
| Dry, not cute | "Nothing today. Fair enough." | "Oh no! 😢" |
| It asks, then gets out of the way | "Snoozed till your meeting ends." | Asking again in five minutes |

Nib never uses exclamation marks in its own words, never uses emoji, and never says "Hey". Its
lines are written in the app (and translated), not on the hub, so a Hindi or Tamil app hears Nib
in that language. Hub-written text (notification previews) is the short English fallback.

### The mark

A drafting-pen nib drawn on our 24 px grid: the tapered blade, the slit down its centre and the
breather hole, set on a square bot tile in teal 900. When Nib wants something it shows an **ink
drop** at the tip: a hollow teal drop when there is something quiet to look at, a solid amber drop
when it needs you (amber only means "you"). It is not a robot, a face or a speech bubble.

## 2. Where Nib lives

- **In the title bar**, beside your own tile. Click it (or `Ctrl+Alt+N` from anywhere in Windows,
  or **Tell Nib…** in the tray menu, or `/nib` in any Dock) to open **Nib's tray**, a panel that
  drops from the corner of the window (a sheet along the bottom on a phone). Nothing floats over
  the Dock or the panes.
- **A callout** under the Nib tile for the two moments Nib starts a conversation itself (the
  start of the day and the wrap-up). It is a small card, never a modal: work carries on around it,
  it does not take focus, Escape closes it, and screen readers hear it once (polite live region).
- **The Nib conversation**, kept on top in the Switchboard and impossible to leave. It holds the
  cards Nib sends (lead cards, registers, leave notices, welcome back) and you can write to Nib
  there as to anyone. Nib reads only its own conversation with you; Direct messages between people
  are end-to-end encrypted and the hub never sees them.

The notice board ([`ANNOUNCEMENTS.md`](ANNOUNCEMENTS.md)) speaks through Nib too, as plain lines
in the same conversation (`Nib.note`, once per key): one grouped reminder a day at most about
notices waiting for your acknowledgement, the issuing desk's afternoon digest, and a line when the
desk answers your question. With Nib turned off these come from the system bot.

Nib is one permanent identity on the hub (`system\nib`, role `bot`, no token), made the first
time anyone in the office opens the app. The older system bot ("Dexterity Connect") keeps sending
account notices (devices, roles), so security notices stay in their own plain channel.

## 3. Day sheets

### 3.1 The start of the day

When you start your day (the day menu in your tile, `/startday`, Pulse), Nib's callout asks
**"Who's given you work today?"**

- Quick picks: the **activity givers** the office set up (area leads, discipline leads, team
  leads), each as a tile with their scope underneath (`AREA 4`, `PIPING`). People who gave you
  work in the last ten workdays come first with a small `USUAL` mark.
- **Anyone else**: type a name; the Directory completes it.
- Pick several. For each, optionally the job (`P-12`, from the office's project codes and your
  recent ones) and a few words.
- **Log these**, **Someone else…** (the full start card in the tray, for anyone who is not a quick
  pick), **Nothing yet** (asks again later, once) or **On leave today** (opens the leave note). The
  **×** in the corner (**Not now**, or Esc) closes the card until the next ask.

If you have not started your day by the **start prompt time** (09:45 by default), the same card
opens gently in the callout: you can answer it without starting the day log.

Open items from your last working day **carry over** automatically ("carried" mark): a day sheet
continues where yesterday stopped, so nobody types the same activity twice.

### 3.2 Capture all day, without hunting for a page

| Way | How |
| --- | --- |
| **Plain words to Nib** | In Nib's tray, the Nib conversation or `/got …` in any Dock: "got 12 isos from Meera for P-12 area 4", "Ravi: check MTO for P-14, half day", "MTO pending from Meera side", "18/40 sheets done P-12". As you type, the words that Nib understood light up as annotations (giver, job, quantity, due); Enter adds the item, a tap on any annotation changes it. |
| **An offer in the conversation** | When someone writes to you in a Direct conversation, or @mentions you in a Space or side-track, with what reads like a request ("please check the GA for P-12 by Friday"), a quiet ruled strip appears under that message: **Add to my day sheet**, with the job and quantity it read. One tap adds it with the author as the giver; × hides it for good. It is shown only for today's messages, at most once per message, and never for your own. The detection runs in your app (it reads Direct messages only after they are decrypted on your device). |
| **Slash commands** | `/got <words>` adds work given to you, `/done <words>` records progress, `/wrap` opens the wrap-up, `/sheet` your day sheet, `/leave` the leave note, `/nib <anything>` asks Nib. None of them posts a message. |
| **Anywhere in Windows** | `Ctrl+Alt+N` brings the app forward with Nib's box ready; the tray menu has **Tell Nib…**. |

**Parsing** happens on the device (and the same rules on the hub for the Nib conversation),
never in the cloud: `parseWork` in `packages/core/src/nib.ts`. It finds:

- **who gave it**: "from Meera", "Meera:", "Meera side", "Meera ne diya", "by Meera", `@Meera`,
  matched against the Directory (configured givers first, small spelling slips forgiven);
- **the job**: the office's project codes, or anything shaped like `P-12513`, `P12`, `J-0412`;
- **the activity**: what is left once the rest is taken out ("Check MTO", "Routing area 4");
- **quantity with a unit**: `12 isos`, `18 of 40 sheets`, `18/40`, `12-15 drawings` (a range:
  15 planned), `40%`, `2.5 h`, `half day`, number words ("a dozen", "twelve");
- **units**: sheets, isos, drawings, GAs, MTOs, lines, spools, supports, models, mark-ups, hours,
  % (with their plurals, abbreviations and Hinglish spellings);
- **what kind of line it is**: given (`got`, `mila`, `assigned`, "please…"), done (`done`,
  `kar diya`, `ho gaya`, `issued`), progress (`x of y`, `%`), blocked (`pending`, `waiting`,
  `hold`, `stuck`, "vendor data awaited"), leave (`leave`, `chutti`, `half day`) or nothing
  (`nothing today`, `kuch nahi`);
- **due**: "by Friday", "kal tak", "EOD", "by 5pm", "on 20 Nov".

When the on-device sentence model is already loaded (Automations and the bot maker load it), Nib
asks it which kind of line it is and blends that with the rules; the rules always decide alone
when the model is not there.

### 3.3 Progress

Each item on the day sheet shows its giver's tile, the job and the activity, and either:

- **numbers**: `18 / 40 sheets` with a dimension-line bar and a stepper (− +, or type), or a
  0–100 % slider for percentages;
- **words**: "Area 4 routing nearly done, waiting for vendor data";
- or **both**. Each item is *ongoing*, *done* or *blocked* (blocked asks for the reason).

### 3.4 The wrap-up

At your **wrap-up time** Nib offers the sheet pre-filled with everything it knows. You correct
numbers, mark items done or blocked, add a note or a blocker, and **Send to Meera and Ravi**.
The button names exactly who receives it. After sending you can still change it; the leads'
cards follow ("changed after sending").

### 3.5 The nudge policy (getting it filled without being annoying)

`nudgePolicy()` in `packages/core/src/nib.ts`, called by the hub every minute for each person.

1. **Never** on a non-workday (a day off in the office's holiday list counts as one; a compensatory
   working day does not, see [`HOLIDAYS.md`](HOLIDAYS.md)), for people the office exempted (by default the management
   subscribers themselves), on leave, after "Nothing today", or once the sheet is sent.
2. **Never while busy**: in a Room, in a calendar meeting, on Do not disturb or Heads-down. A
   nudge that falls in a busy spell waits until it ends; it is not counted.
3. **Never twice within 20 minutes.** At most the office's limit a day (3 by default, 1 to 5).
4. **The ladder**, from the person's wrap-up time *T*:

   | When | What | Counts as an ask |
   | --- | --- | --- |
   | *T* | A hollow ink drop on Nib's tile. Nothing moves. | yes |
   | *T* + 25 min | The wrap-up callout under the tile, and a card on Pulse. | yes |
   | *T* + 50 min, or 15 min before the register, whichever is first | One friendly message in the Nib conversation, which notifies like any message. | yes |

5. **Adaptive**: *T* is the person's own wrap-up time if they set one; otherwise the office's,
   moved towards the time they usually send (the median of their last ten sends), never earlier
   than an hour before the office's time and never later than 30 minutes before the register.
6. **Their choice**, on the wrap-up callout: **Check and send**, a snooze (**In 30 min**, or
   **After my meeting**: until the current meeting ends), **Nothing today** (when the sheet has no
   work of today on it), or **×** (**Not now**). The wrap-up itself has **Ask me at …: change**, to
   set your own wrap-up time. A snooze moves the next ask; it does not count.
7. **Only asks people could see count**: an ask while none of their devices is connected is not
   counted, so "Nib asked 3 times" is true.
8. **The morning after**: if yesterday's sheet was never sent, the start card offers to send it
   first (one ask, counted against yesterday).

Every ask is recorded with its level and time; the management sees the count.

## 4. What leads receive

**One card per lead per day**, in their Nib conversation, the first time someone sends a sheet
with work from them. The card is live: later sheets fill it in place, with a `LATE` mark when they
arrive after the register, and nothing else is posted. It is a **transmittal** sheet:

- a title block: `FROM YOUR DESK · MEERA IYER · THU 12 NOV · 4 PEOPLE`;
- one ruled row per person: their tile, each item (`ISO routing · P-12 · 18 / 40 sheets` with a
  bar, or their words), their note and blockers (blockers in amber);
- totals per job and unit at the foot (`P-12 · 54 / 90 sheets · 12 isos`);
- **Waiting for**: people who named this lead at the start of the day but have not sent yet;
- actions per row: **Seen** (the person sees "Meera saw it" on their sheet) and **Write** (opens
  your Direct conversation with them, quoting the item); **Seen all** at the top.

## 5. What management receives

Management subscribers get **one daily register**, at the register time (19:00 by default), as one
card in their Nib conversation. It is built for 40 to 200 people and never needs scrolling to
understand:

1. **Headline cells**: `EXPECTED 38 · IN TODAY 34 · REPORTED 31 · NOT YET 4 · ON LEAVE 3 · BLOCKED 2`
   (Not yet counts the missing and those not in who have not reported).
2. **The register**: everyone as a small square cell, grouped by department, like a drawing
   register's sheet index. Solid teal: reported. Teal with an amber corner: reported with a blocker.
   Hatched: missing. Dashed with `L`: on leave. Paper: not in today. Each cell's fill height shows
   how much of their planned quantity is done. Tap or arrow to any cell to open that person's
   sheet in the card (keyboard: the register is one focus stop; arrows walk, Enter opens).
3. **Output**: totals per unit in large figures (`ISOS 186 · SHEETS 74 / 120 · MTO 9`) and one
   bar per job with done against planned, the busiest jobs first (`+3 more` opens the rest).
4. **By discipline**: reported against expected, as short bars.
5. **Call-outs**: blockers (person, job, words; at most five, then a count), and outliers (no
   progress all day on numbered work, past-due items, someone with work from four or more givers).
6. **Leave, grouped**: "3 on leave: Anil (back Mon), Sneha (sick), Ravi (half day, afternoon)".
   Individual leave messages to the management are never sent.
7. **Not reported**, with how many times Nib asked: "Kiran · asked 3× · Deepa · asked 1× (in
   meetings all afternoon)".

The register is a snapshot at the time it was sent, so it reads the same tomorrow.

**Late sheets.** If anyone sends after the register, **one** follow-up register is sent at the
follow-up time (21:00 by default; a time before the register time means the next workday
morning). It lists only the late sheets, in the same rows as a lead card, and who is still
missing with their ask counts. No late sheets: no follow-up.

**The week.** On the last workday of the week the management also get a weekly roll-up: a small
register of people by day (five cells each), reporting by day, and each job's week total with a
bar per day.

## 6. Leave, made great

The **leave note** is a Nib skill (tray chip **Going on leave**, `/leave`, "on leave tomorrow" to
Nib, or **On leave today** on the start card). It is the office's way of going on leave: `/leave`
is always Nib's, and Front Office's **Leave request** (an approval only) starts with
`/leave-request` and points back to the note when it is sent. One short sheet asks, with sensible
defaults already chosen:

- **when**: Today · Tomorrow · Pick dates · Half day (morning or afternoon);
- **kind**: annual, sick, comp-off, half day;
- **who covers** (a person picker) and a **handover note**;
- **who to tell**: your leads (today's and recent givers, and your manager, pre-ticked) and,
  optionally, your most active Spaces (the three you wrote in most in two weeks);
- **Desk reminders due while you are away**: move to the day you are back (default), hand to
  your cover, or leave.

It shows exactly what will happen, then **Do it** does all of it:

| | |
| --- | --- |
| Away | Out of office until the end of your last day (applied on the first day for leave that starts later), with your note and your cover as the contact. Your status reads "On leave · back Mon 16 Nov". |
| Calendar | An all-day "On leave" block for those days. |
| Leads | One small Nib card each ("Priya is on leave Thu 12 – Fri 13. Cover: Ravi"). Leads who are management subscribers see it in the register instead. |
| Spaces | If chosen, one line from Nib in each Space. |
| Cover | A Nib card with the dates, the handover note and your open day-sheet items, with **Add to my day sheet** for each. |
| Auto-answers | Anyone who writes to you, or @mentions you, gets the away notice naming your cover (once every 12 hours per conversation). |
| Desk | Reminders moved or handed over as chosen. |
| Day sheets | No nudges on those days; one grouped line in the management register. |
| Back | The first time you open the app on your return day, Nib's tray opens on **Welcome back**: conversations that moved and where you were mentioned, work your cover logged against your items, reminders moved to today, and today's meetings. |

The bot maker's **Leave note** template gains an end action, **Nib marks the person away**
(`do: "away"`), that hands its answers to this skill, so a bot built from it does all of the above
too.

## 7. Everyday skills

Each is a chip in the tray and a phrase Nib understands. Nib only uses what the person can see:
every skill runs with that person's own access (their search, their calendar, their Directory).

| Skill | What it does |
| --- | --- |
| **Morning brief** | Opens with the first look of the day: date, today's meetings, reminders due, items on your sheet (with carried ones), birthdays and work anniversaries among your department and the people you write to, and the day's line. Five lines, never more. |
| **Natural reminders** | "remind me to send the GA to Ravi after lunch" (after lunch 2 PM, before lunch 12:30, end of day, this evening, tomorrow morning, kal, in 20 min…). |
| **Where is…** | "where is the GA for P-12 area 4": files and messages from your own search, newest first, opened in one tap. |
| **Who's in / who knows** | "who's in today" (from the day log: office, home, site); "who knows about P-12 stress" (people who write about it in Spaces you can see, and Spaces named for it). Day sheets are never used for this. |
| **My next meeting** | Its time, place and a **Join** button. |
| **New joiners** | A welcome card on their first day: a five-stop tour, the people to meet (manager, department head, three colleagues) and a button to the office drawing. |
| **Help with the app** | "how do I share my screen": short steps and a **Show me** button that takes you there. |
| **Holiday circular** | An administrator drops management's holiday circular PDF into the conversation: Nib reads it, checks every row (weekday, year, duplicates, what each compensatory working day makes up for), shows a card and registers the days on **Register N days**. See [`HOLIDAYS.md`](HOLIDAYS.md). |

## 8. Configuration (Control room ▸ Nib & day sheets)

Administrators (the office manager, a director) set, on one ruled sheet in four parts:

| | Default |
| --- | --- |
| **01 Activity givers**: area leads, discipline leads and team leads, each with a scope (`Area 4`, `Piping`); **Add the department heads** fills it from the Organisation | none |
| **02 Management**: **Who receives the register** (the daily register, the follow-up and the week) | none |
| 02 Management: **Who keeps a day sheet**: **All but the management**, or **Choose** who keeps none | all but the management |
| **03 Times**: start of the day card, wrap-up, register, follow-up | 09:45, 18:00, 19:00, 21:00 |
| 03 Times: **Asks a day** (1–5) | 3 |
| 03 Times: **Workdays** | Mon–Sat |
| **04 Jobs and privacy**: **Job codes**, one per line (`P-12 Refinery revamp`), used for parsing and grouping | none |
| 04 Jobs and privacy: **Who sees day sheets**: **Private** (each person, their givers for their own items, the management for all) or **Open to the office** | private |
| 04 Jobs and privacy: **Day sheets** on or off | on |

Every change is in the audit log (`nib.config`). **Send me a register now** posts today's register
to the administrator to check the look before the first evening.

## 9. Permissions

`canSeeSheet()` in core, used by every hub op:

- your own sheet: always;
- a giver: only the items they gave, with your note and blockers;
- a management subscriber: everyone's;
- the office's "open" setting: every member sees every sheet;
- guests and bots: never.

## 10. Under the hood

**Tables** (hub, `apps/hub/src/nib.ts`): `nib_items` (one per activity per day), `nib_days` (the
givers picked, state, notes, when sent, asks), `nib_asks` (each ask: level, time), `nib_posts`
(which card was posted to whom), `nib_snapshots` (the register as sent), `nib_leave`, `nib_acks`,
`nib_prefs`. The configuration is one JSON value in `meta`.

**Cards** are messages from Nib whose `clientId` is `nib-<kind>-<ref>`. The hub adds
`message.nib = { kind, ref }` to them (a view extra, like Decisions); the app draws the card from
`nib.card { kind, ref }`, which is checked against the viewer's permissions each time. Lead cards
are computed live, registers are read from their snapshot. `nib.changed` tells open cards to
refresh. The message body is a short English line for notifications and search.

**The clock**: the hub's Nib has its own clock (`now()`), real time plus an offset. Unit tests call
`tick(at)` with exact times; the end-to-end script moves the in-process hub's clock directly
(`hub.nib.setClock`), which no client operation can reach.

**Operations**: `nib.me`, `nib.start`, `nib.item.save`, `nib.item.delete`, `nib.wrap`, `nib.day`
(nothing / snooze / wrap-up time), `nib.card`, `nib.ack`, `nib.sheet`, `nib.leave`,
`nib.leave.cancel`, `nib.welcome.seen`, `nib.holidays.read`, `nib.holidays.register` (holiday circulars,
[`HOLIDAYS.md`](HOLIDAYS.md)), `admin.nib.get`, `admin.nib.set`, `admin.nib.preview`.
Events: `nib.me` (your own state), `nib.changed`.

**Performance**: the register for 200 people and 800 items is built in about 2 ms on the hub
(measured in `packages/core/test/nib.test.ts`); in the end-to-end walk a 197-person register is on
screen about 130 ms after the hub is asked for it (posting, fetching and drawing). The grid is
drawn once and kept when the panels below it change.

**Tests**: `packages/core/test/nib.test.ts` (the parser in English and Hinglish, reminders in
words, the nudge policy, permissions, lead cards, the register for 40 and 200 people, the week),
`apps/hub/test/nib.test.ts` (a whole day with the clock moved: start, capture in the conversation,
wrap-up, one lead card filled in place, one register, a late sheet and exactly one follow-up;
nudges counted and paused on Do not disturb; who sees whose sheet; the leave note end to end; the
bot maker's Nib marks the person away) and `apps/desktop/e2e/nib.mts` (the same day in three real apps).
