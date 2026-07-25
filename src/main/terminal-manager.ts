import { execFile, spawnSync } from 'node:child_process'
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
  CreateProjectActionInput,
  LaunchProfile,
  Project,
  ProjectAction,
  StartTerminalInput,
  TerminalSession,
  TerminalSessionKind,
  TerminalTransportState,
  UpdateProjectActionInput
} from '../shared/types'
import {
  codexStateFromPaneTitle,
  codexThreadReferenceFromPaneTitle
} from './codex-pane-status'
import { normalizeCodexThreadId } from './codex-thread-id'
import { ConversationIndexer } from './conversation-indexer'
import { ProjectMetadataService } from './project-metadata-service'
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
const REMOTE_TMUX_CANDIDATES = [
  '/opt/homebrew/bin/tmux',
  '/usr/local/bin/tmux',
  '/usr/bin/tmux',
  '/home/linuxbrew/.linuxbrew/bin/tmux',
  '"$HOME/.linuxbrew/bin/tmux"'
]
const AGENT_PROFILES = new Set<LaunchProfile>(['codex', 'claude'])
const DISCOVERY_GRACE_MS = 15_000
const MAX_TMUX_LIST_OUTPUT = 1024 * 1024
const RECONNECT_DELAYS_MS = [0, 1_000, 2_000, 5_000, 10_000, 30_000]
const OUTPUT_FLUSH_DELAY_MS = 50
const OUTPUT_RETRY_DELAY_MS = 500
const OUTPUT_BUFFER_LIMIT = 512 * 1024
const ACTION_COMPLETION_POLL_MS = 250
const MAX_ACTION_CAPTURE_OUTPUT = 1024 * 1024
const CODEX_TMUX_TITLE_CONFIG =
  'tui.terminal_title=["activity","run-state","task-progress","thread-id"]'

interface Runtime {
  pty: pty.IPty
  screen: InstanceType<typeof HeadlessTerminal>
  title: string
  detector: ScreenActivityDetector | null
  scanTimer: NodeJS.Timeout | null
  providerTimer: NodeJS.Timeout | null
  actionTimer: NodeJS.Timeout | null
  providerAttempts: number
  outputClosed: boolean
  closingTransport: boolean
  intentionalStop: boolean
  cols: number
  rows: number
  folder: string
  connection: Connection
  session: TerminalSession
}

interface ReconnectRuntime {
  sessionId: string
  cols: number
  rows: number
  attempt: number
  lastExitCode: number
  timer: NodeJS.Timeout | null
  transportState: 'reconnecting' | 'offline'
}

interface PendingOutput {
  chunks: string[]
  length: number
  timer: NodeJS.Timeout | null
  warned: boolean
}

interface ActionPaneSnapshot {
  exitCode: number
  output: string
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

function remoteTmuxResolutionCommand(): string {
  return (
    `panepilot_tmux=$(command -v tmux 2>/dev/null || true); ` +
    `if [ -z "$panepilot_tmux" ]; then ` +
    `for panepilot_candidate in ${REMOTE_TMUX_CANDIDATES.join(' ')}; do ` +
    `if [ -x "$panepilot_candidate" ]; then panepilot_tmux="$panepilot_candidate"; break; fi; ` +
    `done; fi; ` +
    `if [ -z "$panepilot_tmux" ]; then ` +
    `panepilot_tmux=$("\${SHELL:-/bin/sh}" -lic 'command -v tmux' 2>/dev/null | tail -n 1); ` +
    `fi; ` +
    `case "$panepilot_tmux" in ` +
    `/*) test -x "$panepilot_tmux" || exit 127 ;; ` +
    `*) exit 127 ;; ` +
    `esac`
  )
}

function resolveRemoteTmux(alias: string): string | null {
  const discoveryCommand =
    `${remoteTmuxResolutionCommand()}; ` +
    `printf '%s\\n' "$panepilot_tmux"`
  const result = spawnSync(
    'ssh',
    [
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=3',
      alias,
      discoveryCommand
    ],
    { encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'] }
  )
  if (result.status !== 0) return null
  const path = result.stdout
    .trim()
    .split(/\r?\n/)
    .at(-1)
    ?.trim()
  if (
    !path ||
    !path.startsWith('/') ||
    path.length > 4_096 ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    return null
  }
  return path
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

function generatedTerminalName(value: string): string {
  const cleaned = value
    .replace(/[:\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return cleaned || 'PanePilot session'
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
    const titleConfig = ` -c ${quote(CODEX_TMUX_TITLE_CONFIG)}`
    if (providerSessionReference) {
      return `exec codex${titleConfig} resume${flag} ${quote(providerSessionReference)}`
    }
    return `exec codex${flag}${titleConfig}`
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
  private readonly reconnects = new Map<string, ReconnectRuntime>()
  private readonly remoteReconciliations = new Map<string, Promise<number>>()
  private readonly remoteTmuxPaths = new Map<string, string>()
  private readonly pendingOutput = new Map<string, PendingOutput>()
  private readonly tmuxPath = resolveTmux()
  private readonly metadata: ProjectMetadataService
  private shuttingDown = false

  constructor(
    private readonly store: Store,
    private readonly getWindow: () => BrowserWindow | null,
    private readonly conversations: ConversationIndexer,
    private readonly remoteConversations: RemoteConversationIndexer,
    metadata?: ProjectMetadataService
  ) {
    this.metadata = metadata ?? new ProjectMetadataService(store)
  }

  start(input: StartTerminalInput): TerminalSession {
    if (input.profile === 'custom') {
      throw new Error('Create a project Action to run a custom command.')
    }
    return this.startSession(input, 'terminal')
  }

  createAction(input: CreateProjectActionInput): ProjectAction {
    return this.metadata.createAction(input)
  }

  updateAction(input: UpdateProjectActionInput): ProjectAction {
    const action = this.metadata.updateAction(input)
    if (action.lastSessionId) void this.syncSessionMetadata(action.lastSessionId)
    return action
  }

  syncActions(projectId: string): ProjectAction[] {
    return this.metadata.syncActions(projectId)
  }

  runAction(actionId: string): TerminalSession {
    const action = this.store.getProjectAction(actionId)
    if (!action) throw new Error('Action not found.')
    this.requireProjectTmux(action.projectId, 'Actions')
    const previous = action.lastSessionId
      ? this.store.getSession(action.lastSessionId)
      : null
    if (previous && !['completed', 'error'].includes(previous.state)) {
      throw new Error('This action is already running.')
    }
    if (previous) {
      this.discardPendingOutput(previous.id)
      this.store.deleteSession(previous.id)
    }
    return this.startSession(
      {
        projectId: action.projectId,
        name: generatedTerminalName(`Action · ${action.name}`),
        profile: 'custom',
        customCommand: action.command,
        dangerousMode: false
      },
      'action',
      (session) => this.store.setProjectActionSession(action.id, session.id),
      true
    )
  }

  stopAction(actionId: string): void {
    const action = this.store.getProjectAction(actionId)
    if (!action?.lastSessionId) throw new Error('This action has no run to stop.')
    const session = this.store.getSession(action.lastSessionId)
    if (!session || ['completed', 'error'].includes(session.state)) return
    this.stop(session.id)
  }

  deleteAction(actionId: string): void {
    const action = this.store.getProjectAction(actionId)
    if (!action) throw new Error('Action not found.')
    const session = action.lastSessionId
      ? this.store.getSession(action.lastSessionId)
      : null
    if (session && !['completed', 'error'].includes(session.state)) {
      this.stop(session.id)
    }
    this.metadata.deleteAction(actionId)
  }

  async startProjectQna(projectId: string): Promise<TerminalSession> {
    let existing = this.store.getProjectQnaSession(projectId)
    const project = this.store.getProject(projectId)
    if (!project || project.archived) throw new Error('Choose an active project.')
    const connection = this.store.getConnection(project.connectionId)
    if (!connection) throw new Error('Project connection not found.')
    this.requireProjectTmux(projectId, 'Project Q&A')

    if (existing) {
      if (!['completed', 'error'].includes(existing.state)) return existing
      if (!existing.providerSessionId) {
        try {
          await this.discoverProviderSession(existing, project.folder, connection)
        } catch {
          // A failed first launch has no provider thread to resume. The fresh
          // Q&A session below replaces that unusable local record.
        }
        existing = this.store.getSession(existing.id)
      }
      if (existing?.providerSessionId) {
        this.resumeAgent(existing.id)
        return this.requireSession(existing.id)
      }
      if (
        existing?.backend === 'tmux' &&
        existing.tmuxName &&
        this.tmuxSessionExists(connection, existing.tmuxName)
      ) {
        this.changeState(
          existing,
          'idle',
          `Reattached the existing project Q&A session.`
        )
        const latest = this.requireSession(existing.id)
        this.launch(latest, project.folder, connection, 100, 30, false)
        return this.requireSession(existing.id)
      }
      if (existing) {
        this.discardPendingOutput(existing.id)
        this.store.deleteSession(existing.id)
      }
    }

    return this.startSession(
      {
        projectId,
        name: generatedTerminalName(`Q&A · ${project.name}`),
        profile: 'codex',
        dangerousMode: false
      },
      'project-qna',
      undefined,
      true
    )
  }

  sendProjectQnaPrompt(sessionId: string, prompt: string): void {
    const session = this.requireSession(sessionId)
    if (session.kind !== 'project-qna' || session.profile !== 'codex') {
      throw new Error('Project Q&A session not found.')
    }
    this.sendPrompt(
      sessionId,
      `Answer this question about the current project. Do not modify files. ${prompt}`
    )
  }

  resetProjectQna(projectId: string): void {
    const project = this.store.getProject(projectId)
    if (!project || project.archived) throw new Error('Choose an active project.')
    const existing = this.store.getProjectQnaSession(projectId)
    if (!existing) return
    this.delete(existing.id)
  }

  private startSession(
    input: StartTerminalInput,
    kind: TerminalSessionKind,
    onPersist?: (session: TerminalSession) => void,
    tmuxAlreadyConfirmed = false
  ): TerminalSession {
    const project = this.store.getProject(input.projectId)
    if (!project) throw new Error('Project not found.')
    const connection = this.store.getConnection(project.connectionId)
    if (!connection) throw new Error('Project connection not found.')
    if (input.profile === 'custom' && !input.customCommand?.trim()) {
      throw new Error('Enter a custom command.')
    }
    if (input.codexThreadId && input.profile !== 'codex') {
      throw new Error('A Codex thread ID can only be used with the Codex profile.')
    }
    const codexThreadId =
      input.profile === 'codex'
        ? normalizeCodexThreadId(input.codexThreadId)
        : null
    if (
      codexThreadId &&
      this.store
        .listClaimedProviderSessionIds(connection.id)
        .has(codexThreadId)
    ) {
      throw new Error(
        'That Codex thread is already linked to another terminal on this connection.'
      )
    }

    const tmuxAvailable =
      tmuxAlreadyConfirmed || this.connectionHasTmux(connection)
    if (
      (kind === 'action' || kind === 'project-qna') &&
      !tmuxAvailable
    ) {
      throw new Error(
        `${kind === 'action' ? 'Actions' : 'Project Q&A'} require tmux on this connection.`
      )
    }
    const profileLabel =
      input.profile === 'shell'
        ? basename(process.env.SHELL || 'Shell')
        : input.profile === 'claude'
          ? 'Claude'
          : input.profile === 'codex'
            ? 'Codex'
            : 'Command'
    const sameProfileCount = project.sessions.filter(
      (session) =>
        session.profile === input.profile &&
        session.kind !== 'action' &&
        session.kind !== 'project-qna'
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
    const createdSession = this.store.createSession({
      projectId: input.projectId,
      kind,
      name: sessionName,
      profile: input.profile,
      providerSessionName: null,
      customCommand: input.customCommand?.trim() || null,
      backend: tmuxAvailable ? 'tmux' : 'pty',
      tmuxName,
      dangerousMode: input.dangerousMode
    })
    if (codexThreadId) {
      this.store.setSessionProviderId(
        createdSession.id,
        'codex',
        codexThreadId
      )
    }
    const session = this.requireSession(createdSession.id)
    try {
      onPersist?.(session)
      this.launch(
        session,
        project.folder,
        connection,
        input.cols ?? 100,
        input.rows ?? 30,
        true,
        Boolean(codexThreadId)
      )
    } catch (error) {
      this.changeState(
        this.requireSession(session.id),
        'error',
        `${session.name} could not be started.`
      )
      throw error
    }
    return this.store.getSession(session.id)!
  }

  private connectionHasTmux(connection: Connection): boolean {
    return Boolean(this.tmuxPathForConnection(connection))
  }

  private tmuxPathForConnection(connection: Connection): string | null {
    if (connection.kind === 'local') return this.tmuxPath
    const cached = this.remoteTmuxPaths.get(connection.id)
    if (cached) return cached
    const resolved = resolveRemoteTmux(connection.sshAlias ?? connection.name)
    if (resolved) this.remoteTmuxPaths.set(connection.id, resolved)
    return resolved
  }

  private requireProjectTmux(projectId: string, capability: string): void {
    const project = this.store.getProject(projectId)
    const connection = project
      ? this.store.getConnection(project.connectionId)
      : null
    if (!project || !connection) throw new Error('Project connection not found.')
    if (!this.connectionHasTmux(connection)) {
      throw new Error(`${capability} requires tmux on this connection.`)
    }
  }

  async discoverSavedProviderSessions(): Promise<void> {
    if (this.shuttingDown) return
    for (const project of this.store.listProjects()) {
      if (this.shuttingDown) return
      const connection = this.store.getConnection(project.connectionId)
      if (!connection) continue
      for (const session of project.sessions) {
        if (this.shuttingDown) return
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
    if (this.shuttingDown) return 0
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
    if (this.shuttingDown) return false
    const attempts = retryUntilAvailable ? 5 : 1
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (this.shuttingDown) return false
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
    if (this.shuttingDown) return false
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
    const tmuxCommand = this.tmuxPathForConnection(connection)
    if (!tmuxCommand) return false
    const metadata = this.metadataForSession(project, session)
    const command = tmuxMetadataShellCommand(
      metadata,
      session.tmuxName,
      true,
      tmuxCommand
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
      if (this.shuttingDown) return false
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
    const reconnect = this.reconnects.get(sessionId)
    if (reconnect) {
      reconnect.cols = cols
      reconnect.rows = rows
      this.emitTransport(
        sessionId,
        reconnect.transportState,
        reconnect.attempt,
        reconnect.transportState === 'offline'
          ? 'The remote host is offline. PanePilot will keep retrying.'
          : 'Reconnecting to the existing tmux session…'
      )
    } else if (
      !this.runtimes.has(sessionId) &&
      !['completed', 'error'].includes(session.state)
    ) {
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
          connection.kind === 'local' &&
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

  retryAttach(sessionId: string, cols: number, rows: number): void {
    const session = this.requireSession(sessionId)
    if (['completed', 'error'].includes(session.state)) {
      throw new Error('This terminal is no longer running.')
    }
    const project = this.store.getProject(session.projectId)
    const connection = project ? this.store.getConnection(project.connectionId) : null
    if (!project || !connection) throw new Error('The terminal project is unavailable.')

    if (session.backend !== 'tmux' || !session.tmuxName) {
      if (this.runtimes.has(sessionId)) {
        this.emitTransport(sessionId, 'attached')
        return
      }
      this.launch(session, project.folder, connection, cols, rows, false)
      return
    }

    const runtime = this.runtimes.get(sessionId)
    const nextCols = runtime?.cols ?? cols
    const nextRows = runtime?.rows ?? rows
    if (
      connection.kind === 'local' &&
      !this.tmuxSessionExists(connection, session.tmuxName)
    ) {
      this.changeState(
        session,
        'completed',
        `${session.name} is no longer running in tmux.`
      )
      this.emitTransport(
        session.id,
        'detached',
        0,
        'The tmux session no longer exists.'
      )
      throw new Error(`Tmux session “${session.tmuxName}” no longer exists.`)
    }

    if (runtime) this.closeRuntimeForReconnect(runtime)
    this.cancelReconnect(sessionId)
    this.emitTransport(
      sessionId,
      'reconnecting',
      1,
      'Reconnecting to the existing tmux session…'
    )
    if (connection.kind === 'local') {
      this.launch(
        this.requireSession(sessionId),
        project.folder,
        connection,
        nextCols,
        nextRows,
        false
      )
      return
    }

    this.beginRemoteReconnect(session.id, nextCols, nextRows, 0, true)
  }

  reconnectAfterWake(): void {
    for (const runtime of this.runtimes.values()) {
      if (
        runtime.connection.kind !== 'ssh' ||
        runtime.session.backend !== 'tmux'
      ) {
        continue
      }
      this.emitTransport(
        runtime.session.id,
        'reconnecting',
        1,
        'Laptop resumed. Reconnecting to the existing tmux session…'
      )
      runtime.pty.kill()
    }
    for (const reconnect of [...this.reconnects.values()]) {
      this.beginRemoteReconnect(
        reconnect.sessionId,
        reconnect.cols,
        reconnect.rows,
        reconnect.lastExitCode,
        true
      )
    }
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
    const reconnect = this.reconnects.get(sessionId)
    const runtime = this.runtimes.get(sessionId)
    const safeCols = Math.max(20, Math.floor(cols))
    const safeRows = Math.max(5, Math.floor(rows))
    if (reconnect) {
      reconnect.cols = safeCols
      reconnect.rows = safeRows
    }
    if (!runtime) return
    runtime.cols = safeCols
    runtime.rows = safeRows
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
    const providerSessionReference = session.providerSessionId
    if (!providerSessionReference) {
      throw new Error(
        `This terminal does not have a verified ${session.profile === 'codex' ? 'Codex thread' : 'Claude session'} ID yet.`
      )
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
      const connectionTmuxPath = this.tmuxPathForConnection(connection)
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
            ? connectionTmuxPath
              ? spawnSync(
                  connectionTmuxPath,
                  ['rename-session', '-t', `=${session.tmuxName}`, renamedTmux],
                  { encoding: 'utf8', timeout: 3_000 }
                )
              : null
            : connectionTmuxPath
              ? spawnSync(
                  'ssh',
                  [
                    '-T',
                    '-o',
                    'BatchMode=yes',
                    '-o',
                    'ConnectTimeout=5',
                    connection.sshAlias ?? connection.name,
                    `${quote(connectionTmuxPath)} rename-session -t ${quote(`=${session.tmuxName}`)} ${quote(renamedTmux)}`
                  ],
                  { encoding: 'utf8', timeout: 7_000 }
                )
              : null
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
    if (session.kind === 'terminal') {
      this.detachTerminal(session)
      return
    }
    this.terminateSession(session)
  }

  private detachTerminal(session: TerminalSession): void {
    const runtime = this.runtimes.get(session.id)
    this.cancelReconnect(session.id)
    if (session.backend === 'tmux' && session.tmuxName) {
      if (runtime) runtime.intentionalStop = true
      runtime?.pty.kill()
    }
    this.emitTransport(
      session.id,
      'detached',
      0,
      session.backend === 'tmux'
        ? 'Detached from tmux. The session is still running.'
        : 'Detached from the terminal. It will remain available while PanePilot is open.'
    )
  }

  private terminateSession(session: TerminalSession): void {
    const runtime = this.runtimes.get(session.id)
    this.cancelReconnect(session.id)
    if (runtime) {
      runtime.intentionalStop = true
    }
    if (session.backend === 'tmux' && session.tmuxName) {
      const project = this.store.getProject(session.projectId)
      const connection = project ? this.store.getConnection(project.connectionId) : null
      if (!connection) throw new Error('Project connection not found.')
      this.killTmuxSession(connection, session.tmuxName)
    }
    runtime?.pty.kill()
    this.changeState(session, 'completed', `${session.name} was stopped.`)
    this.emitTransport(session.id, 'detached', 0, 'The terminal was stopped.')
  }

  archive(sessionId: string): void {
    this.store.archiveSession(sessionId, true)
  }

  restore(sessionId: string): void {
    this.store.archiveSession(sessionId, false)
  }

  delete(sessionId: string): void {
    const session = this.requireSession(sessionId)
    const runtime = this.runtimes.get(sessionId)
    const outputWasClosed = runtime?.outputClosed ?? false
    if (runtime) runtime.outputClosed = true
    try {
      const project = this.store.getProject(session.projectId)
      const connection = project
        ? this.store.getConnection(project.connectionId)
        : null
      const liveTmuxSession =
        session.backend === 'tmux' &&
        session.tmuxName != null &&
        connection != null &&
        this.tmuxSessionExists(connection, session.tmuxName)
      if (
        !['completed', 'error'].includes(session.state) ||
        liveTmuxSession
      ) {
        this.terminateSession(session)
      }
      this.cancelReconnect(sessionId)
      this.store.deleteSession(sessionId)
      this.discardPendingOutput(sessionId)
    } catch (error) {
      if (runtime) runtime.outputClosed = outputWasClosed
      throw error
    }
  }

  shutdown(): void {
    if (this.shuttingDown) return
    this.shuttingDown = true
    for (const sessionId of this.pendingOutput.keys()) {
      this.flushOutput(sessionId, true)
    }
    for (const reconnect of this.reconnects.values()) {
      if (reconnect.timer) clearTimeout(reconnect.timer)
    }
    this.reconnects.clear()
    this.remoteReconciliations.clear()
    this.remoteTmuxPaths.clear()
    for (const runtime of this.runtimes.values()) {
      runtime.closingTransport = true
      if (runtime.scanTimer) clearTimeout(runtime.scanTimer)
      if (runtime.providerTimer) clearTimeout(runtime.providerTimer)
      if (runtime.actionTimer) clearTimeout(runtime.actionTimer)
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
      title: '',
      detector: AGENT_PROFILES.has(session.profile) ? new ScreenActivityDetector() : null,
      scanTimer: null,
      providerTimer: null,
      actionTimer: null,
      providerAttempts: 0,
      outputClosed: false,
      closingTransport: false,
      intentionalStop: false,
      cols,
      rows,
      folder,
      connection,
      session
    }
    screen.onTitleChange((title) => {
      runtime.title = title
    })
    this.runtimes.set(session.id, runtime)
    this.cancelReconnect(session.id)
    this.emitTransport(session.id, 'attached')
    this.scheduleProviderDiscovery(runtime, folder, connection)
    this.scheduleActionCompletion(runtime)

    child.onData((data) => {
      if (this.shuttingDown || runtime.closingTransport) return
      if (!runtime.outputClosed) this.queueOutput(session.id, data)
      this.getWindow()?.webContents.send('terminal:data', { sessionId: session.id, data })
      screen.write(data, () => this.scheduleScreenScan(runtime))
    })
    child.onExit(({ exitCode }) => {
      if (runtime.scanTimer) clearTimeout(runtime.scanTimer)
      if (runtime.providerTimer) clearTimeout(runtime.providerTimer)
      if (runtime.actionTimer) clearTimeout(runtime.actionTimer)
      runtime.screen.dispose()
      if (this.runtimes.get(session.id) === runtime) {
        this.runtimes.delete(session.id)
      }
      if (runtime.closingTransport) return
      this.flushOutput(session.id)
      const latest = this.store.getSession(session.id)
      if (!latest) return
      if (runtime.intentionalStop || latest.state === 'completed') return
      if (
        connection.kind === 'ssh' &&
        latest.backend === 'tmux' &&
        latest.tmuxName
      ) {
        this.beginRemoteReconnect(
          latest.id,
          runtime.cols,
          runtime.rows,
          exitCode,
          true
        )
        return
      }
      if (latest.kind === 'action') {
        const state = exitCode === 0 ? 'completed' : 'error'
        const message =
          exitCode === 0
            ? `${latest.name} finished.`
            : `${latest.name} exited with code ${exitCode}.`
        this.changeState(latest, state, message)
        this.emitTransport(latest.id, 'detached', 0, message)
        return
      }
      void this.discoverProviderSession(latest, folder, connection)
      this.changeState(
        latest,
        exitCode === 0 ? 'completed' : 'error',
        `${latest.name} exited${exitCode === 0 ? '.' : ` with code ${exitCode}.`}`
      )
      this.emitTransport(
        latest.id,
        'detached',
        0,
        `${latest.name} exited${exitCode === 0 ? '.' : ` with code ${exitCode}.`}`
      )
    })
  }

  private scheduleProviderDiscovery(
    runtime: Runtime,
    folder: string,
    connection: Connection
  ): void {
    if (this.shuttingDown) return
    if (!AGENT_PROFILES.has(runtime.session.profile) || runtime.session.providerSessionId) return
    if (runtime.providerTimer || runtime.providerAttempts >= 45) return
    runtime.providerTimer = setTimeout(() => {
      if (this.shuttingDown) return
      runtime.providerTimer = null
      runtime.providerAttempts += 1
      void this.discoverProviderSession(runtime.session, folder, connection)
        .then((linked) => {
          if (this.shuttingDown) return
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
    connection: Connection,
    paneTitle?: string
  ): Promise<boolean> {
    if (this.shuttingDown) return false
    const latest = this.store.getSession(session.id)
    if (!latest || !AGENT_PROFILES.has(latest.profile)) return false
    if (latest.providerSessionId) {
      await this.syncSessionMetadata(latest.id)
      return true
    }
    const excludedIds = this.store.listClaimedProviderSessionIds(connection.id)
    const provider = latest.profile as ConversationProvider
    const providerSessionHint =
      provider === 'codex'
        ? paneTitle == null
          ? await this.codexThreadReferenceForSession(latest, connection)
          : codexThreadReferenceFromPaneTitle(paneTitle)
        : latest.providerSessionName
    const providerSessionId =
      connection.kind === 'local'
        ? this.conversations.findProviderSessionId(
            provider,
            folder,
            latest.createdAt,
            excludedIds,
            providerSessionHint
          )
        : await this.remoteConversations.findProviderSessionId(
            provider,
            connection.sshAlias ?? connection.name,
            folder,
            latest.createdAt,
            excludedIds,
            providerSessionHint
          )
    if (this.shuttingDown) return false
    if (!providerSessionId) return false
    this.store.setSessionProviderId(latest.id, provider, providerSessionId)
    await this.syncSessionMetadata(latest.id)
    this.getWindow()?.webContents.send('terminal:metadata', {
      sessionId: latest.id,
      projectId: latest.projectId
    })
    return true
  }

  private async codexThreadReferenceForSession(
    session: TerminalSession,
    connection: Connection
  ): Promise<string | null> {
    const runtimeTitle = this.runtimes.get(session.id)?.title ?? ''
    const runtimeReference = codexThreadReferenceFromPaneTitle(runtimeTitle)
    if (runtimeReference) return runtimeReference
    if (session.backend !== 'tmux' || !session.tmuxName) return null

    if (connection.kind === 'local') {
      if (!this.tmuxPath) return null
      const result = spawnSync(
        this.tmuxPath,
        ['display-message', '-p', '-t', `=${session.tmuxName}:`, '#{pane_title}'],
        { encoding: 'utf8', timeout: 2_000 }
      )
      return result.status === 0
        ? codexThreadReferenceFromPaneTitle(result.stdout)
        : null
    }

    const listed = await this.listRemoteTmuxSessions(connection)
    const remote = listed?.find(
      (candidate) =>
        candidate.metadata?.terminalId === session.id ||
        candidate.name === session.tmuxName
    )
    return codexThreadReferenceFromPaneTitle(remote?.paneTitle ?? '')
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
        const remoteTmuxPath = this.tmuxPathForConnection(connection)
        if (!remoteTmuxPath) {
          throw new Error(`Tmux is unavailable on ${connection.name}.`)
        }
        if (create) {
          const project = this.store.getProject(session.projectId)
          if (project) {
            const metadataCommand = tmuxMetadataShellCommand(
              this.metadataForSession(project, session),
              undefined,
              false,
              remoteTmuxPath
            )
            const actionSetup =
              session.kind === 'action'
                ? ` && ${quote(remoteTmuxPath)} set-option -q -p -t "$TMUX_PANE" remain-on-exit on`
                : ''
            remoteLaunchCommand =
              `(${metadataCommand}${actionSetup}) || true; ${remoteLaunchCommand}`
          }
        }
        const tmuxAction = create ? 'new-session -s' : 'attach-session -t'
        const tmuxTarget = create ? session.tmuxName : `=${session.tmuxName}`
        const commandSuffix = create ? ` ${quote(remoteLaunchCommand)}` : ''
        remoteCommand =
          `cd ${quote(folder)} && exec ${quote(remoteTmuxPath)} ` +
          `${tmuxAction} ${quote(tmuxTarget)}${commandSuffix}`
      } else {
        remoteCommand = `cd ${quote(folder)} && ${remoteLaunchCommand}`
      }
      return pty.spawn(
        'ssh',
        [
          '-tt',
          '-o',
          'ConnectTimeout=8',
          '-o',
          'ServerAliveInterval=15',
          '-o',
          'ServerAliveCountMax=2',
          '-o',
          'TCPKeepAlive=yes',
          alias,
          remoteCommand
        ],
        {
          name: 'xterm-256color',
          cols,
          rows,
          cwd: homedir(),
          env
        }
      )
    }

    if (session.backend === 'tmux' && session.tmuxName && this.tmuxPath) {
      const project = this.store.getProject(session.projectId)
      const actionSetup =
        session.kind === 'action'
          ? ` && ${quote(this.tmuxPath)} set-option -q -p -t "$TMUX_PANE" remain-on-exit on`
          : ''
      const persistentCommand =
        create && project
          ? `(${tmuxMetadataShellCommand(
              this.metadataForSession(project, session),
              undefined,
              false,
              this.tmuxPath
            )}${actionSetup}) || true; ${command}`
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

  private queueOutput(sessionId: string, data: string): void {
    if (!data || this.shuttingDown) return
    let pending = this.pendingOutput.get(sessionId)
    if (!pending) {
      pending = {
        chunks: [],
        length: 0,
        timer: null,
        warned: false
      }
      this.pendingOutput.set(sessionId, pending)
    }
    pending.chunks.push(data)
    pending.length += data.length
    if (pending.length > OUTPUT_BUFFER_LIMIT) {
      const retained = pending.chunks.join('').slice(-OUTPUT_BUFFER_LIMIT)
      pending.chunks = [retained]
      pending.length = retained.length
    }
    this.scheduleOutputFlush(sessionId, OUTPUT_FLUSH_DELAY_MS)
  }

  private scheduleOutputFlush(sessionId: string, delay: number): void {
    const pending = this.pendingOutput.get(sessionId)
    if (!pending || pending.timer || this.shuttingDown) return
    pending.timer = setTimeout(() => {
      pending!.timer = null
      this.flushOutput(sessionId)
    }, delay)
    pending.timer.unref()
  }

  private flushOutput(sessionId: string, final = false): void {
    const pending = this.pendingOutput.get(sessionId)
    if (!pending) return
    if (pending.timer) {
      clearTimeout(pending.timer)
      pending.timer = null
    }
    if (pending.length === 0) {
      this.pendingOutput.delete(sessionId)
      return
    }

    const data = pending.chunks.join('')
    pending.chunks = []
    pending.length = 0
    try {
      this.store.appendOutput(sessionId, data)
      pending.warned = false
      if (pending.length === 0) {
        this.pendingOutput.delete(sessionId)
      } else {
        this.scheduleOutputFlush(sessionId, OUTPUT_FLUSH_DELAY_MS)
      }
    } catch (error) {
      const retained = `${data}${pending.chunks.join('')}`.slice(-OUTPUT_BUFFER_LIMIT)
      pending.chunks = [retained]
      pending.length = retained.length
      if (!pending.warned) {
        const detail = error instanceof Error ? error.message : String(error)
        console.warn(`Could not persist terminal output yet: ${detail}`)
        pending.warned = true
      }
      if (!final && !this.shuttingDown) {
        this.scheduleOutputFlush(sessionId, OUTPUT_RETRY_DELAY_MS)
      }
    }
  }

  private discardPendingOutput(sessionId: string): void {
    const pending = this.pendingOutput.get(sessionId)
    if (pending?.timer) clearTimeout(pending.timer)
    this.pendingOutput.delete(sessionId)
  }

  private scheduleActionCompletion(runtime: Runtime): void {
    if (
      this.shuttingDown ||
      runtime.session.kind !== 'action' ||
      runtime.session.backend !== 'tmux' ||
      !runtime.session.tmuxName ||
      runtime.actionTimer ||
      runtime.intentionalStop
    ) {
      return
    }
    runtime.actionTimer = setTimeout(() => {
      runtime.actionTimer = null
      void this.finishActionWhenPaneExits(runtime)
    }, ACTION_COMPLETION_POLL_MS)
    runtime.actionTimer.unref()
  }

  private async finishActionWhenPaneExits(runtime: Runtime): Promise<void> {
    if (
      this.shuttingDown ||
      this.runtimes.get(runtime.session.id) !== runtime ||
      runtime.intentionalStop
    ) {
      return
    }
    const snapshot = await this.readActionPaneSnapshot(runtime)
    if (
      this.shuttingDown ||
      this.runtimes.get(runtime.session.id) !== runtime ||
      runtime.intentionalStop
    ) {
      return
    }
    if (!snapshot) {
      this.scheduleActionCompletion(runtime)
      return
    }

    runtime.outputClosed = true
    this.discardPendingOutput(runtime.session.id)
    try {
      this.store.replaceOutput(runtime.session.id, snapshot.output)
      runtime.intentionalStop = true
      this.killTmuxSession(runtime.connection, runtime.session.tmuxName!)
    } catch {
      runtime.outputClosed = false
      runtime.intentionalStop = false
      this.scheduleActionCompletion(runtime)
      return
    }

    runtime.pty.kill()
    const latest = this.store.getSession(runtime.session.id)
    if (!latest) return
    const state = snapshot.exitCode === 0 ? 'completed' : 'error'
    const message =
      snapshot.exitCode === 0
        ? `${latest.name} finished.`
        : `${latest.name} exited with code ${snapshot.exitCode}.`
    this.changeState(latest, state, message)
    this.emitTransport(latest.id, 'detached', 0, message)
  }

  private async readActionPaneSnapshot(
    runtime: Runtime
  ): Promise<ActionPaneSnapshot | null> {
    const name = runtime.session.tmuxName
    if (!name) return null
    const target = `=${name}:`
    const stateFormat = '#{pane_dead}:#{pane_dead_status}'

    if (runtime.connection.kind === 'local') {
      if (!this.tmuxPath) return null
      const state = spawnSync(
        this.tmuxPath,
        ['display-message', '-p', '-t', target, stateFormat],
        { encoding: 'utf8', timeout: 2_000 }
      )
      const match = state.status === 0
        ? state.stdout.trim().match(/^1:(-?\d+)$/)
        : null
      if (!match) return null
      const capture = spawnSync(
        this.tmuxPath,
        ['capture-pane', '-p', '-e', '-S', '-', '-t', target],
        {
          encoding: 'utf8',
          timeout: 2_000,
          maxBuffer: MAX_ACTION_CAPTURE_OUTPUT
        }
      )
      if (capture.status !== 0) return null
      return {
        exitCode: Number(match[1]),
        output: capture.stdout.replace(/\r?\n/g, '\r\n')
      }
    }

    const tmuxPath = this.tmuxPathForConnection(runtime.connection)
    if (!tmuxPath) return null
    const remoteCommand =
      `panepilot_state=$(${quote(tmuxPath)} display-message -p -t ${quote(target)} ${quote(stateFormat)}) || exit $?; ` +
      `case "$panepilot_state" in 1:*) ;; *) exit 3 ;; esac; ` +
      `printf '%s\\n' "\${panepilot_state#1:}"; ` +
      `${quote(tmuxPath)} capture-pane -p -e -S - -t ${quote(target)}`
    try {
      const result = await execFileAsync(
        'ssh',
        [
          '-T',
          '-o',
          'BatchMode=yes',
          '-o',
          'ConnectTimeout=5',
          runtime.connection.sshAlias ?? runtime.connection.name,
          remoteCommand
        ],
        {
          encoding: 'utf8',
          timeout: 8_000,
          maxBuffer: MAX_ACTION_CAPTURE_OUTPUT
        }
      )
      const firstNewline = result.stdout.indexOf('\n')
      if (firstNewline < 0) return null
      const exitCode = Number(result.stdout.slice(0, firstNewline).trim())
      if (!Number.isInteger(exitCode)) return null
      return {
        exitCode,
        output: result.stdout.slice(firstNewline + 1).replace(/\r?\n/g, '\r\n')
      }
    } catch {
      return null
    }
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
      action: this.store.getActionForSession(session.id),
      latexSection
    })
  }

  private async listRemoteTmuxSessions(
    connection: Connection
  ): Promise<ListedTmuxSession[] | null> {
    const format = tmuxSessionListFormat()
    const remoteCommand =
      `${remoteTmuxResolutionCommand()}; ` +
      `panepilot_output=$("$panepilot_tmux" list-sessions -F ${quote(format)} 2>&1); ` +
      `panepilot_code=$?; ` +
      `if [ "$panepilot_code" -eq 0 ]; then ` +
      `printf '%s\\n' "$panepilot_output"; exit 0; fi; ` +
      `case "$panepilot_output" in ` +
      `*"no server running"*|*"failed to connect to server"*) exit 0 ;; ` +
      `*) printf '%s\\n' "$panepilot_output" >&2; exit "$panepilot_code" ;; ` +
      `esac`
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
      this.remoteTmuxPaths.delete(connection.id)
      return null
    }
  }

  private beginRemoteReconnect(
    sessionId: string,
    cols: number,
    rows: number,
    lastExitCode: number,
    immediate = false
  ): void {
    if (this.shuttingDown) return
    const existing = this.reconnects.get(sessionId)
    if (existing?.timer) clearTimeout(existing.timer)
    const reconnect: ReconnectRuntime = existing ?? {
      sessionId,
      cols,
      rows,
      attempt: 0,
      lastExitCode,
      timer: null,
      transportState: 'reconnecting'
    }
    reconnect.cols = Math.max(20, Math.floor(cols))
    reconnect.rows = Math.max(5, Math.floor(rows))
    reconnect.lastExitCode = lastExitCode
    reconnect.transportState = 'reconnecting'
    if (immediate) reconnect.attempt = 0
    this.reconnects.set(sessionId, reconnect)
    this.scheduleRemoteReconnect(reconnect, immediate ? 0 : undefined)
  }

  private scheduleRemoteReconnect(
    reconnect: ReconnectRuntime,
    delayOverride?: number
  ): void {
    if (this.shuttingDown) return
    if (this.reconnects.get(reconnect.sessionId) !== reconnect) return
    const delay =
      delayOverride ??
      RECONNECT_DELAYS_MS[
        Math.min(reconnect.attempt, RECONNECT_DELAYS_MS.length - 1)
      ]
    reconnect.timer = setTimeout(() => {
      if (this.shuttingDown) return
      reconnect.timer = null
      reconnect.transportState = 'reconnecting'
      this.emitTransport(
        reconnect.sessionId,
        'reconnecting',
        reconnect.attempt + 1,
        'Reconnecting to the existing tmux session…'
      )
      void this.runRemoteReconnect(reconnect)
    }, delay)
    reconnect.timer.unref()
  }

  private async runRemoteReconnect(
    reconnect: ReconnectRuntime
  ): Promise<void> {
    if (this.shuttingDown) return
    const session = this.store.getSession(reconnect.sessionId)
    const project = session ? this.store.getProject(session.projectId) : null
    const connection = project ? this.store.getConnection(project.connectionId) : null
    if (
      !session ||
      !project ||
      !connection ||
      connection.kind !== 'ssh' ||
      session.backend !== 'tmux' ||
      !session.tmuxName ||
      ['completed', 'error'].includes(session.state)
    ) {
      this.cancelReconnect(reconnect.sessionId)
      return
    }

    const listed = await this.listRemoteTmuxSessions(connection)
    if (this.reconnects.get(reconnect.sessionId) !== reconnect) return
    if (!listed) {
      reconnect.attempt += 1
      reconnect.transportState = 'offline'
      this.emitTransport(
        reconnect.sessionId,
        'offline',
        reconnect.attempt,
        `Cannot reach ${connection.name}. PanePilot will keep retrying.`
      )
      this.scheduleRemoteReconnect(reconnect)
      return
    }

    const remote = listed.find(
      (candidate) =>
        candidate.name === session.tmuxName &&
        candidate.metadata?.terminalId === session.id
    )
    if (!remote) {
      this.cancelReconnect(session.id)
      const state = reconnect.lastExitCode === 0 ? 'completed' : 'error'
      this.changeState(
        session,
        state,
        `${session.name} is no longer running in tmux.`
      )
      this.emitTransport(
        session.id,
        'detached',
        reconnect.attempt,
        'The remote tmux session no longer exists.'
      )
      return
    }

    this.applyCodexPaneSnapshot(session, remote)
    this.cancelReconnect(session.id)
    try {
      this.launch(
        this.requireSession(session.id),
        project.folder,
        connection,
        reconnect.cols,
        reconnect.rows,
        false
      )
    } catch {
      this.beginRemoteReconnect(
        session.id,
        reconnect.cols,
        reconnect.rows,
        reconnect.lastExitCode
      )
    }
  }

  private cancelReconnect(sessionId: string): void {
    const reconnect = this.reconnects.get(sessionId)
    if (reconnect?.timer) clearTimeout(reconnect.timer)
    this.reconnects.delete(sessionId)
  }

  private closeRuntimeForReconnect(runtime: Runtime): void {
    runtime.closingTransport = true
    if (runtime.scanTimer) clearTimeout(runtime.scanTimer)
    if (runtime.providerTimer) clearTimeout(runtime.providerTimer)
    if (runtime.actionTimer) clearTimeout(runtime.actionTimer)
    this.flushOutput(runtime.session.id)
    if (this.runtimes.get(runtime.session.id) === runtime) {
      this.runtimes.delete(runtime.session.id)
    }
    runtime.pty.kill()
  }

  private emitTransport(
    sessionId: string,
    state: TerminalTransportState,
    attempt = 0,
    message: string | null = null
  ): void {
    this.getWindow()?.webContents.send('terminal:transport', {
      sessionId,
      state,
      attempt,
      message
    })
  }

  private applyCodexPaneSnapshot(
    session: TerminalSession,
    remote: ListedTmuxSession
  ): boolean {
    if (session.profile !== 'codex' || remote.paneDead) return false
    const nextState = codexStateFromPaneTitle(remote.paneTitle, session.state)
    if (!nextState || nextState === session.state) return false
    const message =
      nextState === 'running'
        ? `${session.name} is working.`
        : nextState === 'needs-input'
          ? `${session.name} needs your input.`
          : nextState === 'response-ready'
            ? `${session.name} finished its latest turn.`
            : undefined
    this.changeState(session, nextState, message)
    return true
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
    if (this.shuttingDown) return 0
    if (!listed) return 0

    let changes = 0
    const liveMetadataIds = new Set(
      listed.flatMap((session) =>
        session.metadata ? [session.metadata.terminalId] : []
      )
    )
    const liveByName = new Map(listed.map((session) => [session.name, session]))

    for (const listedSession of listed) {
      let metadata = listedSession.metadata
      let upgradeLegacyMetadata = false
      if (metadata && metadata.sessionKind == null) {
        const known = this.store.getSession(metadata.terminalId)
        if (known?.projectId) {
          const action =
            known.kind === 'action'
              ? this.store.getActionForSession(known.id)
              : null
          metadata = {
            ...metadata,
            sessionKind: known.kind,
            action: action
              ? {
                  id: action.id,
                  name: action.name,
                  command: action.command
                }
              : null
          }
          upgradeLegacyMetadata = true
        }
      }
      const project = this.projectForDiscoveredSession(projects, listedSession)
      if (!metadata || !project) continue
      const result = this.store.upsertDiscoveredTmuxSession(
        project.id,
        listedSession.name,
        metadata
      )
      if (!result) continue
      let changed = result.changed
      changed =
        this.applyCodexPaneSnapshot(result.session, listedSession) || changed
      if (
        result.session.profile === 'codex' &&
        !result.session.providerSessionId
      ) {
        changed =
          (await this.discoverProviderSession(
            result.session,
            project.folder,
            connection,
            listedSession.paneTitle
          )) || changed
      }
      if (upgradeLegacyMetadata) {
        changed = (await this.syncSessionMetadata(result.session.id)) || changed
      }
      if (metadata.action && result.session.kind === 'action') {
        changed =
          this.store.upsertDiscoveredProjectAction(
            project.id,
            result.session.id,
            metadata.action
          ) || changed
      }
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
    const tmuxPath = this.tmuxPathForConnection(connection)
    if (!tmuxPath) return false
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
          `${quote(tmuxPath)} has-session -t ${quote(`=${name}`)}`
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

    const tmuxPath = this.tmuxPathForConnection(connection)
    if (!tmuxPath) {
      throw new Error('Tmux is unavailable, so the persistent session could not be stopped.')
    }
    const target = quote(`=${name}`)
    const tmuxCommand = quote(tmuxPath)
    const remoteCommand =
      `if ${tmuxCommand} has-session -t ${target} 2>/dev/null; then ` +
      `${tmuxCommand} kill-session -t ${target}; else status=$?; test "$status" -eq 1; fi`
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
    if (this.shuttingDown) return
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
