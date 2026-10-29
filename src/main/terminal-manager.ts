import { execFile, type ExecFileOptionsWithBufferEncoding, type ExecFileOptionsWithStringEncoding } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir, uptime } from 'node:os'
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
  LatexChatMode,
  LatexChatPurpose,
  LatexChatScope,
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
  LATEX_INLINE_OUTPUT_END,
  LATEX_INLINE_OUTPUT_START
} from '../shared/latex-inline-edit'
import {
  codexQueuedQuestionOnScreen,
  codexStateFromPaneTitle,
  codexStateFromPaneSnapshot,
  codexThreadReferenceFromPaneTitle
} from './codex-pane-status'
import { normalizeCodexThreadId } from './codex-thread-id'
import type { ConversationIndexer } from './conversation-indexer'
import type { AsyncConversationIndexer } from './conversation-indexer-client'
import { ProjectMetadataService } from './project-metadata-service'
import { RemoteConversationIndexer } from './remote-conversation-indexer'
import { acknowledgedAgentState, ScreenActivityDetector } from './screen-activity-detector'
import { Store } from './store'
import { captureTmuxPreview, TerminalPreviewReads } from './terminal-preview'
import { TerminalOutputBuffer } from './terminal-output-buffer'
import { TerminalOutputFlow } from './terminal-output-flow'
import { ConnectionRetryCoordinator } from './connection-retry-coordinator'
import type { TerminalPreviewSnapshot } from '../shared/types'
import {
  panePilotTmuxMetadata,
  parseTmuxSessionList,
  sameRemoteProjectPath,
  tmuxMetadataShellCommand,
  tmuxSessionListArgs,
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
const OUTPUT_FLUSH_DELAY_MS = 250
const OUTPUT_RETRY_DELAY_MS = 500
const OUTPUT_BUFFER_LIMIT = 512 * 1024
const ACTION_COMPLETION_POLL_MS = 250
const INLINE_EDIT_COMPLETION_POLL_MS = 1_000
const MAX_ACTION_CAPTURE_OUTPUT = 1024 * 1024
const ACTION_EXIT_STATUS_OPTION = '@panepilot_action_exit_status'
const MAX_TERMINAL_CAPTURE_OUTPUT = 4 * 1024 * 1024
const MAX_TERMINAL_INPUT_BYTES = 2 * 1024 * 1024
const LOGIN_PATH_TIMEOUT_MS = 8_000
const REBOOT_RECOVERY_CLOCK_SKEW_MS = 5_000
const TERMINAL_INPUT_CHUNK_SIZE = 16 * 1024
const CODEX_TMUX_TITLE_CONFIG =
  'tui.terminal_title=["activity","run-state","task-progress","thread-id"]'
const MAX_CODEX_QUESTION_SCANS_PER_DISCOVERY = 4

interface Runtime {
  pty: pty.IPty
  screen: InstanceType<typeof HeadlessTerminal> | null
  finishParsing: (() => void) | null
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

interface OutputConsumer {
  ready: boolean
  cutoff: number
  sequence: number
  expected: number | null
  deliver: (() => void) | null
  complete: (() => void) | null
}

interface SessionOutput {
  generation: string
  sequence: number
  received: number
  dispatched: number
  consumers: Map<string, OutputConsumer>
  flow: TerminalOutputFlow
}

interface ReconnectRuntime {
  sessionId: string
  connectionId: string
  cols: number
  rows: number
  attempt: number
  lastExitCode: number
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

export interface LatexInlineExecResult {
  exitCode: number
  output: string
}

interface LatexInlineExecWaiter {
  resolve(result: LatexInlineExecResult): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function actionRunCommand(tmuxCommand: string, command: string): string {
  const executable = quote(tmuxCommand)
  const marker = quote(ACTION_EXIT_STATUS_OPTION)
  return (
    `${executable} set-option -q -p -t "$TMUX_PANE" remain-on-exit on || true; ` +
    `${executable} set-option -q -u -t "$TMUX_PANE" ${marker} 2>/dev/null || true; ` +
    `( ${command}\n); ` +
    `panepilot_action_status=$?; ` +
    `${executable} set-option -q -t "$TMUX_PANE" ${marker} "$panepilot_action_status" || ` +
    `exit "$panepilot_action_status"; ` +
    `while :; do sleep 3600; done`
  )
}

function actionExitStatus(value: string): number | null {
  const match = value.trim().match(/^(-?\d+)?:([01]):(-?\d*)$/)
  if (!match) return null
  const reported = match[1] ? Number(match[1]) : null
  if (reported != null && Number.isInteger(reported)) return reported
  const deadStatus = match[3] ? Number(match[3]) : null
  return match[2] === '1' && deadStatus != null && Number.isInteger(deadStatus)
    ? deadStatus
    : null
}

function isLatexInlineEditSession(session: TerminalSession): boolean {
  return session.latexChat?.purpose === 'inline-edit'
}

function latexInlineExecCommand(prompt: string): string {
  return [
    'panepilot_inline_output=$(mktemp "${TMPDIR:-/tmp}/panepilot-inline-output.XXXXXX") || exit 1',
    'panepilot_inline_log=$(mktemp "${TMPDIR:-/tmp}/panepilot-inline-log.XXXXXX") || { rm -f "$panepilot_inline_output"; exit 1; }',
    'codex exec --sandbox workspace-write --skip-git-repo-check --color never ' +
      `--output-last-message "$panepilot_inline_output" ${quote(prompt)} ` +
      '>"$panepilot_inline_log" 2>&1',
    'panepilot_inline_status=$?',
    `printf '\n${LATEX_INLINE_OUTPUT_START}'`,
    'head -c 50000 "$panepilot_inline_output" | base64 | tr -d \'\\n\'',
    `printf '${LATEX_INLINE_OUTPUT_END}\n'`,
    'if [ "$panepilot_inline_status" -ne 0 ]; then tail -c 16000 "$panepilot_inline_log"; fi',
    'rm -f "$panepilot_inline_output" "$panepilot_inline_log"',
    'exit "$panepilot_inline_status"'
  ].join('; ')
}

export function systemBootTimeMs(
  nowMs = Date.now(),
  uptimeSeconds = uptime()
): number {
  return nowMs - Math.max(0, uptimeSeconds) * 1_000
}

export function sessionPredatesSystemBoot(
  updatedAt: string,
  bootTimeMs: number
): boolean {
  const updatedAtMs = Date.parse(updatedAt)
  return (
    Number.isFinite(updatedAtMs) &&
    Number.isFinite(bootTimeMs) &&
    updatedAtMs < bootTimeMs + REBOOT_RECOVERY_CLOCK_SKEW_MS
  )
}

export function terminalInputChunks(
  data: string,
  chunkSize = TERMINAL_INPUT_CHUNK_SIZE
): string[] {
  if (!data) return []
  const chunks: string[] = []
  for (let start = 0; start < data.length; ) {
    let end = Math.min(data.length, start + Math.max(1, chunkSize))
    if (
      end < data.length &&
      data.charCodeAt(end - 1) >= 0xd800 &&
      data.charCodeAt(end - 1) <= 0xdbff &&
      data.charCodeAt(end) >= 0xdc00 &&
      data.charCodeAt(end) <= 0xdfff
    ) {
      end = end - start === 1 ? end + 1 : end - 1
    }
    chunks.push(data.slice(start, end))
    start = end
  }
  return chunks
}

export function persistsTerminalOutput(profile: LaunchProfile): boolean {
  // Codex owns the durable conversation archive. Persist only the small exact
  // thread reference that PanePilot needs to resume it after a restart.
  return profile !== 'codex'
}

export function retainedVolatileTerminalOutput(
  data: string,
  maximumBytes = OUTPUT_BUFFER_LIMIT
): string {
  if (!data || maximumBytes <= 0) return ''
  const encoded = Buffer.from(data, 'utf8')
  if (encoded.length <= maximumBytes) return data
  let start = encoded.length - maximumBytes
  while (start < encoded.length && (encoded[start] & 0xc0) === 0x80) start += 1
  return encoded.subarray(start).toString('utf8')
}

async function resolveTmux(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('sh', ['-lc', 'command -v tmux'], {
      encoding: 'utf8', timeout: 1_000, maxBuffer: 16 * 1024
    })
    const candidate = stdout.trim()
    if (candidate && existsSync(candidate)) return candidate
  } catch { /* Fall back to well-known installation paths. */ }
  return TMUX_CANDIDATES.find(existsSync) ?? null
}

// PanePilot inherits whatever PATH launched it, which is frequently narrower than
// the user's own shell PATH: on zsh, entries such as ~/.local/bin and
// ~/Library/pnpm are usually added in ~/.zshrc, which only interactive shells
// read. tmux copies the *client's* environment into a session it creates, so a
// narrow PATH means `codex`/`claude` are not found, the pane exits immediately,
// and the tmux session dies before anyone can attach to it. Resolve the user's
// real PATH once from an interactive login shell and reuse it for every launch;
// doing this per launch would add that shell's startup time to every terminal.
let resolvedLoginPath: Promise<string | null> | undefined

function loginShellPath(): Promise<string | null> {
  if (resolvedLoginPath) return resolvedLoginPath
  resolvedLoginPath = (async () => {
    const shell = process.env.SHELL
    if (!shell || !existsSync(shell)) return null
    try {
      const result = await execFileAsync(shell,
        ['-lic', 'printf "\\npanepilot_path<%s>panepilot_end\\n" "$PATH"'],
        { encoding: 'utf8', timeout: LOGIN_PATH_TIMEOUT_MS, maxBuffer: 1024 * 1024 })
      return /panepilot_path<([^>\n]*)>panepilot_end/.exec(result.stdout)?.[1]?.trim() || null
    } catch { return null }
  })()
  return resolvedLoginPath
}

async function terminalPath(): Promise<string | undefined> {
  const loginPath = await loginShellPath()
  if (!loginPath) return process.env.PATH
  const seen = new Set(loginPath.split(':'))
  const extras = (process.env.PATH ?? '').split(':').filter((entry) => entry && !seen.has(entry))
  return extras.length > 0 ? `${loginPath}:${extras.join(':')}` : loginPath
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

async function resolveRemoteTmuxAsync(alias: string): Promise<string | null> {
  const discoveryCommand =
    `${remoteTmuxResolutionCommand()}; ` +
    `printf '%s\\n' "$panepilot_tmux"`
  try {
    const result = await execFileAsync(
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
      {
        encoding: 'utf8',
        timeout: 3_000,
        maxBuffer: 64 * 1024
      }
    )
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
  } catch {
    return null
  }
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
  private readonly outputs = new Map<string, SessionOutput>()
  private readonly pendingConsumers = new Map<string, { cancelled: boolean }>()
  private readonly launches = new Map<string, Promise<void>>()
  private readonly inlineExecs = new Set<string>()
  private readonly operations = new Map<string, Promise<unknown>>()
  private readonly reconnects = new Map<string, ReconnectRuntime>()
  private readonly connectionRetries = new ConnectionRetryCoordinator(RECONNECT_DELAYS_MS)
  private readonly tmuxReconciliations = new Map<string, Promise<number>>()
  private readonly remoteTmuxReads = new Map<string, Promise<ListedTmuxSession[] | null>>()
  private readonly remoteTmuxPaths = new Map<string, string>()
  private readonly codexQuestionScanCursors = new Map<string, number>()
  private readonly pendingOutput = new Map<string, PendingOutput>()
  private readonly volatileOutput = new Map<string, TerminalOutputBuffer>()
  private readonly latexInlineExecWaiters = new Map<
    string,
    LatexInlineExecWaiter
  >()
  private tmuxPath: string | null | undefined
  private tmuxResolution: Promise<string | null> | undefined
  private readonly metadata: ProjectMetadataService
  private shuttingDown = false
  private readonly stoppingProjects = new Set<string>()
  private readonly processAbort = new AbortController()

  constructor(
    private readonly store: Store,
    private readonly getWindow: () => BrowserWindow | null,
    private readonly conversations: Pick<ConversationIndexer | AsyncConversationIndexer, 'findProviderSessionId'>,
    private readonly remoteConversations: RemoteConversationIndexer,
    metadata?: ProjectMetadataService
  ) {
    this.metadata = metadata ?? new ProjectMetadataService(store)
    // Resolving the login PATH costs a full interactive shell startup. Prime it
    // just off the critical path so the first terminal launch does not wear it.
    setImmediate(() => { void loginShellPath() }).unref()
  }

  private ensureActive(): void {
    if (this.shuttingDown) throw new Error('PanePilot is closing.')
  }

  private ensureProjectLaunchable(projectId: string): void {
    this.ensureActive()
    if (this.stoppingProjects.has(projectId) || this.store.getProjectForRuntime(projectId)?.archived) {
      throw new Error('This project is being archived or has been archived.')
    }
  }

  private execCommand(file: string, args: string[], options: ExecFileOptionsWithStringEncoding): Promise<{ stdout: string; stderr: string }>
  private execCommand(file: string, args: string[], options: ExecFileOptionsWithBufferEncoding): Promise<{ stdout: Buffer; stderr: Buffer }>
  private async execCommand(file: string, args: string[], options: ExecFileOptionsWithStringEncoding | ExecFileOptionsWithBufferEncoding): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
    this.ensureActive()
    const result = options.encoding === 'buffer' || options.encoding === null
      ? await execFileAsync(file, args, { ...options, encoding: 'buffer', signal: this.processAbort.signal })
      : await execFileAsync(file, args, { ...options, encoding: 'utf8', signal: this.processAbort.signal })
    this.ensureActive()
    return result
  }

  private serializeOperation<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(key) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(() => { this.ensureActive(); return operation() })
    this.operations.set(key, pending)
    const clear = (): void => { if (this.operations.get(key) === pending) this.operations.delete(key) }
    void pending.then(clear, clear)
    return pending
  }

  async start(input: StartTerminalInput): Promise<TerminalSession> {
    if (input.profile === 'custom') {
      throw new Error('Create a project Action to run a custom command.')
    }
    const project = this.store.getProjectForRuntime(input.projectId)
    if (!project) throw new Error('Project not found.')
    const connection = this.store.getConnection(project.connectionId)
    if (!connection) throw new Error('Project connection not found.')
    return this.startSession(input, 'terminal')
  }

  async startLatexChat(
    input: StartTerminalInput,
    attachment: {
      purpose?: LatexChatPurpose
      scope: LatexChatScope
      sectionId: string | null
      mode: LatexChatMode
    }
  ): Promise<TerminalSession> {
    if (!AGENT_PROFILES.has(input.profile)) {
      throw new Error('Choose Codex or Claude for a LaTeX chat.')
    }
    return this.startSession(
      input,
      'latex-chat',
      (session) => {
        this.store.attachLatexChat(session.id, {
          projectId: input.projectId,
          ...attachment
        })
      }
    )
  }

  async startLatexInlineChat(projectId: string): Promise<TerminalSession> {
    const project = this.store.getProjectForRuntime(projectId)
    if (!project) throw new Error('Choose an active LaTeX project.')
    return this.serializeOperation(`launch:${project.connectionId}`, () =>
      this.startLatexInlineChatOnce(projectId))
  }

  private async startLatexInlineChatOnce(projectId: string): Promise<TerminalSession> {
    const existing = this.store.getLatexInlineEditSession(projectId)
    const project = this.store.getProjectForRuntime(projectId)
    if (!project || project.archived || project.type !== 'latex') {
      throw new Error('Choose an active LaTeX project.')
    }
    const connection = this.store.getConnection(project.connectionId)
    if (!connection) throw new Error('Project connection not found.')
    await this.requireProjectTmux(projectId, 'Inline editing')

    if (existing) return existing

    const baseName = generatedTerminalName(`Inline edits · ${project.name}`)
    let name = baseName
    let suffix = 2
    while (await this.tmuxSessionExists(connection, name)) {
      const suffixText = ` ${suffix}`
      name = `${baseName.slice(0, 80 - suffixText.length).trimEnd()}${suffixText}`
      suffix += 1
    }
    this.ensureProjectLaunchable(projectId)
    const created = this.store.createSession({
      projectId,
      kind: 'latex-chat',
      name,
      profile: 'codex',
      providerSessionName: null,
      customCommand: null,
      backend: 'tmux',
      tmuxName: name,
      dangerousMode: false
    })
    this.store.attachLatexChat(created.id, {
      projectId,
      purpose: 'inline-edit',
      scope: 'project',
      sectionId: null,
      mode: 'edit'
    })
    return this.requireSession(created.id)
  }

  async runLatexInlineEditExec(
    sessionId: string,
    prompt: string
  ): Promise<LatexInlineExecResult> {
    if (this.inlineExecs.has(sessionId)) {
      throw new Error('Wait for the current inline edit to finish before sending another.')
    }
    this.inlineExecs.add(sessionId)
    try {
      return await this.runLatexInlineEditExecOnce(sessionId, prompt)
    } finally {
      this.inlineExecs.delete(sessionId)
    }
  }

  private async runLatexInlineEditExecOnce(
    sessionId: string,
    prompt: string
  ): Promise<LatexInlineExecResult> {
    let session = this.requireSession(sessionId)
    if (
      session.profile !== 'codex' ||
      session.latexChat?.purpose !== 'inline-edit'
    ) {
      throw new Error('Persistent inline Codex chat not found.')
    }
    if (session.state === 'running') {
      throw new Error('Wait for the current inline edit to finish before sending another.')
    }
    const project = this.store.getProjectForRuntime(session.projectId)
    const connection = project
      ? this.store.getConnection(project.connectionId)
      : null
    if (!project || !connection) {
      throw new Error('The LaTeX project connection is unavailable.')
    }
    await this.requireProjectTmux(project.id, 'Inline editing')

    const runtime = this.runtimes.get(session.id)
    const cols = runtime?.cols ?? 100
    const rows = runtime?.rows ?? 30
    this.cancelReconnect(session.id)
    if (runtime) this.closeRuntimeForReconnect(runtime)
    if (session.tmuxName && await this.tmuxSessionExists(connection, session.tmuxName)) {
      await this.killTmuxSession(connection, session.tmuxName)
    }
    this.discardPendingOutput(session.id)
    this.store.clearSessionProviderId(session.id)
    session = this.requireSession(session.id)
    this.changeState(session, 'running', `${session.name} is applying an edit.`)

    const result = new Promise<LatexInlineExecResult>((resolve, reject) => {
      const timer = setTimeout(async () => {
        if (!this.latexInlineExecWaiters.delete(session.id)) return
        const timedOutRuntime = this.runtimes.get(session.id)
        if (timedOutRuntime) this.closeRuntimeForReconnect(timedOutRuntime)
        try {
          if (
            session.tmuxName &&
            await this.tmuxSessionExists(connection, session.tmuxName)
          ) {
            await this.killTmuxSession(connection, session.tmuxName)
          }
        } catch {
          // The persisted error still lets the next ask replace this exact
          // runner after a host reconnect.
        }
        const latest = this.store.getSessionWithoutOutput(session.id)
        if (latest) {
          this.changeState(
            latest,
            'error',
            `${latest.name} exceeded the 15-minute inline-edit limit.`
          )
        }
        reject(new Error('Codex exceeded the 15-minute inline-edit limit.'))
      }, 15 * 60_000)
      timer.unref()
      this.latexInlineExecWaiters.set(session.id, { resolve, reject, timer })
    })

    try {
      await this.launch(
        this.requireSession(session.id),
        project.folder,
        connection,
        cols,
        rows,
        true,
        false,
        latexInlineExecCommand(prompt)
      )
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error))
      this.rejectLatexInlineExec(
        session.id,
        normalized
      )
      const latest = this.store.getSessionWithoutOutput(session.id)
      if (latest) this.changeState(latest, 'error', `${latest.name} could not start.`)
      return result
    }
    return result
  }

  async prepareLocalSessionsAfterReboot(
    bootTimeMs = systemBootTimeMs()
  ): Promise<number> {
    if (!(await this.localTmuxPath()) || this.shuttingDown) return 0
    // One bounded snapshot, without starting any terminal clients or agents.
    const listed = await this.listLocalTmuxSessions()
    if (!listed || this.shuttingDown) return 0
    const liveByName = new Map(listed.map((session) => [session.name, session]))
    let restored = 0

    for (const project of this.store.listProjectsForRuntime()) {
      if (project.archived) continue
      const connection = this.store.getConnection(project.connectionId)
      if (!connection || connection.kind !== 'local') continue

      for (const session of project.sessions) {
        if (
          session.archived ||
          session.kind === 'project-qna' ||
          session.backend !== 'tmux' ||
          !session.tmuxName ||
          ['completed', 'error'].includes(session.state) ||
          (!this.store.isSessionPendingRebootRecovery(session.id) &&
            !sessionPredatesSystemBoot(session.updatedAt, bootTimeMs))
        ) {
          continue
        }

        const liveTmuxSession = liveByName.get(session.tmuxName)
        if (
          liveTmuxSession &&
          liveTmuxSession.metadata?.terminalId !== session.id
        ) {
          this.store.setSessionState(
            session.id,
            'error',
            `PanePilot did not restore ${session.name} because another tmux session is using that name.`
          )
          continue
        }

        if (session.kind === 'action' || session.profile === 'custom' || isLatexInlineEditSession(session)) {
          if (liveTmuxSession) {
            try {
              await this.killTmuxSession(connection, session.tmuxName)
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error)
              console.error(`Could not stop restored Action ${session.name}: ${detail}`)
              this.store.setSessionState(
                session.id,
                'error',
                `${session.name} was unexpectedly restored by tmux and could not be stopped.`
              )
              continue
            }
          }
          this.store.setSessionState(
            session.id,
            'completed',
            `${session.name} ended when the computer restarted. Run it again when needed.`
          )
          continue
        }

        if (liveTmuxSession) {
          try {
            this.store.prepareSessionForRebootRecovery(session.id, false)
            restored += 1
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            console.error(`Could not adopt restored session ${session.name}: ${detail}`)
            this.store.setSessionState(
              session.id,
              'error',
              `${session.name} could not be adopted after reboot.`
            )
          }
          continue
        }

        try {
          this.store.deferSessionForRebootRecovery(session.id)
          restored += 1
        } catch (error) {
          const latest = this.store.getSessionWithoutOutput(session.id)
          if (latest && !['completed', 'error'].includes(latest.state)) {
            this.changeState(
              latest,
              'error',
              `${latest.name} could not be restored after reboot.`
            )
          }
          const detail = error instanceof Error ? error.message : String(error)
          console.error(`Could not restore ${session.name} after reboot: ${detail}`)
        }
      }
    }

    return restored
  }

  createAction(input: CreateProjectActionInput): Promise<ProjectAction> {
    return this.metadata.createAction(input)
  }

  async updateAction(input: UpdateProjectActionInput): Promise<ProjectAction> {
    const action = await this.metadata.updateAction(input)
    if (action.lastSessionId) void this.syncSessionMetadata(action.lastSessionId)
    return action
  }

  syncActions(projectId: string): Promise<ProjectAction[]> {
    return this.metadata.syncActions(projectId)
  }

  runAction(actionId: string): Promise<TerminalSession> {
    return this.serializeOperation('action:' + actionId, () => this.runActionOnce(actionId))
  }

  private async runActionOnce(actionId: string): Promise<TerminalSession> {
    const action = this.store.getProjectAction(actionId)
    if (!action) throw new Error('Action not found.')
    await this.requireProjectTmux(action.projectId, 'Actions')
    const previous = action.lastSessionId
      ? this.store.getSessionWithoutOutput(action.lastSessionId)
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

  stopAction(actionId: string): Promise<void> {
    return this.serializeOperation('action:' + actionId, () => this.stopActionOnce(actionId))
  }

  private async stopActionOnce(actionId: string): Promise<void> {
    const action = this.store.getProjectAction(actionId)
    if (!action?.lastSessionId) throw new Error('This action has no run to stop.')
    const session = this.store.getSessionWithoutOutput(action.lastSessionId)
    if (!session || ['completed', 'error'].includes(session.state)) return
    await this.stop(session.id)
  }

  deleteAction(actionId: string): Promise<void> {
    return this.serializeOperation('action:' + actionId, () => this.deleteActionOnce(actionId))
  }

  private async deleteActionOnce(actionId: string): Promise<void> {
    const action = this.store.getProjectAction(actionId)
    if (!action) throw new Error('Action not found.')
    const session = action.lastSessionId
      ? this.store.getSessionWithoutOutput(action.lastSessionId)
      : null
    if (session && !['completed', 'error'].includes(session.state)) {
      await this.stop(session.id)
    }
    await this.metadata.deleteAction(actionId)
  }

  /** Retire exact legacy Q&A backends without blocking the first window paint. */
  async removeLegacyProjectQnaSessions(): Promise<number> {
    if (this.shuttingDown) return 0
    let removed = 0
    for (const session of this.store.listLegacyProjectQnaSessions()) {
      if (this.shuttingDown) break
      try {
        if (session.backend === 'tmux' && session.tmuxName) {
          const project = this.store.getProjectForRuntime(session.projectId)
          const connection = project ? this.store.getConnection(project.connectionId) : null
          if (!connection) throw new Error('The project connection is unavailable.')
          const listed = await this.listTmuxSessions(connection)
          if (this.shuttingDown) break
          if (!listed) throw new Error('Could not verify the tmux host.')
          const exact = listed.find((item) => item.name === session.tmuxName)
          if (exact && exact.metadata?.terminalId !== session.id) {
            throw new Error('The tmux name now belongs to another or unverified session.')
          }
          if (exact) {
            if (connection.kind === 'local') {
              await this.killTmuxSession(connection, session.tmuxName)
            } else {
              const remoteCommand =
                `${remoteTmuxResolutionCommand()}; ` +
                `"$panepilot_tmux" kill-session -t ${quote(`=${session.tmuxName}`)}`
              await this.execCommand('ssh', [
                '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
                connection.sshAlias ?? connection.name, remoteCommand
              ], { encoding: 'utf8', timeout: 8_000, maxBuffer: 64 * 1024 })
            }
            const after = await this.listTmuxSessions(connection)
            if (this.shuttingDown) break
            if (!after || after.some((item) => item.metadata?.terminalId === session.id)) {
              throw new Error('Could not verify that the exact tmux session stopped.')
            }
          }
        }
        if (!['completed', 'error'].includes(session.state)) {
          this.store.setSessionState(session.id, 'completed')
        }
        this.store.deleteSession(session.id)
        this.getWindow()?.webContents.send('terminal:metadata', {
          sessionId: session.id,
          projectId: session.projectId
        })
        removed += 1
      } catch (error) {
        // Keep the record so a later launch can retry when its SSH host is up.
        console.warn(`Could not retire legacy Q&A session ${session.id}:`, error)
      }
    }
    return removed
  }

  async startTemporaryCodexChat(projectId: string): Promise<TerminalSession> {
    const project = this.store.getProjectForRuntime(projectId)
    if (!project || project.archived) throw new Error('Choose an active project.')
    await this.requireProjectTmux(projectId, 'Temporary Codex chats')
    const chatNumber =
      project.sessions.filter((session) => session.kind === 'temporary-chat')
        .length + 1
    return this.startSession(
      {
        projectId,
        name: generatedTerminalName(`Quick chat ${chatNumber}`),
        profile: 'codex',
        dangerousMode: false
      },
      'temporary-chat',
      undefined,
      true
    )
  }

  sendTemporaryCodexChatPrompt(sessionId: string, prompt: string): void {
    const session = this.requireSession(sessionId)
    if (session.kind !== 'temporary-chat' || session.profile !== 'codex') {
      throw new Error('Temporary Codex chat not found.')
    }
    this.sendPrompt(sessionId, prompt)
  }

  async clearTemporaryCodexChat(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId)
    if (session.kind !== 'temporary-chat') {
      throw new Error('Temporary Codex chat not found.')
    }
    await this.delete(sessionId)
  }

  private async startSession(
    input: StartTerminalInput,
    kind: TerminalSessionKind,
    onPersist?: (session: TerminalSession) => void,
    tmuxAvailability?: boolean,
    preparedSessionName?: string
  ): Promise<TerminalSession> {
    const project = this.store.getProjectForRuntime(input.projectId)
    if (!project) throw new Error('Project not found.')
    return this.serializeOperation(`launch:${project.connectionId}`, () =>
      this.startSessionOnce(input, kind, onPersist, tmuxAvailability, preparedSessionName))
  }

  private async startSessionOnce(
    input: StartTerminalInput,
    kind: TerminalSessionKind,
    onPersist?: (session: TerminalSession) => void,
    tmuxAvailability?: boolean,
    preparedSessionName?: string
  ): Promise<TerminalSession> {
    const project = this.store.getProjectForRuntime(input.projectId)
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

    this.ensureProjectLaunchable(project.id)
    const tmuxAvailable =
      tmuxAvailability ?? await this.connectionHasTmux(connection)
    if (
      (kind === 'action' ||
        kind === 'temporary-chat' ||
        kind === 'latex-chat') &&
      !tmuxAvailable
    ) {
      const capability =
        kind === 'action'
          ? 'Actions'
          : kind === 'temporary-chat'
            ? 'Temporary Codex chats'
            : 'LaTeX chats'
      throw new Error(
        `${capability} require tmux on this connection.`
      )
    }
    let sessionName =
      preparedSessionName ?? this.sessionNameForInput(input, project)
    if (tmuxAvailable && !preparedSessionName) {
      const baseName = sessionName
      let suffix = 2
      while (await this.tmuxSessionExists(connection, sessionName)) {
        const suffixText = ` ${suffix}`
        sessionName = `${baseName.slice(0, 80 - suffixText.length).trimEnd()}${suffixText}`
        suffix += 1
      }
    }
    this.ensureProjectLaunchable(project.id)
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
    let session = this.requireSession(createdSession.id)
    try {
      onPersist?.(session)
      // Capability attachments can change both the session kind and the
      // metadata that must be written before tmux launches. Re-read the row so
      // the first remote snapshot is already complete and portable.
      session = this.requireSession(createdSession.id)
      await this.launch(
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
    return this.store.getSessionWithoutOutput(session.id)!
  }

  private sessionNameForInput(
    input: StartTerminalInput,
    project: Project
  ): string {
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
        session.kind !== 'temporary-chat'
    ).length
    const requestedName = input.name ? validatedTerminalName(input.name) : null
    return requestedName || `${profileLabel} ${sameProfileCount + 1}`
  }

  private async remoteTmuxSessionExists(
    connection: Connection,
    tmuxPath: string,
    name: string
  ): Promise<boolean> {
    try {
      await this.execCommand(
        'ssh',
        [
          '-T',
          '-o',
          'BatchMode=yes',
          '-o',
          'ConnectTimeout=3',
          connection.sshAlias ?? connection.name,
          `${quote(tmuxPath)} has-session -t ${quote(`=${name}`)}`
        ],
        {
          encoding: 'utf8',
          timeout: 5_000,
          maxBuffer: 64 * 1024
        }
      )
      return true
    } catch (error) {
      const exitCode =
        error && typeof error === 'object' && 'code' in error
          ? (error as { code?: unknown }).code
          : null
      if (exitCode === 1) return false
      throw error
    }
  }

  private async connectionHasTmux(connection: Connection): Promise<boolean> {
    return Boolean(await this.tmuxPathForConnection(connection))
  }

  private localTmuxPath(): Promise<string | null> {
    this.ensureActive()
    if (this.tmuxPath !== undefined) return Promise.resolve(this.tmuxPath)
    return this.tmuxResolution ??= resolveTmux().then((path) => {
      this.ensureActive()
      this.tmuxPath = path
      return path
    })
  }

  private async tmuxPathForConnection(connection: Connection): Promise<string | null> {
    if (connection.kind === 'local') return this.localTmuxPath()
    const cached = this.remoteTmuxPaths.get(connection.id)
    if (cached) return cached
    const resolved = await resolveRemoteTmuxAsync(connection.sshAlias ?? connection.name)
    this.ensureActive()
    if (resolved) this.remoteTmuxPaths.set(connection.id, resolved)
    return resolved
  }

  private async requireProjectTmux(projectId: string, capability: string): Promise<void> {
    this.ensureProjectLaunchable(projectId)
    const project = this.store.getProjectForRuntime(projectId)
    const connection = project
      ? this.store.getConnection(project.connectionId)
      : null
    if (!project || !connection) throw new Error('Project connection not found.')
    if (!(await this.connectionHasTmux(connection))) {
      throw new Error(`${capability} requires tmux on this connection.`)
    }
    this.ensureProjectLaunchable(projectId)
  }

  async discoverSavedProviderSessions(): Promise<void> {
    if (this.shuttingDown) return
    for (const project of this.store.listProjectsForRuntime()) {
      if (this.shuttingDown) return
      const connection = this.store.getConnection(project.connectionId)
      if (!connection) continue
      for (const session of project.sessions) {
        if (this.shuttingDown) return
        if (this.store.isSessionPendingRebootRecovery(session.id)) continue
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

  async reconcileSessions(connectionId?: string): Promise<number> {
    if (this.shuttingDown) return 0
    const projects = this.store
      .listProjectsForRuntime()
      .filter((project) => !project.archived)
    const connections = this.store
      .listConnections()
      .filter(
        (connection) =>
          (!connectionId || connection.id === connectionId) &&
          projects.some((project) => project.connectionId === connection.id)
      )
    const changes = await Promise.all(
      connections.map((connection) => {
        const active = this.tmuxReconciliations.get(connection.id)
        if (active) return active
        const reconciliation = this.reconcileConnection(
          connection,
          projects.filter((project) => project.connectionId === connection.id)
        )
          .catch(() => 0)
          .finally(() => {
            this.tmuxReconciliations.delete(connection.id)
          })
        this.tmuxReconciliations.set(connection.id, reconciliation)
        return reconciliation
      })
    )
    return changes.reduce((total, count) => total + count, 0)
  }

  async reconcileRemoteSessions(connectionId?: string): Promise<number> {
    return this.reconcileSessions(connectionId)
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
    const session = this.store.getSessionWithoutOutput(sessionId)
    const project = session
      ? this.store.getProjectForRuntime(session.projectId)
      : null
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
    const synced = await this.writeSessionMetadata(project, session, connection)
    if (!synced || this.shuttingDown) return false
    this.store.markSessionTmuxMetadataManaged(session.id)
    return true
  }

  private async writeSessionMetadata(
    project: Project,
    session: TerminalSession,
    connection: Connection
  ): Promise<boolean> {
    if (session.backend !== 'tmux' || !session.tmuxName) return false
    const tmuxCommand = await this.tmuxPathForConnection(connection)
    if (!tmuxCommand) return false
    const command = tmuxMetadataShellCommand(
      this.metadataForSession(project, session),
      session.tmuxName,
      true,
      tmuxCommand
    )
    try {
      if (connection.kind === 'local') {
        await this.execCommand('sh', ['-lc', command], {
          encoding: 'utf8',
          timeout: 4_000, maxBuffer: 256 * 1024
        })
      } else {
        await this.execCommand(
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
      return true
    } catch {
      return false
    }
  }

  async attach(sessionId: string, cols: number, rows: number, consumerId?: string): Promise<{ output: string; generation?: string; sequence?: number }> {
    const key = consumerId ? `${sessionId}:${consumerId}` : null
    const pending = { cancelled: false }
    if (key) this.pendingConsumers.set(key, pending)
    try {
      return await this.serializeOperation(sessionId, () => this.attachOnce(sessionId, cols, rows, consumerId, pending))
    } finally {
      if (key && this.pendingConsumers.get(key) === pending) this.pendingConsumers.delete(key)
    }
  }

  private async attachOnce(sessionId: string, cols: number, rows: number, consumerId: string | undefined, pending: { cancelled: boolean }): Promise<{ output: string; generation?: string; sequence?: number }> {
    let session = this.requireSession(sessionId)
    if (session.backend === 'tmux' && session.tmuxName !== session.name) {
      await this.renameOnce(sessionId, session.name)
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
      const project = this.store.getProjectForRuntime(session.projectId)
      const connection = project ? this.store.getConnection(project.connectionId) : null
      if (!project || !connection) throw new Error('The terminal project is unavailable.')
      if (project.archived || session.archived) throw new Error('This terminal is archived.')
      if (session.backend === 'pty') {
        this.changeState(
          session,
          'completed',
          `${session.name} could not be restored because it used a non-persistent PTY.`
        )
      } else {
        if (connection.kind === 'local' && this.store.isSessionPendingRebootRecovery(sessionId)) {
          await this.restoreLocalSessionOnAttach(session, project, connection, cols, rows)
        } else {
          if (
            connection.kind === 'local' &&
            AGENT_PROFILES.has(session.profile) &&
            session.state !== 'idle' &&
            session.state !== 'needs-input'
          ) {
            this.changeState(session, 'idle')
          }
          await this.launch(session, project.folder, connection, cols, rows, false)
        }
      }
    }
    this.ensureActive()
    this.flushOutput(sessionId)
    const output = session.profile === 'codex'
      ? this.volatileOutput.get(sessionId)?.read() ?? ''
      : this.store.getSession(sessionId)?.output ?? ''
    if (!consumerId || pending.cancelled || this.shuttingDown) return { output }
    const state = this.outputState(sessionId)
    // Replay includes every native delivery received so far, including queued
    // bytes. New consumers skip precisely that prefix when the queue drains.
    this.unsubscribeOutput(sessionId, consumerId, false)
    state.consumers.set(consumerId, { ready: false, cutoff: state.received, sequence: 0, expected: 0, deliver: null, complete: null })
    return { output, generation: state.generation, sequence: 0 }
  }

  acknowledgeOutput(sessionId: string, consumerId: string, generation: string, sequence: number): void {
    const state = this.outputs.get(sessionId)
    const consumer = state?.consumers.get(consumerId)
    if (!state || state.generation !== generation || !consumer || consumer.expected !== sequence) return
    consumer.expected = null
    if (sequence === 0) {
      consumer.ready = true
      consumer.deliver?.()
      return
    }
    const complete = consumer.complete
    consumer.complete = null
    complete?.()
  }

  unsubscribeOutput(sessionId: string, consumerId: string, cancelPending = true): void {
    if (cancelPending) {
      const pending = this.pendingConsumers.get(`${sessionId}:${consumerId}`)
      if (pending) pending.cancelled = true
    }
    const state = this.outputs.get(sessionId)
    const consumer = state?.consumers.get(consumerId)
    if (!consumer) return
    state!.consumers.delete(consumerId)
    consumer.deliver = null
    const complete = consumer.complete
    consumer.complete = null
    complete?.()
  }

  clearOutputConsumers(): void {
    for (const pending of this.pendingConsumers.values()) pending.cancelled = true
    for (const [sessionId, state] of this.outputs) {
      for (const consumerId of state.consumers.keys()) this.unsubscribeOutput(sessionId, consumerId)
    }
  }

  private outputState(sessionId: string): SessionOutput {
    const previous = this.outputs.get(sessionId)
    if (previous) return previous
    const state: SessionOutput = {
      generation: randomUUID(), sequence: 0, received: 0, dispatched: 0,
      consumers: new Map(),
      flow: new TerminalOutputFlow({
        pause: () => this.runtimes.get(sessionId)?.pty.pause(),
        resume: () => this.runtimes.get(sessionId)?.pty.resume(),
        write: (data, done) => this.deliverOutput(sessionId, state, data, done),
        onParsed: () => {
          const runtime = this.runtimes.get(sessionId)
          if (runtime) this.scheduleScreenScan(runtime)
        }
      })
    }
    this.outputs.set(sessionId, state)
    return state
  }

  private deliverOutput(sessionId: string, state: SessionOutput, data: string, done: () => void): void {
    const start = state.dispatched
    state.dispatched += data.length
    const end = state.dispatched
    state.sequence += 1
    // One parser batch and every subscribed surface must finish before reading
    // the next batch. Hidden cached surfaces still acknowledge their parser.
    let remaining = 1
    const complete = (): void => { if (--remaining === 0) done() }
    for (const [consumerId, consumer] of state.consumers) {
      if (end <= consumer.cutoff) continue
      const text = data.slice(Math.max(0, consumer.cutoff - start))
      remaining += 1
      let completed = false
      consumer.complete = () => { if (!completed) { completed = true; complete() } }
      consumer.deliver = () => {
        consumer.deliver = null
        // Each surface begins after its own replay cutoff. Global batches can
        // predate that subscription or contain only replayed bytes for it.
        const sequence = ++consumer.sequence
        consumer.expected = sequence
        const window = this.getWindow()
        if (!window || window.isDestroyed()) { this.unsubscribeOutput(sessionId, consumerId); return }
        window.webContents.send('terminal:data', { sessionId, consumerId, generation: state.generation, sequence, data: text })
      }
      if (consumer.ready) consumer.deliver()
    }
    const runtime = this.runtimes.get(sessionId)
    if (runtime?.screen && !runtime.closingTransport) {
      remaining += 1
      let completed = false
      const parsed = (): void => {
        if (completed) return
        completed = true
        if (runtime.finishParsing === parsed) runtime.finishParsing = null
        complete()
      }
      runtime.finishParsing = parsed
      runtime.screen.write(data, parsed)
    }
    complete()
  }

  private async restoreLocalSessionOnAttach(
    session: TerminalSession,
    project: Project,
    connection: Connection,
    cols: number,
    rows: number
  ): Promise<void> {
    if (!(await this.localTmuxPath()) || !session.tmuxName) {
      throw new Error('Tmux is unavailable, so this terminal cannot resume yet.')
    }
    // Recheck ownership at selection time: another client may have restored it
    // since startup. Never attach to an unrelated session that reused the name.
    const listed = await this.listLocalTmuxSessions()
    if (!listed) throw new Error('Could not check tmux. Retry opening this terminal.')
    const live = listed.find((candidate) => candidate.name === session.tmuxName)
    if (live && live.metadata?.terminalId !== session.id) {
      throw new Error(`Another tmux session is using the name “${session.name}”. PanePilot did not attach to it.`)
    }
    await this.launch(
      session, project.folder, connection, cols, rows, !live,
      !live && AGENT_PROFILES.has(session.profile) && Boolean(session.providerSessionId)
    )
    this.store.prepareSessionForRebootRecovery(session.id, !live)
  }

  async retryAttach(sessionId: string, cols: number, rows: number): Promise<void> {
    let session = this.requireSession(sessionId)
    const project = this.store.getProjectForRuntime(session.projectId)
    const connection = project ? this.store.getConnection(project.connectionId) : null
    if (!project || !connection) throw new Error('The terminal project is unavailable.')
    if (connection.kind === 'local' && this.store.isSessionPendingRebootRecovery(sessionId)) {
      await this.attach(sessionId, cols, rows)
      return
    }

    if (
      ['completed', 'error'].includes(session.state) &&
      session.backend === 'tmux' &&
      session.tmuxName
    ) {
      if (connection.kind === 'ssh') {
        await this.reconcileSessions(connection.id)
      } else if (await this.tmuxSessionExists(connection, session.tmuxName)) {
        this.store.setSessionState(
          session.id,
          'idle',
          `Rediscovered running tmux session ${session.tmuxName}`
        )
      }
      session = this.requireSession(sessionId)
    }
    if (['completed', 'error'].includes(session.state)) {
      throw new Error('This terminal is no longer running in tmux.')
    }

    if (session.backend !== 'tmux' || !session.tmuxName) {
      if (this.runtimes.has(sessionId)) {
        this.emitTransport(sessionId, 'attached')
        return
      }
      await this.launch(session, project.folder, connection, cols, rows, false)
      return
    }

    const runtime = this.runtimes.get(sessionId)
    const nextCols = runtime?.cols ?? cols
    const nextRows = runtime?.rows ?? rows
    if (
      connection.kind === 'local' &&
      !(await this.tmuxSessionExists(connection, session.tmuxName))
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
      await this.launch(
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
    if (Buffer.byteLength(data, 'utf8') > MAX_TERMINAL_INPUT_BYTES) {
      throw new Error('Terminal input is limited to 2 MB at a time.')
    }
    for (const chunk of terminalInputChunks(data)) runtime.pty.write(chunk)
  }

  private readonly previewReads = new TerminalPreviewReads()

  async preview(sessionId: string): Promise<TerminalPreviewSnapshot> {
    const session = this.requireSession(sessionId)
    if (session.archived) {
      throw new Error('This session cannot be previewed.')
    }
    const project = this.store.getProjectForRuntime(session.projectId)
    const connection = project && !project.archived ? this.store.getConnection(project.connectionId) : null
    if (!connection) throw new Error('The terminal project is unavailable.')
    return this.previewReads.read(sessionId, async () => {
      if (session.backend === 'tmux' && session.tmuxName) {
        const tmuxPath = connection.kind === 'local' ? this.tmuxPath :
          this.remoteTmuxPaths.get(connection.id) ?? await resolveRemoteTmuxAsync(connection.sshAlias ?? connection.name)
        if (!tmuxPath) throw new Error('Tmux is unavailable.')
        if (connection.kind === 'ssh') this.remoteTmuxPaths.set(connection.id, tmuxPath)
        return captureTmuxPreview(tmuxPath, session.tmuxName,
          connection.kind === 'ssh' ? connection.sshAlias ?? connection.name : undefined)
      }
      const runtime = this.runtimes.get(sessionId)
      if (!runtime?.screen) throw new Error('No screen snapshot is available for this detached terminal.')
      const buffer = runtime.screen.buffer.active
      const output = Array.from({ length: runtime.screen.rows }, (_, index) =>
        buffer.getLine(buffer.baseY + index)?.translateToString(true) ?? '').join('\n')
      return { output, cols: runtime.screen.cols, rows: runtime.screen.rows, source: 'buffer' }
    })
  }

  async captureBuffer(sessionId: string): Promise<string> {
    const session = this.requireSession(sessionId)
    if (session.backend !== 'tmux' || !session.tmuxName) {
      throw new Error('Full-buffer copy requires a tmux-backed terminal.')
    }
    const project = this.store.getProjectForRuntime(session.projectId)
    const connection = project
      ? this.store.getConnection(project.connectionId)
      : null
    if (!connection) throw new Error('The terminal project is unavailable.')
    const tmuxPath = await this.tmuxPathForConnection(connection)
    if (!tmuxPath) throw new Error(`Tmux is unavailable on ${connection.name}.`)
    const target = `=${session.tmuxName}:`
    const args = ['capture-pane', '-p', '-J', '-S', '-', '-t', target]

    if (connection.kind === 'local') {
      const result = await this.execCommand(tmuxPath, args, {
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: MAX_TERMINAL_CAPTURE_OUTPUT
      })
      return result.stdout
    }

    try {
      const result = await this.execCommand(
        'ssh',
        [
          '-T',
          '-o',
          'BatchMode=yes',
          '-o',
          'ConnectTimeout=5',
          connection.sshAlias ?? connection.name,
          `${quote(tmuxPath)} ${args.map(quote).join(' ')}`
        ],
        {
          encoding: 'utf8',
          timeout: 10_000,
          maxBuffer: MAX_TERMINAL_CAPTURE_OUTPUT
        }
      )
      return result.stdout
    } catch (error) {
      const detail =
        error instanceof Error && 'stderr' in error
          ? String((error as Error & { stderr?: string }).stderr ?? '').trim()
          : ''
      throw new Error(
        detail || `Could not capture tmux session “${session.tmuxName}” on ${connection.name}.`
      )
    }
  }

  sendPrompt(sessionId: string, prompt: string): void {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) throw new Error('Open the chat before sending a message.')
    const cleaned = prompt.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
    if (!cleaned) throw new Error('Enter a message for the agent.')
    this.write(sessionId, `\x1b[200~${cleaned}\x1b[201~\r`)
    const latest = this.store.getSessionWithoutOutput(sessionId)
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
    runtime.screen?.resize(safeCols, safeRows)
  }

  acknowledge(sessionId: string): void {
    const session = this.requireSession(sessionId)
    const acknowledged = acknowledgedAgentState(session.state)
    if (acknowledged !== session.state) this.changeState(session, acknowledged)
  }

  resumeAgent(sessionId: string): Promise<void> {
    return this.serializeOperation(sessionId, () => this.resumeAgentOnce(sessionId))
  }

  private async resumeAgentOnce(sessionId: string): Promise<void> {
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
    const project = this.store.getProjectForRuntime(session.projectId)
    const connection = project ? this.store.getConnection(project.connectionId) : null
    if (!project || !connection) throw new Error('The terminal project is unavailable.')

    const persistentSessionExists =
      session.backend === 'tmux' && session.tmuxName
        ? await this.tmuxSessionExists(connection, session.tmuxName)
        : false
    const providerLabel = session.profile === 'claude' ? 'Claude' : 'Codex'
    this.changeState(
      session,
      'idle',
      `Resumed ${providerLabel} session ${providerSessionReference}.`
    )
    const latest = this.requireSession(sessionId)
    try {
      await this.launch(
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

  forceReloadAgent(sessionId: string): Promise<void> {
    return this.serializeOperation(sessionId, () => this.forceReloadAgentOnce(sessionId))
  }

  private async forceReloadAgentOnce(sessionId: string): Promise<void> {
    let session = this.requireSession(sessionId)
    if (!AGENT_PROFILES.has(session.profile)) {
      throw new Error('Only Codex or Claude chats can be force reloaded.')
    }
    if (session.archived) {
      throw new Error('Restore the archived chat before force reloading it.')
    }

    const project = this.store.getProjectForRuntime(session.projectId)
    const connection = project ? this.store.getConnection(project.connectionId) : null
    if (!project || !connection) throw new Error('The terminal project is unavailable.')

    if (!session.providerSessionId) {
      try {
        await this.discoverProviderSession(session, project.folder, connection)
      } catch {
        // Reload must still recover a tab whose original provider process never
        // became linkable. In that case the same tab starts a fresh chat below.
      }
      session = this.requireSession(sessionId)
    }
    const providerSessionReference = session.providerSessionId

    const runtime = this.runtimes.get(sessionId)
    const cols = runtime?.cols ?? 100
    const rows = runtime?.rows ?? 30
    this.cancelReconnect(sessionId)
    if (runtime) this.closeRuntimeForReconnect(runtime)
    if (session.profile === 'codex') this.volatileOutput.delete(sessionId)

    try {
      if (session.backend === 'tmux' && session.tmuxName) {
        await this.killTmuxSession(connection, session.tmuxName)
      }
      const providerLabel = session.profile === 'claude' ? 'Claude' : 'Codex'
      this.changeState(
        session,
        'idle',
        providerSessionReference
          ? `Force reloaded ${providerLabel} session ${providerSessionReference}.`
          : `Force reloaded ${providerLabel} as a new chat because no provider session ID was available.`
      )
      await this.launch(
        this.requireSession(sessionId),
        project.folder,
        connection,
        cols,
        rows,
        true,
        Boolean(providerSessionReference)
      )
    } catch (error) {
      const latest = this.store.getSessionWithoutOutput(sessionId)
      if (latest) {
        this.changeState(latest, 'error', `Could not force reload ${session.name}.`)
      }
      throw error
    }
  }

  rename(sessionId: string, name: string): Promise<void> {
    return this.serializeOperation(sessionId, () => this.renameOnce(sessionId, name))
  }

  private async renameOnce(sessionId: string, name: string): Promise<void> {
    const cleaned = validatedTerminalName(name)
    const session = this.requireSession(sessionId)
    let tmuxName = session.tmuxName
    if (session.backend === 'tmux' && session.tmuxName) {
      if (cleaned === session.name && cleaned === session.tmuxName) return
      const project = this.store.getProjectForRuntime(session.projectId)
      const connection = project ? this.store.getConnection(project.connectionId) : null
      if (!connection) throw new Error('Project connection not found.')
      const connectionTmuxPath = await this.tmuxPathForConnection(connection)
      const persistentSessionExists = await this.tmuxSessionExists(
        connection,
        session.tmuxName
      )
      if (cleaned !== session.tmuxName && persistentSessionExists) {
        if (await this.tmuxSessionExists(connection, cleaned)) {
          throw new Error(
            `A tmux session named “${cleaned}” already exists on ${connection.name}.`
          )
        }
      }
      const renamedTmux = cleaned
      if (persistentSessionExists) {
        if (!connectionTmuxPath) throw new Error('Tmux is unavailable.')
        const args = ['rename-session', '-t', `=${session.tmuxName}`, renamedTmux]
        await this.execCommand(
          connection.kind === 'local' ? connectionTmuxPath : 'ssh',
          connection.kind === 'local' ? args : [
            '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
            connection.sshAlias ?? connection.name,
            [connectionTmuxPath, ...args].map(quote).join(' ')
          ],
          { encoding: 'utf8', timeout: connection.kind === 'local' ? 3_000 : 7_000, maxBuffer: 64 * 1024 }
        )
      }
      tmuxName = renamedTmux
    }
    if (cleaned === session.name && tmuxName === session.tmuxName) return
    this.store.renameSession(sessionId, cleaned, tmuxName)
    const runtime = this.runtimes.get(sessionId)
    const latest = this.store.getSessionWithoutOutput(sessionId)
    if (runtime && latest) runtime.session = latest
  }

  transferSession(
    sessionId: string,
    targetProjectId: string
  ): Promise<TerminalSession> {
    return this.serializeOperation(sessionId, () => this.transferSessionOnce(sessionId, targetProjectId))
  }

  private async transferSessionOnce(
    sessionId: string,
    targetProjectId: string
  ): Promise<TerminalSession> {
    const session = this.requireSession(sessionId)
    if (session.kind !== 'terminal' || session.archived) {
      throw new Error('Only active ordinary terminal sessions can be transferred.')
    }
    const sourceProject = this.store.getProjectForRuntime(session.projectId)
    const targetProject = this.store.getProjectForRuntime(targetProjectId)
    if (!sourceProject || !targetProject || targetProject.archived) {
      throw new Error('Choose an active destination project.')
    }
    if (sourceProject.id === targetProject.id) return session
    this.ensureProjectLaunchable(sourceProject.id)
    this.ensureProjectLaunchable(targetProjectId)
    if (sourceProject.connectionId !== targetProject.connectionId) {
      throw new Error('A terminal can only move to a project on the same machine.')
    }
    const connection = this.store.getConnection(sourceProject.connectionId)
    if (!connection) throw new Error('Project connection not found.')
    const liveTmuxSession =
      session.backend === 'tmux' &&
      session.tmuxName != null &&
      await this.tmuxSessionExists(connection, session.tmuxName)
    if (
      liveTmuxSession &&
      !(await this.writeSessionMetadata(targetProject, session, connection))
    ) {
      throw new Error(
        'Could not retag the live tmux session for the destination project.'
      )
    }

    let transferred: TerminalSession
    try {
      this.ensureProjectLaunchable(sourceProject.id)
      this.ensureProjectLaunchable(targetProjectId)
      transferred = this.store.transferSession(sessionId, targetProjectId)
    } catch (error) {
      if (liveTmuxSession) {
        await this.writeSessionMetadata(sourceProject, session, connection)
      }
      throw error
    }
    if (liveTmuxSession) {
      this.store.markSessionTmuxMetadataManaged(sessionId)
    }
    const runtime = this.runtimes.get(sessionId)
    if (runtime) runtime.session = transferred
    this.getWindow()?.webContents.send('terminal:metadata', {
      sessionId,
      projectId: targetProjectId
    })
    return transferred
  }

  setPinned(sessionId: string, pinned: boolean): void {
    this.store.setSessionPinned(sessionId, pinned)
  }

  setFlagged(sessionId: string, flagged: boolean): void {
    this.store.setSessionFlagged(sessionId, flagged)
  }

  async archiveProject(projectId: string): Promise<void> {
    const project = this.store.getProjectForRuntime(projectId)
    if (!project) throw new Error('Project not found.')
    if (project.archived) return
    this.stoppingProjects.add(projectId)
    try {
      await this.serializeOperation(`launch:${project.connectionId}`, async () => {
        const current = this.store.getProjectForRuntime(projectId)
        if (!current || current.archived) return
        for (const session of current.sessions) {
          await this.serializeOperation(session.id, async () => {
            const latest = this.store.getSessionWithoutOutput(session.id)
            if (latest) await this.terminateSession(latest)
          })
        }
        this.ensureActive()
        this.store.archiveProject(projectId, true)
      })
    } finally { this.stoppingProjects.delete(projectId) }
  }

  stop(sessionId: string): Promise<void> {
    return this.serializeOperation(sessionId, () => this.stopOnce(sessionId))
  }

  private async stopOnce(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId)
    if (session.kind === 'terminal') {
      this.detachTerminal(session)
      return
    }
    await this.terminateSession(session)
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

  private async terminateSession(session: TerminalSession): Promise<void> {
    const runtime = this.runtimes.get(session.id)
    this.cancelReconnect(session.id)
    if (runtime) {
      runtime.intentionalStop = true
    }
    if (isLatexInlineEditSession(session)) {
      this.rejectLatexInlineExec(
        session.id,
        new Error('The inline edit was stopped before it finished.')
      )
    }
    if (session.backend === 'tmux' && session.tmuxName) {
      const project = this.store.getProjectForRuntime(session.projectId)
      const connection = project ? this.store.getConnection(project.connectionId) : null
      if (!connection) throw new Error('Project connection not found.')
      await this.killTmuxSession(connection, session.tmuxName)
    }
    runtime?.pty.kill()
    this.changeState(session, 'completed', `${session.name} was stopped.`)
    this.emitTransport(session.id, 'detached', 0, 'The terminal was stopped.')
  }

  delete(sessionId: string): Promise<void> {
    return this.serializeOperation(sessionId, () => this.deleteOnce(sessionId))
  }

  private async deleteOnce(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId)
    const runtime = this.runtimes.get(sessionId)
    const outputWasClosed = runtime?.outputClosed ?? false
    if (runtime) runtime.outputClosed = true
    try {
      const project = this.store.getProjectForRuntime(session.projectId)
      const connection = project
        ? this.store.getConnection(project.connectionId)
        : null
      const liveTmuxSession =
        session.backend === 'tmux' &&
        session.tmuxName != null &&
        connection != null &&
        await this.tmuxSessionExists(connection, session.tmuxName)
      if (
        !['completed', 'error'].includes(session.state) ||
        liveTmuxSession
      ) {
        await this.terminateSession(session)
      }
      this.ensureActive()
      this.cancelReconnect(sessionId)
      this.store.deleteSession(sessionId)
      this.discardPendingOutput(sessionId)
      const output = this.outputs.get(sessionId)
      output?.flow.dispose()
      this.outputs.delete(sessionId)
    } catch (error) {
      if (runtime) runtime.outputClosed = outputWasClosed
      throw error
    }
  }

  updateRestartBlocker(): string | null {
    if (this.latexInlineExecWaiters.size) return 'Wait for the inline edit to finish before updating.'
    if ([...this.runtimes.values()].some((runtime) => runtime.session.backend !== 'tmux')) {
      return 'Stop non-tmux terminals before updating; they cannot survive an app restart.'
    }
    return null
  }

  shutdown(): void {
    if (this.shuttingDown) return
    this.shuttingDown = true
    this.processAbort.abort()
    for (const [sessionId, waiter] of this.latexInlineExecWaiters) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('PanePilot closed before the inline edit finished.'))
      this.latexInlineExecWaiters.delete(sessionId)
    }
    for (const sessionId of this.pendingOutput.keys()) {
      this.flushOutput(sessionId, true)
    }
    this.connectionRetries.shutdown()
    this.reconnects.clear()
    this.tmuxReconciliations.clear()
    this.remoteTmuxReads.clear()
    this.remoteTmuxPaths.clear()
    this.volatileOutput.clear()
    for (const runtime of this.runtimes.values()) {
      runtime.closingTransport = true
      if (runtime.scanTimer) clearTimeout(runtime.scanTimer)
      if (runtime.providerTimer) clearTimeout(runtime.providerTimer)
      if (runtime.actionTimer) clearTimeout(runtime.actionTimer)
      runtime.pty.kill()
      runtime.finishParsing?.()
      runtime.screen?.dispose()
    }
    this.runtimes.clear()
    this.clearOutputConsumers()
    for (const state of this.outputs.values()) state.flow.dispose()
    this.outputs.clear()
  }

  private async launch(
    session: TerminalSession,
    folder: string,
    connection: Connection,
    cols: number,
    rows: number,
    create: boolean,
    resumeProvider = false,
    commandOverride?: string
  ): Promise<void> {
    const existing = this.launches.get(session.id)
    if (existing) return existing
    const pending = this.launchOnce(session, folder, connection, cols, rows, create, resumeProvider, commandOverride)
    this.launches.set(session.id, pending)
    const clear = (): void => { if (this.launches.get(session.id) === pending) this.launches.delete(session.id) }
    void pending.then(clear, clear)
    return pending
  }

  private async launchOnce(
    session: TerminalSession,
    folder: string,
    connection: Connection,
    cols: number,
    rows: number,
    create: boolean,
    resumeProvider = false,
    commandOverride?: string
  ): Promise<void> {
    if (this.runtimes.has(session.id)) return
    const command =
      commandOverride ??
      launchCommand(
        session.profile,
        session.customCommand,
        session.dangerousMode,
        resumeProvider ? session.providerSessionId : null
      )
    await this.tmuxPathForConnection(connection)
    this.ensureProjectLaunchable(session.projectId)
    if (this.shuttingDown) throw new Error('PanePilot is closing.')
    const child = await this.spawnTerminal(session, folder, connection, command, cols, rows, create)
    if (this.shuttingDown) { child.kill(); return }
    this.store.clearSessionRebootRecovery(session.id)
    const screen = session.backend === 'pty' || (AGENT_PROFILES.has(session.profile) && !isLatexInlineEditSession(session))
      ? new HeadlessTerminal({ cols, rows, scrollback: 0, allowProposedApi: true })
      : null
    const runtime: Runtime = {
      pty: child,
      screen,
      finishParsing: null,
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
    screen?.onTitleChange((title) => {
      runtime.title = title
    })
    this.runtimes.set(session.id, runtime)
    const outputState = this.outputState(session.id)
    if (outputState.flow.paused) child.pause()
    this.cancelReconnect(session.id)
    this.emitTransport(session.id, 'attached')
    this.scheduleProviderDiscovery(runtime, folder, connection)
    this.scheduleActionCompletion(runtime)

    child.onData((data) => {
      if (this.shuttingDown || runtime.closingTransport) return
      if (!runtime.outputClosed) this.retainTerminalOutput(session, data)
      outputState.received += data.length
      outputState.flow.enqueue(data)
    })
    child.onExit(({ exitCode }) => {
      if (runtime.scanTimer) clearTimeout(runtime.scanTimer)
      if (runtime.providerTimer) clearTimeout(runtime.providerTimer)
      if (runtime.actionTimer) clearTimeout(runtime.actionTimer)
      runtime.finishParsing?.()
      runtime.screen?.dispose()
      if (this.runtimes.get(session.id) === runtime) {
        this.runtimes.delete(session.id)
      }
      if (runtime.closingTransport) return
      this.flushOutput(session.id)
      const latest = this.store.getSessionWithoutOutput(session.id)
      if (!latest) return
      if (runtime.intentionalStop || latest.state === 'completed') return
      if (isLatexInlineEditSession(latest)) {
        const error = new Error(
          `${latest.name} exited before Codex returned an inline-edit result.`
        )
        this.rejectLatexInlineExec(latest.id, error)
        this.changeState(
          latest,
          exitCode === 0 ? 'completed' : 'error',
          error.message
        )
        this.emitTransport(latest.id, 'detached', 0, error.message)
        return
      }
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
    if (
      !AGENT_PROFILES.has(runtime.session.profile) ||
      runtime.session.providerSessionId ||
      isLatexInlineEditSession(runtime.session)
    ) {
      return
    }
    if (runtime.providerTimer || runtime.providerAttempts >= 45) return
    runtime.providerTimer = setTimeout(() => {
      if (this.shuttingDown) return
      runtime.providerTimer = null
      runtime.providerAttempts += 1
      void this.discoverProviderSession(runtime.session, folder, connection)
        .then((linked) => {
          if (this.shuttingDown) return
          const latest = this.store.getSessionWithoutOutput(runtime.session.id)
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
    const latest = this.store.getSessionWithoutOutput(session.id)
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
        ? await this.conversations.findProviderSessionId(
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
      const tmuxPath = await this.localTmuxPath()
      if (!tmuxPath) return null
      try {
        const result = await this.execCommand(tmuxPath,
          ['display-message', '-p', '-t', `=${session.tmuxName}:`, '#{pane_title}'],
          { encoding: 'utf8', timeout: 2_000, maxBuffer: 64 * 1024 })
        return codexThreadReferenceFromPaneTitle(result.stdout)
      } catch { return null }
    }

    const listed = await this.listRemoteTmuxSessions(connection)
    const remote = listed?.find(
      (candidate) =>
        candidate.metadata?.terminalId === session.id ||
        candidate.name === session.tmuxName
    )
    return codexThreadReferenceFromPaneTitle(remote?.paneTitle ?? '')
  }

  private async spawnTerminal(
    session: TerminalSession,
    folder: string,
    connection: Connection,
    command: string,
    cols: number,
    rows: number,
    create: boolean
  ): Promise<pty.IPty> {
    const env = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      PATH: await terminalPath()
    } as Record<string, string>
    this.ensureProjectLaunchable(session.projectId)

    if (connection.kind === 'ssh') {
      const alias = connection.sshAlias ?? connection.name
      let remoteLaunchCommand =
        session.profile === 'shell' ? command : interactiveLoginCommand(command)
      let remoteCommand: string
      if (session.backend === 'tmux' && session.tmuxName) {
        const remoteTmuxPath = await this.tmuxPathForConnection(connection)
        this.ensureProjectLaunchable(session.projectId)
        if (!remoteTmuxPath) {
          throw new Error(`Tmux is unavailable on ${connection.name}.`)
        }
        if (create) {
          const project = this.store.getProjectForRuntime(session.projectId)
          if (project) {
            const metadataCommand = tmuxMetadataShellCommand(
              this.metadataForSession(project, session),
              undefined,
              false,
              remoteTmuxPath
            )
            remoteLaunchCommand =
              `(${metadataCommand}) || true; ${
                session.kind === 'action' || isLatexInlineEditSession(session)
                  ? actionRunCommand(remoteTmuxPath, remoteLaunchCommand)
                  : remoteLaunchCommand
              }`
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
      const project = this.store.getProjectForRuntime(session.projectId)
      const persistentCommand =
        create && project
          ? `(${tmuxMetadataShellCommand(
              this.metadataForSession(project, session),
              undefined,
              false,
              this.tmuxPath
          )}) || true; ${
              session.kind === 'action' || isLatexInlineEditSession(session)
                ? actionRunCommand(this.tmuxPath, command)
                : command
            }`
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

  private visibleScreenText(runtime: Runtime): string {
    if (!runtime.screen) return ''
    const buffer = runtime.screen.buffer.active
    const start = buffer.viewportY
    const end = Math.min(buffer.length, start + runtime.screen.rows)
    const lines: string[] = []
    for (let index = start; index < end; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? '')
    }
    return lines.join('\n')
  }

  private scheduleScreenScan(runtime: Runtime): void {
    if (!runtime.detector) return
    if (runtime.scanTimer) return
    runtime.scanTimer = setTimeout(() => {
      runtime.scanTimer = null
      const screenText = this.visibleScreenText(runtime)
      const latest = this.store.getSessionWithoutOutput(runtime.session.id)
      if (!latest) return
      const codex = runtime.session.profile === 'codex'
      const questionVisible =
        codex && codexQueuedQuestionOnScreen(screenText)
      const fallbackState = runtime.detector?.inspect(screenText)
      const nextState = codex && (questionVisible || latest.state === 'needs-input')
        ? codexStateFromPaneSnapshot(runtime.title, screenText, latest.state)
        : fallbackState
      if (nextState) {
        if (!codex && latest.state === 'needs-input' && nextState !== 'needs-input') return
        const message =
          nextState === 'running'
            ? `${latest.name} is working.`
            : nextState === 'needs-input'
              ? `${latest.name} has a queued question for you.`
              : nextState === 'idle'
                ? `${latest.name} is no longer waiting for a queued answer.`
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

  private retainTerminalOutput(session: TerminalSession, data: string): void {
    if (!data || this.shuttingDown) return
    if (persistsTerminalOutput(session.profile)) {
      this.queueOutput(session.id, data)
      return
    }
    const output = this.volatileOutput.get(session.id) ??
      new TerminalOutputBuffer(OUTPUT_BUFFER_LIMIT)
    output.append(data)
    this.volatileOutput.set(session.id, output)
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
    this.volatileOutput.delete(sessionId)
  }

  private resolveLatexInlineExec(
    sessionId: string,
    result: LatexInlineExecResult
  ): void {
    const waiter = this.latexInlineExecWaiters.get(sessionId)
    if (!waiter) return
    clearTimeout(waiter.timer)
    this.latexInlineExecWaiters.delete(sessionId)
    waiter.resolve(result)
  }

  private rejectLatexInlineExec(sessionId: string, error: Error): void {
    const waiter = this.latexInlineExecWaiters.get(sessionId)
    if (!waiter) return
    clearTimeout(waiter.timer)
    this.latexInlineExecWaiters.delete(sessionId)
    waiter.reject(error)
  }

  private scheduleActionCompletion(runtime: Runtime): void {
    if (
      this.shuttingDown ||
      (runtime.session.kind !== 'action' &&
        !isLatexInlineEditSession(runtime.session)) ||
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
    }, isLatexInlineEditSession(runtime.session)
      ? INLINE_EDIT_COMPLETION_POLL_MS
      : ACTION_COMPLETION_POLL_MS)
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

    if (isLatexInlineEditSession(runtime.session)) {
      runtime.outputClosed = true
      const streamedOutput =
        this.volatileOutput.get(runtime.session.id)?.read() ?? ''
      const output = retainedVolatileTerminalOutput(
        snapshot.output || streamedOutput
      )
      const retained = new TerminalOutputBuffer(OUTPUT_BUFFER_LIMIT)
      retained.append(output)
      this.volatileOutput.set(runtime.session.id, retained)
      const latest = this.store.getSessionWithoutOutput(runtime.session.id)
      if (!latest) {
        this.rejectLatexInlineExec(
          runtime.session.id,
          new Error('The inline-edit session disappeared before completion.')
        )
        return
      }
      const state = snapshot.exitCode === 0 ? 'response-ready' : 'error'
      const message =
        snapshot.exitCode === 0
          ? `${latest.name} applied an inline edit.`
          : `${latest.name} exited with code ${snapshot.exitCode}.`
      this.changeState(latest, state, message)
      this.emitTransport(latest.id, 'detached', 0, message)
      this.resolveLatexInlineExec(latest.id, {
        exitCode: snapshot.exitCode,
        output
      })
      return
    }

    runtime.outputClosed = true
    this.flushOutput(runtime.session.id)
    const streamedOutput =
      this.store.getSession(runtime.session.id)?.output ?? ''
    this.discardPendingOutput(runtime.session.id)
    try {
      this.store.replaceOutput(
        runtime.session.id,
        snapshot.output.trim() || !streamedOutput
          ? snapshot.output
          : streamedOutput
      )
      runtime.intentionalStop = true
      await this.killTmuxSession(runtime.connection, runtime.session.tmuxName!)
    } catch {
      runtime.outputClosed = false
      runtime.intentionalStop = false
      this.scheduleActionCompletion(runtime)
      return
    }

    runtime.pty.kill()
    const latest = this.store.getSessionWithoutOutput(runtime.session.id)
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
    const tmuxPath = await this.tmuxPathForConnection(runtime.connection)
    if (!tmuxPath) return null
    const target = `=${name}:`
    const stateFormat =
      `#{${ACTION_EXIT_STATUS_OPTION}}:#{pane_dead}:#{pane_dead_status}`
    let exitCode: number | null
    try {
      const state = await this.readActionTmuxOutput(
        runtime.connection,
        tmuxPath,
        ['display-message', '-p', '-t', target, stateFormat],
        false
      )
      exitCode = actionExitStatus(state)
    } catch {
      return null
    }
    if (exitCode == null) return null

    // Running Actions already stream through their PTY. Only capture once the
    // exit marker is known, and never let a failed capture hide that marker.
    let output = ''
    try {
      output = await this.readActionTmuxOutput(
        runtime.connection,
        tmuxPath,
        ['capture-pane', '-p', '-e', '-S', '-', '-t', target],
        true
      )
    } catch {
      // Completion falls back to the output already received from the PTY.
    }
    return { exitCode, output: output.replace(/\r?\n/g, '\r\n') }
  }

  private async readActionTmuxOutput(
    connection: Connection,
    tmuxPath: string,
    args: string[],
    capture: boolean
  ): Promise<string> {
    const command = [tmuxPath, ...args].map(quote).join(' ') +
      (capture ? ` | tail -c ${MAX_ACTION_CAPTURE_OUTPUT}` : '')
    const local = connection.kind === 'local'
    const executable = local ? (capture ? '/bin/sh' : tmuxPath) : 'ssh'
    const processArgs = local
      ? (capture ? ['-c', command] : args)
      : [
          '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
          connection.sshAlias ?? connection.name, command
        ]
    const { stdout } = await this.execCommand(executable, processArgs, {
      encoding: 'buffer',
      timeout: local ? 2_000 : 8_000,
      maxBuffer: capture ? MAX_ACTION_CAPTURE_OUTPUT : 4_096
    })
    // tail bounds transfer at the source, including over SSH. Its first byte
    // can land inside a UTF-8 character, so discard only that partial prefix.
    let start = 0
    if (capture) {
      while (start < stdout.length && (stdout[start] & 0xc0) === 0x80) start += 1
    }
    return stdout.subarray(start).toString('utf8')
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

  private listRemoteTmuxSessions(
    connection: Connection
  ): Promise<ListedTmuxSession[] | null> {
    const existing = this.remoteTmuxReads.get(connection.id)
    if (existing) return existing
    // Reconnecting tabs and ordinary discovery need the same host snapshot.
    // Share only an in-flight read; the next attempt must verify live state.
    const pending = this.readRemoteTmuxSessions(connection)
    this.remoteTmuxReads.set(connection.id, pending)
    const clearPending = (): void => {
      if (this.remoteTmuxReads.get(connection.id) === pending) {
        this.remoteTmuxReads.delete(connection.id)
      }
    }
    void pending.then(clearPending, clearPending)
    return pending
  }

  private async readRemoteTmuxSessions(
    connection: Connection
  ): Promise<ListedTmuxSession[] | null> {
    const remoteCommand =
      `${remoteTmuxResolutionCommand()}; ` +
      `panepilot_output=$("$panepilot_tmux" ${tmuxSessionListArgs().map(quote).join(' ')} 2>&1); ` +
      `panepilot_code=$?; ` +
      `if [ "$panepilot_code" -eq 0 ]; then ` +
      `printf '%s\\n' "$panepilot_output"; exit 0; fi; ` +
      `case "$panepilot_output" in ` +
      `*"no server running"*|*"failed to connect to server"*) exit 0 ;; ` +
      `*) printf '%s\\n' "$panepilot_output" >&2; exit "$panepilot_code" ;; ` +
      `esac`
    try {
      const result = await this.execCommand(
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

  private async listLocalTmuxSessions(): Promise<ListedTmuxSession[] | null> {
    const tmuxPath = await this.localTmuxPath()
    if (!tmuxPath) return null
    try {
      const result = await this.execCommand(tmuxPath, tmuxSessionListArgs(), {
        encoding: 'utf8', timeout: 4_000, maxBuffer: MAX_TMUX_LIST_OUTPUT
      })
      return parseTmuxSessionList(result.stdout)
    } catch (error) {
      const result = error as { stdout?: string; stderr?: string }
      const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`
      return /no server running|failed to connect to server|error connecting to .*\((?:No such file or directory|Connection refused)\)/i.test(detail) ? [] : null
    }
  }

  private listTmuxSessions(
    connection: Connection
  ): Promise<ListedTmuxSession[] | null> {
    return connection.kind === 'local'
      ? this.listLocalTmuxSessions()
      : this.listRemoteTmuxSessions(connection)
  }

  private beginRemoteReconnect(
    sessionId: string,
    cols: number,
    rows: number,
    lastExitCode: number,
    immediate = false
  ): void {
    if (this.shuttingDown) return
    const session = this.store.getSessionWithoutOutput(sessionId)
    const project = session ? this.store.getProjectForRuntime(session.projectId) : null
    const connection = project ? this.store.getConnection(project.connectionId) : null
    if (!connection || connection.kind !== 'ssh') return
    const existing = this.reconnects.get(sessionId)
    if (existing && existing.connectionId !== connection.id) this.cancelReconnect(sessionId)
    const reconnect: ReconnectRuntime = existing?.connectionId === connection.id ? existing : {
      sessionId,
      connectionId: connection.id,
      cols,
      rows,
      attempt: 0,
      lastExitCode,
      transportState: 'reconnecting'
    }
    reconnect.connectionId = connection.id
    reconnect.cols = Math.max(20, Math.floor(cols))
    reconnect.rows = Math.max(5, Math.floor(rows))
    reconnect.lastExitCode = lastExitCode
    reconnect.transportState = 'reconnecting'
    if (immediate) reconnect.attempt = 0
    this.reconnects.set(sessionId, reconnect)
    this.connectionRetries.schedule(
      connection.id,
      () => this.runConnectionReconnect(connection.id),
      immediate
    )
  }

  private async runConnectionReconnect(connectionId: string): Promise<boolean> {
    if (this.shuttingDown) return true
    const pending = [...this.reconnects.values()].filter((item) => item.connectionId === connectionId)
    if (!pending.length) return true
    const connection = this.store.getConnection(connectionId)
    if (!connection || connection.kind !== 'ssh') {
      for (const reconnect of pending) this.cancelReconnect(reconnect.sessionId)
      return true
    }
    for (const reconnect of pending) {
      reconnect.transportState = 'reconnecting'
      this.emitTransport(
        reconnect.sessionId,
        'reconnecting',
        reconnect.attempt + 1,
        'Reconnecting to the existing tmux session…'
      )
    }
    // One bounded host snapshot feeds every exact terminal identity in this
    // round, even when participants take different amounts of time to attach.
    const listed = await this.listRemoteTmuxSessions(connection).catch(() => null)
    if (this.shuttingDown) return true
    await Promise.all(pending.map((reconnect) => this.runRemoteReconnect(reconnect, connection, listed)))
    return ![...this.reconnects.values()].some((item) => item.connectionId === connectionId)
  }

  private async runRemoteReconnect(
    reconnect: ReconnectRuntime,
    connection: Connection,
    listed: ListedTmuxSession[] | null
  ): Promise<void> {
    if (this.shuttingDown || this.reconnects.get(reconnect.sessionId) !== reconnect) return
    const session = this.store.getSessionWithoutOutput(reconnect.sessionId)
    const project = session
      ? this.store.getProjectForRuntime(session.projectId)
      : null
    if (
      !session ||
      !project ||
      project.connectionId !== connection.id ||
      reconnect.connectionId !== connection.id ||
      project.archived || session.archived ||
      session.backend !== 'tmux' ||
      !session.tmuxName ||
      ['completed', 'error'].includes(session.state)
    ) {
      this.cancelReconnect(reconnect.sessionId)
      return
    }

    if (!listed) {
      reconnect.attempt += 1
      reconnect.transportState = 'offline'
      this.emitTransport(
        reconnect.sessionId,
        'offline',
        reconnect.attempt,
        `Cannot reach ${connection.name}. PanePilot will keep retrying.`
      )
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
    try {
      await this.launch(
        this.requireSession(session.id),
        project.folder,
        connection,
        reconnect.cols,
        reconnect.rows,
        false
      )
      if (this.reconnects.get(session.id) === reconnect) this.cancelReconnect(session.id)
    } catch {
      if (this.shuttingDown || this.reconnects.get(session.id) !== reconnect) return
      reconnect.attempt += 1
      reconnect.transportState = 'offline'
      this.emitTransport(session.id, 'offline', reconnect.attempt,
        `Could not attach to ${connection.name}. PanePilot will keep retrying.`)
    }
  }

  private cancelReconnect(sessionId: string): void {
    const reconnect = this.reconnects.get(sessionId)
    this.reconnects.delete(sessionId)
    if (reconnect && ![...this.reconnects.values()].some((item) => item.connectionId === reconnect.connectionId)) {
      this.connectionRetries.cancel(reconnect.connectionId)
    }
  }

  private closeRuntimeForReconnect(runtime: Runtime): void {
    runtime.closingTransport = true
    runtime.finishParsing?.()
    runtime.screen?.dispose()
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
    remote: ListedTmuxSession,
    screenText?: string | null
  ): boolean {
    if (session.profile !== 'codex' || remote.paneDead) return false
    const queuedQuestion =
      screenText != null && codexQueuedQuestionOnScreen(screenText)
    const nextState = codexStateFromPaneSnapshot(
      remote.paneTitle,
      screenText,
      session.state
    )
    if (!nextState || nextState === session.state) return false
    const message =
      nextState === 'running'
        ? `${session.name} is working.`
        : nextState === 'needs-input'
          ? queuedQuestion
            ? `${session.name} has a queued question for you.`
            : `${session.name} needs your input.`
          : nextState === 'response-ready'
            ? `${session.name} finished its latest turn.`
            : undefined
    this.changeState(session, nextState, message)
    return true
  }

  private async captureCodexQuestionScreen(
    connection: Connection,
    name: string
  ): Promise<string | null> {
    const tmuxPath = connection.kind === 'local'
      ? this.tmuxPath
      : this.remoteTmuxPaths.get(connection.id) ??
        await resolveRemoteTmuxAsync(connection.sshAlias ?? connection.name).catch(() => null)
    if (!tmuxPath) return null
    if (connection.kind === 'ssh') this.remoteTmuxPaths.set(connection.id, tmuxPath)
    const args = ['capture-pane', '-p', '-t', `=${name}:`]
    try {
      const result = connection.kind === 'local'
        ? await this.execCommand(tmuxPath, args, {
            encoding: 'utf8', timeout: 2_000, maxBuffer: 64 * 1024
          })
        : await this.execCommand('ssh', [
            '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3',
            connection.sshAlias ?? connection.name,
            `${quote(tmuxPath)} ${args.map(quote).join(' ')}`
          ], { encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024 })
      // Normalize tmux's record-ending newline, retaining actual blank rows.
      return result.stdout.replace(/\r?\n$/, '')
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

  private async reconcileConnection(
    connection: Connection,
    projects: Project[]
  ): Promise<number> {
    const listed = await this.listTmuxSessions(connection)
    if (this.shuttingDown) return 0
    if (!listed) return 0

    let changes = 0
    const liveMetadataIds = new Set(
      listed.flatMap((session) =>
        session.metadata ? [session.metadata.terminalId] : []
      )
    )
    const liveByName = new Map(listed.map((session) => [session.name, session]))

    // A Codex follow-up question is visible in its composer, but its title can
    // still say Working. Recheck previous input alerts even after Ready so an
    // old queued footer cannot latch the status. Sample a bounded, rotating set
    // of panes per discovery so SSH hosts with many sessions remain responsive.
    const codexCandidates = listed.filter((session) =>
      session.metadata?.profile === 'codex' &&
      !session.paneDead &&
      !this.runtimes.has(session.metadata.terminalId) &&
      (codexStateFromPaneTitle(session.paneTitle, 'idle') === 'running' ||
        this.store.getSessionWithoutOutput(session.metadata.terminalId)?.state === 'needs-input')
    )
    const screenSnapshots = new Map<string, string | null>()
    if (codexCandidates.length > 0) {
      if (connection.kind === 'ssh' && !this.remoteTmuxPaths.has(connection.id)) {
        const tmuxPath = await resolveRemoteTmuxAsync(connection.sshAlias ?? connection.name)
          .catch(() => null)
        if (tmuxPath) this.remoteTmuxPaths.set(connection.id, tmuxPath)
      }
      const cursor = this.codexQuestionScanCursors.get(connection.id) ?? 0
      const count = Math.min(MAX_CODEX_QUESTION_SCANS_PER_DISCOVERY, codexCandidates.length)
      const selected = Array.from({ length: count }, (_, index) =>
        codexCandidates[(cursor + index) % codexCandidates.length]
      )
      this.codexQuestionScanCursors.set(connection.id, (cursor + count) % codexCandidates.length)
      await Promise.all(selected.map(async (session) => {
        screenSnapshots.set(session.name, await this.captureCodexQuestionScreen(connection, session.name))
      }))
    }

    for (const listedSession of listed) {
      let metadata = listedSession.metadata
      let repairMetadata = false
      if (metadata && metadata.sessionKind == null) {
        const known = this.store.getSessionWithoutOutput(metadata.terminalId)
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
          repairMetadata = true
        }
      }
      const project = this.projectForDiscoveredSession(projects, listedSession)
      if (!metadata || !project) continue
      const known = this.store.getSessionWithoutOutput(metadata.terminalId)
      if (
        known?.latexChat &&
        (metadata.sessionKind !== 'latex-chat' || metadata.latex == null)
      ) {
        metadata = this.metadataForSession(project, {
          ...known,
          kind: 'latex-chat'
        })
        repairMetadata = true
      }
      const result = this.store.upsertDiscoveredTmuxSession(
        project.id,
        listedSession.name,
        metadata
      )
      if (!result) continue
      this.store.clearSessionRebootRecovery(result.session.id)
      let changed = result.changed
      const runtime = this.runtimes.get(result.session.id)
      const screenText = runtime?.title
        ? this.visibleScreenText(runtime)
        : screenSnapshots.get(listedSession.name)
      changed =
        this.applyCodexPaneSnapshot(
          result.session,
          listedSession,
          screenText
        ) || changed
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
      if (repairMetadata) {
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
        if (connection.kind === 'local' && this.store.isSessionPendingRebootRecovery(session.id)) continue
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

  private async tmuxSessionExists(connection: Connection, name: string): Promise<boolean> {
    const tmuxPath = await this.tmuxPathForConnection(connection)
    if (!tmuxPath) throw new Error(`Tmux is unavailable on ${connection.name}.`)
    if (connection.kind === 'ssh') return this.remoteTmuxSessionExists(connection, tmuxPath, name)
    try {
      await this.execCommand(tmuxPath, ['has-session', '-t', `=${name}`], {
        encoding: 'utf8', timeout: 2_000, maxBuffer: 64 * 1024
      })
      return true
    } catch (error) {
      if ((error as { code?: unknown }).code === 1) return false
      throw error
    }
  }

  private async killTmuxSession(connection: Connection, name: string): Promise<void> {
    const tmuxPath = await this.tmuxPathForConnection(connection)
    if (!tmuxPath) throw new Error('Tmux is unavailable, so the persistent session could not be stopped.')
    if (connection.kind === 'local') {
      if (!(await this.tmuxSessionExists(connection, name))) return
      await this.execCommand(tmuxPath, ['kill-session', '-t', `=${name}`], {
        encoding: 'utf8', timeout: 3_000, maxBuffer: 64 * 1024
      })
      if (await this.tmuxSessionExists(connection, name)) throw new Error(`Tmux session “${name}” is still running.`)
      return
    }
    const target = quote(`=${name}`)
    const executable = quote(tmuxPath)
    // A successful SSH result proves the exact target stopped; transport failure
    // remains an error and must never archive/delete its durable record.
    const remoteCommand =
      `if ${executable} has-session -t ${target} 2>/dev/null; then ` +
      `${executable} kill-session -t ${target} || exit $?; ` +
      `if ${executable} has-session -t ${target} 2>/dev/null; then exit 1; else status=$?; test "$status" -eq 1; fi; ` +
      `else status=$?; test "$status" -eq 1; fi`
    await this.execCommand('ssh', [
      '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
      connection.sshAlias ?? connection.name, remoteCommand
    ], { encoding: 'utf8', timeout: 7_000, maxBuffer: 64 * 1024 })
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
    this.ensureActive()
    const session = this.store.getSessionWithoutOutput(id)
    if (!session) throw new Error('Terminal session not found.')
    return session
  }
}
