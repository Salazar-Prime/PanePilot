# PanePilot Quick Start

This guide covers everything needed to run PanePilot with local and SSH-backed
projects.

## 1. Mac requirements

- An Apple silicon Mac (`M1`, `M2`, `M3`, or newer).
- macOS 12 or newer.
- Internet access.
- An existing project folder.

Download the latest DMG from
[PanePilot Releases](https://github.com/Salazar-Prime/PanePilot/releases/latest),
drag PanePilot into Applications, then Control-click the app and choose **Open** on
the first launch. The current release is not notarized.

Node.js and npm are not required to run the packaged app. They are needed only when
building PanePilot from source or installing an agent through npm.

## 2. Install local dependencies

Install Homebrew if it is not already available, then install tmux:

```bash
brew install tmux
```

tmux is strongly recommended. Regular terminals can fall back to a plain PTY, but
persistent terminals, Actions, and Project Q&A depend on tmux.

Verify the installation:

```bash
tmux -V
```

## 3. Install the coding agents

Only install the agents you plan to use.

### Codex

```bash
npm install -g @openai/codex
codex
```

The first run handles sign-in. Confirm afterward:

```bash
command -v codex
codex --version
```

See the
[official Codex CLI setup](https://help.openai.com/en/articles/11096431).

### Claude Code

Anthropic's native installer for macOS is:

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude
```

The first run opens the authentication flow. Confirm afterward:

```bash
command -v claude
claude --version
claude doctor
```

See the
[official Claude Code installation guide](https://code.claude.com/docs/en/installation).

## 4. Local-project preflight check

Run:

```bash
command -v tmux
command -v codex
command -v claude
```

A path should appear for each tool you intend to use.

If an agent works in Terminal but PanePilot reports `command not found`, launch
PanePilot from that terminal so it inherits the terminal's `PATH`:

```bash
/Applications/PanePilot.app/Contents/MacOS/PanePilot
```

## 5. SSH-project requirements

On every SSH host used by PanePilot, install:

- tmux.
- Python 3.
- Codex, if Codex sessions will run there.
- Claude Code, if Claude sessions will run there.
- Git, if the project uses Git.

For example, on Ubuntu:

```bash
sudo apt update
sudo apt install tmux python3 git
```

An SSH project executes its terminals on the SSH host. The remote host therefore
needs its own Codex and Claude installations and authentication.

Log into the host and authenticate each provider once:

```bash
ssh myserver
codex
claude
```

## 6. Configure SSH access

PanePilot reads named hosts from:

```text
~/.ssh/config
```

Example:

```sshconfig
Host myserver
  HostName 192.168.1.50
  User varun
  IdentityFile ~/.ssh/id_ed25519
```

Test it:

```bash
ssh myserver
```

Key-based authentication or a working SSH agent is strongly recommended. PanePilot's
background browsing, status checks, and tmux discovery cannot stop for an invisible
password prompt.

Test non-interactive access:

```bash
ssh -o BatchMode=yes myserver true
```

No output and a successful exit means it is ready.

## 7. Remote-host preflight check

Replace `myserver` with the SSH alias:

```bash
ssh myserver '
  command -v tmux
  command -v python3
  command -v git
  command -v codex
  command -v claude
'
```

Missing output means that particular program is not available to PanePilot on the
remote host.

## 8. Create the first project

### Local project

1. Open PanePilot.
2. Choose **New project**.
3. Select **This Mac**.
4. Choose an existing project folder.
5. Create the project.
6. Open **New terminal** and select Login shell, Codex, or Claude Code.

### SSH project

1. Confirm the SSH alias exists in `~/.ssh/config`.
2. Refresh the connection list in PanePilot.
3. Choose **New project**.
4. Select the SSH host.
5. Browse to or type the remote project folder.
6. Create the project.

## Quick checklist

- [ ] Apple silicon Mac with macOS 12 or newer.
- [ ] PanePilot installed and opened once through Control-click → Open.
- [ ] tmux installed locally.
- [ ] Codex and/or Claude installed and authenticated locally.
- [ ] SSH aliases configured in `~/.ssh/config`.
- [ ] Key-based or SSH-agent authentication works.
- [ ] tmux and Python 3 installed on each SSH host.
- [ ] Codex and/or Claude installed and authenticated on each SSH host where they
      will run.
- [ ] The project folders already exist.
- [ ] `command -v` checks return paths for the required tools.
