# Dexterity Connect: office setup, step by step

Follow this from top to bottom once. Each part says where to do it, and how to check it worked.

**What it ends with:**

- the server running;
- you as owner, with everything configured;
- working from outside the office;
- clean Dexterity Meet links;
- management and IT in charge, and you stepped back.

| Part | Where | Time |
| --- | --- | --- |
| A. The server (office hub) | The server PC | 20 min |
| B. Your app, and becoming the owner | Your own PC | 10 min |
| C. Configure the office | Your PC, in the app's Control room | 45 min |
| D. Working from outside, and Dexterity Meet links | Cloudflare website + your PC | 45 min |
| E. Bring everyone in | Each person's PC and phone | 5 min each |
| F. Hand over to management and IT, and step back | Your PC | 10 min |
| G. Final checks | Office and a phone on mobile data | 15 min |

## Before you start

- [ ] **One server PC** that can stay on day and night. It must be Windows 10 or 11 (64-bit), plugged into the
      office network by cable if possible, with a second disk or a network share (NAS) for backups.
- [ ] **An office email address** that is not anyone's personal one (for example an IT mailbox). You will make the
      Cloudflare account with it, so that whoever looks after the system later can sign in.
- [ ] **The two download links** (they always give the newest version):
  - Office hub (server): <https://github.com/dexterity-admin/dexterity-connect/releases/latest/download/DexterityConnectHub-win-x64.zip>
  - App for Windows (everyone): <https://github.com/dexterity-admin/dexterity-connect/releases/latest/download/DexterityConnect-Setup.exe>
  - The same links are on the landing page: <https://dexterity-admin.github.io/dexterity-connect/#start>

> **The server is not a person.** It does not log in, has no role and is not in the people list. In the app it appears
> as **Dexterity Office Hub**: in the title bar (top right) and in the **Office hub** card on Pulse, with its
> address. You do not need the app on the server PC: you configure everything from your own PC.

---

## Part A. The server (office hub)

*On the server PC, signed in to Windows as a user with administrator rights.*

**A1. Keep the PC awake.**

1. Open **Settings → System → Power** (on Windows 10: **Settings → System → Power & sleep**).
2. Under **Screen and sleep**, set **When plugged in, put my device to sleep after** to **Never**. The screen may
   turn off; the PC must not sleep.

**A2. Give it a fixed address.** Ask whoever manages the office router to make a **DHCP reservation** for this
PC, so its IP address never changes (for example `192.168.1.20`). Write the address down. The apps find the
hub on their own, but a fixed address makes it dependable and lets people type it in if they ever need to.

**A3. Download and unpack the hub.**

1. Download the **Office hub** zip (link above).
2. Right-click it, choose **Extract All…**, and extract it to **`D:\`** (any drive except C: is fine). You get
   **`D:\DexterityConnectHub`**. Keep this folder where it is: the hub runs from it, and its data is kept in
   `hub-data` inside it.

**A4. Install the hub.**

1. In `D:\DexterityConnectHub`, double-click **`Install-Hub.cmd`**.
2. Click **Yes** when Windows asks for permission.
3. It installs the hub as a Windows service that starts with the PC and restarts itself. It also opens the ports
   it needs in Windows Firewall:
   - TCP 47900 for the apps;
   - UDP 47901 for finding the hub;
   - 47910–47999 for meetings of more than 8 people.

**Check it worked:** press **Win + R**, type `services.msc`, press Enter. **Dexterity Connect Hub** shows
**Running**.

**A5. Only if your office network is split.** If PCs are on different network segments (VLANs, a separate staff
Wi-Fi), ask whoever manages the network to let those PCs reach the server PC on **TCP 47900**, **UDP 47901**
and **TCP/UDP 47910–47999**. On a simple office network there is nothing to do.

**A6. Optional: live-streaming webinars to YouTube.** This needs ffmpeg on the server PC. Skip it if you will not
stream webinars.

1. Click Start and type `PowerShell`. Right-click **Windows PowerShell** and choose **Run as administrator**.
2. Run:

   ```
   winget install --id Gyan.FFmpeg -e --scope machine
   ```

3. In `services.msc`, right-click **Dexterity Connect Hub** and choose **Restart**.

---

## Part B. Your app, and becoming the owner

*On your own PC (not the server).*

1. Download the **App for Windows** (link above) and run it.
   - If Windows says **"Windows protected your PC"**, click **More info → Run anyway**. The installer is not
     code-signed yet; it is the genuine file.
2. Dexterity Connect opens on **Welcome to Dexterity Connect**:
   - **Your name, as colleagues will see it**: type your name.
   - **Office hub**: pick the hub shown with **Secure**. If none appears, click **Enter the hub address yourself**
     and type the server's address from A2, for example `192.168.1.20`.
   - Click **Request access**.
3. You are the first person, so you become the **owner** at once.

**Check it worked:** click your picture (top right). The menu has **Control room**.

---

## Part C. Configure the office

*In the app on your PC: click your picture (top right) → **Control room**. The Control room has 17 numbered
sections. Every change is saved on the server for the whole office, not on your PC or under your name.*

**C1. Backups (do this first).** Go to **16 Backups & leavers → Backups**.

1. **Backup folder**: enter a folder on a second disk of the server PC (`E:\DexConnectBackup`) or a network share
   (`\\NAS\backups\dexconnect`). Never use the server's own C: drive. Click **Save folder**; the hub checks it can
   write there and tells you if it cannot.
   - **For a network share**, the hub runs as the server PC's computer account. Ask whoever manages the NAS to
     give the server PC itself (it appears as `DOMAIN\SERVER-PC$`) permission to change files in that folder.
2. **Every night at**: leave **02:00**, or choose another time. **Keep**: leave the numbers (14 daily, 8 weekly,
   12 monthly). Click **Save**.
3. Click **Back up now**. After a moment the sheet shows the last good backup and its size.
4. Make sure only administrators can open the backup folder: it holds all messages and the hub's key.

**C2. Organisation.** Go to **04 Organisation**.

1. **Departments**: type each department in **New department, for example Piping**. Choose **Part of** to nest it
   under another, and **Led by** for its head.
2. **People**: under **Import people**, click **Template** to download `dexterity-connect-people.csv`.
   1. Open it in Excel. It has these columns: **Account** (each person's Windows user name, for example `priya`),
      **Name, Designation, Department, Reports to** (the manager's Windows user name), **Extension, Phone,
      Email, Seat, Employee ID, Date of joining, Birthday**.
   2. Fill in one row per person and save it as **CSV**.
   3. Click **Choose CSV file** and pick it. The app shows what it will do (who is updated, who gets their
      details when they join, which new departments are created) before you confirm.

   People who have not installed the app yet are included: they get their details as soon as they join.
3. **Office managers** (people who may move seats): type a name in **Add an office manager…** and pick them.
4. **Conference rooms and cabins**: add each room with its number of seats, so meetings can book them.

**C3. Office holidays.** Go to **13 Bots & tools**, find **Office holidays**. For each holiday, choose the date,
type the name (for example *Diwali*) and click **Add holiday**. Nib, scheduled bot jobs and hot-desk booking skip
these days.

**C4. Notice desks.** Go to **15 Notice desks**. The desks **Admin, HR, IT and Management** are already there.
Under each desk, use **Add an issuer…** to choose who issues notices for it (for example the HR manager under
HR). A desk with no issuers is issued for by administrators only.

**C5. Nib and day sheets.** Go to **14 Nib & day sheets**.

1. **01 Activity givers**: click **Add the department heads**, or add each lead with **Add someone** and a scope
   (for example *Piping* or *Area 4*).
2. **02 Management**: under **Who receives the register**, add the directors or managers who should get the
   evening register.
3. **03 Times**: leave the defaults or change them:
   - start of day 09:45;
   - wrap-up 18:00;
   - register 19:00;
   - follow-up 21:00;
   - workdays Mon–Sat.
4. **04 Jobs and privacy**: enter **Job codes**, one per line (`P-12 Hydrotreater revamp`). Leave day sheets
   **Private** unless management wants them open to everyone.
5. Click **Save**. Then click **Send me a register now** to see the evening register before the first real one.

**C6. Policies.** Go to **08 Policies** and read through once. The defaults are:

- guest links for meetings allowed (**Meetings**);
- people may add their own phones;
- lobby for people joining from outside.

Change only what the office decides (for example the largest file people can share, or whether calls may be
recorded).

**C7. Seating (the real floor plan of Level 01 is already in the app).**

1. In the app, open **Directory → Org chart → Floor → Arrange → Import**.
2. Click **Open a CSV** and choose `seat-names-from-drawing.csv` (the seat list read from your drawing, sent to you
   separately; it is not kept in the code because it has people's names).
3. Click **Match names**. Full names are matched for certain. For first names only, tick **Use line …** where the
   suggestion is right.
4. Open **Move plan** and click **Apply now**.
5. In **Layout**, rename **Room A (unlabelled)** and check that the two MD cabins are the right way round.

**Check it worked:** the floor plan shows people at their seats; **17 Audit log** lists every change you made.

---

## Part D. Working from outside the office, and Dexterity Meet links

*This gives staff the app at home and on mobile data, and gives meetings clean links that clients can open in a
browser, for example `https://dexterity-meet.pages.dev/p12-design-review`. It uses a free Cloudflare account.
The office opens no ports to the internet.*

**D1. Make the Cloudflare account.**

1. Go to <https://dash.cloudflare.com/sign-up> and sign up with the **office email address**. The free plan is
   enough.
2. Verify the email address (Cloudflare sends a link).
3. In the dashboard, open **Workers & Pages** once (left menu, under *Compute*). If Cloudflare asks you to choose a
   **workers.dev subdomain**, pick a short one such as `dexterity`. Your gateway's address will contain it.
4. On the **Workers & Pages** page, copy your **Account ID** (on the right side) into Notepad.

**D2. Make the API token.** It lets the deploy script create the gateway and the meeting site.

1. Click the person icon (top right) → **My Profile** → **API Tokens** → **Create Token**.
2. Next to **Edit Cloudflare Workers**, click **Use template**.
3. Under **Permissions**, click **+ Add more** and set **Account · Cloudflare Pages · Edit**. The template alone
   cannot deploy the meeting site.
4. Under **Account Resources**, choose your account. Under **Zone Resources**, choose **All zones** (or your
   domain).
5. Click **Continue to summary** → **Create Token**. Copy the token into Notepad now: Cloudflare shows it only
   once.

**D3. Prepare your PC to run the deploy script (once).**

1. Install **Node.js 22 LTS** from <https://nodejs.org> with the default options.
2. Sign in to GitHub as **vikramdex-ops**, the owner of the source code. Open this link to download the source as a
   zip: <https://github.com/vikramdex-ops/Dex-Chat/archive/refs/heads/claude/epic-fermi-h7zdk1.zip>
3. Extract it to **`D:\Dexterity\`**. You get a folder like `D:\Dexterity\Dex-Chat-claude-epic-fermi-h7zdk1`.

**D4. Deploy the gateway and the meeting site.**

1. In that folder, open `scripts\release` and double-click **`Deploy-Gateway.cmd`**.
2. When it asks for the token, paste it (right-click pastes; nothing shows while you paste) and press Enter.
3. When it asks for the **Account ID**, paste it and press Enter.
4. The first run downloads its tools, so it takes a few minutes. At the end it prints:

   ```
   Gateway address:       https://dexconnect-gateway.<your-subdomain>.workers.dev
   Meeting site address:  https://dexterity-meet.pages.dev
   ```

   Copy both into Notepad.
5. If it says the name **dexterity-meet** is taken, run it again with another name:
   1. Click in the folder's address bar, type `cmd` and press Enter.
   2. Run `Deploy-Gateway.cmd -SiteName dexmeet-office`.

   The meeting site is then `https://dexmeet-office.pages.dev`.

**D5. Tell the hub.** In the app: **Control room → 09 Outside the office**.

1. **Gateway address**: paste the gateway address and click **Save address**.
2. Switch on **Allow access from outside the office**. The status turns green within seconds.
3. Under **Who may use it**:
   - leave **New devices may ask to join from outside** on (an administrator still approves each one);
   - turn on **The Control room works from outside** only if owners and IT should manage it from home.
4. Under **Meeting site · Dexterity Meet**:
   - paste the meeting site address into **Meeting site address** and click **Save address**;
   - leave **Name on meeting pages** as *Dexterity Design Services*, or change it and click **Save name**.

**D6. Lock the gateway to your server (recommended).**

1. On the same page, under **This hub**, copy the **Fingerprint**.
2. In `scripts\release`, click the address bar, type `cmd`, press Enter, and run:

   ```
   Deploy-Gateway.cmd -Fingerprint PASTE-THE-FINGERPRINT-HERE
   ```

   Paste the token and Account ID again when asked.
3. Back in **Outside the office**, the status says **gateway pinned to this hub**.

**D7. Calls from outside (recommended).** Without this, calls from some mobile networks cannot connect.

1. In Cloudflare, open **Realtime → TURN Server** (left menu) → **Create**. Give it a name.
2. Copy its **Turn Token ID** (32 characters) and **API Token**.
3. In the app: **Outside the office → Calls across networks**:
   1. Set **Relay for calls** to **Cloudflare TURN**.
   2. Paste the **TURN key id** and the **API token**, and save.

   The token stays on the server; each call gets short-lived credentials. Cloudflare's free allowance is plenty
   for an office.

**D8. Check it.**

1. Open the meeting site address in a browser. It says **Join a meeting with Dexterity Design Services**.
2. In the app, open **Meet**, copy your personal room's link, and open it on a phone **using mobile data** (Wi-Fi
   off). The meeting page opens.

**D9. Optional: your own domain for meeting links** (for example `meet.dexteritydesign.co.in`).

1. In Cloudflare: **Workers & Pages → dexterity-meet → Custom domains → Set up a custom domain**. Enter
   `meet.dexteritydesign.co.in` and continue.
2. If your domain's DNS is on Cloudflare, it adds the record itself. If not, Cloudflare shows a **CNAME** record:
   `meet` pointing to `dexterity-meet.pages.dev`. Add exactly that record at your domain's DNS provider
   (GoDaddy, BigRock or whoever holds `dexteritydesign.co.in`), or ask whoever manages the website.
3. Wait until Cloudflare shows the domain as **Active** (minutes to a few hours).
4. In the app: **Outside the office → Meeting site address** → enter `https://meet.dexteritydesign.co.in` →
   **Save address**.

   New links use it at once. Links already sent keep working.

---

## Part E. Bring everyone in

**E1. Each person's PC.**

1. They install the app from the **App for Windows** link (the same *More info → Run anyway* if Windows asks).
2. They type their name, pick the hub and click **Request access**.
3. Their screen shows a **device code**. In **Control room → 01 Approvals**, you see the same code: ask them to read
   it out, and click **Approve** if it matches.

**E2. Roles.** In **Control room → 03 People & roles**:

| Who | What to set |
| --- | --- |
| The 2 management users | **Role → Owner**, then confirm **Make owner** |
| The 2 IT users | **Role → Admin**, then add them at the top under **IT desk → Add someone to the IT desk…** so they receive Help me requests |
| Everyone else | **Member** (the default) |

Owners and admins can both configure everything. Only owners choose who the owners and admins are.

**E3. Phones (each person, no administrator needed).**

1. On their office PC: **Preferences → Your devices → Add my phone**. A QR code appears.
2. They point the phone camera at it and tap the link, then **Download for Android**. The app installs and signs
   them in as themselves.
3. There is no iPhone app.

**E4. Home laptops.**

1. On their office PC: **Preferences → Your devices → Add my laptop** shows a code starting with `DXP1-`.
2. They click **Email it to me**.
3. On the laptop they install the app, choose **I have a pairing code** and paste it.

**E5. Optional: meetings in Outlook or a phone calendar.**

1. In **Preferences → Calendar**, each person can click **Show my meetings in Outlook or on my phone**.
2. In Outlook, they paste the address under **Add calendar → Subscribe from web**.

---

## Part F. Hand over to management and IT, and step back

1. Make sure E2 is done: management are **Owners**, IT are **Admins**.
2. In **Control room → 03 People & roles**, on **your own row**, change **Role** to **Admin** and confirm **Step
   down**. You are no longer an owner.
3. Everything you configured stays exactly as it is:
   - backups, Nib, seating, notice desks, holidays and policies;
   - the gateway, the Meet site and the call keys.

   It all belongs to the office, so nobody has to re-enter anything.
4. If you leave the office entirely: one of the owners opens **Control room → 16 Backups & leavers → Someone
   leaving** and chooses you and who takes over your items. Your devices are signed out.
5. Hand over the **outside accounts**: these are logins, not app settings.
   - **The Cloudflare account**, made with the office email: give the login to IT or management.
     - The API token is not stored anywhere and is not needed day to day.
     - It is only needed to deploy again, using D2 and D4.
   - **The GitHub accounts** (`vikramdex-ops` for the source, `dexterity-admin` for releases and the landing
     page).
   - **The server PC's Windows login**, and who manages the backup share.

---

## Part G. Final checks

- [ ] `services.msc` on the server shows **Dexterity Connect Hub: Running**.
- [ ] **Control room → 16 Backups & leavers** shows a good backup from today.
- [ ] Two PCs can message each other, and a call between them works.
- [ ] A phone on **mobile data** can send a message.
- [ ] A meeting link opened on a phone on mobile data reaches the meeting page, and a test guest can join from the
      lobby.
- [ ] **Outside the office** shows green and **gateway pinned to this hub**.
- [ ] **03 People & roles** shows 2 owners (management) and 2 admins (IT), with IT on the **IT desk**.
- [ ] An evening has passed and the management received Nib's register.
- [ ] The app updates itself: **Preferences → Updates** shows the newest version. Installed apps check on start and
      every 4 hours.

---

## If something goes wrong

| What you see | What to do |
| --- | --- |
| "Windows protected your PC" when installing | **More info → Run anyway**. The installers are not code-signed yet. |
| The app keeps looking for the office hub | Check the PC is on the office network, not guest Wi-Fi. Click **Enter the hub address yourself** and type the server's address (A2). Check `services.msc` on the server. |
| A PC on another floor or Wi-Fi cannot find the hub | Part A5: the network must let it reach the server's ports. |
| `Deploy-Gateway.cmd` says *Install Node.js 22* | Do D3 step 1, then run it again. |
| It fails at the meeting site with a Pages message | The token is missing **Account · Cloudflare Pages · Edit** (D2 step 3). Edit the token in Cloudflare, add it, run again. |
| *Cloudflare would not create the Pages project* | The name is taken: run `Deploy-Gateway.cmd -SiteName dexmeet-office`. |
| **Outside the office** status is not green | Check the gateway address was pasted exactly and **Allow access from outside the office** is on. The server needs internet for this part only. |
| Calls from home connect but have no sound or video | Set up **Cloudflare TURN** (D7). |
| The backup says it cannot write to the share | Give the server PC's computer account write access to that folder (C1). |
| An update is waiting | Nothing to do: apps update themselves. The hub keeps a copy of the newest installers for PCs without internet. |

## Optional, later

- **Code-signing certificate** (about US$200–400 a year): removes the "Windows protected your PC" warning.
- **Hindi and Tamil**: a native speaker of each reads the app in their language (**Preferences → Appearance →
  Language**) and notes any wording to change.
- **User guide approval**: `Dexterity-Connect-User-Guide.pdf` says *Approved by: Pending approval* until the person
  who signs off documents gives their name.
