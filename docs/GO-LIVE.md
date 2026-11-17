# Going live: what the office has to do

> For the setup itself, click by click, use [OFFICE-SETUP.md](OFFICE-SETUP.md) (or `Dexterity-Connect-Office-Setup.pdf`). This page is the wider checklist.

The app is built and tested on the development machine. These steps need a person, an office PC, an
account or a decision, so they cannot be done from here. Do them in this order. Each step says
where it happens and how to tell it worked.

Times are rough. Steps 1 to 4 are needed before anyone else installs the app; the rest can follow
in the first week.

## 1. Build the first release (about 1 hour, once)

On an office Windows PC that will build releases, following [RELEASING.md](RELEASING.md):

1. Install **Node.js 22 LTS** and **Git**, and clone the repository onto a drive other than C:
   (for example `D:\Dexterity\Dex-Chat`).
2. For the Android app: install **JDK 21** and the **Android SDK**, and set `ANDROID_HOME`.
   Without them the release has no APK.
3. For publishing: install the **GitHub CLI** and run `gh auth login` with the account that owns
   `dexterity-admin/dexterity-connect`.
4. Make sure `main` holds the finished work: it is merged from the development branch through a
   pull request. A build from any other branch is published on the **beta** channel. Check out
   `main`. In `scripts\release`, double-click **Build-Release.cmd**. The installers land in
   `D:\DexterityConnect-Releases\<version>`.
5. Install the Windows setup from that folder on one PC and open it. If it starts, run
   `Build-Release.cmd -Publish -Version <that version> -SkipTests`.

**Worked when:** the landing page's **Download for Windows** button gets the new installer, and
the release page lists `SHA256SUMS.txt`.

**Know:**

- The build script has never run on a real Windows PC. If it stops, it says at which step; send
  that message to whoever maintains the repository.
- Windows SmartScreen will say "Windows protected your PC" on first install, because the
  installers are not code-signed. Choose **More info → Run anyway**. A code-signing certificate
  (about US$200–400 a year) removes this.
- macOS installers can only be built on a Mac (commands in RELEASING.md). There is no iPhone app.

## 2. Install the office hub (about 15 minutes, once)

1. Choose one PC that stays on all the time, on the office network, with a second disk or a NAS
   for backups.
2. Extract the hub zip from the release (for example to `D:\Dexterity Connect Hub`). Double-click
   **Install-Hub.cmd** as an administrator. This installs the Windows service, opens its firewall
   ports and starts it:
   - TCP 47900: connections;
   - UDP 47901: discovery;
   - TCP and UDP 47910–47999: large Rooms.
3. If the office has more than one network segment (VLANs, a separate Wi-Fi), make sure those
   ports reach the hub PC. Note the hub PC's IP address: anyone the automatic search cannot reach
   types it in **Enter the hub address yourself**.

**Worked when:** Services shows **Dexterity Connect Hub** as Running.

## 3. Become the owner, then let people in (10 minutes, then ongoing)

1. On your own PC, install the app, open it, pick the hub and click **Request access**. The first
   person to join becomes the **owner**.
2. Everyone else installs and opens the app. Approve each in **Control room → 01 Approvals**,
   checking that the 8-character device code matches what they read out.
3. In **03 People & roles**, choose who runs the office. The office can have several owners and
   always keeps at least one.
   - **Owner**: configures everything, and chooses the administrators and the other owners.
     Pick **Owner** for a person and confirm **Make owner** (for example, two people from
     management).
   - **Admin**: configures everything except who the owners and administrators are (for example,
     two people from IT). Also add IT to the **IT desk** at the top of the same page.
   - **To hand over**: once someone else is an owner, pick **Admin** on your own row and confirm
     **Step down**.

## Handing the office over

Everything set in the Control room belongs to the office, not to the person who entered it:

- the gateway and Meet addresses, and the call (TURN) keys;
- backups, policies, Nib, holidays, notice desks, the seating plan and integrations.

Making someone an owner or administrator, stepping down, or offboarding the person who set it all
up changes none of it. The new owners find it working, with nothing to re-enter. A test checks this
(`apps/hub/test/handover.test.ts`).

A few things live outside the app, in accounts. Create these with an office email address (for
example an IT mailbox), not a personal one, so handing over means sharing that login:

- the Cloudflare account that runs the gateway and the Meet site. Its API token is never stored;
  it is only needed to deploy again;
- the GitHub accounts that hold the source and publish the releases and this landing page;
- the hub PC's Windows login, and the backup share's permissions.

## The office's defaults, set by the hub on its first start

A new hub sets these itself, once (`apps/hub/src/firstrun.ts`); nobody has to:

- **Nib & day sheets**: start of day 09:45, wrap-up 18:00, register 18:30, follow-up 19:00,
  Monday to Saturday, day sheets private, no job codes, nobody receiving the register yet;
- **Notice desks**: Admin, HR, IT and Management, with no issuers (administrators issue for them);
- **Policies**: their defaults apply without anyone opening Policies; the audit log is always on;
- **Backups**: a folder on a second disk of the hub PC, made private, at 02:00, with a first backup
  checked at once, only when such a disk is there (section 4).

Each is applied once and never again, so whatever an administrator changes stays changed, and a hub
upgraded from an older version keeps its settings.

## 4. Backups (5 minutes, do this on day one)

**Control room → 16 Backups & leavers → Backups** ([BACKUP.md](BACKUP.md)).

If the hub PC has a second internal disk with room, the hub has already chosen
`<drive>:\DexConnectBackup`, made it private and backed up to it: the sheet says **Chosen by the hub
on its first start**, and steps 1 to 3 are done. If it says **Backups need a second disk or a network
share**, the hub found only one disk (or only another part of the same disk) and chose nothing:

1. Set the **backup folder** on a different disk or a network share (`\\NAS\backups\dexconnect`),
   never the hub's own disk. For a share, give the hub PC's computer account
   (`DEXTERITY\HUB-PC$`) write access, or run the service as an account that has it.
2. Keep the folder readable by administrators only: each copy holds every message and the hub's key.
3. Click **Back up now**. The page should show the copy and its size.
4. Once, in the first month, try a restore on a spare PC (BACKUP.md, "Restoring"), so you know it
   works before you need it.

## 5. Tell the app about the office (about 1 hour)

All of these are in the **Control room**, reached from your tile at the top right.

| Where | What to set |
| --- | --- |
| **04 Organisation** | Departments, who reports to whom, titles and locations. Lines (the org chart) is drawn from this. |
| **04 Organisation → Office managers** | The people who may move seats (administrators can already). |
| **03 People & roles → IT desk** | The IT people who get Help me requests and run support sessions. |
| **Notice desks** | The issuing desks (Admin, HR, IT, Management) and who issues for each. |
| **13 Bots & tools → Office holidays** | This year's holidays. Nib, scheduled bot jobs and hot-desk booking skip them. |
| **14 Nib & day sheets** | 01 the activity givers (**Add the department heads** fills it); 02 who receives the management register; 03 times and workdays (defaults 09:45, 18:00, 18:30, 19:00, Mon–Sat); 04 the job codes, one per line (`P-12 Refinery revamp`), and whether day sheets are private (default) or open. Then **Send me a register now** to see it before the first evening. |
| **08 Policies** | Read the defaults once: the edit window, upload limit, call recording, meetings, PC-to-PC fallback. |
| **05 Guests**, **06 Compliance** | Who may invite guests; retention and legal holds, if the office has rules for them. |

## 6. Seating (30 minutes)

[SEATING.md](SEATING.md). The real floor plan (153 seats, from the 18-Jul-2026 drawing) is already
in the app. The names on the drawing are **not** in the repository, because they are personal data.

1. **Directory → Org chart → Floor → Arrange → Import.** Open the CSV of seat and name pairs read
   from the drawing (kept outside the repository and handed over separately). Tick the suggested
   matches where only a first name was on the drawing.
2. Check the assumptions the plan makes (SEATING.md, "What was assumed from the drawing"):
   - rename "Room A (unlabelled)";
   - check which MD's cabin is MD-01;
   - check that the top of the sheet is north.
   Fix anything in the **Layout** tab.
3. Set the hot desks. Then use **Apply** for the current arrangement, so it becomes Rev A.

The drawing is not current. When people move, use a **Move plan** (it tells each person once and
walks them there) rather than editing seats one by one.

## 7. Working from outside the office, and Dexterity Meet (about 30 minutes)

[REMOTE-ACCESS.md](REMOTE-ACCESS.md) and [DEXTERITY-MEET.md](DEXTERITY-MEET.md), section 1:

1. Make a free **Cloudflare** account.
2. **My Profile → API Tokens**: create a token from the **Edit Cloudflare Workers** template. Then
   **+ Add more → Account · Cloudflare Pages · Edit**, because the template alone cannot deploy the
   meeting site. Note the **Account ID**.
3. On the build PC, double-click `scripts\release\Deploy-Gateway.cmd`. Paste the token and the
   account ID (they are not saved). It prints two addresses: the gateway and
   `https://dexterity-meet.pages.dev`.
4. In **Control room → 09 Outside the office**:
   - paste the gateway address and **Save address**;
   - switch on **Allow access from outside the office**;
   - under **Meeting site · Dexterity Meet**, paste the meeting site address and **Save address**.
5. Copy the **Fingerprint** from the same page. Run `Deploy-Gateway.cmd -Fingerprint <it>` so the
   gateway only talks to this hub. The page then says *gateway pinned to this hub*.
6. **Calls across networks:** choose **Cloudflare TURN** (Cloudflare → Realtime → TURN Server →
   Create; paste the key id and API token). Without it, some mobile networks cannot make calls.

**Worked when:**

- a phone **on mobile data** (not office Wi-Fi) can send a message;
- a personal meeting link opened on that phone reaches the meeting page and joins a call.

## 8. Phones and home laptops (each person, 2 minutes)

No administrator is needed:

- **Phone:** on the office PC, **Preferences → Your devices → Add my phone**. Scan the QR code with
  the phone; it installs the Android app and signs in.
- **Laptop:** **Add my laptop** shows a code to paste into the app on the laptop.

## 9. The setup check

At the top of the **Control room**, the **Setup check** shows, live from the hub, what it can check
about itself, each as **Pass**, **Failed** or **To do** with the one thing to do:

- the hub service is running, and for how long;
- the database: SQLite's quick check, and every table and column this version needs;
- free space on the hub's disk;
- backups: the destination, the nightly schedule, the last good backup with its size and its check;
- the seating plan, the notice desks, Nib's times and private day sheets, who receives the register;
- the audit log;
- working from outside (the gateway connected and pinned), and the relay for calls.

Things only a person can check are listed **By hand**, with what to do, and are never shown as
passed: two PCs messaging, a call between two PCs, a phone on mobile data, a meeting link with a
guest. **Copy report** and **Download** give the whole check as text, to keep or send.

Other parts of the hub add their own checks with `hub.health.register(id, fn)`
(`apps/hub/src/setupcheck.ts`); they appear on the same sheet.

## 10. Check it on real hardware before telling everyone

These were tested automatically on the development machine but have not yet run for real:

- [ ] `Build-Release.cmd` and `Deploy-Gateway.cmd` on Windows (steps 1 and 7).
- [ ] The hub as a Windows service on the office PC, and `Install-Hub.cmd`'s firewall rules.
- [ ] A real Cloudflare deployment: the gateway, the Pages site, its service binding and the
      token's Pages permission.
- [ ] Two office PCs messaging, a call, a screen share and a Room of 5 or more.
- [ ] An Android phone on mobile data: message, call, the Nib tray and the notice board.
- [ ] A client joining a meeting from a browser on their own network, including Safari or Firefox.
- [ ] Share paths: a link on a mapped drive opens for a colleague who maps that share to a
      different letter.
- [ ] One nightly backup on the chosen disk or share, and one restore on a spare PC.
- [ ] The hub choosing its backup disk on the office PC: the PowerShell disk map, `icacls` on the
      folder, and the amber "needs a second disk" sheet on a one-disk PC.
- [ ] An update: publish a newer build and see an installed app update itself.

## 11. People to ask

- **The user guide:** `docs/Dexterity-Connect-User-Guide.pdf` (Rev 2) says *Approved by: Pending
  approval*. Have the person who signs off documents read it and give their name for that line.
- **Hindi and Tamil:** a native speaker of each should read the app in their language
  (**Preferences → Appearance → Language**) and list any wording to change.
- **Office policies:** confirm with management what the notice board, day sheets and call
  recording should do under the office's own rules (who issues, private or open sheets, whether
  calls may be recorded).

## Optional, later

| What | Why | Cost |
| --- | --- | --- |
| A code-signing certificate | No SmartScreen warning on install | About US$200–400 a year |
| A custom meeting domain (`meet.dexteritydesign.co.in`) | Clean client links (DEXTERITY-MEET.md, "A domain of the office's own") | A DNS record |
| Cloudflare Workers paid plan | Only if the free limits are ever reached | US$5 a month |
| A Mac for macOS builds | For anyone on a Mac | |
