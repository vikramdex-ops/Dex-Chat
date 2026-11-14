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

## 4. Links that open Dexterity Connect

| Link | Opens |
| --- | --- |
| `dexconnect://conversation/<id>` | A conversation |
| `dexconnect://message/<conversation id>/<message id>` | One message (shown as a preview card in messages; *Copy link* on a message makes one) |
| `dexconnect://people/<user id>` | Someone's profile in the Directory |
| `dexconnect://desk`, `dexconnect://calendar`, `dexconnect://settings` | Those screens |

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
