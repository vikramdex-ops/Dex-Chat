# Bots talking to bots, and scheduled bot jobs

A bot in Dexterity Connect can ask another bot a question, hand a request to another bot and get
it back with a result, and act when another bot's request moves. A bot can also do things on a
schedule written in plain words. Both work for members' own bots (the bot maker), the office
templates, Front Office, and the office's own system bots (Nib, the Directory and the office
calendar).

Code: the rules are pure functions in `packages/core/src/botnet.ts` (skills, handoffs, events,
safety) and `packages/core/src/botjobs.ts` (schedules, runs, missed runs); the hub keeps the links
and runs in `apps/hub/src/botnet.ts` and `apps/hub/src/botjobs.ts`; the app draws them in
`apps/desktop/src/renderer/bots/net/` and the bot maker's *Other bots* and *Schedule* parts.

## 1. Concepts

| Word | Meaning |
| --- | --- |
| **Skill** | A named question (or a small errand) a bot answers for other bots, with typed inputs and outputs: "Is a place free?" takes *Which* and gives *Free*, *Of* and *Waiting*. |
| **Ask** | A step of a flow that asks a skill instead of the person. Its answer is used like any answer. |
| **Handoff** | A request handed to another bot with the answers it needs. The other bot asks the person only what is left, and hands back a result. |
| **Event** | Something that happens to a bot's request (sent, reaches a stage, closes) or to a person (goes on leave) that another bot listens for. |
| **Hop** | One message between two bots. Every hop is kept as a link: the relay cards, the network sheet and the audit log read them. |
| **Job** | Something a bot does on a schedule ("every Monday at 10:00"). Every run is stamped RAN, SKIPPED, FAILED or DRY. |

## 2. The skills contract

A skill is published by a bot; nobody writes it by hand. A tracked bot publishes skills from its
own stages, so every office template answers questions without extra work:

| Skill | Question | Inputs | Outputs | Published by |
| --- | --- | --- | --- | --- |
| `<bot>.open` | How many are open? | stage, older (days), person | count, oldest (days), refs | every tracked bot |
| `<bot>.status` | Where is a request? | ref (`PLT-0004`) | stage, who, stamp | every tracked bot |
| `<bot>.seats` | Is a place free? | key (`CAESAR II`) | free, of, waiting | a tracked bot with places (`limit`) |
| `<bot>.release` | Release their places *(an errand)* | person | released, refs | a tracked bot with places |
| `<bot>.sent` | How many were sent? | days | count | a bot that tracks nothing (Front Office's flows, Leave note) |
| `directory.lead` | Who is their lead? | person | lead, department | the Directory |
| `nib.away` | Are they on leave? | person, date | away, back, cover | Nib |
| `nib.awayList` | Who is on leave? | date | count, people | Nib |
| `calendar.workday` | Is it a working day? | date | working, why | the office calendar |

Values are typed (`text`, `number`, `person`, `date`, `yesno`, `list`). The main output is the step's
answer (`{{seat}}` reads "1 free"; its value, for a route, is `1`), and each output is a variable
of its own (`{{seat.free}}`, `{{seat.waiting}}`). `GET` them in the app with `botnet.skills`; the bot
maker shows them as blocks to pick, grouped by the bot that answers, with SYSTEM, OFFICE or YOURS
and DOES IT for an errand.

In a definition:

```json
{ "id": "seat", "label": "CAESAR II seat", "prompt": "Is a CAESAR II seat free?",
  "input": { "kind": "text", "validate": { "type": "number", "integer": true, "min": 0 } },
  "ask": { "skill": "licence-seat.seats", "with": { "key": "CAESAR II" }, "onFail": "ask" },
  "branches": [{ "if": { "equals": "0" }, "goto": "wait" }] }
```

`with` fills the inputs from words or `{{placeholders}}`. The step's own prompt and input are the
fallback: `onFail` is `ask` (ask the person instead, the default), `skip` (carry on with no
answer) or `stop` (end the conversation with the reason). A step that asks a bot is never counted
in "step 2 of 3", and Back goes over it to the person's own step before it.

## 3. Handoffs

A request can be handed on in three places:

- **At the end** (`finish`): `{ "do": "handoff", "to": "plot-room", "carry": { "size": "A3" } }`.
  The other bot starts for the same person with the answers carried. It asks only what is left
  (a confirmation is always the person's), in its own conversation, which starts with "From Iso
  ready: 3 answers carried across."
- **A stage that waits on another bot**: `"who": "bot:plot-room"` with
  `"handoff": { "start": "queue", "carry": { "drawings": "{{drawings}} rev {{rev}}" } }`. When the
  request reaches the stage it is handed over; with `start`, the other bot's request opens at
  that stage (its earlier stages happened here, and are drawn done with "Done before it was
  handed over"). No one acts on the stage meanwhile; its cell in the strip shows the other bot's
  mark and how its request stands, live (`PLT-0004 · Plotting`). When the other request closes,
  the stage's button named in `back.done` (or `back.stopped`) is pressed for it, with the other
  bot's stamp and last note as `{{note}}` (`PLT-0004 · COLLECTED: Rack 3`). Left out, `back.done`
  is the stage's main (`go`) button and `back.stopped` the one that ends it short.
- **A button** of a stage: `"handoff": { "to": "late-work", "carry": { "day": "{{day.value}}" } }`
  on an action. The person pressing it carries on in the other bot (a site visit running late
  hands to the late work bot).

`carry` maps the other bot's step variables to this bot's placeholders; answers with the same
name go across by themselves. Every carried answer is checked again by the other bot as if the
person had written it; one that does not pass is asked again. A handoff that cannot happen
(refused, failed) leaves the stage with the bot's maker (or the person who asked), with its
buttons and a Desk task, and says why.

## 4. Events

```json
"network": {
  "share": "users",
  "accept": true,
  "on": [
    { "id": "issued", "on": "drawing-issue.closed", "stamp": "ISSUED", "do": "tell", "text": "{{ref}} is issued: {{title}}." },
    { "id": "away", "on": "nib.away", "do": "ask", "ask": { "skill": "licence-seat.release", "with": { "person": "{{user.value}}" } } }
  ]
}
```

`on` is `<bot>.opened`, `<bot>.closed` (with `stamp`, only that stamp), `<bot>.stage.<stage id>`
or `nib.away` (someone goes on leave: Nib's leave note, or a bot's Mark me away). `do` is `tell`
(a line to this bot's maker), `start` (this bot for the person the event is about, answers
carried as above) or `ask` (a skill, an errand included, for that person; `text` then tells the
maker the answer with `{{result}}`). Variables: the request's answers, `{{ref}}`, `{{title}}`,
`{{stamp}}`, `{{user}}`; for leave, `{{user}}`, `{{from}}` and `{{to}}`.

These are separate from [Automations](AUTOMATIONS.md): an automation reacts to what happens in one
conversation (a message, a file, a reaction), while a bot's events are its requests' own life,
across conversations. Both use the same "when … then …" words in the app.

## 5. Scheduled jobs

```json
"jobs": [{
  "id": "monday", "title": "Monday chase", "when": "every Monday at 10:00", "missed": "once",
  "do": { "do": "check", "ask": { "skill": "rfi-log.open", "with": { "older": "10" } },
          "if": { "var": "result.count", "gt": 0 }, "tell": "lead",
          "text": "{{result.count}} TQs are older than 10 days: {{result.refs}}." }
}]
```

### The grammar

The schedule is plain English words, read the same way on every PC and on the hub (the app reads
it as it is typed, marks what it understood on the words, and lists the next five runs).

| Written | Understood |
| --- | --- |
| `every weekday at 9:15`, `daily 9am`, `every working day at 09:15` | Every working day at 09:15 |
| `every Monday 10:00`, `every Mon and Thu at 17:30`, `every Friday at 5` | Those days, at those times (`at 5` is 17:00, and it says so) |
| `last working day of the month at 16:00`, `first working day of each month 9:30` | That day of each month |
| `last day of the month at 16:00` | The calendar's last day |
| `1st and 15th`, `on the 5th at 11:00` | Those dates; a date that is a day off moves to the next working day; no time given is 09:30, when the office opens |
| `every 2 hours during office hours`, `every 30 minutes between 10:00 and 12:00`, `every hour during office hours on Saturdays` | From the start of the window, every so often, on working days (or the days named) |
| `tomorrow at 10`, `on 20 Nov at 15:00`, `2026-11-20 at 15:00` | Once (kept as the date it meant) |

Times are `9:15`, `09:15`, `9.15`, `9am`, `5 pm`, `noon`. Up to six times a day, at most every 15
minutes, at least every 12 hours for a window. Times between 21:00 and 08:00 are **quiet hours**
and refused. Everything is in **office time, IST** (UTC+05:30), whatever the PC's own zone. Working
days are Nib's (Control room → Nib); the office's days off come from management's holiday circular,
read by Nib and registered by an administrator ([`HOLIDAYS.md`](HOLIDAYS.md)), and no job runs on one. A
compensatory working day is a working day even on a weekday the office does not normally work.

### What a job does

| `do` | |
| --- | --- |
| `start` | Start this bot for people: `people` is `{ "from": "team" }` (the maker's own team), `{ "from": "space", "space": "Piping desk" }`, `{ "from": "department", "department": "Piping" }` (its head or an administrator) or `{ "from": "people", "people": [ids] }`. Someone already answering it is passed over. |
| `register` | Post the bot's register where its register goes (tracked bots). Nothing open: nothing posted. |
| `check` | Ask a skill, and only when `if` holds (on `result` or `result.<output>`) tell `owner`, `lead` (the maker's lead) or `space:<name>` (a Space the maker is in) the `text`. |
| `ask` | Ask a skill and post the answer the same way. |
| `remind` | A Desk reminder for each of the people. |

`leave: false` keeps people on leave in (they are left out by default, and the run says how
many). `missed` is `skip` (the default) or `once`.

### Running safely

- **The clock** is injected (`BotFlows.now`); the scheduler's decisions are `planDue()` in core.
- **Missed runs.** A run more than five minutes late was missed (the hub was off): it is stamped
  SKIPPED ("Missed at 10:00: the hub was off"), or, with `missed: once`, the latest missed run
  runs once when the hub is back (in the morning, if it is back in the quiet hours) and is stamped
  "Caught up".
- **Concurrency.** One run of a job at a time; at most six runs a tick, three per maker; the rest
  run on the next tick, seconds later. A run due at a moment runs once, however often the hub ticks.
- **Pause, Skip next, Move a run** (once, by up to two weeks, to a working day outside the quiet
  hours), **Run now** (not in the quiet hours) and **Dry run** (what it would do, with nothing
  sent, stamped DRY) are on the job sheet for the bot's maker and administrators. A paused bot's
  jobs wait with it.
- **Failures** are stamped FAILED with the reason, and the maker hears once a day per job, from the bot.
- **History**: `botjob.history`, the job sheet, and the audit log (`botjob.ran`, `botjob.skipped`,
  `botjob.failed`, `botjob.dry`, `botjob.paused`, `botjob.skipnext`, `botjob.moved`, `botjob.runnow`,
  `botjob.dryrun`, `botjob.holidays`).

## 6. Safety rules

- **Who may ask whom.** A bot asks the skills of bots its maker may use (their own, a Space's they
  are in, office-wide ones), plus the system's. Someone else's private bot is never asked; a bot
  with `"share": "owner"` answers only its own maker's bots. Handoffs go only to bots both the
  maker and the person may use, that take them (`"accept": false` refuses). Listening needs the
  same; the maker of a listening bot hears only about requests they could open anyway.
- **Errands** (`effect: act`, such as releasing seats) are done only for the person the run is
  for, unless the asking bot's maker made the other bot too, or is an administrator.
- **No data leaks.** A skill's numbers are for anyone who may ask it; which requests they are
  (`refs`) only those the person may see. Event hops are kept off people's relay cards. Makers see
  their bots' exchanges on the network sheet without names; administrators see who.
- **Loops and depth.** Each run and request carries the bots it came through; a hop back to one of
  them is stopped ("Stopped a loop: Ping already had this request (ping-bot → pong-bot →
  ping-bot)"), and a request passes through four bots at most.
- **Rate limits.** A bot asks at most 30 times a minute (15 for one person), hands over at most 10
  times a minute (4 to one bot for one person), and acts on at most 40 events a minute.
- **Time limits.** A skill answers within 3 seconds, or the hop is NO ANSWER and the flow falls back.
- **Idempotency.** Every hop has a key (the run and step, the request and stage and round, the
  event); a second attempt returns the first hop. A job's run at a moment happens once.
- **Saving checks it.** A bot that asks, hands to or listens to a bot its maker may not use cannot
  be saved ("“ravi-seat.seats” is not a skill your bots can ask").
- **Audit.** Every hop is in the audit log as `botnet.query`, `botnet.handoff` or `botnet.event`,
  with its status (`ok`, `returned`, `refused`, `failed`, `timeout`, `loop`, `limited`) and reason.
- **Encryption.** Bots are not end-to-end encrypted, here as everywhere: a bot conversation says
  so once in its Details, and the bot maker's *Other bots* part says it again.

## 7. What people see

- **The relay card.** When a bot asks or hands over for someone, their conversation with the bot
  shows the bots as instrument tags (the ISA bubbles of the Meet page's readiness tags: letters
  above the bar, `B-01` below) on a small loop diagram. A pulse runs along the line and back as
  the question is answered, or the request is handed over and comes back; each hop is labelled
  (`SEAT? · CAESAR II → 1 free`) and stamped (ANSWERED, HANDED, BACK, REFUSED, STOPPED, NO ANSWER).
  Under the drawing the hops are a ruled schedule (what screen readers read), with **Ask again**
  for a failed question and **Open Plot room** for a handoff. Reduced motion: no pulse.
- **The stage strip.** A stage that waits on another bot carries that bot's mark and its
  request's number and stage, with a live dot while it is open there.
- **The bot network sheet** (Desk → Bots → Bot network, for one's own bots; Control room → Bots &
  tools → Bot network, the office's): every bot as a tag on a drawing with a frame and grid
  references; asks as data links (a line with small circles), handoffs as solid lines with
  arrows, listening as dash-dot lines, each as heavy as the week's traffic, with the count and an
  amber flag for failures. Messages pulse along their line as they pass. Picking a line (on the
  drawing or in the list under it) shows its recent exchanges and failures.
- **The job sheet** (Desk → Bots → Job sheet; a bot's page → Jobs; Control room → Bots & tools →
  Job sheet): a time ruler in office time, Today, This week or This month, each job its own lane;
  days off hatched, NOW an amber line, the next run filled with its countdown, past runs stamped.
  Hovering or focusing a run shows what it did. Pause, Skip next, Move a run, Dry run, Run now.
- **The bot maker**: *Questions → Ask a bot* (skill blocks; *If it cannot answer*: ask the person
  instead, carry on without it, or stop; *Make it a plain question* takes the bot away), *At the end → Hand to a bot* (with
  what it carries across), *Afterwards → Who acts → Another bot carries it on*, *Other bots*
  (its skills, who may ask it, whether it takes handoffs, what it listens for, the bots it works
  with) and *Schedule* (jobs in plain words with the next five runs). The test run asks other
  bots for real as the maker (an errand is only described) and shows the relay card. The JSON
  in *Advanced* follows every change.

## 8. Templates

- **Weekly TQ chaser** (`tq-chaser`): its question asks the TQ bot (`rfi-log.open`) how many
  queries are older than the days given; its job, every Monday at 10:00 (caught up once), tells the
  maker's lead when there are any.
- **Friday timesheet** (`friday-timesheet`): every Friday at 17:00 it starts for the maker's team
  (people on leave left out); its "Who is your lead?" step asks the Directory, and the hours go to
  that lead.

## 9. Operations

| Operation | Who | What |
| --- | --- | --- |
| `botnet.skills { flow? }` | members | the skills this person's bots may ask |
| `botnet.try { skill, with? }` | members | ask a skill now as yourself (the test run; errands described) |
| `botnet.retry { hopId }` | the person it was for | ask a failed hop again; the flow carries on |
| `botnet.map { scope }` | members (`office`: administrators) | the network sheet |
| `botnet.edge { from, to }` | the makers of either bot, administrators | recent exchanges along a line |
| `botjob.sheet { scope, flow?, from?, to? }` | members (`office`: administrators) | the job sheet's lanes |
| `botjob.set { flow, job, paused?, skipNext?, unskip?, move? }` | the bot's maker, administrators | pause, skip the next run, move one run |
| `botjob.run { flow, job, dry? }` | the bot's maker, administrators | run now, or a dry run |
| `botjob.history { flow, job }` | the bot's maker, administrators | the runs, newest first |
| `botjob.calendar` | members | working days, days off, compensatory working days, every day with its kind and source, the circulars registered, the office's zone |
| `admin.botjob.holidays { holidays }` | administrators | the office's days (date, name, kind); unchanged days keep their source |

Events: `botnet.pulse { from, to, kind, status, at }` (to administrators and both bots' makers)
and `botjob.changed { flow, job }`.
