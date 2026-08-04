# PanePilot

PanePilot is a desktop control center for local and SSH projects worked on by people and
coding agents. It keeps project folders, persistent terminals, agent attention state,
files, and activity in one Electron window.

An optional [Android companion](android/README.md) connects directly over SSH to
PanePilot-tagged tmux sessions, so you can check agent progress and send a message from
your phone without running a remote daemon.

PanePilot also supports section-aware LaTeX projects: choose a main `.tex` file, edit
source in place, attach persistent Codex or Claude chats to the whole paper or one
section, and review source changes highlighted directly in the editor. Optional
repository, Overleaf, and `context/` links keep the paper and its research material
together.

## Install the preview release

PanePilot v0.2.0-rc.1 is available from
[GitHub Releases](https://github.com/Salazar-Prime/PanePilot/releases). The packaged
preview supports Apple silicon Macs running macOS 12 or newer.

1. Download the `.dmg`, open it, and drag PanePilot into Applications.
2. Because this preview is not yet Developer ID signed or notarized, Control-click
   PanePilot in Finder, choose **Open**, and confirm the first launch.

The `.zip` contains the same application for users who prefer an archive. Verify either
download against `SHA256SUMS.txt` attached to the release.

## Documentation

The complete product, user, architecture, and development documentation lives in the
Fumadocs site under [`docs/`](docs/README.md).

```bash
cd docs
npm install
npm run dev
```

Then open <http://localhost:3000>. The documentation site requires Node.js 22 or newer.

## Run the desktop app

Requirements:

- macOS or Linux
- Node.js 20.18+
- `tmux` for persistent terminals (PanePilot falls back to a plain PTY)
- `codex` and/or `claude` on `PATH` for agent launch profiles
- Optional: `rclone` for project-scoped Google Drive uploads

```bash
npm install
npm run dev
```

Validation:

```bash
npm test
npm run typecheck
npm run build
```

## Current agent status tracking

Codex terminals expose `run-state` and `task-progress` through the tmux pane title so
PanePilot can restore the latest status after an SSH reconnect without a remote daemon
or event spool. Claude Code continues to use terminal-output fallback tracking.

Shell and Action terminals are excluded from agent-state detection, so ordinary
terminal output cannot create a false working state.

Project and terminal metadata, saved output, and activity are stored in
`~/Library/Application Support/project-console/project-console.sqlite` on macOS.

## Google Drive uploads

Google Drive uploads use [rclone](https://rclone.org/drive/), so rclone owns the OAuth
credentials and PanePilot does not need a Google Cloud client-secret file.

1. Install rclone (`brew install rclone` on macOS).
2. Run `rclone config` and create one named Google Drive remote for each account, such
   as `personal-drive` and `work-drive`.
3. In PanePilot, choose **Connect Drive** in a project's top toolbar, select that
   project's remote, and enter an existing folder path. Leave the folder empty to use
   My Drive.

Each project independently stores only its rclone remote name, attached folder path,
and returned Drive item IDs. Removing the project connection never removes the rclone
account or uploaded files.

In the Files workspace, open a file and choose **Upload to Drive**. The full saved file
currently open in Monaco is uploaded even when its preview is truncated. Its
project-relative path is preserved under the attached folder, and uploading that path
again updates the destination. Save any Monaco edits before uploading. PanePilot shows
Open/Copy actions for the private Drive link and records the same link in project
activity. It does not call `rclone link`, which would create a public share link.

Press **Command-K** (or **Control-K**) to open the command palette for projects,
terminals, and common project actions.

Press **Command-/** (or **Control-/**) to reveal the focused project's keyboard
KeyTips. While they are visible, use `T` for terminals, `A` for Actions, `Q` for
project Q&A, `N` for Notes, `F` for Files, `C` for chat history, and `H` for Activity.
LaTeX projects also use `M` for Manuscript and `P` for PDF. Number keys select the
shown terminal or chat tabs. Without opening KeyTips, **Command/Control-1–9** jumps
directly to a tab and **Command/Control-Shift-[ / ]** cycles tabs. Only the focused
pane responds in split view. **Control-Page Up / Page Down** is also available for
cycling tabs.
