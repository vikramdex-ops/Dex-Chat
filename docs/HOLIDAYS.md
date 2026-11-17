# Office holidays from the circular

Every year management issues a **holiday circular**: a PDF on the office letterhead with a
reference and date (`Ref: HRD/CIR/2026/011   26-Mar-2026`), the period it covers ("for the period
of January-2026 to December-2026"), then a table, `Sl. No. | Date | Day | Description`, over a few
pages, and notes at the end. Nobody types these days in. An administrator gives the PDF to Nib, Nib
reads it, checks it and shows what it found, and one click registers it in the office's calendar.

The 2026 circular is built into the hub: a new hub registers it on its first start.

Code: `packages/core/src/holidays.ts` (the reader, the checks, the plan; pure and unit-tested),
`apps/hub/src/holidays.ts` (the office's days, circulars read and registered, the built-in one),
`apps/hub/src/nib.ts` (the PDF dropped in Nib's conversation, the cards, the ops),
`apps/desktop/src/renderer/nib/holidays.tsx` (the card), `apps/desktop/src/renderer/bots/OfficeHolidays.tsx`
(Control room), `apps/desktop/src/renderer/ocr.ts` (`readScanText`, for scans).

## 1. What a day is

Each registered day has a **kind**, because the circular holds more than holidays:

| Kind | In the circular | What it means |
| --- | --- | --- |
| `holiday` | a named day: *Pongal*, *Diwali*, *Christmas* | Nobody works. Kept even when it falls on a Sunday. |
| `weekoff` | *Week-Off* | One of the office's alternating Saturdays off. Nobody works. |
| `compoff` | *Compensatory Off* | A day off given back for a Saturday worked. Nobody works. |
| `compwork` | *Compensatory work for 14-Jan-2026* | A **working** day: a Saturday worked to make up for a day off. Never a holiday. It is linked to the day off it makes up for. |

Every day that is not `compwork` is a **day off**: Nib does not ask for day sheets or send the
register, scheduled bot jobs do not run ("every working day", "first working day of the month" move
past it), hot desks cannot be booked for it, and overdue action points are not reminded on it.

A `compwork` day is a **working day even on a weekday the office does not normally work**. With
Nib's workdays at Monday to Saturday (the default) a compensatory Saturday is a working day anyway;
with Monday to Friday it becomes one for that date only. This is the calendar's one notion of an
extra working day (`OfficeCalendar.extraWorkdays` in `@dex/core/botjobs`, and `isWorkingDay`).

Each day also keeps **where it came from**: the circular's reference and date, the PDF's file name,
its SHA-256 and the row's serial number. A day typed in by an administrator has no source and reads
"Added by hand". If an administrator changes a day that came from a circular (its name or kind), it
becomes theirs.

Days of different years live side by side: registering 2027 never touches 2026.

## 2. Giving Nib the circular

- **In the conversation with Nib**: drop the PDF (or attach it with the paperclip) and send. Any
  PDF sent to Nib is read as a circular.
- **Control room → Bots & tools → Office holidays → Read a holiday circular…**: pick the PDF. The
  same card opens there, and also arrives in your conversation with Nib, so there is a record.

Only owners and administrators can register. Anyone else who sends Nib a circular is told that an
administrator registers office holidays (nothing is read).

## 3. What Nib shows

The card (`nib.card { kind: 'holidays' }`), drawn as a title block like Nib's other cards:

- `HOLIDAY CIRCULAR · 2026 · HRD/CIR/2026/011`, then the source line: the reference, its date, the
  file name and the first eight characters of its SHA-256;
- the period, and the days counted by kind, with **In doubt** (amber when it is not zero);
- for a revised circular, what changes: *N new, N changed, N removed, N the same*;
- notes about the document as a whole (a serial number skipped or used twice, no period line);
- the rows: the rows in doubt first (amber, each with why), then the others, six at a time
  (**Show all 46 rows**): Sl, the date and weekday as written, the description, the kind, and
  *New*, *Same*, *Changed* or *Not registered*. A compensatory working day says which day it makes
  up for;
- days a previous circular registered that this one no longer has, struck through;
- **Register 46 days** (administrators), or *Already registered on 17 Nov 2026 from Ref
  HRD/CIR/2026/011. Nothing changes.*, or *Registered on … by …*.

After registering, Nib posts a summary card (`holidaysDone`): the days by kind, the rows in doubt
left out, and **Open Office holidays**.

## 4. Reading and checking

`readCircular(lines)` reads the text line by line, whichever way it was extracted: the hub's own
PDF reader (cells three spaces apart), `pdftotext`, one cell per line, or OCR (single spaces). It
finds the reference and its date, the period, and the table's rows after the first `Sl. No.`
header; repeated headers and the letterhead on later pages, and the notes at the end, are left out.
Dates are read as the circulars write them: `01-Jan-2026`, `06-June-2026`, `05-Sept-2026`,
`6-Nov-2026`, `24-Apr-26`, `06-Nov` (the circular's year), `1 May 2026`, `01/01/2027`, with the
text layer's stray spaces (`01-May -2026`) and OCR's `O` for `0`.

Each row is checked, and a row with any of these problems is **in doubt**: listed, never registered.

| Check | In doubt when |
| --- | --- |
| The date | it cannot be read (`31-Feb-2026`) |
| The weekday | the day written is not the date's weekday |
| The year | the date is outside the circular's period (or, with no period, the year most rows are in) |
| Duplicate dates | two different days share a date (both in doubt); the same day written twice (the second) |
| Compensatory work | the day it makes up for is not a day off in the same circular, or cannot be read |
| The description | there is none |

Serial numbers that skip or repeat are shown as notes on the whole document (a row may be
missing); the rows themselves are still read.

Against what is registered (`planCircular`), each good row is **new**, the **same**, or **changed**
(name, kind or the day it makes up for). Days of the same year that came from a circular and are not
in this one at all are **removed**. Days typed in by hand, days of other years, and dates the new
circular has in doubt are never removed.

## 5. Registering

`nib.holidays.register { id }` (owners and administrators):

- applies the plan to the office's list (`office_holidays` in `meta`), with the source on every row;
- remembers the circular (`office_circulars`: reference, date, year, file, SHA-256, when, by whom,
  the counts), shown under **Circulars registered**;
- writes `holidays.circular` to the audit log with the reference, its date, the file, the SHA-256,
  the year, what was added, changed and removed, and the rows left out;
- posts Nib's summary.

**The same file twice** (same SHA-256, whatever its name) is *already registered*: the card has no
button and `register` refuses. Registering a card twice is still once. **A revised circular** for
the same year (a new file) shows its differences and applies them when registered.

## 6. Scans

A circular with no text layer (a scan) gives the hub nothing to read: the card says so. On a PC,
**Read the scan on this PC** draws each page with PDF.js at about 200 dpi and reads it with the
same OCR engine that reads text in pictures (`readScanText` in `ocr.ts`, tesseract.js, shipped
with the app; up to six pages). The text goes to the hub (`nib.holidays.read { id, text }`), which
reads and checks it like any circular; the card then says it was read from a scan and asks for each
row to be checked against the paper. On a phone (no OCR engine) the card asks for the circular as a
PDF with text, or for the conversation to be opened on a PC.

## 7. The built-in 2026 circular

`apps/hub/seed/holidays-2026.json` is the 2026 circular read by the same reader:

```bash
node apps/hub/scripts/holiday-seed.ts holidays-2026.pdf apps/hub/seed/holidays-2026.json
```

It holds the PDF's file name, SHA-256, reference and page count, and every row as read. The script
refuses a circular with anything in doubt, because the seed is registered without anyone checking it.

On its first start a hub registers it **once**: only dates not in the list yet are added (an
administrator's own days are never overwritten), the circular is listed as *Built into the hub*, and
a flag in `meta` (`holidays_seeded_<hash>`) means it is never applied again, even after an
administrator removes or changes days. A hub that already registered the same file skips it.
Tests and the end-to-end walks start hubs with `holidaySeed: false`, so they do not depend on the
date they run.

## 8. Operations

| Operation | Who | What |
| --- | --- | --- |
| `nib.holidays.read { fileId }` | members (only administrators get a reading) | read a PDF already uploaded; the card also goes to the conversation with Nib |
| `nib.holidays.read { id, text }` | the person who sent the scan | the text the desktop read from it |
| `nib.holidays.register { id }` | owners, administrators | register a reading |
| `nib.card { kind: 'holidays' \| 'holidaysDone', ref }` | the sender, administrators | the card |
| `botjob.calendar` | members | days off (`holidays`), `extraWorkdays`, every day with its kind and source (`days`), `circulars` |
| `admin.botjob.holidays { holidays }` | owners, administrators | replace the list (Office holidays' edits; unchanged days keep their source) |

## 9. Tests

- `packages/core/test/holidays.test.ts`: the real 2026 circular's text (`fixtures/holiday-circular-2026.txt`,
  from the hub's PDF reader), the same text as OCR and one cell per line, dates as written, a 2027
  circular, rows in doubt (a duplicate, a wrong weekday, a date out of the period, an unreadable
  date, a compensatory day for nothing, no description), no period line, a scan and a PDF that is not
  a circular, and the plan (new, same, changed, removed, the same file twice).
- `apps/hub/test/holidays.test.ts`: dropping the PDF into Nib's conversation, the card, a member
  refused, registering with the source and the audit, the same PDF again, an administrator's edit, a
  revised circular, 2027 beside 2026; rows in doubt left out; a scan read from the desktop's text;
  a file that is not a PDF; Office holidays' **Read a holiday circular…**; Nib's register, scheduled
  jobs and hot-desk booking skipping a Saturday off and working on a compensatory working day; the
  built-in circular registered once and not put back after edits.
- `apps/desktop/e2e/holidaypdf.mts`: the walk in the app, with screenshots at 1440 and 390 px, light,
  dark and Hindi. `HOLIDAY_PDF=/path/to/holidays-2026.pdf` uses the real PDF; without it, one is
  drawn from the fixture text.
