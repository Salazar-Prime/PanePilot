import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import HeadlessXterm from '@xterm/headless'
import { expect, it } from 'vitest'
import type { Connection, Project, TerminalSession } from '../src/shared/types'
import type { ListedTmuxSession } from '../src/main/tmux-metadata'
import { ConversationIndexer } from '../src/main/conversation-indexer'
import { RemoteConversationIndexer } from '../src/main/remote-conversation-indexer'
import { ScreenActivityDetector } from '../src/main/screen-activity-detector'
import { Store } from '../src/main/store'
import { TerminalManager } from '../src/main/terminal-manager'
import { statusSessions } from '../src/renderer/src/lib/statusSessions'

it.each([
  '• Queued follow-up inputs\r\n? 1 question\r\nshift+← to answer',
  '• Queued follow-up inputs\r\n? 1 question · 12s\r\n⇧← to answer'
])('updates the status-bar input count only while the footer is live: %s', async (footer) => {
  const root = mkdtempSync(join(tmpdir(), 'panepilot-queued-input-'))
  const folder = join(root, 'project')
  mkdirSync(folder)
  const store = new Store(root)
  store.syncConnections([])
  const project = store.createProject({ type: 'terminal', name: 'Input status', connectionId: 'local', folder, repositoryUrl: null })
  const session = store.createSession({ projectId: project.id, name: 'Codex', profile: 'codex', providerSessionName: null, customCommand: null, backend: 'pty', tmuxName: null, dangerousMode: false })
  const manager = new TerminalManager(store, () => null, new ConversationIndexer(), new RemoteConversationIndexer())
  const screen = new HeadlessXterm.Terminal({ cols: 100, rows: 16, allowProposedApi: true })
  const runtime = { session, screen, title: 'Working', detector: new ScreenActivityDetector(), scanTimer: null as ReturnType<typeof setTimeout> | null }
  const harness = manager as unknown as {
    scheduleScreenScan(value: typeof runtime): void
    applyCodexPaneSnapshot(session: TerminalSession, pane: ListedTmuxSession, screen: string | null): boolean
    listTmuxSessions(connection: Connection): Promise<ListedTmuxSession[]>
    captureCodexQuestionScreen(connection: Connection, name: string): Promise<string | null>
    reconcileConnection(connection: Connection, projects: Project[]): Promise<number>
  }
  const inputCount = () => statusSessions([{ ...project, sessions: [store.getSessionWithoutOutput(session.id)!] }], 'needs-input').length
  const render = async (text: string) => {
    await new Promise<void>((resolve) => screen.write(`\x1b[2J\x1b[H${text}`, resolve))
    harness.scheduleScreenScan(runtime)
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  try {
    await render(`\x1b[12;1H\x1b[33m${footer}\x1b[0m\r\n› Answer here`)
    expect(inputCount()).toBe(1)
    // Repainting the elapsed time must retain one alert, not clear it or count twice.
    await render(`\x1b[12;1H${footer.replace('12s', '13s')}\r\n› Answer here`)
    expect(inputCount()).toBe(1)
    // The same text is still on screen, but is now above the last eight rows.
    await render(`${footer}\r\n${'Progress\r\n'.repeat(10)}`)
    expect(inputCount()).toBe(0)
    expect(store.getSessionWithoutOutput(session.id)?.state).toBe('running')
    await render(`\x1b[12;1H${footer}\r\n› Answer here`)
    expect(inputCount()).toBe(1)
    runtime.title = 'Ready'
    await render('› Ask anything')
    expect(inputCount()).toBe(0)
    expect(store.getSessionWithoutOutput(session.id)?.state).toBe('response-ready')

    store.setSessionState(session.id, 'needs-input')
    const pane: ListedTmuxSession = { name: session.name, tmuxId: '$1', attachedClients: 0, paneCurrentCommand: 'codex', paneDead: false, paneTitle: 'Ready', metadata: null }
    expect(harness.applyCodexPaneSnapshot(store.getSessionWithoutOutput(session.id)!, pane, null)).toBe(false)
    expect(inputCount()).toBe(1)
    expect(harness.applyCodexPaneSnapshot(store.getSessionWithoutOutput(session.id)!, pane, '› Ask anything')).toBe(true)
    expect(inputCount()).toBe(0)

    // Detached tmux snapshots (including SSH captures) use the same exact footer parser.
    expect(harness.applyCodexPaneSnapshot(store.getSessionWithoutOutput(session.id)!, pane, footer)).toBe(true)
    expect(inputCount()).toBe(1)
    expect(harness.applyCodexPaneSnapshot(store.getSessionWithoutOutput(session.id)!, pane, null)).toBe(false)
    expect(inputCount()).toBe(1)
    expect(harness.applyCodexPaneSnapshot(store.getSessionWithoutOutput(session.id)!, pane, '› Ask anything')).toBe(true)
    expect(inputCount()).toBe(0)

    // Detached Ready panes must still be sampled when SQLite has an old alert.
    store.setSessionState(session.id, 'needs-input')
    harness.listTmuxSessions = async () => [{ ...pane, metadata: {
      terminalId: session.id, originProjectId: project.id, projectPath: project.folder,
      profile: 'codex', providerSessionId: 'test-thread', providerSessionName: null,
      createdAt: session.createdAt, dangerousMode: false, sessionKind: 'terminal', action: null, latex: null
    } }]
    let captures = 0
    harness.captureCodexQuestionScreen = async () => { captures += 1; return '› Ask anything' }
    await harness.reconcileConnection(store.getConnection('local')!, [{ ...project, sessions: [store.getSessionWithoutOutput(session.id)!] }])
    expect(captures).toBe(1)
    expect(inputCount()).toBe(0)
  } finally {
    if (runtime.scanTimer) clearTimeout(runtime.scanTimer)
    screen.dispose()
    manager.shutdown()
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
}, 15_000)
