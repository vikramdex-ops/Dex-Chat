# Tool notices: any office tool speaks through Nib

How an office tool (Project Opener, Dexterity Sheets, Hopper, Datum, Sleuth, a script) tells a
person something in Dexterity Connect: a task assigned, a mention, a watcher that fired. One HTTP
call with the tool's integration token; the notice arrives in the person's conversation with Nib.

This page is the whole contract. A tool that follows it needs nothing else from Connect, and
nothing in Connect has to change when a new tool is added.

## Why it works this way

- **Nib is not an integration.** It is part of the hub, with no token, and nothing outside the hub
  can post as it ([`NIB.md`](NIB.md)). So a tool never posts *as* Nib: it asks the hub, and the hub
  writes the line.
- **The tool's name comes first, and the hub writes it.** Every notice through Nib starts with the
  integration's name as an administrator created it (`**Project Opener** · Task`). A tool cannot
  change or leave out that line, so a notice never passes for Nib's own words.
- **The call always has somewhere to go.** If an administrator switched *Notices through Nib* off
  for the integration, or Nib does not write to the person (a guest), the same notice arrives as a
  Direct message from the integration. The tool does not need to know which it was.
- **Made for tools that retry.** A tool that could not tell a timeout from a failure sends the same
  request again; the same `key` for the same person is delivered once.

## Set-up (once per tool)

1. An administrator opens **Control room → Integrations**, types the tool's name and presses
   **Create token**. The page shows the token once, with **Copy settings**:
   `{ "connect": { "enabled": true, "hub": "<host>:47900", "fingerprint": "<SHA-256>", "token": "dxc_…" } }`.
2. The administrator pastes those settings into the tool. A tool should accept that block as it
   is (Project Opener does), so there is nothing to retype.
3. **Notices through Nib** is on for every integration. The switch is on the integration's row;
   changing it is in the audit log as `bot.notices`.

Recipients are Windows sign-ins (`priya.raman` or `DEX\priya.raman`), which the office already
knows from the Directory: nobody links an account, and nobody needs the tool installed to be told.

## The requests

All of them: `https://<hub>:47900`, `Authorization: Bearer <token>`, JSON, office network only
(the hub refuses them through the internet gateway). Trust the hub by the SHA-256 fingerprint of
its certificate, not by a certificate authority: check the fingerprint before sending the token.

### `GET /api/bot/hello` (the tool's Test button)

```json
{ "ok": true, "api": 1,
  "integration": { "id": "…", "name": "Project Opener" },
  "hub": { "id": "…", "name": "Dexterity Mumbai", "version": "0.1.111" },
  "features": ["hello", "notify", "message", "widget", "flows", "sessions"],
  "notices": { "via": "nib", "perMinute": 120, "maxRecipients": 50, "keyDays": 7 } }
```

`401` means the token is unknown or revoked. `404` means the hub is older than this page: use
`POST /api/bot/message` ([`INTEGRATIONS.md`](INTEGRATIONS.md#2-post-notices-bot-api)) until it is
updated.

### `POST /api/bot/notify`

```json
{ "to": ["priya.raman", "DEX\\ravi"],
  "key": "task:01JD3…:assigned",
  "kind": "task",
  "from": "vikram",
  "title": "Check ISO-1001 rev B",
  "text": "Due Friday.",
  "lines": ["3 drawings"],
  "link": { "title": "Open in Project Opener", "url": "projectopener://open/01JD…" },
  "space": "Piping P-12513" }
```

| Field | Meaning |
| --- | --- |
| `to` | Up to 50 Windows sign-ins. A bare name must be one person in the office. |
| `space` | Optional. A Space by name: the notice is also posted there, in the integration's own name (Nib speaks in Spaces only for the office's own news). |
| `key` | Optional, up to 160 characters, yours to choose. The same key for the same person (or Space) is delivered once for 7 days. Make it from the thing that happened (`task:<id>:assigned`), never from the time you sent it. Without a key the same words are not repeated within 10 minutes. |
| `kind` | Optional word after the tool's name: `task`, `mention`, `alert`, `reminder`, `review`, `update`. Anything else is left out. |
| `from` | Optional sign-in of the person who caused it; shown as *from Vikram Shah* when the office knows them. |
| `title` | One line, up to 200 characters, shown bold. |
| `text` | Markdown, up to 2,000 characters. |
| `lines` | Up to 8 list lines of 300 characters. |
| `link` | `{ "title", "url" }` or just the address. Web links and the office tools' own (`https`, `http`, `dexconnect`, `projectopener`, `dexterity`, `sleuth`, `datum`); anything else is left out. Tool links are drawn as cards with **Open in…**. |
| `via` | Optional `"integration"`: send this one in the tool's own name even when Nib is on. |

At least one of `title`, `text`, `lines`, and at least one of `to`, `space`. Up to 64 KB.

The person sees, in their conversation with Nib:

> **Project Opener** · Task · from Vikram Shah
> **Check ISO-1001 rev B**
> Due Friday.
> - 3 drawings
> [Open in Project Opener](projectopener://open/01JD…)

### The answer

```json
{ "ok": true, "api": 1, "delivered": 1, "duplicates": 0, "failed": 0, "unknown": ["nobody"],
  "results": [
    { "to": "priya.raman", "status": "delivered", "via": "nib", "account": "dex\\priya.raman",
      "away": { "back": "2026-11-24", "cover": "dex\\ravi" } },
    { "to": "nobody", "status": "unknown" } ] }
```

| `status` | Meaning | What the tool does |
| --- | --- | --- |
| `delivered` | Written now; `via` says `nib` or `integration`. | Nothing. |
| `duplicate` | This key already reached them. | Nothing: it is a success. |
| `unknown` | Not one person in the office (no such sign-in, an ambiguous bare name, a bot, someone who can no longer sign in), or no such Space. | Do not retry. Show it to whoever set the recipient. |
| `failed` | The hub could not write it. | Send the same request again with the same key. |

`away` is there when the person is on leave today (Nib's leave note): the day they are back and
who covers. The notice is still delivered; the tool can tell the sender.

| HTTP | Meaning | Retry? |
| --- | --- | --- |
| `200` | Read `results`. `ok` is true when at least one was delivered or already had it. | Only if `failed` > 0. |
| `400` | The request is wrong (`error` says how). | No. |
| `401` | Token unknown or revoked. | No; tell the person to check the settings. |
| `403` | Arrived through the internet gateway. | No. |
| `404` | A hub from before tool notices. | Use `/api/bot/message`. |
| `413` | Larger than 64 KB. | No. |
| `429` | More than 120 deliveries in a minute for this integration. Nothing of the request was delivered. `Retry-After` and `retryAfterSec` say when. | Yes, the same request, after that long. |
| `500` | Nothing got through. | Yes, with the same key. |
| no answer | Hub away, network down, timeout. | Yes, with the same key. |

## What a well-behaved tool does

1. **Never waits for Connect.** Its own notification (a toast, an inbox entry) happens first; the
   notice goes from a background thread with a 10 s timeout.
2. **Keeps an outbox.** A notice that got no answer, `429`, `5xx` or `failed` waits on disk and is
   tried again (Project Opener: every 5 minutes, up to 50 times, the oldest dropped beyond 500).
   When the hub is not reachable, the rest of the outbox waits rather than hammering it.
3. **Sends a key.** Without one, a retry after a lost answer could say the same thing twice once
   10 minutes have passed.
4. **Checks the fingerprint before the token is sent**, and sends nothing to a hub showing another
   certificate.
5. **Stores the token as a secret** (Windows DPAPI, a sealed file) and never logs it.
6. **Falls back by itself.** `404` on `/api/bot/notify` means an older hub: post the same words to
   `/api/bot/message`.
7. **Lets each person opt out** of being told through Connect, on their own PC.

Reference clients: `project_opener/lan/connect_bot.py` in Project Opener (Python, standard library
only) and `crates/collab/src/connect.rs` in Dexterity Sheets (Rust, `/api/bot/message`).

## Who is on leave: `GET /api/bot/leave`

A tool that hands work over (Project Opener's Handover) can read Nib's leave note, once an
administrator ticks **Reads leave** on the integration's row in Control room → Integrations. It is
off for every integration until then (`403` with the reason), and the switch is audited as
`bot.leave`.

| Request | Answer |
| --- | --- |
| `GET /api/bot/leave?account=<sign-in>` | `{ "ok": true, "account", "today", "leave": [{ "id", "from", "to", "half", "current", "cover": { "account", "name" } \| null }] }`: that person's leave from today on, oldest first. Never the kind, the note or the handover. `404` when nobody has that sign-in. |
| `GET /api/bot/leave/changes?since=<cursor>` | `{ "ok": true, "cursor", "accounts" }`: whose leave was noted or cancelled after `cursor` (kept 30 days). Without `since`, only the cursor to start from. Poll it, and read `leave` only for the accounts it names (or when the day changes, since `current` does). |

## Edge cases, and what happens

| Case | Result |
| --- | --- |
| The same notice sent twice (retry, two PCs seeing the same event) | One line; the second answer is `duplicate`. |
| A request with five people fails half-way | Sent again with the same key: those who had it are `duplicate`, the rest are delivered. |
| The same person written twice (`priya`, `DEX\priya`) | One line, one result. |
| The person is on leave | Delivered; `away` tells the tool. |
| The person is a guest | Delivered as a Direct message from the integration (`via: "integration"`). |
| The person left the office (cannot sign in) | `unknown`. |
| Day sheets are switched off for the office | Still delivered through Nib: Nib is how the office's own news reaches a person. |
| The administrator switches *Notices through Nib* off | From then on notices arrive from the integration; earlier ones stay where they are. |
| The token is revoked | `401` at once; lines already written stay. |
| A tool floods (a loop, a bug) | `429` after 120 deliveries in a minute, nothing partially delivered. |
| The link is not the web or an office tool (`javascript:`, `file:`) | Left out; the rest is delivered. |
| The tool's text tries to look like Nib | It cannot: the first line is the integration's name, written by the hub. |
| The hub restarts mid-request | The tool got no answer and retries; keys are kept in the hub's database, so nothing is repeated. |
| Outside the office | The Bot API is office-only. A tool on a laptop outside keeps the notice in its outbox until it is back. |

## Inside the hub

`apps/hub/src/toolleave.ts` (the leave reads, the switch in `tool_leave_prefs`, the change cursor in
`nib_leave_changes`; tested in `apps/hub/test/toolleave.test.ts`), `apps/hub/src/toolnotices.ts` (the requests, the keys in `tool_notices`, the switch in
`tool_notice_prefs`, the rate limit), `Nib.toolLine` in `apps/hub/src/nib.ts` (the line in the
conversation with Nib), routed from `botRoute` in `apps/hub/src/hub.ts`. Operations for the
Control room: `admin.bots` (each integration with `viaNib`, `notices` in the last 7 days and
`lastNotice`) and `admin.bots.notices { userId, viaNib }`, `admin.bots.leave { userId, readsLeave }` (and `readsLeave` in `admin.bots`).

**Tests**: `apps/hub/test/toolnotices.test.ts` (hello; a notice through Nib in the tool's name and
once per key; no key; the administrator's switch and the fallback; a Space; someone on leave; every
refusal and the rate limit; the older Bot API unchanged).
