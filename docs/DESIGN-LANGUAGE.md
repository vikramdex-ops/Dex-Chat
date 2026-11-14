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
| Accent colour | Blue / green | **Dexterity teal** for structure and actions. **Amber** only for things that need you (mentions, approvals, a call ringing, an update ready). |

## 2. Foundations

**Colour.** Teal 500 `#2a8c98` (accent), teal 700 `#1e6066` (pressed), teal 900 `#132b2e` (dark surfaces), amber `#f7af44` (attention only). Neutrals have a slight teal tint so greys never look generic. Light and dark themes come from the same tokens; Windows Mica shows through the window background.

**Type.**
- Outfit (display): view titles, names, numbers.
- Segoe UI Variable (body): text.
- Cascadia/JetBrains Mono (annotation): device codes, line numbers, tags, versions.
- Numbers in lists use tabular figures.

**Shape.** 8 px radius for controls, 12 px for cards, 30 % squircle for avatars, 22 px pill for the Dock. Hairline 1 px strokes, never heavy borders.

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
| **Dock** | Floating, 12 px from the edges. Icons on the left inside the Dock: attach, record, insert (poll/form/note/tool). Send is an arrow that turns teal when there is text. Enter sends; Shift+Enter adds a line. |
| **Cards** | Rich embeds (a file, a Sheets range, a Sleuth tag hit, a Datum component) all share one card frame: icon tile, title, mono meta line, primary action. |
| **Control sheet** | Slides from the right, 560 px, with a sticky header. Escape closes. |

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
