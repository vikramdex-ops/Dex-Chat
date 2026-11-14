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
| `dexconnect://people/<user id>` | Someone's profile in the Directory |
| `dexconnect://desk`, `dexconnect://calendar`, `dexconnect://settings` | Those screens |

## What each tool does today

| Tool | Into Dexterity Connect | From Dexterity Connect |
| --- | --- | --- |
| Hopper | File alerts and link notices through the Bot API | — |
| Slate | — | Notes open in Slate and saves come back; text, CSV and log files open in Slate |
| Project Opener, Sleuth, Datum, Dexterity Sheets | Share to Dexterity Connect (see each tool's notes) | Recognised references in messages open in the tool |
