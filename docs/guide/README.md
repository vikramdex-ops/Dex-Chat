# Dexterity Connect user guide

The official user manual, `DDSP-IT-DXC-UG-001`, printed to
[`docs/Dexterity-Connect-User-Guide.pdf`](../Dexterity-Connect-User-Guide.pdf). It has the same print
look as the office's other guides (Project Opener, Sleuth), in this app's teal.

| File | What it is |
| --- | --- |
| `guide.html` | The text. One `<section class="sec">` per numbered section; sub-sections are `<h3>5.2 …</h3>` |
| `guide.css` | The print stylesheet: A4, the Onest font, the cover, the contents, tables, steps, notes, the running header and footer |
| `figures/fig-*.png` | Screenshots of the real app, made by `apps/desktop/e2e/guide-shots.mts` |
| `Onest-*.ttf` | The Onest font (SIL Open Font License 1.1), used only for the printed guide |
| `dexterity-logo.png` | The Dexterity logo on the cover |

The cover uses the app icon straight from `apps/desktop/build/icon.png`.

## Rebuilding the PDF

```bash
npm ci
npm run guide
```

`scripts/build-guide.mjs` prints `guide.html` with Chromium through `playwright-core` (A4, backgrounds
on, PDF outline from the headings). It prints twice: the first pass reads each page's text with
PDF.js to find the page every numbered heading starts on, the second writes those numbers into the
Contents (a third pass runs if that moved a heading). It prints the page count and size, and fails if
a Contents entry has no page.

Chromium for `playwright-core`:

- if it is not installed yet: `npx playwright-core install chromium`;
- if the browsers are kept elsewhere: `PLAYWRIGHT_BROWSERS_PATH=/path/to/browsers npm run guide`;
- or use the Chrome or Edge on the PC: `GUIDE_CHANNEL=chrome npm run guide` (or `msedge`).

`node scripts/build-guide.mjs --out some.pdf` writes the PDF somewhere else.

The running header (title, document number and revision; the company) and footer (classification;
"Page X of N") are CSS `@page` margin boxes in `guide.css`, not Playwright's `headerTemplate`: the
templates would also print on the cover, and the margin boxes can be left off it.

The PDF's time stamp is set to the guide's date (`"date"` in the `meta` block at the top of
`guide.html`), so the same source and figures give the same PDF, byte for byte.

## Rebuilding the figures

The figures come from the built app, driven by `apps/desktop/e2e/guide-shots.mts`. It starts a fresh
hub, seeds a demonstration office (40 colleagues in departments, the P-12 Piping and P-14 Structural
steel Spaces with a working day of messages, a GA drawing as PDF, a poll, a Decision, a lounge,
reminders, meetings), then walks every screen the guide shows as Priya Raman, as Vikram Shah (the
owner, for the Control room) and as a new joiner, and writes `figures/fig-*.png` at 1440 × 900 in the
light theme (phones at 390 px, and a few dark ones).

```bash
npm run desktop:build
POL1_ISOLATED=1 TZ=Asia/Kolkata xvfb-run -a -s "-screen 0 2000x1000x24 -noreset" \
  node apps/desktop/e2e/guide-shots.mts
```

- `POL1_ISOLATED=1` puts the hub on a free port, so the run does not clash with other hubs on 47900.
- `TZ=Asia/Kolkata` gives the office's own clock in the screenshots.
- `GUIDE_ONLY=messages,calendar` walks only some parts (the office is always seeded first);
  `GUIDE_OUT=/tmp/figs` writes the pictures somewhere else to compare first.
- Each part catches its own failure, saves `guide-FAIL-<part>-<who>.png` in `apps/desktop/e2e/out/`,
  and carries on; the run ends with the list of parts that failed and exits with 1.
- The run takes about 15 minutes. Every run starts from an empty hub, so it can be repeated at any time.
- ffmpeg makes the placeholder camera pictures for the meeting screenshot.

Look at every new figure before rebuilding the PDF: no error, spinner, empty placeholder, overlap or
cut-off dialog. The people, messages and files are invented; never use real accounts or data.

## Changing the guide

- Bold is for the exact names of buttons and settings as the app shows them. Check a name in the code
  (`apps/desktop/src/renderer/`) or in `apps/desktop/src/renderer/i18n/strings.json` before using it.
- A new numbered section needs a line in the Contents with `<span class="toc-page" data-sec="N"></span>`;
  the build fills in the page.
- Figures are captioned `Fig. <section>-<n>`; renumber the section's figures and their mentions in the text.
- A new revision: change the Revision and Date on the cover, in the `meta` block and in the revision
  history (section 19.2), and the revision in the running header in `guide.css`.
