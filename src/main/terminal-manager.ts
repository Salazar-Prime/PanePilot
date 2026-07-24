import { execFile, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import type { BrowserWindow } from 'electron'
import * as pty from 'node-pty'
import HeadlessXterm from '@xterm/headless'
import type {
  AgentState,
  Connection,
  ConversationProvider,
  LaunchProfile,
  Project,
  StartTerminalInput,
  TerminalSession
} from '../shared/types'
import {
  codexComposerIsReady,
  codexRenameInput,
  createCodexSessionName
} from './codex-session-name'
import { ConversationIndexer } from './conversation-indexer'
import { RemoteConversationIndexer } from './remote-conversation-indexer'
import { acknowledgedAgentState, ScreenActivityDetector } from './screen-activity-detector'
import { Store } from './store'
import {
  panePilotTmuxMetadata,
  parseTmuxSessionList,
  sameRemoteProjectPath,
  tmuxMetadataShellCommand,
  tmuxSessionListFormat,
  type ListedTmuxSession,
  type PanePilotTmuxMetadata
} from './tmux-metadata'

const { Terminal: HeadlessTerminal } = HeadlessXterm
const execFileAsync = promisify(execFile)
const TMUX_CANDIDATES = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux']
const AGENT_PROFILES = new Set<LaunchProfile>(['codex', 'claude'])
const DISCOVERY_GRACE_MS = 15_000
const MAX_TMUX_LIST_OUTPUT = 1024 * 1024

interface Runtime {
  pty: pty.IPty
  screen: InstanceType<typeof HeadlessTerminal>
  detector: ScreenActivityDetector | null
  scanTimer: NodeJS.Timeout | null
  providerTimer: NodeJS.Timeout | null
  providerAttempts: number
  pendingProviderSessionName: string | null
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
  providerSessionReference: string | null = null
): string {
  if (profile === 'shell') return 'exec "${SHELL:-/bin/sh}" -l'
  if (profile === 'custom') {
    return `exec "\${SHELL:-/bin/sh}" -lc ${quote(customCommand ?? '')}`
  }
  if (profile === 'codex') {
    const flag = dangerous ? ' --dangerously-bypass-approvals-and-sandbox' : ''
    if (providerSessionReference) {
      return `exec codex resume${flag} ${quote(providerSessionReference)}`
    }
    return `exec codex${flag}`
  }
  const flag = dangerous ? ' --dangerously-skip-permissions' : ''
  if (providerSessionReference) {
    return `exec claude${flag} --resume ${quote(providerSessionReference)}`
  }
  return `exec claude${flag}`
}

function interactiveLoginCommand(command: string): string {
  return `exec "\${SHELL:-/bin/sh}" -lic ${quote(command)}`
}

export class TerminalManager {
  private readonly runtimes = new Map<string, Runtime>()
  private readonly remoteReconciliations = new Map<string, Promise<number>>()
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
    const providerSessionName =
      input.profile === 'codex' ? createCodexSessionName(sessionName, randomUUID()) : null
    const session = this.store.createSession({
      projectId: input.projectId,
      name: sessionName,
      profile: input.profile,
      providerSessionName,
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
        if (!AGENT_PROFILES.has(session.profile) || session.providerSessionId) continue
        try {
          await this.discoverProviderSession(session, project.folder, connection)
        } catch {
          // Archive discovery is best-effort. A later terminal launch or History
          // refresh can retry after SSH or provider storage becomes available.
        }
      }
    }
  }

  async reconcileRemoteSessions(connectionId?: string): Promise<number> {
    const projects = this.store
      .listProjects()
      .filter((project) => !project.archived)
    const connections = this.store
      .listConnections()
      .filter(
        (connection) =>
          connection.kind === 'ssh' &&
          (!connectionId || connection.id === connectionId) &&
          projects.some((project) => project.connectionId === connection.id)
      )
    const changes = await Promise.all(
      connections.map((connection) => {
        const active = this.remoteReconciliations.get(connection.id)
        if (active) return active
        const reconciliation = this.reconcileRemoteConnection(
          connection,
          projects.filter((project) => project.connectionId === connection.id)
        )
          .catch(() => 0)
          .finally(() => {
            this.remoteReconciliations.delete(connection.id)
          })
        this.remoteReconciliations.set(connection.id, reconciliation)
        return reconciliation
      })
    )
    return changes.reduce((total, count) => total + count, 0)
  }

  async syncSessionMetadata(
    sessionId: string,
    retryUntilAvailable = false
  ): Promise<boolean> {
    const attempts = retryUntilAvailable ? 5 : 1
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await this.syncSessionMetadataOnce(sessionId)) return true
      if (attempt + 1 < attempts) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 250 * (attempt + 1))
          timer.unref()
        })
      }
    }
    return false
  }

  private async syncSessionMetadataOnce(sessionId: string): Promise<boolean> {
    const session = this.store.getSession(sessionId)
    const project = session ? this.store.getProject(session.projectId) : null
    const connection = project ? this.store.getConnection(project.connectionId) : null
    if (
      !session ||
      !project ||
      !connection ||
      session.backend !== 'tmux' ||
      !session.tmuxName
    ) {
      return false
    }
    const metadata = this.metadataForSession(project, session)
    const command = tmuxMetadataShellCommand(
      metadata,
      session.tmuxName,
      true,
      connection.kind === 'local' ? this.tmuxPath ?? 'tmux' : 'tmux'
    )
    try {
      if (connection.kind === 'local') {
        const result = spawnSync('sh', ['-lc', command], {
          encoding: 'utf8',
          timeout: 4_000
        })
        if (result.error || result.status !== 0) return false
      } else {
        await execFileAsync(
          'ssh',
          [
            '-T',
            '-o',
            'BatchMode=yes',
            '-o',
            'ConnectTimeout=5',
            connection.sshAlias ?? connection.name,
            command
          ],
          {
            encoding: 'utf8',
            timeout: 8_000,
            maxBuffer: 256 * 1024
          }
        )
      }
      this.store.markSessionTmuxMetadataManaged(session.id)
      return true
    } catch {
      return false
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

  sendPrompt(sessionId: string, prompt: string): void {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) throw new Error('Open the chat before sending a message.')
    const cleaned = prompt.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
    if (!cleaned) throw new Error('Enter a message for the agent.')
    runtime.pty.write(`\x1b[200~${cleaned}\x1b[201~\r`)
    const latest = this.store.getSession(sessionId)
    if (latest && AGENT_PROFILES.has(latest.profile)) {
      this.changeState(latest, 'running', `${latest.name} is working.`)
    }
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

  resumeAgent(sessionId: string, dangerousModeConfirmed = false): void {
    const session = this.requireSession(sessionId)
    if (!AGENT_PROFILES.has(session.profile)) {
      throw new Error('Only Codex or Claude terminals can resume a linked chat.')
    }
    const providerSessionReference =
      session.providerSessionId ?? session.providerSessionName
    if (!providerSessionReference) {
      throw new Error(`This terminal is not linked to a ${session.profile} session yet.`)
    }
    if (!['completed', 'error'].includes(session.state)) {
      throw new Error(`This ${session.profile} terminal is already running.`)
    }
    if (session.archived) {
      throw new Error('Restore the archived terminal before resuming its agent chat.')
    }
    if (session.dangerousMode && !dangerousModeConfirmed) {
      throw new Error('Confirm dangerous mode again before resuming this agent.')
    }
    const project = this.store.getProject(session.projectId)
    const connection = project ? this.store.getConnection(project.connectionId) : null
    if (!project || !connection) throw new Error('The terminal project is unavailable.')

    const persistentSessionExists =
      session.backend === 'tmux' && session.tmuxName
        ? this.tmuxSessionExists(connection, session.tmuxName)
        : false
    const providerLabel = session.profile === 'claude' ? 'Claude' : 'Codex'
    this.changeState(
      session,
      'idle',
      `Resumed ${providerLabel} session ${providerSessionReference}.`
    )
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
    if (session.backend === 'tmux' && session.tmuxName) {
      const project = this.store.getProject(session.projectId)
      const connection = project ? this.store.getConnection(project.connectionId) : null
      if (!connection) throw new Error('Project connection not found.')
      this.killTmuxSession(connection, session.tmuxName)
    }
    runtime?.pty.kill()
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
      resumeProvider
        ? (session.providerSessionId ?? session.providerSessionName)
        : null
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
      pendingProviderSessionName:
        session.profile === 'codex' && create && !resumeProvider
          ? session.providerSessionName
          : null,
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
    if (!AGENT_PROFILES.has(runtime.session.profile) || runtime.session.providerSessionId) return
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
    if (!latest || !AGENT_PROFILES.has(latest.profile)) return false
    if (latest.providerSessionId) {
      await this.syncSessionMetadata(latest.id)
      return true
    }
    const excludedIds = this.store.listClaimedProviderSessionIds(connection.id)
    const provider = latest.profile as ConversationProvider
    const providerSessionId =
      connection.kind === 'local'
        ? this.conversations.findProviderSessionId(
            provider,
            folder,
            latest.createdAt,
            excludedIds
          )
        : await this.remoteConversations.findProviderSessionId(
            provider,
            connection.sshAlias ?? connection.name,
            folder,
            latest.createdAt,
            excludedIds
          )
    if (!providerSessionId) return false
    this.store.setSessionProviderId(latest.id, providerSessionId)
    await this.syncSessionMetadata(latest.id)
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
      let remoteLaunchCommand =
        session.profile === 'shell' ? command : interactiveLoginCommand(command)
      let remoteCommand: string
      if (session.backend === 'tmux' && session.tmuxName) {
        if (create) {
          const project = this.store.getProject(session.projectId)
          if (project) {
            const metadataCommand = tmuxMetadataShellCommand(
              this.metadataForSession(project, session)
            )
            remoteLaunchCommand =
              `(${metadataCommand}) || true; ${remoteLaunchCommand}`
          }
        }
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
      const project = this.store.getProject(session.projectId)
      const persistentCommand =
        create && project
          ? `(${tmuxMetadataShellCommand(
              this.metadataForSession(project, session),
              undefined,
              false,
              this.tmuxPath
            )}) || true; ${command}`
          : command
      const args = create
        ? ['new-session', '-s', session.tmuxName, '-c', folder, persistentCommand]
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
      if (runtime.pendingProviderSessionName && codexComposerIsReady(lines)) {
        const providerSessionName = runtime.pendingProviderSessionName
        runtime.pendingProviderSessionName = null
        runtime.pty.write(codexRenameInput(providerSessionName))
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

  private metadataForSession(
    project: Project,
    session: TerminalSession
  ): PanePilotTmuxMetadata {
    const latexSection =
      session.latexChat?.scope === 'section' && session.latexChat.sectionId
        ? this.store.getLatexSection(session.latexChat.sectionId)
        : null
    return panePilotTmuxMetadata({
      project,
      session,
      latexSection
    })
  }

  private async listRemoteTmuxSessions(
    connection: Connection
  ): Promise<ListedTmuxSession[] | null> {
    const format = tmuxSessionListFormat()
    const remoteCommand =
      `if command -v tmux >/dev/null 2>&1; then ` +
      `panepilot_output=$(tmux list-sessions -F ${quote(format)} 2>&1); ` +
      `panepilot_code=$?; ` +
      `if [ "$panepilot_code" -eq 0 ]; then ` +
      `printf '%s\\n' "$panepilot_output"; exit 0; fi; ` +
      `case "$panepilot_output" in ` +
      `*"no server running"*|*"failed to connect to server"*) exit 0 ;; ` +
      `*) printf '%s\\n' "$panepilot_output" >&2; exit "$panepilot_code" ;; ` +
      `esac; ` +
      `else exit 127; fi`
    try {
      const result = await execFileAsync(
        'ssh',
        [
          '-T',
          '-o',
          'BatchMode=yes',
          '-o',
          'ConnectTimeout=5',
          connection.sshAlias ?? connection.name,
          remoteCommand
        ],
        {
          encoding: 'utf8',
          timeout: 8_000,
          maxBuffer: MAX_TMUX_LIST_OUTPUT
        }
      )
      return parseTmuxSessionList(result.stdout)
    } catch {
      return null
    }
  }

  private projectForDiscoveredSession(
    projects: Project[],
    session: ListedTmuxSession
  ): Project | null {
    const metadata = session.metadata
    if (!metadata) return null
    const matchingPath = projects.filter((project) =>
      sameRemoteProjectPath(project.folder, metadata.projectPath)
    )
    return (
      matchingPath.find((project) => project.id === metadata.originProjectId) ??
      (matchingPath.length === 1 ? matchingPath[0] : null)
    )
  }

  private async reconcileRemoteConnection(
    connection: Connection,
    projects: Project[]
  ): Promise<number> {
    const listed = await this.listRemoteTmuxSessions(connection)
    if (!listed) return 0

    let changes = 0
    const liveMetadataIds = new Set(
      listed.flatMap((session) =>
        session.metadata ? [session.metadata.terminalId] : []
      )
    )
    const liveByName = new Map(listed.map((session) => [session.name, session]))

    for (const listedSession of listed) {
      const metadata = listedSession.metadata
      const project = this.projectForDiscoveredSession(projects, listedSession)
      if (!metadata || !project) continue
      const result = this.store.upsertDiscoveredTmuxSession(
        project.id,
        listedSession.name,
        metadata
      )
      if (!result) continue
      let changed = result.changed
      if (metadata.latex) {
        changed =
          this.store.upsertDiscoveredLatexChat(
            result.session.id,
            project.id,
            metadata.latex
          ) || changed
      }
      if (changed) {
        changes += 1
        this.getWindow()?.webContents.send('terminal:metadata', {
          sessionId: result.session.id,
          projectId: project.id
        })
      }
    }

    for (const project of projects) {
      for (const session of project.sessions) {
        if (
          session.backend !== 'tmux' ||
          !session.tmuxName ||
          session.state === 'completed' ||
          session.state === 'error'
        ) {
          continue
        }
        if (liveMetadataIds.has(session.id)) continue
        const nameMatch = liveByName.get(session.tmuxName)
        if (nameMatch && !nameMatch.metadata) {
          if (await this.syncSessionMetadata(session.id)) {
            changes += 1
            liveMetadataIds.add(session.id)
          }
          continue
        }
        if (
          this.store.getSessionTmuxMetadataVersion(session.id) === 1 &&
          !this.runtimes.has(session.id) &&
          Date.now() - Date.parse(session.createdAt) > DISCOVERY_GRACE_MS &&
          this.store.markMissingTmuxSession(session.id)
        ) {
          changes += 1
          this.getWindow()?.webContents.send('terminal:state', {
            sessionId: session.id,
            projectId: project.id,
            state: 'completed'
          })
        }
      }
    }
    return changes
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

  private killTmuxSession(connection: Connection, name: string): void {
    if (connection.kind === 'local') {
      if (!this.tmuxPath) {
        throw new Error('Tmux is unavailable, so the persistent session could not be stopped.')
      }
      if (!this.tmuxSessionExists(connection, name)) return
      const result = spawnSync(this.tmuxPath, ['kill-session', '-t', `=${name}`], {
        encoding: 'utf8',
        timeout: 3_000
      })
      if (result.error || result.status !== 0) {
        const detail = result.error?.message || result.stderr?.trim()
        throw new Error(detail || `Could not stop tmux session “${name}”.`)
      }
      if (this.tmuxSessionExists(connection, name)) {
        throw new Error(`Tmux session “${name}” is still running.`)
      }
      return
    }

    const target = quote(`=${name}`)
    const remoteCommand =
      `if tmux has-session -t ${target} 2>/dev/null; then ` +
      `tmux kill-session -t ${target}; else status=$?; test "$status" -eq 1; fi`
    const result = spawnSync(
      'ssh',
      [
        '-T',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=5',
        connection.sshAlias ?? connection.name,
        remoteCommand
      ],
      { encoding: 'utf8', timeout: 7_000 }
    )
    if (result.error || result.status !== 0) {
      const detail = result.error?.message || result.stderr?.trim()
      throw new Error(detail || `Could not stop remote tmux session “${name}”.`)
    }
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
