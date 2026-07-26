# PanePilot Remote for Android

PanePilot Remote is a deliberately small Android companion for the desktop app. It
connects directly to an SSH server, discovers live tmux sessions carrying PanePilot's
versioned `@panepilot_*` metadata, shows a recent pane snapshot, and sends text back to
the exact tmux pane.

It does not require a relay, PanePilot daemon, web service, or a copy of the desktop
SQLite database. Tmux remains authoritative for live-session presence.

## What it supports

- Multiple manually configured SSH servers
- Password or imported private-key authentication
- SSH host-key verification and saved `known_hosts`
- PanePilot session discovery grouped by project folder
- Codex progress state from the tmux pane title
- Bounded, auto-refreshing plain-text pane snapshots
- Multiline agent messages sent through a temporary tmux buffer

The app is a focused monitor and message composer, not a full terminal emulator. It
does not create, rename, stop, archive, or delete sessions.

## Requirements

- Android 8.0 (API 26) or newer
- Network access from the phone to the SSH server, directly or through your VPN
- An SSH account with access to the same user's default tmux server
- `tmux` installed on the server
- Live tmux-backed sessions created by a current PanePilot desktop client

PanePilot tags only tmux-backed sessions. Plain PTY fallback sessions cannot be
discovered from another device.

## Build and install from the command line

Install Android Studio or the Android command-line tools with Android SDK 34 and
Build Tools 34. Then:

```bash
cd android
export ANDROID_HOME="$HOME/Library/Android/sdk"
export JAVA_HOME=$(/usr/libexec/java_home -v 21)
./gradlew assembleDebug
```

If Homebrew installed the command-line tools on macOS, the SDK path is commonly:

```bash
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
```

Connect an Android phone with USB debugging enabled and install the APK:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

You can also copy `app/build/outputs/apk/debug/app-debug.apk` to the phone, open it,
and allow installation from that file source when Android asks.

## Build with Android Studio

1. Open the repository's `android/` folder in Android Studio.
2. Let Gradle sync.
3. Select a connected phone.
4. Run the `app` configuration.

## First connection

1. Tap **Add server** and enter a host, SSH port, username, and authentication method.
2. For key authentication, import the private key. The app copies it into private app
   storage; it never stores the key passphrase.
3. Tap the server, enter the password or optional key passphrase, and connect.
4. On first connection, compare the displayed SSH fingerprint with the fingerprint
   from the server or hosting provider before choosing **Trust and connect**.
5. Choose a live session, watch its pane snapshot, and use the bottom composer to send
   a prompt.

If a legitimate server is rebuilt and its host key changes, edit that server and use
**Forget saved host key** only after independently verifying the new fingerprint.

## Security and behavior

- Passwords and private-key passphrases stay in memory only for the active connection.
- Imported private keys live in Android's app-private storage and are removed when the
  server profile is deleted.
- Message text is sent as SSH channel input to `tmux load-buffer`; it is not interpolated
  into the remote shell command.
- Session names are always passed as exact tmux targets (`=session-name:`).
- The transcript is capped to the most recent 300 pane lines and 768 KB per refresh.
- Leaving the app does not stop the remote tmux session.
