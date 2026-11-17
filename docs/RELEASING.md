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
`"Uninstall Dexterity Connect Hub.exe" /S [/REMOVEDATA]`. Exit codes: 0 done, 1 failed, 2 refused.

The GitHub workflow's `hub-smoke` job installs the built setup on a clean Windows runner, checks the
service, firewall rules and `/health`, runs it again, uninstalls and reinstalls, upgrades an install
made the old way from the zip, and runs the zip's script; nothing is published unless it passes.
`apps/hub/installer/smoke-test.ps1` does it, and can be run by hand on a throw-away PC or VM.
`Build-Release.cmd` does not run it (it would install a hub on the build PC): try a local build's
setup on a spare PC before `-Publish`.

The hub does not update itself. The update feed lists the hub zip (`hub-win-x64`), but the hub's
mirror does not download it and nothing installs it: to upgrade the hub, run the new
`DexterityConnectHub-Setup.exe` on the hub PC. The hub is offline for about a minute.

## The internet gateway

`scripts\release\Deploy-Gateway.cmd` deploys the gateway to Cloudflare from the same PC. It asks for
the Cloudflare API token and account id, and doesn't save them. See `docs/REMOTE-ACCESS.md`.

## Status of these scripts

The scripts repeat, step for step, what the GitHub workflow did when it last ran successfully.
They have not yet been run on a Windows PC: the first run may need a small fix. If it stops, the
message says at which step.
