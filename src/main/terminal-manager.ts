import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import type { BrowserWindow } from 'electron'
import * as pty from 'node-pty'
import HeadlessXterm from '@xterm/headless'
import type {
  AgentState,
  Connection,
  LaunchProfile,
  StartTerminalInput,
  TerminalSession
} from '../shared/types'
import { acknowledgedAgentState, ScreenActivityDetector } from './screen-activity-detector'
import { Store } from './store'

const { Terminal: HeadlessTerminal } = HeadlessXterm
const TMUX_CANDIDATES = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux']
const AGENT_PROFILES = new Set<LaunchProfile>(['codex', 'claude'])

interface Runtime {
  pty: pty.IPty
  screen: InstanceType<typeof HeadlessTerminal>
  detector: ScreenActivityDetector | null
  scanTimer: NodeJS.Timeout | null
  closingForAppExit: boolean
  session: TerminalSession
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function resolveTmux(): string | null {
  const pathCandidate = spawnSync('sh', ['-lc', 'command -v tmux'], {
    encoding: 'utf8',
    timeout: 1_000
  }).stdout?.trim()
  if (pathCandidate && existsSync(pathCandidate)) return pathCandidate
  return TMUX_CANDIDATES.find(existsSync) ?? null
}

function remoteHasTmux(alias: string): boolean {
  const result = spawnSync(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=2', alias, 'command -v tmux'],
    { encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'] }
  )
  return result.status === 0 && Boolean(result.stdout.trim())
}

function launchCommand(profile: LaunchProfile, customCommand: string | null, dangerous: boolean): string {
  if (profile === 'shell') return 'exec "${SHELL:-/bin/sh}" -l'
  if (profile === 'custom') {
    return `exec "\${SHELL:-/bin/sh}" -lc ${quote(customCommand ?? '')}`
  }
  if (profile === 'codex') {
    const flag = dangerous ? ' --dangerously-bypass-approvals-and-sandbox' : ''
    return `exec codex${flag}`
  }
  const flag = dangerous ? ' --dangerously-skip-permissions' : ''
  return `exec claude${flag}`
}

export class TerminalManager {
  private readonly runtimes = new Map<string, Runtime>()
  private readonly tmuxPath = resolveTmux()

  constructor(
    private readonly store: Store,
    private readonly getWindow: () => BrowserWindow | null
  ) {}

  start(input: StartTerminalInput): TerminalSession {
    const project = this.store.getProject(input.projectId)
    if (!project) throw new Error('Project not found.')
    const connection = this.store.getConnection(project.connectionId)
    if (!connection) throw new Error('Project connection not found.')
    if (input.profile === 'custom' && !input.customCommand?.trim()) {
      throw new Error('Enter a custom command.')
    }

    const tmuxAvailable =
      connection.kind === 'local'
        ? Boolean(this.tmuxPath)
        : remoteHasTmux(connection.sshAlias ?? connection.name)
    const tmuxName = tmuxAvailable
      ? `panepilot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      : null
    const profileLabel =
      input.profile === 'shell'
        ? basename(process.env.SHELL || 'Shell')
        : input.profile === 'claude'
          ? 'Claude'
          : input.profile === 'codex'
            ? 'Codex'
            : 'Command'
    const sameProfileCount = project.sessions.filter(
      (session) => session.profile === input.profile
    ).length
    const session = this.store.createSession({
      projectId: input.projectId,
      name: input.name?.trim() || `${profileLabel} ${sameProfileCount + 1}`,
      profile: input.profile,
      customCommand: input.customCommand?.trim() || null,
      backend: tmuxAvailable ? 'tmux' : 'pty',
      tmuxName,
      dangerousMode: input.dangerousMode
    })
    this.launch(session, project.folder, connection, input.cols ?? 100, input.rows ?? 30, true)
    return this.store.getSession(session.id)!
  }

  attach(sessionId: string, cols: number, rows: number): { output: string } {
    const session = this.requireSession(sessionId)
    if (!this.runtimes.has(sessionId) && !['completed', 'error'].includes(session.state)) {
      const project = this.store.getProject(session.projectId)
      const connection = project ? this.store.getConnection(project.connectionId) : null
      if (!project || !connection) throw new Error('The terminal project is unavailable.')
      if (session.backend === 'pty') {
        this.changeState(
          session,
          'completed',
          `${session.name} could not be restored because it used a non-persistent PTY.`
        )
      } else {
        if (
          AGENT_PROFILES.has(session.profile) &&
          session.state !== 'idle' &&
          session.state !== 'needs-input'
        ) {
          this.changeState(session, 'idle')
        }
        this.launch(session, project.folder, connection, cols, rows, false)
      }
    }
    return { output: this.store.getSession(sessionId)?.output ?? '' }
  }

  write(sessionId: string, data: string): void {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) throw new Error('Terminal is not attached.')
    runtime.pty.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) return
    const safeCols = Math.max(20, Math.floor(cols))
    const safeRows = Math.max(5, Math.floor(rows))
    runtime.pty.resize(safeCols, safeRows)
    runtime.screen.resize(safeCols, safeRows)
  }

  acknowledge(sessionId: string): void {
    const session = this.requireSession(sessionId)
    const acknowledged = acknowledgedAgentState(session.state)
    if (acknowledged !== session.state) this.changeState(session, acknowledged)
  }

  rename(sessionId: string, name: string): void {
    const cleaned = name.trim()
    if (!cleaned) throw new Error('Terminal name cannot be empty.')
    this.store.renameSession(sessionId, cleaned)
  }

  stop(sessionId: string): void {
    const session = this.requireSession(sessionId)
    const runtime = this.runtimes.get(sessionId)
    if (runtime) {
      if (session.backend === 'tmux') {
        runtime.pty.write('\u0002:kill-session\r')
      } else {
        runtime.pty.kill()
      }
      setTimeout(() => {
        const current = this.runtimes.get(sessionId)
        if (current) current.pty.kill()
      }, 750).unref()
    }
    this.changeState(session, 'completed', `${session.name} was stopped.`)
  }

  archive(sessionId: string): void {
    this.store.archiveSession(sessionId, true)
  }

  restore(sessionId: string): void {
    this.store.archiveSession(sessionId, false)
  }

  delete(sessionId: string): void {
    this.store.deleteSession(sessionId)
  }

  shutdown(): void {
    for (const runtime of this.runtimes.values()) {
      runtime.closingForAppExit = true
      if (runtime.scanTimer) clearTimeout(runtime.scanTimer)
      runtime.pty.kill()
      runtime.screen.dispose()
    }
    this.runtimes.clear()
  }

  private launch(
    session: TerminalSession,
    folder: string,
    connection: Connection,
    cols: number,
    rows: number,
    create: boolean
  ): void {
    if (this.runtimes.has(session.id)) return
    const command = launchCommand(session.profile, session.customCommand, session.dangerousMode)
    const child = this.spawnTerminal(session, folder, connection, command, cols, rows, create)
    const screen = new HeadlessTerminal({
      cols,
      rows,
      scrollback: 1_000,
      allowProposedApi: true
    })
    const runtime: Runtime = {
      pty: child,
      screen,
      detector: AGENT_PROFILES.has(session.profile) ? new ScreenActivityDetector() : null,
      scanTimer: null,
      closingForAppExit: false,
      session
    }
    this.runtimes.set(session.id, runtime)

    child.onData((data) => {
      this.store.appendOutput(session.id, data)
      this.getWindow()?.webContents.send('terminal:data', { sessionId: session.id, data })
      screen.write(data, () => this.scheduleScreenScan(runtime))
    })
    child.onExit(({ exitCode }) => {
      if (runtime.scanTimer) clearTimeout(runtime.scanTimer)
      runtime.screen.dispose()
      this.runtimes.delete(session.id)
      if (runtime.closingForAppExit) return
      const latest = this.store.getSession(session.id)
      if (!latest || latest.state === 'completed') return
      this.changeState(
        latest,
        exitCode === 0 ? 'completed' : 'error',
        `${latest.name} exited${exitCode === 0 ? '.' : ` with code ${exitCode}.`}`
      )
    })
  }

  private spawnTerminal(
    session: TerminalSession,
    folder: string,
    connection: Connection,
    command: string,
    cols: number,
    rows: number,
    create: boolean
  ): pty.IPty {
    const env = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor'
    } as Record<string, string>

    if (connection.kind === 'ssh') {
      const alias = connection.sshAlias ?? connection.name
      let remoteCommand: string
      if (session.backend === 'tmux' && session.tmuxName) {
        const tmuxAction = create ? 'new-session -A -s' : 'attach-session -t'
        const commandSuffix = create ? ` ${quote(command)}` : ''
        remoteCommand = `cd ${quote(folder)} && exec tmux ${tmuxAction} ${quote(session.tmuxName)}${commandSuffix}`
      } else {
        remoteCommand = `cd ${quote(folder)} && ${command}`
      }
      return pty.spawn('ssh', ['-tt', alias, remoteCommand], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: homedir(),
        env
      })
    }

    if (session.backend === 'tmux' && session.tmuxName && this.tmuxPath) {
      const args = create
        ? ['new-session', '-A', '-s', session.tmuxName, '-c', folder, command]
        : ['attach-session', '-t', session.tmuxName]
      return pty.spawn(this.tmuxPath, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: folder,
        env
      })
    }

    const shell = process.env.SHELL || '/bin/sh'
    if (session.profile === 'shell') {
      return pty.spawn(shell, ['-l'], { name: 'xterm-256color', cols, rows, cwd: folder, env })
    }
    return pty.spawn(shell, ['-lc', command], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: folder,
      env
    })
  }

  private scheduleScreenScan(runtime: Runtime): void {
    if (!runtime.detector) return
    if (runtime.scanTimer) clearTimeout(runtime.scanTimer)
    runtime.scanTimer = setTimeout(() => {
      runtime.scanTimer = null
      const buffer = runtime.screen.buffer.active
      const start = buffer.viewportY
      const end = Math.min(buffer.length, start + runtime.screen.rows)
      const lines: string[] = []
      for (let index = start; index < end; index += 1) {
        lines.push(buffer.getLine(index)?.translateToString(true) ?? '')
      }
      const nextState = runtime.detector?.inspect(lines.join('\n'))
      if (nextState) {
        const latest = this.store.getSession(runtime.session.id)
        if (!latest) return
        const message =
          nextState === 'running'
            ? `${latest.name} is working.`
            : `${latest.name} finished and needs your attention.`
        this.changeState(latest, nextState, message)
      }
    }, 450)
    runtime.scanTimer.unref()
  }

  private changeState(session: TerminalSession, state: AgentState, message?: string): void {
    if (!this.store.setSessionState(session.id, state, message)) return
    this.getWindow()?.webContents.send('terminal:state', {
      sessionId: session.id,
      projectId: session.projectId,
      state
    })
  }

  private requireSession(id: string): TerminalSession {
    const session = this.store.getSession(id)
    if (!session) throw new Error('Terminal session not found.')
    return session
  }
}
