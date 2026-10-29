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
import { sessionPredatesSystemBoot, systemBootTimeMs, TerminalManager } from '../src/main/terminal-manager'
import {
  encodePanePilotTmuxMetadata, panePilotTmuxMetadata, PANEPILOT_TMUX_OPTION_KEYS,
  TMUX_FIELD_SEPARATOR
} from '../src/main/tmux-metadata'
import type { TerminalSession } from '../src/shared/types'

// Never launch real agents or touch the user's tmux server in recovery tests.
const subprocess = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: subprocess.execFile
  }),
  spawnSync: vi.fn(() => { throw new Error('Unexpected synchronous subprocess in recovery test') })
}))

describe('terminal reboot recovery', () => {
  let appDataPath: string
  let store: Store
  let managers: TerminalManager[]
  let projectId: string
  let listing: string
  let listError: string
  const bootTime = Date.parse('2026-01-01T00:00:00Z')

  function manager(): TerminalManager {
    const instance = new TerminalManager(store, () => null,
      new ConversationIndexer(), new RemoteConversationIndexer())
    managers.push(instance)
    return instance
  }

  function session(overrides: Partial<Parameters<Store['createSession']>[0]> = {}): TerminalSession {
    const name = `Reboot 🛠️ ${randomUUID()}`
    const result = store.createSession({
      projectId, name, profile: 'codex', backend: 'tmux', tmuxName: name,
      providerSessionName: null, customCommand: null, dangerousMode: false,
      ...overrides
    })
    const db = new DatabaseSync(join(appDataPath, 'project-console.sqlite'))
    db.prepare('UPDATE terminal_sessions SET created_at = ?, updated_at = ?, tmux_metadata_version = 1 WHERE id = ?')
      .run('2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', result.id)
    db.close()
    return store.getSessionWithoutOutput(result.id)!
  }

  function live(value: TerminalSession, terminalId = value.id): void {
    const metadata = panePilotTmuxMetadata({
      project: store.getProjectForRuntime(value.projectId)!, session: value,
      action: null, latexSection: null
    })
    const encoded = encodePanePilotTmuxMetadata({ ...metadata, terminalId })
    listing = ['$1', value.tmuxName, '0', '', 'codex', '0',
      ...PANEPILOT_TMUX_OPTION_KEYS.map((key) => encoded[key] ?? '')
    ].join(TMUX_FIELD_SEPARATOR)
  }

  beforeEach(() => {
    appDataPath = mkdtempSync(join(tmpdir(), 'panepilot-reboot-recovery-'))
    store = new Store(appDataPath)
    store.syncConnections(['test-host'])
    projectId = store.createProject({ type: 'terminal', name: 'Project',
      connectionId: 'local', folder: appDataPath, repositoryUrl: null }).id
    managers = []
    listing = ''
    listError = ''
    vi.stubEnv('SHELL', '')
    subprocess.execFile.mockImplementation(async (_command, args) => {
      const arguments_ = args as string[]
      let stdout = ''
      let stderr = ''
      let status = 0
      if (arguments_.includes('command -v tmux')) stdout = '/bin/sh\n'
      else if (arguments_.includes('list-sessions')) {
        stdout = listing
        stderr = listError
        status = listError ? 1 : 0
      } else if (arguments_.includes('has-session')) status = listing ? 0 : 1
      else throw new Error(`Unexpected subprocess in recovery test: ${arguments_.join(' ')}`)
      if (status !== 0) throw Object.assign(new Error(stderr || 'tmux session missing'), { code: status, stdout, stderr })
      return { stdout, stderr }
    })
    vi.mocked(pty.spawn).mockImplementation(() => ({
      pid: 1, cols: 100, rows: 30, process: 'fake tmux', handleFlowControl: false,
      onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
      write() {}, resize() {}, kill() {}, pause() {}, resume() {}, clear() {}
    }))
  })

  afterEach(() => {
    for (const instance of managers) instance.shutdown()
    store.close()
    rmSync(appDataPath, { recursive: true, force: true })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('recognizes only records from before the current boot', () => {
    expect(systemBootTimeMs(bootTime + 60_000, 60)).toBe(bootTime)
    expect(sessionPredatesSystemBoot('2025-12-31T23:59:00Z', bootTime)).toBe(true)
    expect(sessionPredatesSystemBoot('2026-01-01T00:00:10Z', bootTime)).toBe(false)
    expect(sessionPredatesSystemBoot('not-a-date', bootTime)).toBe(false)
  })

  it('queues 80 tabs without spawning, then resumes only the selected exact thread', async () => {
    const sessions = Array.from({ length: 80 }, () => session({ dangerousMode: true }))
    const selected = sessions[37]
    const threadId = randomUUID()
    store.setSessionProviderId(selected.id, 'codex', threadId)
    const instance = manager()
    expect(await instance.prepareLocalSessionsAfterReboot(Date.now() + 60_000)).toBe(80)
    expect(pty.spawn).not.toHaveBeenCalled()
    expect(subprocess.execFile.mock.calls.filter((call) =>
      (call[1] as string[]).includes('list-sessions'))).toHaveLength(1)
    await instance.reconcileSessions('local')
    const findProvider = vi.spyOn(ConversationIndexer.prototype, 'findProviderSessionId')
    await instance.discoverSavedProviderSessions()
    expect(findProvider).not.toHaveBeenCalled()
    expect(pty.spawn).not.toHaveBeenCalled()
    expect(sessions.every((value) => store.getSession(value.id)?.state === 'idle')).toBe(true)
    await Promise.all([
      instance.attach(selected.id, 120, 40),
      instance.attach(selected.id, 120, 40)
    ])
    expect(pty.spawn).toHaveBeenCalledTimes(1)
    const [, args, options] = vi.mocked(pty.spawn).mock.calls[0]
    expect(args).toEqual(expect.arrayContaining(['new-session', selected.name]))
    expect(args?.at(-1)).toContain(`resume --dangerously-bypass-approvals-and-sandbox '${threadId}'`)
    expect(options).toMatchObject({ cwd: appDataPath, cols: 120, rows: 40 })
    expect(store.isSessionPendingRebootRecovery(selected.id)).toBe(false)
    expect(sessions.filter((value) => store.isSessionPendingRebootRecovery(value.id))).toHaveLength(79)
  })

  it('keeps waiting tabs through app restarts, metadata changes, and discovery', async () => {
    const waiting = session({ profile: 'shell' })
    store.replaceOutput(waiting.id, 'Saved shell output')
    const first = manager()
    await first.prepareLocalSessionsAfterReboot(Date.now() + 60_000)
    store.setSessionPinned(waiting.id, true)
    first.shutdown()
    store.close()
    store = new Store(appDataPath)
    const reopened = manager()
    expect(await reopened.prepareLocalSessionsAfterReboot(bootTime)).toBe(1)
    await reopened.reconcileSessions('local')
    expect(pty.spawn).not.toHaveBeenCalled()
    expect(store.getSession(waiting.id)).toMatchObject({ state: 'idle', pinned: true })
    expect((await reopened.attach(waiting.id, 100, 30)).output).toBe('Saved shell output')
    expect(pty.spawn).toHaveBeenCalledTimes(1)
    expect(store.getProject(projectId)?.activities.filter((activity) =>
      activity.kind === 'terminal-reboot-pending')).toHaveLength(1)
  })

  it('adopts an already restored owned session without starting a new agent', async () => {
    const existing = session()
    live(existing)
    const instance = manager()
    expect(await instance.prepareLocalSessionsAfterReboot(bootTime)).toBe(1)
    expect(pty.spawn).not.toHaveBeenCalled()
    await instance.attach(existing.id, 100, 30)
    expect(vi.mocked(pty.spawn).mock.calls[0][1]).toEqual(['attach-session', '-t', `=${existing.name}`])
  })

  it('rechecks ownership when another client restores a waiting session', async () => {
    const waiting = session()
    const instance = manager()
    await instance.prepareLocalSessionsAfterReboot(bootTime)
    live(waiting)
    await instance.attach(waiting.id, 100, 30)
    expect(vi.mocked(pty.spawn).mock.calls[0][1]).toEqual(['attach-session', '-t', `=${waiting.name}`])
    expect(store.isSessionPendingRebootRecovery(waiting.id)).toBe(false)
  })

  it('never attaches to an unrelated session that takes a waiting name', async () => {
    const waiting = session()
    const instance = manager()
    await instance.prepareLocalSessionsAfterReboot(bootTime)
    live(waiting, randomUUID())
    await expect(instance.attach(waiting.id, 100, 30)).rejects.toThrow('Another tmux session')
    expect(pty.spawn).not.toHaveBeenCalled()
    expect(store.isSessionPendingRebootRecovery(waiting.id)).toBe(true)
  })

  it('leaves failed attachment pending so Retry can restore that exact tab', async () => {
    const waiting = session({ profile: 'shell' })
    const instance = manager()
    await instance.prepareLocalSessionsAfterReboot(bootTime)
    vi.mocked(pty.spawn).mockImplementationOnce(() => { throw new Error('spawn failed') })
    await expect(instance.attach(waiting.id, 100, 30)).rejects.toThrow('spawn failed')
    expect(store.isSessionPendingRebootRecovery(waiting.id)).toBe(true)
    await instance.retryAttach(waiting.id, 110, 35)
    expect(store.isSessionPendingRebootRecovery(waiting.id)).toBe(false)
    expect(pty.spawn).toHaveBeenCalledTimes(2)
  })

  it('does not create a late PTY when shutdown occurs during asynchronous attachment', async () => {
    const waiting = session({ profile: 'shell' })
    const instance = manager()
    await instance.prepareLocalSessionsAfterReboot(bootTime)
    const attachment = instance.attach(waiting.id, 100, 30)
    instance.shutdown()
    // Closing may reject the attachment or acknowledge it without a runtime.
    // In either case, pending async discovery must never launch after shutdown.
    await Promise.allSettled([attachment])
    expect(vi.mocked(pty.spawn).mock.calls.length).toBe(0)
    expect(store.isSessionPendingRebootRecovery(waiting.id)).toBe(true)
  })

  it('distinguishes a missing tmux socket from a failed read', async () => {
    const waiting = session()
    const instance = manager()
    listError = 'error connecting to /tmp/tmux-test/default (Permission denied)'
    expect(await instance.prepareLocalSessionsAfterReboot(bootTime)).toBe(0)
    expect(store.isSessionPendingRebootRecovery(waiting.id)).toBe(false)
    listError = 'error connecting to /tmp/tmux-test/default (No such file or directory)'
    expect(await instance.prepareLocalSessionsAfterReboot(bootTime)).toBe(1)
    listError = 'error connecting to /tmp/tmux-test/default (Permission denied)'
    await expect(instance.attach(waiting.id, 100, 30)).rejects.toThrow('Could not check tmux')
    expect(store.isSessionPendingRebootRecovery(waiting.id)).toBe(true)
    expect(pty.spawn).not.toHaveBeenCalled()
  })

  it('does not recover Actions, stopped tabs, PTYs, archived projects, or SSH sessions', async () => {
    const action = session({ kind: 'action', profile: 'custom', customCommand: 'do not execute' })
    const stopped = session()
    store.setSessionState(stopped.id, 'completed')
    const failed = session()
    store.setSessionState(failed.id, 'error')
    const plain = session({ profile: 'shell', backend: 'pty', tmuxName: null })
    const remoteProject = store.createProject({ type: 'terminal', name: 'Remote',
      connectionId: 'ssh:test-host', folder: '/srv/project', repositoryUrl: null })
    const remote = session({ projectId: remoteProject.id })
    const archivedProject = store.createProject({ type: 'terminal', name: 'Archived',
      connectionId: 'local', folder: join(appDataPath, 'archived'), repositoryUrl: null })
    const archived = session({ projectId: archivedProject.id })
    const db = new DatabaseSync(join(appDataPath, 'project-console.sqlite'))
    db.prepare('UPDATE projects SET archived = 1 WHERE id = ?').run(archivedProject.id)
    db.close()
    expect(await manager().prepareLocalSessionsAfterReboot(Date.now() + 60_000)).toBe(0)
    expect(store.getSession(action.id)?.state).toBe('completed')
    for (const value of [action, stopped, failed, plain, remote, archived]) {
      expect(store.isSessionPendingRebootRecovery(value.id)).toBe(false)
    }
    expect(pty.spawn).not.toHaveBeenCalled()
  })

  it('keeps explicitly stopped waiting tabs stopped after another app launch', async () => {
    const waiting = session({ kind: 'temporary-chat' })
    const instance = manager()
    await instance.prepareLocalSessionsAfterReboot(bootTime)
    await instance.stop(waiting.id)
    expect(store.isSessionPendingRebootRecovery(waiting.id)).toBe(false)
    expect(await instance.prepareLocalSessionsAfterReboot(Date.now() + 60_000)).toBe(0)
    expect(store.getSession(waiting.id)?.state).toBe('completed')
    expect(pty.spawn).not.toHaveBeenCalled()
  })

  it('resumes Claude by its exact saved ID with safe permissions unchanged', async () => {
    const waiting = session({ profile: 'claude' })
    const providerId = randomUUID()
    store.setSessionProviderId(waiting.id, 'claude', providerId)
    const instance = manager()
    await instance.prepareLocalSessionsAfterReboot(Date.now() + 60_000)
    await instance.attach(waiting.id, 100, 30)
    const command = vi.mocked(pty.spawn).mock.calls[0][1]?.at(-1)
    expect(command).toContain(`exec claude --resume '${providerId}'`)
    expect(command).not.toContain('--dangerously-skip-permissions')
  })

  it('leaves one-shot inline edits stopped while deferring writing and quick chats', async () => {
    const paper = store.createProject({ type: 'latex', name: 'Paper',
      connectionId: 'local', folder: join(appDataPath, 'paper'), repositoryUrl: null,
      latex: { mainFile: 'main.tex', overleafUrl: null, contextFolder: 'context' } })
    const writing = session({ projectId: paper.id, kind: 'latex-chat' })
    const inline = session({ projectId: paper.id, kind: 'latex-chat' })
    for (const [value, purpose] of [[writing, 'writing'], [inline, 'inline-edit']] as const) {
      store.attachLatexChat(value.id, {
        projectId: paper.id, purpose, scope: 'project', sectionId: null, mode: 'edit'
      })
    }
    const quick = session({ kind: 'temporary-chat' })
    const instance = manager()
    expect(await instance.prepareLocalSessionsAfterReboot(Date.now() + 60_000)).toBe(2)
    expect(store.getSession(inline.id)?.state).toBe('completed')
    expect(store.isSessionPendingRebootRecovery(inline.id)).toBe(false)
    expect(store.isSessionPendingRebootRecovery(writing.id)).toBe(true)
    expect(store.isSessionPendingRebootRecovery(quick.id)).toBe(true)
    expect(pty.spawn).not.toHaveBeenCalled()
  })

  it('still completes a missing session from the current boot', async () => {
    const current = session()
    store.setSessionState(current.id, 'running')
    const instance = manager()
    expect(await instance.prepareLocalSessionsAfterReboot(bootTime)).toBe(0)
    await instance.reconcileSessions('local')
    expect(store.getSession(current.id)?.state).toBe('completed')
    expect(pty.spawn).not.toHaveBeenCalled()
  })
})
