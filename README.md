# PanePilot

PanePilot is a desktop control center for local and SSH projects worked on by people and
coding agents. It keeps project folders, persistent terminals, agent attention state,
files, and activity in one Electron window.

## Run it

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

## Agent status fallback

PanePilot deliberately does not depend on provider hooks in this build. For Codex and
Claude terminals it watches the rendered terminal screen:

- `esc to interrupt` visible → **Working**
- the marker disappears after being visible → **Needs attention**
- the user opens or reselects the terminal → **Ready**

Shell and custom-command terminals are excluded from this detection, so ordinary
terminal output cannot create a false agent-working state.

Project and terminal metadata, saved output, and activity are stored in
`~/Library/Application Support/project-console/project-console.sqlite` on macOS.
