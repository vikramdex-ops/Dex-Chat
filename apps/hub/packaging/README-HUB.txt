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
  hub-data\   database, certificate and (later) shared files. Back this folder up.
  logs\       service logs.

Remove
  Double-click Uninstall-Hub.cmd. Your data in hub-data is kept.

Health check
  https://<hub-pc-address>:47900/health  (the browser will warn about the certificate;
  the Dexterity Connect app trusts it by its fingerprint instead.)
