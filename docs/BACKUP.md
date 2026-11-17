# Backing up and restoring the hub

The hub PC holds everything the office has in Dexterity Connect: people and devices, Spaces and
messages, files, the Calendar, recordings and the audit log. The hub backs itself up every night to
a folder you choose. This page says what a backup is, how to set it up, how to tell it is working,
and how to put one back.

## What a backup is

- **The database**, copied with SQLite's online backup while the hub keeps running. People can go
  on sending messages during the copy; the copy is consistent at the moment it finishes.
- **The files**: everything shared in conversations, recordings, tool bundles. Files are stored by
  their SHA-256 and never change, so the backup folder keeps one shared pool of them and each run
  copies only files it does not have yet. After the first backup, nightly runs are quick.
- **The hub's identity** (`hub-cert.pem`, `hub-key.pem`), so PCs and phones trust a restored hub
  without being set up again.

Update downloads and half-finished recording uploads are not backed up: the hub fetches or receives
them again.

## Setting it up

### On its own, on the first start

When the hub starts and no administrator has chosen a backup folder (the setting was never saved),
it looks at the hub PC's disks and chooses one itself, **only when that is safe**
(`apps/hub/src/firstrun.ts`):

- a **fixed** volume (Windows' drive type 3): not removable, not a network drive, not on a USB,
  SD, FireWire, iSCSI or virtual-disk bus (USB disks that Windows reports as fixed are left out);
- on a **different physical disk** from the hub's data, mapped from drive letter to disk number
  with PowerShell (below);
- not the Windows drive (`SystemDrive`) or a boot or system partition;
- with at least **twice the hub's data and 10 GB** free. The roomiest such volume wins.

It then makes `<drive>:\DexConnectBackup`, makes it private to **Administrators and SYSTEM** (and
the hub's own account, when the service runs as someone else) with
`icacls <folder> /inheritance:r /grant:r *S-1-5-32-544:(OI)(CI)F *S-1-5-18:(OI)(CI)F` (well-known
SIDs, so it works in any Windows language), sets **02:00**, keeps **14 daily, 8 weekly and 12
monthly** copies, runs the first backup at once and checks it like every other run. A folder that
cannot be made private is not used. The audit log records `backup.settings` with `auto: true`.

**If no disk qualifies** (one disk, another partition of the same disk, only the Windows disk, only
USB drives, or a disk too full) the hub chooses nothing. **Backups & leavers** and the setup check
at the top of the Control room then say, in amber: *Backups need a second disk or a network share*,
what the hub found (for example "C:, D: are parts of the same physical disk (disk 0)") and the one
thing to do. The hub looks again on each start until a folder is set, so adding a second disk and
restarting the service is enough. Once an administrator saves a folder (or turns backups off), the
hub never chooses one itself again, and a folder it chose is never re-chosen.

On a PC that is not Windows, or when PowerShell does not answer within 20 seconds, the hub chooses
nothing and says so.

The PowerShell the hub runs, read-only (`DISK_SCRIPT` in `firstrun.ts`, run with
`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand …`):

```powershell
$ErrorActionPreference = 'Stop'
$out = @()
foreach ($v in @(Get-Volume | Where-Object { $_.DriveLetter })) {
  $disk = $null; $bus = $null; $boot = $false
  try {
    $p = Get-Partition -DriveLetter $v.DriveLetter -ErrorAction Stop | Select-Object -First 1
    $disk = [int]$p.DiskNumber
    $boot = [bool]($p.IsBoot -or $p.IsSystem)
    $d = Get-Disk -Number $disk -ErrorAction Stop
    $bus = [string]$d.BusType
  } catch { }
  $out += [pscustomobject]@{
    letter = [string]$v.DriveLetter; driveType = [string]$v.DriveType; disk = $disk; bus = $bus; boot = $boot
    free = [int64]$v.SizeRemaining; size = [int64]$v.Size; label = [string]$v.FileSystemLabel
  }
}
ConvertTo-Json -Compress -Depth 4 -InputObject ([pscustomobject]@{ system = [string]$env:SystemDrive; volumes = $out })
```

A volume whose disk Windows does not report (a mapped drive, Storage Spaces, some RAID drivers) has
no disk number and is never chosen; if the hub's own data drive has none, nothing is chosen.

### By hand

**Control room → Backups & leavers → Backups.**

1. **Backup folder.** A second disk (`E:\DexConnectBackup`) or a network share
   (`\\NAS\backups\dexconnect`). Not the hub's own disk: a backup on the same disk is lost with it.
   The hub checks it can write there when you save; if it cannot, it says why.
2. **Every night at.** The hub PC's time, 02:00 unless you change it. If the hub was off then, it
   backs up as soon as it is on again.
3. **Keep.** One copy a day for 14 days, one a week for 8 weeks and one a month for 12 months, unless
   you change the numbers. Older copies are removed after a new backup has worked, never before.

**Back up now** starts a backup straight away (for example before moving the hub to a new PC).

### Network shares

The hub runs as a Windows service. By default that is the Local System account, which reaches a
network share as the hub PC's own computer account (`DEXTERITY\HUB-PC$`). Either give that computer
account permission to change the share's folder, or set the service to run as an account that can
(Services → Dexterity Connect Hub → Properties → Log On). If the share cannot be reached, the
Control room says so in plain words.

### Keep the folder private

Each copy holds the hub's private key and all the office's messages and files. Only administrators
should be able to read the backup folder.

## Is it working?

The Backups sheet shows:

- the last good backup, its size, and how many new files it copied;
- what the check after it found: SQLite's `PRAGMA integrity_check` on the copy (opened read-only),
  the number of messages in it, and how many of its files were read back and compared with their
  SHA-256;
- the next backup;
- any failure, in plain words ("The backup folder E:\DexConnectBackup could not be reached. Check
  that the disk is plugged in...");
- the copies in the folder and why each is kept (latest, day, week, month), and the last runs;
- when the hub chose the folder itself, or could not, what it found.

The **setup check** at the top of the Control room also shows backups: the destination, the
schedule, and the last good backup with its size and whether it was checked.

After a failure the hub tries again an hour later. **If no backup has worked for two days**, the
sheet shows an amber warning and the Dexterity Connect system bot tells every administrator, once a
day, until one works. A hub with no backup folder at all gets the same warning once it is two days
old.

## Restoring

Use this after the hub's disk failed, the database was damaged, or to move the hub to a new PC.

1. **Stop the hub service.** Services → Dexterity Connect Hub → Stop, or in an administrator Command
   Prompt in the hub's folder: `DexterityConnectHubService.exe stop`. The restore refuses to run
   while the hub is running; it never stops the service itself.
2. **Run the restore**, in the hub's folder (Command Prompt as administrator):

   ```
   DexterityConnectHub.exe --restore "E:\DexConnectBackup"
   ```

   That puts back the newest copy. For an older one, give its folder:
   `--restore "E:\DexConnectBackup\snapshots\2026-11-14_0200"`.
   Or drag the backup folder onto `Restore-Hub.cmd`.
3. **Start the service again**: `DexterityConnectHubService.exe start`.

What the restore does:

- checks the copy first (SQLite's integrity check, and that every file it needs is in the backup
  folder), and changes nothing if it is not sound;
- moves the current data folder aside to `hub-data-before-restore-<date>-<time>` (it never deletes
  it: remove it yourself once the hub works);
- puts the copy's database, certificate and files in `hub-data`, and writes `restored-from.txt`.

Everything since the backup was taken is not in the restored hub: messages sent after it, files
shared after it. Devices approved after it have to be approved again.

### On a new PC

Install the hub from the hub zip as usual (`Install-Hub.cmd`), stop the service, run the restore,
start the service. Give the new PC the old PC's address if you can (the DHCP reservation); apps find
the hub on the network either way, and trust it because its certificate is restored.

### From a source checkout

`node apps/hub/src/main.ts --restore <folder>` restores into `DEXCONNECT_DATA_DIR` (default
`./hub-data`).

## The backup folder

```
E:\DexConnectBackup\
  README.txt                       what the folder is
  files\ab\ab12…                   the shared files, one copy each
  snapshots\2026-11-15_0200\
    hub.db                         the database
    hub-cert.pem, hub-key.pem      the hub's identity
    files.txt                      the files this copy needs
    manifest.json                  when, which hub, and what the check found
```

A copy is written as `snapshots\.partial-…` and renamed only once it is complete and checked, so a
run cut short (the PC switched off) never looks like a backup; the leftovers are cleared a day later.
Do not change files in the folder by hand.

The code is in `apps/hub/src/backup.ts`; the tests (a backup while people write, the keeping rules,
a restore round trip, a folder that cannot be used) in `apps/hub/test/backup.test.ts`.
