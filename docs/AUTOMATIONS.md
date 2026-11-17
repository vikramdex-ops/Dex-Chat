# Automations

Automations are rules that act when something happens in a conversation: a drawing is shared, a
message gets a ✅, someone votes in a poll, a message says “stop work”, someone mentions the
Document Review group. A rule is drawn as a small schematic on a ruled sheet, read left to right:

**When** (one trigger) → **Only if** (any number of conditions, all must hold) → **Then** (steps, in order)

The hub runs the rules, so they work whoever is online. Every rule keeps a log of its last 50 runs.

Automations react to one conversation. Bots that act when *another bot's* request is sent, moves
or closes, or when someone goes on leave, and bots that do things on a schedule, are part of the
bot maker instead: see [`BOT-NETWORK.md`](BOT-NETWORK.md).

## Where to find them

- **In a conversation:** the header’s **More** menu → **Automations…** lists that conversation’s
  rules. Everyone in the conversation can see them.
- **Control room → Automations:** every rule in the office, rules that watch every Space, and the
  setting for webhooks on the office network (below).

## Who can change them

| Rule | Who can add, change, turn on or off, or remove it |
| --- | --- |
| For one conversation | The person who started it, its moderators, and administrators who are in it |
| For every Space (office-wide) | Administrators |

Guests cannot make rules. Administrators see every rule in the Control room but change a
conversation’s rules only if they are in it. Every change is in the Control room’s audit log
(created, changed, turned on or off, removed). A rule acts for its owner: once the owner leaves the
conversation (or, for an office-wide rule, stops being an administrator), it stops running and its
run log says why. Someone who manages the conversation can remove it or save it as their own.

Office-wide rules watch **Spaces** only. Direct conversations are private: only rules made for that
Direct conversation see it, and its end-to-end encrypted text is never read by the hub (a keyword
or mention rule cannot match it; a rule about files still can).

## Triggers

| Trigger | Runs when | Options |
| --- | --- | --- |
| A file is attached | A new message has a file | File types (pdf, dwg, xlsx…), a name pattern (`GA-*`, or a word in the name) |
| Someone reacts | A reaction is added to a message | The reaction (an emoji or an office emoji such as `:approved:`); only on messages written by some people |
| A vote, form answer or Decision | Someone votes in a poll, answers a form, or reaches the end of their path through a Decision (`response.confirmed`) | Polls, forms, Decisions or all; only one choice (for a form, the answer to its first multiple-choice question; for a Decision, the option that closed it, or the option before a written answer) |
| A message has these words | A new message has any of the words (whole words, any capitals) or matches a regular expression | Words separated by commas, or a pattern; capitals must match |
| Someone is mentioned | A new message mentions one of the people, or anyone in a group | People and groups |

Voting again for the same choice does not run a rule twice; changing a vote to a new choice does.
Regular expressions are checked before they are saved: patterns longer than 200 characters,
back-references, look-arounds and repeated groups that themselves repeat or branch (the shapes
that can take a very long time) are refused, and only the first 4,000 characters of a message are
checked.

## Conditions

| Condition | Holds when |
| --- | --- |
| Only in these conversations | It happened in one of the chosen Spaces (useful for office-wide rules) |
| Only when it is these people | Whoever wrote, reacted or answered is one of the people or groups (or, with “leave these people out”, is not) |
| Only at these times | On the chosen days between two times on the hub’s clock (the same time twice means all day), or outside them |
| Only these files | An attached file has one of the types, or a name like the pattern |

A **group** is a department from **Control room → Organisation**, with the departments under it.

## Steps

| Step | What it does |
| --- | --- |
| Read the PDF title block | Reads the attached PDF on the hub and finds the drawing title, revision and number (see below) |
| Notify people | A Direct message from the Dexterity Connect system bot, with a link to the message it is about |
| Post a message | Posts in a Space as **Automations**: the Space where it happened, or another Space |
| Reminder or To do | A reminder on someone’s Desk (due at once or later), or the message kept on their Desk as a To do |
| Tag the message | Adds a #tag, found by #tag search like a tag written in the message (it stays when the message is edited) |
| Call a webhook | POSTs to a web address (see below) |

Steps run in order. If one fails, the steps after it do not run, and the run log says why. People
in a step can be named people, groups, or **who wrote the message**, **who reacted or answered**
and **the rule’s owner**.

### Values steps can use

Messages, reminders and webhook bodies can include `{{values}}`. The editor offers the ones each
step can use.

| Value | Is |
| --- | --- |
| `{{author.name}}`, `{{actor.name}}` | Who wrote the message; who reacted, voted or answered (for a new message, the author) |
| `{{conversation.name}}`, `{{conversation.link}}` | Where it happened |
| `{{message.text}}`, `{{message.link}}` | The message (mentions as names) and a link that opens it |
| `{{file.name}}`, `{{file.type}}`, `{{file.size}}` | The file the rule is about |
| `{{reaction.emoji}}` | The reaction |
| `{{response.choice}}`, `{{response.source}}` | The choice, and `poll` or `form` |
| `{{match.text}}`, `{{match.1}}` … | The matched words, and a pattern’s groups |
| `{{mention.names}}` | The people mentioned that the rule watches for |
| `{{file.title}}`, `{{file.revision}}`, `{{file.number}}`, `{{file.pages}}` | From **Read the PDF title block** |
| `{{webhook.status}}`, `{{webhook.reply}}` | From **Call a webhook**: the reply’s status and its first 1,000 characters |
| `{{rule.name}}`, `{{now.date}}`, `{{now.time}}` | The rule, and the hub’s date and time |

## Reading a drawing’s title block

The hub reads PDFs itself (no outside service). It looks at the text drawn on the first 12 pages,
including title blocks drawn as forms (Form XObjects), compressed pages and fonts with Unicode
maps, and at the document’s information and XMP metadata. It recognises:

- titles after **Title**, **Drawing title**, **Dwg title**, **Sheet title**, **Document title**
  (on the same line, in the next cell, or on up to three lines below);
- revisions after **Rev**, **Rev.**, **Revision**, **Rev No.** (`REV. A`, `Revision: 3`, `Rev B2`,
  `P2`, `C01`), or the latest row of a revision schedule;
- numbers after **Drawing No.**, **Dwg No.**, **Document No.**, **Doc No.**

The title block wins over the metadata; tool names and file names in the metadata (`Layout1`,
`GA-101.dwg`, `Microsoft Word - …`) are not taken as titles. When nothing else gives a revision,
the file name can (`GA-101_RevD.pdf`, `GA-101 Rev 3.pdf`). Encrypted PDFs, scans without a text
layer and text drawn as lines (some CAD fonts) have no text to read; files over 64 MB are not read.

## Webhooks

**Call a webhook** sends a POST to the address. With an empty body it sends everything as JSON:

```json
{
  "rule": { "id": "…", "name": "PDF review" },
  "event": "message.new",
  "summary": "Priya Raman shared GA-101.pdf in Design",
  "conversation": { "id": "…", "name": "Design" },
  "message": { "id": "…", "text": "…", "link": "dexconnect://message/…/…" },
  "author": { "id": "…", "name": "Priya Raman", "account": "dex\\priya" },
  "actor": { "id": "…", "name": "Priya Raman", "account": "dex\\priya" },
  "variables": { "file.title": "GENERAL ARRANGEMENT", "file.revision": "C" }
}
```

A body of your own can use `{{values}}`; when it starts with `{` or `[`, values are escaped so the
body stays valid JSON and it is sent as `application/json`, otherwise as plain text. Each call
carries `X-Dex-Rule: <rule id>`. Calls time out after 8 seconds, bodies are up to 16 KB and only
the first 64 KB of a reply is read. A reply outside 200–299 fails the step.

Calls are guarded so a rule cannot reach places it should not:

- only `http://` and `https://`, never with a user name or password in the address;
- every address the name resolves to is checked, and the connection goes to the checked address;
- **addresses on the office network** (10.x, 172.16–31.x, 192.168.x, 100.64–127.x, this PC,
  `localhost`, `.local`) are refused until an administrator ticks **Control room → Automations →
  Webhooks may call the office network**; office servers may then use their own certificates;
- link-local and cloud metadata addresses (169.254.x, `fe80::`), multicast and other special
  ranges are always refused;
- redirects (up to 3) are checked the same way.

## Limits and safety

- A rule runs at most **30 times a minute**; past that, events are let go and the run log says so
  once a minute.
- Nothing a rule posts, and nothing the system bot says, starts a rule again.
- Up to 6 conditions and 8 steps per rule; up to 50 rules per conversation and 100 office-wide.
- A rule is saved with a revision number. If someone saved a newer revision while you were editing,
  your save is refused and the panel offers theirs.

## Test runs

**Test run** shows what a rule would do without doing it: pick a recent message in the conversation
(a real PDF is read, so you see the title and revision it would find) or give made-up details (a
file name, message text, a reaction or a choice). It says whether the rule would run, why not if
it would not, what each step would do, and the values the steps would see. Nothing is sent, posted,
tagged or called.

## Describe a rule in your own words

Type what should happen, for example:

> When someone uploads a PDF in the design channel, extract its title and revision, then notify
> the document review group.

and **Draft the rule**. The app proposes a rule and draws it; nothing runs until you check it and
choose **Approve and turn on**.

How the draft is made, all on your PC:

1. The words are split into a trigger (“when…”, “if…”, “whenever…”, “as soon as…”), conditions
   (“only…”, “during office hours”, “but only PDFs named like …”) and steps (“then…”, “and notify…”),
   in the order written.
2. Each part is ranked against the kinds of triggers, conditions and steps by keyword cues and by a
   small sentence model, **all-MiniLM-L6-v2** (quantized, 23 MB), which runs in a background worker
   on the ONNX runtime’s WebAssembly build. The model ships with the app and loads the first time
   you use the box; nothing is sent anywhere.
3. The details are found and resolved against your office: Spaces (“the design channel” → Design),
   people (“Ravi”, “@priya”, “me”) and groups (“the document review group”), file types, reactions
   (“a thumbs up”, ✅, `:approved:`), quoted words and `/patterns/`, times (“office hours”,
   “weekends”, “between 9 and 6 on weekdays”, “after 7pm”), due times (“in 2 hours”, “tomorrow”),
   #tags and web addresses.

Each box shows how sure the draft is. Parts it is unsure of, or could not fill (a Space or group
that does not exist, a missing reaction or address), get an amber revision cloud and a note saying
what to fill in; the rule cannot be approved until the missing parts are filled. If the model cannot load on a PC,
drafting carries on with the keyword cues alone and says so.

## For developers

- Rule format, checks and helpers: `packages/core/src/flows.ts` (operations `flow.list`,
  `flow.save`, `flow.enable`, `flow.delete`, `flow.runs`, `flow.test`, `admin.flows.settings`;
  events `flow.updated`, `flow.removed`, `flow.ran`).
- The drafter: `packages/core/src/flow-describe.ts` (`draftFlow(text, context, ranker?)`).
- The engine: `apps/hub/src/flows.ts`; PDF reading: `apps/hub/src/pdf.ts`; guarded calls:
  `apps/hub/src/safe-fetch.ts`. Messaging reports new messages, reactions and confirmed responses
  through `Messaging.observe`.
- The panel: `apps/desktop/src/renderer/flows/`; the model is copied into the app by
  `flowModelAssets` in `apps/desktop/vite.config.ts` from `apps/desktop/assets/models/all-MiniLM-L6-v2`.
