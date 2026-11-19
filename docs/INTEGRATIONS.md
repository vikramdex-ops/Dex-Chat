# Integrating office tools with Dexterity Connect

Several ways for a tool to work with Dexterity Connect, from the simplest to the most capable. None
needs the internet: everything runs on the office network.

> **Zoho Calendar** is a built-in sync rather than a bot: an administrator registers the office's Zoho client
> once in Control room → Integrations, and each person connects their own calendar. See
> [`ZOHO-CALENDAR.md`](ZOHO-CALENDAR.md).

## 1. Share a file or a note (no setup)

Open this link with the system's default handler (`ShellExecute`, `QDesktopServices::openUrl`,
`open::that`, `start ""` in a batch file). Dexterity Connect shows **Share to Dexterity Connect**
with everything filled in; the person picks or confirms who it is for and presses **Share**.
Nothing is sent without that confirmation, and it is sent as that person (so Direct messages are
end-to-end encrypted as usual).

```
dexconnect://share?text=<message>&file=<absolute path>&to=<who>&from=<tool name>&title=<label>&link=<url>
```

| Parameter | Meaning |
| --- | --- |
| `text` | Message text (Markdown: `**bold**`, lists, `code`). Up to 8,000 characters. |
| `file` | A file on this PC to attach. Repeat for up to 20 files. |
| `to` | Optional. Someone's Windows sign-in (`DEXTERITY\priya.raman` or just `priya.raman`) for a Direct message, or `space:<Space name>`. |
| `from` | Optional. Your tool's name, shown in the dialog. |
| `title`, `link` | Optional. A labelled link added on a new line, for example a job folder, a web page or a workbook cell. Web and office-tool links (`https`, `dexterity`, `projectopener`, `sleuth`, `datum`, `dexconnect`) are written as `[title](link)`; others as `title: link`. |

Encode each value with URL encoding (spaces as `%20`, backslashes as `%5C`).

## 2. Post notices (Bot API)

For things that happen without a person at the keyboard (a transmittal is ready, a check finished),
an administrator creates an **integration token** in **Control room → Integrations** and the tool
posts:

```
POST https://<hub>:47900/api/bot/message
Authorization: Bearer <token>
Content-Type: application/json

{ "text": "Rev B of ISO-1001 is ready", "to": ["priya.raman"], "space": "Piping P-12513",
  "card": { "title": "Transmittal T-0412", "lines": ["3 drawings"], "url": "https://…" } }
```

Trust the hub by its certificate fingerprint (shown on the same page) rather than a certificate
authority. Hopper's notices use this.

### Incoming webhooks (Slack-style)

Tools and services that already know how to post to a Slack "incoming webhook" can post to
Dexterity Connect without changes. In **Control room → Integrations → Webhooks**, choose a Space
and **Create webhook**. You get an address like `https://<hub>:47900/api/hooks/<secret>`; anyone
who has it can post into that Space, so treat it as a password and **Revoke** it if it leaks.

```
POST https://<hub>:47900/api/hooks/<secret>
Content-Type: application/json

{ "text": "*Build 7* passed <https://ci/7|details>" }
```

- Slack's `text`, `blocks` (header, section, fields, context, divider) and `attachments` (title,
  text, fields) are understood. Slack's `*bold*`, `_italic_`, `~strike~` and `<url|label>` links
  become Dexterity Connect formatting.
- A form post with a `payload` field also works.
- Up to 60 posts a minute per webhook and 256 KB per post. Answers: `200 ok`, `400`, `404`
  (unknown or revoked), `413`, `429`.
- Webhooks reach the hub on the office network only. They are not exposed through the internet
  gateway.

## 3. Slash commands (the tool answers)

An administrator gives an integration commands and a webhook address on the office network in
**Control room → Integrations → Commands**. When someone types `/open P-12513`, the hub sends:

```
POST <webhook>
X-Dex-Timestamp: 1763120000
X-Dex-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<body>" with the signing secret>

{ "command": "/open", "text": "P-12513", "user": { "id": "…", "name": "Priya Raman", "account": "dex\\priya.raman" },
  "conversation": { "id": "…", "kind": "space", "name": "Piping P-12513" }, "at": "2026-11-14T10:00:00Z" }
```

Reply within 8 seconds with `{ "text": "…" }` to post into the conversation as the integration, or
`{ "text": "…", "ephemeral": true }` to show it only to the person who typed the command.

The app's own commands (`/remind`, `/poll`, `/action`, `/call`, `/startday`, Nib's `/got`, `/done`, `/wrap`,
`/sheet`, `/leave`, `/nib` and the rest: `APP_COMMANDS` in `packages/core/src/bots.ts`) are never
sent to the hub, so no integration or flow can take one. The slash list shows each name once: the
app's own first, then integrations' and flows' commands; a command saved before its name became the
app's is left out.

### Message actions

Give an integration **message actions** next to its commands (Control room → Integrations →
Commands and message actions), one per line, e.g. `Raise an RFI (spaces)`. They appear in every
message's menu (or only in Spaces / Direct). Choosing one sends the message to the same signed
webhook:

```
{ "action": { "id": "…", "label": "Raise an RFI" }, "at": "2026-11-14T10:00:00Z",
  "user": { "id": "…", "name": "Priya Raman", "account": "dex\\priya.raman" },
  "message": { "id": "…", "text": "Nozzle N3 clashes with the platform", "createdAt": "…",
               "author": { "id": "…", "name": "Vikram Shah", "account": "dex\\vikram" },
               "files": [{ "name": "clash.png", "size": 48211, "type": "image/png" }] },
  "conversation": { "id": "…", "kind": "space", "name": "P-12 Piping" } }
```

Reply `{ "text": "RFI-0042 raised" }` to post in the message's side-track, or add `"ephemeral": true`
to show it only to the person who chose the action. For an encrypted Direct message the text is
sent by the person's own app, because the hub cannot read it.

### Pulse cards

An integration keeps up to 5 cards on everyone's Pulse up to date with its token:

```
POST https://<hub>:47900/api/bot/widget
Authorization: Bearer <token>

{ "key": "plotter", "title": "Plotter queue", "lines": ["3 sheets waiting", "A0 roll low"], "url": "https://…" }
```

Send the same `key` again to update it, or `{ "key": "plotter", "remove": true }` to take it down.
Up to 8 lines of 200 characters. Revoking the integration removes its cards. (The address keeps its older name, `/api/bot/widget`.)

### Automations

Rules in a conversation (or for every Space) can call your tool's webhook when something happens
there, for example when a drawing is shared, with the PDF's title and revision in the body. The
request format, the values a body can use and the safety rules (office-network addresses only when
an administrator allows them) are in [`AUTOMATIONS.md`](AUTOMATIONS.md#webhooks).

## 4. Conversations that take several steps (flows)

A flow asks one thing at a time in the person's Direct conversation with an integration: a plot
request, a leave request, a site-visit booking. Each step is a card with its input inline; **Back**
and **Cancel** are always there. The hub keeps where each person is: the current step, the answers
so far, when it started, when it was last answered and when it expires (7 days after the last
answer unless the flow says otherwise). When the person comes back later, on any of their
devices or after restarting the app, the integration shows **Pick up where you left off: step 3
of 5** with **Resume**, **Start over** and **Cancel**.

People start a flow by its slash command (`/plot`), by writing to the integration (a keyword or
the flow's title; anything else gets a card listing what it can do), or with a **Start** button
on a card the integration or a colleague posted.

(Flows are conversations with a person. [Automations](AUTOMATIONS.md) are something else: rules
that react to what happens in a conversation, such as a drawing being shared.)

### Bots members make (the bot maker)

Flows are not only for integrations. Any member (not guests) makes a bot of their own from
**Desk → Bots → Make a bot**; administrators write integrations' flows in the same maker from
**Control room → Bots & tools → Write a flow** (or **Change** on a flow).

- **Start from something:** a template (Plot request, Leave note, Site visit, Technical query,
  Software seat, Late work request, Drawing check and issue; see [BOT-TEMPLATES.md](BOT-TEMPLATES.md)),
  put into the maker's language when it is used, a few words ("Ask which site, which day, how many people and who hosts us, then
  put a task on their Desk") drafted on the PC by the same small sentence model Automations uses
  (it falls back to keyword cues when the model cannot load; nothing leaves the PC), a copy of a
  bot you can already use, or a blank bot.
- **The maker** is one sheet: the bot's title block (mark, name, revision, who can use it,
  status), the editor in six numbered parts (01 Identity, 02 Questions, 03 At the end, 04
  Afterwards, 05 Sharing, 06 Advanced: the definition as JSON, kept in step both ways), and on the right a
  **test run** that plays the bot in a real pane with the real cards, as a colleague sees it.
  The test run follows the draft as it changes; nothing is sent. Problems are written in plain
  words beside the question or end action that causes them.
- **Identity:** a name, one of our drawn symbols or a two-letter monogram, a colour from the
  palette, an "about" line, a greeting (`{{user.first}}` addresses people by name), a **voice**
  (plain, warm, brief or formal) that words everything the bot says itself (its greeting, its
  refusals, the Yes/No buttons when left blank, "Same as last time", the closing line; the
  author's own questions are never changed), **office hours** (outside them it says when it is
  back), and **remember answers**, which offers each person's last answers as a one-tap default.
  Text questions can carry **quick replies**. Defaults from the office's records: a person
  question can offer **their lead from the directory** as one tap (`"suggest": "lead"`), and a
  text question can offer **job numbers from the Spaces they are in** (`"suggest": "jobs"`).
- **At the end:** a task on the Desk of a person chosen in the bot, a post (the Space it was
  started from, a Space its maker is in, or a message to a chosen person), a reminder for the
  person who answered, or **Mark me away**, which hands the answers to Nib's leave note (out of
  office, calendar, the lead and the cover told, Desk reminders moved; see [`NIB.md`](NIB.md)). The
  Leave note template ends with it. The integration's webhook is for administrators only.
- **Sharing:** *Only me*, *A Space* (its members can start it; a card with a Start button is
  posted there), or *The whole office*, which an administrator approves in **Control room → Bots
  & tools** (with a note the maker can read; in the audit log as `botflow.requested`,
  `botflow.approved`, `botflow.rejected`). Until then the bot stays as it was. A member's later
  change to an office-wide bot also waits for review, while everyone keeps the approved revision.
  Slash commands are for office-wide bots only.
- **Revisions:** every save is a revision, and a conversation keeps the revision it started on,
  so an edit never breaks a run in progress (Start over moves it to the newest).
- **Afterwards:** each request can be carried on after it is sent (below).
- **After it is live:** each bot has a page on the Desk: runs, finished, stopped, in progress,
  where people stop (runs that reached each question, and stopped there), recent runs and
  revisions. Answers are never shown there, and a name appears only for finished runs. Pause (no
  new runs; those under way may finish), retire, share, duplicate or delete it there.

Each member-made bot is its own identity in conversations, with its mark as its tile and a BOT
tag; it is not listed under Integrations and has no token anyone can use.

| Operation | Who | What |
| --- | --- | --- |
| `botflow.make { definition, scope, spaceId?, baseVersion?, newBot? }` | members | make or change your bot; `baseVersion` refuses a stale save |
| `botflow.mine` | members | your bots, with the newest revision, runs and the last review |
| `botflow.status { name, status }` | maker, admins | `live`, `paused` or `retired` |
| `botflow.stats { name }` | maker, admins | runs, drop-off per step, recent runs, revisions |
| `botflow.definition { name }` | anyone who can start it | to duplicate it |
| `botflow.forget { name }` | anyone | forget the answers a bot remembers for you |
| `botflow.marks` | anyone | marks and colours of member-made bots, for their tiles |
| `botflow.delete { name }` | maker, admins | remove it (conversations under way are cancelled) |
| `admin.botflows.review { name, approve, note? }` | admins | office-wide sharing, or a newer revision of an office-wide bot |

A definition takes these optional parts besides those below: `persona` (`mark`
`{ kind: "glyph", glyph }` or `{ kind: "monogram", letters }`, `colour`, `about`, `greeting`,
`tone`, `hours { days, from, to }`, `remember`), `suggestions` on a text input, a
`{ "do": "remind", "text", "due" | "dueInDays" }` finish action, and
`{ "do": "away", "from", "to"?, "cover"?, "lead"?, "kind"?, "note"? }`, which names the date steps
(the first day away and the day back), the person steps (who covers, who to tell) and the answers
for the kind of leave and a note.

### Bots talking to bots, and scheduled jobs

A bot can ask another bot's **skills** mid-flow (a step with `ask`: "Is a CAESAR II seat free?",
"Who is their lead?", "Is Ravi on leave tomorrow?"), **hand a request on** with its answers (a
`handoff` at the end, a stage whose `who` is `bot:<name>`, or a button with a `handoff`) and get it
back with the other bot's stamp, and **listen** for another bot's requests or for someone going on
leave (`network.on`). Tracked bots publish their skills from their own stages; Nib, the Directory
and the office calendar publish system skills. Every hop is checked (only bots the maker may use,
errands only for the person, no loops, four bots deep at most, rate limits, three seconds to
answer), kept, audited, and shown to the person as a relay card; the bot network sheet draws all of
them. A bot can also have **scheduled jobs** written in plain words (`jobs`: "every Monday at
10:00"), in office time (IST) on working days, with a job sheet, a dry run and run history. The
contract, the rules, the schedule grammar and the operations are in [`BOT-NETWORK.md`](BOT-NETWORK.md).

### After it is sent: tracked requests

A bot with a `track` carries each request on after the last question. The request gets a number
(`DC-0007`) and moves through **stages**; at each stage one person acts with the stage's buttons.

- **Who acts:** `requester` (the person who asked), `lead` (their manager in the Directory, else
  their department's head, else the bot's maker), a step that picked a person (a step called
  `lead` wins over the directory), or `role:<key>`, a person the maker names once in `roles`
  (the plot room, document control; the maker until chosen). Someone out of office with a
  delegate is passed over to the delegate, and the card says whom they cover for.
- **Cards:** the person acting gets a card in their conversation with the bot (and, unless the
  stage says `"task": false`, a task on their Desk, done when they act). The person who asked keeps
  the bot's closing card; it follows the request live: the strip of stages (done, here, returned,
  round 2), who has it and since when, the due date, and the stamp when it closes. A newer card
  for the same request folds the older one ("Carried on below"). When it closes, the person who
  asked gets one line with the stamp.
- **Buttons** (`actions`, up to five): `to` a stage, the same stage (start it again: *Still using
  it*), or `end` with a `stamp` and an `outcome` (`done` or `stopped`). `note` (`optional` or
  `required`) opens a note box labelled `ask`; the last note is `{{note}}` in later prompts.
  `needsChecks` waits for every line of the stage's `checklist`. `tone` (`go`, `back`, `stop`)
  draws the button and the main way along the strip. The person who asked can **Withdraw** while
  it is open.
- **Places at once** (`limit`): at most so many requests in a stage, counted per answer of `by`
  (`seats` per answer, `otherwise` for the rest). The rest wait in order and see **In line for
  E3D: place 2 of 3** and who holds the places; when one leaves, the next moves up and is told.
  The longest holder is asked once, politely, when someone is waiting.
- **Reminders** (`remind { afterHours, times, escalate }`, default a day, twice, then the lead):
  only in the bot's hours (or Mon–Sat 09:30–18:30), never to someone out of office, and gathered
  into **one list per person** that replaces their last one; the list can be acted on directly.
  After the last reminder it is passed up once (`lead`: the lead of the person it waits for;
  `role:<key>`; or `none`), and that person can **Take it over**.
- **Register** (`register { to, at, days, columns }`): one card with the counts (open, overdue,
  waiting, closed this week), the oldest, a bar of open requests per stage, the places of each
  queue, and each request, opened in place to read or act on. Posted at `at` on `days` to `to`
  (`owner`, `role:<key>` or `space:<name>`) only when something is open, replacing the one before.
  Anyone writes "register" (or "status", "queue", "who has one now") to the bot for theirs; it
  shows what they may see: requests they are part of, or everything for the maker, role holders,
  the leads concerned and administrators. A register in a Space shows everything to its members.

```json
"track": {
  "ref": "DC", "name": "{{job}} · rev {{rev}}",
  "roles": { "doccontrol": { "label": "Document control", "person": "<user id>" } },
  "stages": [
    { "id": "check", "label": "Check", "who": "checker", "due": "due",
      "prompt": "Check rev {{rev}} of {{drawings}}",
      "checklist": ["Title block and revision", "Against the model"],
      "actions": [
        { "id": "pass", "label": "Checked, no comments", "to": "issue", "needsChecks": true, "tone": "go" },
        { "id": "comments", "label": "Return with comments", "to": "correct", "note": "required", "ask": "Comments", "tone": "back" } ] },
    { "id": "correct", "label": "Correct", "who": "requester", "prompt": "Returned: {{note}}",
      "actions": [{ "id": "done", "label": "Corrected", "to": "check", "tone": "go" }] },
    { "id": "issue", "label": "Issue", "who": "role:doccontrol", "prompt": "Issue it",
      "actions": [{ "id": "issued", "label": "Issued", "to": "end", "stamp": "ISSUED", "note": "required", "ask": "Transmittal number", "tone": "go" }] }
  ],
  "remind": { "afterHours": 24, "times": 2, "escalate": "lead" },
  "register": { "to": "role:doccontrol", "at": "09:20", "days": [1, 2, 3, 4, 5] }
}
```

| Operation | Who | What |
| --- | --- | --- |
| `botflow.act { itemId, action, note? }` | the person acting | press a button of the stage |
| `botflow.tick { itemId, index, on }` | the person acting | tick a checklist line |
| `botflow.withdraw { itemId, note? }` | the person who asked | close it as withdrawn |
| `botflow.takeover { itemId }` | the lead of the person acting, the person it was passed up to, the maker, admins | take the stage over |
| `botflow.item { itemId }` | anyone who may see it | the request as one card shows it |
| `botflow.about { botId }` | anyone | what a bot's conversation header shows: who made it, its about line, hours, flows, and (tracked bots) open requests and those waiting for you |
| `botflow.register { flow, post? }` | anyone who can start the bot | the register as they may see it; `post` also puts it in their conversation with the bot |

Every action is in the audit log as `botflow.item.acted`. Each conversation shows one live card per request: when a newer card for it is posted there, older ones fold to "DC-0001 · See the latest card below". A conversation with a bot has a bot's header (BOT, who made it, what it is for, OPEN and YOURS or its hours); its Details say once that bot conversations are not end-to-end encrypted. The rules are in
`packages/core/src/botflow-track.ts`, shared by the hub and the bot maker's test run, where the
maker plays every part ("Trying it as: Checker") without sending anything.

### Flows run by the hub

Keep a flow with the integration's token:

```
PUT https://<hub>:47900/api/flows/site-visit
Authorization: Bearer <token>
Content-Type: application/json

{
  "title": "Book a site visit",
  "description": "The site lead gets it on their Desk.",
  "command": "sitevisit",
  "keywords": ["site visit"],
  "expiresInDays": 7,
  "vars": { "office": "Mumbai" },
  "steps": [
    { "id": "site", "label": "Site", "prompt": "Which site?",
      "input": { "kind": "choice", "options": ["Refinery", { "value": "depot", "label": "Depot (hard hat only)" }] },
      "branches": [{ "if": { "equals": "depot" }, "goto": "people", "set": { "ppe": "Hard hat" } }] },
    { "id": "permit", "label": "Permit", "prompt": "Work permit number?",
      "input": { "kind": "regex", "pattern": "WP-\\d{4}", "message": "Permit numbers look like WP-1234." } },
    { "id": "people", "label": "People", "prompt": "How many people?", "input": { "kind": "number", "integer": true, "min": 1, "max": 8 } },
    { "id": "day", "label": "Day", "prompt": "Which day?", "input": { "kind": "date", "notBefore": "today" } },
    { "id": "lead", "label": "Site lead", "prompt": "Who is the site lead?", "input": { "kind": "person" } },
    { "id": "pack", "label": "Briefing pack", "prompt": "Attach the briefing pack if there is one.", "input": { "kind": "file", "accept": [".pdf"], "optional": true } },
    { "id": "ok", "prompt": "Send this to {{lead}}?\n\n{{summary}}", "input": { "kind": "confirm", "yes": "Send", "no": "Change something" },
      "branches": [{ "if": { "equals": "no" }, "goto": "site" }] }
  ],
  "finish": [
    { "do": "task", "assignee": "lead", "text": "Site visit to {{site}} on {{day}} for {{people}} ({{user}})", "due": "day" },
    { "do": "post", "to": "origin", "text": "Site visit booked: {{site}}, {{day}}." },
    { "do": "webhook" }
  ],
  "done": "Sent to {{lead}}."
}
```

| Part | Meaning |
| --- | --- |
| `name` (in the address) | Lower-case letters, digits and dashes; unique in the office. `PUT` again to change it; `DELETE /api/flows/<name>` removes it (anyone in the middle is stopped). `GET /api/flows` lists yours. |
| `input.kind` | `choice` (buttons; `options` as text or `{value, label}`), `text` (add `validate`, or use the short kinds `number` with `min`, `max`, `integer`; `date` with `notBefore` (`"today"` or a date); `email`; `regex` with `pattern`), `person` (anyone in the office except the person answering), `file` (`accept` extensions; the person attaches it in the card), `confirm` (`yes` and `no` words). `optional: true` adds **Skip**. `message` replaces the hint shown when an answer does not pass. |
| `branches` | Checked in order after the step is answered; the first whose `if` passes decides where to go (`goto` a step id, or `"end"`), and may `set` variables. Tests: `equals`, `notEquals`, `in`, `matches`, `gt`, `gte`, `lt`, `lte`, `empty`, on the step's answer or on another `var`. Without a branch the flow goes to `next`, or the following step. |
| Variables | Each answer is kept under its step id (or `save`). In prompts and messages `{{name}}` shows the answer as the person saw it (a person's name, a date in words), `{{name.value}}` the raw value (an id, `2026-11-20`), `{{summary}}` all answers so far as a list, `{{user}}` who is answering. |
| `finish` | `task`: a task on the Desk of the person in `assignee` (a person step), due at 09:00 on the `due` date step (or `dueInDays`); they also get the answers, and any file, in their conversation with the integration. `post`: `to` is `origin` (the Space the flow was started from), `space:<name>`, or `person:<step>`. `webhook`: the integration's webhook (Control room → Integrations → Commands) receives `{ "type": "flow.completed", "flow", "sessionId", "user", "answers", "labels", "files", "conversation" }`, signed like slash commands; a reply `{ "text": "…" }` is posted to the person. |

Other calls: `POST /api/flows/<name>/offer` with `{ "to": ["priya.raman"], "space": "Site team" }`
posts a card with a **Start** button; `POST /api/flows/<name>/start` with `{ "user": "priya.raman" }`
starts it for someone (the first step appears in their conversation with the integration).
Answers are checked again on the hub, whatever the app shows. Administrators can write, change and
switch flows off in **Control room → Bots & tools → Flows**.

Dexterity Connect comes with **Front Office** and two flows: **Request a plot** (`/plot`: job,
drawings and revisions, the plot set, sheet size, media, sets, date needed, approver; the approver
gets a task on their Desk) and **Leave request** (`/leave-request`: kind, from, working days, who
covers, handover, approver; the approver gets a task and the person covering is told). `/leave` is
Nib's leave note, the office's way of going on leave (it tells leads and Spaces, blocks the calendar
and shows the person away); the leave request is only the approval, and when it is sent it points to
`/leave` for the rest. Hubs that installed the leave request with `/leave` move it to
`/leave-request` when they start. Revoking Front Office in Control room → Integrations switches them
off.

### Nib, the office's companion

Nib is not an integration: it is part of the hub, one permanent bot identity with no token, and
nothing outside the hub can post as it. Its design, the day sheets, the register and the leave
note are in [`NIB.md`](NIB.md). The operations the app uses:

| Operation | Who | What |
| --- | --- | --- |
| `nib.me` | members | your day: the sheet, the ask Nib is making, your givers, leave, welcome back |
| `nib.start { givers, items?, yesterday? }` | members | who gave you work today (and send the last unsent sheet) |
| `nib.item.save`, `nib.item.delete` | members | an item on your sheet: giver, job, activity, quantity, words, state, due |
| `nib.wrap { note?, blockers?, items? }` | members | send the sheet to your leads (again after a change) |
| `nib.day { nothing?, snoozeMinutes?, snoozeUntilFree?, wrapAt? }` | members | nothing today, a snooze, your own wrap-up time |
| `nib.card { kind, ref }` | the card's reader | a card's data, checked against the viewer each time |
| `nib.ack { date, userId? }` | leads | mark a sheet (or all) seen |
| `nib.sheet { userId, date }` | the person, their givers (their items), the management | one day sheet |
| `nib.leave.plan`, `nib.leave`, `nib.leave.cancel`, `nib.cover.take`, `nib.welcome.seen` | members | the leave note |
| `admin.nib.get`, `admin.nib.set`, `admin.nib.preview` | administrators | the configuration (audited as `nib.config`), and a register now |
| `nib.sheets.ask { text }` | members | a Dexterity Sheets question from the Nib box; the answer is also posted in the conversation with Nib (see [Dexterity Sheets](#dexterity-sheets)) |

Events: `nib.me` (your day changed) and `nib.changed { date, kinds }` (cards to draw again).

### Integrations with their own logic (sessions)

An integration that decides each step itself can still keep its state on the hub, so it survives
restarts and other devices:

```
GET    /api/sessions/<user>        the conversation in progress with that person (404 if none)
PUT    /api/sessions/<user>        { "step": "drawing", "data": { … }, "expiresInDays": 3,
                                     "prompt": { "title": "Plot spooler", "text": "Which drawing?",
                                                 "input": { "kind": "text" }, "of": 4 } }
DELETE /api/sessions/<user>        end it
```

`<user>` is a Windows sign-in (`priya.raman` or `DEX\priya.raman`) or a person's id. `data` is
your own JSON (up to 64 KB). A `prompt` shows a card for that step with the same inputs as above
(`of` is how many steps there are, for "step 2 of 4"); `"end": "done"` or `"end": "cancelled"`
finishes it. The session you get back has `id`, `step`, `history`, `answers`, `data`,
`startedAt`, `updatedAt` and `expiresAt`.

What happens in the conversation is sent to your webhook, signed, with the session id and step:

```
{ "type": "answer", "sessionId": "01J…", "step": "qty", "value": "4", "label": "4",
  "session": { … }, "user": { "id": "…", "name": "Priya Raman", "account": "dex\\priya.raman" },
  "conversation": { "id": "…", "kind": "direct" }, "at": "2026-11-14T10:00:00Z" }
```

`type` is `answer` (a card was answered), `message` (the person wrote; with `text`, `files` and
`messageId`), `back` (they went back to the previous card, which the hub shows again), `cancel` or
`restart`. Reply with `{ "text": "…" }` to answer in the conversation and/or
`{ "session": { "step": …, "data": …, "prompt": … } }` to move on, exactly like `PUT`.

## 5. Tools inside conversations (mini-apps)

A tool is a small web page that runs inside a conversation: everyone in it sees the same tool and
its shared state. Members add approved tools from the conversation's menu (**Add a tool…**); each
one added is a sheet-framed card in the timeline that can be popped out larger.

### The bundle

Upload either **one HTML file** that describes itself:

```html
<!doctype html>
<html><head>
<script type="application/dex-manifest+json">
{ "id": "rfi-log", "name": "RFI log", "version": "1.2.0", "description": "Open RFIs for this job",
  "permissions": ["state", "post", "members"], "hosts": ["https://docs.office.local"], "height": 360 }
</script>
<style>…</style></head>
<body>…<script>…</script></body></html>
```

or a **.zip** with `manifest.json` (the same fields, plus `entry` if the page is not `index.html`)
next to the page, its scripts, styles, images and fonts. The hub writes everything the page refers
to into it (scripts, styles, `url()` in styles, `src` of images and media become inline or `data:`);
anything loaded from elsewhere (`https://…`, `//…`) is refused. Up to 2 MB packed, 4 MB unpacked,
64 files, 3 MB as one page. Ids starting with `dex-` belong to the tools that come with the app.

| Permission | What the tool may do |
| --- | --- |
| `state` | Read and write its shared state in that conversation. |
| `post` | Post a message as the person, after they see it and press **Post it**. |
| `members` | See who is in the conversation (names and titles). |
| `files` | List the files shared in the conversation; open one after the person agrees (once per file). |
| `network` | Reach the `hosts` the administrator granted (set by listing `hosts`). |

Every tool can read who is looking (`context`) and ask for a different height.

### The sandbox

The app shows a tool in `<iframe sandbox="allow-scripts">` loaded from its own `dexapp:` address:
no same origin with the app, no top navigation, no popups, no form submission (handle clicks and
Enter in your script), no `alert` or `prompt`, no camera, microphone, clipboard or location. The page is served with this policy (also written into the page
before anything else):

```
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:;
font-src data:; media-src data: blob:; connect-src 'none' (or the granted hosts); frame-src 'none';
child-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'
```

Its frame may only ever show tools: the app refuses to send it anywhere else.

### The API

The page gets `window.dex` before its own scripts run:

```js
const ctx = await dex.context();
// { viewer: { id, name }, conversation: { id, kind, name }, app: { id, name, version },
//   instanceId, permissions, theme: { mode: 'light' | 'dark', colors: { bg, text, accent, … } } }
const people = await dex.members();                 // [{ id, name, title }]
const { posted } = await dex.post('**Tape**\n- 12 × 3 = 36');
const { state, version } = await dex.state.get();
const r = await dex.state.set(next, version);       // { state, version, conflict }
dex.on('state', ({ state, version, updatedBy }) => render(state));
const files = await dex.files.list();               // [{ id, name, mime, size, createdAt }]
const f = await dex.files.read(files[0].id);        // { id, name, mime, size, bytes: ArrayBuffer }
await dex.resize(480);                              // 120 to 900 px
dex.on('theme', ({ mode, colors }) => …);
```

The app's colours are also set as CSS variables (`--dex-bg`, `--dex-text`, `--dex-text-2`,
`--dex-text-3`, `--dex-stroke`, `--dex-stroke-strong`, `--dex-accent`, `--dex-accent-soft`,
`--dex-amber`, `--dex-danger`, `--dex-font-body`, `--dex-font-mono`, …) and follow light and dark.

Shared state is one JSON value per tool added, up to 64 KB, sent to everyone in the conversation.
The last write wins and each write increases `version`; pass the version you started from and the
answer's `conflict` says whether someone wrote in between, so you can merge (the tools that come
with the app keep lists of records with ids and merge by id). Up to 25 writes in 5 seconds per person.

Underneath, `window.dex` is `postMessage`: the page sends `{ dex: 1, id, method, params }` to its
parent (`context.get`, `members.list`, `message.post`, `state.get`, `state.set`, `files.list`,
`files.read`, `ui.resize`) and gets `{ dex: 1, id, ok, result | error }`; changes arrive as
`{ dex: 1, event: 'state' | 'theme', data }`.

### Review

In **Control room → Bots & tools → Tools in conversations** an administrator uploads a bundle, reads
what it asks for (permissions, hosts, its whole page), grants some or all of the hosts, and approves
or rejects it with a note. A new version goes back for review before anyone runs it. Switching a tool
off stops it everywhere at once; its cards say so. Uploading, approving, rejecting, switching on or
off, and every tool added to a conversation are in the audit log.

Dexterity Connect comes with five tools: **Calculator** (a tape everyone in the conversation sees),
**Unit converter** (length, pressure, flow, temperature, mass, area, volume and density, with a
shared list of noted conversions), **Drawing viewer** (SVG, PNG, JPEG or the first page of a PDF,
with pan, zoom and numbered markers), **Data sheet** (a CSV as a sortable table and a bar chart;
for a workbook, save the sheet as CSV first) and **Punch list** (snags by area, discipline and
priority, with a tally board).

## 6. Links that open Dexterity Connect

| Link | Opens |
| --- | --- |
| `dexconnect://conversation/<id>` | A conversation |
| `dexconnect://message/<conversation id>/<message id>` | One message (shown as a preview card in messages; *Copy link* on a message makes one) |
| `dexconnect://people/<user id>` | Someone's profile in the Directory |
| `dexconnect://file/<file id>` | A file shared in a conversation |
| `dexconnect://calendar/event/<event id>` | A meeting on the Calendar |
| `dexconnect://desk/task/<reminder id>` | A task (reminder) on someone's Desk |
| `dexconnect://meet/<meeting ID>` | Joins a meeting by its ID (482-913-207), through its lobby if it has one |
| `dexconnect://desk`, `dexconnect://calendar`, `dexconnect://settings` | Those screens |

Every one of these links, the tools' own links below, and paths on the office share are shown in
messages as cards (see [Link cards](#5-link-cards-side-tracks-about-links-and-reaction-insights)).

## 7. Link cards, side-tracks about links and reaction insights

These are operations the apps call on the hub over their signed-in connection (like every other
operation; there is no separate HTTP API). Types are in `packages/core/src/protocol.ts`.

### `links.preview { url }` → `LinkCard`

A card for any link in a message. The app asks when the message is on screen: posting a message
never waits for a preview (the hub only warms its cache afterwards, for web links in messages it
can read).

| Link | Card `kind` | What it shows |
| --- | --- | --- |
| `dexconnect://message/<conv>/<msg>` | `message` | Author, conversation, sent or edited, replies, an excerpt (encrypted messages say so), actions `open` and `reply` |
| `dexconnect://conversation/<id>` | `conversation` | Name, topic, members, last message, kind; `join` for an open Space you are not in |
| `dexconnect://people/<id>` | `person` | Name, designation, department, seat, status |
| `dexconnect://file/<id>` | `file` | Name, type, size, who shared it; a thumbnail (`preview.fileId`) for images |
| `dexconnect://calendar/event/<id>` | `event` | Title, when, organiser, invited and going, your reply; `join` for a meeting held as a call |
| `dexconnect://desk/task/<id>` | `task` | The task, due, open, overdue or done |
| `dexconnect://meet/<meeting ID>` | `meeting` | Title, host, kind, whether it is running (how many people, only for people inside the meeting), lobby; `join` and `copy-path` (the meeting link). Anyone signed in may see what `meet.get` shows for an ID |
| `sleuth://search?q=` | `search` | The search; `open-in-tool` (Sleuth) |
| `dexterity://open/<server>/<book>?at=<Sheet>!<Cell>` | `workbook` | The workbook's name and server, the sheet (`meta` key `sheet`) and cell (`location`); `open-in-tool` (*Open at B4*) opens the whole link, `?at=` included, so Sheets goes to the cell |
| `projectopener://open/<id>` | `project` | The project; `open-in-tool` (Project Opener) |
| `datum://c/<id>`, `datum://m/<module>/<calculator>` | `component`, `calculator` | `open-in-tool` (Datum) |
| `\\server\share\…`, `file://…`, `D:\…` | `folder`, `path` | The name, the folder, the file type and server; actions `open-in-tool` (label *Open folder*, `tool: 'folder'`) and `copy-path`. The hub never reads the path. The apps draw these cards themselves (see *Share paths and drive letters* below) and no longer ask the hub; the hub still answers for other clients. |
| `http://`, `https://` | `web`, `video` (YouTube), `repo`, `issue`, `pull` (GitHub), `pdf`, `image` | Title, site, description, picture and icon from `og:*`, `twitter:*`, `<title>` and `<meta name="description">`; size for PDFs, dimensions for images |

In the apps, the first three links of a message get cards under it (links to messages are drawn as
a quote card in the text instead, with Reply). A card is asked for only when its message comes
near the screen and is kept per link for the session; every card, whether loading, ready, failed
or without access, is drawn in the same reserved box, so the timeline never moves when one
arrives. Links in end-to-end encrypted messages only get cards when they point into the office
(`dexconnect://`) or are share paths (drawn on the PC): other links are never sent to the hub. **Discuss** on a card opens its
side-track (`links.discuss`). **Open folder** on a share or drive path goes through the PC's own
Explorer, and only for a path written as `\\server\share\…` or `D:\…` that exists and is a folder,
never a file or program; the PC needs access to the share as usual.

### Share paths and drive letters

One person maps `\\nas01\Project` as `X:`, another as `Z:`, a third maps nothing. So that a path
in a message works for all of them (the way Project Opener's portable paths do):

- **Stored as UNC, shown per reader.** When a message is sent (the Dock, Share, a dropped folder,
  an edit), a path on a drive letter this PC maps to a network share is rewritten to its UNC path
  (`X:\P12513\Iso` → `\\nas01\Project\P12513\Iso`). Code (`` `…` `` and fenced blocks) is left
  alone. Every reader, the writer included, sees UNC paths with their own drive letter where they
  have one (the mapping with the longest root wins, so `J:` → `\\nas01\Project\Jobs` beats `Z:` →
  `\\nas01\Project`), with the UNC form in the tooltip; without a mapping they see the UNC path.
  The writer therefore still sees what they typed, and editing a message shows their letters again.
  We store UNC and render per reader, rather than rewrite the text per reader, because the stored
  message is then right for every client, search, notification and export without knowing anyone's
  drives. Paths are read in quotes (with spaces), as `file://` URLs, with forward slashes, as
  `\\?\UNC\` long paths, with trailing separators and next to Hindi or Tamil text; a full stop or
  danda after a path ends the sentence, not the path (`packages/core/src/sharepaths.ts`).
- **Cards are made on the PC.** Path cards (`kind` `path` or `folder`) are drawn from the path
  alone, also in end-to-end encrypted messages: the hub never sees or reads them. **Copy path**
  copies the reader's form; the menu beside it has **Copy UNC path**. **Open** (drawings, sheets,
  documents, images and archives only, never programs or scripts) and **Open folder** try the path
  as given, its UNC form and the PC's own letter, in that order, and use the first that exists.
- **Local drives.** A path on a drive that is not a network share (`C:\Users\…`, or a `subst` drive
  onto a local folder) is sent as written. The writer's card says *Only on this PC: others cannot
  open it*; other readers see *Only on Priya Raman's PC* and only Copy path.
- **No access.** Once a card is on screen the app checks the path in the main process: the file
  server's SMB port (445) within 0.8 s, then the path within 2 s, cached for a minute per path and
  never on the window's thread. *You don't have access to this file/folder*, *The file server isn't
  reachable from here* and *Not found from this PC* replace the card's third line, and Open and
  Open folder are left out; nothing else changes and nothing moves.
- **This PC's drives (Windows).** Read from `reg query HKCU\Network /s /v RemotePath` (persistent
  mappings), `net use` (connected now, including session-only ones; it wins on a conflict) and
  `subst`, all under `chcp 65001` so share names in any script arrive intact; no PowerShell (slow to
  start and often restricted) and no native modules. `net use` is read by the shape of its lines (a
  drive letter, then `\\server\share…`), so translated Windows works. `subst` drives onto a mapped
  drive or a share lead to the share; onto a local folder they stay local. DFS: a letter mapped to
  a namespace keeps the namespace path (the same on every PC); it is never resolved to a target
  server. The map is read at start, when the window gains focus (cached for 60 s) and on
  **Preferences → Your network drives → Refresh**. macOS and Linux have no drive letters: mounted
  SMB shares are not read, UNC paths are shown as written and Open folder stays Windows-only.
- **Older messages.** Messages written before this keep their drive letters. Each Windows device
  publishes its network roots to the hub (`links.drives.set { drives: [{ letter, root }] }`, only
  letters and UNC roots; local and subst-onto-local drives are dropped on the PC and again on the
  hub). Readers ask for the writers' maps (`links.drives.of { userIds }` → per person `{ known,
  drives }`, all their approved devices together, a letter two devices map differently left out).
  A drive-letter path whose writer's map is known is translated through it to UNC and shown with
  the reader's letter; a letter the writer's map does not have is *only on their PC*; with no map
  known the path is shown as written, dotted, with *May be mapped differently on your PC*. Both
  operations refuse guests and bots, so share roots reach only signed-in members (over the
  devices' own encrypted channel when they are outside the office; the gateway passes only opaque
  frames).
- **Test hook.** `DEXCONNECT_TEST_DRIVES` (TEST ONLY, honoured only in an unpackaged development
  build and only when set) gives a fake map, inline JSON or a file read on every refresh, with
  per-path access results; under it nothing is handed to Explorer and the calls are recorded for
  the e2e script (`apps/desktop/e2e/sharepaths.mts`).

Hopper has no link scheme of its own (`hopper://` only serves files inside Hopper's window), so
office-share paths are the way to point at files Hopper manages.

Internal cards are worked out for the person asking. If they cannot see what the link points at,
or it does not exist, the card is `{ kind: 'restricted' }` with no title, subtitle, details or
actions, so a link never tells anyone what is behind it.

Web pages are fetched by the hub, never by the apps:

- `http` and `https` only, on the usual web ports (80, 443, 8080, 8443);
- the host is looked up once and every address checked: loopback, private, link-local,
  carrier-grade NAT, multicast, documentation and reserved addresses (IPv4 and IPv6, including
  mapped, NAT64 and 6to4 forms, and numbers written in decimal, octal or hex) are refused, unless
  an administrator lists the host in `allowLanHosts`. The request goes to the address that was
  checked, so a second DNS answer cannot redirect it;
- at most 3 redirects, each checked again; 4 seconds in all; at most 512 KB read;
- only HTML is read for its tags; PDFs and images by their headers (and an image's first bytes for
  its size); nothing else;
- the request sends `User-Agent: DexterityConnect-LinkPreview` and no cookies, credentials or
  referrer.

A blocked page gives `{ kind: 'unavailable', status: 'blocked', reason }`, a failed one
`status: 'failed'`. Web cards are cached on the hub for 24 hours (failures for 15 minutes) by a
hash of the address without its `#fragment`, and shared by everyone. Each person can have 30
web previews a minute that are not in the cache; after that the operation answers
*Too many link previews in a minute*.

### `admin.links.get`, `admin.links.set { externalPreviews?, guestExternalPreviews?, allowLanHosts? }` → `LinkSettings`

Administrators only. `externalPreviews` (on by default) turns fetching web pages off for the whole
office; cards then have `status: 'disabled'` and only the site's name. Guests get no web previews
unless `guestExternalPreviews` is on (off by default, the data-protection friendly choice).
`allowLanHosts` lists up to 50 office-network host names (an intranet wiki) the hub may fetch.

### `links.hide { messageId, url, hidden }` → `Message`

The author of a message removes the card for one of its links (or brings it back), for everyone.
The message carries `hiddenPreviews: string[]` with the links whose cards are removed. Up to 20.

### `links.discuss { url, convId, messageId? }` → `LinkThread`

Opens the side-track about a link in a conversation: the same side-tracks as everywhere else
(replies under a root message, `msg.list { parentId }`, `msg.send { parentId }`). The hub remembers
the root for each conversation and link (`{ convId, urlHash, rootMessageId }`). The first time,
it anchors to the latest message in the conversation that holds the link, or posts a new message
with the link as the person asking. In a Direct conversation the hub cannot read the messages, so
the app passes the `messageId` the person started from. Members only.

### `reactions.insights { messageId }` → `ReactionInsights`

What a message's reactions show, for members of its conversation. Every reaction added or removed
is kept with its time (`reaction_events`), from the moment the hub is updated (reactions from
before count as added when they were made).

- `distribution`: each emoji with its count and percentage;
- `audience`: the conversation's members other than the author and integrations: how many
  reacted, read it without reacting, have not read it, and `unknown` (their read receipts are
  off). Read receipts are used as people share them: someone with their own receipts off gets
  `receipts: false` and no read counts, as in Read by…; side-track replies have no receipts;
- `timeline`: added, removed and cumulative reactions in up to 25 equal steps from the message;
  `firstAt` and `lastAt`;
- `byDepartment`: reactors per department (when the office has departments);
- `announcement`: for messages in the Office space or a Space where only moderators post, the
  share of members who reacted against the average of the office's other announcements in the
  last 90 days;
- `anonymous`: for an anonymous poll only counts are given (no departments, no read counts).

Every answer carries `note: 'Reactions are not approvals'`, which the app shows with the numbers.
In the apps, **Reaction insights** is in a message's More menu and on the count at the end of its
stamps: the numbers as small charts (and as a table), with that note always on top.

### Communication styles (in the app, no hub)

`restyle(text, style, opts?)` in `@dex/core/restyle` rewrites a draft as `concise`, `formal`,
`diplomatic`, `explanatory` or `technical`. It runs on the person's own PC, is rule-based and
deterministic (no model, no network), and never changes numbers, units, dates, times, names,
@mentions, drawing, line and tag numbers, code, links or quoted text (the technical style only
writes the SI symbol and a thin space after a number). It returns the new text and each change
(`from`, `to`, `rule`, `at`, `sourceAt`); `applyChoices(result, rejectedIds)` gives the text with
the changes the person undid put back. `opts.names` lists more names to keep, `opts.glossary` adds
the office's own abbreviations, and `opts.courtesy: false` stops the diplomatic style adding a
greeting and thanks.

In the apps, **Restyle** in the Dock shows the five styles as stamps; the chosen one opens a sheet
with the draft as written beside the restyled text, each change a numbered revision mark that can
be accepted or rejected, then *Use this* or *Keep mine*. The directory's names are passed as
`opts.names`. **Restyle a copy** in a message's More menu does the same for someone else's
message, for the reader only (to copy). On phones the sheet comes up from the bottom.

## 6. Decisions and references

Two more kinds of message, with their state on the hub. Types are in
`packages/core/src/message-kinds.ts`.

### Decisions

A question whose options either close ("Approved", with an optional closing note) or lead to a
follow-up step: another question with options, or a written answer (which always ends the path).
At most 4 steps deep, 6 options a step and 24 steps in all; labels up to 80 characters, questions
up to 300, notes up to 500, written answers up to 1,000. Every member of the conversation walks
their own path. Guests can answer but not start one.

| Operation | What it does |
| --- | --- |
| `decision.create { convId, parentId?, clientId?, root }` → `Message` | Posts the Decision. `root` is `{ prompt, kind: 'choice', options: [{ label, note?, next? }] }`; `next` is the follow-up step (`kind: 'choice'` or `'text'`). The hub checks the tree and gives every step an id (`s1`, `s2`…) and every option one (`s1.1`, `s1.2`…). The message's text is `Decision: <question>` for notifications and search |
| `decision.answer { messageId, stepId, optionId?, text? }` → `Message` | Answers the step in front of you: an option, or the text for a written step |
| `decision.reset { messageId }` → `Message` | Starts your own path again |
| `decision.close { messageId }` → `Message` | The author (or an administrator) stops further answers |
| `decision.results { messageId }` → `DecisionResults` | The author (or an administrator): the tree, everyone's path and outcome, who has not started, and how many picked each option |

`Message.decision` is the Decision as each person sees it: the question, their path (`trail`),
the step in front of them (`current`; later steps stay hidden until they are reached), whether they
reached an end, its `outcome` and closing `note`, how many started and finished, and, for its
author only, the whole `tree`. When someone reaches an end the hub emits `response.confirmed` with
`source: 'decision'`, `choice` (the closing option, or the option before a written answer) and
`answers: { path, answer? }`, so Automations react as they do to polls and forms.

### References

Dragging a message or a file into another conversation (or **Reference in…** in a message's menu)
posts a reference: a pointer, not a copy. Like a forward it is a message (its `ref` is stored with
it), but what it points at is worked out for each person as they look.

| Operation | What it does |
| --- | --- |
| `refs.send { convId, parentId?, clientId?, target }` → `Message` | Posts a reference. `target` is `{ convId, messageId }` or `{ fileId }`. Only someone who can open the source may reference it, and only into a conversation they are in (not the source's own). A reference to a reference points at the original. The message's text is *Shared a reference* |
| `refs.check { convId, target }` → `{ members, without }` | Before posting: how many people in the conversation (integrations left out) could not open the source. Only a count |
| `refs.resolve { messageId }` → `MessageRef` | A reference message, resolved for the person asking |

`Message.ref` (a `MessageRef`) gives everyone `kind` and `authorId`. People who may open the source
(members of its conversation; for a file, anyone the file store lets open it) also get where it is
(`convId`, `messageId`, the Space's name), the message itself (its text, encrypted for Direct
conversations and opened by the app as usual) or the file's details, and `gone` if it was deleted.
Everyone else sees only that it exists, *From a conversation you're not in*, with the author's
name. A file reference is the same file id: it is never linked to the new conversation, so opening
it is checked against the conversations it was really shared in. Forwarding a reference forwards
the pointer; a reference cannot be edited.

## What each tool does today

| Tool | Into Dexterity Connect | From Dexterity Connect |
| --- | --- | --- |
| Hopper | File alerts and link notices through the Bot API | — |
| Slate | — | Notes open in Slate and its saves come back into the note; text, CSV and log attachments open in Slate |
| Project Opener | Project menu → *Share to Dexterity Connect…* (title, client, description, `projectopener://open/<id>`) | `projectopener://` links in messages open the project |
| Sleuth | Result menu → *Share to Dexterity Connect…* (the file and the text found) | Line numbers (`6"-P-1001-A1B`) and drawing numbers (`ISO-1001-01`) in messages run that search in Sleuth (`sleuth://search?q=`) |
| Datum | Component page → *Share* (key figures, dimensions, `datum://c/<id>`) | `datum://` links open the component, calculator or module page |
| Dexterity Sheets | Being built on the Sheets side (not released yet): *Share to Dexterity Connect* (`dexconnect://share`), and mention and assignment notices from the Sheets server through the Bot API. Connect is ready for both | `dexterity://open/…?at=` links open the workbook at the cell; Nib answers "what's assigned to me in Sheets?" from the Sheets server's read API (below) |

Links for a tool show as a chip with the tool's name. Dexterity Connect opens only these schemes,
and only when the tool is installed on that PC. The tool-side changes are on each repository's
`claude/epic-fermi-h7zdk1` branch.

## Dexterity Sheets

Both directions use what is above; nothing in Connect is special to Sheets except Nib reading it.

**Sheets → Connect**

- *Share to Dexterity Connect* in the Sheets app opens
  `dexconnect://share?from=Dexterity%20Sheets&title=<book>&link=<dexterity://open/<server>/<book>?at=<Sheet>!<Cell>>`
  (the link URL-encoded as a whole). The message is written as a Markdown link, `[<book>](<link>)`,
  and its card shows the server, sheet and cell. A sheet name with spaces or quotes is encoded
  (`%20`, `%27`) so the link is never cut short.
- Mention and assignment notices come from the Sheets server through the Bot API
  (`POST /api/bot/message`, Pulse cards through `POST /api/bot/widget`) with an ordinary integration
  token an administrator creates for it. Put the `dexterity://open/…?at=` link in the text or the
  card's `url` so it opens at the cell.

**Connect → Sheets: Nib reads the Sheets server**

An administrator sets this in **Control room → Integrations → Dexterity Sheets**: the server (typed
as a name or address, or **Find on the network**) and the token generated in Sheets Server Manager,
then **Test**. Stored on the hub like the Zoho client secret: the token is sealed (AES-256-GCM with
`sheets.key` beside the database), never logged, never sent back to the Control room or to anyone's
PC; changes are audited as `sheets.config` without it.

- Finding: the UDP question `DEXSHEETS?1` to port 47811 (broadcast, and loopback for a server on
  the hub's PC); each answer is `{ "name", "address": "0.0.0.0:<port>", "version" }`. The read API
  is assumed on TCP **47812** of the PC that answered.
- The read API: HTTP, JSON, `Authorization: Bearer <token>`, answered within 6 seconds.

| Request | Answer |
| --- | --- |
| `GET /api/v1/health` | `{ name, version }` (the **Test** button) |
| `GET /api/v1/people/{user}/assigned` | `[{ book, sheet, cell, title, status, due, link }]` |
| `GET /api/v1/people/{user}/mentions?since=<ISO 8601>` | `[{ book, sheet, cell, from, text, at, link }]` (Nib asks for the last 7 days) |
| `GET /api/v1/books` | `[{ id, name, sharer, online: [user] }]`; an optional `link` per book is used when present |

`{user}` is always the asking person's own Windows account, `DOMAIN\user` in lower case,
URL-encoded (`dex%5Cpriya`); Sheets matches it without regard to case. `online` lists accounts in the
same form; Nib shows the names the office knows. `link` must be a `dexterity://open/…` link or it is
shown as plain words. An item counts as done when its `status` is `done`, `closed`, `complete(d)`,
`resolved`, `finished`, `cancelled` or `n/a`; everything else is open. `due` is read as
`YYYY-MM-DD…`. `401`/`403` mean the token was refused.

| Operation | Who | What |
| --- | --- | --- |
| `admin.sheets.get` | administrators | `{ url, hasToken, configured, lastTest, digestPeople }` |
| `admin.sheets.set { url?, token? }` | administrators | a new token replaces the saved one; empty keeps it; `null` removes it |
| `admin.sheets.test { url?, token? }` | administrators | `GET /api/v1/health` with what is typed, or the saved settings |
| `admin.sheets.discover` | administrators | `[{ name, address, version, url }]` that answered within two seconds |

Event: `admin.sheets` (the settings changed).

## Outside the office

Everything on this page works on the office network. Through the internet gateway
([`REMOTE-ACCESS.md`](REMOTE-ACCESS.md)) people can share, open links and use slash commands as
usual, but the Bot API and webhooks stay office-only: the hub refuses them with `403` when they
arrive through the gateway.
