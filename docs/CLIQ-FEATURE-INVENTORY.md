# Zoho Cliq feature inventory (2025–2026, non-AI)

Researched from Zoho's public help centre, changelog and admin guides on 2026-11-14. It is a capability
reference only: no Zoho code, assets or UI are used in Dexterity Connect.

Tags: **[LAN]** fully offline on a LAN · **[SRV]** offline, but needs a self-hosted component (SFU, recorder,
search or OCR engine) · **[NET]** needs the internet or a third-party cloud · **[AI]** excluded

## 1. Messaging and composer
- Formatting: `*bold*` `_italic_` `~strike~` `__underline__` `` `quote` `` `!blockquote` ```` ```code``` ````, `#`–`######` headings, `---` rule, `[text](url)`, bulleted and numbered lists (Tab nests), an M↓ cheat-sheet, and Ctrl+Z to undo auto-format [LAN]
- Selection pop-up toolbar, code-snippet sharing with syntax highlighting, Enter / Shift+Enter send behaviour [LAN]
- Emoji, custom emoji (5,000 per org, 100 per user), stickers, animated emoji [LAN]
- Voice, video and screen-recording messages up to 15 minutes, with playback speed and background effects [LAN]
- 4,000 characters per message; up to 10 edits; admin edit/delete window from 1 minute to 730 days [LAN]
- Link previews (internal [LAN], external [NET]) and Markdown-file preview [LAN]
- Scheduled messages, up to 25 per chat [LAN]
- Mentions: @user, @channel/@all, #channel, an @ button; an admin can block mentioning non-members [LAN]
- Hashtags plus a trends hub [LAN]

## 2. Message actions
- Hover bar: 3 configurable quick reactions, a reaction picker, reply/quote [LAN]
- More menu: select (multi-select), forward (25 at a time, admin can force original-sender info), copy, fork,
  reminder, mark unread, edit, delete (25 at a time), permalink, pin, custom actions [LAN]
- Reply privately to the sender or to mentioned users [LAN]
- Star messages with typed stars and a Starred view [LAN]
- Pin up to 25 per chat, for 1 hour, 1 week or forever [LAN]
- Read receipts (ticks plus per-user read info, can be switched off), last seen after 15 minutes [LAN]
- Report a message to an admin approvals queue; moderators delete with a reason [LAN]

## 3. Conversations and structure
- 1:1, groups (up to 500), bots, a system bot; convert a group into a channel [LAN]
- Threads: auto-follow, close (permission-gated), all-threads list, thread vs inline reply mode [LAN]
- Chat tabs (pin files, forms, widgets, links, reports) and chat actions on the composer [LAN]
- Mentions & Replies view (30 days), sent messages, per-user call history, chats in common [LAN]
- Pinned chats (100), folders (50), custom sidebar modules, resizable sidebar, sorting, filters [LAN]

## 4. Channels
- Types: organization, team, personal (private), external [LAN] / external across companies [NET]
- Roles: super admin, admin, moderator, member, bot (100 admins and 100 moderators per channel) [LAN]
- Per-role permission matrix and default permissions per channel type [LAN]
- Join/leave notices, meeting-chat placement, archive, recommendations, announcement-only channels [LAN]
- Networks (separate partner workspaces); guests and client users scoped to the channels they are invited to [LAN]

## 5. Presence and status
- Available, away, busy (silent), invisible, DND (with a duration or a schedule), idle/offline [LAN]
- Automatic "on a call" / "in a meeting"; leave status from HR [LAN]
- Custom statuses (icon and text); admin-managed status catalogue [LAN]
- Out-of-office auto-responder with a delegate and alerts when you are mentioned [LAN]
- Busylight hardware sync [LAN through a local USB bridge]

## 6. Notifications
- Global on/off; sounds for all, 1:1 only or mentions only; custom sounds per chat type [LAN]
- Per-chat mute, "mute 1 hour" from the toast, global sound mute (Ctrl+Shift+M) [LAN]
- Admin default notification settings; per-bot preferences [LAN]
- Mobile push through APNs/FCM [NET]

## 7. Productivity
- Reminders: on a message or standalone, for yourself or others (up to 10), recurring [LAN]
- Polls: up to 7 days, CSV export, edit alerts [LAN] · Forms: builder, file fields, QR codes [LAN] · Shared notes [LAN]
- Calendar and events: time zones, first weekday, room booking [LAN]
- Whiteboard (20 editors) [LAN/SRV] · Collaborative sheets [SRV]
- Remote work: check-in/out timer, default status, managers see reportees' attendance, CSV reports, "Meet Now" [LAN]
- Organization module: directory, departments, designations, custom fields, org chart [LAN]
- Document scanner, image annotation (crop, rotate, mirror, draw) [LAN]

## 8. Files and search
- Any file type, multi-preview, up to 1 GB, peer-to-peer transfer (admin toggle) [LAN]
- Media tab, pan/zoom/rotate viewer, chat side panel while previewing [LAN]
- Ctrl+K search with person, chat, date and type filters, jump to date [SRV: index] · OCR in images [SRV]
- Object-based image search [AI] · Cloud attachments from WorkDrive or Drive [NET]

## 9. Calls and meetings
- 1:1 audio/video, ringtone, recording, screen share, promote to a group call [LAN P2P]
- Group calls and meetings: scheduled, instant or from a channel; lock, host handover, co-hosts [SRV: SFU]
- Screen share with system audio and annotation, slide share, whiteboard, pinned video, PiP, network stats,
  noise cancellation, background blur [SRV / client-side]
- Recording [SRV] · Live events with RTMP [SRV] · Conference-room TV app [SRV]
- Captions and transcripts [AI] · PSTN telephony [NET]

## 10. Personalisation and accessibility
- Light, dark and auto themes; message views (classic, monochrome, bubbles); 14+ languages; date and time formats [LAN]
- WCAG work: font scaling, contrast, spacing, focus rings, keyboard navigation [LAN]

## 11. Keyboard shortcuts (customisable)
- Ctrl+K search · Shift+/ shortcut list · Ctrl+E emoji · Ctrl+B / I / U · Ctrl+Shift+X strike · Ctrl+L link
- Ctrl+Shift+S schedule · ↑ edit last message
- G M mentions · G R reminders · G S starred · G H home
- On a selected message: E edit · F forward · P pin · U unread · C copy · S R reminder
- Ctrl+Shift+F fork · Ctrl+Shift+L copy link · I picture-in-picture [LAN]

## 12. Developer platform
- Bots, slash commands, message actions, widgets, schedulers, a database, incoming webhooks, functions,
  unfurl handlers, a form builder, Deluge scripting, a no-code bot builder, REST API [LAN with a local runtime]
- Third-party integrations [NET], or [LAN] for on-premises tools

## 13. Admin and compliance
- Bulk user import, roles and custom admin privileges, default channels and bots for new users [LAN]
- Policies: IP restrictions, upload limits, P2P file transfer, edit/delete windows, mention restrictions [LAN]
- Retention (90-day minimum), eDiscovery and legal hold, audit trail, DLP, full export (JSON/XML/PDF) [LAN]
- Usage reports, channel management, file cleanup [LAN]

## Windows desktop app (architecture)
- Electron (confirmed by Zoho), distributed through the Microsoft Store and as an MSI, 32 and 64 bit,
  update prompt on restart.
- Desktop-specific features: multiple windows/tabs, multi-account, native Action Center toasts (they respect
  Focus Assist), feedback with logs.
- Gaps users have asked Zoho for: a taskbar unread badge, a 12/24-hour choice, global hotkeys,
  minimise to tray and start minimised. Dexterity Connect includes all of these.

## Main sources
- https://zstatic.zohostatic.com/cliq/whats-new.html
- https://help.zoho.com/portal/en/kb/zoho-cliq/cliq-7-0/user-guides
- https://help.zoho.com/portal/en/kb/zoho-cliq/admin-guides/manage-organization/articles/cliq-limitations
- https://help.zoho.com/portal/en/kb/zoho-cliq/user-guides/conversations/chats/articles/where-can-i-find-a-list-of-keyboard-shortcuts
- https://help.zoho.com/portal/en/kb/zoho-cliq/user-guides/user-panel/statuses/articles/the-different-statuses-in-cliq
- https://help.zoho.com/portal/en/kb/zoho-cliq/admin-guides/data-administration/articles/ediscovery-and-data-retention-policies-in-zoho-cliq
- https://help.zoho.com/portal/en/community/topic/an-important-update-for-zoho-cliq-desktop-users
