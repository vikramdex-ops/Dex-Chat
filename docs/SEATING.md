# Seating: the office's real floor plan

Directory ▸ Org chart ▸ **Floor** is the office's own drawing: the A3 seating layout dated
18-Jul-2026, transcribed into data at real scale (feet), with people on the seats they hold. It
replaces the generic plan the Floor sheet used to invent from free-text seats ("Bay 2, Desk 4");
that generated plan is still the fallback when a hub has no plan.

Code: `apps/hub/src/seating.ts` (the hub), `packages/core/src/seating.ts` (rules both share),
`apps/hub/seed/floor-l01.json` (the transcribed drawing), `apps/desktop/src/renderer/orgscape/`
(`plan.ts`, `drawplan.ts`, `seating/`). Tests: `apps/hub/test/seating.test.ts`,
`packages/core/test/seating.test.ts`, `apps/desktop/e2e/seating.mts`.

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

A seat is held by nobody, a person, a reservation for a role or team ("Piping · hot desk"), or is a
hot desk that anyone can book for a day (today or up to two weeks ahead). A person holds at most one
seat.

Booking a hot desk: click it on the plan; the seat's callout shows who has it today, a **Book for**
day (today, then each working day up to two weeks ahead: the office's working week and holidays,
the same calendar scheduled bot jobs use) and the days it is already booked, with who. **Book for
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
