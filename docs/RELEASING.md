# Releasing Dexterity Connect

Releases are built on an office Windows PC with one script. Pushing code to GitHub builds nothing;
the GitHub workflow (`.github/workflows/build.yml`) still exists but runs only when started by hand.

## One-time setup on the build PC (about 30 minutes)

Keep the checkout off drive C:, for example `D:\Dexterity\Dex-Chat`.

1. **Node.js 22 LTS** from <https://nodejs.org> (default options).
2. **Git** from <https://git-scm.com>, then clone the repository:
   `git clone https://github.com/vikramdex-ops/Dex-Chat D:\Dexterity\Dex-Chat`
3. **For the Android app (optional):**
   - JDK 21 (for example Eclipse Temurin 21).
   - The Android SDK. Android Studio installs it, or use the command-line tools plus
     `sdkmanager "platforms;android-36" "build-tools;36.0.0"`.
   - Set the environment variable `ANDROID_HOME` to the SDK folder.
   - Without these, the script builds everything except the APK and says so.
4. **For publishing (optional):** the GitHub CLI from <https://cli.github.com>, then
   `gh auth login`. Sign in with the account that owns `dexterity-admin/dexterity-connect`.

The Android signing key is in the repository (`apps/mobile/android/keystore`). Every APK is signed
with it, so phones accept each new version as an update.

## Building a release

In `scripts\release`, double-click **Build-Release.cmd**.

1. It installs dependencies, typechecks and runs the tests.
2. It builds:
   - the Windows installer;
   - the office hub: `DexterityConnectHub-Setup-<version>.exe` (the installer for the server PC)
     and `DexterityConnectHub-<version>-win-x64.zip` (the same files, with `Install-Hub.cmd`);
   - the Android APK.
3. It writes the files, with `SHA256SUMS.txt` and the update feed, to
   `D:\DexterityConnect-Releases\<version>`.

Nothing is published yet, so you can install and try the build first.

| Option | What it does |
| --- | --- |
| `-Publish` | Uploads to the public release page and updates the feed, so installed apps update themselves within the hour |
| `-Channel stable` / `-Channel beta` | Stable reaches everyone; beta only the people who opted in. Default: stable from `main`, beta from any other branch |
| `-Version 0.1.26111514` | Publish the exact build you tested (with `-SkipTests`) |
| `-SkipAndroid`, `-SkipTests` | Faster builds while trying things |
| `-Out E:\Builds` | Another output folder |

The version is `<major.minor>.<yyMMddHH>`, so every build is newer than the last.

Publishing also uploads copies without the version in their names (`DexterityConnect-Setup.exe`,
`DexterityConnectHub-Setup.exe`, `DexterityConnectHub-win-x64.zip`, `DexterityConnect.apk`), so
`https://github.com/dexterity-admin/dexterity-connect/releases/latest/download/<name>` always gives
the newest stable build. The landing page and `docs/OFFICE-SETUP.md` link to these.

A typical release:
1. On a PC with the `main` branch checked out, run `Build-Release.cmd`.
2. Install the setup from the output folder on one PC and try it.
3. Run `Build-Release.cmd -Publish -Version <that version> -SkipTests`.

macOS installers can only be built on a Mac: `npm ci`, then `npm run build -w @dex/desktop`, then
`npx electron-builder --mac dmg --arm64 --x64` in `apps/desktop`.

The installers are not code-signed. Windows SmartScreen shows "Windows protected your PC" on first
install: choose **More info → Run anyway**. A code-signing certificate removes this. It costs about
US$200–400 a year; set it in `apps/desktop/package.json` (`build.win`) when you have one.

## The hub setup

`DexterityConnectHub-Setup.exe` is built with NSIS from `apps/hub/installer/hub-setup.nsi` by
`node apps/hub/scripts/build-setup.mjs`. The build PC needs nothing extra: the script uses the NSIS
that the Windows app's build downloads (or an installed NSIS, `winget install NSIS.NSIS`, or
`MAKENSIS`). The setup runs `Install-Hub.ps1`, the same script `Install-Hub.cmd` runs from the zip,
so both install the hub the same way:

- refuses anything but 64-bit Windows 10/11, too little free space, or ports 47900/47901 held by
  another program (asks for administrator rights through the usual Windows prompt);
- programs in `C:\Program Files\Dexterity Connect Hub`, data in
  `C:\ProgramData\Dexterity Connect Hub\hub-data` (a page lets the owner choose another folder;
  only SYSTEM and Administrators can open it). `hub-data-location.txt` beside the program names the
  data folder, so `DexterityConnectHub.exe --restore` finds it too;
- an installed hub (from the setup, or from the zip in any folder) is found through its service and
  upgraded where it is; its data always stays where it is. Data an uninstall kept is found again;
- the WinSW service as Local System, delayed automatic start, restart after a failure three times;
- the firewall rules `Install-Hub.cmd` always made (TCP 47900, UDP 47901, TCP and UDP 47910-47999 for
  the relay), replaced by name so they never double;
- no sleep or hibernation on mains power (an option, on by default; `/NOPOWER` when silent);
- starts the hub and waits up to 150 seconds for `https://127.0.0.1:47900/health`;
- logs to `C:\ProgramData\Dexterity Connect Hub\setup.log`; Apps & features has Uninstall, which keeps
  the data unless its box is ticked.

Silent: `DexterityConnectHub-Setup.exe /S [/DATA=E:\HubData] [/NOPOWER]`, and
`"Uninstall Dexterity Connect Hub.exe" /S [/REMOVEDATA]`. Exit codes: 0 done, 1 failed, 2 refused,
3 a self-update went back to the version before (`/SELFUPDATE`, which the hub uses; below). The
uninstaller also removes `previous\`.

The GitHub workflow's `hub-smoke` job installs the built setup on a clean Windows runner, checks the
service, firewall rules and `/health`, runs it again, uninstalls and reinstalls, upgrades an install
made the old way from the zip, runs the zip's script, and lets the hub update itself and go back
after a broken update (below); nothing is published unless it passes.
`apps/hub/installer/smoke-test.ps1` does it, and can be run by hand on a throw-away PC or VM.
`Build-Release.cmd` does not run it (it would install a hub on the build PC): try a local build's
setup on a spare PC before `-Publish`.

## The hub updates itself

The hub setup is run once. After that the hub keeps itself up to date from the same feed as the apps
(`apps/hub/src/hub-update.ts`):

- **The feed.** `make-feed.mjs` lists the hub's setup, `DexterityConnectHub-Setup-<version>.exe`, as
  `hub-win-x64`, with its size and SHA-512, like the apps' installers. The hub zip is still a release
  file (and in `SHA256SUMS.txt`) for installing by hand, but not in the feed. Both build paths stamp
  the version into the hub (`build.mjs --version`), so the hub knows which build it is
  (`DexterityConnectHub.exe --version` prints it, and `/health` reports it).
- **Finding and fetching.** The hub looks at the feed for its channel (stable unless an administrator
  chooses beta) a minute after it starts and every 4 hours. A newer setup is downloaded once into
  `<data>\hub-update\` (resumable; refused unless its size and SHA-512 match the feed), and the owners
  and administrators are told once: "The hub updates itself to X at 03:00; it is offline for about a
  minute."
- **When.** At the quiet time, 03:00 hub-local time by default (after the 02:00 backup), within a
  two-hour window. Never while a meeting, call or webinar is live on the hub: it waits until it ends,
  and if the window closes first, it tries the next night. When backups are set up it makes a fresh
  backup first; if that fails, tonight's backup will do, and without a good backup in the last 24
  hours it waits for the next night. Without backups set up it still updates, and says so.
- **Installing.** The hub writes down its intent, checks the file's size and SHA-512 again, and
  registers a one-off scheduled task (`Dexterity Connect Hub update`, as SYSTEM, no trigger) that runs
  `DexterityConnectHub-Setup-<v>.exe /S /SELFUPDATE /NOPOWER`, so the setup is not a child of the
  service it stops. The setup finds the installed hub and its data as an interactive repair does.
- **Going back.** With `/SELFUPDATE`, `Install-Hub.ps1 -SelfUpdate` copies the running version's
  programs to `<install>\previous\` before they are replaced. If the new version does not start, or
  does not answer `https://127.0.0.1:47900/health` as its own version within 150 seconds, it puts the
  old programs back, starts them and waits for `/health` again (exit code 3). If the setup stops while
  copying, it runs `Install-Hub.ps1 -SelfUpdate -Rollback`. What happened goes to
  `<data>\hub-update\result.json` and `setup.log`. The data is not part of this: an update that went
  back leaves the database as the new version left it (changes to it only add tables and columns),
  and the backup made just before is there if needed.
- **Afterwards.** The hub, running again, compares its version with its intent: the new version means
  it worked ("Updated from A to B" in the audit log, and a note to the administrators); the old one
  means the setup went back. That version is then not tried again by itself; **Control room → Backups
  & leavers → Hub updates** shows what the setup said and where its log is, with **Try again**.
- **Administrators** (owners and admins only) see the version, the channel, the last look, the next
  update and the history there, and can turn automatic updates off, change the quiet time and the
  channel, and click **Update now** (it still waits for a live meeting unless they confirm
  **Update now anyway**). The setup check shows the same in one line.
- **Trust.** The same as the apps' updater: the feed comes over HTTPS from the public release
  repository, and a setup runs only if its size and SHA-512 match the feed (checked again just before
  it runs). Never a lower or equal version, never a beta on the stable channel, never a file named for
  another version. The installers are not code-signed, so this trusts whoever can publish to the
  release repository's `update-feed` branch, exactly as the apps do.
- Only the hub installed as the Windows service updates itself. A hub run from source (development)
  says so in the setup check and never looks at the feed by itself.

To upgrade by hand instead (or with automatic updates off), run the new `DexterityConnectHub-Setup.exe`
on the hub PC as before; the hub is offline for about a minute.

The install test (`hub-smoke`) installs the release's setup, then lets the hub update itself the way
it does at night (`DexterityConnectHub.exe --apply-update <setup>`, through the same scheduled task) to
a test build one version later, and checks the service comes back healthy as that version with the
same certificate and data; then it updates to a test build whose hub program cannot start and checks
the setup goes back and the previous version runs and answers. The `hub` job builds those two test
setups; they are never published.

## The internet gateway

`scripts\release\Deploy-Gateway.cmd` deploys the gateway to Cloudflare from the same PC. It asks for
the Cloudflare API token and account id, and doesn't save them. See `docs/REMOTE-ACCESS.md`.

## Status of these scripts

The scripts repeat, step for step, what the GitHub workflow did when it last ran successfully.
They have not yet been run on a Windows PC: the first run may need a small fix. If it stops, the
message says at which step.
