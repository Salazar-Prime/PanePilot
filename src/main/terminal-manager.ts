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
import { ConversationIndexer } from './conversation-indexer'
import { RemoteConversationIndexer } from './remote-conversation-indexer'
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
  providerTimer: NodeJS.Timeout | null
  providerAttempts: number
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

function validatedTerminalName(value: string): string {
  const name = value.trim()
  if (!name) throw new Error('Terminal name cannot be empty.')
  if (name.length > 80) throw new Error('Terminal names must be 80 characters or fewer.')
  if (/[:\u0000-\u001f\u007f]/.test(name)) {
    throw new Error('Terminal names cannot contain colons or control characters.')
  }
  return name
}

function launchCommand(
  profile: LaunchProfile,
  customCommand: string | null,
  dangerous: boolean,
  providerSessionId: string | null = null
): string {
  if (profile === 'shell') return 'exec "${SHELL:-/bin/sh}" -l'
  if (profile === 'custom') {
    return `exec "\${SHELL:-/bin/sh}" -lc ${quote(customCommand ?? '')}`
  }
  if (profile === 'codex') {
    const flag = dangerous ? ' --dangerously-bypass-approvals-and-sandbox' : ''
    if (providerSessionId) {
      return `exec codex resume${flag} ${quote(providerSessionId)}`
    }
    return `exec codex${flag}`
  }
  const flag = dangerous ? ' --dangerously-skip-permissions' : ''
  return `exec claude${flag}`
}

function interactiveLoginCommand(command: string): string {
  return `exec "\${SHELL:-/bin/sh}" -lic ${quote(command)}`
}

export class TerminalManager {
  private readonly runtimes = new Map<string, Runtime>()
  private readonly tmuxPath = resolveTmux()

  constructor(
    private readonly store: Store,
    private readonly getWindow: () => BrowserWindow | null,
    private readonly conversations: ConversationIndexer,
    private readonly remoteConversations: RemoteConversationIndexer
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
    const requestedName = input.name ? validatedTerminalName(input.name) : null
    let sessionName = requestedName || `${profileLabel} ${sameProfileCount + 1}`
    if (tmuxAvailable) {
      const baseName = sessionName
      let suffix = 2
      while (this.tmuxSessionExists(connection, sessionName)) {
        const suffixText = ` ${suffix}`
        sessionName = `${baseName.slice(0, 80 - suffixText.length).trimEnd()}${suffixText}`
        suffix += 1
      }
    }
    const tmuxName = tmuxAvailable ? sessionName : null
    const session = this.store.createSession({
      projectId: input.projectId,
      name: sessionName,
      profile: input.profile,
      customCommand: input.customCommand?.trim() || null,
      backend: tmuxAvailable ? 'tmux' : 'pty',
      tmuxName,
      dangerousMode: input.dangerousMode
    })
    this.launch(session, project.folder, connection, input.cols ?? 100, input.rows ?? 30, true)
    return this.store.getSession(session.id)!
  }

  async discoverSavedProviderSessions(): Promise<void> {
    for (const project of this.store.listProjects()) {
      const connection = this.store.getConnection(project.connectionId)
      if (!connection) continue
      for (const session of project.sessions) {
        if (session.profile !== 'codex' || session.providerSessionId) continue
        try {
          await this.discoverProviderSession(session, project.folder, connection)
        } catch {
          // Archive discovery is best-effort. A later terminal launch or History
          // refresh can retry after SSH or provider storage becomes available.
        }
      }
    }
  }

  attach(sessionId: string, cols: number, rows: number): { output: string } {
    let session = this.requireSession(sessionId)
    if (session.backend === 'tmux' && session.tmuxName !== session.name) {
      this.rename(sessionId, session.name)
      session = this.requireSession(sessionId)
    }
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

  resumeAgent(sessionId: string): void {
    const session = this.requireSession(sessionId)
    if (session.profile !== 'codex') {
      throw new Error('Only Codex terminals can resume a linked Codex chat.')
    }
    if (!session.providerSessionId) {
      throw new Error('This terminal is not linked to a Codex session yet.')
    }
    if (!['completed', 'error'].includes(session.state)) {
      throw new Error('This Codex terminal is already running.')
    }
    if (session.archived) {
      throw new Error('Restore the archived terminal before resuming its Codex chat.')
    }
    const project = this.store.getProject(session.projectId)
    const connection = project ? this.store.getConnection(project.connectionId) : null
    if (!project || !connection) throw new Error('The terminal project is unavailable.')

    const persistentSessionExists =
      session.backend === 'tmux' && session.tmuxName
        ? this.tmuxSessionExists(connection, session.tmuxName)
        : false
    this.changeState(session, 'idle', `Resumed Codex session ${session.providerSessionId}.`)
    const latest = this.requireSession(sessionId)
    try {
      this.launch(
        latest,
        project.folder,
        connection,
        100,
        30,
        !persistentSessionExists,
        !persistentSessionExists
      )
    } catch (error) {
      this.changeState(
        this.requireSession(sessionId),
        'error',
        `Could not resume ${session.name}.`
      )
      throw error
    }
  }

  rename(sessionId: string, name: string): void {
    const cleaned = validatedTerminalName(name)
    const session = this.requireSession(sessionId)
    let tmuxName = session.tmuxName
    if (session.backend === 'tmux' && session.tmuxName) {
      if (cleaned === session.name && cleaned === session.tmuxName) return
      const project = this.store.getProject(session.projectId)
      const connection = project ? this.store.getConnection(project.connectionId) : null
      if (!connection) throw new Error('Project connection not found.')
      const persistentSessionExists = this.tmuxSessionExists(
        connection,
        session.tmuxName
      )
      if (cleaned !== session.tmuxName && persistentSessionExists) {
        if (this.tmuxSessionExists(connection, cleaned)) {
          throw new Error(
            `A tmux session named “${cleaned}” already exists on ${connection.name}.`
          )
        }
      }
      const renamedTmux = cleaned
      if (persistentSessionExists) {
        const result =
          connection.kind === 'local'
            ? this.tmuxPath
              ? spawnSync(
                  this.tmuxPath,
                  ['rename-session', '-t', `=${session.tmuxName}`, renamedTmux],
                  { encoding: 'utf8', timeout: 3_000 }
                )
              : null
            : spawnSync(
                'ssh',
                [
                  '-T',
                  '-o',
                  'BatchMode=yes',
                  '-o',
                  'ConnectTimeout=5',
                  connection.sshAlias ?? connection.name,
                  `tmux rename-session -t ${quote(`=${session.tmuxName}`)} ${quote(renamedTmux)}`
                ],
                { encoding: 'utf8', timeout: 7_000 }
              )
        if (!result || result.error || result.status !== 0) {
          const detail = result?.error?.message || result?.stderr?.trim()
          throw new Error(detail || 'Could not rename the persistent tmux session.')
        }
      }
      tmuxName = renamedTmux
    }
    if (cleaned === session.name && tmuxName === session.tmuxName) return
    this.store.renameSession(sessionId, cleaned, tmuxName)
    const runtime = this.runtimes.get(sessionId)
    const latest = this.store.getSession(sessionId)
    if (runtime && latest) runtime.session = latest
  }

  setPinned(sessionId: string, pinned: boolean): void {
    this.store.setSessionPinned(sessionId, pinned)
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
      if (runtime.providerTimer) clearTimeout(runtime.providerTimer)
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
    create: boolean,
    resumeProvider = false
  ): void {
    if (this.runtimes.has(session.id)) return
    const command = launchCommand(
      session.profile,
      session.customCommand,
      session.dangerousMode,
      resumeProvider ? session.providerSessionId : null
    )
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
      providerTimer: null,
      providerAttempts: 0,
      closingForAppExit: false,
      session
    }
    this.runtimes.set(session.id, runtime)
    this.scheduleProviderDiscovery(runtime, folder, connection)

    child.onData((data) => {
      this.store.appendOutput(session.id, data)
      this.getWindow()?.webContents.send('terminal:data', { sessionId: session.id, data })
      screen.write(data, () => this.scheduleScreenScan(runtime))
    })
    child.onExit(({ exitCode }) => {
      if (runtime.scanTimer) clearTimeout(runtime.scanTimer)
      if (runtime.providerTimer) clearTimeout(runtime.providerTimer)
      runtime.screen.dispose()
      this.runtimes.delete(session.id)
      if (runtime.closingForAppExit) return
      const latest = this.store.getSession(session.id)
      if (!latest) return
      void this.discoverProviderSession(latest, folder, connection)
      if (latest.state === 'completed') return
      this.changeState(
        latest,
        exitCode === 0 ? 'completed' : 'error',
        `${latest.name} exited${exitCode === 0 ? '.' : ` with code ${exitCode}.`}`
      )
    })
  }

  private scheduleProviderDiscovery(
    runtime: Runtime,
    folder: string,
    connection: Connection
  ): void {
    if (runtime.session.profile !== 'codex' || runtime.session.providerSessionId) return
    if (runtime.providerTimer || runtime.providerAttempts >= 45) return
    runtime.providerTimer = setTimeout(() => {
      runtime.providerTimer = null
      runtime.providerAttempts += 1
      void this.discoverProviderSession(runtime.session, folder, connection)
        .then((linked) => {
          const latest = this.store.getSession(runtime.session.id)
          if (!latest) return
          runtime.session = latest
          if (!linked && this.runtimes.has(runtime.session.id)) {
            this.scheduleProviderDiscovery(runtime, folder, connection)
          }
        })
        .catch(() => {
          if (this.runtimes.has(runtime.session.id)) {
            this.scheduleProviderDiscovery(runtime, folder, connection)
          }
        })
    }, runtime.providerAttempts === 0 ? 900 : 1_500)
    runtime.providerTimer.unref()
  }

  private async discoverProviderSession(
    session: TerminalSession,
    folder: string,
    connection: Connection
  ): Promise<boolean> {
    const latest = this.store.getSession(session.id)
    if (!latest || latest.profile !== 'codex') return false
    if (latest.providerSessionId) return true
    const excludedIds = this.store.listClaimedProviderSessionIds(connection.id)
    const providerSessionId =
      connection.kind === 'local'
        ? this.conversations.findCodexSessionId(folder, latest.createdAt, excludedIds)
        : await this.remoteConversations.findCodexSessionId(
            connection.sshAlias ?? connection.name,
            folder,
            latest.createdAt,
            excludedIds
          )
    if (!providerSessionId) return false
    if (!this.store.setSessionProviderId(latest.id, providerSessionId)) return true
    this.getWindow()?.webContents.send('terminal:metadata', {
      sessionId: latest.id,
      projectId: latest.projectId
    })
    return true
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
      const remoteLaunchCommand =
        session.profile === 'shell' ? command : interactiveLoginCommand(command)
      let remoteCommand: string
      if (session.backend === 'tmux' && session.tmuxName) {
        const tmuxAction = create ? 'new-session -s' : 'attach-session -t'
        const tmuxTarget = create ? session.tmuxName : `=${session.tmuxName}`
        const commandSuffix = create ? ` ${quote(remoteLaunchCommand)}` : ''
        remoteCommand = `cd ${quote(folder)} && exec tmux ${tmuxAction} ${quote(tmuxTarget)}${commandSuffix}`
      } else {
        remoteCommand = `cd ${quote(folder)} && ${remoteLaunchCommand}`
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
        ? ['new-session', '-s', session.tmuxName, '-c', folder, command]
        : ['attach-session', '-t', `=${session.tmuxName}`]
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
    if (runtime.scanTimer) return
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
    }, 120)
    runtime.scanTimer.unref()
  }

  private tmuxSessionExists(connection: Connection, name: string): boolean {
    if (connection.kind === 'local') {
      if (!this.tmuxPath) return false
      return (
        spawnSync(this.tmuxPath, ['has-session', '-t', `=${name}`], {
          encoding: 'utf8',
          timeout: 2_000,
          stdio: ['ignore', 'ignore', 'ignore']
        }).status === 0
      )
    }
    const alias = connection.sshAlias ?? connection.name
    return (
      spawnSync(
        'ssh',
        [
          '-T',
          '-o',
          'BatchMode=yes',
          '-o',
          'ConnectTimeout=3',
          alias,
          `tmux has-session -t ${quote(`=${name}`)}`
        ],
        {
          encoding: 'utf8',
          timeout: 5_000,
          stdio: ['ignore', 'ignore', 'ignore']
        }
      ).status === 0
    )
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
