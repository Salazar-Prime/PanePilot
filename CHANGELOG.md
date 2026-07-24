# Changelog

## 0.2.0-rc.1 — 2026-07-24

This release candidate adds:

- Cross-laptop discovery of PanePilot-owned remote tmux sessions without a remote
  daemon.
- Automatic remote tmux reattachment after SSH loss or laptop wake, with retry and
  offline states in the terminal workspace.
- Codex lifecycle snapshots sourced from `run-state` and `task-progress`.
- Editable project Actions that run shell commands in fresh ephemeral tmux sessions
  and retain the latest output.
- One persistent, tmux-backed Codex Q&A workspace per project.
- Distinct icons for Codex, Claude Code, login-shell, and custom terminal profiles.
- Files workspace state that survives switching between project tabs for the lifetime
  of the renderer.
- Restored file-browser scrolling.

The v0.2.0-rc.1 build supports Apple silicon Macs on macOS 12 or newer. It remains
unsigned and unnotarized.

## 0.1.0 — 2026-07-24

PanePilot's first preview release introduces:

- Local and SSH-backed terminal projects with persistent tmux sessions.
- Codex, Claude Code, login-shell, and custom-command launch profiles.
- Agent lifecycle and attention states with terminal response input.
- Read-only, searchable Codex and Claude conversation history.
- Bounded local and remote file browsing, previewing, and editing.
- Reversible project and terminal archives, terminal pinning, and saved output.
- Explicit loopback-only SSH port forwards.
- Section-aware LaTeX projects with scoped Ask/Edit chats and source-change review.

The v0.1.0 downloadable build supports Apple silicon Macs on macOS 12 or newer. It is
an unsigned, unnotarized preview.
