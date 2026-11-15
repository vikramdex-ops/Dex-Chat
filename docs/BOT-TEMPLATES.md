# Bot templates for a design office

The bot maker's first templates were one-shot forms: a few questions, then a task on someone's
Desk. Nothing came back to the person who asked, and nobody could see what was still open. This
note lists the bots that would save DDSP real time, ranks them, and records what was built.
Every bot built here is a **tracked** bot (see [INTEGRATIONS.md §4](INTEGRATIONS.md#after-it-is-sent-tracked-requests)):

- each request gets a number (`DC-0007`) and moves through **stages**;
- at each stage **one person acts** with buttons (approve, return with comments, plot, issue),
  with a note box or a checklist when the stage needs one;
- the person who asked watches it move **on the card they already have**;
- reminders are **few, polite, in working hours, and gathered** into one list per person, then
  passed up to a lead once;
- a **register** card (one card, replacing the one before) shows what is open, how old, and where.

The "Leave note" template and the daily activity bot belong to the Nib companion work and are not
covered here.

## Candidates

How often: per person, in a busy week, in a 60-person office (piping, structural, E&I, drafting,
document control, site teams, IT and admin).

| # | Bot | Pain it removes | Who | How often |
| --- | --- | --- | --- | --- |
| 1 | **Drawing check and issue** | Check prints lost on desks; "has Ravi checked it yet?"; back-checks forgotten; no record of which transmittal carried which revision, or whether the client acknowledged it | Drafters, checkers, leads, document control | Daily; every drawing, every revision |
| 2 | **Technical query (TQ / RFI)** | TQs live in mail threads and spreadsheets; nobody knows which are open, how old, or whether the answer reached the drawings | Engineers, leads, the client interface | Several a week per job |
| 3 | **Plot request with the plot queue** | Walking to the plot room to ask; plots made without approval; no idea of your place in the queue; plots left uncollected | Drafters, leads, plot room | Daily |
| 4 | **Software seat (E3D, PDMS, AutoCAD…)** | "Who has the E3D licence?" asked in every Space; seats held overnight; people waiting without knowing it | Modellers, designers, IT | Several times a day |
| 5 | **Site visit, full loop** | Gate passes arranged at the last minute; PPE forgotten; visit findings never written up | Site teams, leads, admin | Weekly per site team |
| 6 | **Late work request** | Security and the cab arranged by phone at 7 pm; no list of who is in the building after hours | Anyone working late, leads, admin and security | A few times a week, more near IFC dates |
| 7 | Model review comment closeout | Comments from a 30/60/90 % model review spread over mark-ups; closeout not proved | Leads, modellers, checkers | Per review (monthly per job) |
| 8 | Client comment register | Client comments on issued drawings answered piecemeal; "reply sheet" made by hand | Leads, document control | Per issue to client |
| 9 | Conveyance or expense claim | Paper bills, lost claims, slow approval | Everyone travelling to site, leads, accounts | Weekly per site person |
| 10 | Visitor arriving / front office | Reception does not know who is expected; visitors wait at the gate | Anyone hosting, front office | A few a week |
| 11 | Handover note (end of a project or role) | Knowledge leaves with the person; the next person starts from nothing | Leads, the person leaving, the person taking over | Rare but costly |
| 12 | IT help request | Small IT asks interrupt the IT person in person | Everyone, IT | Daily |
| 13 | Material take-off / BOM request | MTO requests to the piping lead with no due date or revision | Procurement-facing engineers | Per job stage |

## How they were judged

Each candidate was scored on: how often it happens (a bot people use daily earns its place), how
many people it connects (a second party acting is where messages get lost), how much it costs when
it goes wrong (a wrong revision issued, a TQ never closed), and whether a register would show
management something they cannot see today.

| Rank | Bot | Why | Built |
| --- | --- | --- | --- |
| 1 | Drawing check and issue | The core of the office's work; check and back-check loop, approval, issue and the client's receipt in one record | **Yes**, replaces "Drawing issue request"; folds in the transmittal register (#8 partly) |
| 2 | Technical query (TQ) | Open TQs are the most common question in project reviews; "open TQs: 7, oldest 12 days" | **Yes**, replaces "RFI log" (same short name, so copies keep working) |
| 3 | Plot request with the queue | Daily, three parties, a physical hand-off | **Yes**, upgrades "Plot request" |
| 4 | Software seat | Many times a day, the waiting line is invisible today | **Yes**, new |
| 5 | Site visit, full loop | Safety: PPE and permits before, the report after | **Yes**, upgrades "Site visit" |
| 6 | Late work request | One consolidated list for security at 16:30 instead of phone calls | **Yes**, new |
| 7 | Model review comment closeout | Same shape as the TQ bot (raise, assign, answer, close); members can copy the TQ template and rename it | Not yet: copy of TQ |
| 8 | Client comment register | Partly covered by the drawing check (transmittal and receipt) | Not yet |
| 9 | Expense claim | Needs accounts' own process and photo of the bill; the engine already supports it (a file step, lead approves, accounts pays) | Not yet: makeable in the maker |
| 10 | Visitor arriving | Simple notice; Pulse and the front office flow cover most of it | Dropped |
| 11 | Handover note | Rare; better as a document than a bot | Dropped |
| 12 | IT help request | Makeable with the engine (one IT role, "Fixed" / "Need more"); left to IT to shape | Not yet |
| 13 | MTO request | Too job-specific for a template | Dropped |

## What was built

Each template works as it stands. Where it needs a named person (the plot room, document control,
the client interface, admin, IT), the bot's maker chooses them under **Afterwards → People it
names**; until then it comes to the maker. "Their lead" is the person's manager in the Directory,
else their department's head. Someone out of office with a delegate is passed over to the delegate.

### Drawing check and issue (`DC-0001`)

1. The drafter answers: job (one tap from the Spaces they are in), drawings, revision, issued for
   (IFR, IFA, IFC, as-built), checker, check print (optional), issue by.
2. **Check** — the checker gets a card with a four-line checklist (title block, dimensions and
   tags, against the model and P&ID, notes and BOM). *Checked, no comments* needs every line
   ticked; *Return with comments* needs the comments.
3. **Correct** (when returned) — back to the drafter with the comments; *Corrected, send for
   back-check* sends it to the checker again: the card shows **Round 2**.
4. **Approve** — the drafter's lead approves it for issue, or sends it back.
5. **Issue** — document control issues it and writes the transmittal number.
6. **Client receipt** — document control records the client's acknowledgement: stamp **ISSUED**.

The register goes to document control at 09:20 on working days.

### Technical query (`TQ-0001`)

1. The engineer: job, discipline, drawing or document, the question, a proposed answer (the
   client answers faster), a mark-up, the date the answer is needed.
2. **Review** — their lead sends it to the client, answers it internally, asks to reword it, or
   marks it not needed.
3. **With client** — the client interface records the client's reply (due on the answer date).
4. **Close out** — the engineer closes it once the answer is in the drawings (**CLOSED**), or asks again.

Weekly register (Mondays 09:30) to the client interface: open, overdue, oldest, by stage.

### Plot request (`PLT-0001`)

1. Job, drawings, sheet size, sets, needed by, approver (the person's lead offered as one tap).
2. **Approve** — the lead approves, asks for a change, or turns it down with a reason.
3. **Plot queue** — the plot room sees it; the person who asked sees their **place in the queue**.
4. **Plotting**, then **Ready to collect** with where to collect it.
5. **Collect** — the person who asked presses *Collected*: **COLLECTED**.

Register to the plot room at 09:15. Reminders after 4 working hours.

### Software seat (`LIC-0001`)

1. Which software, for which job. No confirmation: one tap and it is theirs if a seat is free.
2. **In use** — places per software (E3D 4, PDMS 2, AutoCAD Plant 3D 3, AutoCAD 10, Tekla 2,
   STAAD.Pro 2, CAESAR II 1, Navisworks 3; the maker changes them). When all are taken the card
   says **In line for E3D: place 2 of 3**, and **Held by** whom since when.
3. The person who has held a seat longest is asked once, politely, when someone is waiting.
4. *Release the seat* moves the next person up: their card says the seat is theirs now.
   *Still using it* keeps the seat and restarts the clock.

Anyone writes "register" (or "who has one now") to the bot for the seats; IT gets it at 17:45.

### Site visit (`SV-0001`)

1. Site, day, job, how many going, purpose, site contact.
2. **Approve** — their lead.
3. **Gate pass** — admin arranges the pass and travel, with a note for the team.
4. **Safety** — the person going ticks the PPE and permit checklist before the day (*Ready to go*
   needs every line).
5. **Visit report** — due two days after; their lead reads it (**REPORTED**) or asks for more.

### Late work request (`LW-0001`)

1. Day, until when, job, what needs finishing, cab home or not.
2. **Approve** — their lead (reminded after 2 hours, never passed up).
3. **Arrange** — admin and security: **APPROVED** with the cab number for the person.

Admin and security get one list at 16:30 of who stays late, until when, and who needs a cab.

### Weekly TQ chaser (bots talking to bots, on a schedule)

Asks the TQ bot (`rfi-log.open`) how many technical queries are older than the days given, and
lists the ones the person may see. Its job runs every Monday at 10:00 (caught up once if the hub
was off) and tells the maker's lead only when there are any. It needs a Technical query bot the
maker may use; until there is one, saving says so.

### Friday timesheet (a job for a team)

Every Friday at 17:00 it starts for the maker's team (from the Directory; people on leave are left
out): the job they worked on most, the hours, anything else. Its "Who is your lead?" step asks the
Directory instead of the person, and the hours are posted to that lead. Both are described in
[`BOT-NETWORK.md`](BOT-NETWORK.md).

## Making more

The same engine is in the bot maker for everyone (**Afterwards** part): stages, who acts, the
buttons and where each goes, notes, checklists, places at once, reminders and the register. A
model review closeout or an IT help desk is a copy of the TQ template with different words.
