DEXTERITY CONNECT HUB
=====================

The hub is the always-on part of Dexterity Connect. Put it on one office PC that stays on.

Install
  The easy way: run DexterityConnectHub-Setup.exe (from the same release page) and click Yes
  when Windows asks for permission. It puts the programs in C:\Program Files\Dexterity Connect Hub
  and the data in C:\ProgramData\Dexterity Connect Hub\hub-data (you can choose another folder).
  It also finds a hub installed from this zip and upgrades it where it is, data and all.

  From this zip instead:
  1. Copy this whole folder to where the hub should live, for example D:\Dexterity Connect Hub
  2. Double-click Install-Hub.cmd and click Yes when Windows asks for permission.

Either way the hub runs as a Windows service that starts with the PC (a minute or two after
Windows, before anyone signs in) and restarts itself if it ever stops. Setup opens only the ports
the hub needs in Windows Firewall (TCP 47900, UDP 47901, and 47910-47999 for large meetings), stops
the PC sleeping while plugged in, starts the hub and checks that it answers. Running it again
repairs or upgrades the hub and never touches its data. Everything it did is in
C:\ProgramData\Dexterity Connect Hub\setup.log

Recommended for the hub PC
  - Keep it switched on and plugged into the office network.
  - Ask whoever manages the router to give it a fixed IP (DHCP reservation). Apps follow
    the hub automatically if its address changes, but a fixed address is still best.

Files
  hub-data\   database, certificate and shared files (beside the program for a zip install;
              hub-data-location.txt names the folder when it is elsewhere). The hub backs it up
              every night once you choose a backup folder (below).
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
  2. In a Command Prompt as administrator in the hub's program folder:
       DexterityConnectHub.exe --restore "E:\DexConnectBackup"
     puts back the newest copy. For an older one, give its folder:
       DexterityConnectHub.exe --restore "E:\DexConnectBackup\snapshots\2026-11-14_0200"
     Or drag the backup folder onto Restore-Hub.cmd.
     The copy is checked first. The current hub-data is moved aside to
     hub-data-before-restore-<date>-<time>, never deleted.
  3. Start the hub: DexterityConnectHubService.exe start
  On a new PC: run the setup (or Install-Hub.cmd), then do the three steps above.
  Anything after the backup was taken (new messages, devices approved since) is not restored.

Remove
  Settings > Apps > Dexterity Connect Hub > Uninstall (installed with the setup), or double-click
  Uninstall-Hub.cmd (installed from the zip). The data is kept unless you tick the box to delete it.

Health check
  https://<hub-pc-address>:47900/health  (the browser will warn about the certificate;
  the Dexterity Connect app trusts it by its fingerprint instead.)
