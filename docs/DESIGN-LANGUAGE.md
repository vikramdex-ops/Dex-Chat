# Dexterity Connect: design language ("Drafting Table")

Dexterity is an engineering office. Our people spend their day reading drawings: title blocks, grid
references, dimension lines, revision clouds. The app borrows that visual grammar and nothing from
other messengers. Every decision below is checked against one rule:

> **If a screen could be mistaken for Zoho Cliq (or Teams, Slack), it is wrong.**

## 1. Distinctness audit: what Cliq does, and what we do instead

| Area | Typical Cliq pattern | Dexterity Connect |
| --- | --- | --- |
| Primary navigation | Dark vertical icon bar on the far left | **Lens bar** centred in the title bar: *Pulse · Direct · Spaces · Rooms · Directory*. There is no left icon rail. |
| Conversation list | Fixed column of chats next to the icon bar | **Switchboard**: one collapsible panel that mixes people, spaces and projects, filtered by lenses, pinnable and re-orderable by drag. Collapses to a 56 px strip of avatar tiles. |
| Conversation view | One chat at a time | **Panes**: open up to three conversations side by side (Ctrl+click or drag a tab), like sheets laid out on a table. |
| Messages | Avatar + bubble/row, own messages often tinted | **Spine timeline**: a thin vertical rule with time ticks (a dimension line). Messages hang off it in sender runs. Own messages carry an amber notch on the spine rather than a different alignment or bubble colour. |
| Avatars | Circles | **Tiles**: rounded squares (squircle, 30 % radius) with initials in Outfit. |
| Presence | Coloured dot on the avatar | **Beacon ring** around the tile: solid teal = available, teal outline = away, amber pulse = in a Room (call), hatched = do not disturb, none = offline. |
| Composer | Text box fixed to the bottom edge | **Dock**: a floating rounded composer with a lift shadow that grows into a sheet for long text, polls or forms. Slash commands open inline cards, not menus. |
| Threads | Side panel styled like the chat | **Side-track**: a narrower pane with a hairline link drawn from the parent message, so the reply chain is visibly attached to its origin. |
| Home | Chat list | **Pulse**: what changed since you last looked (mentions, approvals, reminders due, files for you, people who came online), grouped by "beat" (time block). |
| Settings and admin | Separate settings pages | **Control sheets**: full-height sheets that slide over from the right, opened from your own tile in the title bar. |
| Labels | Sentence-case UI labels | **Title-block labels**: small caps, wide tracking, for section labels only (`PEOPLE · 24 ONLINE`). Body text stays sentence case. |
| Empty states | Illustrations | **Drafting grid**: a faint blueprint grid with one line of plain text and one action. |
| Accent colour | Blue / green | **Dexterity teal** for structure and actions. **Amber** only for things that are live or need you (mentions, approvals, a call ringing, a lounge in use, an update ready); never for a file type, someone being away or a plain notice. |

## 2. Foundations

**Colour.** Teal `#1c7680` (accent, `--accent`; `#47b0a4` in the dark theme), teal 700 `#1e6066` (hover, and teal text on light surfaces), teal 900 `#132b2e` (dark surfaces), amber `#f7af44` (attention only). Neutrals have a slight teal tint so greys never look generic. Light and dark themes come from the same tokens; Windows Mica shows through the window background.

**Type.**
- Outfit (display): view titles, names, numbers.
- Segoe UI Variable (body): text.
- Cascadia/JetBrains Mono (annotation): device codes, line numbers, tags, versions.
- Numbers in lists use tabular figures.

**Shape.** 8 px radius for controls, 12 px for cards, 30 % squircle for avatars, 22 px pill for the Dock (12 px once it holds several lines). Hairline 1 px strokes, never heavy borders.

**Grid.** A 4 px base unit. Content columns align to an 8 px drafting grid, which is visible only in empty states.

**Motion.**
- 120 ms for state changes and 220 ms for panels.
- Panes slide and settle with a small overshoot (spring, damping 26).
- Nothing animates for decoration once loaded.
- `prefers-reduced-motion` turns all of it into cross-fades.

**Sound.** A set of soft, short "tick" sounds (message, mention, call), recorded for us. Off by default during Rooms.

## 3. Signature components

| Component | Rule |
| --- | --- |
| **Lens bar** | 5 lenses, keyboard Ctrl+1…5. The active lens has a teal underline that slides between items. A badge shows only when something needs you (amber), never a running total of unread. |
| **Switchboard** | Sections: Pinned, Spaces, Direct, Projects. Each row is a tile + name + one line of context. Unread is shown with bold weight and a teal tick on the left edge, not a counter, unless you were mentioned (amber count). |
| **Tile** | 28 / 36 / 56 px. Colour derived from the person's id within a palette tuned to the brand, so a person's tile colour is stable across PCs. |
| **Beacon** | Ring 2 px outside the tile. Never a dot. |
| **Spine** | 1 px rule at x = 52 px. A time tick appears every 10 minutes of activity; day changes become a title-block label across the spine. |
| **Dock** | Floating, 12 px from the edges. Icons on the left inside the Dock: attach, record, insert (poll/form/note/tool). Send is an arrow that turns teal when there is text. Enter sends; Shift+Enter adds a line (Enter while an input method is composing a Hindi or Tamil word is the input method's). It grows line by line with the text, up to about 260 px (two fifths of a short window), then scrolls; with more than one line the pill opens into a 12 px box, its tools and Send staying on the last line. In a narrow Pane or on a phone the text then takes the whole width and the tools sit on a ruled row under it. The shape follows the text, not the width, so it never flips back and forth. Every composer grows the same way (`renderer/autogrow.ts`, `@dex/core/compose`). |
| **Message tools** | The tool column on the spine (side-track, stamp, keep, remind, more) shows for one message at a time: the one under the pointer, kept while the pointer travels to it (300 ms, and as long as it keeps closing in along the corridor from where it left; `chat/toolRail.ts`), so a neighbour it crosses never takes it. The gutter between a message and its column belongs to the message while it shows them. Focus inside a message shows them; on touch a tap shows them and a second tap puts them away (a long press still lifts the message to reference it). |
| **Cards** | Rich embeds (a file, a Sheets range, a Sleuth tag hit, a Datum component) all share one card frame: icon tile, title, mono meta line, primary action. |
| **Control sheet** | Slides from the right, 560 px, with a sticky header. Escape closes. |

### Shared controls (drawn in `drawing.css`)

| Control | Rule |
| --- | --- |
| **Choice of one** | A row of ruled cells; the chosen cell is teal-tinted with a 2 px teal base rule. Never a sliding white thumb in a grey pill. The Control room's sections are a numbered drawing register (01 Approvals … 14 Audit log). |
| **Switch** | A slide lever on a scale: square track, square knob, a tick where the knob will go. Never a round pill toggle. |
| **Tag** | A mono caption in a hairline box (`YOU`, `ADMIN`, `ENCRYPTED`). Never a rounded coloured pill; green is not in the palette. |
| **Settings, dashboards, registers** | One sheet ruled with hairlines and numbered section labels (`01 PROFILE`), not a stack of floating rounded cards. Pulse's summary and the Directory are ruled cells. |
| **Stamps** | One ruled strip under the message; your own stamp has a teal base rule. |
| **Live bars** (a lounge) | A title block in the corner of the sheet: ruled cells, an amber rule down the edge while live, Leave as an amber outline with the door glyph. Never a red hang-up handset. |
| **Icons** | Drawn in `ui.tsx` on the 24 px grid: send is a transmittal (a sheet with a dimension arrow), messages are a spine with entries, voice is a Room on plan, leaving is a door. No paper planes, speech bubbles or handsets. |
| **Empty states** | One symbol in a framed cell on the drafting grid, one line, one action. |

### Nib (the office's companion)

| Piece | Rule |
| --- | --- |
| **Mark** | A drafting pen's nib on a square bot tile in teal 900, drawn in `nib/NibMark.tsx`. When Nib wants something an ink drop forms at the tip: a hollow teal drop for something quiet, a solid amber drop when it needs you. Never a robot, a face or a speech bubble. |
| **Where it sits** | A tile in the title bar beside your own. Its tray drops from that corner (a sheet along the bottom on a phone); its conversation is a title-block row above the Switchboard's lists. Nothing floats over the Dock. |
| **Callout** | A small card under the tile, with an amber rule down its edge, for the start of the day and the wrap-up only. Never a modal, never takes focus, Escape closes it. |
| **Voice** | Nib's own lines start with a short teal leader, like a note on a drawing. Brief, warm, a little dry; no exclamation marks, no emoji. |
| **Words read** | What Nib understood is marked on your words like dimensions: an underline with a mono caption above (`FROM`, `JOB`, `QTY`, `DUE`). |
| **Progress** | A dimension line: extension ticks at both ends, the done part in teal (amber when blocked). |
| **Cards** | A title block (mark, mono caption, title, drawing number such as `NIB-REG-261115`) over a ruled body. The register is a sheet index: people as square cells by department, filled to how far along they are; hatched when missing, dashed when on leave, an amber corner for a blocker. |

### The notice board (Notices lens)

Official notices are a register, not a feed and not a news page. Code: `renderer/notices/`; the
whole design is in [`ANNOUNCEMENTS.md`](ANNOUNCEMENTS.md).

| Piece | Rule |
| --- | --- |
| **Register** | One ruled sheet: number and revision in mono (`HR-POL-0012 · Rev B`), title, desk and kind, dates, a status tag. An amber tick on the left edge for "needs your acknowledgement", a teal one for "not opened yet". Never cards with cover images, never a feed. |
| **In force shelf** | Standing policies as pinned sheet stacks: a teal drawing pin, one sheet behind for each earlier revision. |
| **Title block** | A notice opens with a drawing's title block in ruled cells: ISSUED BY, NUMBER, REV, DATE, EFFECTIVE, EXPIRES, ADDRESSED TO, STATUS. WITHDRAWN and SUPERSEDED are stamps across it. |
| **Revision cloud** | A changed paragraph sits in a scalloped cloud drawn in code, with a revision triangle carrying the letter, as on a revised drawing. |
| **Acknowledgement** | A deliberate act (a statement and check questions in ruled cells), then a rubber stamp in teal ink: READ AND UNDERSTOOD, the name, the date and the number. |
| **Acknowledgement register** | A transmittal's acknowledgement register: a row per department, each person a square cell, teal when done, hatched while waiting. |
| **This week** | On Pulse, seven day cells as a scale with ticks; holidays and events on their day. |
| **Urgent** | One banner under the title bar with an amber rule, for administrators' urgent notices only; dismissed once for every device. Amber is otherwise kept for "needs you". |
| **Motion** | A new notice's row plots in once; the stamp lands once; cells fill as acknowledgements arrive. Reduced motion: all of it appears in place. |

### Bots talking to bots, and the job sheet

| Piece | Rule |
| --- | --- |
| **Relay card** | Bots are instrument tags (the ISA bubble of the Meet page's readiness tags: letters above the bar, `B-01` below, the bot's colour as a small swatch) on a small loop diagram. Asks are data links (a line with small circles), handoffs solid lines with an arrow, listening dash-dot. Each hop is labelled in mono capitals (`SEAT? · CAESAR II → 1 free`) and stamped in a ruled box turned a few degrees (ANSWERED, HANDED, BACK; REFUSED, STOPPED, NO ANSWER in the danger colour). A pulse runs along a fresh hop, out and back, amber while it is on its way; a bot waiting on its answer has an amber ring. The hops are also a ruled schedule under the drawing. Reduced motion: no pulse, no ring. |
| **Stage strip** | A stage that waits on another bot carries the bot's mark and its request (`PLT-0004 · Plotting`), with the live dot while it is open there. |
| **Network sheet** | A drawing sheet: a heavy frame in a hairline one, grid references, a title block (`BOT NETWORK · BN-261115`). Bots as tags on plates (YOURS, OFFICE, SPACE, PRIVATE, SYSTEM), connections as routed pipes with rounded bends, as heavy as the week's traffic, counts in mono, failures in an amber flag. A pulse runs along a line as a message passes. The lines are also a ruled list, and picking one opens its exchanges beside the drawing (below it on a phone). |
| **Job sheet** | A programme on a time ruler in office time (Today, This week, This month as ruled cells): days off hatched, NOW an amber line with a tag, one lane per job with its title block on the left. Upcoming runs are diamonds (the next one filled, with its countdown), past runs stamps (RAN, SKIPPED dashed, FAILED in danger, DRY dashed); a run moved once is joined to its old place by a dashed arc. |
| **Schedule in plain words** | What was read is marked on the words like dimensions (an underline with `EVERY`, `DAY`, `TIME`, `DATE`, `WINDOW` above); what was understood is a teal-ruled line; the next five runs are a ruled list. |

### The office drawing (Directory ▸ Org chart)

The org chart is not a tree of cards. It is the office drawn as an engineering drawing, a sheet
people open to find who does what, who to ask and how they connect. Code: `renderer/orgscape/`.

| Piece | Rule |
| --- | --- |
| **Sheet** | One drafting sheet on a canvas, panned and zoomed like a CAD viewer (drag, fling, wheel, pinch, double-click, `+` `-` `0`). A heavy frame inside a hairline one, a faint drafting grid, grid references (A, B… / 1, 2…) in rulers along the top and left. Never a scrolling page of cards. |
| **Sheets** | *Lines* (general arrangement of reporting lines) and *Floor* (the office's real floor plan, or one generated from seats when a hub has none). Chosen with ruled cells, not tabs. |
| **Plates** | A person is a hairline plate: tile with its beacon, name, designation, and a ruled strip below (`EXT 214 · B2·D4 · C4`). In the office now: solid plate with a teal tick down its edge (amber in a Room). Not signed in: a paper-coloured plate. The size of their team sits in a small box. Never a rounded card, never a circle. |
| **Lines** | Reporting lines run as routed pipes: a riser drops from under the manager's tile and a header runs along each row of their team, with rounded bends (elbows) and a drop to each plate. Lines never cross a plate. Picking someone lights their line to the top and their team's drops in teal. |
| **Areas** | A department is an area: a chain-line (dash-dot) boundary with `AREA 03` in a tag and the name, headcount and how many are in. |
| **Level of detail** | Zoomed out: areas and blocks (drawn in batched paths). Middle: tile and name. Close: the whole plate. |
| **Marks** | New this month: a revision cloud round the plate and a revision triangle with `NEW`. Birthday: a pennant. Work anniversary: `5 yrs` in a box. Not joined yet at the date being looked at: a dashed plate ("proposed"). |
| **Floor plan** | The office's own drawing at real scale (docs/SEATING.md): partitions as solid walls, glazing as two hairlines, the structural wall and columns hatched (poché), doors with their swing, fixed furniture as simple symbols, room names with their sizes in mono captions, the drawing's dimension strings (ticks, extension lines) and a north point. Every seat is a desk with its chair and its ID; a free seat is an open, dashed chair marked FREE; a reserved one has a hatched desk and its role; a hot desk says so; a name from the office drawing whose person has not joined is a plain outlined tile with initials and the name under it, like someone away. Someone working from home, a site or a client leaves their desk dashed and stands in the off-site key beside the plan. A hub with no plan draws bays along a corridor from free-text seats instead. |
| **Seating** | Moves still to come are dashed arrows from the old seat to the new one with a ghost of who is coming: amber while a draft (it needs someone), teal once published. Comparing two revisions draws revision clouds and the triangle (`C`) round each changed seat. Departments are a soft colour wash under their seats (a toggle, with a key), never amber. Arrange is a ruled panel down the right (a sheet on a phone): People, Move plan, Move a team, Import, Layout. The notice wall export is an A3 sheet with a heavy border and a title block. |
| **Overlays** | A Space is drawn as an instrument loop: a hexagon tag with dashed signal lines to its members. A route ("How we connect") is a heavy teal line flowing along the reporting lines with numbered steps; on the floor plan it is a dotted walk that goes round desks and through doors. Search spotlights a person for a moment and flies there. |
| **Viewer furniture** | Title block in the corner (drawing, people, live scale `1:2.4`, grid under the pointer, drawing number), key plan with the view on it, zoom cells, and a callout (a small title block) that follows the person picked, with Write, Room, How we connect, Spaces, Card, and the way across to the other sheet for the same person: **Find on the floor** on the reporting lines (the floor plan opens with the camera at their seat, spotlit; "No seat on the plan" or "Working from home today" instead when there is nothing to find), **See in the reporting lines** on the floor. On a phone the callout is a sheet along the bottom edge. |
| **Liveness** | When someone comes in or joins a Room a pulse runs down their line to their plate. The sheet plots itself in (lines drawn like a pen plotter) the first time it opens in a session. "You are here" points at your own plate. |
| **Access** | The canvas is one focus stop (`role="application"`): arrows walk along the lines (up to the manager, down to the team, left and right to peers) or between desks, Enter opens, Escape steps back; each move is announced. The schedule beside it lists everyone as a tree (`role="tree"`) or by room; it shows itself when asked for or as soon as focus enters it. Reduced motion: no plot-in, flights jump, the route does not flow. |
| **Ways in** | A Pulse card (new this month, birthdays and anniversaries, someone to meet in another department), "See in the org chart" on every profile; each flies to the person. |

## 4. Voice

- Plain English with real office words: drawings, revisions, line numbers, site. No marketing tone.
- Verbs on buttons ("Approve", "Send to Hopper"), never "OK" or "Submit".
- Status lines say what will happen next ("It installs when you restart").

## 5. Terminology

| Concept | Our word |
| --- | --- |
| Channel | **Space** |
| 1:1 or group chat | **Direct** |
| Thread | **Side-track** |
| Call / meeting | **Room** |
| Activity / home | **Pulse** |
| Contacts | **Directory** |
| Saved items, reminders, notes | **Desk** |
| Admin console | **Control room** |

## 6. Checklist for every new screen

1. Does it use the Lens bar / Switchboard / Pane / Dock structure instead of a rail plus list plus chat?
2. Tiles and beacon rings, not circles and dots?
3. Amber only where the person must act?
4. Is there any component, icon or phrase that someone could recognise from Cliq? If so, redesign it.
5. Keyboard path for every action, reduced-motion fallback, contrast AA in both themes.
