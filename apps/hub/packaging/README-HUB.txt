DEXTERITY CONNECT HUB
=====================

The hub is the always-on part of Dexterity Connect. Put it on one office PC that stays on.

Install
  1. Copy this whole folder to where the hub should live, for example D:\Dexterity Connect Hub
  2. Double-click Install-Hub.cmd and click Yes when Windows asks for permission.

That is all. The hub runs as a Windows service, starts with the PC, restarts itself if it
ever stops, and opens only the two ports it needs (TCP 47900, UDP 47901) in Windows Firewall.

Recommended for the hub PC
  - Keep it switched on and plugged into the office network.
  - Set Power Options so it never sleeps.
  - Ask whoever manages the router to give it a fixed IP (DHCP reservation). Apps follow
    the hub automatically if its address changes, but a fixed address is still best.

Files
  hub-data\   database, certificate and shared files. The hub backs it up every night once
              you choose a backup folder (below).
  logs\       service logs.

Backups
  In Dexterity Connect: Control room > Backups & leavers > Backups. Choose a folder on a second
  disk or a network share, for example E:\DexConnectBackup or \\NAS\backups\dexconnect. The hub
  backs up every night (02:00 unless you change it) while it keeps running, copies only new files,
  checks every copy, and keeps one a day for 14 days, a week for 8 weeks and a month for 12 months.
  "Back up now" makes one straight away. If no backup works for two days, administrators are told.
  For a network share, the service's account (Local System, as the PC's computer account) must be
  allowed to write there. The backup folder holds the hub's private key: keep it private.

Restore a backup
  1. Stop the hub: Services > Dexterity Connect Hub > Stop
     (or, in a Command Prompt as administrator here: DexterityConnectHubService.exe stop).
     The restore refuses to run while the hub is running.
  2. In a Command Prompt as administrator in this folder:
       DexterityConnectHub.exe --restore "E:\DexConnectBackup"
     puts back the newest copy. For an older one, give its folder:
       DexterityConnectHub.exe --restore "E:\DexConnectBackup\snapshots\2026-11-14_0200"
     Or drag the backup folder onto Restore-Hub.cmd.
     The copy is checked first. The current hub-data is moved aside to
     hub-data-before-restore-<date>-<time>, never deleted.
  3. Start the hub: DexterityConnectHubService.exe start
  On a new PC: run Install-Hub.cmd, then do the three steps above.
  Anything after the backup was taken (new messages, devices approved since) is not restored.

Remove
  Double-click Uninstall-Hub.cmd. Your data in hub-data is kept.

Health check
  https://<hub-pc-address>:47900/health  (the browser will warn about the certificate;
  the Dexterity Connect app trusts it by its fingerprint instead.)
