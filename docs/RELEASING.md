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
   - the office hub package;
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

A typical release:
1. On a PC with the `main` branch checked out, run `Build-Release.cmd`.
2. Install the setup from the output folder on one PC and try it.
3. Run `Build-Release.cmd -Publish -Version <that version> -SkipTests`.

macOS installers can only be built on a Mac: `npm ci`, then `npm run build -w @dex/desktop`, then
`npx electron-builder --mac dmg --arm64 --x64` in `apps/desktop`.

The installers are not code-signed. Windows SmartScreen shows "Windows protected your PC" on first
install: choose **More info → Run anyway**. A code-signing certificate removes this. It costs about
US$200–400 a year; set it in `apps/desktop/package.json` (`build.win`) when you have one.

## The internet gateway

`scripts\release\Deploy-Gateway.cmd` deploys the gateway to Cloudflare from the same PC. It asks for
the Cloudflare API token and account id, and doesn't save them. See `docs/REMOTE-ACCESS.md`.

## Status of these scripts

The scripts repeat, step for step, what the GitHub workflow did when it last ran successfully.
They have not yet been run on a Windows PC: the first run may need a small fix. If it stops, the
message says at which step.
