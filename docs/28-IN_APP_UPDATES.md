# 28 — In-app updates (v1.11)

Status labels: **Implemented** (code on main), **Tested** (automated tests in CI), **Device-verified** (checked on a real phone), **Production-verified** (checked with a real GitHub release).

## What it does

1. **Check.** When Qline opens or comes back to the foreground (at most every 6 hours, or any time from Settings → App updates), it reads the latest release from the public GitHub API (`/repos/jazsajonia-pixel/qline/releases/latest`). Drafts, pre-releases and tags that aren't `vX.Y.Z` are ignored.
2. **Tell, don't force.** When the release is newer than the installed app, a banner appears at the top of the app ("Qline 1.11.0 is available", What's new / Later / Update), plus one Android notification per version. **Later** hides the banner for that version for 3 days. Settings → App updates always shows it. Nothing is downloaded until the person taps Update. The app keeps working normally throughout.
3. **Download and check.** The APK (`qline-X.Y.Z.apk`, only from `https://github.com/...`) streams into the app's private cache. Its SHA-256 is computed while it downloads and compared with GitHub's asset digest and/or the `APK SHA-256` line that `release.yml` writes into the release notes. If both exist and disagree, or neither exists, the update is not offered. A mismatching download is deleted. 200 MB cap.
4. **Native checks** (`Updater.kt`) before Android sees the file: the SHA-256 is checked again, then the package name must be Qline's, the version code must be newer, and the signing certificate must match the installed app's.
5. **Install.** The first time, Android needs "Install unknown apps" for Qline. The banner explains this and opens the setting, and installing continues on return. The APK goes to Android's `PackageInstaller` (session API, `REQUEST_INSTALL_PACKAGES`). **Android always shows its own confirmation screen**; Qline cannot and does not install silently. If the person cancels, the update stays offered and the checked download is reused.
6. **Restart.** Android stops the old app while replacing it. `UpdatedReceiver` (`MY_PACKAGE_REPLACED`) deletes the download, tries to open Qline again and posts "Qline updated to X. Tap to open." On the next start Qline removes that notification and shows "Qline updated to X" once.

## Honest limits

- **Android may block the automatic reopen.** Since Android 10, apps generally may not start an activity from the background, and some vendors (TECNO HiOS included) restrict it further. When blocked, the "tap to open" notification is the fallback, so the restart is "usually by itself", not guaranteed.
- The confirmation tap is required by Android, and the "Install unknown apps" permission is asked once.
- It only works from v1.11.0 on: people on 1.10.0 or older install 1.11.0 manually once.
- Installs from the GitHub release only. Play Store installs (none today) would need Play's in-app update API instead.
- The GitHub API allows 60 unauthenticated requests per hour per IP; the 6-hour throttle keeps Qline far below that.

## Verification

| Item | Implemented | Tested | Device-verified | Production-verified |
| --- | --- | --- | --- | --- |
| Release parsing, checksum rules, version compare | Yes | Yes (unit) | No | No |
| Banner, Later snooze, notification once, Settings screen | Yes | Yes (unit and widget) | No | No |
| Download with SHA-256, tamper deleted | Yes | Yes (fake HTTP) | No | No |
| Native checks, PackageInstaller, permission flow | Yes | Compiles in CI (`flutter build apk`); logic not unit-tested | No | No |
| Reopen after update / notification fallback | Yes | No | No | No |

To verify on a phone: install v1.11.0, publish a later test release (for example v1.11.1), open Qline, tap Update, allow unknown apps, confirm, and note whether Qline reopens by itself or through the notification.
