# Seating: the office's real floor plan

Directory ▸ Org chart ▸ **Floor** is the office's own drawing: the A3 seating layout dated
18-Jul-2026, transcribed into data at real scale (feet), with people on the seats they hold. It
replaces the generic plan the Floor sheet used to invent from free-text seats ("Bay 2, Desk 4");
that generated plan is still the fallback when a hub has no plan.

Code: `apps/hub/src/seating.ts` (the hub), `packages/core/src/seating.ts` (rules both share),
`apps/hub/seed/floor-l01.json` (the transcribed drawing), `apps/hub/seed/floor-l01-names.json` (the
names written on its seats), `apps/desktop/src/renderer/orgscape/` (`plan.ts`, `drawplan.ts`,
`seating/`). Tests: `apps/hub/test/seating.test.ts`, `apps/hub/test/seatnames.test.ts`,
`packages/core/test/seating.test.ts`, `apps/desktop/e2e/seating.mts`, `apps/desktop/e2e/seatnames.mts`.

## The plan as data

The hub keeps the plan as versioned JSON (`seat_layouts`); every saved layout is a new version.
Coordinates are feet from the inside face of the north-west corner, x east, y south (the drawing's
top is plan north). A plan holds:

| Part | What it is |
| --- | --- |
| `outline`, `walls` | The floor, and walls as centre lines with a thickness: partitions, glazing (`glass`), the structural wall (`solid`), and the curved glass corners as arcs. |
| `doors` | Hinge, the leaf's closed tip and its open tip; the swing is drawn between them. |
| `columns` | The twelve 4′1″ columns. |
| `rooms` | Named outlines with their size as drawn (`STORAGE ROOM 7′0″ x 14′10″`), half-cabins and client cabins. |
| `fixtures` | Fixed furniture as simple symbols: the conference table (16 seats), sofas, the planter island, printers, the reception counter, the senior pods' desks. |
| `seats` | Every seat: ID, position, facing (compass degrees), type, zone and the bench or pod it belongs to. |
| `zones` | Groups people recognise ("Left benches"), each with its ID code. |
| `dims`, `labels` | The drawing's dimension strings and notes ("WORKSTATIONS 53 Nos."). |

Validation (`validatePlan`): seat IDs unique and well formed, no two seats closer than 1′7″
(overlap), every seat in a zone that exists and on the floor, rooms named and outlined.

A person's callout carries the way across: on the reporting lines, **Find on the floor** switches
to Floor with them still selected and flies to their seat, spotlit (or says "No seat on the plan",
or that they work away today); on Floor, **See in the reporting lines** flies to their plate.

## Seat IDs

| Zone | IDs | On the drawing |
| --- | --- | --- |
| Left benches | `W-A01`…`W-A53` | WORKSTATIONS 53 Nos. Five double benches (5 + 5) and a short row of 3. Numbered bench by bench from the north: the north side west to east, then the south side, so bench 1 is `W-A01`–`W-A10` and the short row is `W-A51`–`W-A53`. |
| North-east benches | `W-B01`…`W-B20` | WORKSTATIONS 20 Nos. Two double benches of 5 + 5, numbered the same way. |
| Senior pods | `POD1-1`…`POD1-9`, `POD2-1`…`POD2-9` | SENIOR WORKSTATIONS 18 Nos. Two pods of three Y-shaped three-seat clusters; seats numbered in reading order (north to south, then west to east). |
| Half-cabins | `HC-03`…`HC-10` | HALF-CABIN 03 to 10, the drawing's own numbers (two wide, four tall, numbered across). HC-04, 05, 07, 08 and 10 start reserved for the roles the drawing names (Knowledge HUB, 3D-Manager, E&I Manager, Civil-Manager, Piping-Manager). |
| South-east benches | `W-C01`…`W-C42` | WORKSTATIONS 42 Nos. A row of 6 (`W-C01`–`W-C06`), then three double benches of 6 + 6. |
| Client cabins | `CC-01`…`CC-09` | CLIENT CABIN 01 to 09. |
| MD's cabins | `MD-01`, `MD-02` | MD-01 is the north cabin (14′4″ × 16′11″), MD-02 the south (14′4″ × 17′3″). |
| Reception | `REC-01` | The front desk. |

153 seats in all. New seats take the next number in their zone (`W-A54`…); a new pod takes the
next pod number (`POD3-1`…).

## Who holds a seat

A seat is held by nobody, a person, a reservation for a role or team ("Piping · hot desk"), a name
from the office drawing whose person has not joined yet (below), or is a hot desk that anyone can
book for a day (today or up to two weeks ahead). A person holds at most one seat.

## Names from the drawing

The drawing has a name written on 40 of its seats, mostly first names ("Sharada", "Logesh M",
"Karthikeyan A S"). They are committed as seed data in `apps/hub/seed/floor-l01-names.json`, with
where they came from: the drawing `Seating_Plan_18-Jul-2026`, read on 15-Nov-2026. The office owner
approved keeping these names in the repository (before, they were deliberately kept out and handed
over as a CSV to import).

- **A fresh hub** puts each name on its seat as part of Rev A. Nothing has to be imported, matched or
  applied. On the plan a named seat looks like the seat of someone away: a tile with initials and
  the name under it. **Find** finds it by name ("Shar" → Sharada · Seat W-A31), its callout says who
  holds it and that they have not joined yet, and **Walk there** walks to it.
- **Once only.** A meta flag (`seating.drawingNames`) records that the names were put on the plan.
  They are never put there again: not on a restart, and not on a seat that was cleared, given to
  someone else or made a hot desk since.
- **A hub that was already running** gets the names once, on its next start, on the seats that are
  still empty. Nobody is moved: a seat someone holds (or that is reserved or a hot desk) keeps its
  holder, and a name is left out when someone already seated fits it (they were seated by hand). It
  is a revision ("Names from the drawing … put on N empty seats") and in the audit log
  (`seating.names`).

**When people join, they take their seat.** When someone's first device is approved, when an
administrator imports people, when someone is renamed (by themselves or an administrator), when a
guest becomes a member, and at every start, the hub looks at the names still on seats. A person with
no seat takes a named seat only when it is certain:

- the drawing's name fits theirs word by word from the start, each word the same word or a single
  letter their word starts with (an initial). Case, spaces and dots do not matter. "Sharada" fits
  Sharada Venkat; "Logesh M" fits Logesh Murugan; "Karthikeyan A S" fits Karthikeyan A Senthil.
  "Sam" does not fit Samuel (a word must be whole), and "Anand Pandey" does not fit plain Anand;
- of all the names on the drawing that fit them, the longest is a single name, and that name is
  still on exactly one seat. So Karthikeyan A Senthil takes "Karthikeyan A S", not "Karthikeyan A";
  and once "Karthikeyan A S" is taken, a Karthikeyan A Suresh is not given "Karthikeyan A" either;
- nobody else without a seat fits that name. Two people called Pavithra both wait.

The seat becomes theirs at once: a revision ("W-A31 taken by Sharada Venkat ("Sharada" on the
drawing)"), an audit entry (`seating.claim`, with `auto: true` and no actor), their directory Seat
field follows, and they are told once, the way a move plan tells people: a line from Nib (or the
system bot) with a link that walks them there, and the notice on the Floor sheet ("From today your
seat is W-A31 · Left benches", **Walk there**, **Got it**).

**Anything else waits to be matched.** Administrators and office managers see, at the top of
**Arrange ▸ People**, **Waiting to be matched**: each named seat that someone without a seat might
be, with the suggestion (or a choice of people). Suggestions are people whose first name is the
drawing's, starts it or is one letter away ("Anand" for "Anandh"). **Confirm** gives them the seat
in one click (`seating.claim`), audited with who confirmed, and the person is told. The **Arrange**
button shows how many wait. A named seat whose person has left, or a name nobody will claim, is
changed like any other seat: **Free it**, a reservation or a move plan.

Booking a hot desk: click it on the plan; the seat's callout shows who has it today, a **Book for**
day (today, then each working day up to two weeks ahead: the office's working week, its days off and
compensatory working days ([`HOLIDAYS.md`](HOLIDAYS.md)), the same calendar scheduled bot jobs use) and the days it is already booked, with who. **Book for
today** (or **Book for Tue 17 Nov**) books the chosen day; **Cancel my booking** frees it. A person
has one hot desk a day: booking another for the same day moves the booking. The hub refuses a day
that is not a working day, and a day further than two weeks out (`seating.book`; the days it
offers are `bookDays` in `seating.get`). Their directory **Seat** field follows the plan (`W-A14 · Left benches`) and becomes
read-only; the free text stays for offices with no plan.

## Office managers

Administrators name the office managers in Control room ▸ **Organisation** ▸ **Office managers**:
type a name to add someone (members only: administrators can change seats already), and the × on
a person's chip takes them off. Each change is in the audit log ("changed the office managers",
with who was added and who was taken off). The hub op is `admin.seating.managers`.

## Changing seats: move plans

Seats change only through a move plan: lines of "this seat, held by this". Administrators and the
office managers they name put one together on the plan:

- drag a person from the list, or from their seat, onto a seat; drop on someone to swap;
- tick several people (or a department) and drag them to a seat: they fill that zone's free seats
  in order from there;
- **Move a team**: a department into a zone, with a preview of who goes where;
- **Import**: paste or open a CSV of `seat_id, name` lines; names are matched against the
  directory (a full name or Windows user name is certain; a first name or an initial is suggested
  and must be ticked); or take seats from people's old free-text Seat field where it names a seat
  plainly (`W-A14`, `MD's cabin 01`, `Reception`).

Pending moves show on the plan as dashed arrows (amber while a draft, teal once published). **Apply**
publishes the plan for a day ("from Monday"): everyone it moves is told once (from Nib, or the
system bot), with a `dexconnect://floor/<seat>` link that opens the plan and walks them there.
On the day the moves take effect and become a revision. A published plan can be taken back to
draft before its day; the latest applied plan can be undone (when its seats have not changed since).

## Revisions

Each change that takes effect is a revision, like a drawing's: Rev A is the drawing as built in,
then B, C… with the date, who made it and its change list, and a snapshot of who held what. Any two
can be compared: the later one is drawn with revision clouds and its triangle round every seat that
changed. The current plan prints for the notice wall as an A3 PDF or PNG with a title block.

## Editing the layout

Arrange ▸ Layout: move (drag, or arrow keys by the 3″ grid, Shift for a foot), turn (R), duplicate
(Ctrl+D) and remove (Delete) seats; select a whole bench; add a bench of N or a pod of 6 (placed
clear of other seats and walls near the middle of the view); rename rooms; exact X, Y and facing in
fields; undo and redo. Problems (overlaps, duplicate IDs) are listed and marked; a layout with
problems cannot be saved, and a held seat cannot be removed. A new drawing (PDF page or image) can
be laid underneath, faint, to trace when the office changes.

## What was assumed from the drawing

- The overall floor is 75′6″ × 111′0″ (the drawing's chains: 28′0″ + 4′6″ + 7′1½″ + 9′0″ +
  17′6½″ + 8′0″ across; 15′2½″ + 60′3½″ + 17′4″ + 17′4″ down).
- The large unlabelled room at the north-west is "Room A (unlabelled)", drawn with its stepped
  outlines; rename it in the layout editor.
- Both MD's cabins are labelled "MD'S CABIN 02" on the drawing; the north one is MD-01.
- The drawing has no north arrow; plan north is the top of the sheet (`north` in the plan can be
  changed).
- The half-cabins have one seat each (the person at the desk); the two chairs across the desk are
  for visitors and are drawn as furniture.
- Client cabins 01–04 have no door drawn; the walk ends outside them.

## Performance

The e2e walk fills the plan to about 150 held seats and measures frames while panning and zooming
(`seating-perf.json` in its output): drawing a frame takes about 2–3 ms (median), under 5 ms at
the 95th percentile.
