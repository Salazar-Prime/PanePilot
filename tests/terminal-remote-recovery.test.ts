import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as pty from 'node-pty'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationIndexer } from '../src/main/conversation-indexer'
import { RemoteConversationIndexer } from '../src/main/remote-conversation-indexer'
import { Store } from '../src/main/store'
import { TerminalManager } from '../src/main/terminal-manager'
import { encodePanePilotTmuxMetadata, panePilotTmuxMetadata, PANEPILOT_TMUX_OPTION_KEYS, TMUX_FIELD_SEPARATOR } from '../src/main/tmux-metadata'
import type { Connection, TerminalSession } from '../src/shared/types'

// No real SSH, provider processes, archives, or user tmux sockets are used.
const subprocess = vi.hoisted(() => ({ exec: vi.fn() }))
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: subprocess.exec }),
  spawnSync: vi.fn(() => { throw new Error('Unexpected synchronous subprocess') })
}))

describe('on-demand SSH terminal recovery', () => {
  let root: string
  let store: Store
  let manager: TerminalManager
  let projectId: string
  let listing: string
  let offline: boolean

  function saved(overrides: Partial<Parameters<Store['createSession']>[0]> = {}) {
    const name = `Saved 🛠 ${randomUUID()}`
    const session = store.createSession({ projectId, name, profile: 'codex', backend: 'tmux',
      tmuxName: name, dangerousMode: true, providerSessionName: null, customCommand: null, ...overrides })
    const db = new DatabaseSync(join(root, 'project-console.sqlite'))
    db.prepare("UPDATE terminal_sessions SET tmux_metadata_version = 1, created_at = '2020-01-01' WHERE id = ?").run(session.id)
    db.close()
    return store.getSessionWithoutOutput(session.id)!
  }

  function live(session: TerminalSession, terminalId = session.id, projectPath = '/srv/paper') {
    const metadata = panePilotTmuxMetadata({ project: store.getProjectForRuntime(projectId)!, session,
      action: null, latexSection: null })
    const encoded = encodePanePilotTmuxMetadata({ ...metadata, terminalId, projectPath })
    listing = ['$1', session.name, '0', '', session.profile, '0',
      ...PANEPILOT_TMUX_OPTION_KEYS.map((key) => encoded[key] ?? '')].join(TMUX_FIELD_SEPARATOR)
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'panepilot-remote-recovery-'))
    store = new Store(root)
    store.syncConnections(['main-mac'])
    projectId = store.createProject({ type: 'terminal', name: 'Paper', connectionId: 'ssh:main-mac',
      folder: '/srv/paper', repositoryUrl: null }).id
    listing = ''
    offline = false
    vi.stubEnv('SHELL', '')
    subprocess.exec.mockImplementation(async (_file, args: string[]) => {
      const command = args.at(-1) ?? ''
      if (offline && _file === 'ssh') throw new Error('SSH unavailable')
      if (args.includes('command -v tmux') || command.includes('panepilot_tmux')) {
        return { stdout: command.includes('list-sessions') ? listing : '/bin/sh\n', stderr: '' }
      }
      throw new Error(`Unexpected subprocess: ${args.join(' ')}`)
    })
    vi.mocked(pty.spawn).mockImplementation(() => ({
      pid: 1, cols: 100, rows: 30, process: 'fake SSH', handleFlowControl: false,
      onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
      write() {}, resize() {}, kill() {}, pause() {}, resume() {}, clear() {}
    }))
    manager = new TerminalManager(store, () => null, new ConversationIndexer(), new RemoteConversationIndexer())
  })

  afterEach(() => {
    manager.shutdown()
    store.close()
    rmSync(root, { recursive: true, force: true })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('queues missing tabs without spawning, then resumes only the selected exact Codex ID on its host', async () => {
    const tabs = Array.from({ length: 20 }, () => saved())
    const selected = tabs[7]
    const thread = randomUUID()
    store.setSessionProviderId(selected.id, 'codex', thread)
    expect(await manager.reconcileSessions('ssh:main-mac')).toBe(20)
    expect(pty.spawn).not.toHaveBeenCalled()
    expect(tabs.every((tab) => store.isSessionPendingRebootRecovery(tab.id))).toBe(true)
    await Promise.all([manager.attach(selected.id, 120, 40), manager.attach(selected.id, 120, 40)])
    expect(pty.spawn).toHaveBeenCalledOnce()
    const [file, args, options] = vi.mocked(pty.spawn).mock.calls[0]
    expect(file).toBe('ssh')
    expect(args).toContain('main-mac')
    expect(args?.at(-1)).toContain("cd '/srv/paper'")
    expect(args?.at(-1)).toContain('new-session -s')
    expect(args?.at(-1)).toContain(thread)
    expect(args?.at(-1)).toContain('resume --dangerously-bypass-approvals-and-sandbox')
    expect(options).toMatchObject({ cols: 120, rows: 40 })
    expect(store.getSession(selected.id)).toMatchObject({ id: selected.id, providerSessionId: thread,
      dangerousMode: true, state: 'idle', recoveryPending: false })
    expect(tabs.filter((tab) => store.isSessionPendingRebootRecovery(tab.id))).toHaveLength(19)
  })

  it('recovers on the first click even before background discovery runs', async () => {
    const tab = saved({ profile: 'shell', dangerousMode: false })
    await manager.attach(tab.id, 90, 24)
    expect(vi.mocked(pty.spawn).mock.calls[0][1]?.at(-1)).toContain('new-session -s')
    expect(store.getSession(tab.id)?.recoveryPending).toBe(false)
  })

  it('resumes Claude by its exact ID without changing safe permissions', async () => {
    const tab = saved({ profile: 'claude', dangerousMode: false })
    const id = randomUUID()
    store.setSessionProviderId(tab.id, 'claude', id)
    await manager.attach(tab.id, 100, 30)
    const command = vi.mocked(pty.spawn).mock.calls[0][1]?.at(-1)
    expect(command).toContain('claude --resume')
    expect(command).toContain(id)
    expect(command).not.toContain('dangerously-skip-permissions')
  })

  it('adopts a backend restored by another client without launching another agent', async () => {
    const tab = saved()
    await manager.reconcileSessions('ssh:main-mac')
    live(tab)
    await manager.attach(tab.id, 100, 30)
    const command = vi.mocked(pty.spawn).mock.calls[0][1]?.at(-1)
    expect(command).toContain('attach-session -t')
    expect(command).not.toContain('new-session')
    expect(command).not.toContain('codex resume')
  })

  it('follows a renamed exact UUID instead of recreating its stale name', async () => {
    const tab = saved()
    live({ ...tab, name: 'Renamed elsewhere', tmuxName: 'Renamed elsewhere' })
    await manager.attach(tab.id, 100, 30)
    expect(vi.mocked(pty.spawn).mock.calls[0][1]?.at(-1)).toContain("attach-session -t '=Renamed elsewhere'")
    expect(store.getSession(tab.id)?.name).toBe('Renamed elsewhere')
  })

  it.each(['other-uuid', 'other-project'])('refuses a live %s ownership conflict', async (conflict) => {
    const tab = saved()
    live(tab, conflict === 'other-uuid' ? randomUUID() : tab.id,
      conflict === 'other-project' ? '/srv/unrelated' : '/srv/paper')
    await expect(manager.attach(tab.id, 100, 30)).rejects.toThrow('Another tmux session')
    expect(pty.spawn).not.toHaveBeenCalled()
  })

  it('never replaces a missing linked conversation with a fresh chat when its ID is unknown', async () => {
    const tab = saved()
    await expect(manager.attach(tab.id, 100, 30)).rejects.toThrow('no verified provider session ID')
    expect(pty.spawn).not.toHaveBeenCalled()
    expect(store.isSessionPendingRebootRecovery(tab.id)).toBe(true)
  })

  it('leaves offline state intact and permits explicit Retry after the host returns', async () => {
    const tab = saved({ profile: 'shell' })
    offline = true
    expect(await manager.reconcileSessions('ssh:main-mac')).toBe(0)
    await expect(manager.attach(tab.id, 100, 30)).rejects.toThrow()
    expect(store.getSession(tab.id)?.state).toBe('idle')
    expect(pty.spawn).not.toHaveBeenCalled()
    offline = false
    await manager.retryAttach(tab.id, 110, 35)
    expect(pty.spawn).toHaveBeenCalledOnce()
  })

  it('keeps a failed spawn pending and retries only the exact saved tab', async () => {
    const tab = saved({ profile: 'shell' })
    vi.mocked(pty.spawn).mockImplementationOnce(() => { throw new Error('spawn failed') })
    await expect(manager.attach(tab.id, 100, 30)).rejects.toThrow('spawn failed')
    expect(store.isSessionPendingRebootRecovery(tab.id)).toBe(true)
    await manager.retryAttach(tab.id, 100, 30)
    expect(store.isSessionPendingRebootRecovery(tab.id)).toBe(false)
  })

  it('preserves deferred recovery across application restarts without launching', async () => {
    const tab = saved({ profile: 'shell' })
    await manager.reconcileSessions('ssh:main-mac')
    manager.shutdown()
    store.close()
    store = new Store(root)
    manager = new TerminalManager(store, () => null, new ConversationIndexer(), new RemoteConversationIndexer())
    await manager.reconcileSessions('ssh:main-mac')
    expect(pty.spawn).not.toHaveBeenCalled()
    expect(store.getProjectForRuntime(projectId)?.sessions[0].recoveryPending).toBe(true)
    await manager.attach(tab.id, 100, 30)
    expect(pty.spawn).toHaveBeenCalledOnce()
  })

  it('marks a backend lost during reconnect as pending without starting it from polling', async () => {
    const tab = saved({ profile: 'shell' })
    const reconnect = { sessionId: tab.id, connectionId: 'ssh:main-mac', cols: 100, rows: 30,
      attempt: 0, lastExitCode: 255, transportState: 'reconnecting' as const }
    const internals = manager as unknown as {
      reconnects: Map<string, typeof reconnect>
      runRemoteReconnect(value: typeof reconnect, connection: Connection, listed: unknown[]): Promise<void>
    }
    internals.reconnects.set(tab.id, reconnect)
    await internals.runRemoteReconnect(reconnect, store.getConnection('ssh:main-mac')!, [])
    expect(store.getSession(tab.id)).toMatchObject({ state: 'idle', recoveryPending: true })
    expect(pty.spawn).not.toHaveBeenCalled()
    expect(internals.reconnects.size).toBe(0)
    await manager.retryAttach(tab.id, 100, 30)
    expect(pty.spawn).toHaveBeenCalledOnce()
  })

  it('keeps explicit stopped/restored tabs, Actions, PTYs, and archives out of automatic recovery', async () => {
    const stopped = saved()
    store.setSessionState(stopped.id, 'completed', `${stopped.name} was stopped.`)
    const archived = saved()
    store.setSessionState(archived.id, 'completed')
    store.setSessionArchived(archived.id, true)
    const restored = saved()
    store.setSessionState(restored.id, 'completed')
    store.setSessionArchived(restored.id, true)
    store.setSessionArchived(restored.id, false)
    const action = saved({ kind: 'action', profile: 'custom', customCommand: 'never run' })
    const plain = saved({ backend: 'pty', tmuxName: null, profile: 'shell' })
    await manager.reconcileSessions('ssh:main-mac')
    for (const tab of [stopped, archived, restored, action, plain]) {
      expect(store.isSessionPendingRebootRecovery(tab.id)).toBe(false)
    }
    await manager.attach(stopped.id, 100, 30)
    await manager.attach(restored.id, 100, 30)
    await expect(manager.attach(archived.id, 100, 30)).rejects.toThrow('archived')
    expect(pty.spawn).not.toHaveBeenCalled()
  })

  it('does not launch after an in-flight selection is canceled or the app shuts down', async () => {
    const tab = saved({ profile: 'shell' })
    const internals = manager as unknown as { listTmuxSessions(connection: Connection): Promise<unknown[]> }
    let finish!: (value: unknown[]) => void
    vi.spyOn(internals, 'listTmuxSessions').mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const attaching = manager.attach(tab.id, 100, 30, 'surface')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    manager.unsubscribeOutput(tab.id, 'surface')
    finish([])
    await attaching
    expect(pty.spawn).not.toHaveBeenCalled()
    const next = manager.attach(tab.id, 100, 30)
    manager.shutdown()
    finish([])
    await Promise.allSettled([next])
    expect(pty.spawn).not.toHaveBeenCalled()
  })
})
