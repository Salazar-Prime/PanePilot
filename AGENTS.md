# PanePilot Agent Guide

This document is the durable product and engineering handoff for PanePilot (the package is still named `project-console`). Read it before changing the application. It records the core product decisions made with the owner, the current implementation, important invariants, and the intended path for adding project types beyond terminals.

## Product purpose

PanePilot is a desktop control center for projects that are worked on by people and LLM agents. It should answer, at a glance:

- What projects exist locally and on each SSH host?
- Which agents are working, waiting, finished with a response, or blocked?
- Which terminal or conversation needs the user's attention?
- What did Codex or Claude previously say and what did the user answer?
- Which files and GitHub repository belong to a project?

The application is intentionally a single desktop UI:

- A top bar for project-type selection, project identity, and global actions.
- A toggleable left sidebar for connections, projects, terminals, and attention state.
- A type-specific main workspace.
- A bottom status bar for cross-project agent counts.

The current implementation supports terminal projects and section-aware LaTeX projects. General writing projects were part of the original vision but are deliberately not implemented yet.

## Confirmed product decisions

These are owner-approved decisions and should be treated as product invariants unless explicitly changed:

1. A project has a stable identity independent of its display name.
2. A terminal project is tied to one folder and one connection.
3. A connection is either the local machine or an SSH alias imported from `~/.ssh/config`.
4. Projects are grouped by connection in the sidebar.
5. Subprojects are not part of the product. Legacy `parent_id` values are flattened during database migration.
6. A project may have multiple terminal sessions.
7. Terminals appear both as tabs in the main workspace and as direct-jump items under their project in the sidebar.
8. Persistent terminals use tmux when available. A plain PTY is the fallback.
9. User-created terminal launch profiles are login shell, Codex, and Claude Code. Reusable custom commands are project Actions, not ordinary terminal tabs.
10. Dangerous permission bypass is per terminal, off by default, visibly marked, and confirmed before launch. It must never become a silent global default.
11. Terminal rename is non-destructive. Detaching an ordinary terminal leaves its tmux session running. Archive hides a stopped terminal but preserves its saved output. Confirmed deletion closes the exact live terminal session when necessary, then removes its saved output.
12. Deleting a terminal does not delete the provider's Codex or Claude conversation archive.
13. Local Codex and Claude archives are indexed read-only and are searchable across full message text.
14. File-looking terminal output should be clickable. Files can also be browsed and previewed in the UI.
15. A GitHub repository action is available when a Git remote can be discovered.
16. Remote Codex lifecycle recovery uses the tmux pane title configured with `activity`, `run-state`, and `task-progress`. Tmux is the shared current-state snapshot across laptops; PanePilot does not maintain a remote lifecycle spool.
17. A persistent terminal's PanePilot name and tmux session name are identical. Names must be tmux-safe and unique on that connection.
18. Terminal pinning is persisted. Pinned terminals remain first while the remaining terminals follow the user's selected sort order.
19. Projects can be archived only after all of their terminals stop. Archived projects have a separate library view and do not contribute to live status counts.
20. SSH port forwards are explicit, bind to `127.0.0.1`, use `ExitOnForwardFailure`, and stop when PanePilot exits.
21. A new Codex terminal exposes Codex's `thread-id` in its tmux pane title. PanePilot resolves that collision-resistant title reference against the project-scoped Codex archive, stores the full provider thread ID in SQLite, and mirrors it into live tmux metadata. PanePilot never uses `/rename` for identity and resumes only with the exact provider thread ID.
22. PanePilot-owned tmux sessions carry versioned session-scoped `@panepilot_*` metadata. On an SSH connection, live tagged sessions are discovered with one-shot tmux commands and reconciled into the local database by stable terminal UUID and canonical project folder. This enables another PanePilot machine to attach without a remote daemon. Tmux is authoritative for live-session presence; SQLite remains authoritative for durable local workspace state.
23. A project Action is an editable name and shell command. Each invocation replaces the prior saved run with a fresh ephemeral tmux session; the latest output remains visible, and xterm input remains available while the command is running.
24. Every project has at most one project Q&A Codex session. It is a persistent tmux-backed agent session rendered as a top-level project capability, not as an ordinary terminal tab or sidebar terminal.
25. SSH transport state is separate from terminal and agent lifecycle state. A dropped SSH client becomes reconnecting/offline; only a successful remote scan proving the exact tmux session is gone may complete the terminal.
26. Files workspace navigation, preview, editor, and unsaved draft state survive switching project tabs in the current renderer lifetime. They are not persisted across application restarts.
27. Every folder-backed project has Markdown notes stored in `.notes-panepilot` at the project root. The file is authoritative on the local or SSH host and is never mirrored into SQLite.
28. The SSH connection list can be refreshed explicitly from `~/.ssh/config` without restarting PanePilot.
29. A new Codex terminal may optionally receive an exact Codex thread ID. PanePilot links that ID before creating tmux metadata and launches `codex resume` instead of creating a new thread.
30. Project Q&A can be reset after confirmation. Reset closes the exact old backend session when present and deletes PanePilot’s Q&A terminal record/output, but never deletes the provider’s conversation archive.

## Agent lifecycle semantics

Agent state describes the current turn, not merely whether the terminal process exists.

| State | Meaning | Expected UI |
| --- | --- | --- |
| `idle` | Codex or Claude is open and ready, but no turn is running. | Neutral dot; no attention badge. |
| `running` | The user submitted a prompt and the agent is generating or using tools. | Animated working indicator. |
| `needs-input` | The agent asked a direct question, requested confirmation, or opened a permission prompt. | Amber dot, `!` attention badge, and response input in the terminal workspace. |
| `response-ready` | The latest response finished without requiring an answer. | Blue response-ready dot. |
| `needs-attention` | The run hit a condition that needs intervention. | Red attention state. |
| `completed` | The terminal process/session was intentionally ended. | Completed state; terminal can be archived or deleted. |
| `error` | The terminal or agent ended with an error. | Error state; terminal can be archived or deleted. |

Important lifecycle rules:

- A new Codex or Claude terminal starts as `idle`, not `running`.
- Startup rendering must not mark an agent as working.
- `UserPromptSubmit` changes the state to `running`.
- Provider `Stop` examines `last_assistant_message`:
  - A direct trailing question or explicit confirmation request becomes `needs-input`.
  - Otherwise it becomes `response-ready`.
- `PermissionRequest` always becomes `needs-input`.
- Claude `Notification` events for `permission_prompt` and `idle_prompt` become `needs-input`.
- `needs-input` is sticky. It must not be replaced by an unrelated `Stop` or screen update. It clears only when terminal input is submitted or a later structured event proves execution continued.
- An open shell terminal must never cause an LLM-specific working indicator.
- `completed` means the terminal ended. It does not mean merely that one answer finished.

State priority when several visible sessions exist is:

`needs-input` → `needs-attention` → `running` → `response-ready` → `idle` → `error` → `completed`.

## Current architecture

PanePilot is an Electron application using React, TypeScript, SQLite, xterm, node-pty, and tmux.

### Process boundaries

- `src/main/`: trusted Electron main process, SQLite, PTYs, tmux, SSH, archive indexing, filesystem access, and lifecycle events.
- `src/preload/index.ts`: narrow IPC bridge exposed as `window.projectConsole`.
- `src/renderer/`: React UI. It must not access Node APIs directly.
- `src/shared/types.ts`: contracts shared across the three layers.

Every new capability that crosses the Electron boundary must be updated in all of these places:

1. Shared input/output types.
2. Main-process IPC handler.
3. Preload bridge.
4. `src/renderer/env.d.ts`.
5. Renderer consumer.

### Important files

- `src/renderer/components/App.tsx`: application shell, connection/project sidebar, project header, History UI, and Files UI.
- `src/renderer/components/ManagedTerminal.tsx`: xterm lifecycle, terminal tabs, launcher, rename/archive/delete UI, dangerous mode, and response input.
- `src/renderer/src/components/ActionsPanel.tsx`: editable project Actions, latest-run output, rerun, stop, and deletion UI.
- `src/renderer/src/components/ProjectQnaPane.tsx`: the single project-scoped Codex Q&A terminal and question composer.
- `src/main/terminal-manager.ts`: PTY/tmux lifecycle, persistence, SSH attachment, state transitions, and terminal operations.
- `src/main/codex-pane-status.ts`: maps Codex terminal-title snapshots into PanePilot lifecycle states.
- `src/main/store.ts`: SQLite schema, migrations, project/session/activity persistence, and aggregate state.
- `src/main/conversation-indexer.ts`: read-only Codex/Claude JSONL discovery, parsing, caching, and full-text search.
- `src/main/remote-conversation-indexer.ts`: read-only, server-side normalization of Codex/Claude archives over SSH plus remote Codex session discovery.
- `src/main/file-service.ts`: bounded local file listing and previews.
- `src/main/remote-file-service.ts`: SSH-backed file listing and previews.
- `src/renderer/src/components/NotesPanel.tsx`: project-root Markdown notes editor for local and SSH projects.
- `src/main/ssh-config.ts`: SSH alias discovery.
- `src/main/git.ts`: repository URL discovery.
- `src/main/latex-project-service.ts`: LaTeX outline parsing, project settings, scoped chat launch, edit snapshots, and source diffs.
- `src/main/latex-paths.ts`: bounded relative LaTeX path and external URL validation.
- `src/renderer/src/components/LatexProjectWorkspace.tsx`: LaTeX capability tabs and workspace orchestration.
- `src/renderer/src/components/LatexManuscript.tsx`: section outline, editable Monaco source, and agent-change decorations.
- `src/renderer/src/components/LatexAgentPane.tsx`: project/section chat selection, Ask/Edit modes, prompt composer, and tmux transcript.
- `src/renderer/src/projectTypeRegistry.ts`: renderer project-type definitions and workspace dispatch.
- `scripts/agent-event-hook.mjs`: no-op-outside-PanePilot hook bridge.
- `scripts/install-agent-hooks.mjs`: additive user-level hook installer with backups.

### Storage

The database is:

`~/Library/Application Support/project-console/project-console.sqlite`

Core tables:

- `connections`: local or SSH connection identities.
- `projects`: base project identity, type, connection, folder, repository URL, aggregate state, and timestamps.
- `terminal_sessions`: terminal profile, command, backend, tmux identity, provider session ID, legacy provider session name, lifecycle state, dangerous-mode flag, archive flag, and saved output.
- `project_actions`: editable project-scoped command definitions and the terminal session containing only the latest run.
- `activities`: project timeline entries.
- `agent_events`: idempotently ingested provider lifecycle payloads.
- `port_forwards`: saved loopback-only SSH forwarding configurations. Running processes are intentionally not persisted across app exits.
- `latex_projects`: type-owned main file, Overleaf URL, and context-folder settings.
- `latex_sections`: stable section identities reconciled from the main file and included sources.
- `latex_chat_sessions`: project/section scope and Ask/Edit mode for a terminal session.
- `latex_edit_snapshots`: bounded `.tex` baselines used to highlight agent changes until the user clears them.

The old `projects.parent_id` column remains for migration compatibility but is unused and cleared on startup.

Do not put type-specific data into many nullable columns on `projects`. New project types should use their own table keyed by `project_id`.

## Terminal persistence and output

- Local and remote sessions use tmux when it is available.
- Each PanePilot terminal has its own tmux session name.
- The tmux session name must exactly match the PanePilot terminal name. Rename both as one operation.
- New tmux sessions are tagged before the launch profile starts with the stable terminal ID, originating project ID, canonical project folder, profile, creation time, dangerous-mode indicator, and any known provider/LaTeX attachment identity.
- Session metadata also distinguishes ordinary terminals, Action runs, project Q&A, and LaTeX chats. A live Action includes its bounded definition so another PanePilot client can reconcile it without exposing the run as a normal terminal.
- Remote discovery lists only the selected SSH user's default tmux server. Tagged sessions whose canonical project folder matches exactly are imported or refreshed in local SQLite; untagged sessions are ignored unless they match a legacy local terminal record, in which case PanePilot adopts them by adding metadata.
- Another local PanePilot installation may attach to the same discovered session. Normal attachment does not detach an existing tmux client.
- Detaching an ordinary terminal closes only PanePilot's current tmux client. The tmux session and its process remain live and can be reattached from the same or another PanePilot client.
- Discovery uses bounded `BatchMode` SSH calls and no remote daemon, registry, or background service. Offline hosts leave the locally cached workspace untouched.
- Remote terminal SSH clients use server keepalives. Electron resume forces attached remote clients through exact-ID tmux verification and bounded reconnect backoff.
- PanePilot-managed Codex launches mirror `activity`, `run-state`, and `task-progress` into the tmux pane title. Discovery reads that shared snapshot so another laptop can recover current Codex state without consuming events.
- A provider session ID discovered after launch is mirrored into the live tmux metadata. The PanePilot terminal UUID remains the primary identity because provider IDs are not available at tmux creation time.
- Closing/detaching the renderer does not kill a persistent tmux session.
- Action tmux sessions are intentionally ephemeral: they end when the command exits. PanePilot deletes the prior run row before rerunning so only the latest output is retained.
- A PTY fallback is used when tmux cannot be found or created.
- Tmux preserves a still-running Codex process. A new Codex terminal includes `thread-id` in its session-local terminal title; PanePilot resolves the displayed reference against the project-scoped Codex archive and mirrors the full ID into `@panepilot_provider_session_id`.
- A stopped Codex terminal restarts only with `codex resume <exact-id>`. Provider session names are retained only for migration compatibility and are never used as a resume target.
- When the user supplies an exact Codex thread ID at creation, PanePilot validates and links it before launch, mirrors it into tmux metadata, and starts with `codex resume <exact-id>`.
- Provider session discovery reads Codex `session_meta` archive records and does not depend on lifecycle hooks. Existing unlinked Codex terminals are reconciled on startup when their archives are available.
- Stopping an Action or agent capability, and deleting any live tmux-backed terminal, must directly kill the exact tmux session and verify that it is gone before marking it `completed` or removing it. Do not simulate tmux prefix keystrokes through the terminal UI.
- Local tmux resolution checks PATH plus common Homebrew/system locations.
- Custom hook environment variables must be passed through the pane's initial `env` command. A pre-existing tmux server does not automatically import arbitrary client variables.
- Saved terminal output is capped in SQLite.
- xterm replay must suppress `onData`; otherwise xterm protocol replies can be echoed into the PTY as numeric garbage.
- Raw PTY output must remain byte-for-byte intact. Codex remote-state recovery reads the tmux pane title separately and must never inject metadata into terminal output.

Archive and deletion rules:

- Only `completed` or `error` terminals can be archived.
- Archived terminals are hidden from normal tabs/sidebar lists but can be restored.
- Permanent deletion first closes an active terminal's exact backend session, then removes saved terminal output and associated ingested hook events.
- Provider-owned conversation JSONL is never removed by terminal deletion.
- Projects can be archived only when every terminal is `completed` or `error`.
- Project archiving is reversible and does not delete terminals, activity, files, or provider archives.

## Remote Codex lifecycle snapshot

PanePilot does not install a remote agent daemon or maintain a per-client event spool.
Managed Codex launches receive a session-local terminal-title override for:

- `activity`
- `run-state`
- `task-progress`
- `thread-id`

Codex keeps these values current in the tmux pane. Remote discovery reads the pane
title beside the versioned PanePilot tmux options. `Working` or `Thinking` maps to
`running`, an action-required title maps to `needs-input`, and `Ready` after a
previously running state maps to `response-ready`.

`task-progress` is the latest progress emitted by Codex `update_plan`; it is useful
context but is not by itself proof that a turn is running. Local and legacy sessions
continue to use the narrow rendered-screen fallback.

Remote provider session IDs and conversation archives remain on their SSH host. PanePilot queries them read-only with Python 3, filters by the remote project working directory on that host, and transfers only normalized conversation data. Remote archives must never be mistaken for local `~/.codex` or `~/.claude` data.

## Dangerous agent mode

Dangerous mode uses:

- Codex: `--dangerously-bypass-approvals-and-sandbox`
- Claude: `--dangerously-skip-permissions`

Safety invariants:

- Off by default for every launch.
- Per-terminal choice, never a global preference.
- Confirmation immediately before launch.
- Persistent `unsafe` badge on the terminal.
- Activity history records that permission checks were disabled.
- UI language must explain that this is intended only for isolated or disposable environments.

## Conversation history

Local archive sources:

- Codex: `~/.codex/sessions/**/*.jsonl`
- Claude: `~/.claude/projects/**/*.jsonl`

Remote projects use the same paths under the selected SSH user's home directory. Remote scanning runs server-side, is bounded by an SSH timeout/output cap, requires Python 3, and is cached separately from local indexing.

Conversations are associated with a project by working directory. The indexer:

- Reads provider archives without modifying them.
- Caches parsed files by mtime and size.
- Produces normalized user/assistant messages.
- Preserves the provider's actual session ID so a stopped Codex terminal can resume the exact chat.
- Searches title, working directory, and complete message content.
- Returns snippets and match counts.
- Highlights query matches in the selected conversation.

Known scaling limitation: search currently scans the in-memory parsed conversations. If archives become large, introduce a SQLite FTS index with file mtime/version tracking rather than repeatedly parsing every archive.

## File and repository behavior

- Local file operations are bounded to the project folder.
- Remote file operations execute through SSH.
- Choosing a folder for a new SSH project browses that host's filesystem, starts at the remote home directory, and stores the canonical remote path. It must never open the local native folder dialog.
- File previews are truncated at 1 MB.
- Project notes use the fixed project-root path `.notes-panepilot`, are UTF-8 Markdown text capped at 1 MB, and reject symlink targets. Both local and remote writes replace the file atomically.
- The file preview toolbar can download the authoritative saved file through a native Save dialog. Local files are copied directly; remote files are streamed over SSH without applying the 1 MB Monaco preview limit.
- File previews use a locally bundled Monaco editor with language detection. Editing requires an explicit Edit action and saving is bounded to existing files no larger than 1 MB.
- Terminal links recognize project-contained path-like text and optional line/column suffixes. Clicking a link switches to Files, opens the authoritative file in Monaco, and reveals the requested line and column when present.
- Relative terminal links resolve against the project folder.
- Repository URLs are currently auto-discovered only for local projects.
- The project context menu opens the repository when one is available.

## LaTeX projects

- A LaTeX project is folder- and connection-backed, like a terminal project, but its type-specific settings live in `latex_projects`.
- The default main file is `main.tex`; users can choose another project-relative `.tex` file during creation or in project settings.
- The optional context folder defaults to `context`. Agents are told they may inspect it and other paper sections when relevant.
- The outline reads sectioning commands from the main document and recursively included `.tex` files. A common `\section{...}` followed by `\input{...}` maps the section to the included source file.
- Section rows are reconciled rather than recreated so attached chat identities survive ordinary title and line-number changes.
- A LaTeX chat is a normal persistent Codex or Claude terminal session plus a type-owned attachment to the whole project or one section.
- Ask mode tells the provider not to modify files. Edit mode scopes the requested edit and captures a baseline of bounded `.tex` files before the first submitted edit.
- The renderer polls source diffs while an edit runs. Added and modified source is decorated in Monaco; removed source is displayed in an inline view zone. Highlights remain until the user clears them.
- Chat prompts must go through the LaTeX composer so PanePilot can add the current mode, section, main-file, and context-folder instructions.
- Git repository URLs use the base project capability. Local repositories are auto-discovered, while any LaTeX project can store a manual web URL. The Overleaf URL is independent and type-owned.
- Both GitHub/repository and Overleaf actions use validated HTTP(S) external links.
- Do not store document source in SQLite. Files remain authoritative locally or on the selected SSH host.

## Adding another project type

This is the most important extension point. Do not add a large `if (project.type === ...)` chain throughout `App.tsx`. The current single-type implementation is compact but should be refactored into a project-type registry before implementing writing projects.

### Target model

Separate three concepts:

1. **Base project identity**
   - `id`
   - `type`
   - `name`
   - timestamps
   - optional connection/location identity

2. **Type-owned data and behavior**
   - Stored in a type-specific table.
   - Read and mutated through a type-specific service.
   - Rendered by a type-specific workspace component.

3. **Reusable capabilities**
   - Files
   - Repository
   - Terminals
   - Agent history
   - Search

A project type selects capabilities; a capability should not be hard-coded as belonging to only one type. For example, a future writing project might still optionally use Files or an agent terminal.

### Recommended registry

Introduce a renderer registry with a shape similar to:

```ts
interface ProjectTypeDefinition {
  id: ProjectType;
  label: string;
  description: string;
  capabilities: Array<'terminal' | 'files' | 'repository' | 'agent-history'>;
  Workspace: React.ComponentType<ProjectWorkspaceProps>;
  createFields: ProjectCreateFieldDefinition[];
}
```

Use the registry for:

- The top-bar project-type switcher.
- New-project form fields.
- Project workspace dispatch.
- Available tabs and actions.
- Empty states and labels.

Main-process behavior should use a corresponding service registry:

```ts
interface ProjectTypeService {
  type: ProjectType;
  create(base: Project, input: unknown): void;
  delete?(project: Project): void;
  summarize(project: Project): ProjectTypeSummary;
}
```

This prevents the renderer registry from becoming responsible for persistence.

### Concrete implementation sequence

The renderer and main-process project-type registries are now in place. Before adding another type:

1. Add the renderer definition and main-process type service instead of branching throughout `App.tsx`.
2. Reuse capability components such as Files, History, and agent conversation history.
3. Decide whether the new type requires a folder and connection.
   - If not, migrate `projects.folder` and `connection_id` into a generic optional location model.
   - Do not use fake folders or fake local connections for non-location projects.
4. Add a type-specific table and migration.
5. Extend `ProjectType` in `src/shared/types.ts`.
6. Add type-specific IPC methods and mirror them through preload and renderer declarations.
7. Add type-aware creation validation.
8. Add focused tests for creation, reload, switching, and deletion.

### Writing project example

A writing project should not be implemented as a terminal project with different labels. A reasonable first model is:

```text
writing_projects
  project_id       PRIMARY KEY -> projects.id
  document_root    nullable path or workspace identifier
  primary_document nullable document id
  workflow_state   idea | outlining | drafting | revising | complete
  settings_json
```

Potential writing workspace capabilities:

- Outline
- Draft editor
- Research/source library
- Revision history
- Agent conversations
- Optional Files and Terminal tabs when the project is location-backed

Questions that require owner input before implementing writing projects:

- Is a writing project always backed by a local/remote folder, or can it live entirely in PanePilot?
- Is the primary unit one document, a collection, or both?
- Should drafts be plain Markdown files, database records, or user-selectable?
- Should writing-agent history use Codex/Claude terminal sessions, an API integration, or both?
- Which sidebar state replaces terminal-centric states for writing workflows?

Do not implement the writing type until these decisions are answered.

## Known gaps and future work

- Continue splitting the single CSS file into project-type/capability modules.
- Add formal unit and integration tests.
- Add SQLite FTS when conversation volume warrants it.
- Add packaged-app-safe hook installation; the current hook command references the development checkout.
- Add project deletion and connection health diagnostics.
- Improve remote repository discovery.
- Decide and implement the writing project model.

## Development and validation

Install and run:

```bash
npm install
npm run dev
```

Validation:

```bash
npm run typecheck
npm run build
git diff --check
```

`node-pty` requires its native macOS `spawn-helper` to be executable. npm can reinstall the prebuilt helper without its executable bit, which surfaces as the otherwise opaque `posix_spawnp failed` error before any shell starts. `postinstall`, `predev`, and `prestart` run `scripts/prepare-node-pty.mjs`; keep all three guards.

When main-process code changes, stop and restart `npm run dev`; Vite hot reload alone does not restart Electron's main process. Newly injected tmux environment variables only apply to newly created sessions.

## Change checklist

For any change:

1. Preserve local and remote connection behavior.
2. Check whether it is base-project behavior, type-specific behavior, or a reusable capability.
3. Keep provider lifecycle state separate from terminal-process existence.
4. Keep `needs-input` sticky until a real response/continuation.
5. Avoid destructive actions without confirmation and stopped-session validation.
6. Update shared types, main IPC, preload, renderer declarations, and UI together.
7. Add a forward-compatible SQLite migration.
8. Run typecheck, build, and focused smoke tests.
9. Restart Electron for main/preload changes.
10. Commit and push validated scoped changes automatically.

The repository uses npm and tracks `package-lock.json`. Do not add the unrelated `pnpm-lock.yaml` unless the owner intentionally switches package managers.
