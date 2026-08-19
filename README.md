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

## Create a project

The New Project dialog can attach an existing folder or create a new one on the
selected local or SSH connection. For a new folder, choose its parent location and
enter one folder name. PanePilot previews the final path and uses that folder name as
the default project name; the project name remains editable. Creation refuses path
separators and existing destinations rather than overwriting them. A new LaTeX
project also receives a minimal configured main `.tex` file. In the SSH browser,
typing after the current path fuzzy-filters its child folders.

## Current agent status tracking

Codex terminals expose `run-state` and `task-progress` through the tmux pane title so
PanePilot can restore the latest status after an SSH reconnect without a remote daemon
or event spool. Claude Code continues to use terminal-output fallback tracking.

Shell and Action terminals are excluded from agent-state detection, so ordinary
terminal output cannot create a false working state.

Project and terminal metadata, saved output, and activity are stored in
`~/Library/Application Support/project-console/project-console.sqlite` on macOS.

## Git status and history

The branch icon beside Project settings opens a read-only Git pane for the focused
project. Its badge and color distinguish conflicts, staged changes, untracked or
modified files, ahead/behind state, and a clean tree. The pane groups working-tree
changes and renders the all-branch commit graph in one continuous scrolling view.
Large histories load another bounded page as you approach the bottom, with **Load
older commits** retained as a fallback. Local and SSH-backed projects are supported,
and these status/history reads run with Git optional locks disabled so PanePilot does
not update the repository.

The top **Repository** action labels a Git repository with no `origin` remote as
**Local** and opens its read-only Git pane. For GitHub origins, it instead shows
**Public**, **Private**, or **Internal**. PanePilot first uses the locally authenticated
GitHub CLI (`gh`), which can identify private repositories available to that account,
then falls back to GitHub's public repository API. If neither can see the repository,
the label is **Unknown** instead of assuming that a missing repository is private.
The check is read-only and cached briefly.

## Markdown preview

Markdown files open in a rendered **Preview** in both the Files workspace and project
Notes, with **Source** available beside it for the Monaco view. Choosing **Edit** in
Files moves directly to Source; while editing, Preview renders the current unsaved
draft so formatting can be checked before saving. The renderer follows GitHub
Flavored Markdown for tables, task lists, strikethrough, autolinks, fenced code,
heading links, and GitHub-style alerts. Relative links open the target inside the
project, relative images are loaded through PanePilot's bounded local/SSH file
preview, and web links open in the system browser. Raw HTML is sanitized before
rendering.

The Files explorer toolbar can create an empty file or folder in the current
directory. Right-click an explorer entry for copy-path, rename, download, or nested
creation actions. The same copy-path, rename, and download commands are available in
Monaco's context menu and in the file preview header. Local paths copy as absolute
paths; SSH paths include their alias. Rename never overwrites an existing entry, and
unsaved Monaco drafts follow the renamed path without being saved implicitly.

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
activity. Uploading alone does not call `rclone link` or change public access.
After an upload, **Create public link** explicitly asks rclone to make an
anyone-with-the-link URL and copies it to the clipboard. **Stop sharing** removes the
public link. Uploading by itself never changes the file's public sharing state.

Press **Command-K** (or **Control-K**) to open the command palette for projects,
terminals, and common project actions.

The message-plus button beside the audio control opens project-scoped **Quick Codex
chats**. You can also open the collection or create a new chat from Command-K. These
tmux-backed chats stay out of ordinary terminal tabs, survive restarts, and remain
available until you choose **Clear**. Clearing removes PanePilot's session and saved
output while leaving Codex's own conversation archive untouched.

The **Aa** toolbar control changes the complete interface—including terminal and
Monaco text—between Compact (90%), Standard (100%), Comfortable (110%), and Large
(125%). The client-local choice survives restarts. Command/Control with plus or minus
steps through those sizes; Command/Control-0 resets to Standard.

Hold **Control** and tap **?** three times to reveal the focused project's keyboard
KeyTips. The first tap passes through to the focused terminal or editor; the second
and third are consumed, so completing the gesture sends only one Control-? input to
the terminal. While KeyTips are visible, use `T` for terminals, `A` for Actions, `Q`
for project Q&A, `N` for Notes, `F` for Files, `C` for chat history, and `H` for Activity.
LaTeX projects also use `M` for Manuscript and `P` for PDF. Number keys select the
shown terminal or chat tabs. Without opening KeyTips, **Command/Control-1–9** jumps
directly to a tab and **Command/Control-Shift-[ / ]** cycles tabs. Only the focused
pane responds in split view. **Control-Page Up / Page Down** is also available for
cycling tabs.

Each Local or SSH machine heading in the sidebar has its own project sort menu.
The choice is saved only on this PanePilot client and applies inside that machine
group. Project icons light their left and right halves independently to show which
split pane currently has the project open. Drag open terminal tabs to arrange them;
the order is saved per project on this client, and pinned tabs always stay in the
leftmost group. Use **Command/Control-Shift-\\** to swap the left and right pane
contents, or reveal KeyTips and press `S`. For project sorting, **Newest first**
means the project selected most recently on this PanePilot client; it does not mean
the newest database record.
With project sorting set to **Needs attention**, entering an attention state
promotes a project. That promotion is sticky: resolving the attention state does
not move the project back down, while a later attention event can promote another
project above it.

Right-click an ordinary terminal in the sidebar or use its tab menu to **Transfer
session to project**. Destinations are limited to active projects on the same local
or SSH machine. PanePilot moves the tab and retags live tmux metadata; an already
running process keeps its current working directory until it is force reloaded or
resumed.

Click a project's sidebar glyph to replace its initial with one Unicode symbol
or emoji. In split view, violet on the glyph's left half marks the left pane and
teal on its right half marks the right pane. The larger project name in the top
bar is followed by a dotted-underlined path; click that path to copy it. The
keyboard shortcut overlay remains available by holding **Control** and tapping
**?** three times even though the visible Shortcuts and Command Palette buttons
are intentionally omitted. Press **Escape** to dismiss the topmost open modal.
