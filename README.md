# PanePilot

PanePilot is a desktop control center for local and SSH projects worked on by people and
coding agents. It keeps project folders, persistent terminals, agent attention state,
files, and activity in one Electron window.

PanePilot also supports section-aware LaTeX projects: choose a main `.tex` file, edit
source in place, attach persistent Codex or Claude chats to the whole paper or one
section, and review source changes highlighted directly in the editor. Optional
repository, Overleaf, and `context/` links keep the paper and its research material
together.

## Install the preview release

PanePilot v0.1.0 is available from
[GitHub Releases](https://github.com/Salazar-Prime/PanePilot/releases). The first
packaged preview supports Apple silicon Macs running macOS 12 or newer.

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

The current implementation watches the rendered terminal screen for Codex and Claude:

- `esc to interrupt` visible → **Working**
- the marker disappears after being visible → **Needs attention**
- the user opens or reselects the terminal → **Ready**

Shell and custom-command terminals are excluded from this detection, so ordinary
terminal output cannot create a false agent-working state.

Project and terminal metadata, saved output, and activity are stored in
`~/Library/Application Support/project-console/project-console.sqlite` on macOS.
