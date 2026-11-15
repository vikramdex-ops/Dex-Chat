# Integrating office tools with Dexterity Connect

Four ways for a tool to work with Dexterity Connect, from the simplest to the most capable. None
needs the internet: everything runs on the office network.

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
| `title`, `link` | Optional. A labelled link added on a new line, for example a job folder or a web page. |

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

### Pulse widgets

An integration keeps up to 5 cards on everyone's Pulse up to date with its token:

```
POST https://<hub>:47900/api/bot/widget
Authorization: Bearer <token>

{ "key": "plotter", "title": "Plotter queue", "lines": ["3 sheets waiting", "A0 roll low"], "url": "https://…" }
```

Send the same `key` again to update it, or `{ "key": "plotter", "remove": true }` to take it down.
Up to 8 lines of 200 characters. Revoking the integration removes its widgets.

### Automations

Rules in a conversation (or for every Space) can call your tool's webhook when something happens
there, for example when a drawing is shared, with the PDF's title and revision in the body. The
request format, the values a body can use and the safety rules (office-network addresses only when
an administrator allows them) are in [`AUTOMATIONS.md`](AUTOMATIONS.md#webhooks).

## 4. Links that open Dexterity Connect

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

## 5. Link cards, side-tracks about links and reaction insights

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
| `dexterity://open/<server>/<book>?at=` | `workbook` | The workbook's name, its server and cell; `open-in-tool` (Dexterity Sheets) |
| `projectopener://open/<id>` | `project` | The project; `open-in-tool` (Project Opener) |
| `datum://c/<id>`, `datum://m/<module>/<calculator>` | `component`, `calculator` | `open-in-tool` (Datum) |
| `\\server\share\…`, `file://…`, `D:\…` | `folder`, `path` | The name, the folder, the file type and server; actions `open-in-tool` (label *Open folder*, `tool: 'folder'`) and `copy-path`. The hub never reads the path. |
| `http://`, `https://` | `web`, `video` (YouTube), `repo`, `issue`, `pull` (GitHub), `pdf`, `image` | Title, site, description, picture and icon from `og:*`, `twitter:*`, `<title>` and `<meta name="description">`; size for PDFs, dimensions for images |

In the apps, the first three links of a message get cards under it (links to messages are drawn as
a quote card in the text instead, with Reply). A card is asked for only when its message comes
near the screen and is kept per link for the session; every card, whether loading, ready, failed
or without access, is drawn in the same reserved box, so the timeline never moves when one
arrives. Links in end-to-end encrypted messages only get cards when they point into the office
(`dexconnect://`): other links are never sent to the hub. **Discuss** on a card opens its
side-track (`links.discuss`). **Open folder** on a share or drive path goes through the PC's own
Explorer, and only for a path written as `\\server\share\…` or `D:\…` that exists and is a folder,
never a file or program; the PC needs access to the share as usual.

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
| Dexterity Sheets | Share → *Share to Dexterity Connect* (the shared spreadsheet's `dexterity://` link) | `dexterity://` links open the spreadsheet |

Links for a tool show as a chip with the tool's name. Dexterity Connect opens only these schemes,
and only when the tool is installed on that PC. The tool-side changes are on each repository's
`claude/epic-fermi-h7zdk1` branch.

## Outside the office

Everything on this page works on the office network. Through the internet gateway
([`REMOTE-ACCESS.md`](REMOTE-ACCESS.md)) people can share, open links and use slash commands as
usual, but the Bot API and webhooks stay office-only: the hub refuses them with `403` when they
arrive through the gateway.
