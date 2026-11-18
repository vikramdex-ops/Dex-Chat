# Dexterity Connect: what you still do by hand

Everything that can happen on its own now does. This page lists only what needs a person: the hardware, your
own accounts, decisions, and the checks that need a second device. Each step says where, and how to tell it
worked.

## Already done for you

You do **not** need to do any of the following. Each is set up automatically, once, and never overwrites a change
you make later.

- **The server.** `DexterityConnectHub-Setup.exe` does all of this:
  - checks the PC;
  - installs the background service, which starts with the PC and restarts itself if it stops;
  - opens the firewall;
  - stops the PC sleeping;
  - checks that the server answers.

  After that the server updates itself (at 03:00, after the backup, never during a meeting): nothing to run.
- **Backups.** On first start the server looks for a second disk:
  - if it finds one, it makes a private backup folder, schedules 02:00 nightly backups (keeping 14 daily, 8 weekly
    and 12 monthly), runs the first backup and checks it;
  - if there is no safe second disk, it says so in the Setup check (step 3).
- **Seating.** The office floor plan with the 40 names from the drawing is there from the start. People take their
  seat automatically when they join and their name clearly matches. You only confirm the few that are unclear.
- **Holidays.** 2026's days off, from circular HRD/CIR/2026/011, are registered:
  - holidays, week-offs and compensatory offs are days off;
  - compensatory working days are working days.
- **Nib.** Start of day 09:45, wrap-up 18:00, register 18:30, follow-up 19:00, Monday to Saturday, day sheets
  private. Nib reminds people three times before the register: 18:00, 18:11 and 18:22.
- **Notice desks.** Admin, HR, IT and Management.
- **Policies.** The standard policies apply.
- **Audit log.** Always on.
- **Remote access and Dexterity Meet.** You paste one Cloudflare token (step 4). The server then:
  - deploys the gateway and the meeting site;
  - pins the gateway to itself;
  - creates the call relay;
  - turns on access from outside;
  - checks it all.
- **Zoho Calendar.** Ready for everyone once the office's Zoho app is registered (step 5). Each person then
  connects their own calendar.
- **The final checks.** A live **Setup check** at the top of the Control room replaces the old checklist.

---

## 1. The server PC (physical setup)

1. Put the server PC where it stays: on mains power, on the office network (a cable is best).
2. **For automatic backups:** fit a second internal disk, or have a network share (NAS) ready. A second part of the
   same disk is not enough: if that disk fails, the backup goes with it.
3. **Ask whoever manages the office router** to give this PC a fixed address (a *DHCP reservation*).
4. On the server PC:
   1. Download <https://github.com/dexterity-admin/dexterity-connect/releases/latest/download/DexterityConnectHub-Setup.exe>
      and run it.
   2. Click **Yes** when Windows asks for permission.
   3. Click through the pages; the defaults are right.
   4. If Windows says "Windows protected your PC", click **More info → Run anyway**.

**It worked when** the last page says **The hub is running** and shows the PC's address. If it fails, the
message gives the reason and the log file's location.

## 2. Your PC: become the owner

1. Download <https://github.com/dexterity-admin/dexterity-connect/releases/latest/download/DexterityConnect-Setup.exe>
   and install it.
2. Type your name, pick the office hub (shown with **Secure**), and click **Request access**.
3. You are the first, so you are the **owner**.

Stay the owner until everything below is done and checked (step 9 is the hand-over).

## 3. Look at the Setup check

Click your picture (top right) → **Control room**. The **Setup check** at the top lists what is passed and what
is left, each with the one thing to do.

- **Copy report** and **Download** give it as text.
- **Check again** refreshes it after you fix something.

What you will probably see there:

| Setup check says | What to do |
| --- | --- |
| **Backups need a second disk or a network share** | Fit a second disk and restart the server PC (it looks again on every start). Or enter a network share in **Control room → 16 Backups & leavers → Backups → Backup folder**, and give the server PC's computer account (`DOMAIN\SERVER-PC$`) write access to it. |
| **Working from outside is not set up** | Step 4. |
| **Zoho Calendar is not set up for the office** | Step 5. |
| **Nobody receives the evening register** | A decision for later (step 7). |
| **Names to confirm on the floor plan** | Step 7. |
| Four rows marked **By hand** | Step 8. |

## 4. Working from outside, and Dexterity Meet links (about 10 minutes)

This is your Cloudflare account, so these steps are yours.

1. **Make the account:** go to <https://dash.cloudflare.com/sign-up>, sign up with the **office email address**
   (not a personal one), and click the link in Cloudflare's email. The free plan is enough.
2. **Make the token:** in the app, open **Control room → 09 Outside the office**. The first card is **Set up with
   Cloudflare**.
   1. Click **Open the token form**. Cloudflare's token page opens with three permissions already filled in.
   2. Add one more yourself: **+ Add more → Account → Cloudflare Realtime** (it may be called **Calls**) **→
      Edit**. This one is for calls from outside.
   3. Click **Continue to summary → Create Token → Copy**.
3. **Paste it once:**
   1. Paste the token into the card.
   2. Tick **Keep it on the hub for gateway updates**, so later updates are one click.
   3. Click **Set up**.

   The card ticks off each step. If one stops, it says why (for example a missing permission): fix that on the same
   token in Cloudflare, then click **Retry**.

**It worked when** the card shows the gateway, the meeting site and **Calls: Cloudflare TURN**, and the status
says **gateway pinned to this hub**. Your meeting links then look like
`https://dexterity-meet.pages.dev/p12-design-review`.

*Optional, any time later: an office domain for meeting links* (`meet.dexteritydesign.co.in`).

1. In Cloudflare, go to **Workers & Pages → dexterity-meet → Custom domains → Set up a custom domain**.
2. If the domain's DNS is elsewhere (GoDaddy, BigRock…), add the one **CNAME** record Cloudflare shows there.
3. When the domain shows **Active**, enter it in **Control room → 09 Outside the office → Meeting site address**.

## 5. Zoho Calendar for the office (one form, about 5 minutes)

Zoho only lets an app read a person's calendar through an app registered by a Zoho account. You register it once
for the whole office; nobody registers anything per person.

1. Sign in at <https://api-console.zoho.in> with the office's Zoho account.
2. Click **Add Client → Server-based Applications**, and fill in:
   - **Client Name:** `Dexterity Connect`
   - **Homepage URL:** `https://www.dexteritydesign.co.in`
   - **Authorized Redirect URIs:** `http://127.0.0.1:47917/zoho/callback`, exactly as written.

   The same address is shown with a **Copy** button in the app.
3. Click **Create**. Zoho shows a **Client ID** and **Client Secret**.
   - If any colleague's Zoho account is in another region, turn on **Multi-DC** in the client's settings.
4. In the app, open **Control room → 11 Integrations → Zoho Calendar**:
   1. Leave **India**.
   2. Paste the **Client ID** and **Client Secret**.
   3. Click **Save and invite everyone**.

**It worked when** the Setup check shows **Zoho Calendar is ready for everyone**, and the people list in that form
fills up as colleagues connect.

**If Zoho refuses the redirect address in step 2,** tell IT. The app then needs a small change to send Zoho
through the office gateway instead.

## 6. Bring people in

**Each person's PC:**

1. They install the app from the second link in step 2, type their name and click **Request access**.
2. In **Control room → 01 Approvals** you see a code: ask them to read out the one on their screen, and click
   **Approve** if it matches.

Their seat is given automatically if their name matches the drawing.

**Phones and home laptops (each person does this; no administrator needed):** **Preferences → Your devices →
Add my phone** (scan the QR code) or **Add my laptop** (a code to paste).

**Zoho Calendar (each person does this):** they click **Connect Zoho Calendar**:

- where it appears: in their Calendar or in **Preferences → Calendar**;
- what happens: they sign in to Zoho in the browser, then see **Connected as … · last synced …**;
- what they need from you: nothing.

## 7. Decisions, whenever you are ready

None of these blocks anything; the office works without them.

| Decision | Where |
| --- | --- |
| Who receives Nib's evening register (directors, managers) | **Control room → 14 Nib & day sheets → 02 Management** |
| Who hands out work and the job codes | **14 Nib & day sheets → 01 Activity givers** (**Add the department heads**) and **04 Job codes** |
| Who issues notices for each desk | **15 Notice desks → Add an issuer…** |
| Names the server could not match for certain | **Directory → Org chart → Floor → Arrange → Waiting to be matched → Confirm** |
| Departments, managers, rooms, more employee details (later, for company-wide use) | **04 Organisation → Import people → Template** (a CSV from Excel) |
| Anything in the policies | **08 Policies** |

**Every year:** when management issues the next holiday circular, drop the PDF into your conversation with Nib.

1. Check any rows Nib marks in doubt.
2. Click **Register**.

The same file twice changes nothing, and a revised circular shows what changed.

## 8. The checks only a person can do

These are listed as **By hand** in the Setup check, and are never marked passed by themselves.

- [ ] Two PCs message each other, and a call between them works.
- [ ] A phone on **mobile data** (Wi-Fi off) sends a message.
- [ ] A meeting link opened on that phone reaches the meeting page, and a test guest joins from the lobby.
- [ ] A call from outside the office has sound and video both ways.
- [ ] **On the first real Cloudflare run:** every step in the card ticked, and the status says **gateway pinned to
      this hub**.
- [ ] **On the first real Zoho connection:** a test meeting appears in that person's Zoho Calendar at the right
      time, and moving it in Dexterity Connect moves it in Zoho.
- [ ] After the first working evening: the management received Nib's register.

## 9. Hand over (only when everything above is done)

1. In **Control room → 03 People & roles**:
   - management users: **Role → Owner**, confirm **Make owner**;
   - IT users: **Role → Admin**, and add them at the top under **IT desk → Add someone to the IT desk…**.
2. Check that they can open the Control room.
3. On your own row: **Role → Admin**, confirm **Step down**.

Every setting, seat, backup and connection stays as it is.

Then hand over the accounts that live outside the app:

- the Cloudflare login (office email);
- the Zoho account that owns the client;
- the GitHub accounts;
- the server PC's Windows login.

---

### If something goes wrong

| What you see | What to do |
| --- | --- |
| Setup on the server says a port is in use | It names the program using it. Close or uninstall that program, then run setup again. Running it again is always safe. |
| The app keeps looking for the office hub | Check the PC is on the office network, not guest Wi-Fi. Click **Enter the hub address yourself** and type the server's address (step 1). |
| A phone keeps saying **Reaching the office hub…** | The phone joined before step 4, so it only knows the office network's address, and the office Wi-Fi is a separate network from the PCs' cable. On your PC: **Preferences → Your devices → Add my phone**. On the phone, tap **Scan a new code** (or **Choose a different hub**) and scan it. Nothing on the phone is lost, and from then on it uses the office network when it can and the way in from outside when it cannot. |
| A PC on another floor or Wi-Fi cannot find the hub | Ask whoever manages the network to let it reach the server on TCP 47900, UDP 47901 and TCP/UDP 47910–47999. |
| **Set up with Cloudflare** stops at a step | Read the reason on the card, fix it on the same token in Cloudflare, then **Retry**. |
| Someone's Zoho shows **Reconnect Zoho Calendar** | They click it and sign in again; nothing is duplicated. |
| Nib marks a holiday row in doubt | Check it against the circular. Rows in doubt are never registered by themselves. |

Details for IT: [RELEASING.md](RELEASING.md) (the hub setup), [BACKUP.md](BACKUP.md), [SEATING.md](SEATING.md),
[HOLIDAYS.md](HOLIDAYS.md), [ZOHO-CALENDAR.md](ZOHO-CALENDAR.md), [REMOTE-ACCESS.md](REMOTE-ACCESS.md).
