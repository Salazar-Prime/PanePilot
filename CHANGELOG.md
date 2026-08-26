# Changelog

## 0.8.0 — 2026-08-26

This release adds:

- Guarded inline Codex edits for selected LaTeX source. PanePilot saves and verifies
  the selection, accepts only an exact-range change, and keeps persistent editorial
  history with safe rollback when the replacement can still be located.
- A clearer LaTeX workflow with simplified writing-chat controls, explicit scope
  hierarchy, correct escaped-percent highlighting, and one native macOS print job
  for the complete PDF snapshot currently displayed.
- A persisted, keyboard-accessible project-sidebar width and local discovery of
  tagged tmux sessions created by another PanePilot client, matching the existing
  cross-client SSH behavior.

Inline edits require the Codex CLI to be installed and authenticated on the local or
SSH project machine.

The v0.8.0 desktop build supports Apple silicon Macs on macOS 12 or newer. It is
ad-hoc signed, not Apple-notarized, and has no automatic update channel. PanePilot
Remote remains source-only in this release.

## 0.7.2 — 2026-08-24

This patch release improves long-running LaTeX and terminal workflows:

- Previously loaded LaTeX projects reopen from a renderer-lifetime cache while
  their manuscript maps refresh in the background. Manuscript and PDF Preview now
  share one persistent writing-chat margin whose visibility and width are saved per
  project.
- Project-scoped Auto compile is available in PDF Preview. It is off by default and,
  when enabled, detects bounded `.tex` metadata changes on the local or SSH project
  machine before running the existing `latexmk` compile path.
- Closed terminal sessions no longer leak macOS kqueue, slave PTY, or low-numbered
  file descriptors, preventing a long-running PanePilot process from eventually
  failing to launch new terminals.

The v0.7.2 desktop build supports Apple silicon Macs on macOS 12 or newer. It is
ad-hoc signed, not Apple-notarized, and has no automatic update channel. PanePilot
Remote remains source-only in this release.

## 0.7.1 — 2026-08-24

This patch release fixes the LaTeX workflow:

- LaTeX chats now preserve their project or section scope and Ask/Edit mode before
  tmux launch. Remote discovery also repairs stale generic metadata instead of
  replacing richer local attachment details.
- PDF preview now uses a continuous, lazily rendered page stack and remembers its
  tab, page, zoom, and scroll position while switching projects or capabilities and
  after reload or recompile.
- A bounded Recompile action runs the existing `latexmk` installation on the local
  or SSH project machine, then reloads the PDF without returning to page one.

The v0.7.1 desktop build supports Apple silicon Macs on macOS 12 or newer. It is
ad-hoc signed, not Apple-notarized, and has no automatic update channel. PanePilot
Remote remains source-only in this release.

## 0.7.0 — 2026-08-24

This release adds:

- Existing-folder and new-folder project creation for local and SSH connections. The
  unified SSH browser supports editable canonical paths, inline folder creation,
  fuzzy filtering, and keyboard completion/navigation without speculative remote
  requests. New LaTeX folders receive a minimal configured main file.
- Sanitized GitHub-style Preview/Source modes for project Notes, exact provider
  session-ID copying in LLM Chats, and a Local repository state for Git projects
  without an `origin` remote.
- Safer lifecycle and migration behavior: project archiving stops every exact live
  ordinary or capability-owned session before archiving, legacy project deletion
  cascades are repaired, shortcut gestures target only the focused terminal, and
  terminal file links exclude trailing prose punctuation.

The v0.7.0 desktop build supports Apple silicon Macs on macOS 12 or newer. It is
ad-hoc signed, not Apple-notarized, and has no automatic update channel. PanePilot
Remote remains source-only in this release.

## 0.6.0 — 2026-08-14

This release adds:

- Sanitized GitHub-style Markdown previews with Preview/Source modes, rendered
  unsaved drafts, project-bounded relative links and images, and syntax highlighting.
- File and folder creation, rename, download, and copy-path actions for local and SSH
  projects, with collision, traversal, overwrite, and symlink safeguards.
- Project-scoped Quick Codex chats that use persistent tmux sessions while staying
  separate from ordinary terminal tabs.
- Same-connection terminal transfer between active projects, including live tmux
  metadata retagging before durable project ownership changes.
- Client-local whole-interface scaling at 90%, 100%, 110%, and 125%, with toolbar and
  keyboard controls and a first-run 110% default.
- Read-only Public, Private, Internal, or Unknown GitHub visibility in the Repository
  action using the authenticated GitHub CLI with a public API fallback.
- Continuous Git-pane scrolling with bounded automatic history pagination and a
  manual fallback.

The v0.6.0 desktop build supports Apple silicon Macs on macOS 12 or newer. It remains
unsigned and unnotarized. PanePilot Remote remains source-only in this release.

## 0.5.0 — 2026-08-11

This release adds:

- A read-only Git status and history pane for local and SSH projects, with grouped
  working-tree changes, conflicts, staging state, upstream ahead/behind counts,
  stashes, and a bounded all-branch commit graph.
- A toolbar Git indicator that summarizes repository state without taking Git locks
  or modifying the project repository.
- A privacy-oriented output policy for Codex terminals: raw terminal output stays in
  a bounded application-lifetime replay buffer instead of being continuously saved
  to SQLite. Exact provider thread IDs and Codex's own archive remain the durable
  recovery source; other terminal profiles retain saved-output behavior.

The v0.5.0 desktop build supports Apple silicon Macs on macOS 12 or newer. It remains
unsigned and unnotarized. PanePilot Remote remains source-only in this release.

## 0.4.0 — 2026-08-10

This release adds:

- Project-scoped rclone Google Drive destinations, authoritative local/SSH file
  uploads, and explicit creation, copying, and revocation of public file links.
- Google Neural2 read-aloud controls with concise and verbatim modes, local monthly
  usage limits, and Application Default Credentials support.
- Built-in LaTeX PDF preview, printing, and Finder reveal actions.
- Focused project keyboard navigation, KeyTips, split-pane swapping, client-local
  project sorting, custom project icons, and drag-ordered terminal tabs.
- Force reload for Codex and Claude tabs, exact-session recovery improvements, local
  tmux restoration after reboot, safer clipboard handling, and login-shell PATH
  resolution for agent launches.
- PanePilot Remote 0.1.1 source with optional Android Keystore-backed password
  storage and broader tmux delimiter compatibility.

The v0.4.0 desktop build supports Apple silicon Macs on macOS 12 or newer. It remains
unsigned and unnotarized. PanePilot Remote remains source-only in this release.

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
